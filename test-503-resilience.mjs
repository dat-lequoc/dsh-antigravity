// Comprehensive 503 Capacity Fault-Injection Test Suite
import fs from 'node:fs';

process.env.ANTIGRAVITY_BASE_URL = 'https://cloudcode-pa.googleapis.com';
process.env.ANTIGRAVITY_PROJECT_ID = 'aicode-consumers';

// Import from worktree-test via symlinked node_modules
const mod = await import('/home/nightfury/dsh-plugins/worktree-test/lib/index.js');

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
    return { enabledModelIds: ['gemini-3.8-flash-tiered', 'gemini-3.6-flash'], catalogModels: [] };
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

// ── Test 1: Transient 503 recovers on retry and shows error notice in stream ──
{
  console.log('Running Test 1: 503 retry recovery...');
  let callCount = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('fetchAvailableModels')) {
      return new Response(JSON.stringify({ models: [{ modelId: 'gemini-3.8-flash-tiered', supportsImages: true }] }), { status: 200 });
    }
    callCount++;
    if (callCount <= 2) {
      // Both endpoints fail on first candidate attempt
      return new Response(ERROR_503_BODY, { status: 503, headers: { 'content-type': 'application/json' } });
    }
    // Subsequent attempt recovers
    return new Response(sseText('Recovered successfully after 503!'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  const adapter = new mod.AntigravityAdapter(mockStore, mockSettings, () => undefined);
  const chunks = [];
  let fullText = '';
  let notices = [];

  for await (const chunk of adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash-tiered',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
  })) {
    chunks.push(chunk);
    if (chunk.type === 'reasoning-delta' && chunk.text.includes('Antigravity Notice:')) {
      notices.push(chunk.text);
    }
    if (chunk.type === 'text-delta') {
      fullText += chunk.text;
    }
  }

  check('1. Turn did not fail on 503', fullText === 'Recovered successfully after 503!', 'got: ' + fullText);
  check('1. Transient notice was emitted to reasoning block', notices.length > 0, 'notices: ' + notices.length);
  check('1. Notice mentions capacity/error', notices.some(n => n.includes('capacity') || n.includes('503') || n.includes('Notice:')));
  check('1. Retried multiple calls', callCount >= 3, 'calls: ' + callCount);
}

// ── Test 2: 503 triggers fallback to next model candidate ──
{
  console.log('Running Test 2: Model candidate fallback on capacity error...');
  const modelsRequested = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('fetchAvailableModels')) {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    const body = init?.body ? JSON.parse(init.body) : {};
    const model = body?.model || 'unknown';
    modelsRequested.push(model);

    if (model.includes('3.8')) {
      // Primary model 3.8 is overloaded (503)
      return new Response(ERROR_503_BODY, { status: 503, headers: { 'content-type': 'application/json' } });
    }
    // Fallback model (e.g. 3.6) succeeds
    return new Response(sseText('Hello from fallback model!'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  const adapter = new mod.AntigravityAdapter(mockStore, mockSettings, () => undefined);
  let fullText = '';
  let fallbackNotices = [];

  for await (const chunk of adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash-tiered',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
  })) {
    if (chunk.type === 'reasoning-delta' && chunk.text.includes('fallback model')) {
      fallbackNotices.push(chunk.text);
    }
    if (chunk.type === 'text-delta') {
      fullText += chunk.text;
    }
  }

  check('2. Fallback model succeeded', fullText === 'Hello from fallback model!', 'got: ' + fullText);
  check('2. Switched from 3.8 to fallback candidate', modelsRequested.some(m => !m.includes('3.8')), 'models: ' + modelsRequested.join(', '));
  check('2. Notice informed user about model switch', fallbackNotices.length > 0, 'notices: ' + fallbackNotices.length);
}

// ── Test 3: Persistent 503 across all retries throws terminal LlmError ──
{
  console.log('Running Test 3: Terminal 503 error after exhaustion...');
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('fetchAvailableModels')) {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    return new Response(ERROR_503_BODY, { status: 503, headers: { 'content-type': 'application/json' } });
  };

  const adapter = new mod.AntigravityAdapter(mockStore, mockSettings, () => undefined);
  let error;
  try {
    for await (const chunk of adapter.stream({
      provider: 'antigravity',
      model: 'gemini-3.8-flash-tiered',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })) {}
  } catch (e) {
    error = e;
  }

  check('3. Throws terminal LlmError', !!error, 'no error thrown');
  check('3. Error message contains 503 and diagnostic details', error?.message.includes('503') && error?.message.includes('capacity'), error?.message?.slice(0, 100));
}

// ── Test 4: AbortSignal cancellation during backoff ──
{
  console.log('Running Test 4: Cancellation during backoff...');
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
    // Abort shortly after first 503 failure
    setTimeout(() => controller.abort(), 80);
    for await (const chunk of stream) {}
  } catch (e) {
    abortedCleanly = e?.code === 'ABORTED' || e?.message?.includes('aborted');
  }
  const duration = Date.now() - start;

  check('4. Aborted cleanly without hanging in backoff', abortedCleanly);
  check('4. Fast abort duration', duration < 2000, 'duration: ' + duration + 'ms');
}

console.log('\n=== 503 Resilience Test Summary ===');
let pass = 0, fail = 0;
for (const t of tests) {
  if (t.pass) pass++; else fail++;
  console.log((t.pass ? 'PASS ' : 'FAIL ') + t.name + (t.pass ? '' : '   -> ' + t.detail));
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
