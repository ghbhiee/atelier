// Runtime configuration for Atelier (formerly h3studio). Everything comes from the environment (an EnvironmentFile
// under systemd, or the shell when developing). Only PUBLIC_ORIGIN is mandatory.
import path from "node:path";
import os from "node:os";

function int(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number`);
  return v;
}

export function loadConfig(env = process.env) {
  const publicOrigin = (env.PUBLIC_ORIGIN || "").replace(/\/$/, "");
  if (!publicOrigin) throw new Error("PUBLIC_ORIGIN is required (e.g. https://atelier.example.com:8444)");
  const url = new URL(publicOrigin);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("PUBLIC_ORIGIN must be https:// (WebAuthn needs a secure context)");
  const dataDir = path.resolve(env.DATA_DIR || "./data");
  const pepper = env.TOKEN_PEPPER || "";
  if (pepper.length < 16) throw new Error("TOKEN_PEPPER must be at least 16 characters");
  // Which box the workbench is talking to right now. Everything below that used to name one machine
  // (comfyUrl, the two upstream ports, the CompShare instance, the asset port/host) reads through this,
  // so switching boxes is one assignment rather than a restart with a different environment.
  const fleet = { active: null, boxes: null };
  const cfg = {
    publicOrigin,
    // Mount everything under this path (e.g. "/studio" behind nginx at https://host/studio/). "" = root.
    basePath: (() => { const b = (env.BASE_PATH || "").replace(/\/+$/, ""); if (b && !/^(\/[a-z0-9-]+)+$/.test(b)) throw new Error("BASE_PATH must look like /studio"); return b; })(),
    rpId: url.hostname,
    rpName: env.RP_NAME || "Atelier",
    port: int("PORT", 18790),
    host: env.HOST || "127.0.0.1",
    dataDir,
    tokenPepper: pepper,
    // ComfyUI on the GPU, reached through the reverse tunnel that lands on this box.
    get comfyUrl() { return env.COMFY_URL ? env.COMFY_URL.replace(/\/$/, "") : fleet.active.comfyUrl; },
    comfyClientId: env.COMFY_CLIENT_ID || "h3studio",
    // CompShare (UCloud) power control; optional — without keys the app only observes.
    // ---- GPU boxes ---------------------------------------------------------------------------
    // One machine was hard-wired into ports and one instance id. Renting a second (another region, so we
    // can start whichever has capacity) makes the box a parameter: GPU_BOXES lists them by name and each
    // one carries its own instance, tunnel port base and hostname. With GPU_BOXES unset the existing
    // environment still describes exactly one box called "north", so nothing changes for a single machine.
    boxes: (() => {
      const names = (env.GPU_BOXES || "huabei").split(",").map((x) => x.trim()).filter(Boolean);
      const pick = (name, key, dflt) => env[`GPU_${name.toUpperCase()}_${key}`] ?? dflt;
      return Object.freeze(names.map((name, i) => {
        const base = Number(pick(name, "PORTBASE", i === 0 ? 19188 : 19188 + i * 100));
        return Object.freeze({
          name,
          label: pick(name, "LABEL", name),
          region: pick(name, "REGION", env.COMPSHARE_REGION || ""),
          zone: pick(name, "ZONE", env.COMPSHARE_ZONE || ""),
          instanceId: pick(name, "INSTANCE", i === 0 ? env.COMPSHARE_INSTANCE_ID || "" : ""),
          host: pick(name, "HOST", i === 0 ? env.ASSETS_HOST || "" : ""),
          portBase: base,
          comfyUrl: `http://127.0.0.1:${base}`,
          sshPort: base + 1,
          llmUpstream: `http://127.0.0.1:${base + 2}`,
          voiceUpstream: `http://127.0.0.1:${base + 3}`,
          assetsPort: Number(pick(name, "ASSETS_PORT", env.ASSETS_PORT || 8443)),
          // Two shapes of machine: a VM where we open 8443 and reach https://<ip>:8443 with our own cert,
          // and a container pod where the platform fronts the port with its own TLS ingress on a fixed
          // hostname (http://8443-<pod>.pod.compshare.cn). Set GPU_<BOX>_ASSETS_URL for the second kind;
          // the box then serves plain HTTP behind it (ASSETS_TLS=0) and the browser gets a real cert.
          assetsUrl: (pick(name, "ASSETS_URL", "") || "").replace(/\/$/, ""),
        });
      }));
    })(),
    activeBox: env.GPU_ACTIVE_BOX || "",     // empty = the first box, or whatever settings.activeBox says
    // keys are account-wide; the instance/region/zone follow the active box
    get compshare() {
      if (!(env.COMPSHARE_PUBLIC_KEY && env.COMPSHARE_PRIVATE_KEY)) return null;
      const b = fleet.active;
      return { publicKey: env.COMPSHARE_PUBLIC_KEY, privateKey: env.COMPSHARE_PRIVATE_KEY,
        instanceId: b.instanceId || "", region: b.region || "cn-wlcb", zone: b.zone || "cn-wlcb-01" };
    },
    // GPU-side control (gpuctl over the reverse ssh tunnel). port unset = follow the active box's own
    // tunnel port, which is what makes switching machines work; GPUCTL_MOCK=1 swaps in a stand-in for tests.
    gpuctl: Object.freeze({ host: env.GPUCTL_HOST || "127.0.0.1", port: env.GPUCTL_PORT ? Number(env.GPUCTL_PORT) : null, user: env.GPUCTL_USER || "root", key: env.GPUCTL_KEY || path.join(dataDir, "gpu_ed25519"), knownHosts: env.GPUCTL_KNOWN_HOSTS || path.join(dataDir, "gpu_known_hosts"), mock: env.GPUCTL_MOCK === "1" }),
    // Direct browser ↔ GPU asset transfer (gpu/assets/server.py). Same secret on both sides; ASSETS_MOCK=1 points at a local stand-in for tests.
    assetsSecret: env.ASSETS_SECRET || "",
    // Fleet tunnel (Hysteria2). 13 is in LA, the boxes are in mainland China: plain TCP into China is
    // ~24 KB/s per flow, the same path over QUIC with a loss-agnostic CC measured 6 MB/s.
    fleetHy2: Object.freeze({ server: env.FLEET_HY2_SERVER || "", password: env.FLEET_HY2_PASSWORD || "", sni: env.FLEET_HY2_SNI || "" }),
    get assetsPort() { return fleet.active.assetsPort; },
    get assetsHost() { return fleet.active.host || ""; },   // hostname with a real cert (its A record is kept pointing at the box)
    // per-box ingress URL wins, then the test/dev override; empty = derive https://<public ip>:<port>
    get assetsBase() { return fleet.active?.assetsUrl || env.ASSETS_BASE || ""; },
    godaddy: Object.freeze({ key: env.GODADDY_KEY || "", secret: env.GODADDY_SECRET || "", domain: env.GODADDY_DOMAIN || "" }),
    // Runner endpoints as seen from this box (tunnel ports): llama-server and the voice service.
    get llmUpstream() { return env.LLM_UPSTREAM ? env.LLM_UPSTREAM.replace(/\/$/, "") : fleet.active.llmUpstream; },
    get voiceUpstream() { return env.VOICE_UPSTREAM ? env.VOICE_UPSTREAM.replace(/\/$/, "") : fleet.active.voiceUpstream; },
    hourlyRate: Number(env.GPU_HOURLY_RATE || 3.32),
    idleMinutes: Number(env.GPU_IDLE_MINUTES || 10),
    // fileshare backend on the same box (login-free share links); optional.
    fileshare: env.FILESHARE_TOKEN ? Object.freeze({ url: (env.FILESHARE_URL || "http://127.0.0.1:8787").replace(/\/$/, ""), token: env.FILESHARE_TOKEN }) : null,
    // Optional OpenAI-compatible LLM for the prompt assistant (DeepSeek by default).
    // Prompt assistant (DeepSeek by default). The environment sets the baseline; whatever the settings
    // page saved wins, so the key can be rotated from the browser without an ssh session and a restart.
    assistantOverride: {},
    get llm() {
      const o = this.assistantOverride || {};
      const apiKey = o.apiKey ?? env.LLM_API_KEY;
      if (!apiKey) return null;
      return {
        baseUrl: (o.baseUrl || env.LLM_BASE_URL || "https://api.deepseek.com").replace(/\/$/, ""),
        apiKey,
        model: o.model || env.LLM_MODEL || "deepseek-v4-pro",
        fastModel: o.fastModel || env.LLM_FAST_MODEL || "deepseek-v4-flash",
        source: o.apiKey ? "settings" : "env",
      };
    },
    // Embeddings for the prompt library (OpenAI by default; DeepSeek has no embedding model).
    embed: (env.EMBED_API_KEY || env.OPENAI_API_KEY) ? Object.freeze({ baseUrl: (env.EMBED_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""), apiKey: env.EMBED_API_KEY || env.OPENAI_API_KEY, model: env.EMBED_MODEL || "text-embedding-3-small" }) : null,
    openprompt: Object.freeze({ url: (env.OPENPROMPT_URL || "https://openprompt-virid.vercel.app").replace(/\/$/, ""), autoSync: env.PROMPTS_AUTOSYNC !== "0", syncHours: Number(env.PROMPTS_SYNC_HOURS || 24) }),
    promptRulesUrl: env.PROMPT_RULES_URL || "https://atelier.example.com/h3.md",
    ffmpeg: env.FFMPEG || "ffmpeg",
    ffprobe: env.FFPROBE || "ffprobe",
    fontName: env.SUBTITLE_FONT || (os.platform() === "darwin" ? "Hiragino Sans GB" : "Noto Sans CJK SC"),
    sessionTtl: int("SESSION_TTL_SECONDS", 30 * 86400),
    enrollmentTtl: int("PASSKEY_ENROLLMENT_TTL_SECONDS", 24 * 3600),
    maxUploadBytes: int("MAX_UPLOAD_BYTES", 2 * 1024 * 1024 * 1024),
    // Development only: a fixed cookie value accepted as a session on http://localhost (never on https).
    devSessionToken: url.protocol === "http:" && env.DEV_SESSION_TOKEN ? env.DEV_SESSION_TOKEN : null,
    version: env.ATELIER_VERSION || "0.1.0",
    fleet,
    /** Point every per-box field at another machine. Returns the box, or throws if it is not configured. */
    useBox(name) {
      const b = cfg.boxes.find((x) => x.name === name);
      if (!b) throw new Error(`没有这台机器：${name}（有 ${cfg.boxes.map((x) => x.name).join("、")}）`);
      fleet.active = b;
      return b;
    },
  };
  fleet.boxes = cfg.boxes;
  fleet.active = cfg.boxes.find((b) => b.name === cfg.activeBox) || cfg.boxes[0];
  return cfg;
}
