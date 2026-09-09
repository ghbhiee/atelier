// Browser end-to-end: drives a real headless Chrome over the DevTools protocol (no npm dependencies —
// Node 22 ships a WebSocket client, and Chrome is already on the machine).
//
//   node test/browser.mjs                 → boots test/dev.mjs, walks every page, checks for JS errors
//   node test/browser.mjs --headed        → same, with a visible window
//   node test/browser.mjs --base https://atelier.example.com --path /gpu --cookie "atl_session=…"
//
// What it asserts: every route renders without an uncaught error or console error, the pages that must
// work while the GPU is off do work, and a real file upload goes through the upload box end to end.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.length ? v.join("=") : true]; }));
const CHROME = args.chrome || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, checks = 0;
let cdpRef = null;
const waitFor = async (expr, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cdpRef.eval(expr).catch(() => false)) return true; await sleep(200); } return false; };
const step = (t) => console.log(`\n▶ ${t}`);
const ok = (cond, what) => { checks++; if (cond) console.log(`  ✓ ${what}`); else { fails++; console.log(`  ✗ ${what}`); } };

// ---- tiny CDP client ---------------------------------------------------------------------------
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.handlers = []; ws.onmessage = (e) => this.onMessage(JSON.parse(e.data)); }
  static async attach(port) {
    for (let i = 0; i < 100; i++) {
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
        const page = list.find((t) => t.type === "page");
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
          return new Cdp(ws);
        }
      } catch { /* chrome still starting */ }
      await sleep(100);
    }
    throw new Error("could not attach to Chrome");
  }
  onMessage(m) {
    if (m.id && this.waiting.has(m.id)) { const { res, rej } = this.waiting.get(m.id); this.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) for (const h of this.handlers) h(m);
  }
  on(fn) { this.handlers.push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.waiting.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
    return r.result.value;
  }
  async goto(url) {
    await this.send("Page.navigate", { url });
    for (let i = 0; i < 100; i++) { if (await this.eval("document.readyState === 'complete'").catch(() => false)) break; await sleep(100); }
  }
}

