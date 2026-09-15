import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { FileAccountStore, normalizeProxyPolicy } from '../lib/account-store.js';

const moduleURL = new URL('../lib/account-store.js', import.meta.url).href;
const creds = (name = 'a') => ({ access: `access-${name}`, refresh: `refresh-${name}`, expires: Date.now() + 3600000, projectId: `project-${name}`, email: `${name}@example.test`, providerSubject: `subject-${name}` });
async function fixture(t) { const root = await fs.mkdtemp(join(tmpdir(), 'ag-account-test-')); t.after(() => fs.rm(root, { recursive: true, force: true })); const file = join(root, 'accounts.json'); return { root, file, store: new FileAccountStore(file) }; }
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function child(source, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000, killSignal: 'SIGKILL' });
    let out = ''; let err = ''; proc.stdout.on('data', data => { out += data; }); proc.stderr.on('data', data => { err += data; });
    proc.on('error', reject); proc.on('exit', code => code === 0 ? resolve(out) : reject(new Error(`Child exited ${code}: ${err}`)));
  });
}

test('empty store and proxy default; first login activates, later login preserves selection', async t => {
  const { store, file } = await fixture(t);
  assert.deepEqual(await store.readDocument(), { version: 2, revision: 0, activeAccountId: null, accounts: [] });
  assert.equal(await store.read(), null); assert.equal(await store.capture(), null); assert.equal(store.path(), file);
  const a = (await store.upsert(creds())).accountId;
  const b = (await store.upsert(creds('b'))).accountId;
  assert.equal((await store.summaries()).activeAccountId, a);
  const capture = await store.capture(b);
  assert.equal(capture.accountId, b); assert.equal(capture.path(), file);
  assert.equal((await capture.read()).access, 'access-b');
  assert.deepEqual(capture.proxy, { enabled: false, url: null, scope: 'auth-only', revision: 0 });
  await store.activate(b, 2);
  assert.equal((await new FileAccountStore(file).read()).access, 'access-b');
  await assert.rejects(store.activate(a, 2), { code: 'REVISION_CONFLICT' });
  const summaries = JSON.stringify(await store.summaries());
  for (const secret of ['access-b', 'refresh-b', 'project-b', 'subject-b', 'credentials']) assert.ok(!summaries.includes(secret));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('proxy policies reject credentials, malformed/unsupported URLs and unknown fields', () => {
  assert.deepEqual(normalizeProxyPolicy(), { enabled: false, url: null, scope: 'auth-only', revision: 0 });
  assert.equal(normalizeProxyPolicy({ enabled: true, url: 'http://[::1]:8080/' }).url, 'http://[::1]:8080');
  assert.equal(normalizeProxyPolicy({ enabled: true, url: 'https://localhost:443', scope: 'all-account' }).url, 'https://localhost');
  for (const url of ['socks5://localhost:1080', 'http://user:pass@host:80', 'http://host/path', 'http://host?x', 'http://host#', 'http://host:0', 'http://host:65536', ' http://host', 'http://ho st', 'http://host\\evil', 'not-url']) assert.throws(() => normalizeProxyPolicy({ enabled: true, url }), { code: 'INVALID_PROXY' }, url);
  for (const policy of [null, [], { enabled: 'true' }, { scope: 'everything' }, { enabled: true }, { other: 1 }, { revision: -1 }]) assert.throws(() => normalizeProxyPolicy(policy), { code: 'INVALID_PROXY' });
});

test('legacy reads are non-destructive and stable; first write backs up exactly once', async t => {
  const { store, file } = await fixture(t);
  const { providerSubject, ...legacy } = creds();
  const raw = JSON.stringify(legacy);
  await fs.writeFile(file, raw, { mode: 0o600 });
  const first = await store.readDocument();
  assert.deepEqual(await store.read(), legacy);
  assert.equal((await new FileAccountStore(file).readDocument()).activeAccountId, first.activeAccountId);
  assert.equal(await fs.readFile(file, 'utf8'), raw);
  await assert.rejects(fs.stat(`${file}.legacy.bak`), { code: 'ENOENT' });
  await store.setProxy(first.activeAccountId, { enabled: true, url: 'http://localhost:8080' });
  assert.equal(await fs.readFile(`${file}.legacy.bak`, 'utf8'), raw);
  assert.equal((await fs.stat(`${file}.legacy.bak`)).mode & 0o777, 0o600);
  await store.upsert(creds(), { accountId: first.activeAccountId });
  assert.equal((await store.readDocument()).accounts.length, 1);
  assert.equal((await store.readDocument()).accounts[0].proxy.enabled, true);
  await store.removeAccount(first.activeAccountId);
  await assert.rejects(fs.stat(`${file}.legacy.bak`), { code: 'ENOENT' });
  assert.equal(await store.read(), null);
});

test('mismatched migration backup fails without overwriting credentials', async t => {
  const { store, file } = await fixture(t); const raw = JSON.stringify(creds());
  await fs.writeFile(file, raw, { mode: 0o600 }); await fs.writeFile(`${file}.legacy.bak`, 'different', { mode: 0o600 });
  await assert.rejects(store.upsert(creds('b')), /backup differs/);
  assert.equal(await fs.readFile(file, 'utf8'), raw);
  await store.delete();
  assert.equal(await store.read(), null); await assert.rejects(fs.stat(`${file}.legacy.bak`), { code: 'ENOENT' });
});

test('subject dedup preserves preferences; wrong-account reauthentication fails', async t => {
  const { store } = await fixture(t);
  const a = (await store.upsert(creds(), { label: 'My label', proxy: { enabled: true, url: 'http://localhost:8080' } })).accountId;
  assert.equal((await store.upsert({ ...creds(), access: 'new-access' })).accountId, a);
  assert.equal((await store.readDocument()).accounts.length, 1);
  assert.equal((await store.summaries()).accounts[0].label, 'My label');
  assert.equal((await store.summaries()).accounts[0].proxy.enabled, true);
  await assert.rejects(store.upsert(creds('b'), { accountId: a }), { code: 'ACCOUNT_IDENTITY_MISMATCH' });
  await assert.rejects(store.upsert(creds(), { accountId: 'unknown' }), { code: 'ACCOUNT_NOT_FOUND' });
});

test('removal requires explicit active replacement; last removal and logout retain empty revision', async t => {
  const { store } = await fixture(t);
  const a = (await store.upsert(creds())).accountId; const b = (await store.upsert(creds('b'))).accountId;
  await assert.rejects(store.removeAccount(a), { code: 'REPLACEMENT_REQUIRED' });
  await assert.rejects(store.removeAccount(a, a), { code: 'INVALID_REPLACEMENT' });
  await store.removeAccount(a, b, 2);
  assert.equal((await store.summaries()).activeAccountId, b);
  await store.removeAccount(b);
  assert.equal(await store.read(), null);
  await store.delete(); assert.equal((await store.summaries()).revision, 5);
});

test('switch, unrelated login and proxy edit do not block refresh or lose rotated token', async t => {
  const { store, file } = await fixture(t); const other = new FileAccountStore(file);
  const a = (await store.upsert(creds())).accountId; const b = (await store.upsert(creds('b'))).accountId;
  const capture = await store.capture(a); const entered = gate(); const release = gate();
  const refresh = capture.modify(async value => { entered.resolve(); await release.promise; return { ...value, access: 'rotated-access', refresh: 'rotated-refresh' }; });
  await entered.promise;
  try {
    await other.activate(b); await other.setProxy(a, { enabled: true, url: 'http://localhost:8080', scope: 'all-account' });
    await other.upsert(creds('c'));
  } finally { release.resolve(); }
  await refresh;
  const doc = await store.readDocument(); const record = doc.accounts.find(record => record.id === a);
  assert.equal(doc.activeAccountId, b); assert.equal(record.proxy.enabled, true); assert.equal(record.credentials.refresh, 'rotated-refresh');
  assert.equal(capture.proxy.enabled, false); assert.equal(doc.accounts.length, 3);
});

test('removed account cannot be resurrected by late refresh', async t => {
  const { store } = await fixture(t); const a = (await store.upsert(creds())).accountId;
  const capture = await store.capture(); const entered = gate(); const release = gate();
  const refresh = capture.modify(async value => { entered.resolve(); await release.promise; return { ...value, access: 'late' }; });
  await entered.promise; await store.removeAccount(a); release.resolve();
  await assert.rejects(refresh, { code: 'ACCOUNT_NOT_FOUND' }); assert.equal(await capture.read(), null); assert.equal(await store.read(), null);
});

test('relogin during refresh wins credential generation check', async t => {
  const { store } = await fixture(t); const a = (await store.upsert(creds())).accountId;
  const capture = await store.capture(); const entered = gate(); const release = gate();
  const refresh = capture.modify(async value => { entered.resolve(); await release.promise; return { ...value, access: 'late' }; });
  await entered.promise; await store.upsert({ ...creds(), access: 'relogin' }, { accountId: a }); release.resolve();
  await assert.rejects(refresh, { code: 'ACCOUNT_CHANGED' }); assert.equal((await store.read()).access, 'relogin');
});

test('cross-instance captured refreshes singleflight by credential generation', async t => {
  const { store, file } = await fixture(t); await store.upsert(creds());
  const a = await store.capture(); const b = await new FileAccountStore(file).capture();
  const entered = gate(); const release = gate(); let calls = 0;
  const first = a.modify(async value => { calls++; entered.resolve(); await release.promise; return { ...value, refresh: 'rotated' }; });
  await entered.promise;
  const second = b.modify(value => { calls++; return { ...value, refresh: 'wrong' }; });
  release.resolve(); await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal((await store.read()).refresh, 'rotated');
});

test('concurrent cross-instance writers preserve all accounts and revisions', async t => {
  const { store, file } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, n) => new FileAccountStore(file).upsert(creds(String(n)))));
  const doc = await store.readDocument(); assert.equal(doc.accounts.length, 12); assert.equal(doc.revision, 12);
});

