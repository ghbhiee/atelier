#!/bin/bash
# llama.cpp（CUDA）+ runner。幂等。
#
# 三条路，按快慢：
#   1. 13 上有别的机器备份好的构建产物 → 经车队隧道拉过来（约 5 MB/s，几十秒）
#   2. llama.cpp 官方预编译的 CUDA 包（GitHub，从盒子直连很快）——先验能不能跑
#   3. 从源码编译（正确但慢，20–40 分钟）
# 权重不下载：一律软链共享盘 /model 上已有的 gguf。
set -euo pipefail
BIN=/root/llama.cpp/build/bin/llama-server
PROXY=${FLEET_PROXY:-127.0.0.1:11080}
CACHE_URL=${LLAMA_CACHE_URL:-}          # 由 add-gpu.sh 传入，指向 13 的 loopback（经隧道）

ok() { [ -x "$BIN" ] && "$BIN" --version >/dev/null 2>&1; }
if ok; then echo "llama-server 已就绪：$("$BIN" --version 2>&1 | head -1)"; else

mkdir -p /root/llama.cpp/build/bin
got=0
# --- 1) 13 上的缓存，经隧道
if [ -n "$CACHE_URL" ]; then
  echo "== 试 13 的缓存（经隧道）"
  # --noproxy "" 是必须的：curl 默认把 localhost 排除在代理之外，于是它会直连盒子自己的 18790（不存在）
  if curl -fsS --noproxy "" --connect-timeout 10 --max-time 900 --socks5-hostname "$PROXY" -o /tmp/llama.tgz "$CACHE_URL"; then
    tar -C /root/llama.cpp/build/bin -xzf /tmp/llama.tgz && rm -f /tmp/llama.tgz
    chmod +x /root/llama.cpp/build/bin/* 2>/dev/null || true
    ok && got=1 && echo "   缓存可用"
  fi
  [ "$got" = 1 ] || echo "   缓存拿不到或跑不起来，往下走"
fi
# --- 2) 官方预编译（注意：llama.cpp 的 Linux 预编译已经不出 CUDA 版了，只有 Windows 有；
#        Vulkan 版在这些容器里看不到设备。留着这一步是为了以后官方要是又出了能直接用）
if [ "$got" = 0 ]; then
  echo "== 试官方预编译的 CUDA 包"
  T=$(mktemp -d)
  U=$(curl -fsS --connect-timeout 10 --max-time 60 https://api.github.com/repos/ggml-org/llama.cpp/releases/latest \
      | grep -oE '"browser_download_url": *"[^"]*ubuntu[^"]*cuda[^"]*\.zip"' | head -1 | cut -d'"' -f4 || true)
  if [ -n "$U" ] && curl -fsSL --connect-timeout 10 --max-time 900 -o "$T/l.zip" "$U"; then
    # 这些 pod 镜像连 unzip 都没有，用 python 的 zipfile 解，省得动 apt
    (cd "$T" && python3 -m zipfile -e l.zip .) \
      && find "$T" -type f \( -name 'llama-*' -o -name '*.so*' \) -exec install -m755 {} /root/llama.cpp/build/bin/ \; 2>/dev/null || true
    LD_LIBRARY_PATH=/root/llama.cpp/build/bin ok && got=1 && echo "   预编译可用"
  fi
  rm -rf "$T"
  [ "$got" = 1 ] || echo "   预编译不可用（多半是这张卡的算力没编进去），只能自己编"
fi
# --- 3) 源码编译
if [ "$got" = 0 ]; then
  echo "== 从源码编译（20–40 分钟）"
  # 这些镜像里 CUDA 其实是全的，只是 nvcc 不在 PATH 上；cmake 走 pip、g++ 走 conda，都不动 apt
  export PATH="/usr/local/cuda/bin:$PATH"
  CONDA=/usr/local/miniconda3
  PY312="$CONDA/envs/py312/bin/python"
  command -v cmake >/dev/null || {
    echo "   装 cmake（pip 清华源）"
    "$PY312" -m pip install -q cmake ninja -i https://pypi.tuna.tsinghua.edu.cn/simple
    export PATH="$CONDA/envs/py312/bin:$PATH"
  }
  command -v g++ >/dev/null || {
    echo "   装 g++（conda 清华源）"
    "$CONDA/bin/conda" install -y -q -p "$CONDA/envs/py312" \
      -c https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge gxx_linux-64 >/dev/null 2>&1 || true
    G=$(ls "$CONDA/envs/py312/bin/"*-linux-gnu-g++ 2>/dev/null | head -1)
    [ -n "$G" ] && ln -sf "$G" /usr/local/bin/g++ && ln -sf "${G%g++}gcc" /usr/local/bin/gcc-conda
  }
  command -v cmake >/dev/null || { echo "cmake 还是没有，编不了"; exit 1; }
  command -v nvcc  >/dev/null || { echo "缺 nvcc（CUDA toolkit），编不了 CUDA 版"; exit 1; }
  command -v g++   >/dev/null || { echo "缺 g++（CUDA 需要 C++ 宿主编译器），编不了"; exit 1; }
  rm -rf /root/llama.cpp/src && mkdir -p /root/llama.cpp/src
  curl -fsSL --connect-timeout 10 --max-time 600 -o /tmp/lcpp.tar.gz https://github.com/ggml-org/llama.cpp/archive/refs/heads/master.tar.gz
  tar -C /root/llama.cpp/src --strip-components=1 -xzf /tmp/lcpp.tar.gz && rm -f /tmp/lcpp.tar.gz
  ARCH=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d '.')
  # nvcc 默认拿系统 gcc 当宿主编译器，而这些镜像的 gcc 没带 cc1plus（少了 g++ 包），
  # 于是 cmake 连编译器识别都过不去。显式指到 conda 装的那个 g++。
  HOSTCXX=$(readlink -f "$(command -v g++)")
  cmake -S /root/llama.cpp/src -B /root/llama.cpp/bld -DGGML_CUDA=ON \
    -DCMAKE_CUDA_ARCHITECTURES="${ARCH:-120}" -DLLAMA_CURL=OFF \
    -DCMAKE_CUDA_HOST_COMPILER="$HOSTCXX" -DCMAKE_CXX_COMPILER="$HOSTCXX" >/dev/null
  cmake --build /root/llama.cpp/bld -j"$(nproc)" --target llama-server >/dev/null
  install -m755 /root/llama.cpp/bld/bin/llama-server /root/llama.cpp/build/bin/llama-server
  find /root/llama.cpp/bld -name '*.so*' -exec install -m755 {} /root/llama.cpp/build/bin/ \; 2>/dev/null || true
fi
fi

echo "== runner + supervisor"
mkdir -p /root/runners
cat > /root/runners/llm.sh <<'R'
#!/bin/bash
# llama-server runner: MODEL / ARGS / ALIAS 来自 /root/runners/llm.env（gpuctl start llm KEY=VAL… 写的）
set -a; [ -f /root/runners/llm.env ] && . /root/runners/llm.env; set +a
: "${MODEL:?MODEL not set}"
ARGS_DEFAULT="-c 32768 -ngl 999 -fa on --jinja"
eval "exec /root/llama.cpp/build/bin/llama-server -m \"\$MODEL\" --host 127.0.0.1 --port 8080 ${ARGS:-$ARGS_DEFAULT} ${ALIAS:+--alias \"\$ALIAS\"}"
R
chmod +x /root/runners/llm.sh
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
supervisorctl reread >/dev/null; supervisorctl update >/dev/null
echo "== 共享盘上的 gguf："
find /model -maxdepth 5 -iname '*.gguf' 2>/dev/null | head -5 || echo "   一个都没有，得先把权重放到 /model"
LD_LIBRARY_PATH=/root/llama.cpp/build/bin "$BIN" --version 2>&1 | head -1
