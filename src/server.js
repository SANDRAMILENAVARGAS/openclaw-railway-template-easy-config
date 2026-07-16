import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

// Railway commonly sets PORT=8080 for HTTP services.
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);

// Hard-coded Openclaw directories for Railway deployment
const STATE_DIR = "/data/.openclaw";
const WORKSPACE_DIR = "/data/workspace";

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Debug logging helper
const DEBUG = process.env.OPENCLAW_TEMPLATE_DEBUG?.toLowerCase() === "true";
function debug(...args) {
  if (DEBUG) console.log(...args);
}

// Gateway admin token - use SETUP_PASSWORD for simplicity
// This protects both the /setup wizard and the OpenClaw gateway
const OPENCLAW_GATEWAY_TOKEN = SETUP_PASSWORD || crypto.randomBytes(32).toString("hex");
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

if (!SETUP_PASSWORD) {
  console.warn("[setup] WARNING: SETUP_PASSWORD not set - using auto-generated token");
  console.warn(`[setup] Gateway token: ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}...`);
} else {
  console.log("[setup] ✓ Using SETUP_PASSWORD as gateway token");
}

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = 18789;
const INTERNAL_GATEWAY_HOST = "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
const OPENCLAW_ENTRY = "/openclaw/dist/entry.js";
const OPENCLAW_NODE = "node";

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

// Agent metadata file (dashboard-specific fields not stored in openclaw.json)
const AGENT_META_PATH = path.join(STATE_DIR, "agent-meta.json");

// Skills directory (each skill is a folder with SKILL.md + optional scripts/references/assets)
const SKILLS_DIR = path.join(WORKSPACE_DIR, "skills");

function readAgentMeta() {
  try {
    return JSON.parse(fs.readFileSync(AGENT_META_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeAgentMeta(meta) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(AGENT_META_PATH, JSON.stringify(meta, null, 2), "utf8");
}

function parseSkillFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      meta[key] = val;
    }
  }
  return meta;
}

// Persona templates for quick agent personality configuration
const PERSONA_TEMPLATES = [
  {
    id: "support-friendly",
    name: "Friendly Support Agent",
    description: "Warm, empathetic support agent that prioritizes user satisfaction and clear communication.",
    category: "support",
    soul: `# SOUL - Friendly Support Agent

You are a warm, empathetic support agent. Your primary goal is to help users resolve their issues quickly while making them feel heard and valued.

## Personality
- Friendly and approachable tone
- Patient with all skill levels
- Proactive in offering additional help
- Celebrate user successes

## Communication Style
- Use clear, jargon-free language
- Break complex steps into simple instructions
- Confirm understanding before moving on
- End interactions with a helpful follow-up suggestion`,
    identity: { name: "Support Agent" },
    model: null,
  },
  {
    id: "developer-focused",
    name: "Developer Assistant",
    description: "Technical coding assistant that provides precise, well-documented solutions with best practices.",
    category: "development",
    soul: `# SOUL - Developer Assistant

You are a skilled developer assistant focused on writing clean, maintainable code. You follow best practices and explain your reasoning.

## Personality
- Direct and technically precise
- Opinionated about code quality
- Thorough in error handling
- Security-conscious

## Communication Style
- Use code examples liberally
- Reference documentation and standards
- Explain trade-offs between approaches
- Flag potential issues proactively`,
    identity: { name: "Dev Assistant" },
    model: null,
  },
  {
    id: "creative-writer",
    name: "Creative Writer",
    description: "Imaginative writing partner that helps with storytelling, content creation, and creative brainstorming.",
    category: "creative",
    soul: `# SOUL - Creative Writer

You are an imaginative creative writing partner. You help users craft compelling narratives, generate ideas, and refine their creative work.

## Personality
- Enthusiastic about creative expression
- Encouraging and constructive
- Rich vocabulary and varied sentence structure
- Playful but professional

## Communication Style
- Offer multiple creative options
- Use vivid language and metaphors
- Ask thought-provoking questions
- Build on user ideas rather than replacing them`,
    identity: { name: "Creative Writer" },
    model: null,
  },
  {
    id: "data-analyst",
    name: "Data Analyst",
    description: "Analytical assistant that excels at interpreting data, finding patterns, and presenting insights clearly.",
    category: "analytics",
    soul: `# SOUL - Data Analyst

You are a meticulous data analyst. You help users understand their data, find patterns, and make data-driven decisions.

## Personality
- Precise and detail-oriented
- Evidence-based reasoning
- Clear about assumptions and limitations
- Pragmatic about methodology

## Communication Style
- Present findings with supporting evidence
- Use structured formats (tables, lists)
- Distinguish correlation from causation
- Suggest next steps for deeper analysis`,
    identity: { name: "Data Analyst" },
    model: null,
  },
  {
    id: "minimalist",
    name: "Minimalist Assistant",
    description: "Concise, no-nonsense assistant that delivers maximum value with minimum words.",
    category: "productivity",
    soul: `# SOUL - Minimalist Assistant

You are a concise, efficient assistant. You deliver maximum value with minimum words. No fluff, no filler.

## Personality
- Direct and to the point
- Efficient with words
- Action-oriented
- Respectful of user time

## Communication Style
- Short, clear responses
- Bullet points over paragraphs
- Skip pleasantries unless asked
- Lead with the answer, then explain if needed`,
    identity: { name: "Assistant" },
    model: null,
  },
];

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

