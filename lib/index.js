/**
 * Google Antigravity / Cloud Code Assist adapter for DeepSeek Harness.
 *
 * This plugin is intentionally shaped like a DSH Web plugin: Cordis loads this
 * module, `apply()` registers a harness LlmAdapter, and OAuth credentials live
 * under DSH home. It does not require an external Antigravity CLI.
 */
import { createHash, randomBytes } from "node:crypto";
import { FileAccountStore, normalizeProxyPolicy } from "./account-store.js";
import { FileUsageStore } from "./usage-store.js";
import { FileSessionAccountStore } from "./session-accounts.js";
import { registerAccountCommand } from "./account-command.js";
import { accountScope, providerFetch, runWithTransport, streamWithTransport, disposeTransports, testProxy } from "./transport.js";
import { createOAuthFlow, refreshOAuth } from "./oauth.js";
import { agyCliStatus, writeAgyCliDocument } from "./agy-cli.js";
import { discoverDockerProxies } from "./docker-proxies.js";
export { FileAccountStore } from "./account-store.js";
export { FileUsageStore, summarizeUsage, normalizeUsage } from "./usage-store.js";
export { FileSessionAccountStore, normalizeSessionAccounts } from "./session-accounts.js";
export { ACCOUNT_COMMAND_NAME, describeAccounts, findAccount, runAccountCommand } from "./account-command.js";
import { createServer } from "node:http";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  ToolCallId,
  ToolCallId as CallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
} from "@deepseek-ai/dsh-llm";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import z from "@deepseek-ai/schemastery";

export const PROVIDER = "antigravity";
export const PROVIDER_NAME = "Antigravity";
export const name = "dsh-antigravity";
export const inject = ["llm"];

/** Hard cap on account attempts for one request: one per account plus a stale-pin margin. */
const ACCOUNT_ATTEMPT_LIMIT = 8;

/**
 * Account states that can serve a request. `refresh-required` only means the
 * access token expired; the stored refresh token renews it on demand.
 */
const USABLE_ACCOUNT_STATES = new Set(["ready", "refresh-required"]);

/**
 * The context capacity every Antigravity model is reported with.
 *
 * `maxContextWindow` is a ceiling rather than a default: it lowers whatever the
 * model or the live catalog claims and never raises it, so a cap can only make
 * the harness condense earlier, never later. The harness compacts at a share of
 * this window (compaction-basic's `thresholdRatio`, 0.8 by default) after
 * reserving completion tokens and its own headroom, so the trigger lands below
 * the cap: a 750,000 cap condenses at roughly 600,000 tokens.
 */
export const Config = z.object({
  maxContextWindow: z.number().step(1).min(1)
    .description("Ceiling for the context window reported by every Antigravity model; unset reports the catalog value (1,048,576 for Gemini). Lower it to make the harness compact earlier and spend less quota per request."),
  failoverOnQuota: z.boolean().default(true)
    .description("When the account a request uses reports quota exhaustion, retry that step on the next signed-in account and remember it for the session. Pinned sessions move only after their own account is exhausted."),
  streamIdleTimeoutMs: z.number().step(1).min(1000).default(120_000)
    .description("Maximum milliseconds a stream may go without emitting a chunk (including time-to-first-chunk) before aborting with TIMEOUT so the harness retries on a fresh connection."),
});

const STREAM_IDLE_TIMEOUT_MS = 120_000;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
const DISCOVERY_TIMEOUT_MS = 8000;
const PROJECT_CACHE_TTL_MS = 30 * 60 * 1000;
const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
// The Antigravity client and preview Gemini models (Carbon, Hydrogen, Argon)
// live on `daily-cloudcode-pa.sandbox.googleapis.com`; `cloudcode-pa` rejects
// consumer tokens with 429 or returns 404 on preview tiers, so keep it only as
// the secondary fallback to avoid uploading large payloads twice per step.
const DAILY_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ENDPOINT_FALLBACKS = [
  DAILY_ENDPOINT,
  DEFAULT_ENDPOINT,
];

const REDIRECT_PATH = "/oauth-callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

const DEFAULT_CLIENT_ID = Buffer.from(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc" +
    "C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
  "base64",
).toString("utf8");
const DEFAULT_CLIENT_SECRET = Buffer.from(
  "R09DU1BYLUs1OEZXUjQ" + "4NkxkTEoxbUxCOHNYQzR6NnFEQWY=",
  "base64",
).toString("utf8");

const PLATFORM =
  process.platform === "darwin" ? "MACOS" : process.platform === "win32" ? "WINDOWS" : "LINUX";
// Identifies the plugin as the Antigravity CLI build the service accepts; see
// defaultUserAgent() for why the `cli` segment cannot be dropped.
const ANTIGRAVITY_CLIENT_VERSION = "1.3.4";
const ANTIGRAVITY_CLIENT_BUILD = "998275202";
const GEMINI_ROLE = {
  user: "user",
  model: "model",
};
const TOOL_CALLING_MODE = {
  none: "NONE",
  any: "ANY",
  auto: "AUTO",
  validated: "VALIDATED",
};

const ROUTING = {
  "claude-opus-5.5": {
    off: "claude-opus-5-5-high",
    routing: {
      minimal: "claude-opus-5-5-low",
      low: "claude-opus-5-5-low",
      medium: "claude-opus-5-5-medium",
      high: "claude-opus-5-5-high",
      xhigh: "claude-opus-5-5-high",
    },
    defaultRequestId: "claude-opus-5-5-high",
  },
  "claude-sonnet-5.5": {
    off: "claude-sonnet-5-5-high",
    routing: {
      minimal: "claude-sonnet-5-5-low",
      low: "claude-sonnet-5-5-low",
      medium: "claude-sonnet-5-5-medium",
      high: "claude-sonnet-5-5-high",
      xhigh: "claude-sonnet-5-5-high",
    },
    defaultRequestId: "claude-sonnet-5-5-high",
  },
  "claude-opus-4-6": {
    off: "claude-opus-4-6-thinking",
    routing: {
      minimal: "claude-opus-4-6-thinking",
      low: "claude-opus-4-6-thinking",
      medium: "claude-opus-4-6-thinking",
      high: "claude-opus-4-6-thinking",
      xhigh: "claude-opus-4-6-thinking",
    },
    defaultRequestId: "claude-opus-4-6-thinking",
  },
  "claude-sonnet-4-6": {
    off: "claude-sonnet-4-6-thinking",
    routing: {
      minimal: "claude-sonnet-4-6-thinking",
      low: "claude-sonnet-4-6-thinking",
      medium: "claude-sonnet-4-6-thinking",
      high: "claude-sonnet-4-6-thinking",
      xhigh: "claude-sonnet-4-6-thinking",
    },
    defaultRequestId: "claude-sonnet-4-6-thinking",
  },
  // Gemini 4 Argon is exposed upstream as one pinned id per reasoning level, so
  // the effort must pick the id rather than a thinkingConfig level. The bare
  // `gemini-4-argon` id is not a servable model; only the tiered ids are.
  "gemini-4-argon": {
    off: "gemini-4-argon-low",
    routing: {
      minimal: "gemini-4-argon-low",
      low: "gemini-4-argon-low",
      medium: "gemini-4-argon-medium",
      high: "gemini-4-argon-high",
      xhigh: "gemini-4-argon-high",
    },
    defaultRequestId: "gemini-4-argon-high",
  },
  "gemini-4-carbon": {
    off: "gemini-4-carbon-low",
    routing: {
      minimal: "gemini-4-carbon-low",
      low: "gemini-4-carbon-low",
      medium: "gemini-4-carbon-medium",
      high: "gemini-4-carbon-high",
      xhigh: "gemini-4-carbon-high",
    },
    defaultRequestId: "gemini-4-carbon-high",
  },
  "gemini-4-hydrogen": {
    off: "gemini-4-hydrogen-low",
    routing: {
      minimal: "gemini-4-hydrogen-low",
      low: "gemini-4-hydrogen-low",
      medium: "gemini-4-hydrogen-medium",
      high: "gemini-4-hydrogen-high",
      xhigh: "gemini-4-hydrogen-xhigh",
    },
    defaultRequestId: "gemini-4-hydrogen-high",
  },
  "gemini-3.7-flash": {
    off: "gemini-3.7-flash-tiered",
    routing: {
      minimal: "gemini-3.7-flash-tiered",
      low: "gemini-3.7-flash-tiered",
      medium: "gemini-3.7-flash-tiered",
      high: "gemini-3.7-flash-tiered",
      xhigh: "gemini-3.7-flash-tiered",
    },
    defaultRequestId: "gemini-3.7-flash-tiered",
  },
  "gemini-3.6-flash": {
    off: "gemini-3.6-flash-low",
    routing: {
      minimal: "gemini-3.6-flash-low",
      low: "gemini-3.6-flash-low",
      medium: "gemini-3.6-flash-medium",
      high: "gemini-3.6-flash-high",
      xhigh: "gemini-3.6-flash-high",
    },
    defaultRequestId: "gemini-3.6-flash-high",
  },
  "gemini-3.5-flash": {
    off: "gemini-3.5-flash-extra-low",
    routing: {
      minimal: "gemini-3.5-flash-extra-low",
      low: "gemini-3.5-flash-low",
      medium: "gemini-3.5-flash-low",
      high: "gemini-3-flash-agent",
      xhigh: "gemini-3-flash-agent",
    },
    defaultRequestId: "gemini-3-flash-agent",
  },
  "gemini-3.1-pro": {
    off: "gemini-3.1-pro-low",
    routing: {
      minimal: "gemini-3.1-pro-low",
      low: "gemini-3.1-pro-low",
      medium: "gemini-pro-agent",
      high: "gemini-pro-agent",
      xhigh: "gemini-pro-agent",
    },
    defaultRequestId: "gemini-pro-agent",
  },
  "gemini-3.1-flash-image": {
    off: "gemini-3.1-flash-image",
    routing: {
      minimal: "gemini-3.1-flash-image",
      low: "gemini-3.1-flash-image",
      medium: "gemini-3.1-flash-image",
      high: "gemini-3.1-flash-image",
      xhigh: "gemini-3.1-flash-image",
    },
    defaultRequestId: "gemini-3.1-flash-image",
  },
  "gemini-3-flash": {
    off: "gemini-3-flash",
    routing: {
      minimal: "gemini-3-flash",
      low: "gemini-3-flash",
      medium: "gemini-3-flash",
      high: "gemini-3-flash",
      xhigh: "gemini-3-flash",
    },
    defaultRequestId: "gemini-3-flash",
  },
  "gemini-2.5-pro": {
    off: "gemini-2.5-pro",
    routing: {
      minimal: "gemini-2.5-pro",
      low: "gemini-2.5-pro",
      medium: "gemini-2.5-pro",
      high: "gemini-2.5-pro",
      xhigh: "gemini-2.5-pro",
    },
    defaultRequestId: "gemini-2.5-pro",
  },
  "gemini-2.5-flash": {
    off: "gemini-2.5-flash",
    routing: {
      minimal: "gemini-2.5-flash",
      low: "gemini-2.5-flash",
      medium: "gemini-2.5-flash",
      high: "gemini-2.5-flash",
      xhigh: "gemini-2.5-flash",
    },
    defaultRequestId: "gemini-2.5-flash",
  },
  "gpt-oss-120b": {
    off: "gpt-oss-120b-medium",
    routing: {
      minimal: "gpt-oss-120b-medium",
      low: "gpt-oss-120b-medium",
      medium: "gpt-oss-120b-medium",
      high: "gpt-oss-120b-medium",
      xhigh: "gpt-oss-120b-medium",
    },
    defaultRequestId: "gpt-oss-120b-medium",
  },
};

const RUNTIME_MAX_OUTPUT_TOKENS = {
  "claude-opus-5-5-high": 64000,
  "claude-opus-5-5-low": 64000,
  "claude-opus-5-5-medium": 64000,
  "claude-sonnet-5-5-high": 64000,
  "claude-sonnet-5-5-low": 64000,
  "claude-sonnet-5-5-medium": 64000,
  // Kept explicit so the ceiling survives a failed or stale catalog fetch
  // rather than falling through to the generic gemini-* default; the live
  // catalog reports the same 65536 maxOutputTokens for these tiers.
  "gemini-4-argon-low": 65536,
  "gemini-4-argon-medium": 65536,
  "gemini-4-argon-high": 65536,
  "gemini-4-carbon-low": 65536,
  "gemini-4-carbon-medium": 65536,
  "gemini-4-carbon-high": 65536,
  "gemini-4-hydrogen-low": 262144,
  "gemini-4-hydrogen-medium": 262144,
  "gemini-4-hydrogen-high": 262144,
  "gemini-4-hydrogen-xhigh": 262144,
  "gemini-3.7-flash": 65536,
  "gemini-3.7-flash-tiered": 65536,
  "gemini-3.7-flash-low": 65536,
  "gemini-3.7-flash-medium": 65536,
  "gemini-3.7-flash-high": 65536,
  "gemini-3.6-flash": 65536,
  "gemini-3.6-flash-low": 65536,
  "gemini-3.6-flash-medium": 65536,
  "gemini-3.6-flash-high": 65536,
  "gemini-3.5-flash": 65536,
  "gemini-3.5-flash-extra-low": 65536,
  "gemini-3.5-flash-low": 65536,
  "gemini-3-flash-agent": 65536,
  "gemini-3.1-pro": 65535,
  "gemini-3.1-pro-low": 65535,
  "gemini-3.1-pro-high": 65535,
  "gemini-pro-agent": 65535,
  "claude-opus-4-6": 64000,
  "claude-opus-4-6-thinking": 64000,
  "claude-sonnet-4-6": 64000,
  "gpt-oss-120b": 32768,
  "gpt-oss-120b-medium": 32768,
};

const MODELS = [
  {
    id: "claude-opus-5.5",
    name: "Claude Opus 5.5",
    inputModalities: ["text", "image"],
    contextWindow: 250000,
    maxTokens: 64000,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "claude-sonnet-5.5",
    name: "Claude Sonnet 5.5",
    inputModalities: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    reasoningEfforts: ["low", "medium", "high"],
  },
  // The pinned Claude 5.5 reasoning tiers, selectable as their own models.
  // Upstream exposes one id per tier, so there is no ROUTING entry: the id is
  // sent through unchanged and each entry offers only the level it pins.
  {
    id: "claude-opus-5-5-high",
    name: "Claude Opus 5.5 (High)",
    inputModalities: ["text", "image"],
    contextWindow: 250000,
    maxTokens: 64000,
    reasoningEfforts: ["high"],
  },
  {
    id: "claude-opus-5-5-medium",
    name: "Claude Opus 5.5 (Medium)",
    inputModalities: ["text", "image"],
    contextWindow: 250000,
    maxTokens: 64000,
    reasoningEfforts: ["medium"],
  },
  {
    id: "claude-opus-5-5-low",
    name: "Claude Opus 5.5 (Low)",
    inputModalities: ["text", "image"],
    contextWindow: 250000,
    maxTokens: 64000,
    reasoningEfforts: ["low"],
  },
  {
    id: "claude-sonnet-5-5-high",
    name: "Claude Sonnet 5.5 (High)",
    inputModalities: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    reasoningEfforts: ["high"],
  },
  {
    id: "claude-sonnet-5-5-medium",
    name: "Claude Sonnet 5.5 (Medium)",
    inputModalities: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    reasoningEfforts: ["medium"],
  },
  {
    id: "claude-sonnet-5-5-low",
    name: "Claude Sonnet 5.5 (Low)",
    inputModalities: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    reasoningEfforts: ["low"],
  },
  // One Argon entry with a reasoning selector, matching how the other Gemini
  // models are offered: the effort chooses the pinned upstream id through
  // ROUTING. The catalog reports the three pinned tiers but never a bare
  // `gemini-4-argon`, so this entry is what keeps the picker to a single Argon
  // row with Low/Medium/High instead of three near-duplicate ones.
  {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-4-carbon",
    name: "Gemini 4 Carbon",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 262144,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65535,
    reasoningEfforts: ["low", "high"],
  },
  {
    id: "gemini-3.1-flash-image",
    name: "Gemini 3.1 Flash Image",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "high"],
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    inputModalities: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    inputModalities: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    reasoningEfforts: ["high"],
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    inputModalities: ["text", "image"],
    contextWindow: 250000,
    maxTokens: 64000,
    reasoningEfforts: ["high"],
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    inputModalities: ["text"],
    contextWindow: 131072,
    maxTokens: 32768,
    reasoningEfforts: ["medium"],
  },
];

const TIER_ALIASES = new Map([
  ["gemini-4-argon-low", "gemini-4-argon"],
  ["gemini-4-argon-medium", "gemini-4-argon"],
  ["gemini-4-argon-high", "gemini-4-argon"],
  ["gemini-4-carbon-low", "gemini-4-carbon"],
  ["gemini-4-carbon-medium", "gemini-4-carbon"],
  ["gemini-4-carbon-high", "gemini-4-carbon"],
  ["gemini-4-hydrogen-low", "gemini-4-hydrogen"],
  ["gemini-4-hydrogen-medium", "gemini-4-hydrogen"],
  ["gemini-4-hydrogen-high", "gemini-4-hydrogen"],
  ["gemini-4-hydrogen-xhigh", "gemini-4-hydrogen"],
]);

const diagnostics = {
  endpoint: "",
  status: undefined,
  projectId: "",
  resolvedRuntimeModel: "",
  availableModels: "",
  matchedModelDebug: "",
  error: "",
  transientErrors: [],
  retries: 0,
  fallbackModelSwitches: 0,
};

function recordTransientError(status, modelId, endpoint, message) {
  diagnostics.transientErrors = diagnostics.transientErrors || [];
  diagnostics.transientErrors.push({
    timestamp: Date.now(),
    status,
    modelId,
    endpoint,
    message: redactSecrets(message || ""),
  });
  if (diagnostics.transientErrors.length > 20) {
    diagnostics.transientErrors.shift();
  }
}

const projectCache = new Map();
const modelCache = new Map();
const inFlightModelLookups = new Map();
const quotaCache = new Map();
const accountCatalogs = new Map();
const authErrors = new Map();
let webLoginFlow = undefined;
let loginTransition = Promise.resolve();

// Every provider operation carries a captured account through all async work.
async function captureAccount(store, accountId) {
  if (store.accountId) return store;
  if (typeof store.capture === "function") {
    const captured = await store.capture(accountId);
    if (!captured) throw new LlmError("No active Antigravity account. Sign in in Settings.", "AUTH");
    return captured;
  }
  return store; // Compatibility for externally supplied single-credential stores.
}

function accountCacheKey(store = accountScope.getStore()?.account) {
  return `${store?.path?.() || ""}:${store?.accountId || "legacy"}:${store?.credentialRevision || 0}:${store?.proxy?.revision || 0}`;
}

/**
 * The fetched model catalog is account metadata, not credential state.
 *
 * Keying it by `accountCacheKey` orphaned it on every on-demand token refresh
 * (a refresh bumps credentialRevision), and the static MODELS fallback then
 * dropped catalog-only models — gemini-3.8-flash-tiered among them — from the
 * picker until the next quota fetch repopulated the cache.
 */
export function catalogCacheKey(store) {
  return `${store?.path?.() || ""}:${store?.accountId || "legacy"}`;
}

