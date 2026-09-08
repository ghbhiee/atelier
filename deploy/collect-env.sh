#!/bin/sh
# 从当前活跃的 GPU 机器收走「跑通了的环境」，存到 13：
#   sh deploy/collect-env.sh voice   → 更新仓库里的 gpu/voice/requirements.lock.txt
#   sh deploy/collect-env.sh llm     → 更新 13 缓存里的 llama-cuda-sm120.tgz
# 目的：下一台机器不用再解析依赖、不用再编译，照着装就行。
set -eu
WHAT=${1:?voice | llm}
ENVF=/etc/atelier/env
SRC=${SRC:-/opt/services/atelier}
envget() { sed -n "s/^$1=//p" "$ENVF" | tail -1 | sed "s/^['\"]//; s/['\"]$//"; }
KEY=$(envget GPUCTL_KEY); PORT=$(envget GPUCTL_PORT)
[ -n "$PORT" ] || PORT=$(ss -tlnp 2>/dev/null | grep -oE '127\.0\.0\.1:19[0-9]89' | head -1 | cut -d: -f2)
[ -n "$PORT" ] || { echo "找不到活跃机器的隧道端口"; exit 1; }
DATA=$(envget DATA_DIR); [ -n "$DATA" ] || DATA=$SRC/data
RS() { sudo -u atelier ssh -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no root@127.0.0.1 "$@"; }
RC() { sudo -u atelier scp -i "$KEY" -P "$PORT" -o StrictHostKeyChecking=no "root@127.0.0.1:$1" "$2"; }

RS "bash /root/atelier-gpu/freeze-env.sh $WHAT"
case "$WHAT" in
  voice)
    RC /tmp/voice.lock.txt /tmp/voice.lock.txt
    cp /tmp/voice.lock.txt "$SRC/gpu/voice/requirements.lock.txt"
    echo "已更新 $SRC/gpu/voice/requirements.lock.txt（$(wc -l < /tmp/voice.lock.txt) 个包）"
    echo "记得把它提交进仓库"
    ;;
  llm)
    mkdir -p "$DATA/cache"
    RC "/tmp/llama-cuda-sm120.tgz" "/tmp/llama-cuda-sm120.tgz"
    mv /tmp/llama-cuda-sm120.tgz "$DATA/cache/" && chown atelier:atelier "$DATA/cache/llama-cuda-sm120.tgz"
    ls -lh "$DATA/cache/llama-cuda-sm120.tgz"
    ;;
esac
