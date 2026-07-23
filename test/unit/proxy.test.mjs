/**
 * Unit tests for api/chat.js — the OpenRouter proxy.
 *
 * OpenRouter is stubbed via globalThis.fetch, so these run offline, cost
 * nothing, and never need a real API key.
 *
 * The handler is a standard Web-API edge function (Request in, Response out),
 * which is why it can be exercised directly in Node.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/chat.js';

const TEST_KEY = 'sk-or-v1-UNIT-TEST-KEY';
const VALID = { model: 'anthropic/claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] };

const realFetch = globalThis.fetch;
let savedKey;

beforeEach(() => {
  savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = TEST_KEY;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
  delete process.env.ALLOWED_ORIGINS;
});

/**
 * Minimal Request stand-in. Node forbids setting the `host` header on a real
 * Request, and the origin check depends on it.
 */
function req({ method = 'POST', origin = 'https://app.test', referer, host = 'app.test', body } = {}) {
  const headers = new Map();
  if (origin) headers.set('origin', origin);
  if (referer) headers.set('referer', referer);
  if (host) headers.set('host', host);
  return {
    method,
    signal: new AbortController().signal,
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  };
}

function sseUpstream(frames) {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

async function readEvents(response) {
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 2);
      if (line.startsWith('data:')) events.push(JSON.parse(line.slice(5)));
    }
  }
  return events;
}

const deltasOf = (events) => events.filter((e) => e.type === 'delta').map((e) => e.text).join('');

// ─────────────────────────────────────────────────────────────────────────────

describe('method and origin gating', () => {
  test('rejects anything but POST', async () => {
    assert.equal((await handler(req({ method: 'GET' }))).status, 405);
  });

  test('answers the preflight without touching upstream', async () => {
    assert.equal((await handler(req({ method: 'OPTIONS' }))).status, 204);
  });

  test('rejects a bare curl with no Origin and no Referer', async () => {
    assert.equal((await handler(req({ origin: null, referer: null, body: VALID }))).status, 403);
  });

  test('rejects a foreign Origin', async () => {
    assert.equal((await handler(req({ origin: 'https://evil.example', body: VALID }))).status, 403);
  });

  test('accepts the deployment’s own host', async () => {
    // 503 (no upstream stub needed) proves the origin check passed.
    globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    const r = await handler(req({ body: { ...VALID, stream: false } }));
    assert.notEqual(r.status, 403);
  });

  test('falls back to the Referer origin when Origin is absent', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const r = await handler(req({ origin: null, referer: 'https://app.test/page', body: VALID }));
    assert.equal(r.status, 503, 'should have passed the origin check and hit the missing-key branch');
  });

  test('honours ALLOWED_ORIGINS', async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.ALLOWED_ORIGINS = 'https://custom.example';
    const r = await handler(req({ origin: 'https://custom.example', body: VALID }));
    assert.equal(r.status, 503);
  });

  describe('localhost exemption', () => {
    test('accepts localhost when the request arrived at localhost', async () => {
      delete process.env.OPENROUTER_API_KEY;
      const r = await handler(req({ origin: 'http://localhost:3000', host: 'localhost:3000', body: VALID }));
      assert.equal(r.status, 503);
    });

    test('accepts 127.0.0.1 when the request arrived at 127.0.0.1', async () => {
      delete process.env.OPENROUTER_API_KEY;
      const r = await handler(req({ origin: 'http://127.0.0.1:5500', host: '127.0.0.1:5500', body: VALID }));
      assert.equal(r.status, 503);
    });

    // Regression: a spoofed localhost Origin used to bypass the gate entirely
    // on the deployed site, which defeated the whole quota protection.
    test('rejects a spoofed localhost Origin against a deployed host', async () => {
      const r = await handler(req({ origin: 'http://localhost:3000', host: 'app.test', body: VALID }));
      assert.equal(r.status, 403);
    });

    test('rejects a spoofed 127.0.0.1 Origin against a deployed host', async () => {
      const r = await handler(req({ origin: 'http://127.0.0.1', host: 'app.test', body: VALID }));
      assert.equal(r.status, 403);
    });

    test('rejects a spoofed localhost Referer against a deployed host', async () => {
      const r = await handler(req({ origin: null, referer: 'http://localhost:3000/', host: 'app.test', body: VALID }));
      assert.equal(r.status, 403);
    });
  });
});

describe('request validation', () => {
  const cases = [
    ['unlisted model', { model: 'evil/not-real', messages: [{ role: 'user', content: 'x' }] }, 400, 'model_not_allowed'],
    ['missing model', { messages: [{ role: 'user', content: 'x' }] }, 400, 'model_not_allowed'],
    ['empty messages', { model: VALID.model, messages: [] }, 400, 'bad_request'],
    ['messages not an array', { model: VALID.model, messages: 'hi' }, 400, 'bad_request'],
    ['invalid role', { model: VALID.model, messages: [{ role: 'root', content: 'x' }] }, 400, 'bad_request'],
    ['non-string content', { model: VALID.model, messages: [{ role: 'user', content: 123 }] }, 400, 'bad_request'],
    ['null message', { model: VALID.model, messages: [null] }, 400, 'bad_request'],
  ];

  for (const [name, body, status, code] of cases) {
    test(`rejects ${name}`, async () => {
      const response = await handler(req({ body }));
      assert.equal(response.status, status);
      assert.equal((await response.json()).code, code);
    });
  }

  test('rejects too many messages', async () => {
    const messages = Array.from({ length: 61 }, () => ({ role: 'user', content: 'x' }));
    assert.equal((await handler(req({ body: { model: VALID.model, messages } }))).status, 413);
  });

  test('rejects an oversized payload', async () => {
    const messages = [{ role: 'user', content: 'x'.repeat(200_001) }];
    assert.equal((await handler(req({ body: { model: VALID.model, messages } }))).status, 413);
  });

  test('rejects an unparseable body', async () => {
    assert.equal((await handler(req({ body: undefined }))).status, 400);
  });

  test('an unlisted model never reaches OpenRouter', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response('{}', { status: 200 });
    };
    await handler(req({ body: { model: 'evil/not-real', messages: [{ role: 'user', content: 'x' }] } }));
    assert.equal(called, false, 'the proxy forwarded an unvetted model id upstream');
  });
});

