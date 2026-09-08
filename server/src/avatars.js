// 长数字人 — long talking-head videos driven by an audio file. The audio is split at silences into
// ≤ ~14.8 s pieces; each piece becomes one ref2va job with the portrait as <Picture 1>, the previous
// segment's last frame as the composition anchor <Picture 2> (so framing/lighting stay put), and the
// audio piece as <Audio 1> ([reference generation + audio reuse]). Clips are trimmed back to the exact
// piece length, concatenated, and the original audio is laid back over the whole video.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { alignUp } from "./workflows.js";

const nowS = () => Math.floor(Date.now() / 1000);
const rid = (n = 4) => crypto.randomBytes(n).toString("hex");
const MAX_FRAMES = 362;               // 15.08 s, the model's training ceiling

/** Greedy split of [0,duration) at silence midpoints so no piece exceeds maxLen. */
export function planSegments(duration, silences, { maxLen = 14.8, minLen = 2.0 } = {}) {
  const cuts = silences.map((s) => (s.start + s.end) / 2).filter((t) => t > 0.2 && t < duration - 0.2).sort((a, b) => a - b);
  const segs = []; let start = 0;
  while (duration - start > maxLen) {
    const cand = cuts.filter((t) => t > start + minLen && t <= start + maxLen);
    const end = cand.length ? cand.at(-1) : start + maxLen;
    segs.push({ start: +start.toFixed(3), end: +end.toFixed(3) }); start = end;
  }
  segs.push({ start: +start.toFixed(3), end: +duration.toFixed(3) });
  // merge a tiny trailing piece into the previous one
  if (segs.length > 1 && segs.at(-1).end - segs.at(-1).start < 0.8) { const last = segs.pop(); segs.at(-1).end = last.end; }
  return segs.map((s, index) => ({ index, ...s, duration: +(s.end - s.start).toFixed(3) }));
}

export class Avatars {
  constructor(config, projects, jobs, media, events) { this.config = config; this.projects = projects; this.jobs = jobs; this.media = media; this.events = events; }
  init() { this.events.on("job", (j) => { if (j?.tags?.[0] === "avatar" && (j.status === "done" || j.status === "error" || j.status === "cancelled")) this.onJob(j).catch((e) => console.error("[avatars]", e.message)); }); }
  get(pid, aid) { const p = this.projects.get(pid); const a = (p.avatars || []).find((x) => x.id === aid); if (!a) throw Object.assign(new Error("数字人任务不存在"), { status: 404 }); return { p, a }; }
  seg(a, i) { const s = a.segments.find((x) => x.index === Number(i)); if (!s) throw Object.assign(new Error("分段不存在"), { status: 404 }); return s; }

