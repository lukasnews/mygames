'use strict';

/* =========================================================
   Meine Spiele – Bibliothek und Wunschliste
   Daten liegen im Browser (localStorage) und werden – falls
   eingerichtet – über Supabase zwischen Geräten abgeglichen.
   ========================================================= */

const APP_VERSION = '2.3.0';
const DATEN_KEY = 'spieleliste.daten.v1';
const ANSICHT_KEY = 'spieleliste.ansicht.v1';
const SYNC_KEY = 'spieleliste.sync.v1';
const STARTDATEN_URL = 'spiele.json';
const URALT = '1970-01-01T00:00:00.000Z';

const BEREICHE = {
  'Story-Wunsch': { liste: 'bibliothek', titel: 'Passt zu deinem Wunsch', text: 'Spannende Story, linear, nicht zu schwer' },
  'Für andere Laune': { liste: 'bibliothek', titel: 'Für andere Laune', text: 'Nach Genre sortiert' },
  'Wunschliste': { liste: 'wunschliste', titel: 'Wunschliste', text: 'Spiele, die du dir kaufen könntest' },
};
const BEREICHE_JE_LISTE = {
  bibliothek: ['Story-Wunsch', 'Für andere Laune'],
  wunschliste: ['Wunschliste'],
};
const STATUS_BIBLIOTHEK = ['offen', 'angefangen', 'durchgespielt', 'abgebrochen'];
const STATUS_TEXT = {
  offen: 'Offen', angefangen: 'Angefangen', durchgespielt: 'Durchgespielt',
  abgebrochen: 'Abgebrochen', gekauft: 'Gekauft',
};
const STATUS_RANG = { angefangen: 0, offen: 1, durchgespielt: 2, abgebrochen: 3 };
const ERLEDIGT = new Set(['durchgespielt', 'abgebrochen']);
const STANDARD_ZIEL_NACH_KAUF = 'Top: genau dein Ding';

// Name der Steam-Funktion, wie er in ihrer Adresse steht (…/functions/v1/<name>)
function steamFunktion() {
  return (window.SPIELE_CONFIG?.steamFunktion || 'steam-spielzeit').trim();
}
const STANDARD_TIPPS = {
  bibliothek: {
    titel: 'Start-Tipp',
    auto: true,
    text: 'Metro 2033 Redux für kurz und spannend, The Witcher 3 für eine große Story.',
  },
  wunschliste: {
    titel: 'Kauf-Tipp',
    auto: false,
    text: 'Zuerst The Last of Us Part I und Detroit: Become Human. Im Steam-Sale gibt es fast alles davon stark reduziert, also auf die Wunschliste setzen und abwarten.',
  },
};

let daten = null;
let ansicht = {
  reiter: 'bibliothek', status: '', kategorie: '', erledigteAus: false,
  zu: {}, wuerfelAuswahl: 'bereich:Story-Wunsch', wuerfelAngefangen: false,
  sortierung: 'eigene', kompakt: false,
};
let suchtext = '';
let reihenfolgeModus = false;
const aufgeklappt = new Set();   // Karten, die in der Kompaktansicht geöffnet sind

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

/* ---------- Hilfsfunktionen ---------- */

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (z) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[z]));
}

function jetzt() { return new Date().toISOString(); }

function zeitpunkt(wert, ersatz = URALT) {
  const d = new Date(wert);
  return wert && !isNaN(d) ? d.toISOString() : ersatz;
}

