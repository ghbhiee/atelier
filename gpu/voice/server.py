#!/usr/bin/env python3
"""Voice service (router) for the GPU box.

One HTTP service in front of several TTS engines plus SenseVoice ASR:
  * IndexTTS-2   — in-process (this venv): zero-shot voice clone, emotion by text / vector / reference
  * Qwen3-TTS    — worker: built-in speakers (CustomVoice), voice clone (Base), voice design from a description
  * Kokoro       — worker: fast built-in voices (zh/en/ja …), speed control, no clone
Engines are loaded lazily on first use and evicted LRU (at most MAX_LOADED at a time) so VRAM stays bounded.

Saved voices ("我的音色") live in /root/model-cache/voice/voices/<id>.json + <id>.wav (reference clip, 24 kHz mono)
with a SenseVoice transcript, so every clone-capable engine can use them; sample voices (IndexTTS demo clips)
are exposed the same way under ids "sample:voice_05".

HTTP (127.0.0.1:8600, reached from server 13 through the reverse tunnel):
  GET  /health                         → {ok, engines:{id:{loaded}}, asr_loaded}
  GET  /engines                        → engine catalogue with controls + built-in voices
  POST /engines/{id}/load | /unload
  GET  /voices                         → {saved:[…], samples:[…], builtin:{engine:[…]}}
  POST /voices  (multipart name, note?, ref=file  |  json {name, note, ref_path})  → saved voice (transcribed)
  GET  /voices/{id}/sample             → the reference wav
  PATCH/DELETE /voices/{id}
  POST /tts     json {text, model?, voice?, params?{emotion,emo_alpha,instruct,speed,language}, format?}
                multipart text + ref=file (+ the same fields)                        → audio/wav | audio/mpeg
  POST /asr     multipart file [language] [itn]                                     → {text, language, emotion, events}
  POST /v1/audio/speech        OpenAI-compatible {model, input, voice, speed, instructions, response_format}
  POST /v1/audio/transcriptions OpenAI-compatible multipart file [model] [language] [response_format]
  GET  /v1/models              TTS engines + saved voices as model objects (merged into the LLM list by server 13)
"""
import io, json, os, re, shlex, subprocess, sys, tempfile, threading, time, uuid
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

HERE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("INDEXTTS_ROOT", "/root/index-tts"))
CACHE = Path(os.environ.get("VOICE_CACHE", "/root/model-cache/voice")); CACHE.mkdir(parents=True, exist_ok=True)
VOICES = CACHE / "voices"; VOICES.mkdir(exist_ok=True)
EXAMPLES = Path(os.environ.get("VOICE_EXAMPLES", str(CACHE / "examples")))
ASR_MODEL_DIR = Path(os.environ.get("ASR_MODEL", "/model/ModelScope/gongjy/SenseVoiceSmall"))
DEFAULT_ENGINE = os.environ.get("MODEL_ID", "indextts-2")
MAX_LOADED = int(os.environ.get("VOICE_MAX_LOADED", "1"))
VENVS = Path("/root/venvs")

app = FastAPI(title="atelier-voice")
_lock = threading.Lock()
_t0 = time.time()


def log(*a): print("[voice]", *a, flush=True)


# ----------------------------------------------------------------------------------------------
def _indextts_path() -> str:
    """Where IndexTTS-2's weights are. INDEXTTS_MODEL wins, then MODEL (only when the service booted into
    IndexTTS), then the default cache dir. Whatever we pick must actually contain config.yaml."""
    for cand in (os.environ.get("INDEXTTS_MODEL"),
                 os.environ.get("MODEL") if os.environ.get("MODEL_ID", "indextts-2") == "indextts-2" else None,
                 "/root/model-cache/IndexTTS-2"):
        if cand and (Path(cand) / "config.yaml").exists():
            return cand
    return "/root/model-cache/IndexTTS-2"


