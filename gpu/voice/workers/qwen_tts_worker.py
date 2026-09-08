#!/usr/bin/env python3
"""Qwen3-TTS worker (Qwen/Qwen3-TTS-12Hz-1.7B-*). Runs in /root/venvs/qwen-tts/.venv (pip: qwen-tts).

Three checkpoints, one worker; the checkpoint is swapped on demand:
  * CustomVoice (MODEL_PATH)  — built-in speakers (Vivian, Serena, Uncle_Fu, Dylan, Eric, Ryan, Aiden, Ono_Anna, Sohee)
                                + `instruct` style prompt      → used when a built-in `voice` is given
  * Base (EXTRA_PATHS.base)   — voice clone from ref audio + its transcript      → used when a reference clip is given
  * VoiceDesign (EXTRA_PATHS.design) — invent a voice from a text description   → used when params.design is given
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _base import serve, save_wav

LANGS = {"zh": "Chinese", "en": "English", "ja": "Japanese", "ko": "Korean", "de": "German", "fr": "French", "ru": "Russian", "pt": "Portuguese", "es": "Spanish", "it": "Italian"}


class Engine:
    NAME = "qwen3-tts"
    VOICES = [{"id": v} for v in ["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"]]

    def __init__(self):
        self.paths = {"custom": os.environ.get("MODEL_PATH")}
        self.paths.update(json.loads(os.environ.get("EXTRA_PATHS") or "{}"))
        self.models = {}; self.cur = None

    def _get(self, kind):
        if kind not in self.models:
            import torch
            from qwen_tts import Qwen3TTSModel
            path = self.paths.get(kind)
            if not path or not os.path.exists(path): raise ValueError(f"Qwen3-TTS {kind} checkpoint missing: {path}")
            # keep one checkpoint resident at a time (each ~4 GB)
            for k in list(self.models):
                if k != kind: del self.models[k]
            import gc; gc.collect(); torch.cuda.empty_cache()
            self.models[kind] = Qwen3TTSModel.from_pretrained(path, device_map="cuda:0", dtype=torch.bfloat16)
        return self.models[kind]

    def load(self):
        self._get("custom")

    def unload(self):
        self.models.clear()
        import gc, torch; gc.collect(); torch.cuda.empty_cache()

    def synth(self, text, ref_path, ref_text, voice, params, out):
        lang = params.get("language") or "Auto"
        if lang in LANGS: lang = LANGS[lang]
        instruct = (params.get("instruct") or "").strip() or None
        design = (params.get("design") or "").strip()
        if design:
            m = self._get("design"); wavs, sr = m.generate_voice_design(text=text, language=lang, instruct=design)
        elif ref_path:
            m = self._get("base"); wavs, sr = m.generate_voice_clone(text=text, language=lang, ref_audio=ref_path, ref_text=ref_text or None)
        else:
            m = self._get("custom"); wavs, sr = m.generate_custom_voice(text=text, language=lang, speaker=voice or "Vivian", instruct=instruct)
        audio = wavs[0] if isinstance(wavs, (list, tuple)) else wavs
        return save_wav(out, audio, sr)


if __name__ == "__main__":
    serve(Engine())
