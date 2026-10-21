const CACHE = 'xueqiu-assistant-static-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || request.mode === 'navigate') return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(request);
    const network = fetch(request).then((response) => { if (response.ok) void cache.put(request, response.clone()); return response; });
    return cached || network;
  }));
});
