#!/usr/bin/env node
/**
 * Swap the Antigravity CLI's (`agy`) auth between accounts.
 *
 * The CLI keeps its session in `$AGY_HOME/antigravity-oauth-token`, holding an
 * access token, a refresh token and an `id_token` whose claims carry the signed-in
 * address. Swapping therefore means replacing that whole document, not just the
 * bearer string.
 *
 * Credentials come from the accounts this plugin already stores, so the CLI and
 * DSH can share one Antigravity identity. The access token is minted fresh from
 * the account's refresh token at swap time: the stored one is usually expired, and
 * the token endpoint is also what returns a matching `id_token`. The refresh token
 * is reused as-is (Google does not rotate it for this client), so the source
 * account keeps working afterwards.
 *
 * Usage:
 *   antigravity-cli-auth.mjs list                  # CLI identity + candidates
 *   antigravity-cli-auth.mjs use quoccbaoo         # swap to the matching account
 *   antigravity-cli-auth.mjs use bop --no-probe    # swap without calling the CLI
 *   antigravity-cli-auth.mjs restore               # undo the last swap
 *
 * `use` matches case-insensitively against account id, email and label; a match
 * must be unique. Sources: the DSH plugin store (default) or sub2api's database
 * (`--source sub2api`, read through docker exec).
 *
 * Every swap backs the previous file up first, and writes atomically with mode
 * 600. Tokens are never printed.
 */
import { chmodSync, copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { FileAccountStore } from "../lib/account-store.js";
import { clientId, clientSecret } from "../lib/index.js";

const CLI_DIR = process.env.AGY_HOME || join(homedir(), ".gemini", "antigravity-cli");
const TOKEN_FILE = process.env.AGY_TOKEN_FILE || join(CLI_DIR, "antigravity-oauth-token");
const STORE_FILE = process.env.ANTIGRAVITY_STORE || join(homedir(), ".dsh", "storages", "antigravity-oauth.json");
const AGY_BIN = process.env.AGY_BIN || "agy";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const PROBE_TIMEOUT_MS = 180000;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
function note(message) {
  console.log(`  ${message}`);
}
/** Decode a JWT payload for display only; never verify or print the signature. */
function claimsOf(jwt) {
  const parts = String(jwt ?? "").split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], "base64url").toString()); } catch { return null; }
}
function readCliToken() {
  if (!existsSync(TOKEN_FILE)) return null;
  try { return JSON.parse(readFileSync(TOKEN_FILE, "utf8")); } catch { return null; }
}
function cliIdentity() {
  const doc = readCliToken();
  if (!doc) return null;
  const inner = typeof doc.token === "string" ? JSON.parse(doc.token) : doc.token;
  const idClaims = claimsOf(doc.id_token);
  const expiry = inner?.expiry ? new Date(inner.expiry) : null;
  return {
    email: idClaims?.email || "(unknown)",
    expires: expiry && !Number.isNaN(expiry.valueOf()) ? expiry : null,
    expired: expiry ? expiry.valueOf() <= Date.now() : null,
    refresh: Boolean(inner?.refresh_token),
    authMethod: doc.auth_method || "(unset)",
  };
}

async function candidatesFromStore() {
  if (!existsSync(STORE_FILE)) return [];
  const store = new FileAccountStore(STORE_FILE);
  const { accounts } = await store.summaries();
  const out = [];
  for (const account of accounts) {
    const creds = await (await store.capture(account.id)).read();
    if (!creds?.refresh) continue;
    out.push({
      id: account.id, label: account.label, email: account.email,
      expires: account.expires ? new Date(account.expires) : null,
      refresh: creds.refresh, access: creds.access, source: "plugin store",
    });
  }
  return out;
}

