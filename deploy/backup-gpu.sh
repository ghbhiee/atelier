#!/bin/sh
# Keep a copy of everything that lives on a GPU box in 13, so a replacement machine can be brought up
# from here without touching this repo. Run on 13 as root (push.sh calls it after every deploy):
#
#   sh deploy/backup-gpu.sh [box]        default: the active box
#
# What it saves, per box, under /opt/services/atelier-gpu-backup/<box>/:
#   code/        /root/atelier-gpu           (our scripts: gpuctl, runners, whitemodel node, voice, assets)
#   runners/     /root/runners/*.env         (secrets: llm model + args, voice, asset-service key)
#   supervisor/  /etc/supervisor/conf.d/*    (which programs exist and how they start)
#   comfy/       the atelier ComfyUI node + the workflow templates it needs
#   manifest.json  what was on the box: models present, venvs, disk, EIP, ports
set -eu
BOX=${1:-north}
ENVF=/etc/atelier/env
DEST=/opt/services/atelier-gpu-backup/$BOX
KEY=/var/lib/atelier/.ssh/id_ed25519
KH=/var/lib/atelier/.ssh/known_hosts
envget() { sed -n "s/^$1=//p" "$ENVF" | tail -1 | sed "s/^['\"]//; s/['\"]$//"; }
UP=$(echo "$BOX" | tr '[:lower:]' '[:upper:]')
PORT=$(envget "GPU_${UP}_PORTBASE"); PORT=$(( ${PORT:-19188} + 1 ))
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$KH -o ConnectTimeout=20 -p $PORT root@127.0.0.1"

$SSH true 2>/dev/null || { echo "box $BOX 不可达（隧道端口 $PORT），跳过备份"; exit 0; }
mkdir -p "$DEST"

# code + runner env + supervisor conf, straight over the tunnel (no tar files left behind anywhere)
for pair in "/root/atelier-gpu code" "/root/runners runners" "/etc/supervisor/conf.d supervisor"; do
  src=${pair%% *}; sub=${pair##* }
  mkdir -p "$DEST/$sub"
  $SSH "tar -C $(dirname "$src") -cf - $(basename "$src") 2>/dev/null" | tar -C "$DEST/$sub" -xf - --strip-components=1 2>/dev/null || true
done
mkdir -p "$DEST/comfy"
$SSH "tar -C /root/ComfyUI/custom_nodes -cf - atelier_whitemodel 2>/dev/null" | tar -C "$DEST/comfy" -xf - 2>/dev/null || true

# a short inventory of the machine itself, so a replacement can be compared against it
{
  printf '{\n'
  printf '  "at": "%s",\n' "$(date -Is)"
  printf '  "box": "%s",\n' "$BOX"
  printf '  "eip": "%s",\n' "$($SSH 'curl -s -m 6 ifconfig.me || true' 2>/dev/null)"
  printf '  "gpu": "%s",\n' "$($SSH 'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader | head -1' 2>/dev/null)"
  printf '  "disk_free_gb": %s,\n' "$($SSH 'df -BG --output=avail / | tail -1 | tr -dc 0-9' 2>/dev/null || echo 0)"
  printf '  "programs": "%s",\n' "$($SSH 'supervisorctl status 2>/dev/null | awk "{printf \"%s=%s \", \$1, \$2}"' 2>/dev/null)"
  printf '  "venvs": "%s",\n' "$($SSH 'ls /root/venvs 2>/dev/null | tr "\n" " "' 2>/dev/null)"
  printf '  "have": "%s",\n' "$($SSH 'for p in /root/llama.cpp/build/bin/llama-server /root/index-tts/.venv/bin/python /root/ComfyUI/main.py /model /root/atelier-assets/tls/cert.pem; do [ -e "$p" ] && printf "%s " "$p"; done' 2>/dev/null)"
  printf '  "comfy_input_files": %s\n' "$($SSH 'ls -1 /root/ComfyUI/input 2>/dev/null | wc -l' 2>/dev/null || echo 0)"
  printf '}\n'
} > "$DEST/manifest.json"

chmod -R go-rwx "$DEST"
echo "备份 $BOX → $DEST  ($(du -sh "$DEST" 2>/dev/null | cut -f1))"