function neueId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function fuerSuche(text) {
  return String(text).toLocaleLowerCase('de').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Vergleichsschlüssel für Spielnamen (für Sync-Abgleich und Steam)
function namensSchluessel(text) {
  return fuerSuche(text).replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
}

function datumText(iso) {
  if (!iso) return 'noch nie';
  const d = new Date(iso);
  if (isNaN(d)) return 'unbekannt';
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// "105 min", "4,4 h", "8 h", "1.234,5 h" → Minuten
function spielzeitMinuten(text) {
  if (!text) return 0;
  const t = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  const m = t.match(/([\d.,]+)\s*(min|h|std)/);
  if (!m) return 0;
  const zahl = parseFloat(m[1].replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  if (isNaN(zahl)) return 0;
  return m[2] === 'min' ? Math.round(zahl) : Math.round(zahl * 60);
}

function spielzeitText(minuten) {
  if (!minuten) return null;
  if (minuten < 60) return `${minuten} min`;
  const h = minuten / 60;
  return `${h.toLocaleString('de-DE', { maximumFractionDigits: 1 })} h`;
}

function stundenText(minuten) {
  return `${Math.round(minuten / 60).toLocaleString('de-DE')} Std.`;
}

function kategorieVon(name) {
  return daten.kategorien.find((k) => k.name === name);
}

function listeVonBereich(bereich) {
  return BEREICHE[bereich]?.liste ?? null;
}

function steamLink(s) {
  return s.steamAppId
    ? `https://store.steampowered.com/app/${s.steamAppId}/`
    : `https://store.steampowered.com/search/?term=${encodeURIComponent(s.name.replace(/\(.*?\)/g, '').trim())}`;
}

function naechsteReihenfolge(kategorie) {
  const werte = daten.spiele.filter((s) => s.kategorie === kategorie).map((s) => s.reihenfolge);
  return werte.length ? Math.max(...werte) + 1 : 0;
}

/* ---------- Daten laden, prüfen, speichern ---------- */

// Wandelt alle Datei-Formate (Original-spiele.json, alter oder neuer Export) ins interne Format um.
function normalisieren(roh, { startdaten = false } = {}) {
  const spieleRoh = Array.isArray(roh) ? roh : roh?.spiele;
  if (!Array.isArray(spieleRoh)) throw new Error('Die Datei enthält keine Spieleliste.');
  const dokumentZeit = zeitpunkt(roh?.geaendert);

  const kategorien = [];
  const katNamen = new Map();
  const katHinzu = (k) => {
    if (!k?.name || katNamen.has(String(k.name))) return;
    let bereich = k.bereich;
    if (!BEREICHE[bereich]) bereich = k.liste === 'wunschliste' ? 'Wunschliste' : 'Für andere Laune';
    const kat = { name: String(k.name), info: String(k.info ?? k.kategorieInfo ?? ''), bereich, liste: listeVonBereich(bereich) };
    katNamen.set(kat.name, kat);
    kategorien.push(kat);
  };
  if (!Array.isArray(roh) && Array.isArray(roh.kategorien)) roh.kategorien.forEach(katHinzu);

  const spiele = [];
  const ids = new Set();
  spieleRoh.forEach((s, index) => {
    if (!s || typeof s.name !== 'string' || !s.name.trim()) return;
    const katName = String(s.kategorie || (s.liste === 'wunschliste' ? 'Wunschliste' : 'Ohne Kategorie'));
    if (!katNamen.has(katName)) katHinzu({ name: katName, info: s.kategorieInfo, bereich: s.bereich, liste: s.liste });
    const kat = katNamen.get(katName);

    let status = String(s.status || 'offen');
    if (kat.liste === 'wunschliste' || !STATUS_BIBLIOTHEK.includes(status)) status = 'offen';

    // Startdaten bekommen feste IDs, damit alle Geräte dieselben Spiele erkennen
    let id = s.id ? String(s.id) : (startdaten ? 'st-' + namensSchluessel(s.name) : neueId());
    while (ids.has(id)) id = startdaten ? id + '-2' : neueId();
    ids.add(id);

    const bewertung = Math.max(0, Math.min(5, Math.round(Number(s.bewertung) || 0)));
    const notiz = String(s.notiz ?? '');
    const appId = parseInt(s.steamAppId, 10);
    // Ältere Daten haben keinen Änderungszeitpunkt pro Spiel:
    // Spiele mit eigenen Angaben gelten als zuletzt mit dem Dokument geändert.
    const benutzt = status !== 'offen' || notiz || bewertung;
    const geaendert = zeitpunkt(s.geaendert, benutzt ? dokumentZeit : URALT);

    spiele.push({
      id,
      name: s.name.trim(),
      beschreibung: String(s.beschreibung ?? ''),
      spielzeit: s.spielzeit ? String(s.spielzeit) : null,
      liste: kat.liste,
      kategorie: kat.name,
      status,
      notiz,
      bewertung,
      reihenfolge: Number.isFinite(Number(s.reihenfolge)) && s.reihenfolge !== null && s.reihenfolge !== '' ? Number(s.reihenfolge) : index,
      steamAppId: appId > 0 ? appId : null,
      durchgespieltAm: status === 'durchgespielt' ? (s.durchgespieltAm ? zeitpunkt(s.durchgespieltAm) : null) : null,
      geaendert,
    });
  });
  if (!spiele.length) throw new Error('In der Datei wurden keine Spiele gefunden.');

  const geloescht = {};
  if (roh && typeof roh.geloescht === 'object' && !Array.isArray(roh.geloescht)) {
    for (const [id, zeit] of Object.entries(roh.geloescht)) geloescht[id] = zeitpunkt(zeit);
  }

  // Tipp-Kästen je Reiter (fehlen sie, gelten die Standard-Tipps)
  const tipps = {};
  for (const liste of Object.keys(STANDARD_TIPPS)) {
    const t = roh?.tipps?.[liste];
    const standard = STANDARD_TIPPS[liste];
    if (t && typeof t === 'object') {
      const text = String(t.text ?? '');
      // Ältere Daten ohne „auto“: unveränderter Standard-Tipp übernimmt die neue Voreinstellung
      const auto = typeof t.auto === 'boolean' ? t.auto : (text === standard.text && standard.auto);
      tipps[liste] = { titel: String(t.titel ?? ''), text, auto, geaendert: zeitpunkt(t.geaendert) };
    } else {
      tipps[liste] = { ...standard, geaendert: URALT };
    }
  }

  return {
    version: 2,
    kategorien,
    spiele,
    geloescht,
    tipps,
    geaendert: roh?.geaendert ?? null,
    letzterExport: roh?.letzterExport ?? null,
    letzterSync: roh?.letzterSync ?? null,
  };
}

// JSON mit fester Reihenfolge (Schlüssel sortiert) – zum Vergleichen von Datenständen
function stabil(wert) {
  if (Array.isArray(wert)) return '[' + wert.map(stabil).join(',') + ']';
  if (wert && typeof wert === 'object') {
    return '{' + Object.keys(wert).sort().filter((k) => wert[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stabil(wert[k])).join(',') + '}';
  }
  return JSON.stringify(wert ?? null);
}

// Vergleichsform: unabhängig von der Reihenfolge auf dem jeweiligen Gerät
function vergleichsText(d) {
  return stabil({
    kategorien: [...d.kategorien].sort((a, b) => a.name.localeCompare(b.name)),
    spiele: [...d.spiele].sort((a, b) => a.id.localeCompare(b.id)),
    geloescht: d.geloescht,
    tipps: d.tipps,
  });
}

// Der Teil der Daten, der synchronisiert und exportiert wird
function inhalt(d) {
  return { app: 'spieleliste', version: 2, kategorien: d.kategorien, spiele: d.spiele, geloescht: d.geloescht, tipps: d.tipps };
}

async function startdatenLaden() {
  const antwort = await fetch(STARTDATEN_URL, { cache: 'no-cache' });
  if (!antwort.ok) throw new Error('Startdaten konnten nicht geladen werden.');
  return normalisieren(await antwort.json(), { startdaten: true });
}

async function laden() {
  try {
    const gespeichert = localStorage.getItem(DATEN_KEY);
    if (gespeichert) daten = normalisieren(JSON.parse(gespeichert));
  } catch (e) {
    console.warn('Gespeicherte Daten unlesbar', e);
  }
  if (!daten) {
    daten = await startdatenLaden();
    lokalSchreiben();
  }
  let a = null;
  try { a = JSON.parse(localStorage.getItem(ANSICHT_KEY) || 'null'); } catch { /* egal */ }
  if (a && typeof a === 'object') {
    ansicht = { ...ansicht, ...a };
  } else {
    // Beim ersten Start: „Für andere Laune“ zugeklappt, damit der Story-Wunsch im Fokus steht
    for (const k of daten.kategorien) if (k.bereich === 'Für andere Laune') ansicht.zu[k.name] = true;
  }
}

function lokalSchreiben() {
  try {
    localStorage.setItem(DATEN_KEY, JSON.stringify(daten));
  } catch (e) {
    zeigeHinweis('Speichern fehlgeschlagen – bitte Daten exportieren!');
    console.error(e);
  }
}

// Nach jeder Änderung durch dich aufrufen: speichert und stößt den Sync an
function speichern() {
  daten.geaendert = jetzt();
  lokalSchreiben();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  syncPlanen();
}

function beruehren(s) {
  s.geaendert = jetzt();
}

function ansichtMerken() {
  try { localStorage.setItem(ANSICHT_KEY, JSON.stringify(ansicht)); } catch { /* egal */ }
}

/* ---------- Zusammenführen (für Sync) ---------- */

// Führt zwei Datenstände Spiel für Spiel zusammen: Die jeweils neuere Änderung gewinnt.
function zusammenfuehren(lokal, fern) {
  const geloescht = { ...fern.geloescht };
  for (const [id, zeit] of Object.entries(lokal.geloescht)) {
    if (!geloescht[id] || zeit > geloescht[id]) geloescht[id] = zeit;
  }

  // Gleiches Spiel mit unterschiedlicher ID (z. B. auf zwei Geräten getrennt angelegt) zusammenlegen
  const fernIds = new Set(fern.spiele.map((s) => s.id));
  const lokalIds = new Set(lokal.spiele.map((s) => s.id));
  const fernNachName = new Map();
  for (const s of fern.spiele) {
    if (!lokalIds.has(s.id)) fernNachName.set(namensSchluessel(s.name), s.id);
  }
  const lokaleSpiele = lokal.spiele.map((s) => {
    if (fernIds.has(s.id)) return s;
    const andereId = fernNachName.get(namensSchluessel(s.name));
    if (andereId) { fernNachName.delete(namensSchluessel(s.name)); return { ...s, id: andereId }; }
    // Spiel aus den Startdaten, das auf einem anderen Gerät gelöscht wurde
    const startId = 'st-' + namensSchluessel(s.name);
    if (s.id !== startId && geloescht[startId] && !lokalIds.has(startId)) return { ...s, id: startId };
    return s;
  });

  const nachId = new Map();
  const nimm = (s) => {
    const vorhanden = nachId.get(s.id);
    if (!vorhanden || s.geaendert > vorhanden.geaendert ||
        (s.geaendert === vorhanden.geaendert && stabil(s) > stabil(vorhanden))) {
      nachId.set(s.id, s);
    }
  };
  fern.spiele.forEach(nimm);
  lokaleSpiele.forEach(nimm);

  const spiele = [...nachId.values()].filter((s) => !(geloescht[s.id] && geloescht[s.id] >= s.geaendert));
  // Reihenfolge der Liste: lokale Reihenfolge, neue Spiele hinten
  const lokalPos = new Map(lokaleSpiele.map((s, i) => [s.id, i]));
  spiele.sort((a, b) => (lokalPos.get(a.id) ?? 1e9) - (lokalPos.get(b.id) ?? 1e9));

  const kategorien = [...lokal.kategorien];
  for (const k of fern.kategorien) if (!kategorien.some((x) => x.name === k.name)) kategorien.push(k);
  for (const s of spiele) {
    if (!kategorien.some((k) => k.name === s.kategorie)) {
      const bereich = s.liste === 'wunschliste' ? 'Wunschliste' : 'Für andere Laune';
      kategorien.push({ name: s.kategorie, info: '', bereich, liste: s.liste });
    }
  }

  // Tipps: je Reiter gewinnt die neuere Änderung
  const tipps = {};
  for (const liste of new Set([...Object.keys(lokal.tipps ?? {}), ...Object.keys(fern.tipps ?? {})])) {
    const a = lokal.tipps?.[liste];
    const b = fern.tipps?.[liste];
    if (!a || !b) { tipps[liste] = a ?? b; continue; }
    tipps[liste] = b.geaendert > a.geaendert || (b.geaendert === a.geaendert && stabil(b) > stabil(a)) ? b : a;
  }

  return { ...lokal, kategorien, spiele, geloescht, tipps };
}

/* ---------- Rückgängig ---------- */

let rueckgaengigStand = null;

function sicherungMachen() {
  rueckgaengigStand = JSON.stringify(daten);
}

function rueckgaengig() {
  if (!rueckgaengigStand) return;
  const alt = JSON.parse(rueckgaengigStand);
  rueckgaengigStand = null;
  const t = jetzt();
  // Alles, was sich seitdem geändert hat, als „jetzt geändert“ markieren,
  // damit der Sync den alten Stand nicht wieder überschreibt.
  const aktuell = new Map(daten.spiele.map((s) => [s.id, stabil(s)]));
  for (const s of alt.spiele) {
    if (aktuell.get(s.id) !== stabil(s)) { s.geaendert = t; delete alt.geloescht[s.id]; }
  }
  const altIds = new Set(alt.spiele.map((s) => s.id));
  for (const s of daten.spiele) if (!altIds.has(s.id)) alt.geloescht[s.id] = t;
  for (const k of daten.kategorien) if (!alt.kategorien.some((x) => x.name === k.name)) alt.kategorien.push(k);
  alt.letzterExport = daten.letzterExport;
  alt.letzterSync = daten.letzterSync;
  daten = alt;
  speichern();
  rendern();
  zeigeHinweis('Rückgängig gemacht');
}

/* ---------- Hinweis-Leiste ---------- */

let hinweisTimer = null;
let hinweisAktion = null;
function zeigeHinweis(text, optionen = {}) {
  if (optionen === true) optionen = { knopf: 'Rückgängig', aktion: rueckgaengig };
  const { knopf = null, aktion = null, dauer = knopf ? 6000 : 2600 } = optionen;
  const t = $('#toast');
  $('#toast-text').textContent = text;
  $('#toast-knopf').hidden = !knopf;
  $('#toast-knopf').textContent = knopf ?? '';
  hinweisAktion = aktion;
  t.hidden = false;
  clearTimeout(hinweisTimer);
  if (dauer) hinweisTimer = setTimeout(() => { t.hidden = true; }, dauer);
}

/* ---------- Filter und Sortierung ---------- */

function filterAktiv() {
  return Boolean(suchtext || ansicht.kategorie ||
    (ansicht.reiter === 'bibliothek' && (ansicht.status || ansicht.erledigteAus)));
}

function passtZumFilter(s) {
  if (s.liste !== ansicht.reiter) return false;
  if (ansicht.kategorie && s.kategorie !== ansicht.kategorie) return false;
  if (ansicht.reiter === 'bibliothek') {
    if (ansicht.status && s.status !== ansicht.status) return false;
    if (ansicht.erledigteAus && ERLEDIGT.has(s.status)) return false;
  }
  if (suchtext && !fuerSuche(s.name).includes(fuerSuche(suchtext))) return false;
  return true;
}

function sortieren(spiele) {
  const nachReihe = (a, b) => a.reihenfolge - b.reihenfolge;
  const kopie = [...spiele];
  switch (reihenfolgeModus ? 'eigene' : ansicht.sortierung) {
    case 'status': return kopie.sort((a, b) => (STATUS_RANG[a.status] ?? 9) - (STATUS_RANG[b.status] ?? 9) || nachReihe(a, b));
    case 'bewertung': return kopie.sort((a, b) => b.bewertung - a.bewertung || nachReihe(a, b));
    case 'spielzeit': return kopie.sort((a, b) => spielzeitMinuten(b.spielzeit) - spielzeitMinuten(a.spielzeit) || nachReihe(a, b));
    case 'name': return kopie.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    default: return kopie.sort(nachReihe);
  }
}

/* ---------- Darstellung ---------- */

const PFEIL = '<svg class="kat-pfeil" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>';
const STIFT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17.2V20h2.8l8.3-8.3-2.8-2.8L4 17.2zm13.7-7.6a1 1 0 0 0 0-1.4l-1.9-1.9a1 1 0 0 0-1.4 0l-1.4 1.4 2.8 2.8 1.9-1.9z"/></svg>';

function sterneHtml(wert, mitAktion = true) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    html += `<button type="button" class="stern${i <= wert ? ' an' : ''}" ${mitAktion ? 'data-aktion="stern"' : ''} data-wert="${i}" aria-label="${i} von 5 Sternen" aria-pressed="${i <= wert}">★</button>`;
  }
  return html;
}

function statusAuswahlHtml(s) {
  return `<select class="status-wahl st-${s.status}" data-aktion="status" aria-label="Status von ${esc(s.name)}">
    ${STATUS_BIBLIOTHEK.map((st) => `<option value="${st}"${st === s.status ? ' selected' : ''}>${STATUS_TEXT[st]}</option>`).join('')}
  </select>`;
}

function hauptAktionHtml(s) {
  return s.liste === 'bibliothek'
    ? statusAuswahlHtml(s)
    : '<button class="klein-knopf haupt" data-aktion="gekauft">✓ Gekauft</button>';
}

function spielHtml(s, kontext = {}) {
  // Kompaktansicht: eine Zeile, Antippen des Namens klappt die Karte auf
  if (ansicht.kompakt && !reihenfolgeModus && !aufgeklappt.has(s.id)) {
    return `
      <article class="spiel kompakt" data-id="${esc(s.id)}">
        <button class="spiel-name-knopf" data-aktion="aufklappen" aria-expanded="false">
          <span>${esc(s.name)}</span>${s.bewertung ? `<span class="mini-stern" aria-label="${s.bewertung} Sterne">★${s.bewertung}</span>` : ''}
        </button>
        ${hauptAktionHtml(s)}
      </article>`;
  }

  let unten;
  if (reihenfolgeModus) {
    unten = `<span class="leise klein">${kontext.position + 1}. von ${kontext.anzahl}</span>
      <span class="platz"></span>
      <span class="reihen-knoepfe">
        <button class="klein-knopf" data-aktion="hoch" aria-label="${esc(s.name)} nach oben"${kontext.position === 0 ? ' disabled' : ''}>▲</button>
        <button class="klein-knopf" data-aktion="runter" aria-label="${esc(s.name)} nach unten"${kontext.position === kontext.anzahl - 1 ? ' disabled' : ''}>▼</button>
      </span>`;
  } else {
    unten = `${hauptAktionHtml(s)}
      <span class="platz"></span>
      <span class="sterne" role="group" aria-label="Bewertung">${sterneHtml(s.bewertung)}</span>`;
  }

  const steamText = s.liste === 'wunschliste' ? 'Preis auf Steam' : 'Steam';
  const meta = [];
  if (s.spielzeit) meta.push(`<span>⏱ Bisher gespielt: ${esc(s.spielzeit)}</span>`);
  if (s.status === 'durchgespielt' && s.durchgespieltAm) {
    meta.push(`<span>✓ Durchgespielt am ${new Date(s.durchgespieltAm).toLocaleDateString('de-DE')}</span>`);
  }
  return `
    <article class="spiel" data-id="${esc(s.id)}">
      <div class="spiel-kopf">
        <div class="spiel-name">${esc(s.name)}</div>
        <button class="klein-knopf" data-aktion="bearbeiten" aria-label="${esc(s.name)} bearbeiten">${STIFT}</button>
      </div>
      ${s.beschreibung ? `<p class="spiel-beschr">${esc(s.beschreibung)}</p>` : ''}
      <div class="spiel-meta">${meta.join('')}
        <a class="steam-link" href="${esc(steamLink(s))}" target="_blank" rel="noopener" aria-label="${esc(s.name)} auf Steam öffnen (${steamText})">${steamText} ↗</a>
      </div>
      ${s.notiz ? `<div class="spiel-notiz">${esc(s.notiz)}</div>` : ''}
      <div class="spiel-aktionen">${unten}</div>
      ${ansicht.kompakt && !reihenfolgeModus ? '<button class="link-knopf zuklappen" data-aktion="zuklappen">▲ Weniger anzeigen</button>' : ''}
    </article>`;
}

function fortschrittHtml(kat, alleSpiele) {
  const gesamt = alleSpiele.length;
  if (kat.liste !== 'bibliothek') {
    return `<div class="fortschritt"><span>${gesamt} ${gesamt === 1 ? 'Spiel' : 'Spiele'}</span></div>`;
  }
  const durch = alleSpiele.filter((s) => s.status === 'durchgespielt').length;
  const ab = alleSpiele.filter((s) => s.status === 'abgebrochen').length;
  const prozent = gesamt ? Math.round((durch / gesamt) * 100) : 0;
  return `<div class="fortschritt"><span>${durch}/${gesamt} durchgespielt${ab ? ` · ${ab} abgebrochen` : ''}</span>
    <span class="balken" aria-hidden="true"><i style="width:${prozent}%"></i></span></div>`;
}

function kategorieHtml(kat, alleSpiele, gefiltert, offenErzwingen) {
  const gesamt = alleSpiele.length;
  const offen = offenErzwingen || reihenfolgeModus || !ansicht.zu[kat.name];
  const sortiert = sortieren(gefiltert);
  return `
    <details class="kategorie" data-kategorie="${esc(kat.name)}"${offen ? ' open' : ''}>
      <summary>
        <span class="kat-name">${esc(kat.name)}${gefiltert.length !== gesamt ? ` <span class="zahl">(${gefiltert.length} von ${gesamt})</span>` : ''}</span>
        ${kat.info ? `<span class="kat-info">${esc(kat.info)}</span>` : ''}
        ${PFEIL}
        ${fortschrittHtml(kat, alleSpiele)}
      </summary>
      <div class="kat-spiele">${sortiert.map((s, i) => spielHtml(s, { position: i, anzahl: sortiert.length })).join('')}</div>
    </details>`;
}

function geradeDabeiHtml() {
  const dabei = daten.spiele.filter((s) => s.liste === 'bibliothek' && s.status === 'angefangen')
    .sort((a, b) => b.geaendert.localeCompare(a.geaendert));
  if (!dabei.length) return '';
  return `
    <div class="bereich"><h2>Gerade dabei</h2><p>Deine angefangenen Spiele</p></div>
    <div class="kategorie dabei">
      <div class="kat-spiele">${dabei.map((s) => spielHtml(s)).join('')}</div>
    </div>`;
}

/* ---------- Tipp-Kasten ---------- */

// Macht Spielnamen im Tipp antippbar (auch Kurzformen wie „The Witcher 3“ für „The Witcher 3: Wild Hunt“)
function tippMitLinks(text) {
  const muster = new Map();
  const kurzZaehler = new Map();
  for (const s of daten.spiele) {
    const kurz = s.name.split(':')[0].trim();
    if (kurz !== s.name && kurz.length >= 6) kurzZaehler.set(kurz, (kurzZaehler.get(kurz) ?? 0) + 1);
  }
  for (const s of daten.spiele) {
    muster.set(s.name, s.id);
    const kurz = s.name.split(':')[0].trim();
    if (kurzZaehler.get(kurz) === 1 && !muster.has(kurz)) muster.set(kurz, s.id);
  }
  const namen = [...muster.keys()].sort((a, b) => b.length - a.length);
  if (!namen.length) return esc(text);
  const teile = namen.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const regex = new RegExp('(?<![\\p{L}\\p{N}])(' + teile + ')(?![\\p{L}\\p{N}])', 'gu');
  let html = '';
  let pos = 0;
  for (const treffer of text.matchAll(regex)) {
    html += esc(text.slice(pos, treffer.index));
    html += `<button class="tipp-spiel" data-spiel-id="${esc(muster.get(treffer[0]))}">${esc(treffer[0])}</button>`;
    pos = treffer.index + treffer[0].length;
  }
  return html + esc(text.slice(pos));
}

function tippRendern() {
  const tipp = daten.tipps?.[ansicht.reiter];
  const leer = !tipp || !(tipp.auto || tipp.titel.trim() || tipp.text.trim());
  $('#tipp').hidden = leer;
  $('#tipp-hinzufuegen').hidden = !leer;
  if (leer) return;
  $('#tipp-titel').textContent = tipp.titel.trim() || 'Tipp';
  $('#tipp-auto-hinweis').hidden = !tipp.auto;
  const text = tipp.auto ? autoTipp(ansicht.reiter) : tipp.text.trim();
  $('#tipp-text').innerHTML = tippMitLinks(text);
}

/* ---------- Automatischer Tipp ---------- */

// „Ca. 10 Std.“, „Nur Hauptstory: ca. 50 Std.“ → 10 bzw. 50
function geschaetzteStunden(s) {
  const m = String(s.beschreibung).match(/ca\.\s*(\d+(?:[.,]\d+)?)\s*(?:Std|h\b)/i);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

// Gemeinsamer Schlüssel für Spiele einer Reihe: „Dishonored“, „Dishonored 2“ → „dishonored“
function serienSchluessel(name) {
  const woerter = fuerSuche(name).replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/);
  const erstes = woerter[0] || '';
  return ['the', 'a', 'an'].includes(erstes) || erstes.length < 4 ? woerter.slice(0, 2).join(' ') : erstes;
}

function namenListe(spiele) {
  const n = spiele.map((s) => s.name);
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} und ${n[n.length - 1]}` : n[0];
}

function autoTipp(liste) {
  return liste === 'wunschliste' ? autoKaufTipp() : autoStartTipp();
}

function autoStartTipp() {
  const katIndex = new Map(daten.kategorien.map((k, i) => [k.name, i]));
  const ordnung = (a, b) => (katIndex.get(a.kategorie) ?? 99) - (katIndex.get(b.kategorie) ?? 99) || a.reihenfolge - b.reihenfolge;
  const bib = daten.spiele.filter((s) => s.liste === 'bibliothek').sort(ordnung);
  const teile = [];
  const erwaehnt = new Set();

  // 1. Weiterspielen
  const dabei = bib.filter((s) => s.status === 'angefangen').sort((a, b) => b.geaendert.localeCompare(a.geaendert)).slice(0, 2);
  if (dabei.length === 1) {
    teile.push(`Weiterspielen: ${dabei[0].name}${dabei[0].spielzeit ? ` (bisher ${dabei[0].spielzeit})` : ''}.`);
  } else if (dabei.length > 1) {
    teile.push(`Weiterspielen: ${namenListe(dabei)}.`);
  }
  dabei.forEach((s) => erwaehnt.add(s.id));

  // Reihen innerhalb einer Kategorie
  const reihen = new Map();
  for (const s of bib) {
    const k = s.kategorie + '|' + serienSchluessel(s.name);
    if (!reihen.has(k)) reihen.set(k, []);
    reihen.get(k).push(s);
  }
  const blockiert = new Set();  // Fortsetzungen, deren Vorgänger noch nicht erledigt ist
  let fortsetzung = null;
  for (const teil of reihen.values()) {
    if (teil.length < 2) continue;
    teil.sort((a, b) => a.reihenfolge - b.reihenfolge);
    let offenerVorgaenger = false;
    for (const s of teil) {
      if (offenerVorgaenger) blockiert.add(s.id);
      if (s.status === 'offen' || s.status === 'angefangen') offenerVorgaenger = true;
    }
    // 2. Reihe fortsetzen: nächstes offenes Spiel nach dem zuletzt durchgespielten
    const durch = teil.filter((s) => s.status === 'durchgespielt');
    if (!durch.length) continue;
    const letztes = durch[durch.length - 1];
    const naechstes = teil.slice(teil.indexOf(letztes) + 1).find((s) => s.status === 'offen');
    if (naechstes && !teil.some((s) => s.status === 'angefangen')) {
      const zeit = letztes.durchgespieltAm || letztes.geaendert;
      if (!fortsetzung || zeit > fortsetzung.zeit) fortsetzung = { vorher: letztes, naechstes, zeit };
    }
  }
  if (fortsetzung) {
    teile.push(`Nach ${fortsetzung.vorher.name} geht es weiter mit ${fortsetzung.naechstes.name}.`);
    erwaehnt.add(fortsetzung.naechstes.id);
  }

  // 3. Neu anfangen: kurz und groß aus dem Story-Wunsch (ohne reine Koop-Spiele)
  const kandidaten = bib.filter((s) => s.status === 'offen' && !erwaehnt.has(s.id) && !blockiert.has(s.id) &&
    kategorieVon(s.kategorie)?.bereich === 'Story-Wunsch' && !/koop/i.test(s.kategorie));
  const mitDauer = kandidaten.map((s) => ({ s, h: geschaetzteStunden(s) })).filter((x) => x.h);
  const kurz = mitDauer.find((x) => x.h <= 12);
  const gross = mitDauer.find((x) => x.h >= 20 && x.s !== kurz?.s) || mitDauer.find((x) => x.h >= 15 && x.s !== kurz?.s);
  const dauer = (x) => `ca. ${String(x.h).replace('.', ',')} Std.`;
  const neu = teile.length ? 'Neu anfangen: ' : '';
  if (kurz && gross) {
    teile.push(`${neu}${kurz.s.name} für kurz und spannend (${dauer(kurz)}), ${gross.s.name} für eine große Story (${dauer(gross)}).`);
  } else if (kurz || gross) {
    const x = kurz || gross;
    teile.push(`${neu}${x.s.name} (${dauer(x)}).`);
  } else if (!teile.length && kandidaten.length) {
    teile.push(`Als Nächstes: ${kandidaten[0].name}.`);
  }

  if (!teile.length) {
    return 'Alles aus deinem Story-Wunsch ist erledigt – stark! Schau in die Wunschliste oder in „Für andere Laune“.';
  }
  return teile.join(' ');
}

function autoKaufTipp() {
  const katIndex = new Map(daten.kategorien.map((k, i) => [k.name, i]));
  const wunsch = daten.spiele.filter((s) => s.liste === 'wunschliste')
    .sort((a, b) => (katIndex.get(a.kategorie) ?? 99) - (katIndex.get(b.kategorie) ?? 99) || a.reihenfolge - b.reihenfolge);
  if (!wunsch.length) return 'Deine Wunschliste ist leer. Mit + fügst du Spiele hinzu, die du dir kaufen könntest.';
  const teile = [];
  // Fortsetzung einer Reihe, die du in der Bibliothek schon durchgespielt hast
  // (das zuletzt durchgespielte Spiel zählt zuerst)
  const durch = daten.spiele.filter((s) => s.liste === 'bibliothek' && s.status === 'durchgespielt')
    .sort((a, b) => (b.durchgespieltAm || b.geaendert).localeCompare(a.durchgespieltAm || a.geaendert));
  let passend = null;
  for (const d of durch) {
    const w = wunsch.find((x) => serienSchluessel(x.name) === serienSchluessel(d.name));
    if (w) { passend = { w, v: d }; break; }
  }
  if (passend) teile.push(`Da du ${passend.v.name} durchgespielt hast: ${passend.w.name} setzt die Reihe fort.`);
  // Pro Reihe nur ein Spiel empfehlen (nicht Teil 1 und Teil 2 gleichzeitig)
  const reihen = new Set(passend ? [serienSchluessel(passend.w.name)] : []);
  const zuerst = [];
  for (const s of wunsch) {
    const k = serienSchluessel(s.name);
    if (reihen.has(k)) continue;
    reihen.add(k);
    zuerst.push(s);
    if (zuerst.length === 2) break;
  }
  if (zuerst.length) teile.push(`${passend ? 'Außerdem lohnen sich' : 'Zuerst'} ${namenListe(zuerst)}.`);
  teile.push('Im Steam-Sale gibt es fast alles stark reduziert – also auf die Steam-Wunschliste setzen und abwarten.');
  return teile.join(' ');
}

let tippManuellerText = '';

function tippDialogOeffnen() {
  const tipp = daten.tipps[ansicht.reiter];
  const standard = STANDARD_TIPPS[ansicht.reiter];
  const form = $('#form-tipp');
  form.titel.value = tipp.titel;
  tippManuellerText = tipp.text;
  form.auto.checked = Boolean(tipp.auto);
  $('#tipp-auto-erklaerung').textContent = ansicht.reiter === 'wunschliste'
    ? 'Der Tipp wird bei jeder Änderung neu berechnet: zuerst die Fortsetzung einer Reihe, die du zuletzt durchgespielt hast, dann die ersten Spiele deiner Wunschliste (pro Reihe nur eins). Unten siehst du den aktuellen Vorschlag.'
    : 'Der Tipp wird bei jeder Änderung neu berechnet: zuerst angefangene Spiele, dann die nächste Fortsetzung einer Reihe, dann ein kurzes und ein großes offenes Story-Spiel in deiner Reihenfolge. Unten siehst du den aktuellen Vorschlag.';
  tippAutoUmschalten();
  $('#tipp-dialog-titel').textContent = `Tipp für „${ansicht.reiter === 'bibliothek' ? 'Bibliothek' : 'Wunschliste'}“`;
  $('#tipp-standard').hidden = tipp.titel === standard.titel && tipp.text === standard.text && Boolean(tipp.auto) === standard.auto;
  $('#tipp-entfernen').hidden = !(tipp.auto || tipp.titel || tipp.text);
  $('#dlg-tipp').showModal();
}

// Automatisch an: Vorschau im Textfeld, Bearbeiten gesperrt. Aus: eigener Text zurück.
function tippAutoUmschalten() {
  const form = $('#form-tipp');
  const auto = form.auto.checked;
  form.text.disabled = auto;
  form.text.value = auto ? autoTipp(ansicht.reiter) : (tippManuellerText || form.text.value);
  $('#tipp-auto-erklaerung').hidden = !auto;
}

function tippSetzen(titel, text, auto = false) {
  daten.tipps[ansicht.reiter] = { titel: titel.trim(), text: text.trim(), auto, geaendert: jetzt() };
  speichern();
  rendern();
}

function tippEinrichten() {
  $('#tipp-bearbeiten').addEventListener('click', tippDialogOeffnen);
  $('#tipp-hinzufuegen').addEventListener('click', tippDialogOeffnen);
  $('#form-tipp').auto.addEventListener('change', (e) => {
    const form = $('#form-tipp');
    if (e.target.checked) tippManuellerText = form.text.value;
    tippAutoUmschalten();
  });
  $('#tipp-text').addEventListener('click', (e) => {
    const knopf = e.target.closest('[data-spiel-id]');
    if (!knopf) return;
    const s = daten.spiele.find((x) => x.id === knopf.dataset.spielId);
    if (!s) return;
    // Filter, die das Spiel verstecken würden, aufheben
    suchtext = ''; $('#suche').value = '';
    ansicht.status = ''; ansicht.kategorie = ''; ansicht.erledigteAus = false;
    aufgeklappt.add(s.id);
    zeigeSpiel(s.id);
  });
  $('#form-tipp').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const auto = f.auto.checked;
    tippSetzen(f.titel.value, auto ? tippManuellerText : f.text.value, auto);
    $('#dlg-tipp').close();
    zeigeHinweis(auto ? 'Tipp wird jetzt automatisch erstellt' : 'Tipp gespeichert');
  });
  $('#tipp-entfernen').addEventListener('click', () => {
    sicherungMachen();
    tippSetzen('', '', false);
    $('#dlg-tipp').close();
    zeigeHinweis('Tipp entfernt', true);
  });
  $('#tipp-standard').addEventListener('click', () => {
    const f = $('#form-tipp');
    const standard = STANDARD_TIPPS[ansicht.reiter];
    f.titel.value = standard.titel;
    tippManuellerText = standard.text;
    f.text.value = standard.text;
    f.auto.checked = standard.auto;
    tippAutoUmschalten();
  });
}

function rendern() {
  tippRendern();
  for (const knopf of $$('.reiter-knopf')) {
    knopf.setAttribute('aria-selected', String(knopf.dataset.reiter === ansicht.reiter));
  }
  $('#zahl-bibliothek').textContent = daten.spiele.filter((s) => s.liste === 'bibliothek').length;
  $('#zahl-wunschliste').textContent = daten.spiele.filter((s) => s.liste === 'wunschliste').length;

  // Werkzeugleiste
  const istBib = ansicht.reiter === 'bibliothek';
  const statusFeld = $('#filter-status');
  statusFeld.hidden = !istBib;
  statusFeld.innerHTML = '<option value="">Alle Status</option>' +
    STATUS_BIBLIOTHEK.map((st) => `<option value="${st}">${STATUS_TEXT[st]}</option>`).join('');
  statusFeld.value = ansicht.status;
  $('.filter').classList.toggle('einzeln', !istBib);
  $('#erledigte-zeile').hidden = !istBib;
  $('#erledigte-aus').checked = ansicht.erledigteAus;
  $('#wuerfel-knopf').hidden = !istBib || reihenfolgeModus;
  $('#sortierung option[value="status"]').hidden = !istBib;
  if (!istBib && ansicht.sortierung === 'status') ansicht.sortierung = 'eigene';
  $('#sortierung').value = ansicht.sortierung;
  $('#filter-zuruecksetzen').hidden = !filterAktiv() || reihenfolgeModus;
  $('#sortierung').disabled = reihenfolgeModus;
  $('#kompakt-knopf').setAttribute('aria-pressed', String(ansicht.kompakt));
  $('#reihenfolge-knopf').setAttribute('aria-pressed', String(reihenfolgeModus));
  $('#reihenfolge-hinweis').hidden = !reihenfolgeModus;

  const katFeld = $('#filter-kategorie');
  const katDesReiters = daten.kategorien.filter((k) => k.liste === ansicht.reiter);
  if (ansicht.kategorie && !katDesReiters.some((k) => k.name === ansicht.kategorie)) ansicht.kategorie = '';
  katFeld.innerHTML = '<option value="">Alle Kategorien</option>' +
    BEREICHE_JE_LISTE[ansicht.reiter].map((b) => {
      const ks = katDesReiters.filter((k) => k.bereich === b);
      if (!ks.length) return '';
      return `<optgroup label="${esc(BEREICHE[b].titel)}">${ks.map((k) => `<option value="${esc(k.name)}">${esc(k.name)}</option>`).join('')}</optgroup>`;
    }).join('');
  katFeld.value = ansicht.kategorie;

  // Liste
  const aktiv = filterAktiv();
  let html = '';
  let treffer = 0;
  if (istBib && !aktiv && !reihenfolgeModus) html += geradeDabeiHtml();
  for (const bereich of BEREICHE_JE_LISTE[ansicht.reiter]) {
    let teil = '';
    for (const kat of daten.kategorien.filter((k) => k.bereich === bereich)) {
      const alle = daten.spiele.filter((s) => s.kategorie === kat.name);
      const gefiltert = alle.filter(passtZumFilter);
      if (!gefiltert.length) continue;
      treffer += gefiltert.length;
      teil += kategorieHtml(kat, alle, gefiltert, aktiv);
    }
    if (teil) {
      const b = BEREICHE[bereich];
      html += (istBib ? `<div class="bereich"><h2>${esc(b.titel)}</h2><p>${esc(b.text)}</p></div>` : '') + teil;
    }
  }
  if (!treffer) {
    html = aktiv
      ? '<p class="leer">Keine Spiele gefunden.<br><button class="knopf" data-filter-zuruecksetzen>Filter zurücksetzen</button></p>'
      : '<p class="leer">Hier ist noch nichts.<br>Tippe auf <b>+</b>, um ein Spiel hinzuzufügen.</p>';
  }
  $('#liste').innerHTML = html;
}

function zeigeSpiel(id) {
  const s = daten.spiele.find((x) => x.id === id);
  if (!s) return;
  if (ansicht.reiter !== s.liste) {
    ansicht.reiter = s.liste;
    ansicht.kategorie = '';
  }
  delete ansicht.zu[s.kategorie];
  ansichtMerken();
  rendern();
  const el = $(`details .spiel[data-id="${CSS.escape(id)}"]`) || $(`.spiel[data-id="${CSS.escape(id)}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('markiert');
    setTimeout(() => el.classList.remove('markiert'), 1700);
  }
}

/* ---------- Aktionen in der Liste ---------- */

function setzeStatus(s, status) {
  s.status = status;
  s.durchgespieltAm = status === 'durchgespielt' ? jetzt() : null;
  beruehren(s);
}

function verschieben(s, richtung) {
  const geschwister = daten.spiele.filter((x) => x.kategorie === s.kategorie).sort((a, b) => a.reihenfolge - b.reihenfolge);
  const i = geschwister.indexOf(s);
  const j = i + richtung;
  if (j < 0 || j >= geschwister.length) return;
  [geschwister[i], geschwister[j]] = [geschwister[j], geschwister[i]];
  geschwister.forEach((x, pos) => {
    if (x.reihenfolge !== pos) { x.reihenfolge = pos; beruehren(x); }
  });
  speichern();
  rendern();
  const knopf = $(`details .spiel[data-id="${CSS.escape(s.id)}"] [data-aktion="${richtung < 0 ? 'hoch' : 'runter'}"]`);
  if (knopf && !knopf.disabled) knopf.focus({ preventScroll: false });
}

function listeEinrichten() {
  const liste = $('#liste');

  liste.addEventListener('click', (e) => {
    const knopf = e.target.closest('[data-aktion]');
    if (!knopf || knopf.tagName === 'SELECT') return;
    const id = knopf.closest('.spiel')?.dataset.id;
    const s = daten.spiele.find((x) => x.id === id);
    if (!s) return;
    switch (knopf.dataset.aktion) {
      case 'stern': {
        const wert = Number(knopf.dataset.wert);
        s.bewertung = s.bewertung === wert ? 0 : wert;
        beruehren(s); speichern(); rendern();
        break;
      }
      case 'bearbeiten': spielDialogOeffnen(id); break;
      case 'gekauft': gekauftDialogOeffnen(id); break;
      case 'aufklappen': aufgeklappt.add(id); rendern(); break;
      case 'zuklappen': aufgeklappt.delete(id); rendern(); break;
      case 'hoch': verschieben(s, -1); break;
      case 'runter': verschieben(s, 1); break;
    }
  });

  liste.addEventListener('change', (e) => {
    if (e.target.dataset.aktion !== 'status') return;
    const s = daten.spiele.find((x) => x.id === e.target.closest('.spiel').dataset.id);
    if (!s) return;
    setzeStatus(s, e.target.value);
    speichern();
    rendern();
    if (s.status === 'durchgespielt') zeigeHinweis(`🎉 „${s.name}“ durchgespielt!`);
  });

  // Auf- und Zuklappen der Kategorien merken (nur ohne aktive Filter)
  liste.addEventListener('toggle', (e) => {
    const det = e.target;
    if (!det.matches?.('details.kategorie') || filterAktiv() || reihenfolgeModus) return;
    if (det.open) delete ansicht.zu[det.dataset.kategorie];
    else ansicht.zu[det.dataset.kategorie] = true;
    ansichtMerken();
  }, true);
}

/* ---------- Dialoge allgemein ---------- */

function dialogeEinrichten() {
  for (const d of $$('dialog')) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-schliessen]')) e.target.closest('dialog')?.close();
  });
}

