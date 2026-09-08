#!/usr/bin/env python3
"""White-model ("clay" / plaster) video renderer — torch port of ~/cc/whitemodel (depth_infer.py + render.py).

Stage 1  infer_depth(): Depth Anything V2 per frame → disparity cache (uint16 + per-frame range) + luma cache + meta.
Stage 2  render(): multi-scale relief field with per-band local normalisation → three-point Lambert shading →
         cavity AO → contour lines → mp4 (original audio laid back).

The numerics deliberately mirror OpenCV so the port stays within the golden tolerance of the reference:
  * Gaussian kernels built like cv2.getGaussianKernel (ksize = round(8σ+1)|1, reflect-101 borders, repeated reflection)
  * INTER_AREA downsampling with fractional cells, INTER_LINEAR upsampling (half-pixel centres)
  * bilateral filter with a circular window of radius round(1.5·σ_space)
  * 3×3 Sobel / 8, erosion with an "ignore outside" border, linear-interpolation percentiles
Everything runs on cuda / mps / cpu; frames are processed one at a time so memory stays flat regardless of clip length.
"""
import json, math, os, subprocess, sys, time
import numpy as np
import torch
import torch.nn.functional as F

PRESETS = {
  "clay":   dict(relief=6.0, ao=0.55, edge=0.55, photo=0.30, gamma=1.00, amb=0.30, spec=0.14, temporal=10, local=25, alpha=0.85, wbase=0.35),
  "sculpt": dict(relief=9.0, ao=0.75, edge=0.75, photo=0.55, gamma=0.95, amb=0.24, spec=0.08, temporal=8, local=35, alpha=0.72, wbase=0.30),
  "soft":   dict(relief=3.5, ao=0.40, edge=0.35, photo=0.15, gamma=1.05, amb=0.40, spec=0.18, temporal=10, local=15, alpha=0.92, wbase=0.50),
  "toon":   dict(relief=6.0, ao=0.45, edge=1.05, photo=0.20, gamma=1.00, amb=0.34, spec=0.00, temporal=8, local=25, alpha=0.85, wbase=0.35, bands=5),
}
USER_PARAMS = ("relief", "photo", "ao")   # the only knobs exposed to users (HANDOFF §6)

def _unit(v):
    v = np.asarray(v, np.float32); return v / np.linalg.norm(v)
KEY  = _unit([-0.45, -0.62, 0.65])   # x right, y DOWN (image coords), z toward camera
FILL = _unit([ 0.62, -0.18, 0.55])
RIM  = _unit([ 0.08,  0.72, 0.50])
GMAX = 2.2                           # gradient soft-clip: keeps depth cliffs from going pure black

DEPTH_MODELS = {"small": "depth-anything/Depth-Anything-V2-Small-hf",
                "base":  "depth-anything/Depth-Anything-V2-Base-hf",
                "large": "depth-anything/Depth-Anything-V2-Large-hf"}


def pick_device(pref=None):
    if pref: return torch.device(pref)
    if torch.cuda.is_available(): return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available(): return torch.device("mps")
    return torch.device("cpu")


# ----------------------------------------------------------------------------------------------
# OpenCV-compatible primitives (all take / return 2-D float32 tensors)
# ----------------------------------------------------------------------------------------------
_KCACHE = {}

def _gauss1d(sigma, device):
    key = (round(float(sigma), 6), str(device))
    k = _KCACHE.get(key)
    if k is None:
        n = int(round(sigma * 8 + 1)) | 1            # cv2: cvRound(sigma*4*2+1)|1 for non-8U images
        x = np.arange(n, dtype=np.float64) - (n - 1) * 0.5
        w = np.exp(-0.5 * (x / sigma) ** 2); w /= w.sum()
        k = torch.tensor(w, dtype=torch.float32, device=device)
        _KCACHE[key] = k
    return k

def _reflect101_idx(n, pad, device):
    key = ("r", n, pad, str(device))
    idx = _KCACHE.get(key)
    if idx is None:
        p = np.arange(-pad, n + pad)
        if n == 1: p = np.zeros_like(p)
        else:
            per = 2 * (n - 1)                        # repeated reflection, like cv2.borderInterpolate
            p = np.abs(p) % per
            p = np.where(p >= n, per - p, p)
        idx = torch.tensor(p, dtype=torch.long, device=device)
        _KCACHE[key] = idx
    return idx

