// Per-session auth: a pin routes one session's requests to its account, a
// subagent inherits its parent's pin, and an exhausted account hands the same
// request to another signed-in account without changing the profile default.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityAdapter } from '../lib/index.js';
import { FileSessionAccountStore } from '../lib/session-accounts.js';

const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];

async function tempFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'antigravity-failover-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'antigravity-sessions.json');
}

function credentialStore({ active = 'acct-a', tokens = { 'acct-a': 'token-a', 'acct-b': 'token-b' }, broken = new Set() } = {}) {
  return {
    path: () => '/tmp/antigravity-oauth.json',
    capture: async (accountId) => {
      const id = accountId ?? active;
      if (!(id in tokens) || broken.has(id)) {
        const error = new Error('Account not found');
        error.code = 'ACCOUNT_NOT_FOUND';
        throw error;
      }
      const credentials = () => ({ access: tokens[id], refresh: 'refresh', expires: Date.now() + 3_600_000 });
      return {
        accountId: id,
        proxy: { enabled: false, revision: 0 },
        read: async () => credentials(),
        modify: async (change) => change(credentials()),
      };
    },
    summaries: async () => ({
      revision: 1,
      activeAccountId: active,
      accounts: Object.keys(tokens).map((id) => ({ id, email: `${id}@example.com`, authState: 'ready' })),
    }),
  };
}

const modelSettings = { read: async () => ({ enabledModelIds: ['gemini-4-argon'], catalogModels: [] }) };
const usageStore = { record: async () => {} };

