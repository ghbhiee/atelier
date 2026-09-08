#!/bin/sh
# Server-side installer (run as root on 13). Idempotent.
#   sh deploy/install.sh            (source dir = the directory this script lives in/..)
# Expects: node at /opt/services/node-current and the nginx snippet in place (see deploy/nginx-atelier.conf).
# Keeps existing env + data. Migrates an old "h3studio" install in place on first run:
#   /opt/services/h3studio-data → /opt/services/atelier-data, /etc/h3studio/env → /etc/atelier/env (symlinked back),
#   service user h3studio → atelier (home /var/lib/atelier keeps the gpuctl ssh key), h3studio.service disabled.
set -eu
SRC=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALL_DIR=/opt/services/atelier
DATA_DIR=/opt/services/atelier-data
ENV_DIR=/etc/atelier
NODE_BIN=/opt/services/node-current/bin
SERVICE_USER=atelier
OLD_USER=h3studio

# ---- one-time migration from the h3studio layout ---------------------------------------------
if id "$OLD_USER" >/dev/null 2>&1 && ! id "$SERVICE_USER" >/dev/null 2>&1; then
  systemctl disable --now h3studio.service >/dev/null 2>&1 || true
  usermod -l "$SERVICE_USER" -d /var/lib/atelier -m "$OLD_USER"
  groupmod -n "$SERVICE_USER" "$OLD_USER" 2>/dev/null || true
  echo "migrated user $OLD_USER → $SERVICE_USER (home /var/lib/atelier)"
fi
if [ -d /opt/services/h3studio-data ] && [ ! -e "$DATA_DIR" ]; then
  systemctl stop h3studio.service >/dev/null 2>&1 || true
  mv /opt/services/h3studio-data "$DATA_DIR"; ln -sfn "$DATA_DIR" /opt/services/h3studio-data
  echo "migrated data → $DATA_DIR"
fi
if [ -f /etc/h3studio/env ] && [ ! -e "$ENV_DIR/env" ]; then
  mkdir -p "$ENV_DIR"; mv /etc/h3studio/env "$ENV_DIR/env"; ln -sfn "$ENV_DIR/env" /etc/h3studio/env
  sed -i 's#^DATA_DIR=/opt/services/h3studio-data#DATA_DIR=/opt/services/atelier-data#; s#^GPUCTL_KEY=/var/lib/h3studio/#GPUCTL_KEY=/var/lib/atelier/#; s#^GPUCTL_KNOWN_HOSTS=/var/lib/h3studio/#GPUCTL_KNOWN_HOSTS=/var/lib/atelier/#' "$ENV_DIR/env"
  echo "migrated env → $ENV_DIR/env"
fi

id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir /var/lib/atelier --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$ENV_DIR"
# code (node_modules installed on the server, data/env never touched)
rsync -a --delete --exclude node_modules --exclude data --exclude data-dev --exclude .git --exclude '._*' --exclude .DS_Store --exclude 'test/*.output' "$SRC/" "$INSTALL_DIR/"
(cd "$INSTALL_DIR" && PATH="$NODE_BIN:$PATH" "$NODE_BIN/npm" ci --omit=dev --no-audit --no-fund 2>&1 | tail -2)
chown -R root:root "$INSTALL_DIR"; chmod -R a+rX "$INSTALL_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"; chmod 700 "$DATA_DIR"
[ -d /var/lib/atelier ] && chown -R "$SERVICE_USER:$SERVICE_USER" /var/lib/atelier || true
chown root:"$SERVICE_USER" "$ENV_DIR"; chmod 750 "$ENV_DIR"
if [ -f "$ENV_DIR/env" ]; then chown root:"$SERVICE_USER" "$ENV_DIR/env"; chmod 640 "$ENV_DIR/env"; else echo "WARNING: $ENV_DIR/env missing — copy deploy/env.example and fill it in" >&2; fi
ln -sfn "$INSTALL_DIR/bin/atelier" /usr/local/bin/atelier
ln -sfn "$INSTALL_DIR/bin/atelier" /usr/local/bin/h3studio     # legacy name (the approval note says `h3studio auth approve`)
[ -L /opt/services/h3studio ] || [ ! -e /opt/services/h3studio ] && ln -sfn "$INSTALL_DIR" /opt/services/h3studio || true
cat > /etc/systemd/system/atelier.service <<UNIT
[Unit]
Description=Atelier (GPU workbench: video / white model / voice / LLM)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_DIR/env
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
ExecStart=$NODE_BIN/node $INSTALL_DIR/server/src/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
MemoryMax=600M
TasksMax=512

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now atelier.service >/dev/null 2>&1 || true
# never restart under a running job (uploads take minutes through the tunnel): wait up to 20 min, unless FORCE_RESTART=1
if [ "${FORCE_RESTART:-0}" != 1 ]; then
  for i in $(seq 1 120); do
    n=$(curl -s -m 5 http://127.0.0.1:18790/healthz | sed -n 's/.*"activeJobs":\([0-9]*\).*/\1/p')
    b=$(curl -s -m 5 http://127.0.0.1:18790/healthz | sed -n 's/.*"busy":\(true\|false\).*/\1/p')
    if [ -z "$n" ] || { [ "$n" = 0 ] && [ "$b" != true ]; }; then break; fi
    [ "$i" = 1 ] && echo "waiting: $n active job(s) / busy=$b before restart (FORCE_RESTART=1 to skip)…"
    sleep 10
  done
fi
# keep a copy of whatever is on the GPU boxes here, so a replacement machine can be rebuilt from 13 alone
for b in $(sed -n "s/^GPU_BOXES=['\"]*\([^'\"]*\).*/\1/p" "$ENV_DIR/env" | tr ',' ' '); do
  sh "$INSTALL_DIR/deploy/backup-gpu.sh" "$b" || true
done
[ -s "$ENV_DIR/env" ] && ! grep -q "^GPU_BOXES=" "$ENV_DIR/env" && sh "$INSTALL_DIR/deploy/backup-gpu.sh" north || true
systemctl restart atelier.service
sleep 2
systemctl --no-pager --lines=0 status atelier.service | head -5
curl -s -m 5 http://127.0.0.1:18790/healthz && echo
