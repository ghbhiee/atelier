// 母图工坊 — continuity master images. Ported from the skill's masters.py (proven 2026-09-05):
//  person: static front close-up (56 f) → frame 1.2 s; then "photo + front" → 90 f head-turn clip →
//          frames at 1.9 s (three-quarter) and 3.3 s (profile). Static "strict profile" prompts do NOT work.
//  scene:  static wide shot of the room with the people in fixed positions (56 f, 1344×768) → frame 1.2 s.
//  regen:  crop a master (e.g. half of the wide shot) → regenerate at full resolution → frame ("裁剪推进").
// Every produced frame is registered as a project asset and can be adopted as shared refs / edit refs.
import crypto from "node:crypto";
import fs from "node:fs";

const nowS = () => Math.floor(Date.now() / 1000);
const rid = (n = 4) => crypto.randomBytes(n).toString("hex");
const GREY = "front of a plain, evenly lit light-grey studio backdrop with nothing else in the frame";
export const TURN_T = { threeq: 1.9, profile: 3.3 };

export class Masters {
  constructor(config, projects, jobs, media, events) { this.config = config; this.projects = projects; this.jobs = jobs; this.media = media; this.events = events; }
  init() { this.events.on("job", (j) => { if (j?.status === "done" && j.tags?.[0] === "master") this.onDone(j).catch((e) => console.error("[masters]", e.message)); }); }
  get(pid, mid) { const p = this.projects.get(pid); const m = (p.masters || []).find((x) => x.id === mid); if (!m) throw Object.assign(new Error("母图任务不存在"), { status: 404 }); return { p, m }; }

  async create(pid, b) {
    const p = this.projects.get(pid);
    const kind = b.kind === "scene" ? "scene" : "person";
    const faces = (b.faces || (b.face ? [b.face] : [])).filter((a) => p.assets.some((x) => x.id === a));
    if (kind === "person" && !faces.length) throw new Error("人物母图需要一张头肩照");
    const m = { id: `m_${rid()}`, kind, name: String(b.name || (kind === "person" ? "人物" : "场景")).slice(0, 60), faces, desc: String(b.desc || "").slice(0, 600), outfit: String(b.outfit || "").slice(0, 300), scene: String(b.scene || "").slice(0, 600), subjects: String(b.subjects || "").slice(0, 3000), background: b.background === "scene" ? "scene" : "grey",
      settings: { width: Number(b.width) || (kind === "person" ? 640 : 1344), height: Number(b.height) || (kind === "person" ? 736 : 768), seed: Number(b.seed) || 7100, steps: Number(b.steps) || 8, refSize: "max" },
      steps: {}, createdAt: nowS(), updatedAt: nowS() };
    if (m.settings.width % 32 || m.settings.height % 32) throw new Error("尺寸必须是 32 的倍数");
    p.masters ||= []; p.masters.unshift(m); await this.projects.save(p); return m;
  }
  async update(pid, mid, b) {
    const { p, m } = this.get(pid, mid);
    for (const k of ["name", "desc", "outfit", "scene", "subjects"]) if (b[k] !== undefined) m[k] = String(b[k]);
    if (b.background) m.background = b.background === "scene" ? "scene" : "grey";
    if (Array.isArray(b.faces)) m.faces = b.faces.filter((a) => p.assets.some((x) => x.id === a)).slice(0, 9);
    if (b.settings) for (const k of ["width", "height", "seed", "steps"]) if (b.settings[k] !== undefined) m.settings[k] = Number(b.settings[k]);
    if (m.settings.width % 32 || m.settings.height % 32) throw new Error("尺寸必须是 32 的倍数");
    m.updatedAt = nowS(); await this.projects.save(p); return m;
  }
  async remove(pid, mid) { const { p } = this.get(pid, mid); p.masters = p.masters.filter((x) => x.id !== mid); await this.projects.save(p); }

