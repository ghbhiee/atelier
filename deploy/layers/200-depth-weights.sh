#!/bin/bash
# 白模用的 Depth Anything V2 Large（HF 格式）。共享盘 /model 上没有这个格式（只有 Kijai 的
# safetensors 和 Depth-Anything-3），所以必须落在本机。1.3 GB，走 hf-mirror。
set -eu
D=/root/model-cache/Depth-Anything-V2-Large-hf
B=https://hf-mirror.com/depth-anything/Depth-Anything-V2-Large-hf/resolve/main
mkdir -p "$D"
ok=1
for f in config.json preprocessor_config.json model.safetensors; do
  [ -s "$D/$f" ] && continue
  curl -fsSL --noproxy '*' --max-time 1800 --retry 3 -o "$D/$f" "$B/$f" || ok=0
done
[ "$ok" = 1 ] || { echo "下载没全成"; exit 1; }
# 大小对不对：正片 1.34 GB，半截文件会让 transformers 在加载时才炸
sz=$(stat -c %s "$D/model.safetensors")
[ "$sz" -gt 1300000000 ] || { echo "model.safetensors 只有 $sz 字节，不完整"; exit 1; }
echo "深度权重就位（$(du -sh "$D" | cut -f1)）"
