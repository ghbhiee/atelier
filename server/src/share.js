// Login-free share links via the fileshare backend that runs on the same server (127.0.0.1:8787).
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export async function shareFile(config, file, { name, permanent = false } = {}) {
  if (!config.fileshare) throw new Error("没有配置 FILESHARE_TOKEN，无法生成分享链接");
  const qs = new URLSearchParams({ name: name || path.basename(file) });
  if (permanent) qs.set("ttl", "permanent");
  const size = fs.statSync(file).size;
  const res = await fetch(`${config.fileshare.url}/upload?${qs}`, { method: "PUT", headers: { "X-Token": config.fileshare.token, "Content-Length": String(size) }, body: Readable.toWeb(fs.createReadStream(file)), duplex: "half", signal: AbortSignal.timeout(1_800_000) });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`fileshare 返回异常：${res.status} ${text.slice(0, 200)}`); }
  if (!res.ok || !j.ok) throw new Error(`fileshare 失败：${j.error || res.status}`);
  return { url: j.url, expires: j.expires || null, permanent: !!j.permanent, size };
}
