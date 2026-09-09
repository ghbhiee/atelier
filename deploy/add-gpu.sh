#!/bin/sh
# 一条命令把一台新租的机器变成可用的工作台节点。在 13 上以 root 跑：
#
#   sh deploy/add-gpu.sh <名字> '<CompShare 给的 ssh 命令>' <端口基数> [ssh 密码]
#   sh deploy/add-gpu.sh shanghai 'ssh -p 24123 root@cpod-xxx.podtcp.compshare.cn' 19288 'Ci1Y...'
#
# 端口基数：第一台 19188，第二台 19288，第三台 19388，依此类推（每台占 4 个：comfy/sshd/llm/voice）。
#
# 下载源一律走国内，别改回默认：机器在大陆，从美国站拉包会卡好几分钟（ffmpeg 就踩过）。
#   pip      → 清华 https://pypi.tuna.tsinghua.edu.cn/simple
#   ffmpeg   → npmmirror（实测 5.8 秒；johnvansickle 那个美国站要几分钟）
#   GitHub   → 直连就行，从盒子实测 5.5 MB/s，不用代理
# 缓存到 13 再推过去反而更慢：13 的上行只有 24 KB/s，盒子自己连国内镜像是几 MB/s。
# 所有下载都带 --max-time，宁可失败也不要无限期等。
# 密码只在第一次用来把钥匙送进去；之后全走密钥。幂等，重复跑没关系。
#
# 做完这些：钥匙 → 反向隧道 → gpuctl/白模节点/素材服务 → 车队隧道 → ComfyUI + 权重软链 → 登记进 env。
# 实测耗时：只装视频/白模约 4–6 分钟；连大模型和语音一起装要久一些（llama.cpp 可能要编译）。
set -eu
BOX=${1:?名字，例如 shanghai}
LOGIN_RAW=${2:?CompShare 显示的 ssh 命令，带引号}
BASE=${3:?端口基数，第二台写 19288}
PASS=${4:-}
ENVF=/etc/atelier/env
SRC=${SRC:-/opt/services/atelier}
KEY=/var/lib/atelier/.ssh/id_ed25519
UP=$(echo "$BOX" | tr '[:lower:]' '[:upper:]')
t0=$(date +%s)
say() { echo "== $* ($(( $(date +%s) - t0 ))s)"; }
envget() { sed -n "s/^$1=//p" "$ENVF" | tail -1 | sed "s/^['\"]//; s/['\"]$//"; }

# 1) 钥匙进去（唯一需要密码的一步）
if [ -n "$PASS" ]; then
  say "钥匙"
  command -v sshpass >/dev/null 2>&1 || { echo "需要 sshpass：apt-get install -y sshpass"; exit 1; }
  PUB=$(cat "${KEY}.pub")
  # shellcheck disable=SC2086
  sshpass -p "$PASS" $LOGIN_RAW -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    "mkdir -p /root/.ssh && chmod 700 /root/.ssh && grep -qF '$PUB' /root/.ssh/authorized_keys 2>/dev/null || echo '$PUB' >> /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys"
fi

# 之后所有远程操作都用密钥
LOGIN=$(echo "$LOGIN_RAW" | sed "s#^ssh #ssh -i $KEY -o StrictHostKeyChecking=no #")
remote() { $LOGIN "$@"; }

# 2) 先把这台登记进 env（provision 要从这里读端口基数）
grep -q "^GPU_${UP}_PORTBASE=" "$ENVF" || {
  say "登记 $BOX"
  printf 'GPU_%s_PORTBASE=%s\n' "$UP" "$BASE" >> "$ENVF"
  CUR=$(envget GPU_BOXES); [ -n "$CUR" ] || CUR=huabei
  echo "$CUR" | tr ',' '\n' | grep -qx "$BOX" || sed -i "s/^GPU_BOXES=.*/GPU_BOXES=${CUR},${BOX}/" "$ENVF"
}

# 3) 隧道 / gpuctl / 白模 / 素材 / 证书
say "provision（隧道 + gpuctl + 素材服务 + 证书）"
sh "$SRC/deploy/provision-gpu.sh" "$BOX" "$LOGIN" "$BASE"

# 3.5) 有供体就直接克隆环境，别再装一遍
# DONOR='ssh -p 24123 root@cpod-A.podtcp.compshare.cn' sh deploy/add-gpu.sh …
# GPU→GPU 是国内直传（MB/s 级），比在新机器上重新解析依赖快，也不会再撞到版本漂移。
if [ -n "${DONOR:-}" ]; then
  say "从供体克隆环境（llama.cpp / 语音 / ComfyUI）"
  sh "$SRC/deploy/clone-env.sh" "$DONOR" "$LOGIN_RAW" all || echo "  ! 克隆没成，退回逐个安装"
fi

# 4) 补齐软件：全部走车队的增量层。层是「基础镜像 → 现在该有的样子」的差额，存在 13 上
#    （sh deploy/layer.sh list 看有哪些）。用我们自己的镜像开的机器只补新增的几层，
#    用厂商裸镜像开的就从头补一遍——同一条路径，不用记哪台装过什么。
say "补齐软件（车队增量层）"
sh "$SRC/deploy/layer.sh" sync >/dev/null 2>&1 || true
remote 'bash /root/atelier-gpu/restore.sh' 2>&1 | tail -20 || echo "  ! 有层没补上，看 /root/restore.log"

# 7) 等它真的能应答
say "等 ComfyUI 起来"
i=0
while [ $i -lt 60 ]; do
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${BASE}/system_stats" || true)
  [ "$code" = 200 ] && break
  i=$((i+1)); sleep 5
done
[ "$code" = 200 ] || { echo "!! ComfyUI 60x5 秒内没通，看 /root/comfyui.log"; }

say "完成"
echo
echo "还需要你在 CompShare 控制台做的（脚本做不到）："
echo "  · 给这台开放/映射 8443（素材服务），否则浏览器只能把素材传给 13 再慢慢转"
echo "  · 把实例 id / region / zone 填进 $ENVF："
echo "      GPU_${UP}_INSTANCE=…   GPU_${UP}_REGION=…   GPU_${UP}_ZONE=…"
echo "    然后 systemctl restart atelier"
