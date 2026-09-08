#!/bin/sh
# Local → server: tar the source over one SSH connection and run the installer as root.
#   sh deploy/push.sh            (uses ssh alias "13")
set -eu
SRC=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HOST=${1:-13}
SSH="ssh -o ControlMaster=auto -o ControlPath=/tmp/wd13-%C -o ControlPersist=900 $HOST"
cd "$SRC"
COPYFILE_DISABLE=1 tar czf - --exclude node_modules --exclude data --exclude data-dev --exclude reference --exclude .git --exclude '.DS_Store' --exclude '._*' . | $SSH 'rm -rf /root/atelier-src && mkdir -p /root/atelier-src && tar xzf - -C /root/atelier-src && FORCE_RESTART='${FORCE_RESTART:-0}' sh /root/atelier-src/deploy/install.sh'
