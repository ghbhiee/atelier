#!/bin/bash
# ffmpeg + ffprobe，静态二进制，不动 apt（在这些 pod 上装包触发过 needrestart 把 sshd 弄挂）。
# 走 npmmirror（国内直连，几秒），拿不到再退回 johnvansickle（美国站，国内很慢）。
set -euo pipefail
command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1 && { echo "已装：$(ffmpeg -version | head -1)"; exit 0; }
VER=${FFMPEG_VER:-b6.1.1}
M=${FFMPEG_MIRROR:-https://registry.npmmirror.com/-/binary/ffmpeg-static}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
got=0
if curl -fsSL --max-time 300 -o "$TMP/ffmpeg.gz" "$M/$VER/ffmpeg-linux-x64.gz" \
   && curl -fsSL --max-time 300 -o "$TMP/ffprobe.gz" "$M/$VER/ffprobe-linux-x64.gz"; then
  gunzip -f "$TMP/ffmpeg.gz" "$TMP/ffprobe.gz"
  install -m755 "$TMP/ffmpeg" /usr/local/bin/ffmpeg
  install -m755 "$TMP/ffprobe" /usr/local/bin/ffprobe
  got=1
fi
if [ "$got" = 0 ]; then
  echo "npmmirror 拿不到，回退 johnvansickle（慢）"
  curl -fsSL --max-time 1200 -o "$TMP/f.tar.xz" https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
  tar -C "$TMP" -xf "$TMP/f.tar.xz"
  D=$(find "$TMP" -maxdepth 1 -type d -name 'ffmpeg-*' | head -1)
  install -m755 "$D/ffmpeg" /usr/local/bin/ffmpeg
  install -m755 "$D/ffprobe" /usr/local/bin/ffprobe
fi
ffmpeg -version | head -1; ffprobe -version | head -1
