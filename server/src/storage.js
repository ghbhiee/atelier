// Storage accounting and cleanup. Everything is a dry-run "plan" first; `clean` only deletes what the
// plan listed. A job output is "referenced" when any clip take/pick, edit shot, avatar segment, master
// step or render points at it; an asset is referenced by project refs, clips, edits, avatars, masters.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const nowS = () => Math.floor(Date.now() / 1000);
const DERIVED = new Set(["frame", "crop", "prep", "output", "master", "avatar-seg", "avatar-anchor", "import"]);

async function dirSize(dir) {
  let total = 0;
  try { for (const e of await fsp.readdir(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) total += await dirSize(f); else if (e.isFile()) total += (await fsp.stat(f)).size; } } catch {}
  return total;
}

export class Storage {
  constructor(config, projects, jobs) { this.config = config; this.projects = projects; this.jobs = jobs; }

  referencedJobs() {
    const ids = new Set();
    for (const p of this.projects.cache.values()) {
      for (const c of p.clips || []) { for (const t of c.takes || []) ids.add(t); if (c.pick) ids.add(c.pick); }
      for (const e of p.edits || []) for (const s of e.shots || []) { for (const t of s.jobs || []) ids.add(t); if (s.pick) ids.add(s.pick); }
      for (const a of p.avatars || []) for (const s of a.segments || []) { for (const t of s.jobs || []) ids.add(t); if (s.pick) ids.add(s.pick); }
      for (const m of p.masters || []) for (const st of Object.values(m.steps || {})) if (st.jobId) ids.add(st.jobId);
      for (const r of p.renders || []) for (const c of r.clips || []) if (c.jobId) ids.add(c.jobId);
    }
    return ids;
  }
  referencedAssets(p) {
    const ids = new Set(p.refs || []);
    for (const c of p.clips || []) { for (const a of c.refs || []) ids.add(a); for (const a of c.videos || []) ids.add(a); if (c.lastFrame) ids.add(c.lastFrame); }
    for (const e of p.edits || []) { ids.add(e.sourceAssetId); for (const a of e.refs || []) ids.add(a); for (const s of e.shots || []) { if (s.seg) ids.add(s.seg); for (const a of s.refs || []) ids.add(a); } }
    for (const a of p.avatars || []) { ids.add(a.face); ids.add(a.audio); for (const s of a.segments || []) { if (s.audioAsset) ids.add(s.audioAsset); if (s.anchor) ids.add(s.anchor); } }
    for (const m of p.masters || []) { for (const a of m.faces || []) ids.add(a); for (const st of Object.values(m.steps || {})) { if (st.assetId) ids.add(st.assetId); for (const a of Object.values(st.assets || {})) ids.add(a); if (st.from) ids.add(st.from); } }
    for (const j of this.jobs.jobs.values()) if (j.projectId === p.id) { for (const a of [...(j.images || []), ...(j.videos || []), ...(j.audios || []), j.lastFrame].filter(Boolean)) ids.add(a); }
    return ids;
  }

  async overview() {
    let jobsBytes = 0, jobsCount = 0;
    for (const j of this.jobs.jobs.values()) { jobsCount++; jobsBytes += await dirSize(this.jobs.dir(j.id)); }
    let assetsBytes = 0, assetsCount = 0, rendersBytes = 0, rendersCount = 0;
    for (const p of this.projects.cache.values()) { for (const a of p.assets || []) { assetsCount++; assetsBytes += a.size || 0; } rendersCount += (p.renders || []).length; rendersBytes += await dirSize(this.projects.rendersDir(p.id)); }
    const promptsBytes = await dirSize(path.join(this.config.dataDir, "prompts"));
    let disk = null; try { const st = await fsp.statfs(this.config.dataDir); disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize }; } catch {}
    const plan = await this.plan({ oldJobsDays: 7, failedJobs: true, orphanAssets: true });
    return { dataDir: this.config.dataDir, jobs: { count: jobsCount, bytes: jobsBytes }, assets: { count: assetsCount, bytes: assetsBytes }, renders: { count: rendersCount, bytes: rendersBytes }, prompts: { bytes: promptsBytes }, disk, suggested: { jobs: plan.jobs.length, assets: plan.assets.length, bytes: plan.totalBytes } };
  }

  /** Dry run. rules: { oldJobsDays (null = skip), failedJobs, orphanAssets, uploadDays (unreferenced uploads older than N days; default 30) } */
  async plan({ oldJobsDays = null, failedJobs = false, orphanAssets = false, uploadDays = 30 } = {}) {
    const refJobs = this.referencedJobs(); const t = nowS();
    const jobs = [];
    for (const j of this.jobs.jobs.values()) {
      const active = ["queued", "starting", "uploading", "submitted", "running", "downloading"].includes(j.status);
      if (active) continue;
      const old = oldJobsDays != null && (t - j.createdAt) >= oldJobsDays * 86400 && !refJobs.has(j.id) && j.status === "done";
      const failed = failedJobs && (j.status === "error" || j.status === "cancelled");
      if (old || failed) jobs.push({ id: j.id, title: j.title, status: j.status, createdAt: j.createdAt, bytes: await dirSize(this.jobs.dir(j.id)), reason: failed ? "failed" : "old" });
    }
    const assets = [];
    if (orphanAssets) for (const p of this.projects.cache.values()) {
      const used = this.referencedAssets(p);
      for (const a of p.assets || []) {
        if (used.has(a.id)) continue;
        const derived = DERIVED.has(a.source?.type);
        if (derived || (t - a.createdAt) >= uploadDays * 86400) assets.push({ projectId: p.id, project: p.name, id: a.id, name: a.name, kind: a.kind, bytes: a.size || 0, createdAt: a.createdAt, reason: derived ? "derived" : "stale-upload" });
      }
    }
    const totalBytes = jobs.reduce((s, j) => s + j.bytes, 0) + assets.reduce((s, a) => s + a.bytes, 0);
    return { jobs, assets, totalBytes };
  }
  async clean(rules) {
    const plan = await this.plan(rules);
    let freed = 0, removedJobs = 0, removedAssets = 0;
    for (const j of plan.jobs) { try { await this.jobs.remove(j.id); freed += j.bytes; removedJobs++; } catch {} }
    for (const a of plan.assets) { try { await this.projects.removeAsset(a.projectId, a.id); freed += a.bytes; removedAssets++; } catch {} }
    // stale contact sheets
    try { for (const f of await fsp.readdir(this.jobs.root)) if (f.startsWith("_sheet_")) { const p = path.join(this.jobs.root, f); const st = await fsp.stat(p); if (nowS() - st.mtimeMs / 1000 > 86400) { freed += st.size; await fsp.rm(p, { force: true }); } } } catch {}
    return { removedJobs, removedAssets, freed };
  }
}
