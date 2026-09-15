import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import undici, { getGlobalDispatcher } from 'undici';
import { accountScope, providerFetch, runWithTransport, streamWithTransport, disposeTransports, testProxy } from '../lib/transport.js';

const realFetch = globalThis.fetch;
const realProxyFetch = undici.fetch;
const account = (scope = 'all', enabled = true, url = 'http://127.0.0.1:12345') => ({ accountId: 'test-account', proxy: { enabled, scope, url } });
const context = (scope = 'all', kind = 'api', enabled = true) => ({ account: account(scope, enabled), kind });
afterEach(async () => { globalThis.fetch = realFetch; undici.fetch = realProxyFetch; await disposeTransports(); });

function recordFetch() {
  const calls = [];
  globalThis.fetch = undici.fetch = async (url, init) => {
    calls.push({ url, init, scope: accountScope.getStore() });
    return new Response('ok');
  };
  return calls;
}

test('OFF, unscoped and auth-only API inherit ordinary global fetch', async () => {
  const calls = recordFetch();
  await (await providerFetch('https://example.test')).text();
  for (const value of [context('all', 'api', false), context('auth-only', 'api')]) {
    await runWithTransport(value, async () => assert.equal(await (await providerFetch('https://example.test')).text(), 'ok'));
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => !Object.hasOwn(call.init, 'dispatcher')));
  assert.equal(calls[2].scope.account.accountId, 'test-account');
});

test('custom auth/all use explicit per-operation agents without global/environment mutation', async () => {
  const calls = recordFetch();
  const env = { ...process.env };
  const globalDispatcher = getGlobalDispatcher();
  for (const value of [context('auth-only', 'auth'), context()]) {
    await runWithTransport(value, async () => {
      await (await providerFetch('https://example.test')).text();
      await (await providerFetch('https://example.test')).text();
      assert.equal(calls.at(-1).init.dispatcher.closed, false);
    });
  }
  assert.equal(calls[0].init.dispatcher, calls[1].init.dispatcher);
  assert.notEqual(calls[0].init.dispatcher, calls[2].init.dispatcher);
  assert.ok(calls.every(call => call.init.dispatcher.closed));
  assert.equal(getGlobalDispatcher(), globalDispatcher);
  assert.deepEqual({ ...process.env }, env);
});