let gatewayProc = null;
let gatewayStarting = null;
let onboardingInProgress = false; // Prevents middleware from starting gateway during onboarding

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  // Railway may need more time for cold starts (especially first deployment)
  // Default to 90 seconds for Railway, allow override via opts
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const start = Date.now();
  const endpoints = ["/openclaw", "/openclaw", "/", "/health"];

  while (Date.now() - start < timeoutMs) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${GATEWAY_TARGET}${endpoint}`, { method: "GET" });
        // Any HTTP response means the port is open.
        if (res) {
          console.log(`[gateway] ready at ${endpoint}`);
          return true;
        }
      } catch (err) {
        // not ready, try next endpoint
      }
    }
    await sleep(250);
  }
  console.error(`[gateway] failed to become ready after ${timeoutMs}ms`);
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  // Fix permissions on state directory to address security warnings
  // State dir contains sensitive data (config, credentials, sessions)
  try {
    fs.chmodSync(STATE_DIR, 0o700);
    console.log(`[gateway] ✓ Fixed permissions: ${STATE_DIR} (700: owner only)`);
  } catch (err) {
    console.warn(`[gateway] ⚠️  Could not set permissions on ${STATE_DIR}: ${err.message}`);
  }

  // Sync wrapper token to openclaw.json before every gateway start.
  // This ensures the gateway's config-file token matches what the wrapper injects via proxy.
  console.log(`[gateway] ========== GATEWAY START TOKEN SYNC ==========`);
  console.log(`[gateway] Syncing wrapper token to config: ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}... (len: ${OPENCLAW_GATEWAY_TOKEN.length})`);

  const syncResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]),
  );

  console.log(`[gateway] Sync result: exit code ${syncResult.code}`);
  if (syncResult.output?.trim()) {
    console.log(`[gateway] Sync output: ${syncResult.output}`);
  }

  if (syncResult.code !== 0) {
    console.error(`[gateway] ⚠️  WARNING: Token sync failed with code ${syncResult.code}`);
  }

  // Verify sync succeeded
  try {
    const config = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const configToken = config?.gateway?.auth?.token;

    console.log(`[gateway] Token verification:`);
    console.log(`[gateway]   Wrapper: ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}... (len: ${OPENCLAW_GATEWAY_TOKEN.length})`);
    console.log(`[gateway]   Config:  ${configToken?.slice(0, 16)}... (len: ${configToken?.length || 0})`);

    if (configToken !== OPENCLAW_GATEWAY_TOKEN) {
      console.error(`[gateway] ✗ Token mismatch detected!`);
      console.error(`[gateway]   Full wrapper: ${OPENCLAW_GATEWAY_TOKEN}`);
      console.error(`[gateway]   Full config:  ${configToken || 'null'}`);
      throw new Error(
        `Token mismatch: wrapper has ${OPENCLAW_GATEWAY_TOKEN.slice(0, 16)}... but config has ${(configToken || 'null')?.slice?.(0, 16)}...`
      );
    }
    console.log(`[gateway] ✓ Token verification PASSED`);
  } catch (err) {
    console.error(`[gateway] ERROR: Token verification failed: ${err}`);
    throw err; // Don't start gateway with mismatched token
  }

  console.log(`[gateway] ========== TOKEN SYNC COMPLETE ==========`);

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  // Read the .env file to get the API key for the gateway process
  let gatewayEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
  };

  try {
    const envPath = path.join(STATE_DIR, ".env");
    const envContent = fs.readFileSync(envPath, "utf8");
    const match = envContent.match(/OPENAI_API_KEY=(.+)/);
    if (match && match[1]) {
      gatewayEnv.OPENAI_API_KEY = match[1].trim();
      console.log(`[gateway] Found OPENAI_API_KEY in .env, passing to gateway process`);
    }
  } catch (err) {
    console.warn(`[gateway] Could not read .env file: ${err.message}`);
  }

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: gatewayEnv,
  });

  console.log(`[gateway] starting with command: ${OPENCLAW_NODE} ${clawArgs(args).join(" ")}`);
  console.log(`[gateway] STATE_DIR: ${STATE_DIR}`);
  console.log(`[gateway] WORKSPACE_DIR: ${WORKSPACE_DIR}`);
  console.log(`[gateway] config path: ${configPath()}`);

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    gatewayProc = null;
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await startGateway();
      // Use longer timeout for Railway cold starts (90 seconds)
      const ready = await waitForGatewayReady({ timeoutMs: 90_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function stopGateway() {
  if (gatewayProc) {
    const oldProc = gatewayProc;
    try {
      oldProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Wait for the process to actually exit, not just a fixed delay.
    const timeoutMs = 10_000;
    const start = Date.now();
    while (oldProc.exitCode === null && Date.now() - start < timeoutMs) {
      await sleep(100);
    }
    if (oldProc.exitCode === null) {
      console.warn(`[gateway] Process did not exit after ${timeoutMs}ms, forcing SIGKILL`);
      try {
        oldProc.kill("SIGKILL");
        await sleep(500);
      } catch {
        // ignore
      }
    } else {
      console.log(`[gateway] Process stopped cleanly (code=${oldProc.exitCode})`);
    }
    gatewayProc = null;
  }
}

async function restartGateway() {
  await stopGateway();
  return ensureGatewayRunning();
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      );
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="Openclaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="Openclaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

// Configure gog CLI environment for persistent authentication in containers
// Must be called before decodeCredentialsFromEnv to set up the environment
function configureGogEnvironment() {
  // Set default values if not provided
  const gogConfigDir = process.env.GOG_CONFIG_DIR || "/data/.gog-config";
  const keyringBackend = process.env.GOG_KEYRING_BACKEND || "file";
  const keyringPassword = process.env.GOG_KEYRING_PASSWORD || "";

  // Set XDG_CONFIG_HOME to persist gog config to Railway volume
  process.env.XDG_CONFIG_HOME = gogConfigDir;
  process.env.GOG_KEYRING_BACKEND = keyringBackend;

  // Create gog config directory
  try {
    fs.mkdirSync(gogConfigDir, { recursive: true });
    console.log(`[gog] ✅ Config directory: ${gogConfigDir}`);
  } catch (err) {
    console.warn(`[gog] ⚠️  Could not create config directory: ${err.message}`);
  }

  // Warn if keyring password is not set
  if (!keyringPassword || keyringPassword.includes("Replace")) {
    console.warn(`[gog] ⚠️  GOG_KEYRING_PASSWORD not set or is placeholder`);
    console.warn(`[gog]    For Google Workspace features, set a secure password in Railway variables`);
  } else {
    console.log(`[gog] ✅ Keyring backend: ${keyringBackend}`);
  }

  return { gogConfigDir, keyringBackend, keyringPassword };
}

// Decode base64-encoded credentials on startup
// This allows secure credential storage via environment variables
function decodeCredentialsFromEnv() {
  const googleSecretBase64 = process.env.GOOGLE_CLIENT_SECRET_BASE64;

  if (!googleSecretBase64) {
    console.log("[credentials] GOOGLE_CLIENT_SECRET_BASE64 not set, skipping Google credentials setup");
    return;
  }

  try {
    // Create credentials directory
    const credentialsDir = path.join(STATE_DIR, "credentials");
    fs.mkdirSync(credentialsDir, { recursive: true });

    // Decode base64 and write to file
    const decoded = Buffer.from(googleSecretBase64, "base64").toString("utf8");
    const credentialsPath = path.join(credentialsDir, "client_secret.json");

    // Validate it's valid JSON before writing
    const parsed = JSON.parse(decoded); // Will throw if invalid

    // Check if this is the placeholder (contains "note" key)
    if (parsed.note && parsed.note.includes("Replace this with your actual")) {
      console.log(`[credentials] ⚠️  GOOGLE_CLIENT_SECRET_BASE64 contains placeholder value`);
      console.log(`[credentials] To use Google Workspace features:`);
      console.log(`[credentials]   1. Create OAuth credentials at https://console.google.com`);
      console.log(`[credentials]   2. Download client_secret.json`);
      console.log(`[credentials]   3. Encode: base64 -w 0 client_secret.json`);
      console.log(`[credentials]   4. Update GOOGLE_CLIENT_SECRET_BASE64 in Railway variables`);
      return;
    }

    // Validate it's a proper client_secret.json (has required fields)
    if (!parsed.installed && !parsed.web) {
      throw new Error("Invalid client_secret.json format (missing 'installed' or 'web' key)");
    }

    fs.writeFileSync(credentialsPath, decoded, { mode: 0o600 });
    console.log(`[credentials] ✅ Successfully decoded and wrote Google credentials to ${credentialsPath}`);

    // Set environment variable for gog skill to find it
    process.env.GOOGLE_CREDENTIALS_PATH = credentialsPath;

    console.log(`[gog] ℹ️  To complete Google Workspace setup, run via Railway Shell:`);
    console.log(`[gog]    gog auth credentials ${credentialsPath}`);
    console.log(`[gog]    gog auth add your@gmail.com --services gmail --manual`);
  } catch (err) {
    console.error(`[credentials] ❌ Failed to decode Google credentials: ${err.message}`);
    console.error(`[credentials] The GOOGLE_CLIENT_SECRET_BASE64 environment variable may be invalid`);
  }
}