  sceneText(m) { return m.background === "grey" ? GREY : (m.scene || "a neutral interior"); }
  prompt(m, step, { from = null, npics = 1 } = {}) {
    const pics = Array.from({ length: npics }, (_, i) => `<Picture ${i + 1}>`).join(", ");
    const several = npics > 1 ? ", several views of the same person" : "";
    const desc = m.desc || "the person in the pictures", outfit = m.outfit || "the same clothing as in the pictures", scene = this.sceneText(m);
    if (step === "front") return `subject_definitions:
<Subject 1> is the person whose face and hair come from ${pics}${several}: ${desc}. In the target video they wear ${outfit}.

summary:
[reference generation] A single static medium close-up facing the camera directly of <Subject 1> in ${scene}, used as a continuity master. Nobody speaks.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - the facial identity, apparent age, hair and eyewear from ${pics} are retained; only the clothing is replaced.

detailed_description:
The target video is live-action footage with warm interior lighting and natural skin, no beauty filter.
[Shot 1] A static medium close-up facing the camera directly of <Subject 1>, ${desc}, wearing ${outfit}, in ${scene}. They hold the pose, breathe and blink naturally, and slowly turn the head a few degrees. The camera holds a static shot. No subtitles, no on-screen text.

overall_soundscape:
Quiet room tone.

non_diegetic_music:
N/A`;
    if (step === "turn") return `subject_definitions:
<Subject 1> is the person whose face, hair${/glasses/i.test(desc) && !/no glasses/i.test(desc) ? " and glasses" : ""} come from ${pics}, ${npics > 1 ? "several views" : "one view"} of the same person: ${desc}. In the target video they wear ${outfit}.

summary:
[reference generation] A single static medium close-up of <Subject 1> in ${scene}, who slowly turns the head from facing the camera to a full left profile; used as a continuity master for several head angles. Nobody speaks.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - the facial identity, apparent age, hair and eyewear from ${pics} are retained; only the clothing is replaced.

detailed_description:
The target video is live-action footage with warm interior lighting and natural skin, no beauty filter.
[Shot 1] A static medium close-up, 50mm lens, at eye level, of <Subject 1> wearing ${outfit}, in ${scene}, the whole head inside the frame. At the start they face the camera directly. Over the whole shot they slowly and steadily turn the head to their left, passing through a three-quarter view in the middle, until at the end the face is seen in strict profile, only one eye visible and the tip of the nose against the background. The expression stays calm and neutral; they blink naturally. The camera holds a static shot. No subtitles, no on-screen text.

overall_soundscape:
Quiet room tone.

non_diegetic_music:
N/A`;
    if (step === "wide") return `subject_definitions:
${m.subjects || `<Subject 1> is the person whose face comes from <Picture 1>: ${desc}. In the target video they wear ${outfit}.`}
<Subject 9> is the room: ${m.scene || "a neutral interior"}.

summary:
[reference generation] One static wide shot of everyone inside <Subject 9>, each person in a fixed position, used as a continuity master for the whole scene. Nobody speaks, nobody moves from their spot.

retention_analysis:
Every <Subject N> defined above (appears in [Shot 1]): fully_preserved - facial identity, apparent age, hairstyle and eyewear from the pictures are retained; only clothing is set as described.
<Subject 9> (appears in [Shot 1]): fully_preserved - the layout is exactly as described and never mirrored, rotated or rearranged.

detailed_description:
The target video is a realistic live-action scene, clean digital cinema camera, 24 fps, natural skin texture, no beauty filter. No subtitles, no on-screen text, no additional people.
[Shot 1] A static wide shot, 35mm lens, at standing eye level, showing the whole room of <Subject 9> with every person in their described position, facing the camera in relaxed neutral poses. They breathe and blink naturally and stay in place. The camera holds a static shot.

overall_soundscape:
Quiet room tone.

non_diegetic_music:
N/A`;
    // regen: reproduce a cropped master at full resolution (composition follows the last picture)
    return `subject_definitions:
${m.subjects || `<Subject 1> is the person whose face comes from <Picture 1>: ${desc}.`}
<Picture ${npics}> is the composition anchor: the target video frames exactly what <Picture ${npics}> shows, same camera position, same crop, same people in the same places.

summary:
[reference generation] One static shot reproducing <Picture ${npics}> at full resolution, used as a continuity master. Nobody speaks, nobody moves.

retention_analysis:
Every <Subject N> defined above (appears in [Shot 1]): fully_preserved - facial identity, apparent age, hairstyle and eyewear are retained.
<Picture ${npics}> (composition anchor): fully_preserved - framing, positions, furniture, colours and lighting are retained and never mirrored, rotated or rearranged.

detailed_description:
The target video is a realistic live-action scene, clean digital cinema camera, 24 fps, natural skin texture, no beauty filter. No subtitles, no on-screen text, no additional people.
[Shot 1] A static shot framed exactly as <Picture ${npics}>. Everyone holds their pose, breathes and blinks naturally. The camera holds a static shot.

overall_soundscape:
Quiet room tone.

non_diegetic_music:
N/A`;
  }

