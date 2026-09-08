// Prompt library: (1) OpenPrompt mirror — the public gallery at openprompt-virid.vercel.app is a static
// site (prompts-data.js → catalog chunks → detail chunks); we mirror the VIDEO prompts, re-tag them with
// the fast LLM into our own taxonomy, embed them (OpenAI) and serve vector search; (2) the user's own
// saved prompts. Everything lives under DATA_DIR/prompts/.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const nowS = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEEP = ["id", "case_id", "title", "title_en", "title_zh", "description", "description_zh", "author_handle", "author_url", "source_post_url", "source_case_url", "source_platform", "published_at", "collected_at", "language", "prompt", "translated_prompt", "likes", "image", "video_url", "model", "mode", "duration", "aspect_ratio", "category", "search_index"];
const MODES = ["t2v", "i2v", "ref", "edit", "avatar", "other"];

export class Prompts {
  constructor(config, events) {
    this.config = config; this.events = events;
    this.dir = path.join(config.dataDir, "prompts");
    this.items = new Map();      // id → item (detail subset)
    this.tags = new Map();       // id → tag record
    this.vecIds = [];            // row order of this.vectors
    this.vectors = null;         // Float32Array (rows × dim)
    this.dim = 0;
    this.library = [];
    this.status = { lastSync: null, lastError: null, syncing: null };
    this.queryCache = new Map();
  }