// Configure gog environment and decode credentials on startup
configureGogEnvironment();
decodeCredentialsFromEnv();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// CORS middleware for external dashboard access (e.g. OpenClaw Cloud on Lovable)
app.use("/setup/api", (req, res, next) => {
  const origin = req.headers.origin;
  const allowed = (process.env.DASHBOARD_ORIGINS || "").split(",").filter(Boolean);
  if (origin && allowed.some((a) => origin === a)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
    res.set("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Minimal health endpoint for Railway.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

// Serve static files for setup wizard
app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(process.cwd(), "src", "public", "setup-app.js"));
});

app.get("/setup/styles.css", requireSetupAuth, (_req, res) => {
  res.type("text/css");
  res.sendFile(path.join(process.cwd(), "src", "public", "styles.css"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "setup.html"));
});

app.get("/setup/google", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "google-setup.html"));
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  // Run version and channels help commands in parallel for faster response
  const [version, channelsHelp] = await Promise.all([
    runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
    runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"])),
  ]);

  // We reuse Openclaw's own auth-choice grouping logic indirectly by hardcoding the same group defs.
  // This is intentionally minimal; later we can parse the CLI help output to stay perfectly in sync.
  const authGroups = [
    {
      value: "openai",
      label: "OpenAI",
      hint: "GPT models",
      options: [
        { value: "openai-api-key", label: "OpenAI API key (from platform.openai.com)" },
        { value: "openai-codex", label: "OpenAI ChatGPT OAuth" },
        { value: "codex-cli", label: "OpenAI Codex CLI OAuth" },
      ],
    },
    {
      value: "anthropic",
      label: "Anthropic",
      hint: "Claude API (recommended)",
      options: [
        { value: "apiKey", label: "Anthropic API key (from console.anthropic.com)" },
        { value: "token", label: "Anthropic setup-token (from Claude Code CLI)" },
        { value: "claude-cli", label: "Anthropic Claude Code CLI OAuth" },
      ],
    },
    {
      value: "google",
      label: "Google",
      hint: "Gemini API key + OAuth",
      options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
        { value: "google-antigravity", label: "Google Antigravity OAuth" },
        { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" },
      ],
    },
    {
      value: "openrouter",
      label: "OpenRouter",
      hint: "API key",
      options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
      models: [
        {
          id: "openai/gpt-5.4",
          name: "GPT-5.4",
          description: "OpenAI's latest flagship model",
          contextWindow: 1047576,
          inputPrice: 2.00,
          outputPrice: 8.00,
        },
        {
          id: "google/gemini-2.5-pro-preview",
          name: "Gemini 2.5 Pro",
          description: "Google's advanced reasoning model",
          contextWindow: 1048576,
          inputPrice: 1.25,
          outputPrice: 10.00,
        },
        {
          id: "deepseek/deepseek-chat-v3-0324",
          name: "DeepSeek V3",
          description: "Strong reasoning and coding at low cost",
          contextWindow: 131072,
          inputPrice: 0.27,
          outputPrice: 1.10,
        },
        {
          id: "anthropic/claude-sonnet-4.6",
          name: "Claude Sonnet 4.6",
          description: "Anthropic's latest fast coding model",
          contextWindow: 200000,
          inputPrice: 3.00,
          outputPrice: 15.00,
        },
        {
          id: "openai/gpt-5.4-mini",
          name: "GPT-5.4 Mini",
          description: "OpenAI's compact, efficient model",
          contextWindow: 1048576,
          inputPrice: 0.50,
          outputPrice: 2.00,
        },
        {
          id: "google/gemini-3-flash-preview",
          name: "Gemini 3 Flash",
          description: "Google's fast, lightweight model",
          contextWindow: 1048576,
          inputPrice: 0.10,
          outputPrice: 0.40,
        },
        {
          id: "deepseek/deepseek-v3.2",
          name: "DeepSeek V3.2",
          description: "Latest DeepSeek with improved reasoning",
          contextWindow: 163840,
          inputPrice: 0.28,
          outputPrice: 0.40,
        },
        {
          id: "moonshotai/kimi-k2.5",
          name: "Kimi K2.5",
          description: "Moonshot's flagship reasoning model",
          contextWindow: 327680,
          inputPrice: 0.55,
          outputPrice: 2.00,
        },
        {
          id: "minimax/minimax-m2.7",
          name: "MiniMax M2.7",
          description: "MiniMax's latest optimized model",
          contextWindow: 196600,
          inputPrice: 0.30,
          outputPrice: 1.20,
        },
        {
          id: "z-ai/glm-5",
          name: "GLM-5",
          description: "Z.AI's next-generation language model",
          contextWindow: 204800,
          inputPrice: 0.55,
          outputPrice: 2.10,
        },
      ],
    },
    {
      value: "ai-gateway",
      label: "Vercel AI Gateway",
      hint: "API key",
      options: [
        { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
      ],
    },
    {
      value: "atlas",
      label: "Atlas Cloud",
      hint: "API key",
      options: [
        { value: "atlas-api-key", label: "Atlas Cloud API key" },
      ],
      models: [
        {
          id: "moonshotai/kimi-k2.5",
          name: "Moonshot Kimi K2.5 (default)",
          description: "Flagship model with advanced reasoning and long context",
          contextWindow: 327680,
          inputPrice: 0.55,
          outputPrice: 2.00,
        },
        {
          id: "minimaxai/minimax-m2.1",
          name: "MiniMax M2.1",
          description: "Lightweight 10B model, optimized for coding",
          contextWindow: 196600,
          inputPrice: 0.30,
          outputPrice: 1.20,
        },
        {
          id: "qwen/qwen-3.5-397ba17b",
          name: "Qwen3.5 397BA17B",
          description: "High-performance large language model",
          contextWindow: 262100,
          inputPrice: 0.50,
          outputPrice: 2.00,
        },
        {
          id: "zai-org/glm-5",
          name: "GLM 5",
          description: "Next-generation Chinese-optimized large language model",
          contextWindow: 204800,
          inputPrice: 0.55,
          outputPrice: 2.10,
        },
        {
          id: "moonshot-ai/kimi-k2.5",
          name: "Kimi K2.5",
          description: "Long-context model with improved reasoning",
          contextWindow: 262100,
          inputPrice: 0.60,
          outputPrice: 2.50,
        },
        {
          id: "qwen/qwen-3-max-20260123",
          name: "Qwen3 Max 20260123",
          description: "Premium Qwen model with enhanced capabilities",
          contextWindow: 262100,
          inputPrice: 0.80,
          outputPrice: 3.00,
        },
        {
          id: "minimaxai/minimax-m2.1",
          name: "MiniMax M2.1",
          description: "Lightweight 10B model, optimized for coding",
          contextWindow: 196600,
          inputPrice: 0.30,
          outputPrice: 1.20,
        },
        {
          id: "zai-org/glm-5",
          name: "GLM 5",
          description: "Chinese-optimized large language model",
          contextWindow: 202800,
          inputPrice: 0.52,
          outputPrice: 1.95,
        },
        {
          id: "deepseek-ai/deepseek-v3.2",
          name: "DeepSeek V3.2",
          description: "Advanced reasoning model with chain-of-thought",
          contextWindow: 163800,
          inputPrice: 0.28,
          outputPrice: 0.40,
        },
      ],
    },
    {
      value: "modelscope",
      label: "ModelScope.ai",
      hint: "API key",
      options: [
        { value: "modelscope-api-key", label: "ModelScope.ai API key" },
      ],
      models: [
        {
          id: "zai-org/GLM-5-Flash",
          name: "GLM-5 Flash",
          description: "Fast and efficient large language model",
          contextWindow: 131072,
          inputPrice: 0.00,
          outputPrice: 0.00,
        },
        {
          id: "deepseek-ai/DeepSeek-V3.2",
          name: "DeepSeek V3.2 (default)",
          description: "Latest DeepSeek model with strong reasoning and coding",
          contextWindow: 163840,
          inputPrice: 0.00,
          outputPrice: 0.00,
        },
      ],
    },
    {
      value: "moonshot",
      label: "Moonshot AI",
      hint: "Kimi K2 + Kimi Code",
      options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" },
      ],
    },
    {
      value: "zai",
      label: "Z.AI (GLM 5)",
      hint: "API key",
      options: [{ value: "zai-api-key", label: "Z.AI (GLM 5) API key" }],
    },
    {
      value: "minimax",
      label: "MiniMax",
      hint: "M2.1 (recommended)",
      options: [
        { value: "minimax-api", label: "MiniMax M2.1" },
        { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
      ],
    },
    {
      value: "qwen",
      label: "Qwen",
      hint: "OAuth",
      options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
    },
    {
      value: "copilot",
      label: "Copilot",
      hint: "GitHub + local proxy",
      options: [
        {
          value: "github-copilot",
          label: "GitHub Copilot (GitHub device login)",
        },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" },
      ],
    },
    {
      value: "synthetic",
      label: "Synthetic",
      hint: "Anthropic-compatible (multi-model)",
      options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
    },
    {
      value: "opencode-zen",
      label: "OpenCode Zen",
      hint: "API key",
      options: [
        { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" },
      ],
    },
  ];

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups,
  });
});

