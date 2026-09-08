// Does the video model actually work, and does it keep the reference person?
//
//   node test/h3-check.mjs                    one reference-image run against production
//   node test/h3-check.mjs --n 2 --mode t2v   plain text-to-video runs instead
//   node test/h3-check.mjs --ref a_5a6df139e2 --keep
//
// This is the check the workbench cannot do for itself: it submits a real job, waits for the file, and
// then asks three questions that map onto the ways H3 fails quietly.
//   1. did ComfyUI actually receive the reference keys?   (the silent failure: refs listed but ignored)
//   2. is there a real moving picture?                     (frames, duration, non-black, some motion)
//   3. does the output still look like the reference?      (SSIM of the reference against sampled frames)
// SSIM is crude for faces, but a run that ignored the reference scores far below one that used it, and
// the numbers are comparable across runs, which is what makes a regression visible.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.length ? v.join("=") : true]; }));
const cfg = JSON.parse(fsSync.readFileSync(path.join(os.homedir(), ".config/atelier/config.json"), "utf8"));
const BASE = (args.base || cfg.base).replace(/\/$/, "");
const KEY = args.key || cfg.key;
const OUT = args.out || path.join(os.homedir(), "cc/atelier/data-dev/h3-check");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (bin, a) => new Promise((res, rej) => execFile(bin, a, { maxBuffer: 32 << 20 }, (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so))));
// ffmpeg reports filter results (ssim) on stderr even when it succeeds
const runErr = (bin, a) => new Promise((res) => execFile(bin, a, { maxBuffer: 32 << 20 }, (e, so, se) => res(se || so || String(e && e.message))));
const api = async (p, opts = {}) => {
  const r = await fetch(BASE + p, { ...opts, headers: { authorization: `Bearer ${KEY}`, ...(opts.body ? { "content-type": "application/json" } : {}), ...opts.headers } });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 300) }; }
  if (!r.ok) throw new Error(`${opts.method || "GET"} ${p} → ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
};

// Six-part H3 prompt (the format the minimax-h3 skill settled on). Kept short on purpose: these are checks,
// not art, and every extra second of video is money.
const SHOTS = [
  { title: "室内对镜头说话", body: "integrated_multimodal_description: [Shot 1] Live-action, a static medium close-up of <Picture 1> sitting by a window in soft daylight, looking at the camera and speaking a few words, slight natural head movement. The camera holds still.\n\noverall_soundscape: Quiet room tone.\n\nnon_diegetic_music: N/A" },
  { title: "转头看向窗外", body: "integrated_multimodal_description: [Shot 1] Live-action, a static medium shot of <Picture 1> turning their head slowly from the camera towards a bright window, warm afternoon light on the face. The camera holds still.\n\noverall_soundscape: Faint street noise.\n\nnon_diegetic_music: N/A" },
  { title: "站起走两步", body: "integrated_multimodal_description: [Shot 1] Live-action, a static wide shot of <Picture 1> standing up from a chair and taking two steps towards the camera in an ordinary room, even indoor light. The camera holds still.\n\noverall_soundscape: Footsteps on a wooden floor.\n\nnon_diegetic_music: N/A" },
];

const results = [];
const say = (...a) => console.log(...a);

async function pickReference() {
  if (args.ref) return args.ref;
  const p = await api("/api/projects/default");
  const imgs = (p.assets || []).filter((a) => a.kind === "image" && !a.pending && (a.width || 0) >= 512);
  if (!imgs.length) throw new Error("项目里没有可用的人像素材");
  return imgs[Math.floor(Math.random() * imgs.length)].id;
}

async function waitJob(id, maxMs = 20 * 60_000) {
  const t0 = Date.now(); let last = "";
  while (Date.now() - t0 < maxMs) {
    const j = await api(`/api/jobs/${id}`);
    const line = j.log?.at(-1)?.text || j.status;
    if (line !== last) { last = line; say(`   · ${j.status} — ${line}`); }
    if (["done", "error", "cancelled"].includes(j.status)) return j;
    await sleep(5000);
  }
  return { ...(await api(`/api/jobs/${id}`)), status: "timeout" };
}

/** SSIM of the reference against three sampled frames, plus a motion figure between first and last. */
async function inspect(video, refImage) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "h3-"));
  const probe = JSON.parse(await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", video]));
  const v = probe.streams.find((s) => s.codec_type === "video");
  const dur = Number(probe.format.duration || 0);
  const frames = [];
  for (const at of [0.1, dur / 2, Math.max(0.1, dur - 0.2)]) {
    const f = path.join(tmp, `f${frames.length}.png`);
    await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", at.toFixed(2), "-i", video, "-frames:v", "1", f]);
    frames.push(f);
  }
  // brightness: a black or frozen output is the other silent failure
  const stats = await Promise.all(frames.map(async (f) => {
    const out = await run("ffmpeg", ["-y", "-loglevel", "error", "-i", f, "-vf", "scale=64:64,format=gray", "-f", "rawvideo", "-"]).catch(() => "");
    return out ? [...Buffer.from(out, "binary")].reduce((s, b) => s + b, 0) / (64 * 64) : 0;
  }));
  let ssim = null;
  if (refImage) {
    const scores = [];
    for (const f of frames) {
      const line = await runErr("ffmpeg", ["-y", "-loglevel", "info", "-i", f, "-i", refImage,
        "-lavfi", "[0:v]scale=256:256,format=gray,eq=contrast=1[a];[1:v]scale=256:256,format=gray,eq=contrast=1[b];[a][b]ssim", "-f", "null", "-"]);
      const m = /All:([0-9.]+)/.exec(line); if (m) scores.push(Number(m[1]));
    }
    if (scores.length) ssim = { max: Math.max(...scores), avg: +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4) };
  }
  const motion = await runErr("ffmpeg", ["-y", "-loglevel", "info", "-i", frames[0], "-i", frames.at(-1),
    "-lavfi", "[0:v]scale=256:256,format=gray[a];[1:v]scale=256:256,format=gray[b];[a][b]ssim", "-f", "null", "-"]);
  const mm = /All:([0-9.]+)/.exec(motion);
  await fs.rm(tmp, { recursive: true, force: true });
  return { width: v?.width, height: v?.height, seconds: +dur.toFixed(2), frames: v?.nb_frames ? Number(v.nb_frames) : null,
           brightness: stats.map((s) => Math.round(s)), ssimToRef: ssim, firstLastSsim: mm ? Number(mm[1]) : null };
}

(async () => {
  await fs.mkdir(OUT, { recursive: true });
  const n = Number(args.n || 1);
  const mode = args.mode || "ref";
  const gpu = await api("/api/gpu");
  say(`GPU ${gpu.state}${gpu.state === "on" ? `（本次开机 ${Math.round((gpu.cost?.currentSeconds || 0) / 60)} 分钟）` : ""}`);

  for (let i = 0; i < n; i++) {
    const shot = SHOTS[Math.floor(Math.random() * SHOTS.length)];
    const refId = mode === "ref" ? await pickReference() : null;
    say(`\n▶ ${i + 1}/${n} ${shot.title}${refId ? `　参考图 ${refId}` : "　（纯文生）"}`);
    const spec = { projectId: "default", title: `自检 · ${shot.title} ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
                   workflow: refId ? "native_ref2va" : "native_t2v", prompt: shot.body.replace("<Picture 1>", refId ? "<Picture 1>" : "a woman in her thirties"),
                   images: refId ? [refId] : [], width: 832, height: 448, seconds: Number(args.seconds || 3), tags: ["h3-check"] };
    const t0 = Date.now();
    const job = await api("/api/jobs", { method: "POST", body: JSON.stringify(spec) });
    const done = await waitJob(job.id);
    const took = Math.round((Date.now() - t0) / 1000);
    if (done.status !== "done") { results.push({ shot: shot.title, refId, jobId: job.id, ok: false, why: done.error || done.status, took }); say(`   ✗ ${done.status}: ${done.error || ""}`); continue; }

    const vid = path.join(OUT, `${job.id}.mp4`);
    const r = await fetch(`${BASE}/api/jobs/${job.id}/file`, { headers: { authorization: `Bearer ${KEY}` } });
    await fs.writeFile(vid, Buffer.from(await r.arrayBuffer()));
    let refFile = null;
    if (refId) {
      refFile = path.join(OUT, `${refId}.jpg`);
      if (!fsSync.existsSync(refFile)) {
        const rr = await fetch(`${BASE}/api/projects/default/assets/${refId}/file`, { headers: { authorization: `Bearer ${KEY}` } });
        await fs.writeFile(refFile, Buffer.from(await rr.arrayBuffer()));
      }
    }
    const info = await inspect(vid, refFile);
    const sheet = path.join(OUT, `${job.id}_sheet.jpg`);
    await run("ffmpeg", ["-y", "-loglevel", "error", ...(refFile ? ["-i", refFile] : []), "-i", vid,
      "-filter_complex", refFile
        ? "[0:v]scale=-2:270,pad=iw+8:ih:0:0:black[r];[1:v]fps=1/1,scale=-2:270,tile=3x1[t];[r][t]hstack"
        : "[0:v]fps=1/1,scale=-2:270,tile=3x1",
      "-frames:v", "1", sheet]).catch(() => null);
    info.sheet = fsSync.existsSync(sheet) ? sheet : null;
    const refOk = !refId || done.refCheck?.ok !== false;
    const moving = info.firstLastSsim == null || info.firstLastSsim < 0.985;      // identical first/last = frozen
    const lit = info.brightness.every((b) => b > 12);
    const ok = refOk && moving && lit && info.seconds > 1;
    results.push({ shot: shot.title, refId, jobId: job.id, ok, took, refCheck: done.refCheck, ...info, file: vid, warning: done.warning || null });
    say(`   ${ok ? "✓" : "✗"} ${took}s  ${info.width}×${info.height} ${info.seconds}s  参考键${refOk ? "已收到" : "没收到"}  画面${lit ? "正常" : "过暗"}  ${moving ? "有运动" : "疑似静帧"}` +
        (info.ssimToRef ? `  与参考图 SSIM 峰值 ${info.ssimToRef.max}` : ""));
  }

  const okN = results.filter((r) => r.ok).length;
  say(`\n${okN === results.length ? "✅" : "❌"} H3 自检：${okN}/${results.length} 通过　产物在 ${OUT}`);
  await fs.writeFile(path.join(OUT, "report.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  process.exitCode = okN === results.length ? 0 : 1;
})().catch((e) => { console.error("✗ " + e.message); process.exitCode = 1; });
