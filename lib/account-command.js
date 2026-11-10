/**
 * `/antigravity-account`: show or choose the Antigravity account this session uses.
 *
 * A pin is per session, while the plugin-wide active account stays the default
 * for every session without one. The command only writes the pin record; the
 * adapter resolves it on the next request, so an idle session picks up the
 * change immediately and a running turn picks it up on its next step.
 */

/** Slash command name (lowercase, no leading slash). */
export const ACCOUNT_COMMAND_NAME = "antigravity-account";

/** Inputs that clear a pin and fall back to the plugin-wide active account. */
const CLEAR_WORDS = new Set(["active", "default", "off", "clear", "none", "auto"]);

function labelOf(account) {
  return account.label || account.email || account.id;
}

function describeAccount(account) {
  const label = labelOf(account);
  return account.email && account.email !== label ? `${label} — ${account.email}` : label;
}

/**
 * Resolve one user-supplied account reference.
 * Accepts a 1-based row number (`3` or `#3`), an exact account id, an exact
 * email or label (case-insensitive), or a unique prefix of any of those.
 * @param {readonly { id: string, email?: string, label?: string }[]} accounts - account summaries.
 * @param {string} query - user input.
 * @returns {{ id: string, email?: string, label?: string, authState?: string } | undefined}
 */
export function findAccount(accounts, query) {
  const text = String(query ?? "").trim();
  if (text === "") return undefined;
  const numbered = /^#?(\d+)$/.exec(text);
  if (numbered !== null) {
    const index = Number(numbered[1]) - 1;
    return index >= 0 && index < accounts.length ? accounts[index] : undefined;
  }
  const lower = text.toLowerCase();
  const exact = accounts.find((account) => account.id === text)
    ?? accounts.find((account) => (account.email ?? "").toLowerCase() === lower)
    ?? accounts.find((account) => (account.label ?? "").toLowerCase() === lower);
  if (exact !== undefined) return exact;
  const matching = accounts.filter((account) => account.id.startsWith(text)
    || (account.email ?? "").toLowerCase().startsWith(lower)
    || (account.label ?? "").toLowerCase().startsWith(lower));
  return matching.length === 1 ? matching[0] : undefined;
}

/**
 * Render the account list with the active account and this session's pin marked.
 * @param {readonly { id: string, email?: string, label?: string, authState?: string }[]} accounts
 * @param {string | null | undefined} activeAccountId
 * @param {{ accountId: string, reason: string } | undefined} pin
 * @returns {string}
 */
export function describeAccounts(accounts, activeAccountId, pin) {
  if (accounts.length === 0) {
    return "No Antigravity accounts are signed in. Add one on the Antigravity settings page.";
  }
  const lines = ["Antigravity accounts:"];
  accounts.forEach((account, index) => {
    const marks = [];
    if (account.id === activeAccountId) marks.push("active");
    if (pin?.accountId === account.id) {
      marks.push(pin.reason === "failover" ? "this session, after failover" : "this session");
    }
    const status = account.authState === undefined || account.authState === "ready" ? "" : ` (${account.authState})`;
    const suffix = marks.length === 0 ? "" : ` — ${marks.join(", ")}`;
    lines.push(`  ${index + 1}. ${describeAccount(account)}${status}${suffix}`);
  });
  const summary = pin === undefined
    ? "This session follows the active account."
    : `This session uses ${pin.accountId === activeAccountId ? "the active account" : `#${accounts.findIndex((account) => account.id === pin.accountId) + 1}`}${pin.reason === "failover" ? " (switched after a quota failure)" : ""}.`;
  lines.push("", summary, `Send /${ACCOUNT_COMMAND_NAME} <#n | email | id | active> to change it.`);
  return lines.join("\n");
}

/**
 * Execute one command invocation.
 * @param {{
 *   store: { summaries: () => Promise<{ activeAccountId?: string | null, accounts?: readonly any[] }> },
 *   sessionAccounts: { get: (sessionId: string) => { accountId: string, reason: string } | undefined, pin: (sessionId: string, accountId: string, reason?: string) => Promise<unknown>, clear: (sessionId: string) => Promise<unknown> },
 *   sessionId: string,
 *   rawInput: string,
 * }} options
 * @returns {Promise<{ kind: "success" | "error", text: string }>}
 */
export async function runAccountCommand({ store, sessionAccounts, sessionId, rawInput }) {
  const document = await store.summaries();
  const accounts = Array.isArray(document?.accounts) ? document.accounts : [];
  const activeAccountId = document?.activeAccountId;
  const pin = sessionAccounts.get(sessionId);
  const text = String(rawInput ?? "").trim();

  if (text === "" || text.toLowerCase() === "list") {
    return { kind: "success", text: describeAccounts(accounts, activeAccountId, pin) };
  }
  if (CLEAR_WORDS.has(text.toLowerCase())) {
    await sessionAccounts.clear(sessionId);
    const active = accounts.find((account) => account.id === activeAccountId);
    return {
      kind: "success",
      text: active === undefined
        ? "This session follows the active account."
        : `This session follows the active account (${describeAccount(active)}).`,
    };
  }
  const account = findAccount(accounts, text);
  if (account === undefined) {
    return { kind: "error", text: `No Antigravity account matches "${text}".\n\n${describeAccounts(accounts, activeAccountId, pin)}` };
  }
  if (account.authState !== undefined && account.authState !== "ready") {
    return { kind: "error", text: `${describeAccount(account)} is not signed in (${account.authState}). Sign it in on the Antigravity settings page first.` };
  }
  await sessionAccounts.pin(sessionId, account.id, "pinned");
  return { kind: "success", text: `This session now uses ${describeAccount(account)}.` };
}

/**
 * Register `/antigravity-account` when this profile mounts the commands service.
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context.
 * @param {{ store: any, sessionAccounts: any }} options - resolved owners.
 */
export function registerAccountCommand(ctx, options) {
  ctx.inject(["commands"], (commandCtx) => {
    if (typeof commandCtx.commands?.register !== "function") return;
    commandCtx.effect(
      () => commandCtx.commands.register({
        name: ACCOUNT_COMMAND_NAME,
        description: "Show or choose the Antigravity account this session uses.",
        input: { hint: "<#n | email | id | active>" },
        handler: (invocation) => runAccountCommand({
          store: options.store,
          sessionAccounts: options.sessionAccounts,
          sessionId: String(invocation.agent.session.id),
          rawInput: invocation.rawInput,
        }),
      }),
      "antigravity account command",
    );
  });
}
