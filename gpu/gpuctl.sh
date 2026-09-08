#!/bin/bash
# gpuctl — the thin GPU-side control surface the control plane (server 13) drives over the reverse
# ssh tunnel. Every sub-command prints one JSON document; nothing here decides policy (VRAM arbitration
# lives in server/src/models.js), it only reports and flips supervisor programs.
#
#   gpuctl status                 → vram/util, gpu procs, supervisor programs, listening ports, net counters, disk, uptime
#   gpuctl cert                   → sha256 fingerprint of the asset service's TLS cert (pinned by 13)
#   gpuctl start <prog> [args…]   → supervisorctl start (args are exported as env for the program's wrapper)
#   gpuctl stop <prog>            → supervisorctl stop
#   gpuctl free                   → ask ComfyUI to unload models + free memory (keeps the process)
#   gpuctl wait-port <port> [sec] → block until 127.0.0.1:<port> accepts TCP (default 120 s)
#   gpuctl download <url> <dest> [max_gb]  → fetch a small model file/archive into /root/model-cache (detached, see log)
#   gpuctl log <prog> [lines]     → tail of a supervisor program's log
#   gpuctl setenv <prog> KEY=VAL… → write /root/runners/<prog>.env (read by the runner wrappers)
set -u
CACHE=/root/model-cache
RUNNERS=/root/runners
mkdir -p "$CACHE" "$RUNNERS"

# KEY=value pairs → single-quoted shell assignments (values may contain spaces / quotes)
write_env() {
  local prog=$1; shift; : > "$RUNNERS/$prog.env"
  for kv in "$@"; do
    local k=${kv%%=*} v=${kv#*=}
    printf "%s='%s'\n" "$k" "$(printf '%s' "$v" | sed "s/'/'\\\\''/g")" >> "$RUNNERS/$prog.env"
  done
}
json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))'; }

vram() {
  # sm util, memory-bus util, power draw and clock as well — 13 aggregates these over a power-on session
  # the card's name too: with gpuctl available 13 never calls ComfyUI's /system_stats, so this is the
  # only place the dashboard can learn what card it is looking at
  nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu,utilization.memory,power.draw,power.limit,clocks.sm,name --format=csv,noheader,nounits 2>/dev/null \
    | awk -F', ' '{name=$9; gsub(/"/,"",name); printf "{\"used\":%d,\"total\":%d,\"util\":%d,\"temp\":%d,\"memUtil\":%d,\"powerW\":%.1f,\"powerLimitW\":%.0f,\"clockMhz\":%d,\"name\":\"%s\"}", $1, $2, $3, $4, $5, $6, $7, $8, name}'
}
procs() {
  # per-process VRAM (pid, used MiB, command)
  nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null | python3 -c '
import sys, json, os
out = []
for line in sys.stdin:
    p = [x.strip() for x in line.split(",")]
    if len(p) < 2 or not p[0].isdigit(): continue
    try: cmd = open(f"/proc/{p[0]}/cmdline","rb").read().replace(b"\0", b" ").decode(errors="replace")[:80]
    except Exception: cmd = ""
    out.append({"pid": int(p[0]), "mib": int(p[1] or 0), "cmd": cmd})
print(json.dumps(out))'
}
programs() {
  supervisorctl status 2>/dev/null | python3 -c '
import sys, json
out = {}
for line in sys.stdin:
    parts = line.split()
    if len(parts) >= 2: out[parts[0]] = parts[1]
print(json.dumps(out))'
}
net() {
  # cumulative bytes on every real interface — 13 diffs two samples to see uploads / downloads in flight
  sed 's/:/ /' /proc/net/dev | awk 'NR>2 && $1!="lo" {rx+=$2; tx+=$10} END {printf "{\"rx\":%.0f,\"tx\":%.0f}", rx+0, tx+0}'
}
ports() {
  # Some pod images ship without iproute2. An empty port list makes 13 think ComfyUI is down and the
  # box never comes "on", so fall back to /proc/net/tcp, which is always there.
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk 'NR>1{print $4}' | sed "s/.*://" | sort -un | python3 -c 'import sys,json; print(json.dumps([int(x) for x in sys.stdin.read().split() if x.isdigit()]))'
  else
    python3 -c 'import json
out=set()
for f in ("/proc/net/tcp","/proc/net/tcp6"):
    try: rows=open(f).read().splitlines()[1:]
    except OSError: continue
    for r in rows:
        c=r.split()
        if len(c)>3 and c[3]=="0A": out.add(int(c[1].split(":")[1],16))
print(json.dumps(sorted(out)))'
  fi
}