/* ---------- Spiel bearbeiten / hinzufügen ---------- */

let bearbeiteId = null;

function kategorieOptionen(nurListe = null, mitNeu = false) {
  let html = '';
  for (const bereich of Object.keys(BEREICHE)) {
    if (nurListe && BEREICHE[bereich].liste !== nurListe) continue;
    const ks = daten.kategorien.filter((k) => k.bereich === bereich);
    if (!ks.length) continue;
    const label = BEREICHE[bereich].liste === 'bibliothek' ? `Bibliothek – ${BEREICHE[bereich].titel}` : 'Wunschliste';
    html += `<optgroup label="${esc(label)}">${ks.map((k) => `<option value="${esc(k.name)}">${esc(k.name)}</option>`).join('')}</optgroup>`;
  }
  if (mitNeu) html += '<optgroup label="Neu"><option value="__neu__">+ Neue Kategorie …</option></optgroup>';
  return html;
}

function statusSegmenteRendern(liste, aktuell) {
  const block = $('#feld-status-block');
  block.hidden = liste !== 'bibliothek';
  if (liste !== 'bibliothek') return;
  const wert = STATUS_BIBLIOTHEK.includes(aktuell) ? aktuell : 'offen';
  $('#feld-status').innerHTML = STATUS_BIBLIOTHEK.map((st) => `
    <label><input type="radio" name="status" value="${st}"${st === wert ? ' checked' : ''}><span>${STATUS_TEXT[st]}</span></label>`).join('');
}

