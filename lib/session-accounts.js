/**
 * Per-session Antigravity account pins.
 *
 * The plugin's account store has one profile-wide `activeAccountId`. A pin is
 * the exception: it records which account a *session* prefers, so several
 * sessions can spend different accounts at the same time. The active account
 * remains the default for every session without a pin.
 *
 * Session ids are unbounded and sessions are disposable, so the document keeps
 * only the most recent records and drops ones older than the retention window.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const SESSION_ACCOUNTS_VERSION = 1;

/** Why a session points at an account: chosen by the user, or forced by an exhausted one. */
export const SESSION_ACCOUNT_REASONS = Object.freeze(["pinned", "failover"]);

/** Records kept across all sessions; the oldest fall off first. */
export const MAX_SESSION_ACCOUNTS = 500;

/** A resumed session older than this starts from the active account again. */
export const SESSION_ACCOUNT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Sanitize a stored session-account document.
 * Malformed rows, unknown reasons, and expired records are dropped rather than
 * rejected: a corrupt pin must never fail a model request.
 * @param {unknown} source - parsed file contents, or anything else.
 * @param {number} [now] - reference time for retention.
 * @returns {{ version: number, sessions: Record<string, { accountId: string, reason: string, updatedAt: number }> }}
 */
export function normalizeSessionAccounts(source, now = Date.now()) {
  const sessions = {};
  const raw = isRecord(source) && isRecord(source.sessions) ? source.sessions : {};
  const records = [];
  for (const [sessionId, value] of Object.entries(raw)) {
    if (!sessionId || !isRecord(value)) continue;
    const accountId = typeof value.accountId === "string" ? value.accountId.trim() : "";
    if (!accountId) continue;
    const reason = SESSION_ACCOUNT_REASONS.includes(value.reason) ? value.reason : "pinned";
    const updatedAt = Number.isFinite(value.updatedAt) ? Math.max(0, Math.floor(value.updatedAt)) : now;
    if (now - updatedAt > SESSION_ACCOUNT_RETENTION_MS) continue;
    records.push([sessionId, { accountId, reason, updatedAt }]);
  }
  records.sort(([, left], [, right]) => right.updatedAt - left.updatedAt);
  const keep = records
    // A parsed JSON object can carry these as own keys; assigning them would
    // mutate the prototype instead of storing a record.
    .filter(([sessionId]) => sessionId !== "__proto__" && sessionId !== "constructor" && sessionId !== "prototype")
    .slice(0, MAX_SESSION_ACCOUNTS);
  for (const [sessionId, record] of keep) sessions[sessionId] = record;
  return { version: SESSION_ACCOUNTS_VERSION, sessions };
}

/**
 * Durable session-to-account map, loaded once and written through on every change.
 * Reads are synchronous after {@link ready} so the adapter can resolve an account
 * on the request path without another await.
 */
export class FileSessionAccountStore {
  #file;
  /** @type {Map<string, { accountId: string, reason: string, updatedAt: number }> | undefined} */
  #records;
  #loading;
  #chain = Promise.resolve();

  /**
   * @param {string} file - JSON document path.
   */
  constructor(file) {
    this.#file = file;
  }

  /**
   * Load the document once. Concurrent callers share one read.
   * @returns {Promise<this>}
   */
  async ready() {
    if (this.#records !== undefined) return this;
    if (this.#loading === undefined) this.#loading = this.#load();
    try {
      await this.#loading;
    } catch (error) {
      this.#loading = undefined;
      throw error;
    }
    return this;
  }

  async #load() {
    try {
      this.#records = new Map(Object.entries(normalizeSessionAccounts(JSON.parse(await readFile(this.#file, "utf8"))).sessions));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) {
        this.#records = new Map();
        return;
      }
      throw error;
    }
  }

  /**
   * Current pin for one session. Call {@link ready} first.
   * @param {string | undefined} sessionId
   * @returns {{ accountId: string, reason: string, updatedAt: number } | undefined}
   */
  get(sessionId) {
    if (sessionId === undefined || sessionId === null) return undefined;
    return this.#records?.get(String(sessionId));
  }

  /** @returns {Record<string, { accountId: string, reason: string, updatedAt: number }>} */
  records() {
    return Object.fromEntries(this.#records ?? []);
  }

  /**
   * Point one session at an account.
   * @param {string} sessionId
   * @param {string} accountId
   * @param {"pinned" | "failover"} [reason]
   * @returns {Promise<this>}
   */
  async pin(sessionId, accountId, reason = "pinned") {
    if (!sessionId) throw new Error("session accounts: a session id is required");
    if (!accountId) throw new Error("session accounts: an account id is required");
    return this.#mutate((records) => {
      records.set(String(sessionId), {
        accountId: String(accountId),
        reason: SESSION_ACCOUNT_REASONS.includes(reason) ? reason : "pinned",
        updatedAt: Date.now(),
      });
    });
  }

  /**
   * Drop one session's pin so it follows the active account again.
   * @param {string} sessionId
   * @returns {Promise<this>}
   */
  async clear(sessionId) {
    return this.#mutate((records) => {
      records.delete(String(sessionId));
    });
  }

  /**
   * Apply one change under the write chain, so concurrent edits cannot interleave.
   * @param {(records: Map<string, { accountId: string, reason: string, updatedAt: number }>) => void} change
   * @returns {Promise<this>}
   */
  #mutate(change) {
    const next = (async () => {
      await this.#chain.catch(() => {});
      await this.ready();
      const records = new Map(this.#records);
      change(records);
      await this.#write(records);
      this.#records = records;
      return this;
    })();
    this.#chain = next.catch(() => {});
    return next;
  }

  async #write(records) {
    const now = Date.now();
    const sessions = {};
    const kept = [...records.entries()]
      .filter(([, record]) => now - record.updatedAt <= SESSION_ACCOUNT_RETENTION_MS)
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_SESSION_ACCOUNTS);
    for (const [sessionId, record] of kept) sessions[sessionId] = record;
    const body = `${JSON.stringify({ version: SESSION_ACCOUNTS_VERSION, sessions }, null, 2)}\n`;
    await mkdir(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, this.#file);
  }
}
