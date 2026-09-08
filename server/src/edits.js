// Video-edit wizard ("视频编辑" / face swap): source video → shot detection → pick shots → per-shot
// reference segment (prep) → one ref2va job per shot ([video editing + audio reuse]) → retake / pick →
// reassemble: untouched shots from the source, edited shots from the results, original soundtrack.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { alignLength } from "./workflows.js";

const nowS = () => Math.floor(Date.now() / 1000);
const rid = (n = 4) => crypto.randomBytes(n).toString("hex");
const round32 = (v) => Math.max(64, Math.round(v / 32) * 32);

/** Fit a source frame into ≤ maxSide, both sides multiples of 32. */
export function fitSize(w, h, maxSide = 832) {
  if (!w || !h) return { w: 832, h: 448 };
  const k = Math.min(1, maxSide / Math.max(w, h));
  return { w: round32(w * k), h: round32(h * k) };
}

export class Edits {
  constructor(config, projects, jobs, media, events) { this.config = config; this.projects = projects; this.jobs = jobs; this.media = media; this.events = events; }
  get(pid, eid) { const p = this.projects.get(pid); const e = (p.edits || []).find((x) => x.id === eid); if (!e) throw Object.assign(new Error("编辑任务不存在"), { status: 404 }); return { p, e }; }
  shot(e, i) { const s = e.shots.find((x) => x.index === Number(i)); if (!s) throw Object.assign(new Error("镜头不存在"), { status: 404 }); return s; }

