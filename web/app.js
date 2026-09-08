/* Atelier (formerly H3 Studio) SPA — no build step. Hash routing, SSE live updates, vanilla DOM. */
(function () {
"use strict";
// ---------- tiny DOM / fetch helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
// element.append(null) would render the text "null": conditional children are common here, so filter them.
{ const _append = Element.prototype.append; Element.prototype.append = function (...kids) { return _append.apply(this, kids.flat(20).filter((k) => k != null && k !== false)); }; }
/** One click means one action. A handler that returns a promise (almost all of ours do) keeps the button
 *  disabled and shows "…" until it settles, so double-clicking "生成" cannot queue the same job twice. */
function guardClick(el, fn) {
  return async (ev) => {
    if (el.dataset.busy) { ev.preventDefault(); ev.stopImmediatePropagation(); return; }
    let r;
    try { r = fn(ev); } catch (e) { throw e; }
    if (!r || typeof r.then !== "function") return r;
    const label = el.textContent, wide = el.offsetWidth;
    el.dataset.busy = "1"; el.disabled = true; if (wide) el.style.minWidth = wide + "px"; el.textContent = "…";
    try { return await r; }
    finally { delete el.dataset.busy; el.disabled = false; el.textContent = label; el.style.minWidth = ""; }
  };
}
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v; else if (k === "style") el.style.cssText = v;
    else if (k === "onclick" && tag === "button") el.addEventListener("click", guardClick(el, v));
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v; else if (k === "value") el.value = v; else if (k in el && k !== "list" && typeof v !== "string") el[k] = v; else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(20)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
async function api(path, { method = "GET", body, raw = false, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined && !raw) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
  else if (body !== undefined) opts.body = body;
  const r = await fetch("api" + path, opts);
  if (r.status === 401) { location.href = "login"; throw new Error("未登录"); }
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { error: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const fmtT = (s) => { s = Math.max(0, Math.round(s || 0)); const m = Math.floor(s / 60), sec = s % 60; return m ? `${m} 分 ${sec} 秒` : `${sec} 秒`; };
const fmtHM = (s) => { s = Math.round(s || 0); const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60); return hh ? `${hh}h${String(mm).padStart(2, "0")}m` : `${mm}m`; };
const fmtDate = (t) => t ? new Date(t * 1000).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";
const fmtBytes = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " KB";
const fmtG = (mib) => mib == null ? "?" : (mib / 1024).toFixed(1) + " G";     // VRAM is reported in MiB everywhere
const STATUS_ZH = { queued: "排队中", starting: "检查 GPU", uploading: "上传参考", submitted: "已提交", running: "生成中", downloading: "下载中", done: "完成", error: "失败", cancelled: "已取消" };
const REF_LINKS = () => [
  { label: "H3 提示词规则", url: S.meta?.rulesUrl || "https://atelier.example.com/h3", title: "官方六段格式 + 实测结论（skill PROMPT_RULES.md 线上版）" },
  { label: "OpenPrompt 提示词库", url: "https://openprompt-virid.vercel.app/", title: "6000+ 条 AI 视频提示词，可按 MiniMax H3 / 时长 / 类型筛选" },
];
const refLinkBtns = () => REF_LINKS().map((l) => h("a", { class: "btn sm", href: l.url, target: "_blank", rel: "noopener", title: l.title }, l.label));
function toast(text, level = "info", ms = 5000) { const el = h("div", { class: "toast " + level }, text); $("#toasts").append(el); setTimeout(() => el.remove(), ms); }
const isMobile = () => window.matchMedia("(max-width:820px)").matches;
let sheetDepth = 0;
/** Dialog. On phones a non-narrow dialog is rendered as a full-screen second-level page with a
 *  back bar; a history entry is pushed so the browser/gesture back closes it instead of leaving the app. */
function modal(title, body, { actions = [], narrow = false, onClose } = {}) {
  const root = $("#modal-root");
  const asPage = isMobile() && !narrow;
  let closed = false, myDepth = 0, onPop = null;
  const closeInternal = () => { if (closed) return; closed = true; bg.remove(); if (onPop) window.removeEventListener("popstate", onPop); onClose?.(); };
  const close = () => { if (closed) return; if (asPage && history.state?.h3sSheet === myDepth) { closeInternal(); history.back(); } else closeInternal(); };
  const bg = h("div", { class: "modal-bg", onclick: (e) => { if (e.target === bg && !asPage) close(); } },
    h("div", { class: "modal" + (narrow ? " narrow" : "") },
      h("div", { class: "modal-h" }, h("button", { class: "page-bar", onclick: close }, "‹ 返回"), h("h2", null, title), h("button", { class: "ghost close-x", onclick: close }, "✕")),
      body,
      actions.length ? h("div", { class: "modal-f" }, actions.map((a) => h("button", { class: a.primary ? "primary" : a.danger ? "danger" : "", onclick: async () => { try { const r = await a.onclick?.(); if (r !== false) close(); } catch (e) { toast(e.message, "error"); } } }, a.label))) : null));
  root.append(bg);
  if (asPage) {
    myDepth = ++sheetDepth;
    history.pushState({ h3sSheet: myDepth }, "");
    onPop = () => { closeInternal(); };
    window.addEventListener("popstate", onPop);
    bg.scrollTop = 0; window.scrollTo(0, 0);
  }
  return { close, el: bg };
}
function confirm(text, { danger = false } = {}) { return new Promise((res) => { modal("确认", h("p", null, text), { narrow: true, actions: [{ label: "取消", onclick: () => res(false) }, { label: "确定", primary: !danger, danger, onclick: () => res(true) }], onClose: () => res(false) }); }); }
function copy(text) { navigator.clipboard?.writeText(text).then(() => toast("已复制", "ok", 1500)).catch(() => toast("复制失败", "error")); }

// ---------- state ----------
const S = { boxes: null, meta: null, gpu: null, jobs: new Map(), projects: [], view: null, viewArgs: null, es: null, me: null, direct: null, directOk: null, directAt: 0 };

// ---- direct GPU transfer -------------------------------------------------------------------
// 13 → GPU is per-flow shaped to ~40 KB/s; the browser reaches the box at line rate, so assets go
// straight there. The box only has a self-signed certificate (the IDC blocks ACME on 80/443 for any
// hostname), so the first time we ask the user to open it once and accept it.
async function directInfo({ maxAgeMs = 30_000 } = {}) {
  if (S.direct && Date.now() - S.directAt < maxAgeMs) return S.direct;
  try { S.direct = await api("/direct"); } catch { S.direct = { available: false, reason: "拿不到直传信息" }; }
  S.directAt = Date.now();
  return S.direct;
}
async function directReady({ offer = true } = {}) {
  const info = await directInfo();
  if (!info.available) {
    if (offer && !S.directHinted && /未开机/.test(info.reason || "")) {
      S.directHinted = true;
      toast("GPU 关机中，这次经 13 中转上传（慢十几倍）。要直传就先在仪表盘开机。", "warn", 6000);
    }
    return false;
  }
  if (S.directOk === true) return true;
  try {
    const r = await fetch(info.base + "/health", { cache: "no-store" });
    if (r.ok) { S.directOk = true; return true; }
  } catch { /* cert not accepted yet, or the box is unreachable from here */ }
  S.directOk = false;
  if (offer && !info.trusted) offerTrust(info);
  else if (offer) toast("连不上 GPU 直传（" + info.base + "），这次走 13 中转", "warn", 4000);
  return false;
}
/** Where the bytes live: on the box, mirrored on 13, or still being mirrored. */
/** Play from the box while it is on and trusted (domestic, fast); 13's mirror is the fallback. */
function jobSrc(id) { return `api/jobs/${id}/file` + (S.directOk === true && S.gpu?.state === "on" ? "?from=gpu" : ""); }
// One preview plays at a time: clicking another voice (or the same one again) stops what was playing,
// instead of stacking overlapping clips.
let previewAudio = null, previewBtn = null;
function playPreview(url, btn, { onError } = {}) {
  const same = previewBtn === btn;
  if (previewAudio) { previewAudio.pause(); previewAudio.currentTime = 0; if (previewBtn) previewBtn.textContent = "▶"; }
  previewAudio = null; previewBtn = null;
  if (same) return;
  const a = new Audio(url);
  previewAudio = a; previewBtn = btn; btn.textContent = "⏸";
  const done = () => { if (previewBtn === btn) { btn.textContent = "▶"; previewAudio = null; previewBtn = null; } };
  a.addEventListener("ended", done);
  a.play().catch((e) => { done(); onError ? onError(e) : toast("这个音色没有可试听的样本", "warn"); });
}
function whereTag(a) {
  if (a.pending) return h("span", { class: "tag", style: "left:auto;right:12px;bottom:44px;top:auto;background:#3a3a3a;color:#ccc" }, "上传中");
  if (a.gpu && !a.local) return h("span", { class: "tag", style: "left:auto;right:12px;bottom:44px;top:auto;background:#2b4a2b;color:#b6f2b6" }, "GPU · 备份中");
  if (a.gpu && a.local) return h("span", { class: "tag", style: "left:auto;right:12px;bottom:44px;top:auto;background:#243b52;color:#a8d3ff" }, "GPU + 13");
  return null;
}
function offerTrust(info) {
  if (S.trustShown) return; S.trustShown = true;
  const body = h("div", null,
    h("p", null, "素材可以从浏览器直接传到 GPU（比经过 13 中转快十几倍）。GPU 用的是自签名证书，需要你在浏览器里同意一次。"),
    h("ol", { class: "small" },
      h("li", null, "点下面的按钮打开 GPU 地址，浏览器会提示「不安全」"),
      h("li", null, "选择「高级 / 继续前往」，看到「已信任这台 GPU 机器」就好了"),
      h("li", null, "关掉那个标签页回来，再上传即可直传")),
    h("p", { class: "muted small" }, "地址：" + info.base + "　（GPU 的公网 IP，换机器时会变，届时再同意一次）"));
  modal("开启 GPU 直传", body, { narrow: true, actions: [
    { label: "以后再说", onclick: () => {} },
    { label: "打开并信任", primary: true, onclick: () => { window.open(info.trustUrl, "_blank", "noopener"); S.directOk = null; S.trustShown = false; } },
  ] });
}
const jobsSorted = () => [...S.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
const isActive = (j) => ["queued", "starting", "uploading", "submitted", "running", "downloading"].includes(j.status);

// ---------- SSE ----------
function connectEvents() {
  const es = new EventSource("api/events");
  S.es = es;
  es.addEventListener("gpu", (e) => { S.gpu = JSON.parse(e.data); renderChip(); document.dispatchEvent(new CustomEvent("gpu")); });
  es.addEventListener("job", (e) => { const j = JSON.parse(e.data); if (j.deleted) S.jobs.delete(j.id); else S.jobs.set(j.id, j); document.dispatchEvent(new CustomEvent("job", { detail: j })); });
  es.addEventListener("toast", (e) => { const t = JSON.parse(e.data); toast(t.text, t.level === "ok" ? "ok" : t.level === "error" ? "error" : t.level === "warn" ? "warn" : "info"); });
  es.addEventListener("project", (e) => document.dispatchEvent(new CustomEvent("project", { detail: JSON.parse(e.data) })));
  es.addEventListener("render", (e) => document.dispatchEvent(new CustomEvent("render", { detail: JSON.parse(e.data) })));
  es.addEventListener("models", (e) => { S.models = JSON.parse(e.data); document.dispatchEvent(new CustomEvent("models", { detail: S.models })); });
  es.addEventListener("comfy.ws", () => {});
  es.onerror = () => {};
}
/** A tiny inline utilisation history — no chart library, just a row of bars. */
function utilSpark(series) {
  const box = h("div", { class: "spark", title: "最近的显卡利用率（每 20 秒一格）" });
  for (const p of series.slice(-90)) {
    const v = Math.max(2, Math.min(100, p.util));
    box.append(h("i", { style: `height:${v}%;background:${v > 60 ? "var(--accent)" : v > 15 ? "#5b8db8" : "#3a3a3a"}`, title: `${new Date(p.at * 1000).toLocaleTimeString("zh-CN", { hour12: false })} · ${p.util}% · ${(p.vram / 1024).toFixed(1)}G · ${p.powerW}W` }));
  }
  return box;
}
function renderChip() {
  const g = S.gpu, chip = $("#gpu-chip");
  if (!g) return;
  chip.className = "gpu-chip " + g.state;
  const q = g.queue ? g.queue.running + g.queue.pending : 0;
  $(".txt", chip).textContent = { on: "GPU 在线", off: "GPU 关机", starting: "GPU 开机中…", stopping: "GPU 关机中…", unknown: "GPU 状态未知" }[g.state] + (g.state === "on" && q ? ` · 队列 ${q}` : "") + (g.cost?.currentCny ? ` · ¥${g.cost.currentCny}` : "");
}

// ---------- routing ----------
const routes = {};
function navigate() {
  const hash = location.hash.slice(1) || "/";
  const [, name = "", ...rest] = hash.split("/");
  const route = routes[name || "dash"] ? (name || "dash") : "dash";
  S.view = route; S.viewArgs = rest;
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === (route === "project" ? "projects" : route)));
  const main = $("#main"); main.innerHTML = "";
  Promise.resolve(routes[route](main, ...rest)).catch((e) => { main.append(h("div", { class: "errbox" }, e.message)); });
}
/** A local tab strip for a page that has too much on it. `panes` is [[标题, 节点], …]; the pick is
 *  remembered per page so coming back lands where you left. Reuses the .subtab pills from the voice page. */
function tabbed(panes, key = null) {
  key = key || "atelier.tabs." + (location.hash.split("/")[1] || "page");
  const bar = h("div", { class: "subtabs" }), box = h("div");
  let cur = localStorage.getItem(key);
  if (!panes.some(([t]) => t === cur)) cur = panes[0]?.[0];
  const draw = () => {
    bar.innerHTML = ""; box.innerHTML = "";
    for (const [title] of panes) bar.append(h("button", { class: "subtab" + (title === cur ? " on" : ""), onclick: () => { cur = title; try { localStorage.setItem(key, title); } catch {} draw(); } }, title));
    const pane = panes.find(([t]) => t === cur);
    if (pane) box.append(pane[1]);
  };
  draw();
  return h("div", null, bar, box);
}

const listen = (type, fn) => { document.addEventListener(type, fn); S._cleanup.push(() => document.removeEventListener(type, fn)); };
S._cleanup = [];
// One handler, and the order inside it matters: tear the old view's listeners down FIRST, then mount the new
// one. It used to be two handlers — navigate() then cleanup — and because a route body runs synchronously up
// to its first await, the cleanup pass swept away the listeners and timers the new page had just registered.
// That is why the dashboard needed a manual refresh to notice a model finishing.
window.addEventListener("hashchange", () => {
  for (const f of S._cleanup.splice(0)) f();
  $("#modal-root").innerHTML = "";
  navigate();
});

// ================= Dashboard =================
routes.dash = async (main) => {
  const g = S.gpu || await api("/gpu");
  S.gpu = g; renderChip();
  const gpuCard = h("div", { class: "card" });
  const jobsCard = h("div", { class: "card" });
  const recentCard = h("div", { class: "card" }), usageCard = h("div", { class: "card" }), modelsCard = h("div", { class: "card" });
  main.append(h("h1", null, "仪表盘"), h("div", { class: "grid g2" }, gpuCard, modelsCard), h("div", { style: "height:14px" }), jobsCard, h("div", { style: "height:14px" }), usageCard, h("div", { style: "height:14px" }), recentCard);
  let ms = S.models || null;
  async function drawModels() {
    if (!ms) { try { ms = S.models = await api("/models"); } catch (e) { modelsCard.innerHTML = ""; modelsCard.append(h("h2", null, "模型"), h("p", { class: "muted small" }, e.message)); return; } }
    modelsCard.innerHTML = "";
    const g = ms.gpu, used = g?.vram?.used ?? 0, total = g?.vram?.total || ms.vramTotal || 32607;
    const nameOf = (id) => ms.models.find((m) => m.id === id)?.name || id;
    const short = (n) => String(n).split("（")[0].split(" · ")[0].slice(0, 16);
    const chips = [];
    if (ms.loaded.video) chips.push(h("span", { class: "badge " + (ms.comfyModelsLoaded ? "on" : "") }, ms.comfyModelsLoaded ? "🎬 H3 权重在显存" : "🎬 ComfyUI 空载"));
    for (const mod of ["llm", "voice"]) if (ms.loaded[mod]) chips.push(h("span", { class: "badge on" }, `${MOD_ICON[mod]} ${nameOf(ms.loaded[mod].modelId || "?")}`));
    const busy = ms.busy;
    const taskBtn = (label, modality, on, title) => h("button", { class: "sm" + (on ? " primary" : ""), disabled: !!busy, title, onclick: async () => { try { await api("/models/ensure", { method: "POST", body: { modality } }); toast(`正在准备「${label}」…`, "info"); } catch (e) { toast(e.message, "error"); } } }, label);
    const d = ms.defaults || {};
    modelsCard.append(h("div", { class: "row between" }, h("h2", null, "模型"), h("a", { href: "#/models", class: "small" }, "模型管家 →")),
      h("div", { class: "row", style: "gap:6px;flex-wrap:wrap;margin-top:4px" }, ...(chips.length ? chips : [h("span", { class: "muted small" }, g ? "空载：显存里没有模型" : "GPU 关机")])),
      h("div", { class: "progress", style: "margin:8px 0 4px;height:8px" }, h("i", { style: `width:${Math.min(100, Math.round(100 * used / total))}%` })),
      h("div", { class: "muted small" }, g ? `显存 ${(used / 1024).toFixed(1)} / ${(total / 1024).toFixed(1)} G` : "开机后显示显存"),
      busy ? h("div", { class: "hint", style: "margin-top:6px" }, h("span", { class: "spin" }), ` ${busy.action === "load" ? "加载" : "卸载"} ${ms.modalities[busy.modality]?.label || busy.modality}：${busy.progress.at(-1)?.text || "…"}`) : null,
      h("div", { class: "row", style: "gap:6px;flex-wrap:wrap;margin-top:8px" },
        taskBtn(`🎬 视频 · ${short(nameOf(d.video || "h3"))}`, "video", !!ms.loaded.video && ms.comfyModelsLoaded, "把默认视频模型装进显存（会卸掉大模型 / 语音）"),
        taskBtn(`💬 大模型 · ${short(nameOf(d.llm || ""))}`, "llm", ms.loaded.llm?.modelId && ms.loaded.llm.modelId === d.llm, "加载默认大模型（会卸掉 H3 权重）；在「模型管家」里换默认"),
        taskBtn(`🎙 语音 · ${short(nameOf(d.voice || ""))}`, "voice", !!ms.loaded.voice, "加载默认语音模型（转写的 SenseVoice 随语音服务一起起来）"),
        h("button", { class: "sm danger", disabled: !!busy || (!ms.loaded.llm && !ms.loaded.voice && !ms.comfyModelsLoaded), onclick: async () => { try { ms = S.models = await api("/models/unload", { method: "POST", body: { modality: "all" } }); drawModels(); toast("已全部卸载", "ok"); } catch (e) { toast(e.message, "error"); } } }, "全部卸载")));
  }
  drawModels(); listen("models", (e) => { ms = S.models = e.detail; drawModels(); });
  if (!S.boxes) api("/boxes").then((b) => { S.boxes = b; drawGpu?.(); }).catch(() => {});
  async function drawUsage() {
    let rows = []; try { rows = await api("/gpu/usage?days=14"); } catch { return; }
    usageCard.innerHTML = "";
    const max = Math.max(1, ...rows.map((r) => r.seconds)); const total = rows.reduce((a, r) => a + r.cny, 0);
    usageCard.append(h("div", { class: "row between" }, h("h2", null, "GPU 用量 · 最近 14 天"), h("span", { class: "muted small" }, `合计 ¥${total.toFixed(2)} · ${fmtHM(rows.reduce((a, r) => a + r.seconds, 0))}`)),
      h("div", { style: "display:grid;grid-template-columns:repeat(14,1fr);gap:4px;align-items:end;height:110px;margin-top:6px" }, rows.map((r) => h("div", { title: `${r.day}：${fmtHM(r.seconds)} · ¥${r.cny}`, style: "display:flex;flex-direction:column;justify-content:flex-end;height:100%;gap:2px" }, h("span", { class: "muted", style: "font-size:10px;text-align:center" }, r.cny ? "¥" + r.cny : ""), h("div", { style: `height:${Math.max(2, Math.round(90 * r.seconds / max))}px;background:linear-gradient(180deg,#fbbf24,var(--accent));border-radius:3px 3px 0 0;opacity:${r.seconds ? 1 : .25}` }), h("span", { class: "muted", style: "font-size:10px;text-align:center" }, r.day.slice(5))))));
  }
  drawUsage(); listen("gpu", () => {});
  function drawGpu() {
    const g = S.gpu; gpuCard.innerHTML = "";
    const st = g.state;
    const idleLeft = g.idleSince && st === "on" && g.autoOff ? Math.max(0, g.idleMinutes * 60 - (Date.now() / 1000 - g.idleSince)) : null;
    gpuCard.append(
      h("div", { class: "row between" }, h("h2", null, "GPU ",
        h("span", { class: "badge " + st }, { on: "在线", off: "关机", starting: "开机中", stopping: "关机中", unknown: "未知" }[st]),
        // 云上还在跑、只是服务没起来，跟真的关机是两回事，说清楚免得以为状态错了
        st !== "on" && g.cloudState === "Running" ? h("span", { class: "badge", style: "margin-left:6px", title: "CompShare 上这台实例是 Running，但 ComfyUI 没连上（可能还没装好、正在启动，或隧道断了）" }, "云上在跑 · 服务未就绪") : null),
        h("div", { class: "row" },
          (S.boxes?.boxes || []).filter((b) => b.configured).length > 1 ? (() => {
            // The dropdown picks which machine you are LOOKING at. It does not move the workbench —
            // that only happens when you start that machine, or press 设为默认. Merely browsing the list
            // used to switch the fleet underneath you.
            const live = g.box?.name || S.boxes.active;
            S.viewBox = S.boxes.boxes.some((b) => b.name === S.viewBox) ? S.viewBox : live;
            const list = S.boxes.boxes.filter((b) => b.configured);
            const cloudZh = (c) => ({ Running: "云上在跑", Stopped: "云上已关机", Starting: "云上开机中", Stopping: "云上关机中" })[c] || (c || "状态未知");
            const sel = h("select", { class: "sm", style: "max-width:190px" },
              list.map((b) => h("option", { value: b.name, selected: b.name === S.viewBox },
                `${b.label || b.name}${b.name === live ? "（当前）" : ""} · ${cloudZh(b.cloudState)}`)));
            sel.onchange = () => { S.viewBox = sel.value; drawGpu(); };
            const row = [sel];
            const vb = list.find((b) => b.name === S.viewBox);
            if (vb && vb.name !== live) {
              row.push(h("button", { class: "sm primary", title: `把工作台切到这台并开机`, onclick: async () => {
                try { await api(`/boxes/${encodeURIComponent(vb.name)}/start`, { method: "POST" });
                  toast(`正在开 ${vb.label || vb.name}，工作台已切过去`, "ok", 6000);
                  S.boxes = await api("/boxes"); S.gpu = await api("/gpu"); drawGpu();
                } catch (e) { toast(e.message, "error", 8000); }
              } }, vb.cloudState === "Running" ? "用这台" : "开机并切过去"));
              row.push(h("button", { class: "sm", title: "只切换，不开机", onclick: async () => {
                try { await api(`/boxes/${encodeURIComponent(vb.name)}/activate`, { method: "POST" });
                  toast(`默认机器已设为 ${vb.label || vb.name}`, "ok");
                  S.boxes = await api("/boxes"); S.gpu = await api("/gpu"); drawGpu();
                } catch (e) { toast(e.message, "error", 8000); }
              } }, "设为默认"));
            }
            return h("span", { class: "row", style: "gap:6px" }, ...row);
          })() : null,
          h("button", { class: "sm", onclick: () => api("/gpu/probe", { method: "POST" }).then((s) => { S.gpu = s; drawGpu(); }) }, "刷新"),
          st === "off" || st === "unknown" ? h("button", { class: "sm primary", disabled: !g.canControl, onclick: () => api("/gpu/start", { method: "POST" }).then(() => toast("开机指令已发出，约 2 分钟", "info")) }, "开机") : null,
          st === "on" ? h("button", { class: "sm", disabled: !g.canControl, onclick: async () => { try { await api("/gpu/stop", { method: "POST", body: {} }); toast("已关机", "ok"); } catch (e) { if (await confirm(e.message + "\n\n强制关机？", { danger: true })) await api("/gpu/stop", { method: "POST", body: { force: true } }).then(() => toast("已强制关机", "ok")).catch((e2) => toast(e2.message, "error")); } } }, "关机") : null)),
      h("div", { class: "row", style: "gap:22px;margin:10px 0" },
        h("div", { class: "stat" },
          h("b", null, g.device ? g.device.name.replace(/^cuda:\d+ /, "").replace(/ : .*$/, "") : (S.boxes?.boxes?.find((b) => b.active)?.label || "GPU")),
          h("span", null, g.device ? `显存 ${Math.round(g.device.vramTotal / 2 ** 30)} GB · ComfyUI ${g.comfyVersion || "?"}`
            : st === "on" ? "正在读取显卡信息…" : st === "starting" ? "开机中，约 2 分钟后显示显卡信息" : "关机中；开机后显示显卡型号与显存")),
        h("div", { class: "stat" }, h("b", null, g.queue ? `${g.queue.running} 跑 / ${g.queue.pending} 等` : "—"), h("span", null, "ComfyUI 队列（含其它会话）" + (g.queue?.etaSeconds ? ` · 预计 ${fmtT(g.queue.etaSeconds)} 清空` : ""))),
        h("div", { class: "stat" }, h("b", null, `¥${g.cost?.todayCny ?? 0}`), h("span", null, `今日 ${fmtHM(g.cost?.todaySeconds)} · 累计 ¥${g.cost?.totalCny ?? 0}`)),
        st === "on" ? h("div", { class: "stat" }, h("b", null, fmtHM(g.cost?.currentSeconds)), h("span", null, `本次开机 · ¥${g.cost?.currentCny}`)) : null,
        st === "on" && g.stats ? h("div", { class: "stat" }, h("b", null, `${g.stats.now?.util ?? 0}%`), h("span", null, `显卡利用率 · 本次均 ${g.stats.utilAvg}% / 峰 ${g.stats.utilMax}%`)) : null,
        st === "on" && g.stats ? h("div", { class: "stat" }, h("b", null, fmtHM(g.stats.busySeconds)), h("span", null, `本次真正在算（${g.stats.busyPct}% 的开机时间）`)) : null),
      st === "on" && g.stats ? h("div", { class: "muted small", style: "margin-top:6px" },
        `显存峰值 ${fmtG(g.stats.vramMaxMib)} / 均 ${fmtG(g.stats.vramAvgMib)} · 显存带宽均 ${g.stats.memUtilAvg}% · 功耗均 ${g.stats.powerAvgW}W 峰 ${g.stats.powerMaxW}W · 最高温 ${g.stats.tempMax}°C · 本次用电 ${g.stats.energyWh} Wh · 采样 ${g.stats.samples} 次`) : null,
      st === "on" && g.stats?.series?.length > 2 ? utilSpark(g.stats.series) : null,
      st === "on" && g.autoOff && g.activity?.busy ? h("div", { class: "hint" }, "自动关机暂缓：" + g.activity.why.join("；")) :
      idleLeft != null ? h("div", { class: "hint" }, `空闲中，${fmtT(idleLeft)} 后自动关机（${g.idleMinutes} 分钟无任务）`) : st === "on" && !g.autoOff ? h("div", { class: "hint warn" }, "自动关机已关闭，记得手动关机（¥" + g.hourlyRate + "/小时）") : null,
      g.lastError ? h("div", { class: "errbox", style: "margin-top:8px" }, g.lastError) : null,
      g.queue?.items?.length ? h("table", { style: "margin-top:10px" }, h("tr", null, h("th", null, "任务"), h("th", null, "来源"), h("th", null, "规格"), h("th", null, "状态")), g.queue.items.map((it) => h("tr", null, h("td", { class: "mono" }, it.promptId.slice(0, 8)), h("td", null, (it.clientId === "h3studio" || it.clientId === "atelier") ? "本站" : it.clientId || "?"), h("td", null, `${it.weights || ""} ${it.width || "?"}×${it.height || "?"} ${it.length || "?"}帧 ${it.steps || "?"}步`), h("td", null, it.running ? "运行中" : "排队")))) : null,
      h("details", { style: "margin-top:10px" }, h("summary", { class: "muted small" }, "电源设置"),
        h("div", { class: "row", style: "margin-top:8px" },
          h("label", { class: "inline" }, h("input", { type: "checkbox", checked: g.autoOff, onchange: (e) => api("/gpu/settings", { method: "PATCH", body: { autoOff: e.target.checked } }).then((s) => { S.gpu = s; drawGpu(); }) }), "空闲自动关机"),
          h("label", { class: "inline" }, "空闲分钟 ", h("input", { type: "number", min: 1, max: 120, value: g.idleMinutes, style: "width:70px", onchange: (e) => api("/gpu/settings", { method: "PATCH", body: { idleMinutes: Number(e.target.value) } }).then((s) => { S.gpu = s; drawGpu(); }) })),
          h("label", { class: "inline" }, h("input", { type: "checkbox", checked: g.autoOn, onchange: (e) => api("/gpu/settings", { method: "PATCH", body: { autoOn: e.target.checked } }).then((s) => { S.gpu = s; drawGpu(); }) }), "生成时自动开机"),
          h("label", { class: "inline" }, "¥/小时 ", h("input", { type: "number", step: "0.01", value: g.hourlyRate, style: "width:80px", onchange: (e) => api("/gpu/settings", { method: "PATCH", body: { hourlyRate: Number(e.target.value) } }).then((s) => { S.gpu = s; drawGpu(); }) })),
          g.instanceId ? h("span", { class: "muted small mono" }, g.instanceId) : h("span", { class: "muted small" }, "未配置 CompShare，无法自动开关机"))));
  }
  function drawJobs() {
    jobsCard.innerHTML = "";
    const active = jobsSorted().filter(isActive);
    jobsCard.append(h("div", { class: "row between" }, h("h2", null, `进行中 (${active.length})`), h("a", { href: "#/generate", class: "btn" }, "＋ 新建生成")));
    if (!active.length) jobsCard.append(h("p", { class: "muted" }, "没有进行中的任务。"));
    for (const j of active) jobsCard.append(jobCard(j));
  }
  function drawRecent() {
    recentCard.innerHTML = "";
    const recent = jobsSorted().filter((j) => !isActive(j)).slice(0, 12);
    recentCard.append(h("div", { class: "row between" }, h("h2", null, "最近完成"), h("a", { href: "#/jobs" }, "全部任务 →")));
    if (!recent.length) recentCard.append(h("p", { class: "muted" }, "还没有任务。去「快速生成」跑第一条吧。"));
    recentCard.append(h("div", { class: "grid g4" }, recent.map((j) => h("div", { class: "asset", onclick: () => jobDetail(j.id) }, j.output ? h("img", { class: "thumb", src: `api/jobs/${j.id}/poster` }) : h("div", { class: "thumb", style: "display:grid;place-items:center;color:#666" }, STATUS_ZH[j.status]), h("div", { class: "name" }, j.title), h("div", { class: "meta" }, `${j.width}×${j.height} · ${j.seconds}s · ${fmtDate(j.createdAt)}`)))));
  }
  drawGpu(); drawJobs(); drawRecent();
  listen("gpu", drawGpu); listen("job", () => { drawJobs(); drawRecent(); });
  const t = setInterval(drawGpu, 15000); S._cleanup.push(() => clearInterval(t));
};

function jobCard(j) {
  const pct = j.progress?.max ? Math.round(100 * j.progress.value / j.progress.max) : 0;
  const el = h("div", { class: "job", onclick: () => jobDetail(j.id) },
    j.output ? h("img", { src: `api/jobs/${j.id}/poster` }) : h("div", { style: "width:120px;aspect-ratio:16/9;background:#000;border-radius:6px;display:grid;place-items:center;color:#555;font-size:12px" }, STATUS_ZH[j.status] || j.status),
    h("div", { class: "col", style: "gap:4px;min-width:0" },
      h("div", { class: "row between" }, h("div", { class: "ttl" }, j.title), h("span", { class: "badge " + j.status }, STATUS_ZH[j.status] || j.status)),
      h("div", { class: "muted small" }, `${S.meta?.workflows?.[j.workflow]?.label || j.workflow} · ${j.width}×${j.height} · ${j.length}帧≈${j.seconds}s · ${j.steps}步 · seed ${j.seed}`),
      isActive(j) ? h("div", { class: "progress" + (j.status === "running" && j.progress ? "" : " indet") }, h("i", { style: `width:${j.status === "running" && j.progress ? pct : 35}%` })) : null,
      h("div", { class: "muted small" }, j.log?.at(-1)?.text || "", j.status === "running" && j.progress ? ` · ${j.progress.value}/${j.progress.max} 步` : "", j.elapsed ? ` · ${fmtT(j.elapsed)}` : "", isActive(j) && j.eta != null ? (j.status === "running" ? ` · 剩余约 ${fmtT(j.eta)}` : j.queuePosition != null && j.queuePosition > 0 ? ` · 前面 ${j.queuePosition} 个 · 预计 ${fmtT(j.eta)}` : ` · 预计 ${fmtT(j.eta)}`) : ""),
      j.warning ? h("div", { class: "warn small" }, j.warning) : null),
    isActive(j) ? h("button", { class: "sm danger stop", title: "停止这个任务", onclick: async (ev) => { ev.stopPropagation(); await stopJob(j); } }, "停止") : null);
  return el;
}

/** Stop an active job: queued ones just flip to cancelled, a running one interrupts ComfyUI. */
async function stopJob(j) {
  if (!(await confirm(`停止「${j.title}」？${j.status === "running" ? "正在采样的这条会被中断，已消耗的时间不退。" : ""}`, { danger: true }))) return;
  try { await api(`/jobs/${j.id}/cancel`, { method: "POST" }); toast("已停止", "ok"); }
  catch (e) { toast(e.message, "error"); }
}

// ================= Prompt templates =================
const TPL = {
  native_t2v: `integrated_multimodal_description: [Shot 1] Live-action, cinematic, a medium-wide shot frames … The camera holds a static shot. … (S1) says in a calm voice: <d>[Chinese] 台词</d>. [Shot 2] At 00:03.000, the camera cuts to …

overall_soundscape: Quiet room tone, …

non_diegetic_music: N/A`,
  native_i2v: `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, cinematic … starting exactly from <Picture 1>. The camera pushes in with small amplitude at slow speed. …

overall_soundscape: …

non_diegetic_music: N/A`,
  native_i2v_last: `Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the {END}-second mark of the target video.

integrated_multimodal_description: [Shot 1] Live-action … the shot begins exactly as <Picture 1> and ends exactly as <Picture 2>. …

overall_soundscape: …

non_diegetic_music: N/A`,
  native_ref2va: `subject_definitions:
<Subject 1> is CHARACTER A. Her face and identity come from <Picture 1>: <脸型、发型、眼镜、耳环等客观描述>. Her wardrobe comes from <Picture 2>: <固定服装>.
<Subject 2> is the room in <Picture 2>: LEFT background = …; CENTER = …; RIGHT = …
<Picture 2> is also the composition anchor: camera position, <Subject 1> screen-left.

summary:
[reference generation] One static shot of <Subject 1> inside <Subject 2>: <一句话剧情>.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - facial identity, proportions, apparent age, hairstyle and wardrobe are retained unchanged.
<Subject 2> (appears in [Shot 1]): fully_preserved - layout, furniture, colors and lighting are retained and never mirrored, rotated or rearranged.

detailed_description:
The target video is a realistic live-action scene, clean digital cinema camera, 24 fps, natural skin texture, no beauty filter. No subtitles, no on-screen text.
[Shot 1] A static medium shot, 35mm lens, … <Subject 1> (S1) says in a calm voice, <d>[Chinese] 台词</d>. The camera holds a static shot.

overall_soundscape:
Quiet room tone, …

non_diegetic_music:
N/A`,
  continue: `subject_definitions:
<Subject 1> is CHARACTER A, whose face and identity come from <Picture 1>: <脸的描述>. Wardrobe and position come from <Video 1>.
<Video 1> is the previous shot of this same scene, ending in the exact state the target video must start from: same room, same people in their final positions and poses, same framing and lighting.

summary:
[video continuation] The target video continues directly from the end of <Video 1>: <一句话说接下来发生什么>.

retention_analysis:
<Subject 1>: fully_preserved - facial identity, proportions, apparent age, hairstyle and wardrobe are retained unchanged.
<Video 1> (continuation source): partially_preserved - the final state of <Video 1> (positions, poses, wardrobe, framing, lighting) is continued seamlessly; its earlier frames are not repeated.

detailed_description:
The target video is the same live-action scene as <Video 1>, same look, same lighting.
[Shot 1] The same static shot as the end of <Video 1>, picking up the action without a cut. <接下来的动作/台词> <Subject 1> (S1) says, <d>[Chinese] 台词</d> The camera holds a static shot.

overall_soundscape:
The same room tone as <Video 1> continues.

non_diegetic_music:
N/A`,
  swap: `subject_definitions:
<Subject 1> is a completely different person from the <原片里的人描述> in <Video 1>. The face, hair and glasses come from <Picture 1> and <Picture 2>, several views of the same person: <脸的描述>. Everything else comes from that person in <Video 1>: the clothing, the body, the positions in the frame, the gestures, the head and mouth movements, the timing and the expressions. <Subject 1> does not keep the clothing or background of the photos.
<Video 1> is the source video for the target video edit; every other person in it is kept exactly as they are. Its camera, framing, cuts, lighting, background and timing are kept.
<Audio 1> is the synchronized audio track of <Video 1> and is reused in the target video.

summary:
[video editing + audio reuse] The target video is an edited version of <Video 1>: the referenced person is replaced by <Subject 1>, with the face and hair from the reference pictures. Everyone else, all clothing, the scene, the camera, the cuts and the original dialogue from <Audio 1> stay exactly the same.

retention_analysis:
<Subject 1>: fully_preserved - the facial identity, face shape, eyes, nose, lips, skin tone, apparent age and hairstyle from the reference pictures are retained in every frame; the original person's face and hair are not retained.
<Video 1> (source video): partially_preserved - shots, cuts, camera, framing, background, lighting, timing, all clothing, bodies, positions, gestures, head and mouth movements are retained; only the referenced person's face and hair are replaced.
<Audio 1>: fully_copy - reused 1:1 as the complete final audio track.

detailed_description:
The target video is the live-action footage of <Video 1>, same look, same lighting.
[Shot 1] … <Subject 1> (S1) says, <d>[English] 原台词</d>

overall_soundscape:
The complete original soundtrack of <Audio 1> continues throughout.

non_diegetic_music:
N/A`,
};
const MODES = [
  { id: "t2v", workflow: "native_t2v", label: "文生视频", desc: "只靠文字，fl2va 权重，4 步" },
  { id: "i2v", workflow: "native_i2v", label: "首帧 / 首尾帧", desc: "一张图定开头，可选尾帧" },
  { id: "ref", workflow: "native_ref2va", label: "参考图 · 角色一致", desc: "人脸/母图保持一致，数字人" },
  { id: "video", workflow: "native_ref2va", label: "参考视频 · 换脸/动作", desc: "源视频+人脸，或续接/运镜参考", video: true },
];

// ================= Quality tiers =================
/** <select> that fills width/height/steps/refSize inputs from a tier; keeps portrait orientation if the current size is portrait. */
function qualitySelect({ wEl, hEl, stepsEl, refSizeEl, workflow = () => "native_ref2va", onApply = () => {} }) {
  const q = S.meta.quality || {};
  const sel = h("select", null, h("option", { value: "" }, "质量档位…"), Object.entries(q).map(([k, v]) => h("option", { value: k, title: v.desc }, `${v.label} · ${v.size[0]}×${v.size[1]}`)));
  sel.onchange = () => {
    const t = q[sel.value]; if (!t) return;
    const portrait = Number(wEl.value) < Number(hEl.value);
    wEl.value = portrait ? t.size[1] : t.size[0]; hEl.value = portrait ? t.size[0] : t.size[1];
    if (stepsEl) stepsEl.value = t.steps[workflow()] ?? t.steps.native_ref2va;
    if (refSizeEl) refSizeEl.value = t.refSize;
    onApply(sel.value, t);
  };
  return sel;
}

// ================= LoRA select =================
/** <select> + strength input for the acceleration LoRA. value → { name, strength, disabled } | null */
function loraControl(initial = null, workflow = () => "native_ref2va") {
  const sel = h("select", null, h("option", { value: "" }, "模板默认（加速 LoRA）"), h("option", { value: "__off" }, "关闭加速 LoRA（步数 20+）"));
  const strength = h("input", { type: "number", step: 0.1, min: 0, max: 2, placeholder: "1.0", style: "width:70px", value: initial?.strength ?? "" });
  const load = async () => { try { const r = await api("/loras"); for (const n of r.items) sel.append(h("option", { value: n }, n.replace(/\.safetensors$/, ""))); if (initial?.name) sel.value = initial.name; if (initial?.disabled) sel.value = "__off"; if (!r.items.length) sel.append(h("option", { value: "", disabled: true }, "（GPU 开机后可读取列表）")); } catch {} };
  load();
  const el = h("div", { class: "row" }, h("div", { style: "flex:1" }, sel), h("label", { class: "inline small" }, "强度 ", strength));
  el.value = () => sel.value === "__off" ? { disabled: true } : sel.value ? { name: sel.value, strength: strength.value === "" ? null : Number(strength.value) } : strength.value !== "" ? { strength: Number(strength.value) } : null;
  return el;
}

// ================= Asset picker =================
async function pickAssets(projectId, { kind = "image", multi = true, title = "选择素材" } = {}) {
  const p = await api(`/projects/${projectId}`);
  return new Promise((resolve) => {
    const sel = new Set();
    const grid = h("div", { class: "grid g4" });
    const draw = () => {
      grid.innerHTML = "";
      const list = p.assets.filter((a) => (!kind || a.kind === kind) && !a.pending).sort((a, b) => b.createdAt - a.createdAt);
      if (!list.length) grid.append(h("p", { class: "muted" }, "这个项目里还没有" + (kind === "video" ? "视频" : kind === "audio" ? "音频" : "图片") + "素材，先上传。"));
      for (const a of list) grid.append(h("div", { class: "asset" + (sel.has(a.id) ? " sel" : ""), onclick: () => { if (!multi) { resolve([a.id]); m.close(); return; } sel.has(a.id) ? sel.delete(a.id) : sel.add(a.id); draw(); } },
        h("img", { class: "thumb", src: `api/projects/${p.id}/assets/${a.id}/thumb` }), h("div", { class: "name" }, a.name), h("div", { class: "meta" }, a.kind === "video" ? `${a.duration}s ${a.width}×${a.height}` : a.kind === "audio" ? `${a.duration}s 音频` : `${a.width}×${a.height}`)));
    };
    draw();
    const up = uploadBox(p.id, async () => { const np = await api(`/projects/${p.id}`); p.assets = np.assets; draw(); }, kind === "video" ? "video/*,.mp4,.mov" : kind === "audio" ? "audio/*,.mp3,.wav,.m4a,.aac" : "image/*,.heic,.HEIC");
    const m = modal(title, h("div", null, up, h("div", { style: "height:10px" }), grid), { actions: multi ? [{ label: "取消", onclick: () => resolve([]) }, { label: `选用 (${sel.size})`, primary: true, onclick: () => resolve([...sel]) }] : [], onClose: () => resolve([]) });
    if (multi) { const btn = m.el.querySelector(".modal-f button.primary"); const obs = new MutationObserver(() => { btn.textContent = `选用 (${sel.size})`; }); obs.observe(grid, { childList: true, subtree: true }); }
  });
}
function uploadBox(projectId, onDone, accept = "image/*,video/*,audio/*,.heic,.HEIC,.mp4,.mov,.mp3,.wav,.m4a,.aac") {
  const input = h("input", { type: "file", multiple: true, accept, style: "display:none", onchange: () => doUpload([...input.files]) });
  const label = h("div", null, "点击或拖入文件上传（图片 JPG/PNG/HEIC，视频 MP4/MOV）");
  const bar = h("div", { class: "progress", style: "margin-top:8px", hidden: true }, h("i"));
  const box = h("div", { class: "drop", onclick: (e) => { if (e.target.tagName !== "INPUT") input.click(); }, ondragover: (e) => { e.preventDefault(); box.classList.add("over"); }, ondragleave: () => box.classList.remove("over"), ondrop: (e) => { e.preventDefault(); box.classList.remove("over"); doUpload([...e.dataTransfer.files]); } }, label, bar, input);
  function xhrPut(url, body, { headers = {}, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
      xhr.onload = () => { let j = {}; try { j = JSON.parse(xhr.responseText); } catch {} if (xhr.status >= 200 && xhr.status < 300) resolve(j); else reject(new Error(j.error || `HTTP ${xhr.status}`)); };
      xhr.onerror = () => reject(new Error("网络错误"));
      xhr.send(body);
    });
  }
  /** Relay through 13 (the old path): safe everywhere, but 13 → GPU is slow when the job runs. */
  function putViaServer(f, onProgress) {
    return xhrPut(`api/projects/${projectId}/assets?name=${encodeURIComponent(f.name)}`, f, { headers: { "content-type": "application/octet-stream" }, onProgress });
  }
  /** Straight to the GPU box: 13 hands out the id + a signed URL, the bytes never cross the slow leg. */
  async function putDirect(f, onProgress, say) {
    say("登记素材…");
    const r = await api(`/projects/${projectId}/assets/direct`, { method: "POST", body: { name: f.name } });
    try { await xhrPut(`${r.put}&t=${encodeURIComponent(r.token)}`, f, { onProgress }); }
    catch (e) {
      // do not leave a 0-byte placeholder behind when the transfer dies
      await api(`/projects/${projectId}/assets/${r.asset.id}`, { method: "DELETE" }).catch(() => {});
      throw e;
    }
    say("GPU 处理中（转码 / 缩略图）…");
    const a = await api(`/projects/${projectId}/assets/${r.asset.id}/direct-done`, { method: "POST", body: {} });
    say("已在 GPU 上，正在后台同步一份到 13");
    return a;
  }
  async function doUpload(files) {
    if (!files.length) return;
    bar.hidden = false;
    for (const [i, f] of files.entries()) {
      const tag = files.length > 1 ? `[${i + 1}/${files.length}] ` : "";
      label.textContent = `${tag}上传 ${f.name} (${fmtBytes(f.size)}) 0%`;
      bar.firstChild.style.width = "0%";
      const head = `${tag}${f.name} (${fmtBytes(f.size)})`;
      const say = (what) => { label.textContent = `${head} · ${what}`; };
      const prog = (where) => (r) => { const pct = Math.round(r * 100); bar.firstChild.style.width = pct + "%"; say(`${where} ${pct}%`); };
      say("准备中…");
      try {
        if (await directReady()) {
          try { await putDirect(f, prog("直传 GPU"), say); toast(`已直传到 GPU：${f.name}`, "ok", 2000); continue; }
          catch (e) { S.directOk = false; toast(`直传失败，改走 13 中转：${e.message}`, "warn", 4000); }
        }
        say("经 13 上传…");
        await putViaServer(f, prog("上传到 13"));
        say("服务器处理中（转码 / 缩略图）…");
        toast(`已上传 ${f.name}`, "ok", 2000);
      } catch (e) { toast(`${f.name}: ${e.message}`, "error"); }
    }
    bar.hidden = true; label.textContent = "点击或拖入文件上传（图片 JPG/PNG/HEIC，视频 MP4/MOV）"; input.value = "";
    onDone?.();
  }
  return box;
}

// ================= LLM prompt assistant =================
function llmAssist({ mode, seconds, refs, existing, onResult }) {
  if (!S.meta?.llm) { toast("服务器没有配置 LLM_API_KEY，提示词助手不可用", "warn"); return; }
  const idea = h("textarea", { placeholder: "用中文描述你想要的画面、人物、台词、氛围…\n例如：两姐妹在客厅沙发上找充电器，姐姐问妹妹有没有看到，妹妹装没听见。夜晚、暖光、情景喜剧感。", style: "min-height:140px" });
  const lang = h("select", null, ["Chinese", "English", "Japanese", "Korean"].map((l) => h("option", { value: l }, l)));
  const refInputs = refs.map((r) => h("input", { placeholder: `<${r.kind === "video" ? "Video" : "Picture"} ${r.index}> 是什么？（例如：姐姐的正面头肩照 / 客厅全景母图）`, value: r.desc || "" }));
  const status = h("div", { class: "hint" });
  const deep = h("input", { type: "checkbox" });
  const body = h("div", null, h("label", null, "你的想法"), idea, h("label", null, "台词语言"), lang, h("label", { class: "inline", style: "margin-top:8px" }, deep, "深度思考（更细致，约 2 分钟；默认约 10 秒）"), refs.length ? h("label", null, "参考素材说明（按编号）") : null, refInputs, h("p", { class: "hint" }, "助手（", S.meta.llmModel || "LLM", "）会按 ", h("a", { href: S.meta.rulesUrl, target: "_blank" }, "官方六段格式与实测规则"), " 输出英文提示词，生成后仍可手工修改；找灵感可看 ", h("a", { href: "https://openprompt-virid.vercel.app/", target: "_blank", rel: "noopener" }, "OpenPrompt 提示词库"), "。"), status);
  modal("AI 帮我写提示词", body, { actions: [{ label: "取消" }, { label: "生成提示词", primary: true, onclick: async () => {
    if (!idea.value.trim()) { status.textContent = "先写点想法。"; return false; }
    status.textContent = deep.checked ? "深度思考中（约 2 分钟）…" : "正在生成（约 10 秒）…";
    const r = await api("/llm/prompt", { method: "POST", body: { mode, idea: idea.value, seconds, dialogueLang: lang.value, existing, deep: deep.checked, refs: refs.map((x, i) => ({ ...x, desc: refInputs[i].value })) } });
    onResult(r.prompt);
  } }] });
}


/** 改写：框里已经有一段提示词（自己写的，或从库里带过来的），说一句要改成什么，
 *  把「原文 + 要求 + H3 规则」一起交给助手。跟「AI 助手」不同——那个是从零写。 */
function llmRewrite({ current, mode, seconds, dialogueLang = "Chinese", onResult }) {
  if (!String(current || "").trim()) { toast("编辑框里还没有内容，先写一段或从推荐里选一条", "warn"); return; }
  const want = h("textarea", { placeholder: "要改成什么？用中文说。\n例如：把台词换成两句更口语的；机位改成缓慢推近；把夜景改成清晨；姐姐改成戴眼镜。", style: "min-height:120px" });
  const deep = h("input", { type: "checkbox" });
  const status = h("div", { class: "hint" });
  const before = h("pre", { style: "max-height:150px;overflow:auto;white-space:pre-wrap;font-size:12px" }, current);
  modal("AI 改写这段提示词", h("div", null,
    h("label", null, "要改什么"), want,
    h("label", { class: "inline", style: "margin-top:8px" }, deep, "深度思考（更稳，约 2 分钟；默认约 10 秒）"),
    h("details", { style: "margin-top:8px" }, h("summary", { class: "muted small" }, "改写前的原文"), before),
    h("p", { class: "hint" }, "只改你说的地方，其余段落、参考图编号、时间对齐句原样保留。规则与你的要求冲突时以 ",
      h("a", { href: (S.meta?.rulesUrl || "#"), target: "_blank", rel: "noopener" }, "H3 规则"), " 为准。"),
    status), {
    actions: [{ label: "取消" }, { label: "改写", primary: true, onclick: async () => {
      if (!want.value.trim()) { status.textContent = "先说一下要改成什么。"; return false; }
      status.textContent = deep.checked ? "深度思考中（约 2 分钟）…" : "改写中（约 10 秒）…";
      const r = await api("/llm/rewrite", { method: "POST", body: { current, want: want.value, mode, seconds, dialogueLang, deep: deep.checked } });
      onResult(r.prompt);
      toast("已改写，原文可以用编辑器的撤销找回", "ok");
    } }],
  });
}

// ================= Prompt tools: save / library picker / OpenPrompt recommendations =================
function saveToLibrary({ text, mode = "", source = null }) {
  if (!text || !text.trim()) return toast("提示词为空", "warn");
  const name = h("input", { value: (text.split("\n").find((l) => l.trim()) || "").replace(/^[a-z_]+:\s*/i, "").slice(0, 60) });
  const tags = h("input", { placeholder: "逗号分隔，例如：情景喜剧, 客厅, 两人" });
  const note = h("input", { placeholder: "备注（可选）" });
  modal("保存到我的提示词", h("div", null, h("label", null, "名称"), name, h("label", null, "标签"), tags, h("label", null, "备注"), note, h("pre", { style: "max-height:200px" }, text.slice(0, 1500) + (text.length > 1500 ? "…" : ""))), { narrow: true, actions: [{ label: "取消" }, { label: "保存", primary: true, onclick: async () => { await api("/library", { method: "POST", body: { name: name.value, text, mode, tags: tags.value, note: note.value, source } }); toast("已保存到我的提示词", "ok"); } }] });
}
function libraryPicker({ onPick }) {
  const q = h("input", { placeholder: "搜索名称 / 标签 / 内容" });
  const list = h("div", { class: "col", style: "margin-top:8px;max-height:60vh;overflow:auto" });
  const draw = async () => {
    const items = await api("/library?q=" + encodeURIComponent(q.value));
    list.innerHTML = "";
    if (!items.length) list.append(h("p", { class: "muted" }, "还没有保存的提示词。在提示词框旁点「保存提示词」，或在提示词库里收藏。"));
    for (const it of items) list.append(h("div", { class: "card tight", style: "cursor:pointer", onclick: () => { onPick(it); m.close(); } }, h("div", { class: "row between" }, h("b", null, it.name), h("span", { class: "muted small" }, [it.mode, ...(it.tags || [])].filter(Boolean).join(" · "))), h("div", { class: "muted small", style: "white-space:pre-wrap;max-height:3.2em;overflow:hidden" }, it.text.slice(0, 200))));
  };
  q.oninput = () => draw();
  const m = modal("从我的提示词插入", h("div", null, q, list));
  draw();
}
function promptPreview(item, { onUse } = {}) {
  const body = h("div");
  const draw = (full) => {
    body.innerHTML = "";
    const hd = body.parentElement?.querySelector(".modal-h h2"); if (hd && (full.title_zh || full.title)) hd.textContent = full.title_zh || full.title;
    body.append(
      h("div", { class: "row", style: "gap:6px;flex-wrap:wrap;margin-bottom:6px" }, (full.tags || []).map((t) => h("span", { class: "badge" }, t)), full.model ? h("span", { class: "badge on" }, full.model) : null, full.duration ? h("span", { class: "badge" }, full.duration) : null, full.mode ? h("span", { class: "badge" }, full.mode) : null, full.h3_format ? h("span", { class: "badge done" }, "H3 官方格式") : null, full.manual ? h("span", { class: "badge done" }, "已人工修正") : null,
        !String(full.id).startsWith("l_") ? h("button", { class: "sm ghost", onclick: () => { const ti = h("input", { value: full.title_zh || "" }), tg = h("input", { value: (full.tags || []).join(", ") }), sm = h("input", { value: full.summary_zh || "" }), md = h("select", null, ["t2v", "i2v", "ref", "edit", "avatar", "other"].map((x) => h("option", { value: x, selected: full.mode === x }, x))); modal("修正标签", h("div", null, h("label", null, "中文标题"), ti, h("label", null, "标签（逗号分隔）"), tg, h("label", null, "一句话概括"), sm, h("label", null, "模式"), md, h("p", { class: "hint" }, "人工修正会被保留，全量重打标不会覆盖；保存后自动重新向量化。")), { narrow: true, actions: [{ label: "取消" }, { label: "保存", primary: true, onclick: async () => { const r = await api(`/prompts/item/${encodeURIComponent(full.id)}`, { method: "PATCH", body: { title_zh: ti.value, tags: tg.value, summary_zh: sm.value, mode: md.value } }); toast("已保存修正", "ok"); draw(r); } }] }); } }, "修正标签") : null),
      full.summary_zh ? h("p", { class: "muted small" }, full.summary_zh) : null,
      full.video_url ? videoEl(full.video_url, full.image) : full.image ? h("img", { src: full.image, style: "max-width:100%;max-height:40vh;border-radius:8px" }) : null,
      // 复制/收藏/去快速生成 挪到提示词上方，跟溯源同一行、靠右
      (() => { const acts = [h("button", { class: "sm", onclick: () => copy(full.prompt) }, "复制"), onUse ? h("button", { class: "sm primary", onclick: () => { onUse(full.prompt, "replace"); m.close(); } }, "替换到编辑框") : null, onUse ? h("button", { class: "sm", onclick: () => { onUse(full.prompt, "append"); m.close(); } }, "追加到末尾") : null, String(full.id).startsWith("l_") ? null : h("button", { class: "sm", onclick: () => saveToLibrary({ text: full.prompt, mode: full.mode || "", source: { type: "openprompt", id: full.id, url: full.source_post_url } }) }, "收藏到我的提示词"), h("button", { class: "sm", onclick: () => { S.clone = { mode: full.mode === "ref" ? "ref" : full.mode === "i2v" ? "i2v" : full.mode === "edit" ? "video" : "t2v", projectId: S.projects[0]?.id || "default", images: [], videos: [], prompt: full.prompt, title: full.title_zh || full.title }; m.close(); location.hash = "#/generate/clone"; } }, "去快速生成")];
        const src = [full.source_post_url ? h("a", { href: full.source_post_url, target: "_blank", rel: "noopener" }, "原帖" + (full.author_handle ? " @" + full.author_handle : "")) : null,
          full.source_case_url ? h("a", { href: full.source_case_url, target: "_blank", rel: "noopener" }, "案例页") : null,
          full.video_url ? h("a", { href: full.video_url, target: "_blank", rel: "noopener" }, "视频文件") : null,
          S.meta?.openprompt ? h("a", { href: `${S.meta.openprompt}/`, target: "_blank", rel: "noopener" }, "OpenPrompt") : null].filter(Boolean);
        return h("div", { class: "row small", style: "margin:8px 0;gap:8px;flex-wrap:wrap" },
          src.length ? h("span", { class: "muted" }, "溯源：") : null, ...src, h("span", { style: "flex:1" }), ...acts.filter(Boolean));
      })(),
      h("pre", { style: "max-height:45vh" }, full.prompt || ""),
      full.translated_prompt ? h("details", null, h("summary", { class: "muted small" }, "译文"), h("pre", null, full.translated_prompt)) : null,
      !String(full.id).startsWith("l_") ? (() => { const box = h("div", { class: "col", style: "gap:6px;margin-top:10px" }, h("div", { class: "muted small" }, "相似提示词加载中…")); api(`/prompts/item/${encodeURIComponent(full.id)}/similar?k=6`).then((r) => { box.innerHTML = ""; box.append(h("div", { class: "muted small" }, "相似提示词" + (r.mode === "vector" ? "（向量近邻）" : ""))); for (const it of r.results) box.append(h("div", { class: "card tight", style: "cursor:pointer;padding:6px 10px", onclick: () => promptPreview(it, { onUse }) }, h("div", { class: "row between" }, h("b", { class: "small" }, it.title_zh || it.title), h("span", { class: "muted small" }, [it.model, it.duration, it.score != null ? Math.round(it.score * 100) + "%" : null].filter(Boolean).join(" · "))), h("div", { class: "muted small" }, (it.tags || []).slice(0, 6).join(" · ")))); }).catch(() => { box.innerHTML = ""; }); return box; })() : null,
      );
  };
  const m = modal(item.title_zh || item.title, body);
  draw(item.prompt !== undefined ? item : { ...item, prompt: "加载中…" });
  if (item.prompt === undefined) api(`/prompts/item/${encodeURIComponent(item.id)}`).then(draw).catch((e) => toast(e.message, "error"));
}
/** <video> that also plays HLS (.m3u8, used by most OpenPrompt entries) via hls.js, with an open-in-new-tab fallback. */
function videoEl(url, poster) {
  const v = h("video", { class: "player", controls: true, preload: "metadata", style: "max-height:40vh", poster: poster || null, playsinline: true });
  const wrap = h("div", null, v);
  const fallback = () => { if (wrap.querySelector(".hint")) return; wrap.append(h("div", { class: "hint" }, "视频无法在此播放（跨域或格式限制），", h("a", { href: url, target: "_blank", rel: "noopener" }, "在新窗口打开"))); };
  if (/\.m3u8(\?|$)/i.test(url)) {
    // HLS goes through our same-origin relay (the CDN's CORS headers reject browsers); the relay rewrites playlists.
    const src = "api/prompts/media?u=" + encodeURIComponent(url);
    if (window.Hls && window.Hls.isSupported()) { const hls = new window.Hls({ enableWorker: false, xhrSetup: (xhr) => { xhr.withCredentials = true; } }); hls.on(window.Hls.Events.ERROR, (_e, d) => { if (d.fatal) { hls.destroy(); fallback(); } }); hls.loadSource(src); hls.attachMedia(v); }
    else if (v.canPlayType("application/vnd.apple.mpegurl")) v.src = src; else fallback();
  } else { v.src = url; v.onerror = () => { v.onerror = null; v.src = "api/prompts/media?u=" + encodeURIComponent(url); v.onerror = fallback; }; }
  return wrap;
}
/** Row of buttons + a recommendation panel bound to a textarea. */
function promptTools(textarea, { mode = () => "", h3Only = () => true } = {}) {
  const panel = h("div", { hidden: true, style: "margin-top:8px" });
  const list = h("div", { class: "col", style: "gap:6px" });
  const status = h("div", { class: "hint" });
  let timer = null, lastQ = "", auto = true;
  const getText = () => textarea.value, setText = (t, how) => { textarea.value = how === "append" ? (textarea.value.trim() ? textarea.value.replace(/\s+$/, "") + "\n\n" + t : t) : t; textarea.dispatchEvent(new Event("input")); };
  async function search(force = false) {
    const q = getText().trim(); if (!force && q === lastQ) return; lastQ = q;
    if (q.length < 6) return showRandom();          // nothing to match against yet — show something to steal from
    status.textContent = "正在匹配 OpenPrompt…";
    try {
      const r = await api(`/prompts/search?q=${encodeURIComponent(q.slice(0, 1500))}&k=8${h3Only() ? "&h3=1" : ""}`);
      list.innerHTML = "";
      status.textContent = r.results.length ? `${r.mode === "vector" ? "语义匹配" : "关键词匹配"} · ${r.results.length} 条，点开查看` : (r.error ? "匹配失败：" + r.error : "没有匹配的提示词" + (S.promptStatus?.items ? "" : "（提示词库还没同步，去「提示词库」页面同步）"));
      for (const it of (r.mine || []).filter((x) => x.score == null || x.score > 0.35)) list.append(h("div", { class: "card tight", style: "cursor:pointer;padding:6px 10px;border-color:var(--accent)", onclick: () => promptPreview({ id: it.id, title_zh: it.name, tags: it.tags, mode: it.mode, prompt: it.text, summary_zh: it.note }, { onUse: setText }) }, h("div", { class: "row between" }, h("b", { class: "small" }, "★ " + it.name), h("span", { class: "muted small" }, ["我的提示词", it.score != null ? Math.round(it.score * 100) + "%" : null].filter(Boolean).join(" · "))), h("div", { class: "muted small" }, (it.tags || []).slice(0, 6).join(" · "))));
      for (const it of r.results) list.append(h("div", { class: "card tight", style: "cursor:pointer;padding:6px 10px", onclick: () => promptPreview(it, { onUse: setText }) }, h("div", { class: "row between" }, h("b", { class: "small" }, it.title_zh || it.title), h("span", { class: "muted small" }, [it.model, it.duration, it.score != null ? Math.round(it.score * 100) + "%" : null].filter(Boolean).join(" · "))), h("div", { class: "muted small" }, (it.tags || []).slice(0, 6).join(" · ") || it.summary_zh || "")));
    } catch (e) { status.textContent = e.message; }
  }
  /** With an empty box there is nothing to match, so offer a random handful from the library — the point
   *  of the panel is to give you a starting shot, not only to match one you already wrote. */
  async function showRandom() {
    status.textContent = "从提示词库里随机挑几条…";
    try {
      const r = await api(`/prompts/random?k=8${h3Only() ? "&h3=1" : ""}`);
      list.innerHTML = "";
      status.innerHTML = "";
      status.append(h("span", null, `随机推荐 ${r.results.length} 条（库里 ${r.total} 条${h3Only() ? " H3" : ""}）`), " ",
        h("button", { class: "sm ghost", onclick: () => showRandom() }, "再来一批"));
      for (const it of r.results) list.append(h("div", { class: "card tight", style: "cursor:pointer;padding:6px 10px", onclick: () => promptPreview(it, { onUse: setText }) },
        h("div", { class: "row between" }, h("b", { class: "small" }, it.title_zh || it.title || it.id), h("span", { class: "muted small" }, it.model || "")),
        it.summary_zh ? h("div", { class: "muted small" }, it.summary_zh.slice(0, 70)) : null));
      lastQ = "";
    } catch (e) { status.textContent = e.message; }
  }
  textarea.addEventListener("input", () => { if (!auto || panel.hidden) return; clearTimeout(timer); timer = setTimeout(() => search(), 1200); });
  const toggle = h("button", { class: "sm", onclick: () => { panel.hidden = !panel.hidden; toggle.classList.toggle("primary", !panel.hidden); if (!panel.hidden) search(true); } }, "OpenPrompt 推荐");
  const h3cb = h("input", { type: "checkbox", checked: h3Only(), onchange: () => { h3Only = () => h3cb.checked; search(true); } });
  panel.append(h("div", { class: "row between" }, status, h("div", { class: "row" }, h("label", { class: "inline small" }, h3cb, "只看 MiniMax H3"), h("label", { class: "inline small" }, h("input", { type: "checkbox", checked: true, onchange: (e) => { auto = e.target.checked; } }), "边写边匹配"), h("button", { class: "sm ghost", onclick: () => search(true) }, "刷新"))), list);
  // 「从库插入」去掉了：OpenPrompt 推荐就在下面，要翻自己的库直接去「提示词」页搜。
  const bar = h("div", { class: "row", style: "margin-top:6px" },
    h("button", { class: "primary", onclick: () => saveToLibrary({ text: getText(), mode: mode() }) }, "💾 保存提示词"),
    toggle);
  // 参考链接放最下面，用链接不用按钮
  const links = h("p", { class: "muted small", style: "margin-top:10px" }, "参考：",
    h("a", { href: (S.meta?.rulesUrl || "#"), target: "_blank", rel: "noopener" }, "H3 提示词规则"), "　·　",
    h("a", { href: "https://openprompt-virid.vercel.app/", target: "_blank", rel: "noopener" }, "OpenPrompt 提示词库"));
  return h("div", null, bar, panel, links);
}

// ================= Quick generate =================
routes.generate = async (main, arg) => {
  const meta = S.meta;
  const projects = await api("/projects"); S.projects = projects;
  const preset = arg === "clone" && S.clone ? S.clone : null; S.clone = null;
  const st = { mode: preset?.mode || "t2v", projectId: preset?.projectId || projects[0]?.id || "default", images: preset?.images || [], lastFrame: preset?.lastFrame || null, videos: preset?.videos || [], videoAudio: preset?.videoAudio || false, width: preset?.width || 832, height: preset?.height || 448, seconds: preset?.seconds || 5, steps: preset?.steps || null, seed: preset?.seed ?? "", refSize: preset?.refSize || "max", prompt: preset?.prompt || "", title: preset?.title || "" };
  const assetsCache = {};
  const assetOf = async (id) => { if (!assetsCache[st.projectId]) assetsCache[st.projectId] = (await api(`/projects/${st.projectId}`)).assets; return assetsCache[st.projectId].find((a) => a.id === id); };
  const left = h("div", { class: "col", style: "gap:14px" }), right = h("div", { class: "col" });
  main.append(h("h1", null, "快速生成"), h("div", { class: "grid gen-grid", style: "grid-template-columns:minmax(0,1.6fr) minmax(300px,1fr)" }, left, right));
  const promptEl = h("textarea", { class: "tall", placeholder: "提示词（英文，按官方格式）。点「插入模板」或「AI 助手」开始。", value: st.prompt, oninput: () => { st.prompt = promptEl.value; } });
  const wEl = h("input", { type: "number", step: 32, min: 64, max: 2048, value: st.width }), hEl = h("input", { type: "number", step: 32, min: 64, max: 2048, value: st.height });
  const secEl = h("input", { type: "range", min: 2, max: 15, step: 0.5, value: st.seconds }), secLbl = h("span", { class: "mono" });
  const stepsEl = h("input", { type: "number", min: 1, max: 30, placeholder: "默认" , value: st.steps || "" }), seedEl = h("input", { type: "number", placeholder: "留空 = 随机", value: st.seed });
  const refSizeEl = h("select", null, h("option", { value: "max" }, "max（脸最像，慢）"), h("option", { value: "match" }, "match（快）"));
  refSizeEl.value = st.refSize;
  const titleEl = h("input", { placeholder: "可选，方便在任务列表里认出来", value: st.title });
  const loraEl = loraControl(preset?.lora || null, () => mode().workflow);
  const batchOn = h("input", { type: "checkbox" }), batchCount = h("input", { type: "number", min: 1, max: 24, value: 4, style: "width:70px" }), batchVariants = h("textarea", { placeholder: "每行一个变体（可选）。提示词里写 {{v}} 作为替换位置；没有 {{v}} 就追加到末尾。", style: "min-height:70px" });
  const projEl = h("select", { onchange: () => { st.projectId = projEl.value; st.images = []; st.videos = []; st.lastFrame = null; drawRefs(); } }, projects.map((p) => h("option", { value: p.id }, p.name)));
  projEl.value = st.projectId;
  const sizeSel = h("select", { onchange: () => { const [w, hh] = sizeSel.value.split("x").map(Number); if (w) { wEl.value = w; hEl.value = hh; } } }, h("option", { value: "" }, "尺寸预设…"), meta.sizes.map((s) => h("option", { value: `${s.w}x${s.h}` }, s.label)));
  const qualEl = qualitySelect({ wEl, hEl, stepsEl, refSizeEl, workflow: () => mode().workflow, onApply: (k, t) => toast(`${t.label}：${t.desc}`, "info", 2500) });
  const refsBox = h("div"), modeBox = h("div", { class: "mode-cards" }), estEl = h("div", { class: "hint" });
  const updSec = () => { const f = 5 + Math.max(1, Math.round((secEl.value * 24 - 5) / 17)) * 17; secLbl.textContent = `${secEl.value}s → ${f} 帧 ≈ ${(f / 24).toFixed(2)}s`; };
  secEl.oninput = updSec; updSec();
  function drawModes() { modeBox.innerHTML = ""; for (const m of MODES) modeBox.append(h("div", { class: "mode-card" + (st.mode === m.id ? " sel" : ""), onclick: () => { st.mode = m.id; drawModes(); drawRefs(); } }, h("b", null, m.label), h("span", null, m.desc))); }
  const mode = () => MODES.find((m) => m.id === st.mode);
  async function refTile(id, label, onRemove, isVideo = false) {
    const a = await assetOf(id);
    return h("div", { class: "ref" }, h("img", { src: `api/projects/${st.projectId}/assets/${id}/thumb`, title: a?.name }), h("span", { class: "lbl" }, label), h("button", { class: "x", onclick: onRemove }, "✕"));
  }
  async function drawRefs() {
    refsBox.innerHTML = "";
    const m = mode();
    if (m.id === "t2v") { refsBox.append(h("p", { class: "hint" }, "文生视频不使用参考素材。")); return; }
    const box = h("div", { class: "refs" });
    if (m.id === "i2v") {
      box.append(st.images[0] ? await refTile(st.images[0], "首帧", () => { st.images = []; drawRefs(); }) : h("div", { class: "ref add", onclick: async () => { const [id] = await pickAssets(st.projectId, { multi: false, title: "选择首帧" }); if (id) { st.images = [id]; drawRefs(); } } }, "＋ 首帧"));
      box.append(st.lastFrame ? await refTile(st.lastFrame, "尾帧", () => { st.lastFrame = null; drawRefs(); }) : h("div", { class: "ref add", onclick: async () => { const [id] = await pickAssets(st.projectId, { multi: false, title: "选择尾帧" }); if (id) { st.lastFrame = id; drawRefs(); } } }, "＋ 尾帧(可选)"));
      refsBox.append(box); return;
    }
    for (const [i, id] of st.images.entries()) box.append(await refTile(id, `<Picture ${i + 1}>`, () => { st.images.splice(i, 1); drawRefs(); }));
    if (st.images.length < 9) box.append(h("div", { class: "ref add", onclick: async () => { const ids = await pickAssets(st.projectId, { multi: true, title: "选择参考图（按顺序即 <Picture N>）" }); st.images.push(...ids.filter((x) => !st.images.includes(x))); st.images = st.images.slice(0, 9); drawRefs(); } }, "＋ 参考图"));
    refsBox.append(h("div", { class: "hint" }, "参考图顺序 = 提示词里的 <Picture N>。人脸用头肩裁图（1024 短边），母图放最后。"), box, adviceBox);
    scheduleAdvice();
    if (m.video) {
      const vb = h("div", { class: "refs", style: "margin-top:8px" });
      for (const [i, id] of st.videos.entries()) vb.append(await refTile(id, `<Video ${i + 1}>`, () => { st.videos.splice(i, 1); drawRefs(); }));
      if (st.videos.length < 3) vb.append(h("div", { class: "ref add", onclick: async () => { const ids = await pickAssets(st.projectId, { kind: "video", multi: true, title: "选择参考视频（2–15 秒，先用「切段」处理）" }); st.videos.push(...ids.filter((x) => !st.videos.includes(x))); st.videos = st.videos.slice(0, 3); drawRefs(); } }, "＋ 参考视频"));
      refsBox.append(h("div", { class: "hint", style: "margin-top:8px" }, "参考视频 = <Video N>，24fps、2–15 秒、帧数 17k+5（用项目素材里的「切段」工具处理）。"), vb, h("label", { class: "inline", style: "margin-top:6px" }, h("input", { type: "checkbox", checked: st.videoAudio, onchange: (e) => { st.videoAudio = e.target.checked; } }), "把参考视频的音轨也给模型（<Audio N>，换脸必开）"));
    }
  }
  drawModes(); drawRefs(); setTimeout(refreshAdvice, 300);
  const insertTpl = () => { const m = mode(); let t = m.id === "video" ? TPL.swap : m.id === "i2v" && st.lastFrame ? TPL.native_i2v_last.replace("{END}", Number(secEl.value).toFixed(2)) : TPL[m.workflow]; if (promptEl.value.trim() && !confirmSync("覆盖当前提示词？")) return; promptEl.value = t; st.prompt = t; };
  const confirmSync = (t) => window.confirm(t);
  const refsMeta = () => [...st.images.map((id, i) => ({ kind: "image", index: i + 1, id })), ...st.videos.map((id, i) => ({ kind: "video", index: i + 1, id }))];
  left.append(
    h("div", { class: "card" }, h("div", { class: "row between" }, h("h2", null, "模式"), h("label", { class: "inline" }, "项目 ", projEl)), modeBox, h("div", { style: "height:10px" }), refsBox),
    h("div", { class: "card" }, h("div", { class: "row between" }, h("h2", null, "提示词"), h("div", { class: "row" }, h("button", { class: "sm", onclick: insertTpl }, "插入模板"), h("button", { class: "sm", onclick: () => { if (st.mode !== "video") { st.mode = "video"; drawModes(); drawRefs(); } if (promptEl.value.trim() && !confirmSync("覆盖当前提示词？")) return; promptEl.value = TPL.continue; st.prompt = TPL.continue; } }, "续接模板"), h("button", { class: "sm", onclick: () => llmAssist({ mode: st.mode === "video" ? "swap" : st.mode, seconds: Number(secEl.value), refs: refsMeta(), existing: promptEl.value, onResult: (t) => { promptEl.value = t; st.prompt = t; } }) }, "✨ AI 助手"), h("button", { class: "sm", title: "在现有内容上按你的新要求改写，其余原样保留", onclick: () => llmRewrite({ current: promptEl.value, mode: st.mode === "video" ? "swap" : st.mode, seconds: Number(secEl.value), onResult: (t) => { promptEl.value = t; st.prompt = t; } }) }, "✏️ AI 改写"))), promptEl, promptTools(promptEl, { mode: () => st.mode === "video" ? "edit" : st.mode }), h("div", { class: "hint" }, "台词写 <d>[Chinese] …</d>，5 秒放 1–2 句；相机不动要明说 The camera holds a static shot；不要配乐写 non_diegetic_music: N/A。")));
  const adviceBox = h("div", { style: "margin-top:6px" });
  let adviceTimer = null;
  async function refreshAdvice() {
    const m = mode();
    if (!m.refs || (!st.images.length && !st.videos.length)) { adviceBox.innerHTML = ""; return; }
    try {
      const r = await api("/jobs/advice", { method: "POST", body: { projectId: st.projectId, prompt: promptEl.value, images: st.images, videos: st.videos, width: Number(wEl.value), height: Number(hEl.value) } });
      adviceBox.innerHTML = "";
      if (!r.advice.length) return adviceBox.append(h("div", { class: "hint" }, "参考图检查：没发现问题。"));
      for (const a of r.advice) adviceBox.append(h("div", { class: a.level === "error" ? "errbox" : a.level === "warn" ? "warn" : "hint", style: "margin-top:4px" },
        (a.level === "error" ? "✗ " : a.level === "warn" ? "⚠ " : "· ") + a.text, a.fix ? h("div", { class: "muted small" }, a.fix) : null));
    } catch { adviceBox.innerHTML = ""; }
  }
  const scheduleAdvice = () => { clearTimeout(adviceTimer); adviceTimer = setTimeout(refreshAdvice, 700); };
  promptEl.addEventListener("input", scheduleAdvice);

  const submit = async () => {
    const m = mode();
    const spec = { projectId: st.projectId, title: titleEl.value.trim(), workflow: m.workflow, prompt: promptEl.value, width: Number(wEl.value), height: Number(hEl.value), seconds: Number(secEl.value), steps: stepsEl.value ? Number(stepsEl.value) : undefined, seed: seedEl.value !== "" ? Number(seedEl.value) : undefined, refSize: refSizeEl.value, images: m.id === "t2v" ? [] : st.images, lastFrame: m.id === "i2v" ? st.lastFrame : null, videos: m.video ? st.videos : [], videoAudio: m.video && st.videoAudio, lora: loraEl.value() };
    if (!spec.prompt.trim()) return toast("提示词为空", "error");
    if (spec.width % 32 || spec.height % 32) return toast("宽高必须是 32 的倍数", "error");
    if (spec.lora?.disabled && (!spec.steps || spec.steps < 12)) return toast("关闭加速 LoRA 后步数要 20 左右，请填步数", "warn");
    try {
      if (batchOn.checked) { const variants = batchVariants.value.split("\n").map((x) => x.trim()).filter(Boolean); const r = await api("/jobs/batch", { method: "POST", body: { spec, count: Number(batchCount.value) || 1, seedStart: spec.seed, variants, title: spec.title } }); toast(`已排队 ${r.jobs.length} 条（组 ${r.title}）`, "ok"); for (const j of r.jobs) S.jobs.set(j.id, j); }
      else { const j = await api("/jobs", { method: "POST", body: spec }); toast(`已排队：${j.title}`, "ok"); S.jobs.set(j.id, j); }
      titleEl.value = "";                       // the title is per-take; the prompt and parameters stay for the next one
      drawQueue();
      qcard.classList.add("flash"); setTimeout(() => qcard.classList.remove("flash"), 900);
    } catch (e) { toast(e.message, "error"); }
  };
  right.append(h("div", { class: "card" }, h("h2", null, "参数"),
    h("label", null, "质量档位（一键填参数，下面仍可手改）"), qualEl,
    h("label", null, "尺寸（32 的倍数）"), h("div", { class: "row" }, h("div", { style: "flex:1" }, wEl), "×", h("div", { style: "flex:1" }, hEl)), sizeSel,
    h("label", null, "时长 ", secLbl), secEl,
    h("div", { class: "row" }, h("div", { style: "flex:1" }, h("label", null, "步数（t2v/i2v 4，ref 8）"), stepsEl), h("div", { style: "flex:1" }, h("label", null, "Seed"), seedEl)),
    h("label", null, "参考图分辨率（仅参考模式）"), refSizeEl,
    h("label", null, "加速 LoRA"), loraEl,
    h("label", null, "标题"), titleEl, estEl,
    h("details", { style: "margin-top:8px" }, h("summary", { class: "muted small" }, "批量生成（seed 扫描 / 提示词变体）"), h("label", { class: "inline", style: "margin-top:6px" }, batchOn, "启用批量"), h("label", null, "每个提示词跑几个 seed"), batchCount, h("label", null, "提示词变体"), batchVariants, h("p", { class: "hint" }, "一次最多 48 条，完成后在「任务」页按组查看对照表。")),
    h("button", { class: "primary", style: "width:100%;margin-top:12px;padding:12px", onclick: submit }, "🎬 生成"),
    h("div", { class: "hint" }, S.gpu?.state === "off" ? "GPU 当前关机，提交后会自动开机（约 2 分钟）再生成。" : "")));
  const qcard = h("div", { class: "card" });
  right.append(qcard);
  function drawQueue() { qcard.innerHTML = ""; const list = jobsSorted().slice(0, 8); qcard.append(h("h2", null, "任务动态"), ...(list.length ? list.map(jobCard) : [h("p", { class: "muted" }, "暂无")])); }
  drawQueue(); listen("job", drawQueue);
};

// ================= Projects =================
routes.projects = async (main) => {
  const list = await api("/projects"); S.projects = list;
  const grid = h("div", { class: "grid g3" });
  main.append(h("div", { class: "row between" }, h("h1", null, "项目"), h("button", { class: "primary", onclick: newProject }), ), h("p", { class: "muted" }, "一个项目 = 一组素材 + 共享的人物/场景定义 + 若干片段。分段生成后按顺序拼接、加字幕、出成片。"), grid);
  $("button.primary", main).textContent = "＋ 新建项目";
  for (const p of list) grid.append(h("div", { class: "card", style: "cursor:pointer", onclick: () => { location.hash = `#/project/${p.id}`; } }, h("h2", null, p.name), h("div", { class: "muted small" }, `${p.kind === "free" ? "自由工作区" : "分段场景"} · ${p.clips} 段 · ${p.assets} 素材 · ${p.renders} 成片`), h("div", { class: "muted small" }, `${p.settings.width}×${p.settings.height} · ${p.settings.seconds}s/段 · ${S.meta.workflows[p.settings.workflow]?.label || p.settings.workflow}`), h("div", { class: "muted small" }, "更新 " + fmtDate(p.updatedAt))));
  function newProject() {
    const name = h("input", { placeholder: "例如：两姐妹找充电器" });
    const wf = h("select", null, Object.entries(S.meta.workflows).map(([k, v]) => h("option", { value: k }, v.label)));
    wf.value = "native_ref2va";
    const size = h("select", null, S.meta.sizes.map((s) => h("option", { value: `${s.w}x${s.h}` }, s.label)));
    const sec = h("input", { type: "number", value: 5, min: 2, max: 15, step: 0.5 });
    modal("新建项目", h("div", null, h("label", null, "名称"), name, h("label", null, "默认模式"), wf, h("label", null, "默认尺寸"), size, h("label", null, "每段时长（秒）"), sec), { narrow: true, actions: [{ label: "取消" }, { label: "创建", primary: true, onclick: async () => { const [w, hh] = size.value.split("x").map(Number); const p = await api("/projects", { method: "POST", body: { name: name.value || "未命名项目", kind: "scene", settings: { workflow: wf.value, width: w, height: hh, seconds: Number(sec.value), steps: wf.value === "native_ref2va" ? 8 : 4 } } }); location.hash = `#/project/${p.id}`; } }] });
  }
};

routes.project = async (main, id, tab = "clips", sub = "") => {
  let usage = null, unrefOnly = sub === "unref";
  let p = await api(`/projects/${id}`);
  const open = new Set();
  let curEdit = null;
  let curAvatar = null;
  const head = h("div"), body = h("div");
  main.append(head, body);
  const tabs = [["clips", "片段"], ["masters", "母图"], ["edits", "视频编辑"], ["avatars", "数字人"], ["settings", "设定"], ["assets", "素材"], ["renders", "成片"]];
  function drawHead() {
    head.innerHTML = "";
    const nameEl = h("input", { value: p.name, style: "font-size:20px;font-weight:700;background:transparent;border-color:transparent;padding:4px 6px;width:auto;min-width:300px", onchange: () => save({ name: nameEl.value }) });
    head.append(h("div", { class: "row between" }, h("div", { class: "row" }, h("a", { href: "#/projects", class: "muted" }, "← 项目"), nameEl), h("div", { class: "row" }, h("span", { class: "muted small" }, `${p.settings.width}×${p.settings.height} · ${p.settings.seconds}s · ${S.meta.workflows[p.settings.workflow]?.label}`), p.id !== "default" ? h("button", { class: "sm danger", onclick: async () => { if (await confirm("删除整个项目（含素材、任务产物、成片）？", { danger: true })) { await api(`/projects/${p.id}`, { method: "DELETE" }); location.hash = "#/projects"; } } }, "删除项目") : null)),
      h("div", { class: "tabs" }, tabs.map(([k, l]) => h("a", { href: `#/project/${p.id}/${k}`, class: k === tab ? "active" : "" }, l))));
  }
  async function save(patch) { p = await api(`/projects/${p.id}`, { method: "PATCH", body: patch }); drawHead(); }
  async function reload() { p = await api(`/projects/${p.id}`); }
  drawHead();
  let bodyDraw = 0;
  const draw = { settings: drawSettings, assets: drawAssets, clips: drawClips, renders: drawRenders, edits: drawEdits, masters: drawMasters, avatars: drawAvatars }[tab] || drawClips;
  await draw();
  listen("project", async (e) => { if (e.detail.id === p.id && !e.detail.deleted && tab !== "settings") { await reload(); await draw(); } });
  listen("job", (e) => { if (e.detail.projectId === p.id && tab === "masters" && (e.detail.tags || [])[0] === "master") drawMasters(); if (e.detail.projectId === p.id && tab === "avatars" && (e.detail.tags || [])[0] === "avatar") drawAvatarTakes(e.detail.tags[1]); });
  listen("job", (e) => { if (e.detail.projectId === p.id && tab === "clips") drawTakesOnly(e.detail); if (e.detail.projectId === p.id && tab === "edits" && (e.detail.tags || [])[0] === "edit") drawEditTakes(e.detail.tags[1]); });

  // ---- settings tab ----
  function drawSettings() {
    body.innerHTML = "";
    const s = p.settings, sh = p.shared;
    const wf = h("select", null, Object.entries(S.meta.workflows).map(([k, v]) => h("option", { value: k }, v.label))); wf.value = s.workflow;
    const w = h("input", { type: "number", step: 32, value: s.width }), hh = h("input", { type: "number", step: 32, value: s.height }), sec = h("input", { type: "number", step: 0.5, min: 2, max: 15, value: s.seconds }), steps = h("input", { type: "number", value: s.steps }), rs = h("select", null, h("option", { value: "max" }, "max"), h("option", { value: "match" }, "match")); rs.value = s.refSize;
    const sizeSel = h("select", { onchange: () => { const [a, b] = sizeSel.value.split("x").map(Number); if (a) { w.value = a; hh.value = b; } } }, h("option", { value: "" }, "尺寸预设…"), S.meta.sizes.map((x) => h("option", { value: `${x.w}x${x.h}` }, x.label)));
    const qualEl = qualitySelect({ wEl: w, hEl: hh, stepsEl: steps, refSizeEl: rs, workflow: () => wf.value });
    const loraEl = loraControl(s.lora || null, () => wf.value);
    const ta = (k, ph, tall) => h("textarea", { class: tall ? "tall" : "", placeholder: ph, value: sh[k] || "" });
    const subjects = ta("subjects", "<Subject 1> is CHARACTER A, whose face and identity come from <Picture 1>: … Her wardrobe comes from <Picture 3>: …\n<Subject 3> is the living room in <Picture 3>: LEFT background = …, CENTER = …, RIGHT = …", true);
    const retention = ta("retention", "<Subject 1> (appears in [Shot 1]): fully_preserved - facial identity, proportions, apparent age, hairstyle … retained unchanged.\n<Subject 3>: fully_preserved - layout … never mirrored, rotated or rearranged.");
    const style = ta("style", "The target video is a realistic live-action multi-camera sitcom scene inside <Subject 3>, clean digital cinema camera, 24 fps, natural skin texture, no beauty filter. No subtitles, no on-screen text.");
    const sound = ta("soundscape", "Quiet apartment room tone, faint refrigerator hum …");
    const music = h("input", { value: sh.music || "N/A" });
    const notes = h("textarea", { placeholder: "剧本、分镜、备注……", value: p.notes || "" });
    const refsBox = h("div", { class: "refs" });
    const drawRefs = () => { refsBox.innerHTML = ""; p.refs.forEach((aid, i) => { const a = p.assets.find((x) => x.id === aid); refsBox.append(h("div", { class: "ref" }, h("img", { src: `api/projects/${p.id}/assets/${aid}/thumb`, title: a?.name }), h("span", { class: "lbl" }, `<Picture ${i + 1}>`), h("button", { class: "x", onclick: async () => { await save({ refs: p.refs.filter((x) => x !== aid) }); drawRefs(); } }, "✕"))); }); if (p.refs.length < 9) refsBox.append(h("div", { class: "ref add", onclick: async () => { const ids = await pickAssets(p.id, { multi: true, title: "选择共享参考图（顺序 = <Picture N>）" }); await save({ refs: [...p.refs, ...ids.filter((x) => !p.refs.includes(x))].slice(0, 9) }); drawRefs(); } }, "＋ 参考图")); };
    drawRefs();
    body.append(h("div", { class: "grid g2" },
      h("div", { class: "card" }, h("h2", null, "生成参数（每段默认，片段可覆盖）"), h("label", null, "模式"), wf, h("label", null, "质量档位"), qualEl, h("label", null, "尺寸"), h("div", { class: "row" }, h("div", { style: "flex:1" }, w), "×", h("div", { style: "flex:1" }, hh)), sizeSel, h("div", { class: "row" }, h("div", { style: "flex:1" }, h("label", null, "每段秒数"), sec), h("div", { style: "flex:1" }, h("label", null, "步数"), steps), h("div", { style: "flex:1" }, h("label", null, "参考图分辨率"), rs)),
        h("label", null, "加速 LoRA"), loraEl,
        h("button", { class: "primary", style: "margin-top:12px", onclick: () => save({ settings: { workflow: wf.value, width: Number(w.value), height: Number(hh.value), seconds: Number(sec.value), steps: Number(steps.value), refSize: rs.value, lora: loraEl.value() } }).then(() => toast("已保存", "ok", 1500)).catch((e) => toast(e.message, "error")) }, "保存参数")),
      h("div", { class: "card" }, h("h2", null, "共享参考图"), h("p", { class: "hint" }, "所有片段默认全量传入这些图；人脸头肩图在前，连续性母图放最后。片段可单独覆盖。"), refsBox,
        h("h3", { style: "margin-top:14px" }, "scene.json 互通（与 skill 的 scene.py 同格式）"),
        h("div", { class: "row" }, h("a", { class: "btn sm", href: `api/projects/${p.id}/export.zip` }, "导出 zip（scene.json + refs + 已选 take）"), h("a", { class: "btn sm", href: `api/projects/${p.id}/export.json`, target: "_blank" }, "看 scene.json"),
          h("button", { class: "sm", onclick: () => { const inp = h("input", { type: "file", accept: ".zip,.json,application/zip,application/json", style: "display:none", onchange: async () => { const f = inp.files[0]; if (!f) return; if (!await confirm(`把「${f.name}」导入到当前项目？会追加片段、参考图并覆盖共享段落与参数。`)) return; toast("导入中…", "info"); try { const r = await api(`/projects/${p.id}/import?name=${encodeURIComponent(f.name)}`, { method: "PUT", body: f, raw: true, headers: { "content-type": "application/octet-stream" } }); toast(`已导入 ${r.clips} 段、${r.refs} 张参考图${r.warnings.length ? "；" + r.warnings.join("；") : ""}`, r.warnings.length ? "warn" : "ok", 6000); await reload(); drawSettings(); } catch (e) { toast(e.message, "error"); } } }); document.body.append(inp); inp.click(); } }, "导入 scene.json / zip")),
        h("p", { class: "hint" }, "导出的 zip 可直接给 skill：`scene.py build/assemble scene.json`；导入支持 skill 产出的 scene.json（refs 相对路径会作为素材上传）。"), h("h3", { style: "margin-top:14px" }, "备注 / 剧本"), notes, h("button", { class: "sm", style: "margin-top:6px", onclick: () => save({ notes: notes.value }).then(() => toast("已保存", "ok", 1500)) }, "保存备注"))),
      h("div", { class: "card", style: "margin-top:14px" }, h("div", { class: "row between" }, h("h2", null, "共享提示词段落（六段格式的公共部分）"), h("div", { class: "row" }, h("button", { class: "sm", onclick: () => { if (!subjects.value.trim()) { const t = TPL.native_ref2va.split("\n\n"); subjects.value = t[0].replace("subject_definitions:\n", ""); retention.value = t[2].replace("retention_analysis:\n", ""); style.value = "The target video is a realistic live-action scene, clean digital cinema camera, 24 fps, natural skin texture, no beauty filter. No subtitles, no on-screen text, no additional people."; sound.value = "Quiet room tone."; } } }, "填入模板"), ...refLinkBtns())),
        h("p", { class: "hint" }, "每段的最终提示词 = subject_definitions（共享）+ summary（片段）+ retention_analysis（共享或片段）+ detailed_description（风格句 + 片段 [Shot 1]）+ overall_soundscape + non_diegetic_music。写方位不写形容词，左右关系每段重申。"),
        h("label", null, "subject_definitions"), subjects, h("label", null, "retention_analysis"), retention, h("label", null, "风格句（detailed_description 开头）"), style, h("label", null, "overall_soundscape"), sound, h("label", null, "non_diegetic_music"), music,
        h("button", { class: "primary", style: "margin-top:12px", onclick: () => save({ shared: { subjects: subjects.value, retention: retention.value, style: style.value, soundscape: sound.value, music: music.value } }).then(() => toast("已保存", "ok", 1500)) }, "保存段落")));
  }

  // ---- assets tab ----
  async function drawAssets() {
    // Everything below renders into the shared `body`. Clearing happens before the await, appending after,
    // so two overlapping calls (a tab click plus an upload finishing, say) used to paint the page twice.
    const token = ++bodyDraw;
    body.innerHTML = "";
    try { usage = await api(`/projects/${p.id}/usage`); } catch { usage = null; }
    if (token !== bodyDraw) return;
    const grid = h("div", { class: "grid g4" });
    const cbUnref = h("input", { type: "checkbox", checked: unrefOnly }); cbUnref.onchange = () => { unrefOnly = cbUnref.checked; drawAssets(); };
    body.append(h("div", { class: "row between", style: "margin-bottom:8px" }, h("span", { class: "muted small" }, usage ? `${p.assets.length} 个素材 · 未被引用 ${usage.unreferenced.length} 个（未被参考图 / 片段 / 镜头 / 数字人 / 母图 / 任务使用；可在设置 → 存储与清理里统一清理）` : `${p.assets.length} 个素材`), h("label", { class: "row small", style: "gap:4px" }, cbUnref, "只看未被引用")));
    body.append(h("div", { class: "card" }, uploadBox(p.id, async () => { await reload(); drawAssets(); }), h("p", { class: "hint" }, "HEIC 会自动转 JPG。人脸参考图请裁成头肩（裁剪工具默认 1024 短边）。参考视频先用「切段」处理成 24fps、2–15 秒、帧数对齐。")), h("div", { style: "height:12px" }), grid);
    const list = [...p.assets].filter((a) => !unrefOnly || !usage || usage.unreferenced.includes(a.id)).sort((a, b) => b.createdAt - a.createdAt);
    if (!list.length) grid.append(h("p", { class: "muted" }, unrefOnly ? "没有未被引用的素材。" : "还没有素材。"));
    for (const a of list) grid.append(h("div", { class: "asset", onclick: () => assetDetail(a) }, h("img", { class: "thumb", src: `api/projects/${p.id}/assets/${a.id}/thumb` }), h("span", { class: "tag" }, a.kind === "video" ? `▶ ${a.duration}s` : a.kind === "audio" ? `♪ ${a.duration}s` : "图"), usage && usage.unreferenced.includes(a.id) ? h("span", { class: "tag", style: "left:12px;top:auto;bottom:44px;background:#3a3a3a;color:#ccc" }, "未引用") : null, p.refs.includes(a.id) ? h("span", { class: "tag", style: "left:auto;right:12px;background:var(--accent);color:#000" }, `P${p.refs.indexOf(a.id) + 1}`) : null, h("div", { class: "name" }, a.name), h("div", { class: "meta" }, `${a.id} · ${a.width}×${a.height}${a.frames ? " · " + a.frames + "帧" : ""} · ${fmtBytes(a.size)}`), whereTag(a)));
  }
  function assetDetail(a) {
    const url = `api/projects/${p.id}/assets/${a.id}/file`;
    const media = a.kind === "video" ? h("video", { class: "player", src: url, controls: true }) : a.kind === "audio" ? h("div", null, h("img", { src: `api/projects/${p.id}/assets/${a.id}/thumb`, style: "width:100%;border-radius:8px" }), h("audio", { src: url, controls: true, style: "width:100%;margin-top:8px" })) : h("img", { src: url, style: "max-width:100%;max-height:60vh;border-radius:8px;display:block;margin:auto" });
    const acts = h("div", { class: "row", style: "margin-top:10px" });
    const rm = () => m.close();
    acts.append(h("button", { class: "sm", onclick: () => { const n = prompt("重命名", a.name); if (n) api(`/projects/${p.id}/assets/${a.id}`, { method: "PATCH", body: { name: n } }).then(() => { rm(); reload().then(drawAssets); }); } }, "重命名"),
      h("a", { class: "btn sm", href: url + "?download=1" }, "下载"),
      S.meta.fileshare ? h("button", { class: "sm", onclick: () => api(`/projects/${p.id}/assets/${a.id}/share`, { method: "POST", body: {} }).then((r) => { copy(r.url); modal("分享链接", h("pre", null, r.url), { narrow: true }); }).catch((e) => toast(e.message, "error")) }, "分享链接") : null);
    if (a.kind === "audio") { /* nothing extra */ }
    else if (a.kind === "image") {
      acts.append(h("button", { class: "sm", onclick: () => { rm(); cropDialog(a); } }, "裁剪 / 头肩图"),
        h("button", { class: "sm", onclick: async () => { if (p.refs.includes(a.id)) return toast("已是参考图"); await save({ refs: [...p.refs, a.id] }); rm(); drawAssets(); toast("已加入共享参考图", "ok", 1500); } }, "设为共享参考图 <Picture N>"));
    } else {
      acts.append(h("button", { class: "sm", onclick: () => { const at = media.currentTime || 0; api(`/projects/${p.id}/assets/${a.id}/frame`, { method: "POST", body: { at } }).then((na) => { toast(`已抽帧 ${at.toFixed(2)}s → ${na.name}`, "ok"); reload().then(drawAssets); }).catch((e) => toast(e.message, "error")); } }, "抽当前帧"),
        h("button", { class: "sm", onclick: () => api(`/projects/${p.id}/assets/${a.id}/frame`, { method: "POST", body: { last: true } }).then((na) => { toast(`已抽末帧 → ${na.name}`, "ok"); reload().then(drawAssets); }).catch((e) => toast(e.message, "error")) }, "抽末帧"),
        h("button", { class: "sm", onclick: () => { rm(); prepDialog(a); } }, "切段（参考视频用）"));
    }
    acts.append(h("button", { class: "sm danger", onclick: async () => { if (await confirm(`删除素材 ${a.name}？`, { danger: true })) { await api(`/projects/${p.id}/assets/${a.id}`, { method: "DELETE" }); rm(); await reload(); drawAssets(); } } }, "删除"));
    const m = modal(a.name, h("div", null, media, h("div", { class: "muted small", style: "margin-top:6px" }, `${a.width}×${a.height}${a.duration ? " · " + a.duration + "s · " + (a.fps || "?") + "fps · " + (a.frames || "?") + " 帧" + (a.hasAudio ? " · 有音轨" : " · 无音轨") : ""} · ${fmtBytes(a.size)} · 来源 ${JSON.stringify(a.source || {})}`), acts));
  }
  function cropDialog(a, { onDone = null } = {}) {
    // Draggable / resizable crop box over the image; coordinates map back to source pixels.
    const img = h("img", { src: `api/projects/${p.id}/assets/${a.id}/file`, draggable: false });
    const box = h("div", { class: "crop-box" }, h("i"));
    const wrap = h("div", { class: "crop-wrap" }, img, box);
    const ratioSel = h("select", null, h("option", { value: "free" }, "自由"), h("option", { value: "1" }, "1:1 头肩"), h("option", { value: "0.75" }, "3:4"), h("option", { value: "1.3333" }, "4:3"), h("option", { value: "1.7778" }, "16:9"), h("option", { value: "0.5625" }, "9:16"));
    const shortSide = h("input", { type: "number", value: 1024, style: "width:90px" });
    const nameEl = h("input", { value: a.name.replace(/\.[^.]+$/, "") + "_crop.jpg" });
    const info = h("span", { class: "muted small mono" });
    let r = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }; // fractions of the displayed image
    const apply = () => { const W = img.clientWidth, H = img.clientHeight; box.style.left = r.x * W + "px"; box.style.top = r.y * H + "px"; box.style.width = r.w * W + "px"; box.style.height = r.h * H + "px"; info.textContent = `${Math.round(r.w * a.width)}×${Math.round(r.h * a.height)} @ ${Math.round(r.x * a.width)},${Math.round(r.y * a.height)}`; };
    const clamp = () => { r.w = Math.min(r.w, 1); r.h = Math.min(r.h, 1); r.x = Math.max(0, Math.min(r.x, 1 - r.w)); r.y = Math.max(0, Math.min(r.y, 1 - r.h)); };
    const fixRatio = () => { const v = ratioSel.value; if (v === "free") return; const ratio = Number(v); const W = img.clientWidth, H = img.clientHeight; const pw = r.w * W; r.h = Math.min(1, pw / ratio / H); r.w = r.h * H * ratio / W; clamp(); };
    img.onload = () => { fixRatio(); apply(); };
    ratioSel.onchange = () => { fixRatio(); apply(); };
    let drag = null;
    box.addEventListener("pointerdown", (e) => { e.preventDefault(); box.setPointerCapture(e.pointerId); drag = { mode: e.target.tagName === "I" ? "resize" : "move", sx: e.clientX, sy: e.clientY, r: { ...r } }; });
    box.addEventListener("pointermove", (e) => { if (!drag) return; const W = img.clientWidth, H = img.clientHeight; const dx = (e.clientX - drag.sx) / W, dy = (e.clientY - drag.sy) / H; if (drag.mode === "move") { r.x = drag.r.x + dx; r.y = drag.r.y + dy; } else { r.w = Math.max(0.05, drag.r.w + dx); r.h = Math.max(0.05, drag.r.h + dy); if (ratioSel.value !== "free") { const ratio = Number(ratioSel.value); r.h = r.w * W / ratio / H; } } clamp(); apply(); });
    box.addEventListener("pointerup", () => { drag = null; });
    modal("裁剪 " + a.name, h("div", null, h("div", { class: "row", style: "margin-bottom:8px" }, h("label", { class: "inline" }, "比例 ", ratioSel), h("label", { class: "inline" }, "短边 ", shortSide, "px"), info), h("div", { style: "text-align:center" }, wrap), h("label", null, "新素材名"), nameEl, h("p", { class: "hint" }, "人脸参考：只裁头肩，别带一身衣服；短边 1024 左右既保脸又不炸显存。")),
      { actions: [{ label: "取消" }, { label: "裁剪并保存为新素材", primary: true, onclick: async () => { const crop = { x: r.x * a.width, y: r.y * a.height, w: r.w * a.width, h: r.h * a.height }; const na = await api(`/projects/${p.id}/assets/${a.id}/crop`, { method: "POST", body: { crop, shortSide: Number(shortSide.value), name: nameEl.value } }); toast("已保存裁剪", "ok"); await reload(); if (onDone) onDone(na); else drawAssets(); } }] });
  }
  function prepDialog(a) {
    const start = h("input", { type: "number", step: 0.1, min: 0, value: 0 }), end = h("input", { type: "number", step: 0.1, min: 0, value: Math.min(a.duration, 5).toFixed(1) });
    const w = h("input", { type: "number", step: 32, value: p.settings.width }), hh = h("input", { type: "number", step: 32, value: p.settings.height });
    const cx = h("input", { type: "number", value: 0 }), cy = h("input", { type: "number", value: 0 }), cw = h("input", { type: "number", value: a.width }), ch = h("input", { type: "number", value: a.height });
    const head = h("input", { type: "number", value: 0, min: 0 }), tail = h("input", { type: "number", value: 0, min: 0 });
    const vid = h("video", { class: "player", src: `api/projects/${p.id}/assets/${a.id}/file`, controls: true, style: "max-height:40vh" });
    const useCur = (el) => h("button", { class: "sm", onclick: () => { el.value = vid.currentTime.toFixed(2); } }, "取当前时间");
    modal("切段：" + a.name, h("div", null, vid,
      h("div", { class: "row", style: "margin-top:8px" }, h("div", null, h("label", null, "开始秒"), h("div", { class: "row" }, start, useCur(start))), h("div", null, h("label", null, "结束秒"), h("div", { class: "row" }, end, useCur(end)))),
      h("label", null, "裁剪（源像素 x, y, w, h；手机录屏先裁掉界面/字幕）"), h("div", { class: "row" }, cx, cy, cw, ch),
      h("label", null, "输出尺寸（32 倍数，通常等于生成分辨率）"), h("div", { class: "row" }, w, "×", hh),
      h("div", { class: "row" }, h("div", null, h("label", null, "头部定格帧数（换脸引导，≥12）"), head), h("div", null, h("label", null, "尾部定格帧数"), tail)),
      h("p", { class: "hint" }, "输出 24fps、帧数对齐 17k+5、保留音轨。换脸时头部定格首帧 ≥12 帧能让模型先锁定源片。")),
      { actions: [{ label: "取消" }, { label: "生成片段", primary: true, onclick: async () => { const crop = (Number(cx.value) || Number(cy.value) || Number(cw.value) !== a.width || Number(ch.value) !== a.height) ? { x: Number(cx.value), y: Number(cy.value), w: Number(cw.value), h: Number(ch.value) } : null; toast("正在切段…", "info"); await api(`/projects/${p.id}/assets/${a.id}/prep`, { method: "POST", body: { start: Number(start.value), end: Number(end.value), crop, size: { w: Number(w.value), h: Number(hh.value) }, headHold: Number(head.value), tailHold: Number(tail.value) } }); toast("切段完成", "ok"); await reload(); drawAssets(); } }] });
  }

  // ---- clips tab ----
  function drawClips() {
    ++bodyDraw;
    body.innerHTML = "";
    const toolbar = h("div", { class: "row between", style: "margin-bottom:10px" },
      h("div", { class: "row" }, h("button", { class: "primary", onclick: async () => { const c = await api(`/projects/${p.id}/clips`, { method: "POST", body: {} }); open.add(c.id); await reload(); drawClips(); } }, "＋ 添加片段"),
        h("button", { onclick: async () => { const todo = p.clips.filter((c) => !c.takes.length); if (!todo.length) return toast("每段都已有 take"); if (await confirm(`为 ${todo.length} 段各生成一条？`)) { for (const c of todo) await api(`/projects/${p.id}/clips/${c.id}/generate`, { method: "POST", body: {} }).catch((e) => toast(`${c.title}: ${e.message}`, "error")); toast("已全部排队", "ok"); } } }, "生成所有未生成的段"),
        h("button", { onclick: sheet }, "对照表")),
      h("span", { class: "muted small" }, `${p.clips.length} 段 · 已选用 ${p.clips.filter((c) => c.pick).length} 段`));
    body.append(toolbar);
    if (!p.clips.length) body.append(h("div", { class: "card muted" }, "还没有片段。先在「设定」里写好共享段落和参考图，再添加片段：每段只需写 summary 和 [Shot 1] 镜头描述。"));
    p.clips.forEach((c, i) => body.append(clipEl(c, i)));
  }
  function clipEl(c, i) {
    const params = { w: c.width || p.settings.width, h: c.height || p.settings.height, sec: c.seconds || p.settings.seconds, wf: c.workflow || p.settings.workflow };
    const isOpen = open.has(c.id);
    const bodyEl = h("div", { class: "clip-b", hidden: !isOpen });
    const el = h("div", { class: "clip", id: "clip-" + c.id, draggable: true,
      ondragstart: (e) => { e.dataTransfer.setData("text/plain", c.id); e.dataTransfer.effectAllowed = "move"; el.style.opacity = .5; }, ondragend: () => { el.style.opacity = 1; },
      ondragover: (e) => { e.preventDefault(); el.style.outline = "2px dashed var(--accent)"; }, ondragleave: () => { el.style.outline = ""; },
      ondrop: async (e) => { e.preventDefault(); el.style.outline = ""; const from = e.dataTransfer.getData("text/plain"); if (!from || from === c.id) return; const ids = p.clips.map((x) => x.id); const fi = ids.indexOf(from), ti = ids.indexOf(c.id); ids.splice(fi, 1); ids.splice(ti, 0, from); await api(`/projects/${p.id}/clips/reorder`, { method: "POST", body: { ids } }); await reload(); drawClips(); } },
      h("div", { class: "clip-h", onclick: () => { isOpen ? open.delete(c.id) : open.add(c.id); drawClips(); } },
        h("span", { class: "num" }, i + 1), h("b", { style: "flex:1" }, c.title), h("span", { class: "muted small" }, `${params.w}×${params.h} · ${params.sec}s · seed ${c.seed}` + (c.prompt ? " · 自定义提示词" : "")),
        c.pick ? h("span", { class: "badge done" }, "已选用") : c.takes.length ? h("span", { class: "badge running" }, "生成中") : h("span", { class: "badge" }, "未生成"),
        h("span", { class: "muted small", title: "拖动排序", style: "cursor:grab" }, "⋮⋮"), h("button", { class: "sm ghost", onclick: (e) => { e.stopPropagation(); move(i, -1); } }, "↑"), h("button", { class: "sm ghost", onclick: (e) => { e.stopPropagation(); move(i, 1); } }, "↓")),
      bodyEl);
    if (isOpen) fillClipBody(bodyEl, c);
    return el;
  }
  async function move(i, d) { const ids = p.clips.map((c) => c.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; await api(`/projects/${p.id}/clips/reorder`, { method: "POST", body: { ids } }); await reload(); drawClips(); }
  function fillClipBody(bodyEl, c) {
    bodyEl.innerHTML = "";
    const f = {};
    const inp = (k, ph, opts = {}) => (f[k] = h(opts.area ? "textarea" : "input", { placeholder: ph, value: c[k] ?? "", ...(opts.attrs || {}) }));
    const saveClip = async (extra = {}) => { const patch = { title: f.title.value, seed: f.seed.value, summary: f.summary.value, shot: f.shot.value, retention: f.retention.value, subjects: f.subjects.value, style: f.style.value, soundscape: f.soundscape.value, music: f.music.value, prompt: f.prompt.value, seconds: f.seconds.value, width: f.width.value, height: f.height.value, steps: f.steps.value, workflow: f.workflow.value || null, videoAudio: f.videoAudio.checked, gain: f.gain.value, subs: [...subsBox.querySelectorAll(".cue")].map((row) => ({ text: row.children[0].value, from: row.children[1].value, to: row.children[2].value })), ...extra }; const nc = await api(`/projects/${p.id}/clips/${c.id}`, { method: "PATCH", body: patch }); Object.assign(c, nc); return nc; };
    const wfSel = h("select", null, h("option", { value: "" }, "跟随项目"), Object.entries(S.meta.workflows).map(([k, v]) => h("option", { value: k }, v.label))); wfSel.value = c.workflow || ""; f.workflow = wfSel;
    f.videoAudio = h("input", { type: "checkbox", checked: c.videoAudio });
    // per-clip refs / videos
    const refsBox = h("div", { class: "refs" });
    const drawRefs = () => {
      refsBox.innerHTML = "";
      const list = c.refs && c.refs.length ? c.refs : null;
      if (!list) refsBox.append(h("span", { class: "muted small" }, `使用项目共享参考图（${p.refs.length} 张）`));
      (list || []).forEach((aid, i) => refsBox.append(h("div", { class: "ref" }, h("img", { src: `api/projects/${p.id}/assets/${aid}/thumb` }), h("span", { class: "lbl" }, `<Picture ${i + 1}>`), h("button", { class: "x", onclick: async () => { await saveClip({ refs: list.filter((x) => x !== aid) }); drawRefs(); } }, "✕"))));
      refsBox.append(h("div", { class: "ref add", onclick: async () => { const ids = await pickAssets(p.id, { multi: true, title: "本段单独的参考图（覆盖共享）" }); if (ids.length) { await saveClip({ refs: [...(list || []), ...ids].slice(0, 9) }); drawRefs(); } } }, "＋ 覆盖参考图"));
      (c.videos || []).forEach((aid, i) => refsBox.append(h("div", { class: "ref" }, h("img", { src: `api/projects/${p.id}/assets/${aid}/thumb` }), h("span", { class: "lbl" }, `<Video ${i + 1}>`), h("button", { class: "x", onclick: async () => { await saveClip({ videos: c.videos.filter((x) => x !== aid) }); drawRefs(); } }, "✕"))));
      refsBox.append(h("div", { class: "ref add", onclick: async () => { const ids = await pickAssets(p.id, { kind: "video", multi: true, title: "本段参考视频 <Video N>" }); if (ids.length) { await saveClip({ videos: [...(c.videos || []), ...ids].slice(0, 3) }); drawRefs(); } } }, "＋ 参考视频"));
    };
    drawRefs();
    const subsBox = h("div");
    const cueRow = (s = {}) => h("div", { class: "cue" }, h("input", { placeholder: "字幕文本（一行）", value: s.text || "" }), h("input", { type: "number", step: 0.1, placeholder: "起(秒)", value: s.from ?? "" }), h("input", { type: "number", step: 0.1, placeholder: "止(秒)", value: s.to ?? "" }), h("button", { class: "sm ghost", onclick: (e) => e.target.closest(".cue").remove() }, "✕"));
    (c.subs || []).forEach((s) => subsBox.append(cueRow(s)));
    const takesBox = h("div", { class: "takes", id: "takes-" + c.id });
    bodyEl.append(
      h("div", { class: "row", style: "margin-top:10px" }, h("div", { style: "flex:2" }, h("label", null, "标题"), inp("title", "第 N 段")), h("div", { style: "flex:1" }, h("label", null, "Seed（重拍自动 +1000）"), inp("seed", "", { attrs: { type: "number" } })), h("div", { style: "flex:1" }, h("label", null, "秒数（空=项目默认）"), inp("seconds", String(p.settings.seconds), { attrs: { type: "number", step: 0.5 } }))),
      h("label", null, "summary（一句话，以 [reference generation] 等前缀开头）"), inp("summary", "[reference generation] One static two-shot of <Subject 1> and <Subject 2> inside <Subject 3>: …"),
      h("label", null, "[Shot 1] 镜头描述（detailed_description 的片段部分）"), inp("shot", "[Shot 1] A static medium-wide two-shot, 35mm lens, camera directly in front of the sofa at seated eye level … <Subject 1> (S1) asks in a calm voice, <d>[Chinese] 你看到我充电器了吗？</d> The camera holds a static shot.", { area: true, attrs: { style: "min-height:120px" } }),
      promptTools(f.shot, { mode: () => (c.workflow || p.settings.workflow) === "native_ref2va" ? "ref" : (c.workflow || p.settings.workflow) === "native_i2v" ? "i2v" : "t2v" }),
      h("details", null, h("summary", { class: "muted small" }, "覆盖共享段落 / 参数（可选）"),
        h("div", { class: "row" }, h("div", { style: "flex:1" }, h("label", null, "模式"), wfSel), h("div", { style: "flex:1" }, h("label", null, "宽"), inp("width", String(p.settings.width), { attrs: { type: "number", step: 32 } })), h("div", { style: "flex:1" }, h("label", null, "高"), inp("height", String(p.settings.height), { attrs: { type: "number", step: 32 } })), h("div", { style: "flex:1" }, h("label", null, "步数"), inp("steps", String(p.settings.steps), { attrs: { type: "number" } })), h("div", { style: "flex:1" }, h("label", null, "响度增益 dB"), inp("gain", "0", { attrs: { type: "number", step: 0.5 } }))),
        h("label", null, "subject_definitions（本段覆盖）"), inp("subjects", "留空 = 用共享", { area: true }), h("label", null, "retention_analysis（本段覆盖，单人镜头把另一人写 off-screen / weak_reference）"), inp("retention", "留空 = 用共享", { area: true }), h("label", null, "风格句"), inp("style", "留空 = 用共享"), h("label", null, "overall_soundscape"), inp("soundscape", "留空 = 用共享"), h("label", null, "non_diegetic_music"), inp("music", "留空 = 用共享"),
        h("label", null, "完全自定义提示词（填了就不再拼接，原样发给模型）"), inp("prompt", "", { area: true })),
      h("label", null, "参考素材"), refsBox, h("label", { class: "inline", style: "margin-top:6px" }, f.videoAudio, "参考视频连音轨（换脸必开）"),
      h("label", null, "字幕（相对本段起点；起止留空 = 自动覆盖整段）"), subsBox, h("button", { class: "sm ghost", onclick: () => subsBox.append(cueRow()) }, "＋ 加一条字幕"),
      h("div", { class: "row", style: "margin-top:12px" },
        h("button", { class: "primary", onclick: async () => { await saveClip(); const j = await api(`/projects/${p.id}/clips/${c.id}/generate`, { method: "POST", body: {} }); toast(`已排队 take ${j.take}`, "ok"); await reload(); drawClips(); } }, `🎬 生成 take ${c.takes.length + 1}`),
        h("button", { onclick: () => saveClip().then(() => toast("已保存", "ok", 1500)).catch((e) => toast(e.message, "error")) }, "保存"),
        h("button", { onclick: async () => { await saveClip(); const r = await api(`/projects/${p.id}/clips/${c.id}/prompt`); modal("最终提示词 · " + c.title, h("div", null, h("pre", null, r.prompt), h("div", { class: "muted small" }, `参数：${JSON.stringify(r.params)}`)), { actions: [{ label: "复制", onclick: () => { copy(r.prompt); return false; } }, { label: "关闭" }] }); } }, "预览提示词"),
        h("button", { onclick: () => llmAssist({ mode: (c.workflow || p.settings.workflow) === "native_ref2va" ? ((c.videos || []).length ? "swap" : "ref") : (c.workflow || p.settings.workflow) === "native_i2v" ? "i2v" : "t2v", seconds: Number(f.seconds.value || p.settings.seconds), refs: [...(c.refs && c.refs.length ? c.refs : p.refs).map((id, i) => ({ kind: "image", index: i + 1, id, desc: p.assets.find((a) => a.id === id)?.name })), ...(c.videos || []).map((id, i) => ({ kind: "video", index: i + 1, id, desc: p.assets.find((a) => a.id === id)?.name }))], existing: f.prompt.value || (f.summary.value + "\n" + f.shot.value), onResult: (t) => { f.prompt.value = t; toast("已写入「完全自定义提示词」，可在其中拆回 summary/shot", "ok"); } }) }, "✨ AI 助手"),
        h("button", { class: "danger", style: "margin-left:auto", onclick: async () => { if (await confirm(`删除片段 ${c.title}？（已生成的 take 保留在任务列表）`, { danger: true })) { await api(`/projects/${p.id}/clips/${c.id}`, { method: "DELETE" }); await reload(); drawClips(); } } }, "删除片段")),
      h("div", { class: "row between", style: "margin-top:12px" }, h("h3", { style: "margin:0" }, "Takes"), h("div", { class: "row" },
        h("button", { class: "sm", disabled: !c.takes.length, title: "抽出选用 take 的末帧，作为下一段的首帧（i2v）", onclick: async () => { try { const nc = await api(`/projects/${p.id}/clips/${c.id}/continue`, { method: "POST", body: { mode: "frame" } }); open.add(nc.id); toast(`已创建「${nc.title}」，首帧 = 本段末帧`, "ok"); await reload(); drawClips(); } catch (e) { toast(e.message, "error"); } } }, "续接下一段：末帧作首帧"),
        h("button", { class: "sm", disabled: !c.takes.length, title: "把选用的 take 作为 <Video 1>，用 [video continuation] 续写（保身份+动作）", onclick: async () => { try { const nc = await api(`/projects/${p.id}/clips/${c.id}/continue`, { method: "POST", body: { mode: "video" } }); open.add(nc.id); toast(`已创建「${nc.title}」，<Video 1> = 本段成片`, "ok"); await reload(); drawClips(); } catch (e) { toast(e.message, "error"); } } }, "续接下一段：视频续接"))), takesBox);
    drawTakes(c, takesBox);
  }
  function drawTakes(c, box) {
    box = box || document.getElementById("takes-" + c.id); if (!box) return;
    box.innerHTML = "";
    if (!c.takes.length) box.append(h("span", { class: "muted small" }, "还没生成。"));
    if (c.takes.filter((id) => S.jobs.get(id)?.output).length >= 2) box.append(h("div", { class: "take", style: "display:grid;place-items:center;cursor:pointer", onclick: () => compareTakes(c.takes) }, h("span", { class: "muted small", style: "text-align:center;padding:10px 4px" }, "⇆ 并排对比两条 take")));
    c.takes.forEach((jid, i) => {
      const j = S.jobs.get(jid);
      const pct = j?.progress?.max ? Math.round(100 * j.progress.value / j.progress.max) : 0;
      box.append(h("div", { class: "take" + (c.pick === jid ? " pick" : ""), onclick: () => j && jobDetail(jid) },
        j?.output ? h("img", { src: `api/jobs/${jid}/poster` }) : h("div", { style: "aspect-ratio:16/9;background:#000;border-radius:5px;display:grid;place-items:center;font-size:11px;color:#777" }, j ? STATUS_ZH[j.status] : "任务已删除"),
        j && isActive(j) ? h("div", { class: "progress" + (j.status === "running" ? "" : " indet"), style: "margin-top:4px" }, h("i", { style: `width:${j.status === "running" ? pct : 35}%` })) : null,
        h("div", { class: "t" }, h("span", null, `take ${i + 1}`), h("span", { class: "muted" }, j?.seed ?? "")),
        j?.warning ? h("div", { class: "warn small" }, "参考未全部生效") : null,
        h("div", { class: "row", style: "gap:4px;margin-top:4px" }, h("button", { class: "sm" + (c.pick === jid ? " primary" : ""), onclick: async (e) => { e.stopPropagation(); await api(`/projects/${p.id}/clips/${c.id}/pick`, { method: "POST", body: { jobId: jid } }); c.pick = jid; drawTakes(c); } }, c.pick === jid ? "已选用" : "选用"))));
    });
  }
  function drawTakesOnly(j) { if (!j.clipId) return; const c = p.clips.find((x) => x.id === j.clipId); if (!c) return; if (!c.takes.includes(j.id) && !j.deleted) c.takes.push(j.id); drawTakes(c); }
  async function sheet() {
    const rows = p.clips.map((c) => ({ c, jid: c.pick || c.takes.at(-1) })).filter((x) => x.jid && S.jobs.get(x.jid)?.output);
    if (!rows.length) return toast("还没有可对照的片段");
    modal("对照表（每段首 / 中 / 尾三帧）", h("div", { class: "sheet" }, rows.map((x) => h("div", null, h("div", { class: "muted small" }, `${x.c.title} · seed ${S.jobs.get(x.jid).seed}`), h("img", { src: `api/jobs/${x.jid}/strip` })))));
  }



  // ---- master workshop tab ----
  async function drawMasters() {
    const token = ++bodyDraw;
    body.innerHTML = "";
    const masters = p.masters || [];
    const thumb = (aid, lbl) => aid ? h("div", { class: "ref", style: "width:96px" }, h("img", { src: `api/projects/${p.id}/assets/${aid}/thumb`, style: "width:96px;height:96px", onclick: () => assetDetail(p.assets.find((a) => a.id === aid)) }), h("span", { class: "lbl" }, lbl)) : h("div", { class: "ref add", style: "width:96px;height:96px;font-size:11px" }, lbl + " 待生成");
    body.append(h("div", { class: "card" }, h("div", { class: "row between" }, h("h2", null, "母图工坊"), h("div", { class: "row" }, h("button", { class: "primary", onclick: () => newMaster("person") }, "＋ 人物母图"), h("button", { onclick: () => newMaster("scene") }, "＋ 场景母图"))),
      h("p", { class: "hint" }, "人物：照片 → 静态正面近景（56 帧）抽帧 → 用「照片 + 正面」生成转头片（90 帧，正对镜头缓慢转到全侧脸）→ 1.9s 抽四分之三、3.3s 抽侧面。多角度母图一起喂，换脸和分段才不会漂。场景：所有人固定站位的静态全景 → 抽帧；要别的景别就「裁剪推进」：裁半边 → 再生成 → 抽帧。")));
    if (!masters.length) body.append(h("div", { class: "card muted", style: "margin-top:12px" }, "还没有母图任务。"));
    for (const m of masters) {
      const jobOf = (key) => m.steps[key] ? S.jobs.get(m.steps[key].jobId) : null;
      const stepRow = (key, label, canRun, onRun, extra = null) => { const j = jobOf(key); return h("div", { class: "row", style: "gap:8px;align-items:center;margin-top:6px" }, h("b", { style: "width:52px" }, label), j ? h("span", { class: "badge " + j.status }, STATUS_ZH[j.status]) : h("span", { class: "badge" }, "未生成"), j && isActive(j) ? h("div", { class: "progress" + (j.status === "running" && j.progress ? "" : " indet"), style: "width:120px" }, h("i", { style: `width:${j.status === "running" && j.progress ? Math.round(100 * j.progress.value / j.progress.max) : 35}%` })) : null, h("button", { class: "sm" + (j ? "" : " primary"), disabled: !canRun, onclick: onRun }, j ? "重跑" : "生成"), h("button", { class: "sm ghost", onclick: async () => { const r = await api(`/projects/${p.id}/masters/${m.id}/prompt?step=${key === "turn" ? "turn" : key === "front" ? "front" : key === "wide" ? "wide" : "regen"}`); modal("提示词", h("pre", null, r.prompt)); } }, "提示词"), j?.output ? h("button", { class: "sm ghost", onclick: () => jobDetail(j.id) }, "看片") : null, extra); };
      const produced = [];
      const card = h("div", { class: "card", style: "margin-top:12px" });
      const head = h("div", { class: "row between" }, h("div", { class: "row" }, h("h3", { style: "margin:0" }, m.name), h("span", { class: "badge" }, m.kind === "person" ? "人物" : "场景"), h("span", { class: "muted small" }, `${m.settings.width}×${m.settings.height} · seed ${m.settings.seed}`)), h("div", { class: "row" }, h("button", { class: "sm", onclick: () => editMaster(m) }, "编辑"), h("button", { class: "sm danger", onclick: async () => { if (await confirm(`删除母图任务「${m.name}」？（已入库的素材保留）`, { danger: true })) { await api(`/projects/${p.id}/masters/${m.id}`, { method: "DELETE" }); await reload(); drawMasters(); } } }, "删除")));
      card.append(head, h("div", { class: "muted small", style: "margin:4px 0" }, [m.desc, m.outfit && "穿 " + m.outfit, m.background === "grey" && m.kind === "person" ? "灰底" : m.scene].filter(Boolean).join(" · ")));
      const facesRow = h("div", { class: "refs", style: "margin-top:6px" }, m.faces.map((aid, i) => h("div", { class: "ref", style: "width:96px" }, h("img", { src: `api/projects/${p.id}/assets/${aid}/thumb`, style: "width:96px;height:96px" }), h("span", { class: "lbl" }, `照片${m.faces.length > 1 ? i + 1 : ""}`))));
      if (m.kind === "person") {
        facesRow.append(thumb(m.steps.front?.assetId, "正面"), thumb(m.steps.turn?.assets?.threeq, "四分之三"), thumb(m.steps.turn?.assets?.profile, "侧面"));
        card.append(facesRow,
          stepRow("front", "① 正面", true, async () => { try { await api(`/projects/${p.id}/masters/${m.id}/run`, { method: "POST", body: { step: "front" } }); toast("已排队", "ok"); await reload(); drawMasters(); } catch (e) { toast(e.message, "error"); } }),
          stepRow("turn", "② 转头", !!m.steps.front?.assetId, async () => { try { await api(`/projects/${p.id}/masters/${m.id}/run`, { method: "POST", body: { step: "turn" } }); toast("已排队", "ok"); await reload(); drawMasters(); } catch (e) { toast(e.message, "error"); } },
            m.steps.turn && jobOf("turn")?.output ? h("span", { class: "row", style: "gap:4px" }, h("span", { class: "muted small" }, "转得不够？改时刻重抽："), ...[["threeq", "四分之三", 1.9], ["profile", "侧面", 3.3]].map(([lbl, zh, dflt]) => { const t = h("input", { type: "number", step: 0.1, min: 0, max: 3.7, value: dflt, style: "width:64px" }); return h("span", { class: "row", style: "gap:2px" }, t, h("button", { class: "sm ghost", onclick: async () => { await api(`/projects/${p.id}/masters/${m.id}/extract`, { method: "POST", body: { key: "turn", at: Number(t.value), label: lbl } }); toast(`${zh} 已按 ${t.value}s 重抽`, "ok"); await reload(); drawMasters(); } }, zh)); })) : null));
        produced.push(m.steps.front?.assetId, m.steps.turn?.assets?.threeq, m.steps.turn?.assets?.profile);
      } else {
        facesRow.append(thumb(m.steps.wide?.assetId, "全景"));
        for (const [k, v] of Object.entries(m.steps)) if (k.startsWith("regen_")) facesRow.append(thumb(v.assetId, "推进"));
        card.append(facesRow, stepRow("wide", "① 全景", true, async () => { try { await api(`/projects/${p.id}/masters/${m.id}/run`, { method: "POST", body: { step: "wide" } }); toast("已排队", "ok"); await reload(); drawMasters(); } catch (e) { toast(e.message, "error"); } }));
        produced.push(m.steps.wide?.assetId, ...Object.entries(m.steps).filter(([k]) => k.startsWith("regen_")).map(([, v]) => v.assetId));
      }
      // crop → regen (裁剪推进) available for any produced image
      const cropSrc = h("select", null, h("option", { value: "" }, "选一张母图…"), produced.filter(Boolean).map((aid) => h("option", { value: aid }, p.assets.find((a) => a.id === aid)?.name || aid)));
      card.append(h("div", { class: "row", style: "margin-top:8px;gap:8px" }, h("span", { class: "muted small" }, "裁剪推进："), cropSrc, h("button", { class: "sm", onclick: () => { if (!cropSrc.value) return toast("先选一张"); cropDialog(p.assets.find((a) => a.id === cropSrc.value), { onDone: async (na) => { if (await confirm(`用裁出的「${na.name}」再生成一张全分辨率母图？`)) { await api(`/projects/${p.id}/masters/${m.id}/run`, { method: "POST", body: { step: "regen", from: na.id } }); toast("已排队", "ok"); await reload(); drawMasters(); } } }); } }, "裁剪 → 再生成"),
        h("span", { style: "flex:1" }),
        h("button", { class: "sm primary", disabled: !produced.some(Boolean), onclick: async () => { try { const r = await api(`/projects/${p.id}/masters/${m.id}/adopt`, { method: "POST", body: { target: "refs" } }); toast(`已加入共享参考图（${r.added.length} 张）`, "ok"); await reload(); } catch (e) { toast(e.message, "error"); } } }, "设为共享参考图"),
        (p.edits || []).length ? h("button", { class: "sm", disabled: !produced.some(Boolean), onclick: async () => { const sel = h("select", null, p.edits.map((e) => h("option", { value: e.id }, e.name))); modal("加入哪个视频编辑任务的参考图？", sel, { narrow: true, actions: [{ label: "取消" }, { label: "加入", primary: true, onclick: async () => { const r = await api(`/projects/${p.id}/masters/${m.id}/adopt`, { method: "POST", body: { target: "edit", editId: sel.value } }); toast(`已加入（${r.added.length} 张）`, "ok"); } }] }); } }, "加入视频编辑参考图") : null));
      body.append(card);
    }
    function newMaster(kind) { editMaster({ kind, name: "", faces: [], desc: "", outfit: "", scene: "", subjects: "", background: "grey", settings: { width: kind === "person" ? 640 : p.settings.width, height: kind === "person" ? 736 : p.settings.height, seed: 7100, steps: 8 } }, true); }
    function editMaster(m, isNew = false) {
      const f = { name: h("input", { value: m.name, placeholder: m.kind === "person" ? "例如 girl / 姐姐" : "例如 客厅" }), desc: h("textarea", { value: m.desc, placeholder: m.kind === "person" ? "an East Asian girl about twelve, black round-frame glasses, black hair pulled back（客观描述脸型、发型、眼镜）" : "可选：人物总体描述" }), outfit: h("input", { value: m.outfit, placeholder: "a light-blue sleeveless tank top（目标片里的衣服）" }), scene: h("textarea", { value: m.scene, placeholder: m.kind === "person" ? "留空 = 纯灰背景（推荐，母图背景会漏进结果）" : "LEFT background = small open kitchen; CENTER = island with two stools; RIGHT = window; beige sofa center foreground（写方位不写形容词）" }), subjects: h("textarea", { value: m.subjects, placeholder: "<Subject 1> is CHARACTER A, face from <Picture 1>: …, wearing …, standing on the LEFT.\n<Subject 2> is CHARACTER B, face from <Picture 2>: …, sitting on the RIGHT side of the sofa." }), width: h("input", { type: "number", step: 32, value: m.settings.width }), height: h("input", { type: "number", step: 32, value: m.settings.height }), seed: h("input", { type: "number", value: m.settings.seed }), bg: h("select", null, h("option", { value: "grey" }, "纯灰背景（推荐）"), h("option", { value: "scene" }, "用下面的场景描述")) };
      f.bg.value = m.background || "grey";
      let faces = [...m.faces];
      const facesBox = h("div", { class: "refs" });
      const drawFaces = () => { facesBox.innerHTML = ""; faces.forEach((aid, i) => facesBox.append(h("div", { class: "ref", style: "width:80px" }, h("img", { src: `api/projects/${p.id}/assets/${aid}/thumb`, style: "width:80px;height:80px" }), h("span", { class: "lbl" }, `<Picture ${i + 1}>`), h("button", { class: "x", onclick: () => { faces.splice(i, 1); drawFaces(); } }, "✕")))); facesBox.append(h("div", { class: "ref add", style: "width:80px;height:80px", onclick: async () => { const ids = await pickAssets(p.id, { multi: m.kind === "scene", title: m.kind === "person" ? "选头肩照" : "选每个人的头肩照（顺序 = <Picture N>）" }); faces = [...faces, ...ids.filter((x) => !faces.includes(x))].slice(0, 9); drawFaces(); } }, "＋")); };
      drawFaces();
      modal((isNew ? "新建" : "编辑") + (m.kind === "person" ? "人物母图" : "场景母图"), h("div", null,
        h("label", null, "名称"), f.name, h("label", null, m.kind === "person" ? "头肩照" : "各人物头肩照"), facesBox,
        m.kind === "person" ? [h("label", null, "人物描述（英文）"), f.desc, h("label", null, "服装（英文）"), f.outfit, h("label", null, "背景"), f.bg, h("label", null, "场景描述（英文，仅背景选场景时用）"), f.scene] : [h("label", null, "subject_definitions（每个人来自哪张图、穿什么、站哪）"), f.subjects, h("label", null, "房间方位描述（英文）"), f.scene],
        h("div", { class: "row" }, h("div", null, h("label", null, "宽"), f.width), h("div", null, h("label", null, "高"), f.height), h("div", null, h("label", null, "Seed"), f.seed)),
        h("p", { class: "hint" }, m.kind === "person" ? "人物母图建议 640×736 竖版；输出后用「裁剪」只留头肩再当参考。" : "场景母图建议 1344×768（模型原生）；全景做好后用「裁剪推进」得到中景 / 单人机位。")),
        { actions: [{ label: "取消" }, { label: isNew ? "创建" : "保存", primary: true, onclick: async () => { const body = { kind: m.kind, name: f.name.value, faces, desc: f.desc.value, outfit: f.outfit.value, scene: f.scene.value, subjects: f.subjects.value, background: f.bg.value, width: Number(f.width.value), height: Number(f.height.value), seed: Number(f.seed.value) }; if (isNew) await api(`/projects/${p.id}/masters`, { method: "POST", body }); else await api(`/projects/${p.id}/masters/${m.id}`, { method: "PATCH", body: { ...body, settings: { width: body.width, height: body.height, seed: body.seed } } }); await reload(); drawMasters(); } }] });
    }
  }


  // ---- long avatar tab ----
  async function drawAvatars() {
    const token = ++bodyDraw;
    body.innerHTML = "";
    const avatars = p.avatars || [];
    if (!curAvatar || !avatars.some((a) => a.id === curAvatar)) curAvatar = avatars[0]?.id || null;
    body.append(h("div", { class: "card" }, h("div", { class: "row between" }, h("h2", null, "长数字人"), h("div", { class: "row" }, avatars.length ? h("select", { onchange: (e) => { curAvatar = e.target.value; drawAvatars(); } }, avatars.map((a) => h("option", { value: a.id, selected: a.id === curAvatar }, a.name))) : null, h("button", { class: "primary", onclick: newAvatar }, "＋ 新建数字人"))),
      h("p", { class: "hint" }, "头像照片 + 一段任意长度的讲解音频 → 按静音自动切成 ≤15 秒的段 → 每段一个任务：头像 + 上一段末帧（固定机位）+ 该段音频（口型同步）→ 链式生成 → 裁齐拼接并铺回原音频。")));
    if (!curAvatar) { body.append(h("div", { class: "card muted", style: "margin-top:12px" }, "还没有数字人任务。先把头像和音频上传到素材。")); return; }
    const a = avatars.find((x) => x.id === curAvatar);
    const prog = h("div", { class: "hint" });
    listen("render", (ev) => { if (ev.detail.avatarId === a.id) prog.textContent = ev.detail.text; });
    const done = a.segments.filter((s) => s.jobs.length && S.jobs.get(s.pick || s.jobs.at(-1))?.status === "done").length;
    body.append(h("div", { class: "card", style: "margin-top:12px" },
      h("div", { class: "row between" }, h("div", { class: "row" }, h("img", { src: `api/projects/${p.id}/assets/${a.face}/thumb`, style: "width:56px;height:56px;object-fit:cover;border-radius:8px" }), h("div", null, h("b", null, a.name), h("div", { class: "muted small" }, `音频 ${a.audioDuration}s · ${a.segments.length} 段 · ${a.settings.width}×${a.settings.height} · ${a.settings.style === "enthusiastic" ? "热情" : "自然"} · ${a.settings.anchor ? "上一段末帧锚定" : "不锚定"}`))),
        h("div", { class: "row" }, h("button", { class: "sm", onclick: () => editAvatar(a) }, "编辑"),
          h("button", { class: "sm primary", disabled: a.auto || !a.segments.some((s) => !s.jobs.length), onclick: async () => { try { await api(`/projects/${p.id}/avatars/${a.id}/generate-all`, { method: "POST" }); toast("链式生成已开始，每段完成后自动接下一段", "ok"); await reload(); drawAvatars(); } catch (e) { toast(e.message, "error"); } } }, a.auto ? "链式生成中…" : "生成全部（链式）"),
          h("button", { class: "sm", disabled: done < a.segments.length, onclick: async () => { prog.textContent = "开始…"; try { await api(`/projects/${p.id}/avatars/${a.id}/assemble`, { method: "POST", body: {} }); prog.textContent = ""; await reload(); location.hash = `#/project/${p.id}/renders`; } catch (e) { prog.textContent = ""; toast(e.message, "error"); } } }, `🎞 拼接成片 (${done}/${a.segments.length})`),
          h("button", { class: "sm danger", onclick: async () => { if (await confirm("删除这个数字人任务？（take 保留在任务列表）", { danger: true })) { await api(`/projects/${p.id}/avatars/${a.id}`, { method: "DELETE" }); curAvatar = null; await reload(); drawAvatars(); } } }, "删除"))), prog,
      h("audio", { src: `api/projects/${p.id}/assets/${a.audio}/file`, controls: true, style: "width:100%;margin-top:8px" })));
    const tbl = h("table", { style: "margin-top:12px" }, h("tr", null, h("th", null, "#"), h("th", null, "时间"), h("th", null, "帧"), h("th", null, "锚定"), h("th", null, "Takes"), h("th", null, "")));
    for (const s of a.segments) tbl.append(h("tr", null, h("td", null, s.index + 1), h("td", { class: "mono small" }, `${s.start.toFixed(2)}–${s.end.toFixed(2)}`, h("br"), `${s.duration.toFixed(2)}s`), h("td", { class: "mono small" }, `${s.frames}`), h("td", null, s.anchor ? h("img", { src: `api/projects/${p.id}/assets/${s.anchor}/thumb`, style: "width:64px;border-radius:4px", title: "本段末帧（下一段的构图锚）" }) : h("span", { class: "muted small" }, "—")),
      h("td", null, h("div", { class: "takes", id: `atakes-${a.id}-${s.index}`, style: "margin:0" })),
      h("td", null, h("div", { class: "col", style: "gap:4px" }, h("button", { class: "sm" + (s.jobs.length ? "" : " primary"), onclick: async () => { try { await api(`/projects/${p.id}/avatars/${a.id}/segments/${s.index}/generate`, { method: "POST", body: {} }); toast(`已排队第 ${s.index + 1} 段`, "ok"); await reload(); drawAvatars(); } catch (e) { toast(e.message, "error"); } } }, s.jobs.length ? "重拍" : "生成"), h("button", { class: "sm ghost", onclick: async () => { const r = await api(`/projects/${p.id}/avatars/${a.id}/segments/${s.index}/prompt`); modal(`第 ${s.index + 1} 段提示词`, h("pre", null, r.prompt)); } }, "提示词"), h("audio", { src: `api/projects/${p.id}/assets/${s.audioAsset}/file`, controls: true, style: "width:150px;height:28px" })))));
    body.append(h("div", { class: "card", style: "margin-top:12px" }, h("h3", null, "分段"), tbl));
    drawAvatarTakes(a.id);
    function newAvatar() { editAvatar({ name: "", face: null, audio: null, settings: { width: 640, height: 736, seed: 8100, steps: 8, style: "natural", anchor: true }, prompt: { desc: "", scene: "a softly lit neutral studio background", language: "Chinese" }, maxLen: 14.8 }, true); }
    function editAvatar(a0, isNew = false) {
      let face = a0.face, audio = a0.audio;
      const faceBox = h("div", { class: "refs" }), audioBox = h("div", { class: "refs" });
      const drawPick = () => { faceBox.innerHTML = ""; faceBox.append(face ? h("div", { class: "ref", style: "width:80px" }, h("img", { src: `api/projects/${p.id}/assets/${face}/thumb`, style: "width:80px;height:80px" }), h("span", { class: "lbl" }, "头像")) : null, isNew ? h("div", { class: "ref add", style: "width:80px;height:80px", onclick: async () => { const [id] = await pickAssets(p.id, { multi: false, title: "选头像（头肩照，正面）" }); if (id) { face = id; drawPick(); } } }, "＋") : null); audioBox.innerHTML = ""; audioBox.append(audio ? h("div", { class: "ref", style: "width:160px" }, h("img", { src: `api/projects/${p.id}/assets/${audio}/thumb`, style: "width:160px;height:80px;object-fit:cover" }), h("span", { class: "lbl" }, "音频")) : null, isNew ? h("div", { class: "ref add", style: "width:80px;height:80px", onclick: async () => { const [id] = await pickAssets(p.id, { kind: "audio", multi: false, title: "选驱动音频（mp3/wav/m4a）" }); if (id) { audio = id; drawPick(); } } }, "＋") : null,
        isNew ? h("div", { class: "ref add", style: "width:80px;height:80px;font-size:11px;text-align:center;line-height:1.3", title: "把文稿交给 GPU 上的 IndexTTS-2 配音，生成的音频自动存为本项目素材并选为驱动音频", onclick: () => ttsToAsset(p.id, (na) => { audio = na.id; drawPick(); }) }, "文稿→\nTTS 配音") : null); };
      drawPick();
      const f = { name: h("input", { value: a0.name, placeholder: "例如 讲解员" }), desc: h("input", { value: a0.prompt.desc, placeholder: "the person in <Picture 1>（可补充：眼镜、发型、衣服）" }), scene: h("input", { value: a0.prompt.scene }), lang: h("select", null, ["Chinese", "English", "Japanese", "Korean", "Cantonese"].map((l) => h("option", { value: l, selected: l === a0.prompt.language }, l))), style: h("select", null, h("option", { value: "natural", selected: a0.settings.style === "natural" }, "自然"), h("option", { value: "enthusiastic", selected: a0.settings.style === "enthusiastic" }, "热情生动")), width: h("input", { type: "number", step: 32, value: a0.settings.width }), height: h("input", { type: "number", step: 32, value: a0.settings.height }), seed: h("input", { type: "number", value: a0.settings.seed }), maxLen: h("input", { type: "number", step: 0.5, min: 3, max: 14.8, value: a0.maxLen ?? 14.8 }), anchor: h("input", { type: "checkbox", checked: a0.settings.anchor !== false }) };
      modal(isNew ? "新建数字人" : "编辑数字人", h("div", null, h("label", null, "名称"), f.name, h("label", null, "头像"), faceBox, h("label", null, "驱动音频"), audioBox,
        h("div", { class: "row" }, h("div", { style: "flex:1" }, h("label", null, "人物描述（英文）"), f.desc), h("div", { style: "flex:1" }, h("label", null, "背景（英文）"), f.scene)),
        h("div", { class: "row" }, h("div", null, h("label", null, "台词语言"), f.lang), h("div", null, h("label", null, "表演风格"), f.style), h("div", null, h("label", null, "宽"), f.width), h("div", null, h("label", null, "高"), f.height), h("div", null, h("label", null, "Seed"), f.seed), isNew ? h("div", null, h("label", null, "每段最长(秒)"), f.maxLen) : null),
        h("label", { class: "inline", style: "margin-top:8px" }, f.anchor, "用上一段末帧锚定构图（推荐）"),
        h("p", { class: "hint" }, "竖版 640×736 适合口播；横版可选 832×448。切段在静音处，段越短越稳但接缝越多。")),
        { actions: [{ label: "取消" }, { label: isNew ? "创建并切段" : "保存", primary: true, onclick: async () => { const body = { name: f.name.value, face, audio, desc: f.desc.value, scene: f.scene.value, language: f.lang.value, style: f.style.value, width: Number(f.width.value), height: Number(f.height.value), seed: Number(f.seed.value), maxLen: Number(f.maxLen.value), anchor: f.anchor.checked }; if (isNew) { if (!face || !audio) throw new Error("头像和音频都要选"); const r = await api(`/projects/${p.id}/avatars`, { method: "POST", body }); curAvatar = r.id; } else await api(`/projects/${p.id}/avatars/${a0.id}`, { method: "PATCH", body: { name: body.name, settings: { width: body.width, height: body.height, seed: body.seed, style: body.style, anchor: body.anchor }, prompt: { desc: body.desc, scene: body.scene, language: body.language } } }); await reload(); drawAvatars(); } }] });
    }
  }
  function drawAvatarTakes(aid) {
    const a = (p.avatars || []).find((x) => x.id === aid); if (!a) return;
    for (const s of a.segments) {
      const box = document.getElementById(`atakes-${aid}-${s.index}`); if (!box) continue;
      box.innerHTML = "";
      if (!s.jobs.length) { box.append(h("span", { class: "muted small" }, "—")); continue; }
      if (s.jobs.filter((id) => S.jobs.get(id)?.output).length >= 2) box.append(h("div", { class: "take", style: "width:110px;display:grid;place-items:center;cursor:pointer", onclick: () => compareTakes(s.jobs) }, h("span", { class: "muted small", style: "text-align:center;padding:8px 4px" }, "⇆ 并排对比")));
      s.jobs.forEach((jid, i) => { const j = S.jobs.get(jid); const pct = j?.progress?.max ? Math.round(100 * j.progress.value / j.progress.max) : 0; box.append(h("div", { class: "take" + (s.pick === jid ? " pick" : ""), style: "width:110px", onclick: () => j && jobDetail(jid) }, j?.output ? h("img", { src: `api/jobs/${jid}/poster` }) : h("div", { style: "aspect-ratio:16/9;background:#000;border-radius:5px;display:grid;place-items:center;font-size:11px;color:#777" }, j ? STATUS_ZH[j.status] : "已删除"), j && isActive(j) ? h("div", { class: "progress" + (j.status === "running" ? "" : " indet"), style: "margin-top:4px" }, h("i", { style: `width:${j.status === "running" ? pct : 35}%` })) : null, h("div", { class: "t" }, h("span", null, `take ${i + 1}`), h("button", { class: "sm ghost", style: "padding:0 6px", onclick: async (ev) => { ev.stopPropagation(); await api(`/projects/${p.id}/avatars/${aid}`, { method: "PATCH", body: { segments: [{ index: s.index, pick: jid }] } }); s.pick = jid; drawAvatarTakes(aid); } }, s.pick === jid ? "✓ 选用" : "选用")))); });
    }
  }

  // ---- video edit wizard tab ----
  async function drawEdits() {
    const token = ++bodyDraw;
    body.innerHTML = "";
    const edits = p.edits || [];
    if (!curEdit || !edits.some((e) => e.id === curEdit)) curEdit = edits[0]?.id || null;
    const top = h("div", { class: "card" });
    const thr = h("input", { type: "number", step: 0.05, min: 0.05, max: 0.95, value: 0.3, style: "width:80px" }), minLen = h("input", { type: "number", step: 0.1, min: 0.3, value: 0.8, style: "width:80px" });
    top.append(h("div", { class: "row between" }, h("h2", null, "视频编辑向导"), h("div", { class: "row" },
      edits.length ? h("select", { onchange: (e) => { curEdit = e.target.value; drawEdits(); } }, edits.map((e) => h("option", { value: e.id, selected: e.id === curEdit }, e.name))) : null,
      h("label", { class: "inline small" }, "切镜阈值 ", thr), h("label", { class: "inline small" }, "最短镜头(秒) ", minLen),
      h("button", { class: "primary", onclick: async () => { const [aid] = await pickAssets(p.id, { kind: "video", multi: false, title: "选择源视频（手机录屏先在素材里切段裁掉界面也可）" }); if (!aid) return; toast("切镜检测中…", "info"); try { const e = await api(`/projects/${p.id}/edits`, { method: "POST", body: { sourceAssetId: aid, threshold: Number(thr.value), minLen: Number(minLen.value) } }); curEdit = e.id; await reload(); drawEdits(); toast(`检测到 ${e.shots.length} 个镜头`, "ok"); } catch (e) { toast(e.message, "error"); } } }, "＋ 一键分镜"))),
      h("p", { class: "hint" }, "流程：源视频 → 切镜 → 勾选要换脸/重画的镜头 → 选新人物参考图（头肩照 + 多角度母图）→ 逐镜头生成（源段当 <Video 1>，原声 fully_copy）→ 不满意的镜头重拍 → 拼回：没选的镜头用原片，选了的用结果，最后铺回原声。"));
    body.append(top);
    if (!curEdit) { body.append(h("div", { class: "card muted", style: "margin-top:12px" }, "还没有编辑任务。上传源视频到素材后点「一键分镜」。")); return; }
    const e = edits.find((x) => x.id === curEdit);
    const f = {};
    const inp = (k, v, attrs = {}) => (f[k] = h("input", { value: v ?? "", ...attrs }));
    const refsBox = h("div", { class: "refs" });
    const drawRefs = () => { refsBox.innerHTML = ""; e.refs.forEach((aid, i) => refsBox.append(h("div", { class: "ref" }, h("img", { src: `api/projects/${p.id}/assets/${aid}/thumb` }), h("span", { class: "lbl" }, `<Picture ${i + 1}>`), h("button", { class: "x", onclick: async () => { await api(`/projects/${p.id}/edits/${e.id}`, { method: "PATCH", body: { refs: e.refs.filter((x) => x !== aid) } }); await reload(); drawEdits(); } }, "✕")))); refsBox.append(h("div", { class: "ref add", onclick: async () => { const ids = await pickAssets(p.id, { multi: true, title: "新人物参考图（照片 + 正/侧/四分之三母图）" }); if (ids.length) { await api(`/projects/${p.id}/edits/${e.id}`, { method: "PATCH", body: { refs: [...e.refs, ...ids].slice(0, 9) } }); await reload(); drawEdits(); } } }, "＋ 参考图")); };
    drawRefs();
    const saveSettings = () => api(`/projects/${p.id}/edits/${e.id}`, { method: "PATCH", body: { name: f.name.value, settings: { width: Number(f.width.value), height: Number(f.height.value), headHold: Number(f.head.value), tailHold: Number(f.tail.value), steps: Number(f.steps.value), seed: Number(f.seed.value), refSize: f.refSize.value, audio: f.audio.value, crop: Number(f.cw.value) ? { x: Number(f.cx.value), y: Number(f.cy.value), w: Number(f.cw.value), h: Number(f.ch.value) } : null }, prompt: { target: f.target.value, face: f.face.value, keep: f.keep.value, style: f.style.value } } }).then(async (ne) => { Object.assign(e, ne); toast("已保存", "ok", 1200); }).catch((err) => toast(err.message, "error"));
    f.refSize = h("select", null, h("option", { value: "max" }, "max（脸最像）"), h("option", { value: "match" }, "match（快）")); f.refSize.value = e.settings.refSize;
    f.audio = h("select", null, h("option", { value: "original" }, "铺回原声（推荐）"), h("option", { value: "generated" }, "用生成结果的声音")); f.audio.value = e.settings.audio;
    const prog = h("div", { class: "hint" });
    listen("render", (ev) => { if (ev.detail.editId === e.id) prog.textContent = ev.detail.text; });
    body.append(h("div", { class: "grid g2", style: "margin-top:12px" },
      h("div", { class: "card" }, h("h3", null, "设置"), h("label", null, "名称"), inp("name", e.name),
        h("div", { class: "row" }, h("div", null, h("label", null, "宽"), inp("width", e.settings.width, { type: "number", step: 32 })), h("div", null, h("label", null, "高"), inp("height", e.settings.height, { type: "number", step: 32 })), h("div", null, h("label", null, "头部定格帧"), inp("head", e.settings.headHold, { type: "number" })), h("div", null, h("label", null, "尾部定格帧"), inp("tail", e.settings.tailHold, { type: "number" })), h("div", null, h("label", null, "步数"), inp("steps", e.settings.steps, { type: "number" })), h("div", null, h("label", null, "Seed"), inp("seed", e.settings.seed, { type: "number" }))),
        h("label", null, `裁剪（源像素 x y w h；源 ${e.source.width}×${e.source.height}，留空不裁）`), h("div", { class: "row" }, inp("cx", e.settings.crop?.x ?? "", { type: "number", placeholder: "x" }), inp("cy", e.settings.crop?.y ?? "", { type: "number", placeholder: "y" }), inp("cw", e.settings.crop?.w ?? "", { type: "number", placeholder: "w" }), inp("ch", e.settings.crop?.h ?? "", { type: "number", placeholder: "h" })),
        h("div", { class: "row" }, h("div", { style: "flex:1" }, h("label", null, "参考图分辨率"), f.refSize), h("div", { style: "flex:1" }, h("label", null, "成片声音"), f.audio)),
        h("p", { class: "hint" }, `源 ${e.source.duration.toFixed(1)}s · ${e.source.fps ? e.source.fps.toFixed(0) + "fps" : ""} · ${e.shots.length} 镜头。头部定格 ≥12 帧让模型先锁定源片；分块 ≤15 秒。`)),
      h("div", { class: "card" }, h("h3", null, "新人物与提示词"), h("label", null, "参考图（脸 + 头发 + 眼镜都从这里来）"), refsBox,
        h("label", null, "被替换的人（写清源片里怎么认）"), inp("target", e.prompt.target), h("label", null, "新人物描述（脸型、发型、眼镜…）"), inp("face", e.prompt.face), h("label", null, "其他人"), inp("keep", e.prompt.keep), h("label", null, "补充风格句（可选）"), inp("style", e.prompt.style),
        h("div", { class: "row", style: "margin-top:10px" }, h("button", { class: "primary", onclick: saveSettings }, "保存设置"), h("button", { onclick: async () => { await saveSettings(); const sel = e.shots.filter((s) => s.selected && !s.jobs.length); if (!sel.length) return toast("没有待生成的已勾选镜头"); if (await confirm(`为 ${sel.length} 个镜头各生成一条？`)) { try { const r = await api(`/projects/${p.id}/edits/${e.id}/generate-all`, { method: "POST" }); toast(`已排队 ${r.length} 个镜头`, "ok"); await reload(); drawEdits(); } catch (err) { toast(err.message, "error"); } } } }, "生成所选镜头"), h("button", { onclick: async () => { prog.textContent = "开始…"; try { const r = await api(`/projects/${p.id}/edits/${e.id}/assemble`, { method: "POST", body: {} }); prog.textContent = ""; await reload(); location.hash = `#/project/${p.id}/renders`; } catch (err) { prog.textContent = ""; toast(err.message, "error"); } } }, "🎞 拼回成片"), h("button", { class: "danger", style: "margin-left:auto", onclick: async () => { if (await confirm("删除这个编辑任务？（生成的 take 保留在任务列表）", { danger: true })) { await api(`/projects/${p.id}/edits/${e.id}`, { method: "DELETE" }); curEdit = null; await reload(); drawEdits(); } } }, "删除")), prog)));
    // shots table
    const tbl = h("table", { style: "margin-top:12px" }, h("tr", null, h("th", null, "换"), h("th", null, "#"), h("th", null, "三帧"), h("th", null, "时间"), h("th", null, "本镜头发生了什么（可选，写进提示词）"), h("th", null, "Takes"), h("th", null, "")));
    for (const s of e.shots) {
      const cb = h("input", { type: "checkbox", checked: s.selected, onchange: () => api(`/projects/${p.id}/edits/${e.id}`, { method: "PATCH", body: { shots: [{ index: s.index, selected: cb.checked }] } }).then((ne) => Object.assign(e, ne)) });
      const desc = h("input", { value: s.desc || "", placeholder: "例如：he turns to the camera and says the line", onchange: () => api(`/projects/${p.id}/edits/${e.id}`, { method: "PATCH", body: { shots: [{ index: s.index, desc: desc.value }] } }).then((ne) => Object.assign(e, ne)) });
      const takes = h("div", { class: "takes", id: `etakes-${e.id}-${s.index}`, style: "margin:0" });
      tbl.append(h("tr", null, h("td", null, cb), h("td", null, s.index + 1), h("td", null, s.strip ? h("img", { src: `api/projects/${p.id}/edits/${e.id}/shots/${s.index}/strip`, style: "width:240px;border-radius:4px" }) : "—"), h("td", { class: "mono small" }, `${s.start.toFixed(2)}–${s.end.toFixed(2)}`, h("br"), `${s.duration.toFixed(2)}s`), h("td", null, desc), h("td", null, takes),
        h("td", null, h("div", { class: "col", style: "gap:4px" }, h("button", { class: "sm primary", onclick: async () => { try { const j = await api(`/projects/${p.id}/edits/${e.id}/shots/${s.index}/generate`, { method: "POST", body: {} }); toast(`已排队 take ${s.jobs.length + 1}`, "ok"); s.jobs.push(j.id); if (!s.pick) s.pick = j.id; s.selected = true; cb.checked = true; drawEditTakes(e.id); } catch (err) { toast(err.message, "error"); } } }, s.jobs.length ? "重拍" : "生成"), h("button", { class: "sm", onclick: async () => { const r = await api(`/projects/${p.id}/edits/${e.id}/shots/${s.index}/prompt`); modal(`镜头 ${s.index + 1} 提示词`, h("pre", null, r.prompt), { actions: [{ label: "复制", onclick: () => { copy(r.prompt); return false; } }, { label: "关闭" }] }); } }, "提示词")))));
    }
    body.append(h("div", { class: "card", style: "margin-top:12px" }, h("h3", null, `分镜表 · ${e.shots.filter((s) => s.selected).length}/${e.shots.length} 选中`), tbl));
    drawEditTakes(e.id);
  }
  function drawEditTakes(eid) {
    const e = (p.edits || []).find((x) => x.id === eid); if (!e) return;
    for (const s of e.shots) {
      const box = document.getElementById(`etakes-${eid}-${s.index}`); if (!box) continue;
      box.innerHTML = "";
      if (!s.jobs.length) { box.append(h("span", { class: "muted small" }, "—")); continue; }
      if (s.jobs.filter((id) => S.jobs.get(id)?.output).length >= 2) box.append(h("div", { class: "take", style: "width:110px;display:grid;place-items:center;cursor:pointer", onclick: () => compareTakes(s.jobs) }, h("span", { class: "muted small", style: "text-align:center;padding:8px 4px" }, "⇆ 并排对比")));
      s.jobs.forEach((jid, i) => { const j = S.jobs.get(jid); const pct = j?.progress?.max ? Math.round(100 * j.progress.value / j.progress.max) : 0; box.append(h("div", { class: "take" + (s.pick === jid ? " pick" : ""), style: "width:120px", onclick: () => j && jobDetail(jid) }, j?.output ? h("img", { src: `api/jobs/${jid}/poster` }) : h("div", { style: "aspect-ratio:16/9;background:#000;border-radius:5px;display:grid;place-items:center;font-size:11px;color:#777" }, j ? STATUS_ZH[j.status] : "已删除"), j && isActive(j) ? h("div", { class: "progress" + (j.status === "running" ? "" : " indet"), style: "margin-top:4px" }, h("i", { style: `width:${j.status === "running" ? pct : 35}%` })) : null, h("div", { class: "t" }, h("span", null, `take ${i + 1}`), h("button", { class: "sm ghost", style: "padding:0 6px", onclick: async (ev) => { ev.stopPropagation(); await api(`/projects/${p.id}/edits/${eid}`, { method: "PATCH", body: { shots: [{ index: s.index, pick: jid }] } }); s.pick = jid; drawEditTakes(eid); } }, s.pick === jid ? "✓ 选用" : "选用")))); });
    }
  }

  // ---- renders tab ----
  function drawRenders() {
    ++bodyDraw;
    body.innerHTML = "";
    const a = p.assemble, st = a.style;
    const f = { blackTail: h("input", { type: "number", step: 0.5, min: 0, value: a.blackTail }), lufs: h("input", { type: "number", value: a.lufs }), upscale: h("select", null, h("option", { value: 1 }, "1×（原尺寸）"), h("option", { value: 2 }, "2×（lanczos 放大）")), subtitles: h("input", { type: "checkbox", checked: a.subtitles !== false }), fontSize: h("input", { type: "number", value: st.fontSize }), color: h("input", { type: "color", value: st.color }), outlineColor: h("input", { type: "color", value: st.outlineColor }), outline: h("input", { type: "number", step: 0.2, value: st.outline }), marginV: h("input", { type: "number", value: st.marginV }), align: h("select", null, h("option", { value: "bottom" }, "底部"), h("option", { value: "top" }, "顶部")), bold: h("input", { type: "checkbox", checked: !!st.bold }), box: h("input", { type: "checkbox", checked: !!st.box }) };
    f.upscale.value = String(a.upscale || 1); f.align.value = st.align || "bottom";
    const saveAsm = () => save({ assemble: { blackTail: Number(f.blackTail.value), lufs: Number(f.lufs.value), upscale: Number(f.upscale.value), subtitles: f.subtitles.checked, style: { fontSize: Number(f.fontSize.value), color: f.color.value, outlineColor: f.outlineColor.value, outline: Number(f.outline.value), marginV: Number(f.marginV.value), align: f.align.value, bold: f.bold.checked, box: f.box.checked } } });
    const prog = h("div", { class: "hint" });
    listen("render", (e) => { if (e.detail.projectId === p.id) prog.textContent = e.detail.text; });
    const ready = p.clips.filter((c) => c.pick || c.takes.length);
    body.append(h("div", { class: "grid g2" },
      h("div", { class: "card" }, h("h2", null, "拼接设置"), h("p", { class: "hint" }, `按片段顺序拼接已选用的 take（${ready.length}/${p.clips.length} 段就绪）。每段单独响度归一（整片一起归一会让轻的段台词被环境音盖掉），末尾加黑场。`),
        h("div", { class: "row" }, h("div", { style: "flex:1" }, h("label", null, "结尾黑场（秒）"), f.blackTail), h("div", { style: "flex:1" }, h("label", null, "目标响度 LUFS"), f.lufs), h("div", { style: "flex:1" }, h("label", null, "放大"), f.upscale)),
        h("div", { class: "row", style: "margin-top:10px" }, h("button", { class: "primary", onclick: async () => { await saveAsm(); prog.textContent = "开始…"; try { const r = await api(`/projects/${p.id}/assemble`, { method: "POST", body: {} }); prog.textContent = ""; await reload(); drawRenders(); renderDetail(r); } catch (e) { prog.textContent = ""; toast(e.message, "error"); } } }, "🎞 拼接成片"), h("button", { onclick: () => saveAsm().then(() => toast("已保存", "ok", 1500)) }, "保存设置")), prog),
      h("div", { class: "card" }, h("h2", null, "字幕样式"), h("label", { class: "inline" }, f.subtitles, "烧录字幕（字幕在各片段里编辑）"),
        h("div", { class: "row", style: "margin-top:8px" }, h("div", null, h("label", null, "字号（按 896p 高度）"), f.fontSize), h("div", null, h("label", null, "颜色"), f.color), h("div", null, h("label", null, "描边色"), f.outlineColor), h("div", null, h("label", null, "描边宽"), f.outline), h("div", null, h("label", null, "底边距"), f.marginV), h("div", null, h("label", null, "位置"), f.align)),
        h("div", { class: "row", style: "margin-top:8px" }, h("label", { class: "inline" }, f.bold, "粗体"), h("label", { class: "inline" }, f.box, "半透明底框")), h("p", { class: "hint" }, `字体：${S.meta.fontName}（服务器 libass 渲染）。也可下载 .srt 自己压。`))));
    const list = h("div", { class: "grid g3", style: "margin-top:14px" });
    body.append(h("h2", { style: "margin-top:18px" }, "成片"), list);
    if (!p.renders.length) list.append(h("p", { class: "muted" }, "还没有成片。"));
    for (const r of p.renders) list.append(h("div", { class: "card tight", style: "cursor:pointer", onclick: () => renderDetail(r) }, h("img", { class: "thumb", src: `api/projects/${p.id}/renders/${r.id}/poster` }), h("div", { class: "name", style: "margin-top:6px" }, r.name), h("div", { class: "muted small" }, `${r.duration}s · ${r.width}×${r.height} · ${r.clips.length} 段 · ${r.cues.length} 条字幕 · ${fmtDate(r.createdAt)}`), r.share ? h("div", { class: "small" }, h("a", { href: r.share.url, target: "_blank", onclick: (e) => e.stopPropagation() }, "分享链接")) : null));
  }
  function renderDetail(r) {
    const base = `api/projects/${p.id}/renders/${r.id}`;
    const shareBox = h("div");
    const drawShare = () => { shareBox.innerHTML = ""; if (r.share) shareBox.append(h("pre", null, r.share.url), h("div", { class: "muted small" }, r.share.permanent ? "永久链接" : "7 天有效")); };
    drawShare();
    modal(r.name, h("div", null, h("video", { class: "player", src: `${base}/file`, controls: true, autoplay: false }),
      h("div", { class: "row", style: "margin-top:10px" }, h("a", { class: "btn sm", href: `${base}/file?download=1` }, "下载成片"), r.nosub ? h("a", { class: "btn sm", href: `${base}/nosub?download=1` }, "下载无字幕版") : null, h("a", { class: "btn sm", href: `${base}/srt?download=1` }, "下载 .srt"),
        S.meta.fileshare ? h("button", { class: "sm", onclick: () => api(`${base}/share`, { method: "POST", body: {} }).then((s) => { r.share = s; drawShare(); copy(s.url); }).catch((e) => toast(e.message, "error")) }, "生成分享链接") : null,
        S.meta.fileshare ? h("button", { class: "sm", onclick: () => api(`${base}/share`, { method: "POST", body: { permanent: true } }).then((s) => { r.share = s; drawShare(); copy(s.url); }).catch((e) => toast(e.message, "error")) }, "永久链接") : null,
        h("button", { class: "sm danger", style: "margin-left:auto", onclick: async () => { if (await confirm("删除这个成片？", { danger: true })) { await api(base, { method: "DELETE" }); await reload(); drawRenders(); } } }, "删除")),
      shareBox, h("div", { class: "muted small", style: "margin-top:6px" }, r.cues.map((c) => `${c.start.toFixed(1)}–${c.end.toFixed(1)}s ${c.text}`).join(" · "))));
  }
};


// ================= Prompt library page =================
routes.prompts = async (main, tab = "open") => {
  const [status, facets] = await Promise.all([api("/prompts/status"), api("/prompts/facets")]);
  S.promptStatus = status;
  const tabs = h("div", { class: "tabs" }, h("a", { href: "#/prompts/open", class: tab === "open" ? "active" : "" }, `OpenPrompt 镜像 (${status.items})`), h("a", { href: "#/prompts/mine", class: tab === "mine" ? "active" : "" }, "我的提示词"));
  main.append(h("h1", null, "提示词库"), tabs);
  if (tab === "mine") return drawMine(main);
  // ---- status / sync card
  const sc = h("div", { class: "card tight", style: "margin-bottom:12px" });
  const drawStatus = (st) => {
    S.promptStatus = st; sc.innerHTML = "";
    const sy = st.syncing;
    sc.append(h("div", { class: "row between" },
      h("div", { class: "small" }, h("b", null, `${st.items} 条视频提示词`), h("span", { class: "muted" }, ` · 已打标 ${st.tagged} · 已向量化 ${st.embedded} · 打标模型 ${st.tagModel || "未配置"} · 向量 ${st.embedModel || "未配置"} · 上次同步 ${st.lastSync ? fmtDate(st.lastSync) : "从未"}`), st.lastError ? h("div", { class: "bad small" }, "最近错误：" + st.lastError) : null),
      h("div", { class: "row" }, sy ? h("span", { class: "badge running" }, `${({ catalog: "读目录", details: "读详情", tags: "打标", embed: "向量化" })[sy.phase] || sy.phase} ${sy.done}/${sy.total || "?"}`) : null,
        h("button", { class: "sm", disabled: !!sy, onclick: () => api("/prompts/sync", { method: "POST", body: {} }).then(() => toast("开始同步（增量）", "info")).catch((e) => toast(e.message, "error")) }, "同步新条目"),
        h("button", { class: "sm ghost", disabled: !!sy, onclick: async () => { if (await confirm("用 " + (st.tagModel || "LLM") + " 给全部提示词重新打标并重新向量化？约 " + st.items + " 条。")) api("/prompts/sync", { method: "POST", body: { retag: true, reembed: true } }).then(() => toast("开始全量重打标", "info")).catch((e) => toast(e.message, "error")); } }, "全部重新打标"),
        h("button", { class: "sm", onclick: () => statsModal() }, "标签统计"),
        h("a", { class: "btn sm", href: st.source, target: "_blank", rel: "noopener" }, "源站"))));
    if (sy) sc.append(h("div", { class: "progress", style: "margin-top:6px" }, h("i", { style: `width:${sy.total ? Math.round(100 * sy.done / sy.total) : 5}%` })));
  };
  drawStatus(status);
  let wasSyncing = !!status.syncing;
  listen("prompts", async (e) => { drawStatus(e.detail); if (wasSyncing && !e.detail.syncing) { Object.assign(facets, await api("/prompts/facets")); drawTags(); run(); } wasSyncing = !!e.detail.syncing; });
  async function statsModal() {
    const fc = await api("/prompts/facets");
    const bar = (rows, total, onPick) => h("div", { class: "col", style: "gap:4px" }, rows.map(([k, n]) => h("div", { class: "row", style: "gap:8px;cursor:pointer", onclick: () => onPick(k) }, h("span", { style: "width:130px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, k), h("div", { class: "progress", style: "flex:1;height:10px" }, h("i", { style: `width:${Math.max(1, Math.round(100 * n / total))}%` })), h("span", { class: "muted small", style: "width:56px;text-align:right" }, n))));
    const modeName = (m) => ({ t2v: "文生视频", i2v: "首帧驱动", ref: "参考模式", edit: "视频编辑", avatar: "数字人", other: "其它" })[m] || m;
    const m = modal(`标签统计 · ${fc.total} 条`, h("div", { class: "grid g2" },
      h("div", null, h("h3", null, "模型"), bar(fc.models, fc.total, (k) => { modelSel.value = k; m.close(); run(); }), h("h3", { style: "margin-top:12px" }, "模式（打标结果）"), bar(fc.modes.map(([k, n]) => [modeName(k), n]), fc.total, () => {}), h("p", { class: "muted small", style: "margin-top:10px" }, `含台词 ${fc.dialogue} 条 · 已是 H3 官方格式 ${fc.h3fmt} 条 · 我的提示词 ${fc.library} 条 · 题材 ${fc.categories.length} 类`)),
      h("div", null, h("h3", null, `标签 Top ${Math.min(200, fc.tags.length)}（点击筛选）`), h("div", { style: "max-height:60vh;overflow:auto" }, bar(fc.tags, fc.tags[0]?.[1] || 1, (k) => { f.tag = k; drawTags(); m.close(); run(); })))));
  }
  // ---- filters + search
  const f = { q: "", model: "", mode: "", tag: "", category: "", h3: false, semantic: true, page: 1, author: "", dur: "" };
  const DUR = { "": [null, null], "s5": [null, 5.2], "s10": [5.2, 10.5], "s15": [10.5, 15.5], "l15": [15.5, null] };
  const authorSel = h("select", null, h("option", { value: "" }, "全部作者"), (facets.authors || []).map(([a, n]) => h("option", { value: a }, `@${a} (${n})`)));
  const durSel = h("select", null, h("option", { value: "" }, "全部时长"), h("option", { value: "s5" }, "≤5 秒"), h("option", { value: "s10" }, "5–10 秒"), h("option", { value: "s15" }, "10–15 秒"), h("option", { value: "l15" }, ">15 秒"));
  const qEl = h("input", { placeholder: "语义搜索：描述你要的画面 / 题材 / 镜头，例如：雨夜霓虹街头 女孩 静态镜头", style: "flex:1" });
  const modelSel = h("select", null, h("option", { value: "" }, "全部模型"), facets.models.map(([m, n]) => h("option", { value: m }, `${m} (${n})`)));
  const modeSel = h("select", null, h("option", { value: "" }, "全部模式"), facets.modes.map(([m, n]) => h("option", { value: m }, `${({ t2v: "文生", i2v: "首帧", ref: "参考", edit: "编辑/换脸", avatar: "数字人", other: "其它" })[m] || m} (${n})`)));
  const catSel = h("select", null, h("option", { value: "" }, "全部题材"), facets.categories.map(([m, n]) => h("option", { value: m }, `${m} (${n})`)));
  const tagBox = h("div", { class: "row", style: "gap:4px;flex-wrap:wrap;margin:8px 0" });
  const PAGE = 60;   // 原来 30 条一页，翻不过来
  const drawTags = () => { tagBox.innerHTML = ""; for (const [t, n] of facets.tags.slice(0, 40)) tagBox.append(h("span", { class: "badge" + (f.tag === t ? " on" : ""), style: "cursor:pointer", title: `${n} 条`, onclick: () => { f.tag = f.tag === t ? "" : t; f.page = 1; drawTags(); run(); } }, t)); };
  drawTags();
  const results = h("div", { class: "grid g3" }), info = h("div", { class: "hint" }), pager = h("div", { class: "row", style: "margin-top:10px" });
  async function run() {
    f.q = qEl.value.trim(); f.model = modelSel.value; f.mode = modeSel.value; f.category = catSel.value; f.author = authorSel.value; f.dur = durSel.value;
    const [dMin, dMax] = DUR[f.dur] || [null, null]; const extra = `&author=${encodeURIComponent(f.author)}${dMin != null ? "&durMin=" + dMin : ""}${dMax != null ? "&durMax=" + dMax : ""}`;
    info.textContent = "搜索中…"; results.innerHTML = ""; pager.innerHTML = "";
    try {
      let items, total, modeLabel;
      if (f.q && f.semantic) { const r = await api(`/prompts/search?q=${encodeURIComponent(f.q)}&k=30&model=${encodeURIComponent(f.model)}&mode=${f.mode}&tag=${encodeURIComponent(f.tag)}${f.h3 ? "&h3=1" : ""}${extra}`); items = r.results; total = items.length; modeLabel = r.mode === "vector" ? "语义匹配" : "关键词匹配"; }
      else { const r = await api(`/prompts/browse?q=${encodeURIComponent(f.q)}&model=${encodeURIComponent(f.model)}&mode=${f.mode}&tag=${encodeURIComponent(f.tag)}&category=${encodeURIComponent(f.category)}${f.h3 ? "&h3=1" : ""}${extra}&page=${f.page}&size=${PAGE}`); items = r.items; total = r.total; modeLabel = "按时间";
        // 每页 60 条，页数太多时光靠上一页/下一页翻不过来，所以给一个能直接输的页码框
        if (r.total > PAGE) {
          const last = Math.ceil(r.total / PAGE);
          const num = h("input", { type: "number", min: 1, max: last, value: f.page, style: "width:70px;text-align:center" });
          const go = () => { const n = Math.min(last, Math.max(1, Number(num.value) || 1)); if (n !== f.page) { f.page = n; run(); } else num.value = f.page; };
          num.onkeydown = (e) => { if (e.key === "Enter") go(); };
          num.onchange = go;
          pager.append(
            h("button", { class: "sm", disabled: f.page <= 1, onclick: () => { f.page = 1; run(); } }, "« 首页"),
            h("button", { class: "sm", disabled: f.page <= 1, onclick: () => { f.page--; run(); } }, "上一页"),
            h("span", { class: "row", style: "gap:4px;align-items:center" }, h("span", { class: "muted small" }, "第"), num, h("span", { class: "muted small" }, `/ ${last} 页`)),
            h("button", { class: "sm", disabled: f.page * PAGE >= r.total, onclick: () => { f.page++; run(); } }, "下一页"),
            h("button", { class: "sm", disabled: f.page >= last, onclick: () => { f.page = last; run(); } }, "末页 »"));
        }
      }
      info.textContent = `${modeLabel} · ${total} 条`;
      if (!items.length) results.append(h("p", { class: "muted" }, S.promptStatus.items ? "没有匹配。" : "提示词库是空的，点上面「同步新条目」开始抓取 OpenPrompt。"));
      for (const it of items) results.append(h("div", { class: "card tight", style: "cursor:pointer", onclick: () => promptPreview(it) },
        it.image ? h("img", { class: "thumb", src: it.image, loading: "lazy", onerror: (e) => { e.target.style.display = "none"; } }) : null,
        h("div", { class: "row between", style: "margin-top:6px" }, h("b", { class: "small" }, it.title_zh || it.title), h("span", { class: "muted small" }, [it.model, it.duration, it.score != null ? Math.round(it.score * 100) + "%" : null].filter(Boolean).join(" · "))),
        h("div", { class: "muted small" }, it.summary_zh || ""),
        h("div", { class: "row", style: "gap:4px;flex-wrap:wrap;margin-top:4px" }, (it.tags || []).slice(0, 7).map((t) => h("span", { class: "badge" }, t)), it.h3_format ? h("span", { class: "badge done" }, "H3 格式") : null, it.has_dialogue ? h("span", { class: "badge" }, "有台词") : null),
        h("div", { class: "muted small", style: "margin-top:4px" }, it.author_handle ? "@" + it.author_handle + " · " : "", it.category || "", it.source_post_url ? h("a", { href: it.source_post_url, target: "_blank", rel: "noopener", onclick: (e) => e.stopPropagation(), style: "margin-left:6px" }, "溯源") : null)));
    } catch (e) { info.textContent = e.message; }
  }
  let t = null; qEl.oninput = () => { clearTimeout(t); t = setTimeout(() => { f.page = 1; run(); }, 700); }; qEl.onkeydown = (e) => { if (e.key === "Enter") { clearTimeout(t); f.page = 1; run(); } };
  for (const el of [modelSel, modeSel, catSel, authorSel, durSel]) el.onchange = () => { f.page = 1; run(); };
  main.append(sc, h("div", { class: "row filters" }, qEl, modelSel, modeSel, catSel, authorSel, durSel, h("label", { class: "inline small" }, h("input", { type: "checkbox", onchange: (e) => { f.h3 = e.target.checked; run(); } }), "只看 H3"), h("label", { class: "inline small" }, h("input", { type: "checkbox", checked: true, onchange: (e) => { f.semantic = e.target.checked; run(); } }), "语义搜索")), tagBox, info, results, pager);
  run();
  async function drawMine(root) {
    const q = h("input", { placeholder: "搜索名称 / 标签 / 内容", style: "flex:1" });
    const list = h("div", { class: "grid g3", style: "margin-top:10px" });
    const file = h("input", { type: "file", accept: ".json,application/json", hidden: true }); file.onchange = async () => { const f = file.files[0]; file.value = ""; if (!f) return; try { const data = JSON.parse(await f.text()); const items = Array.isArray(data) ? data : data.items; if (!Array.isArray(items)) throw new Error("JSON 里没有 items 数组"); const r = await api("/library/import", { method: "POST", body: items }); toast(`导入 ${r.added} 条，跳过重复 ${r.skipped} 条`, "ok"); draw(); } catch (e) { toast("导入失败：" + e.message, "error"); } };
    const draw = async () => {
      const items = await api("/library?q=" + encodeURIComponent(q.value));
      list.innerHTML = "";
      if (!items.length) list.append(h("p", { class: "muted" }, "还没有保存的提示词。在快速生成 / 片段的提示词框旁点「保存提示词」，或在 OpenPrompt 镜像里「收藏」。"));
      for (const it of items) list.append(h("div", { class: "card tight" }, h("div", { class: "row between" }, h("b", null, it.name), h("span", { class: "muted small" }, fmtDate(it.updatedAt))),
        h("div", { class: "row", style: "gap:4px;flex-wrap:wrap;margin:4px 0" }, it.mode ? h("span", { class: "badge on" }, it.mode) : null, (it.tags || []).map((t) => h("span", { class: "badge" }, t))),
        h("pre", { style: "max-height:120px;font-size:11px" }, it.text.slice(0, 600) + (it.text.length > 600 ? "…" : "")), it.note ? h("div", { class: "muted small" }, it.note) : null, it.source?.url ? h("a", { class: "small", href: it.source.url, target: "_blank", rel: "noopener" }, "来源") : null,
        h("div", { class: "row", style: "margin-top:6px" }, h("button", { class: "sm", onclick: () => copy(it.text) }, "复制"), h("button", { class: "sm primary", onclick: () => { S.clone = { mode: it.mode === "ref" ? "ref" : it.mode === "i2v" ? "i2v" : it.mode === "edit" || it.mode === "video" ? "video" : "t2v", projectId: S.projects[0]?.id || "default", images: [], videos: [], prompt: it.text, title: it.name }; location.hash = "#/generate/clone"; } }, "去快速生成"),
          h("button", { class: "sm", onclick: () => { const name = h("input", { value: it.name }), tags = h("input", { value: it.tags.join(", ") }), text = h("textarea", { class: "tall", value: it.text }), note = h("input", { value: it.note || "" }); modal("编辑提示词", h("div", null, h("label", null, "名称"), name, h("label", null, "标签"), tags, h("label", null, "内容"), text, h("label", null, "备注"), note), { actions: [{ label: "取消" }, { label: "保存", primary: true, onclick: async () => { await api(`/library/${it.id}`, { method: "PATCH", body: { name: name.value, tags: tags.value, text: text.value, note: note.value } }); draw(); } }] }); } }, "编辑"),
          h("button", { class: "sm danger", style: "margin-left:auto", onclick: async () => { if (await confirm(`删除「${it.name}」？`, { danger: true })) { await api(`/library/${it.id}`, { method: "DELETE" }); draw(); } } }, "删除"))));
    };
    q.oninput = () => draw();
    root.append(h("div", { class: "row" }, q, h("a", { class: "btn sm", href: "api/library/export", title: "导出全部为 JSON（含名称/标签/备注/来源）" }, "导出"), h("button", { class: "sm", title: "导入之前导出的 JSON；内容相同的会跳过", onclick: () => file.click() }, "导入"), file, h("button", { class: "primary", onclick: () => { const text = h("textarea", { class: "tall", placeholder: "粘贴或手写提示词" }); modal("新建提示词", h("div", null, text), { actions: [{ label: "取消" }, { label: "下一步", primary: true, onclick: () => { saveToLibrary({ text: text.value }); } }] }); } }, "＋ 新建")), list);
    draw();
    listen("hashchange", draw);
  }
};

// ================= Jobs =================
routes.jobs = async (main) => {
  const filt = { status: "", projectId: "", groupId: "" }; const sel = new Set();
  const [projects, groups] = await Promise.all([api("/projects"), api("/jobs/groups")]); S.projects = projects;
  const list = h("div", { class: "col" });
  const gSel = h("select", { onchange: () => { filt.groupId = gSel.value; draw(); } }, h("option", { value: "" }, "全部任务组"), groups.map((g) => h("option", { value: g.id }, `${g.title} (${g.done}/${g.count})`)));
  const sheetBtn = h("button", { class: "sm", hidden: true, onclick: async () => { try { const meta = await api(`/jobs/group/${filt.groupId}/sheet?meta=1`); modal("对照表 · " + (groups.find((g) => g.id === filt.groupId)?.title || ""), h("div", { class: "sheet" }, h("img", { src: `api/jobs/group/${filt.groupId}/sheet?t=${Date.now()}` }), h("div", { class: "muted small" }, meta.jobs.map((j) => `#${j.groupIndex} seed ${j.seed}`).join(" · ")), h("p", { class: "hint" }, "从左到右、从上到下按 # 顺序；点任务卡片看完整视频。"))); } catch (e) { toast(e.message, "error"); } } }, "对照表");
  const stSel = h("select", { onchange: () => { filt.status = stSel.value; draw(); } }, h("option", { value: "" }, "全部状态"), Object.entries(STATUS_ZH).map(([k, v]) => h("option", { value: k }, v)));
  const pSel = h("select", { onchange: () => { filt.projectId = pSel.value; draw(); } }, h("option", { value: "" }, "全部项目"), projects.map((p) => h("option", { value: p.id }, p.name)));
  const delSel = h("button", { class: "sm danger", hidden: true, onclick: async () => { const ids = [...sel]; const active = ids.filter((id) => { const j = S.jobs.get(id); return j && isActive(j); }); if (!(await confirm(`删除选中的 ${ids.length} 个任务及产物？${active.length ? `其中 ${active.length} 个正在进行，会先取消。` : ""}`, { danger: true }))) return; try { const r = await api("/jobs/batch-delete", { method: "POST", body: { ids, force: true } }); toast(`已删除 ${r.removed} 个${r.skipped ? `，跳过 ${r.skipped} 个` : ""}`, "ok"); } catch (e) { toast(e.message, "error"); } sel.clear(); draw(); } }, "删除选中");
  const allCb = h("input", { type: "checkbox", title: "全选当前筛选结果" });
  let visible = [];
  allCb.onchange = () => { if (allCb.checked) for (const j of visible) sel.add(j.id); else sel.clear(); draw(); };
  const filters = h("div", { class: "row filters" }, stSel, pSel, gSel, sheetBtn, h("button", { class: "sm danger", onclick: async () => { const dead = jobsSorted().filter((j) => j.status === "error" || j.status === "cancelled"); if (!dead.length) return toast("没有失败/取消的任务"); if (await confirm(`删除 ${dead.length} 个失败/取消的任务？`, { danger: true })) { await api("/jobs/batch-delete", { method: "POST", body: { ids: dead.map((j) => j.id) } }).catch((e) => toast(e.message, "error")); } } }, "清理失败"), delSel);
  main.append(h("div", { class: "row between page-h" }, h("h1", null, "任务"), filters), h("label", { class: "row muted small", style: "gap:6px;margin:6px 0 8px" }, allCb, "全选当前筛选结果（勾选后可批量删除）"), list);
  const updateSel = () => { delSel.hidden = !sel.size; delSel.textContent = `删除选中 (${sel.size})`; allCb.checked = visible.length > 0 && visible.every((j) => sel.has(j.id)); };
  function draw() {
    list.innerHTML = "";
    let arr = jobsSorted();
    if (filt.status) arr = arr.filter((j) => j.status === filt.status);
    if (filt.projectId) arr = arr.filter((j) => j.projectId === filt.projectId);
    if (filt.groupId) arr = arr.filter((j) => j.groupId === filt.groupId).sort((a, b) => (a.groupIndex || 0) - (b.groupIndex || 0));
    sheetBtn.hidden = !filt.groupId; visible = arr;
    for (const id of [...sel]) if (!S.jobs.has(id)) sel.delete(id);
    updateSel();
    if (!arr.length) list.append(h("p", { class: "muted" }, "没有任务。"));
    for (const j of arr) { const cb = h("input", { type: "checkbox", checked: sel.has(j.id), onclick: (e) => e.stopPropagation() }); cb.onchange = () => { if (cb.checked) sel.add(j.id); else sel.delete(j.id); updateSel(); }; list.append(h("div", { class: "row", style: "gap:8px;align-items:flex-start" }, h("div", { style: "padding-top:10px" }, cb), h("div", { style: "flex:1;min-width:0" }, jobCard(j)))); }
  }
  draw(); listen("job", draw);
};

/** Reference thumbnail that opens the underlying asset (image / video / audio) in a viewer. */
function refThumb(projectId, assetId, label) {
  return h("div", { class: "ref", style: "cursor:pointer", title: "点击预览", onclick: async () => {
    const url = `api/projects/${projectId}/assets/${assetId}/file`;
    let a = null; try { a = (await api(`/projects/${projectId}`)).assets.find((x) => x.id === assetId); } catch {}
    if (!a) return toast("素材已不存在", "warn");
    modal(a.name, h("div", null, a.kind === "video" ? h("video", { class: "player", src: url, controls: true, autoplay: true }) : a.kind === "audio" ? h("div", null, h("img", { src: `api/projects/${projectId}/assets/${assetId}/thumb`, style: "width:100%;border-radius:8px" }), h("audio", { src: url, controls: true, autoplay: true, style: "width:100%;margin-top:8px" })) : h("img", { src: url, style: "max-width:100%;max-height:70vh;border-radius:8px;display:block;margin:auto" }), h("div", { class: "muted small", style: "margin-top:6px" }, `${label} · ${a.width || ""}${a.height ? "×" + a.height : ""}${a.duration ? " · " + a.duration + "s" : ""}`), h("div", { class: "row", style: "margin-top:8px" }, h("a", { class: "btn sm", href: url + "?download=1" }, "下载"), h("a", { class: "btn sm", href: `#/project/${projectId}/assets` }, "去素材页"))));
  } }, h("img", { src: `api/projects/${projectId}/assets/${assetId}/thumb`, onerror: (e) => { e.target.style.opacity = .2; } }), h("span", { class: "lbl" }, label));
}
/** Where the time went, and what the card was doing while it went there. */
function stageTable(j) {
  const tl = (j.timeline || []).filter((t) => t.seconds != null && t.seconds > 0);
  const g = j.gpuDuring;
  if (!tl.length && !g) return null;
  const label = { queued: "排队", starting: "开机 / 准备", uploading: "上传素材", submitted: "等待 ComfyUI", running: "采样", downloading: "下载成片" };
  const total = tl.reduce((a, t) => a + t.seconds, 0) || 1;
  return h("details", { style: "margin-top:8px" }, h("summary", { class: "small" }, `耗时分解${j.elapsed ? `（共 ${fmtT(j.elapsed)}）` : ""}${g ? ` · 显卡利用率均 ${g.utilAvg}% 峰 ${g.utilMax}%` : ""}`),
    tl.length ? h("table", { style: "margin-top:6px" },
      h("tr", null, h("th", null, "阶段"), h("th", null, "耗时"), h("th", null, "占比"), h("th", { title: "电源探测每 20 秒一次，短阶段可能取到上一次的读数；整段的准确值看下面一行" }, "当时显卡*")),
      tl.map((t) => {
        const at = j.gpuAtStages?.[t.stage];
        return h("tr", null, h("td", null, label[t.stage] || t.stage), h("td", null, fmtT(t.seconds)),
          h("td", null, `${Math.round(100 * t.seconds / total)}%`),
          h("td", { class: "muted small" }, at ? `${at.util}% · ${(at.vramMib / 1024).toFixed(1)}G · ${at.powerW}W` : "—"));
      })) : null,
    g ? h("div", { class: "muted small", style: "margin-top:4px" }, `这条任务期间：显存峰值 ${(g.vramMaxMib / 1024).toFixed(1)} G · 功耗峰值 ${g.powerMaxW} W · 采样 ${g.samples} 次`) : null);
}

async function jobDetail(id) {
  let j; try { j = await api(`/jobs/${id}`); } catch (e) { return toast(e.message, "error"); }
  const proj = S.projects.find((p) => p.id === j.projectId);
  const body = h("div");
  const m = modal(j.title, body);
  function draw() {
    body.innerHTML = "";
    const pct = j.progress?.max ? Math.round(100 * j.progress.value / j.progress.max) : 0;
    const wfLabel = S.meta.workflows[j.workflow]?.label || j.workflow;
    body.append(
      h("div", { class: "row" }, h("span", { class: "badge " + j.status }, STATUS_ZH[j.status] || j.status), h("span", { class: "muted small" }, `${wfLabel} · ${j.width}×${j.height} · ${j.length} 帧 ≈ ${j.seconds}s · ${j.steps} 步 · seed ${j.seed}${j.refSize ? " · ref " + j.refSize : ""}${j.lora ? " · LoRA " + (j.lora.disabled ? "关" : (j.lora.name || "默认").replace(/\.safetensors$/, "") + (j.lora.strength != null ? "×" + j.lora.strength : "")) : ""} · ${proj?.name || j.projectId}${j.take ? " · take " + j.take : ""}${j.groupId ? " · 组 " + (j.groupTitle || "") + " #" + j.groupIndex : ""}`)),
      isActive(j) ? h("div", { style: "margin:8px 0" }, h("div", { class: "progress" + (j.status === "running" && j.progress ? "" : " indet") }, h("i", { style: `width:${j.status === "running" && j.progress ? pct : 35}%` })), h("div", { class: "hint" }, j.status === "running" && j.progress ? `${j.progress.value}/${j.progress.max} 步 · ` : "", `预计约 ${fmtT(j.estimate)}（按历史同规格任务估算）`, j.startedAt ? ` · 已用 ${fmtT(Date.now() / 1000 - j.startedAt)}` : "")) : null,
      j.output ? h("video", { class: "player", src: jobSrc(j.id), controls: true, autoplay: true, style: "margin-top:8px", onerror: function () { if (this.src.includes("from=gpu")) { S.directOk = false; this.src = `api/jobs/${j.id}/file`; } } }) : null,
      j.warning ? h("div", { class: "warnbox", style: "margin-top:8px" }, j.warning, " — 看到这个别看画面猜，参考肯定没生效；检查工作流/素材。") : null,
      j.error ? h("div", { class: "errbox", style: "margin-top:8px" }, j.error,
        j.errorDetail?.traceback ? h("details", { style: "margin-top:6px" }, h("summary", { class: "small" }, `GPU 上的报错（节点 ${j.errorDetail.node} · ${j.errorDetail.type}）`), h("pre", { style: "white-space:pre-wrap;font-size:11px" }, j.errorDetail.traceback)) : null) : null,
      (j.advice || []).length ? h("details", { style: "margin-top:8px" }, h("summary", { class: "small" }, `参考图检查（${j.advice.length} 条）`),
        j.advice.map((a) => h("div", { class: a.level === "error" ? "errbox" : a.level === "warn" ? "warn" : "hint", style: "margin-top:4px" }, a.text, a.fix ? h("div", { class: "muted small" }, a.fix) : null))) : null,
      stageTable(j),
      j.refCheck ? h("div", { class: "muted small", style: "margin-top:4px" }, `节点收到的参考键：${j.refCheck.received.join(", ") || "无"}（期望 ${j.refCheck.expected}）`) : null,
      h("div", { class: "row", style: "margin-top:10px" },
        isActive(j) ? h("button", { class: "sm danger", onclick: () => api(`/jobs/${j.id}/cancel`, { method: "POST" }).then(() => toast("已取消")).catch((e) => toast(e.message, "error")) }, "取消") : null,
        j.output ? h("a", { class: "btn sm", href: `api/jobs/${j.id}/file?download=1` }, "下载") : null,
        j.output && S.meta.fileshare ? h("button", { class: "sm", onclick: () => api(`/jobs/${j.id}/share`, { method: "POST", body: {} }).then((r) => { j.share = r; draw(); copy(r.url); }).catch((e) => toast(e.message, "error")) }, "分享链接") : null,
        j.output ? h("button", { class: "sm", onclick: () => { const v = body.querySelector("video"); const at = v?.currentTime || 0; api(`/jobs/${j.id}/frame`, { method: "POST", body: { at } }).then((a) => toast(`已抽帧 ${at.toFixed(2)}s → 素材 ${a.name}`, "ok")).catch((e) => toast(e.message, "error")); } }, "抽当前帧→素材") : null,
        j.output ? h("button", { class: "sm", onclick: () => api(`/jobs/${j.id}/frame`, { method: "POST", body: { last: true } }).then((a) => toast(`已抽末帧 → 素材 ${a.name}（可作下一段首帧/母图）`, "ok")).catch((e) => toast(e.message, "error")) }, "抽末帧→素材") : null,
        j.output ? h("button", { class: "sm", onclick: () => api(`/jobs/${j.id}/clone-to-asset`, { method: "POST", body: {} }).then((a) => toast(`已存为视频素材 ${a.name}（可作参考视频/续接）`, "ok")).catch((e) => toast(e.message, "error")) }, "存为视频素材") : null,
        j.output ? h("button", { class: "sm", onclick: async () => { try { const a = await api(`/jobs/${j.id}/frame`, { method: "POST", body: { last: true, name: `${j.title}_末帧.jpg` } }); S.clone = { mode: "i2v", projectId: j.projectId, images: [a.id], lastFrame: null, videos: [], width: j.width, height: j.height, seconds: j.seconds, steps: null, seed: "", refSize: j.refSize, prompt: TPL.native_i2v.replace("starting exactly from <Picture 1>.", "starting exactly from <Picture 1>, continuing the same moment without a cut: same framing, same lighting, everyone in the same positions."), title: `${j.title} · 续(首帧)` }; m.close(); location.hash = "#/generate/clone"; } catch (e) { toast(e.message, "error"); } } }, "续接：末帧作首帧") : null,
        j.output ? h("button", { class: "sm", onclick: async () => { try { const a = await api(`/jobs/${j.id}/clone-to-asset`, { method: "POST", body: {} }); S.clone = { mode: "video", projectId: j.projectId, images: j.workflow === "native_ref2va" ? j.images : [], lastFrame: null, videos: [a.id], videoAudio: false, width: j.width, height: j.height, seconds: j.seconds, steps: null, seed: "", refSize: j.refSize, prompt: TPL.continue, title: `${j.title} · 续(视频)` }; m.close(); location.hash = "#/generate/clone"; } catch (e) { toast(e.message, "error"); } } }, "续接：视频续接") : null,
        h("button", { class: "sm", onclick: () => { S.clone = { mode: j.workflow === "native_t2v" ? "t2v" : j.workflow === "native_i2v" ? "i2v" : j.videos?.length ? "video" : "ref", projectId: j.projectId, images: j.images, lastFrame: j.lastFrame, videos: j.videos, videoAudio: j.videoAudio, width: j.width, height: j.height, seconds: j.seconds, steps: j.steps, seed: j.seed, refSize: j.refSize, prompt: j.prompt, title: j.title, lora: j.lora || null }; m.close(); location.hash = "#/generate/clone"; } }, "再来一条（复制参数）"),
        !isActive(j) ? h("button", { class: "sm", title: "同参数同 seed 重新排队（用于对比模型/隧道抖动或误删产物）", onclick: async () => { try { const r = await api(`/jobs/${j.id}/rerun`, { method: "POST", body: {} }); toast(`已排队重跑（seed ${r.seed}）`, "ok"); m.close(); jobDetail(r.id); } catch (e) { toast(e.message, "error"); } } }, "重跑（同 seed）") : null,
        h("button", { class: "sm", onclick: () => copy(j.prompt) }, "复制提示词"),
        h("button", { class: "sm danger", style: "margin-left:auto", onclick: async () => { if (await confirm("删除任务及产物？", { danger: true })) { await api(`/jobs/${j.id}`, { method: "DELETE" }); m.close(); } } }, "删除")),
      j.share ? h("pre", { style: "margin-top:8px" }, j.share.url) : null,
      j.output?.strip ? h("img", { src: `api/jobs/${j.id}/strip`, style: "width:100%;border-radius:8px;margin-top:8px" }) : null,
      (j.images.length || j.videos.length || j.lastFrame || (j.audios || []).length) ? h("div", { class: "refs", style: "margin-top:8px" }, j.images.map((a, i) => refThumb(j.projectId, a, j.workflow === "native_i2v" ? "首帧" : `<Picture ${i + 1}>`)), j.lastFrame ? refThumb(j.projectId, j.lastFrame, "尾帧") : null, j.videos.map((a, i) => refThumb(j.projectId, a, `<Video ${i + 1}>${j.videoAudio ? "+音" : ""}`)), (j.audios || []).map((a, i) => refThumb(j.projectId, a, `<Audio ${i + 1}>`))) : null,
      h("details", { style: "margin-top:8px", open: !j.output }, h("summary", { class: "muted small" }, "提示词"), h("pre", null, j.prompt)),
      h("details", { style: "margin-top:4px" }, h("summary", { class: "muted small" }, "日志"), h("pre", null, (j.log || []).map((l) => `${new Date(l.at * 1000).toLocaleTimeString("zh-CN", { hour12: false })}  ${l.text}`).join("\n"))));
  }
  draw();
  const onJob = (e) => { if (e.detail.id === j.id) { if (e.detail.deleted) { m.close(); return; } const wasActive = isActive(j); Object.assign(j, e.detail); if (wasActive || isActive(j)) draw(); } };
  document.addEventListener("job", onJob);
  const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { document.removeEventListener("job", onJob); obs.disconnect(); } });
  obs.observe($("#modal-root"), { childList: true });
}

// ================= Compare two takes =================
function compareTakes(jobIds, { labels = null, title = "对比两条 take" } = {}) {
  const cands = jobIds.map((id, i) => ({ id, j: S.jobs.get(id), label: labels ? labels[i] : `take ${i + 1}` })).filter((x) => x.j?.output);
  if (cands.length < 2) return toast("至少需要两条已完成的 take");
  const mk = (idx) => h("select", { style: "width:100%" }, cands.map((c, i) => h("option", { value: c.id, selected: i === idx }, `${c.label} · seed ${c.j.seed}${c.j.warning ? " · ⚠参考未全生效" : ""}`)));
  const selA = mk(cands.length - 2), selB = mk(cands.length - 1);
  const vidA = h("video", { class: "player", controls: true, muted: false, playsinline: true }), vidB = h("video", { class: "player", controls: true, muted: true, playsinline: true });
  const setSrc = () => { vidA.src = jobSrc(selA.value); vidB.src = jobSrc(selB.value); };
  selA.onchange = selB.onchange = setSrc; setSrc();
  const both = (f) => { f(vidA); f(vidB); };
  const sync = () => { if (Math.abs(vidA.currentTime - vidB.currentTime) > 0.08) vidB.currentTime = vidA.currentTime; };
  vidA.addEventListener("play", () => { sync(); vidB.play().catch(() => {}); }); vidA.addEventListener("pause", () => vidB.pause()); vidA.addEventListener("seeked", sync);
  const muteBtn = h("button", { class: "sm", onclick: () => { const b = !vidA.muted; vidA.muted = b; vidB.muted = !b; muteBtn.textContent = b ? "🔊 听右边" : "🔊 听左边"; } }, "🔊 听左边");
  modal(title, h("div", null,
    h("p", { class: "hint" }, "左侧播放器控制两边同步播放；默认只放左边的声音，可切换。"),
    h("div", { class: "grid g2", style: "gap:10px" }, h("div", null, selA, vidA), h("div", null, selB, vidB)),
    h("div", { class: "row", style: "margin-top:8px" }, h("button", { class: "sm primary", onclick: () => { both((v) => { v.currentTime = 0; }); vidA.play().catch(() => {}); } }, "▶ 从头同步播放"), h("button", { class: "sm", onclick: () => both((v) => v.pause()) }, "⏸ 暂停"), muteBtn, h("button", { class: "sm ghost", onclick: () => jobDetail(selA.value) }, "左侧详情"), h("button", { class: "sm ghost", onclick: () => jobDetail(selB.value) }, "右侧详情"))));
}

// ================= White model (clay render) =================
const WM_PRESETS = [["clay", "白模 / 石膏", "主推：干净的哑光石膏，体积感与细节平衡"], ["sculpt", "重雕刻", "细节最多、阴影最重，适合特写"], ["soft", "柔和", "接近产品渲染的柔光白模"], ["toon", "分层色阶", "色阶量化 + 粗轮廓，偏动画"]];
routes.whitemodel = async (main) => {
  const projects = await api("/projects"); S.projects = projects;
  const st = { projectId: projects[0]?.id || "default", video: null, preset: "clay", relief: 0, photo: 0, ao: 0, keepAudio: true, subjectOnly: false, subjectThreshold: 0.55 };
  const left = h("div", { class: "col", style: "gap:14px" }), right = h("div", { class: "col" });
  main.append(h("h1", null, "白模视频"), h("p", { class: "hint" }, "把实拍视频变成没有贴图的白色石膏 / 粘土模型：保留形体、遮挡和光影，去掉一切颜色和纹理。不是 H3 生成，是 GPU 上的深度估计 + 浮雕着色，73 秒 720p 约 2.5 分钟。"), h("div", { class: "grid gen-grid", style: "grid-template-columns:minmax(0,1.4fr) minmax(300px,1fr)" }, left, right));
  const pSel = h("select", null, projects.map((p) => h("option", { value: p.id, selected: p.id === st.projectId }, p.name)));
  pSel.onchange = () => { st.projectId = pSel.value; st.video = null; drawSrc(); };
  const srcBox = h("div");
  async function drawSrc() {
    srcBox.innerHTML = "";
    if (st.video) { const a = st.video; srcBox.append(h("div", { class: "row", style: "align-items:flex-start" }, h("video", { src: `api/projects/${st.projectId}/assets/${a.id}/file`, controls: true, style: "width:280px;border-radius:8px;background:#000" }), h("div", { class: "col small" }, h("b", null, a.name), h("span", { class: "muted" }, `${a.width}×${a.height} · ${a.duration}s · ${a.frames || "?"} 帧`), h("button", { class: "sm", onclick: () => { st.video = null; drawSrc(); } }, "换一段")))); }
    else srcBox.append(h("div", { class: "row" }, h("button", { class: "sm primary", onclick: async () => { const [id] = await pickAssets(st.projectId, { kind: "video", multi: false, title: "选择源视频" }); if (!id) return; st.video = (await api(`/projects/${st.projectId}`)).assets.find((a) => a.id === id); drawSrc(); } }, "从素材库选择")), uploadBox(st.projectId, async () => { const pr = await api(`/projects/${st.projectId}`); const v = pr.assets.filter((a) => a.kind === "video").sort((a, b) => b.createdAt - a.createdAt)[0]; if (v) { st.video = v; drawSrc(); } }, "video/*,.mp4,.mov"));
  }
  drawSrc();
  const cards = h("div", { class: "mode-cards" }, WM_PRESETS.map(([id, name, desc]) => h("div", { class: "mode-card" + (st.preset === id ? " on" : ""), onclick: (e) => { st.preset = id; [...cards.children].forEach((c) => c.classList.remove("on")); e.currentTarget.classList.add("on"); } }, h("b", null, name), h("div", { class: "muted small" }, desc))));
  const slider = (key, label, min, max, step, hint) => { const inp = h("input", { type: "range", min, max, step, value: 0 }), lbl = h("span", { class: "mono small" }, "预设默认"); inp.oninput = () => { st[key] = Number(inp.value); lbl.textContent = st[key] > 0 ? String(st[key]) : "预设默认"; }; return h("div", null, h("label", null, label, " ", lbl), inp, h("div", { class: "hint" }, hint)); };
  const audioCb = h("input", { type: "checkbox", checked: true }); audioCb.onchange = () => { st.keepAudio = audioCb.checked; };
  // Only sculpt the person and leave the room as shot — the mask comes from the depth map the renderer
  // already computes, so this costs nothing extra. Meant for footage you cannot use the actor's face from.
  const subjCb = h("input", { type: "checkbox" });
  const thrEl = h("input", { type: "range", class: "subject-thr", min: 0.2, max: 0.9, step: 0.05, value: 0.55, disabled: true });
  const thrLbl = h("span", { class: "mono small" }, "0.55");
  thrEl.oninput = () => { st.subjectThreshold = Number(thrEl.value); thrLbl.textContent = thrEl.value; };
  subjCb.onchange = () => { st.subjectOnly = subjCb.checked; thrEl.disabled = !subjCb.checked; };
  const subjectBox = h("div", { style: "margin-top:8px" },
    h("label", { class: "inline" }, subjCb, "只把人物做成白模，背景保留原画面"),
    h("div", { class: "hint" }, "给有版权的素材换脸用：人物变成白模，房间、光线、镜头运动都还是原片。遮罩取自深度图（近景＝主体），不额外跑分割模型。"),
    h("div", { class: "row", style: "gap:8px;align-items:center;margin-top:4px" }, h("span", { class: "muted small" }, "主体范围"), thrEl, thrLbl,
      h("span", { class: "muted small" }, "调大＝只留最靠前的人")));
  const titleEl = h("input", { placeholder: "任务名（可选）" });
  const submit = h("button", { class: "primary", onclick: async () => {
    if (!st.video) return toast("先选一段源视频");
    try {
      const j = await api("/jobs", { method: "POST", body: { projectId: st.projectId, workflow: "whitemodel", videos: [st.video.id], title: titleEl.value.trim() || `白模${st.subjectOnly ? "（仅人物）" : ""} · ${st.video.name}`, whitemodel: { preset: st.preset, relief: st.relief, photo: st.photo, ao: st.ao, keepAudio: st.keepAudio , subjectOnly: st.subjectOnly, subjectThreshold: st.subjectThreshold } } });
      toast(`已排队：${j.title}（预计约 ${fmtT(j.estimate)}）`, "ok"); jobDetail(j.id);
    } catch (e) { toast(e.message, "error"); }
  } }, "🗿 生成白模视频");
  left.append(h("div", { class: "card" }, h("h2", null, "1 · 源视频"), h("label", null, "项目"), pSel, srcBox),
    h("div", { class: "card" }, h("h2", null, "2 · 风格"), cards, h("div", { class: "grid g3", style: "margin-top:10px" }, slider("relief", "体积强度 relief", 0, 15, 0.5, "越大浮雕越深；0 = 用预设值"), slider("photo", "五官 / 褶皱 photo", 0, 0.8, 0.05, "把画面明暗当作第二个高度场混入；脸和衣褶靠它"), slider("ao", "明暗对比 ao", 0, 1.5, 0.05, "多尺度凹陷暗化，最像白模的一步")), h("label", { class: "inline", style: "margin-top:8px" }, audioCb, " 保留原声")),
    h("div", { class: "card" }, h("h2", null, "3 · 范围"), subjectBox),
    h("div", { class: "card" }, h("div", { class: "row" }, titleEl, submit)));
  right.append(h("div", { class: "card" }, h("h2", null, "说明"), h("ul", { class: "small muted" }, h("li", null, "处理分辨率跟源视频走，1080p 会慢一些；帧数不限（逐帧流式，显存平稳）。"), h("li", null, "深度网络对人脸没有分辨力，五官靠「photo」从明暗里雕出来；0.25–0.30 是好的平衡，0.5 以上格子衣服会被当成几何。"), h("li", null, "镜头切换会自动重置时序滤波，不会串味；静止区强平滑、运动区零延迟。"), h("li", null, "白模可与 LLM 共存，不会踢掉聊天模型；但会排在 H3 任务的同一条队列里。"), h("li", null, "外部调用：skill ", h("code", null, "h3s.py whitemodel <video> --preset clay"), "，或 POST /api/jobs {workflow:\"whitemodel\", videos:[assetId], whitemodel:{preset,relief,photo,ao}}。"))),
    h("div", { class: "card" }, h("h2", null, "最近的白模任务"), h("div", { class: "col", id: "wm-recent" })));
  const drawRecent = () => { const box = document.getElementById("wm-recent"); if (!box) return; box.innerHTML = ""; const list = jobsSorted().filter((j) => j.workflow === "whitemodel").slice(0, 8); if (!list.length) box.append(h("p", { class: "muted small" }, "还没有。")); for (const j of list) box.append(jobCard(j)); };
  drawRecent(); listen("job", drawRecent);
};

// ================= Models / compute =================
const MOD_ICON = { video: "🎬", whitemodel: "🗿", llm: "💬", voice: "🎙" };
/** Context window of an llama.cpp model from its args (-c N) → "256k" etc. */
/** Weights + KV at the context this model is configured for; "≈" when the KV rate is an estimate. */
const ctxLabel = (v) => v >= 1024 ? `${Math.round(v / 1024)}k` : String(v);
function ctxOfRaw(m) { const a = m?.args || []; const i = a.indexOf("-c"); return i >= 0 ? Number(a[i + 1]) || null : null; }
/** Same estimate the server does, so the number moves as you type. */
function Models_vram(m, ctx) {
  const weightsMib = m.fileGb ? Math.round(m.fileGb * 1024) : (m.vram || m.vramEstimate || 0);
  const n = Number(String(m.params || "").replace(/[^\d.]/g, "")) || 27;
  const perToken = m.kvBytesPerToken || Math.round(860 * n);
  const kvMib = ctx ? Math.round((ctx * perToken) / 1048576) : 0;
  return { weightsMib, kvMib, totalMib: weightsMib + kvMib + 700, measured: !!m.kvBytesPerToken };
}
function vramCell(m) {
  const v = m.vramAt;
  if (!v) return m.vram ? fmtG(m.vram) : h("span", { class: "muted" }, "≈" + fmtG(m.vramEstimate));
  const title = v.kvMib ? `权重 ${fmtG(v.weightsMib)} + KV ${fmtG(v.kvMib)}（${(v.perToken / 1024).toFixed(1)} KB/token${v.measured ? "，实测" : "，估算"}）` : "";
  return h("span", { title }, (v.measured ? "" : "≈") + fmtG(v.totalMib),
    v.kvMib ? h("div", { class: "muted small" }, `权重 ${fmtG(v.weightsMib)} + KV ${fmtG(v.kvMib)}`) : null);
}
function ctxOf(m) { const a = m?.args || []; const i = a.indexOf("-c"); const n = i >= 0 ? Number(a[i + 1]) : null; return n ? (n >= 1024 ? Math.round(n / 1024) + "k" : String(n)) : null; }
/** Test report (from POST /api/models/:id/test or model.lastReport) → DOM. */
function reportView(r) {
  if (!r) return h("p", { class: "muted small" }, "还没有测试记录。");
  return h("div", null,
    h("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, h("span", { class: "badge " + (r.ok ? "done" : "error") }, r.ok ? "通过" : "未通过"), h("span", { class: "muted small" }, `${fmtDate(r.finishedAt || r.startedAt)} · 加载 ${r.loadSeconds != null ? r.loadSeconds + " s" : "（已在显存）"} · 显存 ${fmtG(r.vram)}${r.vramAfter ? ` · 测完显存共 ${fmtG(r.vramAfter)}` : ""}`)),
    h("table", { style: "margin-top:8px" }, h("tr", null, h("th", null, "步骤"), h("th", null, "结果"), h("th", null, "耗时"), h("th", null, "详情")), (r.steps || []).map((s) => h("tr", null, h("td", null, s.name), h("td", null, s.ok ? "✓" : "✗"), h("td", { class: "mono small" }, s.ms != null ? (s.ms / 1000).toFixed(1) + " s" : ""), h("td", { class: "small", style: "max-width:420px;word-break:break-all" }, s.error ? h("span", { class: "warn" }, s.error) : [s.text ? h("div", null, "“" + s.text.slice(0, 160) + "”") : null, s.tps ? h("div", { class: "muted" }, `${s.tps} tok/s 生成${s.promptTps ? ` · ${s.promptTps} tok/s prompt` : ""}${s.tokens ? ` · ${s.tokens} tok` : ""}`) : null, s.audioSeconds ? h("div", { class: "muted" }, `${s.audioSeconds.toFixed(1)} s 音频 · ${fmtBytes(s.bytes)}`) : null, s.language ? h("div", { class: "muted" }, "语言 " + s.language) : null, s.jobId ? h("a", { href: "#", class: "small", onclick: (e) => { e.preventDefault(); jobDetail(s.jobId); } }, "任务 " + s.jobId) : null, s.ids ? h("div", { class: "muted" }, s.ids.join(", ")) : null, s.alreadyLoaded ? h("div", { class: "muted" }, "（已在显存，未重新加载）") : null])))));
}
/** Script → IndexTTS-2 on the GPU → saved as an audio asset of the project (used by the avatar wizard). */
async function ttsToAsset(projectId, onDone) {
  const pr = await api(`/projects/${projectId}`);
  const text = h("textarea", { placeholder: "旁白 / 台词文稿（≤4000 字；数字人建议每段 ≤ 15 秒，多段用句号分开）", style: "min-height:110px" });
  const refSel = h("select", null, h("option", { value: "" }, "默认音色（示例声）"), pr.assets.filter((a) => a.kind === "audio").map((a) => h("option", { value: a.id }, `克隆本项目音频：${a.name}（${a.duration}s）`)));
  const refFile = h("input", { type: "file", accept: "audio/*,.wav,.mp3,.m4a" });
  const name = h("input", { placeholder: "素材名（可选）" });
  const status = h("div", { class: "hint" }, "首次会自动开机并加载语音模型（1–4 分钟），之后几秒一段。");
  const m = modal("文稿 → TTS 配音", h("div", null, h("label", null, "文稿"), text, h("label", null, "音色"), h("div", { class: "row" }, refSel, h("label", { class: "inline small" }, "或上传参考声（5–15 秒）", refFile)), h("label", null, "保存为素材"), name, status),
    { narrow: true, actions: [{ label: "取消" }, { label: "合成并存为素材", primary: true, onclick: async () => {
      const t = text.value.trim(); if (!t) { toast("先写文稿"); return false; }
      status.textContent = "合成中…";
      try {
        let r;
        if (refFile.files[0] || refSel.value) {
          const fd = new FormData(); fd.append("text", t);
          const blob = refFile.files[0] || await (await fetch(`api/projects/${projectId}/assets/${refSel.value}/file`)).blob();
          fd.append("ref", blob, refFile.files[0]?.name || "ref.wav");
          r = await fetch("voice/tts", { method: "POST", body: fd });
        } else r = await fetch("voice/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t }) });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
        const wav = await r.blob();
        const nm = (name.value.trim() || `tts_${t.slice(0, 12).replace(/[\\/:*?"<>|\s]+/g, "_")}`) + ".wav";
        const up = await fetch(`api/projects/${projectId}/assets?name=${encodeURIComponent(nm)}`, { method: "PUT", headers: { "content-type": "audio/wav" }, body: wav });
        if (!up.ok) throw new Error("存素材失败 HTTP " + up.status);
        const asset = await up.json(); toast(`已生成音频素材 ${asset.name}（${asset.duration}s）`, "ok"); m.close(); onDone?.(asset);
      } catch (e) { status.textContent = ""; toast("配音失败：" + e.message, "error", 8000); return false; }
    } }] });
}
routes.models = async (main) => {
  let snap = await api("/models");
  // Loading happens in the background (and can be started from the dashboard or another tab), so follow
  // the model events for as long as this page is on screen.
  const onModelsEvent = (e) => {
    if (!document.body.contains(head)) return document.removeEventListener("models", onModelsEvent);
    snap = e.detail; drawAll();
  };
  document.addEventListener("models", onModelsEvent);
  const head = h("div", { class: "card" }), tasksCard = h("div", { class: "card" }), catCard = h("div", { class: "card" }), logCard = h("div", { class: "card" });
  main.append(h("h1", null, "模型管家"), h("p", { class: "hint" }, "一张显卡上按需切换：谁在显存里、加载 / 卸载 / 测试新模型。对话和语音的操作面板在左边「工具」栏。"), head, tasksCard, catCard, logCard);
  function drawHead() {
    head.innerHTML = "";
    const g = snap.gpu, gpu = S.gpu || {};
    const used = g?.vram?.used ?? 0, total = g?.vram?.total || snap.vramTotal || 32607;
    const chips = [];
    for (const [mod, def] of Object.entries(snap.modalities)) {
      const l = snap.loaded[mod]; if (!l && !(mod === "video" && snap.comfyModelsLoaded)) continue;
      const m = l?.modelId ? snap.models.find((x) => x.id === l.modelId) : null;
      const txt = mod === "video" ? (snap.comfyModelsLoaded ? "H3 权重在显存" : "ComfyUI 空载") : (m?.name || def.label);
      chips.push(h("span", { class: "badge " + (mod === "video" && !snap.comfyModelsLoaded ? "" : "on"), title: def.label }, `${MOD_ICON[mod] || ""} ${txt}`));
    }
    const busy = snap.busy;
    head.append(h("div", { class: "row between", style: "flex-wrap:wrap;gap:8px" },
      h("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, h("span", { class: "badge " + (gpu.state === "on" ? "done" : gpu.state === "off" ? "" : "running") }, { on: "GPU 在线", off: "GPU 关机", starting: "开机中", stopping: "关机中" }[gpu.state] || "状态未知"), snap.available ? null : h("span", { class: "warn small" }, "gpuctl 未配置（回退为只看 ComfyUI）"), ...(chips.length ? chips : [h("span", { class: "muted small" }, "空载：显存里没有模型")])),
      h("div", { class: "row" }, h("button", { class: "sm", onclick: async () => { try { snap = await api("/models/refresh", { method: "POST" }); drawAll(); } catch (e) { toast(e.message, "error"); } } }, "刷新"), h("button", { class: "sm danger", disabled: !!busy, onclick: async () => { if (await confirm("卸载显存里的全部模型（H3 权重 / LLM / 语音）？ComfyUI 进程保留。", { danger: true })) { try { snap = await api("/models/unload", { method: "POST", body: { modality: "all" } }); drawAll(); toast("已全部卸载", "ok"); } catch (e) { toast(e.message, "error"); } } } }, "全部卸载"))),
      h("div", { style: "margin-top:10px" }, h("div", { class: "row between small" }, h("span", null, "显存 ", h("b", null, fmtG(used)), " / ", fmtG(total), g?.vram ? ` · 温度 ${g.vram.temp}°C · 利用率 ${g.vram.util}%` : ""), h("span", { class: "muted" }, g ? `磁盘剩余 ${g.diskFreeGb} G · 采样于 ${fmtDate(g.at)}` : "GPU 关机，无数据")), h("div", { class: "progress", style: "margin-top:4px;height:10px" }, h("i", { style: `width:${Math.min(100, Math.round(100 * used / total))}%;background:${used / total > 0.85 ? "var(--red)" : "var(--accent)"}` }))),
      busy ? h("div", { class: "hint", style: "margin-top:8px" }, h("span", { class: "spin" }), ` ${busy.action === "load" ? "加载" : "卸载"} ${snap.modalities[busy.modality]?.label || busy.modality}：${busy.progress.at(-1)?.text || "…"}（${fmtT(Date.now() / 1000 - busy.since)}）`) : null,
      snap.lastError ? h("div", { class: "errbox", style: "margin-top:8px" }, snap.lastError) : null,
      h("p", { class: "hint", style: "margin-top:8px" }, "规则：视频（H3）与 LLM 互斥，视频任务来了会先卸掉 LLM / 语音；语音可与 LLM 共存；白模可与任何组合共存。空闲到阈值先全部卸载再关机；从「接入 · API」页的 LLM 端点调用（带密钥）会自动开机并加载默认 LLM。"));
  }
  function drawTasks() {
    // Capability cards: one per modality — pick the model, load / unload, see what would be evicted.
    tasksCard.innerHTML = "";
    const caps = [
      { mod: "video", icon: "🎬", title: "视频生成 · MiniMax-H3", desc: "文生 / 图生 / 参考图·视频，出片自带声音" },
      { mod: "llm", icon: "💬", title: "大模型", desc: "对话 · 写作 · 代码；OpenAI 兼容端点" },
      { mod: "voice", icon: "🎙", title: "语音", desc: "配音 · 音色克隆 · 转写" },
      { mod: "whitemodel", icon: "🗿", title: "白模视频", desc: "实拍 → 石膏模型" },
    ];
    const short = (mod) => ({ video: "视频", llm: "大模型", voice: "语音", whitemodel: "白模" })[mod] || mod;
    const grid = h("div", { class: "caps" });
    for (const c of caps) {
      const def = snap.modalities[c.mod] || {}; const models = snap.models.filter((m) => m.modality === c.mod);
      const l = snap.loaded[c.mod];
      const loaded = c.mod === "video" ? !!snap.comfyModelsLoaded : c.mod === "whitemodel" ? false : !!l;
      const wantId = snap.defaults?.[c.mod] || models[0]?.id; const want = models.find((m) => m.id === wantId);
      const running = l?.modelId ? models.find((m) => m.id === l.modelId) : null;
      const evict = (def.exclusive || []).filter((o) => snap.loaded[o] || (o === "video" && snap.comfyModelsLoaded)).map(short);
      const needSwitch = loaded && c.mod !== "video" && running && wantId && running.id !== wantId;
      const sel = h("select", { style: "width:100%" }, models.map((m) => h("option", { value: m.id, selected: m.id === wantId }, `${m.name}${ctxOf(m) ? " · " + ctxOf(m) : ""}${m.tested ? "" : "（未测试）"}`)));
      sel.onchange = async () => { try { await api("/models/default", { method: "POST", body: { modality: c.mod, modelId: sel.value } }); snap = await api("/models"); drawAll(); toast(loaded && running && running.id !== sel.value ? `已设为默认，点「切换」立即换成 ${sel.value}` : `${c.title} 默认模型：${sel.value}`, "ok"); } catch (e) { toast(e.message, "error"); } };
      const specLine = want ? h("div", { class: "muted small", style: "margin-top:4px" },
        [want.params ? `参数 ${want.params}` : null, want.quant ? `量化 ${want.quant}` : null,
         want.fileGb ? `权重 ${want.fileGb} GB` : null,
         want.vramAt ? `${want.vramAt.measured ? "" : "≈"}显存 ${fmtG(want.vramAt.totalMib)}${want.vramAt.kvMib ? `（含 KV ${fmtG(want.vramAt.kvMib)}）` : ""}` : null].filter(Boolean).join(" · ")) : null;
      // 上下文不再手工填：这台工作台会在 24 / 32 / 48 / 96 GB 的卡之间搬家，一个写死的数字换台机器就不对了。
      // 服务端按「当前这张卡装得下多少」算，这里只把结论和依据说清楚。
      const ctxRow = c.mod === "llm" && want && want.ctxAuto ? h("div", { class: "muted small", style: "margin-top:4px" },
        `上下文 ${ctxLabel(want.ctxAuto)}（按当前 ${fmtG(snap.vramTotal)} 显卡自动选，上限 ${ctxLabel(want.ctxMaxUsable)}，${want.ctxLimitedBy === "model" ? "受模型自身限制" : "受显存限制"}）`,
        (() => { const v = Models_vram(want, want.ctxAuto); return ` · 权重 ${fmtG(v.weightsMib)} + KV ${fmtG(v.kvMib)}`; })()) : null;
      const status = c.mod === "whitemodel" ? h("span", { class: "badge" }, "随任务加载，用完即放")
        : loaded ? h("span", { class: "badge on" }, `已加载${(running || want)?.vram ? " · " + fmtG((running || want).vram) : ""}${running && running.id !== wantId ? " · " + running.name : ""}`)
        : h("span", { class: "badge" }, "未加载");
      const btns = h("div", { class: "row", style: "gap:6px;flex-wrap:wrap;margin-top:8px" });
      const load = async (label) => { try { await api("/models/ensure", { method: "POST", body: { modality: c.mod } }); toast(`${label}${c.title}…${evict.length ? `（会先卸掉 ${evict.join("、")}）` : ""}`, "info"); } catch (e) { toast(e.message, "error"); } };
      if (c.mod === "whitemodel") btns.append(h("span", { class: "muted small" }, "去「白模」页提交任务即可；可与任何组合共存。"));
      else {
        if (!loaded) btns.append(h("button", { class: "sm primary", disabled: !!snap.busy, onclick: () => load("正在加载 ") }, "加载"));
        if (needSwitch) btns.append(h("button", { class: "sm primary", disabled: !!snap.busy, onclick: () => load("正在切换 ") }, `切换到 ${want?.name || wantId}`));
        if (loaded) btns.append(h("button", { class: "sm", disabled: !!snap.busy, onclick: async () => { try { snap = await api("/models/unload", { method: "POST", body: { modality: c.mod } }); drawAll(); toast(`${c.title} 已卸载`, "ok"); } catch (e) { toast(e.message, "error"); } } }, c.mod === "video" ? "卸下权重" : "卸载"));
      }
      // one row per capability: name and state on the left, the model and its numbers in the middle,
      // the buttons on the right — reads top to bottom instead of four columns competing for width
      const busyHere = snap.busy && snap.busy.modality === c.mod ? snap.busy : null;
      grid.append(h("div", { class: "cap" + (loaded ? " on" : "") },
        h("div", { class: "cap-head" },
          h("div", { class: "cap-name" }, h("b", null, `${c.icon} ${c.title}`), h("div", { class: "muted small" }, c.desc)),
          h("div", { class: "cap-model" }, models.length > 1 || c.mod === "llm" || c.mod === "voice" ? sel : h("span", { class: "small" }, want?.name || ""), specLine),
          h("div", { class: "cap-act" }, status, btns)),
        busyHere ? h("div", { class: "hint", style: "margin-top:6px" }, h("span", { class: "spin" }), ` ${busyHere.action === "load" ? "加载中" : "卸载中"}：${busyHere.progress?.at(-1)?.text || "…"}`) : null,
        ctxRow,
        h("div", { class: "muted small", style: "margin-top:6px" }, c.mod === "whitemodel" ? "" : !loaded && evict.length ? `加载会腾出显存：卸掉 ${evict.join("、")}` : (def.exclusive || []).length ? `与 ${(def.exclusive || []).map(short).join("、")} 互斥` : "可与任何组合共存")));
    }
    tasksCard.append(h("h2", null, "能力"), h("p", { class: "hint" }, "一张卡按需组合：视频与大模型 / 语音互斥，语音可与大模型共存，白模可与任何共存。切换时自动腾显存，不用手动卸。"), grid);
  }
  function drawCatalog() {
    catCard.innerHTML = "";
    // grouped by capability, each group naming (and letting you change) the model the dashboard loads
    const rowFor = (m) => {
      const l = snap.loaded[m.modality]; const loaded = l && (l.modelId === m.id || (m.modality === "video" && snap.comfyModelsLoaded));
      const st = loaded ? h("span", { class: "badge on" }, "已加载") : m.tested ? h("span", { class: "badge done" }, "已测试") : h("span", { class: "badge" }, "未测试");
      const acts = h("div", { class: "row", style: "gap:4px;flex-wrap:wrap" });
      const runTest = async () => {
        const body = h("div", null, h("p", { class: "hint" }, "加载 → 记显存与耗时 → 真实推理（LLM：中英各一问 + 模型列表；语音：合成一句再转写回读；视频/白模：跑一条真实小任务）。全部通过才标为「已测试」。"), h("div", { class: "row", style: "margin-top:6px" }, h("span", { class: "spin" }), h("span", { class: "muted small" }, "开始…")));
        const log = h("div", { class: "col small", style: "gap:2px;margin-top:8px" }); body.append(log);
        const m2 = modal(`测试 ${m.name}`, body, { narrow: true });
        const onEv = (e) => { const b = e.detail.busy; if (b && b.progress?.length) { const t = b.progress.at(-1).text; if (log.lastChild?.textContent !== t) log.append(h("div", { class: "muted" }, t)); } };
        document.addEventListener("models", onEv);
        try {
          const r = await api(`/models/${m.id}/test`, { method: "POST" });
          body.innerHTML = ""; body.append(reportView(r.report));
          toast(`${m.name} ${r.ok ? "测试通过" : "测试未通过"}`, r.ok ? "ok" : "warn", 6000);
        } catch (e) { body.innerHTML = ""; body.append(h("div", { class: "errbox" }, e.message)); }
        finally { document.removeEventListener("models", onEv); snap = await api("/models"); drawAll(); }
      };
      if (m.modality !== "video" && m.modality !== "whitemodel") {
        if (loaded) acts.append(h("button", { class: "sm", disabled: !!snap.busy, onclick: async () => { try { snap = await api("/models/unload", { method: "POST", body: { modality: m.modality } }); drawAll(); } catch (e) { toast(e.message, "error"); } } }, "卸载"));
        else acts.append(h("button", { class: "sm" + (m.tested ? " primary" : ""), disabled: !!snap.busy, title: m.tested ? "" : "还没测试过，直接加载（不保证能起来）", onclick: async () => { if (!m.tested && !(await confirm(`${m.name} 还没测试过，直接加载？加载失败会在「运行日志」里看到原因。`))) return; try { await api(`/models/${m.id}/load${m.tested ? "" : "?force=1"}`, { method: "POST" }); toast(`正在加载 ${m.name}…`, "info"); } catch (e) { toast(e.message, "error"); } } }, "加载"));
      }
      acts.append(h("button", { class: "sm" + (m.tested ? " ghost" : ""), disabled: !!snap.busy, title: "完整测试：加载 + 真实推理，出报告", onclick: runTest }, m.tested ? "重测" : "测试"));
      if (m.source?.type === "download") acts.append(h("button", { class: "sm ghost", title: "小模型允许从 HF / ModelScope / GitHub 下载到 GPU 机本地缓存", onclick: async () => { try { const r = await api(`/models/${m.id}/download`, { method: "POST" }); toast(`已开始下载（${fmtBytes(r.bytes)}），日志 ${r.log}`, "ok", 8000); } catch (e) { toast(e.message, "error"); } } }, "下载"));
      acts.append(h("button", { class: "sm ghost", onclick: () => modal(m.name, h("div", null, h("div", { class: "kv" }, h("div", null, "模态"), h("div", null, snap.modalities[m.modality]?.label || m.modality), h("div", null, "来源"), h("div", { class: "mono small" }, m.source?.path || m.source?.url || ""), h("div", null, "量化"), h("div", null, m.quant || "—"), h("div", null, "文件"), h("div", null, m.fileGb ? m.fileGb + " GB" : "—"), h("div", null, "显存"), h("div", null, m.vram ? `实测 ${fmtG(m.vram)}` : `估算 ${fmtG(m.vramEstimate)}`), h("div", null, "启动参数"), h("div", { class: "mono small" }, (m.args || []).join(" ") || "—"), h("div", null, "测试"), h("div", null, m.tested ? `通过${m.testedAt ? "（" + (typeof m.testedAt === "number" ? fmtDate(m.testedAt) : m.testedAt) + "）" : ""}${m.tps ? " · " + m.tps + " tok/s" : ""}${m.smoke?.text ? " · " + m.smoke.text.slice(0, 80) : ""}` : "未测试")), h("p", { class: "muted small", style: "margin-top:8px" }, m.note || ""), h("h3", { style: "margin-top:10px" }, "上次测试"), reportView(m.lastReport)), { narrow: true }) }, "详情"));
      return h("tr", null, h("td", null, h("b", null, m.name), h("div", { class: "muted small" }, m.note ? m.note.slice(0, 60) + (m.note.length > 60 ? "…" : "") : "")), h("td", { class: "mono small" }, m.quant || "—"), h("td", { class: "mono small" }, m.params || "—"), h("td", { class: "mono small" }, ctxOf(m) || "—", m.ctxMaxUsable ? h("div", { class: "muted small" }, `最大 ${Math.round(m.ctxMaxUsable / 1024)}k`) : null), h("td", null, m.fileGb ? m.fileGb + " G" : "—"), h("td", null, vramCell(m)), h("td", null, st), h("td", null, acts));
    };
    // one table per capability; the dashboard's three buttons load whatever is set as default here.
    // 白模 / 转写 deliberately have no default: they are pulled in for the task that needs them and dropped after.
    const HOME_MODS = ["video", "llm", "voice"];
    catCard.append(h("h2", null, "模型目录"), h("p", { class: "hint" }, "按能力分组。带「默认」的那一栏就是仪表盘三个按钮会加载的模型；白模和转写属于随用随载，不进仪表盘。只有「已测试」的能一键加载；未测试的先点「测试」（加载 + 记实际显存 + 跑一次推理）。模型来自 GPU 机上的共享库 /model，不占系统盘。"));
    const order = [...HOME_MODS, ...Object.keys(snap.modalities).filter((m) => !HOME_MODS.includes(m)), "asr"];
    for (const mod of order) {
      const list = snap.models.filter((m) => (mod === "asr" ? m.modality === "voice" && /转写|ASR|sensevoice/i.test(m.name + m.id) : m.modality === mod && !/转写|ASR|sensevoice/i.test(m.name + m.id)));
      if (!list.length) continue;
      const def = snap.defaults?.[mod];
      const head = h("div", { class: "row between", style: "margin-top:14px" },
        h("h3", null, `${MOD_ICON[mod] || (mod === "asr" ? "📝" : "")} ${mod === "asr" ? "语音转写" : snap.modalities[mod]?.label || mod}`, h("span", { class: "muted small" }, `　${list.length} 个`)));
      if (HOME_MODS.includes(mod)) {
        const sel = h("select", null, list.filter((m) => m.tested).map((m) => h("option", { value: m.id, selected: m.id === def }, m.name)));
        sel.onchange = async () => { await api("/models/default", { method: "POST", body: { modality: mod, modelId: sel.value } }); snap = await api("/models"); drawAll(); toast("默认模型已改，仪表盘按钮跟着变", "ok"); };
        head.append(h("span", { class: "row", style: "gap:6px;align-items:center" }, h("span", { class: "muted small" }, "仪表盘默认"), sel));
      } else head.append(h("span", { class: "muted small" }, "随用随载，不设默认"));
      catCard.append(head, h("table", null, h("tr", null, h("th", null, "模型"), h("th", null, "量化"), h("th", null, "参数"), h("th", null, "上下文"), h("th", null, "权重"), h("th", null, "显存"), h("th", null, "状态"), h("th", null, "")), list.map(rowFor)));
    }
  }
  function drawLog() {
    logCard.innerHTML = "";
    const pre = h("pre", { style: "max-height:260px;overflow:auto;font-size:11px" }, "（点上面的按钮读取 GPU 机上的运行日志）");
    logCard.append(h("h2", null, "运行日志"), h("div", { class: "row" }, ["llm", "voice", "comfyui", "gputunnel"].map((p) => h("button", { class: "sm", onclick: async () => { pre.textContent = "读取中…"; try { const r = await api(`/models/log/${p}?lines=120`); pre.textContent = r.ok ? r.log : "没有日志"; pre.scrollTop = pre.scrollHeight; } catch (e) { pre.textContent = e.message; } } }, p))), pre);
  }
  function drawAll() { drawHead(); drawTasks(); drawCatalog(); }
  drawAll(); drawLog();
  listen("models", (e) => { snap = e.detail; drawAll(); });
  listen("gpu", () => drawHead());
};

function chatPanel(chatCard, snap) {
    chatCard.innerHTML = "";
    const out = h("div", { class: "chatlog", style: "max-height:320px;overflow:auto;background:var(--code);border-radius:8px;padding:8px;font-size:13px;white-space:pre-wrap;min-height:80px" });
    const inp = h("textarea", { placeholder: "问点什么…（发送会自动开机 + 加载默认 LLM，首次约 1–4 分钟）", style: "min-height:60px" });
    const sys = h("input", { placeholder: "可选：系统提示词", value: "" });
    const msgs = [];
    let cur = snap.loaded.llm?.modelId; const sel = h("select", null, snap.models.filter((m) => m.modality === "llm" && m.tested).map((m) => h("option", { value: m.id, selected: m.id === cur }, m.name)));
    const send = async () => {
      const q = inp.value.trim(); if (!q) return; inp.value = "";
      msgs.push({ role: "user", content: q }); out.append(h("div", { style: "color:var(--accent)" }, "你：" + q)); const ans = h("div", null, "助手："); const body0 = h("span"); ans.append(body0); out.append(ans); out.scrollTop = out.scrollHeight;
      try {
        if (snap.loaded.llm?.modelId !== sel.value) await api("/models/task", { method: "POST", body: { task: "chat", modelId: sel.value } });
        const r = await fetch("llm/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: sel.value, stream: true, messages: [...(sys.value ? [{ role: "system", content: sys.value }] : []), ...msgs] }) });
        if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`); }
        const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = "", text = "", thinking = "";
        // speed is what tells you whether the context you picked is hurting: first token, then tok/s
        const t0 = performance.now(); let firstAt = null, chunks = 0;
        const think = h("details", { class: "think" }, h("summary", { class: "small muted" }, "思考过程"), h("pre", null, ""));
        const meter = h("div", { class: "muted small" }, "");
        ans.append(think, meter); think.hidden = true;
        while (true) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line.startsWith("data:")) continue; const d = line.slice(5).trim(); if (d === "[DONE]") continue; try { const j = JSON.parse(d); const dl = j.choices?.[0]?.delta || {}; if (dl.reasoning_content) thinking += dl.reasoning_content; if (dl.content) { text += dl.content; chunks++; if (firstAt == null) firstAt = performance.now(); }
          // Qwen and friends put the chain inside <think>…</think> in ordinary content; pull it out so the answer reads clean
          let shown = text; const m = /^([\s\S]*?)<\/think>/.exec(text);
          if (/<think>/.test(text) || m) { const open = text.indexOf("<think>"); const close = text.indexOf("</think>");
            if (close > 0) { thinking = text.slice(open >= 0 ? open + 7 : 0, close).trim(); shown = text.slice(close + 8).trim(); }
            else { thinking = text.slice(open >= 0 ? open + 7 : 0); shown = ""; } }
          body0.textContent = shown || (thinking ? "（正在思考…）" : "");
          if (thinking) { think.hidden = false; think.querySelector("pre").textContent = thinking; }
          const secs = (performance.now() - t0) / 1000;
          const tps = chunks > 2 && firstAt ? (chunks / ((performance.now() - firstAt) / 1000)).toFixed(1) : null;
          meter.textContent = `${firstAt ? `首字 ${((firstAt - t0) / 1000).toFixed(1)}s · ` : ""}${tps ? `${tps} tok/s · ` : ""}${secs.toFixed(1)}s${thinking ? ` · 思考 ${thinking.length} 字` : ""}`;
          out.scrollTop = out.scrollHeight; } catch {} } }
        msgs.push({ role: "assistant", content: text });
      } catch (e) { ans.textContent = "助手：出错了 — " + e.message; toast(e.message, "error"); }
    };
    inp.onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); };
    chatCard.append(h("h2", null, "Chat 面板（验证用）"), h("p", { class: "hint" }, "走的就是对外的 OpenAI 兼容端点 ", h("code", null, "llm/v1/chat/completions"), "；agent 用设置页的 API key 调同一个地址。"), h("div", { class: "row" }, sel, h("button", { class: "sm ghost", onclick: () => { msgs.length = 0; out.innerHTML = ""; } }, "清空")), sys, out, inp, h("div", { class: "row", style: "margin-top:6px" }, h("button", { class: "primary sm", onclick: send }, "发送（⌘/Ctrl+Enter）")));
  }

function voicePanel(card) {
  // 语音 page: engine (model) → its controls; voice = saved / sample / built-in; text → audio; clone → saved voice.
  card.innerHTML = "";
  const st = { engine: null, voice: null, engines: [], voices: { saved: [], samples: [], builtin: {} }, params: {} };
  const head = h("div"), ctrlBox = h("div"), voiceBox = h("div"), synthBox = h("div"), cloneBox = h("div"), savedBox = h("div"), asrBox = h("div");
  // Three jobs, three views. Synthesis, cloning and transcription used to share one screen and nobody
  // could tell which control belonged to which job, so each gets its own tab now.
  st.tab = localStorage.getItem("atelier.voiceTab") || "synth";
  const panes = {
    synth: h("div", { class: "grid g2", style: "gap:14px" }, h("div", null, h("h3", null, "1 · 模型与风格"), ctrlBox, h("h3", { style: "margin-top:12px" }, "2 · 音色"), voiceBox), h("div", null, h("h3", null, "3 · 说什么"), synthBox)),
    clone: h("div", { class: "grid g2", style: "gap:14px" }, h("div", null, h("h3", null, "上传一段参考声"), cloneBox), h("div", null, h("h3", null, "我的音色"), savedBox)),
    asr: h("div", null, asrBox),
  };
  const tabsBar = h("div", { class: "subtabs" });
  const TABS = [["synth", "🎙 合成配音"], ["clone", "🧬 克隆音色"], ["asr", "📝 语音转写"]];
  function drawTabs() {
    tabsBar.innerHTML = "";
    for (const [id, label] of TABS) {
      tabsBar.append(h("button", { class: "subtab" + (st.tab === id ? " on" : ""), onclick: () => { st.tab = id; localStorage.setItem("atelier.voiceTab", id); drawTabs(); } }, label));
      panes[id].hidden = st.tab !== id;
    }
  }
  card.append(h("h2", null, "语音工作台"), head, tabsBar, panes.synth, panes.clone, panes.asr);
  drawTabs();
  const vfetch = async (p, o = {}) => { const r = await fetch("voice" + p, o); if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`); return r.headers.get("content-type")?.includes("json") ? r.json() : r; };
  const onVoiceModels = () => {
    if (!document.body.contains(card)) return document.removeEventListener("models", onVoiceModels);
    load();                                   // a load finished (here or anywhere else) — re-read the catalogue
  };
  document.addEventListener("models", onVoiceModels);
  async function load() {
    head.innerHTML = ""; head.append(h("span", { class: "muted small" }, "读取语音目录…"));
    // The catalogue answers even with nothing in VRAM: engines come from 13, saved voices from its mirror.
    try { const c = await api("/voice/catalog"); st.engines = c.engines; st.voices = c.voices; st.loaded = c.loaded; st.serviceUp = c.serviceUp; st.stale = c.stale; }
    catch (e) { head.innerHTML = ""; head.append(h("div", { class: "errbox" }, "语音服务不可用：" + e.message), h("div", { class: "row", style: "margin-top:6px" }, h("button", { class: "sm primary", onclick: async () => { try { await api("/models/ensure", { method: "POST", body: { modality: "voice" } }); toast("正在启动语音服务…", "info"); setTimeout(load, 8000); } catch (e2) { toast(e2.message, "error"); } } }, "启动语音服务"), h("button", { class: "sm", onclick: load }, "重试"))); return; }
    st.engine = st.engine || st.engines.find((e) => e.loaded)?.id || st.engines.find((e) => e.default && e.installed)?.id || st.engines.find((e) => e.installed)?.id;
    head.innerHTML = "";
    if (!st.loaded) {
      const e = eng();
      head.append(h("div", { class: "hint" },
        `语音模型没有加载，音色和历史素材是 13 上的缓存，可以照常浏览；要合成或转写先加载${e?.vram ? `（${e.name} 约占 ${fmtG(e.vram)} 显存）` : ""}。`,
        h("button", { class: "sm primary", style: "margin-left:8px", onclick: async () => { await api("/models/ensure", { method: "POST", body: { modality: "voice", modelId: st.engine } }); toast("正在加载语音模型…加载完这里会自动更新", "ok", 6000); } }, "加载语音模型")));
    }
    draw();
  }
  const eng = () => st.engines.find((e) => e.id === st.engine) || st.engines[0];
  // The catalogue refreshes whenever any model finishes loading. Redrawing the whole page then threw away
  // the text you had typed and the clip you had just synthesised (保存到工作区 would say 先合成一段), so only
  // the catalogue-driven parts are rebuilt; the three work panes are built once.
  function draw() {
    drawCtrl(); drawVoices(); drawSaved(); drawTabs();
    if (!st.built) { st.built = true; drawSynth(); drawClone(); drawAsr(); }
  }
  function drawCtrl() {
    ctrlBox.innerHTML = "";
    const e = eng(); if (!e) return;
    const sel = h("select", null, st.engines.map((x) => h("option", { value: x.id, selected: x.id === st.engine, disabled: !x.installed }, `${x.name}${x.loaded ? "（已加载）" : ""}${x.installed ? "" : "（未安装）"}${x.clone ? " · 可克隆" : " · 内置音色"}`)));
    sel.onchange = () => { st.engine = sel.value; st.params = {}; st.voice = null; draw(); };
    // Which engine is actually in VRAM, and a one-click load for the one you picked. Loading swaps engines
    // (only one fits), so say that plainly rather than letting a synth fail later.
    const loadedName = st.engines.find((x) => x.loaded)?.name;
    const isOn = !!e.loaded;
    const loadBtn = h("button", { class: "sm" + (isOn ? " ghost" : " primary"), disabled: isOn, onclick: async () => {
      await api("/models/ensure", { method: "POST", body: { modality: "voice", modelId: e.id } });
      toast(`正在加载 ${e.name}…${loadedName && loadedName !== e.name ? `（会换掉 ${loadedName}）` : ""}`, "ok", 6000);
    } }, isOn ? "已在显存" : "加载这个模型");
    ctrlBox.append(h("label", null, "模型"), sel,
      h("div", { class: "row", style: "gap:8px;align-items:center;margin:4px 0 6px" },
        h("span", { class: "badge " + (isOn ? "on" : "") }, isOn ? "已加载" : st.serviceUp ? "未加载" : "语音服务未启动"),
        e.vram ? h("span", { class: "muted small" }, `约占 ${fmtG(e.vram)} 显存${e.fileGb ? ` · 权重 ${e.fileGb} GB` : ""}`) : null,
        loadBtn,
        loadedName && !isOn ? h("span", { class: "muted small" }, `当前显存里是 ${loadedName}`) : null),
      h("div", { class: "muted small", style: "margin:2px 0 6px" }, e.notes || e.note || ""));
    for (const c of e.controls || []) {
      const cur = st.params[c.key] ?? c.default ?? "";
      let inp;
      if (c.type === "range") { const lbl = h("span", { class: "mono small" }, String(cur)); inp = h("input", { type: "range", min: c.min, max: c.max, step: c.step, value: cur }); inp.oninput = () => { st.params[c.key] = Number(inp.value); lbl.textContent = inp.value; }; ctrlBox.append(h("label", null, c.label, " ", lbl), inp); }
      else if (c.type === "select") { inp = h("select", null, c.options.map((o) => h("option", { value: o, selected: o === cur }, o))); inp.onchange = () => { st.params[c.key] = inp.value; }; ctrlBox.append(h("label", null, c.label), inp); }
      else { inp = h("input", { value: cur, placeholder: c.hint || "" }); inp.oninput = () => { st.params[c.key] = inp.value; }; ctrlBox.append(h("label", null, c.label), inp, c.hint ? h("div", { class: "hint" }, c.hint) : null); }
    }
  }
  /** Gender / language read off the voice metadata (Kokoro puts them in the id, Qwen in the name). */
function voiceChips(v) {
  const txt = `${v.id || ""} ${v.name || ""}`;
  const female = /女|\bf_|female/i.test(txt) && !/男/.test(v.name || "");
  const male = /男|\bm_|male/i.test(txt) && !female;
  const lang = v.lang || (/^[zZ]/.test(v.id || "") ? "zh" : /^[abAB]/.test(v.id || "") ? "en" : "");
  const out = [];
  if (female || male) out.push(h("span", { class: "chip", style: `background:${female ? "#4a2b3d" : "#243b52"};color:${female ? "#ffc0d9" : "#a8d3ff"}` }, female ? "女" : "男"));
  if (lang) out.push(h("span", { class: "chip" }, lang));
  return out;
}
function voiceItem(v, kind) {
    const on = st.voice === v.id;
    const url = kind === "builtin"
      ? `api/voice/preview?model=${encodeURIComponent(st.engine)}&voice=${encodeURIComponent(v.id)}`
      : `voice/voices/${encodeURIComponent(v.id)}/sample`;
    const play = h("button", { class: "sm ghost", title: kind === "builtin" ? "试听（第一次要合成一句，之后缓存在 13 上）" : "试听参考声", onclick: (ev) => {
      ev.stopPropagation();
      playPreview(url, play, { onError: () => toast(kind === "builtin" ? "试听要先加载这个语音模型" : "这个音色没有可试听的样本", "warn") });
    } }, "▶");
    return h("div", { class: "vitem" + (on ? " on" : ""), title: v.id, onclick: () => { st.voice = v.id; drawVoices(); } }, h("div", { class: "row between" }, h("b", { class: "small" }, v.name, h("span", { class: "muted mono", style: "font-weight:400;font-size:10px;margin-left:5px" }, v.id)), h("span", { class: "row", style: "gap:4px;align-items:center" }, voiceChips(v), play)), v.note ? h("div", { class: "muted small" }, v.note) : null, kind === "saved" && v.refText ? h("div", { class: "muted small", title: v.refText }, `“${v.refText.slice(0, 40)}${v.refText.length > 40 ? "…" : ""}”${v.seconds ? ` · ${v.seconds}s` : ""}`) : null,
      kind === "saved" ? h("div", { class: "row", style: "gap:4px;margin-top:4px" }, h("button", { class: "sm ghost", onclick: async (ev) => { ev.stopPropagation(); const n = prompt("重命名", v.name); if (n) { await vfetch(`/voices/${v.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) }); st.voices = await vfetch("/voices"); drawVoices(); } } }, "改名"), h("button", { class: "sm ghost danger", onclick: async (ev) => { ev.stopPropagation(); if (await confirm(`删除音色「${v.name}」？`, { danger: true })) { await vfetch(`/voices/${v.id}`, { method: "DELETE" }); if (st.voice === v.id) st.voice = null; st.voices = await vfetch("/voices"); drawVoices(); } } }, "删除")) : null);
  }
  function drawVoices() {
    voiceBox.innerHTML = "";
    const e = eng(); if (!e) return;
    const q = (st.voiceFilter || "").trim().toLowerCase();
    const match = (v) => !q || `${v.id} ${v.name || ""} ${v.lang || ""}`.toLowerCase().includes(q)
      || (q === "女" && /女|f_/i.test(`${v.id} ${v.name}`)) || (q === "男" && /男|m_/i.test(`${v.id} ${v.name}`));
    const builtin = (e.voices || []).filter(match); const saved = (st.voices.saved || []).filter(match); const samples = (st.voices.samples || []).filter(match);
    if (!st.voice) {
      const zh = (v) => v.lang === "zh" || /^z[fm]_/.test(v.id || "");
      st.voice = e.clone ? (saved[0]?.id || samples.find((x) => x.id === "sample:voice_05")?.id || samples[0]?.id)
                         : (builtin.find(zh)?.id || builtin[0]?.id);
    }
    const sec = (title, list, kind, hint) => list.length ? h("div", { style: "margin-bottom:8px" }, h("div", { class: "muted small", style: "margin-bottom:4px" }, title), h("div", { class: "vgrid" }, list.map((v) => voiceItem(v, kind)))) : (hint ? h("p", { class: "muted small" }, hint) : null);
    const total = (e.voices || []).length + (st.voices.saved || []).length + (st.voices.samples || []).length;
    if (total > 12) {
      const f = h("input", { class: "vfilter", placeholder: "筛选音色：男 / 女 / zh / en / 名字", value: st.voiceFilter || "" });
      f.oninput = () => { st.voiceFilter = f.value; drawVoices(); f.focus(); };
      voiceBox.append(f);
    }
    if (e.clone) voiceBox.append(sec("我的音色", saved, "saved", "还没有保存的音色，用右边「克隆新音色」加一个。"), sec("示例声", samples, "sample"));
    voiceBox.append(sec(`${e.name} 内置音色（${(e.voices || []).length}）`, builtin, "builtin", ""));
    if (!(e.voices || []).length) {
      voiceBox.append(h("p", { class: "muted small" },
        e.clone ? "这个模型没有内置角色，声音完全来自你给的参考声：用上面的「我的音色」或示例声，情绪/语气用左边的控制项单独调，两者不冲突。"
                : "这个模型没有内置音色。",
        h("br"), "想要现成的男女角色，换 Qwen3-TTS（9 个官方角色，含北京腔 / 四川腔 / 日语 / 韩语）或 Kokoro（加载后约 130 个中英音色）。"));
    }
    if (!e.clone && (st.voices.saved || []).length) voiceBox.append(h("p", { class: "muted small" }, "这个模型不支持克隆，我的音色不可用；换 IndexTTS-2 / Qwen3-TTS。"));
  }
  function drawSynth() {
    synthBox.innerHTML = "";
    const text = h("textarea", { placeholder: "要说的话（≤4000 字；中英日粤等按模型支持）", style: "min-height:90px" });
    const fmt = h("select", null, ["wav", "mp3"].map((f) => h("option", { value: f }, f)));
    const player = h("audio", { controls: true, style: "width:100%;margin-top:6px" }); const dl = h("a", { class: "btn sm", hidden: true, download: "tts.wav" }, "下载"); const status = h("span", { class: "muted small" });
    // The project list lives in S, but a deep link straight to #/voice never populated it — the first
    // 保存 then PUT to `projects//assets` and 404'd. Fetch it here when it is missing.
    const projSel = h("select", null, (S.projects || []).map((p) => h("option", { value: p.id }, p.name)));
    const fillProjects = async () => {
      if (S.projects?.length) return;
      try { S.projects = await api("/projects"); } catch { return; }
      projSel.innerHTML = ""; for (const p of S.projects) projSel.append(h("option", { value: p.id }, p.name));
    };
    fillProjects();
    let lastBlob = null;
    const speak = async () => {
      const t = text.value.trim(); if (!t) return toast("先写点文字");
      status.textContent = "合成中…"; dl.hidden = true;
      const cjk = /[\u3400-\u9fff\u3040-\u30ff]/.test(t);
      const vzh = /^z[fm]_/.test(st.voice || "") || /zh/.test(st.voices?.builtin?.[st.voice]?.lang || "");
      if (st.engine === "kokoro" && cjk && st.voice && !vzh) {
        const zh = (eng()?.voices || []).filter((v) => /^z[fm]_/.test(v.id));
        status.innerHTML = "";
        status.append(h("span", { class: "warn" }, `音色 ${st.voice} 是英文音色，读不了中文（每个汉字会被念成 "Chinese letter"）。`), " ",
          zh.length ? h("button", { class: "sm primary", onclick: () => { st.voice = zh[0].id; drawVoices(); status.textContent = `已换成中文音色 ${zh[0].id}，再点合成。`; } }, `换成 ${zh[0].id}`) : null);
        return;
      }
      try {
        const body = { text: t, model: st.engine, voice: st.voice, format: fmt.value, params: st.params };
        const r = await fetch("voice/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (r.status === 409) {   // nothing loaded, or a different engine is in VRAM — make it one click to fix
          const j = await r.json().catch(() => ({}));
          status.innerHTML = "";
          status.append(h("span", { class: "warn" }, j.error?.message || j.error || "语音模型没有加载"), " ",
            h("button", { class: "sm primary", onclick: async () => { await api("/models/ensure", { method: "POST", body: { modality: "voice", modelId: st.engine } }); toast(`正在加载 ${eng()?.name || st.engine}…加载完再点合成`, "ok", 6000); } }, `加载 ${eng()?.name || st.engine}`));
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
        lastBlob = await r.blob(); const url = URL.createObjectURL(lastBlob); player.src = url; player.play().catch(() => {}); dl.href = url; dl.download = "tts." + fmt.value; dl.hidden = false;
        status.textContent = `完成：${r.headers.get("X-Audio-Seconds") ? Number(r.headers.get("X-Audio-Seconds")).toFixed(1) + " 秒" : fmtBytes(lastBlob.size)} · ${r.headers.get("X-Model") || st.engine}`;
      } catch (e) { status.textContent = ""; toast("合成失败：" + e.message, "error", 8000); }
    };
    synthBox.append(text, h("div", { class: "row", style: "margin-top:6px;flex-wrap:wrap" }, h("button", { class: "primary sm", onclick: speak }, "🎙 合成"), fmt, dl, status), player,
      h("div", { class: "row", style: "margin-top:6px" }, h("span", { class: "muted small" }, "存为素材到"), projSel, h("button", { class: "sm", onclick: async () => { if (!lastBlob) return toast("先合成一段"); await fillProjects(); if (!projSel.value) return toast("还没有项目，先到「项目」页建一个", "warn"); const nm = `tts_${(text.value.trim().slice(0, 12) || "voice").replace(/[\\/:*?"<>|\s]+/g, "_")}.${fmt.value}`; const up = await fetch(`api/projects/${projSel.value}/assets?name=${encodeURIComponent(nm)}`, { method: "PUT", headers: { "content-type": lastBlob.type || "audio/wav" }, body: lastBlob }); if (!up.ok) return toast("保存失败：" + (await up.text()).slice(0, 160), "error"); const a = await up.json(); const proj = S.projects.find((x) => x.id === projSel.value)?.name || projSel.value; toast(`已存到「${proj}」的素材：${a.name}（${a.id}）`, "ok", 6000); } }, "保存")));
  }
  /** The saved-voice library, shown next to the clone form so you can hear what you already have. */
  function drawSaved() {
    savedBox.innerHTML = "";
    const saved = st.voices.saved || [], samples = st.voices.samples || [];
    savedBox.append(saved.length
      ? h("div", { class: "vgrid" }, saved.map((v) => voiceItem(v, "saved")))
      : h("p", { class: "muted small" }, "还没有克隆过音色。左边传一段人声就有了。"));
    if (samples.length) savedBox.append(h("div", { class: "muted small", style: "margin:10px 0 4px" }, "自带示例声（不可删）"), h("div", { class: "vgrid" }, samples.map((v) => voiceItem(v, "sample"))));
    savedBox.append(h("p", { class: "hint", style: "margin-top:10px" }, "音色是全局的：IndexTTS-2 和 Qwen3-TTS 都能用同一个 id，在「合成配音」里选它，API 里把 ", h("code", null, "voice"), " 写成它的 id。"));
  }
  function drawClone() {
    cloneBox.innerHTML = "";
    const name = h("input", { placeholder: "音色名字，例如：雨菡 / 老郭" }), note = h("input", { placeholder: "备注（可选）" }), file = h("input", { type: "file", accept: "audio/*,video/*,.wav,.mp3,.m4a,.mp4,.mov" });
    const from = h("input", { type: "number", min: 0, step: 1, value: 0, style: "width:70px" });
    const len = h("input", { type: "number", min: 3, max: 30, step: 1, value: 20, style: "width:70px" });
    const status = h("div", { class: "muted small", style: "margin-top:6px" });
    const go = h("button", { class: "primary sm", onclick: async () => {
      const f = file.files[0]; if (!f) return toast("先选参考声"); if (!name.value.trim()) return toast("起个名字");
      go.disabled = true; status.textContent = `上传 ${fmtBytes(f.size)} 并转写中…（10–40 秒）`;
      try {
        const fd = new FormData(); fd.append("name", name.value.trim()); fd.append("note", note.value); fd.append("ref", f);
        fd.append("start", String(Number(from.value) || 0)); fd.append("seconds", String(Number(len.value) || 20));
        const r = await fetch("voice/voices", { method: "POST", body: fd });
        if (r.status === 409) {   //克隆要先把语音服务拉起来（转写参考声用的是同一套服务）
          const j = await r.json().catch(() => ({}));
          status.innerHTML = "";
          status.append(h("span", { class: "warn" }, (j.error?.message || j.error || "语音模型没有加载") + " 克隆要用它来转写参考声。"), " ",
            h("button", { class: "sm primary", onclick: async () => { try { await api("/models/ensure", { method: "POST", body: { modality: "voice", modelId: st.engine } }); toast(`正在加载 ${eng()?.name || st.engine}…加载完再点保存`, "ok", 6000); } catch (e2) { toast(e2.message, "error"); } } }, `加载 ${eng()?.name || st.engine}`));
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
        const v = await r.json();
        st.voices = await vfetch("/voices"); st.voice = v.id; drawVoices(); drawSaved();
        status.innerHTML = ""; status.append(h("span", { class: "ok" }, `已保存「${v.name}」`), ` · ${v.seconds || "?"} 秒 · 转写：“${(v.refText || "").slice(0, 40)}”`);
        name.value = ""; note.value = ""; file.value = "";
        toast(`音色「${v.name}」已保存，可以到「合成配音」用它说话`, "ok", 6000);
      } catch (e) { status.innerHTML = ""; status.append(h("span", { class: "warn" }, "保存失败：" + e.message)); }
      finally { go.disabled = false; }
    } }, "保存为音色");
    cloneBox.append(
      h("p", { class: "hint" },
        "音色是全局的，不属于某个模型：这里只保存你给的那段人声和它的转写，合成时 IndexTTS-2 和 Qwen3-TTS 都能拿它说话，所以不用在这里选模型。"),
      h("p", { class: "hint" },
        "两个引擎都是零样本克隆，只看一段参考声：3–15 秒干净人声就够，再长主要是多了环境底噪。默认取开头 20 秒（自动去掉开头的静音）；开头不干净就往后挪起点。背景音乐、多人说话、明显混响会让音色走样。"),
      h("label", null, "名字"), name, h("label", null, "备注"), note,
      h("label", null, "参考声文件"), file,
      h("div", { class: "row", style: "gap:10px;align-items:center;margin-top:6px" },
        h("label", { class: "inline" }, "从第 ", from, " 秒开始"),
        h("label", { class: "inline" }, "取 ", len, " 秒")),
      h("div", { class: "row", style: "margin-top:8px" }, go), status);
  }
  function drawAsr() {
    asrBox.innerHTML = "";
    const f = h("input", { type: "file", accept: "audio/*,video/*" }), out = h("pre", { style: "max-height:120px;white-space:pre-wrap;margin-top:6px" }, "");
    asrBox.append(h("div", { class: "hint" },
      "转写用 SenseVoice-Small，跟语音服务一起起来，不用单独加载，也不占仪表盘的位置。音频或视频都行，输出文字与语种。",
      h("br"), "接口：", h("code", null, "POST /gpu/llm/v1/audio/transcriptions"), "（multipart 的 file），在「接入 · API」页有可复制的完整地址。"));
    asrBox.append(h("div", { class: "row" }, f, h("button", { class: "sm", onclick: async () => { const file = f.files[0]; if (!file) return toast("先选文件"); out.textContent = "转写中…"; const fd = new FormData(); fd.append("file", file); try { const j = await vfetch("/asr", { method: "POST", body: fd }); out.textContent = `${j.text}\n[${[j.language, j.emotion, ...(j.events || [])].filter(Boolean).join(" · ")}]`; } catch (e) { out.textContent = ""; toast("转写失败：" + e.message, "error"); } } }, "转写")), out);
  }
  load();
}

routes.chat = async (main) => {
  const snap = await api("/models");
  const card = h("div", { class: "card" });
  main.append(h("h1", null, "对话"), h("p", { class: "hint" }, "GPU 上的本地大模型（默认 Qwen3.8-27B）。发送会自动开机并加载模型（首次 1–4 分钟）；视频任务来了会把它挤出显存，用完自动空闲关机。走的就是对外的 OpenAI 兼容端点，agent 用「接入」页的密钥调同一个地址。"), card);
  chatPanel(card, snap);
};
routes.voice = async (main) => {
  const card = h("div", { class: "card" });
  main.append(h("h1", null, "语音"), h("p", { class: "hint" }, "三个引擎：IndexTTS-2 零样本克隆 + 情绪，Qwen3-TTS 9 个官方角色 + 风格指令，Kokoro 约 130 个内置音色、最快。转写用 SenseVoice。合成结果可以直接存成项目素材。"), card);
  voicePanel(card);
};

// ================= Access: endpoints + API keys + agent onboarding =================
routes.access = async (main) => {
  let ep = await api("/endpoints"); let keys = await api("/keys"); const revealed = {};
  const epCard = h("div", { class: "card" }), promptCard = h("div", { class: "card" }), voiceCard = h("div", { class: "card" }), keysCard = h("div", { class: "card" });
  // 四块内容挤在一页太乱，拆成 tab；密钥单独一页，因为其它三页都要用它
  main.append(h("h1", null, "接入 · API"),
    h("p", { class: "hint" }, "给 agent / 脚本 / 别的机器用的入口。所有端点共用同一把密钥，认证一律是请求头 ", h("code", null, "Authorization: Bearer <密钥>"), "。"),
    tabbed([
      ["🔑 密钥", keysCard],
      ["🔌 端点", epCard],
      ["💬 大模型接入", promptCard],
      ["🎙 语音接入", voiceCard],
    ]));
  // ---- current key: remembered choice → newest revealable → none
  const curKeyId = () => { const want = localStorage.getItem("atelier.currentKey"); const ok = keys.filter((k) => k.revealable); return (ok.find((k) => k.id === want) || ok.at(-1))?.id || null; };
  const keyText = async (id) => { if (!id) return null; if (!revealed[id]) revealed[id] = (await api(`/keys/${id}/reveal`)).key; return revealed[id]; };
  const row = (label, value, note) => h("tr", null, h("td", null, h("b", null, label)), h("td", { class: "mono small", style: "word-break:break-all" }, value), h("td", null, h("button", { class: "sm ghost", onclick: () => copy(value) }, "复制")), h("td", { class: "muted small" }, note || ""));
  function drawEndpoints() {
    epCard.innerHTML = "";
    const llmList = ep.models.llm; const llmSel = h("select", null, llmList.map((m) => h("option", { value: m.id, selected: m.default }, `${m.name}${m.ctx ? " · " + m.ctx : ""}${m.loaded ? "（已加载）" : m.tested ? "" : "（未测试）"}`)));
    llmSel.onchange = async () => { try { await api("/models/default", { method: "POST", body: { modality: "llm", modelId: llmSel.value } }); ep = await api("/endpoints"); toast(`默认 LLM 已切为 ${llmSel.value}；下次调用 /llm 会自动换成它`, "ok"); drawEndpoints(); drawPrompt(); } catch (e) { toast(e.message, "error"); } };
    const voiceNames = ep.models.voice.filter((m) => m.tested).map((m) => m.name).join(" + ");
    epCard.append(h("h2", null, "端点"), h("table", { class: "ep" },
      row("OpenAI 兼容 LLM", ep.llm, ""),
      h("tr", null, h("td", null, h("b", null, "　↳ 模型")), h("td", { colspan: 3 }, h("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, llmSel, h("span", { class: "muted small" }, `请求里 model 写 ${ep.llmModel || "所选模型 id"}；这里选的就是 /llm 默认加载的那一个（换一个就自动卸旧装新）`)))),
      row("REST API", ep.api, "生成视频（MiniMax-H3）/ 白模 / 任务 / 素材 / 提示词库 / 模型管家"),
      row("语音合成（OpenAI 兼容）", ep.speech || (ep.llm + "/audio/speech"), "POST {model: 引擎 id, input, voice: 音色 id, speed, instructions, response_format} → mp3/wav；下面「语音」表有引擎与音色 id"),
      row("语音转写（OpenAI 兼容）", ep.transcriptions || (ep.llm + "/audio/transcriptions"), "multipart file → {text}；SenseVoice"),
      row("语音原生接口", ep.voice, "/tts /asr /voices /engines：更细的参数（情绪向量、指令、方言、音色描述、保存音色）"),
      row("接口文档", ep.docs, "人读的；OpenAPI 在 " + ep.openapi),
      row("网页", ep.app, "浏览器打开，Passkey 登录")),
      h("p", { class: "hint" }, "认证统一是请求头 ", h("code", null, "Authorization: Bearer <密钥>"), "。首次调用会自动开机（1–4 分钟），之后秒级；空闲到阈值自动关机。"));
  }
  function agentPrompt(key, m) {
    const k = key || "<先在下面创建一把密钥>"; const model = m?.id || ep.llmModel || "见 GET " + ep.llm + "/models"; const ctx = m ? ctxOf(m) : null;
    return `新增一个 OpenAI 兼容的大模型服务：
- base_url：${ep.llm}
- api_key：${k}
- model：${model}${ctx ? `（上下文 ${ctx}）` : ""}
- 支持 chat/completions 与 stream；首次请求会让远端 GPU 自动开机并加载模型，可能要等 1–4 分钟，遇到 503 稍后重试即可。

同一把 key 还可以调用（认证都是请求头 Authorization: Bearer ${k}）：
- 语音合成（OpenAI 兼容）：POST ${ep.speech || ep.llm + "/audio/speech"}   {"model":"<引擎 id>","input":"…","voice":"<音色 id>","speed":1.0,"instructions":"情绪/风格","response_format":"mp3"}
    引擎与音色列表：GET ${ep.llm}/models（type=tts 的条目带内置 voices；顶层 voices 是已保存的音色 id）
- 语音转写（OpenAI 兼容）：POST ${ep.transcriptions || ep.llm + "/audio/transcriptions"}   multipart 的 file（音频或视频）→ {"text":…}
- 视频生成、白模等 REST API：${ep.api}   文档 ${ep.docs}`;
  }
  let llmModels = [];
  async function drawPrompt() {
    promptCard.innerHTML = "";
    const id = curKeyId(); let key = null; try { key = await keyText(id); } catch (e) { toast(e.message, "error"); }
    llmModels = (S.models?.models || (await api("/models")).models).filter((m) => m.modality === "llm");
    const curKey = keys.find((k) => k.id === id);
    const sel = h("select", null, keys.filter((k) => k.revealable).map((k) => h("option", { value: k.id, selected: k.id === id }, k.label)));
    sel.onchange = () => { localStorage.setItem("atelier.currentKey", sel.value); drawPrompt(); drawKeys(); };
    const rows = llmModels.map((m) => {
      const info = ep.models.llm.find((x) => x.id === m.id) || {};
      const text = agentPrompt(key, m);
      return h("tr", null, h("td", null, h("b", null, m.name), h("div", { class: "muted small mono" }, m.id)), h("td", { class: "mono" }, ctxOf(m) || "—"), h("td", null, m.quant || "—"), h("td", null, vramCell(m)),
        h("td", null, info.loaded ? h("span", { class: "badge on" }, "已加载") : m.tested ? h("span", { class: "badge done" }, "已测试") : h("span", { class: "badge" }, "未测试"), info.default ? h("span", { class: "badge", style: "margin-left:4px" }, "默认") : null),
        h("td", null, h("div", { class: "row", style: "gap:4px;flex-wrap:wrap" },
          h("button", { class: "sm primary", disabled: !key, title: key ? "复制这一个模型的完整接入说明（已填当前密钥）" : "先创建密钥", onclick: () => copy(text) }, "复制接入提示词"),
          h("button", { class: "sm ghost", onclick: () => modal(`接入提示词 · ${m.name}`, h("div", null, h("pre", { style: "white-space:pre-wrap;font-size:12px;max-height:60vh;overflow:auto" }, text)), { actions: [{ label: "复制", primary: true, onclick: () => copy(text) }] }) }, "查看"),
          info.default ? null : h("button", { class: "sm ghost", title: "让 /llm 默认加载它", onclick: async () => { try { await api("/models/default", { method: "POST", body: { modality: "llm", modelId: m.id } }); ep = await api("/endpoints"); drawEndpoints(); drawPrompt(); } catch (e) { toast(e.message, "error"); } } }, "设为默认"))));
    });
    promptCard.append(h("h2", null, "给 agent 的接入提示词"), h("p", { class: "hint" }, "按模型复制：每一行的「复制接入提示词」是一段中性的接入说明（端点、密钥、模型名、其它可调用的服务），只写这一个模型，密钥已填好（当前密钥：", h("b", null, curKey?.label || "无"), "）。怎么保存、用在哪，由收到它的 agent 自己决定。"),
      keys.filter((k) => k.revealable).length ? h("div", { class: "row", style: "margin-bottom:8px" }, h("label", { class: "inline small" }, "填入哪把密钥 ", sel)) : h("p", { class: "warn small" }, "还没有可显示的密钥，先在下面创建一把，提示词才有密钥。"),
      h("table", { class: "ep" }, h("tr", null, h("th", null, "大模型"), h("th", null, "上下文"), h("th", null, "量化"), h("th", null, "显存"), h("th", null, "状态"), h("th", null, "")), rows));
    // ---- 语音：一把密钥同样能用；把 endpoint / key / instruct / 音色 id 一次说清楚，能整段复制给 agent
    voiceCard.innerHTML = "";
    const vm = ep.models.voice.filter((m) => m.id !== "sensevoice-small");
    const speechUrl = ep.speech || (ep.llm + "/audio/speech");
    const asrUrl = ep.transcriptions || (ep.llm + "/audio/transcriptions");
    const k = key || "<先在「密钥」页创建一把>";
    let cat = null; try { cat = await api("/voice/catalog"); } catch {}
    const engineOf = (id) => (cat?.engines || []).find((e) => e.id === id) || {};
    const savedVoices = cat?.voices?.saved || ep.voices?.saved || [];
    const sampleVoices = cat?.voices?.samples || [];
    const voiceAgentPrompt = (m) => {
      const e = engineOf(m.id);
      const builtin = (e.voices || []).map((v) => v.id);
      const ctrl = (e.controls || []).map((c) => `    - ${c.key}${c.label && c.label !== c.key ? `（${c.label}）` : ""}${c.type === "range" ? `：${c.min}–${c.max}` : c.type === "select" ? `：${(c.options || []).join(" / ")}` : ""}${c.hint ? `　例：${c.hint}` : ""}`).join("\n");
      return `新增一个 OpenAI 兼容的语音合成服务：
- endpoint：POST ${speechUrl}
- api_key：${k}（请求头 Authorization: Bearer <key>）
- model：${m.id}   # 引擎 id
- voice：音色 id，见下
- 请求体：{"model":"${m.id}","input":"要说的话","voice":"<音色 id>","speed":1.0,"instructions":"<风格指令>","response_format":"wav"}
- 返回：音频二进制（wav / mp3），响应头 X-Audio-Seconds 是时长

音色 id：
${builtin.length ? `  内置（${builtin.length} 个）：${builtin.slice(0, 12).join(", ")}${builtin.length > 12 ? " …完整列表 GET " + ep.llm + "/models" : ""}` : "  这个引擎没有内置音色，必须用克隆音色"}
${m.clone ? `  我的克隆音色：${savedVoices.length ? savedVoices.map((v) => `${v.id}（${v.name}）`).join(", ") : "（还没有，去网页「语音 · 克隆音色」传一段人声）"}` : "  （这个引擎不支持克隆音色）"}
${sampleVoices.length && m.clone ? `  自带示例声：${sampleVoices.map((v) => v.id).join(", ")}` : ""}
${ctrl ? `\n这个引擎支持的额外参数（放进 instructions，或走原生接口 ${ep.voice}/tts 的 params）：\n${ctrl}` : ""}
转写用同一把 key：POST ${asrUrl}，multipart 的 file（音频或视频）→ {"text": "...", "language": "..."}
更细的参数（情绪向量、方言、音色描述、保存新音色）走原生接口：${ep.voice}/tts、${ep.voice}/voices、${ep.voice}/engines`;
    };
    const vrows = vm.map((m) => {
      const e = engineOf(m.id);
      const builtin = (e.voices || []).map((v) => v.id);
      const txt = voiceAgentPrompt(m);
      return h("tr", null,
        h("td", null, h("b", null, m.name.split("（")[0]), h("div", { class: "muted small mono" }, m.id)),
        h("td", null, m.clone ? "克隆音色 + 参考声" : "内置音色", e.loaded ? h("span", { class: "badge on", style: "margin-left:4px" }, "已加载") : null),
        h("td", { class: "mono small", style: "max-width:280px;word-break:break-all" }, builtin.length ? builtin.slice(0, 6).join(", ") + (builtin.length > 6 ? ` …共 ${builtin.length}` : "") : "—"),
        h("td", { class: "small" }, (e.controls || []).map((c) => c.key).join(", ") || "—"),
        h("td", null, h("div", { class: "row", style: "gap:4px;flex-wrap:wrap" },
          h("button", { class: "sm primary", disabled: !key, title: key ? "复制这个引擎的完整接入说明（已填当前密钥）" : "先创建一把密钥", onclick: () => copy(txt) }, "复制接入说明"),
          h("button", { class: "sm ghost", onclick: () => modal(`语音接入 · ${m.name}`, h("div", null, h("pre", { style: "white-space:pre-wrap;max-height:52vh" }, txt)), { actions: [{ label: "复制", primary: true, onclick: () => copy(txt) }, { label: "关闭" }] }) }, "查看"))));
    });
    voiceCard.append(h("h2", null, "语音接入"),
      h("p", { class: "hint" }, "跟大模型用同一把密钥。", h("code", null, "model"), " 填引擎 id，", h("code", null, "voice"), " 填音色 id；风格用 ",
        h("code", null, "instructions"), "（原生接口里是 params）。下面每一行都能整段复制给 agent。"),
      h("table", { class: "ep" }, h("tr", null, h("th", null, "引擎"), h("th", null, "音色来源"), h("th", null, "内置音色 id"), h("th", null, "可调参数"), h("th", null, "")), vrows),
      h("div", { class: "kv", style: "margin-top:10px" },
        h("div", null, "合成"), h("div", { class: "mono small", style: "word-break:break-all" }, "POST " + speechUrl),
        h("div", null, "转写"), h("div", { class: "mono small", style: "word-break:break-all" }, "POST " + asrUrl),
        h("div", null, "原生接口"), h("div", { class: "mono small", style: "word-break:break-all" }, ep.voice + "  /tts /asr /voices /engines")),
      savedVoices.length
        ? h("div", { style: "margin-top:10px" }, h("div", { class: "muted small", style: "margin-bottom:4px" }, `我的克隆音色（voice 直接填 id，${savedVoices.length} 个）`),
            h("div", { class: "row", style: "gap:6px;flex-wrap:wrap" }, savedVoices.map((v) => h("span", { class: "badge", style: "cursor:pointer", title: "点一下复制 id", onclick: () => copy(v.id) }, `${v.name} · `, h("span", { class: "mono" }, v.id)))))
        : h("p", { class: "muted small", style: "margin-top:10px" }, "还没有克隆音色。到「语音 · 克隆音色」传一段人声，之后 voice 直接填它的 id，IndexTTS-2 和 Qwen3-TTS 都能用。"));
  }
  async function drawKeys() {
    keys = await api("/keys"); keysCard.innerHTML = "";
    const label = h("input", { placeholder: "给谁用：例如 cursor-mac / hermes-bot", style: "flex:1" });
    keysCard.append(h("h2", null, "密钥"), h("p", { class: "hint" }, "一把密钥通吃所有端点，权限等同网页登录。通常一个 agent 一把就够，不用多建；点「显示」能再次看到完整密钥（2026-09-07 之前建的只存了指纹）。"),
      h("div", { class: "row" }, label, h("button", { class: "primary sm", onclick: async () => { if (!label.value.trim()) return toast("先起个名字"); try { const r = await api("/keys", { method: "POST", body: { label: label.value.trim() } }); revealed[r.id] = r.key; localStorage.setItem("atelier.currentKey", r.id); label.value = ""; await drawKeys(); drawPrompt(); toast(`已创建 ${r.label}，并填进了上面的提示词`, "ok"); } catch (e) { toast(e.message, "error"); } } }, "创建密钥")),
      keys.length ? h("table", { style: "margin-top:10px" }, h("tr", null, h("th", null, "名称"), h("th", null, "密钥"), h("th", null, "创建"), h("th", null, "最近使用"), h("th", null, "")), keys.map((k) => {
        const cell = h("td", { class: "mono small", style: "word-break:break-all" }, revealed[k.id] || k.prefix + "…");
        return h("tr", null, h("td", null, k.label, k.id === curKeyId() ? h("span", { class: "badge on", style: "margin-left:6px" }, "当前") : null), cell, h("td", null, fmtDate(k.createdAt)), h("td", null, fmtDate(k.lastUsedAt)), h("td", null, h("div", { class: "row", style: "gap:4px" },
          k.revealable ? h("button", { class: "sm", onclick: async () => { try { cell.textContent = await keyText(k.id); } catch (e) { toast(e.message, "error"); } } }, "显示") : h("span", { class: "muted small", title: "创建时未保存明文" }, "不可显示"),
          k.revealable ? h("button", { class: "sm", onclick: async () => { try { copy(await keyText(k.id)); } catch (e) { toast(e.message, "error"); } } }, "复制") : null,
          k.revealable && k.id !== curKeyId() ? h("button", { class: "sm ghost", onclick: () => { localStorage.setItem("atelier.currentKey", k.id); drawKeys(); drawPrompt(); } }, "设为当前") : null,
          h("button", { class: "sm danger", onclick: async () => { if (await confirm(`吊销「${k.label}」？用它的 agent 会立刻 401。`, { danger: true })) { await api(`/keys/${k.id}`, { method: "DELETE" }); delete revealed[k.id]; await drawKeys(); drawPrompt(); } } }, "吊销"))));
      })) : h("p", { class: "muted small" }, "还没有密钥，先创建一把。"));
  }
  drawEndpoints(); await drawKeys(); drawPrompt();
  listen("models", async () => { ep = await api("/endpoints").catch(() => ep); drawEndpoints(); });
};

// ================= Settings =================
routes.settings = async (main) => {
  const [pks, meta] = await Promise.all([api("/passkeys"), api("/meta")]);
  const tbl = h("table", null, h("tr", null, h("th", null, "名称"), h("th", null, "批准时间"), h("th", null, "最近使用"), h("th", null, "设备"), h("th", null, "")), pks.map((k) => h("tr", null, h("td", null, k.label), h("td", null, fmtDate(k.approvedAt)), h("td", null, fmtDate(k.lastUsedAt)), h("td", null, `${k.deviceType || "?"}${k.backedUp ? "（已同步）" : ""}`), h("td", null, h("button", { class: "sm danger", onclick: async () => { if (await confirm(`吊销 Passkey「${k.label}」及其会话？`, { danger: true })) { await api(`/passkeys/${encodeURIComponent(k.id)}`, { method: "DELETE" }); navigate(); } } }, "吊销")))));
  const keysCard = h("div", { class: "card" }, h("h2", null, "接入 · API"), h("p", { class: "hint" }, "端点地址、API 密钥（可再次显示）和给 agent 的接入提示词都搬到了独立页面。"), h("a", { class: "btn sm", href: "#/access" }, "打开「接入 · API」"));
  const storageCard = h("div", { class: "card" });
  async function drawStorage() {
    storageCard.innerHTML = ""; storageCard.append(h("h2", null, "存储与清理"), h("p", { class: "muted small" }, "统计中…"));
    let ov; try { ov = await api("/storage"); } catch (e) { storageCard.append(h("div", { class: "errbox" }, e.message)); return; }
    storageCard.innerHTML = "";
    const days = h("input", { type: "number", value: 7, min: 0, style: "width:70px" }), cbOld = h("input", { type: "checkbox", checked: true }), cbFailed = h("input", { type: "checkbox", checked: true }), cbOrphan = h("input", { type: "checkbox", checked: true });
    const rules = () => ({ oldJobsDays: cbOld.checked ? Number(days.value) : null, failedJobs: cbFailed.checked, orphanAssets: cbOrphan.checked });
    const planBox = h("div", { style: "margin-top:8px" });
    storageCard.append(h("h2", null, "存储与清理"),
      h("div", { class: "kv" }, h("div", null, "任务产物"), h("div", null, `${fmtBytes(ov.jobs.bytes)} · ${ov.jobs.count} 个任务`), h("div", null, "项目素材"), h("div", null, `${fmtBytes(ov.assets.bytes)} · ${ov.assets.count} 个素材`), h("div", null, "成片"), h("div", null, `${fmtBytes(ov.renders.bytes)} · ${ov.renders.count} 条`), h("div", null, "提示词镜像"), h("div", null, fmtBytes(ov.prompts.bytes)), h("div", null, "磁盘剩余"), h("div", null, ov.disk ? `${fmtBytes(ov.disk.free)} / ${fmtBytes(ov.disk.total)}` : "未知")),
      h("div", { class: "progress", style: "margin:8px 0" }, h("i", { style: `width:${ov.disk ? Math.round(100 * (1 - ov.disk.free / ov.disk.total)) : 0}%` })),
      h("p", { class: "hint" }, "清理规则：只删「没有被任何片段 / 镜头 / 数字人 / 母图 / 成片引用」的东西；正在运行的任务永远不碰。先预览，再二次确认。"),
      h("div", { class: "row", style: "gap:12px;flex-wrap:wrap" }, h("label", { class: "row", style: "gap:4px" }, cbOld, "超过 ", days, " 天且未被引用的已完成任务"), h("label", { class: "row", style: "gap:4px" }, cbFailed, "失败/已取消的任务"), h("label", { class: "row", style: "gap:4px" }, cbOrphan, "未被引用的派生素材（抽帧/裁剪/切段等）与 30 天以上的闲置上传")),
      h("div", { class: "row", style: "margin-top:8px" }, h("button", { class: "sm primary", onclick: async () => { planBox.innerHTML = "计算中…"; try { const pl = await api("/storage/plan", { method: "POST", body: rules() }); planBox.innerHTML = ""; if (!pl.jobs.length && !pl.assets.length) return planBox.append(h("p", { class: "muted small" }, "按当前规则没有可清理的内容。")); planBox.append(h("p", null, h("b", null, `将删除 ${pl.jobs.length} 个任务 + ${pl.assets.length} 个素材，释放约 ${fmtBytes(pl.totalBytes)}`)), h("details", null, h("summary", { class: "muted small" }, "查看明细"), h("table", null, h("tr", null, h("th", null, "类型"), h("th", null, "名称"), h("th", null, "原因"), h("th", null, "大小"), h("th", null, "创建")), pl.jobs.map((x) => h("tr", null, h("td", null, "任务"), h("td", null, x.title), h("td", null, x.reason === "failed" ? "失败/取消" : "过期未引用"), h("td", null, fmtBytes(x.bytes)), h("td", null, fmtDate(x.createdAt)))), pl.assets.map((x) => h("tr", null, h("td", null, "素材"), h("td", null, h("a", { href: `#/project/${x.projectId}/assets/unref`, title: "打开该项目的素材页（只看未被引用）" }, x.project), " / ", x.name), h("td", null, x.reason === "derived" ? "派生未引用" : "闲置上传"), h("td", null, fmtBytes(x.bytes)), h("td", null, fmtDate(x.createdAt)))))), h("div", { class: "row", style: "margin-top:8px" }, h("button", { class: "sm danger", onclick: async () => { if (!(await confirm(`确定删除 ${pl.jobs.length} 个任务和 ${pl.assets.length} 个素材（约 ${fmtBytes(pl.totalBytes)}）？不可恢复。`, { danger: true }))) return; try { const r = await api("/storage/clean", { method: "POST", body: { ...rules(), confirm: true } }); toast(`已清理 ${r.removedJobs} 个任务、${r.removedAssets} 个素材，释放 ${fmtBytes(r.freed)}`, "ok"); drawStorage(); } catch (e) { toast(e.message, "error"); } } }, "确认清理"))); } catch (e) { planBox.innerHTML = ""; planBox.append(h("div", { class: "errbox" }, e.message)); } } }, "预览将删除的内容"), h("span", { class: "muted small" }, `默认规则可释放约 ${fmtBytes(ov.suggested.bytes)}`)),
      planBox);
  }
  drawStorage();
  const auditCard = h("div", { class: "card" });
  async function drawAudit() {
    auditCard.innerHTML = ""; auditCard.append(h("h2", null, "审计日志"));
    let rows = []; try { rows = await api("/audit?limit=200"); } catch (e) { auditCard.append(h("div", { class: "errbox" }, e.message)); return; }
    const ZH = { "passkey.enrollment.requested": "申请注册 Passkey", "passkey.enrollment.approved": "批准 Passkey", "passkey.enrollment.rejected": "拒绝 Passkey", "passkey.revoked": "吊销 Passkey", "session.created": "登录", "apikey.created": "创建 API Key", "apikey.revoked": "吊销 API Key", "storage.cleaned": "清理存储", "gpu.on": "GPU 开机", "gpu.off": "GPU 关机", "gpu.stop": "GPU 停机", "gpu.start": "GPU 请求开机" };
    auditCard.append(h("p", { class: "hint" }, "最近 200 条认证 / 密钥 / 清理事件。", " ", h("a", { class: "btn sm", href: "api/audit?limit=2000&download=1" }, "导出 JSON")),
      rows.length ? h("div", { style: "max-height:320px;overflow:auto" }, h("table", null, h("tr", null, h("th", null, "时间"), h("th", null, "事件"), h("th", null, "对象"), h("th", null, "详情")), rows.map((r) => { const { at, action, label, ...rest } = r; return h("tr", null, h("td", { class: "mono small" }, new Date(at).toLocaleString("zh-CN", { hour12: false })), h("td", null, ZH[action] || action), h("td", null, label || ""), h("td", { class: "muted small" }, Object.entries(rest).filter(([, v]) => v != null).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · "))); }))) : h("p", { class: "muted small" }, "还没有记录。"));
  }
  drawAudit();
  // ---- 提示词助手（DeepSeek）与 H3 规则 ------------------------------------------------------
  const aiCard = h("div", { class: "card" });
  async function drawAI() {
    aiCard.innerHTML = "";
    let a; try { a = await api("/settings/assistant"); } catch (e) { aiCard.append(h("h2", null, "提示词助手"), h("div", { class: "errbox" }, e.message)); return; }
    const base = h("input", { value: a.baseUrl, placeholder: "https://api.deepseek.com", style: "width:100%" });
    const key = h("input", { type: "password", placeholder: a.keyMask ? `已配置（${a.keyMask}），留空表示不改` : "sk-…", style: "width:100%" });
    const model = h("input", { value: a.model, placeholder: "deepseek-v4-pro", style: "width:100%" });
    const fast = h("input", { value: a.fastModel, placeholder: "deepseek-v4-flash（打标用，便宜的那个）", style: "width:100%" });
    const status = h("div", { class: "muted small", style: "margin-top:8px" });
    const presets = h("div", { class: "row", style: "gap:6px;flex-wrap:wrap;margin:4px 0 10px" },
      (a.presets || []).map((p) => h("button", { class: "sm ghost", onclick: () => { base.value = p.baseUrl; model.value = p.model; fast.value = p.fastModel; toast(`已填入 ${p.label} 的地址与模型，密钥还要自己填`, "info"); } }, p.label)));
    aiCard.append(h("h2", null, "提示词助手"),
      h("p", { class: "hint" }, "「快速生成」里那个把中文想法写成 H3 官方格式的助手，以及提示词库的自动打标，用的都是这里配的模型。",
        a.configured ? h("span", null, "　当前：", h("b", null, a.model), a.source === "settings" ? "（这里设置的）" : "（来自服务器环境变量）") : h("span", { class: "warn" }, "　还没配置，助手不可用")),
      presets,
      h("label", null, "接口地址"), base, h("div", { class: "hint" }, "OpenAI 兼容的 /chat/completions 前缀。DeepSeek 官方是 https://api.deepseek.com"),
      h("label", null, "API Key"), key,
      h("label", null, "写提示词用的模型"), model,
      h("label", null, "打标用的小模型"), fast,
      h("div", { class: "row", style: "margin-top:10px;gap:8px" },
        h("button", { class: "primary sm", onclick: async () => {
          try { const r = await api("/settings/assistant", { method: "PATCH", body: { baseUrl: base.value, apiKey: key.value, model: model.value, fastModel: fast.value } });
            key.value = ""; toast(`已保存：${r.model}`, "ok"); drawAI();
          } catch (e) { toast(e.message, "error", 8000); } } }, "保存"),
        h("button", { class: "sm", onclick: async () => {
          status.textContent = "正在真实调用一次…";
          try { const r = await api("/settings/assistant/test", { method: "POST" }); status.innerHTML = ""; status.append(h("span", { class: "ok" }, `通了：${r.model} ${r.ms} ms`), r.reply ? ` · 回复「${r.reply}」` : ""); }
          catch (e) { status.innerHTML = ""; status.append(h("span", { class: "warn" }, "不通：" + e.message)); } } }, "测试连通"),
        a.keyMask ? h("button", { class: "sm ghost danger", onclick: async () => { if (await confirm("清掉这里保存的 Key？会退回服务器环境变量里的那把。", { danger: true })) { await api("/settings/assistant", { method: "PATCH", body: { clearKey: true } }); toast("已清除", "ok"); drawAI(); } } }, "清除 Key") : null),
      status);
  }
  drawAI();
  const rulesCard = h("div", { class: "card" });
  function drawRules() {
    const url = (S.meta?.rulesUrl || "https://atelier.example.com/h3").replace(/\.md$/, "");
    rulesCard.innerHTML = "";
    rulesCard.append(h("h2", null, "H3 提示词规则"),
      h("p", { class: "hint" },
        "这份规则是唯一的事实来源，站内的提示词助手就是拿它当 system prompt。两种用法：",
        h("br"), "① 在「快速生成」里写中文想法，助手按这份规则写成 H3 官方格式；",
        h("br"), "② 把链接给你自己的 agent（Claude / ChatGPT 都能读链接），让它照着写。两条路产出的格式一样。",
        h("br"), "发现出片有问题就改这份规则，改完两边同时生效。"),
      h("div", { class: "kv", style: "margin-top:8px" },
        h("div", null, "规则地址"), h("div", null, h("a", { href: url, target: "_blank", rel: "noopener" }, url)),
        h("div", null, "纯文本"), h("div", null, h("a", { href: url + ".md", target: "_blank", rel: "noopener" }, url + ".md"))),
      h("div", { class: "row", style: "gap:8px;margin-top:10px;flex-wrap:wrap" },
        h("button", { class: "sm primary", onclick: () => copy(`请先读这份 MiniMax-H3 提示词规则：${url}.md\n然后按它的官方格式，把我下面的想法写成提示词。`) }, "复制给 agent 的一句话"),
        h("button", { class: "sm", onclick: () => copy(url + ".md") }, "复制链接")));
  }
  drawRules();
  main.append(h("h1", null, "设置"), tabbed([
    ["🤖 提示词助手", h("div", { class: "grid g2" }, aiCard, rulesCard)],
    ["🗄 存储", storageCard],
    ["🔐 安全", h("div", { class: "grid g2" }, h("div", { class: "card" }, h("h2", null, "Passkeys"), h("p", { class: "hint" }, "新设备在登录页注册后，需在服务器执行 ", h("code", null, "atelier auth approve <CODE>"), " 批准。"), tbl), auditCard)],
    ["ℹ️ 关于", h("div", { class: "grid g2" },
    keysCard,
    h("div", { class: "card" }, h("h2", null, "关于"), h("div", { class: "kv" }, h("div", null, "版本"), h("div", null, meta.version), h("div", null, "ffmpeg"), h("div", null, meta.ffmpeg.ok ? `${meta.ffmpeg.version.split(" ").slice(0, 3).join(" ")} · libass ${meta.ffmpeg.ass ? "✓" : "✗"} · drawtext ${meta.ffmpeg.drawtext ? "✓" : "✗"}` : "不可用：" + meta.ffmpeg.error), h("div", null, "字幕字体"), h("div", null, meta.fontName), h("div", null, "提示词助手"), h("div", null, meta.llm ? "已配置" : "未配置（设置 LLM_API_KEY）"), h("div", null, "分享链接"), h("div", null, meta.fileshare ? "已配置" : "未配置（设置 FILESHARE_TOKEN）"), h("div", null, "GPU 电源"), h("div", null, meta.canControl ? "CompShare 已配置" : "未配置（设置 COMPSHARE_*）"), h("div", null, "提示词规则"), h("div", null, h("a", { href: meta.rulesUrl, target: "_blank" }, meta.rulesUrl))),
      h("h3", { style: "margin-top:14px" }, "参考链接"), h("ul", { class: "small" }, REF_LINKS().map((l) => h("li", null, h("a", { href: l.url, target: "_blank", rel: "noopener" }, l.label), " ", h("span", { class: "muted" }, l.title)))),
      h("h3", { style: "margin-top:14px" }, "H3 硬约束速记"), h("ul", { class: "small muted" }, h("li", null, "宽高必须是 32 的倍数；帧数自动对齐到 17k+5；一次最长约 15 秒，长片分段再拼。"), h("li", null, "参考图走 API 只认点号路径，本站已处理；出片后自动核对节点真正收到的参考键，没全收到会打警告。"), h("li", null, "构图跟着母图走，提示词改不动；换景别只能换对应景别的母图。"), h("li", null, "换脸：脸+头发（+眼镜）都必须来自参考图；只换脸保留原发型必失败。"), h("li", null, "多会话共用一条隧道，上传大视频时状态探测会超时，不代表 GPU 出问题。"))))],
  ]));
};

// ================= boot =================
async function boot() {
  try { S.me = await api("/me"); } catch { return; }
  $("#who").textContent = "Passkey：" + S.me.label;
  const side = $(".side"), menuBtn = $("#menu-btn");
  menuBtn.onclick = () => { const open = side.classList.toggle("open"); menuBtn.setAttribute("aria-expanded", String(open)); menuBtn.textContent = open ? "✕" : "☰"; };
  $("#nav").addEventListener("click", () => { side.classList.remove("open"); menuBtn.textContent = "☰"; menuBtn.setAttribute("aria-expanded", "false"); });
  $("#logout").onclick = async (e) => { e.preventDefault(); await fetch("auth/logout", { method: "POST" }); location.href = "login"; };
  S.meta = await api("/meta");
  const [gpu, jobs, projects] = await Promise.all([api("/gpu"), api("/jobs?limit=500"), api("/projects")]);
  S.gpu = gpu; S.projects = projects; for (const j of jobs) S.jobs.set(j.id, j);
  renderChip(); connectEvents(); navigate();
}
boot();
})();