# Engine catalogue: what each engine can do and how to steer it. `controls` drive the UI and the
# OpenAI `instructions` mapping; `voices` are built-in speakers (empty = needs a reference clip).
# ----------------------------------------------------------------------------------------------
ENGINES = {
    "indextts-2": {
        "name": "IndexTTS-2", "kind": "inprocess", "clone": True, "langs": ["zh", "en", "ja", "yue"],
        # MODEL is whatever engine the service happened to be started with, so it is only IndexTTS's path
        # when the service booted into IndexTTS. Trusting it blindly made a later switch back to IndexTTS
        # look for its config.yaml inside the Qwen3-TTS directory and fail with FileNotFoundError.
        "path": _indextts_path(),
        "controls": [
            {"key": "emotion", "label": "情绪描述", "type": "text", "hint": "例如：开心 / 愤怒 / 悲伤 / 害怕 / 厌恶 / 忧郁 / 惊讶 / 平静，或一句话描述"},
            {"key": "emo_alpha", "label": "情绪强度", "type": "range", "min": 0, "max": 1, "step": 0.05, "default": 0.8},
            {"key": "emo_vector", "label": "情绪向量（高兴,愤怒,悲伤,害怕,厌恶,忧郁,惊讶,平静）", "type": "text", "hint": "8 个 0–1 的数，逗号分隔；填了就不看情绪描述"},
        ],
        "voices": [], "notes": "零样本克隆最像；情绪可由文字描述、8 维向量或另一段参考音频控制。",
    },
    "qwen3-tts": {
        "name": "Qwen3-TTS (1.7B)", "kind": "worker", "clone": True, "langs": ["zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"],
        "path": "/model/ModelScope/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", "venv": str(VENVS / "qwen-tts/.venv"), "worker": "qwen_tts_worker.py", "port": 8602,
        "extra_paths": {"base": "/model/ModelScope/Qwen/Qwen3-TTS-12Hz-1.7B-Base", "design": "/model/ModelScope/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"},
        "controls": [
            {"key": "instruct", "label": "风格指令", "type": "text", "hint": "例如：用温柔的语气慢慢说 / 兴奋地喊出来 / 像新闻主播"},
            {"key": "language", "label": "语言", "type": "select", "options": ["Auto", "Chinese", "English", "Japanese", "Korean", "German", "French", "Russian", "Portuguese", "Spanish", "Italian"], "default": "Auto"},
            {"key": "design", "label": "音色描述（VoiceDesign，填了就按描述造声音）", "type": "text", "hint": "例如：二十多岁的女声，清亮、语速偏快、带一点笑意"},
        ],
        "voices": [
            {"id": "Vivian", "name": "Vivian · 女 · 明亮", "lang": "zh"}, {"id": "Serena", "name": "Serena · 女 · 温柔", "lang": "zh"},
            {"id": "Uncle_Fu", "name": "Uncle_Fu · 男 · 醇厚", "lang": "zh"}, {"id": "Dylan", "name": "Dylan · 男 · 北京腔", "lang": "zh"},
            {"id": "Eric", "name": "Eric · 男 · 四川腔", "lang": "zh"}, {"id": "Ryan", "name": "Ryan · 男 · 稳重", "lang": "en"},
            {"id": "Aiden", "name": "Aiden · 男 · 阳光", "lang": "en"}, {"id": "Ono_Anna", "name": "Ono_Anna · 女 · 日语", "lang": "ja"},
            {"id": "Sohee", "name": "Sohee · 女 · 韩语", "lang": "ko"},
        ],
        "notes": "内置 9 个音色 + 风格指令；Base 版做克隆，VoiceDesign 版按文字描述造声音（同一后端自动切换权重）。",
    },
    "kokoro": {
        "name": "Kokoro 82M", "kind": "worker", "clone": False, "langs": ["zh", "en", "ja", "fr", "it", "pt", "es", "hi"],
        "path": "hexgrad/Kokoro-82M-v1.1-zh", "venv": str(VENVS / "kokoro/.venv"), "worker": "kokoro_worker.py", "port": 8603,
        "controls": [{"key": "speed", "label": "语速", "type": "range", "min": 0.5, "max": 2.0, "step": 0.05, "default": 1.0}],
        # v1.1-zh ships ~100 numbered Chinese voice packs (zf_001…, zm_010…); the full list is read from the snapshot when the worker loads
        "voices": [
            {"id": "zf_001", "name": "zf_001 · 女 · zh", "lang": "zh"}, {"id": "zf_002", "name": "zf_002 · 女 · zh", "lang": "zh"}, {"id": "zm_009", "name": "zm_009 · 男 · zh", "lang": "zh"}, {"id": "zm_010", "name": "zm_010 · 男 · zh", "lang": "zh"},
            {"id": "af_heart", "name": "af_heart · 女 · en", "lang": "en"}, {"id": "af_bella", "name": "af_bella · 女 · en", "lang": "en"}, {"id": "am_adam", "name": "am_adam · 男 · en", "lang": "en"}, {"id": "bm_george", "name": "bm_george · 男 · en-GB", "lang": "en"},
        ],
        "notes": "82M 小模型（Apache-2.0），毫秒级、显存 <1 GB；中文 v1.1-zh 约 100 个内置音色（加载后列出全部），不能克隆；适合大量旁白。",
    },
}
# OpenAI voice names → something sensible when a client sends alloy/echo/…
OPENAI_VOICE_MAP = {"alloy": "sample:voice_05", "echo": "sample:voice_09", "fable": "sample:voice_11", "onyx": "sample:voice_12", "nova": "sample:voice_01", "shimmer": "sample:voice_07", "ash": "sample:voice_02", "coral": "sample:voice_03", "sage": "sample:voice_04", "verse": "sample:voice_06"}


