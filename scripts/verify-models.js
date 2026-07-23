#!/usr/bin/env node
/**
 * Sanity-check the allow-list in public/js/models.js against OpenRouter's live
 * catalogue. Run this after editing the model list — a typo'd slug otherwise
 * shows up as a per-pane 404 at runtime instead of at edit time.
 *
 *   npm run verify
 *
 * Needs no API key: /api/v1/models is a public endpoint.
 */

import { MODELS, DEFAULT_MODEL_IDS, MAX_MODELS } from '../public/js/models.js';

const response = await fetch('https://openrouter.ai/api/v1/models');
if (!response.ok) {
  console.error(`Could not reach OpenRouter (${response.status}).`);
  process.exitCode = 1;
  throw new Error('catalogue fetch failed');
}

const catalogue = new Map((await response.json()).data.map((m) => [m.id, m]));
let failed = false;

for (const model of MODELS) {
  const live = catalogue.get(model.id);
  if (!live) {
    console.error(`  MISSING  ${model.id} — not in OpenRouter's catalogue`);
    failed = true;
    continue;
  }
  const inPrice = (Number(live.pricing.prompt) * 1e6).toFixed(2);
  const outPrice = (Number(live.pricing.completion) * 1e6).toFixed(2);
  console.log(`  ok       ${model.id.padEnd(38)} $${inPrice} in / $${outPrice} out per 1M tokens`);
}

const defaults = DEFAULT_MODEL_IDS.length;
if (defaults < 1 || defaults > MAX_MODELS) {
  console.error(`\nDefault selection is ${defaults} models — must be between 1 and ${MAX_MODELS}.`);
  failed = true;
}

const providers = new Set(MODELS.filter((m) => m.default).map((m) => m.provider));
if (providers.size !== defaults) {
  console.error('\nThe default selection should span distinct providers.');
  failed = true;
}

console.log(`\n${MODELS.length} models on the allow-list, ${defaults} pre-selected (${[...providers].join(', ')}).`);

// Set the code rather than calling process.exit() — an abrupt exit while fetch's
// sockets are still open crashes libuv on Windows.
process.exitCode = failed ? 1 : 0;
