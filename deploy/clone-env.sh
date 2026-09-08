#!/bin/sh
# 把一台已经跑通的 GPU 机器上的重环境，直接复制到另一台 GPU 机器。在 13 上跑：
#
#   sh deploy/clone-env.sh <供体的 ssh 命令> <接收方的 ssh 命令> [voice|llm|comfy|all]
#   sh deploy/clone-env.sh 'ssh -p 24123 root@cpod-A.podtcp.compshare.cn' \
#                          'ssh -p 24567 root@cpod-B.podtcp.compshare.cn' voice
#
# 为什么不走 13 中转：13 在洛杉矶，两台 GPU 都在国内。GPU→GPU 直传是国内内网/骨干，
# 实测比绕 13 快一个数量级（13 的出向只有 24 KB/s 每流，GPU 之间是 MB/s 级）。
#
# 密钥怎么办：**不把 13 的长期私钥放到租来的机器上**。做法是在接收方现生成一把一次性
# 密钥，13 通过供体的通道把它的公钥塞进供体的 authorized_keys，传完立刻删掉。
set -eu
DONOR=${1:?供体的 ssh 命令，带引号}
TARGET=${2:?接收方的 ssh 命令，带引号}
WHAT=${3:-all}
ENVF=/etc/atelier/env
envget() { sed -n "s/^$1=//p" "$ENVF" | tail -1 | sed "s/^['\"]//; s/['\"]$//"; }
KEY=$(envget GPUCTL_KEY); [ -n "$KEY" ] || KEY=/var/lib/atelier/.ssh/id_ed25519
D() { $DONOR  -i "$KEY" -o StrictHostKeyChecking=no "$@"; }
T() { $TARGET -i "$KEY" -o StrictHostKeyChecking=no "$@"; }
# 供体的 host/port，接收方 scp 时要用
DHOST=$(echo "$DONOR" | sed 's/.*root@//'); DPORT=$(echo "$DONOR" | sed -n 's/.*-p \([0-9]*\).*/\1/p'); DPORT=${DPORT:-22}

say() { echo "== $*"; }
say "在接收方生成一次性密钥"
PUB=$(T 'rm -f /root/.ssh/_clone /root/.ssh/_clone.pub; ssh-keygen -q -t ed25519 -N "" -f /root/.ssh/_clone; cat /root/.ssh/_clone.pub')
say "把它加进供体的 authorized_keys（用完就删）"
D "grep -qF '$PUB' /root/.ssh/authorized_keys || echo '$PUB' >> /root/.ssh/authorized_keys"
cleanup() {
  D "sed -i '\\#$(echo "$PUB" | awk '{print $2}')#d' /root/.ssh/authorized_keys" 2>/dev/null || true
  T 'rm -f /root/.ssh/_clone /root/.ssh/_clone.pub' 2>/dev/null || true
  say "一次性密钥已清除"
}
trap cleanup EXIT INT TERM

copy() { # copy <远端路径> <说明>
  say "$2：供体打包 → 接收方直接拉"
  D "test -e $1 || { echo '供体上没有 $1'; exit 1; }"
  D "cd \$(dirname $1) && tar -I 'gzip -1' -cf /tmp/_clone.tgz \$(basename $1)"
  SZ=$(D "stat -c %s /tmp/_clone.tgz")
  say "  $(( SZ / 1048576 )) MB，开始直传"
  T "time scp -i /root/.ssh/_clone -P $DPORT -o StrictHostKeyChecking=no root@$DHOST:/tmp/_clone.tgz /tmp/_clone.tgz"
  T "cd \$(dirname $1) && tar -xf /tmp/_clone.tgz && rm -f /tmp/_clone.tgz"
  D "rm -f /tmp/_clone.tgz"
  say "  $2 完成"
}

case "$WHAT" in
  voice) copy /root/index-tts "语音环境（venv + 源码）";;
  llm)   copy /root/llama.cpp "llama.cpp（含 CUDA 编译产物）";;
  comfy) copy /root/ComfyUI   "ComfyUI";;
  all)   copy /root/llama.cpp "llama.cpp"; copy /root/index-tts "语音环境"; copy /root/ComfyUI "ComfyUI";;
  *) echo "只认 voice / llm / comfy / all"; exit 1;;
esac
say "别忘了：接收方还要 supervisor 配置和 runners，跑 deploy/add-gpu.sh 即可（它会跳过已存在的）"