# ----------------------------------------------------------------------------------------------
# Engine runtime: in-process IndexTTS-2, worker subprocesses for the rest
# ----------------------------------------------------------------------------------------------
class Engine:
    def __init__(self, eid, spec):
        self.id, self.spec = eid, spec; self.loaded = False; self.last_used = 0; self.obj = None; self.proc = None; self.error = None
        self._lock = threading.Lock()   # the startup preload and a first request must not both load the same engine

    def load(self):
        with self._lock:
            if self.loaded: return
            self._load()

    def _load(self):
        t0 = time.time()
        if self.spec["kind"] == "inprocess":
            sys.path.insert(0, str(ROOT))
            from indextts.infer_v2 import IndexTTS2  # noqa
            cfg = Path(self.spec["path"]) / "config.yaml"
            if not cfg.exists(): raise HTTPException(500, f"IndexTTS-2 权重不在 {self.spec['path']}（缺 config.yaml）；设 INDEXTTS_MODEL 指向正确目录")
            self.obj = IndexTTS2(cfg_path=str(cfg), model_dir=self.spec["path"], use_fp16=True, use_cuda_kernel=False, use_deepspeed=False)
        else:
            py = Path(self.spec["venv"]) / "bin/python"
            if not py.exists(): raise HTTPException(503, f"{self.spec['name']} 还没安装（缺 {py}）；在 GPU 机上跑 gpu/voice/install-backends.sh")
            # a worker from a previous router life may still own the port: adopt it if healthy, otherwise kill it
            port = self.spec["port"]
            try:
                import urllib.request
                j = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2))
                if j.get("loaded") and j.get("engine") == self.id:
                    log(f"adopting running {self.id} worker on {port}"); self.proc = None; self.loaded = True; self.last_used = time.time(); return
            except Exception: pass
            _kill_port(port)
            env = dict(os.environ, VOICE_ENGINE=self.id, MODEL_PATH=self.spec["path"], WORKER_PORT=str(self.spec["port"]), EXTRA_PATHS=json.dumps(self.spec.get("extra_paths", {})))
            self.proc = subprocess.Popen([str(py), str(HERE / "workers" / self.spec["worker"])], env=env, stdout=open(CACHE / f"{self.id}.log", "ab"), stderr=subprocess.STDOUT)
            for _ in range(600):
                if self.proc.poll() is not None: raise HTTPException(500, f"{self.spec['name']} 进程退出，见 {CACHE / (self.id + '.log')}")
                try:
                    import urllib.request
                    j = json.load(urllib.request.urlopen(f"http://127.0.0.1:{self.spec['port']}/health", timeout=2))
                    if j.get("loaded"): break
                    if j.get("error"): raise HTTPException(500, f"{self.spec['name']} 加载失败：{j['error'][:300]}（日志 {CACHE / (self.id + '.log')}）")
                except Exception: pass
                time.sleep(1)
            else: raise HTTPException(504, f"{self.spec['name']} 10 分钟内没就绪")
            # engines that discover their built-in voices at load time (Kokoro lists the voice packs in its snapshot)
            try:
                import urllib.request
                vs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{self.spec['port']}/voices", timeout=5))
                if isinstance(vs, list) and vs: self.spec["voices"] = [v if isinstance(v, dict) and "name" in v else {"id": v["id"] if isinstance(v, dict) else v, "name": v["id"] if isinstance(v, dict) else v} for v in vs]
            except Exception: pass
        self.loaded = True; self.last_used = time.time(); self.error = None
        log(f"engine {self.id} ready in {time.time()-t0:.1f}s")

    def unload(self):
        if not self.loaded: return
        if self.spec["kind"] == "inprocess":
            self.obj = None
            try: import torch, gc; gc.collect(); torch.cuda.empty_cache()
            except Exception: pass
        elif self.proc:
            try: self.proc.terminate(); self.proc.wait(timeout=20)
            except Exception:
                try: self.proc.kill()
                except Exception: pass
            self.proc = None
        self.loaded = False; log(f"engine {self.id} unloaded")

    def synth(self, text, ref_path, ref_text, voice, params, out_path):
        """→ out_path (wav)."""
        self.last_used = time.time()
        if self.spec["kind"] == "inprocess":
            kw = {}
            if params.get("emo_vector"):
                try: vec = [float(x) for x in re.split(r"[,\s，]+", str(params["emo_vector"]).strip()) if x != ""]
                except ValueError: vec = None
                if vec and len(vec) == 8: kw["emo_vector"] = vec
            if "emo_vector" not in kw and params.get("emotion"): kw["use_emo_text"] = True; kw["emo_text"] = str(params["emotion"])
            if params.get("emotion_ref"): kw["emo_audio_prompt"] = params["emotion_ref"]
            if params.get("emo_alpha") is not None: kw["emo_alpha"] = float(params["emo_alpha"])
            with _lock:
                self.obj.infer(spk_audio_prompt=ref_path, text=text, output_path=out_path, verbose=False, **kw)
            return out_path
        import urllib.request
        body = json.dumps({"text": text, "ref_path": ref_path, "ref_text": ref_text, "voice": voice, "params": params, "out_path": out_path}).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{self.spec['port']}/tts", data=body, headers={"content-type": "application/json"})
        try: r = urllib.request.urlopen(req, timeout=900); j = json.load(r)
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:400]
            try: msg = json.loads(body).get("error") or body
            except Exception: msg = body
            code = 400 if msg.startswith("ValueError:") else 500
            raise HTTPException(code, msg.replace("ValueError: ", "") if code == 400 else f"{self.spec['name']}: {msg}")
        if not j.get("ok"): raise HTTPException(500, f"{self.spec['name']}: {j.get('error')}")
        return j.get("path", out_path)


