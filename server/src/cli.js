#!/usr/bin/env node
// Operator CLI (runs on the server as root or the service user; shares state.json with the service).
//   atelier status
//   atelier auth pending | approve <CODE> | reject <CODE> | list | revoke <label|id-prefix>
//   atelier audit [n]
import fs from "node:fs";
import { loadConfig } from "./config.js";

// Load the service environment file (KEY=value lines) so the CLI sees the same config as the daemon.
const ENV_FILE = process.env.ATELIER_ENV || "/etc/atelier/env";
try {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
} catch {}
import { Store } from "./store.js";
import { Passkeys } from "./passkeys.js";

const HELP = `atelier — Atelier (GPU workbench) operator CLI

  status                        Service facts + passkey counts
  auth pending                  Passkeys waiting for approval
  auth approve <CODE>           Approve a pending passkey (code shown in the browser)
  auth reject <CODE>            Reject a pending passkey
  auth list                     Approved passkeys
  auth revoke <label|idprefix>  Remove a passkey and its sessions
  audit [n]                     Last n audit lines (default 30)
  keys list | create <label> [--json] | revoke <id|label>   API keys for agents/scripts (key shown once)
  prompts status                OpenPrompt mirror: counts + sync progress (asks the running daemon)
  prompts sync [--retag] [--reembed] [--limit N]   Start a sync in the daemon
`;
const when = (s) => (s ? new Date(s * 1000).toLocaleString("zh-CN", { hour12: false }) : "-");
const table = (rows, cols) => {
  if (!rows.length) return console.log("(none)");
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  console.log(cols.map((c, i) => c.padEnd(w[i])).join("  "));
  for (const r of rows) console.log(cols.map((c, i) => String(r[c] ?? "").padEnd(w[i])).join("  "));
};

async function main(argv) {
  const [cmd, action, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") return console.log(HELP);
  const config = loadConfig();
  const store = new Store(config.dataDir, config.tokenPepper);
  await store.init();
  const passkeys = new Passkeys(config, store);
  if (cmd === "status") {
    const s = await store.read();
    const now = Math.floor(Date.now() / 1000);
    console.log(`Atelier ${config.version}\nOrigin:    ${config.publicOrigin}\nData:      ${config.dataDir}\nComfyUI:   ${config.comfyUrl}\nCompShare: ${config.compshare ? config.compshare.instanceId + " (" + config.compshare.region + ")" : "not configured"}\nFileshare: ${config.fileshare ? "configured" : "not configured"}\nLLM:       ${config.llm ? config.llm.model : "not configured"}\nPasskeys:  ${Object.keys(s.passkeys).length} approved, ${Object.values(s.enrollments).filter((e) => e.status === "pending" && e.expiresAt >= now).length} pending, ${Object.keys(s.sessions).length} sessions\nGPU:       last state ${s.power.lastState || "?"} at ${when(s.power.lastChange)}`);
    return;
  }
  if (cmd === "auth") {
    if (action === "pending") return table((await passkeys.listPending()).map((e) => ({ code: e.code, label: e.label, requested: when(e.createdAt), expires: when(e.expiresAt), ip: e.requestedIp, device: `${e.deviceType || "?"}${e.backedUp ? " (synced)" : ""}`, agent: (e.requestedUserAgent || "").slice(0, 40) })), ["code", "label", "requested", "expires", "ip", "device", "agent"]);
    if (action === "approve" || action === "reject") {
      if (!rest[0]) throw new Error(`usage: atelier auth ${action} <CODE>`);
      const r = await passkeys.review(rest[0], action);
      return console.log(`${r.status === "approved" ? "Approved" : "Rejected"} passkey "${r.label}" (${r.code}).${r.status === "approved" ? " The browser page continues automatically." : ""}`);
    }
    if (action === "list") return table((await passkeys.list()).map((p) => ({ id: p.id.slice(0, 16) + "…", label: p.label, approved: when(p.approvedAt), lastUsed: when(p.lastUsedAt), device: `${p.deviceType || "?"}${p.backedUp ? " (synced)" : ""}` })), ["id", "label", "approved", "lastUsed", "device"]);
    if (action === "revoke") { if (!rest[0]) throw new Error("usage: atelier auth revoke <label|idprefix>"); const r = await passkeys.revoke(rest[0]); return console.log(`Revoked "${r.label}" and ${r.revokedSessions} session(s).`); }
    throw new Error("auth: pending | approve | reject | list | revoke");
  }
  if (cmd === "keys") {
    if (action === "list") return table((await passkeys.listApiKeys()).map((k) => ({ id: k.id, label: k.label, prefix: k.prefix + "…", created: when(k.createdAt), lastUsed: when(k.lastUsedAt), by: k.createdBy })), ["id", "label", "prefix", "created", "lastUsed", "by"]);
    if (action === "create") { if (!rest[0]) throw new Error("usage: atelier keys create <label>"); const r = await passkeys.createApiKey({ label: rest[0], by: "cli" }); if (rest.includes("--json")) return console.log(JSON.stringify(r)); return console.log(`API key for "${r.label}" (shown once):\n\n  ${r.key}\n\nUse: Authorization: Bearer ${r.key}`); }
    if (action === "revoke") { if (!rest[0]) throw new Error("usage: atelier keys revoke <id|label>"); const r = await passkeys.revokeApiKey(rest[0]); return console.log(`Revoked API key "${r.label}" (${r.id}).`); }
    throw new Error("keys: list | create | revoke");
  }
  if (cmd === "prompts") {
    const crypto = await import("node:crypto");
    const base = `http://127.0.0.1:${config.port}${config.basePath}`;
    if (action === "status") { const r = await fetch(`${base}/internal/prompts/status`); return console.log(JSON.stringify(await r.json(), null, 2)); }
    if (action === "sync") { const body = { retag: rest.includes("--retag"), reembed: rest.includes("--reembed"), limit: Number(rest[rest.indexOf("--limit") + 1]) || 0 }; const r = await fetch(`${base}/internal/prompts/sync`, { method: "POST", headers: { "content-type": "application/json", "x-internal": crypto.createHash("sha256").update(config.tokenPepper).digest("hex") }, body: JSON.stringify(body) }); return console.log(JSON.stringify(await r.json(), null, 2)); }
    throw new Error("prompts: status | sync");
  }
  if (cmd === "audit") { const s = await store.read(); for (const a of s.audit.slice(-(Number(action) || 30))) console.log(JSON.stringify(a)); return; }
  console.log(HELP);
  process.exitCode = 2;
}
main(process.argv.slice(2)).catch((e) => { console.error("error:", e.message); process.exit(1); });
