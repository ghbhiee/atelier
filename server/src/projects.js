// Projects: assets (uploads, extracted frames, crops, prepped clips), clips with shared prompt
// sections (the scene.py model), takes/picks, and assembly into a final render with subtitles.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { buildAss, buildSrt } from "./media.js";
import { WORKFLOWS, alignLength } from "./workflows.js";

const nowS = () => Math.floor(Date.now() / 1000);
const rid = (n = 6) => crypto.randomBytes(n).toString("hex");
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp", ".tif", ".tiff"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".wma", ".aiff", ".aif"]);

export const DEFAULT_SETTINGS = { workflow: "native_ref2va", width: 832, height: 448, seconds: 5, steps: 8, refSize: "max" };
export const DEFAULT_ASSEMBLE = { blackTail: 1, lufs: -16, upscale: 1, subtitles: true, style: { fontSize: 46, color: "#FFFFFF", outlineColor: "#141414", outline: 2.6, marginV: 44, align: "bottom", bold: false, box: false } };

export class Projects {
  constructor(config, media, events) {
    this.config = config; this.media = media; this.events = events;
    this.root = path.join(config.dataDir, "projects");
    this.cache = new Map();
    this.writes = new Map();
  }
  dir(id) { return path.join(this.root, id); }
  file(id) { return path.join(this.dir(id), "project.json"); }
  assetsDir(id) { return path.join(this.dir(id), "assets"); }
  rendersDir(id) { return path.join(this.dir(id), "renders"); }

  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    for (const d of await fsp.readdir(this.root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try { this.cache.set(d.name, JSON.parse(await fsp.readFile(this.file(d.name), "utf8"))); } catch {}
    }
    if (!this.cache.has("default")) await this.create({ id: "default", name: "默认工作区", kind: "free" });
  }
  list() { return [...this.cache.values()].map(summary).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); }
  get(id) { const p = this.cache.get(String(id)); if (!p) throw Object.assign(new Error("项目不存在"), { status: 404 }); return p; }
  async save(p) {
    p.updatedAt = nowS();
    this.cache.set(p.id, p);
    const prev = this.writes.get(p.id) || Promise.resolve();
    const task = prev.then(async () => {
      await fsp.mkdir(this.dir(p.id), { recursive: true });
      const tmp = this.file(p.id) + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(p, null, 1));
      await fsp.rename(tmp, this.file(p.id));
    });
    this.writes.set(p.id, task.catch(() => {}));
    await task;
    this.events.emitAll("project", { id: p.id, updatedAt: p.updatedAt });
    return p;
  }
  async create({ id, name, kind = "scene", settings = {} }) {
    id = id || `p_${rid(4)}`;
    if (this.cache.has(id)) throw new Error("项目已存在");
    const p = { id, name: String(name || "未命名项目").slice(0, 80), kind, createdAt: nowS(), updatedAt: nowS(), settings: { ...DEFAULT_SETTINGS, ...settings }, refs: [], shared: { subjects: "", retention: "", style: "", soundscape: "", music: "N/A" }, clips: [], assets: [], renders: [], assemble: structuredClone(DEFAULT_ASSEMBLE), notes: "" };
    await fsp.mkdir(this.assetsDir(id), { recursive: true });
    await fsp.mkdir(this.rendersDir(id), { recursive: true });
    return this.save(p);
  }
  async update(id, patch) {
    const p = this.get(id);
    for (const k of ["name", "kind", "notes"]) if (patch[k] !== undefined) p[k] = String(patch[k]).slice(0, k === "notes" ? 20000 : 80);
    if (patch.settings) Object.assign(p.settings, sanitizeSettings(patch.settings));
    if (patch.shared) for (const k of ["subjects", "retention", "style", "soundscape", "music"]) if (patch.shared[k] !== undefined) p.shared[k] = String(patch.shared[k]);
    if (Array.isArray(patch.refs)) p.refs = patch.refs.filter((a) => p.assets.some((x) => x.id === a)).slice(0, 9);
    if (patch.assemble) { const a = patch.assemble; if (a.style) Object.assign(p.assemble.style, a.style); for (const k of ["blackTail", "lufs", "upscale", "subtitles"]) if (a[k] !== undefined) p.assemble[k] = a[k]; }
    return this.save(p);
  }
  async remove(id) {
    if (id === "default") throw new Error("默认工作区不能删除");
    this.get(id);
    this.cache.delete(id);
    await fsp.rm(this.dir(id), { recursive: true, force: true });
    this.events.emitAll("project", { id, deleted: true });
  }

  // ---- assets ------------------------------------------------------------------------------
  assetPath(pid, aid) {
    const p = this.get(pid);
    const a = p.assets.find((x) => x.id === aid);
    if (!a) throw Object.assign(new Error("素材不存在"), { status: 404 });
    const dir = this.assetsDir(pid);
    const file = a.file ? path.join(dir, a.file) : null;
    return { asset: a, file, thumb: a.thumb ? path.join(dir, a.thumb) : null, localReady: !!file && fs.existsSync(file) };
  }
  /** Register a file (already on disk somewhere) as an asset: converts HEIC, probes, makes a thumbnail. */
  async addAsset(pid, srcPath, { name, kind = null, source = { type: "upload" }, move = true } = {}) {
    const p = this.get(pid);
    const id = `a_${rid(5)}`;
    let ext = path.extname(name || srcPath).toLowerCase();
    if (!kind) kind = VIDEO_EXT.has(ext) ? "video" : AUDIO_EXT.has(ext) ? "audio" : "image";
    if (kind === "image" && !IMAGE_EXT.has(ext)) throw new Error(`不支持的图片格式 ${ext || "(无扩展名)"}`);
    if (kind === "video" && !VIDEO_EXT.has(ext)) throw new Error(`不支持的视频格式 ${ext || "(无扩展名)"}`);
    if (kind === "audio" && !AUDIO_EXT.has(ext)) throw new Error(`不支持的音频格式 ${ext || "(无扩展名)"}`);
    let file, dest;
    if (kind === "audio") {
      // Everything becomes 48 kHz PCM wav: ComfyUI's LoadAudio and ffmpeg both like it, and cutting is exact.
      file = `${id}.wav`; dest = path.join(this.assetsDir(pid), file);
      await this.media.ff(["-i", srcPath, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", dest]);
      if (move) await fsp.rm(srcPath, { force: true });
    } else if (kind === "image") {
      // Everything becomes JPEG so ComfyUI's LoadImage and the browser both agree on it.
      file = `${id}.jpg`; dest = path.join(this.assetsDir(pid), file);
      await this.media.image(srcPath, dest, {});
      if (move) await fsp.rm(srcPath, { force: true });
    } else {
      file = `${id}${ext === ".mp4" ? ".mp4" : ".mp4"}`; dest = path.join(this.assetsDir(pid), file);
      if (ext === ".mp4") { if (move) await fsp.rename(srcPath, dest).catch(async () => { await fsp.copyFile(srcPath, dest); await fsp.rm(srcPath, { force: true }); }); else await fsp.copyFile(srcPath, dest); }
      else await this.media.ff(["-i", srcPath, "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", dest]).then(() => move && fsp.rm(srcPath, { force: true }));
    }
    const info = await this.media.probe(dest).catch(() => ({}));
    const thumb = `${id}_t.jpg`;
    if (kind === "video") await this.media.poster(dest, path.join(this.assetsDir(pid), thumb), 480).catch(() => null);
    else if (kind === "audio") await this.media.waveform(dest, path.join(this.assetsDir(pid), thumb)).catch(() => null);
    else await this.media.image(dest, path.join(this.assetsDir(pid), thumb), { shortSide: 360 }).catch(() => null);
    const stat = await fsp.stat(dest);
    const asset = { id, name: String(name || path.basename(srcPath)).slice(0, 120), kind, file, thumb, width: info.width || null, height: info.height || null, duration: kind === "video" || kind === "audio" ? +(info.duration || 0).toFixed(3) : null, frames: kind === "video" ? info.frames : null, fps: info.fps || null, hasAudio: !!info.hasAudio, size: stat.size, createdAt: nowS(), source, local: true, gpu: false };
    p.assets.push(asset);
    await this.save(p);
    return asset;
  }
  // ---- assets that live on the GPU (browser uploaded straight there) ------------------------
  /** Reservations whose bytes never arrived (tab closed, transfer died) would sit in the list as 0-byte
   *  placeholders and show up in pickers. Drop anything still pending after a while. */
  async sweepPending({ olderThanS = 1800 } = {}) {
    let n = 0;
    for (const sum of this.list()) {
      const p = this.get(sum.id);
      const dead = (p.assets || []).filter((a) => a.pending && nowS() - (a.createdAt || 0) >= olderThanS);
      for (const a of dead) { p.assets = p.assets.filter((x) => x.id !== a.id); n++; }
      if (dead.length) await this.save(p);
    }
    if (n) console.log(`[projects] 清掉 ${n} 个没传完的占位素材`);
    return n;
  }

  /** Allocate the id before the browser starts a direct upload, so both sides agree on it. */
  async reserveAsset(pid, { name, kind = null }) {
    const p = this.get(pid);
    const id = `a_${rid(5)}`;
    const ext = path.extname(name || "").toLowerCase();
    kind = kind || (VIDEO_EXT.has(ext) ? "video" : AUDIO_EXT.has(ext) ? "audio" : "image");
    const asset = { id, name: String(name || "素材").slice(0, 120), kind, file: null, thumb: null, size: 0, createdAt: nowS(),
                    source: { type: "upload", via: "direct" }, pending: true, local: false, gpu: false };
    p.assets.push(asset);
    await this.save(p);
    return asset;
  }

  /** The GPU has the bytes: copy its metadata onto our record. The file itself follows in the background. */
  async attachRemote(pid, aid, m) {
    const p = this.get(pid);
    const a = p.assets.find((x) => x.id === aid);
    if (!a) throw Object.assign(new Error("素材不存在"), { status: 404 });
    Object.assign(a, {
      name: m.name || a.name, kind: m.kind || a.kind, file: m.file || a.file, thumb: m.thumb || null,
      width: m.width ?? null, height: m.height ?? null, duration: m.duration ?? null, frames: m.frames ?? null,
      fps: m.fps ?? null, hasAudio: !!m.hasAudio, size: m.size || 0, sha256: m.sha256 || null,
      gpu: true, gpuName: m.comfyName || null, pending: false,
    });
    await this.save(p);
    return a;
  }

  /** Path to the bytes on 13, pulling the GPU copy down first when the browser uploaded it there. */
  async localPath(pid, aid) {
    const r = this.assetPath(pid, aid);
    if (r.localReady) return r;
    if (r.asset.gpu && this.direct?.enabled) { await this.ensureLocal(pid, aid, this.direct); return this.assetPath(pid, aid); }
    if (!r.localReady) throw Object.assign(new Error(`素材 ${r.asset.name} 还没同步到 13，GPU 关机时用不了`), { status: 409 });
    return r;
  }

  /** Pull the GPU copy down to 13 (the fast direction) so the asset survives the box being off. */
  async ensureLocal(pid, aid, direct) {
    const p = this.get(pid);
    const a = p.assets.find((x) => x.id === aid);
    if (!a) throw Object.assign(new Error("素材不存在"), { status: 404 });
    if (a.local && a.file && fs.existsSync(path.join(this.assetsDir(pid), a.file))) return a;
    if (!a.gpu) throw new Error("素材既不在 13 也不在 GPU 上");
    const dir = this.assetsDir(pid);
    await fsp.mkdir(dir, { recursive: true });
    if (a.thumb) await direct.download(aid, path.join(dir, a.thumb), { thumb: true }).catch(() => null);
    await direct.download(aid, path.join(dir, a.file));
    a.local = true;
    await this.save(p);
    return a;
  }

  async removeAsset(pid, aid) {
    const p = this.get(pid);
    const { file, thumb } = this.assetPath(pid, aid);
    p.assets = p.assets.filter((a) => a.id !== aid);
    p.refs = p.refs.filter((r) => r !== aid);
    for (const c of p.clips) { if (c.refs) c.refs = c.refs.filter((r) => r !== aid); if (c.videos) c.videos = c.videos.filter((r) => r !== aid); }
    if (file) await fsp.rm(file, { force: true }); if (thumb) await fsp.rm(thumb, { force: true });
    if (this.direct?.enabled) await this.direct.remove(aid).catch(() => {});   // keep the box in step
    return this.save(p);
  }
  async renameAsset(pid, aid, name) { const p = this.get(pid); const a = p.assets.find((x) => x.id === aid); if (!a) throw new Error("素材不存在"); a.name = String(name).slice(0, 120); return this.save(p); }
  /** Extract a frame from a video (asset or arbitrary file) into a new image asset. */
  async frameAsset(pid, srcFile, { at = 0, last = false, name, source }) {
    const tmp = path.join(this.assetsDir(pid), `tmp_${rid(4)}.jpg`);
    await this.media.frame(srcFile, tmp, { at, last });
    return this.addAsset(pid, tmp, { name: name || `frame_${last ? "last" : at.toFixed(2) + "s"}.jpg`, kind: "image", source: source || { type: "frame", at, last } });
  }
  async cropAsset(pid, aid, { crop, shortSide = 1024, exact = null, name }) {
    const { asset, file } = this.assetPath(pid, aid);
    if (asset.kind !== "image") throw new Error("只能裁剪图片");
    const tmp = path.join(this.assetsDir(pid), `tmp_${rid(4)}.jpg`);
    await this.media.image(file, tmp, { crop, shortSide: exact ? null : shortSide, exact });
    return this.addAsset(pid, tmp, { name: name || `${asset.name.replace(/\.[^.]+$/, "")}_crop.jpg`, kind: "image", source: { type: "crop", from: aid, crop, shortSide, exact } });
  }
  async prepAsset(pid, aid, opts) {
    const { asset, file } = this.assetPath(pid, aid);
    if (asset.kind !== "video") throw new Error("只能处理视频");
    const tmp = path.join(this.assetsDir(pid), `tmp_${rid(4)}.mp4`);
    const r = await this.media.prep(file, tmp, opts);
    const a = await this.addAsset(pid, tmp, { name: opts.name || `${asset.name.replace(/\.[^.]+$/, "")}_${(opts.start || 0).toFixed(1)}s.mp4`, kind: "video", source: { type: "prep", from: aid, ...opts } });
    a.frames = r.frames; await this.save(this.get(pid));
    return a;
  }

  // ---- clips ---------------------------------------------------------------------------------
  clip(pid, cid) { const p = this.get(pid); const c = p.clips.find((x) => x.id === cid); if (!c) throw Object.assign(new Error("片段不存在"), { status: 404 }); return { p, c }; }
  async addClip(pid, data = {}) {
    const p = this.get(pid);
    const n = p.clips.length + 1;
    const c = { id: `c${String(n).padStart(2, "0")}_${rid(2)}`, title: data.title || `第 ${n} 段`, seed: Number.isInteger(data.seed) ? data.seed : 1000 * n + 1, summary: data.summary || "", shot: data.shot || "", retention: data.retention || "", subjects: data.subjects || "", style: data.style || "", soundscape: data.soundscape || "", music: data.music || "", prompt: data.prompt || "", refs: data.refs || null, videos: data.videos || [], videoAudio: !!data.videoAudio, lastFrame: data.lastFrame || null, seconds: data.seconds || null, width: data.width || null, height: data.height || null, steps: data.steps || null, workflow: data.workflow || null, gain: 0, subs: [], takes: [], pick: null, notes: "" };
    if (Number.isInteger(data.at) && data.at >= 0 && data.at <= p.clips.length) p.clips.splice(data.at, 0, c); else p.clips.push(c);
    await this.save(p);
    return c;
  }
  async updateClip(pid, cid, patch) {
    const { p, c } = this.clip(pid, cid);
    for (const k of ["title", "summary", "shot", "retention", "subjects", "style", "soundscape", "music", "prompt", "notes"]) if (patch[k] !== undefined) c[k] = String(patch[k] ?? "");
    for (const k of ["seed", "seconds", "width", "height", "steps"]) if (patch[k] !== undefined) c[k] = patch[k] === null || patch[k] === "" ? null : Number(patch[k]);
    if (patch.workflow !== undefined) c.workflow = patch.workflow && WORKFLOWS[patch.workflow] ? patch.workflow : null;
    if (patch.refs !== undefined) c.refs = Array.isArray(patch.refs) && patch.refs.length ? patch.refs.slice(0, 9) : null;
    if (patch.videos !== undefined) c.videos = Array.isArray(patch.videos) ? patch.videos.slice(0, 3) : [];
    if (patch.videoAudio !== undefined) c.videoAudio = !!patch.videoAudio;
    if (patch.lastFrame !== undefined) c.lastFrame = patch.lastFrame || null;
    if (patch.gain !== undefined) c.gain = Number(patch.gain) || 0;
    if (patch.pick !== undefined) c.pick = patch.pick || null;
    if (Array.isArray(patch.subs)) c.subs = patch.subs.map((s) => ({ text: String(s.text || "").slice(0, 300), from: s.from === "" || s.from == null ? null : Number(s.from), to: s.to === "" || s.to == null ? null : Number(s.to) })).filter((s) => s.text);
    await this.save(p);
    return c;
  }
  async removeClip(pid, cid) { const { p } = this.clip(pid, cid); p.clips = p.clips.filter((x) => x.id !== cid); return this.save(p); }
  async reorderClips(pid, ids) { const p = this.get(pid); const map = new Map(p.clips.map((c) => [c.id, c])); const next = ids.map((i) => map.get(i)).filter(Boolean); for (const c of p.clips) if (!next.includes(c)) next.push(c); p.clips = next; return this.save(p); }
  /** Continuation: make the next clip start where this clip's picked take ends.
   *  mode "frame": last frame → first frame of a new native_i2v clip (cheap, keeps composition/colours).
   *  mode "video": the take itself becomes <Video 1> of a new native_ref2va clip with a [video continuation] summary
   *  (keeps identity + motion; faces still come from the shared pictures). */
  async continueClip(pid, cid, { mode = "frame", jobFile } = {}) {
    const { p, c } = this.clip(pid, cid);
    const jobId = c.pick || c.takes.at(-1);
    const file = jobId && jobFile(jobId);
    if (!file || !fs.existsSync(file)) throw new Error("这段还没有可用的 take，先生成并选用一条");
    const at = p.clips.findIndex((x) => x.id === c.id) + 1;
    const title = `${c.title} · 续`;
    const seed = Number.isInteger(c.seed) ? c.seed + 7 : null;
    if (mode === "frame") {
      const asset = await this.frameAsset(pid, file, { last: true, name: `${c.title}_末帧.jpg`, source: { type: "frame", jobId, last: true, clipId: c.id } });
      return this.addClip(pid, { at, title, seed, workflow: "native_i2v", refs: [asset.id], summary: "",
        shot: `[Shot 1] The shot starts exactly from <Picture 1> and continues the same moment: same framing, same lens, same lighting, everyone in the same positions. <describe what happens next in this shot>. The camera holds a static shot.`,
        notes: `续接自「${c.title}」的末帧（i2v）。首帧图 = <Picture 1>。` });
    }
    const asset = await this.addAsset(pid, file, { name: `${c.title}_take.mp4`, kind: "video", source: { type: "output", jobId, clipId: c.id }, move: false });
    const sh = p.shared;
    const subjects = (sh.subjects || "").trim() + `
<Video 1> is the previous shot of this same scene, ending in the exact state the target video must start from: the same room, the same people in their final positions and poses, the same framing and lighting.`;
    const retention = (sh.retention || "").trim() + `
<Video 1> (continuation source): partially_preserved - the final state of <Video 1> (positions, poses, wardrobe, framing, lighting) is continued seamlessly; its earlier frames are not repeated.`;
    return this.addClip(pid, { at, title, seed, workflow: "native_ref2va", videos: [asset.id], videoAudio: false,
      summary: `[video continuation] The target video continues directly from the end of <Video 1> inside <Subject ${Math.max(1, (sh.subjects.match(/<Subject \d+>/g) || []).length)}>: <one sentence of what happens next>.`,
      subjects: subjects.trim(), retention: retention.trim(),
      shot: `[Shot 1] The same static shot as the end of <Video 1>, picking up the action without a cut. <describe what happens next>. The camera holds a static shot.`,
      notes: `续接自「${c.title}」的成片（video continuation）。<Video 1> = 上一段；人脸仍来自共享参考图。勾选「连音轨」则原声延续（audio reference）。` });
  }

  async recordTake(pid, cid, jobId) { const { p, c } = this.clip(pid, cid); if (!c.takes.includes(jobId)) c.takes.push(jobId); if (!c.pick) c.pick = jobId; return this.save(p); }

  /** Effective generation parameters for a clip (clip overrides → project settings). */
  clipParams(p, c) {
    const s = p.settings;
    const workflow = c.workflow || s.workflow;
    const meta = WORKFLOWS[workflow];
    return { workflow, width: c.width || s.width, height: c.height || s.height, seconds: c.seconds || s.seconds, steps: c.steps || (meta?.steps === 4 && s.steps === 8 ? 4 : s.steps), refSize: s.refSize, lora: s.lora || null, images: meta.refs ? (c.refs && c.refs.length ? c.refs : p.refs) : (c.refs || []), lastFrame: c.lastFrame, videos: meta.refs ? c.videos || [] : [], videoAudio: !!c.videoAudio };
  }
  /** Compose the final prompt for a clip: raw override, or shared sections + clip sections. */
  composePrompt(p, c) {
    if (c.prompt && c.prompt.trim()) return c.prompt.trim();
    const sh = p.shared;
    const { workflow } = this.clipParams(p, c);
    const pick = (k, dflt = "") => (c[k] && c[k].trim()) || (sh[k] && sh[k].trim()) || dflt;
    const parts = [];
    if (WORKFLOWS[workflow]?.refs) {
      const subjects = pick("subjects"); if (subjects) parts.push("subject_definitions:\n" + subjects);
      parts.push("summary:\n" + (c.summary || "[reference generation] " + (c.title || "")).trim());
      const ret = pick("retention"); if (ret) parts.push("retention_analysis:\n" + ret);
      const style = pick("style");
      parts.push("detailed_description:\n" + (style ? style + "\n" : "") + (c.shot || "").trim());
    } else {
      const style = pick("style");
      const head = workflow === "native_i2v" ? "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n" : "";
      parts.push(head + "integrated_multimodal_description:\n" + (style ? style + "\n" : "") + (c.shot || "").trim());
    }
    parts.push("overall_soundscape:\n" + pick("soundscape", "Quiet room tone."));
    parts.push("non_diegetic_music:\n" + pick("music", "N/A"));
    return parts.join("\n\n");
  }

  // ---- assembly ------------------------------------------------------------------------------
  /** clips → per-clip loudnorm → concat → black tail → subtitles. jobFile(jobId) resolves a job's output path. */
  async assemble(pid, { clipIds = null, subtitles = null, style = null, name = null, jobFile, jobInfo, onProgress = () => {} } = {}) {
    const p = this.get(pid);
    const asm = p.assemble;
    const st = { ...asm.style, ...(style || {}) };
    const withSubs = subtitles == null ? asm.subtitles !== false : !!subtitles;
    const clips = p.clips.filter((c) => !clipIds || clipIds.includes(c.id));
    const chosen = [];
    for (const c of clips) {
      const jobId = c.pick || c.takes.at(-1);
      if (!jobId) continue;
      const file = jobFile(jobId);
      if (!file || !fs.existsSync(file)) continue;
      chosen.push({ clip: c, jobId, file });
    }
    if (!chosen.length) throw new Error("没有可拼接的片段：先为每段生成并选用一条 take");
    const up = Math.max(1, Math.min(2, Number(asm.upscale) || 1));
    const W = p.settings.width * up, H = p.settings.height * up;
    const renderId = `r_${rid(4)}`;
    const tmp = path.join(this.rendersDir(pid), `_${renderId}`);
    await fsp.mkdir(tmp, { recursive: true });
    const parts = []; const cues = []; let offset = 0;
    try {
      for (const [i, x] of chosen.entries()) {
        onProgress(`响度归一 ${i + 1}/${chosen.length}：${x.clip.title}`);
        const dst = path.join(tmp, `${i}.mp4`);
        await this.media.normalize(x.file, dst, { width: W, height: H, lufs: asm.lufs ?? -16, gain: x.clip.gain || 0 });
        const d = (await this.media.probe(dst)).duration;
        for (const s of x.clip.subs || []) {
          const from = s.from == null ? 0.3 : Math.max(0, s.from), to = s.to == null ? Math.max(from + 0.5, d - 0.2) : Math.min(d, s.to);
          cues.push({ start: +(offset + from).toFixed(3), end: +(offset + to).toFixed(3), text: s.text, clipId: x.clip.id });
        }
        parts.push(dst); offset += d;
      }
      if (asm.blackTail > 0) { const blk = path.join(tmp, "black.mp4"); await this.media.black(blk, { width: W, height: H, seconds: asm.blackTail }); parts.push(blk); }
      onProgress("拼接…");
      const plain = path.join(this.rendersDir(pid), `${renderId}_nosub.mp4`);
      await this.media.concat(parts, plain);
      let final = plain;
      const srt = buildSrt(cues);
      await fsp.writeFile(path.join(this.rendersDir(pid), `${renderId}.srt`), srt);
      if (!this.caps) this.caps = await this.media.capabilities();
      const canBurn = !!(this.caps.ok && this.caps.ass);
      let subtitleNote = null;
      if (withSubs && cues.length && !canBurn) subtitleNote = "这台服务器的 ffmpeg 没有 libass，字幕没有烧录（已生成 .srt）";
      if (withSubs && cues.length && canBurn) {
        onProgress("烧录字幕…");
        const ass = buildAss(cues, { playResX: W, playResY: H, fontName: this.config.fontName, ...st, fontSize: Math.round((st.fontSize || 46) * (H / 896) * 1.0) });
        const assFile = path.join(tmp, "subs.ass");
        await fsp.writeFile(assFile, ass);
        final = path.join(this.rendersDir(pid), `${renderId}.mp4`);
        await this.media.burn(plain, assFile, final);
      } else { final = path.join(this.rendersDir(pid), `${renderId}.mp4`); await fsp.rename(plain, final); }
      const poster = `${renderId}_poster.jpg`;
      await this.media.poster(final, path.join(this.rendersDir(pid), poster), 640).catch(() => null);
      const info = await this.media.probe(final);
      const render = { id: renderId, name: name || `${p.name} ${new Date().toLocaleString("zh-CN", { hour12: false })}`, file: `${renderId}.mp4`, poster, srt: `${renderId}.srt`, nosub: fs.existsSync(plain) ? `${renderId}_nosub.mp4` : null, createdAt: nowS(), duration: +info.duration.toFixed(2), width: W, height: H, clips: chosen.map((x) => ({ clipId: x.clip.id, jobId: x.jobId, title: x.clip.title })), cues, subtitles: withSubs && cues.length > 0 && canBurn, subtitleNote, style: st, share: null };
      p.renders.unshift(render);
      await this.save(p);
      return render;
    } finally { await fsp.rm(tmp, { recursive: true, force: true }); }
  }
  renderPath(pid, rid_, which = "file") {
    const p = this.get(pid);
    const r = p.renders.find((x) => x.id === rid_);
    if (!r) throw Object.assign(new Error("成片不存在"), { status: 404 });
    const f = which === "poster" ? r.poster : which === "srt" ? r.srt : which === "nosub" ? r.nosub : r.file;
    if (!f) throw Object.assign(new Error("文件不存在"), { status: 404 });
    return { render: r, file: path.join(this.rendersDir(pid), f) };
  }
  async removeRender(pid, rid_) {
    const p = this.get(pid);
    const r = p.renders.find((x) => x.id === rid_);
    if (!r) return p;
    for (const f of [r.file, r.poster, r.srt, r.nosub]) if (f) await fsp.rm(path.join(this.rendersDir(pid), f), { force: true });
    p.renders = p.renders.filter((x) => x.id !== rid_);
    return this.save(p);
  }
}

// ---- scene.json interop (skill's scene.py format) -------------------------------------------
const runPy = (args, cwd) => new Promise((resolve, reject) => { const c = spawn("python3", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); let err = ""; c.stderr.on("data", (d) => { err += d; }); c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`python3 ${args[1]} exit ${code}: ${err.slice(-300)}`)))); c.on("error", reject); });
const safeFile = (n) => String(n || "file").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80);

