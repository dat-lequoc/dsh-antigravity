// `/antigravity-account` is the only surface that writes a session pin. It must
// resolve human references without ambiguity, refuse accounts that cannot work,
// and leave the plugin-wide active account alone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAccounts, findAccount, runAccountCommand } from '../lib/account-command.js';

const accounts = [
  { id: 'acct-a', email: 'a@example.com', label: 'bop', authState: 'ready' },
  { id: 'acct-b', email: 'b@example.com', authState: 'ready' },
  { id: 'acct-c', email: 'c@example.com', authState: 'needs-sign-in' },
];

function fakeStore(activeAccountId = 'acct-a') {
  return { summaries: async () => ({ revision: 1, activeAccountId, accounts }) };
}

function fakeSessions(initial = {}) {
  const records = new Map(Object.entries(initial));
  return {
    records,
    get: (sessionId) => records.get(sessionId),
    pin: async (sessionId, accountId, reason = 'pinned') => {
      records.set(sessionId, { accountId, reason });
    },
    clear: async (sessionId) => {
      records.delete(sessionId);
    },
  };
}

test('account references resolve by row number, id, email, label, and unique prefix', () => {
  assert.equal(findAccount(accounts, '#2').id, 'acct-b');
  assert.equal(findAccount(accounts, '2').id, 'acct-b');
  assert.equal(findAccount(accounts, 'acct-a').id, 'acct-a');
  assert.equal(findAccount(accounts, 'A@EXAMPLE.COM').id, 'acct-a');
  assert.equal(findAccount(accounts, 'bop').id, 'acct-a');
  assert.equal(findAccount(accounts, 'b@').id, 'acct-b');
  // Ambiguous prefix, out-of-range row, and empty input match nothing.
  assert.equal(findAccount(accounts, 'acct-'), undefined);
  assert.equal(findAccount(accounts, '#9'), undefined);
  assert.equal(findAccount(accounts, '0'), undefined);
  assert.equal(findAccount(accounts, '   '), undefined);
});

test('the listing marks the active account and this session pin', () => {
  const text = describeAccounts(accounts, 'acct-a', { accountId: 'acct-b', reason: 'pinned' });
  assert.match(text, /1\. bop — a@example\.com — active/);
  assert.match(text, /2\. b@example\.com — this session/);
  assert.match(text, /3\. c@example\.com \(needs-sign-in\)/);
  assert.match(text, /This session uses #2\./);
  assert.match(text, /Send \/antigravity-account/);
});

test('the listing explains a failover pin and an unpinned session', () => {
  assert.match(
    describeAccounts(accounts, 'acct-a', { accountId: 'acct-b', reason: 'failover' }),
    /this session, after failover/,
  );
  assert.match(describeAccounts(accounts, 'acct-a', undefined), /This session follows the active account\./);
  assert.match(describeAccounts([], 'acct-a', undefined), /No Antigravity accounts are signed in/);
});

test('no input lists accounts instead of changing anything', async () => {
  const sessionAccounts = fakeSessions();
  const result = await runAccountCommand({ store: fakeStore(), sessionAccounts, sessionId: 'session-1', rawInput: '' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /Antigravity accounts:/);
  assert.equal(sessionAccounts.records.size, 0);
});

test('a pin is written for this session only', async () => {
  const sessionAccounts = fakeSessions();
  const result = await runAccountCommand({ store: fakeStore(), sessionAccounts, sessionId: 'session-1', rawInput: '#2' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /This session now uses b@example\.com\./);
  assert.deepEqual(sessionAccounts.get('session-1'), { accountId: 'acct-b', reason: 'pinned' });
  // The plugin-wide active account is untouched: other sessions keep using it.
  assert.equal(sessionAccounts.get('session-2'), undefined);
});

test('an email resolves the same way as a row number', async () => {
  const sessionAccounts = fakeSessions();
  const result = await runAccountCommand({ store: fakeStore(), sessionAccounts, sessionId: 'session-1', rawInput: 'b@example.com' });
  assert.equal(result.kind, 'success');
  assert.equal(sessionAccounts.get('session-1').accountId, 'acct-b');
});

test('active clears the pin', async () => {
  const sessionAccounts = fakeSessions({ 'session-1': { accountId: 'acct-b', reason: 'pinned' } });
  const result = await runAccountCommand({ store: fakeStore(), sessionAccounts, sessionId: 'session-1', rawInput: 'active' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /follows the active account \(bop — a@example\.com\)/);
  assert.equal(sessionAccounts.get('session-1'), undefined);
});

test('an unknown reference fails without writing a pin', async () => {
  const sessionAccounts = fakeSessions();
  const result = await runAccountCommand({ store: fakeStore(), sessionAccounts, sessionId: 'session-1', rawInput: 'zzz' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /No Antigravity account matches "zzz"/);
  assert.equal(sessionAccounts.records.size, 0);
});

test('an account that is not signed in is refused', async () => {
  const sessionAccounts = fakeSessions();
  const result = await runAccountCommand({ store: fakeStore(), sessionAccounts, sessionId: 'session-1', rawInput: 'acct-c' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /not signed in \(needs-sign-in\)/);
  assert.equal(sessionAccounts.records.size, 0);
});