  async create(pid, b) {
    const p = this.projects.get(pid);
    const face = await this.projects.localPath(pid, b.face); if (face.asset.kind !== "image") throw new Error("头像必须是图片");
    const audio = await this.projects.localPath(pid, b.audio); if (audio.asset.kind !== "audio") throw new Error("驱动音频必须是音频素材");
    const maxLen = Math.min(14.8, Math.max(3, Number(b.maxLen) || 14.8));
    const sil = await this.media.silences(audio.file, { noise: Number(b.noise) || -35, minSilence: Number(b.minSilence) || 0.3 });
    const plan = planSegments(audio.asset.duration, sil, { maxLen });
    const id = `v_${rid()}`;
    const dir = path.join(this.projects.dir(pid), "avatars", id); await fsp.mkdir(dir, { recursive: true });
    const segments = [];
    for (const s of plan) {
      const frames = Math.min(MAX_FRAMES, alignUp(s.duration * 24));
      const padTo = frames / 24;
      const wav = path.join(dir, `seg_${s.index}.wav`);
      await this.media.audioSegment(audio.file, wav, { start: s.start, end: s.end, padTo });
      const asset = await this.projects.addAsset(pid, wav, { name: `${b.name || "数字人"}_seg${s.index + 1}.wav`, kind: "audio", source: { type: "avatar-seg", avatarId: id, index: s.index }, move: true });
      segments.push({ ...s, frames, audioAsset: asset.id, jobs: [], pick: null, anchor: null });
    }
    const avatar = { id, name: String(b.name || `${face.asset.name.replace(/\.[^.]+$/, "")} · 数字人`).slice(0, 80), face: b.face, audio: b.audio, audioDuration: audio.asset.duration, segments, silences: sil.length, createdAt: nowS(), updatedAt: nowS(),
      settings: { width: Number(b.width) || 640, height: Number(b.height) || 736, steps: Number(b.steps) || 8, seed: Number(b.seed) || 8100, refSize: "max", style: b.style === "enthusiastic" ? "enthusiastic" : "natural", anchor: b.anchor !== false },
      prompt: { desc: String(b.desc || "the person in <Picture 1>").slice(0, 600), scene: String(b.scene || "a softly lit neutral studio background").slice(0, 400), language: String(b.language || "Chinese").slice(0, 30) },
      auto: false, renders: [] };
    if (avatar.settings.width % 32 || avatar.settings.height % 32) throw new Error("尺寸必须是 32 的倍数");
    p.avatars ||= []; p.avatars.unshift(avatar); await this.projects.save(p);
    return avatar;
  }
  async update(pid, aid, b) {
    const { p, a } = this.get(pid, aid);
    if (b.name !== undefined) a.name = String(b.name).slice(0, 80);
    if (b.settings) { for (const k of ["width", "height", "steps", "seed"]) if (b.settings[k] !== undefined) a.settings[k] = Number(b.settings[k]); if (b.settings.style) a.settings.style = b.settings.style === "enthusiastic" ? "enthusiastic" : "natural"; if (b.settings.anchor !== undefined) a.settings.anchor = !!b.settings.anchor; if (b.settings.refSize) a.settings.refSize = b.settings.refSize === "match" ? "match" : "max"; }
    if (b.prompt) for (const k of ["desc", "scene", "language"]) if (b.prompt[k] !== undefined) a.prompt[k] = String(b.prompt[k]);
    if (Array.isArray(b.segments)) for (const ps of b.segments) { const s = a.segments.find((x) => x.index === Number(ps.index)); if (s && ps.pick !== undefined) s.pick = ps.pick || null; }
    if (a.settings.width % 32 || a.settings.height % 32) throw new Error("尺寸必须是 32 的倍数");
    a.updatedAt = nowS(); await this.projects.save(p); return a;
  }
  async remove(pid, aid) { const { p } = this.get(pid, aid); p.avatars = p.avatars.filter((x) => x.id !== aid); await fsp.rm(path.join(this.projects.dir(pid), "avatars", aid), { recursive: true, force: true }); await this.projects.save(p); }

