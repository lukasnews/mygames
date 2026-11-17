// Service Worker: macht die App offline nutzbar.
// Bei jeder Änderung an den Dateien die Versionsnummer erhöhen.
const VERSION = 'spieleliste-v1';
const DATEIEN = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './spiele.json',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(DATEIEN)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((namen) => Promise.all(namen.filter((n) => n !== VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Erst aus dem Speicher antworten (schnell, offline), im Hintergrund aktualisieren.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const gespeichert = await cache.match(req, { ignoreSearch: true });
      const netz = fetch(req)
        .then((antwort) => {
          if (antwort.ok) cache.put(req, antwort.clone());
          return antwort;
        })
        .catch(() => null);
      if (gespeichert) {
        e.waitUntil(netz);
        return gespeichert;
      }
      const antwort = await netz;
      if (antwort) return antwort;
      if (req.mode === 'navigate') return cache.match('./index.html');
      return new Response('Offline', { status: 503 });
    })
  );
});
