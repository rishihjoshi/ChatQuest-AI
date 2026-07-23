/**
 * ChatQuest-AI — OpenRouter proxy (Vercel Edge Function).
 *
 * The OPENROUTER_API_KEY lives here and only here. It is never sent to the
 * browser, never echoed in a response body, and never logged.
 *
 * Contract (deliberately NOT OpenRouter's shape — the frontend knows only this):
 *
 *   POST /api/chat
 *   { "model": "<allow-listed id>",
 *     "messages": [{ "role": "user"|"assistant"|"system", "content": "..." }],
 *     "stream": true }
 *
 *   stream:true  -> text/event-stream of:
 *       data: {"type":"delta","text":"..."}
 *       data: {"type":"done","finish":"stop","usage":{...}}
 *       data: {"type":"error","message":"...","code":429}
 *   stream:false -> { "content": "...", "finish": "stop", "usage": {...} }
 *   failure      -> non-2xx + { "error": "clean message", "code": "slug" }
 *
 * ONE MODEL PER CALL. Fan-out is the client's job — it fires one request per
 * selected model in parallel so each pane streams and fails independently.
 */

import { MODEL_IDS } from '../public/js/models.js';

export const config = { runtime: 'edge' };

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const APP_TITLE = 'ChatQuest-AI';

/** Guard rails on the request body — cheap defence against a runaway client. */
const MAX_MESSAGES = 60;
const MAX_CHARS_TOTAL = 200_000;
const VALID_ROLES = new Set(['user', 'assistant', 'system']);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function jsonError(message, status, code) {
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Basic abuse protection: only serve requests that came from our own origin.
 *
 * This is not authentication — Origin is trivially spoofed by a non-browser
 * client. It exists to stop someone embedding our endpoint in *their* page and
 * burning our OpenRouter quota, which is the realistic threat for a public
 * unauthenticated proxy.
 *
 * Allowed: the host the request arrived on, VERCEL_URL, VERCEL_BRANCH_URL,
 * anything in the ALLOWED_ORIGINS env var (comma separated), and localhost.
 */
function allowedOrigins(request) {
  const allowed = new Set();
  const host = request.headers.get('host');
  if (host) allowed.add(`https://${host}`);

  for (const key of ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) {
    const value = process.env[key];
    if (value) allowed.add(value.startsWith('http') ? value : `https://${value}`);
  }

  for (const extra of (process.env.ALLOWED_ORIGINS || '').split(',')) {
    const trimmed = extra.trim();
    if (trimmed) allowed.add(trimmed.replace(/\/$/, ''));
  }
  return allowed;
}

function isSameOriginRequest(request) {
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');

  let candidate = origin;
  if (!candidate && referer) {
    try {
      candidate = new URL(referer).origin;
    } catch {
      candidate = null;
    }
  }
  // No Origin and no usable Referer => a direct curl/script hit. Reject.
  if (!candidate) return false;

  // Local development over http://localhost:* / http://127.0.0.1:*.
  //
  // This exemption is gated on the request having actually ARRIVED at a
  // localhost host. Accepting a localhost Origin unconditionally would let
  // anyone bypass the whole check against the deployed site with a one-line
  // curl -H 'Origin: http://localhost:3000', which is exactly the quota-burning
  // case this function exists to stop.
  try {
    const { hostname, protocol } = new URL(candidate);
    const isLoopback = (name) => name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
    if (protocol === 'http:' && isLoopback(hostname)) {
      const host = request.headers.get('host') || '';
      // Strip the port before comparing; Host carries one, hostname does not.
      const hostName = host.replace(/:\d+$/, '');
      return isLoopback(hostName);
    }
  } catch {
    return false;
  }

  return allowedOrigins(request).has(candidate.replace(/\/$/, ''));
}

/** Validate the body. Returns { ok, value } or { ok:false, message, status, code }. */
function parseBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, code: 'bad_request', message: 'Request body must be a JSON object.' };
  }

  const { model, messages, stream } = body;

  if (typeof model !== 'string' || !MODEL_IDS.has(model)) {
    // Never forward an unvetted string to OpenRouter.
    return { ok: false, status: 400, code: 'model_not_allowed', message: 'That model is not on the allow-list.' };
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, status: 400, code: 'bad_request', message: '`messages` must be a non-empty array.' };
  }
  if (messages.length > MAX_MESSAGES) {
    return { ok: false, status: 413, code: 'too_many_messages', message: 'Conversation is too long for one request.' };
  }

  let total = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      return { ok: false, status: 400, code: 'bad_request', message: 'Each message must be an object.' };
    }
    if (!VALID_ROLES.has(message.role) || typeof message.content !== 'string') {
      return { ok: false, status: 400, code: 'bad_request', message: 'Each message needs a valid `role` and a string `content`.' };
    }
    total += message.content.length;
  }
  if (total > MAX_CHARS_TOTAL) {
    return { ok: false, status: 413, code: 'payload_too_large', message: 'Conversation is too large for one request.' };
  }

  return {
    ok: true,
    value: {
      model,
      messages: messages.map(({ role, content }) => ({ role, content })),
      stream: stream !== false,
    },
  };
}

