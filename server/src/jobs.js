// Job manager: one job = one H3 generation. Pipeline:
//   queued → starting (GPU power-on if needed) → uploading (references) → submitted → running
//   → downloading → done | error | cancelled
// Uploads + submissions are serialised (the reverse tunnel is a single SSH channel and a big
// reference video saturates it); execution tracking is concurrent (ComfyUI queues internally).
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { refAdvice } from "./refadvice.js";
import { buildWorkflow, checkRefs, WORKFLOWS } from "./workflows.js";

const nowS = () => Math.floor(Date.now() / 1000);
const ACTIVE = new Set(["queued", "starting", "uploading", "submitted", "running", "downloading"]);

export class Jobs {
  constructor(config, comfy, power, media, events, projects) {
    this.config = config; this.comfy = comfy; this.power = power; this.media = media; this.events = events; this.projects = projects;
    this.root = path.join(config.dataDir, "jobs");
    this.jobs = new Map();
    this.chain = Promise.resolve();     // serialises upload+submit
    this.uploads = new Map();           // assetId → { remote, bootSince }
    this.pollTimer = null;
  }
  dir(id) { return path.join(this.root, id); }
  outputPath(id) { const j = this.jobs.get(id); return j?.output?.file ? path.join(this.dir(id), j.output.file) : null; }
  hasActive() { for (const j of this.jobs.values()) if (ACTIVE.has(j.status)) return true; return false; }
  list({ projectId = null, limit = 200, clipId = null, groupId = null } = {}) {
    let arr = [...this.jobs.values()];
    if (projectId) arr = arr.filter((j) => j.projectId === projectId);
    if (clipId) arr = arr.filter((j) => j.clipId === clipId);
    if (groupId) arr = arr.filter((j) => j.groupId === groupId);
    return arr.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map((j) => this.decorate(j));
  }
  get(id) { const j = this.jobs.get(id); if (!j) throw Object.assign(new Error("任务不存在"), { status: 404 }); return j; }
  /** Batch groups (seed sweeps / prompt variants) with completion counts. */
  groups({ projectId = null, limit = 50 } = {}) {
    const m = new Map();
    for (const j of this.jobs.values()) {
      if (!j.groupId || (projectId && j.projectId !== projectId)) continue;
      const g = m.get(j.groupId) || { id: j.groupId, title: j.groupTitle || j.title, projectId: j.projectId, count: 0, done: 0, active: 0, createdAt: j.createdAt };
      g.count++; if (j.status === "done") g.done++; if (ACTIVE.has(j.status)) g.active++; g.createdAt = Math.min(g.createdAt, j.createdAt);
      m.set(j.groupId, g);
    }
    return [...m.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
  /** Queue several jobs at once: `count` seeds from `seedStart` (or `seeds`), and/or prompt `variants`. */
  async createBatch(spec, { count = 0, seeds = null, seedStart = null, variants = null, title = "" } = {}) {
    const groupId = `g_${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
    const base = String(spec.prompt || "");
    const prompts = variants && variants.length ? variants.map((v) => (base.includes("{{v}}") ? base.replaceAll("{{v}}", v) : (base.trim() ? base.replace(/\s+$/, "") + "\n" + v : v))) : [base];
    let seedList = Array.isArray(seeds) && seeds.length ? seeds.map(Number) : null;
    if (!seedList) { const n = Math.max(1, Math.min(24, Number(count) || 1)); const s0 = Number.isInteger(seedStart) ? seedStart : Math.floor(Math.random() * 2 ** 30); seedList = Array.from({ length: n }, (_, i) => s0 + i); }
    if (prompts.length * seedList.length > 48) throw new Error("一次最多 48 条");
    const groupTitle = title || spec.title || `批量 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
    const out = []; let idx = 0;
    for (const [pi, prompt] of prompts.entries()) for (const seed of seedList) {
      idx++;
      out.push(await this.create({ ...spec, prompt, seed, title: `${groupTitle} #${idx}` + (prompts.length > 1 ? ` 变体${pi + 1}` : "") + ` seed ${seed}`, groupId, groupIndex: idx, groupTitle }));
    }
    return { groupId, title: groupTitle, jobs: out };
  }
  /** Contact sheet of a group's finished jobs (one poster frame each, 3 per row). */
  async sheet(groupId) {
    const jobs = this.list({ groupId, limit: 100 }).filter((j) => j.status === "done" && j.output?.poster).sort((a, b) => (a.groupIndex || 0) - (b.groupIndex || 0));
    if (!jobs.length) throw Object.assign(new Error("这组还没有完成的任务"), { status: 404 });
    const files = jobs.map((j) => path.join(this.dir(j.id), j.output.poster));
    const key = crypto.createHash("md5").update(files.join("|")).digest("hex").slice(0, 8);
    const out = path.join(this.root, `_sheet_${groupId}_${key}.jpg`);
    if (!fs.existsSync(out)) await this.media.tile(files, out, { cols: Math.min(3, files.length), width: 400 });
    return { file: out, jobs: jobs.map((j) => ({ id: j.id, seed: j.seed, title: j.title, groupIndex: j.groupIndex })) };
  }

  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    for (const d of await fsp.readdir(this.root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try { const j = JSON.parse(await fsp.readFile(path.join(this.dir(d.name), "job.json"), "utf8")); this.jobs.set(j.id, j); } catch {}
    }
    // Jobs interrupted by a restart: resume tracking if they were already on the GPU; re-queue the rest
    // (uploads are idempotent, so a deploy in the middle of a 5-minute upload no longer costs the user the job).
    const requeue = [...this.jobs.values()].filter((j) => ["queued", "starting", "uploading"].includes(j.status)).sort((a, b) => a.createdAt - b.createdAt);
    for (const j of this.jobs.values()) {
      if (["submitted", "running", "downloading"].includes(j.status) && j.promptId) { j.status = "submitted"; j.log.push(line("服务重启，继续跟踪 GPU 上的任务")); await this.persist(j); }
    }
    for (const j of requeue) { j.status = "queued"; j.progress = null; j.log.push(line("服务重启，自动重新排队")); await this.persist(j); this.chain = this.chain.then(() => this.run(j)).catch(() => {}); }
    this.events.on("comfy.message", (m) => this.onMessage(m).catch(() => {}));
    this.pollTimer = setInterval(() => this.poll().catch(() => {}), 10_000);
  }

  async persist(j) {
    // Serialised per job with a unique temp name: progress events and pipeline steps write concurrently.
    const prev = this.writes?.get(j.id) || Promise.resolve();
    const task = prev.then(async () => {
      await fsp.mkdir(this.dir(j.id), { recursive: true });
      const tmp = path.join(this.dir(j.id), `job.json.${crypto.randomBytes(3).toString("hex")}.tmp`);
      await fsp.writeFile(tmp, JSON.stringify(j, null, 1));
      await fsp.rename(tmp, path.join(this.dir(j.id), "job.json"));
    });
    (this.writes ||= new Map()).set(j.id, task.catch(() => {}));
    await task;
    this.events.emitAll("job", this.decorate(j));
  }
  async set(j, patch, logLine) {
    // Time every stage as it happens: "why did this take four minutes" is otherwise unanswerable, and the
    // answer is usually the upload or the wait for ComfyUI rather than the sampling everyone assumes.
    if (patch.status && patch.status !== j.status) {
      const now = nowS();
      j.timeline ||= [];
      const prev = j.timeline.at(-1);
      if (prev && prev.until == null) { prev.until = now; prev.seconds = now - prev.at; }
      j.timeline.push({ stage: j.status, at: j.startedAt || j.createdAt, until: null, seconds: null, next: patch.status });
      j.timeline.at(-1).stage = patch.status; j.timeline.at(-1).at = now; delete j.timeline.at(-1).next;
      if (["done", "error", "cancelled"].includes(patch.status)) { const l = j.timeline.at(-1); l.until = now; l.seconds = 0; }
      j.gpuAtStages ||= {};
      const u = this.power?.usage?.series?.at(-1);
      const v = this.power?.status?.stats?.vram;                       // before the first aggregate lands
      if (u) j.gpuAtStages[patch.status] = { util: u.util, vramMib: u.vram, powerW: u.powerW };
      else if (v) j.gpuAtStages[patch.status] = { util: v.util ?? 0, vramMib: v.used ?? 0, powerW: Math.round(v.powerW ?? 0) };
    }
    Object.assign(j, patch);
    if (logLine) j.log.push(line(logLine));
    await this.persist(j);
  }

  /** Utilisation seen by the power probe over the job's own window, so a job can be told apart from an idle card. */
  gpuDuring(j) {
    const series = this.power?.usage?.series || [];
    const from = j.startedAt || j.createdAt, to = j.finishedAt || nowS();
    const win = series.filter((s) => s.at >= from && s.at <= to);
    if (!win.length) return null;
    const utils = win.map((s) => s.util);
    return { samples: win.length, utilAvg: +(utils.reduce((a, b) => a + b, 0) / utils.length).toFixed(1), utilMax: Math.max(...utils),
             vramMaxMib: Math.max(...win.map((s) => s.vram)), powerMaxW: Math.max(...win.map((s) => s.powerW)) };
  }
  /** ComfyUI reports failures per node; a bare message loses the node, its class and the exception. */
  async comfyError(j) {
    if (!j.promptId) return null;
    try {
      const h = await this.comfy.history(j.promptId);
      const rec = h?.[j.promptId] || Object.values(h || {})[0];
      const msgs = rec?.status?.messages || [];
      const err = msgs.find((m) => m[0] === "execution_error")?.[1];
      if (!err) return null;
      return { node: err.node_id, type: err.node_type, exception: `${err.exception_type || ""}: ${err.exception_message || ""}`.trim(),
               traceback: (err.traceback || []).slice(-4).join("").slice(0, 600) };
    } catch { return null; }
  }

  async fail(j, message) {
    const detail = await this.comfyError(j).catch(() => null);
    if (detail) {
      j.errorDetail = detail;
      message = `${message}｜节点 ${detail.node}（${detail.type}）：${detail.exception}`.slice(0, 500);
    }
    const g = this.gpuDuring(j);
    if (g) j.log.push(line(`失败时的显卡：利用率均 ${g.utilAvg}% 峰 ${g.utilMax}%，显存峰 ${(g.vramMaxMib / 1024).toFixed(1)} G`));
    await this.set(j, { status: "error", error: message, finishedAt: nowS() }, "失败：" + message); this.events.emitAll("toast", { level: "error", text: `${j.title}：${message}` }); }

  /** spec: { projectId, clipId, take, title, workflow, prompt, width, height, seconds|length, steps, seed, refSize,
   *          images:[assetId], lastFrame, videos:[assetId], videoAudio, audios:[assetId], lora, tags, groupId, groupIndex, groupTitle } */
  async create(spec) {
    const p = this.projects.get(spec.projectId || "default");
    const workflow = WORKFLOWS[spec.workflow] ? spec.workflow : "native_t2v";
    const meta = WORKFLOWS[workflow];
    let width = Number(spec.width) || 832, height = Number(spec.height) || 448;
    let length = spec.length ? Number(spec.length) : Math.round((Number(spec.seconds) || 5) * 24);
    let prompt = String(spec.prompt || "").trim();
    const images = (spec.images || []).filter(Boolean), videos = (spec.videos || []).filter(Boolean), audios = (spec.audios || []).filter(Boolean);
    for (const a of [...images, ...videos, ...audios, spec.lastFrame].filter(Boolean)) this.projects.assetPath(p.id, a); // validates
    let whitemodel = null;
    if (workflow === "whitemodel") {
      // tool job: geometry comes from the source clip, the "prompt" is just a readable summary of the settings
      const { asset } = this.projects.assetPath(p.id, videos[0] || "");
      if (asset.kind !== "video") throw new Error("白模的源素材必须是视频");
      width = asset.width || width; height = asset.height || height; length = asset.frames || Math.round((asset.duration || 0) * (asset.fps || 24)) || length;
      whitemodel = { preset: spec.whitemodel?.preset || "clay", relief: spec.whitemodel?.relief || 0, photo: spec.whitemodel?.photo || 0, ao: spec.whitemodel?.ao || 0, keepAudio: spec.whitemodel?.keepAudio !== false, depthModel: spec.whitemodel?.depthModel || "large" , subjectOnly: !!spec.whitemodel?.subjectOnly, subjectThreshold: Number(spec.whitemodel?.subjectThreshold) || 0.55 };
      prompt = prompt || `[whitemodel] preset=${whitemodel.preset}${whitemodel.relief ? " relief=" + whitemodel.relief : ""}${whitemodel.photo ? " photo=" + whitemodel.photo : ""}${whitemodel.ao ? " ao=" + whitemodel.ao : ""} source=${asset.name}`;
    }
    if (!prompt) throw new Error("提示词不能为空");
    // Validate the workflow now (cheap) so bad sizes fail before we boot a 3.32 CNY/h GPU.
    const lora = spec.lora && (spec.lora.disabled || spec.lora.name || spec.lora.strength != null) ? { name: spec.lora.name || null, strength: spec.lora.strength != null ? Number(spec.lora.strength) : null, disabled: !!spec.lora.disabled } : null;
    // Tell the user what will stop the reference from steering the result, before the GPU spends a minute on it
    const refAssets = images.map((id) => { try { return this.projects.assetPath(p.id, id).asset; } catch { return null; } });
    const advice = refAdvice({ prompt, images, videos, assets: refAssets, width, height });
    const test = buildWorkflow({ workflow, prompt, width, height, length, steps: spec.steps, seed: spec.seed, refSize: spec.refSize, images: images.map((a) => "x"), lastFrame: spec.lastFrame ? "x" : null, videos: videos.map((a) => "x"), videoAudio: !!spec.videoAudio, audios: audios.map((a) => "x"), lora, whitemodel });
    if (test.whitemodel) whitemodel = { ...whitemodel, ...test.whitemodel };
    const id = `j_${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
    const job = { id, projectId: p.id, clipId: spec.clipId || null, take: spec.take || null, title: String(spec.title || (meta.label + " " + new Date().toLocaleTimeString("zh-CN", { hour12: false }))).slice(0, 120), workflow, prompt, width, height, length: test.length, seconds: +(test.length / 24).toFixed(2), steps: test.steps, seed: test.seed, refSize: meta.refs ? (spec.refSize === "match" ? "match" : "max") : null, images, lastFrame: spec.lastFrame || null, videos, videoAudio: !!spec.videoAudio, audios, lora, whitemodel, groupId: spec.groupId || null, groupIndex: spec.groupIndex || null, groupTitle: spec.groupTitle || null, status: "queued", progress: null, promptId: null, h3Node: test.h3Node, expectedRefs: test.expectedRefs, refCheck: null, error: null, createdAt: nowS(), startedAt: null, submittedAt: null, finishedAt: null, elapsed: null, output: null, log: [line("已创建")], tags: spec.tags || [] };
    if (advice.length) {
      job.advice = advice;
      for (const a of advice.filter((x) => x.level !== "info")) job.log.push(line(`提醒：${a.text}${a.fix ? " — " + a.fix : ""}`));
    }
    this.jobs.set(id, job);
    await this.persist(job);
    if (job.clipId) await this.projects.recordTake(job.projectId, job.clipId, job.id).catch(() => {});
    this.chain = this.chain.then(() => this.run(job)).catch(() => {});
    return this.decorate(job);
  }

  /** Power → upload → submit. Runs one at a time. */
  async run(j) {
    if (j.status !== "queued") return;
    try {
      await this.set(j, { status: "starting", startedAt: nowS() }, "检查 GPU…");
      await this.power.ensureOn((msg) => this.set(j, {}, msg));
      if (j.status === "cancelled") return;
      // video always wins the card: evict llm/voice if loaded and make sure ComfyUI is up before uploading
      if (this.models) await this.models.ensure(j.workflow === "whitemodel" ? "whitemodel" : "video", null, (msg) => this.set(j, {}, msg));
      if (j.status === "cancelled") return;
      await this.set(j, { status: "uploading" }, "上传参考素材…");
      const remote = async (aid) => {
        const { asset, file, localReady } = this.projects.assetPath(j.projectId, aid);
        const key = `${aid}`;
        const cached = this.uploads.get(key);
        if (cached && cached.bootSince === this.power.status.since) return cached.remote;
        // the browser uploaded straight to the box: the bytes are already in ComfyUI's input dir
        if (asset.gpu && asset.gpuName && this.direct?.enabled) {
          const ok = await this.direct.meta(aid).then((m) => m?.comfyName || null).catch(() => null);
          if (ok) {
            this.uploads.set(key, { remote: ok, bootSince: this.power.status.since });
            j.log.push(line(`${asset.name} 已在 GPU 上（直传），跳过上传`));
            return ok;
          }
        }
        if (!localReady) await this.projects.localPath(j.projectId, aid);
        // The asset only exists on 13 (uploaded while the box was off). Pushing it over the tunnel is tens
        // of KB/s; the box's own endpoint with parallel slices is an order of magnitude better.
        if (this.direct?.enabled && this.power.status.state === "on") {
          // Fastest first: the box pulls through the Hysteria2 tunnel (6 MB/s measured) — plain TCP is
          // ~24 KB/s per flow in this direction no matter who dials. Parallel TCP slices are the fallback.
          const gname = `h3s_${aid}${path.extname(file)}`;
          try {
            await this.set(j, {}, `让 GPU 经隧道取 ${asset.name}…`);
            const r = await this.direct.pushViaTunnel(file, aid, gname);
            if (r?.comfyName) {
              this.uploads.set(key, { remote: r.comfyName, bootSince: this.power.status.since });
              j.log.push(line(`${asset.name} 经隧道取回（${r.seconds}s，${r.mbps} MB/s）`));
              return r.comfyName;
            }
          } catch (e) { j.log.push(line(`隧道取回失败，改并行推送：${e.message}`)); }
          try {
            await this.set(j, {}, `把 ${asset.name} 并行推给 GPU…`);
            const r = await this.direct.uploadParallel(file, aid, gname);
            if (r?.comfyName) {
              this.uploads.set(key, { remote: r.comfyName, bootSince: this.power.status.since });
              j.log.push(line(`${asset.name} 并行推送完成（${r.streams} 条流，${r.seconds}s）`));
              return r.comfyName;
            }
          } catch (e) { j.log.push(line(`并行推送失败，改走隧道：${e.message}`)); }
        }
        const name = `h3s_${aid}${path.extname(file)}`;
        const size = asset.size || (await fsp.stat(file)).size;
        // the 13 → GPU leg of the tunnel is slow (≈25 KB/s measured); tell the user what to expect and learn the real rate
        const rate = this.uploadRate || 25_000;
        if (size > 300_000) await this.set(j, {}, `上传 ${asset.name}（${(size / 1048576).toFixed(1)} MB，按 ${Math.round(rate / 1024)} KB/s 约 ${Math.max(1, Math.round(size / rate / 60))} 分钟）…`);
        const t0 = Date.now();
        const r = await this.comfy.upload(file, name);
        const secs = (Date.now() - t0) / 1000; if (secs > 2 && size > 300_000) this.uploadRate = Math.round(size / secs);
        this.uploads.set(key, { remote: r, bootSince: this.power.status.since });
        j.log.push(line(`上传 ${asset.name} → ${r}${secs > 2 ? `（${Math.round(secs)} s，${Math.round(size / secs / 1024)} KB/s）` : ""}`));
        return r;
      };
      const images = []; for (const a of j.images) images.push(await remote(a));
      const videos = []; for (const a of j.videos) videos.push(await remote(a));
      const audios = []; for (const a of j.audios || []) audios.push(await remote(a));
      const lastFrame = j.lastFrame ? await remote(j.lastFrame) : null;
      if (j.status === "cancelled") return;
      const built = buildWorkflow({ workflow: j.workflow, prompt: j.prompt, width: j.width, height: j.height, length: j.length, steps: j.steps, seed: j.seed, refSize: j.refSize, prefix: `h3s_${j.id}`, images, lastFrame, videos, videoAudio: j.videoAudio, audios, lora: j.lora || null, whitemodel: j.whitemodel || null });
      const r = await this.comfy.submit(built.workflow);
      await this.set(j, { status: "submitted", promptId: r.prompt_id, submittedAt: nowS(), queueNumber: r.number }, `已提交 ${r.prompt_id.slice(0, 8)}  ${j.width}x${j.height}  ${j.length} 帧 ≈ ${j.seconds}s  steps=${j.steps}  seed=${j.seed}`);
      this.power.status.idleSince = null;
    } catch (e) {
      if (j.status !== "cancelled") await this.fail(j, e.message);
    }
  }

  async onMessage(m) {
    const pid = m.data?.prompt_id;
    if (!pid) return;
    const j = [...this.jobs.values()].find((x) => x.promptId === pid);
    if (!j || !ACTIVE.has(j.status)) return;
    if (m.type === "execution_start") await this.set(j, { status: "running", runStartedAt: nowS(), progress: { value: 0, max: j.steps } }, "开始采样");
    else if (m.type === "progress") { j.progress = { value: m.data.value, max: m.data.max, node: m.data.node }; if (j.status !== "running") j.status = "running"; this.events.emitAll("job", this.decorate(j)); }
    else if (m.type === "executing" && m.data.node) { if (!j.progress) j.progress = { value: 0, max: j.steps }; j.stage = m.data.node; this.events.emitAll("job", this.decorate(j)); }
    else if (m.type === "execution_success" || m.type === "execution_error" || (m.type === "executing" && m.data.node === null)) await this.finalize(j).catch(() => {});
  }

  /** History polling fallback (websocket down, or restart). */
  async poll() {
    const live = [...this.jobs.values()].filter((j) => ["submitted", "running"].includes(j.status) && j.promptId);
    if (!live.length || this.power.status.state !== "on") return;
    for (const j of live) {
      try { const h = await this.comfy.history(j.promptId); if (h[j.promptId]) await this.finalize(j, h[j.promptId]); }
      catch (e) { if (nowS() - (j.submittedAt || nowS()) > 3 * 3600) await this.fail(j, "3 小时没有结果，放弃"); }
    }
  }

  async finalize(j, record = null) {
    if (!["submitted", "running", "downloading"].includes(j.status)) return;
    if (!record) { const h = await this.comfy.history(j.promptId); record = h[j.promptId]; if (!record) return; }
    if (j.status === "downloading") return;
    const st = record.status || {};
    if (st.status_str === "error") {
      let msg = "ComfyUI 执行失败";
      for (const m of st.messages || []) if (m[0] === "execution_error") { const d = m[1]; msg = `${d.node_type}: ${String(d.exception_message).slice(0, 300)}`; if (/invalid for input of size/.test(msg)) msg += "（宽高不是 32 的倍数？）"; if (/out of memory/i.test(msg)) msg += "（显存不够：降分辨率/帧数，或参考图用 match）"; }
      return this.fail(j, msg);
    }
    const outs = Object.values(record.outputs || {}).flatMap((o) => [...(o.videos || []), ...(o.images || [])]).filter((im) => /\.(mp4|webm|mov)$/i.test(im.filename));
    if (!outs.length) return this.fail(j, "任务完成但没有视频产物");
    await this.set(j, { status: "downloading", refCheck: checkRefs(record, j.h3Node, j.expectedRefs) }, "下载成片…");
    try {
      const dest = path.join(this.dir(j.id), "output.mp4");
      await this.comfy.download(outs[0], dest);
      const info = await this.media.probe(dest);
      await this.media.poster(dest, path.join(this.dir(j.id), "poster.jpg"), 480).catch(() => null);
      await this.media.strip(dest, path.join(this.dir(j.id), "strip.jpg")).catch(() => null);
      const elapsed = nowS() - (j.startedAt || j.createdAt);
      const warn = j.refCheck && !j.refCheck.ok ? `警告：节点只收到 ${j.refCheck.received.join(", ") || "无"}，参考没全进模型` : null;
      await this.set(j, { status: "done", finishedAt: nowS(), elapsed, output: { file: "output.mp4", poster: "poster.jpg", strip: "strip.jpg", duration: +info.duration.toFixed(2), width: info.width, height: info.height, size: (await fsp.stat(dest)).size, remote: outs[0].filename }, warning: warn }, `完成，耗时 ${elapsed}s` + (warn ? "；" + warn : ""));
      this.events.emitAll("toast", { level: warn ? "warn" : "ok", text: `${j.title} 完成` + (warn ? "（参考未全部生效）" : "") });
    } catch (e) { await this.fail(j, "下载失败：" + e.message); }
  }

  async cancel(id) {
    const j = this.get(id);
    if (!ACTIVE.has(j.status)) throw new Error("任务已结束");
    if (j.promptId && this.power.status.state === "on") {
      try {
        const q = await this.comfy.queue();
        if (q.queue_running.some((x) => x[1] === j.promptId)) await this.comfy.interrupt();
        else await this.comfy.deleteQueued([j.promptId]);
      } catch {}
    }
    await this.set(j, { status: "cancelled", finishedAt: nowS() }, "已取消");
    return this.decorate(j);
  }
  async remove(id) {
    const j = this.get(id);
    if (ACTIVE.has(j.status)) await this.cancel(id).catch(() => {});
    this.jobs.delete(id);
    await fsp.rm(this.dir(id), { recursive: true, force: true });
    this.events.emitAll("job", { id, deleted: true });
    if (j.clipId) { try { const { p, c } = this.projects.clip(j.projectId, j.clipId); c.takes = c.takes.filter((t) => t !== id); if (c.pick === id) c.pick = c.takes.at(-1) || null; await this.projects.save(p); } catch {} }
  }
  /** Estimated seconds for a job like this one, from history (same workflow, similar pixel×frame volume). */
  estimate(j) { return this.estimateSpec({ workflow: j.workflow, width: j.width, height: j.height, length: j.length, steps: j.steps, refs: (j.images?.length || 0) + (j.videos?.length || 0) + (j.audios?.length || 0) }); }
  estimateSpec({ workflow = "native_ref2va", width = 832, height = 448, length = 124, steps = 8, refs = 0 }) {
    // white-model: measured 159 s for 1760 frames of 720p on the 5090 (depth 31 fps + shading 22 fps) → ≈ 0.09 s per 720p frame
    if (workflow === "whitemodel") return Math.round(20 + 0.09 * length * Math.max(0.3, (width * height) / (1280 * 720)));
    const vol = width * height * length;
    const same = [...this.jobs.values()].filter((x) => x.status === "done" && x.elapsed && x.workflow === workflow && Math.abs(x.width * x.height * x.length - vol) / vol < 0.25);
    if (same.length) return Math.round(same.slice(-5).reduce((s, x) => s + x.elapsed, 0) / Math.min(5, same.length));
    const px = vol / (832 * 448 * 124);
    return Math.round(45 + 60 * px * (steps / 4) + refs * 20);
  }
  /** Estimate for an item of the ComfyUI queue (ours → history-based; foreign → heuristic from its geometry). */
  estimateFor(item) {
    const own = [...this.jobs.values()].find((j) => j.promptId === item.promptId);
    if (own) return this.estimate(own);
    return this.estimateSpec({ workflow: item.weights === "ref2va" ? "native_ref2va" : "native_t2v", width: item.width, height: item.height, length: item.length, steps: item.steps });
  }
  /** Seconds until the whole ComfyUI queue drains (running item counted by its remaining time). */
  queueEta(items) {
    let total = 0;
    for (const it of items || []) {
      const own = [...this.jobs.values()].find((j) => j.promptId === it.promptId);
      total += own ? this.remaining(own) : this.estimateFor(it);
    }
    return Math.round(total);
  }
  /** Remaining seconds for one of our jobs, from progress or elapsed run time. */
  remaining(j) {
    const est = this.estimate(j);
    if (j.status === "running") {
      if (j.progress?.max) return Math.max(5, Math.round(est * (1 - j.progress.value / j.progress.max) * 0.8 + 10));
      return Math.max(5, est - (nowS() - (j.runStartedAt || nowS())));
    }
    return est;
  }
  /** Public job view + live queue position / ETA. */
  decorate(j) {
    const out = pub(j);
    out.estimate = this.estimate(j);
    out.gpuDuring = this.gpuDuring(j);
    if (["submitted", "running"].includes(j.status) && j.promptId) {
      const items = this.power.status.queue?.items || [];
      const idx = items.findIndex((x) => x.promptId === j.promptId);
      if (idx >= 0) { out.queuePosition = idx; out.ahead = idx; out.eta = Math.round(items.slice(0, idx).reduce((s, it) => s + this.estimateFor(it), 0) + this.remaining(j)); }
      else { out.queuePosition = null; out.eta = this.remaining(j); }
    } else if (["queued", "starting", "uploading"].includes(j.status)) {
      const items = this.power.status.queue?.items || [];
      out.queuePosition = items.length; out.ahead = items.length;
      out.eta = Math.round(this.queueEta(items) + this.estimate(j) + (this.power.status.state === "on" ? 0 : 120));
    }
    return out;
  }
}

const line = (text) => ({ at: nowS(), text });
export function pub(j) {
  const { log, ...rest } = j;
  return { ...rest, log: log.slice(-30) };
}
