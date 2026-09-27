// Cross-origin isolation on hosts that cannot set headers (GitHub Pages).
// Adds COOP/COEP to every response so SharedArrayBuffer (multi-threaded WASM)
// becomes available. Registered by app.html only when the page is not already
// isolated; the page reloads once the worker controls it.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
  e.respondWith(fetch(r).then((res) => {
    if (res.status === 0) return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Embedder-Policy', 'credentialless');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }));
});
