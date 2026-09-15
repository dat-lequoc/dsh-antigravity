import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { accountScope, runWithTransport, providerFetch } from "./transport.js";

const env = (key) => process.env[`ANTIGRAVITY_${key}`] || process.env[`NOAGY_${key}`];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
import { clientId, clientSecret } from "./index.js";
const SCOPES = ["aicode", "cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs"].map((s) => `https://www.googleapis.com/auth/${s}`);
const fail = (message, code = "OAUTH_FAILED") => Object.assign(new Error(message), { code });
const string = (v) => typeof v === "string" && v.length > 0;

async function tokenResponse(response) {
  // Never retain or expose raw upstream token payloads in an exception/cause.
  let value;
  try { value = await response.json(); } catch { throw fail("Invalid OAuth token response."); }
  if (!response.ok) {
    if ([400, 401].includes(response.status) && value?.error === "invalid_grant") {
      throw fail("This account needs to sign in again.", "REAUTH_REQUIRED");
    }
    throw fail(`OAuth request failed (HTTP ${response.status}).`);
  }
  if (!string(value?.access_token) || !Number.isFinite(value.expires_in) || value.expires_in <= 0) {
    throw fail("Invalid OAuth token response.");
  }
  return value;
}

export async function refreshOAuth(credentials, discoverProject) {
  if (!string(credentials?.refresh)) throw fail("This account needs to sign in again.", "REAUTH_REQUIRED");
  const context = accountScope.getStore() || {};
  return runWithTransport({ ...context, kind: "auth" }, async () => {
    const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const response = await providerFetch(TOKEN_URL, {
      method: "POST", signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), refresh_token: credentials.refresh, grant_type: "refresh_token" }).toString(),
    });
    const data = await tokenResponse(response);
    const projectId = credentials.projectId || await discoverProject?.(data.access_token);
    return { ...credentials, access: data.access_token, refresh: data.refresh_token || credentials.refresh,
      expires: Date.now() + data.expires_in * 1000 - 60_000, projectId };
  });
}

/** One loopback/PKCE flow. Call cancel and await result before a conflicting mutation. */
export async function createOAuthFlow({ proxy, signal: parentSignal, discoverProject } = {}) {
  const host = (env("CALLBACK_HOST") || "127.0.0.1").toLowerCase();
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw fail("OAuth callback must bind to loopback.");
  const port = Number(env("CALLBACK_PORT") || 51121);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail("Invalid OAuth callback port.");
  const callback = `http://localhost:${port}/oauth-callback`;
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const controller = new AbortController();
  const flowId = randomBytes(16).toString("hex");
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  let resolveCode, rejectCode;
  const codeResult = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Startup cancellation may reject before the result consumer is attached.
  void codeResult.catch(() => {});
  let accepted = false;
  const server = createServer((request, response) => {
    const send = (status, message) => { response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff" }); response.end(message); };
    if (request.method !== "GET") return send(405, "Method not allowed.");
    let url;
    try { url = new URL(request.url || "", callback); } catch { return send(400, "Invalid callback."); }
    if (url.pathname !== "/oauth-callback") return send(404, "Not found.");
    if (url.searchParams.get("state") !== state) return send(400, "Invalid OAuth state.");
    if (accepted) return send(409, "Callback already accepted.");
    if (url.searchParams.has("error")) { accepted = true; rejectCode(fail("Google sign-in was not completed.")); return send(400, "Google sign-in was not completed."); }
    const code = url.searchParams.get("code");
    if (!code) return send(400, "Missing authorization code.");
    accepted = true;
    resolveCode(code);
    send(200, "Authorization received. Return to DSH to check login completion.");
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const abort = () => { rejectCode(fail("OAuth login canceled or timed out.", "ABORTED")); server.close(); server.closeAllConnections(); };
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 5 * 60_000);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", () => reject(fail("Cannot open OAuth callback port. Close another login and retry.")));
      server.listen(port, host === "localhost" ? "127.0.0.1" : host, resolve);
    });
    signal.throwIfAborted();
  } catch (error) {
    clearTimeout(timer); signal.removeEventListener("abort", abort); server.close(); throw error;
  }
  const params = new URLSearchParams({ client_id: clientId(), response_type: "code", redirect_uri: callback, scope: SCOPES.join(" "), code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent select_account" });
  const result = runWithTransport({ account: { accountId: `login:${flowId}`, proxy }, kind: "auth", signal }, async () => {
    try {
      const code = await codeResult;
      signal.throwIfAborted();
      const exchangeSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const response = await providerFetch(TOKEN_URL, {
        method: "POST", signal: exchangeSignal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), code, grant_type: "authorization_code", redirect_uri: callback, code_verifier: verifier }).toString(),
      });
      const data = await tokenResponse(response);
      if (!string(data.refresh_token)) throw fail("No refresh token received. Allow offline access and sign in again.");
      const info = await providerFetch(USERINFO_URL, { headers: { Authorization: `Bearer ${data.access_token}` }, signal: exchangeSignal });
      if (!info.ok) throw fail("Unable to verify Google account identity.");
      let identity;
      try { identity = await info.json(); } catch { throw fail("Invalid Google account identity response."); }
      // v1 userinfo returns id and verified_email. Neither token decoding nor project IDs identify a user.
      if (!string(identity?.id)) throw fail("Google account identity is missing.");
      const email = identity.verified_email === true && string(identity.email) ? identity.email : undefined;
      const projectId = await discoverProject?.(data.access_token);
      signal.throwIfAborted();
      return { access: data.access_token, refresh: data.refresh_token, expires: Date.now() + data.expires_in * 1000 - 60_000, providerSubject: identity.id, email, projectId };
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      server.close(); server.closeAllConnections();
    }
  });
  void result.catch(() => {});
  return { flowId, authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, result, cancel: () => controller.abort() };
}
