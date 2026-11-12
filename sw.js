/* Sensum & Bakery — service worker (офлайн-режим)
   При обновлении приложения поднимите номер версии в CACHE, чтобы старый кэш очистился.
   Фото лежат в отдельном кэше IMG_CACHE: имя файла содержит хэш содержимого, поэтому
   кэш переживает обновления версий, а при замене фото появляется новый адрес. */
const CACHE = 'sensum-v1.127';
const IMG_CACHE = 'sensum-img';
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable.png', './apple-touch-icon.png'
];
const DOC_WAIT = 3000; // сколько ждать страницу из сети, прежде чем открыть сохранённую
const SHELL = new URL('./index.html', self.registration.scope).href;
const isImage = url => new URL(url).pathname.includes('/images/');
// Only this app's files belong in the offline cache. API replies must reach the network.
const isAppAsset = url => {
  const u = new URL(url), base = new URL(self.registration.scope);
  return u.origin === base.origin && !u.search && (ASSETS.some(p => new URL(p, base).pathname === u.pathname) ||
    (u.pathname.startsWith(base.pathname + 'images/') && /\.[0-9a-f]{8}\.webp$/.test(u.pathname)));
};

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
    // мимо HTTP-кэша браузера: в новый кэш версии не должна попасть старая страница
    caches.open(CACHE).then(c => Promise.all(ASSETS.map(p => fetch(p, { cache: 'reload' }).then(res => {
      if (!res.ok) throw new Error(p + ': ' + res.status);
      return c.put(p, res);
    }))))
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
  if (req.method !== 'GET' || !isAppAsset(req.url)) return;
  const isDoc = req.mode === 'navigate' ||
                (req.headers.get('accept') || '').includes('text/html');
  if (isDoc) {
    // сеть в приоритете: онлайн — свежая версия, офлайн — из кэша. Если сеть не ответила за DOC_WAIT
    // (слабый Wi-Fi), открываем сохранённую страницу, а свежая докачивается в кэш к следующему запуску.
    let copy;
    const net = fetch(SHELL, { cache: 'no-cache' }).then(res => { if (res.ok) copy = res.clone(); return res; });
    const saved = () => caches.match('./index.html').then(r => r || caches.match('./'));
    e.waitUntil(net.then(() => copy && caches.open(CACHE).then(c => c.put('./index.html', copy))).catch(() => {}));
    e.respondWith(new Promise((resolve, reject) => {
      let done = false;
      const finish = r => { if (!done) { done = true; resolve(r); } };
      const timer = setTimeout(() => saved().then(r => { if (r) finish(r); }), DOC_WAIT);
      net.then(res => { clearTimeout(timer); finish(res); },
        err => { clearTimeout(timer); if (!done) saved().then(r => r ? finish(r) : reject(err)); });
    }));
  } else {
    // остальное: кэш в приоритете (фото — в свой кэш)
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
      if (res.ok) {
        const copy = res.clone();
        e.waitUntil(caches.open(isImage(req.url) ? IMG_CACHE : CACHE).then(c => c.put(req, copy)));
      }
      return res;
    }).catch(() => r)));
  }
});

// Открытая страница спрашивает, какая версия у воркера: если новее её самой, она предлагает обновиться.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'version' && e.ports && e.ports[0]) e.ports[0].postMessage({ version: CACHE.replace('sensum-v', '') });
});
