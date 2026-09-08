// Local dev: mock ComfyUI + server on a fixed port with a dev session cookie (no passkey needed).
//   node test/dev.mjs   → open http://localhost:18790/dev-login?token=dev
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockComfy } from "./mock-comfy.mjs";
import { startMockOpenPrompt, startMockAI } from "./mock-ai.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data-dev");
const mock = await startMockComfy({ port: 19288, delayMs: Number(process.env.MOCK_DELAY || 2500), outDir: path.join(dataDir, "mock") });
console.log("mock comfy at", mock.url);
// Prompt library: mocks by default; REAL_AI=1 uses the real keys from the environment (DeepSeek/OpenAI/OpenPrompt).
const mockOP = process.env.REAL_AI ? null : await startMockOpenPrompt({ port: 19289 });
const mockAI = process.env.REAL_AI ? null : await startMockAI({ port: 19290 });
const ai = process.env.REAL_AI ? {} : { OPENPROMPT_URL: mockOP.url, LLM_API_KEY: "test", LLM_BASE_URL: mockAI.url, LLM_MODEL: "mock-pro", LLM_FAST_MODEL: "mock-flash", EMBED_API_KEY: "test", EMBED_BASE_URL: mockAI.url, EMBED_MODEL: "mock-embed" };
const env = { ...process.env, PUBLIC_ORIGIN: "http://localhost:18790", TOKEN_PEPPER: "dev-pepper-0123456789", DATA_DIR: dataDir, PORT: "18790", COMFY_URL: mock.url, DEV_SESSION_TOKEN: "dev", GPU_IDLE_MINUTES: "30", PROMPTS_AUTOSYNC: "0", GPUCTL_MOCK: process.env.REAL_GPU ? "0" : "1", ...(mockAI ? { LLM_UPSTREAM: mockAI.url, VOICE_UPSTREAM: mockAI.url } : {}), ...ai };
const server = spawn(process.execPath, [path.join(root, "server/src/index.js")], { env, stdio: "inherit" });
const bye = async () => { server.kill("SIGTERM"); await mock.close(); if (mockOP) await mockOP.close(); if (mockAI) await mockAI.close(); process.exit(0); };
process.on("SIGINT", bye); process.on("SIGTERM", bye);