test('subprocess writers share document lock; dead process account lock is recoverable', async t => {
  const { store, file } = await fixture(t);
  const source = `import { FileAccountStore } from ${JSON.stringify(moduleURL)}; const store = new FileAccountStore(process.argv[1]); for(let n=0;n<4;n++) await store.upsert({access:'a',refresh:'r',expires:1,email:process.argv[2]+n,providerSubject:process.argv[2]+n});`;
  await Promise.all([child(source, [file, 'first']), child(source, [file, 'second'])]);
  assert.equal((await store.readDocument()).accounts.length, 8); assert.equal((await store.readDocument()).revision, 8);
  const account = await store.capture();
  const folder = `${file}.account-${account.accountId}.lock`;
  const owner = `import * as fs from 'node:fs/promises'; import { hostname } from 'node:os'; await fs.mkdir(process.argv[1],{mode:448}); await fs.writeFile(process.argv[1]+'/'+process.pid+'-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', hostname(), {mode:384});`;
  await child(owner, [folder]);
  await account.modify(value => ({ ...value, access: 'recovered' }));
  assert.equal((await account.read()).access, 'recovered');
});

test('subprocess refresh locks reuse generation instead of rotating twice', async t => {
  const { store, file, root } = await fixture(t); await store.upsert(creds());
  const ready1 = join(root, 'ready1'); const ready2 = join(root, 'ready2');
  const source = `import { FileAccountStore } from ${JSON.stringify(moduleURL)}; import * as fs from 'node:fs/promises'; import {setTimeout} from 'node:timers/promises'; const store=new FileAccountStore(process.argv[1]); const captured=await store.capture(); await fs.writeFile(process.argv[2],'ready'); while(true){try{await fs.stat(process.argv[3]);break}catch{await setTimeout(10)}} await captured.modify(async value=>{await fs.appendFile(process.argv[4],'refresh\\n'); await setTimeout(60); return {...value,refresh:'rotated'};});`;
  await Promise.all([child(source, [file, ready1, ready2, join(root, 'calls')]), child(source, [file, ready2, ready1, join(root, 'calls')])]);
  assert.equal(await fs.readFile(join(root, 'calls'), 'utf8'), 'refresh\n');
  assert.equal((await store.read()).refresh, 'rotated');
});

