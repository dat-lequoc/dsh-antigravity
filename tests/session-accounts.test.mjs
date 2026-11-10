// Session pins are the only per-session auth state the plugin keeps. A pin must
// never fail a request: malformed rows, unknown reasons, expired records, and
// even a corrupt document all resolve to "follow the active account".

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSessionAccountStore,
  MAX_SESSION_ACCOUNTS,
  SESSION_ACCOUNT_RETENTION_MS,
  normalizeSessionAccounts,
} from '../lib/session-accounts.js';

async function tempFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'antigravity-sessions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'antigravity-sessions.json');
}

test('normalization drops malformed rows and defaults the reason', () => {
  const now = 1_700_000_000_000;
  const normalized = normalizeSessionAccounts({
    sessions: {
      'session-a': { accountId: 'acct-1', reason: 'pinned', updatedAt: now - 1000 },
      'session-b': { accountId: ' acct-2 ', reason: 'failover', updatedAt: now - 2000 },
      'session-c': { accountId: 'acct-3', reason: 'nonsense', updatedAt: now - 3000 },
      'session-d': { accountId: '', updatedAt: now },
      'session-e': null,
      'session-f': { accountId: 'acct-4', updatedAt: now - SESSION_ACCOUNT_RETENTION_MS - 1 },
      '': { accountId: 'acct-5', updatedAt: now },
    },
  }, now);

  assert.deepEqual(normalized.sessions['session-a'], { accountId: 'acct-1', reason: 'pinned', updatedAt: now - 1000 });
  assert.equal(normalized.sessions['session-b'].accountId, 'acct-2');
  assert.equal(normalized.sessions['session-c'].reason, 'pinned');
  assert.equal(normalized.sessions['session-d'], undefined);
  assert.equal(normalized.sessions['session-e'], undefined);
  // Older than the retention window: a resumed session starts from the active account.
  assert.equal(normalized.sessions['session-f'], undefined);
  assert.equal(normalized.sessions[''], undefined);
});

test('normalization keeps the newest records and ignores prototype keys', () => {
  const now = 1_700_000_000_000;
  const sessions = Object.fromEntries(
    Array.from({ length: MAX_SESSION_ACCOUNTS + 25 }, (_, index) => [
      `session-${index}`,
      { accountId: `acct-${index}`, updatedAt: now - index },
    ]),
  );
  const parsed = JSON.parse(JSON.stringify({ sessions }));
  parsed.sessions.__proto__ = { accountId: 'acct-bad', updatedAt: now };
  parsed.sessions.constructor = { accountId: 'acct-bad', updatedAt: now };

  const normalized = normalizeSessionAccounts(parsed, now);
  assert.equal(Object.keys(normalized.sessions).length, MAX_SESSION_ACCOUNTS);
  assert.equal(normalized.sessions['session-0'].accountId, 'acct-0');
  assert.equal(normalized.sessions['session-499'].accountId, 'acct-499');
  assert.equal(normalized.sessions['session-500'], undefined);
  assert.equal(Object.getPrototypeOf(normalized.sessions), Object.prototype);
});

test('a pin round-trips through the document and survives a reload', async (t) => {
  const file = await tempFile(t);
  const store = new FileSessionAccountStore(file);
  await store.ready();
  assert.equal(store.get('session-a'), undefined);

  await store.pin('session-a', 'acct-1');
  await store.pin('session-b', 'acct-2', 'failover');

  const document = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(document.sessions['session-a'].accountId, 'acct-1');
  assert.equal(document.sessions['session-a'].reason, 'pinned');
  assert.equal(document.sessions['session-b'].reason, 'failover');
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }

  const reloaded = new FileSessionAccountStore(file);
  await reloaded.ready();
  assert.equal(reloaded.get('session-a').accountId, 'acct-1');
  assert.equal(reloaded.get('session-b').accountId, 'acct-2');
  assert.equal(reloaded.get('session-b').reason, 'failover');

  await reloaded.clear('session-a');
  assert.equal(reloaded.get('session-a'), undefined);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.sessions['session-a'], undefined);
  assert.equal(after.sessions['session-b'].accountId, 'acct-2');
});

test('a corrupt document reads as empty and still accepts a pin', async (t) => {
  const file = await tempFile(t);
  await writeFile(file, '{ not json', 'utf8');
  const store = new FileSessionAccountStore(file);
  await store.ready();
  assert.equal(store.get('session-a'), undefined);

  await store.pin('session-a', 'acct-1');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).sessions['session-a'].accountId, 'acct-1');
});

test('pinning validates its arguments', async (t) => {
  const store = new FileSessionAccountStore(await tempFile(t));
  await store.ready();
  await assert.rejects(() => store.pin('', 'acct-1'), /session id/);
  await assert.rejects(() => store.pin('session-a', ''), /account id/);
});
