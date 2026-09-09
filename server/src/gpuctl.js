// Control-plane side of `gpu/gpuctl.sh`: runs it on the GPU box over the reverse ssh tunnel
// (GPU → 13 port 19189 → GPU sshd). Every call is one short ssh session; results are JSON.
// In tests (`GPUCTL_MOCK=1`) a mock implementation is injected instead of ssh.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const nowS = () => Math.floor(Date.now() / 1000);

export class GpuCtl {
  constructor(config, { mock = null } = {}) {
    this.config = config;
    this.mock = mock;
    const g = config.gpuctl || {};
    this.host = g.host || "127.0.0.1";
    this._port = g.port || null;
    this.user = g.user || "root";
    this.key = g.key || path.join(config.dataDir, "gpu_ed25519");
    this.knownHosts = g.knownHosts || path.join(config.dataDir, "gpu_known_hosts");
    this.lastOk = null; this.lastError = null;
  }

  /** GPUCTL_PORT pins it; otherwise it is the active box's tunnel (portBase + 1). */
  get port() { return this._port || this.config.fleet?.active?.sshPort || 19189; }

  get available() { return !!this.mock || fs.existsSync(this.key); }

  /** Run `gpuctl <args…>` on the GPU box; resolves with the parsed JSON (or throws). */
  async run(args, opts = {}) {
    if (this.mock) return this.mock.run(args);
    // the hop is a reverse tunnel + a busy box: one transient ssh hiccup (banner timeout, reset) gets a second try
    try { return await this._run(args, opts); }
    catch (e) { if (/banner exchange|Connection closed|Connection reset|timed out|kex_exchange/i.test(e.message)) { await new Promise((r) => setTimeout(r, 2500)); return this._run(args, opts); } throw e; }
  }
  async _run(args, { timeoutMs = 30_000 } = {}) {
    if (!fs.existsSync(this.key)) throw new Error(`gpuctl key missing: ${this.key}`);
    const sshArgs = ["-p", String(this.port), "-i", this.key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=no",
      "-o", `UserKnownHostsFile=${this.knownHosts}`, "-o", "LogLevel=ERROR", "-o", "ServerAliveInterval=10", `${this.user}@${this.host}`, "gpuctl", ...args.map(shellQuote)];
    const out = await new Promise((resolve, reject) => {
      const child = execFile("ssh", sshArgs, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(`gpuctl ${args[0]}: ${String(stderr || err.message).trim().slice(0, 300)}`));
        resolve(stdout);
      });
      child.on("error", reject);
    });
    const line = out.trim().split("\n").pop() || "";
    let json; try { json = JSON.parse(line); } catch { throw new Error(`gpuctl ${args[0]}: bad output: ${line.slice(0, 200)}`); }
    this.lastOk = nowS(); this.lastError = null;
    return json;
  }

  status(opts) { return this.run(["status"], opts); }
  start(prog, env = {}) { return this.run(["start", prog, ...Object.entries(env).map(([k, v]) => `${k}=${v}`)], { timeoutMs: 40_000 }); }
  stop(prog) { return this.run(["stop", prog], { timeoutMs: 60_000 }); }
  free() { return this.run(["free"], { timeoutMs: 90_000 }); }
  waitPort(port, secs = 120) { return this.run(["wait-port", String(port), String(secs)], { timeoutMs: (secs + 10) * 1000 }); }
  download(url, dest, maxGb = 3) { return this.run(["download", url, dest, String(maxGb)], { timeoutMs: 40_000 }); }
  log(prog, lines = 40) { return this.run(["log", prog, String(lines)]); }

  /** A plain shell command on the box, stdout as a string. The mirrors need `ls` and `tar`, not
   *  gpuctl's JSON verbs; everything policy-shaped still goes through `run()`. */
  async sh(cmd, { timeoutMs = 60_000 } = {}) {
    if (this.mock) return this.mock.sh ? this.mock.sh(cmd) : "";
    if (!fs.existsSync(this.key)) throw new Error(`gpuctl key missing: ${this.key}`);
    return new Promise((resolve, reject) => {
      execFile("ssh", [...this._ssh(), cmd], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => err && !stdout ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve(stdout));
    });
  }

  /** tar a directory on the box straight into a local .tgz. Box → 13 is the fast direction (MB/s),
   *  which is why every mirror pulls instead of pushing. */
  async fetchTar(remoteDir, destFile, { timeoutMs = 600_000, files = null } = {}) {
    if (this.mock) { fs.writeFileSync(destFile, ""); return { bytes: 0 }; }
    if (!fs.existsSync(this.key)) throw new Error(`gpuctl key missing: ${this.key}`);
    const q = shellQuote(remoteDir);
    // `files` tars just those entries inside the directory (the voice registry is flat files, not
    // one directory per voice); without it the whole directory goes.
    const what = files?.length ? files.map(shellQuote).join(" ") : ".";
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(destFile);
      const child = spawn("ssh", [...this._ssh(), `test -d ${q} && tar -C ${q} -czf - ${what} || exit 3`], { stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("fetchTar 超时")); }, timeoutMs);
      child.stderr.on("data", (d) => { err += d; });
      child.stdout.pipe(out);
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer); out.end();
        if (code !== 0) return reject(new Error(`tar ${remoteDir}: ${(err || "exit " + code).trim().slice(0, 200)}`));
        resolve({ bytes: fs.statSync(destFile).size });
      });
    });
  }

  _ssh() {
    return ["-p", String(this.port), "-i", this.key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
      "-o", "StrictHostKeyChecking=no", "-o", `UserKnownHostsFile=${this.knownHosts}`, "-o", "LogLevel=ERROR",
      "-o", "ServerAliveInterval=10", `${this.user}@${this.host}`];
  }
}

