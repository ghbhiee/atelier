#!/bin/bash
# Install the extra TTS engines on the GPU box, each in its own venv (uv, Aliyun mirrors, torch 2.8 cu128 from the
# local wheel cache /root/wheels — see /root/voice-install.sh for how those wheels were fetched). Idempotent.
#   bash /root/atelier-gpu/voice/install-backends.sh [qwen|kokoro|all]
# Run detached (supervisor one-shot or nohup) — pip pulls a few GB. Logs go to stdout.
set -u
export PATH=/root/venvs/build/bin:/root/.local/bin:/usr/local/cuda/bin:$PATH
IDX=https://mirrors.aliyun.com/pypi/simple
WHEELS=/root/wheels
OVR=/root/wheels/overrides.txt
mkdir -p /root/venvs "$WHEELS"
printf "torch==2.8.0+cu128\ntorchaudio==2.8.0+cu128\ntorchvision==0.23.0+cu128\n" > "$OVR"
# torchvision wheel is needed by some deps; fetch like the others if missing
f="torchvision-0.23.0+cu128-cp311-cp311-manylinux_2_28_x86_64.whl"
[ -s "$WHEELS/$f" ] || curl -sL --max-time 3600 -o "$WHEELS/$f" "https://mirrors.aliyun.com/pytorch-wheels/cu128/${f/+/%2B}" || true
UVPIP() { uv pip install --python "$1/bin/python" --default-index "$IDX" --find-links "$WHEELS" --override "$OVR" "${@:2}"; }
what=${1:-all}


if [ "$what" = qwen ] || [ "$what" = all ]; then
  echo "== Qwen3-TTS"
  [ -x /root/venvs/qwen-tts/.venv/bin/python ] || uv venv --python 3.11 /root/venvs/qwen-tts/.venv
  UVPIP /root/venvs/qwen-tts/.venv "torch==2.8.0+cu128" "torchaudio==2.8.0+cu128" qwen-tts soundfile 2>&1 | tail -3
  /root/venvs/qwen-tts/.venv/bin/python -c "import qwen_tts, torch; print('qwen_tts', getattr(qwen_tts, '__version__', '?'), 'torch', torch.__version__, torch.cuda.is_available())"
fi

if [ "$what" = kokoro ] || [ "$what" = all ]; then
  echo "== Kokoro"
  [ -x /root/venvs/kokoro/.venv/bin/python ] || uv venv --python 3.11 /root/venvs/kokoro/.venv
  UVPIP /root/venvs/kokoro/.venv "torch==2.8.0+cu128" kokoro "misaki[zh,ja]" soundfile pip 2>&1 | tail -3
  # kokoro's English G2P (misaki[en]) wants spaCy's en_core_web_sm, fetched with pip inside the venv
  /root/venvs/kokoro/.venv/bin/python -c "import spacy; spacy.load('en_core_web_sm')" 2>/dev/null || /root/venvs/kokoro/.venv/bin/python -m spacy download en_core_web_sm 2>&1 | tail -1
  # espeak-ng gives Kokoro its English fallback G2P; apt is safe here (no nvidia deps) but keep it detached like every apt on this box
  which espeak-ng >/dev/null 2>&1 || (DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends espeak-ng 2>&1 | tail -1)
  /root/venvs/kokoro/.venv/bin/python -c "import kokoro, torch; print('kokoro', getattr(kokoro, '__version__', '?'), 'torch', torch.__version__, torch.cuda.is_available())"
fi
echo "INSTALL_BACKENDS_EXIT=0"