Projects.prototype.exportScene = async function (pid, { jobFile, copyTakes = true }) {
  const p = this.get(pid);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "h3s-export-"));
  const refsDir = path.join(dir, "refs"), outDir = path.join(dir, "out"); await fsp.mkdir(refsDir); await fsp.mkdir(outDir);
  const used = new Map();
  const refName = async (aid) => {
    if (used.has(aid)) return used.get(aid);
    const { asset, file } = this.assetPath(pid, aid);
    let name = safeFile(asset.name.replace(/\.[^.]+$/, "")) + path.extname(file);
    if ([...used.values()].includes(`refs/${name}`)) name = `${aid}_${name}`;
    await fsp.copyFile(file, path.join(refsDir, name)); used.set(aid, `refs/${name}`); return `refs/${name}`;
  };
  const scene = { name: p.name, out_dir: "out", workflow: p.settings.workflow, width: p.settings.width, height: p.settings.height, seconds: p.settings.seconds, steps: p.settings.steps, ref_size: p.settings.refSize, refs: [], subjects: p.shared.subjects || "", retention: p.shared.retention || "", style: p.shared.style || "", soundscape: p.shared.soundscape || "", music: p.shared.music || "N/A", clips: [], pick: {}, assemble: { black_tail: p.assemble.blackTail, lufs: p.assemble.lufs, upscale: p.assemble.upscale } };
  for (const aid of p.refs) scene.refs.push(await refName(aid));
  for (const c of p.clips) {
    const cl = { id: c.id, title: c.title, seed: c.seed, summary: c.summary, shot: c.shot };
    for (const k of ["retention", "subjects", "style", "soundscape", "music", "prompt", "notes"]) if (c[k]) cl[k] = c[k];
    for (const k of ["seconds", "width", "height", "steps", "workflow"]) if (c[k]) cl[k] = c[k];
    if (c.gain) cl.gain = c.gain;
    if (c.refs && c.refs.length) cl.refs = []; for (const aid of c.refs || []) { try { cl.refs.push(await refName(aid)); } catch {} }
    if (c.videos && c.videos.length) { cl.videos = []; for (const aid of c.videos) { try { cl.videos.push(await refName(aid)); } catch {} } if (c.videoAudio) cl.video_audio = true; }
    if (c.subs && c.subs.length) cl.subs = c.subs;
    const jid = c.pick || c.takes.at(-1); const f = jid && jobFile(jid);
    if (f && fs.existsSync(f)) { if (copyTakes) await fsp.copyFile(f, path.join(outDir, `${c.id}.mp4`)); scene.pick[c.id] = `${c.id}.mp4`; }
    scene.clips.push(cl);
  }
  await fsp.writeFile(path.join(dir, "scene.json"), JSON.stringify(scene, null, 1));
  const zip = path.join(os.tmpdir(), `${safeFile(p.name)}_scene_${Date.now()}.zip`);
  await runPy(["-m", "zipfile", "-c", zip, "scene.json", "refs", "out"], dir);
  await fsp.rm(dir, { recursive: true, force: true });
  return { zip, name: `${safeFile(p.name)}_scene.zip`, clips: scene.clips.length, refs: used.size, picks: Object.keys(scene.pick).length };
};