app.get("/setup/api/gateway-url", requireSetupAuth, (_req, res) => {
  // Returns the gateway URL with token for direct access
  const gatewayUrl = `/openclaw?token=${encodeURIComponent(OPENCLAW_GATEWAY_TOKEN)}`;
  res.json({ url: gatewayUrl });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    // Map auth choice to Openclaw's recognized auth choices
    // (Atlas Cloud uses OpenAI-compatible API, so map it to openai-api-key)
    const authChoiceMap = {
      "atlas-api-key": "openai-api-key",
      "modelscope-api-key": "openai-api-key",
    };
    const effectiveAuthChoice = authChoiceMap[payload.authChoice] || payload.authChoice;
    args.push("--auth-choice", effectiveAuthChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      apiKey: "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      // Atlas Cloud uses OpenAI-compatible API, so use --openai-api-key
      "atlas-api-key": "--openai-api-key",
      // ModelScope.ai uses OpenAI-compatible API, so use --openai-api-key
      "modelscope-api-key": "--openai-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token" && secret) {
      // This is the Anthropics setup-token flow.
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}, extraEnv = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        ...extraEnv, // Add extra environment variables
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

// Reconcile per-agent models with the chosen default model.
async function syncAgentModels(modelRef) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch (err) {
    console.warn(`[model] syncAgentModels: could not read config: ${err.message}`);
    return { ok: false, changed: 0 };
  }

  const list = config?.agents?.list;
  if (!Array.isArray(list) || list.length === 0) {
    console.log(`[model] syncAgentModels: no agents.list to reconcile (defaults apply)`);
    return { ok: true, changed: 0 };
  }

  const updated = list.map((agent) => ({ ...agent, model: modelRef }));

  const result = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "set", "--json", "agents.list", JSON.stringify(updated)]),
  );
  console.log(`[model] syncAgentModels: set ${updated.length} agent(s) to ${modelRef} (exit=${result.code})`, result.output || "(no output)");
  return { ok: result.code === 0, changed: updated.length };
}

