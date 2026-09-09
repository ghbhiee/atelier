#!/bin/bash
# 语音栈：IndexTTS-2 的 venv + SenseVoice。179 个包钉在 gpu/voice/requirements.lock.txt 里，
# 一律国内源。torch 三件套不钉——每个镜像自带的 CUDA 版不一样，钉死会把好的覆盖掉。
set -eu
[ -x /root/index-tts/.venv/bin/python ] && { echo "已有语音 venv"; exit 0; }
bash /root/atelier-gpu/install-voice.sh
