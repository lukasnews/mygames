# Meine Spiele

Kleine Web-App (PWA) zum Verwalten meiner Steam-Spiele: Bibliothek und Wunschliste,
mit Status, Notizen, Bewertungen, Zufallsvorschlag, Statistik, Sync zwischen Geräten
(Supabase) und Spielzeiten aus Steam.

Online: https://mygames.chaoten.online

- `index.html`, `styles.css`, `app.js` – die App (kein Build-Schritt nötig)
- `config.js` – Verbindung zu Supabase (optional)
- `spiele.json` – Startdaten beim ersten Öffnen
- `manifest.webmanifest`, `sw.js`, `icons/` – Installation und Offline-Betrieb
- `vendor/supabase.js` – Supabase-Bibliothek (supabase-js 2.110.0, MIT-Lizenz)
- `supabase/` – Tabelle (`schema.sql`) und Steam-Funktion für Supabase
- `ANLEITUNG-SYNC.md` – Schritt für Schritt: Sync und Steam einrichten

Lokal ansehen: `python3 -m http.server 8000` im Ordner ausführen und http://localhost:8000 öffnen.

Nach Änderungen an den Dateien in `sw.js` die `VERSION` erhöhen – dann erscheint auf allen
Geräten „Neue Version verfügbar“.