def _kill_port(port):
    """Kill whatever listens on 127.0.0.1:port (stale worker)."""
    try:
        out = subprocess.run(["ss", "-ltnp"], capture_output=True, text=True, timeout=5).stdout
        for line in out.splitlines():
            if f":{port} " in line:
                for m in re.finditer(r"pid=(\d+)", line):
                    pid = int(m.group(1))
                    if pid != os.getpid():
                        log(f"killing stale process {pid} on port {port}"); os.kill(pid, 9)
        time.sleep(0.5)
    except Exception as e: log("kill_port:", e)


ENGINE = {eid: Engine(eid, spec) for eid, spec in ENGINES.items()}
VRAM_NEED = {"indextts-2": 8800, "qwen3-tts": 7000, "kokoro": 3600}   # MiB incl. CUDA context (measured 2026-09-07)


def vram_free_mib():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10).stdout.strip()
        return int(out.split("\n")[0])
    except Exception: return None


def ensure_engine(eid):
    e = ENGINE.get(eid)
    if not e: raise HTTPException(400, f"未知语音模型 {eid}；可用：{', '.join(ENGINES)}")
    if not e.loaded:
        loaded = [x for x in ENGINE.values() if x.loaded]
        need = VRAM_NEED.get(eid, 6000)
        # 1) at most MAX_LOADED engines; 2) enough free VRAM (the LLM / H3 may be sitting on the card too) — evict our own LRU engines first
        while loaded and (len(loaded) >= MAX_LOADED or ((vram_free_mib() or 10**6) < need + 600)):
            victim = min(loaded, key=lambda x: x.last_used); log(f"evicting {victim.id} (LRU / VRAM)"); victim.unload(); loaded.remove(victim)
        free = vram_free_mib()
        if free is not None and free < need + 600:
            raise HTTPException(503, f"显存不足：{ENGINES[eid]['name']} 约需 {need/1024:.1f} GB，现在只剩 {free/1024:.1f} GB（大模型 / H3 占着）；在「模型管家」卸掉不用的再试")
        e.load()
    return e


