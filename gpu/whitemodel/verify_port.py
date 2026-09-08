#!/usr/bin/env python3
"""Acceptance checks for the torch port (mirrors ~/cc/whitemodel/verify.py):
  1. golden frame PSNR >= 35 dB   2. adaptive gain K in [0.03, 0.15]
  3. static-region flicker <= 4.0/255   4. motion detail retained >= 95%
Usage: python3 verify_port.py <work dir> [golden.png] [--quick]
"""
import os, sys, time
import numpy as np, cv2, torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wm

work = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/cc/whitemodel/work/full")
golden = next((a for a in sys.argv[2:] if a.endswith(".png")), os.path.expanduser("~/cc/whitemodel/out/golden_f0900.png"))
quick = "--quick" in sys.argv
dev = wm.pick_device()
print("device:", dev)
cache = wm.DepthCache(work, dev)
p = dict(wm.PRESETS["clay"])
t0 = time.time()
K = wm.grad_scale(cache, p, use_cache=False)
print(f"K={K:.4f}  ({time.time()-t0:.1f}s)")
def psnr(a, b):
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return float("inf") if mse == 0 else 10.0 * np.log10(255.0 ** 2 / mse)
res = []
t0 = time.time()
img = wm.shade(cache.height(900), cache.luma(900), p, K).cpu().numpy()
print(f"shade(900) {time.time()-t0:.1f}s")
cv2.imwrite(os.path.join(os.path.dirname(golden), "port_f0900.png"), img)
g = cv2.imread(golden, cv2.IMREAD_GRAYSCALE)
v = psnr(img, g); res.append(("golden frame PSNR", f"{v:.1f} dB", ">= 35 dB", v >= 35.0))
res.append(("adaptive gain K", f"{K:.4f}", "0.03 - 0.15", 0.03 <= K <= 0.15))
if not quick:
    win = range(560, 584)
    src = [np.asarray(cache.gray[i], np.float32) for i in win]
    mv = np.max([np.abs(src[i + 1] - src[i]) for i in range(len(src) - 1)], axis=0)
    static = cv2.erode((mv < 3).astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)
    moving = cv2.dilate((mv > 25).astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)
    def run(temporal):
        tf = wm.Temporal(p if temporal else {"temporal": 1}); out = []
        for i in win:
            h = tf(cache.height(i))
            out.append(wm.shade(h, cache.luma(i), p, K).cpu().numpy().astype(np.float32))
        return out
    t0 = time.time(); filt, raw = run(True), run(False); print(f"temporal window {time.time()-t0:.1f}s")
    flick = float(np.mean([np.mean(np.abs(filt[i + 1] - filt[i])[static]) for i in range(len(filt) - 1)])) if static.any() else 0.0
    res.append(("temporal flicker (static px)", f"{flick:.2f} /255", "<= 4.0", flick <= 4.0))
    det = lambda seq: float(np.mean([cv2.Laplacian(np.where(moving, f, 0), cv2.CV_32F).var() for f in seq]))
    keep = det(filt) / max(det(raw), 1e-9)
    res.append(("motion detail retained", f"{keep * 100:.0f}%", ">= 95%", keep >= 0.95))
print(f"\n{'check':32s} {'value':>26s} {'target':>12s}  result"); print("-" * 82)
ok = True
for name, val, target, passed in res:
    ok &= passed; print(f"{name:32s} {val:>26s} {target:>12s}  {'PASS' if passed else 'FAIL'}")
sys.exit(0 if ok else 1)
