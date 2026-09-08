// Direct browser ↔ GPU asset transfer.
//
// The 13 → GPU leg is per-flow shaped to ~30-75 KB/s while the browser (same country as the box) gets
// line rate, so uploads go straight from the browser to the asset service on the GPU (gpu/assets/server.py,
// TLS on 8443) and 13 pulls its backup afterwards in the fast direction (GPU → 13, ≈1 MB/s).
//
// Auth: 13 mints short-lived HMAC tokens the GPU verifies on its own — no call back here per request.
// TLS: the box only has a self-signed cert (the IDC blocks ACME on 80/443 for any hostname), so 13 pins
// the fingerprint it reads over the ssh tunnel, and the browser is asked once to trust the same cert.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import https from "node:https";
import httpMod from "node:http";
import { pipeline } from "node:stream/promises";

const b64u = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class Direct {
  constructor(config, { power, gpuctl } = {}) {
    this.config = config; this.power = power; this.gpuctl = gpuctl;
    this.secret = config.assetsSecret || "";
    this.port = config.assetsPort || 8443;
    this.host = config.assetsHost || "";
    this.origin = config.publicOrigin || "";
    this.ipCache = { ip: null, at: 0 };
    this.fp = null;            // sha256 fingerprint of the GPU cert, read over ssh
    this.lastError = null;
  }

  get enabled() { return !!this.secret; }

  /** "<id>.<op>.<exp>.<sig>" — id "*" means any asset; op put | get | admin. */
  token(assetId, op, ttlS = 1800) {
    const exp = Math.floor(Date.now() / 1000) + ttlS;
    const msg = `${assetId}.${op}.${exp}`;
    return `${msg}.${b64u(crypto.createHmac("sha256", this.secret).update(msg).digest())}`;
  }

  async publicIp({ maxAgeMs = 300_000 } = {}) {
    if (this.config.assetsBase) return new URL(this.config.assetsBase).hostname;
    if (this.ipCache.ip && Date.now() - this.ipCache.at < maxAgeMs) return this.ipCache.ip;
    const host = await this.power?.cs?.describe(this.config.compshare.instanceId, { region: this.config.compshare.region }).catch(() => null);
    const ip = (host?.IPSet || []).find((x) => x.Type !== "Private")?.IP || null;
    if (ip) this.ipCache = { ip, at: Date.now() };
    return ip;
  }

  /** SHA-256 fingerprint of the box's TLS cert, fetched through the ssh tunnel (a trusted channel).
   *  Only needed while the box serves a self-signed cert; with a real one the CA chain is the proof. */
  async fingerprint({ force = false } = {}) {
    if (this.config.assetsBase || this.host) return null;
    if (this.fp && !force) return this.fp;
    const r = await this.gpuctl?.run(["cert"]).catch(() => null);
    if (r?.ok && r.fingerprint) this.fp = r.fingerprint.toUpperCase();
    return this.fp;
  }

  async base() {
    if (this.config.assetsBase) return this.config.assetsBase.replace(/\/$/, "");
    if (this.host) return `https://${this.host}:${this.port}`;   // real cert, no browser warning
    const ip = await this.publicIp();
    return ip ? `https://${ip}:${this.port}` : null;             // self-signed fallback
  }

  /** What the browser needs to talk to the box itself. */
  async info() {
    if (!this.enabled) return { available: false, reason: "未配置 ASSETS_SECRET" };
    if (this.power?.status?.state !== "on") return { available: false, reason: "GPU 未开机" };
    const base = await this.base();
    if (!base) return { available: false, reason: "拿不到 GPU 公网地址" };
    // A platform ingress (or a hostname with a real certificate) needs no trust dance: the browser
    // already validates it against a public CA. Only our own self-signed cert on a raw IP does.
    const viaIngress = !!this.config.fleet?.active?.assetsUrl;
    const trusted = viaIngress || !!this.host;
    return { available: true, base, port: this.port, host: this.host || null, trusted, viaIngress,
             fingerprint: trusted ? null : await this.fingerprint().catch(() => null),
             trustUrl: trusted ? null : `${base}/trust` };
  }

  /** Point the hostname at the box's current address. The EIP is a bound resource and has not moved in
   *  weeks, but it is not guaranteed, and a stale A record would send the browser nowhere. */
  async syncDns(ip) {
    const g = this.config.godaddy;
    if (!g?.key || !this.host || !ip) return null;
    const domain = g.domain || this.host.split(".").slice(-2).join(".");
    const name = this.host.slice(0, -(domain.length + 1)) || "@";
    const auth = { authorization: `sso-key ${g.key}:${g.secret}`, "content-type": "application/json" };
    const url = `https://api.godaddy.com/v1/domains/${domain}/records/A/${name}`;
    const cur = await fetch(url, { headers: auth }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (cur?.[0]?.data === ip) return { changed: false, ip };
    const r = await fetch(url, { method: "PUT", headers: auth, body: JSON.stringify([{ data: ip, ttl: 600 }]) });
    if (!r.ok) { this.lastError = `更新 ${this.host} 的 A 记录失败：${r.status}`; return { changed: false, ip, error: r.status }; }
    console.log(`[direct] ${this.host} A → ${ip}`);
    return { changed: true, ip };
  }

  /** Make sure the service on the box is up and knows the current EIP (the cert SAN and CORS depend on it). */
  async ensureService({ timeoutMs = 60_000 } = {}) {
    if (!this.enabled || this.config.assetsBase) return true;
    const ip = await this.publicIp({ maxAgeMs: 60_000 });
    await this.syncDns(ip).catch((e) => console.log("[direct] dns:", e.message));
    try {
      const h = await this.health();
      if (h.ok && (!ip || h.ip === ip)) return true;
    } catch { /* not up yet, or wrong IP */ }
    await this.gpuctl.run(["stop", "assets"]).catch(() => {});
    await this.gpuctl.run(["start", "assets", `SECRET=${this.secret}`, `PORT=${this.port}`, `ALLOW_ORIGIN=${this.origin}`, `PUBLIC_IP=${ip || ""}`]);
    await this.fingerprint({ force: true }).catch(() => null);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { const h = await this.health(); if (h.ok) return true; } catch { /* keep waiting */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("GPU 资产服务没起来");
  }

  // ---- HTTP to the box (self-signed cert, pinned by fingerprint) --------------------------------
  async request(method, path, { token, body = null, file = null, stream = null, headers = {}, timeoutMs = 3_600_000 } = {}) {
    const base = await this.base();
    if (!base) throw new Error("拿不到 GPU 公网地址");
    const fp = await this.fingerprint().catch(() => null);
    const u = new URL(base + path);
    const mod = u.protocol === "http:" ? httpMod : https;
    const opts = {
      method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, timeout: timeoutMs,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      rejectUnauthorized: !!this.host,   // real cert → verify normally; self-signed → the pinned fingerprint below is the gate
      ...(this.host ? {} : { checkServerIdentity: () => undefined }),
    };
    return new Promise((resolve, reject) => {
      const req = mod.request(opts, (res) => {
        const peer = res.socket.getPeerCertificate?.();
        const got = (peer?.fingerprint256 || "").replace(/:/g, "").toUpperCase();
        if (fp && got && got !== fp) { req.destroy(); return reject(new Error("GPU 证书指纹不匹配，拒绝连接")); }
        resolve(res);
      });
      req.on("error", reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error("连接 GPU 超时")));
      req.on("timeout", () => req.destroy(new Error("连接 GPU 超时")));
      if (stream) pipeline(stream, req).catch(reject);
      else if (file) pipeline(fs.createReadStream(file), req).catch(reject);
      else req.end(body);
    });
  }

  async json(method, path, opts = {}) {
    const res = await this.request(method, path, opts);
    const chunks = []; for await (const c of res) chunks.push(c);
    const text = Buffer.concat(chunks).toString();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
    if (res.statusCode >= 300) throw new Error(j.error || `GPU 资产服务 ${res.statusCode}`);
    return j;
  }

  health() { return this.json("GET", "/health", { timeoutMs: 8_000 }); }
  list() { return this.json("GET", "/list", { token: this.token("*", "admin", 300), timeoutMs: 20_000 }); }
  meta(assetId) { return this.json("GET", `/a/${assetId}/meta`, { token: this.token(assetId, "get", 300), timeoutMs: 15_000 }); }
  remove(assetId) { return this.json("DELETE", `/a/${assetId}`, { token: this.token(assetId, "put", 300) }); }

  /** GPU → 13 (the fast direction): stream an asset (or its thumbnail) to a local path. */
  async download(assetId, dest, { thumb = false } = {}) {
    const res = await this.request("GET", `/a/${assetId}${thumb ? "/thumb" : ""}`, { token: this.token(assetId, "get", 3600) });
    if (res.statusCode !== 200) { res.resume(); throw new Error(`下载失败 ${res.statusCode}`); }
    await pipeline(res, fs.createWriteStream(dest + ".part"));
    await fsp.rename(dest + ".part", dest);
    return (await fsp.stat(dest)).size;
  }

  /** 13 → GPU in parallel slices. One TCP flow towards the box is shaped to tens of KB/s; sixteen of them
   *  measured 538 KB/s on the same link, so an asset that only exists here still reaches the box in a
   *  reasonable time when a job needs it. */
  async uploadParallel(file, assetId, name, { streams = 12, minPartMib = 2 } = {}) {
    const size = (await fsp.stat(file)).size;
    const n = Math.max(1, Math.min(streams, Math.ceil(size / (minPartMib * 1048576))));
    if (n === 1) return this.upload(file, assetId, name);
    const part = Math.ceil(size / n);
    const t0 = Date.now();
    const token = this.token(assetId, "put", 7200);
    await Promise.all(Array.from({ length: n }, (_, i) => {
      const start = i * part, end = Math.min(size, start + part) - 1;
      if (start > end) return Promise.resolve();
      return (async () => {
        const res = await this.request("PUT", `/a/${assetId}?part=${i}&of=${n}`, {
          token, headers: { "content-length": String(end - start + 1) },
          stream: fs.createReadStream(file, { start, end }),
        });
        const chunks = []; for await (const c of res) chunks.push(c);
        if (res.statusCode >= 300) throw new Error(`分片 ${i} 失败 ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 160)}`);
      })();
    }));
    const meta = await this.json("POST", `/a/${assetId}/assemble?of=${n}&name=${encodeURIComponent(name)}`, { token });
    const secs = (Date.now() - t0) / 1000;
    console.log(`[direct] ${assetId} ${(size / 1048576).toFixed(1)} MB via ${n} 条并行 ${secs.toFixed(1)}s = ${Math.round(size / secs / 1024)} KB/s`);
    return { ...meta, streams: n, seconds: +secs.toFixed(1) };
  }

  /** 13 → GPU (slow, only for what the browser could not send itself). */
  /**
   * Lend a local file to the fleet tunnel for one pull. The GPU reaches 13 only through the Hysteria2
   * tunnel, whose ACL pins it to 13's own loopback, so the URL we hand out is a loopback URL plus a
   * random one-shot token. Nothing here is reachable from the internet.
   */
  lend(file, name, ttlS = 3600) {
    if (!this._lent) this._lent = new Map();
    const t = b64u(crypto.randomBytes(24));
    this._lent.set(t, { file, name, expires: Date.now() + ttlS * 1000 });
    for (const [k, v] of this._lent) if (v.expires < Date.now()) this._lent.delete(k);
    return t;
  }
  takeLent(token) {
    const v = this._lent?.get(token);
    if (!v || v.expires < Date.now()) return null;
    return v;
  }

  /**
   * Send a file to the box the fast way: 13 → GPU over plain TCP is ~24 KB/s per flow no matter which
   * direction initiates it, but the same path over Hysteria2 (QUIC + a loss-agnostic congestion control)
   * measured 6.0-6.3 MB/s. So we do not push at all — we lend the bytes on 13's loopback and ask the box
   * to pull them through the tunnel.
   */
  async pushViaTunnel(file, assetId, name, { port = null } = {}) {
    const size = (await fsp.stat(file)).size;
    const t = this.lend(file, name);
    const localPort = port || this.config.port || 18790;
    const bp = (this.config.basePath || "").replace(/\/$/, "");
    const url = `http://127.0.0.1:${localPort}${bp}/_fleet/blob/${t}`;
    const t0 = Date.now();
    const res = await this.request("POST", `/a/${assetId}/fetch?name=${encodeURIComponent(name)}&url=${encodeURIComponent(url)}`, {
      token: this.token(assetId, "put", 7200), timeoutMs: 3_600_000,
    });
    const chunks = []; for await (const c of res) chunks.push(c);
    const j = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    this._lent?.delete(t);
    if (res.statusCode >= 300) throw new Error(j.error || `隧道拉取失败 ${res.statusCode}`);
    const secs = Math.max(0.001, (Date.now() - t0) / 1000);
    return { ...j, seconds: Math.round(secs), mbps: +(size / secs / 1048576).toFixed(2) };
  }

  async upload(file, assetId, name) {
    const size = (await fsp.stat(file)).size;
    const res = await this.request("PUT", `/a/${assetId}?name=${encodeURIComponent(name)}`, {
      token: this.token(assetId, "put", 7200), file, headers: { "content-length": String(size) },
    });
    const chunks = []; for await (const c of res) chunks.push(c);
    const j = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (res.statusCode >= 300) throw new Error(j.error || `上传失败 ${res.statusCode}`);
    return j;
  }
}


/** Are 13 and the box holding the same set of assets? With more than one box in the fleet this is the
 *  thing that keeps them interchangeable: whichever machine has capacity today should have the same
 *  material on it. Compares by id and size, and can push what is missing in the background. */
export class AssetSync {
  constructor(projects, direct, events) { this.projects = projects; this.direct = direct; this.events = events; this.running = false; this.last = null; }

  /** What each side has, and what is missing where. Cheap: one listing call plus our own records. */
  async compare() {
    if (!this.direct?.enabled) return { available: false, reason: "未启用直传" };
    if (this.direct.power?.status?.state !== "on") return { available: false, reason: "GPU 未开机，无法比对" };
    const onBox = new Map();
    try { for (const m of (await this.direct.list()).assets || []) onBox.set(m.id, m); }
    catch (e) { return { available: false, reason: "读不到 GPU 上的素材：" + e.message }; }
    const here = [];
    for (const sum of this.projects.list()) {
      const p = this.projects.get(sum.id);
      for (const a of p.assets || []) if (!a.pending) here.push({ projectId: p.id, ...a });
    }
    const missingOnBox = here.filter((a) => a.local && !onBox.has(a.id));
    const missingHere = [...onBox.values()].filter((m) => !here.some((a) => a.id === m.id));
    const sizeMismatch = here.filter((a) => onBox.has(a.id) && a.size && onBox.get(a.id).size && Math.abs(onBox.get(a.id).size - a.size) > 4096)
                             .map((a) => ({ id: a.id, here: a.size, box: onBox.get(a.id).size }));
    const r = { available: true, at: Math.floor(Date.now() / 1000), here: here.length, onBox: onBox.size,
                missingOnBox: missingOnBox.map((a) => ({ id: a.id, projectId: a.projectId, name: a.name, size: a.size })),
                missingHere: missingHere.map((m) => ({ id: m.id, name: m.name, size: m.size })), sizeMismatch };
    this.last = r;
    return r;
  }

  /** Push whatever the box is missing (parallel slices), pull whatever only the box has. */
  async sync({ push = true, pull = true, limit = 20 } = {}) {
    if (this.running) return { skipped: "已经在同步" };
    this.running = true;
    const done = { pushed: [], pulled: [], failed: [] };
    try {
      const cmp = await this.compare();
      if (!cmp.available) return { ...done, ...cmp };
      // 换机器正是要搬素材的时候，用最快的那条：隧道（约 5 MB/s）→ 并行 TCP（250–540 KB/s）。
      // 跟 jobs.js 里那条路径保持一致，别让「同步」比「跑任务」慢一个数量级。
      if (push) for (const a of cmp.missingOnBox.slice(0, limit)) {
        const { file, asset } = this.projects.assetPath(a.projectId, a.id);
        const name = asset.file || asset.name;
        try {
          const r = await this.direct.pushViaTunnel(file, a.id, name);
          done.pushed.push({ id: a.id, seconds: r.seconds, mbps: r.mbps, via: "tunnel" });
        } catch (e1) {
          try {
            const r = await this.direct.uploadParallel(file, a.id, name);
            done.pushed.push({ id: a.id, seconds: r.seconds, streams: r.streams, via: "parallel-tcp" });
          } catch (e2) { done.failed.push({ id: a.id, dir: "push", error: `隧道：${e1.message}；并行：${e2.message}` }); }
        }
      }
      if (pull) for (const m of cmp.missingHere.slice(0, limit)) done.pulled.push({ id: m.id, note: "GPU 上有、13 没有：留着不动（可能属于别的会话）" });
      if (done.pushed.length) {
        const viaT = done.pushed.filter((x) => x.via === "tunnel").length;
        console.log(`[assetsync] 推了 ${done.pushed.length} 个素材到 GPU（隧道 ${viaT}，并行 TCP ${done.pushed.length - viaT}）`);
      }
      return done;
    } finally { this.running = false; }
  }
}

/** Background mirror: every asset the browser put on the GPU gets pulled down to 13 so it survives the
 *  box being off. One at a time (the link is shared with jobs), retried a few times, never fatal. */
export class Backup {
  constructor(projects, direct, events) {
    this.projects = projects; this.direct = direct; this.events = events;
    this.q = []; this.running = false; this.failed = new Map();
  }
  queue(pid, aid) {
    if (!this.direct?.enabled) return;
    if (!this.q.some((x) => x.aid === aid)) this.q.push({ pid, aid, tries: 0 });
    this.pump();
  }
  /** Anything still GPU-only from earlier sessions (called after a restart and whenever the box comes up). */
  sweep() {
    for (const p of this.projects.list?.() || []) {
      const full = this.projects.get(p.id);
      for (const a of full.assets || []) if (a.gpu && !a.local && !a.pending) this.queue(p.id, a.id);
    }
    return this.q.length;
  }
  async pump() {
    if (this.running || !this.q.length) return;
    this.running = true;
    while (this.q.length) {
      const item = this.q.shift();
      try {
        await this.projects.ensureLocal(item.pid, item.aid, this.direct);
        this.events?.emitAll("asset", { projectId: item.pid, assetId: item.aid, local: true });
        this.failed.delete(item.aid);
      } catch (e) {
        item.tries++;
        this.failed.set(item.aid, e.message);
        if (item.tries < 3) { this.q.push(item); await new Promise((r) => setTimeout(r, 5000 * item.tries)); }
        else console.log(`[backup] ${item.aid} 放弃：${e.message}`);
      }
    }
    this.running = false;
  }
  status() { return { pending: this.q.length, running: this.running, failed: [...this.failed.entries()].map(([id, error]) => ({ id, error })) }; }
}
