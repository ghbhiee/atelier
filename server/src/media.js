// ffmpeg / ffprobe helpers: probing, frame extraction, source-clip prep, contact strips,
// per-clip loudness normalisation + concat, ASS subtitle burn-in (libass), HEIC conversion.
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class Media {
  constructor(config) { this.ffmpeg = config.ffmpeg; this.ffprobe = config.ffprobe; this.fontName = config.fontName; }

  run(bin, args, { timeoutMs = 1_800_000 } = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${bin} timed out`)); }, timeoutMs);
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
      p.on("error", (e) => { clearTimeout(t); reject(e); });
      p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve({ out, err }) : reject(new Error(`${path.basename(bin)} exit ${code}: ${err.trim().split("\n").slice(-4).join(" | ")}`)); });
    });
  }
  ff(args, opts) { return this.run(this.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...args], opts); }

  async probe(file) {
    const { out } = await this.run(this.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 60_000 });
    const j = JSON.parse(out);
    const v = (j.streams || []).find((s) => s.codec_type === "video");
    const a = (j.streams || []).find((s) => s.codec_type === "audio");
    let fps = null;
    if (v?.r_frame_rate) { const [n, d] = v.r_frame_rate.split("/").map(Number); if (d) fps = n / d; }
    return { duration: Number(j.format?.duration || v?.duration || 0), width: v?.width || null, height: v?.height || null, fps, hasAudio: !!a, codec: v?.codec_name || null, frames: v?.nb_frames ? Number(v.nb_frames) : (fps && j.format?.duration ? Math.round(fps * Number(j.format.duration)) : null), isImage: !!v && (v.codec_name === "mjpeg" || v.codec_name === "png" || v.codec_name === "webp" || Number(j.format?.duration || 0) === 0) };
  }

  /** Extract one frame; at = seconds, or last = true. */
  async frame(src, out, { at = 0, last = false } = {}) {
    if (last) await this.ff(["-sseof", "-0.08", "-i", src, "-update", "1", "-frames:v", "1", "-q:v", "2", out]);
    else await this.ff(["-ss", at.toFixed(3), "-i", src, "-frames:v", "1", "-q:v", "2", out]);
    return out;
  }
  async poster(src, out, width = 480) {
    const p = await this.probe(src);
    const at = Math.min(0.5, Math.max(0, p.duration / 2));
    await this.ff(["-ss", at.toFixed(3), "-i", src, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4", out]);
    return out;
  }
  /** First / middle / last frame side by side — the "is anything drifting" strip. */
  async strip(src, out, { width = 320 } = {}) {
    const p = await this.probe(src);
    const fps = p.fps || 24, n = Math.max(1, Math.round(p.duration * fps));
    const idx = [Math.round(n * 0.06), Math.round(n * 0.5), Math.max(0, Math.round(n * 0.94) - 1)];
    const sel = idx.map((i) => `eq(n\\,${i})`).join("+");
    await this.ff(["-i", src, "-vf", `select='${sel}',scale=${width}:-2,tile=3x1`, "-frames:v", "1", "-q:v", "4", out]);
    return out;
  }

  /** Tile still images into a grid (contact sheet). */
  async tile(files, out, { cols = 3, width = 400 } = {}) {
    const rows = Math.ceil(files.length / cols);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "h3s-tile-"));
    try {
      for (const [i, f] of files.entries()) await fsp.copyFile(f, path.join(dir, `img${String(i).padStart(3, "0")}.jpg`));
      await this.ff(["-framerate", "1", "-i", path.join(dir, "img%03d.jpg"), "-vf", `scale=${width}:-2:flags=lanczos,pad=${width}:ih:0:0:black,tile=${cols}x${rows}:padding=4:color=black`, "-frames:v", "1", "-q:v", "4", out]);
    } finally { await fsp.rm(dir, { recursive: true, force: true }); }
    return out;
  }
  /** Waveform thumbnail for audio assets. */
  async waveform(src, out) { await this.ff(["-i", src, "-filter_complex", "showwavespic=s=480x160:colors=#f59e0b", "-frames:v", "1", out]); return out; }
  /** Silence detection → [{start,end}] (seconds) using silencedetect. */
  async silences(src, { noise = -35, minSilence = 0.3 } = {}) {
    const { err } = await this.run(this.ffmpeg, ["-hide_banner", "-loglevel", "info", "-i", src, "-af", `silencedetect=noise=${noise}dB:d=${minSilence}`, "-f", "null", "-"], { timeoutMs: 600_000 }).catch((e) => ({ err: e.message }));
    const out = []; let cur = null;
    for (const m of String(err).matchAll(/silence_(start|end):\s*([0-9.]+)/g)) { if (m[1] === "start") cur = Number(m[2]); else if (cur != null) { out.push({ start: cur, end: Number(m[2]) }); cur = null; } }
    return out;
  }
  /** Cut [start,end) of an audio file to wav, padded with silence to `padTo` seconds when given. */
  async audioSegment(src, out, { start, end, padTo = null }) {
    const af = ["aresample=48000"]; if (padTo) af.push(`apad=whole_dur=${padTo.toFixed(4)}`);
    await this.ff(["-ss", start.toFixed(4), "-to", end.toFixed(4), "-i", src, "-vn", "-af", af.join(","), ...(padTo ? ["-t", padTo.toFixed(4)] : []), "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", out]);
    return out;
  }
  /** Shot detection with ffmpeg's scene score. Returns [{index,start,end,duration}] covering the whole file;
   *  cuts closer than minLen seconds are merged into the previous shot. */
  async cuts(src, { threshold = 0.3, minLen = 0.8 } = {}) {
    const p = await this.probe(src);
    const { err } = await this.run(this.ffmpeg, ["-hide_banner", "-loglevel", "info", "-i", src, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"], { timeoutMs: 1_800_000 }).catch((e) => ({ err: e.message }));
    const times = [...String(err).matchAll(/pts_time:\s*([0-9.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.05 && t < p.duration - 0.05).sort((a, b) => a - b);
    const bounds = [0];
    for (const t of times) if (t - bounds.at(-1) >= minLen) bounds.push(+t.toFixed(3));
    if (p.duration - bounds.at(-1) < minLen && bounds.length > 1) bounds.pop();
    bounds.push(+p.duration.toFixed(3));
    const shots = [];
    for (let i = 0; i < bounds.length - 1; i++) shots.push({ index: i, start: bounds[i], end: bounds[i + 1], duration: +(bounds[i + 1] - bounds[i]).toFixed(3) });
    return { shots, duration: p.duration, width: p.width, height: p.height, fps: p.fps, hasAudio: p.hasAudio };
  }
  /** Cut [start,end) of a video re-encoded to a uniform format (used for untouched shots when assembling an edit). */
  async segment(src, out, { start, end, width, height, fps = 24, crop = null }) {
    const vf = [];
    if (crop) vf.push(`crop=${Math.round(crop.w)}:${Math.round(crop.h)}:${Math.round(crop.x)}:${Math.round(crop.y)}`);
    vf.push(`fps=${fps}`, `scale=${width}:${height}:flags=lanczos`, "format=yuv420p");
    await this.ff(["-ss", start.toFixed(3), "-to", end.toFixed(3), "-i", src, "-vf", vf.join(","), "-af", "aresample=48000", "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", out]);
    return out;
  }
  /** Take [fromFrame, fromFrame+count) of a 24fps clip, keeping its own audio, re-encoded uniformly. */
  async frames(src, out, { fromFrame, count, width, height }) {
    const start = fromFrame / 24, dur = count / 24;
    await this.ff(["-ss", start.toFixed(4), "-i", src, "-t", dur.toFixed(4), "-vf", `fps=24,scale=${width}:${height}:flags=lanczos,format=yuv420p`, "-af", "aresample=48000", "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", out]);
    return out;
  }
  /** Replace the audio of `video` with the audio of `audioSrc` (trimmed / padded to the video length). */
  async replaceAudio(video, audioSrc, out, { offset = 0 } = {}) {
    await this.ff(["-i", video, "-ss", offset.toFixed(3), "-i", audioSrc, "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-shortest", "-movflags", "+faststart", out]);
    return out;
  }
  /** Convert / crop / resize a still image to JPEG. crop = {x,y,w,h} in source pixels; shortSide caps the shorter edge. */
  async image(src, out, { crop = null, shortSide = null, exact = null } = {}) {
    let input = src;
    const ext = path.extname(src).toLowerCase();
    if (ext === ".heic" || ext === ".heif") input = await this.heicToJpg(src);
    const vf = [];
    if (crop) vf.push(`crop=${Math.round(crop.w)}:${Math.round(crop.h)}:${Math.round(crop.x)}:${Math.round(crop.y)}`);
    if (exact) vf.push(`scale=${exact.w}:${exact.h}:flags=lanczos`);
    else if (shortSide) vf.push(`scale='if(lt(iw,ih),min(iw,${shortSide}),-2)':'if(lt(iw,ih),-2,min(ih,${shortSide}))':flags=lanczos`);
    vf.push("format=yuvj420p");
    await this.ff(["-i", input, "-vf", vf.join(","), "-frames:v", "1", "-q:v", "2", out]);
    return out;
  }
  async heicToJpg(src) {
    const out = path.join(os.tmpdir(), `h3s_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    try { await this.run("heif-convert", [src, out], { timeoutMs: 120_000 }); return out; } catch (e1) {
      if (os.platform() === "darwin") { await this.run("sips", ["-s", "format", "jpeg", src, "--out", out], { timeoutMs: 120_000 }); return out; }
      throw new Error("无法转换 HEIC：服务器缺 heif-convert（" + e1.message + "）");
    }
  }

  /** Cut a reference segment H3 can eat: crop → 24fps → scale → frames aligned to 17k+5, audio kept.
   *  Optional headHold/tailHold freeze the first/last frame (face-swap guidance) inside ONE tpad. */
  async prep(src, out, { start = 0, end = null, seconds = 5, crop = null, size = null, headHold = 0, tailHold = 0 } = {}) {
    const dur = end != null ? end - start : seconds;
    if (dur <= 0.5) throw new Error("片段太短");
    let frames = alignLen(Math.round(dur * 24));
    if (end != null && frames > Math.round(dur * 24) + headHold + tailHold) frames -= 17;
    frames = Math.max(22, frames);
    const vf = [];
    if (crop) vf.push(`crop=${Math.round(crop.w)}:${Math.round(crop.h)}:${Math.round(crop.x)}:${Math.round(crop.y)}`);
    vf.push("fps=24");
    if (size) { if (size.w % 32 || size.h % 32) throw new Error("尺寸必须是 32 的倍数"); vf.push(`scale=${size.w}:${size.h}:flags=lanczos`); }
    if (headHold || tailHold) vf.push(`tpad=start_mode=clone:start=${headHold}:stop_mode=clone:stop=${tailHold}`);
    vf.push("format=yuv420p");
    const tmp = out + ".tmp.mp4";
    await this.ff(["-ss", start.toFixed(3), "-i", src, "-vf", vf.join(","), "-frames:v", String(frames), "-af", "aresample=48000", "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp]);
    // trim audio to the exact frame count
    await this.ff(["-i", tmp, "-t", (frames / 24).toFixed(4), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", out]);
    await fsp.rm(tmp, { force: true });
    return { frames, duration: frames / 24 };
  }

  /** Normalise + scale one clip for assembly. gain in dB added after loudnorm. */
  async normalize(src, out, { width, height, lufs = -16, gain = 0 }) {
    const af = `loudnorm=I=${lufs}:TP=-1.5:LRA=11` + (gain ? `,volume=${gain}dB` : "");
    await this.ff(["-i", src, "-vf", `scale=${width}:${height}:flags=lanczos,fps=24,format=yuv420p`, "-af", af, "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", out]);
    return out;
  }
  async black(out, { width, height, seconds }) {
    await this.ff(["-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=24`, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", out]);
    return out;
  }
  async concat(parts, out) {
    const list = out + ".txt";
    await fsp.writeFile(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'\n`).join(""));
    await this.ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
    await fsp.rm(list, { force: true });
    return out;
  }
  /** Burn an .ass file with libass. The ass path is copied to a safe temp name (filter syntax hates ':' and spaces). */
  async burn(src, assFile, out) {
    const safe = path.join(os.tmpdir(), `h3s_${process.pid}_${Date.now()}.ass`);
    await fsp.copyFile(assFile, safe);
    try { await this.ff(["-i", src, "-vf", `ass=${safe.replace(/\\/g, "/")}`, "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", out]); }
    finally { await fsp.rm(safe, { force: true }); }
    return out;
  }
  /** Sanity check used at startup / in diagnostics. */
  async capabilities() {
    try {
      const { out } = await this.run(this.ffmpeg, ["-hide_banner", "-filters"], { timeoutMs: 30_000 });
      const has = (f) => new RegExp(`\\s${f}\\s`).test(out);
      const { out: v } = await this.run(this.ffmpeg, ["-version"], { timeoutMs: 30_000 });
      return { ok: true, version: v.split("\n")[0], ass: has("ass"), subtitles: has("subtitles"), drawtext: has("drawtext"), loudnorm: has("loudnorm") };
    } catch (e) { return { ok: false, error: e.message }; }
  }
}

export function alignLen(frames) { frames = Math.max(22, Math.round(frames)); return 5 + Math.max(1, Math.round((frames - 5) / 17)) * 17; }

/** cues: [{start, end, text}] seconds. style: {fontName, fontSize, color, outlineColor, outline, marginV, align: 'bottom'|'top', bold} */
export function buildAss(cues, { playResX, playResY, fontName = "Noto Sans CJK SC", fontSize = 46, color = "#FFFFFF", outlineColor = "#141414", outline = 2.6, shadow = 1.2, marginV = 44, align = "bottom", bold = false, box = false } = {}) {
  const hex = (c) => { const m = String(c).replace("#", "").padStart(6, "0"); return `&H00${m.slice(4, 6)}${m.slice(2, 4)}${m.slice(0, 2)}`.toUpperCase(); }; // ASS is &HAABBGGRR
  const ats = (t) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`; };
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\r?\n/g, "\\N");
  const alignment = align === "top" ? 8 : 2;
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${hex(color)},&H000000FF,${hex(outlineColor)},&H64000000,${bold ? -1 : 0},0,0,0,100,100,1.2,0,${box ? 3 : 1},${outline},${shadow},${alignment},60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = cues.filter((c) => c.text && c.end > c.start).map((c) => `Dialogue: 0,${ats(c.start)},${ats(c.end)},Default,,0,0,0,,${esc(c.text)}`);
  return head + lines.join("\n") + "\n";
}
export function buildSrt(cues) {
  const ts = (t) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0").replace(".", ",")}`; };
  return cues.filter((c) => c.text).map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join("\n");
}
