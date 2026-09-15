import { AsyncLocalStorage } from 'node:async_hooks';

export const accountScope = new AsyncLocalStorage();
const leases = new Set();
const ownedLeases = new WeakSet();
let undici;

function unavailable() {
  return Object.assign(new Error('Account proxy is unavailable.'), { code: 'PROXY_UNAVAILABLE' });
}
function aborted() {
  return new DOMException('The operation was aborted.', 'AbortError');
}
function proxyURL(value) {
  try {
    if (typeof value !== 'string' || value !== value.trim()) throw new Error();
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash || /[?#]/.test(value)) throw new Error();
    return url.origin;
  } catch {
    throw unavailable();
  }
}
function customProxy(context) {
  const policy = context?.account?.proxy;
  if (!policy?.enabled) return null;
  const scope = policy.scope ?? 'auth-only';
  if (!['auth-only', 'all'].includes(scope)) throw unavailable();
  if (scope === 'auth-only' && context.kind === 'api') return null;
  return proxyURL(policy.url);
}
function createLease(signal) {
  const lease = { agents: new Map(), closed: false, signal, cleanup: null };
  ownedLeases.add(lease);
  leases.add(lease);
  const abort = () => { void finishLease(lease, true); };
  signal?.addEventListener('abort', abort, { once: true });
  lease.detach = () => signal?.removeEventListener('abort', abort);
  if (signal?.aborted) abort();
  return lease;
}
async function finishLease(lease, force = false) {
  if (lease.cleanup) {
    if (force) for (const agent of lease.agents.values()) void agent.destroy().catch(() => {});
    return lease.cleanup;
  }
  lease.closed = true;
  lease.detach();
  lease.cleanup = (async () => {
    await Promise.all([...lease.agents.values()].map(async agent => {
      if (force) { await agent.destroy().catch(() => {}); return; }
      let timer;
      try {
        await Promise.race([
          agent.close().catch(() => {}),
          new Promise(resolve => { timer = setTimeout(resolve, 2000); }),
        ]);
      } finally {
        clearTimeout(timer);
        // destroy is immediate for Undici agents, including unconsumed bodies.
        await agent.destroy().catch(() => {});
      }
    }));
    leases.delete(lease);
  })();
  return lease.cleanup;
}
async function dispatcherFor(lease, url) {
  if (lease.closed || lease.signal?.aborted) throw aborted();
  undici ??= import('undici');
  const { ProxyAgent } = await undici;
  if (lease.closed || lease.signal?.aborted) throw aborted();
  let agent = lease.agents.get(url);
  if (!agent) {
    agent = new ProxyAgent({ uri: url, connections: 4, proxyTunnel: true, requestTls: { rejectUnauthorized: true }, proxyTls: { rejectUnauthorized: true } });
    lease.agents.set(url, agent);
  }
  return agent;
}
function scopedContext(context) {
  const captured = { ...context };
  if (context?.account) captured.account = { ...context.account, proxy: { ...context.account.proxy } };
  captured.lease = createLease(captured.signal);
  return captured;
}

/** Consume response bodies inside operation; ownership ends when it settles. */
export async function runWithTransport(context, operation) {
  const captured = scopedContext(context);
  try {
    if (captured.signal?.aborted) throw aborted();
    return await accountScope.run(captured, () => operation(captured));
  } finally {
    await finishLease(captured.lease);
  }
}

/** Keep routing and agent ownership across every pull and early iterator return. */
export async function* streamWithTransport(context, makeIterator) {
  const captured = scopedContext(context);
  let iterator;
  let done = false;
  try {
    if (captured.signal?.aborted) throw aborted();
    iterator = await accountScope.run(captured, async () => {
      const source = await makeIterator(captured);
      return source[Symbol.asyncIterator]?.() ?? source[Symbol.iterator]?.() ?? source;
    });
    while (true) {
      if (captured.signal?.aborted) throw aborted();
      const result = await accountScope.run(captured, () => iterator.next());
      if (result.done) { done = true; return result.value; }
      yield result.value;
    }
  } finally {
    try {
      if (!done && iterator?.return) await accountScope.run(captured, () => iterator.return());
    } finally {
      await finishLease(captured.lease);
    }
  }
}

export async function providerFetch(url, init = {}) {
  const context = accountScope.getStore();
  const signals = [context?.signal, init.signal, url instanceof Request ? url.signal : null].filter(Boolean);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  if (signal?.aborted) throw aborted();
  const proxy = customProxy(context);
  if (!proxy) return globalThis.fetch(url, signal ? { ...init, signal } : init);
  const inherited = ownedLeases.has(context?.lease);
  const lease = inherited ? context.lease : createLease(signal);
  try {
    const dispatcher = await dispatcherFor(lease, proxy);
    // proxy-exempt: explicit account-owned override; OFF/excluded routes inherit DSH's global fetch policy.
    // Pair fetch with its ProxyAgent: Undici 8 dispatchers do not support Node's older bundled fetch.
    const transport = await undici;
    const response = await transport.default.fetch(url, { ...init, signal, dispatcher });
    if (response.status === 407) {
      await response.body?.cancel().catch(() => {});
      throw unavailable();
    }
    // Standalone accountScope.run callers also retain the lease until the body ends.
    // Wrap bodies in both modes so late socket/TLS errors cannot expose proxy URLs.
    if (!response.body) { if (!inherited) await finishLease(lease); return response; }
    const reader = response.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) { controller.close(); if (!inherited) await finishLease(lease); }
          else controller.enqueue(result.value);
        } catch (error) {
          controller.error(signal?.aborted || error?.name === 'AbortError' ? aborted() : unavailable());
          if (!inherited) await finishLease(lease, true);
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); } finally { if (!inherited) await finishLease(lease, true); }
      },
    });
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperties(wrapped, {
      url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
    });
    return wrapped;
  } catch (error) {
    if (!inherited) await finishLease(lease, true);
    if (signal?.aborted || error?.name === 'AbortError') throw aborted();
    throw unavailable();
  }
}

/** Only destroys account-owned overrides, never the harness/global dispatcher. */
export async function disposeTransports() {
  await Promise.all([...leases].map(lease => finishLease(lease, true)));
}

/** Fixed, unauthenticated reachability probe; never returns provider bodies/errors. */
export async function testProxy(url) {
  let normalized;
  try { normalized = proxyURL(url); } catch { return { reachable: false, classification: 'invalid-proxy' }; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    await runWithTransport({ account: { proxy: { enabled: true, url: normalized, scope: 'all' } }, kind: 'api', signal: controller.signal }, async () => {
      const response = await providerFetch('https://www.googleapis.com/', { method: 'GET', redirect: 'error' });
      await response.body?.cancel();
    });
    return { reachable: true, classification: 'reachable' };
  } catch {
    return { reachable: false, classification: controller.signal.aborted ? 'timeout' : 'proxy-unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
