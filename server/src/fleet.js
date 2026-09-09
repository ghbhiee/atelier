// The fleet's incremental layers, seen from 13.
//
// A box we can snapshot keeps everything we installed. A 24 GB card or a preemptible instance does
// not: it goes away, and the next one starts from whatever base image we last baked. So 13 holds an
// ordered list of *layers* — idempotent scripts, optionally with a payload — that carry a box from
// the base image to what the fleet currently expects. Nothing may be changed on a box by hand; if it
// is not a layer, it does not survive the box.
//
// Boxes track what they have applied in /root/.atelier/applied.json. Baking an image writes the whole
// current set into that file just before the snapshot, so machines from that image start "already
// applied" and only pick up what came later. That is the whole version scheme: an ordered list plus a
// high-water mark per box.
import fs from "node:fs";
import path from "node:path";

const nowS = () => Math.floor(Date.now() / 1000);

export class Fleet {
  constructor(config, { gpuctl, power, voiceMirror, assetSync, events } = {}) {
    this.config = config; this.gpuctl = gpuctl; this.power = power;
    this.voiceMirror = voiceMirror; this.assetSync = assetSync; this.events = events;
    this.running = false; this.last = null;
  }

  get dir() { return path.join(this.config.dataDir, "fleet"); }
  get manifestFile() { return path.join(this.dir, "layers.json"); }

  manifest() {
    try { return JSON.parse(fs.readFileSync(this.manifestFile, "utf8")); }
    catch { return { version: 1, layers: [] }; }
  }

  /** What the active box says it has applied. Missing file = a box that has never been restored. */
  async applied() {
    const out = await this.gpuctl.sh("cat /root/.atelier/applied.json 2>/dev/null || true").catch(() => "");
    try { return JSON.parse(out); } catch { return { image: null, layers: [], data: {} }; }
  }

  /** Which layers this box is short of, without changing anything. */
  async plan() {
    if (!this.gpuctl?.available) return { available: false, reason: "gpuctl 不可用" };
    if (this.power?.status?.state !== "on") return { available: false, reason: "GPU 未开机" };
    const want = this.manifest().layers || [];
    const have = new Map(((await this.applied()).layers || []).map((l) => [l.id, l.sha]));
    const missing = want.filter((l) => have.get(l.id) !== l.sha);
    return { available: true, total: want.length, missing: missing.map((l) => ({ id: l.id, note: l.note, bytes: l.bytes })) };
  }

  /**
   * Bring the box up to date. The box does the work (it pulls the layers through the fleet tunnel,
   * which is the fast direction); 13 only kicks it off and reads back the summary.
   */
  async restore({ dryRun = false } = {}) {
    if (this.running) return { skipped: "已经在恢复" };
    if (!this.gpuctl?.available) return { available: false, reason: "gpuctl 不可用" };
    this.running = true;
    try {
      const r = await this.gpuctl.run(["restore", ...(dryRun ? ["--dry-run"] : [])], { timeoutMs: 30 * 60_000 });
      this.last = { ...r, at: nowS() };
      if (r?.applied) console.log(`[fleet] 补了 ${r.applied} 层（跳过 ${r.skipped}，失败 ${r.failed}）`);
      this.events?.emitAll?.("fleet", this.status());
      return r;
    } finally { this.running = false; }
  }

  /**
   * On power-on: restore first, then mirror back whatever the box made while we were away.
   * Never throws into the caller's boot path — a box that cannot be restored should still come up.
   */
  async restoreOnBoot() {
    const p = await this.plan().catch(() => null);
    if (!p?.available) return null;
    if (p.missing.length) {
      console.log(`[fleet] 这台缺 ${p.missing.length}/${p.total} 层：${p.missing.map((l) => l.id).join(", ")}`);
      await this.restore().catch((e) => console.log("[fleet] 恢复失败：" + e.message));
    }
    // 数据的两条路：音色是盒子造出来的，拉回 13；素材是 13 有全份，缺什么补给盒子。
    // 两边都只补差额，机器换了也不用从头搬。
    await this.voiceMirror?.sync().catch(() => {});
    const cmp = await this.assetSync?.compare().catch(() => null);
    if (cmp?.available && cmp.missingOnBox.length) {
      console.log(`[fleet] 这台缺 ${cmp.missingOnBox.length} 个素材，后台补齐`);
      this.assetSync.sync({ pull: false, limit: 20 }).catch(() => {});
    }
    return this.last;
  }

  status() {
    const m = this.manifest();
    return { layers: (m.layers || []).length, last: this.last, running: this.running,
             voices: this.voiceMirror?.status?.() || null };
  }
}
