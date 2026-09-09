#!/bin/bash
# restore — 把这台 GPU 机补到「车队当前该有的样子」。在 GPU 机上跑：
#
#   bash /root/atelier-gpu/restore.sh [--base http://127.0.0.1:18790/gpu] [--dry-run] [--only <层 id>]
#
# 为什么要有这东西：24 G 卡和抢占式实例用完就没了，做不了镜像，下次只能从旧的基础镜像起。
# 所以**每一个改动都必须以「层」的形式存在 13 上**，而不是手工 ssh 上去敲一遍——手敲的东西
# 下一台机器上就不存在了。13 是唯一的事实来源，这个脚本负责把差额补齐。
#
# 一层 = 一个幂等的 shell 脚本 + 可选的负载包（.tgz）。层按 id 字典序执行。
# 机器记着自己应用过哪些层（/root/.atelier/applied.json）；做镜像时把当时的全集写进去，
# 于是用那个镜像开的机器天生就「已经应用过」，只需要补之后新增的几层。
#
# 数据不是层：素材与音色每次都要对一遍差额（见最后一步），因为它们一直在变。
set -u
BASE=""; DRY=0; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE=$2; shift 2;;
    --dry-run) DRY=1; shift;;
    --only) ONLY=$2; shift 2;;
    *) echo "不认识的参数：$1" >&2; exit 2;;
  esac
done
[ -n "$BASE" ] || BASE=$(sed -n 's/^FLEET_BASE=//p' /root/runners/fleet.env 2>/dev/null | tr -d "'\"")
[ -n "$BASE" ] || { echo '{"ok":false,"error":"不知道 13 的地址：给 --base，或在 /root/runners/fleet.env 里写 FLEET_BASE"}'; exit 1; }

DIR=/root/.atelier
STATE=$DIR/applied.json
WORK=$DIR/work
mkdir -p "$DIR" "$WORK"
# 13 只能经车队隧道（Hysteria2 的 SOCKS5）够到：FLEET_BASE 指的是 13 自己的 loopback。
# --noproxy "" 是必须的——curl 默认把 localhost 排除在代理之外，于是会直连盒子自己的 18790（不存在）。
PROXY=${FLEET_PROXY:-127.0.0.1:11080}
fetch() { curl -fsS --noproxy "" --socks5-hostname "$PROXY" --connect-timeout 15 --max-time 900 --retry 2 -o "$1" "$2"; }

j() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print($1)" "$2" 2>/dev/null; }

say() { echo "== $*"; }

# ---- 1) 拿清单 --------------------------------------------------------------------------------
say "读车队清单 $BASE/_fleet/layers.json"
fetch "$WORK/layers.json" "$BASE/_fleet/layers.json" || { echo "拿不到清单（13 不可达？隧道没起？）"; exit 1; }
COUNT=$(j 'len(d["layers"])' "$WORK/layers.json")
[ -n "$COUNT" ] || { echo "清单格式不对"; exit 1; }
say "清单里有 $COUNT 层"

[ -f "$STATE" ] || printf '{"image":null,"layers":[],"data":{}}\n' > "$STATE"

# 已应用的 id:sha 集合
applied_sha() { python3 - "$STATE" "$1" <<'PY'
import json, sys
try: d = json.load(open(sys.argv[1]))
except Exception: d = {}
for l in d.get("layers", []):
    if l.get("id") == sys.argv[2]: print(l.get("sha", "")); break
PY
}
mark_applied() { python3 - "$STATE" "$1" "$2" <<'PY'
import json, sys, time
p, lid, sha = sys.argv[1], sys.argv[2], sys.argv[3]
try: d = json.load(open(p))
except Exception: d = {"image": None, "layers": [], "data": {}}
d.setdefault("layers", [])
d["layers"] = [l for l in d["layers"] if l.get("id") != lid]
d["layers"].append({"id": lid, "sha": sha, "at": int(time.time())})
d["layers"].sort(key=lambda l: l["id"])
json.dump(d, open(p, "w"), ensure_ascii=False, indent=1)
PY
}