# ----------------------------------------------------------------------------------------------
# ASR (SenseVoice) — also used to transcribe reference clips when a voice is saved
# ----------------------------------------------------------------------------------------------
_asr = None
def load_asr():
    global _asr
    if _asr is None:
        with _lock:
            if _asr is None:
                from funasr import AutoModel  # noqa
                t0 = time.time(); _asr = AutoModel(model=str(ASR_MODEL_DIR), trust_remote_code=False, disable_update=True, device="cuda:0"); log(f"SenseVoice ready in {time.time()-t0:.1f}s")
    return _asr

def to_wav(src, dst, rate=16000):
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-ac", "1", "-ar", str(rate), dst], capture_output=True, text=True)
    if r.returncode != 0: raise HTTPException(400, "not a decodable audio/video file: " + (r.stderr or "").strip()[-200:])
    return dst

def transcribe(path, language="auto", itn=True):
    model = load_asr()
    wav = to_wav(path, path + ".16k.wav")
    try:
        with _lock:
            res = model.generate(input=wav, cache={}, language=language, use_itn=itn, batch_size_s=60, merge_vad=True, merge_length_s=15)
    finally:
        try: os.remove(wav)
        except Exception: pass
    raw = res[0].get("text", "") if res else ""
    tags = re.findall(r"<\|([^|]+)\|>", raw); text = re.sub(r"<\|[^|]+\|>", "", raw).strip()
    lang = next((t for t in tags if t in ("zh", "en", "yue", "ja", "ko", "nospeech")), None)
    emo = next((t for t in tags if t in ("HAPPY", "SAD", "ANGRY", "NEUTRAL", "FEARFUL", "DISGUSTED", "SURPRISED", "EMO_UNKNOWN")), None)
    events = [t for t in tags if t in ("Speech", "BGM", "Applause", "Laughter", "Cry", "Sneeze", "Breath", "Coughing")]
    return {"text": text, "language": lang, "emotion": emo, "events": events, "raw": raw}


# ----------------------------------------------------------------------------------------------
# Voice registry
# ----------------------------------------------------------------------------------------------
def saved_voices():
    out = []
    for f in sorted(VOICES.glob("*.json")):
        try: v = json.load(open(f)); v["kind"] = "saved"; out.append(v)
        except Exception: pass
    return out

def sample_voices():
    ex = sorted(EXAMPLES.glob("*.wav")) if EXAMPLES.exists() else []
    return [{"id": f"sample:{p.stem}", "name": f"示例声 {p.stem}", "kind": "sample", "ref": str(p)} for p in ex]

def resolve_voice(voice, engine_id):
    """voice → (ref_path|None, ref_text|None, builtin_id|None). Saved/sample voices give a reference clip; built-ins pass through."""
    if not voice: return None, None, None
    voice = OPENAI_VOICE_MAP.get(voice, voice)
    if voice.startswith("sample:"):
        p = EXAMPLES / (voice.split(":", 1)[1] + ".wav")
        if not p.exists(): raise HTTPException(400, f"示例声不存在：{voice}")
        return str(p), None, None
    f = VOICES / f"{voice}.json"
    if f.exists():
        v = json.load(open(f)); return str(VOICES / v["ref"]), v.get("refText"), None
    spec = ENGINES.get(engine_id, {})
    if any(b["id"] == voice for b in spec.get("voices", [])): return None, None, voice
    if voice.startswith(engine_id + ":"): return None, None, voice.split(":", 1)[1]
    raise HTTPException(400, f"未知音色 {voice}（我的音色 id / sample:voice_05 / 该模型的内置音色 id）")

def default_ref():
    ex = sample_voices()
    for want in ("sample:voice_05", "sample:voice_09", "sample:voice_11"):
        for v in ex:
            if v["id"] == want: return v["ref"]
    if ex: return ex[0]["ref"]
    raise HTTPException(400, "没有参考声：传 voice（我的音色 / sample:…）或 ref 文件")


