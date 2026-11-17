'use strict';

/* =========================================================
   Meine Spiele – Bibliothek und Wunschliste
   Alle Daten liegen im Browser (localStorage).
   ========================================================= */

const DATEN_KEY = 'spieleliste.daten.v1';
const ANSICHT_KEY = 'spieleliste.ansicht.v1';
const STARTDATEN_URL = 'spiele.json';

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
const ERLEDIGT = new Set(['durchgespielt', 'abgebrochen']);
const STANDARD_ZIEL_NACH_KAUF = 'Top: genau dein Ding';

let daten = null;            // { version, kategorien, spiele, geaendert, letzterExport }
let ansicht = {
  reiter: 'bibliothek', status: '', kategorie: '', erledigteAus: false,
  zu: {}, wuerfelAuswahl: 'bereich:Story-Wunsch', wuerfelAngefangen: false,
};
let suchtext = '';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

/* ---------- Hilfsfunktionen ---------- */

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (z) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[z]));
}

function neueId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function fuerSuche(text) {
  return String(text).toLocaleLowerCase('de').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function datumText(iso) {
  if (!iso) return 'noch nie';
  const d = new Date(iso);
  if (isNaN(d)) return 'unbekannt';
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function kategorieVon(name) {
  return daten.kategorien.find((k) => k.name === name);
}

function listeVonBereich(bereich) {
  return BEREICHE[bereich]?.liste ?? null;
}

/* ---------- Daten laden, prüfen, speichern ---------- */

// Wandelt die Datei-Formate (Original-spiele.json oder Export dieser App) in das interne Format um.
function normalisieren(roh) {
  const spieleRoh = Array.isArray(roh) ? roh : roh?.spiele;
  if (!Array.isArray(spieleRoh)) throw new Error('Die Datei enthält keine Spieleliste.');

  const kategorien = [];
  const katNamen = new Map();
  const katHinzu = (k) => {
    if (!k?.name || katNamen.has(k.name)) return;
    let bereich = k.bereich;
    if (!BEREICHE[bereich]) bereich = k.liste === 'wunschliste' ? 'Wunschliste' : 'Für andere Laune';
    const kat = { name: String(k.name), info: String(k.info ?? k.kategorieInfo ?? ''), bereich, liste: listeVonBereich(bereich) };
    katNamen.set(kat.name, kat);
    kategorien.push(kat);
  };

  if (!Array.isArray(roh) && Array.isArray(roh.kategorien)) roh.kategorien.forEach(katHinzu);

  const spiele = [];
  const ids = new Set();
  for (const s of spieleRoh) {
    if (!s || typeof s.name !== 'string' || !s.name.trim()) continue;
    const katName = String(s.kategorie || (s.liste === 'wunschliste' ? 'Wunschliste' : 'Ohne Kategorie'));
    if (!katNamen.has(katName)) katHinzu({ name: katName, info: s.kategorieInfo, bereich: s.bereich, liste: s.liste });
    const kat = katNamen.get(katName);
    let status = String(s.status || 'offen');
    if (kat.liste === 'wunschliste' || !STATUS_BIBLIOTHEK.includes(status)) status = 'offen';
    let id = s.id ? String(s.id) : neueId();
    if (ids.has(id)) id = neueId();
    ids.add(id);
    const bewertung = Math.max(0, Math.min(5, Math.round(Number(s.bewertung) || 0)));
    spiele.push({
      id,
      name: s.name.trim(),
      beschreibung: String(s.beschreibung ?? ''),
      spielzeit: s.spielzeit ? String(s.spielzeit) : null,
      liste: kat.liste,
      kategorie: kat.name,
      status,
      notiz: String(s.notiz ?? ''),
      bewertung,
    });
  }
  if (!spiele.length) throw new Error('In der Datei wurden keine Spiele gefunden.');

  return {
    version: 1,
    kategorien,
    spiele,
    geaendert: roh.geaendert ?? null,
    letzterExport: roh.letzterExport ?? null,
  };
}

async function startdatenLaden() {
  const antwort = await fetch(STARTDATEN_URL, { cache: 'no-cache' });
  if (!antwort.ok) throw new Error('Startdaten konnten nicht geladen werden.');
  return normalisieren(await antwort.json());
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
    speichern();
  }
  let a = null;
  try { a = JSON.parse(localStorage.getItem(ANSICHT_KEY) || 'null'); } catch { /* egal */ }
  if (a && typeof a === 'object') {
    ansicht = { ...ansicht, ...a };
  } else {
    // Beim ersten Start: „Für andere Laune“ zugeklappt, damit der Story-Wunsch oben im Fokus steht
    for (const k of daten.kategorien) if (k.bereich === 'Für andere Laune') ansicht.zu[k.name] = true;
  }
}

function speichern() {
  daten.geaendert = new Date().toISOString();
  try {
    localStorage.setItem(DATEN_KEY, JSON.stringify(daten));
  } catch (e) {
    zeigeHinweis('Speichern fehlgeschlagen – bitte Daten exportieren!');
    console.error(e);
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

function ansichtMerken() {
  try { localStorage.setItem(ANSICHT_KEY, JSON.stringify(ansicht)); } catch { /* egal */ }
}

/* ---------- Rückgängig ---------- */

let rueckgaengigStand = null;

function sicherungMachen() {
  rueckgaengigStand = JSON.stringify(daten);
}

function rueckgaengig() {
  if (!rueckgaengigStand) return;
  daten = JSON.parse(rueckgaengigStand);
  rueckgaengigStand = null;
  speichern();
  rendern();
  zeigeHinweis('Rückgängig gemacht');
}

/* ---------- Hinweis-Leiste ---------- */

let hinweisTimer = null;
function zeigeHinweis(text, mitRueckgaengig = false) {
  const t = $('#toast');
  $('#toast-text').textContent = text;
  $('#toast-knopf').hidden = !mitRueckgaengig;
  t.hidden = false;
  clearTimeout(hinweisTimer);
  hinweisTimer = setTimeout(() => { t.hidden = true; }, mitRueckgaengig ? 6000 : 2600);
}

/* ---------- Filter ---------- */

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

function spielHtml(s) {
  const aktion = s.liste === 'bibliothek'
    ? `<select class="status-wahl st-${s.status}" data-aktion="status" aria-label="Status von ${esc(s.name)}">
        ${STATUS_BIBLIOTHEK.map((st) => `<option value="${st}"${st === s.status ? ' selected' : ''}>${STATUS_TEXT[st]}</option>`).join('')}
       </select>`
    : `<button class="klein-knopf haupt" data-aktion="gekauft">✓ Gekauft</button>`;
  return `
    <article class="spiel" data-id="${esc(s.id)}">
      <div class="spiel-kopf">
        <div class="spiel-name">${esc(s.name)}</div>
        <button class="klein-knopf" data-aktion="bearbeiten" aria-label="${esc(s.name)} bearbeiten">${STIFT}</button>
      </div>
      ${s.beschreibung ? `<p class="spiel-beschr">${esc(s.beschreibung)}</p>` : ''}
      ${s.spielzeit ? `<div class="spiel-meta"><span>⏱ Bisher gespielt: ${esc(s.spielzeit)}</span></div>` : ''}
      ${s.notiz ? `<div class="spiel-notiz">${esc(s.notiz)}</div>` : ''}
      <div class="spiel-aktionen">
        ${aktion}
        <span class="platz"></span>
        <span class="sterne" role="group" aria-label="Bewertung">${sterneHtml(s.bewertung)}</span>
      </div>
    </article>`;
}

function kategorieHtml(kat, alleSpiele, gefiltert, offenErzwingen) {
  const gesamt = alleSpiele.length;
  let fortschritt;
  if (kat.liste === 'bibliothek') {
    const durch = alleSpiele.filter((s) => s.status === 'durchgespielt').length;
    const ab = alleSpiele.filter((s) => s.status === 'abgebrochen').length;
    const prozent = gesamt ? Math.round((durch / gesamt) * 100) : 0;
    fortschritt = `<div class="fortschritt"><span>${durch}/${gesamt} durchgespielt${ab ? ` · ${ab} abgebrochen` : ''}</span>
      <span class="balken" aria-hidden="true"><i style="width:${prozent}%"></i></span></div>`;
  } else {
    fortschritt = `<div class="fortschritt"><span>${gesamt} ${gesamt === 1 ? 'Spiel' : 'Spiele'}</span></div>`;
  }
  const offen = offenErzwingen || !ansicht.zu[kat.name];
  return `
    <details class="kategorie" data-kategorie="${esc(kat.name)}"${offen ? ' open' : ''}>
      <summary>
        <span class="kat-name">${esc(kat.name)}${gefiltert.length !== gesamt ? ` <span class="zahl">(${gefiltert.length} von ${gesamt})</span>` : ''}</span>
        ${kat.info ? `<span class="kat-info">${esc(kat.info)}</span>` : ''}
        ${PFEIL}
        ${fortschritt}
      </summary>
      <div class="kat-spiele">${gefiltert.map(spielHtml).join('')}</div>
    </details>`;
}

function rendern() {
  // Reiter
  for (const knopf of $$('.reiter-knopf')) {
    knopf.setAttribute('aria-selected', String(knopf.dataset.reiter === ansicht.reiter));
  }
  $('#zahl-bibliothek').textContent = daten.spiele.filter((s) => s.liste === 'bibliothek').length;
  $('#zahl-wunschliste').textContent = daten.spiele.filter((s) => s.liste === 'wunschliste').length;

  // Filter-Felder
  const istBib = ansicht.reiter === 'bibliothek';
  const statusFeld = $('#filter-status');
  statusFeld.hidden = !istBib;
  statusFeld.innerHTML = '<option value="">Alle Status</option>' +
    STATUS_BIBLIOTHEK.map((st) => `<option value="${st}">${STATUS_TEXT[st]}</option>`).join('');
  statusFeld.value = ansicht.status;
  $('.filter').classList.toggle('einzeln', !istBib);
  $('#erledigte-zeile').hidden = !istBib;
  $('#erledigte-aus').checked = ansicht.erledigteAus;
  $('#wuerfel-knopf').hidden = !istBib;

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
      const kopf = ansicht.reiter === 'bibliothek' ? `<div class="bereich"><h2>${esc(b.titel)}</h2><p>${esc(b.text)}</p></div>` : '';
      html += kopf + teil;
    }
  }
  if (!treffer) {
    html = aktiv
      ? '<p class="leer">Keine Spiele gefunden.<br>Probier eine andere Suche oder setz die Filter zurück.</p>'
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
  const el = $(`.spiel[data-id="${CSS.escape(id)}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('markiert');
    setTimeout(() => el.classList.remove('markiert'), 1700);
  }
}

/* ---------- Aktionen in der Liste ---------- */

function aendereSpiel(id, aenderung) {
  const s = daten.spiele.find((x) => x.id === id);
  if (!s) return null;
  Object.assign(s, aenderung);
  speichern();
  rendern();
  return s;
}

function listeEinrichten() {
  const liste = $('#liste');

  liste.addEventListener('click', (e) => {
    const knopf = e.target.closest('[data-aktion]');
    if (!knopf || knopf.tagName === 'SELECT') return;
    const id = knopf.closest('.spiel')?.dataset.id;
    if (!id) return;
    const s = daten.spiele.find((x) => x.id === id);
    switch (knopf.dataset.aktion) {
      case 'stern': {
        const wert = Number(knopf.dataset.wert);
        aendereSpiel(id, { bewertung: s.bewertung === wert ? 0 : wert });
        break;
      }
      case 'bearbeiten': spielDialogOeffnen(id); break;
      case 'gekauft': gekauftDialogOeffnen(id); break;
    }
  });

  liste.addEventListener('change', (e) => {
    if (e.target.dataset.aktion !== 'status') return;
    const id = e.target.closest('.spiel').dataset.id;
    const status = e.target.value;
    const s = aendereSpiel(id, { status });
    if (status === 'durchgespielt') zeigeHinweis(`🎉 „${s.name}“ durchgespielt!`);
  });

  // Auf- und Zuklappen der Kategorien merken (nur ohne aktive Filter)
  liste.addEventListener('toggle', (e) => {
    const det = e.target;
    if (!det.matches?.('details.kategorie') || filterAktiv()) return;
    if (det.open) delete ansicht.zu[det.dataset.kategorie];
    else ansicht.zu[det.dataset.kategorie] = true;
    ansichtMerken();
  }, true);
}

/* ---------- Dialoge allgemein ---------- */

function dialogeEinrichten() {
  for (const d of $$('dialog')) {
    // Tipp auf den abgedunkelten Hintergrund schließt den Dialog
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
  statusSegmenteRendern(listeDerAuswahl(form), s?.status ?? 'offen');
  dialogSterneSetzen(s?.bewertung ?? 0);

  $('#dlg-spiel').showModal();
  if (!s) setTimeout(() => form.name.focus(), 50);
}

function spielDialogEinrichten() {
  const form = $('#form-spiel');

  form.kategorie.addEventListener('change', () => {
    $('#neue-kat').hidden = form.kategorie.value !== '__neu__';
    const aktuell = form.querySelector('input[name="status"]:checked')?.value;
    statusSegmenteRendern(listeDerAuswahl(form), aktuell);
  });
  form.neueKatBereich.addEventListener('change', () => {
    const aktuell = form.querySelector('input[name="status"]:checked')?.value;
    statusSegmenteRendern(listeDerAuswahl(form), aktuell);
  });

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

    // Kategorie bestimmen (ggf. neu anlegen)
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

    const werte = {
      name,
      beschreibung: form.beschreibung.value.trim(),
      spielzeit: form.spielzeit.value.trim() || null,
      notiz: form.notiz.value.trim(),
      bewertung: Number($('#feld-sterne').dataset.wert) || 0,
      kategorie: kat.name,
      liste: kat.liste,
      status,
    };

    if (bearbeiteId) {
      const s = daten.spiele.find((x) => x.id === bearbeiteId);
      const wechsel = s.liste !== werte.liste;
      Object.assign(s, werte);
      speichern();
      $('#dlg-spiel').close();
      rendern();
      zeigeHinweis(wechsel ? `Gespeichert – jetzt in der ${werte.liste === 'bibliothek' ? 'Bibliothek' : 'Wunschliste'}` : 'Gespeichert');
      return;
    }

    const neu = { id: neueId(), ...werte };
    daten.spiele.push(neu);
    speichern();
    $('#dlg-spiel').close();
    zeigeHinweis(`„${name}“ hinzugefügt`);
    // Filter, die das neue Spiel verstecken würden, zurücksetzen
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
    Object.assign(s, { liste: 'bibliothek', kategorie: kat.name, status: 'offen' });
    speichern();
    $('#dlg-gekauft').close();
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
  // Möglichst nicht zweimal hintereinander dasselbe Spiel
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
    if (s.status === 'offen') s.status = 'angefangen';
    speichern();
    $('#dlg-wuerfel').close();
    $('#wuerfel-los').textContent = '🎲 Würfeln';
    zeigeHinweis(`Viel Spaß mit „${s.name}“!`);
    zeigeSpiel(s.id);
  });
  $('#dlg-wuerfel').addEventListener('close', () => { $('#wuerfel-los').textContent = '🎲 Würfeln'; });
}

/* ---------- Menü: Export, Import, Zurücksetzen ---------- */

function exportDatei() {
  const inhalt = {
    app: 'spieleliste',
    version: 1,
    exportiert: new Date().toISOString(),
    kategorien: daten.kategorien,
    spiele: daten.spiele,
  };
  const heute = new Date().toISOString().slice(0, 10);
  return new File([JSON.stringify(inhalt, null, 2)], `spieleliste-${heute}.json`, { type: 'application/json' });
}

function exportVermerken() {
  daten.letzterExport = new Date().toISOString();
  try { localStorage.setItem(DATEN_KEY, JSON.stringify(daten)); } catch { /* egal */ }
}

function menueInfoAktualisieren() {
  const n = daten.spiele.length;
  let text = `${n} Spiele auf diesem Gerät. Zuletzt geändert: ${datumText(daten.geaendert)}. Letzter Export: ${datumText(daten.letzterExport)}.`;
  const tage = daten.letzterExport ? (Date.now() - new Date(daten.letzterExport)) / 864e5 : Infinity;
  if (tage > 14 && daten.geaendert && (!daten.letzterExport || daten.geaendert > daten.letzterExport)) {
    text += ' Tipp: Exportiere ab und zu als Sicherung.';
  }
  $('#menue-info').textContent = text;
}

async function importieren(datei) {
  let neu;
  try {
    neu = normalisieren(JSON.parse(await datei.text()));
  } catch (e) {
    alert('Die Datei konnte nicht gelesen werden.\n\n' + (e.message || e));
    return;
  }
  const ok = confirm(`Daten ersetzen?\n\nAuf diesem Gerät: ${daten.spiele.length} Spiele\nIn der Datei: ${neu.spiele.length} Spiele\n\nDie Daten auf diesem Gerät werden durch die Datei ersetzt.`);
  if (!ok) return;
  sicherungMachen();
  neu.letzterExport = daten.letzterExport;
  daten = neu;
  speichern();
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
    if (!confirm('Alle Änderungen (Status, Notizen, Bewertungen, neue Spiele) auf diesem Gerät verwerfen und die Startliste laden?')) return;
    try {
      const neu = await startdatenLaden();
      sicherungMachen();
      neu.letzterExport = daten.letzterExport;
      daten = neu;
      speichern();
      $('#dlg-menue').close();
      rendern();
      zeigeHinweis('Startdaten geladen', true);
    } catch (e) {
      alert('Die Startdaten konnten nicht geladen werden. Bist du offline?');
    }
  });
}

/* ---------- Kopf: Reiter, Suche, Filter ---------- */

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
  $('#neu-knopf').addEventListener('click', () => spielDialogOeffnen());
  $('#toast-knopf').addEventListener('click', () => { $('#toast').hidden = true; rueckgaengig(); });
}

/* ---------- Offline-Fähigkeit ---------- */

function serviceWorkerRegistrieren() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker nicht registriert', e));
}

/* ---------- Start ---------- */

async function start() {
  dialogeEinrichten();
  listeEinrichten();
  spielDialogEinrichten();
  gekauftDialogEinrichten();
  wuerfelDialogEinrichten();
  menueEinrichten();
  bedienungEinrichten();
  try {
    await laden();
    rendern();
  } catch (e) {
    console.error(e);
    $('#liste').innerHTML = '<p class="leer">Die Spieleliste konnte nicht geladen werden.<br>Bitte prüfe die Internetverbindung und lade die Seite neu.</p>';
  }
  serviceWorkerRegistrieren();
}

start();