/** Map an upstream failure to a clean, non-leaky client message. */
function upstreamError(status) {
  if (status === 401 || status === 403) {
    return { code: 'upstream_auth', message: 'The server’s OpenRouter credentials were rejected.' };
  }
  if (status === 402) {
    return { code: 'insufficient_credits', message: 'OpenRouter reports insufficient credits for this model.' };
  }
  if (status === 404) {
    return { code: 'model_unavailable', message: 'This model is not currently available on OpenRouter.' };
  }
  if (status === 429) {
    return { code: 'rate_limited', message: 'Rate limited by OpenRouter. Try again in a moment.' };
  }
  if (status >= 500) {
    return { code: 'upstream_error', message: 'OpenRouter is having trouble with this model right now.' };
  }
  return { code: 'upstream_error', message: 'The model provider rejected this request.' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    // Same-origin only, so no CORS grants here — just answer the preflight.
    return new Response(null, { status: 204, headers: { allow: 'POST' } });
  }
  if (request.method !== 'POST') {
    return jsonError('Method not allowed. Use POST.', 405, 'method_not_allowed');
  }
  if (!isSameOriginRequest(request)) {
    return jsonError('Forbidden.', 403, 'forbidden');
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // Configuration problem, not a client problem — say so without detail.
    return jsonError('Server is not configured for chat requests.', 503, 'not_configured');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Request body must be valid JSON.', 400, 'bad_request');
  }

  const parsed = parseBody(body);
  if (!parsed.ok) return jsonError(parsed.message, parsed.status, parsed.code);

  const { model, messages, stream } = parsed.value;

  // Attribution headers — OpenRouter uses these for its app rankings.
  const host = request.headers.get('host');
  const referer = host ? `https://${host}` : 'https://chatquest-ai.vercel.app';

  let upstream;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': referer,
        'X-Title': APP_TITLE,
      },
      body: JSON.stringify({ model, messages, stream }),
      signal: request.signal,
    });
  } catch {
    return jsonError('Could not reach the model provider.', 502, 'network_error');
  }

  if (!upstream.ok) {
    // Drain (and discard) the upstream body so nothing from it reaches the client.
    try {
      await upstream.text();
    } catch {
      /* ignore */
    }
    const { code, message } = upstreamError(upstream.status);
    const status = upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : 400;
    return jsonError(message, status, code);
  }

  return stream ? streamResponse(upstream) : jsonResponse(upstream);
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-streaming
// ─────────────────────────────────────────────────────────────────────────────

async function jsonResponse(upstream) {
  let payload;
  try {
    payload = await upstream.json();
  } catch {
    return jsonError('The model returned a malformed response.', 502, 'bad_upstream_body');
  }

  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') {
    return jsonError('The model returned an empty response.', 502, 'empty_response');
  }

  return new Response(
    JSON.stringify({ content, finish: choice?.finish_reason ?? null, usage: payload?.usage ?? null }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming: translate OpenRouter SSE into our own event shape
// ─────────────────────────────────────────────────────────────────────────────

function streamResponse(upstream) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const send = (controller, event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

  const body = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let buffer = '';
      let finish = null;
      let usage = null;
      let closed = false;

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line; keep the trailing partial.
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            for (const rawLine of frame.split('\n')) {
              const line = rawLine.trim();
              // OpenRouter sends `: OPENROUTER PROCESSING` keep-alive comments.
              if (!line || line.startsWith(':')) continue;
              if (!line.startsWith('data:')) continue;

              const data = line.slice(5).trim();
              if (data === '[DONE]') {
                closed = true;
                break;
              }

              let chunk;
              try {
                chunk = JSON.parse(data);
              } catch {
                continue; // Ignore an unparseable frame rather than killing the stream.
              }

              if (chunk.usage) usage = chunk.usage;

              const choice = chunk.choices?.[0];
              if (!choice) continue;
              if (choice.finish_reason) finish = choice.finish_reason;

              const text = choice.delta?.content;
              if (typeof text === 'string' && text.length > 0) {
                send(controller, { type: 'delta', text });
              }
            }
            if (closed) break;
          }
          if (closed) break;
        }

        send(controller, { type: 'done', finish, usage });
      } catch {
        // Mid-stream failure: the HTTP status is already 200, so the only way to
        // report it is in-band. The client renders this in that pane alone.
        send(controller, { type: 'error', message: 'The model stopped responding partway through.', code: 'stream_interrupted' });
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        controller.close();
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
