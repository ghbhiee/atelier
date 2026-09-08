#!/bin/sh
# Push the gpu.example.com certificate to the box's asset service and reload it.
# Run by acme.sh's --reloadcmd after every renewal, and daily by cron in case the box was off then.
# Idempotent: does nothing when the box already serves this exact certificate.
set -eu
SRC=/etc/atelier/gpu-tls
KEY=/var/lib/atelier/.ssh/id_ed25519
KH=/var/lib/atelier/.ssh/known_hosts
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$KH -o ConnectTimeout=20 -p 19189 root@127.0.0.1"
SCP="scp -i $KEY -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$KH -o ConnectTimeout=20 -P 19189"
[ -s "$SRC/fullchain.pem" ] && [ -s "$SRC/key.pem" ] || { echo "no cert in $SRC"; exit 1; }
want=$(openssl x509 -in "$SRC/fullchain.pem" -noout -fingerprint -sha256 | sed 's/.*=//; s/://g')
have=$($SSH 'openssl x509 -in /root/atelier-assets/tls/cert.pem -noout -fingerprint -sha256 2>/dev/null | sed "s/.*=//; s/://g"' 2>/dev/null || echo "")
if [ "$want" = "$have" ]; then echo "cert already current on the box"; exit 0; fi
$SSH 'mkdir -p /root/atelier-assets/tls'
$SCP "$SRC/fullchain.pem" root@127.0.0.1:/root/atelier-assets/tls/cert.pem
$SCP "$SRC/key.pem" root@127.0.0.1:/root/atelier-assets/tls/key.pem
$SSH 'chmod 600 /root/atelier-assets/tls/key.pem; supervisorctl restart assets >/dev/null; sleep 2; curl -sk -m 6 https://127.0.0.1:8443/health'
echo
