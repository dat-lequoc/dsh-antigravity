/**
 * Token accounting for the Antigravity provider.
 *
 * The service does not expose a token total anywhere: `retrieveUserQuotaSummary`
 * reports only remaining fractions and reset times, and `retrieveUserQuota`
 * returns the same fractions per model. There is therefore no upstream "tokens
 * spent" figure to display, and inventing one from the quota percentage would be
 * a guess (the pools are weighted by token cost, not by token count).
 *
 * What the plugin does have is ground truth for its own traffic: every completed
 * stream carries `usageMetadata`, which the adapter already maps into a `usage`
 * chunk. This store accumulates those counts per account and persists them, so
 * the UI can show how many tokens this machine has actually spent.
 *
 * Counts are local to this plugin. A request made from the Antigravity CLI, the
 * IDE, or another DSH profile is not visible here, so the UI labels the figure
 * accordingly rather than presenting it as an account-wide total.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const VERSION = 1;
const DAILY_RETENTION_DAYS = 60;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeCounters(raw) {
  const source = isRecord(raw) ? raw : {};
  return {
    inputTokens: count(source.inputTokens),
    outputTokens: count(source.outputTokens),
    cacheReadTokens: count(source.cacheReadTokens),
    requests: count(source.requests),
  };
}

function addCounters(target, usage) {
  target.inputTokens += count(usage.inputTokens);
  target.outputTokens += count(usage.outputTokens);
  target.cacheReadTokens += count(usage.cacheReadTokens);
  target.requests += 1;
}

function totalOf(counters) {
  return counters.inputTokens + counters.outputTokens;
}

/** Local calendar day, so "today" matches the user's clock rather than UTC. */
export function dayKey(at) {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(date.getFullYear())}-${month}-${day}`;
}

function normalizeAccount(raw, now) {
  const source = isRecord(raw) ? raw : {};
  const daily = {};
  const cutoff = now - DAILY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const [key, value] of Object.entries(isRecord(source.daily) ? source.daily : {})) {
    // Keys are YYYY-MM-DD, so a lexical comparison against the cutoff day is
    // enough and avoids parsing every entry.
    if (key >= dayKey(cutoff)) daily[key] = normalizeCounters(value);
  }
  const models = {};
  for (const [id, value] of Object.entries(isRecord(source.models) ? source.models : {})) {
    if (typeof id === "string" && id) models[id] = normalizeCounters(value);
  }
  return {
    firstRecordedAt: count(source.firstRecordedAt),
    updatedAt: count(source.updatedAt),
    totals: normalizeCounters(source.totals),
    daily,
    models,
  };
}

export function normalizeUsage(raw, now = Date.now()) {
  const source = isRecord(raw) ? raw : {};
  const accounts = {};
  for (const [id, value] of Object.entries(isRecord(source.accounts) ? source.accounts : {})) {
    if (typeof id === "string" && id) accounts[id] = normalizeAccount(value, now);
  }
  return { version: VERSION, updatedAt: count(source.updatedAt), accounts };
}

/**
 * Shape handed to the UI. `models` is sorted by spend so the panel can show the
 * heaviest consumers first, and `scope` makes the local-only nature explicit.
 */
export function summarizeUsage(account, now = Date.now()) {
  const normalized = account === undefined ? undefined : account;
  if (!normalized) {
    return {
      scope: "local",
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      todayTokens: 0,
      todayRequests: 0,
      models: [],
      firstRecordedAt: 0,
      updatedAt: 0,
    };
  }
  const totals = normalized.totals;
  const today = normalized.daily[dayKey(now)] ?? normalizeCounters(undefined);
  const models = Object.entries(normalized.models)
    .map(([id, counters]) => ({ id, ...counters, totalTokens: totalOf(counters) }))
    .sort((left, right) => right.totalTokens - left.totalTokens || left.id.localeCompare(right.id));
  return {
    scope: "local",
    requests: totals.requests,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    totalTokens: totalOf(totals),
    todayTokens: totalOf(today),
    todayRequests: today.requests,
    models,
    firstRecordedAt: normalized.firstRecordedAt,
    updatedAt: normalized.updatedAt,
  };
}

export class FileUsageStore {
  #file;
  #chain = Promise.resolve();
  #cache;

  constructor(file) {
    this.#file = file;
  }

  path() {
    return this.#file;
  }

  async read() {
    if (this.#cache) return this.#cache;
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8"));
      this.#cache = normalizeUsage(parsed);
      return this.#cache;
    } catch (error) {
      if (error && error.code === "ENOENT") {
        this.#cache = normalizeUsage(undefined);
        return this.#cache;
      }
      // A corrupt file must not break streaming; start over rather than throw.
      this.#cache = normalizeUsage(undefined);
      return this.#cache;
    }
  }

  async write(state) {
    const normalized = normalizeUsage(state);
    await mkdir(dirname(this.#file), { recursive: true });
    const tempFile = `${this.#file}.tmp`;
    await writeFile(tempFile, JSON.stringify({ ...normalized, updatedAt: Date.now() }, null, 2), {
      mode: 0o600,
    });
    await rename(tempFile, this.#file);
    this.#cache = normalized;
    return normalized;
  }

  /**
   * Fold one finished request into the totals. Serialized through a promise
   * chain so concurrent streams cannot clobber each other's counts, and never
   * rejects: accounting must not fail a turn that already succeeded.
   */
  record(accountId, model, usage, now = Date.now()) {
    const id = typeof accountId === "string" && accountId ? accountId : "unknown";
    const next = (async () => {
      await this.#chain.catch(() => {});
      const state = await this.read();
      const accounts = { ...state.accounts };
      const current = accounts[id] ?? normalizeAccount(undefined, now);
      const updated = {
        ...current,
        totals: { ...current.totals },
        daily: { ...current.daily },
        models: { ...current.models },
      };
      addCounters(updated.totals, usage);
      const today = dayKey(now);
      updated.daily[today] = { ...(updated.daily[today] ?? normalizeCounters(undefined)) };
      addCounters(updated.daily[today], usage);
      const modelId = typeof model === "string" && model ? model : "unknown";
      updated.models[modelId] = { ...(updated.models[modelId] ?? normalizeCounters(undefined)) };
      addCounters(updated.models[modelId], usage);
      updated.firstRecordedAt = current.firstRecordedAt || now;
      updated.updatedAt = now;
      accounts[id] = updated;
      return this.write({ version: VERSION, updatedAt: now, accounts });
    })();
    this.#chain = next.catch(() => {});
    return next.catch(() => undefined);
  }

  /** Summary for one account, for the UI payloads. */
  async summary(accountId, now = Date.now()) {
    const state = await this.read();
    const id = typeof accountId === "string" && accountId ? accountId : "unknown";
    return summarizeUsage(state.accounts[id], now);
  }

  /** Resolve once every queued write has settled, so callers can read a total. */
  async flush() {
    await this.#chain.catch(() => {});
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
}