function lookupCacheKey(token) {
  // Do not retain credentials as cache keys; generation also separates proxy edits.
  return `${accountCacheKey()}:${createHash("sha256").update(token).digest("hex")}`;
}

async function accountSettings(modelSettings, captured) {
  const settings = await modelSettings.read();
  const catalog = accountCatalogs.get(catalogCacheKey(captured));
  // The in-memory catalog is empty on a fresh process and after an account
  // switch. The picker used to fall through to the static MODELS table there,
  // which silently dropped every catalog-only model (gemini-3.8-flash-tiered
  // among them) until a quota fetch happened to run. The persisted catalog is
  // the last known good list and is what the settings API already serves.
  return { ...settings, catalogModels: catalog || settings.catalogModels };
}

function clearAccountRuntime() {
  quotaCache.clear(); accountCatalogs.clear(); authErrors.clear();
  projectCache.clear(); modelCache.clear(); inFlightModelLookups.clear();
}

function transitionLogin(operation) {
  const next = loginTransition.then(operation, operation);
  loginTransition = next.catch(() => {});
  return next;
}

let toolCallCounter = 0;

export function credentialPath() {
  return dshHomePath("storages", "antigravity-oauth.json");
}

export function modelSettingsPath() {
  return dshHomePath("storages", "antigravity-settings.json");
}

export function usagePath() {
  return dshHomePath("storages", "antigravity-usage.json");
}

export function sessionAccountsPath() {
  return dshHomePath("storages", "antigravity-sessions.json");
}

const DEFAULT_ENABLED_MODEL_IDS = MODELS.map((model) => model.id);

