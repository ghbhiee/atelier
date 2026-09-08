// GPU power manager: observes the ComfyUI tunnel, starts the CompShare instance on demand, stops
// it after a configurable idle period, and keeps an uptime ledger for the cost meter.
// The GPU is billed per hour (3.32 CNY/h by default) — forgetting to stop it is the expensive bug.
import { CompShare } from "./compshare.js";

const nowS = () => Math.floor(Date.now() / 1000);

export class Power {
  constructor(config, store, comfy, events, { hasActiveJobs = () => false, queueEta = null } = {}) {
    this.config = config; this.store = store; this.comfy = comfy; this.events = events;
    this.hasActiveJobs = hasActiveJobs; this.queueEta = queueEta;
    this.cs = config.compshare ? new CompShare({ publicKey: config.compshare.publicKey, privateKey: config.compshare.privateKey }) : null;
    this.status = { state: "unknown", since: null, reason: null, stats: null, cloudState: null, queue: { running: 0, pending: 0, items: [] }, lastHistory: null, idleSince: null, starting: false, stopping: false, lastProbe: null, lastError: null };
    this.startingPromise = null;
    this.timer = null;
    this.models = null; // set by index.js once the model manager exists
  }

  /** Liveness: gpuctl (ssh through the tunnel) when configured — ComfyUI is no longer always running — else ComfyUI itself. */
  async liveness(timeoutMs) {
    if (this.models?.gpuctl?.available) {
      try {
        const g = await this.models.refresh({ timeoutMs });
        const comfyUp = g.programs?.comfyui === "RUNNING" && (g.ports || []).includes(8188);
        const activity = gpuActivity(g, this._net);
        if (g.net) this._net = { rx: g.net.rx, tx: g.net.tx, at: g.at || nowS() };
        return { state: "on", comfyUp, stats: { vram: g.vram, gpuctl: true }, activity };
      } catch (e) {
        const m = String(e.message || "");
        return { state: /refused|Connection closed|closed by remote|kex_exchange/i.test(m) ? "off" : "unknown", comfyUp: false, reason: "gpuctl: " + m.slice(0, 120) };
      }
    }
    const r = await this.comfy.state(timeoutMs);
    return { ...r, comfyUp: r.state === "on" };
  }

  /** Roll the 20 s probes into a summary for this power-on session: what the card actually did, in the
   *  same dimensions nvidia-smi reports (SM %, memory-bus %, VRAM, power, temperature) plus derived
   *  busy time and energy. Reset whenever the box comes back up. */
  sample(v) {
    if (!v || typeof v.used !== "number") return;
    const st = this.usage ||= { since: nowS(), n: 0, utilSum: 0, utilMax: 0, memUtilSum: 0, vramMax: 0, vramSum: 0, tempMax: 0, powerSum: 0, powerMax: 0, busySamples: 0, last: null, series: [] };
    const now = nowS();
    const gap = st.last ? Math.min(120, now - st.last) : 0;   // seconds this sample stands for
    st.last = now; st.n++;
    st.utilSum += v.util || 0; st.utilMax = Math.max(st.utilMax, v.util || 0);
    st.memUtilSum += v.memUtil || 0;
    st.vramSum += v.used; st.vramMax = Math.max(st.vramMax, v.used);
    st.tempMax = Math.max(st.tempMax, v.temp || 0);
    st.powerSum += v.powerW || 0; st.powerMax = Math.max(st.powerMax, v.powerW || 0);
    if ((v.util || 0) >= 10) st.busySeconds = (st.busySeconds || 0) + gap;
    st.seconds = (st.seconds || 0) + gap;
    st.energyWh = (st.energyWh || 0) + ((v.powerW || 0) * gap) / 3600;
    st.series.push({ at: now, util: v.util || 0, vram: v.used, powerW: Math.round(v.powerW || 0) });
    if (st.series.length > 720) st.series.splice(0, st.series.length - 720);   // ~4 h at 20 s
  }