  // ---- persistence ------------------------------------------------------------------------
  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    const rd = async (f, dflt) => { try { return JSON.parse(await fsp.readFile(path.join(this.dir, f), "utf8")); } catch { return dflt; } };
    let dirtyItems = false, dirtyTags = false;
    for (const [id, it] of Object.entries(await rd("items.json", {}))) { const nm = normalizeModel(it.model); if (nm !== it.model) { it.model = nm; dirtyItems = true; } this.items.set(id, it); }
    for (const [id, t] of Object.entries(await rd("tags.json", {}))) { const nt = normalizeTags(t.tags); if (nt.join("|") !== (t.tags || []).join("|")) { t.tags = nt; dirtyTags = true; } this.tags.set(id, t); }
    if (dirtyItems) await this.saveItems(); if (dirtyTags) await this.saveTags();
    const meta = await rd("vectors.json", null);
    if (meta?.ids?.length && fs.existsSync(path.join(this.dir, "vectors.bin"))) {
      const buf = await fsp.readFile(path.join(this.dir, "vectors.bin"));
      this.dim = meta.dim; this.vecIds = meta.ids;
      this.vectors = new Float32Array(buf.buffer, buf.byteOffset, meta.ids.length * meta.dim);
      // drop stale rows (ids no longer present) lazily at next embed
    }
    this.library = await rd("library.json", []);
    const st = await rd("status.json", {}); this.status.lastSync = st.lastSync || null;
  }
  /** Atomic write, serialised per file (background embedding and API writes can overlap). */
  saveJson(f, obj) {
    this.writes ||= new Map();
    const prev = this.writes.get(f) || Promise.resolve();
    const task = prev.then(async () => { const tmp = path.join(this.dir, `${f}.${crypto.randomBytes(3).toString("hex")}.tmp`); await fsp.writeFile(tmp, JSON.stringify(obj)); await fsp.rename(tmp, path.join(this.dir, f)); });
    this.writes.set(f, task.catch(() => {}));
    return task;
  }
  async saveItems() { await this.saveJson("items.json", Object.fromEntries(this.items)); }
  async saveTags() { await this.saveJson("tags.json", Object.fromEntries(this.tags)); }
  async saveVectors() {
    if (!this.vectors) return;
    const tmp = path.join(this.dir, "vectors.bin.tmp");
    await fsp.writeFile(tmp, Buffer.from(this.vectors.buffer, this.vectors.byteOffset, this.vectors.byteLength));
    await fsp.rename(tmp, path.join(this.dir, "vectors.bin"));
    await this.saveJson("vectors.json", { dim: this.dim, ids: this.vecIds, model: this.config.embed?.model || null });
  }
  async saveLibrary() { await this.saveJson("library.json", this.library); }
  async saveStatus() { await this.saveJson("status.json", { lastSync: this.status.lastSync }); }

  // ---- public shapes ------------------------------------------------------------------------
  summary(id, extra = {}) {
    const it = this.items.get(id); if (!it) return null;
    const t = this.tags.get(id) || {};
    return { id, title: it.title, title_zh: t.title_zh || it.title_zh || it.title, summary_zh: t.summary_zh || it.description_zh || "", tags: t.tags || [], mode: t.mode || null, manual: !!t.manual, genre: t.genre || [], model: it.model || null, duration: it.duration || null, aspect_ratio: it.aspect_ratio || null, author_handle: it.author_handle || null, source_post_url: it.source_post_url || null, source_case_url: it.source_case_url || null, video_url: it.video_url || null, image: it.image || null, category: it.category || null, published_at: it.published_at || null, language: it.language || null, has_dialogue: !!t.has_dialogue, h3_format: !!t.h3_format, prompt_length: (it.prompt || "").length, tagged: !!t.tags, ...extra };
  }
  item(id) { const it = this.items.get(id); if (!it) throw Object.assign(new Error("提示词不存在"), { status: 404 }); return { ...this.summary(id), prompt: it.prompt || "", translated_prompt: it.translated_prompt || "", description: it.description || "", author_url: it.author_url || null, source_platform: it.source_platform || null, subjects: this.tags.get(id)?.subjects || [], camera: this.tags.get(id)?.camera || [], mood: this.tags.get(id)?.mood || [], style: this.tags.get(id)?.style || [], setting: this.tags.get(id)?.setting || "" }; }
  statusInfo() {
    return { items: this.items.size, tagged: this.tags.size, embedded: this.vecIds.length, lastSync: this.status.lastSync, lastError: this.status.lastError, syncing: this.status.syncing, embed: !!this.config.embed, embedModel: this.config.embed?.model || null, tagModel: this.config.llm?.fastModel || null, source: this.config.openprompt.url };
  }
  facets() {
    const cnt = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    const models = new Map(), modes = new Map(), tags = new Map(), cats = new Map(), authors = new Map();
    for (const [id, it] of this.items) { if (it.model) cnt(models, it.model); if (it.category) cnt(cats, it.category); if (it.author_handle) cnt(authors, it.author_handle); const t = this.tags.get(id); if (t?.mode) cnt(modes, t.mode); for (const g of t?.tags || []) cnt(tags, g); }
    const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    let dialogue = 0, h3fmt = 0; for (const t of this.tags.values()) { if (t.has_dialogue) dialogue++; if (t.h3_format) h3fmt++; }
    return { total: this.items.size, models: top(models, 12), modes: top(modes, 8), tags: top(tags, 200), categories: top(cats, 30), authors: top(authors, 60), dialogue, h3fmt, library: this.library.length };
  }
  /** Keyword browse with filters. q matches title/tags/search_index (case-insensitive, all terms). */
  /** A handful of random entries, for when there is nothing typed yet to match against. Optionally biased
   *  towards a mode (t2v / i2v / ref) so the suggestions suit the shot the user is set up for. */
  random({ k = 8, h3 = false, mode = "", seed = null } = {}) {
    const pool = [];
    for (const [id, it] of this.items) {
      if (h3 && !/h3/i.test(it.model || "")) continue;
      const t = this.tags.get(id) || {};
      if (mode && t.mode && t.mode !== mode) continue;
      pool.push(id);
    }
    const out = [];
    const rng = seed != null ? mulberry(Number(seed)) : Math.random;
    const taken = new Set();
    for (let guard = 0; out.length < Math.min(k, pool.length) && guard < pool.length * 4; guard++) {
      const i = Math.floor(rng() * pool.length);
      if (taken.has(i)) continue;
      taken.add(i);
      out.push(this.summary(pool[i]));
    }
    return { mode: "random", total: pool.length, results: out };
  }

  browse({ q = "", model = "", mode = "", tag = "", category = "", h3 = false, author = "", durMin = null, durMax = null, page = 1, size = 30, sort = "recent" } = {}) {
    const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    let list = [];
    for (const [id, it] of this.items) {
      const t = this.tags.get(id) || {};
      if (model && it.model !== model) continue;
      if (author && it.author_handle !== author) continue;
      if (!durOk(it, durMin, durMax)) continue;
      if (h3 && !/h3/i.test(it.model || "")) continue;
      if (mode && t.mode !== mode) continue;
      if (category && it.category !== category) continue;
      if (tag && !(t.tags || []).includes(tag)) continue;
      if (terms.length) { const hay = `${it.title} ${t.title_zh || ""} ${t.summary_zh || ""} ${(t.tags || []).join(" ")} ${it.search_index || ""}`.toLowerCase(); if (!terms.every((w) => hay.includes(w))) continue; }
      list.push(id);
    }
    const key = sort === "likes" ? (id) => this.items.get(id).likes || 0 : (id) => Date.parse(this.items.get(id).published_at || this.items.get(id).collected_at || 0) || 0;
    list.sort((a, b) => key(b) - key(a));
    const total = list.length; page = Math.max(1, Number(page) || 1); size = Math.min(100, Math.max(1, Number(size) || 30));
    return { total, page, size, items: list.slice((page - 1) * size, page * size).map((id) => this.summary(id)) };
  }

  // ---- vector search ------------------------------------------------------------------------
  async embed(texts) {
    const e = this.config.embed; if (!e) throw new Error("没有配置向量模型（EMBED_API_KEY / OPENAI_API_KEY）");
    const res = await fetch(`${e.baseUrl}/embeddings`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${e.apiKey}` }, body: JSON.stringify({ model: e.model, input: texts }), signal: AbortSignal.timeout(120_000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`embeddings ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return j.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
  }
  async queryVector(q) {
    const key = crypto.createHash("sha1").update(q).digest("hex");
    if (this.queryCache.has(key)) return this.queryCache.get(key);
    const [v] = await this.embed([q.slice(0, 6000)]);
    if (this.queryCache.size > 300) this.queryCache.delete(this.queryCache.keys().next().value);
    this.queryCache.set(key, v);
    return v;
  }
  /** Semantic search; falls back to keyword browse when embeddings are unavailable. boost: model substring to prefer (e.g. "h3"). */
  async search({ q, k = 10, model = "", mode = "", tag = "", h3 = false, boost = "h3", author = "", durMin = null, durMax = null } = {}) {
    q = String(q || "").trim();
    if (!q) return { mode: "none", results: [] };
    if (!this.config.embed || !this.vectors || !this.vecIds.length) return { mode: "keyword", results: this.browse({ q, model, mode, tag, h3, author, durMin, durMax, size: k }).items, mine: this.libList(q).slice(0, 3).map((x) => ({ ...x, mine: true })) };
    let qv; try { qv = await this.queryVector(q); } catch (e) { this.status.lastError = e.message; return { mode: "keyword", results: this.browse({ q, model, mode, tag, h3, author, durMin, durMax, size: k }).items, error: e.message }; }
    const dim = this.dim; let qn = 0; for (let i = 0; i < dim; i++) qn += qv[i] * qv[i]; qn = Math.sqrt(qn) || 1;
    const scored = [];
    for (let r = 0; r < this.vecIds.length; r++) {
      const id = this.vecIds[r]; const it = this.items.get(id); if (!it) continue;
      const t = this.tags.get(id) || {};
      if (model && it.model !== model) continue; if (h3 && !/h3/i.test(it.model || "")) continue; if (mode && t.mode !== mode) continue; if (tag && !(t.tags || []).includes(tag)) continue;
      if (author && it.author_handle !== author) continue; if (!durOk(it, durMin, durMax)) continue;
      const off = r * dim; let dot = 0, n = 0;
      for (let i = 0; i < dim; i++) { const x = this.vectors[off + i]; dot += x * qv[i]; n += x * x; }
      let score = dot / ((Math.sqrt(n) || 1) * qn);
      if (boost && new RegExp(boost, "i").test(it.model || "")) score += 0.04;
      scored.push([score, id]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return { mode: "vector", results: scored.slice(0, k).map(([score, id]) => this.summary(id, { score: +score.toFixed(4) })), mine: this.searchLibrary(qv, 3) };
  }

  // ---- sync ------------------------------------------------------------------------------------
  async fetchText(url) {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 h3studio-prompts" }, signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return res.text();
  }
  parseConcat(js) { const i = js.indexOf(".concat("); const j = js.lastIndexOf(");"); if (i < 0 || j < 0) throw new Error("catalog chunk format changed"); return JSON.parse(js.slice(i + 8, j)); }

  /** Full pipeline: catalog → details → tags → vectors. Resumable; safe to re-run. */
  async sync({ retag = false, reembed = false, limit = 0, onlyNew = true } = {}) {
    if (this.status.syncing) throw Object.assign(new Error("同步已在进行中"), { status: 409 });
    const base = this.config.openprompt.url;
    const prog = (phase, done = 0, total = 0, note = "") => { this.status.syncing = { phase, done, total, note, started: this.status.syncing?.started || nowS() }; this.events.emitAll("prompts", this.statusInfo()); };
    try {
      prog("catalog");
      const js = await this.fetchText(`${base}/prompts-data.js`);
      const cat = JSON.parse((js.match(/PROMPT_DATA_CHUNKS = (\[.*?\]);/) || [])[1] || "[]");
      const det = JSON.parse((js.match(/PROMPT_DETAIL_CHUNKS = (\[.*?\]);/) || [])[1] || "[]");
      if (!cat.length || !det.length) throw new Error("prompts-data.js 里没有分片列表（站点结构变了？）");
      let videos = [];
      for (const [i, u] of cat.entries()) { prog("catalog", i + 1, cat.length); const arr = this.parseConcat(await this.fetchText(`${base}/${u.replace(/^\.\//, "")}`)); videos.push(...arr.filter((x) => x.media_type === "video" || x.has_video)); }
      if (limit) videos = videos.slice(0, limit);
      const need = videos.filter((v) => !onlyNew || !this.items.has(v.id));
      const byChunk = new Map();
      for (const v of need) { const c = v.detail_chunk; if (!byChunk.has(c)) byChunk.set(c, []); byChunk.get(c).push(v); }
      let done = 0;
      for (const [c, list] of byChunk) {
        prog("details", done, need.length, `chunk ${c}`);
        const u = det[c]; if (!u) continue;
        let arr; try { arr = JSON.parse(await this.fetchText(`${base}/${u.replace(/^\.\//, "")}`)); } catch (e) { this.status.lastError = e.message; continue; }
        const byId = new Map(arr.map((x) => [x.id, x]));
        for (const v of list) { const d = byId.get(v.id) || {}; const merged = { ...v, ...d }; const it = {}; for (const k of KEEP) if (merged[k] !== undefined && merged[k] !== "") it[k] = merged[k]; it.id = v.id; it.model = normalizeModel(it.model); this.items.set(v.id, it); done++; }
        await this.saveItems();
      }
      // ---- tagging with the fast model
      const toTag = [...this.items.keys()].filter((id) => !this.tags.has(id) || (retag && !this.tags.get(id)?.manual));
      if (this.config.llm && toTag.length) {
        prog("tags", 0, toTag.length);
        let tagged = 0; const batches = []; for (let i = 0; i < toTag.length; i += 8) batches.push(toTag.slice(i, i + 8));
        let bi = 0; const worker = async () => { while (bi < batches.length) { const b = batches[bi++]; try { await this.tagBatch(b); } catch (e) { this.status.lastError = `tag: ${e.message}`; await sleep(2000); } tagged += b.length; if (tagged % 40 < 8) { await this.saveTags(); prog("tags", tagged, toTag.length); } } };
        await Promise.all([worker(), worker(), worker()]);
        await this.saveTags(); prog("tags", toTag.length, toTag.length);
      }
      // ---- embeddings
      if (this.config.embed) {
        const have = new Set(reembed ? [] : this.vecIds);
        const toEmbed = [...this.items.keys()].filter((id) => !have.has(id));
        if (reembed) { this.vectors = null; this.vecIds = []; this.dim = 0; }
        prog("embed", 0, toEmbed.length);
        for (let i = 0; i < toEmbed.length; i += 48) {
          const ids = toEmbed.slice(i, i + 48);
          // OpenAI limits tokens per minute (1M for text-embedding-3-small): back off and retry the same batch.
          let vecs = null;
          for (let attempt = 0; attempt < 5 && !vecs; attempt++) {
            try { vecs = await this.embed(ids.map((id) => this.embedText(id))); }
            catch (e) { this.status.lastError = `embed: ${e.message.slice(0, 160)}`; await sleep(/429|rate/i.test(e.message) ? 25_000 * (attempt + 1) : 5000); }
          }
          if (!vecs) continue;
          this.appendVectors(ids, vecs);
          if ((i / 48) % 10 === 9) await this.saveVectors();
          prog("embed", Math.min(i + 48, toEmbed.length), toEmbed.length);
        }
        await this.saveVectors();
      }
      this.status.lastSync = nowS(); this._hosts = null; await this.saveStatus();
      return { items: this.items.size, tagged: this.tags.size, embedded: this.vecIds.length, newItems: need.length };
    } finally { this.status.syncing = null; this.events.emitAll("prompts", this.statusInfo()); }
  }
  embedText(id) { const it = this.items.get(id); const t = this.tags.get(id) || {}; return `${t.title_zh || it.title || ""}\n${t.summary_zh || ""}\n标签: ${(t.tags || []).join(" ")}\n模型: ${it.model || ""} ${it.mode || ""} ${it.duration || ""}\n${(it.prompt || "").slice(0, 5000)}`; }
  appendVectors(ids, vecs) {
    const dim = vecs[0].length;
    if (!this.vectors) { this.dim = dim; this.vectors = new Float32Array(0); }
    if (dim !== this.dim) throw new Error(`embedding dim ${dim} ≠ ${this.dim}`);
    const next = new Float32Array(this.vectors.length + ids.length * dim); next.set(this.vectors);
    ids.forEach((id, i) => { next.set(vecs[i], this.vectors.length + i * dim); this.vecIds.push(id); });
    this.vectors = next;
  }
  /** Tag a batch with the fast model. DeepSeek v4 "thinks" by default and can spend the whole completion
   *  budget on reasoning (empty content) — thinking is disabled for tagging. On a parse failure the batch
   *  is split and retried so one odd prompt cannot poison seven others. */
  async tagBatch(ids) {
    const llm = this.config.llm;
    const input = ids.map((id) => { const it = this.items.get(id); return { id, model: it.model || "", mode_hint: it.mode || "", duration: it.duration || "", title: it.title || "", prompt: (it.prompt || "").slice(0, 2500) }; });
    const system = `你是视频生成提示词的分类与打标器。对输入数组里的每条提示词输出一个 JSON 对象，最终只输出一个 JSON 数组（不要 markdown、不要解释），每项字段：
{"id": 原样, "title_zh": 不超过 20 字的中文标题, "summary_zh": 一句话中文概括（≤60 字，说清主体/场景/动作/风格）, "mode": ${JSON.stringify(MODES)} 之一（t2v 纯文字；i2v 首帧/首尾帧驱动；ref 参考图/角色一致/数字人风格参考；edit 视频编辑/换脸；avatar 音频驱动数字人；other），"genre": 最多 3 个英文小写题材（如 cinematic, comedy, ad, product, action, anime, vlog, horror, music, travel, gameplay, documentary, romance, scifi, fantasy）, "subjects": 最多 4 个中文主体, "setting": 中文场景短语, "camera": 最多 4 个英文镜头/运镜关键词, "mood": 最多 3 个中文情绪, "style": 最多 3 个中文视觉风格, "has_dialogue": 是否含对白/台词, "h3_format": 是否已是 MiniMax H3 官方格式（含 integrated_multimodal_description / subject_definitions / overall_soundscape 等字段）, "tags": 8–15 个中文短标签（2–6 字，覆盖主体、场景、风格、镜头、情绪、用途，不要重复）}`;
    const body = { model: llm.fastModel, temperature: 0.2, max_tokens: 6000, messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(input) }] };
    if (/deepseek/i.test(llm.baseUrl)) body.thinking = { type: "disabled" };
    const res = await fetch(`${llm.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`LLM ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    let text = (j.choices?.[0]?.message?.content || "").replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
    let arr = null;
    try { const start = text.indexOf("["), end = text.lastIndexOf("]"); arr = JSON.parse(text.slice(start, end + 1)); } catch {}
    if (!Array.isArray(arr)) {
      if (ids.length > 1) { const mid = Math.ceil(ids.length / 2); await this.tagBatch(ids.slice(0, mid)); await this.tagBatch(ids.slice(mid)); return; }
      throw new Error(`无法解析打标结果（finish=${j.choices?.[0]?.finish_reason}, content ${text.length} 字）`);
    }
    for (const r of arr) {
      if (!r?.id || !this.items.has(r.id)) continue;
      this.tags.set(r.id, { title_zh: String(r.title_zh || "").slice(0, 40), summary_zh: String(r.summary_zh || "").slice(0, 200), mode: MODES.includes(r.mode) ? r.mode : "other", genre: arr3(r.genre), subjects: arr3(r.subjects, 4), setting: String(r.setting || "").slice(0, 60), camera: arr3(r.camera, 4), mood: arr3(r.mood), style: arr3(r.style), has_dialogue: !!r.has_dialogue, h3_format: !!r.h3_format, tags: normalizeTags(arr3(r.tags, 15)), taggedAt: nowS(), by: llm.fastModel });
    }
  }
  startScheduler() {
    const op = this.config.openprompt;
    if (!op.autoSync) return;
    const due = () => !this.status.lastSync || nowS() - this.status.lastSync > op.syncHours * 3600;
    setTimeout(() => { if (due() && !this.status.syncing) this.sync({}).catch((e) => { this.status.lastError = e.message; }); }, 20_000);
    this.timer = setInterval(() => { if (due() && !this.status.syncing) this.sync({}).catch((e) => { this.status.lastError = e.message; }); }, 30 * 60_000);
  }

  /** Nearest neighbours of a mirrored item using its stored vector (no embedding call). */
  similar(id, k = 8) {
    const r = this.vecIds.indexOf(id);
    if (r < 0 || !this.vectors) return { results: this.browse({ q: (this.tags.get(id)?.tags || []).slice(0, 3).join(" "), size: k + 1 }).items.filter((x) => x.id !== id).slice(0, k), mode: "keyword" };
    const dim = this.dim, qv = this.vectors.subarray(r * dim, (r + 1) * dim); let qn = 0; for (let i = 0; i < dim; i++) qn += qv[i] * qv[i]; qn = Math.sqrt(qn) || 1;
    const scored = [];
    for (let row = 0; row < this.vecIds.length; row++) {
      if (row === r) continue; const off = row * dim; let dot = 0, n = 0;
      for (let i = 0; i < dim; i++) { const x = this.vectors[off + i]; dot += x * qv[i]; n += x * x; }
      scored.push([dot / ((Math.sqrt(n) || 1) * qn), this.vecIds[row]]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return { mode: "vector", results: scored.slice(0, k).map(([score, sid]) => this.summary(sid, { score: +score.toFixed(4) })).filter(Boolean) };
  }
  /** Manual corrections: override title/summary/tags; marked `manual` so a re-tag never clobbers them; re-embedded. */
  async editItem(id, { title_zh, summary_zh, tags, mode } = {}) {
    if (!this.items.has(id)) throw Object.assign(new Error("提示词不存在"), { status: 404 });
    const t = this.tags.get(id) || { tags: [] };
    if (title_zh !== undefined) t.title_zh = String(title_zh).slice(0, 60);
    if (summary_zh !== undefined) t.summary_zh = String(summary_zh).slice(0, 300);
    if (tags !== undefined) t.tags = normalizeTags((Array.isArray(tags) ? tags : String(tags).split(/[,，\s]+/)).map((x) => String(x).trim()).filter(Boolean)).slice(0, 20);
    if (mode !== undefined && MODES.includes(mode)) t.mode = mode;
    t.manual = true; t.editedAt = nowS();
    this.tags.set(id, t); await this.saveTags();
    if (this.config.embed && this.vectors) {
      const r = this.vecIds.indexOf(id);
      try { const [v] = await this.embed([this.embedText(id)]); if (r >= 0 && v.length === this.dim) { this.vectors.set(v, r * this.dim); await this.saveVectors(); } } catch (e) { this.status.lastError = `embed(edit): ${e.message.slice(0, 120)}`; }
    }
    return this.item(id);
  }

  // ---- media proxy (HLS) ------------------------------------------------------------------------
  /** Hosts we are willing to relay media from: known CDNs + whatever the mirrored items reference. */
  mediaHostAllowed(host) {
    host = String(host || "").toLowerCase();
    if (/(^|\.)cloudflarestream\.com$|(^|\.)videodelivery\.net$|^media\.beatapi\.io$|^github\.com$|(^|\.)githubusercontent\.com$|(^|\.)r2\.dev$|^cms-assets\.youmind\.com$|(^|\.)fal\.media$/.test(host)) return true;
    if (!this._hosts) { this._hosts = new Set(); for (const it of this.items.values()) for (const u of [it.video_url, it.image]) { try { if (u) this._hosts.add(new URL(u).host.toLowerCase()); } catch {} } }
    return this._hosts.has(host);
  }
  /** Fetch an upstream media URL; HLS playlists are rewritten so every URI goes back through `proxyPath`. */
  async proxyMedia(urlStr, { range = null, proxyPath = "media" } = {}) {
    let url; try { url = new URL(urlStr); } catch { throw Object.assign(new Error("bad url"), { status: 400 }); }
    const okProto = url.protocol === "https:" || (process.env.MEDIA_ALLOW_HTTP === "1" && url.protocol === "http:");
    if (!okProto || !this.mediaHostAllowed(url.host)) throw Object.assign(new Error("host not allowed"), { status: 403 });
    const headers = { "user-agent": "Mozilla/5.0 h3studio-media" }; if (range) headers.range = range;
    const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(60_000) });
    const ct = res.headers.get("content-type") || "";
    const isPlaylist = /mpegurl|x-mpegURL/i.test(ct) || /\.m3u8(\?|$)/i.test(url.pathname);
    if (isPlaylist) {
      const text = await res.text();
      const base = new URL(res.url || url);
      const wrap = (u) => { try { return `${proxyPath}?u=${encodeURIComponent(new URL(u, base).toString())}`; } catch { return u; } };
      const out = text.split(/\r?\n/).map((line) => {
        if (!line.trim()) return line;
        if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${wrap(u)}"`);
        return wrap(line.trim());
      }).join("\n");
      return { status: res.ok ? 200 : res.status, headers: { "content-type": "application/vnd.apple.mpegurl", "cache-control": "private, max-age=60" }, body: out };
    }
    const h = { "content-type": ct || "application/octet-stream", "cache-control": "private, max-age=3600" };
    for (const k of ["content-length", "content-range", "accept-ranges"]) if (res.headers.get(k)) h[k] = res.headers.get(k);
    return { status: res.status, headers: h, stream: res.body };
  }

  // ---- user library ---------------------------------------------------------------------------
  async libAdd({ name, text, mode = "", tags = [], note = "", source = null }) {
    text = String(text || "").trim(); if (!text) throw new Error("提示词为空");
    const item = { id: `l_${crypto.randomBytes(4).toString("hex")}`, name: String(name || text.split("\n")[0]).slice(0, 80), text, mode: String(mode || "").slice(0, 20), tags: (Array.isArray(tags) ? tags : String(tags).split(/[,，\s]+/)).map((t) => String(t).trim()).filter(Boolean).slice(0, 20), note: String(note || "").slice(0, 500), source, createdAt: nowS(), updatedAt: nowS(), vec: null };
    this.library.unshift(item); await this.saveLibrary();
    this.embedLibraryItem(item).catch(() => {});
    return pubLib(item);
  }
  /** Saved prompts get a vector too so they show up in recommendations ("我的"). Best effort. */
  async embedLibraryItem(item) {
    if (!this.config.embed) return;
    try { const [v] = await this.embed([`${item.name}\n标签: ${item.tags.join(" ")}\n${item.text.slice(0, 5000)}`]); item.vec = Array.from(v); await this.saveLibrary(); } catch (e) { this.status.lastError = `embed(library): ${e.message.slice(0, 120)}`; }
  }
  searchLibrary(qv, k = 3) {
    const out = [];
    for (const it of this.library) {
      if (!it.vec || it.vec.length !== qv.length) continue;
      let dot = 0, n = 0; for (let i = 0; i < qv.length; i++) { dot += it.vec[i] * qv[i]; n += it.vec[i] * it.vec[i]; }
      let qn = 0; for (let i = 0; i < qv.length; i++) qn += qv[i] * qv[i];
      out.push([dot / ((Math.sqrt(n) || 1) * (Math.sqrt(qn) || 1)), it]);
    }
    return out.sort((a, b) => b[0] - a[0]).slice(0, k).map(([score, it]) => ({ ...pubLib(it), score: +score.toFixed(4), mine: true }));
  }
  async libUpdate(id, patch) {
    const it = this.library.find((x) => x.id === id); if (!it) throw Object.assign(new Error("不存在"), { status: 404 });
    const textChanged = patch.text !== undefined && String(patch.text) !== it.text;
    for (const k of ["name", "text", "mode", "note"]) if (patch[k] !== undefined) it[k] = String(patch[k]);
    if (patch.tags !== undefined) it.tags = (Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(/[,，\s]+/)).map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
    it.updatedAt = nowS(); await this.saveLibrary();
    if (textChanged || patch.tags !== undefined) this.embedLibraryItem(it).catch(() => {});
    return pubLib(it);
  }
  /** Bulk import (from a JSON export). Items whose text already exists are skipped; vectors are computed afterwards one by one. */
  async libImport(items) {
    const have = new Set(this.library.map((x) => x.text.trim()));
    const added = [];
    for (const raw of Array.isArray(items) ? items : []) {
      const text = String(raw?.text || "").trim(); if (!text || have.has(text)) continue; have.add(text);
      const tags = (Array.isArray(raw.tags) ? raw.tags : String(raw.tags || "").split(/[,，\s]+/)).map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
      const item = { id: `l_${crypto.randomBytes(4).toString("hex")}`, name: String(raw.name || text.split("\n")[0]).slice(0, 80), text, mode: String(raw.mode || "").slice(0, 20), tags, note: String(raw.note || "").slice(0, 500), source: raw.source && typeof raw.source === "object" ? raw.source : null, createdAt: Number(raw.createdAt) || nowS(), updatedAt: nowS(), vec: null };
      this.library.unshift(item); added.push(item);
    }
    if (added.length) { await this.saveLibrary(); (async () => { for (const it of added) await this.embedLibraryItem(it).catch(() => {}); })(); }
    return { added: added.length, skipped: (Array.isArray(items) ? items.length : 0) - added.length };
  }
  async libRemove(id) { this.library = this.library.filter((x) => x.id !== id); await this.saveLibrary(); }
  libList(q = "") { const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean); return this.library.filter((x) => !terms.length || terms.every((w) => `${x.name} ${x.tags.join(" ")} ${x.text} ${x.note}`.toLowerCase().includes(w))).map(pubLib); }
}
/** "15s" / "15.083" / "00:12" → seconds (null when unknown). */
export function durSeconds(d) { if (d == null || d === "") return null; if (typeof d === "number") return d; const m = String(d).match(/^(\d+):(\d+)/); if (m) return Number(m[1]) * 60 + Number(m[2]); const n = parseFloat(String(d)); return Number.isFinite(n) ? n : null; }
const durOk = (it, durMin, durMax) => { if (durMin == null && durMax == null) return true; const d = durSeconds(it.duration); if (d == null) return false; return (durMin == null || d >= durMin) && (durMax == null || d <= durMax); };
const pubLib = (it) => { const { vec, ...rest } = it; return { ...rest, embedded: !!vec }; };
const arr3 = (v, n = 3) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x)).slice(0, n);
/** "MiniMax-H3" / "MiniMax H3" / "minimax h3" → "MiniMax H3"; other names trimmed. */
export function normalizeModel(m) { if (!m) return m; const x = String(m).trim(); if (/minimax[\s_-]*h3/i.test(x)) return "MiniMax H3"; return x.replace(/\s+/g, " "); }
const TAG_SYNONYMS = new Map(Object.entries({ "写实风格": "写实", "真实感": "写实", "超写实": "写实", "超写实风格": "写实", "写实电影": "写实", "电影质感": "电影感", "电影氛围": "电影感", "电影级": "电影感", "手持拍摄": "手持镜头", "手持摄影": "手持镜头", "手持": "手持镜头", "动作场面": "动作", "动作片": "动作", "搞笑": "幽默", "喜剧感": "喜剧", "霓虹灯": "霓虹", "霓虹灯光": "霓虹", "雨天": "雨夜", "夜景": "夜晚", "夜间": "夜晚", "城市街道": "城市", "都市": "城市", "产品广告": "广告", "商业广告": "广告", "无对白": "无台词", "有对白": "对白", "对话": "对白", "第一视角": "第一人称", "POV": "第一人称", "慢镜头": "慢动作", "3D动画": "3D", "三维动画": "3D", "二次元": "动漫", "赛博": "赛博朋克", "科幻感": "科幻", "紧张氛围": "紧张", "温馨感": "温馨", "特写镜头": "特写", "多机位": "多镜头", "多镜头切换": "多镜头", "自然光线": "自然光" }));
export function normalizeTag(t) { const x = String(t || "").trim().replace(/[。，,.!！]/g, ""); return TAG_SYNONYMS.get(x) || x; }
export function normalizeTags(list) { const out = []; for (const t of list || []) { const n = normalizeTag(t); if (n && !out.includes(n)) out.push(n); } return out; }


/** Small deterministic PRNG so "再来一批" can be reproduced from a seed when debugging. */
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
