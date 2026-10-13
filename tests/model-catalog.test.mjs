// The picker's model list is the fetched account catalog. Losing that cache falls
// back to the static MODELS table, which silently hides catalog-only models — the
// reported "sometimes Gemini 3.8 Flash is missing" symptom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityAdapter, catalogCacheKey, modelOptionsPayload } from '../lib/index.js';

const store = (over = {}) => ({
  path: () => '/tmp/antigravity-oauth.json',
  accountId: 'account-a',
  credentialRevision: 1,
  proxy: { revision: 0 },
  ...over,
});

test('the model catalog survives an on-demand token refresh', () => {
  // A refresh bumps credentialRevision; the catalog must not be orphaned by it.
  assert.equal(
    catalogCacheKey(store({ credentialRevision: 9 })),
    catalogCacheKey(store({ credentialRevision: 1 })),
  );
});

test('a proxy edit does not orphan the catalog either', () => {
  assert.equal(catalogCacheKey(store({ proxy: { revision: 4 } })), catalogCacheKey(store()));
});

test('the catalog stays separate per account and per credential file', () => {
  assert.notEqual(catalogCacheKey(store()), catalogCacheKey(store({ accountId: 'account-b' })));
  assert.notEqual(catalogCacheKey(store()), catalogCacheKey(store({ path: () => '/tmp/other.json' })));
  assert.notEqual(catalogCacheKey(store()), catalogCacheKey(undefined));
});

test('an enabled catalog-only model is offered while the catalog is loaded', () => {
  const options = modelOptionsPayload({
    enabledModelIds: ['gemini-3.8-flash-tiered'],
    catalogModels: [{ id: 'gemini-3.8-flash-tiered', name: 'Gemini 3.8 Flash Tiered' }],
  }, undefined);
  assert.equal(options.options.find((option) => option.id === 'gemini-3.8-flash-tiered')?.enabled, true);
});

test('the static fallback reproduces the reported missing-model symptom', () => {
  // This is the failure mode the cache-key fix prevents. With the real enabled
  // set and no catalog, the two static bases survive and 3.8 disappears — the
  // exact picker contents from the report.
  const shown = modelOptionsPayload({
    enabledModelIds: ['gemini-3.1-flash-image', 'gemini-3.8-flash-tiered', 'gemini-3.1-pro'],
    catalogModels: [],
  }, undefined).options.filter((option) => option.enabled).map((option) => option.id);
  assert.deepEqual(shown.sort(), ['gemini-3.1-flash-image', 'gemini-3.1-pro']);
});

