// The service reports quota as fractions, never as a token count, so the token
// figures in the UI come from counting this plugin's own traffic. These tests
// pin the accounting: what is counted, how it is attributed, and that a bad
// state file cannot take a request down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileUsageStore, normalizeUsage, summarizeUsage, dayKey } from '../lib/usage-store.js';
import { AntigravityAdapter } from '../lib/index.js';

const tempFile = async () => join(await mkdtemp(join(tmpdir(), 'antigravity-usage-')), 'usage.json');

test('a recorded request accumulates totals, the day bucket, and the model bucket', async () => {
  const store = new FileUsageStore(await tempFile());
  const now = new Date('2026-10-13T10:00:00').getTime();

  await store.record('account-a', 'gemini-4-argon', { inputTokens: 900, outputTokens: 300, cacheReadTokens: 100 }, now);
  await store.record('account-a', 'gemini-4-argon', { inputTokens: 100, outputTokens: 50 }, now);
  await store.record('account-a', 'claude-opus-5.5', { inputTokens: 10, outputTokens: 5 }, now);

  const summary = await store.summary('account-a', now);
  assert.equal(summary.requests, 3);
  assert.equal(summary.inputTokens, 1010);
  assert.equal(summary.outputTokens, 355);
  assert.equal(summary.cacheReadTokens, 100);
  // Cached input is a subset of the prompt, so it must not be added again here.
  assert.equal(summary.totalTokens, 1365);
  assert.equal(summary.todayTokens, 1365);
  assert.equal(summary.todayRequests, 3);
  assert.equal(summary.scope, 'local');
});

test('spend is attributed per account and per model, heaviest first', async () => {
  const store = new FileUsageStore(await tempFile());
  const now = Date.now();

  await store.record('account-a', 'claude-opus-5.5', { inputTokens: 10, outputTokens: 5 }, now);
  await store.record('account-a', 'gemini-4-argon', { inputTokens: 5000, outputTokens: 100 }, now);
  await store.record('account-b', 'gemini-4-argon', { inputTokens: 7, outputTokens: 3 }, now);

  const a = await store.summary('account-a', now);
  assert.deepEqual(a.models.map((model) => model.id), ['gemini-4-argon', 'claude-opus-5.5']);
  assert.equal(a.models[0].totalTokens, 5100);

  const b = await store.summary('account-b', now);
  assert.equal(b.requests, 1);
  assert.equal(b.totalTokens, 10);

  // An account with no traffic reports zeroes rather than throwing.
  const unknown = await store.summary('account-c', now);
  assert.equal(unknown.requests, 0);
  assert.equal(unknown.totalTokens, 0);
  assert.deepEqual(unknown.models, []);
});

test('counts survive a reload and a corrupt file resets instead of throwing', async () => {
  const file = await tempFile();
  const store = new FileUsageStore(file);
  await store.record('account-a', 'gemini-4-argon', { inputTokens: 42, outputTokens: 8 });
  await store.flush();

  const reopened = new FileUsageStore(file);
  const summary = await reopened.summary('account-a');
  assert.equal(summary.inputTokens, 42);
  assert.equal(summary.outputTokens, 8);

  await writeFile(file, '{ this is not json');
  const recovered = new FileUsageStore(file);
  const after = await recovered.summary('account-a');
  assert.equal(after.requests, 0);

  // ...and new traffic is still counted afterwards.
  await recovered.record('account-a', 'gemini-4-argon', { inputTokens: 5, outputTokens: 5 });
  assert.equal((await recovered.summary('account-a')).totalTokens, 10);
});

test('negative and malformed counters are ignored rather than subtracted', async () => {
  const now = Date.now();
  const normalized = normalizeUsage({
    accounts: {
      'account-a': {
        totals: { inputTokens: -500, outputTokens: 'lots', requests: 2.7, cacheReadTokens: null },
        daily: { [dayKey(now)]: { inputTokens: 10 } },
        models: { 'gemini-4-argon': { inputTokens: 10, outputTokens: 5 }, '': { inputTokens: 999 } },
      },
    },
  }, now);

  const summary = summarizeUsage(normalized.accounts['account-a'], now);
  assert.equal(summary.inputTokens, 0);
  assert.equal(summary.outputTokens, 0);
  assert.equal(summary.cacheReadTokens, 0);
  assert.equal(summary.requests, 2);
  assert.equal(summary.todayTokens, 10);
  // A blank model id is dropped instead of becoming an entry.
  assert.deepEqual(summary.models.map((model) => model.id), ['gemini-4-argon']);
});

