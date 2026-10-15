'use strict';
const CACHE = 'btc-live-pwa-v1';
const BASE = new URL('./', self.location.href);
const PAGE = new URL('btc_usd_desktop_1h.html', BASE).href;
const ASSETS = [PAGE, 'pwa.js', 'pwa.css', 'manifest.webmanifest', 'vendor/lightweight-charts-4.2.3.js', '../icons/icon-192.png', '../icons/icon-512.png', '../icons/icon-maskable-512.png'].map(path => new URL(path, BASE).href);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('btc-live-pwa-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const key = url.origin + url.pathname;
  // Only cache this app's shell. Market APIs and other pages always use the network.
  if (request.method !== 'GET' || url.origin !== BASE.origin || !ASSETS.includes(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Keep the shell from the same release together until the user accepts an update.
    const cached = await cache.match(key);
    if (cached) return cached;
    return fetch(request);
  })());
});
