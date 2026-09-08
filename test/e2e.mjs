// End-to-end without a GPU: mock ComfyUI + real server + software passkey.
//   node test/e2e.mjs                       local (temp data dir, mock comfy)
//   node test/e2e.mjs --base https://atelier.example.com:8444 --approve-cmd 'ssh 13 "atelier auth approve {code}"' --no-jobs
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SoftAuthenticator } from "./softauth.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]] : []).filter(Boolean));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); };
const step = (m) => console.log(`\n▶ ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let base = args.base ? args.base + (args.path || "") : args.base, origin = args.origin || args.base, server = null, mock = null, dataDir = null, approveCmd = args["approve-cmd"];
let assetsSrv = null, assetsPort = 0, assetsDir = null;
const label = `e2e-${crypto.randomBytes(3).toString("hex")}`;

if (!base) {
  const { startMockComfy } = await import("./mock-comfy.mjs");
  const { startMockOpenPrompt, startMockAI } = await import("./mock-ai.mjs");
  var mockOP = await startMockOpenPrompt({}); var mockAI = await startMockAI({});
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "h3s-e2e-"));
  mock = await startMockComfy({ port: 0, delayMs: 400, outDir: path.join(dataDir, "mock") });
  // the real GPU asset service, in the clear on localhost — the direct-upload path is worth testing for real
  assetsPort = 18100 + Math.floor(Math.random() * 800);
  assetsDir = path.join(dataDir, "gpu-assets");
  await fs.mkdir(path.join(assetsDir, "comfy_in"), { recursive: true });
  assetsSrv = spawn("python3", [path.join(root, "gpu/assets/server.py")], {
    env: { ...process.env, ASSETS_TLS: "0", ASSETS_PORT: String(assetsPort), ASSETS_SECRET: "e2e-assets-secret", ASSETS_DIR: assetsDir,
           COMFY_INPUT: path.join(assetsDir, "comfy_in"), COMFY_OUTPUT: path.join(assetsDir, "comfy_in") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assetsSrv.stdout.on("data", (d) => process.stdout.write(`  [assets] ${d}`));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${assetsPort}/health`)).ok) break; } catch {} await sleep(100); }
  const port = 19000 + Math.floor(Math.random() * 1000);
  origin = `http://localhost:${port}`; base = origin;
  const env = { ...process.env, PUBLIC_ORIGIN: origin, TOKEN_PEPPER: "e2e-pepper-0123456789", DATA_DIR: dataDir, PORT: String(port), COMFY_URL: mock.url, GPU_IDLE_MINUTES: "1", OPENPROMPT_URL: mockOP.url, LLM_API_KEY: "test", LLM_BASE_URL: mockAI.url, LLM_MODEL: "mock-pro", LLM_FAST_MODEL: "mock-flash", EMBED_API_KEY: "test", EMBED_BASE_URL: mockAI.url, EMBED_MODEL: "mock-embed", PROMPTS_AUTOSYNC: "0", MEDIA_ALLOW_HTTP: "1", GPUCTL_MOCK: "1", LLM_UPSTREAM: mockAI.url, VOICE_UPSTREAM: mockAI.url, ASSETS_SECRET: "e2e-assets-secret", ASSETS_BASE: `http://127.0.0.1:${assetsPort}` };
  server = spawn(process.execPath, [path.join(root, "server/src/index.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => process.stdout.write(`  [server] ${d}`)); server.stderr.on("data", (d) => process.stdout.write(`  [server] ${d}`));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {} await sleep(100); }
  process.env.BASE_PATH = "";
  approveCmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "server/src/cli.js"))} auth approve {code}`;
  process.env.PUBLIC_ORIGIN = origin; process.env.TOKEN_PEPPER = env.TOKEN_PEPPER; process.env.DATA_DIR = dataDir;
}
const auth = new SoftAuthenticator(origin);
let cookie = "";
const call = async (p, { method = "GET", body, raw, headers = {} } = {}) => {
  const opts = { method, headers: { cookie, ...headers } };
  if (body !== undefined && !raw) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); } else if (body !== undefined) opts.body = body;
  const r = await fetch(base + p, opts);
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  return { status: r.status, body: j, headers: r.headers };
};
const ok = async (p, o) => { const r = await call(p, o); if (r.status >= 300) throw new Error(`${o?.method || "GET"} ${p} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };

