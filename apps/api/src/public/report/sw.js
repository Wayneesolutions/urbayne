// App shell cache. Data lives in IndexedDB (see app.js), so the app opens and records numbers with no signal.
// Network first (so a new release reaches phones as soon as they have signal), the saved copy when the network is slow or gone.
const SHELL = 'results-shell-v4';
const FILES = ['/r/', '/r/index.html', '/r/app.js', '/r/manifest.webmanifest', '/r/icon.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !url.pathname.startsWith('/r/')) return;
  const saved = () => caches.match(e.request, { ignoreSearch: true });
  const network = fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
    return res;
  });
  const slow = new Promise((resolve) => setTimeout(resolve, 3000, null));
  e.respondWith(Promise.race([network, slow]).then((res) => res || saved().then((hit) => hit || network)).catch(() => saved()));
});
