# Meine Spiele

Kleine Web-App (PWA) zum Verwalten meiner Steam-Spiele: Bibliothek und Wunschliste,
mit Status, Notizen, Bewertungen, Zufallsvorschlag sowie Export/Import als JSON.

- `index.html`, `styles.css`, `app.js` – die App (kein Build-Schritt nötig)
- `spiele.json` – Startdaten beim ersten Öffnen
- `manifest.webmanifest`, `sw.js`, `icons/` – Installation auf dem Handy und Offline-Betrieb

Lokal ansehen: `python3 -m http.server 8000` im Ordner ausführen und http://localhost:8000 öffnen.

Nach Änderungen an den Dateien in `sw.js` die `VERSION` erhöhen, damit Handys die neue Version laden.
