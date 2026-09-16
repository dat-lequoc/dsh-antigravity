import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

test('reset countdown prefers absolute timestamp over cached label', () => {
  const start = source.indexOf('    function resetText(');
  const end = source.indexOf('    function percentOf(', start);
  const resetText = vm.runInNewContext(source.slice(start, end) + '\nresetText', { formatReset: () => '2h 56m' });
  assert.equal(resetText({ resetTime: '2026-09-16T15:00:00Z', resetLabel: '5h 0m' }), 'Reset: 2h 56m');
  assert.equal(resetText({ resetLabel: '5h 0m' }), 'Reset: 5h 0m');
});

test('visible settings refresh on re-entry and every minute, with cleanup', async () => {
  const start = source.indexOf('      // Settings can remain mounted');
  const end = source.indexOf('      const flow = status.login;', start);
  let cleanup, tick, visible = true, now = 100000, requests = 0;
  const listeners = new Map();
  const target = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  vm.runInNewContext(source.slice(start, end), {
    useEffect: fn => { cleanup = fn(); },
    panelRef: { current: { getClientRects: () => visible ? [1] : [] } },
    getComputedStyle: () => ({ visibility: 'visible' }),
    document: { ...target, visibilityState: 'visible' },
    window: { ...target, setInterval: fn => { tick = fn; return 1; }, clearInterval: () => {} },
    Date: { now: () => now }, mutationLock: { current: false },
    stateRef: { current: { accounts: [{ id: 'a' }, { id: 'b' }] } },
    refreshStatus: async () => {}, refreshQuota: async () => { requests++; },
    live: { current: true }, setError: () => {}, trRef: { current: x => x },
  });
  await tick(); assert.equal(requests, 2);
  await tick(); assert.equal(requests, 2);
  now += 60000; await tick(); assert.equal(requests, 4);
  visible = false; await tick();
  visible = true; await tick(); assert.equal(requests, 6);
  cleanup(); assert.equal(listeners.size, 0);
});
