// Keeps a copy of the app on the phone so it opens offline.
// Network first (so updates show right away), falling back to the saved copy
// when offline or the network is slow. Supabase API calls are never cached.
const CACHE = 'pcl-shell-v2';
const SHELL = ['./', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'apple-touch-icon.png', 'favicon.png',
  'vendor/supabase-2.45.4.js'];
const TIMEOUT = 3000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const cacheable = url => url.origin === self.location.origin || url.hostname === 'cdn.jsdelivr.net' || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!cacheable(url)) return; // Supabase and everything else go straight to the network
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? new URL('./', self.location).href : req;
    const net = fetch(req).then(res => { if (res && !res.redirected && (res.ok || res.type === 'opaque')) cache.put(key, res.clone()); return res; });
    const saved = await cache.match(key, {ignoreSearch: req.mode === 'navigate'});
    if (!saved) return net;
    // use the network if it answers quickly, otherwise the saved copy
    return Promise.race([net.catch(() => saved), new Promise(r => setTimeout(() => r(saved), TIMEOUT))]);
  })());
});