  /** What the dashboard shows: current reading + this power-on session's totals. */
  statsSummary() {
    const st = this.usage;
    if (!st || !st.n) return null;
    const v = this.latestVram();
    return {
      since: st.since, seconds: Math.round(st.seconds || 0), samples: st.n,
      utilAvg: +(st.utilSum / st.n).toFixed(1), utilMax: st.utilMax,
      memUtilAvg: +(st.memUtilSum / st.n).toFixed(1),
      vramAvgMib: Math.round(st.vramSum / st.n), vramMaxMib: st.vramMax,
      tempMax: st.tempMax, powerAvgW: +(st.powerSum / st.n).toFixed(1), powerMaxW: st.powerMax,
      busySeconds: Math.round(st.busySeconds || 0),
      busyPct: st.seconds ? +(100 * (st.busySeconds || 0) / st.seconds).toFixed(1) : 0,
      energyWh: +(st.energyWh || 0).toFixed(1),
      series: st.series.slice(-180), now: v || null,
    };
  }
  latestVram() { return this.usage?.series?.at(-1) || null; }

  async settings() {
    const s = (await this.store.read()).settings || {};
    return { hourlyRate: s.hourlyRate ?? this.config.hourlyRate, idleMinutes: s.idleMinutes ?? this.config.idleMinutes, autoOff: s.autoOff !== false, autoOn: s.autoOn !== false, canControl: !!(this.cs && this.config.compshare.instanceId) };
  }

  /** Probe ComfyUI (cheap) and the queue; record on/off transitions in the ledger. */
  async probe({ withQueue = true } = {}) {
    const r = await this.liveness(8000);
    const prev = this.status.state;
    let state = r.state;
    if (state === "unknown") state = prev === "on" ? "on" : "unknown"; // a busy tunnel is not "off"
    this.status.stats = r.stats ? { ...(this.status.stats || {}), ...r.stats } : this.status.stats;
    this.status.reason = r.reason || null;
    this.status.lastProbe = nowS();
    this.status.comfyUp = r.comfyUp;
    this.status.activity = r.activity || null;
    if (state === "on") this.sample(r.stats?.vram);
    const gpuBusy = !!r.activity?.busy;
    if (state === "on" && withQueue && !r.comfyUp) {
      // box is up but ComfyUI is not: the queue is empty by definition; idleness comes from our own jobs + model activity
      this.status.queue = { running: 0, pending: 0, items: [] };
      const busy = gpuBusy || this.hasActiveJobs() || !!this.models?.isBusy() || !!this.models?.recentlyActive(60);
      if (busy) this.status.idleSince = null; else if (this.status.idleSince == null) this.status.idleSince = nowS();
    }
    if (state === "on" && withQueue && r.comfyUp) {
      try {
        const q = await this.comfy.queue();
        const items = [...q.queue_running.map((j) => ({ ...summarize(j), running: true })), ...q.queue_pending.map((j) => ({ ...summarize(j), running: false }))];
        this.status.queue = { running: q.queue_running.length, pending: q.queue_pending.length, items };
        const h = await this.comfy.recentHistory(1).catch(() => ({}));
        const last = Object.keys(h)[0] || null;
        const busy = gpuBusy || items.length > 0 || this.hasActiveJobs() || !!this.models?.isBusy() || !!this.models?.recentlyActive(60);
        if (busy || last !== this.status.lastHistory) { this.status.idleSince = null; this.status.lastHistory = last; }
        else if (this.status.idleSince == null) this.status.idleSince = nowS();
      } catch { /* keep previous queue info */ }
    }
    // "off" here has always meant "ComfyUI is not answering", which is not the same as "the instance is
    // stopped" — a freshly rented box can be Running in the cloud with nothing installed on it yet. Ask
    // CompShare what it thinks (at most once a minute) so the two can be told apart on screen.
    if (state !== "on" && this.cs && this.config.compshare?.instanceId) {
      const age = nowS() - (this.status.cloudStateAt || 0);
      if (age > 60) {
        this.status.cloudStateAt = nowS();
        this.cs.state(this.config.compshare.instanceId, { region: this.config.compshare.region })
          .then((cs) => { this.status.cloudState = cs; })
          .catch(() => { this.status.cloudState = null; });
      }
    } else if (state === "on") this.status.cloudState = "Running";
    if (state !== prev) {
      this.status.state = state; this.status.since = nowS(); this.status.idleSince = null;
      this.usage = null;   // a new power-on session starts a fresh utilisation summary
      await this.store.update((s) => {
        const p = s.power;
        const open = p.periods.find((x) => x.end == null);
        if (state === "on" && !open) p.periods.push({ start: nowS(), end: null });
        if (state === "off" && open) open.end = nowS();
        p.lastState = state; p.lastChange = nowS();
        s.audit.push({ at: new Date().toISOString(), action: `gpu.${state}` });
      });
      this.events.emitAll("gpu", await this.snapshot());
      // Fresh power-on: hand over to the model manager so the box comes up with something usable in VRAM.
      if (state === "on" && prev !== "on") this.models?.bootLoad?.("probe saw the box come up");
    } else if (withQueue) this.events.emitAll("gpu", await this.snapshot());
    return this.status.state;
  }