/** Import a scene.json (bare JSON or a zip with refs/) into an existing project: settings, shared sections, refs, clips. */
Projects.prototype.importScene = async function (pid, srcPath, { isZip }) {
  const p = this.get(pid);
  let dir = null, sceneFile = srcPath;
  if (isZip) { dir = await fsp.mkdtemp(path.join(os.tmpdir(), "h3s-import-")); await runPy(["-m", "zipfile", "-e", srcPath, dir], dir); const found = (await fsp.readdir(dir, { recursive: true })).find((f) => f.endsWith("scene.json")); if (!found) { await fsp.rm(dir, { recursive: true, force: true }); throw new Error("zip 里没有 scene.json"); } sceneFile = path.join(dir, found); }
  const base = path.dirname(sceneFile);
  let sc; try { sc = JSON.parse(await fsp.readFile(sceneFile, "utf8")); } catch (e) { throw new Error("scene.json 解析失败：" + e.message); }
  const warnings = []; const mapped = new Map();
  const assetFor = async (rel, kind) => {
    if (!rel) return null; if (mapped.has(rel)) return mapped.get(rel);
    const byName = p.assets.find((a) => a.name === path.basename(rel)); const f = path.join(base, rel);
    if (fs.existsSync(f)) { const tmp = path.join(os.tmpdir(), `h3s-imp-${crypto.randomBytes(3).toString("hex")}${path.extname(f)}`); await fsp.copyFile(f, tmp); const a = await this.addAsset(pid, tmp, { name: path.basename(rel), kind, source: { type: "import", path: rel } }); mapped.set(rel, a.id); return a.id; }
    if (byName) { mapped.set(rel, byName.id); return byName.id; }
    warnings.push(`找不到 ${rel}，已跳过`); mapped.set(rel, null); return null;
  };
  const settings = {}; if (sc.workflow) settings.workflow = sc.workflow; for (const k of ["width", "height", "seconds", "steps"]) if (sc[k] != null) settings[k] = sc[k]; if (sc.ref_size) settings.refSize = sc.ref_size;
  await this.update(pid, { name: sc.name || p.name, settings, shared: { subjects: sc.subjects || "", retention: sc.retention || "", style: sc.style || "", soundscape: sc.soundscape || "", music: sc.music || "N/A" }, assemble: sc.assemble ? { blackTail: sc.assemble.black_tail, lufs: sc.assemble.lufs, upscale: sc.assemble.upscale } : undefined });
  const refs = []; for (const r of sc.refs || []) { const id = await assetFor(r, "image"); if (id) refs.push(id); }
  await this.update(pid, { refs });
  let added = 0;
  for (const c of sc.clips || []) {
    const cRefs = []; for (const r of c.refs || []) { const id = await assetFor(r, "image"); if (id) cRefs.push(id); }
    const cVideos = []; for (const r of c.videos || []) { const id = await assetFor(r, "video"); if (id) cVideos.push(id); }
    await this.addClip(pid, { title: c.title || c.id, seed: c.seed, summary: c.summary || "", shot: c.shot || "", retention: c.retention || "", subjects: c.subjects || "", style: c.style || "", soundscape: c.soundscape || "", music: c.music || "", prompt: c.prompt || "", refs: cRefs.length ? cRefs : null, videos: cVideos, videoAudio: !!c.video_audio, seconds: c.seconds || null, width: c.width || null, height: c.height || null, steps: c.steps || null, workflow: c.workflow || null });
    const nc = this.get(pid).clips.at(-1); if (c.gain || (c.subs && c.subs.length) || c.notes) await this.updateClip(pid, nc.id, { gain: c.gain || 0, subs: c.subs || [], notes: c.notes || "" });
    added++;
  }
  if (dir) await fsp.rm(dir, { recursive: true, force: true });
  return { clips: added, refs: refs.length, warnings, picks: Object.keys(sc.pick || {}).length };
};

