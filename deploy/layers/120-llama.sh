#!/bin/bash
# llama.cpp（CUDA）。优先从 13 的缓存拉编好的二进制（隧道上十几秒），拉不到才在盒子上编（20–40 分钟）。
# llama.cpp 已经不出 Linux 的 CUDA 预编译版，所以 13 上那份是我们自己编的。
set -eu
[ -x /root/llama.cpp/build/bin/llama-server ] && { echo "已有 $(/root/llama.cpp/build/bin/llama-server --version 2>&1 | head -1)"; exit 0; }
ARCH=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '.')
[ -n "${ARCH:-}" ] || ARCH=120
LLAMA_CACHE_URL="${FLEET_BASE:-}/_fleet/cache/llama-cuda-sm${ARCH}.tgz" bash /root/atelier-gpu/install-llm.sh
