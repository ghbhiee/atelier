#!/bin/sh
# layer — 车队的增量层仓库，跑在 13 上。层是「基础镜像 → 现在该有的样子」之间的差额，
# 每一层是一个幂等的 shell 脚本（可带一个负载包），按 id 字典序执行。
#
#   sh deploy/layer.sh list
#   sh deploy/layer.sh add <id> <脚本文件> [负载文件] [说明]
#   sh deploy/layer.sh rm  <id>
#   sh deploy/layer.sh show <id>
#   sh deploy/layer.sh bake            # 打镜像前：把当前全集写进活跃机器，让镜像天生「已应用」
#
# id 用 NNN-名字，前面留号段：
#   0xx 系统层（ffmpeg、编译器）  1xx 运行时（ComfyUI / llama.cpp / 语音 venv）
#   2xx 权重与模型缓存            3xx 配置与补丁                9xx 临时/实验
#
# 规矩（对 agent 也一样）：**任何对 GPU 机的改动都要落成一层**。直接 ssh 上去改的东西，
# 下一台机器上就不存在了；24 G 卡和抢占式实例做不了镜像，只能靠这些层恢复。
set -eu
ENVF=/etc/atelier/env
envget() { sed -n "s/^$1=//p" "$ENVF" | tail -1 | sed "s/^['\"]//; s/['\"]\$//"; }
DATA=$(envget DATA_DIR); [ -n "$DATA" ] || DATA=/opt/services/atelier-data
STORE=$DATA/fleet
MAN=$STORE/layers.json
mkdir -p "$STORE/layers"
[ -f "$MAN" ] || echo '{"version":1,"layers":[]}' > "$MAN"
own() { chown -R atelier:atelier "$STORE" 2>/dev/null || true; }

CMD=${1:-list}; shift 2>/dev/null || true

case "$CMD" in
list)
  python3 - "$MAN" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
ls = d.get("layers", [])
if not ls: print("（空）"); raise SystemExit
w = max(len(l["id"]) for l in ls)
for l in ls:
    p = f"  +{l['payload']}" if l.get("payload") else ""
    print(f"{l['id']:<{w}}  {l.get('note','')}{p}")
print(f"\n共 {len(ls)} 层")
PY
  ;;

show)
  ID=${1:?层 id}
  cat "$STORE/layers/$ID.sh"
  ;;

add)
  ID=${1:?层 id，例如 310-opencv}
  SCRIPT=${2:?脚本文件}
  PAYLOAD=${3:-}
  NOTE=${4:-}
  echo "$ID" | grep -qE '^[0-9]{3}-[a-z0-9][a-z0-9._-]*$' || { echo "id 要写成 NNN-名字（小写）"; exit 1; }
  [ -f "$SCRIPT" ] || { echo "没有这个脚本：$SCRIPT"; exit 1; }
  cp "$SCRIPT" "$STORE/layers/$ID.sh"
  PNAME=""
  if [ -n "$PAYLOAD" ]; then
    [ -f "$PAYLOAD" ] || { echo "没有这个负载：$PAYLOAD"; exit 1; }
    PNAME="$ID.$(basename "$PAYLOAD" | sed 's/.*\.//')"
    cp "$PAYLOAD" "$STORE/layers/$PNAME"
  fi
  python3 - "$MAN" "$ID" "$STORE/layers/$ID.sh" "$PNAME" "$NOTE" "$STORE/layers" <<'PY'
import hashlib, json, os, sys, time
man, lid, script, pname, note, ldir = sys.argv[1:7]
h = hashlib.sha256(open(script, "rb").read())
if pname: h.update(open(os.path.join(ldir, pname), "rb").read())
d = json.load(open(man))
d["layers"] = [l for l in d.get("layers", []) if l["id"] != lid]
d["layers"].append({"id": lid, "note": note, "payload": pname or None,
                    "sha": h.hexdigest()[:16], "addedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "bytes": os.path.getsize(script) + (os.path.getsize(os.path.join(ldir, pname)) if pname else 0)})
d["layers"].sort(key=lambda l: l["id"])
json.dump(d, open(man, "w"), ensure_ascii=False, indent=1)
print(f"已登记 {lid}（sha {d['layers'][[l['id'] for l in d['layers']].index(lid)]['sha']}）")
PY
  own
  ;;

rm)
  ID=${1:?层 id}
  python3 - "$MAN" "$ID" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
n = len(d["layers"]); d["layers"] = [l for l in d["layers"] if l["id"] != sys.argv[2]]
json.dump(d, open(sys.argv[1], "w"), ensure_ascii=False, indent=1)
print("删了" if len(d["layers"]) < n else "本来就没有")
PY
  rm -f "$STORE/layers/$ID.sh" "$STORE/layers/$ID".*
  ;;

bake)
  # 打镜像前跑：把当前层全集写进活跃机器的 applied.json。用这个镜像开出来的机器天生
  # 就「已经应用过」这些层，restore 时只补之后新增的几层。
  NAME=${1:-image-$(date +%Y%m%d)}
  KEY=$(envget GPUCTL_KEY); PORT=$(envget GPUCTL_PORT)
  [ -n "$PORT" ] || PORT=$(ss -tlnp 2>/dev/null | grep -oE '127\.0\.0\.1:19[0-9]89' | head -1 | cut -d: -f2)
  [ -n "$KEY" ] && [ -n "$PORT" ] || { echo "找不到 gpuctl 的密钥或端口"; exit 1; }
  python3 - "$MAN" "$NAME" > /tmp/applied.json <<'PY'
import json, sys, time
d = json.load(open(sys.argv[1]))
json.dump({"image": sys.argv[2],
           "layers": [{"id": l["id"], "sha": l["sha"], "at": int(time.time())} for l in d["layers"]],
           "data": {}}, sys.stdout, ensure_ascii=False, indent=1)
PY
  sudo -u atelier ssh -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no root@127.0.0.1 \
    'mkdir -p /root/.atelier && cat > /root/.atelier/applied.json' < /tmp/applied.json
  rm -f /tmp/applied.json
  echo "已把 $(python3 -c "import json;print(len(json.load(open('$MAN'))['layers']))") 层标记为「已烤进镜像 $NAME」"
  echo "现在可以 sh deploy/make-image.sh $NAME"
  ;;

sync)
  # 把仓库里的 deploy/layers/*.sh 登记进 13 的层仓库。层的事实来源是 git，13 只是把它们摊开
  # 给盒子取；负载（编好的二进制之类）不进 git，另外用 add 带上。
  SRC=${SRC:-/opt/services/atelier}
  n=0
  for f in "$SRC"/deploy/layers/*.sh; do
    [ -f "$f" ] || continue
    id=$(basename "$f" .sh)
    note=$(sed -n '2s/^# *//p' "$f")
    sh "$0" add "$id" "$f" "" "$note" >/dev/null
    n=$((n+1))
  done
  echo "登记了 $n 层（仓库 → $STORE/layers）"
  sh "$0" list
  ;;

*) echo "用法：list | sync | show <id> | add <id> <脚本> [负载] [说明] | rm <id> | bake [镜像名]"; exit 2;;
esac
