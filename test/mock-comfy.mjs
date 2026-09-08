#!/usr/bin/env node
// Mock ComfyUI HTTP + WebSocket server for local end-to-end tests (no GPU needed).
//
// Emulates the subset of the ComfyUI API that H3 Studio talks to:
//   GET  /  /system_stats  /queue  /history  /history/<id>  /view      WS /ws?clientId=<id>
//   POST /prompt  /queue  /history  /upload/image  /interrupt
// "Execution" of a MiniMaxH3 workflow renders a synthetic mp4 with ffmpeg (seed-coloured
// card + moving box + 440 Hz sine) at the requested width x height x length @ 24 fps, saved
// as <outDir>/output/<filename_prefix>_00001_.mp4 exactly like ComfyUI's SaveVideo node.
// Every route is also served under the /api prefix, as real ComfyUI does.
//
// Programmatic:  const mock = await startMockComfy({ port: 0, delayMs: 300, outDir });
//                mock.url, mock.submitted, await mock.close()
// CLI:           node test/mock-comfy.mjs --port 19288 --delay 2 --outdir /tmp/mockcomfy
//                [--fail-every N] [--host 0.0.0.0] [--verbose]

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const H3_NODE_TYPES = new Set(['MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo']);
const FFMPEG = process.env.FFMPEG
  || ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((p) => fs.existsSync(p))
  || 'ffmpeg';
const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.json': 'application/json', '.txt': 'text/plain',
};
const SYSTEM_STATS = {
  system: { os: 'posix', comfyui_version: '0.34.0', pytorch_version: '2.13.0+cu132', python_version: '3.12' },
  devices: [{
    name: 'cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync', type: 'cuda', index: 0,
    vram_total: 33670430720, vram_free: 6000000000, torch_vram_total: 26843545600, torch_vram_free: 536870912,
  }],
};

// ---------- small helpers ----------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripApi = (p) => p.replace(/^\/api(?=\/|$)/, '') || '/';

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}
function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
/** Find the first node of a given class_type (or Set of types): returns [id, node] or []. */
function findNode(workflow, type) {
  const match = type instanceof Set ? (t) => type.has(t) : (t) => t === type;
  for (const [id, node] of Object.entries(workflow)) if (node && match(node.class_type)) return [id, node];
  return [];
}

/** Minimal binary-safe multipart/form-data parser: returns [{ name, filename?, data: Buffer }]. */
export function parseMultipart(body, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = body.indexOf(delim);
  while (pos !== -1) {
    pos += delim.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;         // "--" closes the body
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;      // CRLF after delimiter
    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;
    const headers = body.subarray(pos, headerEnd).toString('latin1');
    const next = body.indexOf(delim, headerEnd + 4);
    if (next === -1) break;
    let end = next;
    if (body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2;  // CRLF before next delimiter
    const name = /\bname="([^"]*)"/i.exec(headers)?.[1];
    const fn = /\bfilename="([^"]*)"/i.exec(headers)?.[1];
    parts.push({
      name,
      filename: fn === undefined ? undefined : Buffer.from(fn, 'latin1').toString('utf8'),
      data: body.subarray(headerEnd + 4, end),
    });
    pos = next;
  }
  return parts;
}

/** Run ffmpeg; rejects with stderr on failure, kills the child when `signal` aborts. */
function runFfmpeg(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').pop() || ''}`));
    });
  });
}

