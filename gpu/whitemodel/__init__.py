"""ComfyUI custom node: AtelierWhiteModel — real footage → white-model ("clay" / plaster) render.

Deliberately file-based: the node takes a video *path* (an upload in ComfyUI's input dir, or any absolute
path), streams frames through Depth Anything V2 + the torch relief renderer in wm.py, and returns the output
*path* (registered in history as a video so the workbench downloads it like any other job). Nothing is ever
held as a ComfyUI IMAGE tensor — 1760 frames of 720p float32 would be 19 GB (HANDOFF-H3 §5).
"""
import os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import folder_paths

try:
    from comfy.utils import ProgressBar
except Exception:  # pragma: no cover
    ProgressBar = None

import wm

# Where the HF-format Depth Anything V2 weights live on the GPU box (downloaded once into the model cache);
# falls back to the hub id (needs network) when the local copy is missing.
LOCAL_DEPTH = {
    "large": "/root/model-cache/Depth-Anything-V2-Large-hf",
    "base": "/root/model-cache/Depth-Anything-V2-Base-hf",
    "small": "/root/model-cache/Depth-Anything-V2-Small-hf",
}


def _resolve_video(name):
    if os.path.isabs(name) and os.path.exists(name): return name
    p = os.path.join(folder_paths.get_input_directory(), name)
    if os.path.exists(p): return p
    # ComfyUI upload names may carry a [type] suffix
    base = name.rsplit(" [", 1)[0]
    p = os.path.join(folder_paths.get_input_directory(), base)
    if os.path.exists(p): return p
    raise FileNotFoundError(f"video not found: {name}")


class AtelierWhiteModel:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "video": ("STRING", {"default": "", "multiline": False, "tooltip": "file name in the input dir (upload first) or absolute path"}),
            "preset": (list(wm.PRESETS.keys()), {"default": "clay"}),
            "relief": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 20.0, "step": 0.1, "tooltip": "0 = preset default; volume strength"}),
            "photo": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "0 = preset default; facial / fold detail from source luminance"}),
            "ao": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 2.0, "step": 0.01, "tooltip": "0 = preset default; cavity darkening"}),
            "keep_audio": ("BOOLEAN", {"default": True}),
            "depth_model": (["large", "base", "small"], {"default": "large"}),
            "subject_only": ("BOOLEAN", {"default": False, "tooltip": "只把近景主体做成白模，背景保留原画面（给有版权的素材做换脸用）"}),
            "subject_threshold": ("FLOAT", {"default": 0.55, "min": 0.1, "max": 0.95, "step": 0.05, "tooltip": "多近才算主体：越大只留最前面的人"}),
            "filename_prefix": ("STRING", {"default": "whitemodel"}),
        }}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("video_path",)
    FUNCTION = "run"
    CATEGORY = "Atelier"
    OUTPUT_NODE = True

    def run(self, video, preset, relief, photo, ao, keep_audio, depth_model, filename_prefix, subject_only=False, subject_threshold=0.55):
        src = _resolve_video(video)
        out_dir = folder_paths.get_output_directory()
        stamp = time.strftime("%Y%m%d_%H%M%S")
        name = f"{filename_prefix}_{stamp}.mp4"
        out = os.path.join(out_dir, name)
        work = os.path.join(folder_paths.get_temp_directory(), f"wm_{stamp}")
        os.makedirs(work, exist_ok=True)
        local = LOCAL_DEPTH.get(depth_model)
        if local and not os.path.isdir(local): local = None
        pbar = ProgressBar(1000) if ProgressBar else None
        state = {"stage": "depth", "last": 0}

        def progress(stage, done, total):
            # depth = first 60 %, render = last 40 % (roughly proportional to wall time on a 5090)
            frac = (done / max(total, 1)) * (0.6 if stage == "depth" else 0.4) + (0.0 if stage == "depth" else 0.6)
            v = int(frac * 1000)
            if pbar and v > state["last"]:
                pbar.update_absolute(v, 1000); state["last"] = v

        def log(msg):
            print(f"[whitemodel] {msg}", flush=True)

        wm.run_pipeline(src, out, work=work, preset=preset, overrides=dict(relief=relief, photo=photo, ao=ao),
                        keep_audio=keep_audio, model=depth_model, device="cuda", log=log, progress=progress,
                        local_model=local, batch=8, subject_only=subject_only, subject_thr=subject_threshold)
        # drop the disparity cache (3 GB for a 73 s clip) — the mp4 is the deliverable
        try:
            for f in os.listdir(work): os.remove(os.path.join(work, f))
            os.rmdir(work)
        except Exception: pass
        return {"ui": {"videos": [{"filename": name, "subfolder": "", "type": "output"}]}, "result": (out,)}


NODE_CLASS_MAPPINGS = {"AtelierWhiteModel": AtelierWhiteModel}
NODE_DISPLAY_NAME_MAPPINGS = {"AtelierWhiteModel": "Atelier · White Model Video (白模)"}
