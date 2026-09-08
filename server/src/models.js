// Model manager: one 32 GB card, several modalities (video = MiniMax-H3 in ComfyUI, llm = llama-server,
// voice = TTS/ASR service, whitemodel = depth node in ComfyUI). Keeps the loaded set, arbitrates VRAM
// (video ↔ llm/voice are mutually exclusive; voice may sit next to llm), loads/unloads through gpuctl
// over the reverse tunnel, and records per-modality activity so the power watchdog knows "busy".
// Video always wins: a video job calls ensure("video"), which evicts llm/voice first.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nowS = () => Math.floor(Date.now() / 1000);
const CATALOG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "models.catalog.json");
const RUNNER_PORT = { comfyui: 8188, llm: 8080, voice: 8600 };
const PROGRAM = { video: "comfyui", whitemodel: "comfyui", llm: "llm", voice: "voice" };

export class Models {
  constructor(config, store, gpuctl, comfy, events, power) {
    this.config = config; this.store = store; this.gpuctl = gpuctl; this.comfy = comfy; this.events = events; this.power = power;
    this.catalogRaw = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
    this.state = { loaded: {}, busy: null, gpu: null, activity: {}, lastError: null, comfyModelsLoaded: false };
    this.chain = Promise.resolve();
    Object.defineProperty(this, "upstreams", { get: () => ({ llm: config.llmUpstream, voice: config.voiceUpstream }) });
  }

  // ---------- catalogue ----------
  async catalog() {
    const over = (await this.store.read()).settings?.models || {};
    return {
      vramTotal: this.catalogRaw.vramTotal, modalities: this.catalogRaw.modalities, tasks: this.catalogRaw.tasks,
      models: this.catalogRaw.models.map((m) => ({ ...m, ...(over[m.id] || {}) })),
    };
  }
  async model(id) { const c = await this.catalog(); const m = c.models.find((x) => x.id === id); if (!m) throw new Error(`未知模型 ${id}`); return m; }
  /** Default model per modality: the operator's choice (settings.defaultModels) → the task's default → first tested. */
  async defaultFor(modality, task = null) {
    const c = await this.catalog();
    const chosen = (await this.store.read()).settings?.defaultModels?.[modality];
    if (chosen) { const m = c.models.find((x) => x.id === chosen && x.modality === modality); if (m) return m; }
    const t = task && c.tasks[task]; if (t && t.default) return c.models.find((m) => m.id === t.default) || null;
    return c.models.find((m) => m.modality === modality && m.tested) || c.models.find((m) => m.modality === modality) || null;
  }
  async defaults() { const d = (await this.store.read()).settings?.defaultModels || {}; const out = {}; for (const mod of Object.keys(this.catalogRaw.modalities)) out[mod] = d[mod] || (await this.defaultFor(mod))?.id || null; return out; }
  async setDefault(modality, modelId) {
    const m = await this.model(modelId); if (m.modality !== modality) throw new Error(`${modelId} 不是 ${modality} 模型`);
    await this.store.update((s) => { s.settings = s.settings || {}; s.settings.defaultModels = { ...(s.settings.defaultModels || {}), [modality]: modelId }; });
    this._emit(); return this.defaults();
  }
  async setOverride(id, patch) {
    await this.store.update((s) => { s.settings = s.settings || {}; s.settings.models = s.settings.models || {}; s.settings.models[id] = { ...(s.settings.models[id] || {}), ...patch, updatedAt: nowS() }; });
  }

