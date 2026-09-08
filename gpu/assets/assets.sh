#!/bin/bash
# Asset service runner: SECRET / PORT / ALLOW_ORIGIN / PUBLIC_IP come from /root/runners/assets.env
# (written by `gpuctl start assets KEY=VAL…` from 13, which knows the current EIP and the workbench origin).
set -a; [ -f /root/runners/assets.env ] && . /root/runners/assets.env; set +a
export ASSETS_SECRET="${SECRET:-}" ASSETS_PORT="${PORT:-8443}" ALLOW_ORIGIN="${ALLOW_ORIGIN:-https://atelier.example.com}" PUBLIC_IP="${PUBLIC_IP:-}"
export ASSETS_DIR="${ASSETS_DIR:-/root/atelier-assets}" COMFY_INPUT="${COMFY_INPUT:-/root/ComfyUI/input}" COMFY_OUTPUT="${COMFY_OUTPUT:-/root/ComfyUI/output}"
exec python3 /root/atelier-gpu/assets/server.py
