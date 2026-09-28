// App shell cache. Data lives in IndexedDB (see app.js), so the app opens and records visits with no signal.
const SHELL = 'booth-shell-v1';
const FILES = ['/w/', '/w/index.html', '/w/app.js', '/w/manifest.webmanifest', '/w/icon.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/w/')) {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
  }
});
