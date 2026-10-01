// Offline shell: serve the app from cache when the network is down. Only same-origin GETs are
// cached, keyed by pathname alone, so a URL carrying ?token= is never stored. API and MCP calls
// always go to the network.
const CACHE = 'docket-v2';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/manifest.webmanifest', '/icon.svg']))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api') || url.pathname.startsWith('/mcp')) return;
  // Every page is the same app shell; assets are keyed by their (hashed) path.
  const key = req.mode === 'navigate' ? '/' : url.pathname;
  e.respondWith(fetch(req).then(res => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key).then(r => r || caches.match('/'))));
});
