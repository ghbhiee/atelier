#!/bin/bash
# 语音栈：IndexTTS-2 的 venv + 我们的路由服务 + SenseVoice(ASR)。幂等。
# 一律清华源；权重不下载，软链共享盘 /model 上已有的。
set -euo pipefail
VENV=/root/index-tts/.venv
PY=$VENV/bin/python
PIP_I="-i https://pypi.tuna.tsinghua.edu.cn/simple"

if [ ! -x "$PY" ]; then
  echo "== 取 index-tts 源码"
  if [ ! -d /root/index-tts/indextts ]; then
    mkdir -p /root/index-tts
    curl -fsSL --connect-timeout 10 --max-time 600 -o /tmp/itts.tar.gz \
      https://github.com/index-tts/index-tts/archive/refs/heads/main.tar.gz
    tar -C /root/index-tts --strip-components=1 -xzf /tmp/itts.tar.gz && rm -f /tmp/itts.tar.gz
  fi
  echo "== 建环境（这些镜像没装 python3-venv，用 conda 建，源走清华）"
  CONDA=/usr/local/miniconda3/bin/conda
  if [ -x "$CONDA" ]; then
    "$CONDA" create -y -q -p "$VENV" python=3.11 \
      -c https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main >/dev/null
  else
    BASEPY=$(command -v python3.11 || command -v python3)
    "$BASEPY" -m venv "$VENV" || { echo "建不了环境：既没有 conda，系统 python 也缺 venv 模块"; exit 1; }
  fi
  # shellcheck disable=SC2086
  "$PY" -m pip install -q -U pip $PIP_I
fi

echo "== 装依赖（清华源）"
# torch 先单独装：不同镜像的 CUDA 版本差异是这里唯一容易翻车的地方
"$PY" -c "import torch" 2>/dev/null || "$PY" -m pip install -q torch torchaudio $PIP_I 2>&1 | tail -1
# 优先照仓库里的锁文件装：那是上一台跑通之后 freeze 出来的确切版本，不用再解析、不会再变。
# 锁文件由 deploy/collect-env.sh 从跑通的机器上收取更新。
LOCK=/root/atelier-gpu/voice/requirements.lock.txt
if [ -s "$LOCK" ]; then
  echo "   按锁文件装 $(grep -c . "$LOCK") 个包（版本固定，源走清华）"
  "$PY" -m pip install -q -r "$LOCK" $PIP_I 2>&1 | tail -2 || true
else
  echo "   没有锁文件，只能按上游清单解析（慢，且版本可能漂）"
fi

# index-tts 的依赖写在 pyproject 的 dependencies 里（没有 requirements.txt），抽出来装。
# 不用 `pip install -e .`：那会连 torch 一起按它钉的版本重装，把镜像里配好的 CUDA 版覆盖掉。
if [ -s "$LOCK" ]; then :   # 锁文件已经装过了
elif [ -f /root/index-tts/requirements.txt ]; then
  "$PY" -m pip install -q -r /root/index-tts/requirements.txt $PIP_I 2>&1 | tail -1
elif [ -f /root/index-tts/pyproject.toml ]; then
  "$PY" - <<'EOP' > /tmp/itts-deps.txt
import re, pathlib
t = pathlib.Path("/root/index-tts/pyproject.toml").read_text()
# 只取 dependencies 这一段，但不能用非贪婪匹配到第一个 "]"——像 fugashi[unidic-lite] 这种
# 带 extras 的依赖里本来就有方括号，会被从中间截断，一个坏行让整批 pip 都失败。
i = t.find("dependencies")
seg = ""
if i >= 0:
    j = t.find("[", i)
    depth = 0
    for k in range(j, len(t)):
        if t[k] == "[": depth += 1
        elif t[k] == "]":
            depth -= 1
            if depth == 0: seg = t[j + 1:k]; break
out = []
for line in seg.splitlines():
    line = line.strip().rstrip(",")
    if not line.startswith('"'): continue
    d = line.strip('"')
    if re.match(r"^(torch|torchaudio|torchvision)\b", d): continue   # 镜像里那套 CUDA 版不能动
    out.append(d)
print("\n".join(out))
EOP
  echo "   按 pyproject 装 $(wc -l < /tmp/itts-deps.txt) 个依赖"
  "$PY" -m pip install -q -r /tmp/itts-deps.txt $PIP_I 2>&1 | tail -2 || true
