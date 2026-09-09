#!/usr/bin/env node
// Manual probe for server/src/compshare.js.
//
// READ-ONLY: this script only calls describe()/state(). It must NEVER call
// start(), stop(), reboot, or any other mutating action. It also never prints
// the API keys, IPs, passwords, or software URLs.
//
// Usage: node test/compshare-probe.mjs [instanceId] [region]

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { CompShare, signParams } from "../server/src/compshare.js";

const INSTANCE = process.argv[2] ?? "uhost-xxxx";
const REGION = process.argv[3] ?? "cn-wlcb";

// 1. Signature self-check against the doctest in the official Python SDK
//    (ucloud/core/auth/_cfg.py :: verify_ac).
assert.equal(
  signParams({ foo: "bar" }, "my_private_key"),
  "634edc1bb957c0d65e5ab5494cf3b7784fbc87af",
  "signParams does not match the SDK doctest",
);
console.log("signature self-check: ok");

// 2. Load credentials from the CLI's config file (never echoed anywhere).
const cfgPath = join(homedir(), ".config", "compshare", "config.json");
const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
const profile = cfg.profiles?.[cfg.current_profile ?? "default"];
if (!profile?.public_key || !profile?.private_key) {
  console.error(`no usable profile in ${cfgPath}`);
  process.exit(78);
}

const cs = new CompShare({ publicKey: profile.public_key, privateKey: profile.private_key });

// 3. Read-only calls.
const host = await cs.describe(INSTANCE, { region: REGION });
if (!host) {
  console.error(`describe: ${INSTANCE} not found in region ${REGION}`);
  process.exit(1);
}
const pick = (k) => host[k];
console.log("describe:", {
  UHostId: pick("UHostId"),
  Name: pick("Name"),
  State: pick("State"),
  Region: pick("Region"),
  Zone: pick("Zone"),
  GpuType: pick("GpuType"),
  ChargeType: pick("ChargeType"),
});

const state = await cs.state(INSTANCE, { region: REGION });
console.log("state:", state);

if (!["Running", "Stopped"].includes(state)) {
  console.warn(`note: State is "${state}" (transitional or unexpected)`);
}