# ----------------------------------------------------------------------------------------------
# Synthesis core
# ----------------------------------------------------------------------------------------------
def synth(text, engine_id=None, voice=None, ref_path=None, ref_text=None, params=None, fmt="wav"):
    text = (text or "").strip()
    if not text: raise HTTPException(400, "text is empty")
    if len(text) > 4000: raise HTTPException(400, "text too long (max 4000 chars per request; split it)")
    params = dict(params or {})
    eid = engine_id or DEFAULT_ENGINE
    if eid not in ENGINES: raise HTTPException(400, f"未知语音模型 {eid}")
    spec = ENGINES[eid]
    builtin = None
    if ref_path is None:
        ref_path, rt, builtin = resolve_voice(voice, eid)
        if rt and not ref_text: ref_text = rt
    if ref_path is None and builtin is None:
        if spec["clone"]: ref_path = default_ref()
        elif spec["voices"]: builtin = spec["voices"][0]["id"]
    if ref_path and not spec["clone"] and not builtin:
        raise HTTPException(400, f"{spec['name']} 不支持克隆，请选它的内置音色")
    if ref_path and spec["clone"] and not ref_text and eid == "qwen3-tts":
        try: ref_text = transcribe(ref_path)["text"]   # zero-shot engines want the prompt transcript
        except Exception as e: log("ref transcription failed:", e); ref_text = ""
    e = ensure_engine(eid)
    out = tempfile.NamedTemporaryFile(prefix="tts_", suffix=".wav", dir=str(CACHE), delete=False).name
    t0 = time.time()
    path = e.synth(text, ref_path, ref_text, builtin, params, out)
    dur = None
    try:
        import soundfile as sf
        info = sf.info(path); dur = info.frames / info.samplerate
    except Exception: pass
    log(f"tts[{eid}] {len(text)} chars → {dur and round(dur, 2)}s in {time.time()-t0:.1f}s voice={voice or builtin or 'ref'}")
    final = path
    if fmt in ("mp3", "opus", "aac", "flac"):
        final = path[:-4] + "." + ("m4a" if fmt == "aac" else fmt)
        codec = {"mp3": ["-c:a", "libmp3lame", "-b:a", "128k"], "opus": ["-c:a", "libopus", "-b:a", "64k"], "aac": ["-c:a", "aac", "-b:a", "128k"], "flac": ["-c:a", "flac"]}[fmt]
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", path, *codec, final], check=True)
    data = open(final, "rb").read()
    for p in {path, final}:
        try: os.remove(p)
        except Exception: pass
    return data, dur, eid

MIME = {"wav": "audio/wav", "mp3": "audio/mpeg", "opus": "audio/ogg", "aac": "audio/aac", "flac": "audio/flac"}


# ----------------------------------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------------------------------
@app.get("/health")
def health():
    return {"ok": True, "model": DEFAULT_ENGINE, "engines": {k: {"loaded": v.loaded} for k, v in ENGINE.items()}, "tts_loaded": any(v.loaded for v in ENGINE.values()), "asr_loaded": _asr is not None, "uptime": round(time.time() - _t0)}

@app.get("/engines")
def engines():
    return [{"id": k, "name": s["name"], "loaded": ENGINE[k].loaded, "clone": s["clone"], "langs": s["langs"], "controls": s["controls"], "voices": s["voices"], "notes": s["notes"], "installed": s["kind"] == "inprocess" or Path(s["venv"]).exists(), "default": k == DEFAULT_ENGINE} for k, s in ENGINES.items()]

@app.post("/engines/{eid}/load")
def engine_load(eid: str):
    ensure_engine(eid); return {"ok": True, "loaded": [k for k, v in ENGINE.items() if v.loaded]}

@app.post("/engines/{eid}/unload")
def engine_unload(eid: str):
    e = ENGINE.get(eid)
    if not e: raise HTTPException(400, "未知语音模型")
    e.unload(); return {"ok": True, "loaded": [k for k, v in ENGINE.items() if v.loaded]}

@app.get("/voices")
def voices(engine: str = None):
    return {"saved": saved_voices(), "samples": sample_voices(), "builtin": {k: s["voices"] for k, s in ENGINES.items() if not engine or k == engine}}