function dialogSterneSetzen(wert) {
  const box = $('#feld-sterne');
  box.dataset.wert = wert;
  box.innerHTML = sterneHtml(wert, false);
}

function listeDerAuswahl(form) {
  const wahl = form.kategorie.value;
  if (wahl === '__neu__') return listeVonBereich(form.neueKatBereich.value);
  return kategorieVon(wahl)?.liste ?? 'bibliothek';
}

function spielDialogOeffnen(id = null) {
  bearbeiteId = id;
  const form = $('#form-spiel');
  form.reset();
  const s = id ? daten.spiele.find((x) => x.id === id) : null;
  $('#dlg-spiel-titel').textContent = s ? 'Spiel bearbeiten' : 'Spiel hinzufügen';
  $('#loeschen-knopf').hidden = !s;
  $('#feld-kategorie').innerHTML = kategorieOptionen(null, true);
  $('#neue-kat').hidden = true;

  let kategorie;
  if (s) kategorie = s.kategorie;
  else if (ansicht.kategorie) kategorie = ansicht.kategorie;
  else kategorie = daten.kategorien.find((k) => k.liste === ansicht.reiter)?.name ?? '__neu__';
  form.kategorie.value = kategorie;
  if (kategorie === '__neu__') $('#neue-kat').hidden = false;

  form.name.value = s?.name ?? '';
  form.beschreibung.value = s?.beschreibung ?? '';
  form.spielzeit.value = s?.spielzeit ?? '';
  form.notiz.value = s?.notiz ?? '';
  form.steamAppId.value = s?.steamAppId ?? '';
  statusSegmenteRendern(listeDerAuswahl(form), s?.status ?? 'offen');
  dialogSterneSetzen(s?.bewertung ?? 0);

  $('#dlg-spiel').showModal();
  if (!s) setTimeout(() => form.name.focus(), 50);
}

