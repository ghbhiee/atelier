#!/bin/bash
# Put ComfyUI + the H3 weight links on a fresh box. Idempotent; safe to re-run.
# Everything heavy lives on the shared /model disk, so this is a clone plus symlinks, not a download.
set -euo pipefail
PY=${PY:-/usr/local/miniconda3/envs/py312/bin/python}
[ -x "$PY" ] || PY=$(command -v python3)
CU=/root/ComfyUI

if [ ! -f "$CU/main.py" ]; then
  # tarball rather than git clone: these pods often ship without git, and apt on them is risky
  # (installing packages has triggered needrestart and taken the box's sshd down before).
  echo "== fetch ComfyUI"
  mkdir -p /root/_cu
  curl -fsSL --connect-timeout 10 --max-time 300 -o /root/_cu/cu.tar.gz https://github.com/comfyanonymous/ComfyUI/archive/refs/heads/master.tar.gz
  tar -C /root/_cu -xzf /root/_cu/cu.tar.gz
  mkdir -p "$CU"
  # keep whatever custom nodes are already there (atelier_whitemodel comes from provisioning)
  cp -rn /root/_cu/ComfyUI-master/. "$CU"/ 2>/dev/null || true
  rm -rf /root/_cu
fi
# The box is in China: PyPI direct takes many minutes, the Tsinghua mirror takes under one. Most of
# the heavy things (torch) already ship in the pod image, so this is only the small stuff.
"$PY" -m pip install -q -r "$CU/requirements.txt" -i https://pypi.tuna.tsinghua.edu.cn/simple 2>&1 | tail -2 || true

# The pod images ship torch built for a CUDA that torchaudio has no wheel for (2.13.0+cu132 today), so
# requirements.txt pulls a mismatched CUDA build and ComfyUI dies on import. torchaudio is only used to
# read and write audio files here, so the CPU wheel is the right one and it coexists with a CUDA torch.
if ! "$PY" -c "import torchaudio" >/dev/null 2>&1; then
  echo "== torchaudio (cpu wheel, matches any torch)"
  "$PY" -m pip install -q torchaudio --index-url https://download.pytorch.org/whl/cpu 2>&1 | tail -1 || true
fi

echo "== model links"
M=/model
link() { # link <subdir> <name> <target>
  mkdir -p "$CU/models/$1"
  [ -e "$3" ] || { echo "   缺 $3"; return 0; }
  ln -sfn "$3" "$CU/models/$1/$2"
}
link diffusion_models minimax_h3_fl2va_pruned_int8_convrot.safetensors  "$M/ModelScope/Comfy-Org/MiniMax-H3/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"
link diffusion_models minimax_h3_ref2va_pruned_int8_convrot.safetensors "$M/ModelScope/Comfy-Org/MiniMax-H3/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors"
link diffusion_models minimax_h3_hybrid_fl2va_ref2va_int8.safetensors   "$M/HuggingFace/smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models/minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors"
link text_encoders   qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors       "$M/ModelScope/Comfy-Org/MiniMax-H3/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
link vae             minimax_h3_video_vae_fp16.safetensors              "$M/ModelScope/Comfy-Org/MiniMax-H3/vae/minimax_h3_video_vae_fp16.safetensors"
link vae             minimax_h3_audio_vae_fp32.safetensors              "$M/ModelScope/Comfy-Org/MiniMax-H3/vae/minimax_h3_audio_vae_fp32.safetensors"
link loras           minimax_h3_turbo_4step_ema.safetensors             "$M/HuggingFace/larryvrh/MiniMax-H3-Turbo-Lora/minimax_h3_turbo_4step_ema.safetensors"
link loras           minimax_h3_fl2va_acc_8step.safetensors             "$M/HuggingFace/aptech0081/MiniMax-H3-Acc-LoRAs-ComfyUI/minimax_h3_fl2va_pdd_acc_8step_comfyui.safetensors"
link loras           minimax_h3_ref2va_acc_8step.safetensors            "$M/HuggingFace/aptech0081/MiniMax-H3-Acc-LoRAs-ComfyUI/minimax_h3_ref2va_pdd_acc_8step_comfyui.safetensors"
link latent_upscale_models minimax_h3_latent_upscaler_3d_fp16.safetensors "$M/HuggingFace/LBH-123-AI/Minimax_h3_latent_Upscaler/minimax_h3_latent_upscaler_3d_fp16.safetensors"

echo "== supervisor"
cat > /etc/supervisor/conf.d/comfyui.conf <<C
[program:comfyui]
command=$PY main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch
directory=$CU
priority=10
autostart=true
autorestart=true
startretries=10
startsecs=20
stopwaitsecs=30
redirect_stderr=true
stdout_logfile=/root/comfyui.log
C
supervisorctl reread >/dev/null; supervisorctl update >/dev/null
supervisorctl restart comfyui >/dev/null 2>&1 || supervisorctl start comfyui >/dev/null 2>&1 || true
sleep 20
supervisorctl status comfyui