  // ---------- observation ----------
  touch(modality) { this.state.activity[modality] = nowS(); }
  lastActivity() { return Math.max(0, ...Object.values(this.state.activity)); }
  /** True when any llm/voice request happened within `seconds` (video is covered by the job queue). */
  /** What a model costs in VRAM at a given context: weights (from the file size) + KV cache.
   *  kvBytesPerToken is measured where we have run the model (Qwen3.8-27B Q4 at 256k / q4_0 KV came to
   *  22.2 GB total against 16.5 GB of weights), and otherwise scaled from the parameter count, so the
   *  number is honest about being an estimate. */
  static vramFor(m, ctx) {
    const weightsMib = m.fileGb ? Math.round(m.fileGb * 1024) : (m.vram || m.vramEstimate || 0);
    if (m.modality !== "llm") return { weightsMib, kvMib: 0, totalMib: m.vram || m.vramEstimate || weightsMib, measured: !!m.vram };
    const n = Number(String(m.params || "").replace(/[^\d.]/g, "")) || 27;
    const perToken = m.kvBytesPerToken || Math.round(860 * n);      // ≈0.86 KB per token per B of parameters at q4 KV
    const kvMib = ctx ? Math.round((ctx * perToken) / 1048576) : 0;
    return { weightsMib, kvMib, totalMib: weightsMib + kvMib + 700, measured: !!m.kvBytesPerToken, perToken };
  }
  static ctxOf(m) { const a = m.args || []; const i = a.indexOf("-c"); return i >= 0 ? Number(a[i + 1]) || null : null; }

  /** The largest context this model can hold on this card, and a handful of round choices under it.
   *  Bounded by whatever the architecture supports (ctxMax) as well as by free VRAM. */
  static ctxOptions(m, vramTotalMib = 32607, reserveMib = 1200) {
    if (m.modality !== "llm") return null;
    const weights = m.fileGb ? Math.round(m.fileGb * 1024) : (m.vram || m.vramEstimate || 0);
    const n = Number(String(m.params || "").replace(/[^\d.]/g, "")) || 27;
    const perToken = m.kvBytesPerToken || Math.round(860 * n);
    const budget = Math.max(0, vramTotalMib - weights - reserveMib - 700);
    const fits = Math.floor((budget * 1048576) / perToken);
    const hardMax = Math.min(m.ctxMax || Infinity, fits);
    const steps = [4096, 8192, 16384, 32768, 65536, 98304, 131072, 196608, 262144, 393216, 524288];
    const options = steps.filter((v) => v <= hardMax);
    // round the ceiling down to a whole 1k so it reads sensibly, and offer it when it is not already there
    const maxCtx = Math.max(4096, Math.floor(hardMax / 1024) * 1024);
    if (options.at(-1) !== maxCtx && maxCtx > (options.at(-1) || 0)) options.push(maxCtx);
    return { maxCtx, limitedBy: (m.ctxMax || Infinity) <= fits ? "model" : "vram", perToken, options };
  }

  /**
   * The context to actually launch with on THIS card. The workbench moves between GPUs (24 / 32 / 48 / 96 GB),
   * so a number typed on one machine is wrong on the next: derive it from the card in front of us and keep a
   * safety margin. `ctxPin` on the model overrides it for the rare case someone really wants a fixed size.
   */
  autoCtx(m, vramTotalMib = null) {
    if (m.modality !== "llm") return null;
    if (m.ctxPin) return Number(m.ctxPin);
    const total = vramTotalMib || this.state.gpu?.vram?.total || 32607;
    const co = Models.ctxOptions(m, total);
    if (!co) return null;
    // step down one notch from the ceiling: the estimate is ±10% and a failed load costs minutes
    const usable = co.options.filter((v) => v <= co.maxCtx * 0.92);
    return usable.at(-1) || co.options[0] || 4096;
  }

  /** llama-server args with -c replaced by what fits on the current card. */
  argsFor(m, vramTotalMib = null) {
    const args = [...(m.args || [])];
    const ctx = this.autoCtx(m, vramTotalMib);
    if (!ctx) return args;
    const i = args.indexOf("-c");
    if (i >= 0) args[i + 1] = String(ctx); else args.unshift("-c", String(ctx));
    return args;
  }

