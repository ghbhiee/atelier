import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { Passkeys } from "./passkeys.js";
import { Events } from "./events.js";
import { Comfy } from "./comfy.js";
import { Power } from "./power.js";
import { Media } from "./media.js";
import { Projects } from "./projects.js";
import { Jobs } from "./jobs.js";
import { installApi } from "./api.js";
import { Prompts } from "./prompts.js";
import { Edits } from "./edits.js";
import { Masters } from "./masters.js";
import { Avatars } from "./avatars.js";
import { Storage } from "./storage.js";
import { GpuCtl, MockGpuCtl } from "./gpuctl.js";
import { Direct, Backup, AssetSync } from "./direct.js";
import { Models } from "./models.js";

export async function createApp(config) {
  const store = new Store(config.dataDir, config.tokenPepper);
  await store.init();
  // A box switch survives a restart: GPU_ACTIVE_BOX pins it, otherwise the last one we switched to.
  if (!config.activeBox) {
    const saved = (await store.read()).settings?.activeBox;
    if (saved) { try { config.useBox(saved); } catch (e) { console.log("[fleet] " + e.message); } }
  }
  // The prompt assistant's credentials can be edited in the browser; load what was saved.
  { const a = (await store.read()).settings?.assistant; if (a) config.assistantOverride = { ...a }; }
  const passkeys = new Passkeys(config, store);
  const events = new Events();
  const comfy = new Comfy(config, events);
  const media = new Media(config);
  const projects = new Projects(config, media, events);
  await projects.init();
  let jobs;
  const power = new Power(config, store, comfy, events, { hasActiveJobs: () => jobs?.hasActive() || false, queueEta: (items) => jobs?.queueEta(items) ?? null });
  jobs = new Jobs(config, comfy, power, media, events, projects);
  const gpuctl = new GpuCtl(config, { mock: config.gpuctl.mock ? new MockGpuCtl() : null });
  const models = new Models(config, store, gpuctl, comfy, events, power);
  power.models = models; jobs.models = models;
  // Browser ↔ GPU direct asset transfer + the background mirror back to 13
  const direct = new Direct(config, { power, gpuctl });
  const backup = new Backup(projects, direct, events);
  const assetSync = new AssetSync(projects, direct, events);
  projects.direct = direct; jobs.direct = direct;
  // Real-job hooks for the model test flow (video = tiny H3 clip, whitemodel = synthetic 2 s clip through the node).
  const waitJob = async (id, say, maxMs = 15 * 60_000) => {
    const t0 = Date.now(); let last = "";
    while (Date.now() - t0 < maxMs) {
      const j = jobs.get(id); const line = j.log?.at(-1)?.text || j.status; if (line !== last) { last = line; say(`任务 ${id}: ${line}`); }
      if (["done", "error", "cancelled"].includes(j.status)) return { jobId: id, status: j.status, error: j.error || null, output: j.output ? { duration: j.output.duration, width: j.output.width, height: j.output.height } : null, elapsed: j.elapsed };
      await new Promise((r) => setTimeout(r, 3000));
    }
    return { jobId: id, status: "timeout", error: "15 分钟内没有完成" };
  };
  models.hooks = {
    testVideo: async (say) => { const j = await jobs.create({ projectId: "default", title: "模型测试 · H3 t2v", workflow: "native_t2v", prompt: "integrated_multimodal_description: [Shot 1] Live-action, a static medium shot of a red ceramic teapot on a wooden table by a window, soft daylight. The camera holds a static shot.\n\noverall_soundscape: Quiet room tone.\n\nnon_diegetic_music: N/A", width: 640, height: 384, seconds: 2, tags: ["model-test"] }); return waitJob(j.id, say); },
    testWhitemodel: async (say) => {
      const { execFile } = await import("node:child_process"); const os = await import("node:os");
      const tmp = path.join(os.tmpdir(), `wm-test-${Date.now()}.mp4`);
      await new Promise((res, rej) => execFile(config.ffmpeg, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=24", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", tmp], (e) => e ? rej(e) : res()));
      const a = await projects.addAsset("default", tmp, { name: "模型测试_合成小片.mp4", source: { type: "test" } });
      const j = await jobs.create({ projectId: "default", title: "模型测试 · 白模", workflow: "whitemodel", videos: [a.id], whitemodel: { preset: "clay" }, tags: ["model-test"] });
      return waitJob(j.id, say);
    },
  };
  await jobs.init();
  const prompts = new Prompts(config, events);
  await prompts.init();
  const edits = new Edits(config, projects, jobs, media, events);
  const masters = new Masters(config, projects, jobs, media, events); masters.init();
  const avatars = new Avatars(config, projects, jobs, media, events); avatars.init();
  const storage = new Storage(config, projects, jobs);
  comfy.startWatching();
  power.startLoop();
  // anything the browser left on the GPU still needs its copy here (e.g. we restarted mid-pull)
  setTimeout(() => { const n = backup.sweep(); if (n) console.log(`[backup] ${n} 个素材待同步回 13`); }, 5_000);
  setTimeout(() => projects.sweepPending().catch(() => {}), 20_000);
  // keep the box's material in step with ours whenever it is up — the fleet is only interchangeable if
  // whichever machine we start today already has the same assets on it
  setInterval(async () => {
    if (power.status.state !== "on" || jobs.hasActive() || !direct.enabled) return;
    const c = await assetSync.compare().catch(() => null);
    if (c?.available && c.missingOnBox.length) { console.log(`[assetsync] GPU 缺 ${c.missingOnBox.length} 个素材，后台补齐`); assetSync.sync({ pull: false, limit: 5 }).catch(() => {}); }
  }, 5 * 60_000);
  setInterval(() => projects.sweepPending().catch(() => {}), 30 * 60_000);
  prompts.startScheduler();

  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = path.resolve(here, "../../web");
  const webauthnBundle = path.join(path.dirname(fileURLToPath(import.meta.resolve("@simplewebauthn/browser"))), "../dist/bundle/index.umd.min.js");

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
      // External https: is allowed for img/media/connect so the prompt library can show OpenPrompt's thumbnails and play its videos (HLS via hls.js fetches segments).
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
    next();
  });
  app.get("/healthz", (_req, res) => res.json({ status: "ok", version: config.version, basePath: config.basePath, activeJobs: [...jobs.jobs.values()].filter((j) => ["queued", "starting", "uploading", "submitted", "running", "downloading"].includes(j.status)).length, busy: !!models.state.busy }));
  const root = express.Router();
  installApi(root, { config, store, passkeys, power, jobs, projects, events, media, comfy, prompts, edits, masters, avatars, storage, models, gpuctl, direct, backup, assetSync, webDir, webauthnBundle });
  if (config.basePath) {
    // Express routing is not slash-strict: app.get("/studio") would also swallow "/studio/" and loop.
    app.use((req, res, next) => { const p = req.originalUrl.split("?")[0]; if (p === "/" || p === config.basePath) return res.redirect(302, config.basePath + "/"); next(); });
  }
  app.use(config.basePath || "/", root);
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error, _req, res, _next) => {
    if (error?.type === "entity.too.large") return res.status(413).json({ error: "payload_too_large" });
    if (error?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
    console.error(error);
    if (!res.headersSent) res.status(500).json({ error: error.message || "server_error" });
  });
  const httpServer = http.createServer(app);
  httpServer.requestTimeout = 0; httpServer.headersTimeout = 120_000;
  return { app, httpServer, store, passkeys, power, jobs, projects, events, comfy, media, prompts };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const config = loadConfig();
  const { httpServer, power, comfy, jobs, prompts } = await createApp(config);
  httpServer.listen(config.port, config.host, () => console.log(`Atelier ${config.version} listening on ${config.host}:${config.port} (${config.publicOrigin}) comfy=${config.comfyUrl}`));
  const shutdown = () => { power.stopLoop(); comfy.stopWatching(); clearInterval(jobs.pollTimer); clearInterval(prompts.timer); httpServer.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}