/** Stub the wire: quota/denied tokens fail only on the streaming call. */
function installFetch({ quota = new Set(), denied = new Set() } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    const headers = init.headers ?? {};
    const auth = typeof headers.get === 'function' ? headers.get('authorization') : (headers.Authorization ?? headers.authorization);
    calls.push({ url: target, auth });
    if (target.includes('streamGenerateContent')) {
      const token = String(auth ?? '').replace(/^Bearer /, '');
      if (denied.has(token)) {
        return new Response(JSON.stringify({ error: { message: 'authentication failed' } }), { status: 401, headers: { 'content-type': 'application/json' } });
      }
      if (quota.has(token)) {
        return new Response(JSON.stringify({ error: { code: 429, message: 'Individual quota reached' } }), { status: 429, headers: { 'content-type': 'application/json' } });
      }
      return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
    streamAuths: () => calls.filter((call) => call.url.includes('streamGenerateContent')).map((call) => call.auth),
  };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function adapterFor(store, sessionAccounts, options = {}) {
  return new AntigravityAdapter(store, modelSettings, () => undefined, usageStore, {
    sessionAccounts,
    ...options,
  });
}

test('a pinned session sends its requests with the pinned account', async (t) => {
  const sessionAccounts = new FileSessionAccountStore(await tempFile(t));
  await sessionAccounts.ready();
  await sessionAccounts.pin('session-pinned', 'acct-b');
  const adapter = adapterFor(credentialStore({ active: 'acct-a' }), sessionAccounts);
  const wire = installFetch();
  t.after(() => wire.restore());

  await collect(adapter.stream({ provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'session-pinned', messages }));

  assert.deepEqual(wire.streamAuths(), ['Bearer token-b']);
});

test('an unpinned session keeps using the active account', async (t) => {
  const sessionAccounts = new FileSessionAccountStore(await tempFile(t));
  await sessionAccounts.ready();
  await sessionAccounts.pin('session-pinned', 'acct-b');
  const adapter = adapterFor(credentialStore({ active: 'acct-a' }), sessionAccounts);
  const wire = installFetch();
  t.after(() => wire.restore());

  await collect(adapter.stream({ provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'session-other', messages }));

  assert.deepEqual(wire.streamAuths(), ['Bearer token-a']);
});

test('a subagent inherits the pin of the session that started it', async (t) => {
  const sessionAccounts = new FileSessionAccountStore(await tempFile(t));
  await sessionAccounts.ready();
  await sessionAccounts.pin('session-parent', 'acct-b');
  const sessions = {
    get: (id) => (id === 'session-child' ? { header: { parentSession: 'session-parent' } } : undefined),
  };
  const adapter = adapterFor(credentialStore(), sessionAccounts, { sessions: () => sessions });
  const wire = installFetch();
  t.after(() => wire.restore());

  await collect(adapter.stream({ provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'session-child', messages }));

  assert.deepEqual(wire.streamAuths(), ['Bearer token-b']);
});

test('a stale pin falls back to the active account instead of failing', async (t) => {
  const sessionAccounts = new FileSessionAccountStore(await tempFile(t));
  await sessionAccounts.ready();
  await sessionAccounts.pin('session-gone', 'acct-removed');
  const adapter = adapterFor(credentialStore({ active: 'acct-a' }), sessionAccounts);
  const wire = installFetch();
  t.after(() => wire.restore());

  await collect(adapter.stream({ provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'session-gone', messages }));

  assert.deepEqual(wire.streamAuths(), ['Bearer token-a']);
});

test('a quota failure retries the same step on the next signed-in account', async (t) => {
  const sessionAccounts = new FileSessionAccountStore(await tempFile(t));
  await sessionAccounts.ready();
  const adapter = adapterFor(credentialStore({ active: 'acct-a' }), sessionAccounts);
  const wire = installFetch({ quota: new Set(['token-a']) });
  t.after(() => wire.restore());

  const chunks = await collect(adapter.stream({ provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'session-quota', messages }));

  assert.deepEqual(wire.streamAuths(), ['Bearer token-a', 'Bearer token-b']);
  assert.ok(chunks.some((chunk) => chunk.type === 'finish'), 'the retried request completes the stream');
  // The session remembers the account that worked, so its next step starts there.
  assert.deepEqual(sessionAccounts.get('session-quota'), { accountId: 'acct-b', reason: 'failover', updatedAt: sessionAccounts.get('session-quota').updatedAt });
});

test('failover is skipped when the plugin turns it off', async (t) => {
  const sessionAccounts = new FileSessionAccountStore(await tempFile(t));
  await sessionAccounts.ready();
  const adapter = adapterFor(credentialStore({ active: 'acct-a' }), sessionAccounts, { failoverOnQuota: false });
  const wire = installFetch({ quota: new Set(['token-a']) });
  t.after(() => wire.restore());

  await assert.rejects(
    () => collect(adapter.stream({ provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'session-quota', messages })),
    /quota/i,
  );
  assert.deepEqual(wire.streamAuths(), ['Bearer token-a']);
  assert.equal(sessionAccounts.get('session-quota'), undefined);
});

test('an authentication failure never moves accounts', async (t) => {
  const sessionAccounts = new FileSessionAccountStore(await tempFile(t));
  await sessionAccounts.ready();
  const adapter = adapterFor(credentialStore({ active: 'acct-a' }), sessionAccounts);
  const wire = installFetch({ denied: new Set(['token-a']) });
  t.after(() => wire.restore());

  await assert.rejects(
    () => collect(adapter.stream({ provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'session-auth', messages })),
    /authentication|Antigravity API error/i,
  );
  assert.deepEqual(wire.streamAuths(), ['Bearer token-a']);
  assert.equal(sessionAccounts.get('session-auth'), undefined);
});

test('a pinned session moves only after its own account is exhausted', async (t) => {
  const sessionAccounts = new FileSessionAccountStore(await tempFile(t));
  await sessionAccounts.ready();
  await sessionAccounts.pin('session-pinned', 'acct-b');
  const adapter = adapterFor(credentialStore({ active: 'acct-a' }), sessionAccounts);
  const wire = installFetch({ quota: new Set(['token-b']) });
  t.after(() => wire.restore());

  await collect(adapter.stream({ provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'session-pinned', messages }));

  // acct-a is the next signed-in account, and the pin follows the working one.
  assert.deepEqual(wire.streamAuths(), ['Bearer token-b', 'Bearer token-a']);
  assert.equal(sessionAccounts.get('session-pinned').accountId, 'acct-a');
  assert.equal(sessionAccounts.get('session-pinned').reason, 'failover');
});

test('a candidate that disappears mid-failover cannot loop on the same account', async (t) => {
  const sessionAccounts = new FileSessionAccountStore(await tempFile(t));
  await sessionAccounts.ready();
  // acct-b is listed as ready but cannot be captured: the summary and the
  // credential document disagree for a moment.
  const adapter = adapterFor(credentialStore({ active: 'acct-a', broken: new Set(['acct-b']) }), sessionAccounts);
  const wire = installFetch({ quota: new Set(['token-a']) });
  t.after(() => wire.restore());

  await assert.rejects(
    () => collect(adapter.stream({ provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'session-race', messages })),
    /quota/i,
  );
  // The failed candidate fell back to the active account exactly once more and
  // the loop stopped, so the request never cycles on the same credentials.
  assert.deepEqual(wire.streamAuths(), ['Bearer token-a', 'Bearer token-a']);
  // No account served the step, so the session keeps following the active one.
  assert.equal(sessionAccounts.get('session-race'), undefined);
});
