/* ChatQuest-AI service worker — offline app shell only.
 *
 * BUILD_VERSION is rewritten by scripts/generate-version.js at build time from
 * the same source as /version.json. It keys the cache name, so every deploy
 * gets a brand-new cache and the old shell is deleted on activate. Do not
 * hand-edit it — the placeholder below is only what the dev server sees. */

const BUILD_VERSION = 'dev';
const CACHE_NAME = `chatquest-${BUILD_VERSION}`;

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/styles.css',
  '/js/app.js',
  '/js/api-client.js',
  '/js/models.js',
  '/js/markdown.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // addAll is all-or-nothing; cache entries individually so one missing
      // asset can't stop the whole shell from being installed.
      .then((cache) => Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// The update banner nudges a parked worker through this.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Anything that isn't a plain GET (i.e. every /api/chat call) goes straight
  // to the network, uncached.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache the API or the version probe. If the network is down these
  // must fail fast and visibly rather than resolve from a stale cache.
  if (url.pathname.startsWith('/api/') || url.pathname === '/version.json') return;

  // Navigations: network-first so a fresh deploy is picked up immediately,
  // falling back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html').then((cached) => cached || caches.match('/'))),
    );
    return;
  }

  // Static assets: cache-first. The version-keyed cache name means a new build
  // never reads the previous build's files.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
