import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function extractFunctionBody(marker, endMarker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing source marker: ${marker}`);
  const bodyStart = start + marker.length;
  const end = source.indexOf(endMarker, bodyStart);
  assert.notEqual(end, -1, `missing source end marker: ${endMarker}`);
  return source.slice(bodyStart, end);
}

test('reset countdown prefers absolute timestamp over cached label', () => {
  const start = source.indexOf('    function resetText(');
  const end = source.indexOf('    function percentOf(', start);
  const resetText = vm.runInNewContext(source.slice(start, end) + '\nresetText', { formatReset: () => '2h 56m' });
  assert.equal(resetText({ resetTime: '2026-09-16T15:00:00Z', resetLabel: '5h 0m' }), 'Refreshes in 2h 56m');
  assert.equal(resetText({ resetLabel: '5h 0m' }), 'Refreshes in 5h 0m');
});

test('reset formatter handles numeric epochs and never reports 0m for future times', () => {
  const start = source.indexOf('    function formatReset(');
  const end = source.indexOf('    function resetText(', start);
  const formatReset = vm.runInNewContext(source.slice(start, end) + '\nformatReset', {
    Date: class extends Date {
      static now() { return 1_000_000_000_000; }
    },
  });
  assert.equal(formatReset(1_000_000_010_000), '1m');
  assert.equal(formatReset(1_000_000_000_000), 'now');
  assert.equal(formatReset('not-a-date'), 'not-a-date');
});

test('percentage rendering keeps precise and rounded values safe', () => {
  const start = source.indexOf('    function percentOf(');
  const end = source.indexOf('    function QuotaRow(', start);
  const helpers = vm.runInNewContext(source.slice(start, end) + '\n({ percentOf, percentText })');
  assert.equal(helpers.percentOf({ remainingFraction: 0.637 }), 63.7);
  assert.equal(helpers.percentText(63.7), '63.7');
  assert.equal(helpers.percentText(undefined), '?');
});

test('status revision changes fence old work while preserving account identity', () => {
  const body = extractFunctionBody('      const applyStatus = useCallback((value) => {', '      }, [commitQuota]);');
  const generation = { current: 0 };
  const calls = { cleared: 0, model: 'keep', status: null };
  const applyStatus = vm.runInNewContext(`(value) => {${body}}`, {
    live: { current: true },
    stateRef: { current: { activeAccountId: 'a', revision: 4, accounts: [{ id: 'a' }] } },
    quotaGeneration: generation,
    quotaRequestSeq: { current: { clear: () => { calls.cleared++; } } },
    modelSeq: { current: 0 },
    commitQuota: () => false,
    setModelConfig: value => { calls.model = value; },
    setStatus: value => { calls.status = value; },
    setQuotaStateByAccount: () => {},
    setLoginLink: () => {},
    calls,
  });
  assert.equal(applyStatus({ revision: 5, activeAccountId: 'a', accounts: [{ id: 'a' }] }), true);
  assert.equal(calls.cleared, 1);
  assert.equal(generation.current, 1);
  assert.equal(calls.model, undefined);
  assert.equal(calls.status.revision, 5);
});

test('status quota is accepted only for active account with valid timestamp', () => {
  const body = extractFunctionBody('      const applyStatus = useCallback((value) => {', '      }, [commitQuota]);');
  let committed = 0;
  const applyStatus = vm.runInNewContext(`(value) => {${body}}`, {
    live: { current: true },
    stateRef: { current: { activeAccountId: 'a', revision: 1, accounts: [{ id: 'a' }, { id: 'b' }] } },
    quotaGeneration: { current: 0 }, quotaRequestSeq: { current: { clear() {} } }, modelSeq: { current: 0 },
    commitQuota: () => { committed++; return true; },
    setModelConfig: () => {}, setStatus: () => {}, setQuotaStateByAccount: () => {}, setLoginLink: () => {},
  });
  applyStatus({ revision: 1, activeAccountId: 'a', accounts: [{ id: 'a' }, { id: 'b' }], quota: { accountId: 'b', fetchedAt: 100 } });
  applyStatus({ revision: 1, activeAccountId: 'a', accounts: [{ id: 'a' }], quota: { accountId: 'a' } });
  assert.equal(committed, 0);
});

test('visible settings refresh on re-entry and every minute, with cleanup', async () => {
  const start = source.indexOf('      // Settings can remain mounted');
  const end = source.indexOf('      const flow = status.login;', start);
  let cleanup, tick, visible = true, now = 100000, batches = 0;
  const listeners = new Map();
  const target = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  vm.runInNewContext(source.slice(start, end), {
    useEffect: fn => { cleanup = fn(); },
    panelRef: { current: { getClientRects: () => visible ? [1] : [] } },
    getComputedStyle: () => ({ visibility: 'visible' }),
    document: { ...target, visibilityState: 'visible' },
    window: { ...target, setInterval: fn => { tick = fn; return 1; }, clearInterval: () => {} },
    Date: { now: () => now }, mutationLock: { current: false },
    runQuotaBatch: async () => { batches++; return true; },
    live: { current: true }, setError: () => {}, trRef: { current: x => x },
  });
  await tick(); assert.equal(batches, 1);
  await tick(); assert.equal(batches, 1);
  now += 60000; await tick(); assert.equal(batches, 2);
  visible = false; await tick();
  visible = true; await tick(); assert.equal(batches, 3);
  cleanup(); assert.equal(listeners.size, 0);
});

test('quota rows never overwrite newer data with an older response', () => {
  assert.match(source, /previous\.fetchedAt >= fetchedAt/);
  assert.match(source, /quotaGeneration\.current === generation/);
});

test('batch callers are coalesced and queued work is awaited', () => {
  assert.match(source, /quotaBatchPromise\.current = operation/);
  assert.match(source, /return quotaBatchPromise\.current \|\| Promise\.resolve\(false\)/);
  assert.match(source, /queuedQuotaBatch\.current/);
});

function renderQuotaRow(row) {
  const start = source.indexOf('    function formatReset(');
  const end = source.indexOf('    function QuotaGroup(', start);
  assert.ok(start > 0 && end > start, 'quota row helpers not found in client source');
  const createElement = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
  const React = { createElement };
  const helpers = vm.runInNewContext(source.slice(start, end) + '\n({ QuotaRow })', {
    React, createElement, Date, Number, String, Math, Object, Array, isNaN, parseInt,
  });
  const t = (key, params = {}) => {
    const texts = {
      resetPrefix: 'Refreshes in {time}', resetUnavailable: 'Refresh time unavailable',
      resetNow: 'now', resetNowLabel: 'Refreshes now', remainingLabel: '{percent}% remaining',
      notApplicable: 'N/A', notEnforced: 'Not currently enforced',
    };
    return Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), texts[key] || key);
  };
  const tree = helpers.QuotaRow({ row, accent: 'cyan', t });
  const classes = [];
  const texts = [];
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === 'object') {
      if (node.props.className) classes.push(String(node.props.className));
      walk(node.children);
      return;
    }
    texts.push(String(node));
  };
  walk(tree);
  return { classes, text: texts.join(' ') };
}

test('a non-enforced window renders as N/A instead of a live 100% bar', () => {
  const disabled = renderQuotaRow({
    label: 'Five Hour Limit Remaining', remainingFraction: 1, disabled: true,
    description: 'You have hit your weekly limit, the 5-hour limit does not currently apply.',
  });
  assert.match(disabled.text, /N\/A/);
  assert.match(disabled.text, /Not currently enforced/);
  assert.match(disabled.text, /does not currently apply/);
  assert.ok(!disabled.classes.some((c) => c.includes('dsha-bar')), 'disabled window must not draw a progress bar');

  const live = renderQuotaRow({ label: 'Weekly Limit Remaining', remainingFraction: 0.105135344 });
  assert.match(live.text, /10.51%/);
  assert.match(live.text, /10% remaining/);
  assert.ok(live.classes.some((c) => c.includes('dsha-bar')), 'live window must draw a progress bar');
  assert.ok(!live.classes.some((c) => c.includes('dsha-row-off')));
});