function shellQuote(s) { s = String(s); return /^[A-Za-z0-9_./:=@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`; }

/** In-memory stand-in for tests: emulates supervisor programs, VRAM and ports. */
export class MockGpuCtl {
  constructor() {
    this.programs = { comfyui: "RUNNING", gputunnel: "RUNNING", llm: "STOPPED", voice: "STOPPED" };
    this.voices = [];        // ids the fake box "has"; the voice mirror lists them with `ls`
    this.vram = { comfyui: 500, llm: 0, voice: 0 }; this.calls = []; this.reachable = true; this.runners = {}; this.util = 0; this.procs = []; this.net = { rx: 0, tx: 0 };
  }
  /** Only the shapes the mirrors ask for; anything else is empty, like a box with nothing there. */
  async sh(cmd) {
    this.calls.push(["sh", cmd]);
    if (/voice\/voices/.test(cmd)) return this.voices.join("\n") + (this.voices.length ? "\n" : "");
    return "";
  }
  async run(args) {
    this.calls.push(args);
    if (!this.reachable) throw new Error("gpuctl status: ssh: connect to host 127.0.0.1 port 19189: Connection refused");
    const [cmd, a, ...rest] = args;
    const used = () => 200 + Object.values(this.vram).reduce((s, v) => s + v, 0);
    switch (cmd) {
      case "status": return { ok: true, vram: { used: used(), total: 32607, util: this.util, temp: 30, memUtil: 0, powerW: this.util ? 300 : 15, powerLimitW: 575, clockMhz: 180 }, procs: [...this.procs], programs: { ...this.programs }, net: { ...this.net }, ports: [23, ...(this.programs.comfyui === "RUNNING" ? [8188] : []), ...(this.programs.llm === "RUNNING" ? [8080] : []), ...(this.programs.voice === "RUNNING" ? [8600] : [])], disk_free_gb: 60, uptime_s: 1000, cache: [], runners: { ...this.runners } };
      case "start": this.programs[a] = "RUNNING"; this.vram[a] = a === "llm" ? 18500 : a === "voice" ? 5000 : 500; if (rest.length) this.runners[a] = Object.fromEntries(rest.map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; })); return { ok: true, prog: a, out: `${a}: started` };
      case "stop": this.programs[a] = "STOPPED"; this.vram[a] = 0; return { ok: true, prog: a, out: `${a}: stopped` };
      case "free": this.vram.comfyui = 500; return { ok: true, http: "200", vram: { used: used(), total: 32607 } };
      case "wait-port": { const p = Number(a); const open = (p === 8188 && this.programs.comfyui === "RUNNING") || (p === 8080 && this.programs.llm === "RUNNING") || (p === 8600 && this.programs.voice === "RUNNING"); return { ok: open, port: p, waited: 1 }; }
      case "download": return { ok: true, dest: rest[0], bytes: 1000, log: "/root/model-cache/x.log" };
      case "log": return { ok: true, log: "mock log" };
      case "restore": return { ok: true, applied: 0, skipped: 0, failed: 0, image: "mock", layers: 0 };
      default: return { ok: false, error: "unknown" };
    }
  }
}
