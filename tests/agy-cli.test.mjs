import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyCliIdentity, agyCliStatus, agyCliTokenPath, writeAgyCliDocument } from '../lib/agy-cli.js';

const creds = (overrides = {}) => ({ access: 'access-b', refresh: 'refresh-b', expires: Date.now() + 3_600_000, email: 'b@example.test', ...overrides });
async function fixture(t, { withSession } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'agy-cli-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, 'antigravity-cli', 'antigravity-oauth-token');
  await fs.mkdir(join(root, 'antigravity-cli'), { recursive: true });
  if (withSession) await fs.writeFile(path, JSON.stringify(withSession), { mode: 0o600 });
  return { root, path };
}
const jwt = (payload) => ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.');
async function list(dir) { return (await fs.readdir(dir)).sort(); }

test('token path follows AGY_TOKEN_FILE, then AGY_HOME, then the CLI default', () => {
  assert.equal(agyCliTokenPath({ AGY_TOKEN_FILE: '/tmp/token.json', AGY_HOME: '/tmp/home' }), '/tmp/token.json');
  assert.equal(agyCliTokenPath({ AGY_HOME: '/tmp/home' }), '/tmp/home/antigravity-oauth-token');
  assert.equal(agyCliTokenPath({ HOME: '/home/test' }), '/home/test/.gemini/antigravity-cli/antigravity-oauth-token');
});

test('writes the CLI session document with owner-only permissions and no leftovers', async t => {
  const { path } = await fixture(t);
  const now = Date.now();
  const written = writeAgyCliDocument(creds({ expires: now + 1_800_000 }), { path, email: 'b@example.test', now });
  assert.equal(written.changed, true);
  assert.equal(written.backup, null);
  assert.equal(written.expires, new Date(now + 1_800_000).toISOString());

  const doc = JSON.parse(await fs.readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(doc), ['token', 'auth_method', 'id_token_email']);
  assert.deepEqual(doc.token, {
    access_token: 'access-b', token_type: 'Bearer', refresh_token: 'refresh-b',
    expiry: new Date(now + 1_800_000).toISOString(), expires_in: 1800,
  });
  assert.equal(doc.auth_method, 'consumer');
  assert.equal(doc.id_token_email, 'b@example.test');
  assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await list(join(path, '..')), ['antigravity-oauth-token']);

  const status = agyCliStatus(path);
  assert.equal(status.signedIn, true);
  assert.equal(status.email, 'b@example.test');
  assert.equal(status.expires, doc.token.expiry);
  assert.equal(status.expired, false);
});

test('backs up a CLI session that is not one of the saved accounts', async t => {
  const previous = { token: { access_token: 'access-external', refresh_token: 'refresh-external', expiry: new Date(Date.now() + 60_000).toISOString() }, auth_method: 'consumer', id_token_email: 'external@example.test' };
  const { path } = await fixture(t, { withSession: previous });
  const written = writeAgyCliDocument(creds(), { path, email: 'b@example.test', knownEmails: ['a@example.test'] });
  assert.ok(written.backup, 'unlisted session must be preserved');
  assert.match(written.backup, /antigravity-oauth-token\.bak-/);
  assert.equal(written.previousEmail, 'external@example.test');
  assert.deepEqual(JSON.parse(await fs.readFile(written.backup, 'utf8')), previous);
  assert.equal((await fs.stat(written.backup)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).id_token_email, 'b@example.test');
});

test('does not back up a session that is already a saved account', async t => {
  const previous = { token: { access_token: 'access-a', refresh_token: 'refresh-a', expiry: new Date(Date.now() + 60_000).toISOString() }, auth_method: 'consumer', id_token_email: 'a@example.test' };
  const { path } = await fixture(t, { withSession: previous });
  const written = writeAgyCliDocument(creds(), { path, email: 'b@example.test', knownEmails: ['a@example.test', 'b@example.test'] });
  assert.equal(written.backup, null);
  assert.deepEqual(await list(join(path, '..')), ['antigravity-oauth-token']);
});

test('an unreadable session counts as unlisted and is preserved', async t => {
  const { path } = await fixture(t);
  await fs.writeFile(path, 'not json', { mode: 0o600 });
  const written = writeAgyCliDocument(creds(), { path, email: 'b@example.test', knownEmails: ['a@example.test'] });
  assert.ok(written.backup);
  assert.equal(await fs.readFile(written.backup, 'utf8'), 'not json');
});

test('reuses the stored auth method and skips a write that changes nothing', async t => {
  const previous = { token: { access_token: 'access-b', refresh_token: 'refresh-b', expiry: new Date(Date.now() + 60_000).toISOString() }, auth_method: 'cli', id_token_email: 'b@example.test' };
  const { path } = await fixture(t, { withSession: previous });
  const unchanged = writeAgyCliDocument(creds({ access: 'access-b', refresh: 'refresh-b' }), { path, email: 'b@example.test', knownEmails: ['b@example.test'] });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.backup, null);

  const written = writeAgyCliDocument(creds({ access: 'access-new', refresh: 'refresh-b' }), { path, email: 'b@example.test', knownEmails: ['b@example.test'] });
  assert.equal(written.changed, true);
  assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).auth_method, 'cli');
});

test('reads a legacy session that stores a full id_token instead of an email', async t => {
  const legacy = { token: { access_token: 'a', refresh_token: 'r', expiry: new Date(Date.now() + 60_000).toISOString() }, auth_method: 'consumer', id_token: jwt({ email: 'legacy@example.test' }) };
  const { path } = await fixture(t, { withSession: legacy });
  assert.equal(agyCliIdentity(legacy).email, 'legacy@example.test');
  const written = writeAgyCliDocument(creds(), { path, email: 'b@example.test', knownEmails: ['legacy@example.test'] });
  assert.equal(written.backup, null, 'a listed legacy session needs no backup');
});

test('reports expiry and rejects credentials that cannot drive the CLI', async t => {
  const { path } = await fixture(t);
  const past = Date.now() - 60_000;
  writeAgyCliDocument(creds({ expires: past }), { path, email: 'b@example.test' });
  const status = agyCliStatus(path);
  assert.equal(status.expired, true);
  assert.equal(status.authMethod, 'consumer');
  assert.throws(() => writeAgyCliDocument(creds({ refresh: '' }), { path }), (error) => error.code === 'AGY_CLI_CREDENTIALS');
  assert.equal(agyCliStatus(join(path, 'missing')).signedIn, false);
});
