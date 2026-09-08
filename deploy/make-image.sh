#!/bin/sh
# 把当前活跃的 GPU 机器做成私有镜像，之后新机器直接用它开，什么都不用装。在 13 上跑：
#   sh deploy/make-image.sh <镜像名>
#
# 顺序很重要：先清密钥再打快照。镜像会把整个根盘烤进去，密钥留在里面等于每台新机器
# 都带着同一份素材服务密钥和隧道口令。
set -eu
NAME=${1:?给镜像起个名字，例如 atelier-2026-09-08}
ENVF=/etc/atelier/env
SRC=${SRC:-/opt/services/atelier}
envget() { sed -n "s/^$1=//p" "$ENVF" | tail -1 | sed "s/^['\"]//; s/['\"]$//"; }
KEY=$(envget GPUCTL_KEY); PORT=$(envget GPUCTL_PORT)
[ -n "$PORT" ] || PORT=$(ss -tlnp 2>/dev/null | grep -oE '127\.0\.0\.1:19[0-9]89' | head -1 | cut -d: -f2)
RS() { sudo -u atelier ssh -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no root@127.0.0.1 "$@"; }

echo "== 1/3 把清理脚本送上去并执行（清密钥、停服务）"
tar -C "$SRC/gpu" -cf - prep-image.sh | sudo -u atelier ssh -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no root@127.0.0.1 'tar -C /root/atelier-gpu -xf -'
RS 'bash /root/atelier-gpu/prep-image.sh'

echo
echo "== 2/3 打快照"
echo "   注意：清理之后这台机器我们就连不上了（authorized_keys 已清空），"
echo "   所以快照必须现在打，打完这台就当废弃处理。"
/opt/services/node-current/bin/node - "$NAME" <<'JS'
const { loadConfig } = await import("/opt/services/atelier/server/src/config.js");
const { CompShare } = await import("/opt/services/atelier/server/src/compshare.js");
const fs = await import("node:fs");
const env = Object.fromEntries(fs.readFileSync("/etc/atelier/env", "utf8").split("\n")
  .filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const cfg = loadConfig({ ...process.env, ...env });
const b = cfg.fleet.active;
const cs = new CompShare({ publicKey: cfg.compshare.publicKey, privateKey: cfg.compshare.privateKey });
const r = await cs.invoke("CreateCompShareCustomImage", {
  Region: b.region, Zone: b.zone, UHostId: b.instanceId,
  ImageName: process.argv[2], ImageDescription: "Atelier: ComfyUI+H3 / llama.cpp CUDA / IndexTTS-2 / ffmpeg",
});
console.log("   ", JSON.stringify(r));
JS

echo
echo "== 3/3 之后怎么用"
echo "   在 CompShare 控制台用这个私有镜像开新机器，然后："
echo "     sh deploy/add-gpu.sh <名字> '<新机器的 ssh 命令>' <端口基数> '<密码>'"
echo "   add-gpu 会重新塞钥匙、生成隧道密钥、写回 SECRET 与隧道口令、签新证书。"
echo "   软件都在镜像里，不用再装，整个过程几十秒。"
