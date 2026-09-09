// Cloned voices are made on the GPU box and, until now, only existed there. That is fine for a box we
// can snapshot; it is data loss for a 24 GB card or a preemptible instance, which vanish without an
// image. So 13 keeps a mirror: pull whatever the box has that we do not, and hand it back on restore.
//
// Direction matters. Box → 13 is the fast way (a few MB/s); 13 → box crawls unless it goes through the
// fleet tunnel. So 13 always *pulls*, over the same ssh tunnel gpuctl uses, and the box pulls its
// missing voices back through the tunnel in restore.sh. Nobody pushes.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const nowS = () => Math.floor(Date.now() / 1000);

export class VoiceMirror {
  constructor(config, { gpuctl, power } = {}) {
    this.config = config; this.gpuctl = gpuctl; this.power = power;
    this.dir = path.join(config.dataDir, "fleet", "voices");
    this.running = false;
    this.last = null;
  }

  ensureDir() { fs.mkdirSync(this.dir, { recursive: true }); }

  /** What the mirror holds: one entry per voice, newest first. */
  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((f) => f.endsWith(".tgz")).map((f) => {
      const id = f.replace(/\.tgz$/, "");
      const st = fs.statSync(path.join(this.dir, f));
      return { id, bytes: st.size, at: Math.floor(st.mtimeMs / 1000) };
    }).sort((a, b) => b.at - a.at);
  }

  /** The bundle for one voice, or null. Served to the box through the fleet tunnel. */
  bundle(id) {
    const f = path.join(this.dir, `${id}.tgz`);
    return fs.existsSync(f) ? f : null;
  }

  /**
   * Pull every voice the box has that the mirror does not. One tar per voice — they are small
   * (a reference clip plus a json), and per-voice bundles mean a half-finished sync still leaves
   * whole voices behind rather than a broken archive.
   */
  async sync({ limit = 50 } = {}) {
    if (this.running) return { skipped: "已经在同步" };
    if (!this.gpuctl?.available) return { available: false, reason: "gpuctl 不可用" };
    if (this.power?.status?.state !== "on") return { available: false, reason: "GPU 未开机" };
    this.running = true;
    this.ensureDir();
    const out = { pulled: [], failed: [], at: nowS() };
    try {
      // 注册表是平铺的：每个音色一份 <id>.json（元数据 + 转写）加一份 <id>.wav（参考声）
      const ls = await this.gpuctl.sh("ls -1 /root/model-cache/voice/voices/*.json 2>/dev/null || true").catch(() => "");
      const onBox = String(ls || "").split("\n").map((x) => path.basename(x.trim(), ".json"))
        .filter((x) => /^[a-z0-9_-]{1,64}$/i.test(x));
      const have = new Set(this.list().map((v) => v.id));
      for (const id of onBox.filter((x) => !have.has(x)).slice(0, limit)) {
        const dest = path.join(this.dir, `${id}.tgz`);
        try {
          await this.gpuctl.fetchTar("/root/model-cache/voice/voices", dest, { files: [`${id}.json`, `${id}.wav`] });
          out.pulled.push({ id, bytes: fs.statSync(dest).size });
        } catch (e) { try { fs.unlinkSync(dest); } catch {} out.failed.push({ id, error: e.message }); }
      }
      if (out.pulled.length) console.log(`[voicemirror] 备份了 ${out.pulled.length} 个音色到 13`);
      this.last = { ...out, onBox: onBox.length, mirrored: this.list().length };
      return this.last;
    } finally { this.running = false; }
  }

  status() { return { mirrored: this.list().length, last: this.last }; }
}
