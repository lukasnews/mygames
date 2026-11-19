// Supabase Edge Function „steam-spielzeit“ (Version 2: monatlicher Abgleich)
// Holt deine Steam-Bibliothek (Spielzeit, zuletzt gespielt), Genres, Preise deiner
// Wunschliste und aktuelle Steam-Spiele als Vorschläge. Der Steam-Schlüssel bleibt auf dem Server.
// Benötigte Secrets (Edge Functions → Secrets): STEAM_API_KEY, STEAM_ID
// Optional: ERLAUBTE_EMAIL – dann darf nur dieses Konto die Funktion nutzen.
//
// Anfrage (alles optional):
//   { mitDetails: [appid, …],              // Spiele, deren Genres die App schon kennt
//     bibliothek: [{ id, name, appid }],   // nicht gefundene Spiele im Steam-Shop nachschlagen
//     erfolge: 'auto' | [appid, …],        // Erfolge prüfen: Hinweis auf „durchgespielt“
//     erfolgeOhne: [appid, …],             // bei 'auto' überspringen (erledigt oder abgelehnt)
//     wunsch: [{ id, name, appid }],       // Wunschliste: Preise und App-IDs nachschlagen
//     vorschlaege: true }                  // aktuelle Steam-Spiele als Kandidaten
// Ohne Angaben liefert sie nur die Bibliothek (wie Version 1).

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const antwort = (inhalt: unknown, status = 200) =>
  new Response(JSON.stringify(inhalt), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const LAND = 'at';
const SPRACHE = 'german';
const MAX_DETAILS = 40;      // Genres für so viele eigene Spiele pro Abgleich nachladen
const MAX_KANDIDATEN = 40;   // so viele aktuelle Steam-Spiele prüfen

// Abruf mit Zeitlimit; Fehler ergeben null statt eines Absturzes
async function holeJson(url: string, ms = 8000): Promise<any> {
  const steuerung = new AbortController();
  const timer = setTimeout(() => steuerung.abort(), ms);
  try {
    const r = await fetch(url, { signal: steuerung.signal, headers: { 'Accept-Language': 'de' } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Mehrere Abrufe mit begrenzter Gleichzeitigkeit (Steam mag keine Anfrage-Fluten)
async function nacheinander<T, R>(liste: T[], arbeit: (x: T) => Promise<R>, gleichzeitig = 4): Promise<R[]> {
  const ergebnis: R[] = new Array(liste.length);
  let i = 0;
  const helfer = async () => {
    while (i < liste.length) {
      const nr = i++;
      ergebnis[nr] = await arbeit(liste[nr]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(gleichzeitig, liste.length) }, helfer));
  return ergebnis;
}

const preisAus = (p: any) => p && typeof p.final === 'number'
  ? { final: p.final, initial: p.initial ?? p.final, waehrung: p.currency ?? 'EUR', rabatt: p.discount_percent ?? 0 }
  : null;

// Genres, Kategorien, Kurzbeschreibung und Preis eines Spiels aus dem Steam-Shop
async function details(appid: number) {
  const d = await holeJson(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=${SPRACHE}&cc=${LAND}`);
  const daten = d?.[appid]?.success ? d[appid].data : null;
  if (!daten) return null;
  return {
    appid,
    name: daten.name,
    typ: daten.type,
    genres: (daten.genres ?? []).map((g: any) => g.description),
    kategorien: (daten.categories ?? []).map((c: any) => c.description),
    beschreibung: String(daten.short_description ?? '').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .trim().slice(0, 400),
    preis: daten.is_free ? { final: 0, initial: 0, waehrung: 'EUR', rabatt: 0 } : preisAus(daten.price_overview),
  };
}

// Erfolge, die typischerweise das Ende der Story markieren (deutsch, englisch und interne Namen)
const ABSCHLUSS = /(durchgespielt|abspann|spiel (?:beendet|abgeschlossen|durch)|(?:beende|schlie(?:ß|ss)e|schaffe)\w* (?:das|die|den) (?:spiel|story|geschichte|kampagne|hauptstory|hauptgeschichte)|(?:story|geschichte|kampagne|hauptstory) (?:beendet|abgeschlossen)|finish(?:ed)?[ _]?(?:the[ _])?(?:game|story|campaign)|complet(?:e|ed)[ _]?(?:the[ _])?(?:game|story|campaign|main[ _]story)|beat[ _](?:the[ _])?game|game[ _]?(?:complete|completed|finished|beaten)|credits|ending|the[ _]end\b)/i;
const MAX_ERFOLGE = 40;

const zeitAus = (unix: number) => (unix ? new Date(unix * 1000).toISOString() : null);

async function erfolgeHolen(appid: number, apiSchluessel: string, steamId: string) {
  const u = new URL('https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/');
  u.searchParams.set('key', apiSchluessel);
  u.searchParams.set('steamid', steamId);
  u.searchParams.set('appid', String(appid));
  u.searchParams.set('l', SPRACHE);
  const d = await holeJson(u.toString());
  const liste = d?.playerstats?.achievements;
  if (!Array.isArray(liste) || !liste.length) return null;   // Spiel ohne Erfolge
  const erreicht = liste.filter((a: any) => a.achieved);
  const abschluss = liste.filter((a: any) => ABSCHLUSS.test(`${a.apiname ?? ''} ${a.name ?? ''} ${a.description ?? ''}`));
  const geschafft = abschluss.filter((a: any) => a.achieved).sort((a: any, b: any) => a.unlocktime - b.unlocktime);
  return {
    appid,
    gesamt: liste.length,
    erreicht: erreicht.length,
    abschlussVorhanden: abschluss.length > 0,
    abschluss: geschafft.length ? { name: geschafft[0].name ?? geschafft[0].apiname, zeit: zeitAus(geschafft[0].unlocktime) } : null,
  };
}

const schluessel = (name: string) =>
  name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

// Ähnliche Namen: einer beginnt mit dem anderen und ist nicht viel länger (gleiche Regel wie in der App)
const aehnlich = (a: string, b: string) => {
  if (!a || !b) return false;
  if (a === b) return true;
  const [kurz, lang] = a.length <= b.length ? [a, b] : [b, a];
  return lang.startsWith(kurz) && kurz.length >= 4 && kurz.length / lang.length >= 0.6;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // Leerzeichen und Zeilenumbrüche vom Kopieren entfernen
  const apiSchluessel = (Deno.env.get('STEAM_API_KEY') ?? '').trim();
  const steamId = (Deno.env.get('STEAM_ID') ?? '').trim();

  const fehlend = [!apiSchluessel && 'STEAM_API_KEY', !steamId && 'STEAM_ID'].filter(Boolean);
  if (fehlend.length) {
    // Nur die NAMEN vorhandener Steam-Secrets nennen (nie die Werte), um Tippfehler zu finden
    const vorhanden = Object.keys(Deno.env.toObject()).filter((n) => /steam/i.test(n));
    const gesehen = vorhanden.length ? `Gefunden habe ich: ${vorhanden.join(', ')}.` : 'Ich finde gar kein Secret mit „STEAM“ im Namen.';
    return antwort({
      fehler: `In Supabase ${fehlend.length > 1 ? 'fehlen die Secrets' : 'fehlt das Secret'} ${fehlend.join(' und ')}. ${gesehen} Die Namen müssen genau STEAM_API_KEY und STEAM_ID lauten.`,
    }, 500);
  }
  if (/^[0-9A-F]{32}$/i.test(steamId) && /^\d{17}$/.test(apiSchluessel)) {
    return antwort({ fehler: 'STEAM_API_KEY und STEAM_ID sind vertauscht. Bitte die beiden Werte in Supabase tauschen.' }, 500);
  }
  if (!/^\d{17}$/.test(steamId)) {
    return antwort({ fehler: `STEAM_ID muss deine 17-stellige Steam-ID sein (beginnt mit 7656…). Der eingetragene Wert hat ${steamId.length} Zeichen.` }, 500);
  }
  if (!/^[0-9A-F]{32}$/i.test(apiSchluessel)) {
    return antwort({ fehler: `STEAM_API_KEY sollte aus 32 Zeichen (0–9, A–F) bestehen. Der eingetragene Wert hat ${apiSchluessel.length} Zeichen.` }, 500);
  }

  // Optional nur ein bestimmtes Konto zulassen
  const erlaubt = Deno.env.get('ERLAUBTE_EMAIL');
  if (erlaubt) {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '' },
    });
    const nutzer = r.ok ? await r.json() : null;
    if (nutzer?.email?.toLowerCase() !== erlaubt.toLowerCase()) {
      return antwort({ fehler: 'Dieses Konto darf die Steam-Funktion nicht nutzen.' }, 403);
    }
  }

  let anfrage: any = {};
  try { anfrage = await req.json(); } catch { /* leere Anfrage ist erlaubt */ }
  const warnungen: string[] = [];

  // 1. Eigene Bibliothek mit Spielzeit und „zuletzt gespielt“
  const url = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/');
  url.searchParams.set('key', apiSchluessel);
  url.searchParams.set('steamid', steamId);
  url.searchParams.set('include_appinfo', '1');
  url.searchParams.set('include_played_free_games', '1');
  url.searchParams.set('format', 'json');
  const r = await fetch(url);
  if (!r.ok) {
    const grund = r.status === 401 || r.status === 403 ? 'Steam lehnt den API-Schlüssel ab.' : `Steam antwortet mit Fehler ${r.status}.`;
    return antwort({ fehler: grund }, 502);
  }
  const bibliothek = await r.json();
  const spiele = (bibliothek?.response?.games ?? []).map((g: any) => ({
    appid: g.appid,
    name: g.name,
    minuten: g.playtime_forever ?? 0,
    minuten2Wochen: g.playtime_2weeks ?? 0,
    zuletzt: g.rtime_last_played ? new Date(g.rtime_last_played * 1000).toISOString() : null,
  }));
  const besitz = new Set(spiele.map((s: any) => s.appid));

  // Nur Bibliothek gewünscht (Version-1-Verhalten)
  if (!anfrage.mitDetails && !anfrage.wunsch && !anfrage.vorschlaege && !anfrage.bibliothek && !anfrage.erfolge) return antwort({ spiele });

  // 2. Genres für eigene Spiele, die die App noch nicht kennt (zuletzt gespielte zuerst)
  const bekannt = new Set((anfrage.mitDetails ?? []).map(Number));
  const fehlendeDetails = spiele.filter((s: any) => !bekannt.has(s.appid))
    .sort((a: any, b: any) => (b.zuletzt ?? '').localeCompare(a.zuletzt ?? '') || b.minuten - a.minuten)
    .slice(0, MAX_DETAILS);
  const detailListe = (await nacheinander(fehlendeDetails, (s: any) => details(s.appid))).filter(Boolean);
  const detailsNachId: Record<number, any> = {};
  for (const d of detailListe) detailsNachId[d!.appid] = d;
  if (fehlendeDetails.length && !detailListe.length) warnungen.push('Genres konnten nicht aus dem Steam-Shop geladen werden.');

  // 3. Wunschliste: App-ID per Shop-Suche finden, aktuellen Preis holen
  const wunsch = await nacheinander((anfrage.wunsch ?? []).slice(0, 60), async (w: any) => {
    let appid = Number(w.appid) || null;
    let preis = null;
    if (!appid) {
      const suche = await holeJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(String(w.name).replace(/\(.*?\)/g, ''))}&l=${SPRACHE}&cc=${LAND}`);
      const treffer = suche?.items ?? [];
      const genau = treffer.find((t: any) => schluessel(t.name) === schluessel(w.name)) ?? treffer[0];
      if (genau) {
        appid = genau.id;
        if (genau.price) {
          const p = genau.price;
          preis = { final: p.final, initial: p.initial ?? p.final, waehrung: p.currency ?? 'EUR', rabatt: p.initial ? Math.round((1 - p.final / p.initial) * 100) : 0 };
        }
      }
    }
    if (appid && !preis) preis = (await details(appid))?.preis ?? null;
    return { id: w.id, appid, preis, besitz: appid ? besitz.has(appid) : false };
  }, 3);

  // 4. Spiele der App, die nicht im Konto gefunden wurden: im Steam-Shop nach der App-ID suchen
  const kontoSchluessel = spiele.map((s: any) => schluessel(s.name));
  const offen = (anfrage.bibliothek ?? []).filter((b: any) => {
    if (b.appid) return false; // App-ID schon bekannt
    const k = schluessel(String(b.name));
    return !kontoSchluessel.some((x: string) => aehnlich(k, x));
  }).slice(0, 30);
  const zuordnung = (await nacheinander(offen, async (b: any) => {
    const suche = await holeJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(String(b.name).replace(/\(.*?\)/g, ''))}&l=${SPRACHE}&cc=${LAND}`);
    const k = schluessel(String(b.name));
    const treffer = suche?.items ?? [];
    const passend = treffer.find((t: any) => schluessel(t.name) === k) ?? treffer.find((t: any) => aehnlich(k, schluessel(t.name)));
    return passend ? { id: b.id, appid: passend.id, name: passend.name, besitz: besitz.has(passend.id) } : null;
  }, 3)).filter(Boolean);

  // 5. Erfolge: Gibt es einen freigeschalteten Erfolg für das Story-Ende?
  //    erfolge: 'auto' → gespielte Spiele (ab 30 min) selbst auswählen, außer denen in erfolgeOhne
  const ohne = new Set((anfrage.erfolgeOhne ?? []).map(Number));
  const erfolgIds: number[] = anfrage.erfolge === 'auto'
    ? spiele.filter((s: any) => s.minuten >= 30 && !ohne.has(s.appid))
      .sort((a: any, b: any) => (b.zuletzt ?? '').localeCompare(a.zuletzt ?? '')).map((s: any) => s.appid)
    : (Array.isArray(anfrage.erfolge) ? anfrage.erfolge.map(Number) : []);
  const erfolgListe = (await nacheinander(erfolgIds.filter((id: number) => besitz.has(id)).slice(0, MAX_ERFOLGE),
    (appid: number) => erfolgeHolen(appid, apiSchluessel, steamId))).filter(Boolean);
  const erfolge: Record<number, any> = {};
  for (const e of erfolgListe) erfolge[e!.appid] = e;

  // 6. Kandidaten für Vorschläge: aktuelle Bestseller, Angebote und Neuerscheinungen
  let kandidaten: any[] = [];
  if (anfrage.vorschlaege) {
    const featured = await holeJson(`https://store.steampowered.com/api/featuredcategories/?cc=${LAND}&l=${SPRACHE}`);
    if (!featured) {
      warnungen.push('Aktuelle Steam-Spiele für Vorschläge konnten nicht geladen werden.');
    } else {
      const roh = [
        ...(featured.specials?.items ?? []).map((x: any) => ({ ...x, quelle: 'Angebot' })),
        ...(featured.top_sellers?.items ?? []).map((x: any) => ({ ...x, quelle: 'Bestseller' })),
        ...(featured.new_releases?.items ?? []).map((x: any) => ({ ...x, quelle: 'Neu erschienen' })),
      ];
      const gesehen = new Set<number>();
      const auswahl = roh.filter((x) => {
        if (!x?.id || gesehen.has(x.id) || besitz.has(x.id)) return false;
        gesehen.add(x.id);
        return true;
      }).slice(0, MAX_KANDIDATEN);
      const mitDetails = await nacheinander(auswahl, async (x: any) => {
        const d = await details(x.id);
        if (!d || d.typ !== 'game') return null;
        return { ...d, quelle: x.quelle };
      });
      kandidaten = mitDetails.filter(Boolean);
    }
  }

  return antwort({ spiele, details: detailsNachId, wunsch, zuordnung, erfolge, kandidaten, warnungen });
});
