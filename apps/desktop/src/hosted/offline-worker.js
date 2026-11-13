/* global SHELL_ASSETS, SHELL_CACHE */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const remaining = [...SHELL_ASSETS];
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (remaining.length) {
            const path = remaining.shift();
            if (!path) continue;
            const response = await fetch(path, { credentials: 'omit', cache: 'reload' });
            if (!response.ok || response.redirected)
              throw new Error(`Offline shell fetch failed: ${path}`);
            await cache.put(path, response);
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const old = (await caches.keys()).filter(
        (name) => name.startsWith('dnaforge-hosted-shell-') && name !== SHELL_CACHE
      );
      await Promise.all(old.slice(0, -1).map((name) => caches.delete(name)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const shell = url.pathname === '/hosted.html';
  const asset = url.pathname.startsWith('/hosted/assets/') || url.pathname.startsWith('/assets/');
  if (!shell && !asset) return;
  event.respondWith(
    (async () => {
      if (shell) {
        try {
          return await fetch(event.request);
        } catch {
          const cached = await caches.match('/hosted.html', { cacheName: SHELL_CACHE });
          if (cached) return cached;
          throw new Error('The hosted app has not finished preparing offline access.');
        }
      }
      const cached = await caches.match(event.request);
      return cached ?? fetch(event.request);
    })()
  );
});