@app.post("/voices")
async def voice_create(request: Request):
    ctype = request.headers.get("content-type", "")
    name = note = None; src = None; tmp = None; start = 0.0; want = 20.0
    if ctype.startswith("multipart/form-data"):
        form = await request.form(); name = form.get("name"); note = form.get("note"); up = form.get("ref")
        try: start = max(0.0, float(form.get("start") or 0))
        except Exception: start = 0.0
        try: want = min(30.0, max(3.0, float(form.get("seconds") or 20)))
        except Exception: want = 20.0
        if up is None or not hasattr(up, "read"): raise HTTPException(400, "需要 ref 文件")
        tmp = tempfile.NamedTemporaryFile(prefix="ref_", suffix=os.path.splitext(up.filename or "ref.wav")[1] or ".wav", dir=str(CACHE), delete=False).name
        open(tmp, "wb").write(await up.read()); src = tmp
    else:
        j = await request.json(); name = j.get("name"); note = j.get("note"); src = j.get("ref_path")
        start = max(0.0, float(j.get("start") or 0)); want = min(30.0, max(3.0, float(j.get("seconds") or 20)))
        if not src or not os.path.exists(src): raise HTTPException(400, "ref_path 不存在")
    if not (name or "").strip(): raise HTTPException(400, "name is required")
    vid = "v_" + uuid.uuid4().hex[:8]
    wav = str(VOICES / f"{vid}.wav")
    try:
        # Both engines are zero-shot: they take ONE short reference clip, so the useful range is a few
        # seconds to about half a minute of clean speech — longer mostly adds room tone. The caller can
        # move the window (start) and stretch it (seconds, 3–30) when the good part is not at the front.
        r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(start), "-i", src, "-t", str(want),
                            "-af", "silenceremove=start_periods=1:start_duration=0.1:start_threshold=-45dB",
                            "-ac", "1", "-ar", "24000", wav], capture_output=True, text=True)
        if r.returncode != 0: raise HTTPException(400, "参考声不是可解码的音频/视频：" + (r.stderr or "")[-200:])
        try:
            import soundfile as sf
            info = sf.info(wav); secs = info.frames / info.samplerate
        except Exception: secs = None
        t = transcribe(wav)
        v = {"id": vid, "name": name.strip()[:60], "note": (note or "")[:300], "ref": f"{vid}.wav", "refText": t.get("text", ""), "language": t.get("language"), "seconds": secs and round(secs, 2), "createdAt": int(time.time())}
        json.dump(v, open(VOICES / f"{vid}.json", "w"), ensure_ascii=False, indent=1)
        log(f"saved voice {vid} '{v['name']}' {secs}s: {v['refText'][:40]}")
        return v
    finally:
        if tmp:
            try: os.remove(tmp)
            except Exception: pass

@app.get("/voices/{vid}/sample")
def voice_sample(vid: str):
    if vid.startswith("sample:"):
        p = EXAMPLES / (vid.split(":", 1)[1] + ".wav")
        if not p.exists(): raise HTTPException(404)
        return FileResponse(str(p), media_type="audio/wav")
    f = VOICES / f"{vid}.json"
    if not f.exists(): raise HTTPException(404)
    return FileResponse(str(VOICES / json.load(open(f))["ref"]), media_type="audio/wav")

@app.patch("/voices/{vid}")
async def voice_patch(vid: str, request: Request):
    f = VOICES / f"{vid}.json"
    if not f.exists(): raise HTTPException(404)
    v = json.load(open(f)); j = await request.json()
    for k in ("name", "note", "refText", "defaults"):
        if k in j: v[k] = j[k]
    json.dump(v, open(f, "w"), ensure_ascii=False, indent=1); return v

@app.delete("/voices/{vid}")
def voice_delete(vid: str):
    f = VOICES / f"{vid}.json"
    if not f.exists(): raise HTTPException(404)
    v = json.load(open(f))
    for p in (f, VOICES / v["ref"]):
        try: os.remove(p)
        except Exception: pass
    return {"ok": True}


