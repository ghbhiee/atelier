// Build ComfyUI API-format workflows for MiniMax-H3 from a job spec. Port of h3g.py's `generate`.
//
// Hard facts baked in here (all cost real GPU time to learn):
//  * width/height must be multiples of 32, frames must satisfy (length-5) % 17 == 0
//  * reference inputs are Autogrow inputs: the ONLY wiring the /prompt API honours is the dotted
//    flat path  "ref_images.ref_image_0": [nodeId, 0]  (list / nested / top-level forms are
//    accepted silently but the reference never reaches the model)
//  * native_i2v (fl2va) has first_frame/last_frame but no references; native_ref2va has
//    references but no first/last frame
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WF_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../workflows");
export const WORKFLOWS = {
  native_t2v: { label: "文生视频", weights: "fl2va", refs: false, frames: false, steps: 4 },
  native_i2v: { label: "首帧 / 首尾帧", weights: "fl2va", refs: false, frames: true, steps: 4 },
  native_ref2va: { label: "参考图 / 参考视频", weights: "ref2va", refs: true, frames: false, steps: 8 },
  // Not an H3 generation: the AtelierWhiteModel custom node (Depth Anything V2 + relief shading) turns a real clip into a clay render.
  whitemodel: { label: "白模视频", weights: null, refs: false, frames: false, steps: 1000, tool: true },
};
export const WHITEMODEL_PRESETS = ["clay", "sculpt", "soft", "toon"];
export const SIZE_PRESETS = [
  { w: 832, h: 448, label: "832×448 横版 (默认)" }, { w: 448, h: 832, label: "448×832 竖版" },
  { w: 1344, h: 768, label: "1344×768 原生横版 (母图)" }, { w: 768, h: 1344, label: "768×1344 原生竖版" },
  { w: 640, h: 384, label: "640×384 快速小样" }, { w: 640, h: 736, label: "640×736 竖版换脸" },
  { w: 608, h: 768, label: "608×768 母图/换脸" }, { w: 960, h: 544, label: "960×544 横版" },
];

/** Quality tiers: the real levers are resolution and reference size; steps stay at the LoRA calibration
 *  (4 for fl2va turbo, 8 for ref2va acc) because more steps mostly burn time. */
export const QUALITY = {
  fast: { label: "快速小样", desc: "640×384 · 参考图 match · 最快，用来试提示词", size: [640, 384], steps: { native_t2v: 4, native_i2v: 4, native_ref2va: 8 }, refSize: "match" },
  balanced: { label: "均衡", desc: "832×448 · 参考图 max · 日常出片", size: [832, 448], steps: { native_t2v: 4, native_i2v: 4, native_ref2va: 8 }, refSize: "max" },
  ultra: { label: "高质量", desc: "1344×768 原生画幅 · 参考图 max · 慢 2–3 倍，显存吃紧时降帧数", size: [1344, 768], steps: { native_t2v: 4, native_i2v: 4, native_ref2va: 8 }, refSize: "max" },
};
/** Smallest 17k+5 ≥ frames (used when the audio must fit inside the clip). */
export function alignUp(frames) { frames = Math.max(22, Math.round(frames)); return 5 + Math.max(1, Math.ceil((frames - 5) / 17)) * 17; }

export function alignLength(frames) {
  frames = Math.max(22, Math.round(frames));
  return 5 + Math.max(1, Math.round((frames - 5) / 17)) * 17;
}
export const framesToSeconds = (frames) => frames / 24;

/**
 * Which H3 weights fit the card we are on. The fleet mixes 24 / 32 / 48 / 96 GB machines, so the file
 * names cannot be baked into the template: pick the best variant that fits, then rewrite the loader
 * nodes. Returns null when the catalogue has no variants (keep whatever the template ships with).
 */
export function pickVariant(model, vramTotalMib) {
  const vs = model?.variants || [];
  if (!vs.length || !vramTotalMib) return null;
  const fits = vs.filter((v) => vramTotalMib >= v.minVramMib).sort((a, b) => b.minVramMib - a.minVramMib);
  return fits[0] || vs[vs.length - 1];
}

