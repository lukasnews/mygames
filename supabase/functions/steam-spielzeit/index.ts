// Supabase Edge Function „steam-spielzeit“
// Holt deine Steam-Bibliothek mit Spielzeiten. Der Steam-Schlüssel bleibt auf dem Server.
// Benötigte Secrets (Edge Functions → Secrets): STEAM_API_KEY, STEAM_ID
// Optional: ERLAUBTE_EMAIL – dann darf nur dieses Konto die Funktion nutzen.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const antwort = (inhalt: unknown, status = 200) =>
  new Response(JSON.stringify(inhalt), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // Leerzeichen und Zeilenumbrüche vom Kopieren entfernen
  const schluessel = (Deno.env.get('STEAM_API_KEY') ?? '').trim();
  const steamId = (Deno.env.get('STEAM_ID') ?? '').trim();

  const fehlend = [!schluessel && 'STEAM_API_KEY', !steamId && 'STEAM_ID'].filter(Boolean);
  if (fehlend.length) {
    // Nur die NAMEN vorhandener Steam-Secrets nennen (nie die Werte), um Tippfehler zu finden
    const vorhanden = Object.keys(Deno.env.toObject()).filter((n) => /steam/i.test(n));
    const gesehen = vorhanden.length ? `Gefunden habe ich: ${vorhanden.join(', ')}.` : 'Ich finde gar kein Secret mit „STEAM“ im Namen.';
    return antwort({
      fehler: `In Supabase ${fehlend.length > 1 ? 'fehlen die Secrets' : 'fehlt das Secret'} ${fehlend.join(' und ')}. ${gesehen} Die Namen müssen genau STEAM_API_KEY und STEAM_ID lauten.`,
    }, 500);
  }
  if (/^[0-9A-F]{32}$/i.test(steamId) && /^\d{17}$/.test(schluessel)) {
    return antwort({ fehler: 'STEAM_API_KEY und STEAM_ID sind vertauscht. Bitte die beiden Werte in Supabase tauschen.' }, 500);
  }
  if (!/^\d{17}$/.test(steamId)) {
    return antwort({ fehler: `STEAM_ID muss deine 17-stellige Steam-ID sein (beginnt mit 7656…). Der eingetragene Wert hat ${steamId.length} Zeichen.` }, 500);
  }
  if (!/^[0-9A-F]{32}$/i.test(schluessel)) {
    return antwort({ fehler: `STEAM_API_KEY sollte aus 32 Zeichen (0–9, A–F) bestehen. Der eingetragene Wert hat ${schluessel.length} Zeichen.` }, 500);
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

  const url = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/');
  url.searchParams.set('key', schluessel);
  url.searchParams.set('steamid', steamId);
  url.searchParams.set('include_appinfo', '1');
  url.searchParams.set('include_played_free_games', '1');
  url.searchParams.set('format', 'json');

  const r = await fetch(url);
  if (!r.ok) {
    const grund = r.status === 401 || r.status === 403 ? 'Steam lehnt den API-Schlüssel ab.' : `Steam antwortet mit Fehler ${r.status}.`;
    return antwort({ fehler: grund }, 502);
  }
  const daten = await r.json();
  const spiele = (daten?.response?.games ?? []).map((g: { appid: number; name: string; playtime_forever: number }) => ({
    appid: g.appid,
    name: g.name,
    minuten: g.playtime_forever ?? 0,
  }));
  return antwort({ spiele });
});