  async snapshot() {
    const st = await this.settings();
    const cost = await this.cost(st.hourlyRate);
    const s = this.status;
    let etaSeconds = null; try { etaSeconds = this.queueEta ? this.queueEta(s.queue.items) : null; } catch {}
    return { state: s.starting ? "starting" : s.stopping ? "stopping" : s.state, since: s.since, reason: s.reason, comfyUp: s.comfyUp ?? (s.state === "on"), models: this.models ? { loaded: this.models.state.loaded, busy: this.models.state.busy, vram: this.models.state.gpu?.vram || null } : null, queue: { ...s.queue, etaSeconds }, idleSince: s.idleSince, activity: s.activity || null, stats: this.statsSummary(), idleMinutes: st.idleMinutes, autoOff: st.autoOff, autoOn: st.autoOn, canControl: st.canControl, hourlyRate: st.hourlyRate, cost, device: s.stats?.devices?.[0] ? { name: s.stats.devices[0].name, vramTotal: s.stats.devices[0].vram_total, vramFree: s.stats.devices[0].vram_free }
        // With gpuctl reachable we never call ComfyUI's /system_stats, so take the card straight from nvidia-smi.
        : s.stats?.vram?.total ? { name: s.stats.vram.name || "GPU", vramTotal: s.stats.vram.total * 1048576, vramFree: Math.max(0, (s.stats.vram.total - (s.stats.vram.used || 0)) * 1048576) } : null, comfyVersion: s.stats?.system?.comfyui_version || null, wsConnected: this.comfy.connected, lastError: s.lastError, instanceId: this.config.compshare?.instanceId || null,
      box: this.config.fleet?.active ? { name: this.config.fleet.active.name, label: this.config.fleet.active.label } : null,
      cloudState: s.cloudState || null };
  }