function antigravityEnv(namePart) {
  return process.env[`ANTIGRAVITY_${namePart}`] || process.env[`NOAGY_${namePart}`];
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeText(text) {
  return String(text ?? "").replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nowRequestId() {
  return `antigravity-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function redactSecrets(text) {
  return String(text)
    .replace(/\bya29\.[A-Za-z0-9._~+/-]+=*/g, "[redacted-access-token]")
    .replace(/\b1\/[A-Za-z0-9_-]{20,}/g, "[redacted-refresh-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replace(
      /("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*)[^\s&,}]+/gi,
      "$1[redacted]",
    );
}

function safeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw);
}

function setLastEndpoint(endpoint) {
  diagnostics.endpoint = endpoint || "";
}

function setLastStatus(status) {
  diagnostics.status = status;
}

function setLastProjectId(projectId) {
  diagnostics.projectId = projectId || "";
}

function setLastResolvedRuntimeModel(modelId) {
  diagnostics.resolvedRuntimeModel = modelId || "";
}

function setLastAvailableModels(text) {
  diagnostics.availableModels = text || "";
}

function setLastMatchedModelDebug(text) {
  diagnostics.matchedModelDebug = text || "";
}

function setLastError(error) {
  diagnostics.error = safeError(error || "");
}

export function getAntigravityDiagnostics() {
  return { ...diagnostics };
}

function assertSafeApiBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ANTIGRAVITY_BASE_URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`ANTIGRAVITY_BASE_URL must use https (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new Error("ANTIGRAVITY_BASE_URL must not include credentials");
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    host === "googleapis.com" ||
    host.endsWith(".googleapis.com") ||
    host.endsWith(".sandbox.googleapis.com");
  if (!allowed) {
    throw new Error(
      `ANTIGRAVITY_BASE_URL host "${host}" is not allowed. Use a *.googleapis.com endpoint.`,
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

function endpointCandidates() {
  const explicit = antigravityEnv("BASE_URL")?.trim();
  return explicit ? [assertSafeApiBaseUrl(explicit)] : ENDPOINT_FALLBACKS;
}

/** Quota must come from the same endpoint the Antigravity client uses. */
export function quotaEndpointCandidates() {
  const explicit = antigravityEnv("BASE_URL")?.trim();
  if (explicit) return [assertSafeApiBaseUrl(explicit)];
  return [DAILY_ENDPOINT, ...endpointCandidates().filter((endpoint) => endpoint !== DAILY_ENDPOINT)];
}

function resolveCallbackHost(raw = antigravityEnv("CALLBACK_HOST")) {
  const host = (raw || "127.0.0.1").trim().toLowerCase();
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(host)) {
    throw new Error(
      `Unsafe ANTIGRAVITY_CALLBACK_HOST="${host}". Only loopback hosts are allowed: 127.0.0.1, ::1, localhost.`,
    );
  }
  return host === "localhost" ? "127.0.0.1" : host;
}

function callbackPort() {
  const raw = antigravityEnv("CALLBACK_PORT");
  if (!raw) return 51121;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid ANTIGRAVITY_CALLBACK_PORT: ${raw}`);
  }
  return parsed;
}

function redirectUri() {
  return `http://localhost:${callbackPort()}${REDIRECT_PATH}`;
}

export function clientId() {
  return antigravityEnv("CLIENT_ID") || DEFAULT_CLIENT_ID;
}

export function clientSecret() {
  return antigravityEnv("CLIENT_SECRET") || DEFAULT_CLIENT_SECRET;
}

/**
 * The service gates model availability on the client identity in `User-Agent`,
 * not on the account or project. Measured against the same token and project:
 *
 *   antigravity/1.15.8 linux/amd64                  -> 404 for Gemini 4 Argon
 *   antigravity/cli/1.3.4 (aidev_client; ...)       -> 200, and the catalog
 *                                                      lists the Argon tiers
 *   antigravity-cli/1.3.4                           -> 404
 *   (no User-Agent at all)                          -> 403 "You do not have a
 *                                                      valid license of this
 *                                                      product"
 *
 * So the `antigravity/cli` segment is load-bearing: without it the Argon tiers
 * are invisible in `fetchAvailableModels` and every request for them is refused.
 * The version and the parenthetical fields are not checked individually — a
 * longer or shorter tail all answered 200 — but the shape below mirrors what the
 * real CLI sends. Override with ANTIGRAVITY_USER_AGENT if that ever changes.
 */
function defaultUserAgent() {
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `antigravity/cli/${ANTIGRAVITY_CLIENT_VERSION} (aidev_client; os_type=${os}; arch=${arch}; cl=${ANTIGRAVITY_CLIENT_BUILD}; auth_method=consumer)`;
}

function antigravityHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": antigravityEnv("USER_AGENT") || defaultUserAgent(),
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({
      ideType: "ANTIGRAVITY",
      platform: PLATFORM,
      pluginType: "GEMINI",
    }),
  };
}

function attributionHeaderBag() {
  try {
    return attributionHeaders() || {};
  } catch {
    return {};
  }
}

function jsonOrTextError(text) {
  const parsed = safeJsonParse(text);
  if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
    return parsed.error.message;
  }
  return text;
}

function jsonHeaders(token) {
  return {
    ...antigravityHeaders(token),
    Accept: "application/json",
  };
}

function stableProjectId(seed) {
  const bytes = createHash("sha1").update(`antigravity:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultProjectId(seed = "antigravity-default") {
  return antigravityEnv("PROJECT_ID")?.trim() || stableProjectId(seed);
}

function extractProjectId(data) {
  if (!isRecord(data)) return undefined;
  const direct =
    data.antigravityProjectId ??
    data.projectId ??
    data.backendProjectId ??
    data.userDefinedCloudaicompanionProject ??
    data.cloudaicompanionProject ??
    data.project;
  const directId = asString(direct);
  if (directId) return directId;
  if (isRecord(direct)) {
    const nestedId = asString(direct.id);
    if (nestedId) return nestedId;
  }
  for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
    const value = data[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = extractProjectId(item);
        if (nested) return nested;
        const itemId = asString(item);
        if (itemId) return itemId;
      }
    }
  }
  return undefined;
}

async function listCloudAICompanionProjects(token) {
  for (const endpoint of endpointCandidates()) {
    try {
      const response = await providerFetch(`${endpoint}/v1internal:listCloudAICompanionProjects`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      setLastStatus(response.status);
      setLastEndpoint(endpoint);
      if (!response.ok) continue;
      return extractProjectId(await response.json());
    } catch (error) {
      setLastError(error);
    }
  }
  return undefined;
}

async function loadCodeAssistUncached(token) {
  const body = JSON.stringify({
    metadata: {
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  });
  for (const endpoint of endpointCandidates()) {
    try {
      const response = await providerFetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      setLastStatus(response.status);
      setLastEndpoint(endpoint);
      if (!response.ok) continue;
      const project = extractProjectId(await response.json());
      if (project) return project;
      return await listCloudAICompanionProjects(token);
    } catch (error) {
      setLastError(error);
    }
  }
  return undefined;
}

async function loadCodeAssist(token) {
  const key = lookupCacheKey(token);
  const cached = projectCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    projectCache.delete(key);
    projectCache.set(key, cached);
    return cached.projectId;
  }
  const projectId = await loadCodeAssistUncached(token);
  projectCache.set(key, { projectId, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });
  if (projectCache.size > 32) {
    const oldestKey = projectCache.keys().next().value;
    if (oldestKey !== undefined) projectCache.delete(oldestKey);
  }
  return projectId;
}

function resolveProjectId(options) {
  return (
    antigravityEnv("PROJECT_ID")?.trim() ||
    options.warmedProject ||
    options.credentialProjectId ||
    defaultProjectId(options.email || "antigravity-default")
  );
}

function collectModelLabels(value, out = []) {
  if (!value || out.length > 50) return out;
  if (typeof value === "string") {
    if (/gemini|claude|gpt-oss/i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectModelLabels(item, out);
    return out;
  }
  if (isRecord(value)) {
    for (const key of ["id", "name", "label", "displayName", "model", "modelId"]) {
      collectModelLabels(value[key], out);
    }
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") collectModelLabels(nested, out);
    }
  }
  return out;
}

function summarizeModelCandidate(value) {
  if (!isRecord(value)) return String(value ?? "none");
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token|auth|credential|secret|email/i.test(key)) continue;
    if (raw === null || ["string", "number", "boolean"].includes(typeof raw)) out[key] = raw;
    else if (Array.isArray(raw)) out[key] = `[array:${String(raw.length)}]`;
    else if (isRecord(raw)) out[key] = `{${Object.keys(raw).slice(0, 12).join(",")}}`;
  }
  return JSON.stringify(out).slice(0, 1200);
}

function isUsableRuntimeModelId(id) {
  return /^(gemini-|claude-|gpt-oss-)/i.test(id) && !/\s/.test(id) && !/^MODEL_/i.test(id);
}

function buildModelMatchRegex(requestedId) {
  const requested = requestedId.toLowerCase();
  if (requested === "gemini-3.7-flash-low") return /gemini[- ]3\.7[- ]flash \(low\)/i;
  if (requested === "gemini-3.7-flash-medium") return /gemini[- ]3\.7[- ]flash \(medium\)/i;
  if (requested === "gemini-3.7-flash-high") return /gemini[- ]3\.7[- ]flash \(high\)/i;
  if (requested === "gemini-3.6-flash-low") return /gemini[- ]3\.6[- ]flash \(low\)/i;
  if (requested === "gemini-3.6-flash-medium") return /gemini[- ]3\.6[- ]flash \(medium\)/i;
  if (requested === "gemini-3.6-flash-high") return /gemini[- ]3\.6[- ]flash \(high\)/i;
  if (requested === "gemini-3.5-flash-extra-low") return /gemini[- ]3\.5[- ]flash \(low\)/i;
  if (requested === "gemini-3.5-flash-low" || requested === "gemini-3.5-flash-medium") {
    return /gemini[- ]3\.5[- ]flash \(medium\)/i;
  }
  if (requested === "gemini-3.5-flash-high" || requested === "gemini-3-flash-agent") {
    return /gemini[- ]3\.5[- ]flash \(high\)/i;
  }
  if (requested.includes("claude-opus-4-6")) return /claude.*opus.*4\.6/i;
  if (requested.includes("claude-sonnet-4-6")) return /claude.*sonnet.*4\.6/i;
  if (requested.includes("gpt-oss-120b")) return /gpt.*oss.*120b/i;
  if (requested === "gemini-3.1-pro-low") return /gemini[- ]3\.1[- ]pro \(low\)/i;
  if (requested === "gemini-3.1-pro-high" || requested === "gemini-pro-agent") {
    return /gemini[- ]3\.1[- ]pro \(high\)/i;
  }
  const escaped = escapeRegExp(requested).replace(/\\-/g, "[- ]");
  return new RegExp(escaped, "i");
}

function dynamicModelFromInfo(modelId, info) {
  if (!isRecord(info)) return { id: modelId };
  setLastMatchedModelDebug(summarizeModelCandidate({ modelId, ...info }));
  const experiments = Array.isArray(info.modelExperiments)
    ? info.modelExperiments.filter((item) => typeof item === "string")
    : undefined;
  return {
    id: modelId,
    experiments,
    apiProvider: asString(info.apiProvider),
    modelProvider: asString(info.modelProvider),
  };
}

function findDynamicModel(value, requestedId) {
  if (!value) return undefined;
  if (isRecord(value) && isRecord(value.models)) {
    const modelsMap = value.models;
    if (isUsableRuntimeModelId(requestedId) && requestedId in modelsMap) {
      return dynamicModelFromInfo(requestedId, modelsMap[requestedId]);
    }
    const targetRegex = buildModelMatchRegex(requestedId);
    for (const [modelId, info] of Object.entries(modelsMap)) {
      if (!isUsableRuntimeModelId(modelId)) continue;
      if (targetRegex.test(modelId)) return dynamicModelFromInfo(modelId, info);
      if (isRecord(info)) {
        const label = info.label ?? info.displayName ?? info.name;
        if (typeof label === "string" && targetRegex.test(label)) {
          return dynamicModelFromInfo(modelId, info);
        }
      }
    }
    return undefined;
  }
  const targetRegex = buildModelMatchRegex(requestedId);
  if (typeof value === "string") {
    return targetRegex.test(value) && isUsableRuntimeModelId(value) ? { id: value } : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDynamicModel(item, requestedId);
      if (found) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") {
        const found = findDynamicModel(nested, requestedId);
        if (found) return found;
      }
    }
  }
  return undefined;
}

async function fetchAvailableRuntimeModelUncached(token, projectId, requestedRuntimeModel) {
  const bodies = [{ project: projectId }];
  const attempts = endpointCandidates().flatMap((endpoint) =>
    bodies.map((body) => ({ endpoint, body })),
  );
  const settled = await Promise.all(
    attempts.map(async ({ endpoint, body }) => {
      try {
        const response = await providerFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: "POST",
          headers: antigravityHeaders(token),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });
        if (!response.ok) return { endpoint, status: response.status, data: undefined };
        return { endpoint, status: response.status, data: await response.json() };
      } catch (error) {
        setLastError(error);
        return { endpoint, status: undefined, data: undefined };
      }
    }),
  );
  let lastLabels = "";
  for (const { endpoint, status, data } of settled) {
    if (status !== undefined) setLastStatus(status);
    if (data === undefined) continue;
    setLastEndpoint(endpoint);
    const labels = [...new Set(collectModelLabels(data))].slice(0, 16);
    if (labels.length) lastLabels = labels.join(",");
    const found = findDynamicModel(data, requestedRuntimeModel);
    if (found) {
      if (lastLabels) setLastAvailableModels(lastLabels);
      return found;
    }
  }
  if (lastLabels) setLastAvailableModels(lastLabels);
  return undefined;
}

async function fetchAvailableRuntimeModel(token, projectId, requestedRuntimeModel) {
  const cacheKey = `${lookupCacheKey(token)}::${projectId}::${requestedRuntimeModel}`;
  const cached = modelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const inFlight = inFlightModelLookups.get(cacheKey);
  if (inFlight) return inFlight;
  const promise = fetchAvailableRuntimeModelUncached(token, projectId, requestedRuntimeModel).then(
    (result) => {
      modelCache.set(cacheKey, { result, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
      return result;
    },
  );
  inFlightModelLookups.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlightModelLookups.delete(cacheKey);
    if (modelCache.size > 64) {
      const now = Date.now();
      for (const [key, entry] of modelCache) {
        if (entry.expiresAt <= now) modelCache.delete(key);
      }
    }
  }
}

function clampFraction(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function remainingPercent(remaining) {
  if (remaining === undefined) return undefined;
  return Math.round(remaining * 1000) / 10;
}

function normalizeResetTime(value) {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : undefined;
}

function progressBar(remaining, width = 20) {
  if (remaining === undefined) return `[${"?".repeat(width)}]`;
  const filled = Math.max(0, Math.min(width, Math.round(remaining * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function formatReset(resetTime) {
  if (!resetTime) return "n/a";
  const numeric = typeof resetTime === "number" ? resetTime : (/^\d+$/.test(String(resetTime)) ? Number(resetTime) : NaN);
  const timestamp = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(String(resetTime));
  if (!Number.isFinite(timestamp)) return String(resetTime);
  const delta = timestamp - Date.now();
  if (delta <= 0) return "now";
  const totalMinutes = Math.max(1, Math.ceil(delta / 60000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function postJson(path, token, body, endpoints = endpointCandidates()) {
  let lastErrorText = "";
  for (const endpoint of endpoints) {
    try {
      const response = await providerFetch(`${endpoint}${path}`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify(body),
      });
      setLastEndpoint(endpoint);
      setLastStatus(response.status);
      const text = await response.text();
      const data = safeJsonParse(text) ?? { raw: text };
      if (!response.ok) {
        lastErrorText =
          isRecord(data) && isRecord(data.error) && typeof data.error.message === "string"
            ? data.error.message
            : text;
        if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) {
          throw new Error(`${path} failed (${String(response.status)}): ${lastErrorText.slice(0, 300)}`);
        }
        continue;
      }
      return { endpoint, status: response.status, data };
    } catch (error) {
      lastErrorText = safeError(error);
      setLastError(lastErrorText);
    }
  }
  throw new Error(`${path} failed: ${lastErrorText || "no endpoint available"}`);
}

async function fetchAvailableModelsFromEndpoint(endpoint, token, projectId) {
  try {
    const response = await providerFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ project: projectId }),
    });
    const text = await response.text();
    const data = safeJsonParse(text) ?? { raw: text };
    if (!response.ok) {
      const lastErrorText =
        isRecord(data) && isRecord(data.error) && typeof data.error.message === "string"
          ? data.error.message
          : text;
      setLastError(lastErrorText);
      return undefined;
    }
    return { endpoint, status: response.status, data };
  } catch (error) {
    setLastError(error);
    return undefined;
  }
}

async function fetchMergedAvailableModels(token, projectId) {
  const results = await Promise.all(
    endpointCandidates().map((endpoint) => fetchAvailableModelsFromEndpoint(endpoint, token, projectId)),
  );
  const mergedModels = {};
  let defaultAgentModelId;
  let lastEndpoint = "";
  let lastStatus = 0;

  for (const result of results) {
    if (!result) continue;
    setLastEndpoint(result.endpoint);
    setLastStatus(result.status);
    lastEndpoint = result.endpoint;
    lastStatus = result.status;
    if (isRecord(result.data) && isRecord(result.data.models)) {
      Object.assign(mergedModels, result.data.models);
    }
    if (isRecord(result.data) && typeof result.data.defaultAgentModelId === "string") {
      defaultAgentModelId = result.data.defaultAgentModelId;
    }
  }

  if (!lastEndpoint) throw new Error("/v1internal:fetchAvailableModels failed: no endpoint available");
  return {
    endpoint: lastEndpoint,
    status: lastStatus,
    data: { models: mergedModels, defaultAgentModelId },
  };
}

export function parseQuotaSummary(data) {
  // The service has returned both direct and wrapped RPC responses. Normalize
  // them here so the settings UI does not depend on the wire envelope.
  let summary = isRecord(data) ? data : {};
  for (let depth = 0; depth < 3; depth++) {
    if (Array.isArray(summary.groups) || Array.isArray(summary.buckets)) break;
    const nested = summary.response || summary.result || summary.data;
    if (!isRecord(nested)) break;
    summary = nested;
  }
  const groups = [];
  const hasGroupedBuckets = Array.isArray(summary.groups) && summary.groups.some(
    (group) => isRecord(group) && Array.isArray(group.buckets) && group.buckets.length > 0,
  );
  const rawGroups = hasGroupedBuckets
    ? summary.groups
    : Array.isArray(summary.buckets)
      ? [{ displayName: "Quota", buckets: summary.buckets }]
      : [];
  for (const group of rawGroups) {
    if (!isRecord(group)) continue;
    const buckets = [];
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      if (!isRecord(bucket)) continue;
      const remaining = clampFraction(
        bucket.remainingFraction ?? bucket.remaining_fraction ??
        (isRecord(bucket.remaining) ? bucket.remaining.remainingFraction : undefined),
      );
      const bucketId = bucket.bucketId || bucket.bucket_id || bucket.modelId || bucket.model_id;
      if (remaining === undefined && !bucketId) continue;
      buckets.push({
        bucketId: String(bucketId || bucket.displayName || "unknown"),
        displayName: String(bucket.displayName || bucket.bucketId || bucket.modelId || "Limit"),
        window: bucket.window || bucket.windowName ? String(bucket.window || bucket.windowName) : undefined,
        resetTime: normalizeResetTime(bucket.resetTime ?? bucket.reset_time),
        description: bucket.description ? String(bucket.description) : undefined,
        // Google sets this when a window is not currently enforced (for example the
        // 5-hour limit while the weekly limit is exhausted). Rendering it as a live
        // bar shows a misleading 100%.
        ...(bucket.disabled === true ? { disabled: true } : {}),
        remainingFraction: remaining,
      });
    }
    if (!buckets.length) continue;
    groups.push({
      displayName: String(group.displayName || "Quota group"),
      description: group.description ? String(group.description) : undefined,
      buckets,
    });
  }
  return {
    groups,
    description: summary.description ? String(summary.description) : undefined,
  };
}

function parseModels(data) {
  const raw = isRecord(data) ? data : {};
  const modelsObj = isRecord(raw.models) ? raw.models : {};
  const models = [];
  for (const [modelId, info] of Object.entries(modelsObj)) {
    if (!isRecord(info)) continue;
    if (info.isInternal || String(modelId).startsWith("chat_")) continue;
    const quotaInfo = isRecord(info.quotaInfo) ? info.quotaInfo : {};
    models.push({
      modelId,
      displayName:
        typeof info.displayName === "string"
          ? info.displayName
          : typeof info.label === "string"
            ? info.label
            : typeof info.modelName === "string"
              ? info.modelName
              : undefined,
      remainingFraction: clampFraction(quotaInfo.remainingFraction),
      resetTime: normalizeResetTime(quotaInfo.resetTime ?? quotaInfo.reset_time),
      modelProvider:
        typeof info.modelProvider === "string"
          ? info.modelProvider
          : typeof info.apiProvider === "string"
            ? info.apiProvider
            : undefined,
      supportsThinking: !!info.supportsThinking,
      supportsImages: !!info.supportsImages,
      recommended: !!info.recommended,
    });
  }
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return {
    models,
    defaultAgentModelId:
      raw.defaultAgentModelId || raw.defaultAgentModel
        ? String(raw.defaultAgentModelId || raw.defaultAgentModel)
        : undefined,
  };
}

function extractModelVersion(model) {
  const name = String(model?.name || "");
  const id = String(model?.id || model?.modelId || "");
  const idMatch = id.match(/(?:gemini|claude|gpt)[-_ ]*v?(\d+(?:\.\d+)*)/i)
    || id.match(/\b(\d+(?:\.\d+)+)\b/);
  if (idMatch) return idMatch[1].split(".").map((num) => parseInt(num, 10) || 0);

  const nameMatch = name.match(/(?:gemini|claude|gpt)[-_ ]*v?(\d+(?:\.\d+)*)/i)
    || name.match(/\b(\d+(?:\.\d+)+)\b/);
  if (nameMatch) return nameMatch[1].split(".").map((num) => parseInt(num, 10) || 0);

  return [0];
}

function compareVersionsDesc(v1, v2) {
  const len = Math.max(v1.length, v2.length);
  for (let i = 0; i < len; i++) {
    const num1 = v1[i] !== undefined ? v1[i] : 0;
    const num2 = v2[i] !== undefined ? v2[i] : 0;
    if (num1 !== num2) return num2 - num1;
  }
  return 0;
}

function getFamilyOrder(model) {
  const text = `${model?.id || ""} ${model?.name || ""}`.toLowerCase();
  if (text.includes("gemini")) return 1;
  if (text.includes("claude")) return 2;
  if (text.includes("gpt")) return 3;
  return 4;
}

function getVariantScore(model) {
  const text = `${model?.name || ""} ${model?.id || ""}`.toLowerCase();
  if (text.includes("ultra")) return 1;
  if (text.includes("pro") && !text.includes("lite")) return 2;
  if (text.includes("flash") && !text.includes("lite") && !text.includes("thinking") && !text.includes("image")) return 3;
  if (text.includes("flash") && text.includes("thinking") && !text.includes("lite")) return 4;
  if (text.includes("image")) return 5;
  if (text.includes("lite") && !text.includes("thinking")) return 6;
  if (text.includes("lite") && text.includes("thinking")) return 7;
  return 10;
}

export function compareAntigravityModels(a, b) {
  const famA = getFamilyOrder(a);
  const famB = getFamilyOrder(b);
  if (famA !== famB) return famA - famB;

  const verA = extractModelVersion(a);
  const verB = extractModelVersion(b);
  const verComp = compareVersionsDesc(verA, verB);
  if (verComp !== 0) return verComp;

  const variantA = getVariantScore(a);
  const variantB = getVariantScore(b);
  if (variantA !== variantB) return variantA - variantB;

  return (a.name || a.id || "").localeCompare(b.name || b.id || "") || (a.id || "").localeCompare(b.id || "");
}

export function compareAntigravityModelOptions(a, b) {
  const aEnabled = Boolean(a?.enabled);
  const bEnabled = Boolean(b?.enabled);
  if (aEnabled !== bEnabled) return aEnabled ? -1 : 1;
  return compareAntigravityModels(a, b);
}

function modelNameFromId(id) {
  return String(id)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bGpt\b/g, "GPT")
    .replace(/\bOss\b/g, "OSS");
}

function inferModelShape(modelId, info = {}) {
  const id = String(modelId);
  const staticModel = modelById(id);
  if (staticModel) return staticModel;
  const lower = id.toLowerCase();
  const maxTokens = getMaxOutputTokens(id, id);
  const inputModalities = info.supportsImages || /gemini|claude/i.test(id) ? ["text", "image"] : ["text"];
  // Check -xhigh before -high because "-xhigh".endsWith("-high").
  const pinnedTier = lower.endsWith("-low")
    ? ["low"]
    : lower.endsWith("-medium")
      ? ["medium"]
      : lower.endsWith("-xhigh")
        ? ["xhigh"]
        : lower.endsWith("-high")
          ? ["high"]
          : undefined;
  const reasoningEfforts = pinnedTier
    ? pinnedTier
    : lower.includes("gpt-oss")
      ? ["medium"]
      : lower.includes("claude")
        ? ["high"]
        : lower.includes("pro")
          ? ["low", "high"]
          : lower.includes("gemini")
            ? ["low", "medium", "high"]
            : [];
  let name = info.displayName || info.label || info.modelName || modelNameFromId(id);
  if (id === "gemini-3.7-flash-tiered") {
    name = "Gemini 3.7 Flash";
  }
  const idVer = extractModelVersion({ id });
  const nameVer = extractModelVersion({ name });
  if (
    idVer[0] !== 0 &&
    nameVer[0] !== 0 &&
    (idVer[0] !== nameVer[0] || (idVer[1] !== undefined && nameVer[1] !== undefined && idVer[1] !== nameVer[1]))
  ) {
    name = modelNameFromId(id);
  }
  return {
    id,
    name,
    inputModalities,
    contextWindow: lower.includes("claude") ? 200000 : lower.includes("gpt-oss") ? 131072 : 1048576,
    maxTokens,
    reasoningEfforts,
  };
}

function baseModelMatcher(baseId) {
  switch (baseId) {
    case "gemini-4-argon":
      return (text) => /gemini[- ]*4[- ]*argon/i.test(text);
    case "gemini-4-carbon":
      return (text) => /gemini[- ]*4[- ]*carbon/i.test(text);
    case "gemini-4-hydrogen":
      return (text) => /gemini[- ]*4[- ]*hydrogen/i.test(text);
    case "gemini-3.7-flash":
      return (text) => /gemini[- ]3\.7[- ]flash/i.test(text);
    case "gemini-3.6-flash":
      return (text) => /gemini[- ]3\.6[- ]flash/i.test(text);
    case "gemini-3.5-flash":
      return (text) => /gemini[- ]3\.5[- ]flash|gemini[- ]3[- ]flash[- ]agent/i.test(text);
    case "gemini-3.1-pro":
      return (text) => /gemini[- ]3\.1[- ]pro|gemini[- ]pro[- ]agent/i.test(text);
    case "gemini-3.1-flash-image":
      return (text) => /gemini[- ]3\.1[- ]flash[- ]image/i.test(text);
    case "gemini-3-flash":
      return (text) => /^gemini[- ]3[- ]flash$/i.test(text);
    case "gemini-2.5-pro":
      return (text) => /gemini[- ]2\.5[- ]pro/i.test(text);
    case "gemini-2.5-flash":
      return (text) => /gemini[- ]2\.5[- ]flash|gemini[- ]3\.1[- ]flash[- ]lite/i.test(text);
    case "claude-sonnet-5.5":
      return (text) => /claude[- ]sonnet[- ]5[-. ]5/i.test(text);
    case "claude-sonnet-4-6":
      return (text) => /claude[- ]sonnet[- ]4[-. ]6/i.test(text);
    case "claude-opus-5.5":
      return (text) => /claude[- ]opus[- ]5[-. ]5/i.test(text);
    case "claude-opus-4-6":
      return (text) => /claude[- ]opus[- ]4[-. ]6/i.test(text);
    case "gpt-oss-120b":
      return (text) => /gpt[- ]oss/i.test(text);
    default:
      return (text) => String(text || "").toLowerCase().includes(baseId.toLowerCase());
  }
}

function parseCatalogModels(data) {
  const raw = isRecord(data) ? data : {};
  const modelsObj = isRecord(raw.models) ? raw.models : {};
  const rawModels = [];
  for (const [modelId, infoRaw] of Object.entries(modelsObj)) {
    if (!isUsableRuntimeModelId(modelId)) continue;
    if (!isRecord(infoRaw)) continue;
    if (infoRaw.isInternal || String(modelId).startsWith("chat_") || String(modelId).startsWith("tab_")) continue;
    const quotaInfo = isRecord(infoRaw.quotaInfo) ? infoRaw.quotaInfo : {};
    const inferred = inferModelShape(modelId, infoRaw);
    rawModels.push({
      id: modelId,
      name: inferred.name,
      inputModalities: inferred.inputModalities,
      contextWindow: inferred.contextWindow,
      maxTokens: inferred.maxTokens,
      reasoningEfforts: inferred.reasoningEfforts,
      available: true,
      remainingFraction: clampFraction(quotaInfo.remainingFraction),
      resetTime: normalizeResetTime(quotaInfo.resetTime ?? quotaInfo.reset_time),
      modelProvider:
        typeof infoRaw.modelProvider === "string"
          ? infoRaw.modelProvider
          : typeof infoRaw.apiProvider === "string"
            ? infoRaw.apiProvider
            : undefined,
    });
  }

  const matchedRawIds = new Set();
  const consolidated = [];

  for (const base of MODELS) {
    const matcher = baseModelMatcher(base.id);
    const matching = rawModels.filter((r) => matcher(r.id) || matcher(r.name));
    if (matching.length > 0) {
      for (const m of matching) matchedRawIds.add(m.id);
      const quotaItem = matching.find((m) => typeof m.remainingFraction === "number") || matching[0];
      consolidated.push({
        id: base.id,
        name: base.name,
        inputModalities: base.inputModalities,
        contextWindow: base.contextWindow,
        maxTokens: base.maxTokens,
        reasoningEfforts: base.reasoningEfforts,
        available: true,
        remainingFraction: quotaItem?.remainingFraction,
        resetTime: quotaItem?.resetTime,
        modelProvider: quotaItem?.modelProvider,
      });
    } else {
      consolidated.push({
        id: base.id,
        name: base.name,
        inputModalities: base.inputModalities,
        contextWindow: base.contextWindow,
        maxTokens: base.maxTokens,
        reasoningEfforts: base.reasoningEfforts,
        available: true,
      });
    }
  }

  for (const raw of rawModels) {
    if (!matchedRawIds.has(raw.id)) {
      consolidated.push(raw);
    }
  }

  consolidated.sort(compareAntigravityModels);
  return consolidated;
}

function parseTier(value) {
  if (!isRecord(value)) return undefined;
  if (!value.id && !value.name) return undefined;
  return {
    id: value.id ? String(value.id) : undefined,
    name: value.name ? String(value.name) : undefined,
    description: value.description ? String(value.description) : undefined,
  };
}

export async function fetchAccountQuota(store = new FileCredentialStore(), modelSettings, accountId) {
  const captured = await captureAccount(store, accountId);
  return runWithTransport({ account: captured, kind: "api" }, () => fetchCapturedQuota(captured, modelSettings));
}

async function fetchCapturedQuota(store, modelSettings) {
  const { token, projectId: credentialProjectId } = await ensureApiKey(store);
  const assistResult = await postJson("/v1internal:loadCodeAssist", token, {
    metadata: {
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  }).catch(() => null);

  const discoveredProject = assistResult ? extractProjectId(assistResult.data) : undefined;
  const projectId = resolveProjectId({
    credentialProjectId,
    warmedProject: discoveredProject ?? null,
  });
  setLastProjectId(projectId);

  // Read the summary from the endpoint the Antigravity client uses; the production
  // endpoint can return a lagging snapshot of the Gemini windows.
  const summary = await postJson("/v1internal:retrieveUserQuotaSummary", token, { project: projectId }, quotaEndpointCandidates());

  const available = await fetchMergedAvailableModels(token, projectId);
  const { groups, description } = parseQuotaSummary(summary.data);
  const { models, defaultAgentModelId } = parseModels(available.data);
  const catalogModels = parseCatalogModels(available.data);
  const assistData = isRecord(assistResult?.data) ? assistResult.data : {};
  const productTier = parseTier(assistData.currentTier);
  const paidTier = parseTier(assistData.paidTier);
  const planLabel = paidTier?.name
    ? `${paidTier.name}${paidTier.id ? ` (${paidTier.id})` : ""}`
    : productTier?.name
      ? `${productTier.name}${productTier.id ? ` (${productTier.id})` : ""}`
      : undefined;

  const quota = {
    accountId: store.accountId,
    projectId,
    endpoint: summary.endpoint,
    productTier,
    paidTier,
    planLabel,
    groups,
    groupDescription: description,
    models,
    catalogModels,
    defaultAgentModelId,
    fetchedAt: Date.now(),
  };

  const key = accountCacheKey(store);
  quotaCache.set(key, quota);
  accountCatalogs.set(catalogCacheKey(store), catalogModels);
  // Account catalogs must never prune the user's provider-wide model preferences.
  for (const cache of [quotaCache, accountCatalogs]) {
    while (cache.size > 64) cache.delete(cache.keys().next().value);
  }
  if (modelSettings) {
    // Keep the durable catalog current: it is the fallback the picker reads
    // before this process has fetched one for the active account. enabledModelIds
    // is deliberately left untouched, so a fetch that momentarily omits a model
    // can never erase the user's selection of it.
    try {
      await modelSettings.setCatalogModels(catalogModels);
    } catch (error) {
      setLastError(error);
    }
  }
  return quota;
}

export function getCachedQuota(captured) {
  const exact = quotaCache.get(accountCacheKey(captured));
  if (exact) return exact;
  if (captured?.accountId) {
    let newest;
    for (const value of quotaCache.values()) {
      if (value.accountId === captured.accountId && (!newest || value.fetchedAt > newest.fetchedAt)) newest = value;
    }
    return newest;
  }
  return quotaCache.values().next().value;
}

export function formatQuotaSummary(quota) {
  const lines = [];
  lines.push("Antigravity quota");
  if (quota.planLabel) lines.push(`plan=${quota.planLabel}`);
  lines.push(`project=${quota.projectId}`);
  lines.push(`fetched=${new Date(quota.fetchedAt).toLocaleString()}`);

  if (!quota.groups.length) {
    lines.push("");
    lines.push("No quota groups returned.");
  } else {
    for (const group of quota.groups) {
      lines.push("");
      lines.push(group.displayName);
      for (const bucket of group.buckets) {
        const remaining = remainingPercent(bucket.remainingFraction);
        lines.push(
          `  ${progressBar(bucket.remainingFraction)} ${bucket.displayName}: ${remaining ?? "?"}% left · resets ${formatReset(bucket.resetTime)}`,
        );
      }
    }
  }

  const rows = quota.models.filter((model) => !/tab_|chat_/i.test(model.modelId)).slice(0, 24);
  if (rows.length) {
    lines.push("");
    lines.push("Models");
    const maxId = Math.max(...rows.map((model) => model.modelId.length), 8);
    for (const model of rows) {
      const remaining = remainingPercent(model.remainingFraction);
      const flags = [
        model.recommended ? "recommended" : "",
        model.supportsThinking ? "thinking" : "",
        model.supportsImages ? "images" : "",
      ]
        .filter(Boolean)
        .join(",");
      const display = model.displayName && model.displayName !== model.modelId ? `  ${model.displayName}` : "";
      lines.push(
        `${model.modelId.padEnd(maxId)}  rem ${remaining === undefined ? "  ?" : String(remaining).padStart(5)}%  reset ${formatReset(model.resetTime).padEnd(8)}${flags ? `  [${flags}]` : ""}${display}`,
      );
    }
    lines.push("");
    lines.push("Note: remaining % is pool-shared, not a private per-model budget.");
  }
  return lines.join("\n").trimEnd();
}

function getMaxOutputTokens(modelId, runtimeModel) {
  if (runtimeModel && RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel] !== undefined) {
    return RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel];
  }
  if (RUNTIME_MAX_OUTPUT_TOKENS[modelId] !== undefined) return RUNTIME_MAX_OUTPUT_TOKENS[modelId];
  if (runtimeModel) {
    if (runtimeModel.startsWith("claude-")) return 64000;
    if (runtimeModel.startsWith("gpt-oss-")) return 32768;
    if (runtimeModel.startsWith("gemini-3.1-pro") || runtimeModel === "gemini-pro-agent") {
      return 65535;
    }
    if (runtimeModel.startsWith("gemini-")) return 65536;
  }
  return 8192;
}

function getAntigravityRequestModelId(modelId, effort) {
  const route = ROUTING[modelId];
  if (!route) return modelId;
  if (effort === "off") {
    return route.off ?? route.routing?.high ?? route.defaultRequestId ?? modelId;
  }
  if (effort === undefined) {
    return route.routing?.high ?? route.defaultRequestId ?? route.off ?? modelId;
  }
  if (effort === "xhigh") {
    return (
      route.routing?.xhigh ??
      route.routing?.high ??
      route.routing?.medium ??
      route.routing?.low ??
      route.off ??
      route.defaultRequestId ??
      modelId
    );
  }
  return (
    route.routing?.[effort] ??
    route.routing?.high ??
    route.routing?.medium ??
    route.routing?.low ??
    route.off ??
    route.defaultRequestId ??
    modelId
  );
}

function getFallbackRuntimeModel(runtimeModel, effort) {
  if (runtimeModel === "gemini-3.7-flash-tiered") {
    return getAntigravityRequestModelId("gemini-3.6-flash", effort);
  }
  if (runtimeModel.startsWith("gemini-3.7-flash-")) {
    return runtimeModel.replace("gemini-3.7-flash-", "gemini-3.6-flash-");
  }
  if (runtimeModel === "gemini-3.7-flash") return "gemini-3.6-flash-low";
  return undefined;
}

function modelById(modelId) {
  return MODELS.find((model) => model.id === modelId);
}

function defaultReasoningEffort(model) {
  if (!model.reasoningEfforts || !model.reasoningEfforts.length) return undefined;
  if (model.reasoningEfforts.includes("high")) return "high";
  return model.reasoningEfforts[model.reasoningEfforts.length - 1];
}

function reasoningInfo(model) {
  if (!model.reasoningEfforts.length) return {};
  const defaultEffort = defaultReasoningEffort(model);
  return {
    reasoning: {
      efforts: model.reasoningEfforts.map((level) => ({
        id: ReasoningEffortId(level),
        name: level === "xhigh" ? "XHigh" : level.charAt(0).toUpperCase() + level.slice(1),
      })),
      ...(defaultEffort ? { defaultEffort: ReasoningEffortId(defaultEffort) } : {}),
    },
  };
}

function resolveReasoning(model, effort) {
  if (effort === "off") return effort;
  if (effort && model.reasoningEfforts && model.reasoningEfforts.includes(effort)) return effort;
  return defaultReasoningEffort(model) || "high";
}

function hasImages(messages) {
  return messages.some((message) => {
    try {
      return contentHasImage(message.content);
    } catch {
      return false;
    }
  });
}

function sanitizeToolCallId(id, fallbackName) {
  const cleaned = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const capped = cleaned.slice(0, 64);
  return capped || `${fallbackName || "tool"}_${Date.now()}_${++toolCallCounter}`;
}

function toolCallIdNeeded(modelId, runtimeModel) {
  return (
    modelId.startsWith("claude-") ||
    modelId.startsWith("gpt-oss-") ||
    runtimeModel.startsWith("claude-") ||
    runtimeModel.startsWith("gpt-oss-")
  );
}

function parseArguments(raw) {
  if (isRecord(raw)) return raw;
  if (raw === undefined || raw === null || raw === "") return {};
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  return isRecord(parsed) ? parsed : {};
}

/**
 * Antigravity inline image budget.
 *
 * Cloud Code Assist carries images as base64 `inlineData` inside the request
 * body, and its published `supportedMimeTypes` set lists `image/png` as the
 * raster image type. The pixel and byte bounds below match the harness
 * attachment normalization defaults, so a typical screenshot is served as a
 * passthrough of its normalized bytes instead of a lossy re-encode.
 */
const IMAGE_MAX_PIXELS = 2048 * 2048;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** Accumulated encoded-byte ceiling for every image in one request. */
const IMAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** Raster media types Antigravity accepts for `inlineData`. */
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * Collect every image reference in one request, including images nested in tool
 * results, so each attachment is read exactly once however often it repeats.
 * @param content - blocks from one message.
 * @param refs - accumulator keyed by attachment id.
 */
function collectImageRefs(content, refs) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "image" && isRecord(block.attachment)) {
      refs.set(String(block.attachment.attachmentId), block.attachment);
    } else if (block.type === "tool-result") {
      collectImageRefs(block.content, refs);
    }
  }
}

/**
 * Compute aspect-preserving integer dimensions within a hard total-pixel budget.
 * @param {number} width - positive source width.
 * @param {number} height - positive source height.
 * @param {number} maxPixels - positive width-times-height cap.
 * @returns {{ width: number, height: number }}
 */
function requestImageDimensions(width, height, maxPixels) {
  const w = Number.isSafeInteger(width) && width > 0 ? width : 2048;
  const h = Number.isSafeInteger(height) && height > 0 ? height : 2048;
  const scale = Math.min(1, Math.sqrt(maxPixels / (w * h)));
  if (scale === 1) return { width: w, height: h };
  if (w >= h) {
    let projectedWidth = Math.max(1, Math.floor(w * scale));
    let projectedHeight = Math.max(1, Math.round((projectedWidth * h) / w));
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1;
      projectedHeight = Math.max(1, Math.round((projectedWidth * h) / w));
    }
    return { width: projectedWidth, height: projectedHeight };
  }
  let projectedHeight = Math.max(1, Math.floor(h * scale));
  let projectedWidth = Math.max(1, Math.round((projectedHeight * w) / h));
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1;
    projectedWidth = Math.max(1, Math.round((projectedHeight * w) / h));
  }
  return { width: projectedWidth, height: projectedHeight };
}

function resolveAntigravityImageTarget(ref) {
  const { width, height } = requestImageDimensions(ref?.width, ref?.height, IMAGE_MAX_PIXELS);
  return {
    width,
    height,
    maxBytes: IMAGE_MAX_BYTES,
  };
}

/**
 * Read and base64-encode every image in one request into Antigravity's wire shape.
 *
 * DSH never hands an adapter raw image bytes: an `image` block carries only a
 * durable `attachment` reference, and the mounted attachment service derives the
 * encoded request version. Skipping that step silently drops the image.
 * @param options - the harness request.
 * @param attachments - attachment store, when this profile mounts one.
 * @param signal - request cancellation.
 * @returns `inlineData` payloads by attachment id; empty when the request has none.
 */
async function prepareImages(options, attachments, signal) {
  const refs = new Map();
  for (const message of options.messages) collectImageRefs(message.content, refs);
  const prepared = new Map();
  if (refs.size === 0) return prepared;
  if (attachments === undefined) {
    console.warn("[dsh-antigravity] No attachment service mounted; image attachments cannot be read.");
    return prepared;
  }
  const entries = await Promise.all(
    [...refs].map(async ([id, ref]) => {
      try {
        const target = resolveAntigravityImageTarget(ref);
        const version = await attachments.readImageRequest(ref, target, signal);
        const mimeType = String(version?.mediaType || "");
        if (!IMAGE_MIME_TYPES.has(mimeType)) {
          console.warn(`[dsh-antigravity] Image ${id} has unsupported media type: ${mimeType}`);
          return [id, null];
        }
        return [id, { mimeType, data: Buffer.from(version.data).toString("base64"), bytes: version.bytes }];
      } catch (err) {
        console.warn(`[dsh-antigravity] Failed to prepare image ${id}:`, err?.message || err);
        return [id, null];
      }
    }),
  );
  let totalBytes = 0;
  for (const [id, entry] of entries) {
    if (!entry) continue;
    if (totalBytes + entry.bytes > IMAGE_MAX_TOTAL_BYTES) {
      console.warn(`[dsh-antigravity] Image ${id} omitted: total images exceeded ${Math.round(IMAGE_MAX_TOTAL_BYTES / 1024)}KB.`);
      continue;
    }
    totalBytes += entry.bytes;
    prepared.set(id, entry);
  }
  return prepared;
}

/**
 * Build one Antigravity `inlineData` part for an image block.
 * @param block - the image content block.
 * @param prepared - wire images already read for this request, by attachment id.
 * @returns an `inlineData` part, or undefined for a block carrying no image.
 */
function imageBlockToPart(block, prepared) {
  if (!isRecord(block) || block.type !== "image") return undefined;
  const attachment = isRecord(block.attachment) ? block.attachment : undefined;
  if (attachment) {
    const id = String(attachment.attachmentId);
    const image = prepared?.get(id);
    if (!image) {
      return undefined;
    }
    return { inlineData: { mimeType: image.mimeType, data: image.data } };
  }
  // Non-harness callers may still hand over inline bytes or a data URL.
  let data = asString(block.data) || asString(block.base64);
  const source = isRecord(block.source) ? block.source : undefined;
  if (!data && source) data = asString(source.data) || asString(source.base64);
  let mimeType =
    asString(block.mimeType) ||
    asString(block.mediaType) ||
    (source ? asString(source.mimeType) || asString(source.mediaType) : undefined) ||
    "image/png";
  if (data?.startsWith("data:")) {
    const match = data.match(/^data:([^;,]+);base64,(.*)$/s);
    if (match) {
      mimeType = match[1] || mimeType;
      data = match[2] || "";
    }
  }
  return data ? { inlineData: { mimeType, data } } : undefined;
}

function contentToUserParts(content, prepared) {
  if (typeof content === "string") return [{ text: sanitizeText(content) }];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text") {
      parts.push({ text: sanitizeText(block.text) });
    } else if (isRecord(block) && block.type === "image") {
      const imagePart = imageBlockToPart(block, prepared);
      if (imagePart) {
        parts.push(imagePart);
      } else {
        const name = block.attachment?.name || "image";
        parts.push({ text: `[image: ${name}]` });
      }
    }
  }
  return parts;
}

function toolResultText(blocks, prepared) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text") return sanitizeText(block.text);
      if (block.type === "image") {
        const attachment = isRecord(block.attachment) ? block.attachment : undefined;
        if (!attachment) return "";
        const image = prepared?.get(String(attachment.attachmentId));
        if (!image) {
          const name = attachment.name || "image";
          return `[image: ${name}]`;
        }
        return `[attached image ${image.mimeType}, ${Math.round(image.bytes / 1024)}KB]`;
      }
      if (block.type === "tool-result") return toolResultText(block.content, prepared);
      return "";
    })
    .join("");
}

/**
 * Collect `inlineData` parts for images nested inside one tool result, so a
 * screenshot returned by a tool reaches the model instead of being dropped.
 * @param blocks - tool result content blocks.
 * @param prepared - wire images already read for this request.
 * @param out - accumulator for image parts.
 */
function toolResultImageParts(blocks, prepared, out) {
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === "image") {
      const part = imageBlockToPart(block, prepared);
      if (part) out.push(part);
    } else if (block.type === "tool-result") {
      toolResultImageParts(block.content, prepared, out);
    }
  }
}

function sameReplayModel(savedModelId, targetModelId) {
  if (!savedModelId || !targetModelId) return false;
  const canonicalSaved = TIER_ALIASES.get(savedModelId) ?? savedModelId;
  const canonicalTarget = TIER_ALIASES.get(targetModelId) ?? targetModelId;
  if (canonicalSaved === canonicalTarget) return true;
  // Gemini models on Antigravity share compatible encrypted thoughtSignature
  // payloads across families (argon, carbon, hydrogen, flash). Preserving them
  // across mid-session Gemini switches avoids falling back to
  // skip_thought_signature_validator, which otherwise suppresses thinking.
  // Claude signatures remain strictly model-specific.
  return canonicalSaved.startsWith("gemini-") && canonicalTarget.startsWith("gemini-");
}

function replayBlockFor(message, index, model) {
  const source = message.source;
  if (!source || source.kind !== "model") return undefined;
  const state = source.replayState;
  if (!isRecord(state)) return undefined;
  if (state.kind !== "antigravity" || state.version !== 1) return undefined;
  if (state.provider !== PROVIDER || state.model !== source.model) return undefined;
  if (model?.id && !sameReplayModel(state.model, model.id)) return undefined;
  if (!Array.isArray(state.blocks)) return undefined;
  return state.blocks[index];
}

function assistantParts(message, model, runtimeModel, toolNames) {
  const parts = [];
  if (!Array.isArray(message.content)) return parts;
  const isGemini =
    (typeof runtimeModel === "string" && runtimeModel.startsWith("gemini-")) ||
    (typeof model?.id === "string" && model.id.startsWith("gemini-"));
  for (let index = 0; index < message.content.length; index++) {
    const block = message.content[index];
    if (!isRecord(block)) continue;
    const replay = replayBlockFor(message, index, model);
    if (block.type === "text") {
      const textSignature = replay?.type === "text" && replay.textSignature ? replay.textSignature : undefined;
      if (String(block.text || "").trim() || textSignature) {
        parts.push({
          text: sanitizeText(block.text || ""),
          ...(textSignature ? { thoughtSignature: textSignature } : {}),
        });
      }
    } else if (block.type === "reasoning" && String(block.text || "").trim()) {
      if (replay?.type === "reasoning" && replay.thinkingSignature) {
        parts.push({
          thought: true,
          text: sanitizeText(block.text),
          thoughtSignature: replay.thinkingSignature,
        });
      } else if (isGemini) {
        // Keep historical Gemini thought blocks even across model switches or when
        // replayState is absent; unsigned thinking still stays excluded for Claude.
        parts.push({
          thought: true,
          text: sanitizeText(block.text),
        });
      }
    } else if (block.type === "tool-call") {
      const toolId = String(block.id || "");
      toolNames.set(toolId, block.name);
      parts.push({
        functionCall: {
          name: block.name,
          args: parseArguments(block.arguments),
          ...(toolCallIdNeeded(model.id, runtimeModel)
            ? { id: sanitizeToolCallId(toolId, block.name) }
            : {}),
        },
        ...(replay?.type === "tool-call" && replay.thoughtSignature
          ? { thoughtSignature: replay.thoughtSignature }
          : {}),
      });
    }
  }
  return parts;
}

function pushToolResult(contents, result, toolNames, model, runtimeModel, prepared) {
  const toolCallId = String(result.toolCallId || "");
  const toolName = toolNames.get(toolCallId) || "unknown";
  const responseText = toolResultText(result.content, prepared) || (result.isError ? "Tool failed" : "");
  const part = {
    functionResponse: {
      name: toolName,
      response: result.isError ? { error: responseText } : { output: responseText },
      ...(toolCallIdNeeded(model.id, runtimeModel)
        ? { id: sanitizeToolCallId(toolCallId, toolName) }
        : {}),
    },
  };
  const last = contents[contents.length - 1];
  if (last?.role === GEMINI_ROLE.user && last.parts.some((entry) => "functionResponse" in entry)) {
    last.parts.push(part);
  } else {
    contents.push({ role: GEMINI_ROLE.user, parts: [part] });
  }
  // Images cannot live inside a functionResponse, so they follow it in the same
  // user turn where the API still accepts them.
  const imageParts = [];
  toolResultImageParts(result.content, prepared, imageParts);
  if (imageParts.length) {
    const tail = contents[contents.length - 1];
    if (tail?.role === GEMINI_ROLE.user) tail.parts.push(...imageParts);
    else contents.push({ role: GEMINI_ROLE.user, parts: imageParts });
  }
}

const SKIP_THOUGHT_SIGNATURE_VALIDATOR_B64 = "c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=";
// Antigravity's sandbox backend (`daily-cloudcode-pa`) intermittently enforces
// a 128k-token (131,072) sliding window by front-trimming `contents` to the
// earliest `role: "user"` entry without `functionResponse` that fits. A long
// multi-step `functionCall`/`functionResponse` loop has no internal plain-user
// boundary, so a completed >128k loop (or marathon active loop) would be
// discarded in full. Flattening oversized Gemini tool chains into plain
// `model`/`user` text turns gives every step a clean cut boundary while
// keeping normal turns and the active tool tail native.
const MAX_HISTORICAL_GEMINI_TOOL_CHAIN_CHARS = 180_000;
const MAX_ACTIVE_GEMINI_TOOL_CHAIN_CHARS = 320_000;
const ACTIVE_GEMINI_TOOL_TAIL_CHARS = 160_000;
// On Antigravity (`requestType: "agent"`), moving DSH's `role: "system"`
// message out of `contents[0]` into `systemInstruction` weakens tool-protocol
// adherence (causing direct calls to undeclared SDK helpers) and cuts thinking
// depth on normal sessions. Keep `role: "system"` in `contents[0]` at all
// times, and mirror it into `systemInstruction` only when `contents` grows
// large enough (>360k chars, ~100k tokens) that a 128k front-trimming replica
// could trim `contents[0]`.
const FRONT_TRIM_SYSTEM_BACKUP_CHARS = 360_000;

function hasFunctionResponsePart(entry) {
  return Boolean(entry?.parts?.some((part) => "functionResponse" in part));
}

function hasToolProtocolPart(entry) {
  return Boolean(entry?.parts?.some((part) => "functionCall" in part || "functionResponse" in part));
}

function systemMessageText(content) {
  if (typeof content === "string") return sanitizeText(content);
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => sanitizeText(block.text))
    .filter((text) => text.length > 0)
    .join("\n");
}

function leadingSystemMessagesText(messages) {
  if (!Array.isArray(messages)) return "";
  const chunks = [];
  for (let i = 0; i < messages.length && messages[i]?.role === "system"; i++) {
    const text = systemMessageText(messages[i].content);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n");
}

function estimateEntryChars(entry) {
  let total = 0;
  for (const part of entry?.parts || []) {
    if (typeof part.text === "string") {
      total += part.text.length;
    } else if (part.functionCall) {
      total += String(part.functionCall.name || "").length + JSON.stringify(part.functionCall.args ?? {}).length;
    } else if (part.functionResponse) {
      const res = isRecord(part.functionResponse.response) ? part.functionResponse.response : {};
      total += String(part.functionResponse.name || "").length + String(res.output ?? res.error ?? "").length;
    } else if (part.inlineData?.data) {
      total += 4_000;
    }
  }
  return total;
}

function estimateRangeChars(contents, start, end) {
  let total = 0;
  for (let i = start; i < end; i++) total += estimateEntryChars(contents[i]);
  return total;
}

function formatHistoricalToolCall(functionCall) {
  const name = String(functionCall?.name || "unknown");
  const args = isRecord(functionCall?.args) ? functionCall.args : {};
  const entries = Object.entries(args);
  if (!entries.length) return `[Completed tool call: ${name}]`;
  // Render string parameters raw without JSON quote-escaping so `role: "model"`
  // history never exposes `\"` inside `run_code` TypeScript snippets (which the
  // model otherwise mimics on subsequent tool calls).
  const lines = [`[Completed tool call: ${name}]`];
  for (const [key, value] of entries) {
    if (typeof value === "string") {
      lines.push(value.includes("\n") ? `${key}:\n${value}` : `${key}: ${value}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join("\n");
}

function formatHistoricalToolResponse(functionResponse) {
  const name = String(functionResponse?.name || "unknown");
  const res = isRecord(functionResponse?.response) ? functionResponse.response : {};
  const isError = Object.prototype.hasOwnProperty.call(res, "error");
  const text = String(isError ? (res.error ?? "") : (res.output ?? ""));
  const header = isError ? `[Completed tool error: ${name}]` : `[Completed tool output: ${name}]`;
  return text ? `${header}\n${text}` : header;
}

function flattenGeminiRange(contents, start, end) {
  for (let i = start; i < end; i++) {
    const entry = contents[i];
    if (!hasToolProtocolPart(entry)) continue;
    if (entry.role === GEMINI_ROLE.model) {
      const nextParts = [];
      for (const part of entry.parts) {
        if (part.thought) {
          nextParts.push({ thought: true, text: part.text || "" });
        } else if ("functionCall" in part) {
          nextParts.push({ text: formatHistoricalToolCall(part.functionCall) });
        } else if (typeof part.text === "string") {
          nextParts.push({ text: part.text });
        } else {
          nextParts.push(part);
        }
      }
      contents[i] = { role: GEMINI_ROLE.model, parts: nextParts };
    } else if (entry.role === GEMINI_ROLE.user) {
      const nextParts = [];
      for (const part of entry.parts) {
        if ("functionResponse" in part) {
          nextParts.push({ text: formatHistoricalToolResponse(part.functionResponse) });
        } else {
          nextParts.push(part);
        }
      }
      contents[i] = { role: GEMINI_ROLE.user, parts: nextParts };
    }
  }
}

function findLastPlainUserIndex(contents) {
  for (let i = contents.length - 1; i >= 0; i--) {
    const entry = contents[i];
    if (entry.role === GEMINI_ROLE.user && !hasFunctionResponsePart(entry)) {
      return i;
    }
  }
  return 0;
}

function flattenOversizedGeminiToolChains(contents) {
  const activeTurnStart = findLastPlainUserIndex(contents);

  // 1. Flatten completed historical turn chains whose indivisible FC/FR span
  // exceeds MAX_HISTORICAL_GEMINI_TOOL_CHAIN_CHARS (~20k-25k tokens).
  let chainStart = 0;
  while (chainStart < activeTurnStart) {
    let chainEnd = chainStart + 1;
    while (
      chainEnd < activeTurnStart
      && !(contents[chainEnd].role === GEMINI_ROLE.user && !hasFunctionResponsePart(contents[chainEnd]))
    ) {
      chainEnd += 1;
    }
    let hasTools = false;
    for (let i = chainStart; i < chainEnd; i++) {
      if (hasToolProtocolPart(contents[i])) {
        hasTools = true;
        break;
      }
    }
    if (hasTools && estimateRangeChars(contents, chainStart, chainEnd) > MAX_HISTORICAL_GEMINI_TOOL_CHAIN_CHARS) {
      flattenGeminiRange(contents, chainStart, chainEnd);
    }
    chainStart = chainEnd;
  }

  // 2. If the active turn loop itself grows beyond MAX_ACTIVE_GEMINI_TOOL_CHAIN_CHARS,
  // flatten its older FC/FR pairs while keeping the most recent native tail.
  if (estimateRangeChars(contents, activeTurnStart, contents.length) > MAX_ACTIVE_GEMINI_TOOL_CHAIN_CHARS) {
    let tailChars = 0;
    let nativeTailStart = contents.length;
    for (let i = contents.length - 1; i > activeTurnStart; i--) {
      const entryChars = estimateEntryChars(contents[i]);
      if (
        nativeTailStart < contents.length
        && contents[i].role === GEMINI_ROLE.user
        && hasFunctionResponsePart(contents[i])
        && tailChars + entryChars > ACTIVE_GEMINI_TOOL_TAIL_CHARS
      ) {
        // `i` is a user functionResponse; keep from `i + 1` (the next model FC)
        // native, and flatten `activeTurnStart .. i + 1` so `i` becomes the
        // plain-user turn boundary right before `i + 1`.
        nativeTailStart = i + 1;
        break;
      }
      tailChars += entryChars;
      if (contents[i].role === GEMINI_ROLE.model && hasToolProtocolPart(contents[i])) {
        nativeTailStart = i;
      }
    }
    if (nativeTailStart > activeTurnStart + 1 && nativeTailStart < contents.length) {
      flattenGeminiRange(contents, activeTurnStart, nativeTailStart);
    }
  }
}

function convertMessages(options, model, runtimeModel, prepared) {
  const contents = [];
  const toolNames = new Map();
  const isGemini =
    (typeof runtimeModel === "string" && runtimeModel.startsWith("gemini-")) ||
    (typeof model?.id === "string" && model.id.startsWith("gemini-"));
  for (const message of options.messages) {
    if (message.role === "assistant") {
      const parts = assistantParts(message, model, runtimeModel, toolNames);
      if (parts.length) contents.push({ role: GEMINI_ROLE.model, parts });
      continue;
    }
    // DSH 0.2 stores tool results as role="tool" with the call id on the
    // message. Older histories used a user message containing a tool-result
    // block; both shapes must become a functionResponse immediately after the
    // model's functionCall or Anthropic-backed models reject the request.
    if (message.role === "tool") {
      pushToolResult(contents, message, toolNames, model, runtimeModel, prepared);
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    const resultBlocks = content.filter((block) => isRecord(block) && block.type === "tool-result");
    const userParts = contentToUserParts(content.filter((block) => !isRecord(block) || block.type !== "tool-result"), prepared);
    if (message.role === "system") {
      if (userParts.length) contents.push({ role: GEMINI_ROLE.user, parts: userParts });
      continue;
    }
    // Keep legacy tool results ahead of ordinary text in the same message so
    // every functionCall is followed immediately by its functionResponse.
    for (const block of resultBlocks) {
      pushToolResult(contents, block, toolNames, model, runtimeModel, prepared);
    }
    if (userParts.length) {
      const last = contents[contents.length - 1];
      if (resultBlocks.length > 0 && last?.role === GEMINI_ROLE.user && hasFunctionResponsePart(last)) {
        last.parts.push(...userParts);
      } else {
        contents.push({ role: GEMINI_ROLE.user, parts: userParts });
      }
    }
  }
  if (isGemini) {
    flattenOversizedGeminiToolChains(contents);
    const activeTurnStart = findLastPlainUserIndex(contents);
    for (let i = activeTurnStart + 1; i < contents.length; i++) {
      const entry = contents[i];
      if (entry.role !== GEMINI_ROLE.model) continue;
      for (const part of entry.parts) {
        if ("functionCall" in part && !part.thoughtSignature) {
          part.thoughtSignature = SKIP_THOUGHT_SIGNATURE_VALIDATOR_B64;
        }
      }
    }
  }
  assertRequestEndsWithUserTurn(contents);
  return contents;
}

/**
 * Enforce Antigravity's request-shape invariant: `contents` must end on a user
 * turn. The backend rejects anything else with "Requests ending with a model
 * turn are not supported", so a dropped or empty final user message would
 * otherwise surface as an opaque 400 instead of a local, actionable failure.
 * @param contents - converted Gemini contents about to be sent.
 * @throws LlmError when the request is empty or ends on a model turn.
 */
function assertRequestEndsWithUserTurn(contents) {
  if (contents.length === 0) {
    throw new LlmError("Antigravity request contains no user message.", "INVALID_REQUEST");
  }
  if (contents[contents.length - 1].role !== GEMINI_ROLE.user) {
    throw new LlmError(
      "Antigravity request must end with a user turn; the converted history ends with a model turn.",
      "INVALID_REQUEST",
    );
  }
}

function stripMetaSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const omit = new Set([
    "$schema",
    "$id",
    "$anchor",
    "$dynamicAnchor",
    "$vocabulary",
    "$comment",
    "$defs",
    "definitions",
  ]);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!omit.has(key)) out[key] = stripMetaSchema(value);
  }
  return out;
}

const CUSTOM_TOOL_SCHEMA_ALLOW = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
]);

function normalizeCustomToolType(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value.find((entry) => typeof entry === "string" && entry !== "null");
}

function normalizeCustomToolSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(key)) continue;
    if (key === "type") {
      const normalizedType = normalizeCustomToolType(value);
      if (normalizedType !== undefined) out.type = normalizedType;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = normalizeCustomToolSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if (key === "enum" && Array.isArray(value) && !value.every((entry) => typeof entry === "string")) {
      continue;
    }
    out[key] = normalizeCustomToolSchema(value);
  }
  return out;
}

function convertTools(tools, useLegacyParameters) {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const schema = stripMetaSchema(tool.parameters);
        return {
          name: tool.name,
          description: tool.description,
          ...(useLegacyParameters
            ? { parameters: normalizeCustomToolSchema(schema) }
            : { parametersJsonSchema: schema }),
        };
      }),
    },
  ];
}

function mapToolChoiceMode(toolChoice) {
  if (toolChoice === "none") return TOOL_CALLING_MODE.none;
  if (toolChoice === "any" || toolChoice === "required") return TOOL_CALLING_MODE.any;
  return TOOL_CALLING_MODE.auto;
}

function buildRequest(options, model, projectId, runtimeModel, effort, prepared) {
  const contents = convertMessages(options, model, runtimeModel, prepared);
  const geminiFamily = typeof runtimeModel === "string" && runtimeModel.startsWith("gemini-");
  const systemChunks = [];
  if (typeof options.system === "string" && options.system.length > 0) {
    systemChunks.push(sanitizeText(options.system));
  }
  if (geminiFamily && estimateRangeChars(contents, 0, contents.length) > FRONT_TRIM_SYSTEM_BACKUP_CHARS) {
    const backupSystem = leadingSystemMessagesText(options.messages);
    if (backupSystem) systemChunks.push(backupSystem);
  }
  const systemPrompt = systemChunks.filter(Boolean).join("\n\n");
  const request = {
    contents,
    ...(systemPrompt
      ? {
          systemInstruction: {
            role: GEMINI_ROLE.user,
            parts: [{ text: systemPrompt }],
          },
        }
      : {}),
  };
  const generationConfig = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (runtimeModel === "gemini-3.7-flash-tiered") {
    const selected = effort || "off";
    generationConfig.thinkingConfig = {
      thinkingLevel: selected === "high" || selected === "xhigh" ? "HIGH" : selected === "medium" ? "MEDIUM" : "LOW",
    };
  }
  // Carbon and Hydrogen pinned tier IDs (-low, -medium, -high, -xhigh)
  // require an explicit thinkingBudget to sustain thinking and differentiate
  // effort tiers cleanly: 2048 for low, 8192 for medium (thinkingLevel: MEDIUM
  // drops thoughts to 0), and dynamic -1 for high/xhigh (positive budgets on
  // -xhigh trigger an upstream THINKING_LEVEL_XHIGH 400 error).
  // Argon and Gemini 3.8 Flash use thinkingLevel.
  if (
    typeof runtimeModel === "string"
    && (runtimeModel.startsWith("gemini-4-carbon") || runtimeModel.startsWith("gemini-4-hydrogen"))
  ) {
    const fallbackEffort = runtimeModel.endsWith("-low")
      ? "low"
      : runtimeModel.endsWith("-medium")
        ? "medium"
        : runtimeModel.endsWith("-xhigh")
          ? "xhigh"
          : "high";
    const selected = effort || fallbackEffort;
    const thinkingBudget =
      selected === "low" || selected === "minimal" || selected === "off"
        ? 2048
        : selected === "medium"
          ? 8192
          : -1;
    generationConfig.thinkingConfig = {
      thinkingBudget,
      includeThoughts: true,
    };
  } else if (
    typeof runtimeModel === "string"
    && (runtimeModel.startsWith("gemini-4-argon") || runtimeModel.startsWith("gemini-3.8-flash"))
  ) {
    const fallbackEffort = runtimeModel.endsWith("-low")
      ? "low"
      : runtimeModel.endsWith("-medium")
        ? "medium"
        : "high";
    const selected = effort || fallbackEffort;
    generationConfig.thinkingConfig = {
      thinkingLevel: selected === "high" || selected === "xhigh" ? "HIGH" : selected === "medium" ? "MEDIUM" : "LOW",
      includeThoughts: true,
    };
  }
  const maxAllowed = getMaxOutputTokens(model.id, runtimeModel);
  const belowCeiling = options.maxTokens !== undefined && options.maxTokens < maxAllowed;
  if (!geminiFamily || belowCeiling) {
    generationConfig.maxOutputTokens =
      options.maxTokens !== undefined
        ? Math.min(options.maxTokens, maxAllowed)
        : Math.min(maxAllowed, model.maxTokens || maxAllowed);
  }
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  const usesLegacyToolSchema = model.id.startsWith("claude-") || model.id.startsWith("gpt-oss-");
  const tools = convertTools(options.tools, usesLegacyToolSchema);
  if (tools) {
    request.tools = tools;
    if (model.id.startsWith("claude-")) {
      request.toolConfig = options.toolChoice
        ? { functionCallingConfig: { mode: mapToolChoiceMode(options.toolChoice) } }
        : { functionCallingConfig: { mode: TOOL_CALLING_MODE.validated } };
    } else if (options.toolChoice) {
      request.toolConfig = { functionCallingConfig: { mode: mapToolChoiceMode(options.toolChoice) } };
    }
  }
  if (options.sessionId) request.sessionId = String(options.sessionId);
  return {
    project: projectId,
    model: runtimeModel,
    request,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: nowRequestId(),
  };
}

function mapUsage(usage) {
  const inputTokens = Math.max(0, (usage.promptTokenCount || 0) - (usage.cachedContentTokenCount || 0));
  const outputTokens = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  return {
    inputTokens,
    outputTokens,
    ...(usage.cachedContentTokenCount > 0 ? { cacheReadTokens: usage.cachedContentTokenCount } : {}),
  };
}

function classifyAntigravityError(message, status) {
  if (status === 401 || status === 403 || /\b(?:401|403)\b/.test(message)) return "AUTH";
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
  if (status === 429 || /\b429\b|rate.?limit/i.test(message)) return "RATE_LIMIT";
  if (status === 400 || /\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";
  if (status === 408 || status === 504 || /\btime(?:d)?\s*out\b|timeout/i.test(message)) return "TIMEOUT";
  if ((typeof status === "number" && status >= 500 && status <= 599) || /\b5\d\d\b|no capacity|temporarily unavailable/i.test(message)) {
    return "SERVER";
  }
  if (/stream ended (?:before|without)\b/i.test(message)) return "TRANSPORT";
  if (/\b(?:network|connection|socket|fetch)\b/i.test(message) || /\bECONN[A-Z]+\b/.test(message)) return "TRANSPORT";
  return "ANTIGRAVITY_ERROR";
}

function friendlyAntigravityError(status, text) {
  const message = redactSecrets(jsonOrTextError(text)).slice(0, 500);
  if (status === 400) {
    if (/API key not valid|API_KEY_INVALID/i.test(message)) {
      return "Antigravity login expired or credentials are invalid. Next: run /antigravity-login, then retry.";
    }
    if (/Invalid JSON payload|Unknown name/i.test(message)) {
      return `Antigravity request format was rejected by the backend (${message}). Next: switch to a simpler model or update the plugin.`;
    }
    return `Bad request from Antigravity. Backend said: ${message}`;
  }
  if (status === 401) return "Antigravity authentication failed. Next: run /antigravity-login, then retry.";
  if (status === 403) return `Antigravity denied this request. Backend said: ${message}`;
  if (status === 404) return `Antigravity could not find the requested model/resource. Backend said: ${message}`;
  if (status === 408) return "Antigravity timed out. Next: retry the same request.";
  if (status === 409) return "Antigravity reported a conflict. Next: retry once or start a new chat session.";
  if (status === 429) {
    const wait = message.match(/Resets? in ([^.\n]+)/i)?.[1]?.trim();
    if (/individual quota reached|exceeded your (?:current )?quota|quota (?:exceeded|exhausted)\b/i.test(message)) {
      return `Quota reached.${wait ? ` Please wait ${wait}.` : ""}`;
    }
    return `Rate limited by Antigravity.${wait ? ` Reset: ${wait}.` : ""}`;
  }
  if (status === 500) return "Antigravity had an internal server error. Next: retry or switch models.";
  if (status === 502) return "Antigravity returned a bad gateway error. Next: retry.";
  if (status === 503) return /capacity/i.test(message)
    ? "This model has no capacity right now. Next: retry later or switch models."
    : "Antigravity is temporarily unavailable. Next: retry or switch models.";
  if (status === 504) return "Antigravity timed out upstream. Next: retry.";
  return message || "Antigravity request failed";
}

function formatRequestDiagnostics(extra) {
  return `endpoint=${diagnostics.endpoint || "unknown"}, project=${extra.projectId}, runtimeModel=${extra.runtimeModel}, matched=${diagnostics.matchedModelDebug || "none"}, available=${diagnostics.availableModels || "unknown"}`;
}

function finishReasonOf(rawReason, hasToolCall, hasContent, errorMessage) {
  if (errorMessage && isContextWindowExceededError(errorMessage)) {
    return { kind: "error", failure: { message: errorMessage, code: CONTEXT_WINDOW_EXCEEDED_CODE } };
  }
  if (!hasContent) {
    return {
      kind: "error",
      failure: { message: "Antigravity returned a completed response with no content", code: EMPTY_RESPONSE_CODE },
    };
  }
  if (hasToolCall) return { kind: "tool-calls" };
  if (rawReason === "MAX_TOKENS") return { kind: "max-tokens" };
  if (!rawReason || rawReason === "STOP") return { kind: "stop" };
  return {
    kind: "error",
    failure: { message: `Antigravity finished with reason ${rawReason}`, code: "ANTIGRAVITY_FINISH_REASON" },
  };
}

function replayStateOf(model, runtimeModel, replayBlocks) {
  return {
    kind: "antigravity",
    version: 1,
    provider: PROVIDER,
    model: model.id,
    runtimeModel,
    blocks: replayBlocks,
  };
}

function processStreamLine(line, state) {
  if (!line.startsWith("data:")) return [];
  const json = line.slice(5).trim();
  if (!json || json === "[DONE]") return [];
  const chunk = safeJsonParse(json);
  if (!isRecord(chunk)) return [];
  if (isRecord(chunk.error)) {
    const message = chunk.error.message || JSON.stringify(chunk.error);
    throw new LlmError(String(message), classifyAntigravityError(String(message)));
  }
  const responseData = isRecord(chunk.response) ? chunk.response : chunk;
  const candidate = Array.isArray(responseData.candidates) ? responseData.candidates[0] : undefined;
  const parts = isRecord(candidate?.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const out = [];

  const closeCurrentBlock = () => {
    if (!state.currentBlock) return;
    const index = state.blocks.length - 1;
    if (state.currentBlock.type === "text") {
      out.push({
        type: "block-end",
        index,
        block: { type: "text", text: state.currentBlock.text },
      });
    } else {
      out.push({
        type: "block-end",
        index,
        block: { type: "reasoning", text: state.currentBlock.text },
      });
    }
    state.currentBlock = null;
  };

  for (const part of parts) {
    if (!isRecord(part)) continue;
    const textValue = part.text !== undefined
      ? part.text
      : (!isRecord(part.functionCall) && part.thoughtSignature ? "" : undefined);
    if (textValue !== undefined) {
      const isThinking = part.thought === true;
      const blockType = isThinking ? "reasoning" : "text";
      const delta = sanitizeText(textValue);
      // Gemini's final STOP chunk after a functionCall routinely carries an
      // empty `{ text: "" }` part with no signature. Ignore unsigned empty
      // deltas when no matching block is open so tool-call turns are not
      // padded with trailing empty text blocks and empty completions surface
      // as EMPTY_RESPONSE instead of succeeding with blank output.
      if (!delta && !part.thoughtSignature && (!state.currentBlock || state.currentBlock.type !== blockType)) {
        continue;
      }
      if (!state.currentBlock || state.currentBlock.type !== blockType) {
        closeCurrentBlock();
        state.currentBlock = {
          type: blockType,
          text: "",
          thinkingSignature: undefined,
          textSignature: undefined,
        };
        state.blocks.push(state.currentBlock);
        state.replayBlocks.push({ type: blockType });
        out.push({ type: "block-start", index: state.blocks.length - 1, blockType });
      }
      state.currentBlock.text += delta;
      state.hasContent = true;
      if (isThinking && part.thoughtSignature) {
        state.currentBlock.thinkingSignature = part.thoughtSignature;
        state.replayBlocks[state.blocks.length - 1].thinkingSignature = part.thoughtSignature;
      } else if (!isThinking && part.thoughtSignature) {
        state.currentBlock.textSignature = part.thoughtSignature;
        state.replayBlocks[state.blocks.length - 1].textSignature = part.thoughtSignature;
      }
      if (delta) {
        out.push({
          type: isThinking ? "reasoning-delta" : "text-delta",
          index: state.blocks.length - 1,
          text: delta,
        });
      }
    }
    if (isRecord(part.functionCall)) {
      closeCurrentBlock();
      const toolName = asString(part.functionCall.name) || "";
      const toolId = sanitizeToolCallId(part.functionCall.id || "", toolName);
      const args = isRecord(part.functionCall.args) ? part.functionCall.args : {};
      const argsText = JSON.stringify(args);
      const index = state.blocks.length;
      const block = { type: "tool-call", id: CallId(toolId), name: toolName, arguments: argsText };
      state.blocks.push(block);
      state.replayBlocks.push({
        type: "tool-call",
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      });
      state.hasContent = true;
      state.hasToolCall = true;
      out.push({ type: "block-start", index, blockType: "tool-call" });
      out.push({
        type: "tool-call-delta",
        index,
        id: CallId(toolId),
        ...(toolName ? { name: toolName } : {}),
        argumentsDelta: argsText,
      });
      out.push({ type: "block-end", index, block });
    }
  }

  if (candidate?.finishReason) state.finishReason = candidate.finishReason;
  if (isRecord(responseData.usageMetadata)) state.usage = responseData.usageMetadata;
  return out;
}

async function* streamResponseToChunks(response, model, runtimeModel, state) {
  if (!response.body) throw new LlmError("Antigravity response has no body", "TRANSPORT");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitLine = (line) => processStreamLine(line.replace(/\r$/, ""), state);
  const emitBufferedLines = function* () {
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      yield* emitLine(line);
    }
  };

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (!(result.value instanceof Uint8Array)) continue;
    buffer += decoder.decode(result.value, { stream: true });
    yield* emitBufferedLines();
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    yield* emitLine(buffer.trimEnd());
    buffer = "";
  }

  if (state.currentBlock) {
    const index = state.blocks.length - 1;
    if (state.currentBlock.type === "text") {
      yield { type: "block-end", index, block: { type: "text", text: state.currentBlock.text } };
    } else {
      yield {
        type: "block-end",
        index,
        block: { type: "reasoning", text: state.currentBlock.text },
      };
    }
    state.currentBlock = null;
  }

  if (!state.hasContent) return;
  yield { type: "usage", usage: mapUsage(state.usage || {}) };
  yield {
    type: "finish",
    reason: finishReasonOf(state.finishReason, state.hasToolCall, state.hasContent),
    replayState: replayStateOf(model, runtimeModel, state.replayBlocks),
  };
}

function createStreamState() {
  return {
    blocks: [],
    replayBlocks: [],
    currentBlock: null,
    finishReason: undefined,
    usage: undefined,
    hasContent: false,
    hasToolCall: false,
  };
}

// Capacity retries are transport behavior, not model output. Do not inject retry
// diagnostics into reasoning/text blocks: clients persist those blocks as assistant
// content, which makes transient 503s appear as the model's response.
function* emitTransientNotice(_message, _state) {
  return;
}

function sleepWithSignal(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(new LlmError("antigravity request aborted by caller", "ABORTED"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      cleanup();
      reject(new LlmError("antigravity request aborted by caller", "ABORTED"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function oauthCallbackHeaders(contentType = "text/html; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
  };
}

function sanitizeOAuthProviderError(text) {
  const redacted = redactSecrets(text).trim();
  const parsed = safeJsonParse(redacted);
  if (isRecord(parsed)) {
    const parts = [parsed.error, parsed.error_description].filter(
      (part) => typeof part === "string" && part.length > 0,
    );
    if (parts.length) return parts.join(": ").slice(0, 300);
  }
  return redacted.slice(0, 300) || "unknown OAuth provider error";
}

function base64Url(buffer) {
  return buffer.toString("base64url");
}

function generatePKCE() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}



export function openBrowser(url) {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true });
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true });
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    }
  } catch {
    // Best effort only.
  }
}

export function browserInteraction(signal) {
  return {
    signal,
    notify(event) {
      if (event.type === "auth_url") openBrowser(event.url);
    },
  };
}

export function terminalInteraction(signal) {
  return {
    signal,
    notify(event) {
      if (event.type !== "auth_url") return;
      console.log(event.instructions || "Open the following URL to sign in:");
      console.log(event.url);
      openBrowser(event.url);
    },
  };
}

export async function loginAntigravity(interaction = browserInteraction(), options = {}) {
  const flow = await createOAuthFlow({ ...options, signal: interaction.signal, discoverProject: loadCodeAssist });
  interaction.notify?.({ type: "auth_url", url: flow.authUrl, instructions: "Complete Google sign-in. Return to DSH to check completion." });
  return flow.result;
}

function credentialSummary(credentials) {
  if (!credentials) return { authenticated: false };
  return {
    authenticated: true,
    email: credentialEmail(credentials),
    projectId: credentialProjectId(credentials),
    expires: credentials.expires,
  };
}

export function beginWebLogin(store, options = {}) {
  return transitionLogin(async () => {
    if (webLoginFlow?.status === "pending") throw Object.assign(new Error("A login is already pending. Cancel it first."), { status: 409 });
    let proxy = options.proxy;
    if (options.accountId) {
      const captured = await captureAccount(store, options.accountId);
      proxy ??= captured.proxy;
    }
    proxy = normalizeProxyPolicy(proxy || { enabled: false });
    const oauth = await createOAuthFlow({ proxy, discoverProject: loadCodeAssist });
    const flow = { ...oauth, status: "pending", startedAt: Date.now(), error: "" };
    webLoginFlow = flow;
    flow.done = (async () => {
      try {
        const credentials = await oauth.result;
        if (flow.status !== "pending") return;
        // A cancel arriving during commit waits for this completion before mutating.
        const result = await store.upsert(credentials, { ...options, proxy });
        flow.accountId = result.accountId;
        flow.email = credentials.email;
        flow.status = "complete";
        clearAccountRuntime();
      } catch (error) {
        if (flow.status === "pending") { flow.status = "error"; flow.error = safeError(error); }
      } finally { flow.completedAt = Date.now(); }
    })();
    return { status: flow.status, flowId: flow.flowId, authUrl: flow.authUrl, startedAt: flow.startedAt };
  });
}

async function cancelPendingLogin(flowId) {
  const flow = webLoginFlow;
  if (flowId && flow?.flowId !== flowId) throw Object.assign(new Error("Login flow changed. Reload status."), { status: 409 });
  if (flow?.status === "pending") { flow.status = "canceled"; flow.cancel(); }
  await flow?.done;
}

export function cancelWebLogin(flowId) {
  return transitionLogin(() => cancelPendingLogin(flowId));
}

export function getWebLoginStatus() {
  const flow = webLoginFlow;
  if (!flow) return { status: "idle" };
  return { status: flow.status, flowId: flow.flowId, startedAt: flow.startedAt,
    completedAt: flow.completedAt, accountId: flow.accountId, email: flow.email, error: flow.error };
}

function credentialProjectId(credentials) {
  return asString(credentials?.projectId);
}

function credentialEmail(credentials) {
  return asString(credentials?.email);
}

function needsRefresh(credentials) {
  return !credentials?.access || !credentials.expires || credentials.expires <= Date.now() + 60000;
}

export async function refreshAntigravityToken(credentials) {
  return refreshOAuth(credentials, loadCodeAssist);
}

export function getApiKey(credentials) {
  const email = credentialEmail(credentials);
  return JSON.stringify({
    token: credentials.access,
    projectId: credentialProjectId(credentials) || defaultProjectId(email || "antigravity-default"),
  });
}

/** Compatibility name; all persisted writes now use the versioned account store. */
export class FileCredentialStore extends FileAccountStore {
  constructor(file = credentialPath()) { super(file); }
  async write(credentials) { return this.upsert(credentials); }
  async modify(fn) {
    const captured = await captureAccount(this);
    return captured.modify(fn);
  }
}

function normalizeModelSettings(raw) {
  const enabledModelIds = Array.isArray(raw?.enabledModelIds)
    ? raw.enabledModelIds.filter((id) => typeof id === "string" && id.length > 0 && !/\s/.test(id))
    : DEFAULT_ENABLED_MODEL_IDS;
  return {
    enabledModelIds: [...new Set(enabledModelIds.map((id) => TIER_ALIASES.get(id) ?? id))],
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
    catalogModels: Array.isArray(raw?.catalogModels)
      ? raw.catalogModels.filter((model) => isRecord(model) && typeof model.id === "string" && model.id.length > 0)
      : [],
  };
}

export class FileModelSettingsStore {
  #file;
  #chain = Promise.resolve();

  constructor(file = modelSettingsPath()) {
    this.#file = file;
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8"));
      return normalizeModelSettings(isRecord(parsed) ? parsed : undefined);
    } catch (error) {
      if (error && error.code === "ENOENT") return normalizeModelSettings(undefined);
      throw error;
    }
  }

  async write(settings) {
    const normalized = normalizeModelSettings(settings);
    await mkdir(dirname(this.#file), { recursive: true });
    const tempFile = `${this.#file}.tmp`;
    await writeFile(tempFile, JSON.stringify({ ...normalized, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
    await rename(tempFile, this.#file);
    return this.read();
  }

  modify(fn) {
    const next = (async () => {
      await this.#chain.catch(() => {});
      const current = await this.read();
      const updated = await fn(current);
      if (updated !== undefined) return this.write(updated);
      return current;
    })();
    this.#chain = next.catch(() => {});
    return next;
  }

  setEnabledModelIds(enabledModelIds) {
    return this.modify((current) => ({ ...current, enabledModelIds }));
  }

  setCatalogModels(catalogModels, options = {}) {
    return this.modify((current) => ({
      ...current,
      catalogModels,
      ...(Array.isArray(options.enabledModelIds) ? { enabledModelIds: options.enabledModelIds } : {}),
    }));
  }
}

function enabledModelSet(settings) {
  return new Set(normalizeModelSettings(settings).enabledModelIds);
}

function catalogModelsOf(settings) {
  const normalized = normalizeModelSettings(settings);
  if (!normalized.catalogModels.length) return MODELS;
  // The upstream catalog is refreshed on every quota fetch and replaces the
  // stored list wholesale, so an id upstream does not report - such as the
  // pinned Claude 5.5 reasoning tiers - would vanish again on the next fetch.
  // Keep every built-in entry the fetched catalog does not itself describe.
  const seen = new Set();
  const models = [];
  for (const model of normalized.catalogModels) {
    if (TIER_ALIASES.has(model.id) || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  const missing = MODELS.filter((model) => !seen.has(model.id));
  return missing.length ? [...models, ...missing] : models;
}

function configuredModels(settings) {
  const enabled = enabledModelSet(settings);
  return catalogModelsOf(settings).filter((model) => enabled.has(model.id)).sort(compareAntigravityModels);
}

function modelFromSettings(settings, modelId) {
  return catalogModelsOf(settings).find((model) => model.id === modelId) || modelById(modelId) || inferModelShape(modelId);
}

/**
 * Apply the optional context-window ceiling to one model's declared capacity.
 * Only a finite positive cap lowers the value; an unset or malformed one leaves
 * the catalog value untouched, so the adapter keeps working without config.
 * @param {number} declared - capacity the model or the catalog declares.
 * @param {number | undefined} maxContextWindow - configured ceiling, if any.
 * @returns {number} the capacity to report for this route.
 */
export function contextCapacity(declared, maxContextWindow) {
  if (typeof maxContextWindow !== "number" || !Number.isFinite(maxContextWindow) || maxContextWindow <= 0) {
    return declared;
  }
  return Math.min(declared, Math.floor(maxContextWindow));
}

export async function loginAndSave(store, interaction = browserInteraction(), options = {}) {
  const captured = options.accountId ? await captureAccount(store, options.accountId) : undefined;
  const proxy = normalizeProxyPolicy(options.proxy || captured?.proxy || { enabled: false });
  const credentials = await loginAntigravity(interaction, { proxy });
  interaction.signal?.throwIfAborted();
  if (store.upsert) await store.upsert(credentials, { ...options, proxy });
  else await store.write(credentials);
  clearAccountRuntime();
  return credentials;
}

async function ensureApiKey(store) {
  let credentials = await store.read();
  if (!credentials) {
    throw new LlmError("No Antigravity OAuth credentials. Run /antigravity-login.", "AUTH");
  }
  if (needsRefresh(credentials)) {
    try {
      credentials = await store.modify(async (current) => {
        if (!current) throw new LlmError("This account was removed. Select another account.", "AUTH");
        if (!needsRefresh(current)) return current;
        return refreshAntigravityToken(current);
      });
      authErrors.delete(store.accountId);
    } catch (error) {
      if (error?.code === "REAUTH_REQUIRED") authErrors.set(store.accountId, "Sign in again");
      throw error;
    }
  }
  let warmedProject = null;
  if (!credentialProjectId(credentials) && !antigravityEnv("PROJECT_ID")) {
    warmedProject = await loadCodeAssist(credentials.access);
    if (warmedProject) {
      await store.modify(async (current) => (current ? { ...current, projectId: warmedProject } : current));
    }
  }
  const projectId = resolveProjectId({
    credentialProjectId: credentialProjectId(credentials),
    email: credentialEmail(credentials),
    warmedProject,
  });
  setLastProjectId(projectId);
  return { token: credentials.access, projectId, email: credentialEmail(credentials) };
}

async function resolveRuntimeCandidates(token, projectId, model, effort) {
  const baseRuntimeModel =
    antigravityEnv("RUNTIME_MODEL")?.trim() || getAntigravityRequestModelId(model.id, effort);
  const dynamic = await fetchAvailableRuntimeModel(token, projectId, baseRuntimeModel);
  const initialRuntimeModel =
    dynamic?.id && isUsableRuntimeModelId(dynamic.id) ? dynamic.id : baseRuntimeModel;
  const runtimeCandidates = [initialRuntimeModel];
  const fallback = getFallbackRuntimeModel(initialRuntimeModel, effort);
  if (fallback && fallback !== initialRuntimeModel) runtimeCandidates.push(fallback);
  return runtimeCandidates;
}

async function fetchStreamResponse(endpoint, headers, body, signal) {
  try {
    return await providerFetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers,
      body,
      signal,
    });
  } catch (error) {
    setLastError(error);
    if (signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED", { cause: error });
    throw error;
  }
}

/**
 * Retry delay schedule for transient capacity exhaustion (503) and 5xx errors.
 * Starts at 60s (1 min), increases by 60s per attempt, capped at 300s (5 min).
 * Jitter (+0 to 5s) prevents lockstep thundering herds.
 * Configurable via ANTIGRAVITY_RETRY_INITIAL_DELAY_MS and ANTIGRAVITY_RETRY_MAX_DELAY_MS.
 * @param attempt - 1-based retry count.
 * @returns delay in milliseconds.
 */
function capacityRetryDelayMs(attempt) {
  const minInterval = Number(antigravityEnv("RETRY_INITIAL_DELAY_MS")) || 60_000;
  const maxInterval = Number(antigravityEnv("RETRY_MAX_DELAY_MS")) || 300_000;
  const base = Math.min(attempt * minInterval, maxInterval);
  const jitter = Math.floor(Math.random() * 5000);
  return base + jitter;
}

async function* requestAntigravityChunks(options, model, signal, store, attachments) {
  const supportsImages = model?.inputModalities?.includes("image") === true;

  // Read the durable attachments referenced by this request into wire bytes
  // before the first attempt, so retries reuse the same encoded images.
  // If the model does not support images, prepared is empty so historical images
  // degrade gracefully into text placeholders rather than breaking the session.
  const prepared = supportsImages ? await prepareImages(options, attachments, signal) : new Map();
  const { token, projectId } = await ensureApiKey(store);
  const effort = resolveReasoning(model, options.reasoningEffort);
  const runtimeCandidates = await resolveRuntimeCandidates(token, projectId, model, effort);
  const requestHeaders = {
    ...antigravityHeaders(token),
    ...attributionHeaderBag(),
    ...(model.id.startsWith("claude-") ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
  };

  const state = createStreamState();
  // Default to 1 pass across endpointCandidates() so 503/5xx capacity hiccups,
  // 429 rate limits, and empty streams surface immediately to DSH's visible
  // retry countdown (`SERVER`, `RATE_LIMIT`, `EMPTY_RESPONSE`) instead of
  // silently sleeping 1-5 minutes inside the adapter. Set ANTIGRAVITY_MAX_RETRIES
  // > 1 only when running standalone without a harness retry policy.
  const maxAttempts = Number(antigravityEnv("MAX_RETRIES")) || 1;
  let response;
  let lastText = "";
  const runtimeModel = runtimeCandidates[0];
  setLastResolvedRuntimeModel(runtimeModel);
  const body = JSON.stringify(buildRequest(options, model, projectId, runtimeModel, effort, prepared));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED");

    if (attempt > 0) {
      const delay = capacityRetryDelayMs(attempt);
      diagnostics.retries = (diagnostics.retries || 0) + 1;
      const friendly = friendlyAntigravityError(response?.status, lastText);
      const delayMinutes = Math.max(1, Math.round(delay / 60000));
      const waitNotice = `[Antigravity Notice: Model ${runtimeModel} is at capacity (${response?.status || 503}: ${friendly}). Waiting ${delayMinutes} min before retrying (attempt ${attempt}/${maxAttempts - 1})...]`;
      yield* emitTransientNotice(waitNotice, state);
      await sleepWithSignal(delay, signal);
    }

    let primaryFailure;
    for (const endpoint of endpointCandidates()) {
      if (signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED");
      setLastEndpoint(endpoint);
      try {
        response = await fetchStreamResponse(endpoint, requestHeaders, body, signal);
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw error;
        const code = error?.cause?.code || error?.code;
        const transient = ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT"].includes(code)
          || (!code && error instanceof TypeError && error.message === "fetch failed");
        if (!transient) throw error;
        response = undefined;
        lastText = "Temporary network failure";
        primaryFailure ??= { response: undefined, text: lastText, endpoint };
        continue;
      }
      setLastStatus(response.status);
      if (response.ok) break;
      lastText = await response.text();
      recordTransientError(response.status, runtimeModel, endpoint, lastText);
      if (response.status === 429 && /Individual quota reached/i.test(lastText)) break;
      if ([429, 500, 502, 503, 504].includes(response.status)) {
        primaryFailure ??= { response, text: lastText, endpoint };
      }
      if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) break;
    }

    // If the primary (sandbox) endpoint failed transiently (e.g. 503 capacity)
    // and the secondary production fallback only returned 404/403 because it
    // does not host preview models, preserve the primary retryable failure so
    // the harness retries (`SERVER`) instead of halting on 404/AUTH.
    if (!response?.ok && primaryFailure && (response?.status === 404 || response?.status === 403)) {
      response = primaryFailure.response;
      lastText = primaryFailure.text;
      setLastEndpoint(primaryFailure.endpoint);
      setLastStatus(primaryFailure.response?.status);
    }

    if (response?.ok) {
      for await (const chunk of streamResponseToChunks(response, model, runtimeModel, state)) {
        yield chunk;
      }
      if (state.hasContent) return;
      // If response was 200 but completely empty, retry in outer loop when maxAttempts > 1
    }

    // Fail immediately once all endpoints returned 429 so account failover or
    // caller retry handles it without a silent 1-5 minute stall.
    if (response?.status === 429) break;

    // Non-retryable client errors (e.g. 400 Bad Request, 401 Auth error): fail immediately
    if (response && ![429, 500, 502, 503, 504].includes(response.status)) break;
  }

  if (!response || !response.ok) {
    const friendly = friendlyAntigravityError(response?.status, lastText);
    throw new LlmError(
      `Antigravity API error (${response?.status ?? "no response"}, ${formatRequestDiagnostics({ projectId, runtimeModel })}): ${friendly}`,
      classifyAntigravityError(friendly, response?.status),
    );
  }

  throw new LlmError("Antigravity API returned an empty response", EMPTY_RESPONSE_CODE);
}

/**
 * Whether a failure means "this account is out of quota" — the one error class
 * another account can absorb, because the request produced no content.
 * @param {unknown} error
 * @returns {boolean}
 */
function isAccountQuotaFailure(error) {
  if (error?.code === QUOTA_EXCEEDED_CODE) return true;
  const message = typeof error?.message === "string" ? error.message : "";
  return message !== "" && isQuotaExceededError(message);
}

export class AntigravityAdapter extends LlmAdapter {
  #store;
  #modelSettings;
  /** Optional resolver returning the mounted attachment store, or undefined. */
  #resolveAttachments;
  #usageStore;
  /** Optional ceiling applied to every reported context window. */
  #maxContextWindow;
  /** Optional per-session account pins; undefined keeps the active account only. */
  #sessionAccounts;
  /** Lazy resolver for the session store used to inherit a subagent's parent pin. */
  #sessions;
  /** Whether an exhausted account hands the same request to another signed-in account. */
  #failoverOnQuota;
  /** Optional observer for account switches (logging, diagnostics). */
  #onAccountSwitch;
  /** Idle watchdog timeout (ms) before aborting a silent stream with TIMEOUT. */
  #streamIdleTimeoutMs;

  constructor(
    store = new FileCredentialStore(),
    modelSettings = new FileModelSettingsStore(),
    resolveAttachments = () => undefined,
    usageStore = new FileUsageStore(usagePath()),
    options = {},
  ) {
    super();
    this.#store = store;
    this.#modelSettings = modelSettings;
    this.#resolveAttachments = resolveAttachments;
    this.#usageStore = usageStore;
    this.#maxContextWindow = options.maxContextWindow;
    this.#sessionAccounts = options.sessionAccounts;
    this.#sessions = options.sessions;
    this.#failoverOnQuota = options.failoverOnQuota !== false;
    this.#onAccountSwitch = options.onAccountSwitch;
    const configuredIdle = Number(options.streamIdleTimeoutMs) || Number(antigravityEnv("STREAM_IDLE_TIMEOUT_MS"));
    this.#streamIdleTimeoutMs = Number.isFinite(configuredIdle) && configuredIdle >= 1000
      ? configuredIdle
      : STREAM_IDLE_TIMEOUT_MS;
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME };
  }

  /**
   * The pin governing one request: the session's own record, else the nearest
   * ancestor's. Subagent and forked sessions carry no pin of their own, so this
   * is what makes them inherit the account the work started on.
   * @param {string | undefined} sessionId
   * @returns {{ accountId: string, reason: string } | undefined}
   */
  #pinnedAccount(sessionId) {
    if (this.#sessionAccounts === undefined || sessionId === undefined) return undefined;
    let id = sessionId;
    for (let depth = 0; id !== undefined && depth < 8; depth += 1) {
      const record = this.#sessionAccounts.get(id);
      if (record !== undefined) return record;
      const session = this.#sessions?.()?.get?.(id);
      const parent = session?.header?.parentSession;
      id = parent === undefined ? undefined : String(parent);
    }
    return undefined;
  }

  /**
   * Capture one account, falling back to the active account when a pin names an
   * account that was removed. A stale pin must not fail the turn.
   * @param {string | undefined} accountId
   */
  async #captureAccountFor(accountId) {
    if (accountId === undefined) return captureAccount(this.#store);
    try {
      return await captureAccount(this.#store, accountId);
    } catch (error) {
      if (error?.code === "ACCOUNT_NOT_FOUND") return captureAccount(this.#store);
      throw error;
    }
  }

  /**
   * The next signed-in account to try after a quota failure.
   * @param {Set<string>} tried - account ids already attempted for this step.
   * @returns {Promise<string | undefined>}
   */
  async #nextAccount(tried) {
    if (typeof this.#store?.summaries !== "function") return undefined;
    const document = await this.#store.summaries();
    const accounts = Array.isArray(document?.accounts) ? document.accounts : [];
    const candidate = accounts.find((account) => account.authState === "ready" && !tried.has(account.id));
    return candidate?.id;
  }

  async listModels(provider) {
    const captured = this.#store.capture ? await this.#store.capture() : this.#store;
    const settings = await accountSettings(this.#modelSettings, captured);
    return configuredModels(settings).map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      context: { contextWindow: contextCapacity(model.contextWindow, this.#maxContextWindow) },
      defaultMaxTokens: model.maxTokens,
      ...reasoningInfo(model),
    }));
  }

  async resolveModel(provider, modelId, signal) {
    if (signal?.aborted) return Promise.reject(new LlmError("antigravity model resolution aborted", "ABORTED"));
    const captured = this.#store.capture ? await this.#store.capture() : this.#store;
    const settings = await accountSettings(this.#modelSettings, captured);
    const model = modelFromSettings(settings, modelId);
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      context: { contextWindow: contextCapacity(model.contextWindow, this.#maxContextWindow) },
      defaultMaxTokens: model.maxTokens,
      ...reasoningInfo(model),
    };
  }

  async *stream(options) {
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId);
    if (this.#sessionAccounts !== undefined) await this.#sessionAccounts.ready();
    const pin = this.#pinnedAccount(sessionId);
    const tried = new Set();
    let target = pin?.accountId;
    let failure;
    let switched = false;
    // One attempt per account plus headroom for a stale pin. The cap keeps a
    // pathological account list (an entry that disappears between the summary
    // and its capture) from looping on the same credentials.
    for (let attempt = 0; attempt < ACCOUNT_ATTEMPT_LIMIT; attempt += 1) {
      // Record the requested id before capture: when a candidate capture falls
      // back to the active account, the request must not select that candidate
      // again from an unchanged summary.
      if (target !== undefined) tried.add(target);
      const captured = await this.#captureAccountFor(target);
      const accountId = captured?.accountId;
      if (typeof accountId === "string") tried.add(accountId);
      let yielded = false;
      try {
        for await (const chunk of streamWithTransport(
          { account: captured, kind: "api", signal: options.signal },
          () => this.streamCaptured(options, captured),
        )) {
          yielded = true;
          yield chunk;
        }
        // Only an account that actually served the step becomes the session's
        // pin; a candidate that vanished before its capture did not work.
        if (switched && this.#sessionAccounts !== undefined && sessionId !== undefined) {
          try {
            await this.#sessionAccounts.pin(sessionId, accountId, "failover");
          } catch (pinError) {
            this.#onAccountSwitch?.({ sessionId, from: pin?.accountId, to: accountId, error: pinError });
          }
        }
        return;
      } catch (error) {
        failure = error;
        // Only a request that produced no content may move accounts: a stream
        // that already emitted blocks cannot be replayed on another account.
        if (yielded || !this.#failoverOnQuota || !isAccountQuotaFailure(error)) throw error;
        const next = await this.#nextAccount(tried);
        if (next === undefined) throw error;
        this.#onAccountSwitch?.({ sessionId, from: accountId, to: next });
        switched = true;
        target = next;
      }
    }
    throw failure ?? new LlmError("antigravity account failover exhausted", QUOTA_EXCEEDED_CODE);
  }

  async *streamCaptured(options, captured) {
    const settings = await accountSettings(this.#modelSettings, captured);
    const model = modelFromSettings(settings, options.model);

    const consumer = new AbortController();
    const upstream =
      options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
    const idleTimeoutMs = this.#streamIdleTimeoutMs;
    const watchdog = idleWatchdog(upstream, idleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE);
    const iterator = requestAntigravityChunks(
      options,
      model,
      watchdog.signal,
      captured,
      this.#resolveAttachments(),
    )[Symbol.asyncIterator]();

    let exhausted = false;
    try {
      while (true) {
        const result = await watchdog.next(iterator);
        if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
          throw new LlmError(`antigravity stream idle timeout after ${idleTimeoutMs}ms`, "TIMEOUT");
        }
        if (result.done) {
          exhausted = true;
          return;
        }
        // Count what this request actually cost. The usage chunk is emitted once
        // per completed stream, so a capacity retry that never produced content
        // does not inflate the totals; a turn the caller aborts mid-stream is not
        // counted either, because no usage chunk reaches us.
        const chunk = result.value;
        if (isRecord(chunk) && chunk.type === "usage" && isRecord(chunk.usage)) {
          const reported =
            (chunk.usage.inputTokens || 0) +
            (chunk.usage.outputTokens || 0) +
            (chunk.usage.cacheReadTokens || 0);
          // A stream that reported no usage at all must not be counted as a
          // request: upstream omits usageMetadata on some responses, and the test
          // doubles never send it.
          if (reported > 0) {
            void this.#usageStore.record(captured?.accountId, model.id, chunk.usage).catch(() => {});
          }
        }
        yield chunk;
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`antigravity stream idle timeout after ${idleTimeoutMs}ms`, "TIMEOUT", { cause: error });
      }
      if (options.signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED", { cause: error });
      throw error;
    } finally {
      consumer.abort("antigravity stream consumer stopped");
      if (!exhausted) {
        try {
          await iterator.return(undefined);
        } catch {
          // Ignore upstream cleanup failure after consumer cancellation.
        }
      }
      watchdog[Symbol.dispose]();
    }
  }
}

function doctorText() {
  const current = getAntigravityDiagnostics();
  return [
    `provider=${PROVIDER}`,
    `lastResolvedRuntimeModel=${current.resolvedRuntimeModel || "none"}`,
    `availableModels=${current.availableModels || "none"}`,
    `matchedModel=${current.matchedModelDebug || "none"}`,
    `lastEndpoint=${current.endpoint || "none"}`,
    `lastStatus=${current.status ?? "none"}`,
    `lastProjectId=${current.projectId || "none"}`,
    `lastError=${current.error ? redactSecrets(current.error) : "none"}`,
    `credentialPath=${credentialPath()}`,
    "transport=native-cloud-code-assist-sse",
    "runtimeCli=not-used",
    "commands=/antigravity-account /antigravity-login /antigravity-quota /antigravity-doctor /antigravity-logout",
  ].join("\n");
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function sendMethodNotAllowed(response) {
  sendJson(response, 405, { ok: false, error: "method-not-allowed" });
}

function quotaCardRows(quota) {
  const modelRows = (quota.models || [])
    .filter((model) => !/tab_|chat_/i.test(model.modelId))
    .map((model) => ({
      id: model.modelId,
      label: model.displayName || model.modelId,
      remainingPercent: remainingPercent(model.remainingFraction),
      remainingFraction: model.remainingFraction,
      resetLabel: formatReset(model.resetTime),
      resetTime: model.resetTime,
      provider: model.modelProvider,
      recommended: model.recommended,
      supportsThinking: model.supportsThinking,
      supportsImages: model.supportsImages,
    }));
  const bucketRows = (quota.groups || []).flatMap((group) =>
    (group.buckets || []).map((bucket) => ({
      id: bucket.bucketId,
      label: bucket.displayName,
      group: group.displayName,
      window: bucket.window,
      remainingPercent: remainingPercent(bucket.remainingFraction),
      remainingFraction: bucket.remainingFraction,
      resetLabel: formatReset(bucket.resetTime),
      resetTime: bucket.resetTime,
      description: bucket.description,
      disabled: bucket.disabled === true,
    })),
  );
  const groups = (quota.groups || []).map((group) => ({
    displayName: group.displayName,
    description: group.description,
    buckets: (group.buckets || []).map((bucket) => ({
      id: bucket.bucketId,
      label: bucket.displayName,
      window: bucket.window,
      remainingPercent: remainingPercent(bucket.remainingFraction),
      remainingFraction: bucket.remainingFraction,
      resetLabel: formatReset(bucket.resetTime),
      resetTime: bucket.resetTime,
      description: bucket.description,
      disabled: bucket.disabled === true,
    })),
  }));
  return { modelRows, bucketRows, groups, groupDescription: quota.groupDescription };
}

function publicModelMatchNeedles(modelId) {
  switch (modelId) {
    case "gemini-3.7-flash":
      return ["gemini-3.7-flash", "gemini 3.7 flash"];
    case "gemini-3.6-flash":
      return ["gemini-3.6-flash", "gemini 3.6 flash"];
    case "gemini-3.5-flash":
      return ["gemini-3.5-flash", "gemini 3.5 flash", "gemini-3-flash-agent"];
    case "gemini-3.1-pro":
      return ["gemini-3.1-pro", "gemini 3.1 pro", "gemini-pro-agent"];
    case "claude-sonnet-4-6":
      return ["claude-sonnet-4-6", "claude sonnet 4.6"];
    case "claude-opus-4-6":
      return ["claude-opus-4-6", "claude opus 4.6"];
    case "gpt-oss-120b":
      return ["gpt-oss-120b", "gpt oss 120b"];
    default:
      return [modelId];
  }
}

function rowsForPublicModel(model, quota) {
  if (!quota) return [];
  const { modelRows } = quotaCardRows(quota);
  const needles = publicModelMatchNeedles(model.id);
  return modelRows.filter((row) => {
    const haystack = `${row.id || ""} ${row.label || ""}`.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  });
}

function publicModelQuotaSummary(model, quota) {
  const rows = rowsForPublicModel(model, quota);
  if (!rows.length) return {};
  const withRemaining = rows.filter((row) => typeof row.remainingFraction === "number");
  const best = (withRemaining.length ? withRemaining : rows).reduce((left, right) => {
    const leftValue = typeof left.remainingFraction === "number" ? left.remainingFraction : -1;
    const rightValue = typeof right.remainingFraction === "number" ? right.remainingFraction : -1;
    return rightValue > leftValue ? right : left;
  });
  return {
    available: true,
    remainingFraction: best.remainingFraction,
    remainingPercent: best.remainingPercent,
    resetLabel: best.resetLabel,
    resetTime: best.resetTime,
  };
}

function runtimeTierIds(modelId) {
  const route = ROUTING[modelId];
  if (route === undefined) return [];
  const candidates = [route.off, ...Object.values(route.routing ?? {}), route.defaultRequestId];
  return [...new Set(candidates.filter((id) => typeof id === "string" && id !== ""))];
}

export function modelOptionsPayload(settings, quota) {
  const enabled = enabledModelSet(settings);
  const allModels = [...catalogModelsOf(settings)].sort(compareAntigravityModels);
  const catalogQuotaMap = new Map();
  if (quota?.catalogModels) {
    for (const cm of quota.catalogModels) {
      catalogQuotaMap.set(cm.id, cm);
    }
  }
  const options = allModels.map((model) => {
    const catalogQuota = catalogQuotaMap.get(model.id)
      ?? runtimeTierIds(model.id).map((id) => catalogQuotaMap.get(id)).find((entry) => entry !== undefined);
    const fallbackQuota = publicModelQuotaSummary(model, quota);
    const quotaInfo = catalogQuota?.remainingFraction !== undefined
      ? {
          available: true,
          remainingFraction: catalogQuota.remainingFraction,
          remainingPercent: remainingPercent(catalogQuota.remainingFraction),
          resetLabel: catalogQuota.resetTime ? formatReset(catalogQuota.resetTime) : undefined,
          resetTime: catalogQuota.resetTime,
        }
      : fallbackQuota;
    return {
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      reasoningEfforts: model.reasoningEfforts,
      enabled: enabled.has(model.id),
      ...quotaInfo,
    };
  });
  options.sort(compareAntigravityModelOptions);
  return {
    enabledModelIds: [...enabled],
    options,
  };
}

async function webStatus(store, modelSettings, usageStore) {
  const credentials = await store.read();
  const captured = store.capture ? await store.capture() : store;
  const quota = getCachedQuota(captured);
  const settings = await modelSettings.read();
  const accountState = await store.summaries();
  return {
    ...credentialSummary(credentials),
    ...accountState,
    // The CLI session is deliberately independent of activeAccountId: the
    // settings page moves it without changing which account DSH itself uses.
    cli: agyCliStatus(),
    login: getWebLoginStatus(),
    models: modelOptionsPayload(settings, quota),
    quota:
      quota === undefined
        ? undefined
        : {
            accountId: quota.accountId,
            projectId: quota.projectId,
            planLabel: quota.planLabel,
            fetchedAt: quota.fetchedAt,
            ...quotaCardRows(quota),
            usage: usageStore === undefined ? undefined : await usageStore.summary(quota.accountId),
          },
  };
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed = safeJsonParse(text);
  if (!isRecord(parsed)) throw new Error("invalid JSON request body");
  return parsed;
}

function emitLlmAdaptersUpdated(ctx) {
  try {
    ctx.emit("llm/adapters-updated");
  } catch (error) {
    setLastError(error);
  }
}

/**
 * The state the per-session account picker renders: every account (with its
 * sign-in state), the profile-wide active account, and this session's pin.
 * @param {FileSessionAccountStore} sessionAccounts - pin owner.
 * @param {{ summaries: () => Promise<any> }} store - credential store.
 * @param {string | undefined} sessionId - session whose pin to read.
 * @returns {Promise<{ activeAccountId: string | null, accounts: { id: string, email?: string, label?: string, authState?: string }[], pin: { accountId: string, reason: string } | null }>}
 */
export async function sessionAccountView(sessionAccounts, store, sessionId) {
  await sessionAccounts.ready();
  const document = await store.summaries();
  const accounts = Array.isArray(document?.accounts) ? document.accounts : [];
  return {
    activeAccountId: document?.activeAccountId ?? null,
    accounts: accounts.map((account) => ({
      id: account.id,
      email: account.email,
      label: account.label,
      authState: account.authState,
    })),
    pin: sessionId ? sessionAccounts.get(sessionId) ?? null : null,
  };
}

/**
 * The pin a view can actually use. A pin naming an account that was removed
 * resolves to undefined so callers fall back to the active account.
 * @param {{ pin?: { accountId: string } | null, accounts?: readonly { id: string }[] } | undefined} view - session account view.
 * @returns {string | undefined}
 */
export function pinnedAccountOf(view) {
  const pinned = view?.pin?.accountId;
  if (pinned === undefined) return undefined;
  const accounts = Array.isArray(view?.accounts) ? view.accounts : [];
  return accounts.some((account) => account.id === pinned) ? pinned : undefined;
}

/**
 * Apply one picker choice. A nullish `accountId` clears the pin so the session
 * follows the active account again.
 * @param {FileSessionAccountStore} sessionAccounts - pin owner.
 * @param {{ summaries: () => Promise<any> }} store - credential store.
 * @param {unknown} sessionId - session to change.
 * @param {unknown} accountId - chosen account id, or null/undefined to clear.
 * @returns {Promise<{ ok: true } | { ok: false, error: "missing-session" | "account-not-found" | "account-not-signed-in" }>}
 */
export async function updateSessionAccount(sessionAccounts, store, sessionId, accountId) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return { ok: false, error: "missing-session" };
  await sessionAccounts.ready();
  if (accountId === null || accountId === undefined) {
    await sessionAccounts.clear(id);
    return { ok: true };
  }
  const document = await store.summaries();
  const accounts = Array.isArray(document?.accounts) ? document.accounts : [];
  const account = accounts.find((candidate) => candidate.id === String(accountId));
  if (account === undefined) return { ok: false, error: "account-not-found" };
  // `refresh-required` means the access token expired, not that the account is
  // unusable: the stored refresh token renews it on the next request. The
  // settings page already treats both states as ready.
  if (account.authState !== undefined && !USABLE_ACCOUNT_STATES.has(account.authState)) {
    return { ok: false, error: "account-not-signed-in" };
  }
  await sessionAccounts.pin(id, account.id, "pinned");
  return { ok: true };
}

function registerWebApi(ctx, store, modelSettings, usageStore, sessionAccounts) {
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "prefix",
          path: "/antigravity/api",
          handler: async (request, response) => {
            const url = new URL(request.url || "/", "http://dsh.local");
            const path = url.pathname.replace(/^\/antigravity\/api\/?/, "");
            try {
              if (path === "status" || path === "") {
                if (request.method !== "GET") return sendMethodNotAllowed(response);
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings, usageStore) });
              }
              if (path === "login") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                const value = await beginWebLogin(store, { accountId: body.accountId, activate: body.activate === true, proxy: body.proxy });
                return sendJson(response, 200, { ok: true, value });
              }
              if (path === "login/callback") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                if (!webLoginFlow || webLoginFlow.flowId !== body.flowId) return sendJson(response, 409, { ok: false, error: "login-flow-changed" });
                webLoginFlow.acceptCallback(body.callbackUrl);
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings, usageStore) });
              }
              if (path === "login/cancel") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                await cancelWebLogin(body.flowId);
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings, usageStore) });
              }
              if (path === "accounts") {
                if (request.method !== "GET") return sendMethodNotAllowed(response);
                return sendJson(response, 200, { ok: true, value: await store.summaries() });
              }
              if (path === "session-account") {
                if (request.method === "GET") {
                  const value = await sessionAccountView(sessionAccounts, store, url.searchParams.get("sessionId") || undefined);
                  return sendJson(response, 200, { ok: true, value });
                }
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                const outcome = await updateSessionAccount(sessionAccounts, store, body.sessionId, body.accountId);
                if (!outcome.ok) {
                  const status = outcome.error === "missing-session" ? 400 : outcome.error === "account-not-found" ? 404 : 409;
                  return sendJson(response, status, { ok: false, error: outcome.error });
                }
                return sendJson(response, 200, { ok: true, value: await sessionAccountView(sessionAccounts, store, String(body.sessionId)) });
              }
              if (path === "accounts/cli") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                const accountState = await store.summaries();
                const account = accountState.accounts.find((candidate) => candidate.id === body.accountId);
                if (!account) return sendJson(response, 404, { ok: false, error: "account-not-found" });
                const captured = await captureAccount(store, account.id);
                let credentials = await captured.read();
                if (!credentials?.refresh) return sendJson(response, 409, { ok: false, error: "account-needs-sign-in" });
                // An expired access token is not a blocker: the CLI holds the same
                // refresh token. Refresh through the account's own route when that
                // works, and otherwise hand the CLI the stored pair, which it can
                // refresh itself.
                if (!credentials.access || Number(credentials.expires) <= Date.now() + 60_000) {
                  try {
                    credentials = await captured.modify((current) => {
                      if (!current) return current;
                      if (current.access && Number(current.expires) > Date.now() + 60_000) return current;
                      return runWithTransport(captured, () => refreshAntigravityToken(current));
                    });
                  } catch { /* keep the stored pair; the CLI refreshes it in place */ }
                }
                try {
                  writeAgyCliDocument(credentials, {
                    email: account.email || credentialEmail(credentials),
                    // Every listed account can be written back from this page, so
                    // only a CLI session outside the list is worth preserving.
                    knownEmails: accountState.accounts.map((candidate) => candidate.email).filter(Boolean),
                  });
                } catch (error) {
                  if (error?.code === "AGY_CLI_CREDENTIALS") return sendJson(response, 409, { ok: false, error: "account-needs-sign-in" });
                  throw error;
                }
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings, usageStore) });
              }
              if (path === "accounts/activate") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                await cancelPendingLogin();
                await store.activate(body.accountId, body.expectedRevision);
                clearAccountRuntime(); emitLlmAdaptersUpdated(ctx);
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings, usageStore) });
              }
              if (path === "accounts/remove") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                await cancelPendingLogin();
                await store.removeAccount(body.accountId, body.replacementAccountId, body.expectedRevision);
                clearAccountRuntime(); emitLlmAdaptersUpdated(ctx);
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings, usageStore) });
              }
              if (path === "accounts/proxy") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                const proxy = normalizeProxyPolicy(body.proxy);
                await store.setProxy(body.accountId, proxy, body.expectedRevision);
                clearAccountRuntime();
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings, usageStore) });
              }
              if (path === "proxies") {
                if (request.method !== "GET") return sendMethodNotAllowed(response);
                // Live discovery: a recreated container gets a new bridge IP, so a
                // cached list would hand out a stale address.
                const port = Number.parseInt(antigravityEnv("PROXY_PORT") || "", 10);
                return sendJson(response, 200, {
                  ok: true,
                  value: await discoverDockerProxies({
                    socketPath: antigravityEnv("DOCKER_SOCKET") || undefined,
                    port: Number.isInteger(port) && port > 0 ? port : undefined,
                  }),
                });
              }
              if (path === "proxy/test") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                return sendJson(response, 200, { ok: true, value: await testProxy(body.url) });
              }
              if (path === "quota") {
                if (request.method !== "GET" && request.method !== "POST") {
                  return sendMethodNotAllowed(response);
                }
                const body = request.method === "POST" ? await readRequestJson(request) : {};
                // The composer's quota meter reads the account this Session is
                // actually spending. A pinned Session reports its own pin; an
                // unpinned one (or a stale pin) reports the active account.
                let accountId = typeof body.accountId === "string" && body.accountId !== "" ? body.accountId : undefined;
                if (accountId === undefined && typeof body.sessionId === "string" && body.sessionId !== "") {
                  accountId = pinnedAccountOf(await sessionAccountView(sessionAccounts, store, body.sessionId));
                }
                const quota = await fetchAccountQuota(store, modelSettings, accountId);
                emitLlmAdaptersUpdated(ctx);
                return sendJson(response, 200, {
                  ok: true,
                  value: {
                    accountId: quota.accountId,
                    projectId: quota.projectId,
                    planLabel: quota.planLabel,
                    fetchedAt: quota.fetchedAt,
                    ...quotaCardRows(quota),
                    usage: await usageStore.summary(quota.accountId),
                    models: modelOptionsPayload(await modelSettings.read(), quota),
                  },
                });
              }
              if (path === "models") {
                if (request.method === "GET") {
                  const captured = store.capture ? await store.capture() : store;
                  return sendJson(response, 200, {
                    ok: true,
                    value: modelOptionsPayload(await modelSettings.read(), getCachedQuota(captured)),
                  });
                }
                if (request.method === "POST") {
                  const body = await readRequestJson(request);
                  if (!Array.isArray(body.enabledModelIds)) {
                    return sendJson(response, 400, { ok: false, error: "enabledModelIds must be an array" });
                  }
                  const captured = store.capture ? await store.capture(body.accountId) : store;
                  const settings = await modelSettings.setEnabledModelIds(body.enabledModelIds);
                  emitLlmAdaptersUpdated(ctx);
                  return sendJson(response, 200, {
                    ok: true,
                    value: modelOptionsPayload(settings, getCachedQuota(captured)),
                  });
                }
                return sendMethodNotAllowed(response);
              }
              if (path === "logout") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                await store.delete();
                clearAccountRuntime();
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings, usageStore) });
              }
              return sendJson(response, 404, { ok: false, error: "not-found" });
            } catch (error) {
              return sendJson(response, 500, { ok: false, error: safeError(error) });
            }
          },
        }),
      "dsh-antigravity: web api",
    );
  });
}

