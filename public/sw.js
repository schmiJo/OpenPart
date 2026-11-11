// Keeps the app working offline: serve what's cached straight away, and refresh it in the background.
const CACHE = 'schmishape-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request);
      const fresh = fetch(e.request).then((r) => {
        if (r.ok) cache.put(e.request, r.clone());
        return r;
      });
      return cached ?? fresh;
    }),
  );
});