test('invalid documents, duplicates, file size and permissions fail closed', async t => {
  const { store, file, root } = await fixture(t); await store.upsert(creds()); const valid = await store.readDocument();
  const invalid = [ { ...valid, version: 99 }, { ...valid, activeAccountId: 'missing' }, { ...valid, accounts: [valid.accounts[0], valid.accounts[0]] }, { ...valid, accounts: [{ ...valid.accounts[0], credentials: { ...valid.accounts[0].credentials, expires: null } }] }, { ...valid, accounts: [{ ...valid.accounts[0], proxy: { enabled: true, url: 'http://password@host' } }] } ];
  for (const doc of invalid) { await fs.writeFile(file, JSON.stringify(doc)); await assert.rejects(store.readDocument(), { code: 'INVALID_ACCOUNT_STORE' }).catch(error => { if (doc.accounts?.[0]?.proxy?.url === 'http://password@host') return assert.rejects(store.readDocument(), { code: 'INVALID_PROXY' }); throw error; }); }
  await fs.writeFile(file, '{broken'); await assert.rejects(store.readDocument(), /invalid JSON/);
  await fs.writeFile(file, ' '.repeat(512 * 1024 + 1)); await assert.rejects(store.readDocument(), /512 KiB/);
  await fs.writeFile(file, JSON.stringify(valid)); await fs.chmod(file, 0o644); await assert.rejects(store.readDocument(), { code: 'UNSAFE_ACCOUNT_STORE' });
  await fs.chmod(file, 0o600); await fs.rename(file, join(root, 'real')); await fs.symlink(join(root, 'real'), file); await assert.rejects(store.readDocument(), { code: 'UNSAFE_ACCOUNT_STORE' });
});

test('account limit and corrupt backup never expose or mutate saved credentials', async t => {
  const { store, file } = await fixture(t);
  for (let n = 0; n < 16; n++) await store.upsert(creds(String(n)));
  await assert.rejects(store.upsert(creds('17')), { code: 'ACCOUNT_LIMIT' }); assert.equal((await store.summaries()).revision, 16);
  const bytes = await fs.readFile(file, 'utf8'); assert.ok(!bytes.includes('access-17'));
  assert.deepEqual((await fs.readdir(join(file, '..'))).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')), []);
});