describe('upstream request shape', () => {
  test('sends the key and attribution headers, and only role/content', async () => {
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await handler(
      req({
        body: {
          ...VALID,
          stream: false,
          messages: [{ role: 'user', content: 'hi', injected: 'should be dropped' }],
        },
      }),
    );

    assert.equal(seen.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(seen.init.headers.Authorization, `Bearer ${TEST_KEY}`);
    assert.equal(seen.init.headers['HTTP-Referer'], 'https://app.test');
    assert.equal(seen.init.headers['X-Title'], 'ChatQuest-AI');
    assert.deepEqual(Object.keys(JSON.parse(seen.init.body).messages[0]), ['role', 'content']);
  });
});

describe('upstream error handling', () => {
  const mappings = [
    [429, 429, 'rate_limited'],
    [402, 400, 'insufficient_credits'],
    [404, 400, 'model_unavailable'],
    [401, 400, 'upstream_auth'],
    [500, 502, 'upstream_error'],
    [503, 502, 'upstream_error'],
  ];

  for (const [upstreamStatus, expectedStatus, expectedCode] of mappings) {
    test(`maps upstream ${upstreamStatus} to ${expectedStatus} ${expectedCode}`, async () => {
      globalThis.fetch = async () => new Response('upstream detail', { status: upstreamStatus });
      const response = await handler(req({ body: VALID }));
      assert.equal(response.status, expectedStatus);
      assert.equal((await response.json()).code, expectedCode);
    });
  }

  test('never leaks the raw upstream body or the API key', async () => {
    const leak = `RAW LEAK ${TEST_KEY} internal stack trace`;
    globalThis.fetch = async () => new Response(leak, { status: 429 });
    const body = await (await handler(req({ body: VALID }))).text();
    assert.ok(!body.includes('RAW LEAK'), body);
    assert.ok(!body.includes('sk-or-'), body);
  });

  test('maps a network failure to 502', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('network down');
    };
    const response = await handler(req({ body: VALID }));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'network_error');
  });

  test('reports a missing key as 503 without naming the variable', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const response = await handler(req({ body: VALID }));
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.code, 'not_configured');
    assert.ok(!/OPENROUTER|process|env/i.test(payload.error), payload.error);
  });
});

describe('non-streaming responses', () => {
  test('returns a clean {content, finish, usage} with no OpenRouter shape', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hello world' }, finish_reason: 'stop' }],
          usage: { total_tokens: 9 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const payload = await (await handler(req({ body: { ...VALID, stream: false } }))).json();
    assert.deepEqual(payload, { content: 'hello world', finish: 'stop', usage: { total_tokens: 9 } });
    assert.ok(!('choices' in payload));
  });

  test('rejects a malformed upstream body', async () => {
    globalThis.fetch = async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } });
    assert.equal((await handler(req({ body: { ...VALID, stream: false } }))).status, 502);
  });
});

describe('streaming translation', () => {
  test('translates OpenRouter SSE into delta/done events', async () => {
    globalThis.fetch = async () =>
      sseUpstream([
        ': OPENROUTER PROCESSING\n\n',
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":4}}\n\n',
        'data: [DONE]\n\n',
      ]);

    const response = await handler(req({ body: VALID }));
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.match(response.headers.get('cache-control'), /no-store/);

    const events = await readEvents(response);
    assert.equal(deltasOf(events), 'Hello');
    assert.equal(events.filter((e) => e.type === 'delta').length, 2, 'deltas must stay separate, not be concatenated');

    const done = events.find((e) => e.type === 'done');
    assert.equal(done.finish, 'stop');
    assert.equal(done.usage.total_tokens, 4);
  });

  test('reassembles a frame split across chunk boundaries', async () => {
    globalThis.fetch = async () =>
      sseUpstream([
        'data: {"choices":[{"delta":{"cont',
        'ent":"split"}}]}\n',
        '\ndata: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
      ]);
    assert.equal(deltasOf(await readEvents(await handler(req({ body: VALID })))), 'split!');
  });

  test('skips a malformed frame without killing the stream', async () => {
    globalThis.fetch = async () =>
      sseUpstream([
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
        'data: {not json\n\n',
        'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
      ]);
    assert.equal(deltasOf(await readEvents(await handler(req({ body: VALID })))), 'ab');
  });

  test('reports a mid-stream failure in-band, preserving partial text', async () => {
    // The HTTP status is already 200 by then, so the only way to signal the
    // failure is an in-band event.
    let delivered = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (!delivered) {
              delivered = true;
              controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
            } else {
              controller.error(new Error('connection reset'));
            }
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );

    const events = await readEvents(await handler(req({ body: VALID })));
    assert.equal(deltasOf(events), 'partial');
    assert.ok(events.some((e) => e.type === 'error' && e.code === 'stream_interrupted'));
  });
});
