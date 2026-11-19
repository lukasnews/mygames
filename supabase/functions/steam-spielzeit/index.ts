// Supabase Edge Function „steam-spielzeit“ (Version 2: monatlicher Abgleich)
// Holt deine Steam-Bibliothek (Spielzeit, zuletzt gespielt), Genres, Preise deiner
// Wunschliste und aktuelle Steam-Spiele als Vorschläge. Der Steam-Schlüssel bleibt auf dem Server.
// Benötigte Secrets (Edge Functions → Secrets): STEAM_API_KEY, STEAM_ID
// Optional: ERLAUBTE_EMAIL – dann darf nur dieses Konto die Funktion nutzen.
//
// Anfrage (alles optional):
//   { mitDetails: [appid, …],              // Spiele, deren Genres die App schon kennt
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

const schluessel = (name: string) =>
  name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

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
  if (!anfrage.mitDetails && !anfrage.wunsch && !anfrage.vorschlaege) return antwort({ spiele });

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

  // 4. Kandidaten für Vorschläge: aktuelle Bestseller, Angebote und Neuerscheinungen
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

  return antwort({ spiele, details: detailsNachId, wunsch, kandidaten, warnungen });
});
