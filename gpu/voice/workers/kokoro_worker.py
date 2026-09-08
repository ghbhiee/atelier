#!/usr/bin/env python3
"""Kokoro-82M worker (hexgrad/Kokoro-82M-v1.1-zh for Chinese, hexgrad/Kokoro-82M for the rest).
Runs in /root/venvs/kokoro/.venv (pip: kokoro misaki[zh,ja]). Built-in voices only, `speed` control, ~ms per sentence.

Voice id prefix picks the language pipeline: zf_/zm_ → zh, af_/am_/bf_/bm_ → en, jf_/jm_ → ja, ff_ → fr, if_/im_ → it, pf_/pm_ → pt, ef_/em_ → es, hf_/hm_ → hi.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _base import serve, save_wav

LANG_BY_PREFIX = {"z": "z", "a": "a", "b": "b", "j": "j", "f": "f", "i": "i", "p": "p", "e": "e", "h": "h"}
ZH_REPO = os.environ.get("MODEL_PATH") or "hexgrad/Kokoro-82M-v1.1-zh"
EN_REPO = "hexgrad/Kokoro-82M"


class Engine:
    NAME = "kokoro"
    VOICES = []

    def __init__(self): self.pipes = {}; self.voice_repo = {}

    def _pipe(self, lang, repo=None):
        """A pipeline is (language, repo): v1.1-zh ships English voices too (af_maple, af_sol, bf_vale),
        and asking the plain Kokoro-82M repo for them is a 404. Voices remember where they came from."""
        repo = repo or (ZH_REPO if lang == "z" else EN_REPO)
        key = (lang, repo)
        if key not in self.pipes:
            from kokoro import KPipeline
            if lang == "z":
                # English words inside Chinese text need an English G2P (spaCy en_core_web_sm). Building that
                # second pipeline costs another ~330 MB of fp32 weights, so do it on the first sentence that
                # actually contains Latin letters rather than at load time.
                def en_callable(text):
                    if not text.strip(): return ""
                    try: return next(self._pipe("a", EN_REPO)(text, voice="af_heart"))[1]
                    except Exception as e:
                        print("[kokoro] English G2P unavailable:", e, flush=True); return ""
                self.pipes[key] = KPipeline(lang_code="z", repo_id=repo, en_callable=en_callable)
            else:
                self.pipes[key] = KPipeline(lang_code=lang, repo_id=repo)
        return self.pipes[key]

    def load(self):
        self._pipe("z")
        # built-in voices = the voice packs shipped in the model snapshots (v1.1-zh has ~100 zf_/zm_ voices; en has af_/am_/bf_/bm_…)
        voices = []
        try:
            from huggingface_hub import snapshot_download
            for repo, langs in ((ZH_REPO, "zh"), (EN_REPO, "en")):
                d = os.path.join(snapshot_download(repo, allow_patterns=["voices/*.pt"]), "voices")
                for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
                    if not f.endswith(".pt"): continue
                    vid = f[:-3]; g = "女" if vid[1:2] == "f" else "男"
                    if langs == "en" and vid[0] not in ("a", "b"): continue
                    if vid in self.voice_repo: continue          # first repo that has it wins
                    self.voice_repo[vid] = repo
                    lang = "zh" if vid[0] == "z" else "en" if vid[0] in ("a", "b") else langs
                    voices.append({"id": vid, "name": f"{vid} · {g} · {lang}", "lang": lang})
        except Exception as e:
            print("[kokoro] voice listing failed:", e, flush=True)
        if voices: self.VOICES = voices

    def unload(self):
        self.pipes.clear()
        import gc, torch; gc.collect(); torch.cuda.empty_cache()

    def synth(self, text, ref_path, ref_text, voice, params, out):
        import numpy as np
        voice = voice or "zf_001"
        lang = LANG_BY_PREFIX.get(voice[:1], "z")
        # Each voice pack belongs to one language. Handing Chinese text to an English voice does not fail —
        # espeak just spells every character out as "Chinese letter" — so refuse and name a voice that works.
        cjk = any("\u3400" <= c <= "\u9fff" or "\u3040" <= c <= "\u30ff" for c in text)
        if cjk and lang != "z":
            zh = [v["id"] for v in (self.VOICES or []) if str(v.get("id", "")).startswith(("zf_", "zm_"))]
            same = [v for v in zh if v[1:2] == voice[1:2]]
            raise ValueError(f"音色 {voice} 是{'英文' if lang in 'ab' else lang}音色，读不了中文（会把每个汉字念成 'Chinese letter'）。"
                             f"中文请选 zf_/zm_ 开头的音色，例如 {', '.join((same or zh)[:3]) or 'zf_001'}")
        pipe = self._pipe(lang, self.voice_repo.get(voice))
        speed = float(params.get("speed") or 1.0)
        chunks = []
        for _gs, _ps, audio in pipe(text, voice=voice, speed=speed):
            if audio is not None: chunks.append(np.asarray(audio, dtype=np.float32).reshape(-1))
        audio = np.concatenate(chunks) if chunks else np.zeros(1, np.float32)
        return save_wav(out, audio, 24000)


if __name__ == "__main__":
    serve(Engine())
