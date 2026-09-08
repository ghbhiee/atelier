// CompShare (UCloud) OpenAPI client — zero-dependency Node.js port of the
// signing/encoding scheme used by the official `ucloud-sdk-python3` SDK.
//
// Wire format (see ucloud/core/client/_client.py in the Python SDK):
//   POST <baseUrl>  Content-Type: application/x-www-form-urlencoded
//   headers: U-Timestamp-Ms (ms since epoch), User-Agent
//   body:    flattened params + PublicKey + Action + Signature
// Response is JSON with RetCode (0 = ok) and Message.

import { createHash } from "node:crypto";

/**
 * Encode a scalar the way the SDK does (ucloud/core/typesystem/encoder.py):
 * booleans as lowercase "true"/"false"; numbers with no fractional part as
 * integers (the API gateway decodes floats as ints); everything else String().
 */
function encodeValue(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  // JS has no int/float split: String(2.0) is already "2", String(1.5) is "1.5",
  // which is exactly the SDK's "float with no fraction -> int" rule.
  return String(v);
}

/**
 * Flatten nested params into the flat key/value form the API expects:
 *   { UHostIds: ["a", "b"] }           -> { "UHostIds.0": "a", "UHostIds.1": "b" }
 *   { Disk: { Size: 1 } }              -> { "Disk.Size": "1" }
 *   { Disks: [{ Size: 1 }] }           -> { "Disks.0.Size": "1" }
 * Keys with null/undefined values are dropped (the SDK strips None before
 * encoding). All leaf values become strings.
 */
export function flattenParams(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === null || v === undefined) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object") flattenParams(item, `${key}.${i}`, out);
        else out[`${key}.${i}`] = encodeValue(item);
      });
    } else if (typeof v === "object") {
      flattenParams(v, key, out);
    } else {
      out[key] = encodeValue(v);
    }
  }
  return out;
}

/**
 * Compute the UCloud "verify_ac" signature: sort params by key (byte order),
 * concatenate key+value for each, append the private key, SHA-1 hex digest.
 * Values are the raw encoded strings — NOT url-encoded. `params` must already
 * be flat (see flattenParams) and must already contain PublicKey.
 *
 * Doctest from the SDK: signParams({ foo: "bar" }, "my_private_key")
 *   === "634edc1bb957c0d65e5ab5494cf3b7784fbc87af"
 */
export function signParams(params, privateKey) {
  // Byte-order sort: compare as raw code units, not locale-aware.
  const keys = Object.keys(params).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let simplified = "";
  for (const k of keys) simplified += k + encodeValue(params[k]);
  simplified += privateKey;
  return createHash("sha1").update(simplified, "utf8").digest("hex");
}

/** Error thrown for HTTP failures and non-zero RetCode responses. */
export class CompShareError extends Error {
  constructor(message, { action, retCode, status, body } = {}) {
    super(message);
    this.name = "CompShareError";
    this.action = action;
    this.retCode = retCode;
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CompShare {
  constructor({
    publicKey,
    privateKey,
    baseUrl = "https://api.compshare.cn",
    fetchImpl = fetch,
    timeoutMs = 20000,
    userAgent = "h3studio/0.1 (node)",
  }) {
    if (!publicKey || !privateKey) throw new Error("CompShare: publicKey and privateKey are required");
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
  }

  /**
   * Signed POST of `action` with `params`. Returns the parsed JSON body.
   * Throws CompShareError on HTTP >= 400, unparsable body, or RetCode != 0.
   */
  async invoke(action, params = {}) {
    const flat = flattenParams({ ...params, Action: action, PublicKey: this.publicKey });
    flat.Signature = signParams(flat, this.privateKey);
    const body = new URLSearchParams(flat).toString();

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "U-Timestamp-Ms": String(Date.now()),
          "User-Agent": this.userAgent,
        },
        body,
        signal: ac.signal,
      });
    } catch (err) {
      const msg = err?.name === "AbortError" ? `timeout after ${this.timeoutMs}ms` : err?.message ?? String(err);
      throw new CompShareError(`${action}: request failed (${msg})`, { action });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new CompShareError(`${action}: HTTP ${res.status}`, { action, status: res.status, body: text });
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new CompShareError(`${action}: invalid JSON response`, { action, status: res.status, body: text });
    }
    const retCode = Number(data?.RetCode ?? -1);
    if (retCode !== 0) {
      const message = data?.Message ?? "";
      throw new CompShareError(`${action}: RetCode ${retCode} ${message}`.trim(), {
        action, retCode, message, status: res.status, body: text,
      });
    }
    return data;
  }

  /** Full UHostSet entry for `instanceId`, or null if the API returns no match. */
  async describe(instanceId, { region }) {
    const data = await this.invoke("DescribeCompShareInstance", {
      Region: region,
      UHostIds: [instanceId],
      Limit: 1,
      Offset: 0,
    });
    const hosts = Array.isArray(data.UHostSet) ? data.UHostSet : [];
    return hosts.find((h) => h?.UHostId === instanceId) ?? null;
  }

  /** Just the State string ("Running" | "Stopped" | "Starting" | ...), or "NotFound". */
  async state(instanceId, { region }) {
    const host = await this.describe(instanceId, { region });
    return host?.State ?? "NotFound";
  }

  /** Power on. `withoutGpuSpec` selects CompShare's cheaper no-GPU boot mode. */
  async start(instanceId, { region, zone, withoutGpuSpec } = {}) {
    return this.invoke("StartCompShareInstance", {
      Region: region, Zone: zone, UHostId: instanceId, WithoutGpuSpec: withoutGpuSpec,
    });
  }

  /** Power off (billing for the GPU stops once State becomes "Stopped"). */
  async stop(instanceId, { region, zone } = {}) {
    return this.invoke("StopCompShareInstance", { Region: region, Zone: zone, UHostId: instanceId });
  }

  /**
   * Poll describe() until State is one of `states`. Resolves with the final
   * state; rejects with an Error (carrying `.lastState`) on timeout.
   */
  async waitFor(instanceId, { region, states = ["Running"], timeoutMs = 600000, intervalMs = 10000 }) {
    const deadline = Date.now() + timeoutMs;
    let last = "Unknown";
    for (;;) {
      last = await this.state(instanceId, { region });
      if (states.includes(last)) return last;
      if (Date.now() + intervalMs > deadline) break;
      await sleep(intervalMs);
    }
    const err = new Error(`waitFor(${instanceId}): timed out after ${timeoutMs}ms, last State=${last}`);
    err.lastState = last;
    throw err;
  }
}