function summary(p) { return { id: p.id, name: p.name, kind: p.kind, createdAt: p.createdAt, updatedAt: p.updatedAt, clips: p.clips.length, assets: p.assets.length, renders: p.renders.length, settings: p.settings }; }
export function sanitizeSettings(s) {
  const out = {};
  if (s.workflow && WORKFLOWS[s.workflow]) out.workflow = s.workflow;
  for (const k of ["width", "height"]) if (s[k] !== undefined) { const v = Number(s[k]); if (!Number.isInteger(v) || v % 32 || v < 64 || v > 2048) throw new Error(`${k} 必须是 32 的倍数`); out[k] = v; }
  if (s.seconds !== undefined) { const v = Number(s.seconds); if (!(v >= 1 && v <= 16)) throw new Error("时长 1–15 秒"); out.seconds = v; }
  if (s.steps !== undefined) { const v = Number(s.steps); if (!(v >= 1 && v <= 30)) throw new Error("steps 1–30"); out.steps = v; }
  if (s.refSize !== undefined) out.refSize = s.refSize === "match" ? "match" : "max";
  if (s.lora !== undefined) out.lora = s.lora && typeof s.lora === "object" ? { name: s.lora.name || null, strength: s.lora.strength != null && s.lora.strength !== "" ? Number(s.lora.strength) : null, disabled: !!s.lora.disabled } : null;
  return out;
}
export { alignLength };