# ---- 2) 逐层补齐 ------------------------------------------------------------------------------
IDS=$(python3 -c "import json;print('\n'.join(l['id'] for l in json.load(open('$WORK/layers.json'))['layers']))")
done_n=0; skip_n=0; fail_n=0
for id in $IDS; do
  [ -n "$ONLY" ] && [ "$ONLY" != "$id" ] && continue
  want=$(python3 -c "import json;print([l for l in json.load(open('$WORK/layers.json'))['layers'] if l['id']=='$id'][0].get('sha',''))")
  have=$(applied_sha "$id")
  if [ "$have" = "$want" ] && [ -n "$want" ]; then skip_n=$((skip_n+1)); continue; fi
  note=$(python3 -c "import json;print([l for l in json.load(open('$WORK/layers.json'))['layers'] if l['id']=='$id'][0].get('note',''))")
  say "补 $id — $note"
  [ "$DRY" = 1 ] && { done_n=$((done_n+1)); continue; }

  payload=$(python3 -c "import json;print([l for l in json.load(open('$WORK/layers.json'))['layers'] if l['id']=='$id'][0].get('payload') or '')")
  rm -rf "$WORK/$id"; mkdir -p "$WORK/$id"
  if [ -n "$payload" ]; then
    say "   取负载 $payload"
    fetch "$WORK/$id/payload" "$BASE/_fleet/layers/$payload" || { echo "   ! 负载取不到"; fail_n=$((fail_n+1)); continue; }
  fi
  fetch "$WORK/$id/apply.sh" "$BASE/_fleet/layers/$id.sh" || { echo "   ! 脚本取不到"; fail_n=$((fail_n+1)); continue; }
  # 层脚本能拿到：PAYLOAD（负载路径，没有就是空）、FLEET_BASE（回 13 取别的东西）
  if PAYLOAD="$([ -n "$payload" ] && echo "$WORK/$id/payload")" FLEET_BASE="$BASE" FLEET_PROXY="$PROXY" bash "$WORK/$id/apply.sh"; then
    mark_applied "$id" "$want"; done_n=$((done_n+1)); say "   ✓ $id"
  else
    echo "   ✗ $id 没跑成"; fail_n=$((fail_n+1))
  fi
done

# ---- 3) 数据：每次都对差额，不记「已应用」 ------------------------------------------------------
# 音色是用户在这台机器上克隆出来的，只存在盒子里；13 有镜像，开机时补回来。
if [ "$DRY" != 1 ] && [ -z "$ONLY" ]; then
  say "音色镜像"
  VD=/root/model-cache/voice/voices
  mkdir -p "$VD"
  if fetch "$WORK/voices.json" "$BASE/_fleet/voices.json" 2>/dev/null; then
    n=0
    for vid in $(python3 -c "import json;print(' '.join(v['id'] for v in json.load(open('$WORK/voices.json'))['voices']))" 2>/dev/null); do
      # 注册表是平铺的 <id>.json + <id>.wav；有 json 就算这台已经有了
      [ -f "$VD/$vid.json" ] && continue
      if fetch "$WORK/v.tgz" "$BASE/_fleet/voice/$vid" && tar -C "$VD" -xzf "$WORK/v.tgz"; then n=$((n+1)); fi
    done
    say "   补回 $n 个音色（13 上共 $(python3 -c "import json;print(len(json.load(open('$WORK/voices.json'))['voices']))" 2>/dev/null || echo ?) 个）"
  else
    say "   13 上还没有音色镜像，跳过"
  fi
fi

echo
python3 - "$STATE" <<PY
import json, sys
d = json.load(open(sys.argv[1]))
print(json.dumps({"ok": $fail_n == 0, "applied": $done_n, "skipped": $skip_n, "failed": $fail_n,
                  "image": d.get("image"), "layers": len(d.get("layers", []))}, ensure_ascii=False))
PY
[ "$fail_n" = 0 ]
