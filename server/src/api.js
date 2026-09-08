// HTTP API + auth pages. Everything under /api and the SPA itself require a passkey session.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { spawn } from "node:child_process";
import { WORKFLOWS, SIZE_PRESETS, QUALITY, alignLength } from "./workflows.js";
import { draftPrompt, promptRules } from "./llm.js";
import { shareFile } from "./share.js";

const COOKIE = "h3s";
const jsonErr = (res, e, status = 400) => res.status(e.status || status).json({ error: e.message || String(e) });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => jsonErr(res, e));
const cookieOf = (req) => (req.headers.cookie || "").split(";").map((s) => s.trim()).find((s) => s.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) || null;

class Limiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  middleware() { return (req, res, next) => { const now = Date.now(); const key = req.ip; const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs); if (arr.length >= this.max) return res.status(429).json({ error: "too many attempts, slow down" }); arr.push(now); this.hits.set(key, arr); next(); }; }
  reset(ip) { this.hits.delete(ip); }
}

export function installApi(app, ctx) {
  const { config, passkeys, power, jobs, projects, events, media, webDir, webauthnBundle } = ctx;
  const authLimiter = new Limiter(30, 10 * 60_000), regLimiter = new Limiter(10, 60 * 60_000);

  // ---- session middleware ------------------------------------------------------------------
  app.use(async (req, res, next) => {
    const bearer = (req.headers.authorization || "").match(/^Bearer\s+((?:atl|h3s)_[A-Za-z0-9_-]+)$/)?.[1];
    if (bearer) { req.session = await passkeys.resolveApiKey(bearer).catch(() => null); req.viaKey = true; return next(); }
    const tok = cookieOf(req);
    req.session = config.devSessionToken && tok === config.devSessionToken ? { label: "dev", passkeyId: "dev", createdAt: 0 } : await passkeys.resolveSession(tok).catch(() => null);
    next();
  });
  const requireSession = (req, res, next) => {
    if (req.session) return next();
    if ((req.baseUrl + req.path).startsWith(config.basePath + "/api")) return res.status(401).json({ error: "unauthorized" });
    res.redirect(302, config.basePath + "/login");
  };

  // ---- auth pages & endpoints --------------------------------------------------------------
  if (config.devSessionToken) app.get("/dev-login", (req, res) => { if (req.query.token !== config.devSessionToken) return res.status(403).send("bad token"); res.set("Set-Cookie", `${COOKIE}=${config.devSessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`); res.redirect(302, config.basePath + "/"); });
  for (const f of ["app.css", "login.js", "vendor_hls.min.js"]) app.get(`/${f}`, (_req, res) => res.sendFile(path.join(webDir, f)));
  app.get("/login", (req, res) => { if (req.session) return res.redirect(302, config.basePath + "/"); res.sendFile(path.join(webDir, "login.html")); });
  app.get("/healthz", (_req, res) => res.json({ status: "ok", version: config.version, basePath: config.basePath }));
  app.get("/static/webauthn.js", (_req, res) => res.set("Cache-Control", "public, max-age=86400").sendFile(webauthnBundle));
  const auth = express.Router();
  auth.use(express.json({ limit: "64kb" }));
  auth.post("/options", authLimiter.middleware(), wrap(async (req, res) => res.json(await passkeys.beginAuthentication())));
  auth.post("/verify", authLimiter.middleware(), wrap(async (req, res) => {
    const pk = await passkeys.finishAuthentication({ challengeId: req.body?.challengeId, response: req.body?.response });
    const token = await passkeys.createSession(pk, { ip: req.ip, userAgent: req.get("user-agent") });
    res.set("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly;${config.publicOrigin.startsWith("https") ? " Secure;" : ""} SameSite=Lax; Max-Age=${config.sessionTtl}`);
    authLimiter.reset(req.ip);
    res.json({ ok: true, passkey: pk.label });
  }));
  auth.post("/register/options", regLimiter.middleware(), wrap(async (req, res) => res.json(await passkeys.beginRegistration({ label: req.body?.label, ip: req.ip, userAgent: req.get("user-agent") }))));
  auth.post("/register/verify", regLimiter.middleware(), wrap(async (req, res) => res.json(await passkeys.finishRegistration({ enrollmentId: req.body?.enrollmentId, response: req.body?.response }))));
  auth.get("/register/:id", wrap(async (req, res) => res.json(await passkeys.enrollmentStatus(req.params.id))));
  auth.post("/logout", wrap(async (req, res) => { await passkeys.destroySession(cookieOf(req)); res.set("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`); res.json({ ok: true }); }));
  auth.get("/state", wrap(async (req, res) => res.json({ registered: Object.keys((await ctx.store.read()).passkeys).length, session: req.session ? { label: req.session.label } : null, rpName: config.rpName })));
  app.use("/auth", auth);

  // ---- API ------------------------------------------------------------------------------------
  const api = express.Router();
  api.use(requireSession);
  api.get("/events", events.handler());
  api.get("/me", (req, res) => res.json({ label: req.session.label, since: req.session.createdAt, kind: req.session.kind || "passkey" }));
  // API keys (for agents / scripts): created from a passkey session, shown once.
  api.get("/keys", wrap(async (_req, res) => res.json(await passkeys.listApiKeys())));
  api.post("/keys", express.json(), wrap(async (req, res) => { if (req.session.kind === "apikey") throw Object.assign(new Error("API key 不能再创建 API key，请用 Passkey 登录"), { status: 403 }); res.json(await passkeys.createApiKey({ label: req.body?.label, by: req.session.label })); }));
  api.delete("/keys/:id", wrap(async (req, res) => res.json(await passkeys.revokeApiKey(req.params.id))));
  api.get("/keys/:id/reveal", wrap(async (req, res) => { if (req.session.kind === "apikey") throw Object.assign(new Error("API key 不能查看其它密钥，请用网页登录"), { status: 403 }); res.json(await passkeys.revealApiKey(req.params.id)); }));
  // Absolute endpoints for the 接入 page and for agent onboarding prompts.
  const endpoints = async () => {
    const pub = config.publicOrigin + config.basePath;
    const c = await ctx.models.catalog(); const d = await ctx.models.defaults(); const loaded = ctx.models.state.loaded;
    const ctxOf = (m) => { const a = m.args || []; const i = a.indexOf("-c"); const n = i >= 0 ? Number(a[i + 1]) : null; return n ? (n >= 1024 ? Math.round(n / 1024) + "k" : String(n)) : null; };
    const byMod = (mod) => c.models.filter((m) => m.modality === mod).map((m) => ({ id: m.id, name: m.name, tested: !!m.tested, loaded: loaded[mod]?.modelId === m.id, default: d[mod] === m.id, ctx: ctxOf(m), quant: m.quant || null, vram: m.vram || null }));
    // saved / sample voices come from the voice service when it is up; built-in voices always from the catalogue
    let voices = { saved: [], samples: [], live: false };
    if (loaded.voice) { try { const r = await fetch(`${config.voiceUpstream}/voices`, { signal: AbortSignal.timeout(4000) }); if (r.ok) { const j = await r.json(); voices = { saved: (j.saved || []).map((v) => ({ id: v.id, name: v.name, seconds: v.seconds, refText: v.refText })), samples: (j.samples || []).map((v) => ({ id: v.id, name: v.name })), live: true }; } } catch {} }
    const voiceModels = byMod("voice").map((m) => { const full = c.models.find((x) => x.id === m.id) || {}; return { ...m, clone: !!full.clone, builtin: full.voices || [], controls: full.controls || [] }; });
    return { app: pub + "/", api: pub + "/api", docs: pub + "/api/v1/docs", openapi: pub + "/api/v1/openapi.json", llm: pub + "/llm/v1", voice: pub + "/voice", speech: pub + "/llm/v1/audio/speech", transcriptions: pub + "/llm/v1/audio/transcriptions",
      llmModel: d.llm || null, voiceModel: d.voice || null, models: { llm: byMod("llm"), voice: voiceModels, video: byMod("video"), whitemodel: byMod("whitemodel") }, voices, defaults: d,
      skillPath: "~/.claude/skills/atelier/scripts/atl.py", configPath: "~/.config/atelier/config.json" };
  };
  api.get("/endpoints", wrap(async (_req, res) => res.json(await endpoints())));
  api.get("/meta", wrap(async (_req, res) => res.json({ version: config.version, workflows: WORKFLOWS, sizes: SIZE_PRESETS, quality: QUALITY, llm: !!config.llm, llmModel: config.llm?.model || null, tagModel: config.llm?.fastModel || null, embed: !!config.embed, embedModel: config.embed?.model || null, openprompt: config.openprompt.url, fileshare: !!config.fileshare, canControl: !!(config.compshare?.instanceId), rulesUrl: config.promptRulesUrl.replace(/\.md$/, ""), fontName: config.fontName, ffmpeg: await media.capabilities() })));
  api.get("/rules", wrap(async (_req, res) => res.type("text/plain").send(await promptRules(config))));
  api.get("/passkeys", wrap(async (_req, res) => res.json(await passkeys.list())));
  // ---- model manager --------------------------------------------------------------------
  api.get("/models", wrap(async (_req, res) => res.json(await ctx.models.snapshot())));
  api.post("/models/refresh", wrap(async (_req, res) => { await ctx.models.refresh(); await ctx.models.probeWeights().catch(() => {}); res.json(await ctx.models.snapshot()); }));
  api.post("/models/task", express.json(), wrap(async (req, res) => {
    const c = await ctx.models.catalog(); const t = c.tasks[req.body?.task]; if (!t) throw new Error("未知任务");
    ctx.models.ensure(t.modality, req.body?.modelId || t.default, () => {}).catch((e) => events.emitAll("toast", { level: "error", text: "加载失败：" + e.message }));
    res.json({ ok: true, modality: t.modality, modelId: req.body?.modelId || t.default });
  }));
  api.post("/models/unload", express.json(), wrap(async (req, res) => { const m = req.body?.modality || "all"; if (m === "all") await ctx.models.unloadAll(); else await ctx.models.unload(m); res.json(await ctx.models.snapshot()); }));
  // Load a capability (modality) with its default model — the primary "load" action of the UI.
  api.post("/models/ensure", express.json(), wrap(async (req, res) => {
    const mod = req.body?.modality; if (!(await ctx.models.catalog()).modalities[mod]) throw new Error("未知能力");
    // A human clicking 加载 also sets what comes up on the next power-on; an agent's implicit load does not,
    // unless it says remember:true ("skill 里明确说开机就加载指定模型").
    const remember = !req.viaKey || req.body?.remember === true;
    ctx.models.ensure(mod, req.body?.modelId || null, () => {}, { remember }).catch((e) => events.emitAll("toast", { level: "error", text: "加载失败：" + e.message }));
    res.json({ ok: true, modality: mod, modelId: req.body?.modelId || (await ctx.models.defaults())[mod] || null, remembered: remember });
  }));
  // Which model a modality means by default (what /llm loads, what the dashboard's one-click buttons pick).
  // What lands in VRAM when the box powers on. Default 视频/H3; set {modality:"off"} to boot into nothing.
  api.get("/models/boot", wrap(async (_req, res) => res.json(await ctx.models.bootPref())));
  api.post("/models/boot", express.json(), wrap(async (req, res) => {
    const mod = req.body?.modality;
    if (mod !== "off" && !(await ctx.models.catalog()).modalities[mod]) throw new Error("未知能力");
    res.json(await ctx.models.setBootPref({ modality: mod, modelId: req.body?.modelId || null }));
  }));
  api.post("/models/default", express.json(), wrap(async (req, res) => res.json(await ctx.models.setDefault(req.body?.modality, req.body?.modelId))));
  api.post("/models/:id/load", wrap(async (req, res) => {
    const m = await ctx.models.model(req.params.id); if (!m.tested && !req.query.force) throw new Error("这个模型还没测试过，请先点「测试」");
    ctx.models.ensure(m.modality, m.id, () => {}, { remember: !req.viaKey }).catch((e) => events.emitAll("toast", { level: "error", text: "加载失败：" + e.message }));
    res.json({ ok: true, modality: m.modality, modelId: m.id });
  }));
  api.post("/models/:id/test", wrap(async (req, res) => res.json(await ctx.models.test(req.params.id))));
  api.post("/models/:id/download", wrap(async (req, res) => res.json(await ctx.models.download(req.params.id))));
  api.patch("/models/:id", express.json(), wrap(async (req, res) => { const allowed = {}; for (const k of ["tested", "note", "vram", "args", "hidden", "ctxPin"]) if (k in (req.body || {})) allowed[k] = req.body[k]; await ctx.models.setOverride(req.params.id, allowed); res.json(await ctx.models.model(req.params.id)); }));
  api.get("/models/log/:prog", wrap(async (req, res) => res.json(await ctx.gpuctl.log(req.params.prog, Math.min(400, Number(req.query.lines) || 60)))));
  // Storage & cleanup (dry-run plan, then clean with the same rules)
  api.get("/storage", wrap(async (_req, res) => res.json(await ctx.storage.overview())));
  api.post("/storage/plan", express.json(), wrap(async (req, res) => res.json(await ctx.storage.plan(req.body || {}))));
  api.post("/storage/clean", express.json(), wrap(async (req, res) => { if (!req.body?.confirm) throw new Error("需要 confirm=true"); const r = await ctx.storage.clean(req.body || {}); await ctx.store.update((s) => { s.audit.push({ at: new Date().toISOString(), action: "storage.cleaned", label: req.session?.label || null, ...r, rules: { oldJobsDays: req.body.oldJobsDays ?? null, failedJobs: !!req.body.failedJobs, orphanAssets: !!req.body.orphanAssets } }); }); res.json(r); }));
  // ---- Prompt assistant (DeepSeek by default) -------------------------------------------------
  const maskKey = (k) => (k ? k.slice(0, 5) + "…" + k.slice(-4) : null);
  api.get("/settings/assistant", wrap(async (_req, res) => {
    const l = config.llm;
    res.json({
      configured: !!l, source: l?.source || null,
      baseUrl: l?.baseUrl || "https://api.deepseek.com", model: l?.model || "", fastModel: l?.fastModel || "",
      keyMask: maskKey(l?.apiKey), rulesUrl: config.promptRulesUrl,
      presets: [
        { label: "DeepSeek（官方）", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", fastModel: "deepseek-v4-flash" },
        { label: "本机 GPU 上的 Qwen", baseUrl: (config.publicOrigin + "/llm/v1"), model: "qwen3.8-27b-q4", fastModel: "qwen3.8-27b-q4" },
      ],
    });
  }));
  api.patch("/settings/assistant", express.json(), wrap(async (req, res) => {
    const b = req.body || {};
    const next = { ...(config.assistantOverride || {}) };
    for (const k of ["baseUrl", "model", "fastModel"]) if (typeof b[k] === "string") next[k] = b[k].trim();
    if (typeof b.apiKey === "string" && b.apiKey.trim() && !/^…|…$/.test(b.apiKey)) next.apiKey = b.apiKey.trim();
    if (b.clearKey) delete next.apiKey;
    config.assistantOverride = next;
    await ctx.store.update((st) => { st.settings = st.settings || {}; st.settings.assistant = next; st.audit.push({ at: new Date().toISOString(), action: "settings.assistant", label: req.session?.label || null, model: next.model || null, baseUrl: next.baseUrl || null }); });
    const l = config.llm;
    res.json({ ok: true, configured: !!l, source: l?.source || null, baseUrl: l?.baseUrl, model: l?.model, fastModel: l?.fastModel, keyMask: maskKey(l?.apiKey) });
  }));
  // One real round trip, so "saved" and "works" are not the same claim.
  api.post("/settings/assistant/test", wrap(async (_req, res) => {
    const l = config.llm;
    if (!l) throw new Error("还没配置 API Key");
    const t0 = Date.now();
    const r = await fetch(`${l.baseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${l.apiKey}` },
      body: JSON.stringify({ model: l.model, max_tokens: 24, messages: [{ role: "user", content: "只回复两个字：可用" }] }),
      signal: AbortSignal.timeout(60_000),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${txt.slice(0, 200)}`);
    let reply = ""; try { reply = JSON.parse(txt).choices?.[0]?.message?.content || ""; } catch {}
    res.json({ ok: true, ms: Date.now() - t0, model: l.model, reply: reply.slice(0, 60) });
  }));
  // The H3 prompt rules themselves: the page shows them so they can be pasted into any other agent.
  api.get("/prompt-rules", wrap(async (_req, res) => {
    const { promptRules } = await import("./llm.js");
    const text = await promptRules(config);
    res.json({ url: config.promptRulesUrl, chars: text.length, text });
  }));
  // Audit log
  api.get("/audit", wrap(async (req, res) => { const s = await ctx.store.read(); const n = Math.min(2000, Number(req.query.limit) || 200); const rows = s.audit.slice(-n).reverse(); if (req.query.download) res.attachment(`h3studio-audit-${new Date().toISOString().slice(0, 10)}.json`); res.json(rows); }));
  api.delete("/passkeys/:id", wrap(async (req, res) => res.json(await passkeys.revoke(req.params.id))));

  // GPU
  api.get("/gpu", wrap(async (_req, res) => res.json(await power.snapshot())));
  api.post("/gpu/probe", wrap(async (_req, res) => { await power.probe(); res.json(await power.snapshot()); }));
  if (ctx.gpuctl?.mock) api.post("/_mock/gpuctl", express.json(), (req, res) => { for (const k of ["programs", "util", "procs", "reachable", "net"]) if (k in req.body) ctx.gpuctl.mock[k] = k === "programs" ? { ...ctx.gpuctl.mock.programs, ...req.body.programs } : req.body[k]; res.json({ ok: true }); });
  api.get("/gpu/usage", wrap(async (req, res) => res.json(await power.usageByDay(Math.min(60, Number(req.query.days) || 14)))));
  api.post("/gpu/probe", wrap(async (_req, res) => { await power.probe(); res.json(await power.snapshot()); }));
  api.post("/gpu/start", wrap(async (_req, res) => { power.start().catch((e) => events.emitAll("toast", { level: "error", text: "开机失败：" + e.message })); res.json({ ok: true }); }));
  api.post("/gpu/stop", express.json(), wrap(async (req, res) => { await power.stop({ force: !!req.body?.force, reason: "manual" }); res.json(await power.snapshot()); }));
  api.patch("/gpu/settings", express.json(), wrap(async (req, res) => {
    const b = req.body || {};
    await ctx.store.update((s) => { if (b.hourlyRate !== undefined) s.settings.hourlyRate = Number(b.hourlyRate) || null; if (b.idleMinutes !== undefined) s.settings.idleMinutes = Math.max(1, Number(b.idleMinutes) || 10); if (b.autoOff !== undefined) s.settings.autoOff = !!b.autoOff; if (b.autoOn !== undefined) s.settings.autoOn = !!b.autoOn; });
    res.json(await power.snapshot());
  }));
  api.post("/gpu/queue/clear", wrap(async (_req, res) => { await ctx.comfy.clearQueue(); await ctx.comfy.interrupt().catch(() => {}); res.json({ ok: true }); }));

  // Jobs
  api.get("/jobs", (req, res) => res.json(jobs.list({ projectId: req.query.projectId || null, clipId: req.query.clipId || null, groupId: req.query.groupId || null, limit: Number(req.query.limit) || 200 })));
  api.get("/jobs/groups", (req, res) => res.json(jobs.groups({ projectId: req.query.projectId || null })));
  api.get("/jobs/group/:gid/sheet", wrap(async (req, res) => { const r = await jobs.sheet(req.params.gid); if (req.query.meta) return res.json({ jobs: r.jobs }); res.sendFile(r.file); }));
  api.post("/jobs", express.json({ limit: "512kb" }), wrap(async (req, res) => res.json(await jobs.create(req.body || {}))));
  api.post("/jobs/batch", express.json({ limit: "1mb" }), wrap(async (req, res) => { const b = req.body || {}; res.json(await jobs.createBatch(b.spec || {}, { count: b.count, seeds: b.seeds, seedStart: b.seedStart, variants: Array.isArray(b.variants) ? b.variants.map(String).filter((x) => x.trim()) : null, title: b.title || "" })); }));
  // LoRA files as seen by ComfyUI (cached on disk so the list survives GPU power-offs).
  let loraCache = null; const loraFile = path.join(config.dataDir, "loras.json");
  try { loraCache = JSON.parse(fs.readFileSync(loraFile, "utf8")); } catch {}
  api.get("/loras", wrap(async (req, res) => {
    let live = false;
    if (power.status.state === "on" && (req.query.refresh === "1" || !loraCache || Date.now() / 1000 - loraCache.at > 3600)) {
      try { const items = await ctx.comfy.loras(); loraCache = { items: items.filter((x) => /\.safetensors$/i.test(x)).sort(), at: Math.floor(Date.now() / 1000) }; fs.writeFileSync(loraFile, JSON.stringify(loraCache)); live = true; } catch {}
    }
    res.json({ items: loraCache?.items || [], cachedAt: loraCache?.at || null, live, templates: { native_t2v: "minimax_h3_turbo_4step_ema.safetensors", native_i2v: "minimax_h3_turbo_4step_ema.safetensors", native_ref2va: "minimax_h3_ref2va_acc_8step.safetensors" } });
  }));
  api.get("/jobs/:id", wrap(async (req, res) => { const j = jobs.get(req.params.id); res.json({ ...jobs.decorate(j), log: j.log }); }));
  api.post("/jobs/:id/cancel", wrap(async (req, res) => res.json(await jobs.cancel(req.params.id))));
  api.post("/jobs/:id/rerun", express.json(), wrap(async (req, res) => { const j = jobs.get(req.params.id); const seed = req.body?.newSeed ? undefined : j.seed; res.json(await jobs.create({ projectId: j.projectId, clipId: j.clipId, take: j.take ? j.take + 1 : null, title: `${j.title.replace(/ · 重跑( \d+)?$/, "")} · 重跑`, workflow: j.workflow, prompt: j.prompt, width: j.width, height: j.height, length: j.length, steps: j.steps, seed, refSize: j.refSize, images: j.images, lastFrame: j.lastFrame, videos: j.videos, videoAudio: j.videoAudio, audios: j.audios || [], lora: j.lora || null, tags: j.tags || [], groupId: j.groupId || null, groupTitle: j.groupTitle || null, groupIndex: j.groupIndex || null })); }));
  api.delete("/jobs/:id", wrap(async (req, res) => { await jobs.remove(req.params.id); res.json({ ok: true }); }));
  // Batch delete; running/queued jobs are skipped unless force=true (then they are cancelled first).
  api.post("/jobs/batch-delete", express.json(), wrap(async (req, res) => { const ids = Array.isArray(req.body?.ids) ? req.body.ids : []; let removed = 0, skipped = 0; for (const id of ids) { let j; try { j = jobs.get(id); } catch { skipped++; continue; } if (["queued", "starting", "uploading", "submitted", "running", "downloading"].includes(j.status) && !req.body?.force) { skipped++; continue; } await jobs.remove(id); removed++; } res.json({ removed, skipped }); }));
  const jobFile = (which) => wrap(async (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j.output) throw Object.assign(new Error("还没有产物"), { status: 404 });
    const f = path.join(jobs.dir(j.id), which === "poster" ? j.output.poster : which === "strip" ? j.output.strip : j.output.file);
    // 13 keeps the backup, but the box still has the original: if our copy is gone (or the caller asks for
    // the box explicitly) hand the browser a signed URL straight to the GPU instead of a 404.
    if ((!fs.existsSync(f) || req.query.from === "gpu") && which === "file" && j.output.remote && ctx.direct?.enabled) {
      const info = await ctx.direct.info().catch(() => ({ available: false }));
      if (info.available) return res.redirect(302, `${info.base}/out/${encodeURIComponent(j.output.remote)}?t=${encodeURIComponent(ctx.direct.token("*", "get", 3600))}`);
    }
    if (!fs.existsSync(f)) throw Object.assign(new Error("文件不存在"), { status: 404 });
    if (which === "file" && req.query.download) res.attachment(`${safeName(j.title)}_${j.seed}.mp4`);
    res.sendFile(f, { maxAge: which === "file" ? 0 : 3600_000 });
  });
  api.get("/jobs/:id/file", jobFile("file")); api.get("/jobs/:id/poster", jobFile("poster")); api.get("/jobs/:id/strip", jobFile("strip"));
  api.post("/jobs/:id/frame", express.json(), wrap(async (req, res) => {
    const j = jobs.get(req.params.id); const f = jobs.outputPath(j.id); if (!f) throw new Error("还没有产物");
    const a = await projects.frameAsset(req.body?.projectId || j.projectId, f, { at: Number(req.body?.at) || 0, last: !!req.body?.last, name: req.body?.name, source: { type: "frame", jobId: j.id, at: Number(req.body?.at) || 0, last: !!req.body?.last } });
    res.json(a);
  }));
  api.post("/jobs/:id/share", express.json(), wrap(async (req, res) => {
    const j = jobs.get(req.params.id); const f = jobs.outputPath(j.id); if (!f) throw new Error("还没有产物");
    const r = await shareFile(config, f, { name: `${safeName(j.title)}_${j.seed}.mp4`, permanent: !!req.body?.permanent });
    j.share = r; await jobs.persist(j); res.json(r);
  }));
  api.post("/jobs/:id/clone-to-asset", express.json(), wrap(async (req, res) => {
    const j = jobs.get(req.params.id); const f = jobs.outputPath(j.id); if (!f) throw new Error("还没有产物");
    const a = await projects.addAsset(req.body?.projectId || j.projectId, f, { name: `${safeName(j.title)}.mp4`, kind: "video", source: { type: "output", jobId: j.id }, move: false });
    res.json(a);
  }));

  // Projects
  api.get("/projects", (_req, res) => res.json(projects.list()));
  api.post("/projects", express.json(), wrap(async (req, res) => res.json(await projects.create(req.body || {}))));
  api.get("/projects/:id", wrap(async (req, res) => res.json(projects.get(req.params.id))));
  // Which assets are referenced by something (project refs, clips, edits, avatars, masters, jobs) — the rest are cleanup candidates.
  api.get("/projects/:id/usage", wrap(async (req, res) => { const p = projects.get(req.params.id); const used = ctx.storage.referencedAssets(p); const ids = (p.assets || []).map((a) => a.id); res.json({ referenced: ids.filter((id) => used.has(id)), unreferenced: ids.filter((id) => !used.has(id)) }); }));
  api.patch("/projects/:id", express.json({ limit: "1mb" }), wrap(async (req, res) => res.json(await projects.update(req.params.id, req.body || {}))));
  api.delete("/projects/:id", wrap(async (req, res) => { await projects.remove(req.params.id); res.json({ ok: true }); }));

  // scene.json interop (skill's scene.py format)
  api.get("/projects/:id/export.zip", wrap(async (req, res) => { const r = await projects.exportScene(req.params.id, { jobFile: (id) => jobs.outputPath(id) }); res.attachment(r.name); res.sendFile(r.zip, (err) => { fs.rm(r.zip, { force: true }, () => {}); if (err && !res.headersSent) res.status(500).end(); }); }));
  api.get("/projects/:id/export.json", wrap(async (req, res) => { const r = await projects.exportScene(req.params.id, { jobFile: (id) => jobs.outputPath(id), copyTakes: false }); await new Promise((resolve, reject) => { const c = spawn("python3", ["-c", "import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read('scene.json').decode())", r.zip], { stdio: ["ignore", "pipe", "pipe"] }); let out = ""; c.stdout.on("data", (d) => { out += d; }); c.on("close", (code) => { fs.rm(r.zip, { force: true }, () => {}); if (code) return reject(new Error("export failed")); res.type("json").send(out); resolve(); }); }); }));
  api.put("/projects/:id/import", wrap(async (req, res) => {
    projects.get(req.params.id);
    const name = String(req.query.name || "scene.json"); const isZip = /\.zip$/i.test(name);
    const tmp = path.join(os.tmpdir(), `h3s_imp_${crypto.randomBytes(4).toString("hex")}${isZip ? ".zip" : ".json"}`);
    await new Promise((resolve, reject) => { const ws = fs.createWriteStream(tmp); req.pipe(ws); ws.on("finish", resolve); ws.on("error", reject); req.on("error", reject); });
    try { res.json(await projects.importScene(req.params.id, tmp, { isZip })); } finally { await fsp.rm(tmp, { force: true }); }
  }));

  // Assets: streamed upload (PUT raw body)
  api.put("/projects/:id/assets", wrap(async (req, res) => {
    projects.get(req.params.id);
    const name = String(req.query.name || "upload");
    const len = Number(req.headers["content-length"] || 0);
    if (len > config.maxUploadBytes) throw new Error("文件太大");
    const tmp = path.join(os.tmpdir(), `h3s_up_${crypto.randomBytes(4).toString("hex")}${path.extname(name).toLowerCase()}`);
    await new Promise((resolve, reject) => { const ws = fs.createWriteStream(tmp); req.pipe(ws); ws.on("finish", resolve); ws.on("error", reject); req.on("error", reject); });
    try { res.json(await projects.addAsset(req.params.id, tmp, { name, kind: req.query.kind || null })); }
    finally { await fsp.rm(tmp, { force: true }); }
  }));
  // Serve from 13 when the backup is here; otherwise hand the browser a signed URL straight to the GPU
  // (much faster for the user, and the only way to see an asset 13 has not finished pulling yet).
  const gpuRedirect = async (res, aid, { thumb = false } = {}) => {
    const d = ctx.direct;
    const info = d ? await d.info().catch(() => ({ available: false })) : { available: false };
    if (!info.available) throw Object.assign(new Error("素材还在 GPU 上，但 GPU 现在不可用：" + (info.reason || "")), { status: 409 });
    res.redirect(302, `${info.base}/a/${aid}${thumb ? "/thumb" : ""}?t=${encodeURIComponent(d.token(aid, "get", 3600))}`);
  };
  api.get("/projects/:id/assets/:aid/file", wrap(async (req, res) => {
    const { file, asset, localReady } = projects.assetPath(req.params.id, req.params.aid);
    if (!localReady) return gpuRedirect(res, asset.id);
    if (req.query.download) res.attachment(asset.name);
    res.sendFile(file);
  }));
  api.get("/projects/:id/assets/:aid/thumb", wrap(async (req, res) => {
    const { thumb, file, asset, localReady } = projects.assetPath(req.params.id, req.params.aid);
    if (thumb && fs.existsSync(thumb)) return res.sendFile(thumb, { maxAge: 3600_000 });
    if (localReady) return res.sendFile(file, { maxAge: 3600_000 });
    return gpuRedirect(res, asset.id, { thumb: !!asset.thumb });
  }));
  // Direct upload: 13 allocates the id and a short-lived token, the browser PUTs the bytes to the GPU,
  // then tells us it is done; the backup pull to 13 runs in the background (GPU → 13 is the fast direction).
  // The voice page has to open even when nothing is loaded: engines come from the catalogue, saved voices
  // from the last time we could reach the box. Only synthesising needs the model in VRAM.
  api.get("/voice/catalog", wrap(async (_req, res) => {
    const cat = await ctx.models.catalog();
    const fromCatalog = cat.models.filter((m) => m.modality === "voice" && m.runner === "voice" && m.id !== "sensevoice-small").map((m) => ({
      id: m.id, name: m.name, clone: !!m.clone, installed: !!m.tested, tested: !!m.tested,
      vram: m.vram || m.vramEstimate || null, fileGb: m.fileGb || null, note: m.note || "",
      controls: (m.controls || []).map((c) => (typeof c === "string" ? { key: c, label: c, type: "text" } : c)),
      voices: (m.voices || []).map((v) => (typeof v === "string" ? { id: v, name: v } : v)),
    }));
    const loadedVoice = ctx.models.state.loaded.voice?.modelId || null;
    const liveEngines = ctx.models.state.voiceEngines || null;
    let engines = null, voices = null, live = false;
    if (ctx.models.state.loaded.voice) {
      try {
        const get = async (p) => { const r = await fetch(config.voiceUpstream + p, { signal: AbortSignal.timeout(6000) }); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); };
        engines = await get("/engines"); voices = await get("/voices"); live = true;
        await ctx.store.update((st) => { st.voiceCache = { at: Math.floor(Date.now() / 1000), engines, voices }; });
      } catch { /* fall through to the cache */ }
    }
    const cached = (await ctx.store.read()).voiceCache;
    if (!live && cached) { engines = cached.engines; voices = cached.voices; }
    // merge: catalogue is the source of truth for what exists, the box for what is loaded and which voices are saved
    const byId = new Map((engines || []).map((e) => [e.id, e]));
    const isLoaded = (id) => (liveEngines ? !!liveEngines[id]?.loaded : id === loadedVoice);
    const merged = fromCatalog.map((m) => ({ ...m, ...(byId.get(m.id) || {}), vram: byId.get(m.id)?.vram || m.vram, fileGb: m.fileGb, loaded: isLoaded(m.id) }));
    for (const e of engines || []) if (!merged.some((m) => m.id === e.id)) merged.push({ ...e, loaded: isLoaded(e.id) });
    res.json({
      engines: merged,
      voices: voices || { saved: [], samples: [], builtin: {} },
      loaded: !!loadedVoice, serviceUp: !!ctx.models.state.loaded.voice, modelId: loadedVoice, live,
      stale: !live && !!cached ? cached.at : null,
    });
  }));
  // Preview a built-in voice: synthesised once with a fixed line, then cached on 13 forever, so browsing
  // 131 Kokoro voices costs one GPU call each and later previews work even with the box off.
  api.get("/voice/preview", wrap(async (req, res) => {
    const engine = String(req.query.model || "").replace(/[^\w.-]/g, "");
    const voice = String(req.query.voice || "").replace(/[^\w.:-]/g, "");
    if (!engine || !voice) throw Object.assign(new Error("缺少 model / voice"), { status: 400 });
    const dir = path.join(config.dataDir, "voice-preview");
    const file = path.join(dir, `${engine}__${voice.replace(/[:]/g, "_")}.wav`);
    if (fs.existsSync(file)) return res.sendFile(file, { maxAge: 86400_000 });
    const liveEngine = ctx.models.state.loaded.voice?.modelId || null;
    if (liveEngine !== engine) {
      throw Object.assign(new Error(`试听要先加载 ${engine}${liveEngine ? `（现在显存里是 ${liveEngine}）` : "（语音服务还没加载任何引擎）"}；合成一次后就缓存在 13 上了`), { status: 409, engine, loaded: liveEngine });
    }
    const lang = /^[a-b]/.test(voice) ? "en" : /^j/.test(voice) ? "ja" : "zh";
    const text = lang === "en" ? "Hello, this is what my voice sounds like." : lang === "ja" ? "こんにちは、これが私の声です。" : "你好，这就是我的声音，可以用来配旁白。";
    const r = await fetch(config.voiceUpstream + "/tts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, model: engine, voice, language: lang === "zh" ? "Chinese" : lang === "en" ? "English" : "Japanese" }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!r.ok) throw Object.assign(new Error("试听失败：" + (await r.text()).slice(0, 200)), { status: 502 });
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, Buffer.from(await r.arrayBuffer()));
    res.sendFile(file);
  }));
  // Same advice the job would attach, but before anything is queued — the generate page calls it as you type.
  api.post("/jobs/advice", express.json(), wrap(async (req, res) => {
    const b = req.body || {};
    const assets = (b.images || []).map((id) => { try { return projects.assetPath(b.projectId || "default", id).asset; } catch { return null; } });
    const { refAdvice } = await import("./refadvice.js");
    res.json({ advice: refAdvice({ prompt: b.prompt || "", images: b.images || [], videos: b.videos || [], assets, width: Number(b.width) || 0, height: Number(b.height) || 0 }) });
  }));
  // Which machines exist, which one is active, and what each one is doing. With more than one box the
  // question "start that one" needs a name to point at.
  // Switch which machine the workbench drives. Refused while this one is busy — a job mid-flight on the
  // old box would lose its ports underneath it.
  // Start a specific machine. Switching the workbench to it is a consequence of starting it, not of
  // picking it in a dropdown — the user asked for the dropdown to be a view, not an action.
  api.post("/boxes/:name/start", wrap(async (req, res) => {
    const b = config.boxes.find((x) => x.name === req.params.name);
    if (!b) throw new Error(`没有这台机器：${req.params.name}`);
    if (!b.instanceId) throw new Error(`${b.label || b.name} 还没配置 CompShare 实例`);
    if (b.name !== config.fleet.active.name) {
      const cur = config.fleet.active.name;
      if (power.status.state === "on" && (power.status.queue.running + power.status.queue.pending > 0 || ctx.jobs?.hasActive?.()))
        throw new Error(`${cur} 上还有任务在跑，先等它跑完再换机器`);
      config.useBox(b.name); ctx.models?.onBoxChanged?.(b);
      power.status.state = "unknown"; power.status.comfyUp = false; power.status.idleSince = null; power.usage = null;
      await ctx.store.update((st) => { st.settings = st.settings || {}; st.settings.activeBox = b.name; st.audit.push({ at: new Date().toISOString(), action: "gpu.box.switch", from: cur, to: b.name, reason: "start", label: req.session?.label || null }); });
    }
    power.ensureOn(() => {}).catch((e) => events.emitAll("toast", { level: "error", text: "开机失败：" + e.message }));
    res.json({ ok: true, active: config.fleet.active.name, starting: true });
  }));
  api.post("/boxes/:name/activate", wrap(async (req, res) => {
    const cur = config.fleet.active.name;
    if (req.params.name === cur) return res.json({ ok: true, active: cur, changed: false });
    if (power.status.state === "on" && (power.status.queue.running + power.status.queue.pending > 0 || ctx.jobs?.hasActive?.()))
      throw new Error(`${cur} 上还有任务在跑，先等它跑完或停掉再换机器`);
    const b = config.useBox(req.params.name);
    ctx.models?.onBoxChanged?.(b);
    power.status.state = "unknown"; power.status.comfyUp = false; power.status.idleSince = null; power.usage = null;
    await ctx.store.update((st) => { st.settings = st.settings || {}; st.settings.activeBox = b.name; st.audit.push({ at: new Date().toISOString(), action: "gpu.box.switch", from: cur, to: b.name, reason: "manual", label: req.session?.label || null }); });
    await power.probe().catch(() => {});
    res.json({ ok: true, active: b.name, changed: true, state: power.status.state });
  }));
  // Cloud state for every box, not just the active one, so the dashboard can show what a machine is
  // doing before you commit to switching to it. Cached: CompShare is a signed API call per box.
  const boxCloud = new Map();
  const cloudStateOf = async (b) => {
    if (!power.cs || !b.instanceId) return null;
    const hit = boxCloud.get(b.name);
    if (hit && Date.now() - hit.at < 60_000) return hit.state;
    try { const st = await power.cs.state(b.instanceId, { region: b.region }); boxCloud.set(b.name, { state: st, at: Date.now() }); return st; }
    catch { return hit?.state ?? null; }
  };
  api.get("/boxes", wrap(async (_req, res) => {
    const active = config.fleet.active.name;
    const gpu = await power.snapshot();
    const boxes = await Promise.all(config.boxes.map(async (b) => ({
      name: b.name, label: b.label, region: b.region, zone: b.zone, host: b.host,
      instanceId: b.instanceId, portBase: b.portBase, ports: { comfy: b.portBase, ssh: b.portBase + 1, llm: b.portBase + 2, voice: b.portBase + 3 },
      active: b.name === active,
      state: b.name === active ? gpu.state : "unknown",
      cloudState: await cloudStateOf(b),
      gone: (await cloudStateOf(b)) === "NotFound",   // 云上已删除：别再让人选它
      configured: !!b.instanceId,
    })));
    res.json({ active, boxes });
  }));
  api.get("/assets/sync", wrap(async (_req, res) => res.json(await ctx.assetSync.compare())));
  api.post("/assets/sync", express.json(), wrap(async (req, res) => res.json(await ctx.assetSync.sync({ push: req.body?.push !== false, pull: req.body?.pull !== false, limit: Math.min(50, Number(req.body?.limit) || 20) }))));
  api.get("/direct", wrap(async (_req, res) => res.json(ctx.direct ? await ctx.direct.info() : { available: false, reason: "未启用" })));
  api.post("/projects/:id/assets/direct", express.json(), wrap(async (req, res) => {
    const d = ctx.direct;
    if (!d?.enabled) throw Object.assign(new Error("未启用直传"), { status: 400 });
    // storing bytes only needs the box and the asset service — never wait for ComfyUI or a model load here
    if (power.status.state !== "on") throw Object.assign(new Error("GPU 未开机，先开机再直传（或让它走 13 中转）"), { status: 503 });
    await d.ensureService();
    const info = await d.info();
    if (!info.available) throw Object.assign(new Error("GPU 直传不可用：" + (info.reason || "")), { status: 503 });
    const asset = await projects.reserveAsset(req.params.id, { name: req.body?.name, kind: req.body?.kind || null });
    res.json({ asset, base: info.base, put: `${info.base}/a/${asset.id}?name=${encodeURIComponent(asset.name)}`, token: d.token(asset.id, "put", 7200), trustUrl: info.trustUrl });
  }));
  api.post("/projects/:id/assets/:aid/direct-done", express.json(), wrap(async (req, res) => {
    const d = ctx.direct;
    if (!d?.enabled) throw Object.assign(new Error("未启用直传"), { status: 400 });
    const m = await d.meta(req.params.aid);
    const asset = await projects.attachRemote(req.params.id, req.params.aid, m);
    ctx.backup?.queue(req.params.id, req.params.aid);
    res.json(asset);
  }));
  api.post("/projects/:id/sweep-pending", express.json(), wrap(async (req, res) => res.json({ removed: await projects.sweepPending({ olderThanS: Number(req.body?.olderThanS ?? 1800) }) })));
  api.post("/projects/:id/assets/:aid/backup", wrap(async (req, res) => { res.json(await projects.ensureLocal(req.params.id, req.params.aid, ctx.direct)); }));
  api.delete("/projects/:id/assets/:aid", wrap(async (req, res) => res.json(await projects.removeAsset(req.params.id, req.params.aid))));
  api.patch("/projects/:id/assets/:aid", express.json(), wrap(async (req, res) => res.json(await projects.renameAsset(req.params.id, req.params.aid, req.body?.name || "素材"))));
  api.post("/projects/:id/assets/:aid/frame", express.json(), wrap(async (req, res) => { const { file, asset } = await projects.localPath(req.params.id, req.params.aid); res.json(await projects.frameAsset(req.params.id, file, { at: Number(req.body?.at) || 0, last: !!req.body?.last, name: req.body?.name, source: { type: "frame", from: asset.id, at: Number(req.body?.at) || 0, last: !!req.body?.last } })); }));
  api.post("/projects/:id/assets/:aid/crop", express.json(), wrap(async (req, res) => res.json(await projects.cropAsset(req.params.id, req.params.aid, { crop: req.body?.crop, shortSide: Number(req.body?.shortSide) || 1024, exact: req.body?.exact || null, name: req.body?.name }))));
  api.post("/projects/:id/assets/:aid/prep", express.json(), wrap(async (req, res) => { const b = req.body || {}; res.json(await projects.prepAsset(req.params.id, req.params.aid, { start: Number(b.start) || 0, end: b.end != null && b.end !== "" ? Number(b.end) : null, seconds: Number(b.seconds) || 5, crop: b.crop || null, size: b.size || null, headHold: Number(b.headHold) || 0, tailHold: Number(b.tailHold) || 0, name: b.name })); }));

  // Clips
  api.post("/projects/:id/clips", express.json({ limit: "512kb" }), wrap(async (req, res) => res.json(await projects.addClip(req.params.id, req.body || {}))));
  api.patch("/projects/:id/clips/:cid", express.json({ limit: "512kb" }), wrap(async (req, res) => res.json(await projects.updateClip(req.params.id, req.params.cid, req.body || {}))));
  api.delete("/projects/:id/clips/:cid", wrap(async (req, res) => res.json(await projects.removeClip(req.params.id, req.params.cid))));
  api.post("/projects/:id/clips/reorder", express.json(), wrap(async (req, res) => res.json(await projects.reorderClips(req.params.id, req.body?.ids || []))));
  api.get("/projects/:id/clips/:cid/prompt", wrap(async (req, res) => { const { p, c } = projects.clip(req.params.id, req.params.cid); res.json({ prompt: projects.composePrompt(p, c), params: projects.clipParams(p, c) }); }));
  api.post("/projects/:id/clips/:cid/generate", express.json(), wrap(async (req, res) => {
    const { p, c } = projects.clip(req.params.id, req.params.cid);
    const params = projects.clipParams(p, c);
    const take = c.takes.length + 1;
    const seed = Number.isInteger(c.seed) ? c.seed + 1000 * (take - 1) : undefined;
    const job = await jobs.create({ projectId: p.id, clipId: c.id, take, title: `${p.name} · ${c.title} · take ${take}`, prompt: projects.composePrompt(p, c), seed, ...params });
    res.json(job);
  }));
  api.post("/projects/:id/clips/:cid/continue", express.json(), wrap(async (req, res) => res.json(await projects.continueClip(req.params.id, req.params.cid, { mode: req.body?.mode === "video" ? "video" : "frame", jobFile: (id) => jobs.outputPath(id) }))));
  api.post("/projects/:id/clips/:cid/pick", express.json(), wrap(async (req, res) => res.json(await projects.updateClip(req.params.id, req.params.cid, { pick: req.body?.jobId }))));

  // Video-edit wizard
  const ed = ctx.edits;
  api.post("/projects/:id/edits", express.json(), wrap(async (req, res) => { const b = req.body || {}; events.emitAll("toast", { level: "info", text: "正在切镜检测…" }); res.json(await ed.create(req.params.id, { sourceAssetId: b.sourceAssetId, threshold: b.threshold, minLen: b.minLen, name: b.name })); }));
  api.get("/projects/:id/edits/:eid", wrap(async (req, res) => res.json(ed.get(req.params.id, req.params.eid).e)));
  api.patch("/projects/:id/edits/:eid", express.json({ limit: "512kb" }), wrap(async (req, res) => res.json(await ed.update(req.params.id, req.params.eid, req.body || {}))));
  api.delete("/projects/:id/edits/:eid", wrap(async (req, res) => { await ed.remove(req.params.id, req.params.eid); res.json({ ok: true }); }));
  api.get("/projects/:id/edits/:eid/shots/:i/strip", wrap(async (req, res) => res.sendFile(ed.stripPath(req.params.id, req.params.eid, req.params.i), { maxAge: 3600_000 })));
  api.get("/projects/:id/edits/:eid/shots/:i/prompt", wrap(async (req, res) => { const { e } = ed.get(req.params.id, req.params.eid); res.json({ prompt: ed.composePrompt(e, ed.shot(e, req.params.i)) }); }));
  api.post("/projects/:id/edits/:eid/shots/:i/prep", wrap(async (req, res) => res.json(await ed.prep(req.params.id, req.params.eid, req.params.i))));
  api.post("/projects/:id/edits/:eid/shots/:i/generate", express.json(), wrap(async (req, res) => res.json(await ed.generate(req.params.id, req.params.eid, req.params.i))));
  api.post("/projects/:id/edits/:eid/generate-all", wrap(async (req, res) => res.json(await ed.generateAll(req.params.id, req.params.eid))));
  api.post("/projects/:id/edits/:eid/assemble", express.json(), wrap(async (req, res) => { events.emitAll("toast", { level: "info", text: "开始拼回成片…" }); const r = await ed.assemble(req.params.id, req.params.eid, { onProgress: (text) => events.emitAll("render", { projectId: req.params.id, editId: req.params.eid, text }) }); events.emitAll("toast", { level: "ok", text: `成片完成：${r.duration}s，替换了 ${r.editedShots} 个镜头` }); res.json(r); }));

  // Master-image workshop
  const ms = ctx.masters;
  api.post("/projects/:id/masters", express.json({ limit: "256kb" }), wrap(async (req, res) => res.json(await ms.create(req.params.id, req.body || {}))));
  api.patch("/projects/:id/masters/:mid", express.json({ limit: "256kb" }), wrap(async (req, res) => res.json(await ms.update(req.params.id, req.params.mid, req.body || {}))));
  api.delete("/projects/:id/masters/:mid", wrap(async (req, res) => { await ms.remove(req.params.id, req.params.mid); res.json({ ok: true }); }));
  api.get("/projects/:id/masters/:mid/prompt", wrap(async (req, res) => { const { m } = ms.get(req.params.id, req.params.mid); const step = String(req.query.step || "front"); res.json({ prompt: ms.prompt(m, step, { from: req.query.from || null, npics: (m.faces.length || 1) + (step === "turn" || step === "regen" ? 1 : 0) }) }); }));
  api.post("/projects/:id/masters/:mid/run", express.json(), wrap(async (req, res) => res.json(await ms.run(req.params.id, req.params.mid, String(req.body?.step || "front"), { from: req.body?.from || null }))));
  api.post("/projects/:id/masters/:mid/extract", express.json(), wrap(async (req, res) => res.json(await ms.extract(req.params.id, req.params.mid, String(req.body?.key || ""), { at: req.body?.at, label: req.body?.label }))));
  api.post("/projects/:id/masters/:mid/adopt", express.json(), wrap(async (req, res) => res.json(await ms.adopt(req.params.id, req.params.mid, req.body || {}))));

  // Long avatar wizard
  const av = ctx.avatars;
  api.post("/projects/:id/avatars", express.json({ limit: "256kb" }), wrap(async (req, res) => { events.emitAll("toast", { level: "info", text: "正在按静音切分音频…" }); res.json(await av.create(req.params.id, req.body || {})); }));
  api.get("/projects/:id/avatars/:aid", wrap(async (req, res) => res.json(av.get(req.params.id, req.params.aid).a)));
  api.patch("/projects/:id/avatars/:aid", express.json({ limit: "256kb" }), wrap(async (req, res) => res.json(await av.update(req.params.id, req.params.aid, req.body || {}))));
  api.delete("/projects/:id/avatars/:aid", wrap(async (req, res) => { await av.remove(req.params.id, req.params.aid); res.json({ ok: true }); }));
  api.get("/projects/:id/avatars/:aid/segments/:i/prompt", wrap(async (req, res) => { const { a } = av.get(req.params.id, req.params.aid); const s = av.seg(a, req.params.i); res.json({ prompt: av.prompt(a, s, { withAnchor: a.settings.anchor && s.index > 0 }) }); }));
  api.post("/projects/:id/avatars/:aid/segments/:i/generate", express.json(), wrap(async (req, res) => res.json(await av.generate(req.params.id, req.params.aid, req.params.i))));
  api.post("/projects/:id/avatars/:aid/generate-all", wrap(async (req, res) => res.json(await av.generateAll(req.params.id, req.params.aid))));
  api.post("/projects/:id/avatars/:aid/assemble", express.json(), wrap(async (req, res) => { events.emitAll("toast", { level: "info", text: "开始拼接数字人成片…" }); const r = await av.assemble(req.params.id, req.params.aid, { onProgress: (text) => events.emitAll("render", { projectId: req.params.id, avatarId: req.params.aid, text }) }); events.emitAll("toast", { level: "ok", text: `数字人成片完成：${r.duration}s` }); res.json(r); }));

  // Renders
  api.post("/projects/:id/assemble", express.json(), wrap(async (req, res) => {
    const b = req.body || {};
    events.emitAll("toast", { level: "info", text: "开始拼接成片…" });
    const r = await projects.assemble(req.params.id, { clipIds: b.clipIds || null, subtitles: b.subtitles, style: b.style || null, name: b.name || null, jobFile: (id) => jobs.outputPath(id), onProgress: (text) => events.emitAll("render", { projectId: req.params.id, text }) });
    events.emitAll("toast", { level: "ok", text: `成片完成：${r.duration}s` });
    res.json(r);
  }));
  const renderFile = (which) => wrap(async (req, res) => { const { file, render } = projects.renderPath(req.params.id, req.params.rid, which); if (req.query.download) res.attachment(`${safeName(render.name)}${which === "srt" ? ".srt" : ".mp4"}`); res.sendFile(file); });
  api.get("/projects/:id/renders/:rid/file", renderFile("file")); api.get("/projects/:id/renders/:rid/poster", renderFile("poster")); api.get("/projects/:id/renders/:rid/srt", renderFile("srt")); api.get("/projects/:id/renders/:rid/nosub", renderFile("nosub"));
  api.delete("/projects/:id/renders/:rid", wrap(async (req, res) => res.json(await projects.removeRender(req.params.id, req.params.rid))));
  api.post("/projects/:id/renders/:rid/share", express.json(), wrap(async (req, res) => {
    const { file, render } = projects.renderPath(req.params.id, req.params.rid);
    const r = await shareFile(config, file, { name: `${safeName(render.name)}.mp4`, permanent: !!req.body?.permanent });
    render.share = r; await projects.save(projects.get(req.params.id)); res.json(r);
  }));
  api.post("/projects/:id/assets/:aid/share", express.json(), wrap(async (req, res) => { const { file, asset } = await projects.localPath(req.params.id, req.params.aid); res.json(await shareFile(config, file, { name: asset.name, permanent: !!req.body?.permanent })); }));

  // Prompt library: OpenPrompt mirror + user's saved prompts
  const pr = ctx.prompts;
  api.get("/prompts/status", (_req, res) => res.json(pr.statusInfo()));
  api.get("/prompts/facets", (_req, res) => res.json(pr.facets()));
  api.post("/prompts/sync", express.json(), wrap(async (req, res) => { const b = req.body || {}; pr.sync({ retag: !!b.retag, reembed: !!b.reembed, limit: Number(b.limit) || 0, onlyNew: b.onlyNew !== false }).catch((e) => { pr.status.lastError = e.message; events.emitAll("toast", { level: "error", text: "提示词同步失败：" + e.message }); }); res.json({ ok: true, status: pr.statusInfo() }); }));
  const numOrNull = (v) => (v === undefined || v === "" ? null : Number(v));
  api.get("/prompts/search", wrap(async (req, res) => { const q = req.query; res.json(await pr.search({ q: q.q, k: Math.min(50, Number(q.k) || 10), model: q.model || "", mode: q.mode || "", tag: q.tag || "", h3: q.h3 === "1", boost: q.boost === "" ? "" : (q.boost || "h3"), author: q.author || "", durMin: numOrNull(q.durMin), durMax: numOrNull(q.durMax) })); }));
  api.get("/prompts/random", (req, res) => res.json(pr.random({ k: Math.min(20, Number(req.query.k) || 8), h3: req.query.h3 === "1", mode: req.query.mode || "", seed: req.query.seed ?? null })));
  api.get("/prompts/browse", (req, res) => { const q = req.query; res.json(pr.browse({ q: q.q || "", model: q.model || "", mode: q.mode || "", tag: q.tag || "", category: q.category || "", h3: q.h3 === "1", author: q.author || "", durMin: numOrNull(q.durMin), durMax: numOrNull(q.durMax), page: q.page, size: q.size, sort: q.sort || "recent" })); });
  api.get("/prompts/item/:id", wrap(async (req, res) => res.json(pr.item(req.params.id))));
  api.patch("/prompts/item/:id", express.json(), wrap(async (req, res) => res.json(await pr.editItem(req.params.id, req.body || {}))));
  api.get("/prompts/item/:id/similar", wrap(async (req, res) => { pr.item(req.params.id); res.json(pr.similar(req.params.id, Math.min(20, Number(req.query.k) || 8))); }));
  // Same-origin relay for gallery media (Cloudflare Stream HLS refuses browser CORS but serves plain fetches).
  api.get("/prompts/media", wrap(async (req, res) => {
    const r = await pr.proxyMedia(String(req.query.u || ""), { range: req.headers.range || null, proxyPath: "media" });
    res.status(r.status).set(r.headers);
    if (r.body !== undefined) return res.send(r.body);
    if (!r.stream) return res.end();
    const { Readable } = await import("node:stream");
    Readable.fromWeb(r.stream).on("error", () => res.destroy()).pipe(res);
  }));
  api.get("/library/export", (req, res) => { res.attachment(`h3studio-prompts-${new Date().toISOString().slice(0, 10)}.json`); res.json(pr.libList("")); });
  api.post("/library/import", express.json({ limit: "8mb" }), wrap(async (req, res) => res.json(await pr.libImport(Array.isArray(req.body) ? req.body : req.body?.items || []))));
  api.get("/library", (req, res) => res.json(pr.libList(req.query.q || "")));
  api.post("/library", express.json({ limit: "256kb" }), wrap(async (req, res) => res.json(await pr.libAdd(req.body || {}))));
  api.patch("/library/:id", express.json({ limit: "256kb" }), wrap(async (req, res) => res.json(await pr.libUpdate(req.params.id, req.body || {}))));
  api.delete("/library/:id", wrap(async (req, res) => { await pr.libRemove(req.params.id); res.json({ ok: true }); }));

  // LLM prompt assistant
  api.post("/llm/prompt", express.json({ limit: "256kb" }), wrap(async (req, res) => res.json({ prompt: await draftPrompt(config, req.body || {}) })));
  // Rewrite what is already in the box against a new requirement (keeps everything it is not asked to change).
  api.post("/llm/rewrite", express.json({ limit: "256kb" }), wrap(async (req, res) => {
    const { rewritePrompt } = await import("./llm.js");
    res.json({ prompt: await rewritePrompt(config, req.body || {}) });
  }));
  api.get("/util/align", (req, res) => { const f = alignLength(Number(req.query.frames) || Number(req.query.seconds) * 24 || 120); res.json({ frames: f, seconds: +(f / 24).toFixed(2) }); });

  app.get("/api/v1/docs", (_req, res) => res.type("html").send(apiDocsHtml(config)));
  app.get("/api/v1/openapi.json", (_req, res) => res.json(openapiSpec(config)));
  app.use("/api", api);

  // ---- OpenAI-compatible LLM endpoint + voice service, proxied to the GPU through the tunnel -----
  // Access = workbench session or API key. A request auto-starts the GPU and loads the default model
  // (or waits for an in-flight load); the body is streamed through untouched, so SSE streaming works.
  const proxyTo = (upstreamOf, modalityOf) => async (req, res) => {
    if (!req.session) return res.status(401).json({ error: { message: "unauthorized: use a workbench API key (Authorization: Bearer atl_…)", type: "auth" } });
    const models = ctx.models;
    // OpenAI clients use one base_url for chat and audio: /llm/v1/audio/* is served by the voice service.
    const modality = typeof modalityOf === "function" ? modalityOf(req) : modalityOf;
    if (modality === "llm" && req.method === "GET" && /^\/v1\/models\/?(\?|$)/.test(req.url)) {
      const c = await models.catalog(); const cur = models.state.loaded.llm?.modelId || null; const curVoice = models.state.loaded.voice?.modelId || null;
      const data = c.models.filter((m) => m.modality === "llm").map((m) => ({ id: m.id, object: "model", owned_by: "atelier", type: "llm", loaded: m.id === cur, tested: !!m.tested, ctx: (() => { const a = m.args || []; const i = a.indexOf("-c"); return i >= 0 ? Number(a[i + 1]) : null; })() }));
      for (const m of c.models.filter((m) => m.modality === "voice")) data.push({ id: m.id, object: "model", owned_by: "atelier", type: m.id === "sensevoice-small" ? "asr" : "tts", loaded: models.state.loaded.voice ? (m.id === curVoice || m.id === "sensevoice-small") : false, tested: !!m.tested, clone: !!m.clone, voices: m.voices || [] });
      let voices = [];
      if (models.state.loaded.voice) { try { const r = await fetch(`${config.voiceUpstream}/v1/models`, { signal: AbortSignal.timeout(4000) }); const j = await r.json(); voices = j.voices || []; for (const d of data) { const e = (j.data || []).find((x) => x.id === d.id); if (e && e.loaded != null) d.loaded = e.loaded; } } catch {} }
      return res.json({ object: "list", data, voices, hint: "tts models: POST /v1/audio/speech {model, input, voice}; voices = saved/sample voice ids usable with clone-capable tts models" });
    }
    try {
      models.touch(modality);
      if (!models.state.loaded[modality]) {
        // Only agents get an implicit load: from the workbench the user decides what sits in VRAM.
        if (!req.viaKey) return res.status(409).json({ error: { message: `${modality === "llm" ? "大模型" : "语音模型"}没有加载。到「仪表盘」点一下加载，或在「模型管家」里选一个。`, type: "not_loaded", modality } });
        await models.ensure(modality, null, () => {});
      } else if (models.isBusy()) await models.chain;
    } catch (e) { res.setHeader("Retry-After", /out of resources|226604/.test(e.message) ? "300" : "60"); return res.status(503).json({ error: { message: `模型未就绪：${e.message}${/out of resources|226604/.test(e.message) ? "（云上暂时没有空闲的 5090，控制台会一直重试；几分钟后再调）" : ""}`, type: "model_not_ready" } }); }
    const target = new URL(upstreamOf(req));
    const headers = { ...req.headers, host: target.host }; delete headers.authorization; delete headers.cookie;
    const up = http.request({ hostname: target.hostname, port: target.port || 80, path: req.url, method: req.method, headers }, (ur) => {
      res.status(ur.statusCode || 502);
      for (const [k, v] of Object.entries(ur.headers)) if (!["transfer-encoding", "connection", "keep-alive"].includes(k)) res.setHeader(k, v);
      res.setHeader("X-Accel-Buffering", "no");
      ur.pipe(res); ur.on("end", () => models.touch(modality));
    });
    up.setTimeout(600_000, () => up.destroy(new Error("upstream timeout")));
    up.on("error", (e) => { if (!res.headersSent) res.status(502).json({ error: { message: "upstream: " + e.message, type: "upstream" } }); else res.end(); });
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  };
  const isAudio = (req) => /^\/v1\/audio\//.test(req.url);
  app.use("/llm", proxyTo((req) => isAudio(req) ? config.voiceUpstream : config.llmUpstream, (req) => isAudio(req) ? "voice" : "llm"));
  app.use("/voice", proxyTo(() => config.voiceUpstream, "voice"));
  // The fleet tunnel's only door. A GPU box reaching 13 through the Hysteria2 tunnel lands on 13's
  // loopback, so this route is loopback-only and needs the random one-shot token Direct.lend() handed
  // out for that exact file. It is not reachable from the internet and carries no session.
  app.get("/_fleet/blob/:token", (req, res) => {
    const ip = req.socket.remoteAddress || "";
    if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip)) return res.status(403).end();
    const v = ctx.direct?.takeLent(req.params.token);
    if (!v) return res.status(404).json({ error: "过期或不存在" });
    res.sendFile(v.file, { headers: { "content-type": "application/octet-stream" } }, (e) => { if (e && !res.headersSent) res.status(500).end(); });
  });
  // Build artefacts a GPU box pulls through the fleet tunnel instead of compiling itself.
  // llama.cpp has no prebuilt Linux CUDA release any more, and compiling it on a fresh pod means
  // 20–40 minutes plus a fight with whatever toolchain the image happens to ship. So we build once,
  // keep the binary here, and every later box fetches it over the tunnel in about a minute.
  app.get("/_fleet/cache/:name", (req, res) => {
    const ip = req.socket.remoteAddress || "";
    if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip)) return res.status(403).end();
    if (!/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(req.params.name)) return res.status(400).end();
    const f = path.join(config.dataDir, "cache", req.params.name);
    if (!fs.existsSync(f)) return res.status(404).json({ error: "缓存里没有 " + req.params.name });
    res.sendFile(f);
  });
  // Loopback-only endpoints for the operator CLI (shares the daemon's in-memory prompt index).
  app.post("/internal/prompts/sync", express.json(), wrap(async (req, res) => {
    const ip = req.socket.remoteAddress || "";
    if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip) || req.get("x-internal") !== crypto.createHash("sha256").update(config.tokenPepper).digest("hex")) return res.status(403).json({ error: "forbidden" });
    const b = req.body || {}; pr.sync({ retag: !!b.retag, reembed: !!b.reembed, limit: Number(b.limit) || 0 }).catch((e) => { pr.status.lastError = e.message; }); res.json({ ok: true, status: pr.statusInfo() });
  }));
  app.get("/internal/prompts/status", (req, res) => { const ip = req.socket.remoteAddress || ""; if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip)) return res.status(403).end(); res.json(pr.statusInfo()); });
  app.get(["/", "/index.html"], requireSession, (_req, res) => res.sendFile(path.join(webDir, "index.html")));
  app.use("/", requireSession, express.static(webDir, { index: false, maxAge: 0 }));
}

// ---- external API docs -------------------------------------------------------------------------
const API_ENDPOINTS = [
  ["GET", "/api/gpu", "GPU 状态、队列、费用", null],
  ["POST", "/api/gpu/start", "开机（异步）", null],
  ["POST", "/api/gpu/stop", "关机 {force?}", { force: false }],
  ["GET", "/api/projects", "项目列表", null],
  ["POST", "/api/projects", "新建项目", { name: "示例", settings: { workflow: "native_ref2va", width: 832, height: 448, seconds: 5, steps: 8 } }],
  ["GET", "/api/projects/{id}", "项目详情（素材、片段、母图、编辑、数字人、成片）", null],
  ["PUT", "/api/projects/{id}/assets?name=face.jpg", "上传素材（原始字节作为 body；图片/视频/音频）", "<binary>"],
  ["GET", "/api/projects/{id}/assets/{aid}/file", "下载素材", null],
  ["POST", "/api/jobs", "创建生成任务", { projectId: "default", title: "小黄鸭", workflow: "native_t2v", prompt: "integrated_multimodal_description: [Shot 1] …\n\noverall_soundscape: …\n\nnon_diegetic_music: N/A", width: 832, height: 448, seconds: 5, steps: 4, seed: 7, images: [], lastFrame: null, videos: [], videoAudio: false, audios: [], refSize: "max" }],
  ["GET", "/api/jobs?projectId=&limit=", "任务列表", null],
  ["GET", "/api/jobs/{id}", "任务详情（status/progress/refCheck/output/estimate）", null],
  ["GET", "/api/jobs/{id}/file", "下载成片（支持 Range）", null],
  ["POST", "/api/jobs/{id}/cancel", "取消", null],
  ["POST", "/api/jobs/{id}/share", "生成免登录分享链接 {permanent?}", { permanent: false }],
  ["POST", "/api/jobs/{id}/frame", "抽帧成素材 {at|last}", { last: true }],
  ["POST", "/api/projects/{id}/clips", "添加片段", { title: "第 1 段", summary: "[reference generation] …", shot: "[Shot 1] …" }],
  ["POST", "/api/projects/{id}/clips/{cid}/generate", "为片段生成一条 take", {}],
  ["POST", "/api/projects/{id}/assemble", "拼接成片（响度归一 + 字幕）", {}],
  ["GET", "/api/projects/{id}/renders/{rid}/file", "下载成片", null],
  ["POST", "/api/projects/{id}/edits", "视频编辑：切镜", { sourceAssetId: "a_…", threshold: 0.3, minLen: 0.8 }],
  ["POST", "/api/projects/{id}/avatars", "长数字人：切段", { face: "a_…", audio: "a_…", name: "讲解员" }],
  ["POST", "/api/projects/{id}/masters", "母图工坊", { kind: "person", name: "girl", face: "a_…", desc: "…", outfit: "…" }],
  ["GET", "/api/prompts/search?q=&k=10&h3=1", "提示词语义搜索（OpenPrompt 镜像 + 我的提示词）", null],
  ["GET", "/api/prompts/item/{id}", "提示词详情（原文、译文、标签、溯源、视频）", null],
  ["GET", "/api/library", "我的提示词", null],
  ["POST", "/api/llm/prompt", "AI 助手：中文想法 → H3 官方格式提示词", { mode: "ref", idea: "两姐妹找充电器…", seconds: 5, dialogueLang: "Chinese", refs: [{ kind: "image", index: 1, desc: "姐姐头肩照" }] }],
  ["GET", "/api/events", "SSE 实时事件（gpu / job / toast / render / prompts）", null],
];
function apiDocsHtml(config) {
  const base = config.publicOrigin + config.basePath;
  const esc = (v) => String(v).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const rows = API_ENDPOINTS.map(([m, p, d, body]) => `<tr><td><code>${m}</code></td><td><code>${esc(p)}</code></td><td>${esc(d)}</td><td>${body == null ? "" : `<pre>${esc(typeof body === "string" ? body : JSON.stringify(body, null, 1))}</pre>`}</td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Atelier API</title>
<style>body{margin:0;background:#0e1116;color:#e6e8ec;font:14px/1.5 -apple-system,"PingFang SC",sans-serif}main{max-width:1000px;margin:0 auto;padding:24px}h1{font-size:22px}h2{font-size:16px;margin-top:24px}code,pre{font:12px ui-monospace,Menlo,monospace;background:#0b0e13;border-radius:6px}code{padding:1px 5px}pre{padding:8px;overflow:auto;margin:0;white-space:pre-wrap;max-width:420px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #28303c;padding:6px;text-align:left;vertical-align:top;font-size:13px}a{color:#38bdf8}.hint{color:#8b93a1}</style></head><body><main>
<h1>Atelier 外部 API</h1>
<p class="hint">Base URL：<code>${esc(base)}</code> · 认证：<code>Authorization: Bearer atl_…</code>（在网页「设置 → API Keys」创建）· 与网页登录会话权限相同。机器可读：<a href="${esc(base)}/api/v1/openapi.json">openapi.json</a></p>
<h2>快速开始</h2>
<pre>curl -H "Authorization: Bearer $H3S_KEY" ${esc(base)}/api/gpu
curl -H "Authorization: Bearer $H3S_KEY" -X PUT --data-binary @face.jpg "${esc(base)}/api/projects/default/assets?name=face.jpg"
curl -H "Authorization: Bearer $H3S_KEY" -H "content-type: application/json" -X POST ${esc(base)}/api/jobs -d '{"projectId":"default","workflow":"native_t2v","prompt":"…","width":832,"height":448,"seconds":5}'
curl -H "Authorization: Bearer $H3S_KEY" ${esc(base)}/api/jobs/&lt;id&gt;            # 轮询 status 直到 done
curl -H "Authorization: Bearer $H3S_KEY" -o out.mp4 ${esc(base)}/api/jobs/&lt;id&gt;/file</pre>
<p class="hint">本机 agent 可直接用 skill：<code>python3 ~/.claude/skills/atelier/scripts/atl.py gen "提示词" --seconds 5 --wait</code>（配置 <code>~/.config/atelier/config.json</code>：{"base": "${esc(base)}", "key": "h3s_…"}）。提示词规则见 <a href="${esc(config.promptRulesUrl.replace(/\.md$/, ""))}">/h3</a>。</p>
<h2>端点</h2><table><tr><th>方法</th><th>路径</th><th>说明</th><th>请求体示例</th></tr>${rows}</table>
<h2>任务对象</h2><pre>{ id, projectId, title, workflow, prompt, width, height, length, seconds, steps, seed, refSize,
  images: [assetId], lastFrame, videos: [assetId], videoAudio, audios: [assetId],
  status: queued|starting|uploading|submitted|running|downloading|done|error|cancelled,
  progress: {value, max}, refCheck: {expected, received[], ok}, warning, error,
  output: {file, poster, strip, duration, width, height, size}, share: {url}, log: [{at, text}] }</pre>
<p class="hint">硬约束：宽高 32 的倍数；帧数自动对齐 17k+5；单条 ≤15 秒；参考图 ≤9 张、参考视频 ≤3 段（24fps 2–15 秒）、参考音频 ≤3 段。GPU 关机时任务会自动开机（约 2 分钟）。</p>
</main></body></html>`;
}
function openapiSpec(config) {
  const base = config.publicOrigin + config.basePath;
  const paths = {};
  for (const [m, p, d, body] of API_ENDPOINTS) {
    const [pathOnly, q] = p.split("?");
    const key = pathOnly;
    paths[key] ||= {};
    const params = [...key.matchAll(/\{(\w+)\}/g)].map((x) => ({ name: x[1], in: "path", required: true, schema: { type: "string" } }));
    if (q) for (const part of q.split("&")) { const n = part.split("=")[0]; if (n) params.push({ name: n, in: "query", schema: { type: "string" } }); }
    const op = { summary: d, parameters: params, responses: { 200: { description: "OK" }, 401: { description: "unauthorized" } } };
    if (body != null && m !== "GET") op.requestBody = { content: body === "<binary>" ? { "application/octet-stream": { schema: { type: "string", format: "binary" } } } : { "application/json": { example: body } } };
    paths[key][m.toLowerCase()] = op;
  }
  return { openapi: "3.0.3", info: { title: "Atelier API", version: config.version, description: "MiniMax-H3 video studio. Bearer API keys are created in the web UI (设置 → API Keys)." }, servers: [{ url: base }], security: [{ bearer: [] }], components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } }, paths };
}
const safeName = (s) => String(s || "video").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 60);