// Make `modelRef` the model the default agent actually runs.
async function setAgentDefaultModel(modelRef, alias) {
  // 1. Add the model to the allowlist (agents.defaults.models), preserving existing entries.
  let models = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const existing = cfg?.agents?.defaults?.models;
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      models = existing;
    }
  } catch (_e) { /* no existing allowlist */ }
  models[modelRef] = { ...(models[modelRef] || {}), alias };
  const allowlistResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "set", "--json", "agents.defaults.models", JSON.stringify(models)]),
  );
  console.log(`[model] setAgentDefaultModel: allowlisted ${modelRef} (exit=${allowlistResult.code})`, allowlistResult.output || "(no output)");

  // 2. Set the primary model (now present in the allowlist, so it is actually honored).
  const primaryResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "set", "agents.defaults.model.primary", modelRef]),
  );
  console.log(`[model] setAgentDefaultModel: set primary=${modelRef} (exit=${primaryResult.code})`, primaryResult.output || "(no output)");

  // 3. Reconcile any per-agent overrides so nothing shadows the default.
  await syncAgentModels(modelRef);

  return { ok: allowlistResult.code === 0 && primaryResult.code === 0 };
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  // Set flag to prevent middleware from starting gateway during onboarding
  onboardingInProgress = true;

  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({
        ok: true,
        output:
          "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    try {
      fs.chmodSync(STATE_DIR, 0o700);
      console.log(`[onboard] ✓ Fixed permissions: ${STATE_DIR} (700: owner only)`);
    } catch (err) {
      console.warn(`[onboard] ⚠️  Could not set permissions on ${STATE_DIR}: ${err.message}`);
    }

    const payload = req.body || {};
    const onboardArgs = buildOnboardArgs(payload);

    let onboard;
    if (payload.authChoice === "atlas-api-key") {
      onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs), {}, {
        OPENAI_BASE_URL: "https://api.atlascloud.ai/v1/",
      });
    } else if (payload.authChoice === "modelscope-api-key") {
      onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs), {}, {
        OPENAI_BASE_URL: "https://api-inference.modelscope.ai/v1",
      });
    } else {
      onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));
    }

    let extra = "";
    const ok = onboard.code === 0 && isConfigured();

    if (ok) {
      try {
        const configAfterOnboard = JSON.parse(fs.readFileSync(configPath(), "utf8"));
        const tokenAfterOnboard = configAfterOnboard?.gateway?.auth?.token;
        if (tokenAfterOnboard !== OPENCLAW_GATEWAY_TOKEN) {
          extra += `\n[WARNING] onboard wrote different token than expected\n`;
        }
      } catch (err) {
        console.error(`[onboard] Could not check config after onboard: ${err}`);
      }
    }

    if (ok) {
      console.log(`[onboard] Stopping gateway to apply config changes atomically...`);
      await stopGateway();

      let allowedOrigin = null;
      const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
      if (railwayDomain) {
        allowedOrigin = `https://${railwayDomain}`;
      } else {
        allowedOrigin = "http://localhost:8080";
      }

      await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "--json", "gateway.controlUi.allowedOrigins", JSON.stringify([allowedOrigin])]),
      );

      await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback", "true"]),
      );

      await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "gateway.controlUi.dangerouslyDisableDeviceAuth", "true"]),
      );

      await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "--json", "gateway.trustedProxies", '["127.0.0.1", "::1", "localhost"]']),
      );

      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.mode", "local"]));
      await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "gateway.auth.mode", "token"]),
      );

      const setTokenResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.auth.token",
          OPENCLAW_GATEWAY_TOKEN,
        ]),
      );

      if (setTokenResult.code !== 0) {
        extra += `\n[WARNING] Failed to set gateway token in config: ${setTokenResult.output}\n`;
      }

      try {
        const configContent = fs.readFileSync(configPath(), "utf8");
        const config = JSON.parse(configContent);
        const configToken = config?.gateway?.auth?.token;
        if (configToken !== OPENCLAW_GATEWAY_TOKEN) {
          extra += `\n[ERROR] Token verification failed! Config has different token than wrapper.\n`;
        } else {
          extra += `\n[onboard] ✓ Gateway token synced successfully\n`;
        }
      } catch (err) {
        extra += `\n[ERROR] Could not verify token: ${String(err)}\n`;
      }

      await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "gateway.bind", "loopback"]),
      );
      await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.port",
          String(INTERNAL_GATEWAY_PORT),
        ]),
      );

      const channelsHelp = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["channels", "add", "--help"]),
      );
      const helpText = channelsHelp.output || "";
      const supports = (name) => helpText.includes(name);

      if (payload.telegramToken?.trim()) {
        if (!supports("telegram")) {
          extra +=
            "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
        } else {
          const token = payload.telegramToken.trim();
          const cfgObj = {
            enabled: true,
            dmPolicy: "pairing",
            botToken: token,
            groupPolicy: "allowlist",
            streamMode: "partial",
          };
          const set = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]),
          );
          const get = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["config", "get", "channels.telegram"]),
          );
          extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
          const setStreaming = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["config", "set", "channels.telegram.streaming", "partial"]),
          );
          extra += `\n[telegram streaming] exit=${setStreaming.code} (output ${setStreaming.output.length} chars)\n${setStreaming.output || "(no output)"}`;
          extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        }
      }

      if (payload.discordToken?.trim()) {
        if (!supports("discord")) {
          extra +=
            "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
        } else {
          const token = payload.discordToken.trim();
          const cfgObj = {
            enabled: true,
            token,
            groupPolicy: "allowlist",
            dm: { policy: "pairing" },
          };
          const set = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]),
          );
          const get = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["config", "get", "channels.discord"]),
          );
          extra += `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
          extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        }
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        if (!supports("slack")) {
          extra +=
            "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
        } else {
          const cfgObj = {
            enabled: true,
            botToken: payload.slackBotToken?.trim() || undefined,
            appToken: payload.slackAppToken?.trim() || undefined,
          };
          const set = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]),
          );
          const get = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["config", "get", "channels.slack"]),
          );
          extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
          extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        }
      }

      if (payload.authChoice === "openrouter-api-key" && payload.openrouterModel) {
        const orModel = String(payload.openrouterModel).trim().replace(/^openrouter\//, "");
        const orRef = `openrouter/${orModel}`;

        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "models.mode", "merge"]));
        let orModels = [];
        try {
          const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
          const existing = cfg?.models?.providers?.openrouter?.models;
          if (Array.isArray(existing)) orModels = existing;
        } catch (_e) { /* no existing custom models */ }
        if (!orModels.some((m) => m && m.id === orModel)) {
          orModels.push({ id: orModel, name: orModel });
        }
        await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "models.providers.openrouter.models", JSON.stringify(orModels)]),
        );

        await setAgentDefaultModel(orRef, "OpenRouter");
        extra += `\n[openrouter] configured OpenRouter (model: ${orModel})\n`;
      }

      if (payload.authChoice === "atlas-api-key") {
        const atlasModel = payload.atlasModel || "deepseek-ai/deepseek-v3.2";

        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "models.mode", "merge"]));

        const providerConfig = {
          baseUrl: "https://api.atlascloud.ai/v1/",
          apiKey: "${OPENAI_API_KEY}",
          api: "openai-completions",
          models: [
            { id: "moonshotai/kimi-k2.5", name: "Moonshot Kimi K2.5" },
            { id: "minimaxai/minimax-m2.1", name: "MiniMax M2.1" },
            { id: "zai-org/glm-5", name: "GLM 5" },
            { id: "deepseek-ai/deepseek-v3.2", name: "DeepSeek V3.2" },
          ]
        };

        await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "models.providers.atlas", JSON.stringify(providerConfig)]),
        );

        const atlasRef = `atlas/${atlasModel}`;
        await setAgentDefaultModel(atlasRef, "Atlas Cloud");
        extra += `\n[atlas] configured Atlas Cloud provider (model: ${atlasModel})\n`;
      }

      if (payload.authChoice === "modelscope-api-key") {
        const msModel = payload.modelscopeModel || "deepseek-ai/DeepSeek-V3.2";

        await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "models.mode", "merge"]));

        const providerConfig = {
          baseUrl: "https://api-inference.modelscope.ai/v1",
          apiKey: "${OPENAI_API_KEY}",
          api: "openai-completions",
          models: [
            { id: "zai-org/GLM-5-Flash", name: "GLM-5 Flash" },
            { id: "deepseek-ai/DeepSeek-V3.2", name: "DeepSeek V3.2" },
          ]
        };

        await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "models.providers.modelscope", JSON.stringify(providerConfig)]),
        );

        const msRef = `modelscope/${msModel}`;
        await setAgentDefaultModel(msRef, "ModelScope");
        extra += `\n[modelscope] configured ModelScope.ai provider (model: ${msModel})\n`;
      }

      await restartGateway();

      try {
        const effective = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "get", "agents.defaults.model.primary"]),
        );
        const defaultPrimary = effective.code === 0 ? effective.output.trim() : "(unknown)";
        let agentModel = null;
        let allowlist = [];
        try {
          const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
          const list = cfg?.agents?.list;
          if (Array.isArray(list) && list.length > 0) {
            const def = list.find((a) => a && a.default === true) || list[0];
            agentModel = def?.model ?? null;
          }
          const models = cfg?.agents?.defaults?.models;
          if (models && typeof models === "object") allowlist = Object.keys(models);
        } catch (_e) { /* ignore */ }
        const effModel = agentModel || defaultPrimary;
        const allowlisted = allowlist.includes(defaultPrimary);
        extra += `\n[model] effective model: ${effModel} (default agent; allowlist: ${allowlist.join(", ") || "none"})\n`;
        if (!allowlisted) {
          extra += `[model] WARNING: primary (${defaultPrimary}) is not in the allowlist — OpenClaw may run an allowlisted model instead.\n`;
        }
      } catch (err) {
        console.warn(`[model] could not read effective model: ${err.message}`);
      }
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res
      .status(500)
      .json({ ok: false, output: `Internal error: ${String(err)}` });
  } finally {
    onboardingInProgress = false;
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["channels", "add", "--help"]),
  );
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(
        path.join(STATE_DIR, "gateway.token"),
      ),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

app.get("/setup/api/pairing/list", requireSetupAuth, async (_req, res) => {
  const r = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["pairing", "list"]),
  );
  if (r.code !== 0) {
    return res.json({ ok: true, requests: [] });
  }
  const lines = r.output.trim().split('\n');
  const requests = [];
  for (const line of lines) {
    if (line.includes('│')) {
      const parts = line.split('│').map(s => s.trim());
      if (parts.length >= 2 && parts[0] && !parts[0].includes('Code')) {
        requests.push({
          code: parts[0],
          userId: parts[1] || 'unknown',
          timestamp: parts[2] || new Date().toISOString()
        });
      }
    }
  }
  return res.json({ ok: true, requests });
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["pairing", "approve", String(channel), String(code)]),
  );
  return res
    .status(r.code === 0 ? 200 : 500)
    .json({ ok: r.code === 0, output: r.output });
});

// Google Workspace (gog) OAuth authentication endpoints
app.get("/setup/api/google/status", requireSetupAuth, async (_req, res) => {
  const gogPath = "/home/linuxbrew/.linuxbrew/bin/gog";
  const credentialsPath = path.join(STATE_DIR, "credentials", "client_secret.json");

  try {
    const hasCredentials = fs.existsSync(credentialsPath);

    let accounts = [];
    let gogError = null;

    if (hasCredentials) {
      try {
        const accountsResult = await runCmd(
          gogPath,
          ["auth", "list", "--json"],
          {},
          {
            GOG_KEYRING_BACKEND: process.env.GOG_KEYRING_BACKEND || "file",
            GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD || "",
            XDG_CONFIG_HOME: process.env.GOG_CONFIG_DIR || "/data/.gog-config",
          }
        );

        if (accountsResult.code === 0 && accountsResult.output) {
          try {
            const parsed = JSON.parse(accountsResult.output);
            accounts = parsed.accounts || [];
          } catch (parseErr) {
            console.log(`[google-status] Failed to parse gog output as JSON: ${parseErr.message}`);
          }
        } else if (accountsResult.code !== 0) {
          gogError = accountsResult.output || "gog command failed";
        }
      } catch (cmdErr) {
        gogError = cmdErr.message;
      }
    }

    res.json({
      ok: true,
      hasCredentials,
      hasAccounts: accounts.length > 0,
      accounts: accounts.map((a) => ({ email: a.email, services: a.services })),
      gogError,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/setup/api/google/auth-url", requireSetupAuth, async (req, res) => {
  const { email, services = "gmail" } = req.body || {};
  if (!email) {
    return res.status(400).json({ ok: false, error: "Missing email address" });
  }

  const gogPath = "/home/linuxbrew/.linuxbrew/bin/gog";
  const credentialsPath = path.join(STATE_DIR, "credentials", "client_secret.json");

  try {
    await runCmd(gogPath, ["auth", "credentials", credentialsPath], {}, {
      GOG_KEYRING_BACKEND: process.env.GOG_KEYRING_BACKEND || "file",
      GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD || "",
      XDG_CONFIG_HOME: process.env.GOG_CONFIG_DIR || "/data/.gog-config",
    });

    const result = await runCmd(
      gogPath,
      ["auth", "add", String(email), "--services", String(services), "--manual", "--remote", "--step", "1"],
      {},
      {
        GOG_KEYRING_BACKEND: process.env.GOG_KEYRING_BACKEND || "file",
        GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD || "",
        XDG_CONFIG_HOME: process.env.GOG_CONFIG_DIR || "/data/.gog-config",
      }
    );

    if (result.code !== 0) {
      return res.status(500).json({ ok: false, error: result.output });
    }

    const urlMatch = result.output?.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s]+/);
    if (!urlMatch) {
      return res.status(500).json({ ok: false, error: "Could not extract auth URL from gog output", output: result.output });
    }

    res.json({ ok: true, authUrl: urlMatch[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/setup/api/google/callback", requireSetupAuth, async (req, res) => {
  const { email, callbackUrl, services = "gmail" } = req.body || {};
  if (!email || !callbackUrl) {
    return res.status(400).json({ ok: false, error: "Missing email or callbackUrl" });
  }

  const gogPath = "/home/linuxbrew/.linuxbrew/bin/gog";

  try {
    const result = await runCmd(
      gogPath,
      ["auth", "add", String(email), "--services", String(services), "--remote", "--step", "2", "--auth-url", String(callbackUrl)],
      {},
      {
        GOG_KEYRING_BACKEND: process.env.GOG_KEYRING_BACKEND || "file",
        GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD || "",
        XDG_CONFIG_HOME: process.env.GOG_CONFIG_DIR || "/data/.gog-config",
      }
    );

    if (result.code !== 0) {
      return res.status(500).json({ ok: false, error: result.output });
    }

    res.json({ ok: true, output: result.output });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  try {
    fs.rmSync(configPath(), { force: true });
    res
      .type("text/plain")
      .send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

// ---------------------------------------------------------------------------
// Agent Configuration REST APIs (for OpenClaw Cloud Dashboard)
// ---------------------------------------------------------------------------

app.get("/setup/api/agent", requireSetupAuth, async (_req, res) => {
  try {
    if (!isConfigured()) {
      return res.json({ ok: false, error: "Not configured. Run setup first." });
    }

    const [modelResult, identityResult, channelsResult] = await Promise.all([
      runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "agents.defaults.model.primary"])),
      runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "agents.defaults.identity"])),
      runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels"])),
    ]);

    const model = modelResult.code === 0 ? modelResult.output.trim() : null;

    let identity = null;
    if (identityResult.code === 0) {
      try {
        identity = JSON.parse(identityResult.output.trim());
      } catch {
        identity = identityResult.output.trim() || null;
      }
    }

    let channels = null;
    if (channelsResult.code === 0) {
      try {
        channels = JSON.parse(channelsResult.output.trim());
      } catch {
        channels = null;
      }
    }

    const meta = readAgentMeta();
    const soulPath = path.join(WORKSPACE_DIR, "SOUL.md");
    const hasSoul = fs.existsSync(soulPath);

    return res.json({
      ok: true,
      data: { model, identity, channels, meta, hasSoul },
    });
  } catch (err) {
    console.error("[/setup/api/agent GET] error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.put("/setup/api/agent", requireSetupAuth, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.json({ ok: false, error: "Not configured. Run setup first." });
    }

    const { model, identity, meta, channels } = req.body || {};
    let needsRestart = false;
    const results = [];

    if (model) {
      const r = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "agents.defaults.model.primary", model]),
      );
      results.push({ field: "model", code: r.code, output: r.output });
      if (r.code !== 0) {
        return res.status(500).json({ ok: false, error: "Failed to set model", output: r.output });
      }
      needsRestart = true;
    }

    if (identity) {
      const r = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "--json", "agents.defaults.identity", JSON.stringify(identity)]),
      );
      results.push({ field: "identity", code: r.code, output: r.output });
      if (r.code !== 0) {
        return res.status(500).json({ ok: false, error: "Failed to set identity", output: r.output });
      }
      needsRestart = true;
    }

    if (channels && typeof channels === "object") {
      for (const [type, cfg] of Object.entries(channels)) {
        const r = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", `channels.${type}`, JSON.stringify(cfg)]),
        );
        results.push({ field: `channels.${type}`, code: r.code, output: r.output });
        if (r.code !== 0) {
          return res.status(500).json({ ok: false, error: `Failed to set channels.${type}`, output: r.output });
        }
      }
      needsRestart = true;
    }

    if (meta && typeof meta === "object") {
      const existing = readAgentMeta();
      writeAgentMeta({ ...existing, ...meta });
      results.push({ field: "meta", code: 0 });
    }

    if (needsRestart) {
      await restartGateway();
    }

    return res.json({ ok: true, data: { results } });
  } catch (err) {
    console.error("[/setup/api/agent PUT] error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/setup/api/agent/soul", requireSetupAuth, (_req, res) => {
  try {
    const soulPath = path.join(WORKSPACE_DIR, "SOUL.md");
    let content = null;
    let exists = false;
    if (fs.existsSync(soulPath)) {
      content = fs.readFileSync(soulPath, "utf8");
      exists = true;
    }
    return res.json({ ok: true, data: { content, exists } });
  } catch (err) {
    console.error("[/setup/api/agent/soul GET] error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.put("/setup/api/agent/soul", requireSetupAuth, (req, res) => {
  try {
    const { content } = req.body || {};
    if (typeof content !== "string") {
      return res.status(400).json({ ok: false, error: "content must be a string" });
    }
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    const soulPath = path.join(WORKSPACE_DIR, "SOUL.md");
    fs.writeFileSync(soulPath, content, "utf8");
    return res.json({ ok: true, data: { written: true } });
  } catch (err) {
    console.error("[/setup/api/agent/soul PUT] error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/setup/api/personas/templates", requireSetupAuth, (_req, res) => {
  const templates = PERSONA_TEMPLATES.map(({ id, name, description, category }) => ({
    id,
    name,
    description,
    category,
  }));
  return res.json({ ok: true, data: { templates } });
});

app.post("/setup/api/personas/apply", requireSetupAuth, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.json({ ok: false, error: "Not configured. Run setup first." });
    }

    const { templateId } = req.body || {};
    const template = PERSONA_TEMPLATES.find((t) => t.id === templateId);
    if (!template) {
      return res.status(400).json({ ok: false, error: `Unknown template: ${templateId}` });
    }

    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "SOUL.md"), template.soul, "utf8");

    if (template.identity) {
      const r = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "--json", "agents.defaults.identity", JSON.stringify(template.identity)]),
      );
      if (r.code !== 0) {
        return res.status(500).json({ ok: false, error: "Failed to set identity", output: r.output });
      }
    }

    if (template.model) {
      const r = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "agents.defaults.model.primary", template.model]),
      );
      if (r.code !== 0) {
        return res.status(500).json({ ok: false, error: "Failed to set model", output: r.output });
      }
    }

    const meta = readAgentMeta();
    writeAgentMeta({ ...meta, personaTemplate: templateId });

    await restartGateway();

    return res.json({ ok: true, data: { applied: templateId } });
  } catch (err) {
    console.error("[/setup/api/personas/apply] error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Skills Management REST APIs (for OpenClaw Cloud Dashboard)
// ---------------------------------------------------------------------------

const SKILL_ID_RE = /^[a-zA-Z0-9_-]+$/;

app.get("/setup/api/skills", requireSetupAuth, (_req, res) => {
  try {
    if (!fs.existsSync(SKILLS_DIR)) {
      return res.json({ ok: true, data: { skills: [] } });
    }

    const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    const skills = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = path.join(SKILLS_DIR, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      const content = fs.readFileSync(skillMdPath, "utf8");
      const meta = parseSkillFrontmatter(content);
      const hasScripts = fs.existsSync(path.join(SKILLS_DIR, entry.name, "scripts"));

      skills.push({
        id: entry.name,
        name: meta.name || entry.name,
        description: meta.description || "",
        hasScripts,
      });
    }

    return res.json({ ok: true, data: { skills } });
  } catch (err) {
    console.error("[/setup/api/skills GET] error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post(
  "/setup/api/skills/upload",
  requireSetupAuth,
  express.raw({ type: "application/gzip", limit: "10mb" }),
  async (req, res) => {
    let tmpDir = null;
    try {
      if (!req.body || !req.body.length) {
        return res.status(400).json({ ok: false, error: "Empty body. Send a .tar.gz archive." });
      }

      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-upload-"));
      const archivePath = path.join(tmpDir, "upload.tar.gz");
      fs.writeFileSync(archivePath, req.body);

      await tar.x({ file: archivePath, cwd: tmpDir });

      const extracted = fs.readdirSync(tmpDir).filter((f) => f !== "upload.tar.gz");

      if (extracted.length !== 1) {
        return res.status(400).json({
          ok: false,
          error: `Archive must contain exactly one top-level directory. Found: ${extracted.join(", ") || "(empty)"}`,
        });
      }

      const skillDirName = extracted[0];
      const extractedPath = path.join(tmpDir, skillDirName);

      if (!fs.statSync(extractedPath).isDirectory()) {
        return res.status(400).json({ ok: false, error: "Top-level entry is not a directory." });
      }

      if (!SKILL_ID_RE.test(skillDirName)) {
        return res.status(400).json({
          ok: false,
          error: `Invalid skill directory name "${skillDirName}". Use alphanumeric, hyphens, and underscores only.`,
        });
      }

      if (!fs.existsSync(path.join(extractedPath, "SKILL.md"))) {
        return res.status(400).json({
          ok: false,
          error: "Skill directory must contain a SKILL.md file.",
        });
      }

      fs.mkdirSync(SKILLS_DIR, { recursive: true });
      const destPath = path.join(SKILLS_DIR, skillDirName);
      fs.rmSync(destPath, { recursive: true, force: true });
      fs.cpSync(extractedPath, destPath, { recursive: true });

      return res.json({ ok: true, data: { installed: skillDirName } });
    } catch (err) {
      console.error("[/setup/api/skills/upload] error:", err);
      return res.status(500).json({ ok: false, error: String(err) });
    } finally {
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  },
);

app.get("/setup/api/skills/:id", requireSetupAuth, (req, res) => {
  try {
    const { id } = req.params;
    if (!SKILL_ID_RE.test(id)) {
      return res.status(400).json({ ok: false, error: "Invalid skill ID." });
    }

    const skillDir = path.join(SKILLS_DIR, id);
    const skillMdPath = path.join(skillDir, "SKILL.md");

    if (!fs.existsSync(skillMdPath)) {
      return res.status(404).json({ ok: false, error: `Skill "${id}" not found.` });
    }

    const content = fs.readFileSync(skillMdPath, "utf8");
    const meta = parseSkillFrontmatter(content);

    const files = [];
    function walk(dir, prefix) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel);
        } else {
          files.push(rel);
        }
      }
    }
    walk(skillDir, "");

    return res.json({
      ok: true,
      data: {
        id,
        name: meta.name || id,
        description: meta.description || "",
        content,
        files,
      },
    });
  } catch (err) {
    console.error("[/setup/api/skills/:id GET] error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.delete("/setup/api/skills/:id", requireSetupAuth, (req, res) => {
  try {
    const { id } = req.params;
    if (!SKILL_ID_RE.test(id)) {
      return res.status(400).json({ ok: false, error: "Invalid skill ID." });
    }

    const skillDir = path.join(SKILLS_DIR, id);
    if (!fs.existsSync(skillDir)) {
      return res.status(404).json({ ok: false, error: `Skill "${id}" not found.` });
    }

    fs.rmSync(skillDir, { recursive: true, force: true });
    return res.json({ ok: true, data: { removed: id } });
  } catch (err) {
    console.error("[/setup/api/skills/:id DELETE] error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: false, // Don't add X-Forwarded-* headers (causes "untrusted proxy" errors)
});

proxy.on("error", (err, _req, _res) => {
  console.error("[proxy]", err);
});

proxy.on("proxyReq", (proxyReq, req, res) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
});

proxy.on("proxyReqWs", (proxyReq, req, socket, options, head) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
});

// Siigo API helper
async function getSiigoToken() {
  const res = await fetch("https://api.siigo.com/auth", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Partner-ID": process.env.SIIGO_PARTNER_ID || ""
    },
    body: JSON.stringify({
      username: process.env.SIIGO_USERNAME,
      access_key: process.env.SIIGO_ACCESS_KEY
    })
  });
  const data = await res.json();
  return data.access_token;
}

// Endpoint para consultar productos de Siigo
app.get("/api/products", requireSetupAuth, async (req, res) => {
  try {
    const token = await getSiigoToken();
    const response = await fetch("https://api.siigo.com/v1/products?page=1&page_size=100", {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Partner-ID": process.env.SIIGO_PARTNER_ID || "",
        "Content-Type": "application/json"
      }
    });
    const data = await response.json();
    return res.json({ ok: true, products: data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// Caché en memoria del catálogo — evita golpear la API de Siigo en cada mensaje
let siigoCache = { productos: null, timestamp: 0 };
const SIIGO_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos

async function fetchAllSiigoProducts(token) {
  let page = 1;
  let todos = [];
  while (true) {
    const res = await fetch(`https://api.siigo.com/v1/products?page=${page}&page_size=100`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Partner-ID": process.env.SIIGO_PARTNER_ID || "",
        "Content-Type": "application/json"
      }
    });
    const data = await res.json();
    const resultados = data.results || [];
    todos = todos.concat(resultados);
    if (resultados.length < 100) break;
    page++;
    if (page > 50) break; // límite de seguridad
  }
  return todos;
}