  prompt(a, s, { withAnchor }) {
    const style = a.settings.style === "enthusiastic"
      ? "The delivery is warm, energetic and engaging: bright eyes, expressive eyebrows, a genuine smile between sentences, small natural hand gestures at emphasis points that start and end within the frame."
      : "The delivery is calm and natural: steady eye contact with the camera, relaxed shoulders, small natural head movements, an occasional slight nod, hands mostly still.";
    return `subject_definitions:
<Subject 1> is the presenter, whose face, hair and identity come from <Picture 1>: ${a.prompt.desc}. They are framed in a static medium close-up, facing the camera, in ${a.prompt.scene}.${withAnchor ? `
<Picture 2> is the exact framing of the previous segment and the composition anchor: the target video keeps the same camera position, crop, background, lighting and clothing as <Picture 2>.` : ""}
<Audio 1> is the presenter's speech for this segment and is reused in the target video as the only voice.

summary:
[reference generation + audio reuse] One static medium close-up of <Subject 1> speaking the words of <Audio 1> to the camera with accurate lip sync; no cuts, no camera movement.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - facial identity, apparent age, hairstyle, eyewear and clothing are retained unchanged in every frame.${withAnchor ? `
<Picture 2> (composition anchor): fully_preserved - camera position, framing, background and lighting are retained; nothing is re-framed, zoomed or re-lit.` : ""}
<Audio 1>: fully_copy - reused 1:1 as the complete speech track; the mouth movements follow it exactly.

detailed_description:
The target video is realistic live-action footage, clean digital cinema camera, 24 fps, natural skin texture, no beauty filter. No subtitles, no on-screen text, no other people.
[Shot 1] A static medium close-up, 50mm lens, at eye level, of <Subject 1> facing the camera and speaking <Audio 1> in ${a.prompt.language}; the lips, jaw and cheeks move in exact sync with the words, with natural blinking and breathing. ${style} The head and body keep the same size and position in the frame from the first frame to the last; the camera holds a static shot; no zoom, no pan, no cut, no change of background or lighting.

overall_soundscape:
Only the speech of <Audio 1> with a faint, even room tone; no other voices.

non_diegetic_music:
N/A`;
  }
  async anchorFor(pid, a, s) {
    if (!a.settings.anchor || s.index === 0) return null;
    const prev = a.segments[s.index - 1]; const jobId = prev?.pick || prev?.jobs?.at(-1);
    const file = jobId && this.jobs.outputPath(jobId); if (!file || !fs.existsSync(file)) return null;
    if (prev.anchor && this.projects.get(pid).assets.some((x) => x.id === prev.anchor)) return prev.anchor;
    const asset = await this.projects.frameAsset(pid, file, { last: true, name: `${a.name}_seg${prev.index + 1}_末帧.jpg`, source: { type: "avatar-anchor", avatarId: a.id, index: prev.index, jobId } });
    prev.anchor = asset.id; return asset.id;
  }
  async generate(pid, aid, i) {
    const { p, a } = this.get(pid, aid); const s = this.seg(a, i);
    const anchor = await this.anchorFor(pid, a, s);
    const images = anchor ? [a.face, anchor] : [a.face];
    const n = s.jobs.length + 1;
    const job = await this.jobs.create({ projectId: pid, title: `${a.name} · 第 ${s.index + 1} 段 · take ${n}`, workflow: "native_ref2va", prompt: this.prompt(a, s, { withAnchor: !!anchor }), width: a.settings.width, height: a.settings.height, length: s.frames, steps: a.settings.steps, seed: a.settings.seed + s.index * 10 + 1000 * (n - 1), refSize: a.settings.refSize, images, videos: [], videoAudio: false, audios: [s.audioAsset], tags: ["avatar", aid, String(s.index)] });
    s.jobs.push(job.id); if (!s.pick) s.pick = job.id;
    a.updatedAt = nowS(); await this.projects.save(p);
    return job;
  }
  /** Chain: generate the first segment without a take; the job-done hook continues with the next one. */
  async generateAll(pid, aid) {
    const { p, a } = this.get(pid, aid);
    const next = a.segments.find((s) => !s.jobs.length);
    if (!next) throw new Error("每段都已有 take");
    a.auto = true; await this.projects.save(p);
    return this.generate(pid, aid, next.index);
  }
  async onJob(j) {
    const [, aid, idx] = j.tags; const pid = j.projectId;
    let ctx; try { ctx = this.get(pid, aid); } catch { return; }
    const { p, a } = ctx;
    if (!a.auto) return;
    if (j.status !== "done") { a.auto = false; await this.projects.save(p); this.events.emitAll("toast", { level: "warn", text: `数字人「${a.name}」第 ${Number(idx) + 1} 段失败，链式生成已停` }); return; }
    const next = a.segments.find((s) => !s.jobs.length);
    if (!next) { a.auto = false; await this.projects.save(p); this.events.emitAll("toast", { level: "ok", text: `数字人「${a.name}」全部分段已生成，可以拼接了` }); return; }
    if (next.index !== Number(idx) + 1) return;
    await this.generate(pid, aid, next.index);
  }
  async assemble(pid, aid, { onProgress = () => {} } = {}) {
    const { p, a } = this.get(pid, aid);
    const { file: audioFile } = await this.projects.localPath(pid, a.audio);
    const W = a.settings.width, H = a.settings.height;
    const dir = path.join(this.projects.dir(pid), "avatars", aid, `asm_${rid(3)}`); await fsp.mkdir(dir, { recursive: true });
    try {
      const parts = [];
      for (const s of a.segments) {
        const jobId = s.pick || s.jobs.at(-1); const out = jobId && this.jobs.outputPath(jobId);
        if (!out || !fs.existsSync(out)) throw new Error(`第 ${s.index + 1} 段还没有成片`);
        onProgress(`裁齐第 ${s.index + 1} 段`);
        const f = path.join(dir, `s${s.index}.mp4`);
        await this.media.frames(out, f, { fromFrame: 0, count: Math.max(1, Math.round(s.duration * 24)), width: W, height: H });
        parts.push(f);
      }
      onProgress("拼接…");
      const joined = path.join(dir, "joined.mp4"); await this.media.concat(parts, joined);
      onProgress("铺回原音频…");
      const renderId = `r_${rid()}`; const final = path.join(this.projects.rendersDir(pid), `${renderId}.mp4`);
      await this.media.replaceAudio(joined, audioFile, final);
      const poster = `${renderId}_poster.jpg`; await this.media.poster(final, path.join(this.projects.rendersDir(pid), poster), 640).catch(() => null);
      const info = await this.media.probe(final);
      const render = { id: renderId, name: `${a.name} · 成片 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`, file: `${renderId}.mp4`, poster, srt: null, nosub: null, createdAt: nowS(), duration: +info.duration.toFixed(2), width: W, height: H, clips: a.segments.map((s) => ({ segment: s.index, jobId: s.pick || s.jobs.at(-1) })), cues: [], subtitles: false, style: null, share: null, avatar: aid };
      p.renders.unshift(render); a.renders.unshift(renderId); await this.projects.save(p);
      return render;
    } finally { await fsp.rm(dir, { recursive: true, force: true }); }
  }
}
