#!/bin/sh
# Bring a freshly rented GPU box into the fleet. Run on 13 as root:
#
#   sh deploy/provision-gpu.sh <box-name> '<ssh login command from CompShare>' [port-base]
#   sh deploy/provision-gpu.sh shanghai 'ssh -p 23 root@106.x.x.x' 19288
#
# Idempotent. Does the seven things a box needs before the workbench can use it:
#   1. our key into its authorized_keys (its password changes; the key does not)
#   2. the reverse tunnel back to 13 (comfy / sshd / llm / voice on this box's port base)
#   3. gpuctl + the runners + the white-model node + the asset service
#   4. the asset service's shared secret, matching /etc/atelier/env on 13
#   5. its own hostname's A record and the certificate for it
#   6. supervisor programs registered and the tunnel started
#   7. a report of what is missing (model weights, venvs) so the long downloads can be kicked off
set -eu
BOX=${1:?box name, e.g. shanghai}
LOGIN=${2:?the ssh command CompShare shows, in quotes}
BASE=${3:-}
ENVF=/etc/atelier/env
SRC=${SRC:-/opt/services/atelier}
KEY=/var/lib/atelier/.ssh/id_ed25519
KH=/var/lib/atelier/.ssh/known_hosts
UP=$(echo "$BOX" | tr '[:lower:]' '[:upper:]')

