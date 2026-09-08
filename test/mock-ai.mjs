// Test doubles for the prompt library: a tiny static "OpenPrompt" site and an OpenAI-compatible API
// (chat completions for tagging / drafting, embeddings with deterministic vectors).
import http from "node:http";
import crypto from "node:crypto";

const VIDEO = (id, model, title, prompt, extra = {}) => ({ id, case_id: 0, category: "cinematic-story", title, title_en: title, title_zh: title, author_handle: "tester", dataset: "video", collected_at: "2026-08-28T19:26:40.574Z", language: "en", likes: 3, results_count: 0, image: `https://img.test/${id}.jpg`, media_type: "video", has_image: true, has_video: true, search_index: `${title} tester cinematic-story en`, prompt_length: prompt.length, detail_chunk: 0, model, ...extra });
const DETAIL = (v, prompt) => ({ ...v, description: "desc", description_zh: "描述", author_url: "https://x.com/tester", source_post_url: `https://x.com/tester/status/${v.id}`, source_case_url: `https://github.com/example/${v.id}.json`, source_platform: "X", published_at: "2026-08-20T00:00:00.000Z", prompt, translated_prompt: "", video_url: `https://media.test/${v.id}.webm`, mode: "text-to-video", duration: "5s", aspect_ratio: "16:9" });
export const MOCK_PROMPTS = [
  ["h3-sisters-charger", "MiniMax-H3", "Two sisters look for a phone charger", "subject_definitions:\n<Subject 1> is the older sister…\n\nsummary:\n[reference generation] two sisters on a sofa look for a phone charger, sitcom.\n\noverall_soundscape: room tone\n\nnon_diegetic_music: N/A"],
  ["h3-rainy-street", "MiniMax H3", "Rainy neon street walk", "integrated_multimodal_description: [Shot 1] A woman walks down a rainy neon street at night, cinematic, 35mm. The camera holds a static shot.\n\noverall_soundscape: rain\n\nnon_diegetic_music: N/A"],
  ["seedance-duck", "Seedance 2.0", "Yellow rubber duck on a pond", "A yellow rubber duck floats on a calm pond, morning light, gentle ripples, close-up."],
];

export function startMockOpenPrompt({ port = 0 } = {}) {
  const catalog = MOCK_PROMPTS.map(([id, model, title, prompt]) => VIDEO(id, model, title, prompt));
  const image = { id: "img-1", category: "portrait", title: "Portrait", media_type: "image", has_video: false, has_image: true, detail_chunk: 0, image: "x", search_index: "portrait", prompt_length: 10 };
  const details = MOCK_PROMPTS.map(([id, , , prompt], i) => DETAIL(catalog[i], prompt));
  let selfUrl = "";
  details[1].video_url = "HLS_PLACEHOLDER";
  const routes = {
    "/prompts-data.js": ["application/javascript", `window.PROMPT_DATA = window.PROMPT_DATA || [];\nwindow.PROMPT_DATA_CHUNKS = ["./data/prompts-catalog-001.js"];\nwindow.PROMPT_DETAIL_CHUNKS = ["./data/prompt-details-001.json"];\n`],
    "/data/prompts-catalog-001.js": ["application/javascript", `window.PROMPT_DATA = (window.PROMPT_DATA || []).concat(${JSON.stringify([...catalog, image])});`],
    "/data/prompt-details-001.json": ["application/json", JSON.stringify(details)],
    "/hls/master.m3u8": ["application/vnd.apple.mpegurl", "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"orig\",DEFAULT=YES,URI=\"audio.m3u8\"\n#EXT-X-STREAM-INF:RESOLUTION=640x360,BANDWIDTH=1000000,AUDIO=\"a\"\nvariant.m3u8\n"],
    "/hls/variant.m3u8": ["application/vnd.apple.mpegurl", "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg0.ts\n#EXT-X-ENDLIST\n"],
    "/hls/seg0.ts": ["video/mp2t", "TSDATA-" + "x".repeat(2000)],
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => { const r = routes[req.url.split("?")[0]]; if (!r) { res.writeHead(404); return res.end("nope"); } res.writeHead(200, { "content-type": r[0] }); res.end(r[1].replace("HLS_PLACEHOLDER", selfUrl + "/hls/master.m3u8")); });
    server.listen(port, "127.0.0.1", () => { selfUrl = `http://127.0.0.1:${server.address().port}`; routes["/data/prompt-details-001.json"][1] = routes["/data/prompt-details-001.json"][1].replace("HLS_PLACEHOLDER", selfUrl + "/hls/master.m3u8"); resolve({ url: selfUrl, close: () => new Promise((r) => server.close(r)) }); });
  });
}