test('the same enabled set keeps all three models once the catalog is loaded', () => {
  const shown = modelOptionsPayload({
    enabledModelIds: ['gemini-3.1-flash-image', 'gemini-3.8-flash-tiered', 'gemini-3.1-pro'],
    catalogModels: [
      { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image' },
      { id: 'gemini-3.8-flash-tiered', name: 'Gemini 3.8 Flash Tiered' },
      { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
    ],
  }, undefined).options.filter((option) => option.enabled).map((option) => option.id);
  assert.deepEqual(shown.sort(), ['gemini-3.1-flash-image', 'gemini-3.1-pro', 'gemini-3.8-flash-tiered']);
});

test('the picker keeps catalog-only models before this process fetches a catalog', async () => {
  // An account-scoped store with nothing in the in-memory catalog: exactly the
  // state right after a restart, when the picker used to show only the models in
  // the static table. The persisted catalog is the correct fallback.
  const accountStore = {
    accountId: 'account-a',
    path: () => '/tmp/antigravity-oauth.json',
    read: async () => ({
      access: 'token',
      refresh: 'refresh',
      expires: Date.now() + 3600e3,
    }),
  };
  const modelSettings = {
    read: async () => ({
      enabledModelIds: ['gemini-3.1-flash-image', 'gemini-3.8-flash-tiered', 'gemini-3.1-pro'],
      catalogModels: [
        { id: 'gemini-3.8-flash-tiered', name: 'Gemini 3.8 Flash Tiered', inputModalities: ['text'], reasoningEfforts: ['low', 'medium', 'high'], contextWindow: 1048576, maxTokens: 65536 },
        { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', inputModalities: ['text'], reasoningEfforts: ['low', 'high'], contextWindow: 1048576, maxTokens: 65536 },
        { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image', inputModalities: ['text', 'image'], reasoningEfforts: [], contextWindow: 1048576, maxTokens: 65536 },
      ],
    }),
    setCatalogModels: async () => {},
  };

  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);
  const models = await adapter.listModels('antigravity');
  assert.deepEqual(
    models.map((model) => model.id).sort(),
    ['gemini-3.1-flash-image', 'gemini-3.1-pro', 'gemini-3.8-flash-tiered'],
  );

  const flash38 = models.find((m) => m.id === 'gemini-3.8-flash-tiered');
  assert.equal(flash38?.reasoning?.defaultEffort, 'high');

  const pro31 = models.find((m) => m.id === 'gemini-3.1-pro');
  assert.equal(pro31?.reasoning?.defaultEffort, 'high');

  const flashImg = models.find((m) => m.id === 'gemini-3.1-flash-image');
  assert.equal(flashImg?.reasoning, undefined);

  const resolved = await adapter.resolveModel('antigravity', 'gemini-3.8-flash-tiered');
  assert.equal(resolved.reasoning?.defaultEffort, 'high');
});

test('static models declare high default reasoning when high is supported, or max available', async () => {
  const accountStore = {
    accountId: 'account-a',
    path: () => '/tmp/antigravity-oauth.json',
    read: async () => ({ access: 'token' }),
  };
  const modelSettings = {
    read: async () => ({
      enabledModelIds: ['gemini-3.7-flash', 'gpt-oss-120b', 'claude-opus-4-6'],
      catalogModels: [],
    }),
    setCatalogModels: async () => {},
  };

  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);
  const gemini37 = await adapter.resolveModel('antigravity', 'gemini-3.7-flash');
  assert.equal(gemini37.reasoning?.defaultEffort, 'high');

  const gptOss = await adapter.resolveModel('antigravity', 'gpt-oss-120b');
  assert.equal(gptOss.reasoning?.defaultEffort, 'medium');

  const claudeOpus = await adapter.resolveModel('antigravity', 'claude-opus-4-6');
  assert.equal(claudeOpus.reasoning?.defaultEffort, 'high');

  const claudeOpus55 = await adapter.resolveModel('antigravity', 'claude-opus-5.5');
  assert.equal(claudeOpus55.name, 'Claude Opus 5.5');
  assert.deepEqual(
    claudeOpus55.reasoning?.efforts.map((effort) => effort.id),
    ['low', 'medium', 'high'],
  );
  assert.equal(claudeOpus55.reasoning?.defaultEffort, 'high');
  assert.equal(claudeOpus55.defaultMaxTokens, 64000);

  const claudeSonnet55 = await adapter.resolveModel('antigravity', 'claude-sonnet-5.5');
  assert.equal(claudeSonnet55.name, 'Claude Sonnet 5.5');
  assert.equal(claudeSonnet55.reasoning?.defaultEffort, 'high');
  assert.equal(claudeSonnet55.defaultMaxTokens, 64000);
});

test('Claude 5.5 models sort before Claude 4.6 models', () => {
  const options = modelOptionsPayload({
    enabledModelIds: ['claude-opus-4-6', 'claude-opus-5.5', 'claude-sonnet-4-6', 'claude-sonnet-5.5'],
    catalogModels: [],
  }, undefined).options.filter((o) => o.enabled).map((o) => o.id);

  const opus55Idx = options.indexOf('claude-opus-5.5');
  const opus46Idx = options.indexOf('claude-opus-4-6');
  const sonnet55Idx = options.indexOf('claude-sonnet-5.5');
  const sonnet46Idx = options.indexOf('claude-sonnet-4-6');

  assert.ok(opus55Idx !== -1 && opus46Idx !== -1);
  assert.ok(opus55Idx < opus46Idx, 'claude-opus-5.5 should sort before claude-opus-4-6');
  assert.ok(sonnet55Idx !== -1 && sonnet46Idx !== -1);
  assert.ok(sonnet55Idx < sonnet46Idx, 'claude-sonnet-5.5 should sort before claude-sonnet-4-6');
});

test('Claude 5.5 efforts route to the live runtime IDs', async () => {
  const accountStore = {
    async read() { return { access: 'mock-token', projectId: 'mock-project', expires: Date.now() + 3600e3 }; },
    async capture() { return this; },
    async modify() { return this.read(); },
  };
  const modelSettings = { async read() { return { enabledModelIds: ['claude-opus-5.5', 'claude-sonnet-5.5'], catalogModels: [] }; } };
  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('streamGenerateContent')) sent.push(JSON.parse(init.body).model);
    return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    for (const [model, effort, expected] of [
      ['claude-opus-5.5', 'low', 'claude-opus-5-5-low'],
      ['claude-opus-5.5', 'medium', 'claude-opus-5-5-medium'],
      ['claude-opus-5.5', undefined, 'claude-opus-5-5-high'],
      ['claude-sonnet-5.5', 'high', 'claude-sonnet-5-5-high'],
    ]) {
      sent.length = 0;
      for await (const _ of adapter.stream({ provider: 'antigravity', model, reasoningEffort: effort, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {}
      assert.equal(sent.at(-1), expected, `${model}/${effort}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('role tool messages become immediate function responses', async () => {
  const accountStore = {
    async read() { return { access: 'mock-token', projectId: 'mock-project', expires: Date.now() + 3600e3 }; },
    async capture() { return this; },
    async modify() { return this.read(); },
  };
  const modelSettings = {
    async read() {
      return { enabledModelIds: ['claude-opus-5.5'], catalogModels: [] };
    },
  };
  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('streamGenerateContent')) request = JSON.parse(init.body);
    return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    for await (const _ of adapter.stream({
      provider: 'antigravity',
      model: 'claude-opus-5.5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Run the tool.' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'toolu_test', name: 'lookup', arguments: '{"q":"x"}' }] },
        { role: 'tool', toolCallId: 'toolu_test', content: [{ type: 'text', text: 'tool output' }] },
      ],
    })) {}
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(request.request.contents, [
    { role: 'user', parts: [{ text: 'Run the tool.' }] },
    { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { q: 'x' }, id: 'toolu_test' } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { output: 'tool output' }, id: 'toolu_test' } }] },
  ]);
});

// Gemini 4 Argon is the model the Antigravity CLI advertises as
// gemini-4-argon-{low,medium,high}. Upstream serves only those pinned tiers and
// never a bare `gemini-4-argon`, so the static entry plus ROUTING is what turns
// them into one picker row with a reasoning selector.
test('Gemini 4 Argon is offered with its three reasoning tiers', async () => {
  const accountStore = {
    accountId: 'account-a',
    path: () => '/tmp/antigravity-oauth.json',
    read: async () => ({ access: 'token' }),
  };
  const modelSettings = {
    read: async () => ({ enabledModelIds: ['gemini-4-argon'], catalogModels: [] }),
    setCatalogModels: async () => {},
  };

  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);
  const argon = await adapter.resolveModel('antigravity', 'gemini-4-argon');
  assert.equal(argon.name, 'Gemini 4 Argon');
  assert.deepEqual(
    argon.reasoning?.efforts.map((effort) => effort.id),
    ['low', 'medium', 'high'],
  );
  assert.equal(argon.reasoning?.defaultEffort, 'high');
  assert.equal(argon.defaultMaxTokens, 65536);
});

test('Gemini 4 Argon is offered even though the fetched catalog omits it', () => {
  // The catalog is replaced wholesale on every quota refresh and need not
  // mention Argon (a stale fetch, or an account the tiers are not offered to);
  // the built-in entry has to survive that merge or it disappears again.
  const shown = modelOptionsPayload({
    enabledModelIds: ['gemini-4-argon', 'gemini-3.1-pro'],
    catalogModels: [{ id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' }],
  }, undefined).options;

  const argon = shown.find((option) => option.id === 'gemini-4-argon');
  assert.ok(argon, 'gemini-4-argon must remain selectable');
  assert.equal(argon.enabled, true);
  assert.equal(argon.name, 'Gemini 4 Argon');
});

test('Gemini 4 Argon sorts ahead of every Gemini 3.x model', () => {
  const options = modelOptionsPayload({
    enabledModelIds: ['gemini-4-argon', 'gemini-3.7-flash', 'gemini-3.8-flash-tiered'],
    catalogModels: [
      { id: 'gemini-3.8-flash-tiered', name: 'Gemini 3.8 Flash Tiered' },
      { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
    ],
  }, undefined).options.filter((option) => option.enabled).map((option) => option.id);

  assert.ok(options.indexOf('gemini-4-argon') < options.indexOf('gemini-3.8-flash-tiered'));
});

test('Gemini 4 Argon efforts route to the pinned upstream tiers', async () => {
  const accountStore = {
    async read() { return { access: 'mock-token', projectId: 'mock-project', expires: Date.now() + 3600e3 }; },
    async capture() { return this; },
    async modify() { return this.read(); },
  };
  const modelSettings = { async read() { return { enabledModelIds: ['gemini-4-argon'], catalogModels: [] }; } };
  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('streamGenerateContent')) sent.push(JSON.parse(init.body).model);
    return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    // The bare `gemini-4-argon` id is not servable: every effort, including the
    // default and the off switch, must resolve to one of the pinned tier ids.
    for (const [effort, expected] of [
      ['low', 'gemini-4-argon-low'],
      ['medium', 'gemini-4-argon-medium'],
      ['high', 'gemini-4-argon-high'],
      ['xhigh', 'gemini-4-argon-high'],
      [undefined, 'gemini-4-argon-high'],
      ['off', 'gemini-4-argon-low'],
    ]) {
      sent.length = 0;
      for await (const _ of adapter.stream({
        provider: 'antigravity',
        model: 'gemini-4-argon',
        reasoningEffort: effort,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) {}
      assert.equal(sent.at(-1), expected, `effort=${String(effort)}`);
      assert.notEqual(sent.at(-1), 'gemini-4-argon', 'the bare id must never be sent');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requests identify as the Antigravity CLI client', async () => {
  // Model availability is gated on the client identity in User-Agent, and the
  // gate is load-bearing for Argon: measured against one token and project,
  // `antigravity/1.15.8 linux/amd64` answered 404 for every Argon tier and the
  // model was absent from fetchAvailableModels, while `antigravity/cli/1.3.4`
  // answered 200 and the catalog listed the tiers. Dropping the header entirely
  // earns a 403 "You do not have a valid license of this product".
  const accountStore = {
    async read() { return { access: 'mock-token', projectId: 'mock-project', expires: Date.now() + 3600e3 }; },
    async capture() { return this; },
    async modify() { return this.read(); },
  };
  const modelSettings = { async read() { return { enabledModelIds: ['gemini-4-argon'], catalogModels: [] }; } };
  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);
  const originalFetch = globalThis.fetch;
  const userAgents = [];
  globalThis.fetch = async (url, init = {}) => {
    const headers = init.headers ?? {};
    const ua = typeof headers.get === 'function' ? headers.get('User-Agent') : headers['User-Agent'];
    if (ua) userAgents.push(ua);
    return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    for await (const _ of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      reasoningEffort: 'high',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {}
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(userAgents.length > 0, 'the adapter must send a User-Agent');
  for (const ua of userAgents) {
    assert.match(ua, /^antigravity\/cli\//, `User-Agent lost the CLI segment: ${ua}`);
  }
});