  /** The fleet switched machines: nothing we think is loaded is true any more. */
  onBoxChanged(box) {
    this.state.loaded = {}; this.state.gpu = null; this.state.comfyModelsLoaded = false;
    this.state.voiceEngines = null; this.state.lastError = null;
    console.log(`[models] active box → ${box.name}; forgetting what was in VRAM`);
    this._emit();
  }

  recentlyActive(seconds) { const t = nowS(); return Object.entries(this.state.activity).some(([m, at]) => m !== "video" && t - at < seconds); }
  isBusy() { return !!this.state.busy; }

  /** Pull gpuctl status; derive what is loaded from supervisor programs + open ports + VRAM. */
  async refresh({ timeoutMs = 12_000 } = {}) {
    const st = await this.gpuctl.status({ timeoutMs });
    this.state.gpu = { ...st, at: nowS() };
    const up = (prog) => st.programs?.[prog] === "RUNNING" && st.ports?.includes(RUNNER_PORT[prog]);
    const comfyMib = (st.procs || []).filter((p) => /ComfyUI|main\.py/.test(p.cmd)).reduce((s, p) => s + (p.mib || 0), 0);
    this.state.comfyModelsLoaded = comfyMib > 3000;
    for (const [mod, prog] of Object.entries(PROGRAM)) {
      if (mod === "whitemodel") continue;
      if (up(prog)) {
        // after a control-plane restart the runner may already be up: recover which model it runs from its env file
        const envId = st.runners?.[prog]?.MODEL_ID || st.runners?.[prog]?.ALIAS || null;
        if (!this.state.loaded[mod]) this.state.loaded[mod] = { modelId: envId, since: nowS(), inferred: true };
        else if (!this.state.loaded[mod].modelId && envId) this.state.loaded[mod].modelId = envId;
        if (st.runners?.[prog]?.ARGS != null) this.state.loaded[mod].args = st.runners[prog].ARGS;
      } else delete this.state.loaded[mod];
    }
    if (this.state.loaded.video && !this.state.comfyModelsLoaded) this.state.loaded.video.weights = false; else if (this.state.loaded.video) this.state.loaded.video.weights = true;
    // The voice runner is a router: which engine sits in VRAM changes per request, and the supervisor env
    // it was started with (always indextts-2) says nothing about that. Ask the router itself.
    if (this.state.loaded.voice) {
      try {
        const h = await fetch(this.config.voiceUpstream + "/health", { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
        const live = Object.entries(h.engines || {}).find(([, v]) => v.loaded)?.[0] || null;
        this.state.voiceEngines = h.engines || null;
        if (live) { this.state.loaded.voice.modelId = live; this.state.loaded.voice.inferred = false; }
        else this.state.loaded.voice.modelId = null;      // router up, nothing in VRAM yet
      } catch { /* router not answering; leave what we had */ }
    } else this.state.voiceEngines = null;
    return this.state.gpu;
  }

  async snapshot() {
    const c = await this.catalog();
    for (const m of c.models) {
      const ctx = Models.ctxOf(m);
      if (ctx) m.ctx = ctx;
      if (m.ctxMax) m.ctxHeadroom = m.ctxMax > (ctx || 0);
      m.vramAt = Models.vramFor(m, ctx);
      const co = Models.ctxOptions(m, c.vramTotal);
      if (co) { m.ctxOptions = co.options; m.ctxMaxUsable = co.maxCtx; m.ctxLimitedBy = co.limitedBy; m.ctxAuto = this.autoCtx(m, c.vramTotal); m.ctxPinned = !!m.ctxPin; }
    }
    const g = this.state.gpu;
    return {
      available: this.gpuctl.available, gpu: g ? { vram: g.vram, programs: g.programs, ports: g.ports, diskFreeGb: g.disk_free_gb, at: g.at, procs: g.procs } : null,
      loaded: this.state.loaded, comfyModelsLoaded: this.state.comfyModelsLoaded, bootLoad: await this.bootPref(), busy: this.state.busy, activity: this.state.activity, lastError: this.state.lastError,
      vramTotal: c.vramTotal, modalities: c.modalities, tasks: c.tasks, models: c.models, defaults: await this.defaults(),
    };
  }

  // ---------- arbitration ----------
  /** Serialize load/unload operations. */
  _serial(fn) { const p = this.chain.then(fn, fn); this.chain = p.catch(() => {}); return p; }
  _emit() {
    // snapshot() is async (it rebuilds the catalogue), so by the time it resolved the load had already moved
    // on and every progress step went out carrying the *last* step's text. Freeze the volatile bits here.
    const busy = this.state.busy ? JSON.parse(JSON.stringify(this.state.busy)) : null;
    const loaded = JSON.parse(JSON.stringify(this.state.loaded));
    this.snapshot().then((s) => this.events.emitAll("models", { ...s, busy, loaded })).catch(() => {});
  }
  _progress(text) {
    console.log(`[models] ${this.state.busy?.action || "-"} ${this.state.busy?.modality || "-"}: ${text}`);
    if (!this.state.busy) return;
    this.state.busy.progress.push({ at: nowS(), text });
    if (this.state.busy.progress.length > 40) this.state.busy.progress.splice(0, this.state.busy.progress.length - 40);
    // push each step out as it happens: a load takes tens of seconds and the page should say what it is
    // doing, not spin an animation that means nothing
    this._emit();
  }

  /**
   * The GPU just came up. Unless somebody asked for something specific, put the default modality in
   * VRAM — H3 out of the box, or whatever the user last loaded by hand. A skill that names a model
   * powers the box on through ensure() itself, and that load takes precedence: we hold back 25 s and
   * bail out if anything is already loading or loaded.
   */
  async bootLoad(reason = "power-on") {
    if (this._booting) return null;
    this._booting = true;
    try {
      const pref = await this.bootPref();
      if (!pref || pref.modality === "off") return null;
      await new Promise((r) => setTimeout(r, 25_000));
      if (this.state.busy) return null;                       // an explicit load is already running
      await this.refresh().catch(() => {});
      // "video loaded" only means the ComfyUI process is up; the 20 GB of weights arrive on the first
      // graph. So a box that just booted with ComfyUI autostarted still counts as cold and gets warmed.
      const inVram = Object.entries(this.state.loaded)
        .filter(([mod]) => mod !== "video" || this.state.comfyModelsLoaded).length;
      if (inVram) return null;
      if (this.power.status.state !== "on") return null;
      console.log(`[models] boot load ${pref.modality}${pref.modelId ? " " + pref.modelId : ""} (${reason})`);
      return await this.ensure(pref.modality, pref.modelId, () => {});
    } catch (e) { console.log("[models] boot load failed: " + e.message); return null; }
    finally { this._booting = false; }
  }

  /** What to load on power-on: {modality, modelId} | {modality:"off"}. Defaults to video (MiniMax-H3). */
  async bootPref() {
    const s = (await this.store.read()).settings || {};
    return s.bootLoad || { modality: "video", modelId: null };
  }
  async setBootPref(pref) {
    await this.store.update((s) => { s.settings = s.settings || {}; s.settings.bootLoad = pref; });
    this._emit(); return pref;
  }

  /**
   * Make `modality` ready (optionally a specific model). Turns the instance on, evicts conflicting
   * modalities, starts the runner, waits for its port. Idempotent when already loaded.
   */
  async ensure(modality, modelId = null, onProgress = () => {}, { remember = false } = {}) {
    const c = await this.catalog();
    const mdef = c.modalities[modality]; if (!mdef) throw new Error(`未知模态 ${modality}`);
    const model = modelId ? await this.model(modelId) : await this.defaultFor(modality);
    if (!model && modality !== "video" && modality !== "whitemodel") throw new Error(`目录里没有可用的 ${mdef.label} 模型`);
    return this._serial(async () => {
      const cur = this.state.loaded[modality];
      const say = (t) => { onProgress(t); this._progress(t); };
      const conflicts = (mdef.exclusive || []).filter((o) => this.state.loaded[o] || (o === "video" && this.state.comfyModelsLoaded));
      const argsChanged = modality === "llm" && cur?.args != null && model && cur.args !== this.argsFor(model).join(" ");
      // "video loaded" used to mean only that the ComfyUI process was up; the weights arrived on the first
      // real job, so 加载 looked like a no-op. Treat it as done only when the weights are actually in VRAM.
      const videoCold = modality === "video" && !this.state.comfyModelsLoaded;
      if (cur && !videoCold && (!model || cur.modelId === model.id || (cur.inferred && !cur.modelId)) && !conflicts.length && !argsChanged) {
        // already up and nothing conflicting on the card: nothing to do
        this.touch(modality); return { modality, modelId: cur.modelId || model?.id || null, alreadyLoaded: true };
      }
      this.state.busy = { action: "load", modality, modelId: model?.id || null, since: nowS(), progress: [] }; this._emit();
      try {
        await this.power.ensureOn(say);
        await this.refresh().catch(() => {});
        // 1) evict conflicts
        for (const other of mdef.exclusive || []) {
          if (this.state.loaded[other] || (other === "video" && this.state.comfyModelsLoaded)) { say(`释放 ${c.modalities[other]?.label || other} 的显存…`); await this._unload(other, c); }
        }
        // 2) start runner
        const prog = PROGRAM[modality];
        if (prog === "comfyui") {
          if (this.state.gpu?.programs?.comfyui !== "RUNNING") { say("启动 ComfyUI…"); await this.gpuctl.start("comfyui"); }
          say("等待 ComfyUI 就绪…"); const w = await this.gpuctl.waitPort(8188, 180); if (!w.ok) throw new Error("ComfyUI 180 秒内没起来");
          const s = await this.comfy.state(15_000); if (s.state !== "on") throw new Error("ComfyUI 端口开了但接口不通：" + (s.reason || ""));
          await this.refresh().catch(() => {});
          if (!this.state.comfyModelsLoaded) {
            const { loadTemplate } = await import("./workflows.js");
            const r = await this.comfy.warmup(loadTemplate("native_t2v"), { say });
            say(`H3 权重已进显存（预热 ${r.seconds}s）`);
          }
        } else if (prog === "llm") {
          const cur2 = this.state.loaded.llm;
          const wantArgs = this.argsFor(model).join(" ");
          if (cur2 && ((cur2.modelId && cur2.modelId !== model.id) || (cur2.args != null && cur2.args !== wantArgs))) { say(cur2.modelId !== model.id ? `卸载 ${cur2.modelId}…` : "启动参数变了（如上下文长度），重载…"); await this.gpuctl.stop("llm"); delete this.state.loaded.llm; }
          if (!this.state.loaded.llm || this.state.loaded.llm.modelId !== model.id) {
            say(`加载 ${model.name}（${model.fileGb ?? "?"} GB，约 ${Math.round((model.loadSeconds || 60))} 秒）…`);
            const wa = this.argsFor(model);
            say(`按当前显卡（${Math.round((this.state.gpu?.vram?.total || 32607) / 1024)} GB）自动选上下文 ${Math.round(Number(wa[wa.indexOf("-c") + 1]) / 1024)}k`);
            const r = await this.gpuctl.start("llm", { MODEL: model.source.path, ARGS: wa.join(" "), ALIAS: model.id });
            if (!r.ok) throw new Error("llama-server 启动失败：" + (r.out || ""));
            const w = await this.gpuctl.waitPort(8080, 240); if (!w.ok) { const l = await this.gpuctl.log("llm", 20).catch(() => null); throw new Error("llama-server 240 秒内没就绪" + (l?.log ? "：" + l.log.split("\n").slice(-3).join(" | ").slice(0, 300) : "")); }
            await this._waitHttp(`${this.upstreams.llm}/health`, 240, say);
          }
        } else if (prog === "voice") {
          // one router process hosts several TTS engines; engines are (un)loaded inside it, the process only restarts when down
          if (!this.state.loaded.voice) {
            say(`启动语音服务（默认引擎 ${model.name}）…`);
            const r = await this.gpuctl.start("voice", { MODEL: model.source.path, MODEL_ID: model.id === "sensevoice-small" ? "indextts-2" : model.id, KIND: model.kind || "" });
            if (!r.ok) throw new Error("语音服务启动失败：" + (r.out || ""));
            const w = await this.gpuctl.waitPort(8600, 300); if (!w.ok) { const l = await this.gpuctl.log("voice", 20).catch(() => null); throw new Error("语音服务 300 秒内没就绪" + (l?.log ? "：" + l.log.split("\n").slice(-3).join(" | ").slice(0, 300) : "")); }
            await this._waitHttp(`${this.upstreams.voice}/health`, 300, say);
          }
          if (model.id !== "sensevoice-small") {
            say(`加载语音引擎 ${model.name}…`);
            const r = await fetch(`${this.upstreams.voice}/engines/${encodeURIComponent(model.id)}/load`, { method: "POST", signal: AbortSignal.timeout(900_000) });
            if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`语音引擎 ${model.id} 加载失败：${t.slice(0, 300)}`); }
          }
        }
        await this.refresh().catch(() => {});
        this.state.loaded[modality] = { modelId: model?.id || null, since: nowS(), inferred: false, weights: modality === "video" ? this.state.comfyModelsLoaded : undefined, args: modality === "llm" ? this.argsFor(model).join(" ") : undefined };
        this.touch(modality); this.state.lastError = null;
        say(`${mdef.label} 就绪`);
        await this.store.update((s) => {
          s.audit.push({ at: new Date().toISOString(), action: "model.load", modality, modelId: model?.id || null, vram: this.state.gpu?.vram?.used ?? null });
          // "开机后默认加载 H3，除非用户手工切换到其他模型" — a load the user asked for becomes the new boot default
          if (remember) { s.settings = s.settings || {}; s.settings.bootLoad = { modality, modelId: model?.id || null }; }
        });
        return { modality, modelId: model?.id || null, alreadyLoaded: false, vram: this.state.gpu?.vram || null };
      } catch (e) { this.state.lastError = e.message; console.log(`[models] ensure ${modality} failed: ${e.message}`); throw e; }
      finally { this.state.busy = null; this._emit(); }
    });
  }

