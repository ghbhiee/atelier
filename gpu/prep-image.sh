#!/bin/bash
# 把这台机器整理成「可以做成私有镜像」的状态：软件全留，密钥全清。
# 在要做镜像的 GPU 机上跑，跑完立刻去做镜像；做完镜像这台就废了（密钥没了，连不上）。
#
# 为什么要清：私有镜像会把整个根盘烤进去，任何用这个镜像开的机器都带着同一份密钥。
# 素材服务的 SECRET、车队隧道的口令、我们的 authorized_keys，一个都不能留。
set -euo pipefail
say() { echo "== $*"; }

say "素材服务的密钥"
[ -f /root/runners/assets.env ] && sed -i "s/^SECRET=.*/SECRET=/; s/^PUBLIC_IP=.*/PUBLIC_IP=/" /root/runners/assets.env && echo "   已清空 SECRET"
say "车队隧道口令"
[ -f /etc/atelier/hy2-client.yaml ] && sed -i "s/^auth:.*/auth: REPLACE_ME/" /etc/atelier/hy2-client.yaml && echo "   已置为占位符"
say "反向隧道的机器密钥（每台必须自己生成，共用会串到别人的端口）"
rm -f /root/.ssh/tunnel_ed25519 /root/.ssh/tunnel_ed25519.pub
say "我们塞进去的 authorized_keys"
: > /root/.ssh/authorized_keys
say "自签证书（每台自己签，指纹要不一样）"
rm -rf /root/atelier-assets/tls
say "跑过的痕迹"
rm -rf /root/atelier-assets/blobs /root/atelier-assets/meta /root/atelier-assets/parts 2>/dev/null || true
rm -f /root/*.log /root/llm-install.log /root/voice-install.log /root/relink.log /root/try.log 2>/dev/null || true
rm -rf /root/.cache/pip /root/index-tts/.venv/pkgs 2>/dev/null || true
find /root -name "*.pyc" -delete 2>/dev/null || true
say "supervisor 里跑着的先停掉，免得镜像里带着运行状态"
supervisorctl stop llm voice comfyui assets gputunnel hytunnel >/dev/null 2>&1 || true

echo
echo "已经可以做镜像了。软件都在："
for f in /root/llama.cpp/build/bin/llama-server /root/index-tts/.venv/bin/python /root/ComfyUI/main.py \
         /usr/local/bin/ffmpeg /usr/local/bin/gpuctl /usr/local/bin/hysteria; do
  [ -e "$f" ] && echo "  ✓ $f" || echo "  ✗ 缺 $f"
done
echo
echo "做完镜像后，用它开的新机器跑一次 deploy/add-gpu.sh 即可（几十秒）："
echo "  它会重新塞钥匙、生成隧道密钥、写回 SECRET 与隧道口令、签新证书。"
