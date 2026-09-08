// Passkey enrollment, approval and sign-in (WebAuthn via @simplewebauthn/server), plus cookie
// sessions. Every new passkey — including the first — is pending until an operator approves its
// code on the server:   atelier auth approve ABCD-EFGH
import crypto from "node:crypto";
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";

const now = () => Math.floor(Date.now() / 1000);
// API keys are looked up by HMAC, but a copy is kept encrypted (AES-256-GCM under a pepper-derived key)
// so the owner can show it again in the 接入 page; the pepper lives in the env file, not in state.json.
const encKey = (pepper) => crypto.createHash("sha256").update("apikey-enc:" + pepper).digest();
function encrypt(pepper, text) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", encKey(pepper), iv); const ct = Buffer.concat([c.update(text, "utf8"), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url"); }
function decrypt(pepper, blob) { const b = Buffer.from(blob, "base64url"); const d = crypto.createDecipheriv("aes-256-gcm", encKey(pepper), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"); }
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const CHALLENGE_TTL = 600;
const b64u = (bytes) => Buffer.from(bytes).toString("base64url");

function approvalCode() {
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
export function normalizeCode(code) {
  const clean = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length !== 8) throw new Error("Approval codes look like ABCD-EFGH");
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}
export function assertLabel(label) {
  const clean = String(label || "").trim();
  if (!clean || clean.length > 64) throw new Error("Passkey name must be 1–64 characters");
  return clean;
}
const publicPasskey = (r) => ({ id: r.id, label: r.label, createdAt: r.createdAt, approvedAt: r.approvedAt, lastUsedAt: r.lastUsedAt || null, deviceType: r.deviceType, backedUp: r.backedUp, requestedIp: r.requestedIp || null });

export class Passkeys {
  constructor(config, store) { this.config = config; this.store = store; }

  async beginRegistration({ label, ip, userAgent }) {
    const cleanLabel = assertLabel(label);
    const state = await this.store.read();
    const userId = crypto.randomBytes(32);
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName, rpID: this.config.rpId, userName: cleanLabel, userDisplayName: cleanLabel, userID: userId,
      timeout: 120_000, attestationType: "none",
      excludeCredentials: Object.values(state.passkeys).map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    const enrollmentId = this.store.random(16);
    await this.store.update((s) => {
      s.enrollments[enrollmentId] = { id: enrollmentId, status: "challenge", label: cleanLabel, challenge: options.challenge, userHandle: b64u(userId), createdAt: now(), expiresAt: now() + CHALLENGE_TTL, requestedIp: ip || null, requestedUserAgent: String(userAgent || "").slice(0, 200) || null };
    });
    return { enrollmentId, options };
  }

  async finishRegistration({ enrollmentId, response }) {
    const state = await this.store.read();
    const enrollment = state.enrollments[String(enrollmentId)];
    if (!enrollment || enrollment.status !== "challenge" || enrollment.expiresAt < now()) throw new Error("Registration challenge is invalid or expired");
    const verification = await verifyRegistrationResponse({ response, expectedChallenge: enrollment.challenge, expectedOrigin: this.config.publicOrigin, expectedRPID: this.config.rpId, requireUserVerification: false });
    if (!verification.verified) throw new Error("Passkey registration could not be verified");
    const info = verification.registrationInfo;
    const code = approvalCode();
    await this.store.update((s) => {
      const record = s.enrollments[enrollmentId];
      if (!record || record.status !== "challenge") throw new Error("Registration challenge was already used");
      if (s.passkeys[info.credential.id]) throw new Error("This passkey is already registered");
      delete record.challenge;
      Object.assign(record, {
        status: "pending", code, expiresAt: now() + this.config.enrollmentTtl,
        credential: { id: info.credential.id, publicKey: b64u(info.credential.publicKey), counter: info.credential.counter, transports: info.credential.transports || [] },
        deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, aaguid: info.aaguid,
      });
      s.audit.push({ at: new Date().toISOString(), action: "passkey.enrollment.requested", label: record.label, code });
    });
    return { enrollmentId, code, status: "pending", approvalCommand: `atelier auth approve ${code}` };
  }

  async enrollmentStatus(enrollmentId) {
    const state = await this.store.read();
    const e = state.enrollments[String(enrollmentId)];
    if (!e) return { status: "unknown" };
    if (e.status === "pending" && e.expiresAt < now()) return { status: "expired" };
    return { status: e.status, code: e.code || null, passkeyId: e.credential?.id || null };
  }

  async listPending() {
    const state = await this.store.read();
    return Object.values(state.enrollments).filter((e) => e.status === "pending" && e.expiresAt >= now())
      .map((e) => ({ code: e.code, label: e.label, createdAt: e.createdAt, expiresAt: e.expiresAt, requestedIp: e.requestedIp, requestedUserAgent: e.requestedUserAgent, deviceType: e.deviceType, backedUp: e.backedUp }));
  }

  async review(code, decision, reviewer = "cli") {
    const clean = normalizeCode(code);
    return this.store.update((s) => {
      const e = Object.values(s.enrollments).find((x) => x.code === clean && x.status === "pending");
      if (!e) throw new Error(`No pending enrollment with code ${clean}`);
      if (e.expiresAt < now()) { e.status = "expired"; throw new Error(`Enrollment ${clean} has expired; register again`); }
      if (decision === "approve") {
        if (s.passkeys[e.credential.id]) throw new Error("This passkey is already active");
        s.passkeys[e.credential.id] = { ...e.credential, label: e.label, userHandle: e.userHandle, createdAt: e.createdAt, approvedAt: now(), approvedBy: reviewer, lastUsedAt: null, deviceType: e.deviceType, backedUp: e.backedUp, aaguid: e.aaguid, requestedIp: e.requestedIp };
        e.status = "approved"; e.approvedAt = now();
      } else { e.status = "rejected"; e.reviewedAt = now(); }
      s.audit.push({ at: new Date().toISOString(), action: `passkey.enrollment.${decision === "approve" ? "approved" : "rejected"}`, label: e.label, code: clean, reviewer });
      return { code: clean, label: e.label, status: e.status, passkeyId: e.credential.id };
    });
  }

  async list() {
    const state = await this.store.read();
    return Object.values(state.passkeys).map(publicPasskey).sort((a, b) => a.createdAt - b.createdAt);
  }

  async revoke(selector) {
    return this.store.update((s) => {
      const matches = Object.values(s.passkeys).filter((p) => p.id === selector || p.id.startsWith(selector) || p.label === selector);
      if (matches.length === 0) throw new Error(`No passkey matches ${selector}`);
      if (matches.length > 1) throw new Error(`${matches.length} passkeys match ${selector}; use a longer id prefix`);
      const passkey = matches[0];
      delete s.passkeys[passkey.id];
      let sessions = 0;
      for (const [id, sess] of Object.entries(s.sessions)) if (sess.passkeyId === passkey.id) { delete s.sessions[id]; sessions++; }
      s.audit.push({ at: new Date().toISOString(), action: "passkey.revoked", label: passkey.label, passkeyId: passkey.id, sessions });
      return { ...publicPasskey(passkey), revokedSessions: sessions };
    });
  }

  async beginAuthentication() {
    const state = await this.store.read();
    const passkeys = Object.values(state.passkeys);
    const options = await generateAuthenticationOptions({ rpID: this.config.rpId, timeout: 120_000, userVerification: "preferred", allowCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports })) });
    const challengeId = this.store.random(16);
    await this.store.update((s) => { s.challenges[challengeId] = { challenge: options.challenge, purpose: "authentication", expiresAt: now() + CHALLENGE_TTL }; });
    return { challengeId, options, registeredPasskeys: passkeys.length };
  }

  async finishAuthentication({ challengeId, response }) {
    const state = await this.store.read();
    const challenge = state.challenges[String(challengeId)];
    if (!challenge || challenge.purpose !== "authentication" || challenge.expiresAt < now()) throw new Error("Authentication challenge is invalid or expired");
    const passkey = state.passkeys[String(response?.id || "")];
    if (!passkey) throw new Error("This passkey is not approved on this server");
    const verification = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: this.config.publicOrigin, expectedRPID: this.config.rpId, credential: { id: passkey.id, publicKey: Buffer.from(passkey.publicKey, "base64url"), counter: passkey.counter, transports: passkey.transports }, requireUserVerification: false });
    if (!verification.verified) throw new Error("Passkey authentication could not be verified");
    await this.store.update((s) => {
      if (!s.challenges[challengeId]) throw new Error("Authentication challenge was already used");
      delete s.challenges[challengeId];
      const record = s.passkeys[passkey.id];
      if (!record) throw new Error("This passkey was revoked");
      record.counter = verification.authenticationInfo.newCounter;
      record.lastUsedAt = now();
    });
    return publicPasskey(passkey);
  }

  // ---- API keys (Bearer atl_… / legacy h3s_…; only the HMAC is stored; equivalent to a session) ----
  async createApiKey({ label, by = "web" }) {
    const clean = assertLabel(label);
    const token = "atl_" + this.store.random(30);
    const id = "k_" + this.store.random(6);
    await this.store.update((s) => {
      s.apiKeys[this.store.hash(token)] = { id, label: clean, createdAt: now(), lastUsedAt: null, createdBy: by, prefix: token.slice(0, 10), enc: encrypt(this.store.pepper, token) };
      s.audit.push({ at: new Date().toISOString(), action: "apikey.created", label: clean, id, by });
    });
    return { id, label: clean, key: token, prefix: token.slice(0, 10), revealable: true };
  }
  async listApiKeys() { const s = await this.store.read(); return Object.values(s.apiKeys).sort((a, b) => a.createdAt - b.createdAt).map(({ enc, ...k }) => ({ ...k, revealable: !!enc })); }
  /** Full key for keys created after 2026-09-07 (older ones only have their HMAC). */
  async revealApiKey(id) {
    const s = await this.store.read();
    const k = Object.values(s.apiKeys).find((x) => x.id === id || x.label === id);
    if (!k) throw Object.assign(new Error(`No API key matches ${id}`), { status: 404 });
    if (!k.enc) throw Object.assign(new Error("这把密钥创建时没有保存明文，无法再显示；请新建一把"), { status: 409 });
    await this.store.update((st) => { st.audit.push({ at: new Date().toISOString(), action: "apikey.revealed", label: k.label, id: k.id }); });
    return { id: k.id, label: k.label, key: decrypt(this.store.pepper, k.enc) };
  }
  async revokeApiKey(selector) {
    return this.store.update((s) => {
      const entry = Object.entries(s.apiKeys).find(([, k]) => k.id === selector || k.label === selector || k.prefix === selector);
      if (!entry) throw Object.assign(new Error(`No API key matches ${selector}`), { status: 404 });
      delete s.apiKeys[entry[0]];
      s.audit.push({ at: new Date().toISOString(), action: "apikey.revoked", label: entry[1].label, id: entry[1].id });
      return { id: entry[1].id, label: entry[1].label };
    });
  }
  async resolveApiKey(token) {
    if (!token || !(token.startsWith("atl_") || token.startsWith("h3s_"))) return null;
    const state = await this.store.read();
    const k = state.apiKeys[this.store.hash(token)];
    if (!k) return null;
    if (!k.lastUsedAt || now() - k.lastUsedAt > 60) this.store.update((s) => { const r = s.apiKeys[this.store.hash(token)]; if (r) r.lastUsedAt = now(); }).catch(() => {});
    return { label: k.label, passkeyId: null, apiKeyId: k.id, kind: "apikey", createdAt: k.createdAt };
  }

  // ---- Sessions (cookie = random token; only its HMAC is stored) ----
  async createSession(passkey, { ip, userAgent }) {
    const token = this.store.random(32);
    await this.store.update((s) => {
      s.sessions[this.store.hash(token)] = { passkeyId: passkey.id, label: passkey.label, createdAt: now(), expiresAt: now() + this.config.sessionTtl, ip: ip || null, userAgent: String(userAgent || "").slice(0, 200) };
      s.audit.push({ at: new Date().toISOString(), action: "session.created", label: passkey.label, ip: ip || null });
    });
    return token;
  }
  async resolveSession(token) {
    if (!token) return null;
    const state = await this.store.read();
    const sess = state.sessions[this.store.hash(token)];
    if (!sess || sess.expiresAt < now()) return null;
    if (!state.passkeys[sess.passkeyId]) return null;
    return sess;
  }
  async destroySession(token) {
    if (!token) return;
    await this.store.update((s) => { delete s.sessions[this.store.hash(token)]; });
  }
}