function spielDialogEinrichten() {
  const form = $('#form-spiel');
  const statusNeu = () => {
    const aktuell = form.querySelector('input[name="status"]:checked')?.value;
    statusSegmenteRendern(listeDerAuswahl(form), aktuell);
  };

  form.kategorie.addEventListener('change', () => {
    $('#neue-kat').hidden = form.kategorie.value !== '__neu__';
    statusNeu();
  });
  form.neueKatBereich.addEventListener('change', statusNeu);

  $('#feld-sterne').addEventListener('click', (e) => {
    const stern = e.target.closest('.stern');
    if (!stern) return;
    const wert = Number(stern.dataset.wert);
    dialogSterneSetzen(Number($('#feld-sterne').dataset.wert) === wert ? 0 : wert);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = form.name.value.trim();
    if (!name) { form.name.focus(); return; }

    let katName = form.kategorie.value;
    if (katName === '__neu__') {
      const neuName = form.neueKatName.value.trim();
      if (!neuName) { form.neueKatName.focus(); zeigeHinweis('Bitte einen Namen für die Kategorie eingeben'); return; }
      const vorhanden = daten.kategorien.find((k) => fuerSuche(k.name) === fuerSuche(neuName));
      if (vorhanden) {
        katName = vorhanden.name;
      } else {
        const bereich = form.neueKatBereich.value;
        daten.kategorien.push({ name: neuName, info: form.neueKatInfo.value.trim(), bereich, liste: listeVonBereich(bereich) });
        katName = neuName;
      }
    }
    const kat = kategorieVon(katName);
    const status = kat.liste === 'bibliothek'
      ? (form.querySelector('input[name="status"]:checked')?.value ?? 'offen')
      : 'offen';
    const appId = parseInt(form.steamAppId.value, 10);

    const werte = {
      name,
      beschreibung: form.beschreibung.value.trim(),
      spielzeit: form.spielzeit.value.trim() || null,
      notiz: form.notiz.value.trim(),
      bewertung: Number($('#feld-sterne').dataset.wert) || 0,
      kategorie: kat.name,
      liste: kat.liste,
      steamAppId: appId > 0 ? appId : null,
    };

    if (bearbeiteId) {
      const s = daten.spiele.find((x) => x.id === bearbeiteId);
      const wechsel = s.liste !== werte.liste;
      if (s.kategorie !== werte.kategorie) werte.reihenfolge = naechsteReihenfolge(werte.kategorie);
      Object.assign(s, werte);
      if (s.status !== status) setzeStatus(s, status);
      beruehren(s);
      speichern();
      $('#dlg-spiel').close();
      rendern();
      zeigeHinweis(wechsel ? `Gespeichert – jetzt in der ${werte.liste === 'bibliothek' ? 'Bibliothek' : 'Wunschliste'}` : 'Gespeichert');
      return;
    }

    const neu = {
      id: neueId(), ...werte, status,
      reihenfolge: naechsteReihenfolge(kat.name),
      durchgespieltAm: status === 'durchgespielt' ? jetzt() : null,
      geaendert: jetzt(),
    };
    daten.spiele.push(neu);
    speichern();
    $('#dlg-spiel').close();
    zeigeHinweis(`„${name}“ hinzugefügt`);
    if (ansicht.reiter !== neu.liste) { ansicht.reiter = neu.liste; ansicht.kategorie = ''; }
    if (!passtZumFilter(neu)) {
      suchtext = ''; $('#suche').value = '';
      ansicht.status = ''; ansicht.kategorie = '';
      if (!passtZumFilter(neu)) ansicht.erledigteAus = false;
    }
    zeigeSpiel(neu.id);
  });

  $('#loeschen-knopf').addEventListener('click', () => {
    const s = daten.spiele.find((x) => x.id === bearbeiteId);
    if (!s) return;
    sicherungMachen();
    daten.spiele = daten.spiele.filter((x) => x.id !== s.id);
    daten.geloescht[s.id] = jetzt();
    speichern();
    $('#dlg-spiel').close();
    rendern();
    zeigeHinweis(`„${s.name}“ gelöscht`, true);
  });
}

/* ---------- Gekauft → Bibliothek ---------- */

let gekauftId = null;

function gekauftDialogOeffnen(id) {
  const s = daten.spiele.find((x) => x.id === id);
  if (!s) return;
  gekauftId = id;
  $('#gekauft-text').textContent = `„${s.name}“ wird in deine Bibliothek verschoben und dort als „Offen“ geführt.`;
  const feld = $('#gekauft-kategorie');
  feld.innerHTML = kategorieOptionen('bibliothek');
  if (kategorieVon(STANDARD_ZIEL_NACH_KAUF)?.liste === 'bibliothek') feld.value = STANDARD_ZIEL_NACH_KAUF;
  $('#dlg-gekauft').showModal();
}

function gekauftDialogEinrichten() {
  $('#form-gekauft').addEventListener('submit', (e) => {
    e.preventDefault();
    const kat = kategorieVon($('#gekauft-kategorie').value);
    const s = daten.spiele.find((x) => x.id === gekauftId);
    if (!kat || !s) return;
    sicherungMachen();
    Object.assign(s, { liste: 'bibliothek', kategorie: kat.name, status: 'offen', reihenfolge: naechsteReihenfolge(kat.name) });
    beruehren(s);
    speichern();
    $('#dlg-gekauft').close();
    aufgeklappt.delete(s.id);
    rendern();
    zeigeHinweis(`🛒 „${s.name}“ ist jetzt in der Bibliothek`, true);
  });
}

/* ---------- Was soll ich spielen? ---------- */

let letzterVorschlag = null;

