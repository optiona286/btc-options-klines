'use strict';
const VERSION = 'btc-options-pwa-v6-opening-reference';
const SHELL = VERSION + '-shell';
const DATA = VERSION + '-data';
const BASE = new URL('./', self.location.href);
const SHELL_PATHS = ['./', './index.html', './static-api.js', './pwa.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];
const SHELL_URLS = new Set(SHELL_PATHS.map(path => new URL(path, BASE).href));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll([...SHELL_URLS])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('btc-options-pwa-') && ![SHELL, DATA].includes(key)).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  const isNavigation = request.mode === 'navigate';
  const isData = ['data', 'data1'].some(mode => url.pathname.startsWith(new URL('./' + mode + '/', BASE).pathname));
  const canonical = new URL(url.pathname, BASE.origin).href;
  if (!isNavigation && !isData && !SHELL_URLS.has(canonical)) return;
  event.respondWith((async () => {
    const cache = await caches.open(isData ? DATA : SHELL);
    const key = isNavigation ? new URL('./index.html', BASE).href : isData ? request.url : canonical;
    try {
      const response = await fetch(request);
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil((async () => {
          try {
            await cache.put(key, copy);
            if (isData) {
              const keys = await cache.keys();
              // Limit large historical datasets; keep the date manifest as well.
              const datasets = keys.filter(item => !new URL(item.url).pathname.endsWith('/manifest.json'));
              await Promise.all(datasets.slice(0, Math.max(0, datasets.length - 6)).map(item => cache.delete(item)));
            }
          } catch { /* Storage limits must not prevent online use. */ }
        })());
        return response;
      }
      // Server errors remain visible; only a connection failure uses cached data.
      return response;
    } catch (error) {
      const cached = await cache.match(key);
      if (cached) return cached;
      if (isNavigation) return new Response('<!doctype html><meta charset="utf-8"><h1>目前離線</h1><p>請先連線開啟一次 BTC K 線 App。</p>', {headers:{'Content-Type':'text/html; charset=utf-8'},status:503});
      throw error;
    }
  })());
});
