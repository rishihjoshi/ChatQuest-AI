/**
 * ChatQuest-AI — the only module that knows how /api/chat speaks.
 *
 * app.js calls streamChat() and receives plain text deltas. It has no idea that
 * OpenRouter exists, what SSE looks like, or how errors are framed upstream.
 */

const ENDPOINT = '/api/chat';

export class ChatError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ChatError';
    this.code = code || 'unknown';
  }
}

/**
 * Stream one model's reply.
 *
 * @param {object}   options
 * @param {string}   options.model      Allow-listed model ID.
 * @param {Array<{role:string,content:string}>} options.messages  That model's own history.
 * @param {AbortSignal} [options.signal]
 * @param {(text:string) => void} options.onDelta  Called per token chunk.
 * @param {(info:{finish:string|null, usage:object|null}) => void} [options.onDone]
 * @returns {Promise<void>} Resolves when the stream completes; rejects with ChatError.
 */
export async function streamChat({ model, messages, signal, onDelta, onDone }) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    // Offline, DNS failure, or the request never left the device.
    throw new ChatError(
      navigator.onLine ? 'Could not reach the server.' : 'You’re offline — chat needs a connection.',
      navigator.onLine ? 'network_error' : 'offline',
    );
  }

  if (!response.ok) throw await readErrorResponse(response);

  // A non-streaming body would mean the server fell back; handle it gracefully.
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const payload = await response.json().catch(() => null);
    if (typeof payload?.content === 'string') {
      onDelta(payload.content);
      onDone?.({ finish: payload.finish ?? null, usage: payload.usage ?? null });
      return;
    }
    throw new ChatError('The server returned an unexpected response.', 'bad_response');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const rawLine of frame.split('\n')) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;

          let event;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }

          if (event.type === 'delta') onDelta(event.text);
          else if (event.type === 'done') onDone?.({ finish: event.finish ?? null, usage: event.usage ?? null });
          else if (event.type === 'error') throw new ChatError(event.message, event.code);
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* the stream is already finished or aborted */
    }
  }
}

async function readErrorResponse(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON error body — fall through to the status-based message */
  }

  if (payload?.error) return new ChatError(payload.error, payload.code);

  if (response.status === 403) return new ChatError('This request was rejected by the server.', 'forbidden');
  if (response.status === 429) return new ChatError('Rate limited. Try again in a moment.', 'rate_limited');
  if (response.status >= 500) return new ChatError('The server had a problem with this model.', 'server_error');
  return new ChatError(`Request failed (${response.status}).`, 'http_error');
}