function wuerfelDialogOeffnen() {
  const feld = $('#wuerfel-kategorie');
  feld.innerHTML = `
    <optgroup label="Ganzer Bereich">
      <option value="bereich:Story-Wunsch">Alles aus „${esc(BEREICHE['Story-Wunsch'].titel)}“</option>
      <option value="bereich:Für andere Laune">Alles aus „${esc(BEREICHE['Für andere Laune'].titel)}“</option>
      <option value="alle">Ganze Bibliothek</option>
    </optgroup>` +
    BEREICHE_JE_LISTE.bibliothek.map((b) => {
      const ks = daten.kategorien.filter((k) => k.bereich === b);
      if (!ks.length) return '';
      return `<optgroup label="${esc(BEREICHE[b].titel)}">${ks.map((k) => `<option value="kat:${esc(k.name)}">${esc(k.name)}</option>`).join('')}</optgroup>`;
    }).join('');
  feld.value = ansicht.wuerfelAuswahl;
  if (!feld.value) feld.selectedIndex = 0;
  $('#wuerfel-angefangen').checked = ansicht.wuerfelAngefangen;
  $('#wuerfel-ergebnis').innerHTML = '';
  $('#wuerfel-nehmen').hidden = true;
  $('#wuerfel-los').textContent = '🎲 Würfeln';
  letzterVorschlag = null;
  $('#dlg-wuerfel').showModal();
}

function wuerfeln() {
  const auswahl = $('#wuerfel-kategorie').value;
  const mitAngefangen = $('#wuerfel-angefangen').checked;
  ansicht.wuerfelAuswahl = auswahl;
  ansicht.wuerfelAngefangen = mitAngefangen;
  ansichtMerken();

  const pool = daten.spiele.filter((s) => {
    if (s.liste !== 'bibliothek') return false;
    if (!(s.status === 'offen' || (mitAngefangen && s.status === 'angefangen'))) return false;
    if (auswahl.startsWith('kat:')) return s.kategorie === auswahl.slice(4);
    if (auswahl.startsWith('bereich:')) return kategorieVon(s.kategorie)?.bereich === auswahl.slice(8);
    return true;
  });

  const box = $('#wuerfel-ergebnis');
  if (!pool.length) {
    box.innerHTML = '<div class="leise">Hier gibt es kein offenes Spiel mehr. Wähl eine andere Kategorie' +
      (mitAngefangen ? '.' : ' oder lass auch angefangene Spiele zu.') + '</div>';
    $('#wuerfel-nehmen').hidden = true;
    return;
  }
  const auswahlPool = pool.length > 1 ? pool.filter((s) => s.id !== letzterVorschlag) : pool;
  const s = auswahlPool[Math.floor(Math.random() * auswahlPool.length)];
  letzterVorschlag = s.id;
  box.innerHTML = `
    <div class="leise">${esc(s.kategorie)} · ${esc(STATUS_TEXT[s.status])}${s.spielzeit ? ` · bisher ${esc(s.spielzeit)}` : ''}</div>
    <div class="gross">${esc(s.name)}</div>
    ${s.beschreibung ? `<div>${esc(s.beschreibung)}</div>` : ''}
    <div class="leise">${pool.length} ${pool.length === 1 ? 'Spiel kam' : 'Spiele kamen'} infrage</div>`;
  box.classList.remove('wackeln');
  void box.offsetWidth;
  box.classList.add('wackeln');
  $('#wuerfel-los').textContent = '🎲 Nochmal';
  $('#wuerfel-nehmen').hidden = false;
}

function wuerfelDialogEinrichten() {
  $('#wuerfel-knopf').addEventListener('click', wuerfelDialogOeffnen);
  $('#wuerfel-los').addEventListener('click', wuerfeln);
  $('#wuerfel-kategorie').addEventListener('change', () => {
    $('#wuerfel-ergebnis').innerHTML = '';
    $('#wuerfel-nehmen').hidden = true;
    $('#wuerfel-los').textContent = '🎲 Würfeln';
  });
  $('#wuerfel-nehmen').addEventListener('click', () => {
    const s = daten.spiele.find((x) => x.id === letzterVorschlag);
    if (!s) return;
    if (s.status === 'offen') setzeStatus(s, 'angefangen');
    speichern();
    $('#dlg-wuerfel').close();
    zeigeHinweis(`Viel Spaß mit „${s.name}“!`);
    zeigeSpiel(s.id);
  });
}

/* ---------- Statistik ---------- */

function statistikOeffnen() {
  const bib = daten.spiele.filter((s) => s.liste === 'bibliothek');
  const wunsch = daten.spiele.filter((s) => s.liste === 'wunschliste');
  const zaehle = (st) => bib.filter((s) => s.status === st).length;
  const durch = zaehle('durchgespielt');
  const jahr = new Date().getFullYear();
  const diesesJahr = bib.filter((s) => s.status === 'durchgespielt' && s.durchgespieltAm?.startsWith(String(jahr))).length;
  const minuten = bib.reduce((summe, s) => summe + spielzeitMinuten(s.spielzeit), 0);
  const bewertet = daten.spiele.filter((s) => s.bewertung > 0);
  const schnitt = bewertet.length ? bewertet.reduce((a, s) => a + s.bewertung, 0) / bewertet.length : 0;
  const meistgespielt = [...bib].filter((s) => spielzeitMinuten(s.spielzeit) > 0)
    .sort((a, b) => spielzeitMinuten(b.spielzeit) - spielzeitMinuten(a.spielzeit)).slice(0, 5);
  const lieblinge = [...bewertet].sort((a, b) => b.bewertung - a.bewertung || a.name.localeCompare(b.name, 'de')).slice(0, 5);

  const farben = { angefangen: 'var(--st-angefangen)', durchgespielt: 'var(--st-durch)', abgebrochen: 'var(--st-ab)', offen: 'var(--st-offen)' };
  const reihe = ['durchgespielt', 'angefangen', 'abgebrochen', 'offen'];
  const verteilung = reihe.map((st) => {
    const n = zaehle(st);
    return n ? `<i style="width:${(n / bib.length) * 100}%;background:${farben[st]}" title="${STATUS_TEXT[st]}: ${n}"></i>` : '';
  }).join('');
  const legende = reihe.map((st) => `<span><i style="background:${farben[st]}"></i>${STATUS_TEXT[st]}: ${zaehle(st)}</span>`).join('');

  const katZeilen = daten.kategorien.filter((k) => k.liste === 'bibliothek').map((k) => {
    const alle = bib.filter((s) => s.kategorie === k.name);
    if (!alle.length) return '';
    const d = alle.filter((s) => s.status === 'durchgespielt').length;
    return `<div class="kat-zeile"><span>${esc(k.name)}</span><span class="leise">${d}/${alle.length}</span>
      <span class="balken" aria-hidden="true"><i style="width:${Math.round((d / alle.length) * 100)}%"></i></span></div>`;
  }).join('');

  $('#statistik-inhalt').innerHTML = `
    <div class="kacheln">
      <div class="kachel"><b>${durch}</b><span>von ${bib.length} durchgespielt (${bib.length ? Math.round((durch / bib.length) * 100) : 0} %)</span></div>
      <div class="kachel"><b>${diesesJahr}</b><span>durchgespielt in ${jahr}</span></div>
      <div class="kachel"><b>${stundenText(minuten)}</b><span>Spielzeit insgesamt</span></div>
      <div class="kachel"><b>${zaehle('angefangen')}</b><span>gerade angefangen</span></div>
      <div class="kachel"><b>${schnitt ? schnitt.toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' ★' : '–'}</b><span>Ø Bewertung (${bewertet.length} bewertet)</span></div>
      <div class="kachel"><b>${wunsch.length}</b><span>auf der Wunschliste</span></div>
    </div>
    <div>
      <h3>Status deiner Bibliothek</h3>
      <div class="verteilung" aria-hidden="true">${verteilung}</div>
      <div class="legende">${legende}</div>
    </div>
    ${meistgespielt.length ? `<div><h3>Meistgespielt</h3><ol>${meistgespielt.map((s) => `<li>${esc(s.name)} <span>– ${esc(s.spielzeit)}</span></li>`).join('')}</ol></div>` : ''}
    ${lieblinge.length ? `<div><h3>Deine Lieblinge</h3><ol>${lieblinge.map((s) => `<li>${esc(s.name)} <span class="gold" aria-label="${s.bewertung} Sterne">${'★'.repeat(s.bewertung)}</span></li>`).join('')}</ol></div>` : ''}
    <div><h3>Fortschritt je Kategorie</h3><div class="statistik">${katZeilen}</div></div>`;
  $('#dlg-statistik').showModal();
}

/* ---------- Synchronisation (Supabase) ---------- */

const sync = { client: null, user: null, zustand: 'aus', laeuft: false, nochmal: false, timer: null, kanal: null, fehler: '' };

function syncKonfiguration() {
  const c = window.SPIELE_CONFIG || {};
  let lokal = null;
  try { lokal = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null'); } catch { /* egal */ }
  return {
    url: (c.supabaseUrl || lokal?.url || '').trim(),
    key: (c.supabaseKey || lokal?.key || '').trim(),
    ausDatei: Boolean(c.supabaseUrl && c.supabaseKey),
  };
}

function skriptLaden(src) {
  return new Promise((ok, fehler) => {
    if (window.supabase?.createClient) return ok();
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => ok();
    el.onerror = () => fehler(new Error('Supabase-Bibliothek konnte nicht geladen werden'));
    document.head.appendChild(el);
  });
}

function syncZustand(zustand, fehler = '') {
  sync.zustand = zustand;
  sync.fehler = fehler;
  const knopf = $('#sync-knopf');
  knopf.dataset.zustand = zustand;
  const texte = {
    aus: 'Synchronisation: nicht eingerichtet', abgemeldet: 'Synchronisation: nicht angemeldet',
    ok: 'Synchronisation: alles abgeglichen', laeuft: 'Synchronisation läuft …',
    fehler: 'Synchronisation: Fehler', offline: 'Synchronisation: offline',
  };
  knopf.setAttribute('aria-label', texte[zustand] ?? 'Synchronisation');
  knopf.title = texte[zustand] ?? '';
  if ($('#dlg-sync').open) syncDialogAktualisieren();
}

async function syncStarten() {
  const cfg = syncKonfiguration();
  if (!cfg.url || !cfg.key) { syncZustand('aus'); return; }
  try {
    await skriptLaden('vendor/supabase.js');
    sync.client = window.supabase.createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'spieleliste.auth' },
    });
    const { data } = await sync.client.auth.getSession();
    sync.user = data.session?.user ?? null;
    sync.client.auth.onAuthStateChange((ereignis, session) => {
      const vorher = sync.user?.id;
      sync.user = session?.user ?? null;
      if (ereignis === 'PASSWORD_RECOVERY') passwortNeuSetzen();
      if (sync.user && sync.user.id !== vorher) { realtimeStarten(); syncJetzt(); }
      if (!sync.user) { realtimeStoppen(); syncZustand('abgemeldet'); }
    });
    if (sync.user) {
      realtimeStarten();
      syncJetzt();
    } else {
      syncZustand('abgemeldet');
    }
  } catch (e) {
    console.error(e);
    syncZustand('fehler', e.message);
  }
}

function realtimeStarten() {
  if (!sync.client || !sync.user || sync.kanal) return;
  sync.kanal = sync.client.channel('spieleliste-' + sync.user.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'spielelisten', filter: `user_id=eq.${sync.user.id}` },
      () => syncPlanen(400))
    .subscribe();
}