  /** Uptime per calendar day for the last N days → [{day, seconds, cny}]. */
  async usageByDay(days = 14, rate = null) {
    const p = (await this.store.read()).power; rate = rate ?? (await this.settings()).hourlyRate;
    const t = nowS(); const out = new Map();
    for (let i = days - 1; i >= 0; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); out.set(d.toISOString().slice(0, 10), { day: d.toISOString().slice(0, 10), start: Math.floor(d.getTime() / 1000), seconds: 0 }); }
    for (const x of p.periods) {
      const end = x.end ?? t;
      for (const rec of out.values()) { const a = Math.max(x.start, rec.start), b = Math.min(end, rec.start + 86400); if (b > a) rec.seconds += b - a; }
    }
    return [...out.values()].map((r) => ({ day: r.day, seconds: r.seconds, cny: +(r.seconds / 3600 * rate).toFixed(2) }));
  }
  /** Uptime ledger → cost. */
  async cost(rate) {
    const p = (await this.store.read()).power;
    const t = nowS(), dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const d0 = Math.floor(dayStart.getTime() / 1000);
    let total = 0, today = 0, current = 0;
    for (const x of p.periods) {
      const end = x.end ?? t;
      total += end - x.start;
      today += Math.max(0, end - Math.max(x.start, d0));
      if (x.end == null) current = t - x.start;
    }
    return { rate, totalSeconds: total, todaySeconds: today, currentSeconds: current, totalCny: +(total / 3600 * rate).toFixed(2), todayCny: +(today / 3600 * rate).toFixed(2), currentCny: +(current / 3600 * rate).toFixed(2) };
  }

  /** Make sure the GPU is on before a job. Resolves when ComfyUI answers. */
  async ensureOn(onProgress = () => {}) {
    if (this.status.state === "on") return "on";
    const st = await this.settings();
    if (this.startingPromise) { onProgress("GPU 正在开机（另一任务已触发）…"); return this.startingPromise; }
    const state = await this.probe({ withQueue: false });
    if (state === "on") return "on";
    if (!st.canControl) throw new Error("GPU 是关机状态，而且没有配置 CompShare 凭据，无法自动开机");
    if (!st.autoOn) throw new Error("GPU 是关机状态，自动开机已关闭；请在仪表盘手动开机");
    this.startingPromise = (async () => {
      this.status.starting = true; this.status.lastError = null;
      this.events.emitAll("gpu", await this.snapshot());
      try {
        let inst = this.config.compshare;
        let cloud = await this.cs.state(inst.instanceId, { region: inst.region });
        this.status.cloudState = cloud;
        // 机器可能已经被删掉了（云上查不到），这时候等 8 分钟毫无意义，直接说清楚并让车队接手
        if (cloud === "NotFound") {
          onProgress(`${this.config.fleet.active.label || this.config.fleet.active.name} 在云上已经不存在了（实例 ${inst.instanceId}）`);
          const alt = await this.tryOtherBoxes(onProgress, new Error("实例不存在"));
          if (!alt) throw new Error(`${this.config.fleet.active.label || this.config.fleet.active.name} 已被删除，且没有别的可用机器；到「仪表盘」换一台，或把它从 GPU_BOXES 里去掉`);
          inst = this.config.compshare; cloud = "Starting";
        }
        else if (cloud === "Stopped") {
          onProgress("正在调用 CompShare 开机…");
          try { await this.cs.start(inst.instanceId, { region: inst.region, zone: inst.zone }); }
          catch (e) {
            // "This GPU type is currently out of resources" is why the fleet exists: a region can simply
            // have no free card. Walk the other configured boxes before giving up.
            if (!/out of resources|226604/.test(e.message)) throw e;
            const alt = await this.tryOtherBoxes(onProgress, e);
            if (!alt) throw new Error(`${this.config.fleet.active.label || this.config.fleet.active.name} 没有空闲的卡，其它机器也开不起来：${e.message}`);
            inst = this.config.compshare; cloud = "Starting";
          }
        }
        else onProgress(`实例状态 ${cloud}，等待 ComfyUI 就绪…`);
        const t0 = Date.now();
        while (Date.now() - t0 < 8 * 60_000) {
          await new Promise((r) => setTimeout(r, 15_000));
          const s = await this.probe({ withQueue: false });
          if (s === "on") { onProgress(`已开机并就绪（等了 ${Math.round((Date.now() - t0) / 1000)} 秒）`); return "on"; }
          onProgress(`等待 GPU 就绪… ${Math.round((Date.now() - t0) / 1000)}s`);
        }
        throw new Error("开机后 8 分钟内 ComfyUI 仍不可达，检查 GPU 上的 supervisor（gputunnel / comfyui）");
      } catch (e) { this.status.lastError = e.message; throw e; }
      finally { this.status.starting = false; this.startingPromise = null; this.events.emitAll("gpu", await this.snapshot()); }
    })();
    return this.startingPromise;
  }

  /**
   * One region ran out of cards. Try every other configured box in order; the first one that accepts a
   * start becomes the active box for everything (ports, CompShare instance, asset host) and the caller
   * carries on waiting for it. Returns the box that took it, or null.
   */
  async tryOtherBoxes(onProgress, firstError) {
    const boxes = this.config.boxes.filter((b) => b.instanceId && b.name !== this.config.fleet.active.name);
    if (!boxes.length) { onProgress(`没有备用机器可换（${firstError.message}）`); return null; }
    const from = this.config.fleet.active.name;
    for (const b of boxes) {
      onProgress(`${from} 没有空闲的卡，改试 ${b.label || b.name}…`);
      try {
        const st = await this.cs.state(b.instanceId, { region: b.region });
        if (st === "NotFound") { onProgress(`${b.name} 云上已不存在，跳过`); continue; }
        if (st !== "Stopped" && st !== "Running") { onProgress(`${b.name} 状态 ${st}，跳过`); continue; }
        if (st === "Stopped") await this.cs.start(b.instanceId, { region: b.region, zone: b.zone });
        this.config.useBox(b.name);
        this.models?.onBoxChanged?.(b);
        await this.store.update((s) => { s.settings = s.settings || {}; s.settings.activeBox = b.name; s.audit.push({ at: new Date().toISOString(), action: "gpu.box.switch", from, to: b.name, reason: "out of resources" }); });
        onProgress(`已切到 ${b.label || b.name}，等待它就绪…`);
        return b;
      } catch (e) { onProgress(`${b.name} 也开不起来：${e.message.slice(0, 90)}`); }
    }
    return null;
  }

  async start() { return this.ensureOn(() => {}); }

  async stop({ force = false, reason = "manual" } = {}) {
    const st = await this.settings();
    if (this.status.state === "on" && !force) {
      await this.probe();
      if (this.status.queue.running + this.status.queue.pending > 0) throw new Error(`队列里还有 ${this.status.queue.running + this.status.queue.pending} 个任务（可能是别的会话提交的），没关机；确定要关请用强制关机`);
      if (this.hasActiveJobs()) throw new Error("本站还有进行中的任务，没关机");
      if (this.status.activity?.busy) throw new Error(`GPU 上还有别的活动（${this.status.activity.why.join("；")}），没关机；确定要关请用强制关机`);
    }
    if (!st.canControl) throw new Error("没有配置 CompShare 凭据，无法关机");
    this.status.stopping = true; this.events.emitAll("gpu", await this.snapshot());
    try {
      const inst = this.config.compshare;
      // A misconfigured region/zone must not leave the card running and billing. Try the configured pair
      // first, then the same call without Zone, then every region we know of — the API answers
      // "Params [Zone] not available" when the pair does not match the instance.
      const tries = [{ region: inst.region, zone: inst.zone }, { region: inst.region }];
      for (const b of this.config.boxes) if (b.region && b.region !== inst.region) tries.push({ region: b.region, zone: b.zone }, { region: b.region });
      let lastErr = null, stopped = false;
      for (const t of tries) {
        try { await this.cs.stop(inst.instanceId, t); stopped = true; if (t.region !== inst.region || t.zone !== inst.zone) console.log(`[power] stop needed ${t.region}/${t.zone || "-"}, not ${inst.region}/${inst.zone || "-"} — fix GPU_*_REGION`); break; }
        catch (e) { lastErr = e; }
      }
      if (!stopped) throw lastErr || new Error("关机失败");
      await this.store.update((s) => { s.audit.push({ at: new Date().toISOString(), action: "gpu.stop", reason }); });
      this.status.state = "off"; this.status.since = nowS(); this.status.idleSince = null;
      await this.store.update((s) => { const open = s.power.periods.find((x) => x.end == null); if (open) open.end = nowS(); s.power.lastState = "off"; });
      return "off";
    } finally { this.status.stopping = false; this.events.emitAll("gpu", await this.snapshot()); }
  }

  /** Background loop: probe every 20 s; idle watchdog stops the GPU. */
  startLoop() {
    if (this.timer) return;
    const tick = async () => {
      try {
        await this.probe();
        const st = await this.settings();
        if (this.status.state === "on" && st.autoOff && st.canControl && this.status.activity?.busy && (nowS() - (this.lastHoldLog || 0)) > 600) {
          this.lastHoldLog = nowS(); console.log(`[power] idle rule on hold: ${this.status.activity.why.join("; ")}`);
        }
        if (this.status.state === "on" && st.autoOff && st.canControl && this.status.idleSince != null && !this.hasActiveJobs() && !this.startingPromise && !this.status.activity?.busy) {
          const idle = nowS() - this.status.idleSince;
          if (idle >= st.idleMinutes * 60) {
            // Powering the instance off frees the VRAM anyway, so unloading first only delays the thing
            // that actually stops the billing — and it used to leave the page saying 卸载模型 for a minute.
            console.log(`[power] idle ${Math.round(idle / 60)} min → stop GPU`);
            this.events.emitAll("toast", { level: "info", text: `GPU 空闲 ${Math.round(idle / 60)} 分钟，自动关机` });
            const stopped = await this.stop({ reason: "idle" }).then(() => true).catch((e) => { this.status.lastError = e.message; return false; });
            if (stopped && this.models) { this.models.state.loaded = {}; this.models.state.comfyModelsLoaded = false; this.models.state.gpu = null; this.models._emit(); }
          }
        }
      } catch (e) { this.status.lastError = e.message; }
    };
    tick();
    this.timer = setInterval(tick, 20_000);
  }
  stopLoop() { clearInterval(this.timer); this.timer = null; }
}

