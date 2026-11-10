/**
 * The Antigravity CLI's own session file.
 *
 * `agy` keeps a session separate from this plugin's account store, at
 * `$AGY_HOME/antigravity-oauth-token` (default
 * `~/.gemini/antigravity-cli/antigravity-oauth-token`). The document it holds is
 *
 *   { token: { access_token, token_type, refresh_token, expiry, expires_in },
 *     auth_method: "consumer", id_token_email: "<address>" }
 *
 * Older builds stored a full `id_token` JWT instead of the plain address, so
 * both shapes are read here. Nothing in this module imports a DSH package, so
 * the settings route and its tests share one owner of the on-disk shape instead
 * of each keeping a copy of the format.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AGY_TOKEN_NAME = "antigravity-oauth-token";

/** Resolve the CLI token path from the environment, mirroring the CLI itself. */
export function agyCliTokenPath(env = process.env) {
  if (typeof env.AGY_TOKEN_FILE === "string" && env.AGY_TOKEN_FILE) return env.AGY_TOKEN_FILE;
  const home = (typeof env.AGY_HOME === "string" && env.AGY_HOME) || join(env.HOME || homedir(), ".gemini", "antigravity-cli");
  return join(home, AGY_TOKEN_NAME);
}

function failure(message, code) {
  return Object.assign(new Error(message), { code });
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function string(value) {
  return typeof value === "string" && value.length > 0 ? value : "";
}

function parseJson(value) {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** Decode a JWT payload for identity display only; the signature is never checked. */
function claimsOf(jwt) {
  const parts = string(jwt).split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return record(payload);
  } catch { return null; }
}

function identityEmail(doc) {
  const direct = string(doc.id_token_email).trim();
  if (direct) return direct;
  return string(claimsOf(doc.id_token)?.email).trim();
}

/** Normalize an address for comparison; labels are never compared this way. */
export function emailKey(value) {
  return string(value).trim().toLowerCase();
}

/**
 * Describe one CLI session document.
 * @returns {null | { email: string, authMethod: string, expires: Date | null, expired: boolean | null, refresh: boolean }}
 */
export function agyCliIdentity(doc) {
  const value = record(doc);
  if (!value) return null;
  const token = record(value.token) ?? parseJson(value.token) ?? {};
  const expiry = token.expiry === undefined ? null : new Date(token.expiry);
  const expires = expiry && !Number.isNaN(expiry.valueOf()) ? expiry : null;
  return {
    email: identityEmail(value),
    authMethod: string(value.auth_method) || "(unset)",
    expires,
    expired: expires === null ? null : expires.valueOf() <= Date.now(),
    refresh: Boolean(string(token.refresh_token)),
  };
}

/** Read the CLI document, returning null when it is absent or not JSON. */
export function readAgyCliDocument(path = agyCliTokenPath()) {
  try { return record(JSON.parse(readFileSync(path, "utf8"))); } catch { return null; }
}

/** Read-only view of the CLI session for the settings status payload. */
export function agyCliStatus(path = agyCliTokenPath()) {
  const doc = readAgyCliDocument(path);
  const identity = agyCliIdentity(doc);
  if (!identity) return { path, signedIn: false, email: "", authMethod: "", expires: null, expired: null };
  return {
    path,
    signedIn: true,
    email: identity.email,
    authMethod: identity.authMethod,
    expires: identity.expires === null ? null : identity.expires.toISOString(),
    expired: identity.expired,
  };
}

function timestamp(date) {
  return date.toISOString().replace(/[:.]/g, "");
}

/**
 * Copy the current session beside itself before an overwrite.
 *
 * This is the escape hatch for a CLI login this plugin does not know about: an
 * account that is already saved can be written back at any time, so only an
 * unlisted (or unreadable) session is worth preserving.
 */
function backupSession(path) {
  const backup = `${path}.bak-${timestamp(new Date())}`;
  copyFileSync(path, backup);
  chmodSync(backup, 0o600);
  return backup;
}

function atomicWrite(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, body, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/**
 * Replace the CLI session with one saved account's credentials.
 *
 * The stored access token is written as-is: the CLI holds the same refresh
 * token and refreshes an expired one itself, so this never needs the network
 * and cannot fail on a proxy or transport problem.
 *
 * @param {{ access?: string, refresh?: string, expires?: number, email?: string }} credentials
 * @param {{ path?: string, email?: string, knownEmails?: string[], now?: number }} [options]
 *   `knownEmails` are the accounts this plugin can restore at any time; only a
 *   current session outside that list is backed up before it is replaced.
 * @returns {{ path: string, email: string, expires: string, backup: string | null, changed: boolean, previousEmail: string }}
 */
export function writeAgyCliDocument(credentials, options = {}) {
  const path = options.path || agyCliTokenPath();
  const access = string(credentials?.access);
  const refresh = string(credentials?.refresh);
  if (!access) throw failure("This account has no access token to give the CLI. Refresh it first.", "AGY_CLI_CREDENTIALS");
  if (!refresh) throw failure("This account has no refresh token to give the CLI. Sign in again first.", "AGY_CLI_CREDENTIALS");

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const expiresAt = Number.isFinite(Number(credentials?.expires)) && Number(credentials?.expires) > 0
    ? Number(credentials.expires)
    : now + 3_600_000;
  const email = (options.email || credentials?.email || "").trim();
  const expiry = new Date(expiresAt).toISOString();

  const previousDoc = readAgyCliDocument(path);
  const previous = agyCliIdentity(previousDoc);
  const previousEmail = previous?.email || "";

  const previousToken = record(previousDoc?.token) ?? parseJson(previousDoc?.token) ?? {};
  const unchanged = Boolean(previousDoc)
    && string(previousToken.access_token) === access
    && string(previousToken.refresh_token) === refresh
    && emailKey(identityEmail(previousDoc)) === emailKey(email);
  if (unchanged) return { path, email, expires: expiry, backup: null, changed: false, previousEmail };

  const known = new Set((Array.isArray(options.knownEmails) ? options.knownEmails : []).map(emailKey).filter(Boolean));
  const listed = previousEmail !== "" && known.has(emailKey(previousEmail));
  const backup = existsSync(path) && !listed ? backupSession(path) : null;

  const doc = {
    token: {
      access_token: access,
      token_type: "Bearer",
      refresh_token: refresh,
      expiry,
      expires_in: Math.max(0, Math.round((expiresAt - now) / 1000)),
    },
    auth_method: string(previousDoc?.auth_method) || "consumer",
    ...(email ? { id_token_email: email } : {}),
  };
  atomicWrite(path, JSON.stringify(doc));
  return { path, email, expires: expiry, backup, changed: true, previousEmail };
}
