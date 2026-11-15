// The picker's model list is the fetched account catalog. Losing that cache falls
// back to the static MODELS table, which silently hides catalog-only models — the
// reported "sometimes Gemini 3.8 Flash is missing" symptom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityAdapter, catalogCacheKey, contextCapacity, modelOptionsPayload } from '../lib/index.js';

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

test('maxContextWindow caps every reported context window and never raises one', async () => {
  const accountStore = {
    accountId: 'account-a',
    path: () => '/tmp/antigravity-oauth.json',
    read: async () => ({ access: 'token' }),
  };
  const modelSettings = {
    read: async () => ({ enabledModelIds: ['gemini-4-argon', 'claude-opus-5.5'], catalogModels: [] }),
  };
  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined, undefined, {
    maxContextWindow: 750000,
  });

  const models = await adapter.listModels('antigravity');
  // The Gemini window is lowered, so compaction-basic budgets its pressure from
  // 750,000 instead of 1,048,576 and condenses at 0.8 of the cap.
  assert.equal(models.find((model) => model.id === 'gemini-4-argon').context.contextWindow, 750000);
  // A model already below the cap keeps its own, smaller window.
  assert.equal(models.find((model) => model.id === 'claude-opus-5.5').context.contextWindow, 250000);

  const resolved = await adapter.resolveModel('antigravity', 'gemini-4-argon');
  assert.equal(resolved.context.contextWindow, 750000);
});

test('an unset cap reports the catalog capacity unchanged', async () => {
  const accountStore = {
    accountId: 'account-a',
    path: () => '/tmp/antigravity-oauth.json',
    read: async () => ({ access: 'token' }),
  };
  const modelSettings = { read: async () => ({ enabledModelIds: ['gemini-4-argon'], catalogModels: [] }) };
  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);

  const resolved = await adapter.resolveModel('antigravity', 'gemini-4-argon');
  assert.equal(resolved.context.contextWindow, 1048576);
});

test('contextCapacity only lowers a window and ignores unusable caps', () => {
  assert.equal(contextCapacity(1048576, undefined), 1048576);
  assert.equal(contextCapacity(1048576, 750000), 750000);
  assert.equal(contextCapacity(200000, 750000), 200000);
  // A malformed cap must not blank the window out from under the harness.
  assert.equal(contextCapacity(1048576, 0), 1048576);
  assert.equal(contextCapacity(1048576, -5), 1048576);
  assert.equal(contextCapacity(1048576, Number.NaN), 1048576);
});

