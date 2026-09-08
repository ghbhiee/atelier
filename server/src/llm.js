// Prompt assistant: turns a Chinese idea into the official MiniMax-H3 prompt format using an
// OpenAI-compatible chat model (DeepSeek by default). The rules come from the live copy at
// https://atelier.example.com/h3.md (the single source of truth shared by every agent), with a
// bundled fallback.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let rulesCache = { text: null, at: 0 };

export async function promptRules(config) {
  if (rulesCache.text && Date.now() - rulesCache.at < 10 * 60_000) return rulesCache.text;
  let text = null;
  try {
    const res = await fetch(config.promptRulesUrl, { signal: AbortSignal.timeout(8000), headers: { accept: "text/plain" } });
    if (res.ok) text = await res.text();
  } catch {}
  if (!text || text.length < 500) text = await fs.readFile(path.join(HERE, "../PROMPT_RULES.md"), "utf8").catch(() => "");
  rulesCache = { text, at: Date.now() };
  return text;
}

const MODE_HINTS = {
  t2v: "无参考图的文生视频：只写三段 integrated_multimodal_description / overall_soundscape / non_diegetic_music（不要 subject_definitions、summary、retention_analysis）。",
  i2v: "首帧驱动（可能还有尾帧）：第一行写 `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.`（有尾帧时按规则写两张图的时间对齐句），然后三段 integrated_multimodal_description / overall_soundscape / non_diegetic_music。",
  ref: "参考模式（角色一致 / 数字人 / 母图）：六段官方格式，顺序固定：subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music。summary 以 [reference generation] 开头。",
  swap: "换脸 / 视频编辑：六段格式，summary 以 [video editing + audio reuse] 开头；<Video 1> 是源片，<Audio 1> fully_copy；被替换者写成 a completely different person，脸+头发（+眼镜）都来自参考图，其余全部来自 <Video 1>；不换的人写 kept exactly as they are。",
  continue: "视频续接：六段格式，summary 以 [video continuation] 开头，<Video 1> 是前一段。",
};

export async function draftPrompt(config, { mode = "ref", idea, seconds = 5, refs = [], dialogueLang = "Chinese", existing = "", deep = false }) {
  if (!config.llm) throw new Error("没有配置 LLM_API_KEY，提示词助手不可用");
  const rules = await promptRules(config);
  const refLines = refs.length ? refs.map((r, i) => `- <${r.kind === "video" ? "Video" : "Picture"} ${r.index}>: ${r.desc || "(用户未描述)"}`).join("\n") : "（本次没有参考图/视频）";
  const system = `你是 MiniMax-H3 视频生成的提示词工程师。下面是必须遵守的规则文档（官方格式 + 实测结论）：\n\n${rules}\n\n输出要求：只输出最终提示词正文，全英文（台词 <d>[语言] …</d> 里保留用户要的语言），不要任何解释、不要 markdown 代码块、不要标题。`;
  const user = `模式：${MODE_HINTS[mode] || MODE_HINTS.ref}\n目标时长：约 ${seconds} 秒（台词宁短勿长，5 秒只放 1–2 句）。\n台词语言：${dialogueLang}。\n参考素材及其编号（严格按此编号引用）：\n${refLines}\n\n用户的想法：\n${idea}\n${existing ? `\n用户已有的草稿（在此基础上改写成规范格式，保留意图）：\n${existing}` : ""}`;
  // DeepSeek v4 "thinks" before answering. Default: thinking off (≈8 s). deep=true lets it reason
  // (≈2 min, more careful); if it burns the whole budget on reasoning we fall back to thinking off.
  const call = async (thinking) => {
    const body = { model: config.llm.model, temperature: 0.6, max_tokens: thinking ? 12000 : 4000, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
    if (!thinking && /deepseek/i.test(config.llm.baseUrl)) body.thinking = { type: "disabled" };
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.llm.apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`LLM ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return (j.choices?.[0]?.message?.content || "").trim();
  };
  let text = await call(!!deep);
  if (!text && deep) text = await call(false);
  if (!text) throw new Error("LLM 没有返回内容");
  return text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
}

/**
 * Rewrite an existing prompt against a new requirement. Different job from draftPrompt: there is
 * already a prompt on the table — typed by hand or pulled out of the library — and the user wants it
 * changed, not replaced. Everything the change does not touch has to survive verbatim, because a
 * working H3 prompt is mostly load-bearing detail that took takes to get right.
 */
export async function rewritePrompt(config, { current, want, mode = "ref", seconds = 5, dialogueLang = "Chinese", deep = false }) {
  if (!config.llm) throw new Error("没有配置提示词助手的 API Key，去「设置 · 提示词助手」填一个");
  if (!String(current || "").trim()) throw new Error("没有可改写的内容");
  if (!String(want || "").trim()) throw new Error("说一下要改成什么");
  const rules = await promptRules(config);
  const system = `你是 MiniMax-H3 视频生成的提示词工程师。下面是必须遵守的规则文档（官方格式 + 实测结论）：\n\n${rules}\n\n` +
    `这次的任务是**改写**，不是重写：用户给了一段已有的提示词和一条修改要求。\n` +
    `- 只改用户要求改的部分，其余段落、措辞、参考图编号、时间对齐句一字不动地保留；\n` +
    `- 段落结构必须仍然合规（该几段就几段，顺序不变）；\n` +
    `- 如果修改要求与规则冲突，以规则为准，并在正文之外什么都不要说。\n` +
    `输出要求：只输出改写后的完整提示词正文，全英文（台词 <d>[语言] …</d> 里保留用户要的语言），不要解释、不要 markdown 代码块。`;
  const user = `模式：${MODE_HINTS[mode] || MODE_HINTS.ref}\n目标时长：约 ${seconds} 秒。台词语言：${dialogueLang}。\n\n` +
    `【现有提示词】\n${current}\n\n【修改要求】\n${want}`;
  const call = async (thinking) => {
    const body = { model: config.llm.model, temperature: 0.4, max_tokens: thinking ? 12000 : 4000, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
    if (!thinking && /deepseek/i.test(config.llm.baseUrl)) body.thinking = { type: "disabled" };
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.llm.apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`LLM ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return (j.choices?.[0]?.message?.content || "").trim();
  };
  let text = await call(!!deep);
  if (!text && deep) text = await call(false);
  if (!text) throw new Error("LLM 没有返回内容");
  return text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
}