cmd=${1:-status}; shift || true
case "$cmd" in
  have)
    # 哪些权重文件真的在这台机器上：共享盘各区内容不一样，13 不能假设目录里写的路径都存在
    python3 -c 'import json,os,sys; print(json.dumps({p: os.path.exists(p) for p in sys.argv[1:]}))' "$@"
    ;;
  status)
    printf '{"ok":true,"vram":%s,"procs":%s,"programs":%s,"ports":%s,"net":%s,"disk_free_gb":%s,"uptime_s":%s,"cache":%s,"runners":%s}\n' \
      "$(vram)" "$(procs)" "$(programs)" "$(ports)" "$(net)" \
      "$(df -BG --output=avail / | tail -1 | tr -dc 0-9)" "$(cut -d. -f1 /proc/uptime)" \
      "$(ls -1 "$CACHE" 2>/dev/null | python3 -c 'import sys,json; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')" \
      "$(python3 - "$RUNNERS" <<'PY'
import sys, os, json, shlex
d = sys.argv[1]; out = {}
for f in os.listdir(d) if os.path.isdir(d) else []:
    if not f.endswith(".env"): continue
    kv = {}
    for line in open(os.path.join(d, f)):
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            try: v = shlex.split(v)[0] if v else ""
            except ValueError: pass
            kv[k] = v
    out[f[:-4]] = kv
print(json.dumps(out))
PY
)"
    ;;
  start)
    prog=${1:?prog}; shift || true
    if [ $# -gt 0 ]; then write_env "$prog" "$@"; fi
    out=$(supervisorctl start "$prog" 2>&1); rc=$?
    printf '{"ok":%s,"prog":"%s","out":%s}\n' "$([ $rc -eq 0 ] && echo true || echo false)" "$prog" "$(printf '%s' "$out" | json_escape)"
    ;;
  stop)
    prog=${1:?prog}
    out=$(supervisorctl stop "$prog" 2>&1); rc=$?
    printf '{"ok":%s,"prog":"%s","out":%s}\n' "$([ $rc -eq 0 ] && echo true || echo false)" "$prog" "$(printf '%s' "$out" | json_escape)"
    ;;
  cert)
    f=/root/atelier-assets/tls/cert.pem
    if [ -f "$f" ]; then
      printf '{"ok":true,"fingerprint":"%s"}\n' "$(openssl x509 -in "$f" -noout -fingerprint -sha256 | sed 's/.*=//; s/://g')"
    else echo '{"ok":false,"error":"no cert yet"}'; fi
    ;;
  free)
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 -X POST -H 'Content-Type: application/json' -d '{"unload_models":true,"free_memory":true}' http://127.0.0.1:8188/free)
    sleep 2
    printf '{"ok":%s,"http":"%s","vram":%s}\n' "$([ "$code" = "200" ] && echo true || echo false)" "$code" "$(vram)"
    ;;
  wait-port)
    port=${1:?port}; secs=${2:-120}
    for i in $(seq 1 "$secs"); do
      if (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then printf '{"ok":true,"port":%s,"waited":%s}\n' "$port" "$i"; exit 0; fi
      sleep 1
    done
    printf '{"ok":false,"port":%s,"waited":%s}\n' "$port" "$secs"; exit 1
    ;;
  download)
    url=${1:?url}; dest=${2:?dest}; max=${3:-3}
    case "$url" in https://huggingface.co/*|https://hf-mirror.com/*|https://www.modelscope.cn/*|https://modelscope.cn/*|https://github.com/*|https://objects.githubusercontent.com/*) ;; *) echo '{"ok":false,"error":"source not allowed"}'; exit 1;; esac
    size=$(curl -sIL --max-time 20 "$url" | awk 'tolower($1)=="content-length:"{s=$2} END{print s+0}')
    if [ "$size" -gt $((max * 1024 * 1024 * 1024)) ]; then printf '{"ok":false,"error":"too large","bytes":%s}\n' "$size"; exit 1; fi
    mkdir -p "$(dirname "$CACHE/$dest")"
    nohup sh -c "curl -sL --max-time 3600 -o '$CACHE/$dest.part' '$url' && mv '$CACHE/$dest.part' '$CACHE/$dest' && echo DONE || echo FAIL" > "$CACHE/$dest.log" 2>&1 < /dev/null &
    printf '{"ok":true,"dest":"%s","bytes":%s,"log":"%s"}\n' "$dest" "$size" "$CACHE/$dest.log"
    ;;
  log)
    prog=${1:?prog}; n=${2:-40}
    f=$(supervisorctl status "$prog" >/dev/null 2>&1 && grep -h stdout_logfile "/etc/supervisor/conf.d/$prog.conf" 2>/dev/null | cut -d= -f2)
    [ -n "${f:-}" ] && [ -f "$f" ] && tail -n "$n" "$f" | json_escape | sed 's/^/{"ok":true,"log":/; s/$/}/' || echo '{"ok":false,"error":"no log"}'
    ;;
  setenv)
    prog=${1:?prog}; shift; write_env "$prog" "$@"; echo '{"ok":true}'
    ;;
  *) echo '{"ok":false,"error":"unknown command"}'; exit 1;;
esac