  /** Queue the job for a step. front/turn (person), wide (scene), regen (any, needs `from` asset). */
  async run(pid, mid, step, { from = null } = {}) {
    const { p, m } = this.get(pid, mid);
    let images, length, width = m.settings.width, height = m.settings.height;
    if (step === "front") { if (m.kind !== "person") throw new Error("场景母图没有正面步骤"); images = [...m.faces]; length = 56; }
    else if (step === "turn") { const front = m.steps.front?.assetId; if (!front) throw new Error("先生成正面母图"); images = [...m.faces, front]; length = 90; }
    else if (step === "wide") { images = [...m.faces]; length = 56; if (m.kind === "person") { width = Number(this.projects.get(pid).settings.width) || 1344; height = Number(this.projects.get(pid).settings.height) || 768; } }
    else if (step === "regen") { if (!from) throw new Error("裁剪推进需要指定源图"); this.projects.assetPath(pid, from); images = [...m.faces, from]; length = 56; }
    else throw new Error("未知步骤");
    if (!images.length) throw new Error("没有参考图");
    const n = Object.values(m.steps).filter((s) => s.step === step).length + 1;
    const seed = m.settings.seed + { front: 0, turn: 1, wide: 2, regen: 3 }[step] * 10 + 1000 * (n - 1);
    const job = await this.jobs.create({ projectId: pid, title: `${m.name} · 母图 ${({ front: "正面", turn: "转头", wide: "全景", regen: "推进" })[step]} · take ${n}`, workflow: "native_ref2va", prompt: this.prompt(m, step, { from, npics: images.length }), width, height, length, steps: m.settings.steps, seed, refSize: m.settings.refSize, images, videos: [], videoAudio: false, tags: ["master", mid, step, from || ""] });
    const key = step === "regen" ? `regen_${rid(2)}` : step;
    m.steps[key] = { step, jobId: job.id, from, assetId: null, assets: {}, at: nowS() };
    m.updatedAt = nowS(); await this.projects.save(p);
    return { job, key };
  }
  /** Job finished → pull the master frames out and register them as assets. */
  async onDone(j) {
    const [, mid, step] = j.tags; const pid = j.projectId;
    let ctx; try { ctx = this.get(pid, mid); } catch { return; }
    const { p, m } = ctx;
    const key = Object.keys(m.steps).find((k) => m.steps[k].jobId === j.id); if (!key) return;
    const rec = m.steps[key]; if (rec.assetId || Object.keys(rec.assets || {}).length) return;
    const file = this.jobs.outputPath(j.id); if (!file || !fs.existsSync(file)) return;
    const mk = async (at, label) => (await this.projects.frameAsset(pid, file, { at, name: `${m.name}_${label}.jpg`, source: { type: "master", masterId: mid, step, jobId: j.id, at } })).id;
    if (step === "turn") { rec.assets = { threeq: await mk(TURN_T.threeq, "threeq"), profile: await mk(TURN_T.profile, "profile") }; }
    else { rec.assetId = await mk(1.2, ({ front: "front", wide: "wide", regen: "regen" })[step] || step); }
    m.updatedAt = nowS(); await this.projects.save(p);
    this.events.emitAll("toast", { level: "ok", text: `母图「${m.name}」${({ front: "正面", turn: "转头", wide: "全景", regen: "推进" })[step]}已抽帧入库` });
  }
  /** Re-extract a frame from a step's clip at another time (turn not far enough, etc.). */
  async extract(pid, mid, key, { at, label }) {
    const { p, m } = this.get(pid, mid); const rec = m.steps[key]; if (!rec) throw new Error("步骤不存在");
    const file = this.jobs.outputPath(rec.jobId); if (!file) throw new Error("这步还没有成片");
    const a = await this.projects.frameAsset(pid, file, { at: Number(at) || 0, name: `${m.name}_${label || "frame"}_${Number(at).toFixed(1)}s.jpg`, source: { type: "master", masterId: mid, step: rec.step, jobId: rec.jobId, at: Number(at) } });
    if (label === "threeq" || label === "profile") { rec.assets ||= {}; rec.assets[label] = a.id; } else if (label === "main") rec.assetId = a.id;
    await this.projects.save(p); return a;
  }
  /** All master assets of a record in reference order: front, threeq, profile, wide/regen. */
  produced(m) {
    const out = [];
    const add = (id) => { if (id && !out.includes(id)) out.push(id); };
    add(m.steps.front?.assetId); add(m.steps.turn?.assets?.threeq); add(m.steps.turn?.assets?.profile); add(m.steps.wide?.assetId);
    for (const [k, v] of Object.entries(m.steps)) if (k.startsWith("regen_")) add(v.assetId);
    return out;
  }
  /** Adopt produced assets as project shared refs, or as an edit's refs. */
  async adopt(pid, mid, { target = "refs", editId = null, includeFace = true, assets = null } = {}) {
    const { p, m } = this.get(pid, mid);
    const ids = [...(includeFace ? m.faces : []), ...(assets || this.produced(m))].filter((a) => p.assets.some((x) => x.id === a));
    if (!ids.length) throw new Error("还没有可用的母图");
    if (target === "edit") { const e = (p.edits || []).find((x) => x.id === editId); if (!e) throw new Error("编辑任务不存在"); e.refs = [...new Set([...e.refs, ...ids])].slice(0, 9); }
    else p.refs = [...new Set([...p.refs, ...ids])].slice(0, 9);
    await this.projects.save(p); return { added: ids };
  }
}
