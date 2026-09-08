#!/bin/bash
# 把一台已经跑通的机器上的环境冻下来，供下一台直接照装。在 GPU 机上跑：
#   bash /root/atelier-gpu/freeze-env.sh voice   → /tmp/voice.lock.txt
#   bash /root/atelier-gpu/freeze-env.sh llm     → /tmp/llama-cuda-sm120.tgz
# 冻出来的东西由 13 收走（deploy/collect-env.sh），进仓库或进 13 的缓存目录。
set -euo pipefail
WHAT=${1:?voice | llm}
case "$WHAT" in
  voice)
    PY=/root/index-tts/.venv/bin/python
    [ -x "$PY" ] || { echo "语音 venv 不在"; exit 1; }
    # torch 三件套不冻：每个镜像自带的 CUDA 版不一样，钉死了反而会把好的覆盖掉
    "$PY" -m pip freeze | grep -viE '^(torch|torchaudio|torchvision|nvidia-|triton)([=<>@]|$)' | sort > /tmp/voice.lock.txt
    echo "冻了 $(wc -l < /tmp/voice.lock.txt) 个包 → /tmp/voice.lock.txt"
    "$PY" -c "import torch;print('（当时的 torch：', torch.__version__, '）')"
    ;;
  llm)
    B=/root/llama.cpp/build/bin
    [ -x "$B/llama-server" ] || { echo "llama-server 不在"; exit 1; }
    ARCH=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d '.')
    cd "$B" && tar -czf "/tmp/llama-cuda-sm${ARCH}.tgz" llama-server *.so* 2>/dev/null
    ls -lh "/tmp/llama-cuda-sm${ARCH}.tgz"
    ;;
  *) echo "只认 voice 或 llm"; exit 1;;
esac
