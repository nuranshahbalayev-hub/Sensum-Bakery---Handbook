/* Sensum & Bakery — service worker (офлайн-режим)
   При обновлении приложения поднимите номер версии в CACHE, чтобы старый кэш очистился.
   Фото лежат в отдельном кэше IMG_CACHE: имя файла содержит хэш содержимого, поэтому
   кэш переживает обновления версий, а при замене фото появляется новый адрес. */
const CACHE = 'sensum-v1.86';
const IMG_CACHE = 'sensum-img';
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable.png', './apple-touch-icon.png'
];
const isImage = url => new URL(url).pathname.includes('/images/');

// Фото, которые сейчас использует index.html (берём из его же IMAGES-литерала)
async function currentImages() {
  const html = await (await fetch('./index.html', { cache: 'reload' })).text();
  return [...new Set(html.match(/images\/[a-z0-9]+\.[0-9a-f]{8}\.webp/g) || [])];
}

async function syncImages() {
  const cache = await caches.open(IMG_CACHE);
  const wanted = (await currentImages()).map(p => new URL(p, self.registration.scope).href);
  const have = new Set((await cache.keys()).map(r => r.url));
  await Promise.all([...have].filter(u => !wanted.includes(u)).map(u => cache.delete(u)));
  // докачиваем недостающее; сбой одного фото не должен ломать установку
  await Promise.allSettled(wanted.filter(u => !have.has(u)).map(u => cache.add(u)));
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
      .then(() => syncImages().catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE && k !== IMG_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const isDoc = req.mode === 'navigate' ||
                (req.headers.get('accept') || '').includes('text/html');
  if (isDoc) {
    // сеть в приоритете: онлайн — свежая версия, офлайн — из кэша
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
  } else {
    // остальное: кэш в приоритете (фото — в свой кэш)
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(isImage(req.url) ? IMG_CACHE : CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => r)));
  }
});