/** Point the UNet / CLIP loaders at a specific variant's files. */
export function applyVariant(wf, variant, weights) {
  if (!variant) return wf;
  for (const n of Object.values(wf)) {
    if (n.class_type === "UNETLoader" || n.class_type === "UnetLoaderGGUF") {
      const f = variant.unet?.[weights];
      if (f) { n.inputs.unet_name = f; n.class_type = variant.loader || n.class_type; }
    }
    if (n.class_type === "CLIPLoader" && variant.clip) n.inputs.clip_name = variant.clip;
  }
  return wf;
}

export function loadTemplate(name) {
  const p = path.join(WF_DIR, `${name}.json`);
  if (!WORKFLOWS[name] || !fs.existsSync(p)) throw new Error(`unknown workflow ${name}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
const nodesOf = (wf, ct) => Object.entries(wf).filter(([, v]) => v.class_type === ct).map(([k]) => k);

/**
 * spec: { workflow, prompt, width, height, length, steps, seed, refSize, prefix,
 *         images: [remoteName], lastFrame: remoteName|null, videos: [remoteName], videoAudio, audios: [remoteName],
 *         lora: { name?: string, strength?: number, disabled?: boolean } | null   (template default when omitted) }
 * Returns { workflow, h3Node, length, seed, expectedRefs }
 */
export function buildWorkflow(spec) {
  if (spec.workflow === "whitemodel") {
    const src = (spec.videos || [])[0]; if (!src) throw new Error("白模需要一段源视频");
    const wmp = spec.whitemodel || {};
    const preset = WHITEMODEL_PRESETS.includes(wmp.preset) ? wmp.preset : "clay";
    const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : 0; };
    const wf = { 1: { class_type: "AtelierWhiteModel", inputs: { video: src, preset, relief: num(wmp.relief, 0.5, 20), photo: num(wmp.photo, 0.01, 1), ao: num(wmp.ao, 0.01, 2), keep_audio: wmp.keepAudio !== false, subject_only: !!wmp.subjectOnly, subject_threshold: Math.min(0.95, Math.max(0.1, Number(wmp.subjectThreshold) || 0.55)), depth_model: ["large", "base", "small"].includes(wmp.depthModel) ? wmp.depthModel : "large", filename_prefix: spec.prefix || "whitemodel" } } };
    return { workflow: wf, h3Node: null, length: spec.length || 0, steps: 1000, seed: 0, expectedRefs: 0, whitemodel: { preset, relief: wf[1].inputs.relief, photo: wf[1].inputs.photo, ao: wf[1].inputs.ao, subjectOnly: wf[1].inputs.subject_only, subjectThreshold: wf[1].inputs.subject_threshold } };
  }
  const wf = loadTemplate(spec.workflow);
  const meta = WORKFLOWS[spec.workflow];
  for (const [v, nm] of [[spec.width, "宽"], [spec.height, "高"]]) if (!Number.isInteger(v) || v % 32 || v < 64 || v > 2048) throw new Error(`${nm} ${v} 必须是 32 的倍数（H3 会在 patchify 时 reshape 失败）`);
  const length = alignLength(spec.length);
  if (length > 362 + 17) throw new Error("一次最长约 15 秒（362 帧），更长的请分段生成再拼接");
  const refN = nodesOf(wf, "MiniMaxH3ReferenceToVideo"), i2vN = nodesOf(wf, "MiniMaxH3ImageToVideo");
  const hn = (refN[0] || i2vN[0]);
  if (!hn) throw new Error("模板里没有 H3 节点");
  Object.assign(wf[hn].inputs, { prompt: spec.prompt, width: spec.width, height: spec.height, length });
  const images = spec.images || [], videos = spec.videos || [], audios = spec.audios || [];
  let expectedRefs = 0;
  if (meta.refs) {
    const inp = wf[hn].inputs;
    for (const k of Object.keys(inp)) if (/^(ref_images|ref_videos|ref_video_audios|ref_audios)/.test(k)) delete inp[k];
    for (const n of [...nodesOf(wf, "LoadImage"), ...nodesOf(wf, "LoadVideo"), ...nodesOf(wf, "GetVideoComponents"), ...nodesOf(wf, "LoadAudio")]) if (n.startsWith("9")) delete wf[n];
    inp.ref_image_size = spec.refSize || "max";
    if (images.length > 9) throw new Error("参考图最多 9 张");
    if (videos.length > 3) throw new Error("参考视频最多 3 段");
    images.forEach((name, i) => {
      const nid = `90${i}`;
      wf[nid] = { class_type: "LoadImage", inputs: { image: name } };
      inp[`ref_images.ref_image_${i}`] = [nid, 0];
      expectedRefs++;
    });
    videos.forEach((name, i) => {
      const lv = `92${i}`, gc = `93${i}`;
      wf[lv] = { class_type: "LoadVideo", inputs: { file: name } };
      wf[gc] = { class_type: "GetVideoComponents", inputs: { video: [lv, 0] } };
      inp[`ref_videos.ref_video_${i}`] = [gc, 0];
      expectedRefs++;
      if (spec.videoAudio) { inp[`ref_video_audios.ref_video_audio_${i}`] = [gc, 1]; expectedRefs++; }
    });
    if (audios.length > 3) throw new Error("参考音频最多 3 段");
    audios.forEach((name, i) => {
      const nid = `94${i}`;
      wf[nid] = { class_type: "LoadAudio", inputs: { audio: name } };
      inp[`ref_audios.ref_audio_${i}`] = [nid, 0];
      expectedRefs++;
    });
  } else {
    for (const n of nodesOf(wf, "LoadImage")) delete wf[n];
    delete wf[hn].inputs.first_frame; delete wf[hn].inputs.last_frame;
    if (videos.length || audios.length) throw new Error("文生/首尾帧工作流不吃参考视频/音频，请选「参考图 / 参考视频」模式");
    if (meta.frames) {
      const first = images[0], last = spec.lastFrame || images[1];
      if (first) { wf["900"] = { class_type: "LoadImage", inputs: { image: first } }; wf[hn].inputs.first_frame = ["900", 0]; expectedRefs++; }
      if (last) { wf["901"] = { class_type: "LoadImage", inputs: { image: last } }; wf[hn].inputs.last_frame = ["901", 0]; expectedRefs++; }
      if (!first && !last) throw new Error("首帧模式至少需要一张首帧图");
    } else if (images.length) throw new Error("文生视频不吃参考图；要用图请选首帧或参考模式");
  }
  // Acceleration LoRA: keep the template's, swap the file, change strength, or remove the node entirely
  // (then the sigma-shift node takes the raw UNet and the caller should use many more steps).
  const loraNodes = nodesOf(wf, "LoraLoaderModelOnly");
  const lora = spec.lora || null;
  if (lora && loraNodes.length) {
    if (lora.disabled) {
      const ln = loraNodes[0]; const upstream = wf[ln].inputs.model;
      for (const [id, node] of Object.entries(wf)) for (const [k, v] of Object.entries(node.inputs || {})) if (Array.isArray(v) && v[0] === ln) wf[id].inputs[k] = upstream;
      for (const ln2 of loraNodes) delete wf[ln2];
    } else {
      if (lora.name) { if (!/^[\w./ -]+\.safetensors$/i.test(lora.name)) throw new Error("LoRA 文件名不合法"); wf[loraNodes[0]].inputs.lora_name = lora.name; }
      if (lora.strength != null) wf[loraNodes[0]].inputs.strength_model = Math.max(0, Math.min(2, Number(lora.strength)));
    }
  }
  const steps = spec.steps || meta.steps;
  for (const n of nodesOf(wf, "BasicScheduler")) wf[n].inputs.steps = steps;
  const seed = Number.isInteger(spec.seed) ? spec.seed : Math.floor(Math.random() * 2 ** 31);
  for (const n of nodesOf(wf, "RandomNoise")) wf[n].inputs.noise_seed = seed;
  for (const n of nodesOf(wf, "SaveVideo")) wf[n].inputs.filename_prefix = spec.prefix || "h3studio";
  return { workflow: wf, h3Node: hn, length, seed, steps, expectedRefs };
}

/** Which reference keys actually reached the H3 node, read back from /history. */
export function checkRefs(historyRecord, h3Node, expectedRefs) {
  const inputs = historyRecord?.prompt?.[2]?.[h3Node]?.inputs || {};
  const got = Object.keys(inputs).filter((k) => /^(ref_images|ref_videos|ref_video_audios|ref_audios|first_frame|last_frame)/.test(k));
  return { expected: expectedRefs, received: got, ok: got.length >= expectedRefs };
}
