import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_BYTES = 512 * 1024;
const MAX_ACCOUNTS = 16;
const LOCK_TIMEOUT = 15000;
const ORPHAN_AGE = 30000;
const empty = () => ({ version: 2, revision: 0, activeAccountId: null, accounts: [] });
const copy = value => structuredClone(value);
function fail(message, code = 'INVALID_ACCOUNT_STORE') { const error = new Error(message); error.code = code; throw error; }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function text(value, max = 4096) { return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
function id(value) { return text(value, 128) && /^[A-Za-z0-9_-]+$/.test(value); }

/** Validate a credential-free HTTP(S) origin; disabled means harness defaults. */
export function normalizeProxyPolicy(policy = {}) {
  if (!object(policy) || Object.keys(policy).some(key => !['enabled', 'url', 'scope', 'revision'].includes(key))) fail('Invalid proxy policy', 'INVALID_PROXY');
  const { enabled = false, scope = 'auth-only', revision = 0 } = policy;
  let { url = null } = policy;
  if (typeof enabled !== 'boolean' || !['auth-only', 'all-account'].includes(scope) || !integer(revision)) fail('Invalid proxy policy', 'INVALID_PROXY');
  if (url !== null) {
    if (!text(url, 2048) || url !== url.trim() || /[\\\s]/.test(url)) fail('Invalid proxy origin', 'INVALID_PROXY');
    let parsed;
    try { parsed = new URL(url); } catch { fail('Invalid proxy origin', 'INVALID_PROXY'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || /[?#]/.test(url) || !/^https?:\/\/[^/]+\/?$/.test(url) || (parsed.port && Number(parsed.port) < 1)) fail('Proxy must be a credential-free HTTP(S) origin', 'INVALID_PROXY');
    url = parsed.origin;
  }
  if (enabled && !url) fail('Enabled proxy requires an origin', 'INVALID_PROXY');
  return { enabled, url, scope, revision };
}
function credentials(value) {
  if (!object(value) || typeof value.access !== 'string' || !value.access || value.access.length > 65536 || typeof value.refresh !== 'string' || !value.refresh || value.refresh.length > 65536 || !Number.isFinite(value.expires) || value.expires < 0 || (value.projectId !== undefined && !text(value.projectId))) fail('Invalid account credentials');
  return { access: value.access, refresh: value.refresh, expires: value.expires, ...(value.projectId !== undefined ? { projectId: value.projectId } : {}) };
}
function validate(doc) {
  if (!object(doc) || doc.version !== 2 || !integer(doc.revision) || !Array.isArray(doc.accounts) || doc.accounts.length > MAX_ACCOUNTS) fail('Invalid or unsupported account document');
  const ids = new Set(); const subjects = new Set();
  for (const record of doc.accounts) {
    if (!object(record) || !id(record.id) || ids.has(record.id) || !integer(record.credentialRevision) || !text(record.email, 320) || !text(record.label, 320) || !object(record.proxy) || !Number.isFinite(record.createdAt) || record.createdAt < 0 || !Number.isFinite(record.updatedAt) || record.updatedAt < record.createdAt) fail('Invalid account record');
    ids.add(record.id);
    if (record.providerSubject !== undefined) {
      if (!text(record.providerSubject, 512) || !record.providerSubject || subjects.has(record.providerSubject)) fail('Invalid or duplicate account identity');
      subjects.add(record.providerSubject);
    }
    record.credentials = credentials(record.credentials);
    record.proxy = normalizeProxyPolicy(record.proxy);
  }
  if (doc.accounts.length ? !ids.has(doc.activeAccountId) : doc.activeAccountId !== null) fail('Invalid active account');
  return doc;
}
function flattened(record) { return record ? { ...record.credentials, ...(record.email !== undefined ? { email: record.email } : {}), ...(record.providerSubject !== undefined ? { providerSubject: record.providerSubject } : {}) } : null; }
function summary(record, activeId) {
  return { id: record.id, email: record.email, label: record.label, expires: record.credentials.expires, createdAt: record.createdAt, updatedAt: record.updatedAt, credentialRevision: record.credentialRevision, active: record.id === activeId, authState: record.credentials.expires > Date.now() ? 'ready' : 'refresh-required', proxy: copy(record.proxy) };
}
function secure(stat, directory = false) {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & (directory ? 0o022 : 0o077))) fail('Unsafe account-store ownership, permissions or file type', 'UNSAFE_ACCOUNT_STORE');
}
async function privateRead(file) {
  let handle;
  try {
    const stat = await fs.lstat(file); secure(stat);
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat(); secure(opened);
    if (stat.ino !== opened.ino || stat.dev !== opened.dev) fail('Account file changed during open');
    if (opened.size > MAX_BYTES) fail('Account document exceeds 512 KiB');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    while (used < buffer.length) { const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null); if (!bytesRead) break; used += bytesRead; }
    if (used > MAX_BYTES) fail('Account document exceeds 512 KiB');
    return buffer.subarray(0, used).toString('utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}

/** Persistent host-only credential store. All mutations are coordinated across processes.
 * upsert returns {accountId}; capture returns null when no active account exists.
 * Captured modify(fn) accepts/returns flattened legacy credentials; undefined is a no-op.
 * A generation changed before lock acquisition reuses the new credentials (singleflight).
 * A generation changed during fn rejects ACCOUNT_CHANGED rather than overwriting login.
 */
export class FileAccountStore {
  constructor(file) { if (typeof file !== 'string' || !file) fail('Credential path required'); this.file = resolve(file); }
  path() { return this.file; }
  async _parent() {
    await fs.mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    // Reject symlink components, but do not chmod the shared storage hierarchy.
    let part = dirname(this.file);
    while (true) {
      const stat = await fs.lstat(part);
      if (!stat.isDirectory()) fail('Account-store directory must not be a symlink', 'UNSAFE_ACCOUNT_STORE');
      if (part === dirname(this.file)) secure(stat, true);
      const next = dirname(part); if (next === part) break; part = next;
    }
  }
  async _lock(suffix, fn) {
    await this._parent();
    const folder = `${this.file}.${suffix}.lock`;
    const token = `${process.pid}-${randomUUID()}`;
    const owner = `${folder}/${token}`;
    const deadline = Date.now() + LOCK_TIMEOUT;
    while (true) {
      try {
        await fs.mkdir(folder, { mode: 0o700 });
        const stat = await fs.lstat(folder); secure(stat, true);
        await fs.writeFile(owner, hostname(), { flag: 'wx', mode: 0o600 });
        const current = await fs.lstat(folder);
        if (current.ino !== stat.ino || current.dev !== stat.dev) { await fs.unlink(owner).catch(() => {}); continue; }
        break;
      } catch (error) {
        if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error;
        try {
          const stat = await fs.lstat(folder); secure(stat, true);
          const entries = await fs.readdir(folder);
          if (entries.length === 0 && Date.now() - stat.mtimeMs > ORPHAN_AGE) await fs.rmdir(folder);
          else if (entries.length === 1 && /^\d+-[a-f0-9-]+$/.test(entries[0])) {
            const entry = `${folder}/${entries[0]}`;
            const host = await privateRead(entry);
            if (host === hostname()) {
              const pid = Number(entries[0].split('-')[0]);
              let dead = false;
              try { process.kill(pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
              if (dead) { await fs.unlink(entry); await fs.rmdir(folder); }
            }
          }
        } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
        if (Date.now() >= deadline) fail('Timed out waiting for account-store lock', 'ACCOUNT_LOCK_TIMEOUT');
        await delay(15 + Math.floor(Math.random() * 20));
      }
    }
    try { return await fn(); }
    finally { await fs.unlink(owner); await fs.rmdir(folder); }
  }
  async _load() {
    await this._parent();
    const raw = await privateRead(this.file);
    if (raw === null) return { doc: empty(), legacy: null };
    let value; try { value = JSON.parse(raw); } catch { fail('Account document contains invalid JSON'); }
    if (object(value) && value.version === undefined) {
      const creds = credentials(value);
      if (value.email !== undefined && !text(value.email, 320)) fail('Invalid legacy email');
      const accountId = `legacy-${createHash('sha256').update(this.file).digest('hex').slice(0, 24)}`;
      return { legacy: raw, doc: { version: 2, revision: 0, activeAccountId: accountId, accounts: [{ id: accountId, email: value.email ?? '', label: value.email || 'Imported account', credentials: creds, credentialRevision: 0, proxy: normalizeProxyPolicy(), createdAt: 0, updatedAt: 0 }] } };
    }
    return { doc: validate(value), legacy: null };
  }
  async readDocument() { return (await this._load()).doc; }
  async summaries() { const doc = await this.readDocument(); return { revision: doc.revision, activeAccountId: doc.activeAccountId, accounts: doc.accounts.map(record => summary(record, doc.activeAccountId)) }; }
  async read() { const doc = await this.readDocument(); return flattened(doc.accounts.find(record => record.id === doc.activeAccountId)); }
  async _save(doc, legacy) {
    validate(doc);
    const serialized = `${JSON.stringify(doc)}\n`;
    if (Buffer.byteLength(serialized) > MAX_BYTES) fail('Account document exceeds 512 KiB');
    if (legacy !== null) {
      const backup = `${this.file}.legacy.bak`;
      const previous = await privateRead(backup);
      if (previous !== null && previous !== legacy) fail('Existing legacy backup differs; resolve it before migrating');
      if (previous === null) {
        const handle = await fs.open(backup, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(legacy); await handle.sync(); } finally { await handle.close(); }
      }
    }
    // Validate an existing target again before replacing it.
    await privateRead(this.file);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(serialized); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temporary, this.file);
      const directory = await fs.open(dirname(this.file), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await handle?.close(); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async _mutate(fn, expectedRevision, cleanup = false) {
    return this._lock('document', async () => {
      const { doc, legacy } = await this._load();
      if (expectedRevision !== undefined && (!integer(expectedRevision) || expectedRevision !== doc.revision)) fail('Account revision conflict; reload status', 'REVISION_CONFLICT');
      const result = await fn(doc);
      doc.revision += 1;
      if (cleanup) await this._cleanupBackup();
      await this._save(doc, cleanup ? null : legacy);
      return result;
    });
  }
  async _cleanupBackup() { const backup = `${this.file}.legacy.bak`; if (await privateRead(backup) !== null) await fs.unlink(backup); }
  async upsert(value, options = {}) {
    const next = credentials(value);
    if (!object(options) || (options.activate !== undefined && typeof options.activate !== 'boolean') || (value.email !== undefined && !text(value.email, 320)) || (value.providerSubject !== undefined && (!text(value.providerSubject, 512) || !value.providerSubject)) || (options.label !== undefined && !text(options.label, 320))) fail('Invalid account login fields');
    return this._mutate(doc => {
      let record = options.accountId !== undefined ? doc.accounts.find(record => record.id === options.accountId) : value.providerSubject ? doc.accounts.find(record => record.providerSubject === value.providerSubject) : undefined;
      if (options.accountId !== undefined && !record) fail('Account not found', 'ACCOUNT_NOT_FOUND');
      if (record?.providerSubject && value.providerSubject !== record.providerSubject) fail('Reauthentication identity does not match account', 'ACCOUNT_IDENTITY_MISMATCH');
      if (record && !record.providerSubject && value.providerSubject && record.email && value.email !== record.email) fail('Reauthentication email does not match imported account', 'ACCOUNT_IDENTITY_MISMATCH');
      if (value.providerSubject && doc.accounts.some(other => other !== record && other.providerSubject === value.providerSubject)) fail('Identity already belongs to another account', 'ACCOUNT_IDENTITY_MISMATCH');
      const now = Date.now();
      if (!record) {
        if (doc.accounts.length >= MAX_ACCOUNTS) fail('Account limit of 16 reached', 'ACCOUNT_LIMIT');
        record = { id: randomUUID(), email: value.email ?? '', label: options.label ?? value.email ?? 'Account', credentials: next, credentialRevision: 0, proxy: normalizeProxyPolicy(), createdAt: now, updatedAt: now };
        doc.accounts.push(record);
      }
      record.credentials = next; record.credentialRevision += 1; record.updatedAt = now;
      if (value.email !== undefined) record.email = value.email;
      if (value.providerSubject !== undefined) record.providerSubject = value.providerSubject;
      if (options.label !== undefined) record.label = options.label;
      if (options.proxy !== undefined) record.proxy = { ...normalizeProxyPolicy(options.proxy), revision: record.proxy.revision + 1 };
      if (!doc.activeAccountId || options.activate === true) doc.activeAccountId = record.id;
      return { accountId: record.id };
    });
  }
  async activate(accountId, expectedRevision) { return this._mutate(doc => { this._account(doc, accountId); doc.activeAccountId = accountId; return { accountId }; }, expectedRevision); }
  _account(doc, accountId) { const record = doc.accounts.find(record => record.id === accountId); if (!record) fail('Account not found', 'ACCOUNT_NOT_FOUND'); return record; }
  async removeAccount(accountId, replacementId, expectedRevision) {
    return this._mutate(doc => {
      this._account(doc, accountId);
      if (replacementId !== undefined && (replacementId === accountId || !doc.accounts.some(record => record.id === replacementId))) fail('Invalid replacement account', 'INVALID_REPLACEMENT');
      if (doc.activeAccountId === accountId && doc.accounts.length > 1 && replacementId === undefined) fail('Removing active account requires a replacement', 'REPLACEMENT_REQUIRED');
      doc.accounts = doc.accounts.filter(record => record.id !== accountId);
      if (doc.activeAccountId === accountId) doc.activeAccountId = replacementId ?? null;
      return { accountId };
    }, expectedRevision, true);
  }
  async setProxy(accountId, policy, expectedRevision) {
    const normalized = normalizeProxyPolicy(policy);
    return this._mutate(doc => { const record = this._account(doc, accountId); record.proxy = { ...normalized, revision: record.proxy.revision + 1 }; record.updatedAt = Date.now(); return { accountId }; }, expectedRevision);
  }
  async delete() {
    return this._lock('document', async () => {
      // A private tombstone preserves the mutation revision, prevents legacy-ID ABA,
      // and means callers must inspect read(), not merely test path existence.
      const { doc } = await this._load();
      await this._cleanupBackup();
      await this._save({ ...empty(), revision: doc.revision + 1 }, null);
    });
  }
  async capture(accountId) {
    const doc = await this.readDocument();
    if (accountId === undefined) accountId = doc.activeAccountId;
    if (accountId === null) return null;
    const record = this._account(doc, accountId);
    let generation = record.credentialRevision;
    let pending = null;
    return {
      accountId, credentialRevision: generation, proxy: copy(record.proxy),
      path: () => this.path(),
      read: async () => flattened((await this.readDocument()).accounts.find(record => record.id === accountId)),
      modify: async fn => {
        if (typeof fn !== 'function') fail('Credential modifier must be a function');
        if (pending) return pending;
        pending = this._lock(`account-${accountId}`, async () => {
          const current = this._account(await this.readDocument(), accountId);
          if (current.credentialRevision !== generation) { generation = current.credentialRevision; return flattened(current); }
          const next = await fn(flattened(current));
          if (next === undefined || next === null) return flattened(current);
          const validated = credentials(next);
          const result = await this._mutate(doc => {
            const latest = this._account(doc, accountId);
            if (latest.credentialRevision !== current.credentialRevision) fail('Account credentials changed during refresh', 'ACCOUNT_CHANGED');
            latest.credentials = validated;
            latest.credentialRevision += 1; latest.updatedAt = Date.now();
            return flattened(latest);
          });
          generation = current.credentialRevision + 1;
          return result;
        }).finally(() => { pending = null; });
        return pending;
      },
    };
  }
}