export const SEARCH_PROVIDER_ID = "antigravity";

/**
 * Resolve Vertex AI grounding redirect URLs to their canonical destination URLs.
 * Falls back to the redirect URL if resolution fails or times out.
 * @param url - redirect or destination URL.
 * @param timeoutMs - maximum time allowed for HEAD resolution.
 * @returns canonical destination URL or original URL.
 */
async function resolveRedirect(url, timeoutMs = 2000) {
  if (!url || !url.includes("grounding-api-redirect")) return url;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await providerFetch(url, { method: "HEAD", redirect: "manual", signal: controller.signal });
    clearTimeout(timer);
    const loc = res.headers.get("location");
    return loc || url;
  } catch {
    return url;
  }
}

/**
 * Google Search provider registered with `ctx.web` to power DSH's `web_search` tool.
 * Uses Google Antigravity OAuth and Cloud Code Assist with Google Search grounding.
 */
export class AntigravitySearchProvider {
  id;
  #store;

  constructor(store = new FileCredentialStore(credentialPath()), id = SEARCH_PROVIDER_ID) {
    this.#store = store;
    this.id = id;
  }

  available() {
    // WebSearchProvider requires a synchronous, local-only usability check.
    try {
      const file = this.#store.path();
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 512 * 1024 || (process.platform !== "win32" && (stat.mode & 0o077))) return false;
      const doc = JSON.parse(readFileSync(file, "utf8"));
      if (doc.version === 2) return Boolean(doc.activeAccountId && doc.accounts?.some((a) => a.id === doc.activeAccountId && a.credentials?.refresh));
      return !doc.version && Boolean(doc.refresh);
    } catch { return false; }
  }

  async search(request, signal) {
    const captured = await captureAccount(this.#store);
    return runWithTransport({ account: captured, kind: "api", signal }, () => this.searchCaptured(request, signal, captured));
  }

  async searchCaptured(request, signal, captured) {
    if (signal?.aborted) throw new LlmError("Search request was aborted by caller", "ABORTED");
    const query = String(request?.query || "").trim();
    if (!query) return { content: "No search query provided.", sources: [], truncated: false };

    const maxResults = typeof request.maxResults === "number" && request.maxResults > 0 ? request.maxResults : 8;
    const { token, projectId } = await ensureApiKey(captured);

    const searchModel =
      antigravityEnv("SEARCH_MODEL")?.trim() ||
      antigravityEnv("RUNTIME_MODEL")?.trim() ||
      "gemini-3.8-flash-tiered";

    const payload = {
      project: projectId,
      model: searchModel,
      request: {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Search the web for: "${query}". Return a factual, informative, and concise summary of the search results with key facts and details. Cite sources where appropriate.`,
              },
            ],
          },
        ],
        tools: [{ googleSearch: {} }],
        generationConfig: { maxOutputTokens: 1024 },
      },
      requestType: "agent",
      userAgent: "antigravity",
      requestId: nowRequestId(),
    };

    const requestHeaders = {
      ...antigravityHeaders(token),
      ...attributionHeaderBag(),
    };

    let response;
    let lastErrorText = "";

    for (const endpoint of endpointCandidates()) {
      if (signal?.aborted) throw new LlmError("Search request was aborted by caller", "ABORTED");
      try {
        setLastEndpoint(endpoint);
        response = await fetchStreamResponse(endpoint, requestHeaders, JSON.stringify(payload), signal);
        setLastStatus(response.status);
        if (response.ok) break;
        lastErrorText = await response.text();
        if (response.status === 429 && /Individual quota reached/i.test(lastErrorText)) continue;
        if ([403, 404, 429, 500, 502, 503, 504].includes(response.status)) continue;
      } catch (err) {
        if (signal?.aborted) throw new LlmError("Search request was aborted by caller", "ABORTED", { cause: err });
        lastErrorText = err instanceof Error ? err.message : String(err);
      }
    }

    if (!response || !response.ok) {
      const friendly = friendlyAntigravityError(response?.status, lastErrorText);
      throw new LlmError(
        `Antigravity search API error (${response?.status ?? "no response"}, ${formatRequestDiagnostics({ projectId, runtimeModel: searchModel })}): ${friendly}`,
        classifyAntigravityError(friendly, response?.status),
      );
    }

    const text = await response.text();
    let fullText = "";
    const rawSources = [];
    const seenUrls = new Set();

    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      const parsed = safeJsonParse(json);
      if (!isRecord(parsed)) continue;
      if (isRecord(parsed.error)) {
        const message = parsed.error.message || JSON.stringify(parsed.error);
        throw new LlmError(String(message), classifyAntigravityError(String(message)));
      }
      const responseData = isRecord(parsed.response) ? parsed.response : parsed;
      const candidate = Array.isArray(responseData.candidates) ? responseData.candidates[0] : undefined;
      for (const p of candidate?.content?.parts || []) {
        if (p.text) fullText += p.text;
      }
      const chunks = candidate?.groundingMetadata?.groundingChunks || [];
      for (const chunk of chunks) {
        const uri = chunk.web?.uri;
        const title = chunk.web?.title;
        if (uri && !seenUrls.has(uri)) {
          seenUrls.add(uri);
          rawSources.push({ url: uri, title: title || uri });
        }
      }
    }

    // Also extract direct markdown links if any exist in text
    const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g;
    let match;
    while ((match = linkRegex.exec(fullText)) !== null) {
      const [, title, url] = match;
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        rawSources.push({ url, title });
      }
    }

    // Resolve grounding redirect links to canonical destinations in parallel
    const resolvedSources = await Promise.all(
      rawSources.slice(0, maxResults * 2).map(async (s) => ({
        url: await resolveRedirect(s.url),
        title: s.title,
      })),
    );

    // Deduplicate again after redirect resolution
    const finalSources = [];
    const finalSeen = new Set();
    for (const s of resolvedSources) {
      if (!finalSeen.has(s.url)) {
        finalSeen.add(s.url);
        finalSources.push(s);
      }
    }

    const capped = finalSources.slice(0, maxResults);
    return {
      content: fullText.trim() || undefined,
      sources: capped,
      truncated: finalSources.length > capped.length,
    };
  }
}

function registerWebSearch(target, store) {
  let web;
  if (target?.registerSearchProvider) {
    web = target;
  } else {
    try {
      web = target?.get ? target.get("web") : target?.web;
    } catch {
      web = undefined;
    }
  }
  if (!web?.registerSearchProvider) return;

  const provider = new AntigravitySearchProvider(store, SEARCH_PROVIDER_ID);
  try {
    web.registerSearchProvider(provider);
  } catch (err) {
    setLastError(err);
  }

  // Also register under deepseek-official as a transparent drop-in replacement
  // so any preset or default config expecting deepseek search seamlessly uses
  // Antigravity instead of failing with DeepSeek 402 Insufficient Balance.
  try {
    const alias = new AntigravitySearchProvider(store, "deepseek-official");
    web.registerSearchProvider(alias);
  } catch {
    // If deepseek-official was already registered, ignore.
  }
}

export function apply(ctx, config = {}) {
  const store = new FileCredentialStore(credentialPath());
  const modelSettings = new FileModelSettingsStore(modelSettingsPath());
  // Session pins are the only per-session auth state; the account store's
  // activeAccountId stays the profile-wide default.
  const sessionAccounts = new FileSessionAccountStore(sessionAccountsPath());
  // Image blocks carry only a durable attachment reference, so reading request
  // bytes requires the attachment service this profile mounts. Resolve it lazily
  // on each request: the service may appear after this adapter is registered.
  const resolveAttachments = () => {
    let attachments;
    try {
      attachments = ctx.get("attachments");
    } catch {
      attachments = undefined;
    }
    return typeof attachments?.readImageRequest === "function" ? attachments : undefined;
  };
  const usageStore = new FileUsageStore(usagePath());
  const adapter = new AntigravityAdapter(store, modelSettings, resolveAttachments, usageStore, {
    maxContextWindow: config.maxContextWindow,
    failoverOnQuota: config.failoverOnQuota !== false,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    sessionAccounts,
    sessions: () => {
      try {
        return ctx.get("sessions");
      } catch {
        return undefined;
      }
    },
    onAccountSwitch: ({ sessionId, from, to, error }) => {
      if (error !== undefined) {
        ctx.logger?.warn?.("[antigravity] could not remember the failover account for session %s: %o", sessionId ?? "unknown", error);
        return;
      }
      ctx.logger?.warn?.("[antigravity] session %s failed over from account %s to %s after quota exhaustion", sessionId ?? "unknown", from ?? "unknown", to);
    },
  });
  if (ctx.llm?.registerAdapter) {
    ctx.llm.registerAdapter([PROVIDER], adapter);
  }
  registerWebApi(ctx, store, modelSettings, usageStore, sessionAccounts);
  registerAccountCommand(ctx, { store, sessionAccounts });

  const web = ctx.get("web");
  if (web?.registerSearchProvider) {
    registerWebSearch(web, store);
  } else {
    ctx.inject(["web"], (webCtx) => {
      registerWebSearch(webCtx, store);
    });
  }
}

apply.inject = ["llm"];
// Cordis unwraps a module's default export before reading `Config`, so a plugin
// whose default export is `apply` must publish the schema on the function.
// Without this the entry has no projected schema and the loader never validates
// (or surfaces) the config it passes.
apply.Config = Config;

export default apply;