def pad_reflect101(x, ph, pw):
    if ph: x = x[_reflect101_idx(x.shape[0], ph, x.device), :]
    if pw: x = x[:, _reflect101_idx(x.shape[1], pw, x.device)]
    return x

def gblur(x, sigma):
    """cv2.GaussianBlur(x, (0,0), sigma) for float32 2-D."""
    if sigma <= 0: return x
    k = _gauss1d(sigma, x.device); r = k.numel() // 2
    y = pad_reflect101(x, r, r)[None, None]
    y = F.conv2d(y, k.view(1, 1, 1, -1))
    y = F.conv2d(y, k.view(1, 1, -1, 1))
    return y[0, 0]

def _area_weights(n_in, n_out, device):
    key = ("a", n_in, n_out, str(device))
    W = _KCACHE.get(key)
    if W is None:
        scale = n_in / n_out
        M = np.zeros((n_out, n_in), np.float64)
        for i in range(n_out):
            a = i * scale; cell = min(scale, n_in - a); b = a + cell
            j0 = int(math.floor(a)); j1 = int(math.ceil(b))
            for j in range(j0, min(j1, n_in)):
                w = min(b, j + 1) - max(a, j)
                if w > 1e-9: M[i, j] += w / cell
        W = torch.tensor(M, dtype=torch.float32, device=device)
        _KCACHE[key] = W
    return W

def resize_area(x, w_out, h_out):
    """cv2.resize(..., interpolation=INTER_AREA) for downsizing (exact box / fractional cells)."""
    H, Wd = x.shape
    Wy = _area_weights(H, h_out, x.device); Wx = _area_weights(Wd, w_out, x.device)
    return Wy @ x @ Wx.T

def resize_linear(x, w_out, h_out):
    """cv2.resize(..., INTER_LINEAR): half-pixel centres, clamped edges == torch bilinear align_corners=False."""
    return F.interpolate(x[None, None], size=(h_out, w_out), mode="bilinear", align_corners=False)[0, 0]