// ---------- server ----------
export async function startMockComfy({ port = 0, host = '127.0.0.1', delayMs = 1500, outDir, failEvery = 0, verbose = false } = {}) {
  outDir = outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'mockcomfy-'));
  const dirs = { input: path.join(outDir, 'input'), output: path.join(outDir, 'output'), temp: path.join(outDir, 'temp') };
  for (const d of Object.values(dirs)) await fsp.mkdir(d, { recursive: true });
  const log = verbose ? (...a) => console.log(new Date().toISOString(), ...a) : () => {};

  const state = { pending: [], running: null, history: new Map(), number: 0, executed: 0, closed: false };
  const submitted = [];   // every accepted POST /prompt, in order
  const wss = new WebSocketServer({ noServer: true });

  const queueRemaining = () => state.pending.length + (state.running ? 1 : 0);
  const queueItem = (job) => [job.number, job.prompt_id, job.workflow, job.extra_data, job.outputs_to_execute];
  const statusData = () => ({ status: { exec_info: { queue_remaining: queueRemaining() } } });
  function broadcast(type, data) {
    const msg = JSON.stringify({ type, data });
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
  }

  /** Render the synthetic clip the way SaveVideo would name it: <prefix>_NNNNN_.mp4 (counter = max existing + 1). */
  async function renderVideo({ width, height, length, seed, prefix, signal }) {
    const subfolder = path.dirname(prefix) === '.' ? '' : path.dirname(prefix);
    const base = path.basename(prefix);
    const dir = path.join(dirs.output, subfolder);
    await fsp.mkdir(dir, { recursive: true });
    const re = new RegExp(`^${escapeRe(base)}_(\\d+)_\\.`);
    let n = 0;
    for (const f of await fsp.readdir(dir)) { const m = re.exec(f); if (m) n = Math.max(n, Number(m[1])); }
    const filename = `${base}_${String(n + 1).padStart(5, '0')}_.mp4`;
    // Seed-derived colours so different seeds give visibly different files.
    const h = (Math.abs(Number(seed) || 0) * 2654435761) >>> 0;
    const bg = ((h & 0x7f7f7f) + 0x202020).toString(16).padStart(6, '0');
    const fg = (((h >>> 8) & 0x7f7f7f) + 0x606060).toString(16).padStart(6, '0');
    const secs = (length / 24).toFixed(6);
    await runFfmpeg([
      '-f', 'lavfi', '-i', `color=c=0x${bg}:s=${width}x${height}:r=24`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-vf', `drawbox=x='(iw-w)*(0.5+0.5*sin(2*t))':y=ih/4:w=iw/3:h=ih/2:color=0x${fg}@1:t=fill`,
      '-frames:v', String(length), '-t', secs,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart',
      path.join(dir, filename),
    ], signal);
    return { filename, subfolder };
  }

  /** Execute one job: WS message sequence mirrors real ComfyUI, then a history record is written. */
  async function execute(job) {
    state.running = job;
    job.abort = new AbortController();
    const { signal } = job.abort;
    const pid = job.prompt_id;
    const wf = job.workflow;
    // Atelier white-model node: no H3 geometry; it "renders" a fixed-size clip and reports 1000-step progress like the real node.
    const [wmId, wm] = findNode(wf, 'AtelierWhiteModel');
    const [h3Id0, h30] = findNode(wf, H3_NODE_TYPES);
    const h3Id = wm ? wmId : h3Id0, h3 = wm ? { class_type: 'AtelierWhiteModel', inputs: { width: 640, height: 384, length: 56 } } : h30;
    const [saveId0, save] = findNode(wf, 'SaveVideo');
    const saveId = wm ? wmId : saveId0;
    const [samplerId = '12'] = findNode(wf, 'SamplerCustomAdvanced');
    const [, sched] = findNode(wf, 'BasicScheduler');
    const [, noise] = findNode(wf, 'RandomNoise');
    const steps = wm ? 1000 : Math.max(1, Number(sched?.inputs?.steps) || 4);
    const width = Number(h3.inputs?.width), height = Number(h3.inputs?.height), length = Number(h3.inputs?.length);
    const messages = [];   // only these go into history.status.messages (like real ComfyUI)
    const record = (type, data) => { messages.push([type, data]); broadcast(type, data); };
    let outputs = {}, meta = {}, ok = false;

    broadcast('status', statusData());
    record('execution_start', { prompt_id: pid, timestamp: Date.now() });
    record('execution_cached', { nodes: [], prompt_id: pid, timestamp: Date.now() });
    broadcast('executing', { node: h3Id, display_node: h3Id, prompt_id: pid });
    try {
      // H3 constraints: 32-multiple sides, length = 5 + 17k frames. Real ComfyUI only fails at execution.
      if (!(width > 0 && height > 0 && length > 0) || width % 32 || height % 32 || (length - 5) % 17) {
        const size = 24 * 4 * Math.ceil(width / 32) * Math.ceil(height / 32) + 624;
        throw Object.assign(new Error(`shape '[1, 24, 1, 1, ${Math.floor(height / 32)}, 2, ${Math.floor(width / 32)}, 2]' is invalid for input of size ${size}`), { exception_type: 'RuntimeError' });
      }
      state.executed++;
      if (failEvery > 0 && state.executed % failEvery === 0) {
        throw Object.assign(new Error('CUDA error: out of memory (mock failEvery)'), { exception_type: 'torch.OutOfMemoryError' });
      }
      for (let k = 1; k <= steps; k++) {
        await sleep(delayMs / steps, undefined, { signal });
        broadcast('progress', { value: k, max: steps, prompt_id: pid, node: samplerId });
      }
      broadcast('executing', { node: saveId, display_node: saveId, prompt_id: pid });
      const { filename, subfolder } = await renderVideo({
        width, height, length, seed: noise?.inputs?.noise_seed ?? 0,
        prefix: save?.inputs?.filename_prefix || 'h3_native', signal,
      });
      const video = { filename, subfolder, type: 'output', format: 'video/h264-mp4' };
      outputs = { [saveId]: { videos: [video] } };
      meta = { [saveId]: { node_id: saveId, display_node: saveId, parent_node: null, real_node_id: saveId } };
      broadcast('executed', { node: saveId, display_node: saveId, output: { videos: [video] }, prompt_id: pid });
      record('execution_success', { prompt_id: pid, timestamp: Date.now() });
      ok = true;
    } catch (e) {
      const interrupted = signal.aborted;
      record('execution_error', {
        prompt_id: pid, timestamp: Date.now(), node_id: h3Id, node_type: h3.class_type,
        exception_message: interrupted ? 'Interrupted' : String(e.message),
        exception_type: interrupted ? 'InterruptProcessingException' : (e.exception_type || 'RuntimeError'),
        traceback: [], current_inputs: {}, current_outputs: {},
      });
    }
    broadcast('executing', { node: null, prompt_id: pid });
    state.history.set(pid, {
      prompt: queueItem(job), outputs,
      status: { status_str: ok ? 'success' : 'error', completed: ok, messages },
      meta,
    });
    log(`job ${pid} ${ok ? 'success' : 'error'}`);
    state.running = null;
    schedule();
  }

  function schedule() {
    if (state.closed || state.running || !state.pending.length) return;
    const job = state.pending.shift();
    job.done = new Promise((resolve) => setImmediate(() => execute(job).catch((e) => log('execute crashed', e)).finally(resolve)));
  }

  /** Resolve a user-supplied path inside one of the managed dirs; null on traversal / bad type. */
  function safePath(type, subfolder, filename) {
    const base = dirs[type];
    if (!base) return null;
    const file = path.resolve(base, subfolder || '', filename);
    return file === base || file.startsWith(base + path.sep) ? file : null;
  }

  async function route(req, res, url) {
    const p = stripApi(url.pathname), m = req.method;

    if (m === 'GET' && p === '/') return text(res, 200, 'Mock ComfyUI');
    if (m === 'GET' && p === '/system_stats') return json(res, 200, SYSTEM_STATS);
    if (m === 'GET' && p === '/models/loras') return json(res, 200, ['minimax_h3_turbo_4step_ema.safetensors', 'minimax_h3_ref2va_acc_8step.safetensors', 'minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors', 'readme.txt']);

    if (m === 'GET' && p === '/queue') {
      return json(res, 200, { queue_running: state.running ? [queueItem(state.running)] : [], queue_pending: state.pending.map(queueItem) });
    }
    if (m === 'POST' && p === '/queue') {
      let body = {};
      try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { /* ignore */ }
      if (body.clear) state.pending.length = 0;
      if (Array.isArray(body.delete)) state.pending = state.pending.filter((j) => !body.delete.includes(j.prompt_id));
      broadcast('status', statusData());
      return text(res, 200, '');
    }

    if (m === 'POST' && p === '/prompt') {
      let body;
      try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch { return json(res, 400, { error: 'invalid json', node_errors: [] }); }
      const workflow = body?.prompt;
      if (!workflow || typeof workflow !== 'object') return json(res, 400, { error: 'no prompt', node_errors: [] });
      const [h3Id] = findNode(workflow, H3_NODE_TYPES);
      const [wmId] = findNode(workflow, 'AtelierWhiteModel');
      if (!h3Id && !wmId) return json(res, 400, { error: { type: 'invalid_prompt', message: 'Mock ComfyUI: prompt has no MiniMaxH3ImageToVideo / MiniMaxH3ReferenceToVideo node', details: '', extra_info: {} }, node_errors: {} });
      const [saveId] = findNode(workflow, 'SaveVideo');
      if (!saveId && !wmId) return json(res, 400, { error: { type: 'prompt_no_outputs', message: 'Prompt has no outputs', details: '', extra_info: {} }, node_errors: {} });
      const job = {
        prompt_id: randomUUID(), number: state.number++, workflow,   // stored as submitted, never mutated
        extra_data: { ...(body.extra_data || {}), client_id: body.client_id ?? null },
        outputs_to_execute: [saveId], abort: null, done: null,
      };
      submitted.push({ prompt_id: job.prompt_id, number: job.number, client_id: body.client_id ?? null, prompt: workflow });
      body.front ? state.pending.unshift(job) : state.pending.push(job);
      broadcast('status', statusData());
      json(res, 200, { prompt_id: job.prompt_id, number: job.number, node_errors: {} });
      return schedule();
    }

    if (m === 'GET' && p === '/history') {
      const max = Number(url.searchParams.get('max_items'));
      const entries = [...state.history.entries()];
      return json(res, 200, Object.fromEntries(max > 0 ? entries.slice(-max) : entries));
    }
    if (m === 'GET' && p.startsWith('/history/')) {
      const id = decodeURIComponent(p.slice('/history/'.length));
      const rec = state.history.get(id);
      return json(res, 200, rec ? { [id]: rec } : {});
    }
    if (m === 'POST' && p === '/history') {
      let body = {};
      try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { /* ignore */ }
      if (body.clear) state.history.clear();
      if (Array.isArray(body.delete)) for (const id of body.delete) state.history.delete(id);
      return text(res, 200, '');
    }

    if (m === 'GET' && p === '/view') {
      const filename = url.searchParams.get('filename');
      if (!filename) return text(res, 400, 'missing filename');
      const file = safePath(url.searchParams.get('type') || 'output', url.searchParams.get('subfolder') || '', path.basename(filename));
      if (!file) return text(res, 403, 'forbidden');
      let st;
      try { st = await fsp.stat(file); } catch { return text(res, 404, 'not found'); }
      if (!st.isFile()) return text(res, 404, 'not found');
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      let start = 0, end = st.size - 1, status = 200;
      if (range && (range[1] || range[2])) {   // single byte-range, like aiohttp's FileResponse
        start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
        end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : end;
        if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
        status = 206;
      }
      const headers = { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      res.writeHead(status, headers);
      return fs.createReadStream(file, { start, end }).pipe(res);
    }

    if (m === 'POST' && p === '/upload/image') {
      const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers['content-type'] || '');
      if (!bm) return text(res, 400, 'expected multipart/form-data');
      const parts = parseMultipart(await readBody(req), (bm[1] || bm[2]).trim());
      const fields = {};
      let file = null;
      for (const part of parts) {
        if (part.filename !== undefined) { if (part.name === 'image' || !file) file = part; } else fields[part.name] = part.data.toString('utf8');
      }
      const name = file && path.basename(file.filename);
      if (!name) return text(res, 400, 'no image file in form');
      const type = fields.type || 'input', subfolder = fields.subfolder || '';
      const target = safePath(type, subfolder, name);
      if (!target) return text(res, 400, 'bad type/subfolder');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      let final = target;
      if (fields.overwrite !== 'true' && fields.overwrite !== '1') {   // ComfyUI renames "x.png" -> "x (1).png"
        const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
        for (let i = 1; fs.existsSync(final); i++) final = path.join(path.dirname(target), `${stem} (${i})${ext}`);
      }
      await fsp.writeFile(final, file.data);
      return json(res, 200, { name: path.basename(final), subfolder, type });
    }

    if (m === 'POST' && p === '/interrupt') {
      state.running?.abort?.abort();
      return text(res, 200, '');
    }
    return text(res, 404, 'not found');
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.on('finish', () => log(`${req.method} ${url.pathname}${url.search} -> ${res.statusCode}`));
    route(req, res, url).catch((e) => {
      log('handler error', e);
      if (!res.headersSent) json(res, 500, { error: String(e?.message || e) }); else res.destroy();
    });
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (stripApi(url.pathname) !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const sid = url.searchParams.get('clientId') || randomUUID();
      log(`WS connect ${sid}`);
      ws.on('error', () => {});
      ws.send(JSON.stringify({ type: 'status', data: { ...statusData(), sid } }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const actualPort = server.address().port;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${actualPort}`;
  log(`Mock ComfyUI listening on ${url} (outDir=${outDir}, delay=${delayMs}ms, failEvery=${failEvery})`);

  async function close() {
    if (state.closed) return;
    state.closed = true;
    state.pending.length = 0;
    const running = state.running;
    running?.abort?.abort();                       // stops sleeps and kills in-flight ffmpeg
    if (running?.done) await Promise.race([running.done, sleep(2000)]);
    for (const c of wss.clients) c.terminate();
    await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  return { port: actualPort, url, outDir, close, submitted, history: state.history };
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = { port: 19288, host: '127.0.0.1', delayMs: 1500, outDir: undefined, failEvery: 0, verbose: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--port') opts.port = Number(v), i++;
    else if (a === '--host') opts.host = v, i++;
    else if (a === '--delay') opts.delayMs = Math.round(Number(v) * 1000), i++;   // seconds
    else if (a === '--delay-ms') opts.delayMs = Number(v), i++;
    else if (a === '--outdir') opts.outDir = path.resolve(v), i++;
    else if (a === '--fail-every') opts.failEvery = Number(v), i++;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else {
      console.log('usage: node test/mock-comfy.mjs [--port 19288] [--host 127.0.0.1] [--delay <seconds>|--delay-ms N] [--outdir DIR] [--fail-every N] [--verbose]');
      process.exit(a === '--help' || a === '-h' ? 0 : 1);
    }
  }
  const mock = await startMockComfy(opts);
  console.log(`Mock ComfyUI listening on ${mock.url}  outDir=${mock.outDir}  delay=${opts.delayMs}ms  failEvery=${opts.failEvery}`);
  const stop = () => mock.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
