import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function extractIndicatorHelpers() {
  const start = source.indexOf('    function isAntigravityModel(');
  const end = source.indexOf('    function AntigravityQuotaIndicator(', start);
  assert.ok(start > 0 && end > start, 'helpers not found in client.js');

  const context = {
    quotaGroupsOf: (quota) => {
      if (!quota) return [];
      if (Array.isArray(quota.groups) && quota.groups.length > 0) {
        return quota.groups.filter((g) => Array.isArray(g && g.buckets) && g.buckets.length > 0);
      }
      return [];
    },
    quotaRowsOf: (quota, groups) => {
      if (groups.length > 0 || !quota || !Array.isArray(quota.modelRows)) return [];
      return quota.modelRows.filter((r) => typeof r.remainingFraction === 'number');
    },
    percentOf: (row) => {
      if (typeof row.remainingFraction === 'number' && Number.isFinite(row.remainingFraction)) {
        return Math.round(row.remainingFraction * 10000) / 100;
      }
      if (typeof row.remainingPercent === 'number' && Number.isFinite(row.remainingPercent)) {
        return row.remainingPercent;
      }
      return undefined;
    },
    Boolean,
    String,
    Math,
    Number,
    Array,
  };

  return vm.runInNewContext(
    source.slice(start, end) + '\n({ isAntigravityModel, boundedQuotaPercent, quotaProgressColor, bucketShortLabel, matchBucketsForModel })',
    context
  );
}

test('isAntigravityModel validates active provider and model readiness', () => {
  const { isAntigravityModel } = extractIndicatorHelpers();

  assert.equal(isAntigravityModel({
    status: 'ready',
    current: { provider: 'antigravity', model: 'gemini-3.7-flash' }
  }), true);

  assert.equal(isAntigravityModel({
    status: 'ready',
    current: { provider: 'antigravity', model: 'claude-sonnet-4-6' }
  }), true);

  // Other providers or non-ready states must return false
  assert.equal(isAntigravityModel({
    status: 'ready',
    current: { provider: 'openai-codex', model: 'gpt-5' }
  }), false);

  assert.equal(isAntigravityModel({
    status: 'loading',
    current: { provider: 'antigravity', model: 'gemini-3.7-flash' }
  }), false);

  assert.equal(isAntigravityModel(undefined), false);
});

test('quotaProgressColor maps percentage thresholds accurately', () => {
  const { quotaProgressColor } = extractIndicatorHelpers();

  assert.equal(quotaProgressColor(100).name, 'green');
  assert.equal(quotaProgressColor(60).name, 'green');
  assert.equal(quotaProgressColor(59.9).name, 'yellow');
  assert.equal(quotaProgressColor(40).name, 'yellow');
  assert.equal(quotaProgressColor(39.9).name, 'orange');
  assert.equal(quotaProgressColor(20).name, 'orange');
  assert.equal(quotaProgressColor(19.9).name, 'red');
  assert.equal(quotaProgressColor(0).name, 'red');
});

test('bucketShortLabel formats standard window identifiers', () => {
  const { bucketShortLabel } = extractIndicatorHelpers();

  assert.equal(bucketShortLabel({ bucketId: 'gemini-5h', displayName: 'Five Hour Limit' }), '5h');
  assert.equal(bucketShortLabel({ bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining' }), '5h');
  assert.equal(bucketShortLabel({ bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining' }), '7d');
  assert.equal(bucketShortLabel({ bucketId: 'daily-cap', window: '24h' }), '24h');
  assert.equal(bucketShortLabel({ bucketId: 'custom-quota', displayName: 'Custom' }), 'Cus');
});

test('matchBucketsForModel routes Gemini and 3P models to proper quota groups', () => {
  const { matchBucketsForModel } = extractIndicatorHelpers();

  const mockQuota = {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'gemini-5h', displayName: 'Five Hour Limit', remainingFraction: 0.85, resetTime: '2026-09-15T22:00:00Z' }
        ]
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 1, resetTime: '2026-09-17T16:15:25Z', disabled: true, description: 'Weekly limit reached' },
          { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.35, resetTime: '2026-09-22T00:00:00Z' }
        ]
      }
    ]
  };

  // Gemini model selection
  const geminiBuckets = matchBucketsForModel(mockQuota, 'gemini-3.7-flash');
  assert.equal(geminiBuckets.length, 1);
  assert.equal(geminiBuckets[0].bucketId, 'gemini-5h');

  // Claude 3P model selection
  const claudeBuckets = matchBucketsForModel(mockQuota, 'antigravity/claude-sonnet-4-6');
  assert.equal(claudeBuckets.length, 2);
  assert.equal(claudeBuckets[0].bucketId, '3p-5h');
  assert.equal(claudeBuckets[0].disabled, true);
  assert.equal(claudeBuckets[1].bucketId, '3p-weekly');

  // GPT 3P model selection
  const gptBuckets = matchBucketsForModel(mockQuota, 'gpt-oss-120b');
  assert.equal(gptBuckets.length, 2);
  assert.equal(gptBuckets[0].bucketId, '3p-5h');
});

test('slot registration registers conversation.input.right at order 20', () => {
  const registrations = [];
  const fakeScope = {
    slots: {
      inject: (name, cb) => cb(),
      register: (meta, component) => {
        registrations.push({ meta, component });
      }
    },
    modelDirectories: {
      directoryFor: (sessionId) => ({ store: { sessionId } })
    }
  };

  const fakeCtx = {
    inject: (deps, cb) => {
      if (deps.includes('modelDirectories')) cb(fakeScope);
    },
    slots: {
      inject: () => {},
      register: () => {}
    },
    effect: () => {},
    locale: { register: () => {} }
  };

  // Find apply(ctx) body
  const start = source.indexOf('      apply(ctx) {');
  const end = source.lastIndexOf('      },');
  const applyFn = vm.runInNewContext(
    `(function(ctx) {${source.slice(start + 18, end)}})`,
    {
      installStyle: () => {},
      initNavObserver: () => {},
      NS: 'dsh-antigravity',
      zh: {},
      en: {},
      createTranslator: () => (k) => k,
      AntigravitySettings: () => null,
      AntigravityQuotaIndicator: () => null,
      React: { createElement: () => null }
    }
  );

  applyFn(fakeCtx);

  const quotaSlot = registrations.find(r => r.meta.name === 'conversation.input.right' && r.meta.id === 'antigravity-quota');
  assert.ok(quotaSlot, 'antigravity-quota slot must be registered');
  assert.equal(quotaSlot.meta.order, 20);
  assert.equal(quotaSlot.meta.inject('session-123').directory.sessionId, 'session-123');
});