function candidatesFromSub2api() {
  const query = "SELECT id, name, credentials->>'refresh_token' AS refresh, credentials->>'access_token' AS access, credentials->>'expires_at' AS expires, COALESCE(credentials->>'email','') FROM accounts WHERE platform='antigravity' AND COALESCE(credentials->>'refresh_token','') <> '' ORDER BY id";
  const out = spawnSync("docker", ["exec", "sub2api-postgres", "psql", "-U", "sub2api", "-d", "sub2api", "-t", "-A", "-F", "\u0001", "-c", query], { encoding: "utf8" });
  if (out.status !== 0) fail(`could not read sub2api accounts: ${(out.stderr || "").trim().split("\n")[0]}`);
  return out.stdout.split("\n").filter((line) => line.trim()).map((line) => {
    const [id, name, refresh, access, expires, email] = line.split("\u0001");
    return {
      id: `sub2api:${id}`, label: `${name} (sub2api)`, email: email || "(no email)",
      expires: expires ? new Date(Number(expires) * 1000) : null,
      refresh, access, source: "sub2api",
    };
  });
}

async function gather(source) {
  const list = source === "sub2api" ? candidatesFromSub2api() : await candidatesFromStore();
  if (list.length === 0) fail(`no accounts with a refresh token found in the ${source} source`);
  return list;
}

function describe(account) {
  const exp = account.expires ? account.expires.toISOString() : "-";
  return `${account.label} | ${account.email} | expires ${exp} | ${account.source}`;
}

async function mintToken(account) {
  const body = new URLSearchParams({
    client_id: clientId(), client_secret: clientSecret(),
    refresh_token: account.refresh, grant_type: "refresh_token",
  });
  let response;
  try {
    response = await fetch(TOKEN_ENDPOINT, { method: "POST", body, signal: AbortSignal.timeout(30000) });
  } catch (error) {
    fail(`token refresh could not reach Google: ${error.message}`);
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    const reason = json.error_description || json.error || `HTTP ${response.status}`;
    fail(`token refresh was rejected for ${account.email}: ${reason}`);
  }
  if (!json.id_token) {
    fail("Google returned no id_token, so the CLI's identity could not be replaced");
  }
  const claims = claimsOf(json.id_token);
  if (!claims?.email) fail("the returned id_token carries no email claim");
  return {
    access: json.access_token,
    refresh: json.refresh_token || account.refresh,
    idToken: json.id_token,
    expiresIn: Number(json.expires_in) || 3600,
    email: claims.email,
  };
}