test('day buckets are pruned after the retention window', async () => {
  const now = new Date('2026-10-13T12:00:00').getTime();
  const normalized = normalizeUsage({
    accounts: {
      'account-a': {
        totals: { inputTokens: 300 },
        daily: {
          [dayKey(now)]: { inputTokens: 100 },
          [dayKey(now - 2 * 24 * 60 * 60 * 1000)]: { inputTokens: 100 },
          [dayKey(now - 90 * 24 * 60 * 60 * 1000)]: { inputTokens: 100 },
        },
      },
    },
  }, now);

  // Totals keep everything ever recorded; only the per-day detail is trimmed.
  assert.deepEqual(Object.keys(normalized.accounts['account-a'].daily).sort(), [
    dayKey(now - 2 * 24 * 60 * 60 * 1000),
    dayKey(now),
  ]);
  assert.equal(summarizeUsage(normalized.accounts['account-a'], now).totalTokens, 300);
});

test('a finished stream records its reported usage against the active account', async () => {
  const file = await tempFile();
  const usageStore = new FileUsageStore(file);
  const accountStore = {
    accountId: 'account-a',
    credentialRevision: 1,
    proxy: { revision: 0 },
    path: () => '/tmp/antigravity-oauth.json',
    async read() { return { access: 'mock-token', projectId: 'mock-project', expires: Date.now() + 3600e3 }; },
    async capture() { return this; },
    async modify() { return this.read(); },
  };
  const modelSettings = { async read() { return { enabledModelIds: ['gemini-4-argon'], catalogModels: [] }; } };
  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined, usageStore);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"usageMetadata":' +
      '{"promptTokenCount":1000,"candidatesTokenCount":250,"cachedContentTokenCount":100,"thoughtsTokenCount":50}}\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );

  let usageChunk;
  try {
    for await (const chunk of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      reasoningEffort: 'high',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      if (chunk.type === 'usage') usageChunk = chunk;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Cached prompt tokens are reported separately and reasoning tokens count as
  // output; totals must not double-count the cached subset.
  assert.deepEqual(usageChunk?.usage, { inputTokens: 900, outputTokens: 300, cacheReadTokens: 100 });

  await usageStore.flush();
  const summary = await usageStore.summary('account-a');
  assert.equal(summary.requests, 1);
  assert.equal(summary.inputTokens, 900);
  assert.equal(summary.outputTokens, 300);
  assert.equal(summary.cacheReadTokens, 100);
  assert.equal(summary.totalTokens, 1200);
  assert.deepEqual(summary.models.map((model) => model.id), ['gemini-4-argon']);

  // The state file is private to the user, like the other Antigravity state.
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(written.accounts['account-a'].totals.requests, 1);
});

test('a stream that reports no usage is not counted as a request', async () => {
  const usageStore = new FileUsageStore(await tempFile());
  const accountStore = {
    accountId: 'account-a',
    credentialRevision: 1,
    proxy: { revision: 0 },
    path: () => '/tmp/antigravity-oauth.json',
    async read() { return { access: 'mock-token', projectId: 'mock-project', expires: Date.now() + 3600e3 }; },
    async capture() { return this; },
    async modify() { return this.read(); },
  };
  const modelSettings = { async read() { return { enabledModelIds: ['gemini-4-argon'], catalogModels: [] }; } };
  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined, usageStore);

  const originalFetch = globalThis.fetch;
  // No usageMetadata, as some responses and every test double omit it.
  globalThis.fetch = async () => new Response(
    'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
  try {
    for await (const _ of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {}
  } finally {
    globalThis.fetch = originalFetch;
  }

  await usageStore.flush();
  assert.equal((await usageStore.summary('account-a')).requests, 0);
});
