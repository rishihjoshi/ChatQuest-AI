/**
 * ESLint flat config.
 *
 * Built-in rules only — no plugins, so `npm run lint` works with nothing
 * installed (npx fetches eslint on demand) and the project keeps its zero
 * committed dependencies.
 *
 * The rule set is weighted towards correctness over style: this codebase has no
 * type checker, so the linter is the only thing standing between a typo'd
 * global and a runtime error in one of the panes.
 */

const browser = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'writable',
  console: 'readonly',
  fetch: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  ReadableStream: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  AbortController: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  Image: 'readonly',
  performance: 'readonly',
  caches: 'readonly',
  getComputedStyle: 'readonly',
  XMLSerializer: 'readonly',
  FileReader: 'readonly',
};

const node = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  fetch: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  ReadableStream: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  AbortController: 'readonly',
  setTimeout: 'readonly',
};

const serviceWorker = {
  self: 'readonly',
  caches: 'readonly',
  clients: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
};

const rules = {
  // ── Correctness ──────────────────────────────────────────────────────────
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_' }],
  'no-const-assign': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-condition': ['error', { checkLoops: false }],
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-sparse-arrays': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  // Caught a genuine lost-stream bug once; worth the occasional false positive,
  // which is suppressed inline with a reason where it occurs.
  'require-atomic-updates': 'error',
  'no-async-promise-executor': 'error',
  'no-prototype-builtins': 'error',
  'no-shadow-restricted-names': 'error',
  'no-global-assign': 'error',

  // ── Security-adjacent ────────────────────────────────────────────────────
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-script-url': 'error',

  // ── Quality ──────────────────────────────────────────────────────────────
  eqeqeq: ['warn', 'smart'],
  'no-var': 'warn',
  'prefer-const': 'warn',
  'no-empty': ['warn', { allowEmptyCatch: true }],
  // Build scripts report progress on stdout; that is their interface.
  'no-console': 'off',
  // Sequential reads of a stream are the whole point in the proxy.
  'no-await-in-loop': 'off',
};

export default [
  { ignores: ['node_modules/**', '.vercel/**', 'public/version.json'] },
  {
    files: ['public/js/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: browser },
    rules,
  },
  {
    files: ['public/service-worker.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: serviceWorker },
    rules,
  },
  {
    files: ['api/**/*.js', 'scripts/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: node },
    rules,
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...node, ...browser } },
    rules,
  },
  {
    // Pasted into a DevTools console, so it is a classic script, not a module.
    files: ['test/e2e/browser-checks.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: browser },
    rules,
  },
];