def blur(a, sig):
    """render.py blur(): direct blur for sigma < 6, otherwise blur on a 1/f proxy and upsample."""
    if sig < 6.0: return gblur(a, sig)
    h_, w_ = a.shape
    f = max(1, int(sig / 4.0))
    sm = resize_area(a, max(w_ // f, 8), max(h_ // f, 8))
    sm = gblur(sm, sig / f)
    return resize_linear(sm, w_, h_)

def bilateral(x, sigma_color, sigma_space):
    """cv2.bilateralFilter(x, 0, sigma_color, sigma_space) for float32 2-D (circular window, reflect-101)."""
    radius = int(round(sigma_space * 1.5))
    xp = pad_reflect101(x, radius, radius)
    H, W = x.shape
    cc = -0.5 / (sigma_color * sigma_color); cs = -0.5 / (sigma_space * sigma_space)
    num = torch.zeros_like(x); den = torch.zeros_like(x)
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            r2 = dy * dy + dx * dx
            if math.sqrt(r2) > radius: continue
            sh = xp[radius + dy: radius + dy + H, radius + dx: radius + dx + W]
            w = torch.exp((sh - x) ** 2 * cc) * math.exp(r2 * cs)
            num += w * sh; den += w
    return num / den

_SOB = {}
def sobel(x, axis):
    """cv2.Sobel(x, CV_32F, dx, dy, ksize=3) / 8  (axis 0 → d/dx, 1 → d/dy)."""
    key = (axis, str(x.device))
    k = _SOB.get(key)
    if k is None:
        d = torch.tensor([-1.0, 0.0, 1.0], device=x.device); s = torch.tensor([1.0, 2.0, 1.0], device=x.device)
        k = (s.view(3, 1) @ d.view(1, 3)) if axis == 0 else (d.view(3, 1) @ s.view(1, 3))
        k = (k / 8.0).view(1, 1, 3, 3); _SOB[key] = k
    return F.conv2d(pad_reflect101(x, 1, 1)[None, None], k)[0, 0]

def erode(x, k):
    """cv2.erode with a k×k ones kernel; outside pixels are ignored (cv2's default border for erode)."""
    return -F.max_pool2d(-x[None, None], k, stride=1, padding=k // 2)[0, 0]

def percentile(x, q):
    return torch.quantile(x.reshape(-1), q / 100.0).item()


# ----------------------------------------------------------------------------------------------
# The algorithm (see HANDOFF-H3 §3 for the reasoning behind every step)
# ----------------------------------------------------------------------------------------------
def relief_field(hs, W, p):
    """Multi-scale band-pass with per-band local contrast normalisation, bands up to W/4."""
    H = hs.shape[0]
    sig = [W / 220.0, W / 80.0, W / 28.0, W / 10.0, W / 4.0]
    alpha = p.get("alpha", 0.8)
    loc = max(p.get("local", 25.0), 1.0)
    sw, sh = W // 4, H // 4
    cur = hs
    acc = torch.zeros_like(hs)
    for s_ in sig:
        b = blur(cur, s_)
        band = cur - b
        ns = max(s_ * 2.0, 2.0) / 4.0
        sm = resize_area(band, sw, sh)
        m = gblur(sm, ns)
        sd = torch.sqrt(torch.clamp(gblur((sm - m) ** 2, ns), min=0.0))
        k = int(max(3, round(ns))) | 1
        sd = erode(sd, k)
        sd = gblur(sd, max(ns * 0.6, 0.6))
        sd = resize_linear(sd, W, H)
        flo = (percentile(sd, 55) + 1e-9) / loc
        acc += band / torch.clamp(sd, min=flo) * (s_ ** alpha)
        cur = b
    base = (cur - cur.mean()) / (cur.std(unbiased=False) + 1e-6)
    return acc + base * ((W / 4.0) ** alpha) * p.get("wbase", 0.35)


class DepthCache:
    """Reads the stage-1 cache (disp.npy uint16 memmap + lohi.npy + gray.npy + meta.json)."""
    def __init__(self, work, device):
        self.work = work; self.device = device
        self.meta = json.load(open(os.path.join(work, "meta.json")))
        self.disp = np.load(os.path.join(work, "disp.npy"), mmap_mode="r")
        self.lohi = np.load(os.path.join(work, "lohi.npy"))
        self.gray = np.load(os.path.join(work, "gray.npy"), mmap_mode="r")
        self.n = int(self.meta["n"]); self.W = int(self.meta["W"]); self.H = int(self.meta["H"])

    def height(self, i):
        """Globally-normalised height field for frame i (float32 tensor)."""
        lo_, hi_ = float(self.lohi[i, 0]), float(self.lohi[i, 1])
        raw = torch.from_numpy(np.asarray(self.disp[i], np.float32)).to(self.device)
        raw = lo_ + raw * ((hi_ - lo_) / 65535.0)
        m = self.meta
        return torch.clamp((raw - m["dmin"]) / (m["dmax"] - m["dmin"]), 0.0, 1.0)

    def luma(self, i):
        return torch.from_numpy(np.asarray(self.gray[i], np.float32)).to(self.device) / 255.0


def grad_scale(cache, p, target=0.30, log=print, use_cache=True):
    """One global gradient scale K so shading contrast is stable across the whole clip (10 sample frames)."""
    key = f"{p.get('alpha',0.8)}_{p.get('local',6)}_{p.get('wbase',1.0)}"
    cfile = os.path.join(cache.work, f"gradstat_{key}.json")
    if use_cache and os.path.exists(cfile):
        return json.load(open(cfile))["K"]
    n = cache.n; vals = []
    for i in range(0, n, max(1, n // 10)):
        hs = bilateral(cache.height(i), 0.02, 5)
        R = relief_field(hs, cache.W, p)
        gx = sobel(R, 0); gy = sobel(R, 1)
        vals.append(percentile(torch.sqrt(gx * gx + gy * gy), 92))
    ref = float(np.median(vals))
    K = target / max(ref, 1e-7)
    if use_cache: json.dump(dict(K=K, ref=ref), open(cfile, "w"))
    log(f"  grad ref={ref:.2e}  K={K:.4f}")
    return K


def shade(h, gray, p, K):
    """h: height (H,W) float32 tensor in [0,1]; gray: luma (H,W) float32 in [0,1] → uint8 (H,W) tensor."""
    H, W = h.shape
    hs = bilateral(h, 0.02, 5)
    R = relief_field(hs, W, p)
    if p.get("photo", 0) > 0:
        g = bilateral(gray, 0.06, 5)
        pg = dict(p); pg["wbase"] = 0.0
        R = R + relief_field(g, W, pg) * p["photo"]

    amp = K * p["relief"]
    gx = sobel(R, 0) * amp
    gy = sobel(R, 1) * amp
    gm = torch.sqrt(gx * gx + gy * gy) + 1e-9
    soft = GMAX * torch.tanh(gm / GMAX) / gm
    gx = gx * soft; gy = gy * soft

    inv = 1.0 / torch.sqrt(gx * gx + gy * gy + 1.0)
    nx, ny, nz = -gx * inv, -gy * inv, inv
    dot = lambda L: torch.clamp(nx * float(L[0]) + ny * float(L[1]) + nz * float(L[2]), min=0.0)
    out = p["amb"] + dot(KEY) * 0.74 + dot(FILL) * 0.30 + dot(RIM) * 0.15

    if p["spec"] > 0:
        Hv = _unit(KEY + np.array([0, 0, 1.0], np.float32))
        out = out + p["spec"] * torch.pow(dot(Hv), 14.0)

    if p["ao"] > 0:
        for sig, w in ((W / 130.0, 0.45), (W / 42.0, 0.75), (W / 15.0, 1.0)):
            cav = hs - blur(hs, sig)
            s = percentile(torch.abs(cav), 96) + 1e-6
            out = out * torch.clamp(1.0 + p["ao"] * w * torch.clamp(cav / s, -1.6, 1.2), 0.18, 1.25)

    if p.get("bands"):
        b = int(p["bands"])
        out = torch.floor(torch.clamp(out, 0, 1.25) * b) / (b - 1) * 0.9 + 0.08

    if p["edge"] > 0:
        g0 = torch.sqrt(sobel(hs, 0) ** 2 + sobel(hs, 1) ** 2)
        t = percentile(g0, 99.3) + 1e-9
        e = torch.clamp((g0 - 0.30 * t) / (t * 0.85), 0, 1)
        out = out * (1.0 - p["edge"] * 0.8 * e)

    out = torch.clamp(torch.clamp(out, 0, 1) ** p["gamma"], 0, 1) * 255
    return out.to(torch.uint8)


class Temporal:
    """Per-pixel adaptive EMA (strong where static, none where moving), reset on cuts."""
    def __init__(self, p):
        self.T = int(p.get("temporal", 3)); self.motion = p.get("motion", 0.05); self.ema = None
    def __call__(self, h):
        if self.T <= 1: return h
        if self.ema is not None and torch.mean(torch.abs(h - self.ema)).item() > 0.11: self.ema = None
        if self.ema is None: self.ema = h
        else:
            d = gblur(torch.abs(h - self.ema), 14.0)
            a = torch.clamp(d / self.motion, 2.0 / (self.T + 1.0), 1.0)
            self.ema = a * h + (1.0 - a) * self.ema
        return self.ema


def resolve_params(preset="clay", overrides=None):
    p = dict(PRESETS.get(preset, PRESETS["clay"]))
    for k, v in (overrides or {}).items():
        if v is None: continue
        try: fv = float(v)
        except (TypeError, ValueError): continue
        if fv > 0 or k not in USER_PARAMS: p[k] = fv
    return p


# ----------------------------------------------------------------------------------------------
# Stage 1: depth inference
# ----------------------------------------------------------------------------------------------
def infer_depth(video, work, model="large", batch=8, device=None, log=print, progress=None, local_model=None, start=0.0, dur=0.0, fp16=True):
    import cv2
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation
    device = pick_device(device)
    os.makedirs(work, exist_ok=True)
    cap = cv2.VideoCapture(video)
    if not cap.isOpened(): raise RuntimeError(f"cannot open video: {video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    f0 = int(round(start * fps))
    n = total - f0 if dur <= 0 else min(int(round(dur * fps)), total - f0)
    if f0: cap.set(cv2.CAP_PROP_POS_FRAMES, f0)
    log(f"video {W}x{H} fps={fps:.4f} total={total} -> frames [{f0}, {f0+n}) n={n}")

    mid = local_model or DEPTH_MODELS[model]
    log(f"model: {mid} device: {device}")
    proc = AutoImageProcessor.from_pretrained(mid)
    net = AutoModelForDepthEstimation.from_pretrained(mid)
    use_half = device.type == "cuda" and fp16
    net = net.to(device, dtype=torch.float16 if use_half else torch.float32).eval()

    disp = np.lib.format.open_memmap(os.path.join(work, "disp.npy"), mode="w+", dtype=np.uint16, shape=(n, H, W))
    gray = np.lib.format.open_memmap(os.path.join(work, "gray.npy"), mode="w+", dtype=np.uint8, shape=(n, H, W))
    lohi = np.zeros((n, 2), np.float32)

    buf, idx, done, t0 = [], [], 0, time.time()
    def flush():
        nonlocal buf, idx, done
        if not buf: return
        inp = proc(images=buf, return_tensors="pt")
        pv = inp["pixel_values"].to(device, dtype=torch.float16 if use_half else torch.float32)
        with torch.no_grad():
            out = net(pixel_values=pv).predicted_depth
        out = F.interpolate(out.unsqueeze(1).float(), size=(H, W), mode="bicubic", align_corners=False).squeeze(1)
        arr = out.cpu().numpy()
        for k, i in enumerate(idx):
            a = arr[k]
            lo_, hi_ = float(a.min()), float(a.max())
            lohi[i] = (lo_, hi_)
            disp[i] = np.rint((a - lo_) / max(hi_ - lo_, 1e-6) * 65535.0).astype(np.uint16)
        done += len(idx)
        el = time.time() - t0
        log(f"  depth {done}/{n}  {el:.1f}s  {done/max(el,1e-6):.2f} fps")
        if progress: progress(done, n)
        buf, idx = [], []

    real_n = n
    for i in range(n):
        ok, frame = cap.read()
        if not ok: log(f"!! stream ended early at {i}"); real_n = i; break
        gray[i] = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        buf.append(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)); idx.append(i)
        if len(buf) == batch: flush()
    flush()
    n = real_n
    cap.release(); disp.flush(); gray.flush()
    np.save(os.path.join(work, "lohi.npy"), lohi[:n])

    step = max(1, n // 60)
    samp = [lohi[i, 0] + disp[i, ::4, ::4].astype(np.float32) / 65535.0 * (lohi[i, 1] - lohi[i, 0]) for i in range(0, n, step)]
    d = np.stack(samp)
    meta = dict(input=os.path.abspath(video), model=model, fps=fps, W=W, H=H, start_frame=f0, n=int(n),
                dmin=float(np.percentile(d, 0.5)), dmax=float(np.percentile(d, 99.5)),
                dabsmin=float(d.min()), dabsmax=float(d.max()))
    json.dump(meta, open(os.path.join(work, "meta.json"), "w"), indent=2)
    del net
    if device.type == "cuda": torch.cuda.empty_cache()
    return meta


# ----------------------------------------------------------------------------------------------
# Stage 2: render
# ----------------------------------------------------------------------------------------------
def subject_mask(h, thr=0.55, feather=9.0, device=None):
    """Foreground mask straight out of the height field: the subject is what is near the camera.
    No extra model needed — depth is already computed for the relief — and a soft edge keeps the
    composite from showing a cut-out line. thr is a fraction of the frame's own depth range."""
    lo, hi = percentile(h, 2), percentile(h, 98)      # percentile() takes a percentage, not a fraction
    if hi - lo < 1e-3: return torch.zeros_like(h)       # flat depth (a screen recording): no subject to cut out
    n = torch.clamp((h - lo) / (hi - lo), 0.0, 1.0)
    m = torch.clamp((n - thr) / max(1e-3, 1.0 - thr), 0.0, 1.0)      # ramp instead of a hard cut
    m = torch.clamp(m * 1.6, 0.0, 1.0)
    if feather > 0: m = gblur(m, feather)
    return torch.clamp(m, 0.0, 1.0)


def render(work, out, preset="clay", overrides=None, audio_from="", device=None, log=print, progress=None, limit=0, tint="none",
           subject_only=False, subject_thr=0.55, subject_feather=9.0, source=""):
    device = pick_device(device)
    p = resolve_params(preset, overrides)
    cache = DepthCache(work, device)
    K = grad_scale(cache, p, log=log)
    n = cache.n if limit <= 0 else min(limit, cache.n)
    temporal = Temporal(p)
    W, H, fps = cache.W, cache.H, cache.meta["fps"]

    # Subject-only keeps the original scene and only sculpts the person, which is what makes a copyrighted
    # clip usable: the actor becomes a clay figure while the room stays as shot.
    src = None
    if subject_only:
        if not source or not os.path.exists(source): raise RuntimeError("仅人物白模需要原视频路径（source）")
        src = subprocess.Popen(["ffmpeg", "-v", "error", "-i", source, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                               stdout=subprocess.PIPE, bufsize=W * H * 3 * 4)
    gray_out = (tint == "none") and not subject_only
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray" if gray_out else "bgr24", "-s", f"{W}x{H}", "-r", f"{fps:.6f}", "-i", "-"]
    if audio_from: cmd += ["-i", audio_from]
    cmd += ["-c:v", "libx264", "-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    cmd += (["-map", "0:v:0", "-map", "1:a:0?", "-c:a", "aac", "-b:a", "160k", "-shortest"] if audio_from else ["-an"])
    cmd += [out]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    t0 = time.time()
    if subject_only: log(f"  subject-only: thr={subject_thr} feather={subject_feather} source={os.path.basename(source)}")
    cover = []
    try:
        for i in range(n):
            hraw = cache.height(i)
            h = temporal(hraw)
            shaded = shade(h, cache.luma(i), p, K)
            if subject_only:
                frame = src.stdout.read(W * H * 3)
                if len(frame) < W * H * 3: break
                orig = torch.from_numpy(np.frombuffer(frame, np.uint8).reshape(H, W, 3).astype(np.float32)).to(shaded.device)
                mk = subject_mask(hraw, subject_thr, subject_feather)
                if i % 25 == 0: cover.append(float(mk.mean()))
                m = mk[..., None]
                clay = shaded.float()[..., None].expand(-1, -1, 3)
                img = (m * clay + (1.0 - m) * orig).clamp(0, 255).to(torch.uint8).cpu().numpy()
            else:
                img = shaded.cpu().numpy()
                if tint != "none":
                    f = np.array([0.93, 0.965, 1.0] if tint == "warm" else [1.0, 0.98, 0.94], np.float32)
                    img = np.clip(img[..., None].astype(np.float32) * f, 0, 255).astype(np.uint8)
            enc.stdin.write(np.ascontiguousarray(img).tobytes())
            if i % 50 == 0:
                el = time.time() - t0
                log(f"  render {i}/{n}  {el:.1f}s  {(i+1)/max(el,1e-6):.2f} fps")
                if progress: progress(i, n)
    finally:
        enc.stdin.close(); rc = enc.wait()
        if src: src.stdout.close(); src.wait()
    if rc != 0: raise RuntimeError(f"ffmpeg exited {rc}")
    if progress: progress(n, n)
    if subject_only and cover: log(f"  subject-only mask covered {100*sum(cover)/len(cover):.0f}% of the frame on average")
    log(f"wrote {out}  ({n} frames, {time.time()-t0:.1f}s)")
    return out


def run_pipeline(video, out, work=None, preset="clay", overrides=None, keep_audio=True, model="large", device=None, log=print, progress=None, local_model=None, batch=8, fp16=True,
                 subject_only=False, subject_thr=0.55, subject_feather=9.0):
    """Whole thing: video → white-model mp4. `progress(stage, done, total)`."""
    work = work or (os.path.splitext(out)[0] + "_work")
    os.makedirs(work, exist_ok=True)
    infer_depth(video, work, model=model, batch=batch, device=device, log=log, local_model=local_model, fp16=fp16,
                progress=(lambda d, n: progress("depth", d, n)) if progress else None)
    render(work, out, preset=preset, overrides=overrides, audio_from=video if keep_audio else "", device=device, log=log,
           progress=(lambda d, n: progress("render", d, n)) if progress else None,
           subject_only=subject_only, subject_thr=subject_thr, subject_feather=subject_feather, source=video)
    return out


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="white-model video (torch)")
    ap.add_argument("video"); ap.add_argument("out")
    ap.add_argument("--work"); ap.add_argument("--preset", default="clay", choices=list(PRESETS))
    ap.add_argument("--relief", type=float); ap.add_argument("--photo", type=float); ap.add_argument("--ao", type=float)
    ap.add_argument("--no-audio", action="store_true"); ap.add_argument("--model", default="large", choices=list(DEPTH_MODELS))
    ap.add_argument("--local-model"); ap.add_argument("--device"); ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--render-only", action="store_true", help="reuse an existing --work cache")
    ap.add_argument("--fp32", action="store_true", help="run the depth net in fp32 (default fp16 on cuda)")
    a = ap.parse_args()
    ov = dict(relief=a.relief, photo=a.photo, ao=a.ao)
    if a.render_only:
        render(a.work, a.out, preset=a.preset, overrides=ov, audio_from="" if a.no_audio else a.video, device=a.device)
    else:
        run_pipeline(a.video, a.out, work=a.work, preset=a.preset, overrides=ov, keep_audio=not a.no_audio, model=a.model, device=a.device, local_model=a.local_model, batch=a.batch, fp16=not a.fp32)
