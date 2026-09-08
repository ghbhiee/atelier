#!/bin/bash
# GPU-side install for the model manager. Idempotent; run as root on the GPU box after `scp -r gpu root@GPU:/root/atelier-gpu`.
#   bash /root/atelier-gpu/install-gpu.sh
# Puts gpuctl in PATH, installs the white-model ComfyUI node, the llm / voice / assets runner wrappers and their supervisor
# programs (autostart=false — the control plane on 13 starts them on demand), and widens the reverse tunnel to 4 ports.
# Prerequisites that are NOT done here (long / one-off, see HANDOFF.md): llama.cpp build in /root/llama.cpp,
# the IndexTTS-2 venv in /root/index-tts/.venv (uv sync), Depth-Anything weights in /root/model-cache.
set -eu
SRC=/root/atelier-gpu
install -m 755 "$SRC/gpuctl.sh" /usr/local/bin/gpuctl
mkdir -p /root/runners /root/model-cache
install -m 755 "$SRC/voice/voice.sh" /root/runners/voice.sh
install -m 755 "$SRC/assets/assets.sh" /root/runners/assets.sh
cat > /root/runners/llm.sh <<'S'
#!/bin/bash
# llama-server runner: MODEL / ARGS / ALIAS come from /root/runners/llm.env (written by `gpuctl start llm KEY=VAL…`)
set -a; [ -f /root/runners/llm.env ] && . /root/runners/llm.env; set +a
: "${MODEL:?MODEL not set}"
ARGS_DEFAULT="-c 32768 -ngl 999 -fa on --jinja"
eval "exec /root/llama.cpp/build/bin/llama-server -m \"\$MODEL\" --host 127.0.0.1 --port 8080 ${ARGS:-$ARGS_DEFAULT} ${ALIAS:+--alias \"\$ALIAS\"}"
S
chmod 755 /root/runners/llm.sh

# white-model node (path in → path out) for ComfyUI
mkdir -p /root/ComfyUI/custom_nodes/atelier_whitemodel
cp "$SRC/whitemodel/wm.py" "$SRC/whitemodel/__init__.py" /root/ComfyUI/custom_nodes/atelier_whitemodel/

# supervisor programs
cat > /etc/supervisor/conf.d/llm.conf <<'C'
[program:llm]
command=/root/runners/llm.sh
autostart=false
autorestart=false
startsecs=3
stopwaitsecs=20
redirect_stderr=true
stdout_logfile=/root/llm.log
environment=LD_LIBRARY_PATH="/root/llama.cpp/build/bin:/usr/local/cuda/lib64"
C
cat > /etc/supervisor/conf.d/voice.conf <<'C'
[program:voice]
command=/root/runners/voice.sh
autostart=false
autorestart=false
startsecs=3
stopwaitsecs=30
redirect_stderr=true
stdout_logfile=/root/voice.log
C
cat > /etc/supervisor/conf.d/assets.conf <<'C'
[program:assets]
command=/root/runners/assets.sh
autostart=true
autorestart=true
startsecs=3
stopwaitsecs=10
redirect_stderr=true
stdout_logfile=/root/assets.log
C
# reverse tunnel: comfy 8188 / sshd 23 / llm 8080 / voice 8600 (13 must permitlisten all four)
f=/etc/supervisor/conf.d/gputunnel.conf
if [ -f "$f" ] && ! grep -q "19189:127.0.0.1:23" "$f"; then
  sed -i "s#-R 19188:127.0.0.1:8188 #-R 19188:127.0.0.1:8188 -R 19189:127.0.0.1:23 -R 19190:127.0.0.1:8080 -R 19191:127.0.0.1:8600 #" "$f"
  supervisorctl reread >/dev/null; supervisorctl update >/dev/null; supervisorctl restart gputunnel >/dev/null
fi
supervisorctl reread >/dev/null; supervisorctl update >/dev/null
echo "installed: gpuctl, atelier_whitemodel node, runners llm/voice/assets"; supervisorctl status | awk '{print $1, $2}'