test('proxy failures fail closed and remove raw error details; 407 is safe failure, 503 stays Response', async () => {
  let count = 0;
  globalThis.fetch = undici.fetch = async () => { count++; throw new Error('secret-token http://secret-proxy'); };
  await assert.rejects(runWithTransport(context(), () => providerFetch('https://example.test')), error => {
    assert.equal(error.code, 'PROXY_UNAVAILABLE');
    assert.equal(error.message, 'Account proxy is unavailable.');
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(count, 1);
  globalThis.fetch = undici.fetch = async () => new Response('proxy credentials', { status: 407 });
  await assert.rejects(runWithTransport(context(), () => providerFetch('https://example.test')), { code: 'PROXY_UNAVAILABLE' });
  globalThis.fetch = undici.fetch = async () => new Response('busy', { status: 503 });
  await runWithTransport(context(), async () => {
    const response = await providerFetch('https://example.test');
    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'busy');
  });
});

test('stream lease spans pulls and return with ALS on every iterator call', async () => {
  const calls = recordFetch();
  const observed = [];
  let dispatcher;
  const iterator = streamWithTransport(context(), () => ({
    async next() {
      observed.push(accountScope.getStore());
      assert.equal(dispatcher?.closed ?? false, false);
      await (await providerFetch('https://example.test')).text();
      dispatcher = calls.at(-1).init.dispatcher;
      return { done: false, value: 'chunk' };
    },
    async return() {
      observed.push(accountScope.getStore());
      assert.equal(dispatcher.closed, false);
      return { done: true };
    },
  }));
  assert.equal((await iterator.next()).value, 'chunk');
  assert.equal(accountScope.getStore(), undefined);
  assert.equal(dispatcher.closed, false);
  await iterator.next();
  await iterator.return();
  assert.equal(observed.length, 3);
  assert.ok(observed.every(value => value === observed[0]));
  assert.equal(dispatcher.closed, true);
});

test('normal stream exhaustion and thrown iterator clean up owned agents', async () => {
  const calls = recordFetch();
  async function* source() {
    await (await providerFetch('https://example.test')).text();
    yield 1;
  }
  const values = [];
  for await (const value of streamWithTransport(context(), source)) values.push(value);
  assert.deepEqual(values, [1]);
  assert.equal(calls[0].init.dispatcher.closed, true);
  await assert.rejects(async () => {
    for await (const value of streamWithTransport(context(), async function* () {
      await (await providerFetch('https://example.test')).text();
      throw new Error('operation failed');
    })) void value;
  }, /operation failed/);
  assert.equal(calls[1].init.dispatcher.closed, true);
});

test('cancellation composes caller signals and only destroys owned override', async () => {
  const controller = new AbortController();
  const caller = new AbortController();
  const inherited = getGlobalDispatcher();
  let dispatcher;
  globalThis.fetch = undici.fetch = async (_url, init) => {
    dispatcher = init.dispatcher;
    assert.notEqual(init.signal, controller.signal);
    caller.abort(new Error('sensitive reason'));
    throw init.signal.reason;
  };
  await assert.rejects(runWithTransport({ ...context(), signal: controller.signal }, () => providerFetch('https://example.test', { signal: caller.signal })), { name: 'AbortError' });
  assert.equal(dispatcher.closed, true);
  assert.equal(getGlobalDispatcher(), inherited);
  controller.abort();
  let called = false;
  await assert.rejects(runWithTransport({ ...context(), signal: controller.signal }, () => { called = true; }), { name: 'AbortError' });
  assert.equal(called, false);
});

test('body failures are sanitized and standalone fetch retains ownership until consumed', async () => {
  let dispatcher;
  globalThis.fetch = undici.fetch = async (_url, init) => {
    dispatcher = init.dispatcher;
    return new Response(new ReadableStream({ pull(controller) { controller.error(new Error('secret proxy URL')); } }));
  };
  await runWithTransport(context(), async () => {
    const response = await providerFetch('https://example.test');
    await assert.rejects(response.text(), { code: 'PROXY_UNAVAILABLE' });
  });
  const calls = recordFetch();
  const response = await accountScope.run(context(), () => providerFetch('https://example.test'));
  dispatcher = calls[0].init.dispatcher;
  assert.equal(dispatcher.closed, false);
  assert.equal(await response.text(), 'ok');
  await disposeTransports();
  assert.equal(dispatcher.closed, true);
});

test('probe is fixed-target, unauthenticated, sanitized and rejects unsafe proxy origins', async () => {
  const calls = recordFetch();
  assert.deepEqual(await testProxy('http://127.0.0.1:12345'), { reachable: true, classification: 'reachable' });
  assert.equal(calls[0].url, 'https://www.googleapis.com/');
  assert.equal(calls[0].init.headers, undefined);
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal);
  assert.ok(calls[0].init.dispatcher.closed);
  for (const url of ['socks5://localhost:1', 'http://user:secret@localhost:1', 'http://localhost/path', 'http://localhost/?secret', 'http://localhost/#', 'http://localhost:99999']) {
    assert.deepEqual(await testProxy(url), { reachable: false, classification: 'invalid-proxy' });
  }
  assert.equal(calls.length, 1);
  globalThis.fetch = undici.fetch = async () => { throw new Error('secret'); };
  assert.deepEqual(await testProxy('http://localhost:1'), { reachable: false, classification: 'proxy-unavailable' });
});

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('real Undici CONNECT forwarder carries response body without external access', async () => {
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); };
  const target = http.createServer((_req, res) => { res.write('through '); setImmediate(() => res.end('proxy')); });
  target.on('connection', track);
  const targetPort = await listen(target);
  const connects = [];
  const proxy = http.createServer();
  proxy.on('connection', track);
  proxy.on('connect', (request, socket, head) => {
    connects.push(request.url);
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    track(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  try {
    await runWithTransport({ account: account('all', true, `http://127.0.0.1:${proxyPort}`), kind: 'api' }, async () => {
      const response = await providerFetch(`http://127.0.0.1:${targetPort}/test`);
      assert.equal(await response.text(), 'through proxy');
    });
    assert.deepEqual(connects, [`127.0.0.1:${targetPort}`]);
  } finally {
    await disposeTransports();
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, proxy].map(server => new Promise(resolve => server.close(resolve))));
  }
});
