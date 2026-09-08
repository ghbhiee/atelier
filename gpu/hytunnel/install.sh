#!/bin/bash
# Install the fleet tunnel client on a GPU box. Idempotent.
#   FLEET_HY2_SERVER=atelier.example.com:7100 FLEET_HY2_PASSWORD=... bash install.sh
set -euo pipefail
: "${FLEET_HY2_SERVER:?need FLEET_HY2_SERVER}"
: "${FLEET_HY2_PASSWORD:?need FLEET_HY2_PASSWORD}"
SNI="${FLEET_HY2_SNI:-${FLEET_HY2_SERVER%%:*}}"
VER="${FLEET_HY2_VERSION:-v2.8.1}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v hysteria >/dev/null 2>&1; then
  # the box downloads from GitHub fine (China -> abroad is the fast direction)
  curl -fsSL --connect-timeout 10 --max-time 300 -o /usr/local/bin/hysteria \
    "https://github.com/apernet/hysteria/releases/download/app%2F${VER}/hysteria-linux-amd64"
  chmod +x /usr/local/bin/hysteria
fi

mkdir -p /etc/atelier
sed -e "s#__SERVER__#${FLEET_HY2_SERVER}#" -e "s#__PASSWORD__#${FLEET_HY2_PASSWORD}#" -e "s#__SNI__#${SNI}#" \
  "$HERE/client.yaml.tmpl" > /etc/atelier/hy2-client.yaml
chmod 600 /etc/atelier/hy2-client.yaml

cat > /etc/supervisor/conf.d/hytunnel.conf <<CONF
[program:hytunnel]
command=/usr/local/bin/hysteria client -c /etc/atelier/hy2-client.yaml
environment=HYSTERIA_DISABLE_UPDATE_CHECK="1"
autostart=true
autorestart=true
startsecs=5
stdout_logfile=/var/log/hytunnel.log
redirect_stderr=true
CONF
supervisorctl reread >/dev/null && supervisorctl update >/dev/null
supervisorctl restart hytunnel >/dev/null 2>&1 || supervisorctl start hytunnel
sleep 4
supervisorctl status hytunnel
