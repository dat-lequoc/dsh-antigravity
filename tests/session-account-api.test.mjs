// The picker endpoint is the only UI path that writes a session pin, so it must
// validate the account, refuse a not-signed-in one, and keep "follow active" as
// a real absence of a pin rather than a special value.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinnedAccountOf, sessionAccountView, updateSessionAccount } from '../lib/index.js';
import { FileSessionAccountStore } from '../lib/session-accounts.js';

const accounts = [
  { id: 'acct-a', email: 'a@example.com', label: 'bop', authState: 'ready' },
  { id: 'acct-b', email: 'b@example.com', authState: 'ready' },
  { id: 'acct-c', email: 'c@example.com', authState: 'needs-sign-in' },
  // Access token expired, refresh token present: still usable on the next request.
  { id: 'acct-d', email: 'd@example.com', authState: 'refresh-required' },
];

async function fixture(t, { active = 'acct-a' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'antigravity-picker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionAccounts = new FileSessionAccountStore(join(directory, 'antigravity-sessions.json'));
  await sessionAccounts.ready();
  const credentialStore = { summaries: async () => ({ revision: 1, activeAccountId: active, accounts }) };
  return { sessionAccounts, credentialStore };
}

test('the view exposes accounts, the active account, and no pin by default', async (t) => {
  const { sessionAccounts, credentialStore } = await fixture(t);
  const view = await sessionAccountView(sessionAccounts, credentialStore, 'session-1');
  assert.equal(view.activeAccountId, 'acct-a');
  assert.deepEqual(view.accounts.map((account) => account.id), ['acct-a', 'acct-b', 'acct-c', 'acct-d']);
  assert.equal(view.pin, null);
});

test('choosing an account pins only that session and the view reflects it', async (t) => {
  const { sessionAccounts, credentialStore } = await fixture(t);
  assert.deepEqual(await updateSessionAccount(sessionAccounts, credentialStore, 'session-1', 'acct-b'), { ok: true });

  const pinned = await sessionAccountView(sessionAccounts, credentialStore, 'session-1');
  assert.equal(pinned.pin.accountId, 'acct-b');
  assert.equal(pinned.pin.reason, 'pinned');
  assert.equal(pinned.activeAccountId, 'acct-a', 'the profile-wide active account is untouched');

  const other = await sessionAccountView(sessionAccounts, credentialStore, 'session-2');
  assert.equal(other.pin, null);
});

test('a null choice clears the pin back to the active account', async (t) => {
  const { sessionAccounts, credentialStore } = await fixture(t);
  await updateSessionAccount(sessionAccounts, credentialStore, 'session-1', 'acct-b');
  assert.deepEqual(await updateSessionAccount(sessionAccounts, credentialStore, 'session-1', null), { ok: true });
  assert.equal((await sessionAccountView(sessionAccounts, credentialStore, 'session-1')).pin, null);
});

test('an unknown account is rejected without writing anything', async (t) => {
  const { sessionAccounts, credentialStore } = await fixture(t);
  assert.deepEqual(
    await updateSessionAccount(sessionAccounts, credentialStore, 'session-1', 'acct-missing'),
    { ok: false, error: 'account-not-found' },
  );
  assert.equal((await sessionAccountView(sessionAccounts, credentialStore, 'session-1')).pin, null);
});

test('an account that is not signed in cannot be chosen', async (t) => {
  const { sessionAccounts, credentialStore } = await fixture(t);
  assert.deepEqual(
    await updateSessionAccount(sessionAccounts, credentialStore, 'session-1', 'acct-c'),
    { ok: false, error: 'account-not-signed-in' },
  );
  assert.equal((await sessionAccountView(sessionAccounts, credentialStore, 'session-1')).pin, null);
});

test('an account whose access token expired can still be chosen', async (t) => {
  // The settings page has always treated refresh-required as ready; the picker
  // must agree, or every account whose token expired looks signed out.
  const { sessionAccounts, credentialStore } = await fixture(t);
  assert.deepEqual(await updateSessionAccount(sessionAccounts, credentialStore, 'session-1', 'acct-d'), { ok: true });
  const view = await sessionAccountView(sessionAccounts, credentialStore, 'session-1');
  assert.equal(view.pin.accountId, 'acct-d');
});

test('a missing session id is refused', async (t) => {
  const { sessionAccounts, credentialStore } = await fixture(t);
  assert.deepEqual(await updateSessionAccount(sessionAccounts, credentialStore, '', 'acct-b'), { ok: false, error: 'missing-session' });
  assert.deepEqual(await updateSessionAccount(sessionAccounts, credentialStore, undefined, 'acct-b'), { ok: false, error: 'missing-session' });
});

test('a pin resolves only while its account still exists', () => {
  assert.equal(pinnedAccountOf({ pin: { accountId: 'acct-a' }, accounts: [{ id: 'acct-a' }] }), 'acct-a');
  assert.equal(pinnedAccountOf({ pin: { accountId: 'acct-gone' }, accounts: [{ id: 'acct-a' }] }), undefined);
  assert.equal(pinnedAccountOf({ pin: null, accounts: [{ id: 'acct-a' }] }), undefined);
  assert.equal(pinnedAccountOf({ accounts: [{ id: 'acct-a' }] }), undefined);
  assert.equal(pinnedAccountOf(undefined), undefined);
});
