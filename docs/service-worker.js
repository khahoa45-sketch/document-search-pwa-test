'use strict';

const SCOPE_URL = new URL(self.registration.scope);
const INDEX_URL = new URL('index.html', SCOPE_URL);
const STATIC_URLS = [
  INDEX_URL.href,
  new URL('src/styles.css', SCOPE_URL).href,
  new URL('src/main.js', SCOPE_URL).href,
  new URL('manifest.webmanifest', SCOPE_URL).href
];
const STATIC_URL_SET = new Set(STATIC_URLS);
const CACHE_NAME = `document-search-pwa-shell:${encodeURIComponent(SCOPE_URL.href)}:v2`;
const LEGACY_CACHE_NAMES = ['document-search-pwa-shell-v1'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_URLS))
      .then(() => self.skipWaiting())
      .catch(error => caches.delete(CACHE_NAME).then(() => {
        throw error;
      }))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all(LEGACY_CACHE_NAMES.map(async name => {
      if (!(await caches.keys()).includes(name)) return;
      const cache = await caches.open(name);
      const keys = await cache.keys();
      const containsOnlyThisPwaAssets = keys.length > 0
        && keys.every(request => STATIC_URL_SET.has(request.url));
      if (containsOnlyThisPwaAssets) await caches.delete(name);
    }))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== SCOPE_URL.origin) return;

  const isAppRootNavigation = request.mode === 'navigate'
    && requestUrl.pathname === SCOPE_URL.pathname;
  const resourceUrl = isAppRootNavigation ? INDEX_URL.href : requestUrl.href;
  if (!STATIC_URL_SET.has(resourceUrl)) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(resourceUrl, { ignoreSearch: true });
      if (cached) return cached;
      return fetch(resourceUrl);
    })
  );
});