[ -f "$ENVF" ] || { echo "missing $ENVF"; exit 1; }
envget() { sed -n "s/^$1=//p" "$ENVF" | tail -1 | sed "s/^['\"]//; s/['\"]$//"; }
[ -n "${BASE}" ] || BASE=$(envget "GPU_${UP}_PORTBASE")
[ -n "${BASE}" ] || { echo "give a port base (19288 for the second box)"; exit 1; }
HOSTNAME_=$(envget GPU_HOST_PREFIX); [ -n "$HOSTNAME_" ] || HOSTNAME_=gpu
# the tunnel target is 13 itself; read it from the env rather than hoping the shell already has it
PUBLIC_ORIGIN=$(envget PUBLIC_ORIGIN); TUNHOST=${PUBLIC_ORIGIN#https://}; TUNHOST=${TUNHOST#http://}; TUNHOST=${TUNHOST%%/*}
[ -n "$TUNHOST" ] || { echo "PUBLIC_ORIGIN missing from $ENVF"; exit 1; }
DOMAIN=$(envget GODADDY_DOMAIN); [ -n "$DOMAIN" ] || DOMAIN=atelier.example.com
DNSNAME="${HOSTNAME_}-${BOX}.${DOMAIN}"
[ "$BOX" = huabei ] && DNSNAME="${HOSTNAME_}.${DOMAIN}"

say() { echo "== $*"; }
remote() { $LOGIN -o StrictHostKeyChecking=accept-new "$@"; }

say "1/7 key in"
PUB=$(cat "${KEY}.pub")
remote "mkdir -p /root/.ssh && grep -qF '$PUB' /root/.ssh/authorized_keys 2>/dev/null || echo '$PUB' >> /root/.ssh/authorized_keys"

say "2/7 tunnel user + code"
TUNKEY=$(remote 'cat /root/.ssh/tunnel_ed25519.pub 2>/dev/null || (ssh-keygen -q -t ed25519 -N "" -f /root/.ssh/tunnel_ed25519 && cat /root/.ssh/tunnel_ed25519.pub)')
grep -qF "$TUNKEY" /home/gputunnel/.ssh/authorized_keys 2>/dev/null || \
  printf 'restrict,port-forwarding,permitopen="127.0.0.1:1",permitlisten="%s",permitlisten="%s",permitlisten="%s",permitlisten="%s",command="/bin/false" %s\n' \
    "$BASE" "$((BASE+1))" "$((BASE+2))" "$((BASE+3))" "$TUNKEY" >> /home/gputunnel/.ssh/authorized_keys
chown gputunnel:gputunnel /home/gputunnel/.ssh/authorized_keys; chmod 600 /home/gputunnel/.ssh/authorized_keys

say "3/7 ship gpu/ and install"
tar -C "$SRC" -cf - gpu | $LOGIN -o StrictHostKeyChecking=accept-new 'mkdir -p /root/atelier-gpu-new && tar -C /root/atelier-gpu-new -xf - && rm -rf /root/atelier-gpu && mv /root/atelier-gpu-new/gpu /root/atelier-gpu && rmdir /root/atelier-gpu-new'

say "4/7 asset-service secret"
APORT=$(envget ASSETS_PORT); [ -n "$APORT" ] || APORT=8443
remote "mkdir -p /root/runners && printf \"SECRET='%s'\nPORT='%s'\nALLOW_ORIGIN='%s'\nPUBLIC_IP=''\n\" '$(envget ASSETS_SECRET)' '$APORT' '$(envget PUBLIC_ORIGIN)' > /root/runners/assets.env && chmod 600 /root/runners/assets.env"

say "5/7 tunnel program for port base $BASE"
remote "cat > /etc/supervisor/conf.d/gputunnel.conf <<C
[program:gputunnel]
command=/usr/bin/ssh -i /root/.ssh/tunnel_ed25519 -o StrictHostKeyChecking=no -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes -N -R $BASE:127.0.0.1:8188 -R $((BASE+1)):127.0.0.1:23 -R $((BASE+2)):127.0.0.1:8080 -R $((BASE+3)):127.0.0.1:8600 gputunnel@$TUNHOST
autostart=true
autorestart=true
redirect_stderr=true
stdout_logfile=/root/gputunnel.log
C
bash /root/atelier-gpu/install-gpu.sh >/dev/null 2>&1 || bash /root/atelier-gpu/install-gpu.sh
supervisorctl reread >/dev/null; supervisorctl update >/dev/null; supervisorctl restart gputunnel >/dev/null || supervisorctl start gputunnel >/dev/null"

# Fleet tunnel: the box pulls assets from 13 through Hysteria2 instead of 13 pushing over plain TCP
# (24 KB/s per flow into mainland China vs 6 MB/s measured through the tunnel).
HY2S=$(envget FLEET_HY2_SERVER); HY2P=$(envget FLEET_HY2_PASSWORD)
if [ -n "$HY2S" ] && [ -n "$HY2P" ]; then
  $LOGIN "FLEET_HY2_SERVER='$HY2S' FLEET_HY2_PASSWORD='$HY2P' bash /root/atelier-gpu/hytunnel/install.sh" || echo "  ! 隧道装不上，素材会退回并行 TCP"
else
  echo "  · 没有 FLEET_HY2_*，跳过车队隧道（素材走并行 TCP，慢 20 倍）"
fi

# Where 13 lives, as seen from inside the box (the reverse tunnel's local end). restore.sh reads this
# to pull the fleet's incremental layers; without it a box only has whatever its base image happened
# to contain.
PORT13=$(envget PORT); [ -n "$PORT13" ] || PORT13=18790
BP=$(envget BASE_PATH)
remote "mkdir -p /root/runners && printf \"FLEET_BASE='http://127.0.0.1:${PORT13}${BP}'\n\" > /root/runners/fleet.env"

say "6/7 DNS $DNSNAME → its public address, then the certificate"
IP=$(remote "curl -s -m 8 ifconfig.me || true"); [ -n "$IP" ] || IP=$(echo "$LOGIN" | sed -n 's/.*@\([0-9.]*\).*/\1/p')
curl -s -X PUT -H "Authorization: sso-key $(envget GODADDY_KEY):$(envget GODADDY_SECRET)" -H "content-type: application/json" \
  "https://api.godaddy.com/v1/domains/${DOMAIN}/records/A/${DNSNAME%%.*}" -d "[{\"data\":\"$IP\",\"ttl\":600}]" >/dev/null && echo "   A ${DNSNAME} → $IP"
/root/.acme.sh/acme.sh --issue --dns dns_gd -d "$DNSNAME" --server letsencrypt --keylength ec-256 >/dev/null 2>&1 || echo "   (cert already there or issuance skipped)"
/root/.acme.sh/acme.sh --install-cert -d "$DNSNAME" --ecc --fullchain-file "/etc/atelier/gpu-tls-${BOX}/fullchain.pem" --key-file "/etc/atelier/gpu-tls-${BOX}/key.pem" >/dev/null 2>&1 || true
BOX="$BOX" PORTBASE="$((BASE+1))" SRC_TLS="/etc/atelier/gpu-tls-${BOX}" /usr/local/bin/atelier-push-cert || echo "   (push the cert once the tunnel is up)"

say "7/7 what this box still needs"
remote 'echo "  ComfyUI: $(supervisorctl status comfyui 2>/dev/null | awk "{print \$2}")"; echo "  /model 共享盘: $(ls /model >/dev/null 2>&1 && echo 有 || echo 无)"; echo "  llama.cpp: $(test -x /root/llama.cpp/build/bin/llama-server && echo 有 || echo 缺)"; echo "  语音 venv: $(test -x /root/index-tts/.venv/bin/python && echo 有 || echo 缺)"'
echo
echo "在 13 的 $ENVF 里加上（然后 systemctl restart atelier）："
echo "  GPU_BOXES=north,$BOX"
echo "  GPU_${UP}_INSTANCE=<CompShare 实例 id>"
echo "  GPU_${UP}_REGION=<区域>   GPU_${UP}_ZONE=<可用区>"
echo "  GPU_${UP}_PORTBASE=$BASE"
echo "  GPU_${UP}_HOST=$DNSNAME"
