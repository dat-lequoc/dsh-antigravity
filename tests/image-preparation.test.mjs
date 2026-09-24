import test from 'node:test';
import assert from 'node:assert/strict';
import * as mod from '../lib/index.js';

test('AntigravityAdapter correctly derives ImageRequestTarget with positive integer width, height, and maxBytes', async () => {
  let passedTarget = null;
  const mockAttachments = {
    async readImageRequest(ref, target, signal) {
      passedTarget = target;
      assert(Number.isSafeInteger(target.width) && target.width > 0, 'target.width must be a positive integer');
      assert(Number.isSafeInteger(target.height) && target.height > 0, 'target.height must be a positive integer');
      assert(Number.isSafeInteger(target.maxBytes) && target.maxBytes > 0, 'target.maxBytes must be a positive integer');
      return {
        mediaType: 'image/png',
        bytes: 52301,
        data: Buffer.from('fake-png-bytes'),
      };
    },
  };

  const accountStore = {
    async read() {
      return { access: 'mock-token', projectId: 'mock-project', expires: Date.now() + 3600e3 };
    },
    async capture() {
      return this;
    },
    async modify(fn) {
      return this.read();
    },
  };
  const modelSettings = {
    async read() {
      return {
        enabledModelIds: ['gemini-3.8-flash-tiered'],
        catalogModels: [{
          id: 'gemini-3.8-flash-tiered',
          name: 'Gemini 3.8 Flash Tiered',
          inputModalities: ['text', 'image'],
          reasoningEfforts: ['high'],
        }],
      };
    },
  };

  const adapter = new mod.AntigravityAdapter(accountStore, modelSettings, () => mockAttachments);

  // Mock global fetch to return an empty stream
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response('data: {"candidates":[{"content":{"parts":[{"text":"Hello!"}]}}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  try {
    const stream = adapter.stream({
      provider: 'antigravity',
      model: 'gemini-3.8-flash-tiered',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Check this image' },
            {
              type: 'image',
              attachment: {
                attachmentId: 'sha256:test1234',
                mediaType: 'image/png',
                bytes: 52301,
                width: 612,
                height: 792,
                name: 'test_mod.png',
              },
            },
          ],
        },
      ],
    });

    for await (const chunk of stream) {}

    assert.notEqual(passedTarget, null, 'readImageRequest was called');
    assert.equal(passedTarget.width, 612);
    assert.equal(passedTarget.height, 792);
    assert.equal(passedTarget.maxBytes, 4194304);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AntigravityAdapter session does not break if readImageRequest fails (graceful degradation)', async () => {
  const failingAttachments = {
    async readImageRequest() {
      throw new Error('Image file not found on disk or corrupt');
    },
  };

  const accountStore = {
    async read() {
      return { access: 'mock-token', projectId: 'mock-project', expires: Date.now() + 3600e3 };
    },
    async capture() {
      return this;
    },
    async modify(fn) {
      return this.read();
    },
  };
  const modelSettings = {
    async read() {
      return {
        enabledModelIds: ['gemini-3.8-flash-tiered'],
        catalogModels: [{
          id: 'gemini-3.8-flash-tiered',
          name: 'Gemini 3.8 Flash Tiered',
          inputModalities: ['text', 'image'],
        }],
      };
    },
  };

  const adapter = new mod.AntigravityAdapter(accountStore, modelSettings, () => failingAttachments);

  let sentBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sentBody = JSON.parse(init.body);
    return new Response('data: {"candidates":[{"content":{"parts":[{"text":"Turn completed"}]}}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  try {
    const stream = adapter.stream({
      provider: 'antigravity',
      model: 'gemini-3.8-flash-tiered',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Explain this image' },
            {
              type: 'image',
              attachment: {
                attachmentId: 'sha256:corrupt',
                mediaType: 'image/png',
                bytes: 1234,
                width: 100,
                height: 100,
                name: 'corrupted.png',
              },
            },
          ],
        },
      ],
    });

    let completed = false;
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && chunk.text.includes('Turn completed')) {
        completed = true;
      }
    }

    assert.equal(completed, true, 'Stream completed successfully despite image read failure');
    // Verify that the failed image was replaced with a text fallback in the sent body
    const parts = sentBody.request.contents[0].parts;
    assert(parts.some(p => p.text && p.text.includes('[image: corrupted.png]')), 'Fallback text included');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
