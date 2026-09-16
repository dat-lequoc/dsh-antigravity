// Test 503 retry without model fallback, keeping exact model and retrying with delay
import fs from 'node:fs';

process.env.ANTIGRAVITY_BASE_URL = 'https://cloudcode-pa.googleapis.com';
process.env.ANTIGRAVITY_PROJECT_ID = 'aicode-consumers';
process.env.ANTIGRAVITY_RETRY_INITIAL_DELAY_MS = '20';
process.env.ANTIGRAVITY_RETRY_MAX_DELAY_MS = '50';

const mod = await import('./lib/index.js');

const tests = [];
function check(name, pass, detail = '') {
  tests.push({ name, pass: !!pass, detail });
}

const mockStore = {
  async read() {
    return { access: 'mock-token', refresh: 'mock-r', expires: Date.now() + 3600e3, email: 'u@example.com', projectId: 'aicode-consumers' };
  },
  async write() {},
  async modify(fn) { return fn(await this.read()); },
  async delete() {},
  path() { return '/tmp/mock-creds'; }
};

const mockSettings = {
  async read() {
    return { enabledModelIds: ['gemini-3.8-flash-tiered'], catalogModels: [] };
  }
};

function sseText(text) {
  return 'data: ' + JSON.stringify({
    candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 }
  }) + '\n\n';
}

const ERROR_503_BODY = JSON.stringify({
  error: {
    code: 503,
    status: 'UNAVAILABLE',
    message: 'This model has no capacity right now. Next: retry later or switch models.'
  }
});

// Test 1: 503 retries on the SAME model without model fallback
{
  console.log('Running Test 1: 503 retry without model fallback...');
  let callCount = 0;
  const modelsRequested = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('fetchAvailableModels')) {
      return new Response(JSON.stringify({ models: [{ modelId: 'gemini-3.8-flash-tiered', supportsImages: true }] }), { status: 200 });
    }
    callCount++;
    const body = init?.body ? JSON.parse(init.body) : {};
    modelsRequested.push(body?.model);

    if (callCount <= 4) {
      // 503 on both endpoints for attempt 1 and attempt 2
      return new Response(ERROR_503_BODY, { status: 503, headers: { 'content-type': 'application/json' } });
    }
    // Attempt 3 succeeds on the exact same model
    return new Response(sseText('Success on exact requested model!'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  const adapter = new mod.AntigravityAdapter(mockStore, mockSettings, () => undefined);
  let fullText = '';
  const notices = [];

  for await (const chunk of adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash-tiered',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
  })) {
    if (chunk.type === 'reasoning-delta' && chunk.text.includes('Antigravity Notice:')) {
      notices.push(chunk.text);
    }
    if (chunk.type === 'text-delta') {
      fullText += chunk.text;
    }
  }

  check('1. Turn completed with success text', fullText === 'Success on exact requested model!', 'got: ' + fullText);
  check('1. All requests were on gemini-3.8-flash-tiered (NO model fallback)', modelsRequested.every(m => m === 'gemini-3.8-flash-tiered'), 'models: ' + modelsRequested.join(', '));
  check('1. Retried across multiple attempts', callCount > 2, 'calls: ' + callCount);
  check('1. No retry diagnostics leaked into assistant output', notices.length === 0, 'notices: ' + notices.length);
}

// Test 2: Instant cancellation during sleep
{
  console.log('Running Test 2: Immediate abort during sleep...');
  process.env.ANTIGRAVITY_RETRY_INITIAL_DELAY_MS = '60000'; // Set to 1 min
  globalThis.fetch = async () => new Response(ERROR_503_BODY, { status: 503, headers: { 'content-type': 'application/json' } });

  const controller = new AbortController();
  const adapter = new mod.AntigravityAdapter(mockStore, mockSettings, () => undefined);
  let abortedCleanly = false;
  const start = Date.now();
  try {
    const stream = adapter.stream({
      provider: 'antigravity',
      model: 'gemini-3.8-flash-tiered',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 50);
    for await (const chunk of stream) {}
  } catch (e) {
    abortedCleanly = e?.code === 'ABORTED' || e?.message?.includes('aborted');
  }
  const duration = Date.now() - start;

  check('2. Cancelled cleanly without waiting full 60s', abortedCleanly);
  check('2. Fast cancellation duration', duration < 2000, 'duration: ' + duration + 'ms');
}

// Test 3: Exhausted retries report clear error
{
  console.log('Running Test 3: Terminal error after max retries...');
  process.env.ANTIGRAVITY_RETRY_INITIAL_DELAY_MS = '10';
  process.env.ANTIGRAVITY_MAX_RETRIES = '3';
  globalThis.fetch = async () => new Response(ERROR_503_BODY, { status: 503, headers: { 'content-type': 'application/json' } });

  const adapter = new mod.AntigravityAdapter(mockStore, mockSettings, () => undefined);
  let err;
  try {
    for await (const c of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-3.8-flash-tiered',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })) {}
  } catch (e) {
    err = e;
  }

  check('3. Throws terminal error after retries', !!err);
  check('3. Terminal error mentions 503 and capacity', err?.message.includes('503') && err?.message.includes('capacity'));
}

// Network exceptions have no HTTP response, but must still enter the retry loop.
{
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls < 3) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    return new Response(sseText('Recovered'), { headers: { 'content-type': 'text/event-stream' } });
  };
  const adapter = new mod.AntigravityAdapter(mockStore, mockSettings, () => undefined);
  const chunks = [];
  for await (const chunk of adapter.stream({ provider: 'antigravity', model: 'gemini-3.8-flash-tiered', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) chunks.push(chunk);
  check('4. Recovers from fetch failed after two network failures', calls === 3);
  check('4. Network retries remain silent', !chunks.some(c => c.type === 'reasoning-delta'));
}

console.log('\n=== Results ===');
let pass = 0, fail = 0;
for (const t of tests) {
  if (t.pass) pass++; else fail++;
  console.log((t.pass ? 'PASS ' : 'FAIL ') + t.name + (t.pass ? '' : '   -> ' + t.detail));
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);