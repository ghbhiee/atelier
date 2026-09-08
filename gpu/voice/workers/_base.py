"""Minimal worker scaffold: a stdlib HTTP server (no extra deps in the engine venv) that the voice router
talks to on 127.0.0.1:WORKER_PORT.  An engine module defines:

    load()                                              → loads weights (called once, lazily at start)
    synth(text, ref_path, ref_text, voice, params, out) → writes a wav to `out`, returns its path
    unload()                                            → optional

Protocol:  GET /health → {ok, loaded}   GET /mem → torch's own accounting   POST /tts (json) → {ok, path}   POST /unload → {ok}
"""
import json, os, sys, threading, time, traceback
from http.server import BaseHTTPRequestHandler, HTTPServer


def mem_report():
    """What the weights actually cost versus what the process holds. nvidia-smi only ever shows the last
    number, which on a small model is mostly CUDA context and the caching allocator, not the model."""
    out = {}
    try:
        import torch
        if torch.cuda.is_available():
            out["allocatedMib"] = round(torch.cuda.memory_allocated() / 1048576, 1)      # live tensors = the model
            out["reservedMib"] = round(torch.cuda.memory_reserved() / 1048576, 1)        # allocator pool, incl. freed blocks
            out["peakMib"] = round(torch.cuda.max_memory_allocated() / 1048576, 1)
            free, total = torch.cuda.mem_get_info()
            out["processMib"] = round((total - free) / 1048576)                          # whole card, all processes
    except Exception as e:
        out["error"] = str(e)[:120]
    return out


def trim_cache(keep_mib=256):
    """Give the allocator's spare blocks back to the driver. Synthesis lengths vary a lot, so the pool
    grows to the longest clip and never shrinks on its own — on an 82M model that dwarfs the weights."""
    try:
        import torch
        if not torch.cuda.is_available(): return
        slack = torch.cuda.memory_reserved() - torch.cuda.memory_allocated()
        if slack > keep_mib * 1048576: torch.cuda.empty_cache()
    except Exception: pass


def serve(engine, port=None):
    port = int(port or os.environ.get("WORKER_PORT", "8601"))
    state = {"loaded": False, "error": None}
    lock = threading.Lock()

    def log(*a): print(f"[{engine.NAME}]", *a, flush=True)

    def do_load():
        try:
            t0 = time.time(); engine.load(); state["loaded"] = True; log(f"loaded in {time.time()-t0:.1f}s")
        except Exception as e:
            state["error"] = f"{type(e).__name__}: {e}"; log("load failed:", traceback.format_exc())

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def _json(self, code, obj):
            b = json.dumps(obj, ensure_ascii=False).encode(); self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
        def do_GET(self):
            if self.path.startswith("/health"): return self._json(200, {"ok": True, "loaded": state["loaded"], "error": state["error"], "engine": engine.NAME})
            if self.path.startswith("/voices"): return self._json(200, getattr(engine, "VOICES", []))
            if self.path.startswith("/mem"): return self._json(200, mem_report())
            self._json(404, {"ok": False})
        def do_POST(self):
            n = int(self.headers.get("content-length") or 0); body = json.loads(self.rfile.read(n) or b"{}")
            if self.path.startswith("/unload"):
                with lock:
                    try: engine.unload(); state["loaded"] = False
                    except Exception as e: return self._json(500, {"ok": False, "error": str(e)})
                return self._json(200, {"ok": True})
            if self.path.startswith("/tts"):
                if not state["loaded"]: return self._json(503, {"ok": False, "error": state["error"] or "not loaded"})
                with lock:
                    try:
                        t0 = time.time()
                        path = engine.synth(body.get("text", ""), body.get("ref_path"), body.get("ref_text"), body.get("voice"), body.get("params") or {}, body.get("out_path"))
                        trim_cache()
                        log(f"tts {len(body.get('text', ''))} chars in {time.time()-t0:.1f}s  {mem_report().get('allocatedMib')}/{mem_report().get('reservedMib')} MiB")
                        return self._json(200, {"ok": True, "path": path})
                    except Exception as e:
                        log("tts failed:", traceback.format_exc()); return self._json(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})
            self._json(404, {"ok": False})

    threading.Thread(target=do_load, daemon=True).start()
    srv = HTTPServer(("127.0.0.1", port), H)
    log(f"listening on {port}")
    srv.serve_forever()


def save_wav(path, audio, sr):
    """audio: numpy float array (1-D or (1, n)) or torch tensor → 16-bit wav."""
    import numpy as np
    try:
        import torch
        if isinstance(audio, torch.Tensor): audio = audio.detach().float().cpu().numpy()
    except Exception: pass
    a = np.asarray(audio, dtype=np.float32).reshape(-1)
    peak = float(np.max(np.abs(a))) if a.size else 0.0
    if peak > 1.0: a = a / peak
    import soundfile as sf
    sf.write(path, a, int(sr), subtype="PCM_16")
    return path