  /** Create an edit: detect shots and build a contact strip per shot. */
  async create(pid, { sourceAssetId, threshold = 0.3, minLen = 0.8, name = "" }) {
    const p = this.projects.get(pid);
    const { asset, file } = await this.projects.localPath(pid, sourceAssetId);
    if (asset.kind !== "video") throw new Error("源必须是视频素材");
    const det = await this.media.cuts(file, { threshold: Number(threshold) || 0.3, minLen: Number(minLen) || 0.8 });
    const id = `e_${rid()}`;
    const dir = path.join(this.projects.dir(pid), "edits", id); await fsp.mkdir(dir, { recursive: true });
    const shots = [];
    for (const s of det.shots) {
      const strip = `strip_${s.index}.jpg`;
      await this.media.run(this.media.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", s.start.toFixed(3), "-to", s.end.toFixed(3), "-i", file, "-vf", `select='eq(n\\,0)+eq(n\\,${Math.max(0, Math.round(s.duration * (det.fps || 24) / 2))})+eq(n\\,${Math.max(1, Math.round(s.duration * (det.fps || 24)) - 2)})',scale=240:-2,tile=3x1`, "-frames:v", "1", "-q:v", "4", path.join(dir, strip)]).catch(() => null);
      shots.push({ ...s, selected: false, desc: "", prompt: "", refs: null, strip: fs.existsSync(path.join(dir, strip)) ? strip : null, seg: null, segFrames: null, jobs: [], pick: null });
    }
    const size = fitSize(det.width, det.height);
    const edit = { id, name: name || `${asset.name.replace(/\.[^.]+$/, "")} · 视频编辑`, sourceAssetId, source: { width: det.width, height: det.height, fps: det.fps, duration: det.duration, hasAudio: det.hasAudio }, threshold, minLen, createdAt: nowS(), updatedAt: nowS(), shots,
      settings: { width: size.w, height: size.h, crop: null, headHold: 12, tailHold: 0, steps: 8, refSize: "max", audio: "original", seed: 7000 },
      prompt: { target: "the person in <Video 1>", face: "<describe the face, hair and glasses of the new person as seen in the pictures>", keep: "every other person in it is kept exactly as they are", style: "" },
      refs: [], renders: [] };
    p.edits ||= []; p.edits.unshift(edit); await this.projects.save(p);
    return edit;
  }
  async update(pid, eid, patch) {
    const { p, e } = this.get(pid, eid);
    if (patch.name !== undefined) e.name = String(patch.name).slice(0, 80);
    if (patch.settings) { const s = patch.settings; for (const k of ["width", "height", "headHold", "tailHold", "steps", "seed"]) if (s[k] !== undefined) e.settings[k] = Number(s[k]); if (s.crop !== undefined) e.settings.crop = s.crop && s.crop.w ? { x: +s.crop.x || 0, y: +s.crop.y || 0, w: +s.crop.w, h: +s.crop.h } : null; if (s.refSize) e.settings.refSize = s.refSize === "match" ? "match" : "max"; if (s.audio) e.settings.audio = s.audio === "generated" ? "generated" : "original"; if (e.settings.width % 32 || e.settings.height % 32) throw new Error("尺寸必须是 32 的倍数"); }
    if (patch.prompt) for (const k of ["target", "face", "keep", "style"]) if (patch.prompt[k] !== undefined) e.prompt[k] = String(patch.prompt[k]);
    if (Array.isArray(patch.refs)) e.refs = patch.refs.filter((a) => p.assets.some((x) => x.id === a)).slice(0, 9);
    if (Array.isArray(patch.shots)) for (const ps of patch.shots) { const s = e.shots.find((x) => x.index === Number(ps.index)); if (!s) continue; if (ps.selected !== undefined) s.selected = !!ps.selected; if (ps.desc !== undefined) s.desc = String(ps.desc); if (ps.prompt !== undefined) s.prompt = String(ps.prompt); if (ps.refs !== undefined) s.refs = Array.isArray(ps.refs) && ps.refs.length ? ps.refs.slice(0, 9) : null; if (ps.pick !== undefined) s.pick = ps.pick || null; }
    e.updatedAt = nowS(); await this.projects.save(p); return e;
  }
  async remove(pid, eid) { const { p } = this.get(pid, eid); p.edits = p.edits.filter((x) => x.id !== eid); await fsp.rm(path.join(this.projects.dir(pid), "edits", eid), { recursive: true, force: true }); await this.projects.save(p); }
  stripPath(pid, eid, i) { const { e } = this.get(pid, eid); const s = this.shot(e, i); if (!s.strip) throw Object.assign(new Error("没有缩略图"), { status: 404 }); return path.join(this.projects.dir(pid), "edits", eid, s.strip); }

  /** Cut the shot into a reference segment H3 can eat (24 fps, scaled/cropped, head hold, frames 17k+5). */
  async prep(pid, eid, i) {
    const { p, e } = this.get(pid, eid); const s = this.shot(e, i);
    const { file } = await this.projects.localPath(pid, e.sourceAssetId);
    const st = e.settings;
    const a = await this.projects.prepAsset(pid, e.sourceAssetId, { start: s.start, end: s.end, crop: st.crop, size: { w: st.width, h: st.height }, headHold: st.headHold, tailHold: st.tailHold, name: `${e.name} · 镜头${s.index + 1}_seg.mp4` });
    s.seg = a.id; s.segFrames = a.frames || alignLength(Math.round(s.duration * 24)); await this.projects.save(p);
    return a;
  }
  composePrompt(e, s) {
    if (s.prompt && s.prompt.trim()) return s.prompt.trim();
    const refs = (s.refs && s.refs.length ? s.refs : e.refs);
    const pics = refs.length ? refs.map((_, i) => `<Picture ${i + 1}>`).join(", ") : "<Picture 1>";
    const pr = e.prompt;
    return `subject_definitions:
<Subject 1> is a completely different person from ${pr.target}. The face, hair and glasses come from ${pics}${refs.length > 1 ? ", several views of the same person" : ""}: ${pr.face}. Everything else comes from that person in <Video 1>: the clothing, the body, the positions in the frame, the gestures, the head and mouth movements, the timing and the expressions. <Subject 1> does not keep the clothing or background of the reference pictures.
<Video 1> is the source video for the target video edit; ${pr.keep}. Its camera, framing, cuts, lighting, background and timing are kept.
<Audio 1> is the synchronized audio track of <Video 1> and is reused in the target video.

summary:
[video editing + audio reuse] The target video is an edited version of <Video 1>: the referenced person is replaced by <Subject 1>, with the face and hair from the reference pictures. Everyone else, all clothing, the scene, the camera, the cuts and the original dialogue from <Audio 1> stay exactly the same.

retention_analysis:
<Subject 1>: fully_preserved - the facial identity, face shape, eyes, nose, lips, skin tone, apparent age and hairstyle from the reference pictures are retained in every frame; the original person's face and hair are not retained.
<Video 1> (source video): partially_preserved - shots, camera, framing, background, lighting, timing, all clothing, bodies, positions, gestures, head and mouth movements are retained; only the referenced person's face and hair are replaced.
<Audio 1>: fully_copy - reused 1:1 as the complete final audio track.

detailed_description:
The target video is the live-action footage of <Video 1>, same look, same lighting.${pr.style ? " " + pr.style : ""}
[Shot 1] The first ${(e.settings.headHold / 24).toFixed(2)} seconds hold the opening frame of <Video 1>, then the action of <Video 1> plays out unchanged: ${s.desc || "the same people, same positions, same movements and dialogue as the source"}. <Subject 1> performs exactly what the replaced person does, with the same mouth movements in sync with <Audio 1>.

overall_soundscape:
The complete original soundtrack of <Audio 1> continues throughout.

non_diegetic_music:
N/A`;
  }
  async generate(pid, eid, i, { take = null } = {}) {
    const { p, e } = this.get(pid, eid); const s = this.shot(e, i);
    const refs = s.refs && s.refs.length ? s.refs : e.refs;
    if (!refs.length) throw new Error("先选参考图（新人物的头肩照 / 多角度母图）");
    if (!s.seg || !p.assets.some((a) => a.id === s.seg)) await this.prep(pid, eid, i);
    const n = s.jobs.length + 1;
    const seed = (e.settings.seed || 7000) + s.index * 10 + 1000 * (n - 1);
    const job = await this.jobs.create({ projectId: pid, title: `${e.name} · 镜头${s.index + 1} · take ${n}`, workflow: "native_ref2va", prompt: this.composePrompt(e, s), width: e.settings.width, height: e.settings.height, length: s.segFrames, steps: e.settings.steps, seed, refSize: e.settings.refSize, images: refs, videos: [s.seg], videoAudio: true, tags: ["edit", eid, String(s.index)] });
    s.jobs.push(job.id); if (!s.pick) s.pick = job.id; s.selected = true;
    await this.projects.save(p);
    return job;
  }
  async generateAll(pid, eid) { const { e } = this.get(pid, eid); const out = []; for (const s of e.shots) if (s.selected && !s.jobs.length) out.push(await this.generate(pid, eid, s.index)); return out; }

  /** Reassemble the full video: untouched shots from the source, edited shots from picked takes (head hold trimmed,
   *  missing tail frames filled from the source), uniform encode, then the original soundtrack laid back. */
  async assemble(pid, eid, { onProgress = () => {} } = {}) {
    const { p, e } = this.get(pid, eid);
    const { file: src } = await this.projects.localPath(pid, e.sourceAssetId);
    const st = e.settings, W = st.width, H = st.height;
    const dir = path.join(this.projects.dir(pid), "edits", eid, `asm_${rid(3)}`); await fsp.mkdir(dir, { recursive: true });
    const parts = []; let used = 0;
    try {
      for (const s of e.shots) {
        const jobId = s.selected ? (s.pick || s.jobs.at(-1)) : null;
        const out = jobId ? this.jobs.outputPath(jobId) : null;
        const need = Math.round(s.duration * 24);
        if (out && fs.existsSync(out)) {
          onProgress(`镜头 ${s.index + 1}：采用生成结果`);
          const info = await this.media.probe(out);
          const have = Math.max(0, Math.round(info.duration * 24) - st.headHold - st.tailHold);
          const take = Math.min(have, need);
          const f1 = path.join(dir, `s${s.index}_gen.mp4`);
          await this.media.frames(out, f1, { fromFrame: st.headHold, count: take, width: W, height: H });
          parts.push(f1); used++;
          if (need - take >= 2) { const f2 = path.join(dir, `s${s.index}_tail.mp4`); await this.media.segment(src, f2, { start: s.start + take / 24, end: s.end, width: W, height: H, crop: st.crop }); parts.push(f2); }
        } else {
          onProgress(`镜头 ${s.index + 1}：使用原片`);
          const f = path.join(dir, `s${s.index}_src.mp4`);
          await this.media.segment(src, f, { start: s.start, end: s.end, width: W, height: H, crop: st.crop }); parts.push(f);
        }
      }
      onProgress("拼接…");
      const joined = path.join(dir, "joined.mp4");
      await this.media.concat(parts, joined);
      const renderId = `r_${rid()}`;
      const final = path.join(this.projects.rendersDir(pid), `${renderId}.mp4`);
      if (st.audio === "original" && e.source.hasAudio) { onProgress("铺回原声…"); await this.media.replaceAudio(joined, src, final); }
      else await fsp.copyFile(joined, final);
      const poster = `${renderId}_poster.jpg`; await this.media.poster(final, path.join(this.projects.rendersDir(pid), poster), 640).catch(() => null);
      const info = await this.media.probe(final);
      const render = { id: renderId, name: `${e.name} · 成片 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`, file: `${renderId}.mp4`, poster, srt: null, nosub: null, createdAt: nowS(), duration: +info.duration.toFixed(2), width: W, height: H, clips: e.shots.map((s) => ({ shot: s.index, edited: !!(s.selected && s.pick) })), cues: [], subtitles: false, style: null, share: null, edit: eid, editedShots: used };
      p.renders.unshift(render); e.renders.unshift(renderId); await this.projects.save(p);
      return render;
    } finally { await fsp.rm(dir, { recursive: true, force: true }); }
  }
}