try {
  step("unauthenticated access is refused");
  assert((await call("/api/gpu")).status === 401, "api needs session");
  const home = await fetch(`${base}/`, { redirect: "manual" }); assert(home.status === 302 && /\/login$/.test(home.headers.get("location")), "SPA redirects to /login (" + home.headers.get("location") + ")");
  const st = await ok("/auth/state"); console.log("  registered passkeys:", st.registered);

  step("passkey enrollment → pending code");
  const ro = await ok("/auth/register/options", { method: "POST", body: { label } });
  assert(ro.options.rp.id === new URL(origin).hostname, "rp id");
  const cred = auth.create(ro.options);
  const rv = await ok("/auth/register/verify", { method: "POST", body: { enrollmentId: ro.enrollmentId, response: cred } });
  assert(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(rv.code), "approval code " + rv.code);
  console.log("  code", rv.code, "→", rv.approvalCommand);
  const before = await ok("/auth/options", { method: "POST" });
  const denied = await call("/auth/verify", { method: "POST", body: { challengeId: before.challengeId, response: auth.get(before.options, cred.id, { ignoreAllowList: true }) } });
  assert(denied.status === 401 || denied.status === 400, "unapproved passkey cannot sign in: " + denied.status);

  step("operator approves via CLI");
  console.log("  " + execSync(approveCmd.replace("{code}", rv.code), { encoding: "utf8", env: process.env }).trim());
  for (let i = 0; i < 20; i++) { const s = await ok(`/auth/register/${ro.enrollmentId}`); if (s.status === "approved") break; await sleep(200); }
  assert((await ok(`/auth/register/${ro.enrollmentId}`)).status === "approved", "enrollment approved");

  step("passkey sign-in → session cookie");
  const ao = await ok("/auth/options", { method: "POST" });
  const av = await call("/auth/verify", { method: "POST", body: { challengeId: ao.challengeId, response: auth.get(ao.options, cred.id) } });
  assert(av.status === 200 && av.body.passkey === label, "signed in");
  cookie = av.headers.get("set-cookie").split(";")[0];
  const me = await ok("/api/me"); assert(me.label === label, "me");
  const meta = await ok("/api/meta"); assert(meta.workflows.native_ref2va && meta.ffmpeg.ok, "meta + ffmpeg");
  const gpu = await ok("/api/gpu"); console.log("  gpu state:", gpu.state, "canControl:", gpu.canControl);

  if (args["no-jobs"]) { console.log("\n--no-jobs: skipping generation flow"); }
  else {
    step("project + assets");
    const p = await ok("/api/projects", { method: "POST", body: { name: "E2E 场景", settings: { workflow: "native_ref2va", width: 640, height: 384, seconds: 2, steps: 8 } } });
    const img = path.join(os.tmpdir(), `h3s-e2e-${crypto.randomBytes(2).toString("hex")}.png`);
    execSync(`ffmpeg -y -loglevel error -f lavfi -i color=c=orange:s=300x400 -frames:v 1 ${img}`);
    const a1 = await ok(`/api/projects/${p.id}/assets?name=face.png`, { method: "PUT", body: await fs.readFile(img), raw: true, headers: { "content-type": "application/octet-stream" } });
    assert(a1.kind === "image" && a1.width === 300 && a1.file.endsWith(".jpg"), "image asset normalised to jpg: " + JSON.stringify(a1));
    const crop = await ok(`/api/projects/${p.id}/assets/${a1.id}/crop`, { method: "POST", body: { crop: { x: 50, y: 50, w: 200, h: 200 }, shortSide: 128 } });
    assert(crop.width === 128 && crop.height === 128, "crop → 128×128: " + crop.width + "x" + crop.height);
    const vid = path.join(os.tmpdir(), `h3s-e2e-${crypto.randomBytes(2).toString("hex")}.mp4`);
    execSync(`ffmpeg -y -loglevel error -f lavfi -i testsrc=s=320x240:r=30 -f lavfi -i sine=frequency=300 -t 4 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest ${vid}`);
    const v1 = await ok(`/api/projects/${p.id}/assets?name=src.mp4`, { method: "PUT", body: await fs.readFile(vid), raw: true, headers: { "content-type": "application/octet-stream" } });
    assert(v1.kind === "video" && v1.hasAudio && Math.round(v1.duration) === 4, "video asset: " + JSON.stringify(v1));
    const prep = await ok(`/api/projects/${p.id}/assets/${v1.id}/prep`, { method: "POST", body: { start: 0.5, end: 2.5, size: { w: 320, h: 256 }, headHold: 12 } });
    assert((prep.frames - 5) % 17 === 0 && prep.width === 320 && prep.height === 256, "prep aligned: " + JSON.stringify({ frames: prep.frames, w: prep.width, h: prep.height }));
    const fr = await ok(`/api/projects/${p.id}/assets/${v1.id}/frame`, { method: "POST", body: { last: true } });
    assert(fr.kind === "image", "frame asset");
    await ok(`/api/projects/${p.id}`, { method: "PATCH", body: { refs: [crop.id, a1.id], shared: { subjects: "<Subject 1> is a person from <Picture 1>.", retention: "<Subject 1>: fully_preserved", style: "Live-action test.", soundscape: "Quiet.", music: "N/A" } } });

    step("bad size is rejected before touching the GPU");
    const bad = await call("/api/jobs", { method: "POST", body: { projectId: p.id, workflow: "native_t2v", prompt: "x", width: 500, height: 384, seconds: 2 } });
    assert(bad.status === 400 && /32/.test(bad.body.error), "size validation: " + JSON.stringify(bad.body));

    step("t2v job runs to completion");
    const j1 = await ok("/api/jobs", { method: "POST", body: { projectId: p.id, title: "e2e t2v", workflow: "native_t2v", prompt: "integrated_multimodal_description: test\n\noverall_soundscape: quiet\n\nnon_diegetic_music: N/A", width: 640, height: 384, seconds: 2, seed: 7 } });
    assert(j1.length === 56 && j1.seed === 7 && j1.steps === 4, "job derived params: " + JSON.stringify({ length: j1.length, seed: j1.seed, steps: j1.steps }));
    // Real GPU: power-on ≈2 min + up to ~4 min per job; mock: sub-second. Poll gently either way.
    const waitJob = async (id) => { const deadline = Date.now() + (args.base ? 15 * 60_000 : 120_000); let last = ""; while (Date.now() < deadline) { const j = await ok(`/api/jobs/${id}`); if (args.base && j.log?.at(-1)?.text !== last) { last = j.log?.at(-1)?.text || ""; console.log(`   [${id}] ${j.status} ${last}`); } if (["done", "error", "cancelled"].includes(j.status)) return j; await sleep(args.base ? 5000 : 300); } throw new Error(`job timeout ${id}`); };
    { const jq = await ok(`/api/jobs/${j1.id}`); assert(typeof jq.estimate === "number" && typeof jq.eta === "number" && jq.eta > 0, "eta/estimate exposed: " + JSON.stringify({ estimate: jq.estimate, eta: jq.eta, pos: jq.queuePosition })); const gq = await ok("/api/gpu"); assert("etaSeconds" in gq.queue, "queue eta in gpu snapshot"); }
    const d1 = await waitJob(j1.id);
    assert(d1.status === "done", "t2v done: " + d1.error + " log=" + JSON.stringify(d1.log));
    assert(d1.output.width === 640 && d1.output.height === 384 && Math.abs(d1.output.duration - 56 / 24) < 0.2, "output geometry " + JSON.stringify(d1.output));
    assert(d1.refCheck.expected === 0 && d1.refCheck.ok, "refcheck t2v");
    const file = await fetch(`${base}/api/jobs/${j1.id}/file`, { headers: { cookie, range: "bytes=0-99" } }); assert(file.status === 206, "range request served");
    assert((await fetch(`${base}/api/jobs/${j1.id}/poster`, { headers: { cookie } })).status === 200, "poster");

    step("i2v with first+last frame, ref2va with pictures + video (dotted paths reach the node)");
    const j2 = await ok("/api/jobs", { method: "POST", body: { projectId: p.id, title: "e2e i2v", workflow: "native_i2v", prompt: "p", width: 640, height: 384, seconds: 2, images: [a1.id], lastFrame: fr.id } });
    const j3 = await ok("/api/jobs", { method: "POST", body: { projectId: p.id, title: "e2e ref", workflow: "native_ref2va", prompt: "p", width: 640, height: 384, seconds: 2, images: [crop.id, a1.id], videos: [prep.id], videoAudio: true, refSize: "match" } });
    const d2 = await waitJob(j2.id), d3 = await waitJob(j3.id);
    assert(d2.status === "done" && d2.refCheck.received.includes("first_frame") && d2.refCheck.received.includes("last_frame"), "i2v refs " + JSON.stringify(d2.refCheck) + d2.error);
    assert(d3.status === "done" && d3.refCheck.ok && d3.refCheck.received.includes("ref_images.ref_image_1") && d3.refCheck.received.includes("ref_video_audios.ref_video_audio_0"), "ref2va refs " + JSON.stringify(d3.refCheck) + d3.error);
    const submitted = mock?.submitted?.at(-1); if (submitted) { const wf = submitted.prompt || submitted; const node = Object.values(wf).find((n) => n.class_type === "MiniMaxH3ReferenceToVideo"); assert(node && node.inputs.ref_image_size === "match", "ref_image_size forwarded"); }

    step("white-model tool job: source clip → AtelierWhiteModel node (no prompt, geometry from the asset)");
    assert((await call("/api/jobs", { method: "POST", body: { projectId: p.id, workflow: "whitemodel", videos: [a1.id] } })).status === 400, "white-model rejects an image source");
    const wmj = await ok("/api/jobs", { method: "POST", body: { projectId: p.id, workflow: "whitemodel", videos: [prep.id], whitemodel: { preset: "sculpt", relief: 7, photo: 0.4 } } });
    assert(wmj.workflow === "whitemodel" && wmj.whitemodel.preset === "sculpt" && wmj.whitemodel.relief === 7 && wmj.steps === 1000 && /\[whitemodel\] preset=sculpt/.test(wmj.prompt) && wmj.width > 0, "white-model job created " + JSON.stringify({ wm: wmj.whitemodel, w: wmj.width, l: wmj.length }));
    const wmd = await waitJob(wmj.id); assert(wmd.status === "done" && wmd.output?.file && wmd.refCheck?.ok, "white-model job done " + (wmd.error || ""));
    // subject-only: sculpt the person, keep the room — for footage whose actor cannot be shown
    const wmSub = await ok("/api/jobs", { method: "POST", body: { projectId: p.id, workflow: "whitemodel", videos: [prep.id], whitemodel: { preset: "clay", subjectOnly: true, subjectThreshold: 0.7 } } });
    assert(wmSub.whitemodel?.subjectOnly === true && wmSub.whitemodel.subjectThreshold === 0.7 && /仅人物/.test(wmSub.prompt || "") === false, "subject-only settings travel with the job " + JSON.stringify(wmSub.whitemodel));
    const wmSubDone = await waitJob(wmSub.id); assert(wmSubDone.status === "done", "subject-only white model ran " + (wmSubDone.error || ""));
    if (args.base) await call(`/api/jobs/${wmSub.id}`, { method: "DELETE" });
    if (args.base) await call(`/api/jobs/${wmj.id}`, { method: "DELETE" });

    step("clip workflow: generate → take → pick → subtitles → assemble");
    const c1 = await ok(`/api/projects/${p.id}/clips`, { method: "POST", body: { title: "开场", summary: "[reference generation] test", shot: "[Shot 1] static.", subs: [] } });
    const c2 = await ok(`/api/projects/${p.id}/clips`, { method: "POST", body: { title: "第二段", summary: "[reference generation] test 2", shot: "[Shot 1] static 2.", seconds: 2.3 } });
    await ok(`/api/projects/${p.id}/clips/${c1.id}`, { method: "PATCH", body: { subs: [{ text: "你看到我充电器了吗？", from: 0.2, to: 1.8 }] } });
    await ok(`/api/projects/${p.id}/clips/${c2.id}`, { method: "PATCH", body: { subs: [{ text: "没看见。" }], gain: 2 } });
    const pr = await ok(`/api/projects/${p.id}/clips/${c1.id}/prompt`);
    assert(pr.prompt.startsWith("subject_definitions:") && pr.prompt.includes("summary:\n[reference generation] test") && pr.prompt.endsWith("non_diegetic_music:\nN/A") && pr.params.images.length === 2, "composed prompt: " + pr.prompt);
    const g1 = await ok(`/api/projects/${p.id}/clips/${c1.id}/generate`, { method: "POST", body: {} });
    const g1b = await ok(`/api/projects/${p.id}/clips/${c1.id}/generate`, { method: "POST", body: {} });
    const g2 = await ok(`/api/projects/${p.id}/clips/${c2.id}/generate`, { method: "POST", body: {} });
    assert(g1.take === 1 && g1b.take === 2 && g1b.seed === g1.seed + 1000, "takes + seed offset");
    const [r1, r1b, r2] = await Promise.all([waitJob(g1.id), waitJob(g1b.id), waitJob(g2.id)]);
    assert(r1.status === "done" && r1b.status === "done" && r2.status === "done", "clip jobs done " + [r1.error, r1b.error, r2.error]);
    let pp = await ok(`/api/projects/${p.id}`);
    assert(pp.clips[0].takes.length === 2 && pp.clips[0].pick === g1.id, "first take auto-picked");
    await ok(`/api/projects/${p.id}/clips/${c1.id}/pick`, { method: "POST", body: { jobId: g1b.id } });
    const render = await ok(`/api/projects/${p.id}/assemble`, { method: "POST", body: {} });
    assert(render.clips[0].jobId === g1b.id && render.cues.length === 2, "render uses picked take + cues " + JSON.stringify(render.cues));
    const expected = r1b.output.duration + r2.output.duration + 1;
    assert(Math.abs(render.duration - expected) < 0.35, `render duration ${render.duration} ≈ ${expected}`);
    assert(render.cues[1].start > r1b.output.duration && render.cues[1].end <= expected - 1 + 0.01, "second cue offset into clip 2: " + JSON.stringify(render.cues[1]));
    const srt = (await call(`/api/projects/${p.id}/renders/${render.id}/srt`)).body.raw; assert(/充电器/.test(srt) && /-->/.test(srt), "srt");
    assert((await fetch(`${base}/api/projects/${p.id}/renders/${render.id}/file`, { headers: { cookie } })).status === 200, "render file");
    if (meta.ffmpeg.ass) assert((await fetch(`${base}/api/projects/${p.id}/renders/${render.id}/nosub`, { headers: { cookie } })).status === 200 && render.subtitles, "nosub file + burned"); else { assert(!render.subtitles && render.subtitleNote, "no libass → note"); console.log("  (local ffmpeg has no libass; burn-in skipped, note recorded)"); }

    step("continuation: last frame → i2v clip, take → [video continuation] clip");
    const cf = await ok(`/api/projects/${p.id}/clips/${c1.id}/continue`, { method: "POST", body: { mode: "frame" } });
    assert(cf.workflow === "native_i2v" && cf.refs.length === 1 && cf.title.includes("续"), "frame continuation clip " + JSON.stringify(cf).slice(0, 200));
    const cv = await ok(`/api/projects/${p.id}/clips/${c1.id}/continue`, { method: "POST", body: { mode: "video" } });
    assert(cv.workflow === "native_ref2va" && cv.videos.length === 1 && cv.summary.startsWith("[video continuation]") && /<Video 1>/.test(cv.subjects) && /<Video 1>/.test(cv.retention), "video continuation clip");
    pp = await ok(`/api/projects/${p.id}`);
    const order = pp.clips.map((x) => x.id);
    assert(order.indexOf(cf.id) === order.indexOf(c1.id) + 2 && order.indexOf(cv.id) === order.indexOf(c1.id) + 1, "continuation clips inserted right after the source: " + order.join(","));
    const va = pp.assets.find((a) => a.id === cv.videos[0]); assert(va && va.kind === "video" && va.source.jobId === g1b.id, "take cloned to a video asset");
    const fpr = await ok(`/api/projects/${p.id}/clips/${cf.id}/prompt`);
    assert(fpr.prompt.startsWith("For the target video, at 0.00 seconds") && fpr.params.images[0] === cf.refs[0] && fpr.params.workflow === "native_i2v", "i2v continuation prompt: " + fpr.prompt.slice(0, 80));
    const vpr = await ok(`/api/projects/${p.id}/clips/${cv.id}/prompt`);
    assert(vpr.params.videos[0] === cv.videos[0] && vpr.params.images.length === 2 && /summary:\n\[video continuation\]/.test(vpr.prompt), "video continuation prompt uses shared pictures + video");
    const gcf = await ok(`/api/projects/${p.id}/clips/${cf.id}/generate`, { method: "POST", body: {} });
    const rcf = await waitJob(gcf.id);
    assert(rcf.status === "done" && rcf.refCheck.received.includes("first_frame"), "continuation job ran with first_frame " + rcf.error);
    for (const cid of [cf.id, cv.id]) await ok(`/api/projects/${p.id}/clips/${cid}`, { method: "DELETE" });
    if (args.base) await call(`/api/jobs/${gcf.id}`, { method: "DELETE" });

    step("video-edit wizard: shot detection → refs → per-shot job → reassemble with original audio");
    const ev = path.join(os.tmpdir(), `h3s-e2e-edit-${crypto.randomBytes(2).toString("hex")}.mp4`);
    execSync(`ffmpeg -y -loglevel error -f lavfi -i "color=c=red:s=320x240:r=24:d=1.5" -f lavfi -i "color=c=blue:s=320x240:r=24:d=1.5" -f lavfi -i "sine=frequency=500:d=3" -filter_complex "[0:v][1:v]concat=n=2:v=1:a=0[v]" -map "[v]" -map 2:a -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest ${ev}`);
    const sv = await ok(`/api/projects/${p.id}/assets?name=source.mp4`, { method: "PUT", body: await fs.readFile(ev), raw: true, headers: { "content-type": "application/octet-stream" } });
    const ed = await ok(`/api/projects/${p.id}/edits`, { method: "POST", body: { sourceAssetId: sv.id, threshold: 0.3, minLen: 0.5 } });
    assert(ed.shots.length === 2 && Math.abs(ed.shots[1].start - 1.5) < 0.1 && ed.settings.width % 32 === 0 && ed.shots.every((x) => x.strip), "two shots detected with strips: " + JSON.stringify(ed.shots.map((x) => [x.start, x.end])) + " size " + ed.settings.width + "x" + ed.settings.height);
    const ed2 = await ok(`/api/projects/${p.id}/edits/${ed.id}`, { method: "PATCH", body: { refs: [crop.id], prompt: { target: "the man in the blue shirt in <Video 1>", face: "a woman with short black hair and round glasses" }, shots: [{ index: 1, selected: true, desc: "he turns to the camera and smiles" }], settings: { width: 320, height: 256 } } });
    assert(ed2.refs.length === 1 && ed2.shots[1].selected && ed2.settings.width === 320, "edit patched");
    const epr = await ok(`/api/projects/${p.id}/edits/${ed.id}/shots/1/prompt`);
    assert(/\[video editing \+ audio reuse\]/.test(epr.prompt) && /<Picture 1>/.test(epr.prompt) && /round glasses/.test(epr.prompt) && /turns to the camera/.test(epr.prompt), "edit prompt composed: " + epr.prompt.slice(0, 120));
    const ej = await ok(`/api/projects/${p.id}/edits/${ed.id}/shots/1/generate`, { method: "POST", body: {} });
    assert(ej.workflow === "native_ref2va" && ej.videos.length === 1 && ej.videoAudio === true && ej.images[0] === crop.id && (ej.length - 5) % 17 === 0, "per-shot job spec " + JSON.stringify({ wf: ej.workflow, v: ej.videos, len: ej.length }));
    const ejd = await waitJob(ej.id);
    assert(ejd.status === "done" && ejd.refCheck.received.includes("ref_video_audios.ref_video_audio_0"), "edit job done with audio ref " + ejd.error);
    const ed3 = await ok(`/api/projects/${p.id}/edits/${ed.id}`); assert(ed3.shots[1].jobs.length === 1 && ed3.shots[1].pick === ej.id && ed3.shots[1].seg, "shot has take + prepped segment");
    const er = await ok(`/api/projects/${p.id}/edits/${ed.id}/assemble`, { method: "POST", body: {} });
    assert(Math.abs(er.duration - 3.0) < 0.3 && er.editedShots === 1 && er.clips.length === 2 && er.clips[1].edited && !er.clips[0].edited, "reassembled: " + JSON.stringify({ d: er.duration, edited: er.editedShots, clips: er.clips }));
    const erf = await fetch(`${base}/api/projects/${p.id}/renders/${er.id}/file`, { headers: { cookie } }); assert(erf.status === 200, "edit render served");
    if (args.base) await call(`/api/jobs/${ej.id}`, { method: "DELETE" });

    step("master workshop: front → turn (three-quarter/profile) → adopt; scene wide → crop → regen");
    const mp = await ok(`/api/projects/${p.id}/masters`, { method: "POST", body: { kind: "person", name: "girl", face: crop.id, desc: "an East Asian girl about twelve, black round-frame glasses", outfit: "a light-blue tank top", width: 320, height: 384, seed: 7100 } });
    assert(mp.kind === "person" && mp.faces[0] === crop.id && mp.settings.width === 320, "person master created");
    const fp = await ok(`/api/projects/${p.id}/masters/${mp.id}/prompt?step=front`); assert(/\[reference generation\] A single static medium close-up facing the camera/.test(fp.prompt) && /light-grey studio backdrop/.test(fp.prompt), "front prompt");
    const mr1 = await ok(`/api/projects/${p.id}/masters/${mp.id}/run`, { method: "POST", body: { step: "front" } });
    assert(mr1.job.length === 56 && mr1.job.images.length === 1 && mr1.key === "front", "front job 56 frames");
    assert((await call(`/api/projects/${p.id}/masters/${mp.id}/run`, { method: "POST", body: { step: "turn" } })).status === 400, "turn refused before front exists");
    await waitJob(mr1.job.id); for (let i = 0; i < 40; i++) { const pm = (await ok(`/api/projects/${p.id}`)).masters.find((x) => x.id === mp.id); if (pm.steps.front.assetId) break; await sleep(150); }
    let pm = (await ok(`/api/projects/${p.id}`)).masters.find((x) => x.id === mp.id);
    assert(pm.steps.front.assetId && pp.assets.length >= 0, "front frame auto-registered as asset");
    const mr2 = await ok(`/api/projects/${p.id}/masters/${mp.id}/run`, { method: "POST", body: { step: "turn" } });
    assert(mr2.job.length === 90 && mr2.job.images.length === 2 && mr2.job.images[1] === pm.steps.front.assetId && /turns the head/.test(mr2.job.prompt), "turn job uses photo + front");
    await waitJob(mr2.job.id); for (let i = 0; i < 40; i++) { pm = (await ok(`/api/projects/${p.id}`)).masters.find((x) => x.id === mp.id); if (pm.steps.turn.assets?.profile) break; await sleep(150); }
    assert(pm.steps.turn.assets.threeq && pm.steps.turn.assets.profile, "three-quarter + profile frames extracted at 1.9/3.3 s");
    const ex = await ok(`/api/projects/${p.id}/masters/${mp.id}/extract`, { method: "POST", body: { key: "turn", at: 2.5, label: "profile" } }); assert(ex.kind === "image" && ex.source.at === 2.5, "re-extract at custom time");
    const ad = await ok(`/api/projects/${p.id}/masters/${mp.id}/adopt`, { method: "POST", body: { target: "refs" } });
    pp = await ok(`/api/projects/${p.id}`); assert(ad.added.length === 4 && ad.added[0] === crop.id && ad.added.every((a) => pp.refs.includes(a)), "adopted photo+front+threeq+profile as shared refs " + JSON.stringify(ad));
    const msc = await ok(`/api/projects/${p.id}/masters`, { method: "POST", body: { kind: "scene", name: "living", faces: [crop.id], subjects: "<Subject 1> is CHARACTER A from <Picture 1>, sitting on the LEFT of the sofa.", scene: "LEFT background = kitchen; RIGHT background = window; beige sofa center", width: 640, height: 384 } });
    const mr3 = await ok(`/api/projects/${p.id}/masters/${msc.id}/run`, { method: "POST", body: { step: "wide" } });
    assert(/One static wide shot/.test(mr3.job.prompt) && /LEFT background = kitchen/.test(mr3.job.prompt) && mr3.job.width === 640, "wide prompt");
    await waitJob(mr3.job.id); for (let i = 0; i < 40; i++) { pm = (await ok(`/api/projects/${p.id}`)).masters.find((x) => x.id === msc.id); if (pm.steps.wide.assetId) break; await sleep(150); }
    assert(pm.steps.wide.assetId, "wide frame registered");
    const half = await ok(`/api/projects/${p.id}/assets/${pm.steps.wide.assetId}/crop`, { method: "POST", body: { crop: { x: 0, y: 0, w: 320, h: 384 }, exact: { w: 320, h: 384 } } });
    const mr4 = await ok(`/api/projects/${p.id}/masters/${msc.id}/run`, { method: "POST", body: { step: "regen", from: half.id } });
    assert(mr4.key.startsWith("regen_") && mr4.job.images.at(-1) === half.id && /composition anchor/.test(mr4.job.prompt), "regen from cropped half");
    await waitJob(mr4.job.id); for (let i = 0; i < 40; i++) { pm = (await ok(`/api/projects/${p.id}`)).masters.find((x) => x.id === msc.id); if (pm.steps[mr4.key].assetId) break; await sleep(150); }
    assert(pm.steps[mr4.key].assetId, "regen frame registered");
    const ad2 = await ok(`/api/projects/${p.id}/masters/${msc.id}/adopt`, { method: "POST", body: { target: "edit", editId: ed.id, includeFace: false } });
    assert(ad2.added.length === 2 && (await ok(`/api/projects/${p.id}/edits/${ed.id}`)).refs.includes(pm.steps.wide.assetId), "adopted into edit refs");
    if (args.base) { for (const jid of [mr1.job.id, mr2.job.id, mr3.job.id, mr4.job.id]) await call(`/api/jobs/${jid}`, { method: "DELETE" }); await call(`/api/projects/${p.id}/edits/${ed.id}`, { method: "DELETE" }); }

    step("quality tiers exposed; long avatar: audio asset → silence split → chained ref2va jobs with <Audio 1> → assemble");
    assert(meta.quality?.fast?.size?.[0] === 640 && meta.quality.ultra.size[0] === 1344, "quality tiers in meta");
    const au = path.join(os.tmpdir(), `h3s-e2e-${crypto.randomBytes(2).toString("hex")}.mp3`);
    // 3 s tone, 0.6 s silence, 3 s tone, 0.6 s silence, 2 s tone → ~9.2 s, two clear pauses
    execSync(`ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=440:duration=3" -f lavfi -i "anullsrc=r=48000:cl=stereo:d=0.6" -f lavfi -i "sine=frequency=660:duration=3" -f lavfi -i "anullsrc=r=48000:cl=stereo:d=0.6" -f lavfi -i "sine=frequency=550:duration=2" -filter_complex "[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1[a]" -map "[a]" -c:a libmp3lame -q:a 4 ${au}`);
    const aa = await ok(`/api/projects/${p.id}/assets?name=speech.mp3`, { method: "PUT", body: await fs.readFile(au), raw: true, headers: { "content-type": "application/octet-stream" } });
    assert(aa.kind === "audio" && aa.file.endsWith(".wav") && Math.abs(aa.duration - 9.2) < 0.3 && aa.thumb, "audio asset converted to wav with waveform: " + JSON.stringify(aa));
    const avt = await ok(`/api/projects/${p.id}/avatars`, { method: "POST", body: { face: crop.id, audio: aa.id, name: "讲解员", maxLen: 4, width: 320, height: 384, style: "enthusiastic" } });
    assert(avt.segments.length === 3 && avt.segments.every((sg) => (sg.frames - 5) % 17 === 0 && sg.frames / 24 >= sg.duration - 0.01 && sg.audioAsset), "split at the two pauses into 3 aligned segments: " + JSON.stringify(avt.segments.map((x) => [x.start, x.end, x.frames])));
    const segA = await ok(`/api/projects/${p.id}/assets/${avt.segments[0].audioAsset}/file`).catch(() => null);
    const ap = await ok(`/api/projects/${p.id}/avatars/${avt.id}/segments/1/prompt`); assert(/\[reference generation \+ audio reuse\]/.test(ap.prompt) && /<Audio 1>: fully_copy/.test(ap.prompt) && /<Picture 2> is the exact framing/.test(ap.prompt) && /energetic/.test(ap.prompt), "avatar prompt");
    const aj = await ok(`/api/projects/${p.id}/avatars/${avt.id}/generate-all`, { method: "POST" });
    assert(aj.audios.length === 1 && aj.images.length === 1 && aj.length === avt.segments[0].frames, "first segment job: audio ref, no anchor yet");
    let avd; for (let i = 0; i < 400; i++) { avd = await ok(`/api/projects/${p.id}/avatars/${avt.id}`); if (avd.segments.every((sg) => sg.jobs.length) && !avd.auto) break; await sleep(300); }
    assert(avd.segments.every((sg) => sg.jobs.length === 1) && !avd.auto, "chain generated all 3 segments: " + JSON.stringify(avd.segments.map((x) => x.jobs.length)));
    const av2 = await waitJob(avd.segments[1].jobs[0]); await waitJob(avd.segments[2].jobs[0]);
    assert(av2.status === "done" && av2.images.length === 2 && av2.refCheck.received.includes("ref_audios.ref_audio_0") && av2.refCheck.received.includes("ref_images.ref_image_1"), "segment 2 used the previous last frame as anchor + audio ref: " + JSON.stringify(av2.refCheck));
    avd = await ok(`/api/projects/${p.id}/avatars/${avt.id}`); assert(avd.segments[0].anchor && avd.segments[1].anchor, "anchor frames registered");
    const avr = await ok(`/api/projects/${p.id}/avatars/${avt.id}/assemble`, { method: "POST", body: {} });
    assert(Math.abs(avr.duration - aa.duration) < 0.35 && avr.clips.length === 3, `avatar render ${avr.duration}s ≈ audio ${aa.duration}s`);
    if (args.base) { for (const sg of avd.segments) for (const jid of sg.jobs) await call(`/api/jobs/${jid}`, { method: "DELETE" }); await call(`/api/projects/${p.id}/avatars/${avt.id}`, { method: "DELETE" }); }

    step("batch (seed sweep + variants) → group list → contact sheet; LoRA list / swap / disable");
    const lr = await ok("/api/loras"); assert((args.base ? lr.items.length >= 1 : lr.items.length === 3) && lr.items.every((x) => x.endsWith(".safetensors")) && lr.templates.native_ref2va, "loras from ComfyUI filtered: " + JSON.stringify(lr.items));
    const bt = await ok("/api/jobs/batch", { method: "POST", body: { spec: { projectId: p.id, workflow: "native_t2v", prompt: "integrated_multimodal_description: base {{v}}\n\noverall_soundscape: x\n\nnon_diegetic_music: N/A", width: 640, height: 384, seconds: 2 }, count: 2, seedStart: 100, variants: ["red duck", "blue duck"], title: "扫描" } });
    assert(bt.groupId.startsWith("g_") && bt.jobs.length === 4 && bt.jobs.map((j) => j.seed).join(",") === "100,101,100,101" && bt.jobs[2].prompt.includes("base blue duck") && bt.jobs.every((j) => j.groupId === bt.groupId), "batch of 2 seeds × 2 variants: " + JSON.stringify(bt.jobs.map((j) => [j.seed, j.groupIndex])));
    for (const j of bt.jobs) await waitJob(j.id);
    const groups = await ok("/api/jobs/groups"); const grp = groups.find((g) => g.id === bt.groupId); assert(grp && grp.count === 4 && grp.done === 4 && grp.title === "扫描", "group summary " + JSON.stringify(grp));
    assert((await ok(`/api/jobs?groupId=${bt.groupId}`)).length === 4, "list by group");
    const sh = await fetch(`${base}/api/jobs/group/${bt.groupId}/sheet`, { headers: { cookie } }); assert(sh.status === 200 && /image\/jpeg/.test(sh.headers.get("content-type")), "contact sheet jpg");
    const shm = await ok(`/api/jobs/group/${bt.groupId}/sheet?meta=1`); assert(shm.jobs.length === 4 && shm.jobs[0].seed === 100, "sheet meta");
    // Real GPU: pick a LoRA that actually exists there (prefer a fl2va turbo file); mock: the fake v1.2 file.
    const loraName = args.base ? (lr.items.find((x) => /fl2v|turbo/i.test(x) && !/ref2va|ref2v/i.test(x)) || lr.items[0]) : "minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors";
    const jl = await ok("/api/jobs", { method: "POST", body: { projectId: p.id, workflow: "native_t2v", prompt: "p", width: 640, height: 384, seconds: 2, lora: { name: loraName, strength: 0.8 } } });
    const jn = await ok("/api/jobs", { method: "POST", body: { projectId: p.id, workflow: "native_ref2va", prompt: "p", width: 640, height: 384, seconds: 2, images: [crop.id], steps: 20, lora: { disabled: true } } });
    const dl = await waitJob(jl.id), dn = await waitJob(jn.id);
    assert(dl.status === "done" && dl.lora.name === loraName && dl.lora.strength === 0.8, "lora swap recorded: " + dl.status + " " + (dl.error || ""));
    const subN = mock?.submitted?.find((x) => (x.prompt || x)["7"]?.inputs?.prompt === "p" && !Object.values(x.prompt || x).some((n) => n.class_type === "LoraLoaderModelOnly"));
    assert(dn.status === "done" && dn.lora.disabled && (!mock || (subN && (subN.prompt || subN)["3"].inputs.model[0] === "1")), "lora disabled: node removed and sigma-shift rewired to UNet");
    const subL = mock?.submitted?.find((x) => Object.values(x.prompt || x).some((n) => n.class_type === "LoraLoaderModelOnly" && n.inputs.lora_name.includes("v1.2") && n.inputs.strength_model === 0.8)); assert(!mock || subL, "lora name/strength reached the workflow");

    step("scene.json export (zip with refs + picked takes) → import into a fresh project; manual tag edits survive re-tag");
    const zipRes = await fetch(`${base}/api/projects/${p.id}/export.zip`, { headers: { cookie } }); assert(zipRes.status === 200 && /zip/.test(zipRes.headers.get("content-type") || "") || zipRes.status === 200, "export zip " + zipRes.status);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer()); assert(zipBuf.length > 1000 && zipBuf.slice(0, 2).toString() === "PK", "zip magic");
    const sj = await ok(`/api/projects/${p.id}/export.json`); assert(sj.clips.length >= 2 && sj.refs.length >= 2 && sj.refs.every((r) => r.startsWith("refs/")) && sj.pick && Object.keys(sj.pick).length >= 1 && sj.subjects.includes("<Subject 1>"), "scene.json shape " + JSON.stringify({ clips: sj.clips.length, refs: sj.refs, pick: sj.pick }));
    const p2 = await ok("/api/projects", { method: "POST", body: { name: "导入测试" } });
    const imp = await ok(`/api/projects/${p2.id}/import?name=scene.zip`, { method: "PUT", body: zipBuf, raw: true, headers: { "content-type": "application/octet-stream" } });
    const pp2 = await ok(`/api/projects/${p2.id}`);
    assert(imp.clips === sj.clips.length && imp.refs === sj.refs.length && pp2.refs.length === sj.refs.length && pp2.clips.length === sj.clips.length && pp2.shared.subjects === sj.subjects && pp2.settings.width === sj.width && pp2.clips[0].seed === sj.clips[0].seed && pp2.assets.length >= sj.refs.length, "imported project mirrors the export " + JSON.stringify(imp));
    const c1i = pp2.clips.find((c) => c.title === sj.clips[0].title); assert(c1i && c1i.subs.length === 1 && c1i.subs[0].text.includes("充电器"), "clip subtitles imported");
    if (args.base) await call(`/api/projects/${p2.id}`, { method: "DELETE" });

    step("job frame extraction → asset; cancel; delete");
    const fa = await ok(`/api/jobs/${j1.id}/frame`, { method: "POST", body: { at: 0.5 } }); assert(fa.kind === "image" && fa.source.jobId === j1.id, "frame from job");
    const jc = await ok("/api/jobs", { method: "POST", body: { projectId: p.id, title: "to cancel", workflow: "native_t2v", prompt: "p", width: 640, height: 384, seconds: 5 } });
    await sleep(200); const cc = await ok(`/api/jobs/${jc.id}/cancel`, { method: "POST" }); assert(cc.status === "cancelled", "cancelled");
    await ok(`/api/jobs/${jc.id}`, { method: "DELETE" }); assert((await call(`/api/jobs/${jc.id}`)).status === 404, "deleted");

    step("execution error surfaces (mock fails on misaligned length)");
    if (mock) {
      // Bypass the API validation by posting a raw bad workflow to the mock and making sure the server's finalize maps the error text.
      const bad2 = await call("/api/jobs", { method: "POST", body: { projectId: p.id, workflow: "native_t2v", prompt: "p", width: 640, height: 384, length: 9999 } });
      assert(bad2.status === 400, "too long rejected");
    }
    if (args.base) { step("cleanup on remote"); for (const id of [j1.id, j2.id, j3.id, g1.id, g1b.id, g2.id]) await call(`/api/jobs/${id}`, { method: "DELETE" }); await call(`/api/projects/${p.id}`, { method: "DELETE" }); }
    if (args.base) console.log("\n(skipping the prompt-library sync/re-tag step against production)"); else {
    step("prompt library: OpenPrompt mirror sync → tags → vectors → search; saved prompts");
    const st0 = await ok("/api/prompts/status"); assert(st0.items === 0 && st0.embed === true && st0.tagModel === "mock-flash", "prompts status " + JSON.stringify(st0));
    await ok("/api/prompts/sync", { method: "POST", body: {} });
    let st1; for (let i = 0; i < 100; i++) { st1 = await ok("/api/prompts/status"); if (!st1.syncing && st1.lastSync) break; await sleep(150); }
    assert(st1.items === 3 && st1.tagged === 3 && st1.embedded === 3, "synced 3 videos (image skipped): " + JSON.stringify(st1));
    assert(mockAI.calls.chat.some((c) => c.model === "mock-flash") && mockAI.calls.embeddings.some((c) => c.model === "mock-embed"), "fast model used for tags, embed model for vectors");
    const facets = await ok("/api/prompts/facets"); assert(facets.models.length === 2 && facets.models.some((m) => m[0] === "MiniMax H3" && m[1] === 2) && facets.tags.some((t) => t[0] === "夜晚") && !facets.tags.some((t) => t[0] === "夜景"), "facets normalised (model names merged, 夜景→夜晚) " + JSON.stringify(facets.models) + JSON.stringify(facets.tags.slice(0, 5)));
    const it = await ok("/api/prompts/item/h3-rainy-street"); assert(it.prompt.includes("rainy neon") && it.source_post_url && it.video_url && it.tags.length >= 8 && it.mode === "t2v" && it.h3_format === true && it.title_zh.startsWith("中文·"), "item detail with provenance + tags " + JSON.stringify(it).slice(0, 200));
    assert(it.video_url.endsWith("/hls/master.m3u8"), "mock item carries an HLS url");
    const m3u = await fetch(`${base}/api/prompts/media?u=${encodeURIComponent(it.video_url)}`, { headers: { cookie } }); const m3uText = await m3u.text();
    assert(m3u.status === 200 && /mpegurl/.test(m3u.headers.get("content-type")) && /media\?u=.*variant\.m3u8/.test(m3uText) && /URI="media\?u=.*audio\.m3u8"/.test(m3uText), "master playlist rewritten through the relay: " + m3uText.slice(0, 200));
    const variantUrl = decodeURIComponent(m3uText.match(/media\?u=([^\s"]+variant\.m3u8)/)[1]);
    const var2 = await (await fetch(`${base}/api/prompts/media?u=${encodeURIComponent(variantUrl)}`, { headers: { cookie } })).text();
    const segUrl = decodeURIComponent(var2.match(/media\?u=([^\s"]+seg0\.ts)/)[1]);
    const seg = await fetch(`${base}/api/prompts/media?u=${encodeURIComponent(segUrl)}`, { headers: { cookie } }); assert(seg.status === 200 && /mp2t/.test(seg.headers.get("content-type")) && (await seg.text()).startsWith("TSDATA"), "segment relayed with content-type");
    assert((await fetch(`${base}/api/prompts/media?u=${encodeURIComponent("https://evil.example.com/x.m3u8")}`, { headers: { cookie } })).status === 403, "unknown host refused");
    const sr = await ok("/api/prompts/search?q=" + encodeURIComponent("A woman walks down a rainy neon street at night") + "&k=3");
    assert(sr.mode === "vector" && sr.results[0].id === "h3-rainy-street" && typeof sr.results[0].score === "number", "vector search top hit " + JSON.stringify(sr.results.map((r) => [r.id, r.score])));
    const sr2 = await ok("/api/prompts/search?q=" + encodeURIComponent("yellow rubber duck floats on a calm pond") + "&k=3&h3=1"); assert(sr2.results.every((r) => /h3/i.test(r.model)), "h3 filter");
    const br = await ok("/api/prompts/browse?model=" + encodeURIComponent("Seedance 2.0")); assert(br.total === 1 && br.items[0].id === "seedance-duck", "browse filter by model");
    const bra = await ok("/api/prompts/browse?author=tester&durMin=4&durMax=6"); assert(bra.total === 3 && facets.authors?.[0]?.[0] === "tester", "author + duration filters " + JSON.stringify([bra.total, facets.authors]));
    assert((await ok("/api/prompts/browse?durMax=3")).total === 0, "duration filter excludes 5s items");
    const br2 = await ok("/api/prompts/browse?q=charger"); assert(br2.total === 1 && br2.items[0].id === "h3-sisters-charger", "browse keyword");
    const lib = await ok("/api/library", { method: "POST", body: { name: "我的开场", text: "integrated_multimodal_description: test\n\noverall_soundscape: x\n\nnon_diegetic_music: N/A", mode: "t2v", tags: "开场, 测试" } });
    assert(lib.id.startsWith("l_") && lib.tags.length === 2 && lib.vec === undefined, "library add (vector not exposed)");
    for (let i = 0; i < 30; i++) { const l = await ok("/api/library"); if (l[0]?.embedded) break; await sleep(100); }
    const srm = await ok("/api/prompts/search?q=" + encodeURIComponent("integrated_multimodal_description test") + "&k=2"); assert(Array.isArray(srm.mine) && srm.mine[0]?.id === lib.id && srm.mine[0].mine === true, "saved prompt shows up in recommendations: " + JSON.stringify(srm.mine));
    await ok(`/api/library/${lib.id}`, { method: "PATCH", body: { name: "开场镜头", tags: ["开场"] } });
    const ll = await ok("/api/library?q=开场"); assert(ll.length === 1 && ll[0].name === "开场镜头" && ll[0].tags.length === 1, "library list/search");
    await ok(`/api/library/${lib.id}`, { method: "DELETE" }); assert((await ok("/api/library")).length === 0, "library delete");
    const draft = await ok("/api/llm/prompt", { method: "POST", body: { mode: "t2v", idea: "小黄鸭", seconds: 5, refs: [] } }); assert(draft.prompt.startsWith("integrated_multimodal_description") && mockAI.calls.chat.at(-1).model === "mock-pro", "assistant uses the pro model");
    const st2 = await ok("/api/prompts/sync", { method: "POST", body: { retag: true } }); assert(st2.ok, "retag accepted");
    for (let i = 0; i < 100; i++) { const s3 = await ok("/api/prompts/status"); if (!s3.syncing) break; await sleep(100); }
    const pe1 = await ok(`/api/prompts/item/h3-rainy-street`, { method: "PATCH", body: { title_zh: "雨夜霓虹（人工）", tags: "雨夜, 霓虹, 手工标签" } });
    assert(pe1.manual === true && pe1.title_zh === "雨夜霓虹（人工）" && pe1.tags.includes("手工标签"), "manual edit applied " + JSON.stringify(pe1.tags));
    await ok("/api/prompts/sync", { method: "POST", body: { retag: true } });
    for (let i = 0; i < 100; i++) { const s3 = await ok("/api/prompts/status"); if (!s3.syncing) break; await sleep(100); }
    const pe2 = await ok(`/api/prompts/item/h3-rainy-street`); assert(pe2.title_zh === "雨夜霓虹（人工）" && pe2.tags.includes("手工标签"), "re-tag kept manual edits");
    const rnd = await ok("/api/prompts/random?k=5");
    assert(rnd.mode === "random" && rnd.results.length > 0 && rnd.results.length <= 5 && rnd.total > 0, "random picks work with no query " + JSON.stringify({ n: rnd.results.length, total: rnd.total }));
    const rndH3 = await ok("/api/prompts/random?k=3&h3=1");
    assert(rndH3.results.every((r) => /h3/i.test(r.model || "")), "the H3 filter applies to random picks " + JSON.stringify(rndH3.results.map((r) => r.model)));
    const a1 = await ok("/api/prompts/random?k=5&seed=7"), a2 = await ok("/api/prompts/random?k=5&seed=7");
    assert(JSON.stringify(a1.results.map((r) => r.id)) === JSON.stringify(a2.results.map((r) => r.id)), "a seed reproduces the same picks");
    const sr3 = await ok("/api/prompts/search?q=" + encodeURIComponent("手工标签 雨夜") + "&k=2"); assert(sr3.results[0]?.id === "h3-rainy-street", "re-embedded after edit");
    const sim = await ok("/api/prompts/item/h3-rainy-street/similar?k=2"); assert(sim.mode === "vector" && sim.results.length === 2 && !sim.results.some((x) => x.id === "h3-rainy-street") && typeof sim.results[0].score === "number", "similar prompts by stored vector " + JSON.stringify(sim.results.map((x) => x.id)));


    }
    if (!args.base) {
      step("direct upload: browser → GPU asset service → 13 mirrors it back");
      const d0 = await ok("/api/direct"); assert(d0.available && d0.base.includes(String(assetsPort)), "direct endpoint advertised " + JSON.stringify(d0));
      const clip = path.join(dataDir, "direct-clip.mp4");
      execSync(`${JSON.stringify(process.env.FFMPEG || "ffmpeg")} -y -loglevel error -f lavfi -i testsrc2=s=320x240:r=24 -t 2 -c:v libx264 -pix_fmt yuv420p ${JSON.stringify(clip)}`);
      const bytes = await fs.readFile(clip);
      const res = await ok("/api/projects/default/assets/direct", { method: "POST", body: { name: "direct-clip.mp4" } });
      assert(res.asset.id.startsWith("a_") && res.asset.pending && res.token && res.put.includes(res.asset.id), "13 reserved the id and signed a put url " + JSON.stringify(res.asset));
      const put = await fetch(`${res.put}&t=${encodeURIComponent(res.token)}`, { method: "PUT", body: bytes });
      assert(put.status === 200, "browser PUT straight to the GPU " + put.status);
      const badTok = await fetch(`${res.put}&t=${encodeURIComponent(res.token)}x`, { method: "PUT", body: bytes });
      assert(badTok.status === 403, "a tampered token is refused " + badTok.status);
      const done = await ok(`/api/projects/default/assets/${res.asset.id}/direct-done`, { method: "POST", body: {} });
      assert(done.gpu === true && done.local === false && done.width === 320 && done.frames === 48 && done.gpuName === `h3s_${res.asset.id}.mp4`, "13 took the GPU's metadata " + JSON.stringify(done));
      assert(fsSync.existsSync(path.join(assetsDir, "comfy_in", `h3s_${res.asset.id}.mp4`)), "the box linked it into ComfyUI's input dir");
      const red = await fetch(`${base}/api/projects/default/assets/${res.asset.id}/file`, { headers: { cookie }, redirect: "manual" });
      assert(red.status === 302 && red.headers.get("location").includes(`/a/${res.asset.id}?t=`), "before the mirror lands, 13 sends the browser to the box " + red.status);
      let mirrored; for (let i = 0; i < 100; i++) { mirrored = (await ok("/api/projects/default")).assets.find((a) => a.id === res.asset.id); if (mirrored?.local) break; await sleep(200); }
      assert(mirrored.local === true && mirrored.gpu === true, "the background mirror pulled it back to 13 " + JSON.stringify(mirrored));
      const local = await fetch(`${base}/api/projects/default/assets/${res.asset.id}/file`, { headers: { cookie }, redirect: "manual" });
      assert(local.status === 200 && Number(local.headers.get("content-length")) === bytes.length, "once mirrored 13 serves the bytes itself " + local.status);
      const thumb = await fetch(`${base}/api/projects/default/assets/${res.asset.id}/thumb`, { headers: { cookie } });
      assert(thumb.status === 200 && (thumb.headers.get("content-type") || "").includes("image"), "poster came down with it");
      // parallel slices: the same bytes, split across several PUTs, assembled on the box
      const big = path.join(dataDir, "parallel.mp4");
      execSync(`${JSON.stringify(process.env.FFMPEG || "ffmpeg")} -y -loglevel error -f lavfi -i testsrc2=s=640x360:r=24 -t 6 -c:v libx264 -b:v 3M -pix_fmt yuv420p ${JSON.stringify(big)}`);
      const parRes = await ok("/api/projects/default/assets/direct", { method: "POST", body: { name: "parallel.mp4" } });
      const { Direct } = await import("../server/src/direct.js");
      const d2 = new Direct({ assetsSecret: "e2e-assets-secret", assetsBase: `http://127.0.0.1:${assetsPort}`, assetsPort, compshare: {} }, {});
      const pr = await d2.uploadParallel(big, parRes.asset.id, "parallel.mp4", { streams: 4, minPartMib: 0.3 });
      assert(pr.streams > 1 && pr.parallel === pr.streams && pr.size > 0, "the box assembled the slices " + JSON.stringify({ streams: pr.streams, parallel: pr.parallel, size: pr.size }));
      const bigBytes = await fs.readFile(big);
      assert(pr.uploaded === bigBytes.length, `every byte arrived (${pr.uploaded} vs ${bigBytes.length})`);
      const done2 = await ok(`/api/projects/default/assets/${parRes.asset.id}/direct-done`, { method: "POST", body: {} });
      assert(done2.gpu === true && done2.width === 640, "a parallel upload registers like any other " + JSON.stringify({ w: done2.width }));
      await ok(`/api/projects/default/assets/${parRes.asset.id}`, { method: "DELETE" });
      await ok(`/api/projects/default/assets/${res.asset.id}`, { method: "DELETE" });
      // a reservation whose bytes never arrive must not linger as a 0-byte placeholder
      const stuck = await ok("/api/projects/default/assets/direct", { method: "POST", body: { name: "never-sent.mp4" } });
      assert(stuck.asset.pending === true, "reservation starts pending");
      const swept = await ok("/api/projects/default/sweep-pending", { method: "POST", body: { olderThanS: 0 } });
      assert(swept.removed === 1 && !(await ok("/api/projects/default")).assets.some((a) => a.id === stuck.asset.id), "stale reservations are swept " + JSON.stringify(swept));
    }
    if (!args.base) {
      step("gpu utilisation summary for this power-on session");
      await ok("/api/_mock/gpuctl", { method: "POST", body: { util: 70 } });
      await ok("/api/gpu/probe", { method: "POST" }); await sleep(1100); await ok("/api/gpu/probe", { method: "POST" });
      const gs = (await ok("/api/gpu")).stats;
      assert(gs && gs.samples >= 2 && gs.utilMax === 70 && gs.utilAvg > 0 && gs.vramMaxMib > 0, "utilisation is aggregated across probes " + JSON.stringify(gs && { n: gs.samples, avg: gs.utilAvg, max: gs.utilMax }));
      assert(gs.series.length >= 2 && typeof gs.series.at(-1).powerW === "number", "the series carries util / vram / power per sample");
      assert(gs.busySeconds >= 1 && gs.energyWh > 0, `busy time and energy accumulate (${gs.busySeconds}s, ${gs.energyWh}Wh)`);
      await ok("/api/_mock/gpuctl", { method: "POST", body: { util: 0 } });
    }
    if (!args.base) {
      step("a finished job records where its time went and what the card was doing");
      const anyDone = (await ok("/api/jobs?limit=20")).find((x) => x.status === "done" && x.timeline);
      assert(anyDone, "a completed job carries a timeline");
      const stages = anyDone.timeline.filter((t) => t.seconds != null);
      assert(stages.length >= 2 && stages.every((t) => typeof t.stage === "string"), "stages are timed " + JSON.stringify(stages.map((t) => `${t.stage}:${t.seconds}s`)));
      assert(anyDone.gpuAtStages && Object.keys(anyDone.gpuAtStages).length > 0, "each transition captured a GPU reading " + JSON.stringify(anyDone.gpuAtStages));
    }
    if (!args.base) {
      step("13 and the box agree on which assets exist");
      const cmp = await ok("/api/assets/sync");
      assert(cmp.available === true && typeof cmp.here === "number" && Array.isArray(cmp.missingOnBox), "the two sides can be compared " + JSON.stringify({ here: cmp.here, box: cmp.onBox }));
      const before = cmp.missingOnBox.length;
      // deleting here must delete there, or the two drift apart every time something is tidied up
      const tmpA = await ok("/api/projects/default/assets/direct", { method: "POST", body: { name: "drift.mp4" } });
      await fetch(`${tmpA.put}&t=${encodeURIComponent(tmpA.token)}`, { method: "PUT", body: await fs.readFile(path.join(dataDir, "direct-clip.mp4")) });
      await ok(`/api/projects/default/assets/${tmpA.asset.id}/direct-done`, { method: "POST", body: {} });
      await ok(`/api/projects/default/assets/${tmpA.asset.id}`, { method: "DELETE" });
      const afterDel = await ok("/api/assets/sync");
      assert(!afterDel.missingHere.some((m) => m.id === tmpA.asset.id), "deleting on 13 removes it from the box too " + JSON.stringify(afterDel.missingHere.map((m) => m.id)));
      const synced = await ok("/api/assets/sync", { method: "POST", body: { pull: false, limit: 3 } });
      assert(Array.isArray(synced.pushed) && synced.failed.length === 0, "pushing what the box lacks works " + JSON.stringify({ pushed: synced.pushed.length, failed: synced.failed }));
      const after = await ok("/api/assets/sync");
      assert(after.missingOnBox.length <= Math.max(0, before - synced.pushed.length), `the gap closed (${before} → ${after.missingOnBox.length})`);
    }
    if (!args.base) {
      step("reference pre-flight catches the ways a reference stops steering the result");
      const badPrompt = "<Subject 1> is the news anchor. Her face and identity come from <Picture 1>: a young adult woman with a neat professional appearance.\n<Subject 2> is the CCTV-style news studio in <Picture 1>: a blue newsroom screen.";
      const adv = (await ok("/api/jobs/advice", { method: "POST", body: { projectId: "default", prompt: badPrompt, images: ["a_none"], width: 832, height: 448 } })).advice;
      assert(adv.some((a) => /同时被用来定义人物和场景/.test(a.text)), "one picture doing two jobs is flagged " + JSON.stringify(adv.map((a) => a.text)));
      const unused = (await ok("/api/jobs/advice", { method: "POST", body: { projectId: "default", prompt: "整段没有占位符", images: ["a_x", "a_y"], width: 832, height: 448 } })).advice;
      assert(unused.filter((a) => /没被提到/.test(a.text)).length === 2, "attached but unmentioned images are flagged " + JSON.stringify(unused.map((a) => a.text)));
      const missing = (await ok("/api/jobs/advice", { method: "POST", body: { projectId: "default", prompt: "看 <Picture 3>", images: ["a_x"], width: 832, height: 448 } })).advice;
      assert(missing.some((a) => a.level === "error"), "referring to a picture that was not attached is an error " + JSON.stringify(missing));
      const clean = (await ok("/api/jobs/advice", { method: "POST", body: { projectId: "default", prompt: "<Subject 1> is a person from <Picture 1> walking.", images: ["a_x"], width: 832, height: 448 } })).advice;
      assert(clean.length === 0, "a well-formed reference prompt raises nothing " + JSON.stringify(clean));
    }
    step("gpu snapshot + cost ledger");
    const g = await ok("/api/gpu"); assert(g.state === "on" && g.cost && typeof g.cost.todayCny === "number", "gpu on with cost " + JSON.stringify(g.cost));
    const us = await ok("/api/gpu/usage?days=7"); assert(us.length === 7 && us.at(-1).seconds > 0 && typeof us.at(-1).cny === "number", "usage by day " + JSON.stringify(us.at(-1)));
    if (!args.base) { const s2 = await ok("/api/gpu/settings", { method: "PATCH", body: { idleMinutes: 3, autoOff: false } }); assert(s2.idleMinutes === 3 && s2.autoOff === false, "settings patch"); }
    if (!args.base) {
      step("idle rule respects GPU-side activity (one-shot programs / foreign GPU procs / utilisation)");
      const { gpuActivity } = await import("../server/src/power.js");
      assert(gpuActivity({ programs: { comfyui: "RUNNING", llm: "RUNNING", jupyterlab: "RUNNING", filebrowser: "RUNNING" }, procs: [{ cmd: "python3 ComfyUI/main.py" }, { cmd: "/root/llama.cpp/build/bin/llama-server" }], vram: { util: 0 } }).busy === false, "managed programs/procs are not activity");
      const act = gpuActivity({ programs: { comfyui: "RUNNING", voicetest: "RUNNING" }, procs: [{ cmd: "python3 /root/train.py" }], vram: { util: 42 } });
      assert(act.busy && act.oneshots.join() === "voicetest" && act.foreignProcs === 1 && act.util === 42 && act.why.length === 3, "one-shot / foreign proc / util counted " + JSON.stringify(act));
      await ok("/api/_mock/gpuctl", { method: "POST", body: { programs: { voicetest: "RUNNING" } } });
      const gp = await ok("/api/gpu/probe", { method: "POST" }); assert(gp.activity?.busy && gp.idleSince == null && gp.activity.why[0].includes("voicetest"), "probe sees the one-shot job and holds the idle timer " + JSON.stringify(gp.activity));
      const stopR = await call("/api/gpu/stop", { method: "POST", body: {} }); assert(stopR.status >= 400 && String(stopR.body.error).includes("voicetest"), "manual stop refused while the box is busy " + stopR.status + " " + JSON.stringify(stopR.body));
      await ok("/api/_mock/gpuctl", { method: "POST", body: { programs: { voicetest: "EXITED" }, util: 60 } });
      const gp2 = await ok("/api/gpu/probe", { method: "POST" }); assert(gp2.activity?.busy && gp2.activity.why.some((w) => w.includes("利用率")), "sustained utilisation holds the idle timer " + JSON.stringify(gp2.activity));
      await ok("/api/_mock/gpuctl", { method: "POST", body: { util: 0, net: { rx: 50_000_000, tx: 0 } } });
      await ok("/api/gpu/probe", { method: "POST" });   // first sample of the byte counters
      await ok("/api/_mock/gpuctl", { method: "POST", body: { net: { rx: 60_000_000, tx: 0 } } });
      const gpn = await ok("/api/gpu/probe", { method: "POST" }); assert(gpn.activity?.busy && gpn.activity.why.some((w) => w.includes("网络在传数据")), "bytes moving over the tunnel hold the idle timer (an upload in flight) " + JSON.stringify(gpn.activity));
      await ok("/api/_mock/gpuctl", { method: "POST", body: { util: 0 } });
      await ok("/api/gpu/probe", { method: "POST" });
      const gp3 = await ok("/api/gpu/probe", { method: "POST" }); assert(!gp3.activity?.busy, "quiet box → no GPU-side hold (the idle timer itself starts 60 s after the last model use) " + JSON.stringify(gp3.activity));
    }
    if (!args.base) {
      step("model manager (mock gpuctl): catalogue → chat task loads llm → /llm proxy → video job evicts llm → unload all → test flow");
      const cat0 = await ok("/api/models");
      const q4 = cat0.models.find((m) => m.id === "qwen3.8-27b-q4");
      assert(q4.params === "27B" && q4.ctx === 262144 && q4.vramAt?.measured && q4.vramAt.kvMib > 4000 && q4.vramAt.totalMib > q4.vramAt.weightsMib,
        "llm entries carry参数 / 上下文 / 按上下文算的显存 " + JSON.stringify({ p: q4.params, ctx: q4.ctx, v: q4.vramAt }));
      const koko = cat0.models.find((m) => m.id === "kokoro");
      assert(koko.params === "82M" && koko.vramAt.totalMib > 0, "voice entries carry参数与显存 " + JSON.stringify({ p: koko.params, v: koko.vramAt }));
      const patched = await ok("/api/models/qwen3.8-27b-q4", { method: "PATCH", body: { args: ["-c", "32768", "-ngl", "999", "--cache-type-k", "q4_0", "--cache-type-v", "q4_0", "-fa", "on", "--jinja"] } });
      const after = (await ok("/api/models")).models.find((m) => m.id === "qwen3.8-27b-q4");
      assert(after.ctx === 32768 && after.vramAt.kvMib < q4.vramAt.kvMib, "changing the context moves the estimate " + JSON.stringify(after.vramAt));
      await ok("/api/models/qwen3.8-27b-q4", { method: "PATCH", body: { args: q4.args } });
      const ms0 = await ok("/api/models"); assert(ms0.available && ms0.models.some((m) => m.id === "qwen3.8-27b-q4" && m.tested) && ms0.tasks.chat && !ms0.loaded.llm, "catalogue served, nothing loaded");
      assert((await call("/api/models/nope/load", { method: "POST" })).status === 400 && (await call("/api/models/qwen3-32b-q4/load", { method: "POST" })).status === 400, "unknown / untested models are refused");
      const lm = await fetch(`${base}/llm/v1/models`, { headers: { cookie } }); assert(lm.status === 200 && (await lm.json()).data.some((m) => m.id === "qwen3.8-27b-q4"), "/llm/v1/models lists without loading");
      assert((await fetch(`${base}/llm/v1/models`)).status === 401, "/llm requires auth");
      const en = await ok("/api/models/ensure", { method: "POST", body: { modality: "llm" } }); assert(en.ok && en.modelId === "qwen3.8-27b-q4", "ensure by capability picks the default model " + JSON.stringify(en));
      assert((await call("/api/models/ensure", { method: "POST", body: { modality: "nope" } })).status === 400, "ensure rejects unknown capability");
      let ms1; for (let i = 0; i < 100; i++) { ms1 = await ok("/api/models"); if (ms1.loaded.llm?.modelId === "qwen3.8-27b-q4" && !ms1.busy) break; await sleep(100); }
      assert(ms1.loaded.llm?.modelId === "qwen3.8-27b-q4" && ms1.gpu.programs.llm === "RUNNING" && ms1.gpu.vram.used > 15000, "chat task loaded the default llm " + JSON.stringify({ loaded: ms1.loaded, vram: ms1.gpu?.vram }));
      const cc = await fetch(`${base}/llm/v1/chat/completions`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ model: "qwen3.8-27b-q4", messages: [{ role: "user", content: "hi" }] }) });
      const ccj = await cc.json(); assert(cc.status === 200 && ccj.choices?.[0]?.message?.content, "/llm proxied a chat completion " + JSON.stringify(ccj).slice(0, 120));
      // From a browser session an unloaded model is an error the user can act on; only agents get an implicit load.
      const vtCold = await fetch(`${base}/voice/tts`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "你好", voice: "sample:voice_05" }) });
      const vtColdJ = await vtCold.json();
      assert(vtCold.status === 409 && vtColdJ.error?.type === "not_loaded", "a browser call does not silently load the voice model " + vtCold.status);
      const vcat = await ok("/api/voice/catalog");
      assert(vcat.loaded === false && vcat.engines.some((e) => e.id === "indextts-2" && e.vram > 0), "the voice page still gets its catalogue with nothing loaded " + JSON.stringify(vcat.engines.map((e) => e.id)));
      const agentKey = (await ok("/api/keys", { method: "POST", body: { label: "e2e-loadpolicy" } })).key;
      const vkey = await fetch(`${base}/voice/tts`, { method: "POST", headers: { authorization: `Bearer ${agentKey}`, "content-type": "application/json" }, body: JSON.stringify({ text: "你好", voice: "sample:voice_05" }) });
      assert(vkey.status === 200, "an API key call loads it on demand " + vkey.status);
      const vt = await fetch(`${base}/voice/tts`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "你好", voice: "sample:voice_05", emotion: "开心" }) });
      const ms1b = await ok("/api/models"); assert(vt.status === 200 && vt.headers.get("content-type").startsWith("audio/") && ms1b.loaded.voice?.modelId === "indextts-2" && ms1b.loaded.llm?.modelId === "qwen3.8-27b-q4" && ms1b.gpu.programs.voice === "RUNNING", "/voice/tts loads the voice runner next to the llm and streams audio " + JSON.stringify(ms1b.loaded) + " " + vt.status);
      const sv = await fetch(`${base}/voice/voices`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "e2e 音色", ref_path: "/tmp/ref.wav" }) }); const svj = await sv.json();
      assert(sv.status === 200 && svj.id.startsWith("v_") && svj.refText, "save a voice through the proxy " + JSON.stringify(svj));
      const vl = await (await fetch(`${base}/voice/voices`, { headers: { cookie } })).json(); assert(vl.saved.some((v) => v.id === svj.id) && vl.samples.length && vl.builtin.kokoro, "voices listed (saved + samples + builtin)");
      const sp = await fetch(`${base}/llm/v1/audio/speech`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ model: "indextts-2", input: "OpenAI 兼容的语音接口", voice: svj.id }) });
      assert(sp.status === 200 && sp.headers.get("content-type").startsWith("audio/") && sp.headers.get("x-model") === "indextts-2", "/llm/v1/audio/speech routes to the voice service " + sp.status);
      const lm2 = await (await fetch(`${base}/llm/v1/models`, { headers: { cookie } })).json(); assert(lm2.data.some((m) => m.id === "indextts-2" && m.type === "tts") && lm2.data.some((m) => m.id === "kokoro" && m.voices?.length) && lm2.voices.some((v) => v.id === svj.id), "/llm/v1/models lists tts engines + saved voices");
      assert((await fetch(`${base}/voice/voices/${svj.id}`, { method: "DELETE", headers: { cookie } })).status === 200, "delete saved voice");
      const jv = await ok("/api/jobs", { method: "POST", body: { projectId: p.id, title: "evicts llm", workflow: "native_t2v", prompt: "p", width: 640, height: 384, seconds: 2 } }); await waitJob(jv.id);
      const ms2 = await ok("/api/models"); assert(!ms2.loaded.llm && ms2.gpu.programs.llm === "STOPPED" && !ms2.loaded.voice && ms2.gpu.programs.voice === "STOPPED" && ms2.loaded.video, "video job evicted llm + voice " + JSON.stringify(ms2.loaded));
      const gs = await ok("/api/gpu"); assert(gs.comfyUp === true && gs.models && gs.models.vram, "gpu snapshot carries model state");
      const tr = await ok("/api/models/qwen3-32b-q4/test", { method: "POST" }); assert(tr.modelId === "qwen3-32b-q4" && tr.smoke?.text, "test flow loads + smoke " + JSON.stringify(tr).slice(0, 160));
      assert(tr.ok === true && tr.report?.steps?.length >= 3 && tr.report.steps.every((s) => s.ok) && tr.report.steps.some((s) => s.tps != null || s.text), "test report has steps " + JSON.stringify(tr.report?.steps?.map((s) => [s.name, s.ok])));
      const mm = (await ok("/api/models")).models.find((m) => m.id === "qwen3-32b-q4"); assert(mm.tested === true && mm.lastReport?.ok === true, "tested flag + report persisted");
      assert((await call("/api/models/default", { method: "POST", body: { modality: "llm", modelId: "indextts-2" } })).status === 400, "default must match modality");
      const dd = await ok("/api/models/default", { method: "POST", body: { modality: "llm", modelId: "qwen3-32b-q4" } }); assert(dd.llm === "qwen3-32b-q4", "default llm set " + JSON.stringify(dd));
      const ep2 = await ok("/api/endpoints"); assert(ep2.llmModel === "qwen3-32b-q4" && ep2.models.llm.find((m) => m.id === "qwen3-32b-q4").default === true && ep2.models.llm.some((m) => m.loaded), "endpoints reflect default + loaded " + JSON.stringify(ep2.models.llm.map((m) => [m.id, m.default, m.loaded])));
      await ok("/api/models/default", { method: "POST", body: { modality: "llm", modelId: "qwen3.8-27b-q4" } });
      const ms3 = await ok("/api/models/unload", { method: "POST", body: { modality: "all" } }); assert(!ms3.loaded.llm && ms3.gpu.programs.llm === "STOPPED", "unload all");
      await ok(`/api/jobs/${jv.id}`, { method: "DELETE" });
      step("storage overview → dry-run plan → clean (failed jobs, old unreferenced outputs, orphan derived assets); rerun; audit");
      const ov = await ok("/api/storage"); assert(ov.jobs.count > 0 && ov.jobs.bytes > 0 && ov.assets.count > 0 && ov.disk && ov.disk.free > 0, "storage overview " + JSON.stringify({ jobs: ov.jobs, disk: !!ov.disk }));
      const rr = await ok(`/api/jobs/${j1.id}/rerun`, { method: "POST", body: {} }); assert(rr.seed === j1.seed && rr.prompt === j1.prompt && rr.title.endsWith("重跑"), "rerun keeps seed/prompt");
      await ok(`/api/jobs/${rr.id}/cancel`, { method: "POST" });
      const plan = await ok("/api/storage/plan", { method: "POST", body: { oldJobsDays: 0, failedJobs: true, orphanAssets: true } });
      assert(plan.jobs.some((x) => x.id === rr.id && x.reason === "failed") && plan.jobs.some((x) => x.id === j1.id && x.reason === "old") && !plan.jobs.some((x) => x.id === g1b.id) && plan.assets.some((x) => x.id === fa.id && x.reason === "derived") && plan.totalBytes > 0, "plan lists failed + old-unreferenced jobs and derived orphan asset, keeps picked takes: " + JSON.stringify({ jobs: plan.jobs.map((x) => [x.id, x.reason]), assets: plan.assets.map((x) => x.id) }));
      assert((await call("/api/storage/clean", { method: "POST", body: { failedJobs: true } })).status === 400, "clean requires confirm");
      const cl = await ok("/api/storage/clean", { method: "POST", body: { oldJobsDays: 0, failedJobs: true, orphanAssets: true, confirm: true } });
      assert(cl.removedJobs >= 2 && cl.removedAssets >= 1 && (await call(`/api/jobs/${j1.id}`)).status === 404 && (await ok(`/api/jobs/${g1b.id}`)).status === "done", "clean removed planned items only");
      const us = await ok(`/api/projects/${p.id}/usage`); assert(us.referenced.includes(a1.id) && !us.unreferenced.includes(a1.id), "usage: referenced asset");
      const jx = await ok("/api/jobs", { method: "POST", body: { projectId: p.id, title: "batch-del", workflow: "native_t2v", prompt: "p", width: 640, height: 384, seconds: 2 } }); await waitJob(jx.id);
      const jy = await ok("/api/jobs", { method: "POST", body: { projectId: p.id, title: "batch-keep-active", workflow: "native_t2v", prompt: "p", width: 640, height: 384, seconds: 5 } });
      const bd = await ok("/api/jobs/batch-delete", { method: "POST", body: { ids: [jx.id, jy.id, "j_nope"] } }); assert(bd.removed === 1 && bd.skipped === 2 && (await call(`/api/jobs/${jx.id}`)).status === 404 && (await ok(`/api/jobs/${jy.id}`)).id === jy.id, "batch delete skips active + unknown " + JSON.stringify(bd));
      await ok(`/api/jobs/${jy.id}/cancel`, { method: "POST" }); await ok(`/api/jobs/${jy.id}`, { method: "DELETE" });
      await ok("/api/library", { method: "POST", body: { name: "导出用", text: "integrated_multimodal_description: export me\n\noverall_soundscape: x\n\nnon_diegetic_music: N/A", tags: "x" } });
      const ex = await ok("/api/library/export"); assert(Array.isArray(ex) && ex.length >= 1 && ex[0].text && !("vec" in ex[0]), "library export");
      const im = await ok("/api/library/import", { method: "POST", body: [...ex, { name: "导入的", text: "integrated_multimodal_description: imported\n\noverall_soundscape: x\n\nnon_diegetic_music: N/A", tags: "a, b" }] }); assert(im.added === 1 && im.skipped === ex.length, "import dedupes " + JSON.stringify(im));
      assert((await ok("/api/library?q=导入的")).some((x) => x.name === "导入的" && x.tags.join() === "a,b"), "imported item searchable");
      const au = await ok("/api/audit?limit=500"); assert(Array.isArray(au) && au.length > 0 && au[0].at && au.some((x) => x.action === "passkey.enrollment.approved"), "audit rows");
    }
  }

  step("API keys: create → bearer access → docs public → revoke → 401");
  const docs = await fetch(`${base}/api/v1/docs`); assert(docs.status === 200 && /Atelier 外部 API/.test(await docs.text()), "docs public");
  const oas = await (await fetch(`${base}/api/v1/openapi.json`)).json(); assert(oas.openapi === "3.0.3" && oas.paths["/api/jobs"]?.post && oas.servers[0].url.endsWith(args.path || ""), "openapi spec");
  const nk = await ok("/api/keys", { method: "POST", body: { label: "e2e-agent" } }); assert(nk.key.startsWith("atl_") && nk.id.startsWith("k_") && nk.revealable, "key created");
  const rvk = await ok(`/api/keys/${nk.id}/reveal`); assert(rvk.key === nk.key && (await ok("/api/keys")).find((k) => k.id === nk.id).revealable === true, "key can be shown again");
  const ep = await ok("/api/endpoints"); assert(ep.llm.endsWith("/llm/v1") && ep.api.endsWith("/api") && ep.docs.endsWith("/api/v1/docs") && ep.voice.endsWith("/voice") && ep.app.startsWith(base), "endpoints " + JSON.stringify(ep));
  const bearer = async (p, o = {}) => { const r = await fetch(base + p, { method: o.method || "GET", headers: { authorization: `Bearer ${nk.key}`, ...(o.body ? { "content-type": "application/json" } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const g1 = await bearer("/api/gpu"); assert(g1.status === 200 && typeof g1.body.state === "string", "bearer reaches /api/gpu");
  const meb = await bearer("/api/me"); assert(meb.body.kind === "apikey" && meb.body.label === "e2e-agent", "bearer identity");
  assert((await bearer("/api/keys", { method: "POST", body: { label: "nested" } })).status === 403, "keys cannot mint keys");
  await sleep(200); const kl = await ok("/api/keys"); assert(kl.some((k) => k.id === nk.id && k.lastUsedAt), "lastUsed recorded " + JSON.stringify(kl));
  assert((await fetch(base + "/api/gpu", { headers: { authorization: "Bearer h3s_bogus" } })).status === 401, "bogus key 401");
  await ok(`/api/keys/${nk.id}`, { method: "DELETE" });
  assert((await bearer("/api/gpu")).status === 401, "revoked key 401");

  step("logout + revoke");
  await ok("/auth/logout", { method: "POST" });
  assert((await call("/api/me")).status === 401, "logged out");
  console.log("\n✅ E2E passed");
} catch (e) {
  console.error("\n❌ E2E failed:", e.stack || e); process.exitCode = 1;
} finally {
  if (server) { server.kill("SIGTERM"); await sleep(300); }
  if (assetsSrv) assetsSrv.kill("SIGTERM");
  if (mock) await mock.close();
  if (typeof mockOP !== "undefined" && mockOP) await mockOP.close(); if (typeof mockAI !== "undefined" && mockAI) await mockAI.close();
  if (dataDir && !args.keep) await fs.rm(dataDir, { recursive: true, force: true }); else if (dataDir) console.log("data kept at", dataDir);
  process.exit(process.exitCode || 0);
}
