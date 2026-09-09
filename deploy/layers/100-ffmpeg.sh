#!/bin/bash
# ffmpeg / ffprobe。pod 镜像常常没有，素材服务一收文件就崩。
# 走 npmmirror（实测 5.8 秒；johnvansickle 那个美国站要几分钟）。
set -eu
[ -x /usr/local/bin/ffmpeg ] && [ -x /usr/local/bin/ffprobe ] && { echo "已有 $(ffmpeg -version | head -1)"; exit 0; }
bash /root/atelier-gpu/install-ffmpeg.sh
