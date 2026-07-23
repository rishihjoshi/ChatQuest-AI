/**
 * Integration tests: the proxy behind a real HTTP server.
 *
 * Unlike the unit tests, these call handler() through an actual socket with a
 * real fetch client, so they cover the parts the unit tests cannot: header
 * plumbing, chunked transfer, and whether tokens genuinely arrive incrementally
 * over the wire rather than in one buffered lump at the end.
 *
 * Only OpenRouter itself is stubbed. No API key and no network are required.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import handler from '../../api/chat.js';

const TEST_KEY = 'sk-or-v1-INTEGRATION-TEST-KEY';

let server;
let baseUrl;
const realFetch = globalThis.fetch;

/** Bridge Node's http req/res to the edge handler's Request/Response contract. */
function bridge(nodeReq, nodeRes) {
  const chunks = [];
  nodeReq.on('data', (c) => chunks.push(c));
  nodeReq.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const request = {
      method: nodeReq.method,
      signal: new AbortController().signal,
      headers: { get: (k) => nodeReq.headers[k.toLowerCase()] ?? null },
      json: async () => JSON.parse(raw),
    };

    let response;
    try {
      response = await handler(request);
    } catch (err) {
      nodeRes.writeHead(500).end(String(err));
      return;
    }

    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    nodeRes.writeHead(response.status, headers);

    if (!response.body) {
      nodeRes.end();
      return;
    }
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      nodeRes.write(Buffer.from(value));
    }
    nodeRes.end();
  });
}

before(async () => {
  server = createServer(bridge);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = TEST_KEY;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Post to the local proxy. `origin` defaults to a matching loopback origin. */
function post(body, { origin = '__match__', headers = {} } = {}) {
  const port = server.address().port;
  const finalHeaders = { 'Content-Type': 'application/json', ...headers };
  if (origin === '__match__') finalHeaders.Origin = `http://127.0.0.1:${port}`;
  else if (origin) finalHeaders.Origin = origin;
  return realFetch(`${baseUrl}/api/chat`, { method: 'POST', headers: finalHeaders, body: JSON.stringify(body) });
}

/** Stub OpenRouter with a stream that emits tokens on a timer. */
function stubStreamingUpstream(tokens, gapMs = 40) {
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          for (const token of tokens) {
            await new Promise((r) => setTimeout(r, gapMs));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`));
          }
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
}

const VALID = { model: 'anthropic/claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }], stream: true };

// ─────────────────────────────────────────────────────────────────────────────

describe('over a real socket', () => {
  test('a request with no Origin header is rejected', async () => {
    // This is the deployed-site `curl` case, end to end.
    const response = await post(VALID, { origin: null });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'forbidden');
  });

  test('a foreign Origin is rejected', async () => {
    assert.equal((await post(VALID, { origin: 'https://evil.example' })).status, 403);
  });

  test('an unlisted model is rejected with a clean error', async () => {
    const response = await post({ ...VALID, model: 'evil/not-real' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'That model is not on the allow-list.',
      code: 'model_not_allowed',
    });
  });

  test('streaming headers survive the trip', async () => {
    stubStreamingUpstream(['a'], 0);
    const response = await post(VALID);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.match(response.headers.get('cache-control'), /no-store/);
    await response.text();
  });

  test('tokens arrive incrementally, not buffered to the end', async () => {
    const tokens = ['Streaming ', 'arrives ', 'token ', 'by ', 'token', '.'];
    stubStreamingUpstream(tokens, 60);

    const response = await post(VALID);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const arrivals = [];
    const started = Date.now();
    let buffer = '';
    let text = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n\n')) !== -1) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 2);
        if (!line.startsWith('data:')) continue;
        const event = JSON.parse(line.slice(5));
        if (event.type === 'delta') {
          text += event.text;
          arrivals.push(Date.now() - started);
        }
      }
    }

    assert.equal(text, tokens.join(''));
    assert.equal(arrivals.length, tokens.length, 'each token should surface as its own event');

    // The decisive check: the first token must land well before the last. A
    // buffered response would deliver them all at essentially the same instant.
    const spread = arrivals[arrivals.length - 1] - arrivals[0];
    assert.ok(spread > 100, `tokens arrived within ${spread}ms — response looks buffered, not streamed`);
  });

  test('a slow stream does not block a concurrent fast one', async () => {
    // The whole architecture rests on per-request independence: the client
    // fires one of these per selected model, in parallel.
    const finished = [];

    globalThis.fetch = async (_url, init) => {
      const { model } = JSON.parse(init.body);
      const slow = model.startsWith('openai/');
      const tokens = slow ? ['s1', 's2', 's3', 's4'] : ['f1', 'f2'];
      const gap = slow ? 120 : 20;
      return new Response(
        new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            for (const token of tokens) {
              await new Promise((r) => setTimeout(r, gap));
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };

    const drain = async (model) => {
      const response = await post({ ...VALID, model });
      await response.text();
      finished.push(model);
    };

    await Promise.all([
      drain('openai/gpt-5.6-sol'),
      drain('google/gemini-3.6-flash'),
    ]);

    assert.equal(finished[0], 'google/gemini-3.6-flash', 'the fast model should finish first, unblocked by the slow one');
    assert.equal(finished.length, 2);
  });

  test('one model failing does not affect a parallel request', async () => {
    globalThis.fetch = async (_url, init) => {
      const { model } = JSON.parse(init.body);
      if (model.startsWith('meta-llama/')) return new Response('rate limit detail', { status: 429 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'fine' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const [failed, ok] = await Promise.all([
      post({ ...VALID, model: 'meta-llama/llama-3.3-70b-instruct', stream: false }),
      post({ ...VALID, model: 'anthropic/claude-sonnet-5', stream: false }),
    ]);

    assert.equal(failed.status, 429);
    assert.equal((await failed.json()).code, 'rate_limited');
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).content, 'fine');
  });

  test('an upstream failure body never reaches the client over the wire', async () => {
    globalThis.fetch = async () => new Response(`trace ${TEST_KEY} secret`, { status: 500 });
    const body = await (await post({ ...VALID, stream: false })).text();
    assert.ok(!body.includes('sk-or-'), body);
    assert.ok(!body.includes('trace'), body);
  });
});
