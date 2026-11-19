// Service Worker: macht die App offline nutzbar.
// WICHTIG: Bei jeder Änderung an den App-Dateien VERSION erhöhen –
// dann bekommt jedes Gerät den Hinweis „Neue Version verfügbar“.
const VERSION = 'spieleliste-v2.7.3';
const DATEIEN = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './spiele.json',
  './manifest.webmanifest',
  './vendor/supabase.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // Frisch vom Server holen (nicht aus dem Browser-Cache)
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(DATEIEN.map((url) => new Request(url, { cache: 'reload' })))));
  // Kein skipWaiting: Die neue Version wartet, bis du im Hinweis auf „Aktualisieren“ tippst.
});

self.addEventListener('message', (e) => {
  if (e.data?.typ === 'jetzt-aktivieren') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((namen) => Promise.all(namen.filter((n) => n.startsWith('spieleliste-') && n !== VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Zuerst aus dem Speicher dieser Version antworten (schnell und offline),
// sonst aus dem Netz. Fremde Adressen (Supabase, Steam) laufen direkt übers Netz.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const treffer = await cache.match(req, { ignoreSearch: true });
    if (treffer) return treffer;
    try {
      const antwort = await fetch(req);
      if (antwort.ok) cache.put(req, antwort.clone());
      return antwort;
    } catch {
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      return Response.error();
    }
  })());
});