  async _waitHttp(url, secs, say) {
    const t0 = Date.now();
    while (Date.now() - t0 < secs * 1000) {
      // llama-server answers 503 on /health while still loading; anything else (200, or 404 from a mock) means the port is served
      try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (r.status !== 503) return true; } catch {}
      await new Promise((r) => setTimeout(r, 2000));
      if ((Date.now() - t0) % 20000 < 2100) say(`等待服务就绪… ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    throw new Error(`${url} ${secs} 秒内没有响应`);
  }

  async _unload(modality, c = null) {
    if (modality === "video" || modality === "whitemodel") {
      if (this.state.gpu?.programs?.comfyui === "RUNNING") { const r = await this.gpuctl.free(); if (!r.ok) throw new Error("ComfyUI /free 失败"); }
      this.state.comfyModelsLoaded = false; if (this.state.loaded.video) this.state.loaded.video.weights = false;
    } else {
      await this.gpuctl.stop(PROGRAM[modality]).catch((e) => { throw new Error(`停止 ${modality} 失败：${e.message}`); });
      delete this.state.loaded[modality];
    }
    await this.store.update((s) => { s.audit.push({ at: new Date().toISOString(), action: "model.unload", modality }); });
  }

  async unload(modality) {
    return this._serial(async () => {
      this.state.busy = { action: "unload", modality, since: nowS(), progress: [] }; this._emit();
      try { await this._unload(modality); await this.refresh().catch(() => {}); return { ok: true }; }
      finally { this.state.busy = null; this._emit(); }
    });
  }

  /** Idle path: free everything (H3 weights, llm, voice) but keep ComfyUI's process. */
  async unloadAll() {
    return this._serial(async () => {
      this.state.busy = { action: "unload", modality: "all", since: nowS(), progress: [] }; this._emit();
      try {
        await this.refresh().catch(() => {});
        for (const m of ["llm", "voice"]) if (this.state.loaded[m]) await this._unload(m).catch((e) => { this.state.lastError = e.message; });
        if (this.state.comfyModelsLoaded) await this._unload("video").catch((e) => { this.state.lastError = e.message; });
        await this.refresh().catch(() => {});
      } finally { this.state.busy = null; this._emit(); }
    });
  }

  /**
   * Full acceptance test for a model: load it (timing + VRAM delta), then exercise it for real —
   * llm: a Chinese and an English completion with token rates; voice: TTS a sentence and transcribe it back;
   * video / whitemodel: run a tiny real job through the queue (via hooks from index.js). The report is
   * stored with the model and shown in the UI; `tested` flips to true only when every step passed.
   */
  async test(modelId, onProgress = () => {}) {
    const m = await this.model(modelId);
    const say = (t) => { onProgress(t); if (this.state.busy) this._progress(t); else this.events.emitAll("toast", { level: "info", text: `[测试 ${m.name}] ${t}` }); };
    const report = { modelId: m.id, startedAt: nowS(), steps: [] };
    const step = (name, ok, detail = {}) => { report.steps.push({ name, ok, ...detail }); say(`${ok ? "✓" : "✗"} ${name}${detail.ms ? ` ${(detail.ms / 1000).toFixed(1)}s` : ""}`); };
    const before = (await this.refresh().catch(() => this.state.gpu))?.vram?.used ?? 0;
    const t0 = Date.now();
    let ensured;
    try { ensured = await this.ensure(m.modality, m.id, say); step("加载", true, { ms: Date.now() - t0, alreadyLoaded: !!ensured.alreadyLoaded }); }
    catch (e) { step("加载", false, { error: e.message }); await this.setOverride(m.id, { tested: false, lastReport: { ...report, ok: false, finishedAt: nowS() } }); throw e; }
    const after = this.state.gpu?.vram?.used ?? 0;
    report.loadSeconds = ensured.alreadyLoaded ? (m.loadSeconds || null) : Math.round((Date.now() - t0) / 1000);
    report.vram = ensured.alreadyLoaded ? (m.vram || null) : Math.max(0, after - before) || m.vram || null;
    const json = async (url, body, timeoutMs = 180_000) => { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160)}`); return r.json(); };
    try {
      if (m.modality === "llm") {
        for (const [name, prompt, must] of [["中文问答", "用一句话介绍杭州。/no_think", /杭州|西湖|浙江/], ["English", "Reply with one sentence: what is a GPU? /no_think", /GPU|graphics|processor|unit/i]]) {
          const t1 = Date.now();
          try {
            const j = await json(`${this.upstreams.llm}/v1/chat/completions`, { model: m.id, messages: [{ role: "user", content: prompt }], max_tokens: 120, temperature: 0.3 });
            const text = j.choices?.[0]?.message?.content?.trim() || ""; const tm = j.timings || {};
            step(name, text.length > 0 && (must.test(text) || /mock/i.test(text)), { ms: Date.now() - t1, text: text.slice(0, 200), tps: tm.predicted_per_second ? Math.round(tm.predicted_per_second) : null, promptTps: tm.prompt_per_second ? Math.round(tm.prompt_per_second) : null, tokens: j.usage?.completion_tokens ?? null });
          } catch (e) { step(name, false, { ms: Date.now() - t1, error: e.message }); }
        }
        const t2 = Date.now();
        try { const r = await fetch(`${this.upstreams.llm}/v1/models`, { signal: AbortSignal.timeout(20_000) }); const j = await r.json().catch(() => ({})); step("模型列表", r.ok, { ms: Date.now() - t2, ids: (j.data || []).map((x) => x.id).slice(0, 5) }); } catch (e) { step("模型列表", false, { error: e.message }); }
      } else if (m.modality === "voice") {
        const t1 = Date.now(); let wav = null;
        try {
          const r = await fetch(`${this.upstreams.voice}/tts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "这是一次语音模型测试，一二三四五。" }), signal: AbortSignal.timeout(600_000) });
          if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
          wav = Buffer.from(await r.arrayBuffer()); const secs = Number(r.headers.get("x-audio-seconds")) || null;
          step("合成 TTS", wav.length > 1000, { ms: Date.now() - t1, bytes: wav.length, audioSeconds: secs });
        } catch (e) { step("合成 TTS", false, { ms: Date.now() - t1, error: e.message }); }
        if (wav) {
          const t2 = Date.now();
          try {
            const fd = new FormData(); fd.append("file", new Blob([wav], { type: "audio/wav" }), "test.wav");
            const r = await fetch(`${this.upstreams.voice}/asr`, { method: "POST", body: fd, signal: AbortSignal.timeout(600_000) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`); const j = await r.json();
            const text = j.text || ""; step("转写回读", /语音|测试|一二三|模型/.test(text), { ms: Date.now() - t2, text: text.slice(0, 120), language: j.language || null });
          } catch (e) { step("转写回读", false, { ms: Date.now() - t2, error: e.message }); }
        }
      } else if (m.modality === "video" || m.modality === "whitemodel") {
        const hook = this.hooks?.[m.modality === "video" ? "testVideo" : "testWhitemodel"];
        if (!hook) step("真实任务", false, { error: "没有配置测试钩子" });
        else { const t1 = Date.now(); try { const r = await hook(say); step(m.modality === "video" ? "真实 H3 任务（640×384 · 2 s）" : "真实白模任务（合成小片）", r.status === "done", { ms: Date.now() - t1, jobId: r.jobId, error: r.error || null, output: r.output || null }); } catch (e) { step("真实任务", false, { ms: Date.now() - t1, error: e.message }); } }
      }
    } finally {
      await this.refresh().catch(() => {});
      report.vramAfter = this.state.gpu?.vram?.used ?? null;
    }
    report.ok = report.steps.every((s) => s.ok); report.finishedAt = nowS();
    const patch = { tested: report.ok, lastReport: report, testedAt: report.ok ? nowS() : (m.testedAt || null) };
    if (report.ok) { if (report.vram) patch.vram = report.vram; if (report.loadSeconds) patch.loadSeconds = report.loadSeconds; const tps = report.steps.find((s) => s.tps)?.tps; if (tps) patch.tps = tps; }
    await this.setOverride(m.id, patch);
    await this.store.update((s) => { s.audit.push({ at: new Date().toISOString(), action: "model.tested", modelId: m.id, ok: report.ok }); });
    this._emit();
    return { ...ensured, ok: report.ok, vram: report.vram, loadSeconds: report.loadSeconds, report, smoke: { text: report.steps.find((s) => s.text)?.text || null, tps: report.steps.find((s) => s.tps)?.tps || null } };
  }

  async download(modelId) {
    const m = await this.model(modelId);
    if (m.source?.type !== "download") throw new Error("这个模型不是下载型");
    const url = m.source.file || m.source.url; const dest = m.source.dest || path.basename(m.source.path);
    return this.gpuctl.download(url, dest, m.maxGb || 3);
  }
}