let devServer, chrome, profileDir;
try {
  // ---- target: a local dev server unless --base points at production -------------------------
  let base = args.base ? args.base.replace(/\/$/, "") + (args.path || "") : null, cookie = args.cookie || "";
  if (!base) {
    step("boot the dev server (mock ComfyUI + mock AI + mock gpuctl)");
    devServer = spawn(process.execPath, [path.join(root, "test/dev.mjs")], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    devServer.stdout.on("data", (d) => { out += d; if (args.verbose) process.stdout.write(`  [dev] ${d}`); });
    devServer.stderr.on("data", (d) => { out += d; if (args.verbose) process.stdout.write(`  [dev] ${d}`); });
    for (let i = 0; i < 200; i++) { try { if ((await fetch("http://127.0.0.1:18790/healthz")).ok) break; } catch {} await sleep(150); }
    base = "http://127.0.0.1:18790";
    ok(true, "dev server up on " + base);
  }

  step("launch headless Chrome");
  profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "atl-chrome-"));
  const port = 9300 + Math.floor(Math.random() * 400);
  chrome = spawn(CHROME, [
    args.headed ? "--new-window" : "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-features=Translate,MediaRouter", "--window-size=1440,900", "about:blank",
  ], { stdio: "ignore" });
  const cdp = await Cdp.attach(port);
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Log.enable"); await cdp.send("Network.enable");
  ok(true, "attached to Chrome");

  // collect everything that looks like a failure
  const problems = [];
  const note = (kind, text) => { if (text && !/favicon|ERR_ABORTED/.test(text)) problems.push(`${kind}: ${String(text).slice(0, 200)}`); };
  cdp.on((m) => {
    if (m.method === "Runtime.exceptionThrown") note("exception", m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") note("console.error", m.params.args?.map((a) => a.value || a.description).join(" "));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") note("log", m.params.entry.text);
  });

  cdpRef = cdp;
  step("log in");
  if (cookie) {
    const u = new URL(base);
    const [name, ...rest] = cookie.split("=");
    await cdp.send("Network.setCookie", { name, value: rest.join("="), domain: u.hostname, path: "/", secure: u.protocol === "https:" });
    await cdp.goto(base + "/");
  } else {
    await cdp.goto(base + "/dev-login?token=dev");
  }
  await sleep(1500);
  ok(await cdp.eval("!!document.querySelector('nav a')"), "workbench rendered with a nav");

  step("walk every page and watch for errors");
  const pages = ["/", "/generate", "/projects", "/whitemodel", "/prompts", "/jobs", "/chat", "/voice", "/models", "/access", "/settings",
                 "/project/default/clips", "/project/default/masters", "/project/default/edits", "/project/default/avatars", "/project/default/settings",
                 "/project/default/assets", "/project/default/renders"];
  for (const p of pages) {
    const before = problems.length;
    await cdp.eval(`location.hash = ${JSON.stringify("#" + p)}`);
    await sleep(900);
    const body = await cdp.eval("document.querySelector('main')?.innerText?.slice(0, 400) || ''");
    const errBox = await cdp.eval("!!document.querySelector('main .err, main .error')");
    const news = problems.slice(before);
    ok(!errBox && news.length === 0 && body.length > 0, `${p}${errBox ? "  ← 页面显示错误框" : ""}${news.length ? "  ← " + news.join(" | ") : ""}${body.length === 0 ? "  ← 空页面" : ""}`);
  }

  step("model manager shows what each model costs and lets the context be changed");
  await cdp.eval(`location.hash = '#/models'`);
  await sleep(1500);
  const mm = JSON.parse(await cdp.eval(`JSON.stringify({
    errBox: !!document.querySelector('main .errbox'),
    caps: document.querySelectorAll('.cap').length,
    spec: (document.querySelector('.cap')?.innerText || '').split(String.fromCharCode(10)).join(' ').slice(0, 200),
    ctxSelect: [...document.querySelectorAll('.cap select')].some(sel => [...sel.options].some(o => /k（最大）|^[0-9]+k$/.test(o.textContent))),
    headers: [...document.querySelectorAll('main table th')].map(t => t.textContent),
  })`));
  ok(!mm.errBox, "the model manager renders (no error box)");
  ok(mm.caps >= 4, `capability cards are there (${mm.caps})`);
  ok(/参数|权重|显存/.test(mm.spec), "the selected model shows参数 / 权重 / 显存: " + mm.spec.slice(0, 90));
  const ctxAuto = await cdp.eval(`[...document.querySelectorAll('.cap')].map(c => c.innerText).find(t => /上下文/.test(t)) || ''`);
  ok(/自动选/.test(ctxAuto), "the context is chosen from the card in front of us, not typed: " + ctxAuto.replace(/\n/g, " ").slice(0, 120));
  ok(mm.headers.includes("参数") && mm.headers.includes("权重"), "the catalogue table has参数 / 权重 columns: " + mm.headers.join(","));
  const groups = JSON.parse(await cdp.eval(`JSON.stringify({
    titles: [...document.querySelectorAll('main h3')].map(x => x.textContent.trim()),
    defaultSelects: document.querySelectorAll('main select').length,
    tables: document.querySelectorAll('main table').length,
  })`));
  ok(groups.tables >= 3, `the catalogue is split per capability (${groups.tables} tables)`);
  ok(groups.titles.some((t) => /转写/.test(t)), "转写 (ASR) has its own group: " + groups.titles.join(" / "));
  ok(groups.titles.some((t) => /白模/.test(t)), "白模 has its own group");
  ok(/上限/.test(ctxAuto) && /(受显存限制|受模型自身限制)/.test(ctxAuto), "it says what the ceiling is and what caps it");
  ok(/权重 .* \+ KV /.test(ctxAuto), "it breaks the number down into weights + KV cache");
  const ctxApi = JSON.parse(await cdp.eval(`fetch('api/models').then(r => r.json()).then(m => JSON.stringify(m.models.filter(x => x.modality === 'llm').map(x => [x.id, x.ctxAuto, x.ctxMaxUsable])))`));
  ok(ctxApi.every(([, a]) => a > 0), `every llm gets an auto context: ${ctxApi.map(([i, a]) => i + "=" + Math.round(a / 1024) + "k").join(" ")}`);

  step("voice page works with nothing loaded, and previews do not stack");
  // this section is about the "nothing in VRAM" path, so make sure nothing is
  await cdp.eval(`fetch('api/models/unload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"modality":"voice"}' }).then(r => r.status)`);
  await cdp.eval(`location.hash = '#/voice'`);
  await waitFor("!!document.querySelector('.subtab') && document.querySelectorAll('.vitem').length > 0");
  await waitFor("!/（已加载）/.test(document.querySelector('main')?.innerText || '')", 6000);
  await sleep(400);
  const voiceState = await cdp.eval(`JSON.stringify({
    banner: !!document.body.innerText.match(/语音模型没有加载|加载语音模型/),
    engines: document.querySelectorAll('select option').length > 0,
    tiles: document.querySelectorAll('.vitem').length,
    playBtns: [...document.querySelectorAll('.vitem button')].filter(b => b.textContent === '▶').length,
  })`);
  const vs = JSON.parse(voiceState);
  ok(vs.banner, "an unloaded voice model shows the load banner instead of an error: " + (await cdp.eval("document.querySelector('main')?.innerText?.replace(/\\n/g,' | ').slice(0,220) || ''")));
  ok(vs.engines, "the engine picker is populated from the catalogue");
  // IndexTTS-2 is clone-only, so pick an engine that ships characters and check they are listed
  const picked = await cdp.eval(`(() => {
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => /Kokoro|Qwen3-TTS/i.test(o.textContent)));
    if (!sel) return 'no engine select';
    const opt = [...sel.options].find(o => /Kokoro/i.test(o.textContent)) || [...sel.options].find(o => /Qwen3-TTS/i.test(o.textContent));
    sel.value = opt.value; sel.dispatchEvent(new Event('change'));
    return 'ok';
  })()`);
  ok(picked === "ok", "can switch to an engine with built-in characters (" + picked + ")");
  await sleep(600);
  const voices = JSON.parse(await cdp.eval(`JSON.stringify({ tiles: document.querySelectorAll('.vitem').length, chips: document.querySelectorAll('.vitem .chip').length, play: [...document.querySelectorAll('.vitem button')].filter(b => b.textContent === '▶').length })`));
  ok(voices.tiles > 0, `built-in characters are listed with nothing loaded (${voices.tiles} tiles)`);
  ok(voices.chips > 0, `voices carry gender / language markers (${voices.chips} chips)`);
  ok(voices.play === voices.tiles, `every voice can be previewed (${voices.play}/${voices.tiles})`);
  const preview = await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('.vitem button')].find(b => b.textContent === '▶');
    if (!btn) return 'no button';
    let created = 0; const RealAudio = window.Audio;
    window.Audio = function (u) { created++; const a = new RealAudio(u); a.play = () => Promise.resolve(); return a; };
    btn.click(); btn.click(); btn.click();
    window.Audio = RealAudio;
    return JSON.stringify({ created, label: btn.textContent });
  })()`);
  const pv = JSON.parse(preview);
  ok(pv.created <= 2, `clicking preview three times does not stack players (created ${pv.created})`);

  step("the generate page warns before a reference is wasted");
  const pre = JSON.parse(await cdp.eval(`(async () => {
    const r = await fetch('api/jobs/advice', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'default', prompt: '<Subject 1> is a person from <Picture 1>. <Subject 2> is the studio in <Picture 1>.', images: ['a_x'], width: 832, height: 448 }) }).then(x => x.json());
    return JSON.stringify({ n: r.advice.length, texts: r.advice.map(a => a.text) });
  })()`));
  ok(pre.n > 0 && pre.texts.some((t) => t.includes("人物和场景")), "the page can ask for pre-flight advice: " + (pre.texts || []).join(" / "));

  step("white model offers a person-only mode");
  await cdp.eval(`location.hash = '#/whitemodel'`); await sleep(1200);
  const wm = JSON.parse(await cdp.eval(`(() => {
    const labels = [...document.querySelectorAll('main label')].map(l => l.textContent);
    const cb = [...document.querySelectorAll('main input[type=checkbox]')].find(c => (c.parentElement.textContent || '').includes('只把人物'));
    const range = document.querySelector('main input.subject-thr');
    const before = range ? range.disabled : null;
    if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
    return JSON.stringify({ found: !!cb, rangeWasDisabled: before, rangeNow: range ? range.disabled : null, labels: labels.filter(t => t.includes('人物')) });
  })()`));
  ok(wm.found, "the person-only toggle is on the page");
  ok(wm.rangeWasDisabled === true && wm.rangeNow === false, "its threshold slider unlocks when it is switched on");

  step("chat shows speed and folds the thinking away");
  await cdp.eval(`location.hash = '#/chat'`); await sleep(1200);
  // the browser no longer gets an implicit load, so put the model in VRAM the way a user would
  await cdp.eval(`fetch('api/models/ensure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"modality":"llm"}' }).then(r => r.status)`);
  for (let i = 0; i < 40; i++) { const l = await cdp.eval(`fetch('api/models').then(r => r.json()).then(m => m.loaded.llm ? 'yes' : 'no')`); if (l === "yes") break; await sleep(400); }
  const chat = await cdp.eval(`(async () => {
    const ta = document.querySelector('main textarea'); if (!ta) return 'no textarea';
    ta.value = '你好'; ta.dispatchEvent(new Event('input'));
    const btn = [...document.querySelectorAll('main button')].find(b => b.textContent.includes('发送') || b.textContent.includes('问'));
    if (!btn) return 'no send button';
    btn.click();
    for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 300)); if (document.querySelector('main .think')) break; }
    const think = document.querySelector('main .think');
    const meter = [...document.querySelectorAll('main .meter, main .muted.small')].map(e => e.textContent).find(t => t.includes('tok/s') || t.includes('首字'));
    return JSON.stringify({ think: !!think, thinkHidden: think ? think.hidden : null, thinkText: think ? think.textContent.slice(0, 40) : '', meter: meter || '' });
  })()`);
  const c = (() => { try { return JSON.parse(chat); } catch { return { err: chat }; } })();
  ok(c.think && !c.thinkHidden, "the reasoning is captured and shown as a foldable block: " + (c.thinkText || c.err || ""));
  ok(String(c.meter || "").includes("tok/s") || String(c.meter || "").includes("首字"), "speed is reported: " + (c.meter || "(none)"));

  step("a finished job shows where its time went");
  await cdp.eval(`location.hash = '#/jobs'`); await sleep(1500);
  // make a fresh one: jobs from earlier runs predate the timeline
  const made = await cdp.eval(`(async () => {
    const j = await fetch('api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'default', workflow: 'native_t2v', prompt: 'integrated_multimodal_description: [Shot 1] a still teapot.', width: 640, height: 384, seconds: 2, title: 'browser-e2e 计时' }) }).then(r => r.json());
    for (let i = 0; i < 120; i++) {
      const s = await fetch('api/jobs/' + j.id).then(r => r.json());
      if (['done', 'error', 'cancelled'].includes(s.status)) return s.status === 'done' ? j.id : 'job ' + s.status;
      await new Promise(r => setTimeout(r, 500));
    }
    return 'timeout';
  })()`);
  await cdp.eval(`location.hash = '#/jobs'`); await sleep(1200);
  const opened = await cdp.eval(`(() => {
    const card = [...document.querySelectorAll('.job')].find(c => c.textContent.includes('browser-e2e 计时'));
    if (!card) return 'no finished job';
    card.click(); return 'clicked';
  })()`);
  ok(String(made).startsWith("j_"), "a job ran to completion for the timing check (" + made + ")");
  await sleep(1200);
  if (opened === "clicked") {
    const detail = JSON.parse(await cdp.eval(`(() => {
      const sums = [...document.querySelectorAll('.modal summary')].map(s => s.textContent);
      const t = sums.find(x => x.includes('耗时分解'));
      if (t) [...document.querySelectorAll('.modal details')].forEach(d => d.open = true);
      return JSON.stringify({ has: !!t, text: t || sums.join(' | '), rows: document.querySelectorAll('.modal table tr').length });
    })()`));
    ok(detail.has, "the detail offers a stage breakdown: " + String(detail.text).slice(0, 80));
    ok(detail.rows >= 2, `the breakdown lists stages (${detail.rows} rows)`);
    await cdp.eval(`document.querySelector('.modal .x, .modal-f button')?.click(); document.querySelector('#modal-root').innerHTML='';`);
  } else ok(false, "could not open a finished job: " + opened);

  step("a Chinese script on an English voice is caught before it is spoken as gibberish");
  // the voice list has to be the live one here (an English Kokoro voice must be on screen), so load first
  await cdp.eval(`fetch('api/models/ensure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"modality":"voice","modelId":"kokoro"}' }).then(r => r.status)`);
  for (let i = 0; i < 40; i++) { const l = await cdp.eval(`fetch('api/models').then(r => r.json()).then(m => m.loaded.voice ? 'yes' : 'no')`); if (l === "yes") break; await sleep(400); }
  await cdp.eval(`location.hash = '#/settings'`); await sleep(200);
  await cdp.eval(`location.hash = '#/voice'`);
  await waitFor("document.querySelectorAll('.vitem').length > 0");
  const mismatch = await cdp.eval(`(() => {
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => /Kokoro/i.test(o.textContent)));
    if (!sel) return 'no engine select';
    sel.value = [...sel.options].find(o => /Kokoro/i.test(o.textContent)).value; sel.dispatchEvent(new Event('change'));
    return 'ok';
  })()`);
  await waitFor("[...document.querySelectorAll('.vitem')].some(v => /af_|bf_/.test(v.textContent))", 6000);
  if (mismatch === "ok") {
    const warned = await cdp.eval(`(() => {
      const tile = [...document.querySelectorAll('.vitem')].find(v => /af_|bf_/.test(v.textContent));
      if (!tile) return 'no english voice listed';
      tile.click();
      const ta = document.querySelector('main textarea'); if (!ta) return 'no textarea';
      ta.value = '\u4eca\u5929\u5929\u6c14\u5f88\u597d'; ta.dispatchEvent(new Event('input'));
      const btn = [...document.querySelectorAll('main button:not(.subtab)')].find(b => b.textContent.includes('\u5408\u6210'));
      if (!btn) return 'no synth button';
      btn.click();
      return 'clicked';
    })()`);
    await sleep(900);
    const warnText = await cdp.eval(`(document.querySelector('main .warn')?.textContent || '')`);
    ok(warned === "clicked" && /英文音色|读不了中文/.test(warnText), "picking an English voice for Chinese text warns instead of synthesising: " + (warnText || warned).slice(0, 70));
  } else ok(false, "could not select Kokoro: " + mismatch);

  step("voice: synthesis, cloning and transcription are three separate views");
  await cdp.eval(`location.hash = '#/voice'`);
  await waitFor("!!document.querySelector('.subtab')");
  await sleep(400);
  const tabs0 = JSON.parse(await cdp.eval(`JSON.stringify({
    n: document.querySelectorAll('.subtab').length,
    labels: [...document.querySelectorAll('.subtab')].map(b => b.textContent.trim()),
    synthVisible: !!document.querySelector('textarea'),
  })`));
  ok(tabs0.n === 3, `the voice page has three tabs (${tabs0.n}): ${(tabs0.labels || []).join(" / ")}`);
  ok(tabs0.synthVisible, "合成 is the tab you land on (the text box is visible)");
  const cloneTab = JSON.parse(await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('.subtab')].find(x => /克隆/.test(x.textContent)); if (!b) return JSON.stringify({ err: 'no clone tab' });
    b.click();
    return JSON.stringify({
      hasFile: !!document.querySelector('input[type=file]'),
      hasSaveBtn: [...document.querySelectorAll('button')].some(x => /保存为音色/.test(x.textContent)),
      synthHidden: ![...document.querySelectorAll('textarea')].some(t => t.offsetParent !== null),
      savedLib: /我的音色/.test(document.body.innerText),
    });
  })()`));
  ok(!cloneTab.err && cloneTab.hasFile && cloneTab.hasSaveBtn, "克隆音色 tab shows only the clone form");
  ok(cloneTab.synthHidden, "the synthesis text box is hidden while cloning");
  ok(cloneTab.savedLib, "the clone tab lists the saved-voice library next to the form");
  const cloneWin = JSON.parse(await cdp.eval(`JSON.stringify({
    explains: /不属于某个模型|零样本/.test(document.body.innerText),
    nums: [...document.querySelectorAll('input[type=number]')].map(i => i.value),
  })`));
  ok(cloneWin.explains, "the clone tab explains that a saved voice is engine-independent");
  ok(cloneWin.nums.length >= 2, `the reference window (start / length) can be moved: ${cloneWin.nums.join(",")}`);
  // 用户报的正是这个：语音没加载时点「保存为音色」只弹一句失败，看不出该做什么。
  await cdp.eval(`fetch('api/models/unload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"modality":"voice"}' }).then(r => r.status)`);
  const cloneCold = await cdp.eval(`(async () => {
    const fd = new FormData(); fd.append('name', '测试音色'); fd.append('ref', new File([new Uint8Array(2048)], 'ref.wav', { type: 'audio/wav' }));
    const r = await fetch('voice/voices', { method: 'POST', body: fd });
    return r.status;
  })()`);
  ok(cloneCold === 409, `cloning with nothing in VRAM answers 409 rather than a bare failure (HTTP ${cloneCold})`);
  const cloneUi = await cdp.eval(`(async () => {
    const name = [...document.querySelectorAll('input')].find(i => /音色名字/.test(i.placeholder || ''));
    const file = [...document.querySelectorAll('input[type=file]')].find(i => i.offsetParent !== null);
    if (!name || !file) return 'no clone form';
    name.value = '测试音色';
    const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(2048)], 'ref.wav', { type: 'audio/wav' })); file.files = dt.files;
    const go = [...document.querySelectorAll('button')].find(b => /保存为音色/.test(b.textContent));
    go.click();
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 250)); if ([...document.querySelectorAll('button')].some(b => /^加载 /.test(b.textContent))) break; }
    return [...document.querySelectorAll('button')].filter(b => /^加载 /.test(b.textContent)).map(b => b.textContent).join(',') || 'no load button';
  })()`);
  ok(/^加载 /.test(cloneUi), "the clone form turns that 409 into a one-click 加载 button: " + cloneUi.slice(0, 60));

  step("a synthesised clip survives a catalogue refresh, and the 存为素材 picker is filled");
  await cdp.eval(`(() => { const b = [...document.querySelectorAll('.subtab')].find(x => /合成/.test(x.textContent)); if (b) b.click(); })()`);
  await sleep(300);
  const projOpts = await cdp.eval(`(() => { const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => /默认|default/i.test(o.textContent + o.value))); return s ? s.options.length : 0; })()`);
  ok(projOpts > 0, `the 存为素材 project picker has projects to pick (${projOpts})`);
  await cdp.eval(`(() => { const t = [...document.querySelectorAll('textarea')].find(x => x.offsetParent !== null); if (t) t.value = '不要被刷新吃掉的一句话'; })()`);
  await cdp.eval(`document.dispatchEvent(new CustomEvent('models', { detail: { loaded: {} } }))`);
  await sleep(1200);
  const kept = await cdp.eval(`(() => { const t = [...document.querySelectorAll('textarea')].find(x => x.offsetParent !== null); return t ? t.value : ''; })()`);
  ok(/不要被刷新吃掉/.test(kept), "a models event no longer wipes what you typed (that was why 保存到工作区 said 先合成一段)");

  step("dashboard refreshes by itself while a model loads");
  await cdp.eval(`location.hash = '#/'`); await sleep(1200);
  const before0 = await cdp.eval(`document.body.innerText.includes('加载') || ''`);
  await cdp.eval(`(window.__mev = [], document.addEventListener('models', e => window.__mev.push((e.detail.busy && e.detail.busy.progress || []).map(p => p.text).join(' → ') || '-')), 'armed')`);
  const ensureResp = await cdp.eval(`fetch('api/models/ensure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modality: 'voice' }) }).then(r => r.text())`);
  let live = null, sawProgress = false;
  for (let i = 0; i < 90; i++) {
    live = JSON.parse(await cdp.eval(`JSON.stringify({
      badges: [...document.querySelectorAll('main .badge')].map(b => b.textContent).join(' | '),
      hint: [...document.querySelectorAll('main .hint')].map(b => b.textContent).join(' | ').slice(0, 200),
    })`));
    if (/加载|卸载/.test(live.hint)) sawProgress = true;
    if (/IndexTTS|Kokoro|Qwen3-TTS/.test(live.badges)) break;
    await sleep(500);
  }
  const loadedNow = await cdp.eval(`fetch('api/models').then(r => r.json()).then(m => Object.keys(m.loaded).join(','))`);
  ok(/IndexTTS|Kokoro|Qwen3-TTS/.test(live.badges), `the dashboard shows the newly loaded model without a reload: badges=${live.badges.slice(0, 90)} loaded=${loadedNow} ensure=${String(ensureResp).slice(0, 120)}`);
  const steps = JSON.parse(await cdp.eval(`JSON.stringify(window.__mev)`));
  const longest = steps.map((x) => x.split(" → ").length).reduce((a, b) => Math.max(a, b), 0);
  ok(sawProgress || longest >= 2, `the load streams its real steps instead of an empty spinner (${longest} steps): ${(steps.find((x) => x.includes("→")) || steps[0] || "").slice(0, 110)}`);
  const bootPref = JSON.parse(await cdp.eval(`fetch('api/models/boot').then(r => r.text())`));
  ok(bootPref.modality === "voice", `loading by hand becomes the power-on default (${bootPref.modality})`);
  await cdp.eval(`fetch('api/models/boot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modality: 'video' }) })`);
  const bootBack = JSON.parse(await cdp.eval(`fetch('api/models/boot').then(r => r.text())`));
  ok(bootBack.modality === "video", "the power-on default can be put back to 视频 (H3)");

  step("the fleet: boxes are listed and the active one can be switched");
  const boxes = JSON.parse(await cdp.eval(`fetch('api/boxes').then(r => r.text())`));
  ok(Array.isArray(boxes.boxes) && boxes.boxes.length >= 1, `the fleet lists its machines (${(boxes.boxes || []).map((b) => b.name).join(",")})`);
  ok(boxes.boxes.some((b) => b.active), `one machine is active (${boxes.active})`);
  ok(boxes.boxes.every((b) => b.ports && b.ports.comfy && b.ports.ssh), "each machine carries its own tunnel ports");
  const same = JSON.parse(await cdp.eval(`fetch('api/boxes/${boxes.active}/activate', { method: 'POST' }).then(r => r.text())`));
  ok(same.ok && same.changed === false, "activating the machine already in use is a no-op, not an error");
  const bogus = await cdp.eval(`fetch('api/boxes/nosuchbox/activate', { method: 'POST' }).then(r => r.status)`);
  ok(bogus >= 400, `an unknown machine is refused (HTTP ${bogus})`);
  // switching rewires the ports every service talks to, so the snapshot has to follow along
  const wired = JSON.parse(await cdp.eval(`fetch('api/models').then(r => r.json()).then(m => JSON.stringify({ total: m.vramTotal, avail: m.available }))`));
  ok(wired.total > 0, `the model snapshot answers for the active machine (vram ${wired.total} MiB)`);
  ok(boxes.boxes.every((b) => "cloudState" in b), "每台机器都带云上状态，不用切过去也能看到");
  ok(boxes.boxes.every((b) => "gone" in b), "已删除的机器会被标出来，不该还留在下拉里给人选");
  // 下拉框只是看哪台，不该有副作用
  await cdp.eval(`location.hash = '#/'`); await sleep(1200);
  const activeBefore = JSON.parse(await cdp.eval(`fetch('api/boxes').then(r => r.text())`)).active;
  const pickedBox = await cdp.eval(`(() => {
    const sel = [...document.querySelectorAll('main select')].find(s => [...s.options].some(o => /当前|云上/.test(o.textContent)));
    if (!sel) return 'no box select';
    const other = [...sel.options].find(o => !/（当前）/.test(o.textContent));
    if (!other) return 'single box';
    sel.value = other.value; sel.dispatchEvent(new Event('change'));
    return other.value;
  })()`);
  await sleep(800);
  const activeAfter = JSON.parse(await cdp.eval(`fetch('api/boxes').then(r => r.text())`)).active;
  ok(activeAfter === activeBefore, `changing the dropdown does not move the fleet (${activeBefore} → ${activeAfter}${pickedBox === "single box" ? ", only one machine here" : ""})`);

  step("settings is split into tabs and DeepSeek can be configured from the page");
  await cdp.eval(`location.hash = '#/settings'`);
  await waitFor("document.querySelectorAll('.subtab').length >= 3", 8000);
  const setTabs = JSON.parse(await cdp.eval(`JSON.stringify({
    tabs: [...document.querySelectorAll('main .subtab')].map(b => b.textContent.trim()),
    hasKeyInput: !!document.querySelector('main input[type=password]'),
    rulesLink: (document.body.innerText.match(/https?:\\/\\/[^\\s]*h3[^\\s]*/) || [""])[0],
    dumpsFullRules: document.body.innerText.length > 20000,
  })`));
  ok(setTabs.tabs.length >= 4, `settings has tabs instead of one long page: ${setTabs.tabs.join(" / ")}`);
  ok(setTabs.hasKeyInput, "the assistant's API key can be set from the page");
  ok(/h3/.test(setTabs.rulesLink), "the H3 rules are offered as a link an agent can read: " + setTabs.rulesLink);
  ok(!setTabs.dumpsFullRules, "the page links the rules rather than dumping the whole document");
  const assistant = JSON.parse(await cdp.eval(`fetch('api/settings/assistant').then(r => r.text())`));
  ok("baseUrl" in assistant && Array.isArray(assistant.presets), `the assistant endpoint answers (${assistant.baseUrl}, ${assistant.presets.length} 预设)`);

  step("model visibility: unchecking a model in settings drops it out of the pickers");
  await cdp.eval(`(() => { const b = [...document.querySelectorAll('main .subtab')].find(x => /模型显示/.test(x.textContent)); if (b) b.click(); })()`);
  await waitFor("document.querySelectorAll('main .mgroup input[type=checkbox]').length > 0", 8000);
  const visBefore = JSON.parse(await cdp.eval(`JSON.stringify({
    groups: document.querySelectorAll('main .mgroup').length,
    boxes: document.querySelectorAll('main .mgroup input[type=checkbox]').length,
  })`));
  ok(visBefore.groups >= 2 && visBefore.boxes >= 4, `every capability lists its models with a checkbox (${visBefore.groups} 组 / ${visBefore.boxes} 个)`);
  // pick an llm the dashboard is not currently defaulting to, hide it, and check the capability card's dropdown
  const target = JSON.parse(await cdp.eval(`fetch('api/models').then(r => r.json()).then(s => {
    const def = s.defaults && s.defaults.llm;
    const m = s.models.filter(x => x.modality === 'llm' && !x.hereMissing && x.id !== def)[0];
    return JSON.stringify({ id: m && m.id, name: m && m.name });
  })`));
  ok(!!target.id, "there is a second llm to hide: " + target.name);
  const hid = JSON.parse(await cdp.eval(`(async () => {
    const boxes = [...document.querySelectorAll('main .mgroup label')];
    const row = boxes.find(l => l.textContent.includes(${JSON.stringify(target.name)}));
    if (!row) return JSON.stringify({ err: 'row not found' });
    const cb = row.querySelector('input[type=checkbox]');
    const was = cb.checked; cb.click();
    await new Promise(r => setTimeout(r, 600));
    const after = await fetch('api/models').then(r => r.json());
    const m = after.models.find(x => x.id === ${JSON.stringify(target.id)});
    return JSON.stringify({ was, hidden: !!m.hidden });
  })()`));
  ok(hid.was === true && hid.hidden === true, `unchecking it persists as hidden (${JSON.stringify(hid)})`);
  await cdp.eval(`location.hash = '#/models'`); await sleep(1200);
  const picker = JSON.parse(await cdp.eval(`JSON.stringify({
    inPicker: [...document.querySelectorAll('main .caps select option')].some(o => o.value === ${JSON.stringify(target.id)}),
    inCatalog: document.body.innerText.includes(${JSON.stringify(target.name)}),
    hiddenBadge: [...document.querySelectorAll('main .badge')].some(b => b.textContent.trim() === '已隐藏'),
  })`));
  ok(!picker.inPicker, "the hidden model is gone from the capability card's dropdown");
  ok(picker.inCatalog && picker.hiddenBadge, "but the model manager still lists it, marked 已隐藏");
  await cdp.eval(`fetch('api/models/${target.id}', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hidden: false }) })`);
  await sleep(300);
  // tabbed() remembers the last tab in localStorage — put settings back on its first tab so later
  // steps (which look at the settings page's buttons) see what a fresh visitor sees.
  await cdp.eval(`location.hash = '#/settings'`); await sleep(800);
  await cdp.eval(`(() => { const b = document.querySelector('main .subtab'); if (b && !b.classList.contains('on')) b.click(); })()`);

  step("the prompt editor: save is prominent, 从库插入 is gone, rewrite is offered");
  await cdp.eval(`location.hash = '#/generate'`); await sleep(1500);
  const tools = JSON.parse(await cdp.eval(`JSON.stringify({
    save: [...document.querySelectorAll('main button')].filter(b => /保存提示词/.test(b.textContent)).map(b => b.className),
    fromLib: [...document.querySelectorAll('main button')].some(b => /从库插入/.test(b.textContent)),
    rewrite: [...document.querySelectorAll('main button')].some(b => /AI 改写/.test(b.textContent)),
    assist: [...document.querySelectorAll('main button')].some(b => /AI 助手/.test(b.textContent)),
    linkRow: /参考：/.test(document.body.innerText),
  })`));
  ok(tools.save.some((c) => /primary/.test(c)), "保存提示词 is a prominent button: " + tools.save.join(","));
  ok(!tools.fromLib, "从库插入 is gone (OpenPrompt recommendations take its place)");
  ok(tools.rewrite && tools.assist, "both 写 (AI 助手) and 改 (AI 改写) are offered");
  ok(tools.linkRow, "the rules / library references sit at the bottom as links, not buttons");

  step("access page: tabs, and the voice API is documented like the LLM one");
  await cdp.eval(`location.hash = '#/access'`);
  await waitFor("[...document.querySelectorAll('main .subtab')].length >= 3", 10000);
  await sleep(1200);
  const acc = JSON.parse(await cdp.eval(`JSON.stringify({ tabs: [...document.querySelectorAll('main .subtab')].map(b => b.textContent.trim()) })`));
  ok(acc.tabs.length >= 4, `the access page is split into tabs: ${acc.tabs.join(" / ")}`);
  const voiceTab = JSON.parse(await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('main .subtab')].find(x => /语音/.test(x.textContent));
    if (!b) return JSON.stringify({ err: 'no voice tab' });
    b.click();
    const t = document.querySelector('main').innerText;
    return JSON.stringify({
      endpoint: /audio\\/speech/.test(t),
      asr: /audio\\/transcriptions/.test(t),
      instruct: /instructions/.test(t),
      voiceIds: /音色 id/.test(t),
      engines: [...document.querySelectorAll('main table tr')].length,
      copyBtn: [...document.querySelectorAll('main button')].some(x => /复制接入说明/.test(x.textContent)),
    });
  })()`));
  ok(!voiceTab.err && voiceTab.endpoint && voiceTab.asr, "the voice tab names both the speech and the transcription endpoint");
  ok(voiceTab.instruct, "it documents the instructions / style parameter");
  ok(voiceTab.voiceIds, "it explains what goes in voice (the id)");
  ok(voiceTab.copyBtn, `each engine can be copied as an agent brief (${voiceTab.engines} rows)`);

  step("look and feel: one button system, tabs that are not buttons, no emoji, dark native controls");
  await cdp.eval(`location.hash = '#/chat'`); await sleep(1200);
  const look = JSON.parse(await cdp.eval(`(() => {
    const css = getComputedStyle(document.documentElement);
    const btns = [...document.querySelectorAll('main button:not(.subtab)')];
    const hs = [...new Set(btns.map(b => Math.round(b.getBoundingClientRect().height)).filter(x => x > 0))];
    const emoji = (document.querySelector('main').innerText.match(/[\\u{1F300}-\\u{1FAFF}]/gu) || []);
    return JSON.stringify({
      scheme: css.colorScheme,
      accent: css.getPropertyValue('--accent').trim(),
      heights: hs.sort((a, b) => a - b),
      emoji: emoji.slice(0, 5),
      chatLog: !!document.querySelector('.chat-log'),
    });
  })()`));
  ok(look.scheme === "dark", `native controls follow the dark theme (color-scheme: ${look.scheme})`);
  ok(!/f59e0b|fbbf24/i.test(look.accent), `the amber accent is gone (accent is ${look.accent})`);
  ok(look.heights.length <= 2, `buttons share one or two heights, not a jumble: ${look.heights.join(", ")}px`);
  ok(look.emoji.length === 0, `no emoji in the interface${look.emoji.length ? ": " + look.emoji.join("") : ""}`);
  ok(look.chatLog, "the chat page renders a real conversation log");
  const tabsLook = JSON.parse(await cdp.eval(`(() => {
    location.hash = '#/settings';
    return new Promise(r => setTimeout(() => {
      const t = document.querySelector('main .subtab');
      const b = [...document.querySelectorAll('main button:not(.subtab)')][0];
      if (!t || !b) return r(JSON.stringify({ err: 'not rendered' }));
      const cs = getComputedStyle(t), cb = getComputedStyle(b);
      r(JSON.stringify({ tabRadius: cs.borderRadius, btnRadius: cb.borderRadius, tabBorder: cs.borderBottomWidth, tabBg: cs.backgroundColor }));
    }, 1500));
  })()`));
  ok(!tabsLook.err && tabsLook.tabRadius !== tabsLook.btnRadius, `tabs no longer look like buttons (tab radius ${tabsLook.tabRadius} vs button ${tabsLook.btnRadius})`);

  step("the job detail shows the prompt, and the voice input box is not tiny");
  await cdp.eval(`location.hash = '#/voice'`);
  await waitFor("!!document.querySelector('.speak-text')", 8000);
  const box = await cdp.eval(`Math.round(document.querySelector('.speak-text').getBoundingClientRect().height)`);
  ok(box >= 150, `the 说什么 box is the biggest control on the page (${box}px tall)`);
  const players = JSON.parse(await cdp.eval(`JSON.stringify({ native: document.querySelectorAll('audio[controls]').length, custom: document.querySelectorAll('.ap').length })`));
  ok(players.native === 0, `no native audio widget left (they render light on a dark page): ${players.native} native, ${players.custom} custom`);
  // 侧栏：分组标题不能跟可点的条目长得一样，否则分不清哪个能点
  const nav = JSON.parse(await cdp.eval(`(() => {
    const a = document.querySelector('nav a:not(.active)'), hh = document.querySelector('.nav-h');
    if (!a || !hh) return JSON.stringify({ err: 'no nav' });
    const ca = getComputedStyle(a), ch = getComputedStyle(hh);
    const act = document.querySelector('nav a.active');
    return JSON.stringify({ linkSize: parseFloat(ca.fontSize), headSize: parseFloat(ch.fontSize),
      linkColor: ca.color, headColor: ch.color, activeMark: act ? getComputedStyle(act, '::before').width : '0px' });
  })()`));
  ok(!nav.err && nav.headSize < nav.linkSize - 2, `section headings are visibly smaller than the links (${nav.headSize} vs ${nav.linkSize}px)`);
  ok(nav.headColor !== nav.linkColor, `and a different colour, so headings do not read as clickable (${nav.headColor} vs ${nav.linkColor})`);
  ok(nav.activeMark !== "0px" && nav.activeMark !== "auto", `the current page carries a marker (${nav.activeMark})`);
  // 模型目录：第一列不许把说明拉成一长条
  await cdp.eval(`location.hash = '#/models'`);
  await waitFor("!!document.querySelector('table.models')", 10000);
  const col = JSON.parse(await cdp.eval(`(() => {
    const t = document.querySelector('table.models'); const c = t.querySelector('td');
    return JSON.stringify({ first: Math.round(c.getBoundingClientRect().width), table: Math.round(t.getBoundingClientRect().width) });
  })()`));
  ok(col.first / col.table < 0.45, `the model column leaves room for the rest (${col.first}/${col.table}px)`);
  // 分组标题必须跟下面的内容分开，不能黑成一片
  const grp = JSON.parse(await cdp.eval(`(() => {
    const g = document.querySelector('.mgroup'); if (!g) return JSON.stringify({ err: 'no group' });
    const hd = g.querySelector('.mgroup-h'), bd = g.querySelector('.mgroup-b');
    return JSON.stringify({ headBg: getComputedStyle(hd).backgroundColor, bodyBg: getComputedStyle(bd).backgroundColor,
      border: getComputedStyle(hd).borderBottomWidth, groups: document.querySelectorAll('.mgroup').length });
  })()`));
  ok(!grp.err && grp.headBg !== grp.bodyBg, `each capability group has a header bar you can see (${grp.headBg} vs ${grp.bodyBg}, ${grp.groups} groups)`);
  // 控件不能是纯黑，那看着像没做样式
  const ctl = JSON.parse(await cdp.eval(`(() => {
    const s2 = document.querySelector('main select'); if (!s2) return JSON.stringify({ err: 'no select' });
    const cs = getComputedStyle(s2);
    return JSON.stringify({ bg: cs.backgroundColor, maxW: cs.maxWidth, w: Math.round(s2.getBoundingClientRect().width) });
  })()`));
  ok(!ctl.err && ctl.bg !== "rgb(14, 17, 22)" && ctl.bg !== "rgb(0, 0, 0)", `controls sit on a surface, not near-black (${ctl.bg})`);
  ok(ctl.maxW !== "none", `a dropdown is not stretched across the whole column (max-width ${ctl.maxW})`);

  step("the chat page fills the screen and puts the model picker under the input");
  await cdp.eval(`location.hash = '#/chat'`);
  await waitFor("!!document.querySelector('.chat-in')", 8000);
  const chatUi = JSON.parse(await cdp.eval(`(() => {
    const c = document.querySelector('.chat'), log = document.querySelector('.chat-log');
    const inBox = document.querySelector('.chat-in'), selIn = document.querySelector('.chat-in select');
    const above = document.querySelector('main > .chat > *:first-child') === log;
    return JSON.stringify({ h: Math.round(c.getBoundingClientRect().height), vh: window.innerHeight,
      logFirst: above, pickerUnder: !!selIn, inBottom: Math.round(inBox.getBoundingClientRect().bottom) });
  })()`));
  ok(chatUi.h / chatUi.vh > 0.8, `the conversation fills the screen (${chatUi.h}/${chatUi.vh}px)`);
  ok(chatUi.logFirst, "the log is the first thing on the page — no toolbar above it");
  ok(chatUi.pickerUnder, "the model picker lives in the input area, where chat apps put it");

  step("the model manager shows what this box is missing and can restore it");
  await cdp.eval(`location.hash = '#/models'`); await sleep(1500);
  const fleetUi = JSON.parse(await cdp.eval(`(() => {
    const cards = [...document.querySelectorAll('main .card')];
    const c = cards.find(x => /机器恢复/.test(x.textContent));
    if (!c) return JSON.stringify({ err: 'no fleet card' });
    const btns = [...c.querySelectorAll('button')].map(b => b.textContent.trim());
    // 注意：模板字符串里 \\d 会被吞成 d，正则要么双写反斜杠、要么别用正则
    const rows = c.innerText.replace(/\\s+/g, " ");
    return JSON.stringify({ text: c.innerText.slice(0, 600), btns, hasLayerCount: rows.includes(" 层") && rows.includes("音色镜像") });
  })()`));
  ok(!fleetUi.err, "the model manager has a machine-restore card");
  ok(fleetUi.hasLayerCount, "it says how many layers the fleet has: " + (fleetUi.text || "").split("\n").slice(0, 3).join(" / "));
  ok(fleetUi.btns.some((b) => /补齐|重新检查/.test(b)) && fleetUi.btns.some((b) => /备份音色/.test(b)),
     "and offers both restore and voice backup: " + fleetUi.btns.join(", "));

  step("chat takes images: attach one, see the thumbnail, send it as an image_url message");
  // only models launched with --mmproj can see; make sure one is loadable and picked before attaching
  const seer = JSON.parse(await cdp.eval(`fetch('api/models').then(r => r.json()).then(s => {
    const m = s.models.find(x => x.modality === 'llm' && (x.args || []).includes('--mmproj') && !x.hereMissing);
    return JSON.stringify({ id: m && m.id, tested: m && !!m.tested });
  })`));
  ok(!!seer.id, "the catalogue offers a model that can look at pictures: " + seer.id);
  if (!seer.tested) await cdp.eval(`fetch('api/models/${seer.id}', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tested: true }) })`);
  await cdp.eval(`location.hash = '#/dashboard'`); await sleep(300);
  await cdp.eval(`location.hash = '#/chat'`);
  await waitFor("!!document.querySelector('.chat-in select')", 8000);
  await cdp.eval(`(() => { const s = document.querySelector('.chat-in select'); s.value = ${JSON.stringify(seer.id)}; })()`);
  const img = JSON.parse(await cdp.eval(`(async () => {
    const btn = [...document.querySelectorAll('.chat-in button')].find(b => b.textContent.trim() === '图片');
    if (!btn) return JSON.stringify({ err: 'no picture button' });
    // build a real PNG and hand it to the file input the way a file picker would
    const cv = document.createElement('canvas'); cv.width = 40; cv.height = 30;
    const g = cv.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 40, 30);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    const file = new File([blob], 'red.png', { type: 'image/png' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.querySelector('.chat-in input[type=file]');
    input.files = dt.files; input.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 700));
    const thumbs = document.querySelectorAll('.chat-in .chat-atts .att img').length;
    // send it and capture what actually goes on the wire
    let sent = null; const orig = window.fetch;
    window.fetch = (u, o) => { if (String(u).includes('chat/completions')) { try { sent = JSON.parse(o.body); } catch (e) {} } return orig(u, o); };
    document.querySelector('.chat-in textarea').value = '这是什么颜色';
    [...document.querySelectorAll('.chat-in button')].find(b => b.textContent.trim() === '发送').click();
    await new Promise(r => setTimeout(r, 1500));
    window.fetch = orig;
    const last = sent && sent.messages[sent.messages.length - 1];
    const parts = last && Array.isArray(last.content) ? last.content : [];
    return JSON.stringify({
      thumbs,
      cleared: document.querySelectorAll('.chat-in .chat-atts .att').length,
      inBubble: document.querySelectorAll('.msg.me .chat-atts img').length,
      kinds: parts.map(x => x.type),
      dataUrl: parts.some(x => x.type === 'image_url' && x.image_url.url.startsWith('data:image/')),
    });
  })()`));
  ok(!img.err && img.thumbs === 1, `attaching an image shows a thumbnail in the composer (${JSON.stringify(img)})`);
  ok(img.kinds.join(",") === "text,image_url", `the request carries text + image_url parts (${img.kinds.join(",")})`);
  ok(img.dataUrl, "the image travels as a data: URL the OpenAI schema accepts");
  ok(img.cleared === 0 && img.inBubble === 1, "after sending, the composer is empty and the picture sits in the message");

  step("switching project tabs quickly must not paint the page twice");
  await cdp.eval(`location.hash = '#/project/default/assets'`); await sleep(400);
  await cdp.eval(`location.hash = '#/project/default/clips'`); await sleep(150);
  await cdp.eval(`location.hash = '#/project/default/assets'`); await sleep(150);
  await cdp.eval(`location.hash = '#/project/default/assets'`); await sleep(1800);
  const dup = JSON.parse(await cdp.eval(`JSON.stringify({ drops: document.querySelectorAll('.drop').length, grids: document.querySelectorAll('main .grid.g4').length })`));
  ok(dup.drops === 1 && dup.grids === 1, `the assets tab renders once (${dup.drops} upload boxes, ${dup.grids} grids)`);

  step("upload a file through the upload box");
  const clip = path.join(os.tmpdir(), "atl-browser-upload.mp4");
  if (!fsSync.existsSync(clip)) execSync(`ffmpeg -y -loglevel error -f lavfi -i testsrc2=s=320x240:r=24 -t 2 -c:v libx264 -pix_fmt yuv420p ${JSON.stringify(clip)}`);
  await cdp.eval(`location.hash = '#/project/default/assets'`);
  await sleep(1200);
  const before = await cdp.eval("document.querySelectorAll('.asset').length");
  const { root: docRoot } = await cdp.send("DOM.getDocument");
  const input = await cdp.send("DOM.querySelector", { nodeId: docRoot.nodeId, selector: "input[type=file]" });
  ok(!!input.nodeId, "the upload box has a file input");
  await cdp.send("DOM.setFileInputFiles", { files: [clip], nodeId: input.nodeId });
  let after = before;
  for (let i = 0; i < 120; i++) { after = await cdp.eval("document.querySelectorAll('.asset').length"); if (after > before) break; await sleep(500); }
  ok(after > before, `the asset list grew after the upload (${before} → ${after})`);
  const label = await cdp.eval("document.querySelector('.drop')?.innerText || ''");
  ok(!/0%$/.test(label.trim()), "the upload box is not stuck at 0% (" + label.replace(/\n/g, " ").slice(0, 60) + ")");

  step("result");
  if (problems.length) { console.log("\n  问题："); for (const p of [...new Set(problems)].slice(0, 20)) console.log("   - " + p); }
  console.log(`\n${fails ? "❌" : "✅"} 浏览器 E2E：${checks - fails}/${checks} 通过`);
  process.exitCode = fails ? 1 : 0;
} catch (e) {
  console.log("\n❌ 浏览器 E2E 崩了：" + e.message);
  process.exitCode = 1;
} finally {
  if (chrome) chrome.kill("SIGTERM");
  if (devServer) devServer.kill("SIGTERM");
  await sleep(300);
  if (profileDir) await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
