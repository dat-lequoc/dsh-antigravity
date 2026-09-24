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
});