async def _parse_tts(request: Request):
    """Shared parser for /tts (json or multipart with an uploaded reference)."""
    ctype = request.headers.get("content-type", "")
    ref_tmp = None
    if ctype.startswith("multipart/form-data"):
        form = await request.form()
        g = lambda k: form.get(k)
        params = {k: g(k) for k in ("emotion", "emo_alpha", "emo_vector", "instruct", "speed", "language", "design") if g(k) not in (None, "")}
        up = g("ref")
        if up is not None and hasattr(up, "read"):
            ref_tmp = tempfile.NamedTemporaryFile(prefix="ref_", suffix=os.path.splitext(up.filename or "ref.wav")[1] or ".wav", dir=str(CACHE), delete=False).name
            open(ref_tmp, "wb").write(await up.read())
        return dict(text=g("text"), model=g("model"), voice=g("voice"), ref_path=ref_tmp or g("ref_path"), ref_text=g("ref_text"), params=params, fmt=g("format") or "wav"), ref_tmp
    j = await request.json()
    params = dict(j.get("params") or {})
    for k in ("emotion", "emo_alpha", "emo_vector", "instruct", "speed", "language", "design", "emotion_ref"):
        if j.get(k) not in (None, ""): params[k] = j[k]
    ref = j.get("ref") or j.get("ref_path")
    if ref and not os.path.exists(ref): raise HTTPException(400, f"ref not found: {ref}")
    return dict(text=j.get("text"), model=j.get("model"), voice=j.get("voice"), ref_path=ref, ref_text=j.get("ref_text"), params=params, fmt=j.get("format") or "wav"), None


@app.post("/tts")
async def tts(request: Request):
    args, tmp = await _parse_tts(request)
    try:
        data, dur, eid = synth(args["text"], args["model"], args["voice"], args["ref_path"], args["ref_text"], args["params"], args["fmt"])
        return Response(content=data, media_type=MIME.get(args["fmt"], "audio/wav"), headers={"X-Audio-Seconds": str(dur or ""), "X-Model": eid})
    finally:
        if tmp:
            try: os.remove(tmp)
            except Exception: pass


@app.post("/asr")
async def asr(file: UploadFile = File(...), language: str = Form("auto"), itn: bool = Form(True)):
    tmp = tempfile.NamedTemporaryFile(prefix="asr_", suffix=os.path.splitext(file.filename or "a.wav")[1] or ".wav", dir=str(CACHE), delete=False).name
    open(tmp, "wb").write(await file.read())
    try:
        t0 = time.time(); r = transcribe(tmp, language, itn); log(f"asr {file.filename} → {len(r['text'])} chars in {time.time()-t0:.1f}s"); return r
    finally:
        try: os.remove(tmp)
        except Exception: pass


# ---- OpenAI-compatible surface -----------------------------------------------------------------
@app.post("/v1/audio/speech")
async def openai_speech(request: Request):
    j = await request.json()
    model = j.get("model") or DEFAULT_ENGINE
    if model in ("tts-1", "tts-1-hd", "gpt-4o-mini-tts"): model = DEFAULT_ENGINE
    fmt = j.get("response_format") or "mp3"
    if fmt not in MIME: fmt = "mp3"
    params = {}
    if j.get("speed") not in (None, 1, 1.0): params["speed"] = float(j["speed"])
    if j.get("instructions"): params["instruct"] = j["instructions"]; params["emotion"] = j["instructions"]
    data, dur, eid = synth(j.get("input"), model, j.get("voice"), None, None, params, fmt)
    return Response(content=data, media_type=MIME[fmt], headers={"X-Audio-Seconds": str(dur or ""), "X-Model": eid})

@app.post("/v1/audio/transcriptions")
async def openai_transcriptions(file: UploadFile = File(...), model: str = Form("sensevoice-small"), language: str = Form("auto"), response_format: str = Form("json")):
    r = await asr(file, language if language not in ("", None) else "auto", True)
    if response_format == "text": return Response(content=r["text"], media_type="text/plain")
    if response_format == "verbose_json": return {"task": "transcribe", "language": r["language"], "text": r["text"], "emotion": r["emotion"], "events": r["events"]}
    return {"text": r["text"]}

@app.get("/v1/models")
def openai_models():
    data = [{"id": k, "object": "model", "owned_by": "atelier", "type": "tts", "loaded": ENGINE[k].loaded, "clone": s["clone"], "voices": [v["id"] for v in s["voices"]]} for k, s in ENGINES.items()]
    data.append({"id": "sensevoice-small", "object": "model", "owned_by": "atelier", "type": "asr"})
    return {"object": "list", "data": data, "voices": [{"id": v["id"], "name": v["name"]} for v in saved_voices()] + [{"id": v["id"], "name": v["name"]} for v in sample_voices()]}


@app.on_event("startup")
def _preload():
    if os.environ.get("VOICE_PRELOAD", "1") == "1" and DEFAULT_ENGINE in ENGINES:
        threading.Thread(target=lambda: (lambda: (ensure_engine(DEFAULT_ENGINE), load_asr()))(), daemon=True).start()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8600")), log_level="info")