/** GPU-side activity that 13 cannot see through its own jobs: one-shot supervisor programs (installs, self-tests,
 *  downloads), GPU compute by processes we do not manage, sustained utilisation, or bytes moving over the network
 *  (an upload in flight, a model download — the link to the box is ~40 KB/s, so the floor has to be low).
 *  Any of these keeps the idle rule from stopping the box (never stop a GPU another session is using).
 *  ssh shells deliberately do not count (too broad — a forgotten shell would keep the meter running). */
// The box idles at ~60 KB/s of chatter with the provider's own infrastructure (agents, the shared /model
// mount), so the floor has to sit above that. A real transfer — a browser upload, a model download — is
// hundreds of KB/s at least, and anything slower that matters to us is a tracked job anyway.
const NET_MIN_RATE = 200 * 1024;    // bytes/second averaged between two probes
// long-running daemons on the box (ours + the provider's defaults) — everything else under supervisor is a one-shot job
const MANAGED_PROGRAMS = new Set(["comfyui", "gputunnel", "llm", "voice", "assets", "hytunnel", "jupyterlab", "filebrowser"]);
const MANAGED_PROC = /ComfyUI|main\.py|llama-server|atelier-gpu\/(voice|assets)|(voice|assets)\/server\.py/;
export function gpuActivity(g, prev = null) {
  const why = [];
  let net = null;
  if (g.net && prev && g.at >= prev.at) {
    const bytes = (g.net.rx - prev.rx) + (g.net.tx - prev.tx);
    const secs = Math.max(1, g.at - prev.at);   // probes are 20 s apart in production, back-to-back in tests
    if (bytes >= 0) {                                        // negative = counters reset (reboot); skip this sample
      net = { bytes, secs, rate: Math.round(bytes / secs) };
      if (net.rate >= NET_MIN_RATE) why.push(`网络在传数据 ${Math.round(net.rate / 1024)} KB/s（上传素材或下载模型）`);
    }
  }
  const oneshots = Object.entries(g.programs || {}).filter(([n, st]) => st === "RUNNING" && !MANAGED_PROGRAMS.has(n)).map(([n]) => n);
  if (oneshots.length) why.push(`后台任务在跑：${oneshots.join(", ")}`);
  const foreign = (g.procs || []).filter((p) => p.cmd && !MANAGED_PROC.test(p.cmd));
  if (foreign.length) why.push(`别的进程在用显卡：${foreign.map((p) => p.cmd.slice(0, 40)).join(" | ")}`);
  const util = Number(g.vram?.util || 0);
  if (util >= 10) why.push(`显卡利用率 ${util}%`);
  return { busy: why.length > 0, why, oneshots, foreignProcs: foreign.length, util, net };
}

function summarize(j) {
  const det = {};
  for (const n of Object.values(j[2] || {})) {
    const ct = n.class_type, inp = n.inputs || {};
    if (ct === "UNETLoader") det.weights = String(inp.unet_name || "").includes("ref2va") ? "ref2va" : "fl2va";
    else if (ct === "BasicScheduler") det.steps = inp.steps;
    else if (ct === "MiniMaxH3ImageToVideo" || ct === "MiniMaxH3ReferenceToVideo") { det.width = inp.width; det.height = inp.height; det.length = inp.length; }
  }
  return { promptId: j[1], number: j[0], clientId: j[3]?.client_id || null, ...det };
}