fi
# 路由服务自己要的（FastAPI 那套 + ASR）
"$PY" -m pip install -q fastapi uvicorn python-multipart soundfile funasr modelscope $PIP_I 2>&1 | tail -1
# transformers 必须钉在 4.x（锁文件里也有，这里再钉一次是为了没有锁文件时也不会装错）：IndexTTS-2 依赖 transformers.cache_utils.OffloadedCache，
# 这个类在 5.x 里被删了，装上 5.x 会在合成时 ImportError（华北那台一直是钉着的，脚本里漏了）
"$PY" -m pip install -q "transformers==4.51.3" $PIP_I 2>&1 | tail -1
# torchaudio 2.14 起，保存音频走 torchcodec；torchcodec 又要 FFmpeg 4 的**动态库**
# （libavutil.so.56），静态的 ffmpeg 二进制不算数。conda-forge 的 ffmpeg=4.* 才带这套 .so。
"$PY" -c "import torchcodec" 2>/dev/null || "$PY" -m pip install -q torchcodec $PIP_I 2>&1 | tail -1
if [ ! -e "$VENV/lib/libavutil.so.56" ] && [ -x /usr/local/miniconda3/bin/conda ]; then
  echo "   补 FFmpeg 4 动态库（torchcodec 要 libavutil.so.56）"
  /usr/local/miniconda3/bin/conda install -y -q -p "$VENV" \
    -c https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge "ffmpeg=4.*" >/dev/null 2>&1 || true
fi
"$PY" -c "import transformers;print('transformers', transformers.__version__)"

echo "== 可写的权重镜像（/model 是只读的，IndexTTS 要往旁边写 hf_cache）"
mkdir -p /root/model-cache/IndexTTS-2 /root/model-cache/hf /root/model-cache/modelscope
SRC=/model/ModelScope/IndexTeam/IndexTTS-2
if [ -d "$SRC" ]; then
  for f in "$SRC"/* "$SRC"/.[!.]*; do
    [ -e "$f" ] || continue
    t=/root/model-cache/IndexTTS-2/$(basename "$f")
    [ -e "$t" ] || ln -s "$f" "$t"
  done
  echo "   IndexTTS-2 已软链"
else
  echo "   !! 共享盘上没有 $SRC，语音引擎起不来"
fi
[ -d /model/ModelScope/gongjy/SenseVoiceSmall ] && echo "   SenseVoice 在" || echo "   !! 缺 SenseVoice（转写用）"

echo "== runner + supervisor"
mkdir -p /root/runners
cat > /root/runners/voice.sh <<'R'
#!/bin/bash
# 语音路由：IndexTTS-2 + SenseVoice 跑在 /root/index-tts/.venv 里。
# MODEL / MODEL_ID / KIND / ASR_MODEL 来自 /root/runners/voice.env（gpuctl start voice KEY=VAL… 写的）
set -a; [ -f /root/runners/voice.env ] && . /root/runners/voice.env; set +a
export MODEL="${MODEL:-/root/model-cache/IndexTTS-2}"
export MODEL_ID="${MODEL_ID:-indextts-2}"
export ASR_MODEL="${ASR_MODEL:-/model/ModelScope/gongjy/SenseVoiceSmall}"
export PORT="${PORT:-8600}"
export INDEXTTS_ROOT=/root/index-tts
export HF_HOME=/root/model-cache/hf MODELSCOPE_CACHE=/root/model-cache/modelscope
case "$MODEL" in /model/*) m=/root/model-cache/$(basename "$MODEL"); mkdir -p "$m"; for f in "$MODEL"/* "$MODEL"/.[!.]*; do [ -e "$f" ] && [ ! -e "$m/$(basename "$f")" ] && ln -s "$f" "$m/$(basename "$f")"; done; export MODEL="$m";; esac
pkill -9 -f "atelier-gpu/voice/workers/" 2>/dev/null || true
cd /root/index-tts
exec /root/index-tts/.venv/bin/python /root/atelier-gpu/voice/server.py
R
chmod +x /root/runners/voice.sh
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
supervisorctl reread >/dev/null; supervisorctl update >/dev/null
"$PY" -c "import torch;print('venv ok, torch', torch.__version__, 'cuda', torch.cuda.is_available())"
