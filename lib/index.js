/**
 * Google Antigravity / Cloud Code Assist adapter for DeepSeek Harness.
 *
 * This plugin is intentionally shaped like a DSH Web plugin: Cordis loads this
 * module, `apply()` registers a harness LlmAdapter, and OAuth credentials live
 * under DSH home. It does not require an external Antigravity CLI.
 */
import { createHash, randomBytes } from "node:crypto";
import { FileAccountStore, normalizeProxyPolicy } from "./account-store.js";
import { accountScope, providerFetch, runWithTransport, streamWithTransport, disposeTransports, testProxy } from "./transport.js";
import { createOAuthFlow, refreshOAuth } from "./oauth.js";
export { FileAccountStore } from "./account-store.js";
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

export const PROVIDER = "antigravity";
export const PROVIDER_NAME = "Antigravity";
export const name = "dsh-antigravity";
export const inject = ["llm"];

const STREAM_IDLE_TIMEOUT_MS = 600000;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
const DISCOVERY_TIMEOUT_MS = 8000;
const PROJECT_CACHE_TTL_MS = 30 * 60 * 1000;
const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ENDPOINT_FALLBACKS = [
  DEFAULT_ENDPOINT,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
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

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. " +
  "You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.";
const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
  'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists, or thinking/personality preambles in the final response. Output only the final response.';

const PLATFORM =
  process.platform === "darwin" ? "MACOS" : process.platform === "win32" ? "WINDOWS" : "LINUX";
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

function lookupCacheKey(token) {
  // Do not retain credentials as cache keys; generation also separates proxy edits.
  return `${accountCacheKey()}:${createHash("sha256").update(token).digest("hex")}`;
}

async function accountSettings(modelSettings, captured) {
  const settings = await modelSettings.read();
  const catalog = accountCatalogs.get(accountCacheKey(captured));
  return { ...settings, catalogModels: catalog || (captured?.accountId ? [] : settings.catalogModels) };
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

function defaultUserAgent() {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `antigravity/1.15.8 ${os}/${arch}`;
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

function progressBar(remaining, width = 20) {
  if (remaining === undefined) return `[${"?".repeat(width)}]`;
  const filled = Math.max(0, Math.min(width, Math.round(remaining * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function formatReset(resetTime) {
  if (!resetTime) return "n/a";
  const timestamp = Date.parse(resetTime);
  if (!Number.isFinite(timestamp)) return resetTime;
  const delta = timestamp - Date.now();
  if (delta <= 0) return "now";
  const totalMinutes = Math.round(delta / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function postJson(path, token, body) {
  let lastErrorText = "";
  for (const endpoint of endpointCandidates()) {
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

function parseQuotaSummary(data) {
  const summary = isRecord(data) ? data : {};
  const groups = [];
  for (const group of Array.isArray(summary.groups) ? summary.groups : []) {
    if (!isRecord(group)) continue;
    const buckets = [];
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      if (!isRecord(bucket)) continue;
      const remaining = clampFraction(bucket.remainingFraction);
      if (remaining === undefined && !bucket.bucketId) continue;
      buckets.push({
        bucketId: String(bucket.bucketId || bucket.displayName || "unknown"),
        displayName: String(bucket.displayName || bucket.bucketId || "Limit"),
        window: bucket.window ? String(bucket.window) : undefined,
        resetTime: bucket.resetTime ? String(bucket.resetTime) : undefined,
        description: bucket.description ? String(bucket.description) : undefined,
        remainingFraction: remaining ?? 0,
      });
    }
    if (!buckets.length && !group.displayName) continue;
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
      resetTime: quotaInfo.resetTime ? String(quotaInfo.resetTime) : undefined,
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
  const reasoningEfforts = lower.includes("gpt-oss")
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
    case "claude-sonnet-4-6":
      return (text) => /claude[- ]sonnet/i.test(text);
    case "claude-opus-4-6":
      return (text) => /claude[- ]opus/i.test(text);
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
      resetTime: quotaInfo.resetTime ? String(quotaInfo.resetTime) : undefined,
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
  const [assistResult, summary] = await Promise.all([
    postJson("/v1internal:loadCodeAssist", token, {
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    }).catch(() => null),
    postJson("/v1internal:retrieveUserQuotaSummary", token, {}),
  ]);

  const discoveredProject = assistResult ? extractProjectId(assistResult.data) : undefined;
  const projectId = resolveProjectId({
    credentialProjectId,
    warmedProject: discoveredProject ?? null,
  });
  setLastProjectId(projectId);

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
  accountCatalogs.set(key, catalogModels);
  // Account catalogs must never prune the user's provider-wide model preferences.
  for (const cache of [quotaCache, accountCatalogs]) {
    while (cache.size > 64) cache.delete(cache.keys().next().value);
  }
  return quota;
}

export function getCachedQuota(captured) {
  const exact = quotaCache.get(accountCacheKey(captured));
  if (exact) return exact;
  if (captured?.accountId) {
    for (const value of quotaCache.values()) if (value.accountId === captured.accountId) return value;
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
  if (effort === undefined || effort === "off") {
    return route.off ?? route.routing?.high ?? route.defaultRequestId ?? modelId;
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

function reasoningInfo(model) {
  if (!model.reasoningEfforts.length) return {};
  return {
    reasoning: {
      efforts: model.reasoningEfforts.map((level) => ({
        id: ReasoningEffortId(level),
        name: level.charAt(0).toUpperCase() + level.slice(1),
      })),
    },
  };
}

function resolveReasoning(model, effort) {
  if (effort === undefined || effort === "off") return effort;
  if (model.reasoningEfforts && model.reasoningEfforts.includes(effort)) return effort;
  // If user selected an unsupported effort level, fallback to "high" (or available highest)
  if (model.reasoningEfforts && model.reasoningEfforts.includes("high")) return "high";
  return (model.reasoningEfforts && model.reasoningEfforts[0]) || "high";
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
 * Read and base64-encode every image in one request into Antigravity's wire shape.
 *
 * DSH never hands an adapter raw image bytes: an `image` block carries only a
 * durable `attachment` reference, and the mounted attachment service derives the
 * encoded request version. Skipping that step silently drops the image.
 * @param options - the harness request.
 * @param attachments - attachment store, when this profile mounts one.
 * @param signal - request cancellation.
 * @returns `inlineData` payloads by attachment id; empty when the request has none.
 * @throws LlmError when no attachment service is mounted, a media type is
 *   unsupported, or the encoded total exceeds the request ceiling.
 */
async function prepareImages(options, attachments, signal) {
  const refs = new Map();
  for (const message of options.messages) collectImageRefs(message.content, refs);
  const prepared = new Map();
  if (refs.size === 0) return prepared;
  if (attachments === undefined) {
    throw new LlmError(
      "Antigravity cannot send images because this profile mounts no attachment service.",
      "UNSUPPORTED_CONTENT",
    );
  }
  const policy = { maxPixels: IMAGE_MAX_PIXELS, maxBytes: IMAGE_MAX_BYTES };
  const entries = await Promise.all(
    [...refs].map(async ([id, ref]) => {
      const version = await attachments.readImageRequest(ref, policy, signal);
      const mimeType = String(version.mediaType);
      if (!IMAGE_MIME_TYPES.has(mimeType)) {
        throw new LlmError(
          `Antigravity accepts png, jpeg and webp images; ${mimeType} is not one of them.`,
          "UNSUPPORTED_CONTENT",
        );
      }
      return [id, { mimeType, data: Buffer.from(version.data).toString("base64"), bytes: version.bytes }];
    }),
  );
  let totalBytes = 0;
  for (const [id, entry] of entries) {
    totalBytes += entry.bytes;
    prepared.set(id, entry);
  }
  if (totalBytes > IMAGE_MAX_TOTAL_BYTES) {
    throw new LlmError(
      `Antigravity request images total ${Math.round(totalBytes / 1024)}KB, above the ${Math.round(
        IMAGE_MAX_TOTAL_BYTES / 1024,
      )}KB inline ceiling. Send fewer or smaller images.`,
      "UNSUPPORTED_CONTENT",
    );
  }
  return prepared;
}

/**
 * Build one Antigravity `inlineData` part for an image block.
 * @param block - the image content block.
 * @param prepared - wire images already read for this request, by attachment id.
 * @returns an `inlineData` part, or undefined for a block carrying no image.
 * @throws LlmError when a durable attachment was never prepared.
 */
function imageBlockToPart(block, prepared) {
  if (!isRecord(block) || block.type !== "image") return undefined;
  const attachment = isRecord(block.attachment) ? block.attachment : undefined;
  if (attachment) {
    const id = String(attachment.attachmentId);
    const image = prepared?.get(id);
    if (!image) {
      throw new LlmError(`Antigravity request image ${id} was not prepared.`, "INVALID_REQUEST");
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
      if (imagePart) parts.push(imagePart);
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
        if (!image) return "";
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

function replayBlockFor(message, index) {
  const source = message.source;
  if (!source || source.kind !== "model") return undefined;
  const state = source.replayState;
  if (!isRecord(state)) return undefined;
  if (state.kind !== "antigravity" || state.version !== 1) return undefined;
  if (state.provider !== PROVIDER || state.model !== source.model) return undefined;
  if (!Array.isArray(state.blocks)) return undefined;
  return state.blocks[index];
}

function assistantParts(message, model, runtimeModel, toolNames) {
  const parts = [];
  if (!Array.isArray(message.content)) return parts;
  for (let index = 0; index < message.content.length; index++) {
    const block = message.content[index];
    if (!isRecord(block)) continue;
    const replay = replayBlockFor(message, index);
    if (block.type === "text" && String(block.text || "").trim()) {
      parts.push({ text: sanitizeText(block.text) });
    } else if (block.type === "reasoning" && String(block.text || "").trim()) {
      if (replay?.type === "reasoning" && replay.thinkingSignature) {
        parts.push({
          thought: true,
          text: sanitizeText(block.text),
          thoughtSignature: replay.thinkingSignature,
        });
      } else {
        parts.push({ text: sanitizeText(block.text) });
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

function convertMessages(options, model, runtimeModel, prepared) {
  const contents = [];
  const toolNames = new Map();
  for (const message of options.messages) {
    if (message.role === "assistant") {
      const parts = assistantParts(message, model, runtimeModel, toolNames);
      if (parts.length) contents.push({ role: GEMINI_ROLE.model, parts });
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    const nonResultContent = content.filter((block) => !isRecord(block) || block.type !== "tool-result");
    const userParts = contentToUserParts(nonResultContent, prepared);
    if (message.role === "system") {
      if (userParts.length) contents.push({ role: GEMINI_ROLE.user, parts: userParts });
      continue;
    }
    if (userParts.length) contents.push({ role: GEMINI_ROLE.user, parts: userParts });
    for (const block of content) {
      if (isRecord(block) && block.type === "tool-result") {
        pushToolResult(contents, block, toolNames, model, runtimeModel, prepared);
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
  const request = {
    contents: convertMessages(options, model, runtimeModel, prepared),
    systemInstruction: {
      role: GEMINI_ROLE.user,
      parts: [
        { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
        { text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
        { text: ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION },
        ...(options.system ? [{ text: sanitizeText(options.system) }] : []),
      ],
    },
  };
  const generationConfig = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (runtimeModel === "gemini-3.7-flash-tiered") {
    const selected = effort || "off";
    generationConfig.thinkingConfig = {
      thinkingLevel: selected === "high" || selected === "xhigh" ? "HIGH" : selected === "medium" ? "MEDIUM" : "LOW",
    };
  }
  const maxAllowed = getMaxOutputTokens(model.id, runtimeModel);
  generationConfig.maxOutputTokens =
    options.maxTokens !== undefined
      ? Math.min(options.maxTokens, maxAllowed)
      : Math.min(maxAllowed, model.maxTokens || maxAllowed);
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

function classifyAntigravityError(message) {
  if (/\b(?:401|403)\b/.test(message)) return "AUTH";
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
  if (/\b429\b|rate.?limit/i.test(message)) return "RATE_LIMIT";
  if (/\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";
  if (/\b5\d\d\b/.test(message)) return "SERVER";
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return "TIMEOUT";
  if (/stream ended (?:before|without)\b/i.test(message)) return "TRANSPORT";
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)) return "TRANSPORT";
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
    if (/quota/i.test(message)) return `Quota reached.${wait ? ` Please wait ${wait}.` : ""}`;
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
    if (part.text !== undefined) {
      const isThinking = part.thought === true;
      const blockType = isThinking ? "reasoning" : "text";
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
      const delta = sanitizeText(part.text);
      state.currentBlock.text += delta;
      state.hasContent = true;
      if (isThinking && part.thoughtSignature) {
        state.currentBlock.thinkingSignature = part.thoughtSignature;
        state.replayBlocks[state.blocks.length - 1].thinkingSignature = part.thoughtSignature;
      } else if (!isThinking && part.thoughtSignature) {
        state.currentBlock.textSignature = part.thoughtSignature;
        state.replayBlocks[state.blocks.length - 1].textSignature = part.thoughtSignature;
      }
      out.push({
        type: isThinking ? "reasoning-delta" : "text-delta",
        index: state.blocks.length - 1,
        text: delta,
      });
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
    enabledModelIds: [...new Set(enabledModelIds)],
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
  return normalized.catalogModels.length ? normalized.catalogModels : MODELS;
}

function configuredModels(settings) {
  const enabled = enabledModelSet(settings);
  return catalogModelsOf(settings).filter((model) => enabled.has(model.id)).sort(compareAntigravityModels);
}

function modelFromSettings(settings, modelId) {
  return catalogModelsOf(settings).find((model) => model.id === modelId) || modelById(modelId) || inferModelShape(modelId);
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
  if (hasImages(options.messages) && !model.inputModalities.includes("image")) {
    throw new LlmError(`antigravity model "${model.id}" does not support image content`, "UNSUPPORTED_CONTENT");
  }

  // Read the durable attachments referenced by this request into wire bytes
  // before the first attempt, so retries reuse the same encoded images. This
  // needs only local storage, so unsupported content fails before any network
  // call is spent on a token refresh.
  const prepared = await prepareImages(options, attachments, signal);
  const { token, projectId } = await ensureApiKey(store);
  const effort = resolveReasoning(model, options.reasoningEffort);
  const runtimeCandidates = await resolveRuntimeCandidates(token, projectId, model, effort);
  const requestHeaders = {
    ...antigravityHeaders(token),
    ...attributionHeaderBag(),
    ...(model.id.startsWith("claude-") ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
  };

  const state = createStreamState();
  const maxAttempts = Number(antigravityEnv("MAX_RETRIES")) || 6;
  let response;
  let lastText = "";
  const runtimeModel = runtimeCandidates[0];
  setLastResolvedRuntimeModel(runtimeModel);
  const body = JSON.stringify(buildRequest(options, model, projectId, runtimeModel, effort, prepared));

  attemptLoop: for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

    for (const endpoint of endpointCandidates()) {
      if (signal?.aborted) throw new LlmError("antigravity request aborted by caller", "ABORTED");
      setLastEndpoint(endpoint);
      response = await fetchStreamResponse(endpoint, requestHeaders, body, signal);
      setLastStatus(response.status);
      if (response.ok) break;
      lastText = await response.text();
      recordTransientError(response.status, runtimeModel, endpoint, lastText);
      if (response.status === 429 && /Individual quota reached/i.test(lastText)) break;
      if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) break;
    }

    if (response?.ok) {
      for await (const chunk of streamResponseToChunks(response, model, runtimeModel, state)) {
        yield chunk;
      }
      if (state.hasContent) return;
      // If response was 200 but completely empty, retry in outer loop
    }

    // Permanent account quota exhaustion: fail immediately without waiting 1-5 minutes
    if (response?.status === 429 && /Individual quota reached/i.test(lastText)) break;

    // Non-retryable client errors (e.g. 400 Bad Request, 401 Auth error): fail immediately
    if (response && ![429, 500, 502, 503, 504].includes(response.status)) break;
  }

  if (!response || !response.ok) {
    const friendly = friendlyAntigravityError(response?.status, lastText);
    throw new LlmError(
      `Antigravity API error (${response?.status ?? "no response"}, ${formatRequestDiagnostics({ projectId, runtimeModel })}): ${friendly}`,
      classifyAntigravityError(friendly),
    );
  }

  throw new LlmError("Antigravity API returned an empty response", EMPTY_RESPONSE_CODE);
}

export class AntigravityAdapter extends LlmAdapter {
  #store;
  #modelSettings;
  /** Optional resolver returning the mounted attachment store, or undefined. */
  #resolveAttachments;

  constructor(
    store = new FileCredentialStore(),
    modelSettings = new FileModelSettingsStore(),
    resolveAttachments = () => undefined,
  ) {
    super();
    this.#store = store;
    this.#modelSettings = modelSettings;
    this.#resolveAttachments = resolveAttachments;
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME };
  }

  async listModels(provider) {
    const captured = this.#store.capture ? await this.#store.capture() : this.#store;
    const settings = await accountSettings(this.#modelSettings, captured);
    return configuredModels(settings).map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
      context: { contextWindow: model.contextWindow },
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
      context: { contextWindow: model.contextWindow },
      defaultMaxTokens: model.maxTokens,
      ...reasoningInfo(model),
    };
  }

  async *stream(options) {
    const captured = await captureAccount(this.#store);
    yield* streamWithTransport({ account: captured, kind: "api", signal: options.signal }, () => this.streamCaptured(options, captured));
  }

  async *streamCaptured(options, captured) {
    const settings = await accountSettings(this.#modelSettings, captured);
    const model = modelFromSettings(settings, options.model);

    const consumer = new AbortController();
    const upstream =
      options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
    const watchdog = idleWatchdog(upstream, STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE);
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
          throw new LlmError(`antigravity stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`, "TIMEOUT");
        }
        if (result.done) {
          exhausted = true;
          return;
        }
        yield result.value;
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`antigravity stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`, "TIMEOUT", { cause: error });
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
    "commands=/antigravity-login /antigravity-quota /antigravity-doctor /antigravity-logout",
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

function modelOptionsPayload(settings, quota) {
  const enabled = enabledModelSet(settings);
  const allModels = [...catalogModelsOf(settings)].sort(compareAntigravityModels);
  const catalogQuotaMap = new Map();
  if (quota?.catalogModels) {
    for (const cm of quota.catalogModels) {
      catalogQuotaMap.set(cm.id, cm);
    }
  }
  const options = allModels.map((model) => {
    const catalogQuota = catalogQuotaMap.get(model.id);
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

async function webStatus(store, modelSettings) {
  const credentials = await store.read();
  const captured = store.capture ? await store.capture() : store;
  const quota = getCachedQuota(captured);
  const settings = await modelSettings.read();
  const accountState = await store.summaries();
  return {
    ...credentialSummary(credentials),
    ...accountState,
    login: getWebLoginStatus(),
    models: modelOptionsPayload(settings, quota),
    quota:
      quota === undefined
        ? undefined
        : {
            projectId: quota.projectId,
            planLabel: quota.planLabel,
            fetchedAt: quota.fetchedAt,
            ...quotaCardRows(quota),
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

function registerWebApi(ctx, store, modelSettings) {
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
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings) });
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
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings) });
              }
              if (path === "login/cancel") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                await cancelWebLogin(body.flowId);
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings) });
              }
              if (path === "accounts") {
                if (request.method !== "GET") return sendMethodNotAllowed(response);
                return sendJson(response, 200, { ok: true, value: await store.summaries() });
              }
              if (path === "accounts/activate") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                await cancelPendingLogin();
                await store.activate(body.accountId, body.expectedRevision);
                clearAccountRuntime(); emitLlmAdaptersUpdated(ctx);
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings) });
              }
              if (path === "accounts/remove") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                await cancelPendingLogin();
                await store.removeAccount(body.accountId, body.replacementAccountId, body.expectedRevision);
                clearAccountRuntime(); emitLlmAdaptersUpdated(ctx);
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings) });
              }
              if (path === "accounts/proxy") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                const body = await readRequestJson(request);
                const proxy = normalizeProxyPolicy(body.proxy);
                await store.setProxy(body.accountId, proxy, body.expectedRevision);
                clearAccountRuntime();
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings) });
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
                const quota = await fetchAccountQuota(store, modelSettings);
                emitLlmAdaptersUpdated(ctx);
                return sendJson(response, 200, {
                  ok: true,
                  value: {
                    projectId: quota.projectId,
                    planLabel: quota.planLabel,
                    fetchedAt: quota.fetchedAt,
                    ...quotaCardRows(quota),
                    models: modelOptionsPayload(await modelSettings.read(), quota),
                  },
                });
              }
              if (path === "models") {
                if (request.method === "GET") {
                  return sendJson(response, 200, {
                    ok: true,
                    value: modelOptionsPayload(await modelSettings.read(), getCachedQuota()),
                  });
                }
                if (request.method === "POST") {
                  const body = await readRequestJson(request);
                  if (!Array.isArray(body.enabledModelIds)) {
                    return sendJson(response, 400, { ok: false, error: "enabledModelIds must be an array" });
                  }
                  const settings = await modelSettings.setEnabledModelIds(body.enabledModelIds);
                  emitLlmAdaptersUpdated(ctx);
                  return sendJson(response, 200, {
                    ok: true,
                    value: modelOptionsPayload(settings, getCachedQuota()),
                  });
                }
                return sendMethodNotAllowed(response);
              }
              if (path === "logout") {
                if (request.method !== "POST") return sendMethodNotAllowed(response);
                await store.delete();
                clearAccountRuntime();
                return sendJson(response, 200, { ok: true, value: await webStatus(store, modelSettings) });
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
        classifyAntigravityError(friendly),
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

export function apply(ctx) {
  const store = new FileCredentialStore(credentialPath());
  const modelSettings = new FileModelSettingsStore(modelSettingsPath());
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
  const adapter = new AntigravityAdapter(store, modelSettings, resolveAttachments);
  if (ctx.llm?.registerAdapter) {
    ctx.llm.registerAdapter([PROVIDER], adapter);
  }
  registerWebApi(ctx, store, modelSettings);

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

export default apply;
