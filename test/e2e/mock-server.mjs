#!/usr/bin/env node
/**
 * Local harness for the E2E checks: serves public/ and a MOCK /api/chat that
 * streams fabricated tokens.
 *
 *   node test/e2e/mock-server.mjs [port]     # default 4321
 *
 * Why a mock rather than `vercel dev`: exercising the UI against real models
 * costs money on every run, and the interesting UI states (a model that
 * rate-limits, a model that is much slower than the others) are hard to
 * provoke on demand. This makes them deterministic and free.
 *
 *   - any "llama" model always returns 429   -> tests per-pane error isolation
 *   - gemini/haiku stream fast, openai slow  -> tests independent completion
 *   - replies contain XSS probes             -> must render as inert text
 *
 * Run `vercel dev` instead when you need to verify against the real proxy.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../public');
const PORT = Number(process.argv[2] || 4321);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-model behaviour, so the panes visibly differ from one another. */
function profile(model) {
  if (model.includes('llama')) return { mode: 'error' };
  if (model.includes('gemini')) return { mode: 'stream', delay: 25, lead: 100 };
  if (model.includes('haiku')) return { mode: 'stream', delay: 20, lead: 60 };
  if (model.includes('deepseek')) return { mode: 'stream', delay: 45, lead: 250 };
  if (model.includes('claude')) return { mode: 'stream', delay: 70, lead: 400 };
  return { mode: 'stream', delay: 130, lead: 1200 };
}

function reply(model) {
  const name = model.split('/')[1] || model;
  return `Here is **${name}** answering. Streaming token by token so you can watch each pane fill independently.

- first point from ${name}
- second point, a bit longer, to give the pane something to wrap
- third point

\`\`\`js
// a fenced block, to check code rendering mid-stream
const answer = ${JSON.stringify(name)};
console.log(answer);
\`\`\`

A closing paragraph with \`inline code\` and *emphasis*.

XSS probes (these must render as literal text, never execute):
<img src=x onerror="window.__XSS_IMG=1">
<script>window.__XSS_SCRIPT=1</script>
<a href="javascript:window.__XSS_HREF=1">link</a>
<div onclick="window.__XSS_DIV=1">div</div>`;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/chat') {
    if (req.method !== 'POST') return res.writeHead(405).end();

    let raw = '';
    for await (const chunk of req) raw += chunk;
    let model = '';
    try {
      ({ model } = JSON.parse(raw || '{}'));
    } catch {
      return res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad json","code":"bad_request"}');
    }

    const p = profile(model || '');
    console.log(`  -> ${model} (${p.mode})`);

    if (p.mode === 'error') {
      res.writeHead(429, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: 'Rate limited by OpenRouter. Try again in a moment.', code: 'rate_limited' }));
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
    });

    await sleep(p.lead); // time-to-first-token differs per model
    for (const token of reply(model).match(/\S+\s*/g)) {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ type: 'delta', text: token })}\n\n`);
      await sleep(p.delay);
    }
    res.write(`data: ${JSON.stringify({ type: 'done', finish: 'stop', usage: { total_tokens: 120 } })}\n\n`);
    return res.end();
  }

  // Static files out of public/
  let path = normalize(join(ROOT, url.pathname === '/' ? '/index.html' : url.pathname));
  if (!path.startsWith(ROOT)) return res.writeHead(403).end(); // path traversal guard

  try {
    if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    const headers = { 'content-type': TYPES[extname(path)] || 'application/octet-stream' };
    if (url.pathname === '/version.json') headers['cache-control'] = 'no-store, max-age=0, must-revalidate';
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(PORT, () => {
  console.log(`ChatQuest-AI mock server: http://localhost:${PORT}`);
  console.log('Paste test/e2e/browser-checks.js into DevTools, then: await chatQuestE2E()');
});
