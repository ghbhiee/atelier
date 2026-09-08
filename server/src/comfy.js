// ComfyUI client. The GPU's ComfyUI is reached through the reverse SSH tunnel that lands on this
// box (127.0.0.1:19188). ECONNREFUSED there means the tunnel is down, i.e. the GPU is off.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import WebSocket from "ws";

export class Comfy {
  constructor(config, events) {
    this.config = config;
    this.clientId = config.comfyClientId;
    this.events = events;
    this.ws = null;
    this.wsTimer = null;
    this.connected = false;
  }

  /** Read through to the active box so switching machines needs no restart. */
  get base() { return this.config.comfyUrl; }

  async fetch(pathname, { method = "GET", body, timeoutMs = 20_000, headers = {} } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(this.base + pathname, { method, body, headers, signal: ctl.signal });
      return res;
    } finally { clearTimeout(t); }
  }
  async json(pathname, opts = {}) {
    const res = await this.fetch(pathname, opts);
    if (!res.ok) { const text = await res.text().catch(() => ""); const e = new Error(`ComfyUI ${pathname} → HTTP ${res.status} ${text.slice(0, 300)}`); e.status = res.status; throw e; }
    return res.json();
  }

  /** 'on' | 'off' (tunnel refused) | 'unknown' (timeout: tunnel busy or GPU booting) */
  async state(timeoutMs = 10_000) {
    try {
      const stats = await this.json("/system_stats", { timeoutMs });
      return { state: "on", stats };
    } catch (error) {
      const code = error.cause?.code || error.code;
      if (code === "ECONNREFUSED" || code === "ECONNRESET") return { state: "off", reason: "tunnel down" };
      if (error.name === "AbortError" || error.name === "TimeoutError") return { state: "unknown", reason: "timeout" };
      return { state: "unknown", reason: error.message };
    }
  }

  queue() { return this.json("/queue", { timeoutMs: 15_000 }); }
  /** Files ComfyUI sees in models/loras (ComfyUI ≥ 0.3: GET /models/{folder}). */
  async loras() { const r = await this.json("/models/loras", { timeoutMs: 15_000 }); return Array.isArray(r) ? r : (r.files || r.items || []); }
  history(promptId) { return this.json(`/history/${promptId}`, { timeoutMs: 30_000 }); }
  recentHistory(n = 5) { return this.json(`/history?max_items=${n}`, { timeoutMs: 30_000 }); }
  interrupt() { return this.fetch("/interrupt", { method: "POST" }); }
  clearQueue() { return this.fetch("/queue", { method: "POST", body: JSON.stringify({ clear: true }), headers: { "content-type": "application/json" } }); }
  async deleteQueued(promptIds) { return this.fetch("/queue", { method: "POST", body: JSON.stringify({ delete: promptIds }), headers: { "content-type": "application/json" } }); }

  /** Upload a local file into ComfyUI's input directory (videos also go through /upload/image). */
  async upload(localPath, remoteName) {
    const buf = await fsp.readFile(localPath);
    const form = new FormData();
    form.append("image", new Blob([buf]), remoteName || path.basename(localPath));
    form.append("overwrite", "true");
    // big reference clips crawl through the tunnel (≈25 KB/s from 13): allow an hour rather than failing at 10 min
    const res = await this.fetch("/upload/image", { method: "POST", body: form, timeoutMs: 3_600_000 });
    if (!res.ok) throw new Error(`upload ${remoteName} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }

  async submit(workflow) {
    const j = await this.json("/prompt", { method: "POST", body: JSON.stringify({ prompt: workflow, client_id: this.clientId }), headers: { "content-type": "application/json" }, timeoutMs: 60_000 });
    if (j.node_errors && Object.keys(j.node_errors).length) throw new Error("ComfyUI rejected the workflow: " + JSON.stringify(j.node_errors).slice(0, 400));
    return j;
  }

  /**
   * Put the H3 weights in VRAM without making the user wait for a real job. "Loading H3" used to only
   * mean "the ComfyUI process is running" — the 20-odd GB of weights arrived on the first generation,
   * so pressing 加载 looked like it did nothing. This runs the smallest legal graph (256×256, 22 frames,
   * one step, preview instead of a saved file) purely so the loaders run and stay cached.
   */
  async warmup(template, { say = () => {}, timeoutMs = 900_000 } = {}) {
    const wf = JSON.parse(JSON.stringify(template));
    for (const n of Object.values(wf)) {
      if (n.class_type === "MiniMaxH3ImageToVideo") { n.inputs.width = 256; n.inputs.height = 256; n.inputs.length = 22; n.inputs.prompt = "warmup"; }
      if (n.class_type === "BasicScheduler") n.inputs.steps = 1;
      // keep the graph's own output node — ComfyUI refuses a prompt with no outputs — but park the file
      // out of the way; it is a few tens of KB at this size.
      if (n.class_type === "SaveVideo") n.inputs.filename_prefix = "warmup/h3";
    }
    const { prompt_id } = await this.submit(wf);
    say("H3 权重装载中（第一次要从磁盘读约 20 GB，1–3 分钟）…");
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 4000));
      const h = await this.history(prompt_id).catch(() => ({}));
      const e = h?.[prompt_id];
      if (e?.status?.completed) return { ok: true, seconds: Math.round((Date.now() - t0) / 1000) };
      if (e?.status?.status_str === "error") throw new Error("预热失败：" + JSON.stringify(e.status.messages || "").slice(0, 300));
      if ((Date.now() - t0) % 20000 < 4100) say(`H3 权重装载中… ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    throw new Error("预热超时");
  }

  /** Download an output file (as listed in history) to a local path. */
  async download(item, dest) {
    const qs = new URLSearchParams({ filename: item.filename, type: item.type || "output" });
    if (item.subfolder) qs.set("subfolder", item.subfolder);
    const res = await this.fetch(`/view?${qs}`, { timeoutMs: 1_800_000 });
    if (!res.ok) throw new Error(`download ${item.filename}: HTTP ${res.status}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
    return dest;
  }

  // ---- WebSocket progress feed --------------------------------------------------------------
  /** Keep a websocket to ComfyUI while the GPU is up; reconnect quietly when it is not. */
  startWatching() {
    if (this.wsTimer) return;
    const connect = () => {
      if (this.ws) return;
      const url = this.base.replace(/^http/, "ws") + `/ws?clientId=${encodeURIComponent(this.clientId)}`;
      let ws;
      try { ws = new WebSocket(url, { handshakeTimeout: 8000 }); } catch { return; }
      this.ws = ws;
      ws.on("open", () => { this.connected = true; this.events.emitAll("comfy.ws", { connected: true }); });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return; // preview images
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        this.events.emit("comfy.message", msg);
      });
      const drop = () => { if (this.ws === ws) { this.ws = null; if (this.connected) { this.connected = false; this.events.emitAll("comfy.ws", { connected: false }); } } };
      ws.on("close", drop);
      ws.on("error", () => { drop(); try { ws.terminate(); } catch {} });
    };
    connect();
    this.wsTimer = setInterval(connect, 5000);
  }
  stopWatching() { clearInterval(this.wsTimer); this.wsTimer = null; try { this.ws?.terminate(); } catch {} this.ws = null; }
}
