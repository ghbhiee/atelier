// A software WebAuthn authenticator for tests: produces registration (attestation "none") and
// assertion responses that @simplewebauthn/server accepts, with no browser involved.
import crypto from "node:crypto";

export function cborEncode(value) {
  const chunks = [];
  const head = (major, length) => {
    if (length < 24) chunks.push(Buffer.from([(major << 5) | length]));
    else if (length < 0x100) chunks.push(Buffer.from([(major << 5) | 24, length]));
    else if (length < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(length, 1); chunks.push(b); }
    else { const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(length, 1); chunks.push(b); }
  };
  const encode = (v) => {
    if (typeof v === "number") { if (!Number.isInteger(v)) throw new Error("floats unsupported"); v >= 0 ? head(0, v) : head(1, -1 - v); }
    else if (Buffer.isBuffer(v) || v instanceof Uint8Array) { head(2, v.length); chunks.push(Buffer.from(v)); }
    else if (typeof v === "string") { const b = Buffer.from(v, "utf8"); head(3, b.length); chunks.push(b); }
    else if (Array.isArray(v)) { head(4, v.length); v.forEach(encode); }
    else if (v instanceof Map) { head(5, v.size); for (const [k, val] of v) { encode(k); encode(val); } }
    else if (v && typeof v === "object") { const keys = Object.keys(v); head(5, keys.length); for (const k of keys) { encode(k); encode(v[k]); } }
    else throw new Error(`unsupported CBOR value: ${v}`);
  };
  encode(value);
  return Buffer.concat(chunks);
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");

export class SoftAuthenticator {
  constructor(origin) {
    this.origin = origin;
    this.credentials = new Map();
  }

  /** navigator.credentials.create() */
  create(options) {
    const { publicKey: key, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = key.export({ format: "jwk" });
    const credentialId = crypto.randomBytes(32);
    const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]);
    const rpIdHash = crypto.createHash("sha256").update(options.rp.id).digest();
    const counter = Buffer.alloc(4);
    const idLength = Buffer.alloc(2); idLength.writeUInt16BE(credentialId.length);
    const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), counter, Buffer.alloc(16), idLength, credentialId, cborEncode(cose)]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const attestationObject = cborEncode({ fmt: "none", attStmt: {}, authData });
    const id = b64u(credentialId);
    this.credentials.set(id, { privateKey, counter: 0, rpId: options.rp.id, userHandle: options.user.id });
    return { id, rawId: id, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestationObject), transports: ["internal"] } };
  }

  /** navigator.credentials.get() */
  get(options, credentialId = [...this.credentials.keys()].at(-1), { ignoreAllowList = false } = {}) {
    const credential = this.credentials.get(credentialId);
    if (!credential) throw new Error("unknown credential");
    if (!ignoreAllowList && options.allowCredentials?.length && !options.allowCredentials.some((c) => c.id === credentialId)) throw new Error("credential not allowed by options");
    credential.counter += 1;
    const rpIdHash = crypto.createHash("sha256").update(options.rpId || credential.rpId).digest();
    const counter = Buffer.alloc(4); counter.writeUInt32BE(credential.counter);
    const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), counter]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const signature = crypto.sign("sha256", Buffer.concat([authData, crypto.createHash("sha256").update(clientData).digest()]), credential.privateKey);
    return { id: credentialId, rawId: credentialId, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: credential.userHandle } };
  }
}
