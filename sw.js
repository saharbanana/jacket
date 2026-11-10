// Keeps the app shell available offline. Forecasts are never cached here: weather.js
// stores them with their timestamp, so stale weather is always labeled as stale.
const CACHE = 'jacket-shell-v8';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/engine.js', 'js/store.js', 'js/weather.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Serve from cache for speed and update in the background for the next launch.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/download/')) return; // Keep the APK and its page out of the app cache.
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(event.request, { ignoreSearch: true });
    const network = fetch(event.request).then(response => {
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    });
    if (cached) {
      network.catch(() => {});
      return cached;
    }
    return network;
  }));
});