async function getCatalogoSiigo() {
  const ahora = Date.now();
  if (siigoCache.productos && (ahora - siigoCache.timestamp) < SIIGO_CACHE_TTL_MS) {
    return siigoCache.productos; // usa el caché, no llama a Siigo
  }
  const token = await getSiigoToken();
  const productos = await fetchAllSiigoProducts(token);
  siigoCache = { productos, timestamp: ahora };
  return productos;
}

function truncarParaWhatsApp(texto, maxChars = 4000) {
  if (!texto) return texto;
  if (texto.length <= maxChars) return texto;
  return texto.slice(0, maxChars - 20) + "\n\n(Sigo aquí si necesitas más detalles 🙂)";
}

// Custom webhook endpoint for Make/Zapier integration
app.post("/api/chat", requireSetupAuth, async (req, res) => {
  const { message, sessionKey } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });
  const sk = sessionKey || "whatsapp:default";

  // Solo consultar Siigo si el mensaje es sobre productos o precios
  const palabrasClave = ["producto", "precio", "tienen", "disponible", "catálogo", "catalogo", "cuánto", "cuanto", "valor", "stock", "hay", "venden", "ofrecen", "alpina", "pedido", "quiero", "necesito", "dame"];
  const necesitaCatalogo = palabrasClave.some(p => message.toLowerCase().includes(p));

  let catalogoText = "";
  if (necesitaCatalogo) {
    try {
      const todos = await getCatalogoSiigo();
      const disponibles = todos.filter(p => p.active && p.available_quantity > 0);

      // Filtrar solo los productos que coinciden con palabras del mensaje del cliente
      const palabrasMensaje = message.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      let coincidencias = disponibles.filter(p =>
        palabrasMensaje.some(w => p.name.toLowerCase().includes(w))
      );

      // Si no hay coincidencia clara, manda una muestra general en vez de nada
      if (coincidencias.length === 0) {
        coincidencias = disponibles.slice(0, 30);
      }
      coincidencias = coincidencias.slice(0, 50); // tope de seguridad

      const productos = coincidencias.map(p => {
        const precio = p.prices?.[0]?.price_list?.find(pl => pl.name === "PRECIO TENDERO")?.value || 0;
        return `- ${p.name}: $${Math.round(precio).toLocaleString("es-CO")}`;
      }).join("\n");

      catalogoText = `\n\n[CATÁLOGO DISPONIBLE]:\n${productos}`;
    } catch (e) {
      catalogoText = "";
    }
  }

  const result = await runCmd(OPENCLAW_NODE, clawArgs([
    "agent",
    "--session-key", sk,
    "--message", message + catalogoText,
    "--json"
  ]));

  // Extraer el bloque JSON real, ignorando líneas de log que a veces vienen mezcladas
  let parsed = null;
  const lineas = (result.output || "").split("\n");
  let inicio = -1, fin = -1;
  for (let i = 0; i < lineas.length; i++) {
    if (lineas[i].trim() === "{") { inicio = i; break; }
  }
  if (inicio !== -1) {
    for (let i = lineas.length - 1; i > inicio; i--) {
      if (lineas[i].trim() === "}") { fin = i; break; }
    }
  }
  if (inicio !== -1 && fin !== -1) {
    try {
      parsed = JSON.parse(lineas.slice(inicio, fin + 1).join("\n"));
    } catch {
      parsed = null;
    }
  }

  let textoFinal =
    parsed?.finalAssistantVisibleText ||
    parsed?.meta?.finalAssistantVisibleText ||
    parsed?.payloads?.[0]?.text ||
    (result.output || "").trim(); // nunca "": si no hay campo esperado, usa el texto crudo

  // Última red de seguridad: si de verdad no hay nada de texto, nunca mandes vacío a WhatsApp
  if (!textoFinal || !textoFinal.trim()) {
    textoFinal = "Disculpa, tuve un problema procesando tu mensaje. ¿Puedes repetirlo? 🙏";
  }

  textoFinal = truncarParaWhatsApp(textoFinal);

  return res.json({
    ok: true,
    reply: { finalAssistantVisibleText: textoFinal },
    _debugParsed: parsed,                 // TEMPORAL — quitar cuando confirmemos la causa
    _debugRawOutputLength: (result.output || "").length, // TEMPORAL
  });
});

app.use(async (req, res) => {
  // Only start gateway if configured AND onboarding is not in progress
  // The onboardingInProgress flag prevents race conditions during config changes
  if (isConfigured() && !onboardingInProgress) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      return res
        .status(503)
        .type("text/plain")
        .send(`Gateway not ready: ${String(err)}`);
    }
  }

  // Proxy to gateway (auth token injected via proxyReq event)
  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

// Create HTTP server from Express app
const server = app.listen(PORT, () => {
  console.log(`[wrapper] listening on port ${PORT}`);
  console.log(`[wrapper] setup wizard: http://localhost:${PORT}/setup`);
  console.log(`[wrapper] configured: ${isConfigured()}`);
});

// Handle WebSocket upgrades
server.on("upgrade", async (req, socket, head) => {
  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  if (onboardingInProgress) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }

  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

process.on("SIGTERM", () => {
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(0);
});
