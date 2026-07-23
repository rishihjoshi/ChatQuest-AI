#!/usr/bin/env node
/**
 * Stamp the build identifier into every place that needs it.
 *
 * One source of truth per build:
 *   1. public/version.json          — what the server currently reports
 *   2. public/index.html            — window.__APP_VERSION__, the version the
 *                                     loaded page was actually built with
 *   3. public/service-worker.js     — BUILD_VERSION, which keys the cache name
 *
 * The client compares (2) against (1). Because both come from this one script
 * run, they can never drift the way two independently-fetched values can.
 *
 * Nothing here is hand-maintained — the identifier changes on every deploy by
 * construction, so it is impossible to ship a build with a stale version.
 *
 * Usage:
 *   node scripts/generate-version.js          stamp the current build
 *   node scripts/generate-version.js --reset  restore the "dev" placeholders
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reset = process.argv.includes('--reset');

function buildId() {
  // Vercel's build environment provides the commit SHA.
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (sha) return sha.slice(0, 12);

  // Local builds: fall back to the working-tree commit, then to a timestamp.
  try {
    return execSync('git rev-parse --short=12 HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return `t${Date.now().toString(36)}`;
  }
}

const version = reset ? 'dev' : buildId();

/** Replace a value in-place via regex, failing loudly if the anchor is gone. */
function stamp(relativePath, pattern, replacement) {
  const path = join(root, relativePath);
  const source = readFileSync(path, 'utf8');
  if (!pattern.test(source)) {
    throw new Error(`generate-version: could not find the version anchor in ${relativePath}`);
  }
  writeFileSync(path, source.replace(pattern, replacement), 'utf8');
}

stamp('public/index.html', /window\.__APP_VERSION__\s*=\s*"[^"]*"/, `window.__APP_VERSION__ = "${version}"`);
stamp('public/service-worker.js', /const BUILD_VERSION\s*=\s*'[^']*'/, `const BUILD_VERSION = '${version}'`);

writeFileSync(
  join(root, 'public/version.json'),
  `${JSON.stringify({ version, builtAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);

console.log(`[version] stamped build ${version}`);