/** Deterministic pseudo-embedding: bag of character trigrams hashed into `dim` buckets, L2-normalised. */
export function fakeEmbedding(text, dim = 64) {
  const v = new Float32Array(dim); const t = text.toLowerCase();
  for (let i = 0; i + 3 <= t.length; i++) { const h = crypto.createHash("md5").update(t.slice(i, i + 3)).digest(); v[h[0] % dim] += 1; v[h[1] % dim] += 0.5; }
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Array.from(v, (x) => x / n);
}
export function startMockAI({ port = 0 } = {}) {
  const calls = { chat: [], embeddings: [], tts: [] };
  const savedVoices = [];
  // 0.1 s of silence, 16-bit mono 24 kHz — enough for ffprobe / a browser to accept it as a wav
  const WAV = (() => { const n = 2400, b = Buffer.alloc(44 + n * 2); b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40); return b; })();
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ""; req.on("data", (d) => { body += d; }); req.on("end", () => {
        // the clone endpoint is multipart, everything else is JSON — never let a body shape 500 the mock
        let j = {};
        if (body) { try { j = JSON.parse(body); } catch { for (const m of String(body).matchAll(/name="([^"]+)"\r?\n\r?\n([^\r\n]*)/g)) j[m[1]] = m[2]; } }
        const path = req.url.split("?")[0];
        res.setHeader("content-type", "application/json");
        if (path.endsWith("/embeddings")) { calls.embeddings.push(j); const inputs = Array.isArray(j.input) ? j.input : [j.input]; return res.end(JSON.stringify({ data: inputs.map((t, index) => ({ index, embedding: fakeEmbedding(String(t)) })), model: j.model })); }
        if (path.endsWith("/chat/completions")) {
          calls.chat.push(j);
          const sys = j.messages?.[0]?.content || "", user = j.messages?.at(-1)?.content || "";
          let content;
          if (/打标器/.test(sys)) { const items = JSON.parse(user); content = JSON.stringify(items.map((it) => ({ id: it.id, title_zh: `中文·${it.title.slice(0, 12)}`, summary_zh: `概括 ${it.title}`, mode: /subject_definitions/.test(it.prompt) ? "ref" : "t2v", genre: ["cinematic"], subjects: ["人物"], setting: "街道", camera: ["static"], mood: ["平静"], style: ["写实"], has_dialogue: /<d>/.test(it.prompt), h3_format: /integrated_multimodal_description|subject_definitions/.test(it.prompt), tags: ["夜景", "雨天", "都市", "电影感", "静态镜头", "写实", "女性", "行走"] }))); }
          else content = `integrated_multimodal_description: [Shot 1] Mock prompt for: ${user.slice(-80).replace(/\n/g, " ")}\n\noverall_soundscape: quiet\n\nnon_diegetic_music: N/A`;
          if (j.stream) {   // the workbench's chat panel streams and looks for a <think> block
            res.setHeader("content-type", "text/event-stream");
            const parts = ["<think>", "先想一下：", "这是模拟的思考。", "</think>", ...content.match(/.{1,24}/gs) || []];
            for (const pt of parts) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pt } }] })}\n\n`);
            return res.end("data: [DONE]\n\n");
          }
          return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], model: j.model }));
        }
        if (req.method === "GET" && path.endsWith("/models")) return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-llm", object: "model" }, { id: "indextts-2", object: "model", type: "tts", loaded: true }], voices: savedVoices.map((v) => ({ id: v.id, name: v.name })) }));
        // ---- voice router stand-in (engines / voices / tts / OpenAI audio) ----
        if (path === "/health") return res.end(JSON.stringify({ ok: true, engines: { "indextts-2": { loaded: true } }, tts_loaded: true, asr_loaded: true }));
        if (path === "/engines" && req.method === "GET") return res.end(JSON.stringify([{ id: "indextts-2", name: "IndexTTS-2", loaded: true, clone: true, installed: true, default: true, controls: [{ key: "emotion", label: "情绪", type: "text" }], voices: [] }, { id: "kokoro", name: "Kokoro", loaded: false, clone: false, installed: true, controls: [{ key: "speed", type: "range", min: 0.5, max: 2 }], voices: [{ id: "zf_xiaobei", name: "小贝", lang: "zh" }, { id: "zm_010", name: "男声 010", lang: "zh" }, { id: "af_heart", name: "Heart", lang: "en" }, { id: "bf_emma", name: "Emma", lang: "en" }] }]));
        if (/^\/engines\/[^/]+\/(load|unload)$/.test(path)) return res.end(JSON.stringify({ ok: true, loaded: ["indextts-2"] }));
        if (path === "/voices" && req.method === "GET") return res.end(JSON.stringify({ saved: savedVoices, samples: [{ id: "sample:voice_05", name: "示例声 voice_05", kind: "sample" }], builtin: { kokoro: [{ id: "zf_xiaobei", name: "小贝", lang: "zh" }, { id: "af_heart", name: "Heart", lang: "en" }] } }));
        if (path === "/voices" && req.method === "POST") { const v = { id: "v_" + crypto.randomBytes(3).toString("hex"), name: (j.name || "voice").slice(0, 60), note: j.note || "", refText: "这是参考声的转写", seconds: 5.2, createdAt: Math.floor(Date.now() / 1000), kind: "saved" }; savedVoices.push(v); return res.end(JSON.stringify(v)); }
        if (/^\/voices\/[^/]+$/.test(path) && req.method === "DELETE") { const id = path.split("/")[2]; const i = savedVoices.findIndex((v) => v.id === id); if (i >= 0) savedVoices.splice(i, 1); return res.end(JSON.stringify({ ok: true })); }
        if ((path === "/tts" || path === "/v1/audio/speech") && req.method === "POST") { calls.tts.push(j); res.setHeader("content-type", "audio/wav"); res.setHeader("x-audio-seconds", "1.5"); res.setHeader("x-model", j.model || "indextts-2"); return res.end(WAV); }
        res.writeHead(404); res.end("{}");
      });
    });
    server.listen(port, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) }));
  });
}
