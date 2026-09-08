// Single JSON document with atomic writes and a lock file, shared between the service and the
// CLI (which approves passkeys from a different process). Borrowed from webdeploy.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const INITIAL_STATE = {
  passkeys: {}, enrollments: {}, challenges: {}, sessions: {}, apiKeys: {},
  settings: { hourlyRate: null, idleMinutes: null, autoOff: true, autoOn: true },
  power: { periods: [], lastState: null, lastChange: null },
  audit: [],
  voiceCache: null,   // last engine list / saved voices seen on the box, so the voice page works while it is off
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 15_000;

export class Store {
  constructor(dataDir, pepper) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "state.json");
    this.lockFile = path.join(dataDir, "state.lock");
    this.pepper = pepper;
    this.queue = Promise.resolve();
  }
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try { await fs.access(this.file); } catch { await this.#write(structuredClone(INITIAL_STATE)); }
    await this.update(() => {});
  }
  hash(value) { return crypto.createHmac("sha256", this.pepper).update(String(value)).digest("hex"); }
  random(bytes = 32) { return crypto.randomBytes(bytes).toString("base64url"); }
  async read() {
    const state = JSON.parse(await fs.readFile(this.file, "utf8"));
    for (const key of Object.keys(INITIAL_STATE)) if (state[key] === undefined) state[key] = structuredClone(INITIAL_STATE[key]);
    return state;
  }
  async update(mutator) {
    const task = this.queue.then(async () => {
      await this.#lock();
      try {
        const state = await this.read();
        const result = await mutator(state);
        prune(state);
        await this.#write(state);
        return result;
      } finally { await fs.rm(this.lockFile, { force: true }); }
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async #lock() {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await fs.open(this.lockFile, "wx", 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const stat = await fs.stat(this.lockFile).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) { await fs.rm(this.lockFile, { force: true }); continue; }
        if (Date.now() > deadline) throw new Error("State file is locked by another process");
        await sleep(50 + Math.random() * 100);
      }
    }
  }
  async #write(state) {
    const temp = `${this.file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, this.file);
  }
}

export function prune(state, now = Math.floor(Date.now() / 1000)) {
  for (const [id, r] of Object.entries(state.challenges)) if (r.expiresAt < now) delete state.challenges[id];
  for (const [id, r] of Object.entries(state.sessions)) if (r.expiresAt < now) delete state.sessions[id];
  for (const [id, r] of Object.entries(state.enrollments)) {
    if (r.expiresAt < now && r.status !== "approved") delete state.enrollments[id];
    else if (r.status === "approved" && r.approvedAt && r.approvedAt < now - 7 * 86400) delete state.enrollments[id];
  }
  if (state.audit.length > 2000) state.audit.splice(0, state.audit.length - 2000);
  if (state.power.periods.length > 5000) state.power.periods.splice(0, state.power.periods.length - 5000);
}