function realtimeStoppen() {
  if (sync.kanal) { sync.client.removeChannel(sync.kanal); sync.kanal = null; }
}

function syncPlanen(verzoegerung = 1500) {
  if (!sync.client || !sync.user) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(syncJetzt, verzoegerung);
}

async function syncJetzt() {
  if (!sync.client || !sync.user) return;
  if (sync.laeuft) { sync.nochmal = true; return; }
  if (!navigator.onLine) { syncZustand('offline'); return; }
  sync.laeuft = true;
  syncZustand('laeuft');
  try {
    const { data, error } = await sync.client.from('spielelisten').select('daten').eq('user_id', sync.user.id).maybeSingle();
    if (error) throw error;

    const vorher = vergleichsText(daten);
    let fernText = null;
    if (data?.daten) {
      const fern = normalisieren(data.daten);
      fernText = vergleichsText(fern);
      daten = zusammenfuehren(daten, fern);
    }
    const nachher = inhalt(daten);
    const nachherText = vergleichsText(daten);

    if (nachherText !== fernText) {
      const { error: fehler } = await sync.client.from('spielelisten')
        .upsert({ user_id: sync.user.id, daten: nachher, geaendert: jetzt() });
      if (fehler) throw fehler;
    }
    daten.letzterSync = jetzt();
    lokalSchreiben();
    if (nachherText !== vorher) {
      // Offene Bearbeitungsdialoge nicht stören – Liste trotzdem neu zeichnen
      rendern();
    }
    syncZustand('ok');
  } catch (e) {
    console.error('Sync-Fehler', e);
    syncZustand(navigator.onLine ? 'fehler' : 'offline', e.message || String(e));
  } finally {
    sync.laeuft = false;
    if (sync.nochmal) { sync.nochmal = false; syncPlanen(200); }
  }
}

function syncMeldung(text, istFehler = false) {
  const el = $('#sync-meldung');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('fehler', istFehler);
}

function syncDialogAktualisieren() {
  const cfg = syncKonfiguration();
  $('#sync-einrichten').hidden = Boolean(cfg.url && cfg.key);
  $('#sync-anmelden').hidden = !(cfg.url && cfg.key) || Boolean(sync.user);
  $('#sync-angemeldet').hidden = !sync.user;
  $('#sync-trennen').hidden = !(cfg.url && cfg.key) || cfg.ausDatei;
  if (sync.user) {
    const zustand = {
      ok: '✅ Alles abgeglichen', laeuft: '↻ Wird abgeglichen …', offline: '📴 Offline – wird nachgeholt, sobald du wieder online bist',
      fehler: `⚠️ Fehler: ${sync.fehler}`,
    }[sync.zustand] ?? '';
    $('#sync-info').innerHTML = `Angemeldet als <b>${esc(sync.user.email)}</b><br>${esc(zustand)}<br><span class="leise klein">Letzter Abgleich: ${esc(datumText(daten.letzterSync))}</span>`;
  }
}

function syncDialogOeffnen() {
  syncMeldung('');
  syncDialogAktualisieren();
  $('#dlg-sync').showModal();
}

function fehlerText(e) {
  const m = e?.message || String(e);
  if (/Invalid login credentials/i.test(m)) return 'E-Mail oder Passwort ist falsch.';
  if (/Email not confirmed/i.test(m)) return 'Bitte bestätige zuerst deine E-Mail-Adresse (Link in der Mail).';
  if (/already registered/i.test(m)) return 'Für diese E-Mail gibt es schon ein Konto. Bitte anmelden.';
  if (/Password should be/i.test(m)) return 'Das Passwort muss mindestens 8 Zeichen haben.';
  if (/signups not allowed|Signups not allowed/i.test(m)) return 'Neue Konten sind in Supabase gesperrt.';
  if (/Failed to send a request to the Edge Function|Requested function was not found|NOT_FOUND/i.test(m)) {
    return navigator.onLine
      ? `Die Steam-Funktion ist in Supabase nicht erreichbar. Die App sucht sie unter „…/functions/v1/${steamFunktion()}“. Stimmt das Ende der Adresse in Supabase (Edge Functions) nicht damit überein, muss der Name in config.js angepasst werden. Passt er, schau in Supabase unter Edge Functions → Logs nach einem Fehler.`
      : 'Du bist offline. Die Steam-Spielzeiten lassen sich nur mit Internet holen.';
  }
  if (/non-2xx status code/i.test(m)) return 'Die Steam-Funktion in Supabase hat einen Fehler gemeldet. Details stehen in Supabase unter Edge Functions → Logs.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Keine Verbindung zu Supabase. Bist du online? Stimmt die Project URL?';
  return m;
}

async function passwortNeuSetzen() {
  const pw = prompt('Neues Passwort für deine Spieleliste (mindestens 8 Zeichen):');
  if (!pw) return;
  const { error } = await sync.client.auth.updateUser({ password: pw });
  zeigeHinweis(error ? fehlerText(error) : 'Passwort geändert');
}

function syncDialogEinrichten() {
  $('#sync-knopf').addEventListener('click', syncDialogOeffnen);

  $('#sync-einrichten').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const url = f.url.value.trim().replace(/\/+$/, '');
    const key = f.key.value.trim();
    if (!/^https:\/\/.+/.test(url)) { syncMeldung('Die Project URL muss mit https:// beginnen.', true); return; }
    try { localStorage.setItem(SYNC_KEY, JSON.stringify({ url, key })); } catch { /* egal */ }
    syncMeldung('Verbinde …');
    await syncStarten();
    syncMeldung(sync.zustand === 'fehler' ? fehlerText(sync.fehler) : '', sync.zustand === 'fehler');
    syncDialogAktualisieren();
  });

  const clientDa = () => {
    if (sync.client) return true;
    syncMeldung('Keine Verbindung zu Supabase. Prüfe Project URL und Key oder lade die App neu.', true);
    return false;
  };

  $('#sync-anmelden').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!clientDa()) return;
    const f = e.target;
    syncMeldung('Melde an …');
    const { error } = await sync.client.auth.signInWithPassword({ email: f.email.value.trim(), password: f.passwort.value });
    if (error) { syncMeldung(fehlerText(error), true); return; }
    f.reset();
    syncMeldung('Angemeldet – deine Spiele werden abgeglichen.');
  });

  $('#sync-registrieren').addEventListener('click', async () => {
    const f = $('#sync-anmelden');
    if (!f.reportValidity() || !clientDa()) return;
    syncMeldung('Lege Konto an …');
    const { data, error } = await sync.client.auth.signUp({
      email: f.email.value.trim(), password: f.passwort.value,
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) { syncMeldung(fehlerText(error), true); return; }
    if (data.session) { syncMeldung('Konto angelegt und angemeldet.'); return; }
    syncMeldung('Fast geschafft: Du bekommst eine E-Mail. Tippe auf den Link darin und melde dich danach hier mit E-Mail und Passwort an.');
  });

  $('#sync-passwort-vergessen').addEventListener('click', async () => {
    const email = $('#sync-anmelden').email.value.trim();
    if (!email) { syncMeldung('Trag zuerst deine E-Mail-Adresse ein.', true); return; }
    if (!clientDa()) return;
    const { error } = await sync.client.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    syncMeldung(error ? fehlerText(error) : 'Du bekommst eine E-Mail mit einem Link zum Zurücksetzen.', Boolean(error));
  });

  $('#sync-jetzt').addEventListener('click', () => syncJetzt());

  $('#sync-abmelden').addEventListener('click', async () => {
    await sync.client?.auth.signOut();
    syncMeldung('Abgemeldet. Deine Spiele bleiben auf diesem Gerät gespeichert.');
    syncDialogAktualisieren();
  });

  $('#sync-trennen').addEventListener('click', async () => {
    if (!confirm('Verbindung zu Supabase auf diesem Gerät entfernen? Deine Spiele bleiben hier gespeichert.')) return;
    try { await sync.client?.auth.signOut(); } catch { /* egal */ }
    realtimeStoppen();
    localStorage.removeItem(SYNC_KEY);
    sync.client = null; sync.user = null;
    syncZustand('aus');
    syncMeldung('');
    syncDialogAktualisieren();
  });

  // Beim Zurückkehren in die App und wenn das Netz wieder da ist abgleichen
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncPlanen(300); });
  window.addEventListener('online', () => syncPlanen(300));
  window.addEventListener('offline', () => { if (sync.user) syncZustand('offline'); });
}

/* ---------- Steam-Spielzeiten ---------- */

function steamDialogOeffnen() {
  $('#dlg-menue').close();
  $('#steam-ergebnis').innerHTML = '';
  const bereit = Boolean(sync.client && sync.user);
  $('#steam-los').disabled = !bereit;
  $('#steam-text').textContent = bereit
    ? 'Holt deine aktuellen Spielzeiten aus Steam und trägt sie bei den passenden Spielen ein.'
    : 'Dafür brauchst du die Synchronisation (☁ oben) und die Steam-Funktion in Supabase. Die Anleitung steht in ANLEITUNG-SYNC.md, Teil 2.';
  $('#dlg-steam').showModal();
}

function steamSchluessel(name) {
  return namensSchluessel(String(name).replace(/\(.*?\)/g, '').replace(/[™®©]/g, ''));
}

