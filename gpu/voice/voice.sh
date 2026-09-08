#!/bin/bash
# Voice runner: IndexTTS-2 + SenseVoice service inside /root/index-tts/.venv (Python 3.11, torch 2.8 cu128).
# MODEL / MODEL_ID / KIND / ASR_MODEL come from /root/runners/voice.env (written by `gpuctl start voice KEY=VAL…`).
set -a; [ -f /root/runners/voice.env ] && . /root/runners/voice.env; set +a
# IndexTTS-2 wants to write an hf_cache/ (w2v-bert, MaskGCT codec, bigvgan) next to its checkpoints, and /model is
# read-only — so the model dir is a writable mirror of symlinks under /root/model-cache (built by install-gpu.sh).
export MODEL="${MODEL:-/root/model-cache/IndexTTS-2}"
export MODEL_ID="${MODEL_ID:-indextts-2}"
export ASR_MODEL="${ASR_MODEL:-/model/ModelScope/gongjy/SenseVoiceSmall}"
export PORT="${PORT:-8600}"
export INDEXTTS_ROOT=/root/index-tts
export HF_HOME=/root/model-cache/hf MODELSCOPE_CACHE=/root/model-cache/modelscope
case "$MODEL" in /model/*) m=/root/model-cache/$(basename "$MODEL"); mkdir -p "$m"; for f in "$MODEL"/* "$MODEL"/.[!.]*; do [ -e "$f" ] && [ ! -e "$m/$(basename "$f")" ] && ln -s "$f" "$m/$(basename "$f")"; done; export MODEL="$m";; esac
# workers spawned by a previous router life would keep their ports (and VRAM); start clean
pkill -9 -f "atelier-gpu/voice/workers/" 2>/dev/null || true
cd /root/index-tts
exec /root/index-tts/.venv/bin/python /root/atelier-gpu/voice/server.py