test('Gemini 4 Carbon resolves with three reasoning tiers, folds tier aliases, and reads tier quota', async () => {
  const accountStore = {
    accountId: 'account-a',
    path: () => '/tmp/antigravity-oauth.json',
    read: async () => ({ access: 'token' }),
  };
  const modelSettings = {
    read: async () => ({
      enabledModelIds: ['gemini-4-carbon-high'],
      catalogModels: [
        { id: 'gemini-4-carbon-low', name: 'Gemini 4 Carbon Low' },
        { id: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon Medium' },
        { id: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon High' },
      ],
    }),
    setCatalogModels: async () => {},
  };

  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);
  const carbon = await adapter.resolveModel('antigravity', 'gemini-4-carbon');
  assert.equal(carbon.name, 'Gemini 4 Carbon');
  assert.deepEqual(carbon.reasoning?.efforts.map((effort) => effort.id), ['low', 'medium', 'high']);
  assert.equal(carbon.reasoning?.defaultEffort, 'high');
  assert.equal(carbon.defaultMaxTokens, 65536);

  const payload = modelOptionsPayload(await modelSettings.read(), {
    catalogModels: [{ id: 'gemini-4-carbon-high', remainingFraction: 0.72, resetTime: '2026-11-19T00:00:00Z' }],
  });
  assert.deepEqual(payload.enabledModelIds, ['gemini-4-carbon']);
  const carbonOption = payload.options.find((option) => option.id === 'gemini-4-carbon');
  assert.ok(carbonOption);
  assert.equal(carbonOption.enabled, true);
  assert.equal(carbonOption.remainingFraction, 0.72);
  assert.equal(payload.options.some((option) => option.id.startsWith('gemini-4-carbon-')), false);
});

test('Gemini 4 Carbon routes to pinned tiers with tier-mapped thinkingBudget and includeThoughts, while Argon sets thinkingLevel', async () => {
  const accountStore = {
    async read() { return { access: 'mock-token', projectId: 'mock-project', expires: Date.now() + 3600e3 }; },
    async capture() { return this; },
    async modify() { return this.read(); },
  };
  const modelSettings = {
    async read() {
      return { enabledModelIds: ['gemini-4-carbon', 'gemini-4-argon'], catalogModels: [] };
    },
  };
  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('streamGenerateContent')) sent.push(JSON.parse(init.body));
    return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    for (const [effort, expectedModel, expectedBudget] of [
      ['low', 'gemini-4-carbon-low', 2048],
      ['medium', 'gemini-4-carbon-medium', 8192],
      ['high', 'gemini-4-carbon-high', -1],
      [undefined, 'gemini-4-carbon-high', -1],
    ]) {
      sent.length = 0;
      for await (const _ of adapter.stream({
        provider: 'antigravity',
        model: 'gemini-4-carbon',
        reasoningEffort: effort,
        system: 'Be concise.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) {}
      const body = sent.at(-1);
      assert.equal(body.model, expectedModel);
      assert.deepEqual(body.request.generationConfig?.thinkingConfig, {
        thinkingBudget: expectedBudget,
        includeThoughts: true,
      });
      assert.equal(body.request.generationConfig?.maxOutputTokens, undefined);
      assert.deepEqual(body.request.systemInstruction, {
        role: 'user',
        parts: [{ text: 'Be concise.' }],
      });
    }

    sent.length = 0;
    for await (const _ of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-argon',
      reasoningEffort: 'high',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {}
    assert.deepEqual(sent.at(-1).request.generationConfig?.thinkingConfig, {
      thinkingLevel: 'HIGH',
      includeThoughts: true,
    });
    assert.equal(sent.at(-1).request.systemInstruction, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini multi-turn replay preserves thought:true, drops trailing empty chunks, and keeps user turns separate from functionResponse', async () => {
  const accountStore = {
    async read() { return { access: 'mock-token', projectId: 'mock-project', expires: Date.now() + 3600e3 }; },
    async capture() { return this; },
    async modify() { return this.read(); },
  };
  const modelSettings = {
    async read() { return { enabledModelIds: ['gemini-4-carbon'], catalogModels: [] }; },
  };
  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);
  const originalFetch = globalThis.fetch;
  let capturedBody;
  let step = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('streamGenerateContent')) {
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }
    step += 1;
    capturedBody = JSON.parse(init.body);
    if (step === 1) {
      const sse = [
        'data: {"candidates":[{"content":{"role":"model","parts":[{"thought":true,"text":"checking files"}]}}]}',
        'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"read_file","args":{"path":"a.js"},"id":"call_1"},"thoughtSignature":"c2lnXzE="}]}}]}',
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP"}]}',
        '',
      ].join('\n');
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('data: {"candidates":[{"content":{"parts":[{"text":"done"}]}}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    const firstChunks = [];
    for await (const chunk of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-carbon',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read a.js' }] }],
    })) {
      firstChunks.push(chunk);
    }
    const blockEnds = firstChunks.filter((c) => c.type === 'block-end').map((c) => c.block);
    // Trailing unsigned empty `{ text: "" }` STOP chunk must not append an empty text block.
    assert.deepEqual(blockEnds.map((b) => b.type), ['reasoning', 'tool-call']);
    const finish = firstChunks.find((c) => c.type === 'finish');

    for await (const _ of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-carbon',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Read a.js' }] },
        {
          role: 'assistant',
          content: blockEnds,
          source: {
            kind: 'model',
            provider: 'antigravity',
            model: 'gemini-4-carbon',
            replayState: finish.replayState,
          },
        },
        { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'export const x = 1;' }] },
        { role: 'user', content: [{ type: 'text', text: 'Now summarize it.' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'call_2', name: 'stat_file', arguments: '{"path":"a.js"}' }] },
        { role: 'tool', toolCallId: 'call_2', content: [{ type: 'text', text: '19 bytes' }] },
      ],
    })) {}

    assert.deepEqual(capturedBody.request.contents, [
      { role: 'user', parts: [{ text: 'Read a.js' }] },
      {
        role: 'model',
        parts: [
          { thought: true, text: 'checking files' },
          { functionCall: { name: 'read_file', args: { path: 'a.js' } }, thoughtSignature: 'c2lnXzE=' },
        ],
      },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'export const x = 1;' } } }] },
      { role: 'user', parts: [{ text: 'Now summarize it.' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'stat_file', args: { path: 'a.js' } },
            thoughtSignature: 'c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=',
          },
        ],
      },
      { role: 'user', parts: [{ functionResponse: { name: 'stat_file', response: { output: '19 bytes' } } }] },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini 4 Hydrogen resolves four reasoning tiers including xhigh, folds tier aliases, and sends dynamic thinkingBudget (-1) + includeThoughts', async () => {
  const accountStore = {
    async read() { return { access: 'mock-token', projectId: 'mock-project', expires: Date.now() + 3600e3 }; },
    async capture() { return this; },
    async modify() { return this.read(); },
  };
  const modelSettings = {
    read: async () => ({
      enabledModelIds: ['gemini-4-hydrogen-xhigh'],
      catalogModels: [
        { id: 'gemini-4-hydrogen-low', name: 'Gemini 4 Hydrogen (Low)' },
        { id: 'gemini-4-hydrogen-medium', name: 'Gemini 4 Hydrogen (Medium)' },
        { id: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
        { id: 'gemini-4-hydrogen-xhigh', name: 'Gemini 4 Hydrogen (XHigh)' },
      ],
    }),
    setCatalogModels: async () => {},
  };

  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);
  const hydrogen = await adapter.resolveModel('antigravity', 'gemini-4-hydrogen');
  assert.equal(hydrogen.name, 'Gemini 4 Hydrogen');
  assert.deepEqual(hydrogen.reasoning?.efforts.map((e) => [e.id, e.name]), [
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
    ['xhigh', 'XHigh'],
  ]);
  assert.equal(hydrogen.reasoning?.defaultEffort, 'high');
  assert.equal(hydrogen.defaultMaxTokens, 262144);

  const payload = modelOptionsPayload(await modelSettings.read(), {
    catalogModels: [{ id: 'gemini-4-hydrogen-xhigh', remainingFraction: 0.85, resetTime: '2026-11-19T00:00:00Z' }],
  });
  assert.deepEqual(payload.enabledModelIds, ['gemini-4-hydrogen']);
  const option = payload.options.find((o) => o.id === 'gemini-4-hydrogen');
  assert.ok(option);
  assert.equal(option.enabled, true);
  assert.equal(option.remainingFraction, 0.85);
  assert.equal(payload.options.some((o) => o.id.startsWith('gemini-4-hydrogen-')), false);

  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('streamGenerateContent')) sent.push(JSON.parse(init.body));
    return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    for (const [effort, expectedModel, expectedBudget] of [
      ['low', 'gemini-4-hydrogen-low', 2048],
      ['medium', 'gemini-4-hydrogen-medium', 8192],
      ['high', 'gemini-4-hydrogen-high', -1],
      ['xhigh', 'gemini-4-hydrogen-xhigh', -1],
      [undefined, 'gemini-4-hydrogen-high', -1],
    ]) {
      sent.length = 0;
      for await (const _ of adapter.stream({
        provider: 'antigravity',
        model: 'gemini-4-hydrogen',
        reasoningEffort: effort,
        maxTokens: 262144,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) {}
      const body = sent.at(-1);
      assert.equal(body.model, expectedModel, `effort=${String(effort)}`);
      assert.deepEqual(body.request.generationConfig?.thinkingConfig, {
        thinkingBudget: expectedBudget,
        includeThoughts: true,
      });
      assert.equal(body.request.generationConfig?.maxOutputTokens, undefined);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini replay keeps past reasoning and encrypted signatures across Gemini model switches, while Claude isolates signatures', async () => {
  const accountStore = {
    async read() { return { access: 'mock-token', projectId: 'mock-project', expires: Date.now() + 3600e3 }; },
    async capture() { return this; },
    async modify() { return this.read(); },
  };
  const modelSettings = {
    async read() { return { enabledModelIds: ['gemini-4-carbon', 'claude-opus-5.5'], catalogModels: [] }; },
  };
  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('streamGenerateContent')) sent.push(JSON.parse(init.body));
    return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'Analyze step 1' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'hydrogen thought' },
          { type: 'text', text: 'Step 1 done' },
        ],
        source: {
          kind: 'model',
          provider: 'antigravity',
          model: 'gemini-4-hydrogen',
          replayState: {
            kind: 'antigravity',
            version: 1,
            provider: 'antigravity',
            model: 'gemini-4-hydrogen',
            blocks: [{ type: 'reasoning' }, { type: 'text', textSignature: 'aHlkcm9fc2ln' }],
          },
        },
      },
      { role: 'user', content: [{ type: 'text', text: 'Analyze step 2' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'legacy thought with no replayState' },
          { type: 'text', text: 'Step 2 done' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Continue on Carbon' }] },
    ];

    for await (const _ of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-carbon',
      reasoningEffort: 'high',
      messages: history,
    })) {}
    assert.deepEqual(sent.at(-1).request.contents, [
      { role: 'user', parts: [{ text: 'Analyze step 1' }] },
      {
        role: 'model',
        parts: [
          { thought: true, text: 'hydrogen thought' },
          { text: 'Step 1 done', thoughtSignature: 'aHlkcm9fc2ln' },
        ],
      },
      { role: 'user', parts: [{ text: 'Analyze step 2' }] },
      {
        role: 'model',
        parts: [
          { thought: true, text: 'legacy thought with no replayState' },
          { text: 'Step 2 done' },
        ],
      },
      { role: 'user', parts: [{ text: 'Continue on Carbon' }] },
    ]);

    for await (const _ of adapter.stream({
      provider: 'antigravity',
      model: 'claude-opus-5.5',
      reasoningEffort: 'high',
      messages: history,
    })) {}
    assert.deepEqual(sent.at(-1).request.contents, [
      { role: 'user', parts: [{ text: 'Analyze step 1' }] },
      { role: 'model', parts: [{ text: 'Step 1 done' }] },
      { role: 'user', parts: [{ text: 'Analyze step 2' }] },
      { role: 'model', parts: [{ text: 'Step 2 done' }] },
      { role: 'user', parts: [{ text: 'Continue on Carbon' }] },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('system messages stay strictly in contents[0] with separate user turns even above 360k chars so sandbox systemInstruction 429 filters never fire', async () => {
  const accountStore = {
    async read() { return { access: 'mock-token', projectId: 'mock-project', expires: Date.now() + 3600e3 }; },
    async capture() { return this; },
    async modify() { return this.read(); },
  };
  const modelSettings = {
    async read() { return { enabledModelIds: ['gemini-4-carbon'], catalogModels: [] }; },
  };
  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('streamGenerateContent')) sent.push(JSON.parse(init.body));
    return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  try {
    for await (const _ of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-carbon',
      reasoningEffort: 'high',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Fix official_eval.py' }] },
        { role: 'user', content: [{ type: 'text', text: '<system-reminder>Workspace context</system-reminder>' }] },
      ],
    })) {}

    const normalReq = sent.at(-1).request;
    assert.equal(normalReq.systemInstruction, undefined);
    assert.deepEqual(normalReq.contents, [
      { role: 'user', parts: [{ text: 'You are an AI agent powered by DeepSeek Harness.' }] },
      { role: 'user', parts: [{ text: 'Fix official_eval.py' }] },
      { role: 'user', parts: [{ text: '<system-reminder>Workspace context</system-reminder>' }] },
    ]);

    // Even above 360k chars, role:"system" must NEVER be copied into systemInstruction
    // (which triggers HTTP 429 on "You are an AI agent powered by DeepSeek Harness.").
    sent.length = 0;
    for await (const _ of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-carbon',
      reasoningEffort: 'high',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.' }] },
        { role: 'user', content: [{ type: 'text', text: 'X'.repeat(370_000) }] },
      ],
    })) {}
    const hugeReq = sent.at(-1).request;
    assert.equal(hugeReq.systemInstruction, undefined);
    assert.equal(hugeReq.contents[0].parts[0].text, 'You are an AI agent powered by DeepSeek Harness.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('oversized Gemini tool chains flatten with unescaped string args while keeping normal chains, active tail, and Claude native', async () => {
  const accountStore = {
    async read() { return { access: 'mock-token', projectId: 'mock-project', expires: Date.now() + 3600e3 }; },
    async capture() { return this; },
    async modify() { return this.read(); },
  };
  const modelSettings = {
    async read() { return { enabledModelIds: ['gemini-4-carbon', 'claude-opus-5.5'], catalogModels: [] }; },
  };
  const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('streamGenerateContent')) sent.push(JSON.parse(init.body));
    return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  const bigOutA = 'A'.repeat(95_000);
  const bigOutB = 'B'.repeat(95_000);

  try {
    const historyWithCompletedBigTurn = [
      { role: 'system', content: [{ type: 'text', text: 'Agent system rules.' }] },
      // Turn 1: >180k chars across 2 tool steps -> should flatten on Gemini without JSON-escaped quotes!
      { role: 'user', content: [{ type: 'text', text: 'Inspect big files' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Reading part A' },
          {
            type: 'tool-call',
            id: 'c1',
            name: 'run_code',
            arguments: JSON.stringify({
              description: 'List benchmark directories',
              code: 'const r = await tools.bash({\n  description: "List benchmark directories"\n});',
            }),
          },
        ],
      },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: bigOutA }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Reading part B' },
          { type: 'tool-call', id: 'c2', name: 'run_code', arguments: '{"step":2}' },
        ],
      },
      { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: bigOutB }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Inspection complete.' }] },
      // Turn 2: medium completed turn (<180k chars) -> stays native FC/FR!
      { role: 'user', content: [{ type: 'text', text: 'Quick check' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c3', name: 'run_code', arguments: '{"step":3}' }] },
      { role: 'tool', toolCallId: 'c3', content: [{ type: 'text', text: 'C'.repeat(90_000) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Quick check done.' }] },
      // Turn 3: active turn with in-flight tool call -> stays native FC/FR with thoughtSignature
      { role: 'user', content: [{ type: 'text', text: 'Apply fix now' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c4', name: 'run_code', arguments: '{"step":4}' }] },
      { role: 'tool', toolCallId: 'c4', content: [{ type: 'text', text: 'patched' }] },
    ];

    for await (const _ of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-carbon',
      reasoningEffort: 'high',
      messages: historyWithCompletedBigTurn,
    })) {}

    const geminiContents = sent.at(-1).request.contents;
    // contents[0] is system, contents[1] is Turn 1 user, contents[2] is flattened Turn 1 model
    assert.equal(geminiContents[0].parts[0].text, 'Agent system rules.');
    assert.equal(geminiContents[1].parts[0].text, 'Inspect big files');
    assert.deepEqual(geminiContents[2], {
      role: 'model',
      parts: [
        { thought: true, text: 'Reading part A' },
        {
          text:
            '[Completed tool call: run_code]\n' +
            'description: List benchmark directories\n' +
            'code:\n' +
            'const r = await tools.bash({\n  description: "List benchmark directories"\n});',
        },
      ],
    });
    assert.equal(geminiContents[2].parts[1].text.includes('\\"'), false);
    assert.equal(geminiContents[3].role, 'user');
    assert.equal('functionResponse' in geminiContents[3].parts[0], false);
    assert.match(geminiContents[3].parts[0].text, /^\[Completed tool output: run_code\]\nA+$/);
    assert.equal('functionResponse' in geminiContents[5].parts[0], false);

    // Turn 2 (90k < 180k) remains native functionCall / functionResponse
    assert.deepEqual(geminiContents[8].parts[0].functionCall, { name: 'run_code', args: { step: 3 } });
    assert.equal('functionResponse' in geminiContents[9].parts[0], true);

    // Turn 3 (active) remains native functionCall / functionResponse with fallback thoughtSignature
    assert.deepEqual(geminiContents[12].parts[0], {
      functionCall: { name: 'run_code', args: { step: 4 } },
      thoughtSignature: 'c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=',
    });
    assert.deepEqual(geminiContents[13].parts[0].functionResponse, {
      name: 'run_code',
      response: { output: 'patched' },
    });

    // Claude keeps all turns as native functionCall / functionResponse
    sent.length = 0;
    for await (const _ of adapter.stream({
      provider: 'antigravity',
      model: 'claude-opus-5.5',
      messages: historyWithCompletedBigTurn,
    })) {}
    const claudeContents = sent.at(-1).request.contents;
    assert.equal('functionCall' in claudeContents[2].parts[0], true);
    assert.equal('functionResponse' in claudeContents[3].parts[0], true);

    // Marathon active Gemini turn (>320k chars) flattens older steps while preserving native tail
    const marathonMsgs = [{ role: 'user', content: [{ type: 'text', text: 'Start marathon' }] }];
    for (let k = 1; k <= 8; k++) {
      marathonMsgs.push({
        role: 'assistant',
        content: [{ type: 'tool-call', id: `m_${k}`, name: 'run_code', arguments: JSON.stringify({ k }) }],
      });
      marathonMsgs.push({
        role: 'tool',
        toolCallId: `m_${k}`,
        content: [{ type: 'text', text: String(k).repeat(50_000) }],
      });
    }
    sent.length = 0;
    for await (const _ of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-carbon',
      messages: marathonMsgs,
    })) {}
    const marathonContents = sent.at(-1).request.contents;
    assert.equal('functionCall' in marathonContents[1].parts[0], false);
    assert.equal('functionResponse' in marathonContents[2].parts[0], false);
    const tailModel = marathonContents.at(-2);
    const tailTool = marathonContents.at(-1);
    assert.equal('functionCall' in tailModel.parts[0], true);
    assert.equal(tailModel.parts[0].thoughtSignature, 'c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=');
    assert.equal('functionResponse' in tailTool.parts[0], true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sandbox endpoint is preferred first, 503 fails fast as SERVER over secondary 404, and streamIdleTimeoutMs aborts hung streams', async () => {
  const accountStore = {
    async read() { return { access: 'mock-token', projectId: 'mock-project', expires: Date.now() + 3600e3 }; },
    async capture() { return this; },
    async modify() { return this.read(); },
  };
  const modelSettings = {
    async read() { return { enabledModelIds: ['gemini-4-carbon'], catalogModels: [] }; },
  };
  const originalFetch = globalThis.fetch;
  const calledHosts = [];

  try {
    // 1. Sandbox endpoint succeeds on first try without hitting cloudcode-pa.googleapis.com
    globalThis.fetch = async (url) => {
      calledHosts.push(new URL(String(url)).host);
      return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    const adapter = new AntigravityAdapter(accountStore, modelSettings, () => undefined);
    for await (const _ of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-4-carbon',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {}
    assert.deepEqual(calledHosts, ['daily-cloudcode-pa.sandbox.googleapis.com']);

    // 2. Sandbox 503 + secondary 404 fails fast (<1s, no 60s sleep) and preserves code="SERVER"
    calledHosts.length = 0;
    globalThis.fetch = async (url) => {
      const host = new URL(String(url)).host;
      calledHosts.push(host);
      if (host.includes('sandbox')) {
        return new Response('{"error":{"code":503,"message":"Model is at capacity"}}', { status: 503 });
      }
      return new Response('{"error":{"code":404,"message":"Requested entity was not found"}}', { status: 404 });
    };
    const t0 = Date.now();
    await assert.rejects(
      async () => {
        for await (const _ of adapter.stream({
          provider: 'antigravity',
          model: 'gemini-4-carbon',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })) {}
      },
      (err) => {
        assert.equal(err.code, 'SERVER');
        assert.match(err.message, /503/);
        assert.ok(Date.now() - t0 < 2000, 'must fail fast without sleeping 60s');
        return true;
      },
    );
    assert.deepEqual(calledHosts, ['daily-cloudcode-pa.sandbox.googleapis.com', 'cloudcode-pa.googleapis.com']);

    // 3. Hung stream aborts cleanly with code="TIMEOUT" at configured streamIdleTimeoutMs
    globalThis.fetch = async (_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
    const fastTimeoutAdapter = new AntigravityAdapter(
      accountStore,
      modelSettings,
      () => undefined,
      undefined,
      { streamIdleTimeoutMs: 1000 },
    );
    const t1 = Date.now();
    await assert.rejects(
      async () => {
        for await (const _ of fastTimeoutAdapter.stream({
          provider: 'antigravity',
          model: 'gemini-4-carbon',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })) {}
      },
      (err) => {
        assert.equal(err.code, 'TIMEOUT');
        assert.match(err.message, /idle timeout after 1000ms/);
        const elapsed = Date.now() - t1;
        assert.ok(elapsed >= 900 && elapsed < 3000, `expected ~1s timeout, got ${elapsed}ms`);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