function backupTokenFile() {
  if (!existsSync(TOKEN_FILE)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backup = `${TOKEN_FILE}.bak-${stamp}`;
  copyFileSync(TOKEN_FILE, backup);
  chmodSync(backup, 0o600);
  return backup;
}

function writeTokenFile(minted, previous) {
  const expiry = new Date(Date.now() + minted.expiresIn * 1000);
  const doc = {
    token: {
      access_token: minted.access,
      token_type: "Bearer",
      refresh_token: minted.refresh,
      // The CLI writes RFC3339 with nanoseconds; milliseconds round-trip fine.
      expiry: expiry.toISOString(),
    },
    auth_method: previous?.auth_method || "consumer",
    id_token: minted.idToken,
  };
  const temp = `${TOKEN_FILE}.tmp`;
  writeFileSync(temp, JSON.stringify(doc), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, TOKEN_FILE);
  return expiry;
}

function probeCli() {
  const result = spawnSync(AGY_BIN, ["models"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.error) return { ok: false, detail: result.error.message };
  const models = output.split("\n").filter((line) => /\t/.test(line)).length;
  if (result.status !== 0) return { ok: false, detail: `agy models exited ${result.status}: ${output.trim().split("\n")[0] || "(no output)"}` };
  if (models === 0) return { ok: false, detail: `agy models returned no models: ${output.trim().slice(0, 120)}` };
  return { ok: true, detail: `${models} models listed` };
}

async function commandList(source) {
  const current = cliIdentity();
  console.log("Antigravity CLI");
  console.log(`  file:  ${TOKEN_FILE}`);
  if (!current) console.log("  state: no token file (the CLI is signed out)");
  else console.log(`  state: ${current.email} | auth_method=${current.authMethod} | expires ${current.expires ? current.expires.toISOString() : "-"}${current.expired ? " (expired)" : ""} | refresh ${current.refresh ? "present" : "missing"}`);
  console.log("\nAvailable accounts");
  for (const account of await gather(source)) console.log(`  ${describe(account)}`);
  console.log("\nMatch with any unique part of the id, email or label, e.g. `use quoccbaoo`.");
}

async function commandShow() {
  const current = cliIdentity();
  if (!current) fail(`no token file at ${TOKEN_FILE}`);
  console.log(JSON.stringify({
    file: TOKEN_FILE, email: current.email, auth_method: current.authMethod,
    expires: current.expires ? current.expires.toISOString() : null,
    expired: current.expired, has_refresh_token: current.refresh,
  }, null, 2));
}

async function commandUse(match, options) {
  if (!match) fail("usage: use <match>");
  const needle = match.toLowerCase();
  const all = await gather(options.source);
  const hits = all.filter((account) =>
    [account.id, account.email, account.label].some((field) => String(field).toLowerCase().includes(needle)));
  if (hits.length === 0) {
    console.error(`error: no account matches "${match}". Available:`);
    for (const account of all) console.error(`  ${describe(account)}`);
    process.exit(1);
  }
  if (hits.length > 1) {
    console.error(`error: "${match}" matches ${hits.length} accounts; be more specific:`);
    for (const account of hits) console.error(`  ${describe(account)}`);
    process.exit(1);
  }

  const account = hits[0];
  const previous = readCliToken();
  const before = cliIdentity();
  console.log(`Swapping the Antigravity CLI to ${account.email} (${account.label})`);
  if (before) note(`current identity: ${before.email}`);

  const minted = await mintToken(account);
  note(`minted a fresh access token for ${minted.email} (expires in ${minted.expiresIn}s)`);
  if (minted.email.toLowerCase() !== String(account.email).toLowerCase()) {
    fail(`the refreshed identity (${minted.email}) does not match the selected account (${account.email})`);
  }

  const backup = backupTokenFile();
  if (backup) note(`backed up the previous token to ${backup}`);
  const expiry = writeTokenFile(minted, previous);
  note(`wrote ${TOKEN_FILE} (mode 600, expires ${expiry.toISOString()})`);

  const after = cliIdentity();
  console.log(`\nCLI now signed in as ${after?.email}`);

  if (options.probe) {
    console.log("\nProbing with `agy models` …");
    const result = probeCli();
    if (result.ok) note(`probe ok: ${result.detail}`);
    else {
      console.error(`  probe failed: ${result.detail}`);
      if (backup) console.error(`  restore the previous auth with: node ${process.argv[1]} restore ${backup}`);
      process.exit(1);
    }
  }
  console.log(`\nDone. Restore the previous auth any time with: node ${process.argv[1]} restore`);
}

function commandRestore(explicit) {
  let backup = explicit;
  if (!backup) {
    const dir = join(TOKEN_FILE, "..");
    const prefix = `${TOKEN_FILE.split("/").pop()}.bak-`;
    const found = readdirSync(dir).filter((name) => name.startsWith(prefix)).sort();
    if (found.length === 0) fail("no backup to restore");
    backup = join(dir, found[found.length - 1]);
  }
  if (!existsSync(backup)) fail(`backup not found: ${backup}`);
  backupTokenFile();
  copyFileSync(backup, TOKEN_FILE);
  chmodSync(TOKEN_FILE, 0o600);
  const restored = cliIdentity();
  console.log(`Restored ${backup}`);
  console.log(`CLI is now signed in as ${restored?.email || "(unknown)"}`);
}

function parseArgs(argv) {
  const options = { probe: true, source: "plugin" };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-probe") options.probe = false;
    else if (arg === "--source") { options.source = argv[++i]; if (!["plugin", "sub2api"].includes(options.source)) fail("--source must be plugin or sub2api"); }
    else if (arg === "--help" || arg === "-h") options.help = true;
    else positional.push(arg);
  }
  return { options, positional };
}

const { options, positional } = parseArgs(process.argv.slice(2));
const command = positional[0] || "list";

if (options.help) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n/, "").replace(/^\/\*\*\n/, "").replace(/^ \* ?/gm, "").trim());
  process.exit(0);
}

try {
  if (command === "list") await commandList(options.source);
  else if (command === "show") await commandShow();
  else if (command === "use") await commandUse(positional[1], options);
  else if (command === "restore") commandRestore(positional[1]);
  else fail(`unknown command "${command}" (list | show | use <match> | restore [backup])`);
} catch (error) {
  fail(error?.message || String(error));
}