async function steamHolen() {
  const knopf = $('#steam-los');
  knopf.disabled = true;
  knopf.textContent = 'Frage Steam …';
  const box = $('#steam-ergebnis');
  try {
    const { data, error } = await sync.client.functions.invoke(steamFunktion(), { method: 'POST', body: {} });
    if (error) {
      let detail = error.message;
      try { detail = (await error.context?.json())?.fehler || detail; } catch { /* egal */ }
      throw new Error(detail);
    }
    if (data?.fehler) throw new Error(data.fehler);
    const steamSpiele = data?.spiele ?? [];
    if (!steamSpiele.length) throw new Error('Steam hat keine Spiele geliefert. Ist im Steam-Profil „Spieldetails“ auf „Öffentlich“ gestellt?');

    const nachId = new Map(steamSpiele.map((g) => [g.appid, g]));
    const nachName = new Map(steamSpiele.map((g) => [steamSchluessel(g.name), g]));
    const gefunden = new Set();
    let aktualisiert = 0;
    const nichtGefunden = [];
    sicherungMachen();
    for (const s of daten.spiele.filter((x) => x.liste === 'bibliothek')) {
      const g = (s.steamAppId && nachId.get(s.steamAppId)) || nachName.get(steamSchluessel(s.name));
      if (!g) { nichtGefunden.push(s.name); continue; }
      gefunden.add(g.appid);
      const neueZeit = spielzeitText(g.minuten);
      if (s.spielzeit !== neueZeit || s.steamAppId !== g.appid) {
        if (s.spielzeit !== neueZeit) aktualisiert++;
        s.spielzeit = neueZeit;
        s.steamAppId = g.appid;
        beruehren(s);
      }
    }
    speichern();
    rendern();
    const nurSteam = steamSpiele.filter((g) => !gefunden.has(g.appid)).sort((a, b) => b.minuten - a.minuten);
    box.innerHTML = `
      <p class="meldung">✅ ${steamSpiele.length} Spiele in deinem Steam-Konto · ${aktualisiert} Spielzeiten aktualisiert.</p>
      ${nichtGefunden.length ? `<details><summary>${nichtGefunden.length} Spiele hier nicht in Steam gefunden</summary>
        <p class="leise klein">Meist weicht nur der Name ab. Trag beim Spiel unter „Bearbeiten“ die Steam-App-ID ein, dann klappt es beim nächsten Mal.</p>
        <ul>${nichtGefunden.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
      ${nurSteam.length ? `<details><summary>${nurSteam.length} Steam-Spiele, die hier fehlen</summary>
        <ul>${nurSteam.map((g) => `<li>${esc(g.name)} <span class="leise">(${esc(spielzeitText(g.minuten) ?? 'nie gespielt')}, App-ID ${g.appid})</span></li>`).join('')}</ul></details>` : ''}`;
    if (aktualisiert) zeigeHinweis(`${aktualisiert} Spielzeiten aktualisiert`, true);
  } catch (e) {
    box.innerHTML = `<p class="meldung fehler">${esc(fehlerText(e))}</p>`;
  } finally {
    knopf.disabled = false;
    knopf.textContent = '🎮 Spielzeiten jetzt holen';
  }
}

/* ---------- Menü: Export, Import, Zurücksetzen ---------- */

function exportDatei() {
  const heute = new Date().toISOString().slice(0, 10);
  const text = JSON.stringify({ ...inhalt(daten), exportiert: jetzt() }, null, 2);
  return new File([text], `spieleliste-${heute}.json`, { type: 'application/json' });
}

function exportVermerken() {
  daten.letzterExport = jetzt();
  lokalSchreiben();
}

function menueInfoAktualisieren() {
  const n = daten.spiele.length;
  let text = `${n} Spiele auf diesem Gerät. Zuletzt geändert: ${datumText(daten.geaendert)}. Letzter Export: ${datumText(daten.letzterExport)}.`;
  const tage = daten.letzterExport ? (Date.now() - new Date(daten.letzterExport)) / 864e5 : Infinity;
  if (!sync.user && tage > 14 && daten.geaendert && (!daten.letzterExport || daten.geaendert > daten.letzterExport)) {
    text += ' Tipp: Exportiere ab und zu als Sicherung.';
  }
  $('#menue-info').textContent = text;
  $('#app-version').textContent = `App-Version ${APP_VERSION}`;
}

// Ersetzt den kompletten Datenstand so, dass der Sync ihn auch auf andere Geräte überträgt
function datenErsetzen(neu) {
  const t = jetzt();
  const neueIds = new Set(neu.spiele.map((s) => s.id));
  const geloescht = { ...daten.geloescht, ...neu.geloescht };
  for (const s of daten.spiele) if (!neueIds.has(s.id)) geloescht[s.id] = t;
  for (const s of neu.spiele) { s.geaendert = t; delete geloescht[s.id]; }
  neu.geloescht = geloescht;
  for (const tipp of Object.values(neu.tipps)) tipp.geaendert = t;
  neu.letzterExport = daten.letzterExport;
  neu.letzterSync = daten.letzterSync;
  sicherungMachen();
  daten = neu;
  speichern();
}

async function importieren(datei) {
  let neu;
  try {
    neu = normalisieren(JSON.parse(await datei.text()));
  } catch (e) {
    alert('Die Datei konnte nicht gelesen werden.\n\n' + (e.message || e));
    return;
  }
  const hinweisSync = sync.user ? '\n\nDa die Synchronisation an ist, gilt das auch für deine anderen Geräte.' : '';
  const ok = confirm(`Daten ersetzen?\n\nAuf diesem Gerät: ${daten.spiele.length} Spiele\nIn der Datei: ${neu.spiele.length} Spiele\n\nDie Daten auf diesem Gerät werden durch die Datei ersetzt.${hinweisSync}`);
  if (!ok) return;
  datenErsetzen(neu);
  $('#dlg-menue').close();
  rendern();
  zeigeHinweis(`${neu.spiele.length} Spiele importiert`, true);
}

function menueEinrichten() {
  $('#menue-knopf').addEventListener('click', () => {
    menueInfoAktualisieren();
    try {
      $('#teilen-knopf').hidden = !(navigator.canShare && navigator.canShare({ files: [exportDatei()] }));
    } catch { $('#teilen-knopf').hidden = true; }
    $('#dlg-menue').showModal();
  });

  $('#steam-knopf').addEventListener('click', steamDialogOeffnen);
  $('#steam-los').addEventListener('click', steamHolen);

  $('#export-knopf').addEventListener('click', () => {
    const datei = exportDatei();
    const url = URL.createObjectURL(datei);
    const a = document.createElement('a');
    a.href = url;
    a.download = datei.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    exportVermerken();
    menueInfoAktualisieren();
    zeigeHinweis(`Gespeichert als ${datei.name}`);
  });

  $('#teilen-knopf').addEventListener('click', async () => {
    const datei = exportDatei();
    try {
      await navigator.share({ files: [datei], title: 'Meine Spiele (Export)' });
      exportVermerken();
      menueInfoAktualisieren();
    } catch (e) {
      if (e.name !== 'AbortError') zeigeHinweis('Teilen hat nicht geklappt');
    }
  });

  $('#import-knopf').addEventListener('click', () => $('#import-datei').click());
  $('#import-datei').addEventListener('change', async (e) => {
    const datei = e.target.files[0];
    e.target.value = '';
    if (datei) await importieren(datei);
  });

  $('#reset-knopf').addEventListener('click', async () => {
    const zusatz = sync.user ? ' Das gilt wegen der Synchronisation auch für deine anderen Geräte.' : '';
    if (!confirm('Alle Änderungen (Status, Notizen, Bewertungen, neue Spiele) verwerfen und die Startliste laden?' + zusatz)) return;
    try {
      datenErsetzen(await startdatenLaden());
      $('#dlg-menue').close();
      rendern();
      zeigeHinweis('Startdaten geladen', true);
    } catch (e) {
      alert('Die Startdaten konnten nicht geladen werden. Bist du offline?');
    }
  });
}

/* ---------- Kopf: Reiter, Suche, Filter, Ansicht ---------- */

function bedienungEinrichten() {
  for (const knopf of $$('.reiter-knopf')) {
    knopf.addEventListener('click', () => {
      if (ansicht.reiter === knopf.dataset.reiter) return;
      ansicht.reiter = knopf.dataset.reiter;
      ansicht.kategorie = '';
      ansichtMerken();
      rendern();
      window.scrollTo({ top: 0 });
    });
  }
  $('#suche').addEventListener('input', (e) => { suchtext = e.target.value.trim(); rendern(); });
  $('#filter-status').addEventListener('change', (e) => { ansicht.status = e.target.value; ansichtMerken(); rendern(); });
  $('#filter-kategorie').addEventListener('change', (e) => { ansicht.kategorie = e.target.value; ansichtMerken(); rendern(); });
  $('#erledigte-aus').addEventListener('change', (e) => { ansicht.erledigteAus = e.target.checked; ansichtMerken(); rendern(); });
  $('#sortierung').addEventListener('change', (e) => { ansicht.sortierung = e.target.value; ansichtMerken(); rendern(); });
  $('#kompakt-knopf').addEventListener('click', () => {
    ansicht.kompakt = !ansicht.kompakt;
    aufgeklappt.clear();
    ansichtMerken();
    rendern();
  });
  const reihenfolgeUmschalten = (an) => {
    reihenfolgeModus = an;
    if (an) {
      suchtext = ''; $('#suche').value = '';
      ansicht.status = ''; ansicht.erledigteAus = false;
    }
    rendern();
  };
  $('#reihenfolge-knopf').addEventListener('click', () => reihenfolgeUmschalten(!reihenfolgeModus));
  $('#reihenfolge-fertig').addEventListener('click', () => {
    reihenfolgeUmschalten(false);
    if (ansicht.sortierung !== 'eigene') {
      ansicht.sortierung = 'eigene';
      ansichtMerken();
      rendern();
      zeigeHinweis('Sortierung auf „Eigene Reihenfolge“ gestellt');
    }
  });
  const filterZuruecksetzen = () => {
    suchtext = ''; $('#suche').value = '';
    ansicht.status = ''; ansicht.kategorie = ''; ansicht.erledigteAus = false;
    ansichtMerken();
    rendern();
  };
  $('#filter-zuruecksetzen').addEventListener('click', filterZuruecksetzen);
  $('#liste').addEventListener('click', (e) => { if (e.target.closest('[data-filter-zuruecksetzen]')) filterZuruecksetzen(); });

  // Tastatur am PC: „/“ springt in die Suche, Escape leert sie
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input, textarea, select') && !$('dialog[open]')) {
      e.preventDefault();
      $('#suche').focus();
    }
  });
  $('#suche').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.value) { e.target.value = ''; suchtext = ''; rendern(); }
  });

  $('#neu-knopf').addEventListener('click', () => spielDialogOeffnen());
  $('#statistik-knopf').addEventListener('click', statistikOeffnen);
  $('#toast-knopf').addEventListener('click', () => {
    $('#toast').hidden = true;
    const aktion = hinweisAktion;
    hinweisAktion = null;
    aktion?.();
  });
}

/* ---------- Offline-Fähigkeit und Updates ---------- */

function serviceWorkerRegistrieren() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;

  let neuGeladen = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (neuGeladen) return;
    neuGeladen = true;
    location.reload();
  });

  const updateAnbieten = (worker) => {
    zeigeHinweis('Neue Version verfügbar', {
      knopf: 'Aktualisieren', dauer: 0,
      aktion: () => worker.postMessage({ typ: 'jetzt-aktivieren' }),
    });
  };

  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (!reg) return;
    if (reg.waiting && navigator.serviceWorker.controller) updateAnbieten(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const neu = reg.installing;
      neu?.addEventListener('statechange', () => {
        if (neu.state === 'installed' && navigator.serviceWorker.controller) updateAnbieten(neu);
      });
    });
    // Bei jedem Zurückkehren in die App nach Updates schauen
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch((e) => console.warn('Service Worker nicht registriert', e));
}

/* ---------- Start ---------- */

async function start() {
  dialogeEinrichten();
  listeEinrichten();
  spielDialogEinrichten();
  gekauftDialogEinrichten();
  wuerfelDialogEinrichten();
  menueEinrichten();
  syncDialogEinrichten();
  tippEinrichten();
  bedienungEinrichten();
  try {
    await laden();
    rendern();
  } catch (e) {
    console.error(e);
    $('#liste').innerHTML = '<p class="leer">Die Spieleliste konnte nicht geladen werden.<br>Bitte prüfe die Internetverbindung und lade die Seite neu.</p>';
    return;
  }
  verknuepfungAusfuehren();
  serviceWorkerRegistrieren();
  syncStarten();
}

// Langes Drücken auf das App-Symbol (Android) bietet „Was soll ich spielen?“ und „Spiel hinzufügen“
function verknuepfungAusfuehren() {
  const aktion = new URLSearchParams(location.search).get('aktion');
  if (!aktion) return;
  history.replaceState(null, '', location.pathname);
  if (aktion === 'wuerfeln') {
    ansicht.reiter = 'bibliothek';
    rendern();
    wuerfelDialogOeffnen();
  } else if (aktion === 'neu') {
    spielDialogOeffnen();
  }
}

start();
