# Anleitung: Synchronisation und Steam-Spielzeiten

Die App funktioniert auch ohne diese Schritte. Mit Teil 1 werden deine Spiele automatisch
zwischen Handy und PC abgeglichen. Teil 2 holt zusätzlich deine Spielzeiten aus Steam.

Alles ist kostenlos. Zeitaufwand: Teil 1 etwa 15 Minuten, Teil 2 etwa 15 Minuten.

---

## Teil 1: Synchronisation mit Supabase

### 1. Konto und Projekt anlegen
1. Öffne https://supabase.com und klicke auf **Start your project**.
   Am einfachsten meldest du dich mit **Continue with GitHub** an.
2. Klicke auf **New project**:
   - **Name:** `privat` (das Projekt kann später auch deine anderen privaten Apps aufnehmen)
   - **Database Password:** auf **Generate a password** klicken und das Passwort
     in deinem Passwort-Manager speichern. Du brauchst es für die App nicht, aber für Notfälle.
   - **Region:** `Central EU (Frankfurt)`
   - **Create new project**. Danach 1–2 Minuten warten.

### 2. Tabelle anlegen
1. Links im Menü **SQL Editor** öffnen und dann **+ New query** wählen.
2. Den kompletten Inhalt der Datei `supabase/schema.sql` aus diesem Projekt hineinkopieren.
   Auf GitHub: Datei öffnen, oben rechts auf das Kopier-Symbol „Copy raw file“ klicken.
3. Unten rechts auf **Run** klicken. Es sollte „Success. No rows returned“ erscheinen.

### 3. Adresse der App eintragen
Damit landest du nach dem Klick auf den Bestätigungslink in der E-Mail in deiner App.
1. Links **Authentication** öffnen und dann **URL Configuration**.
2. Bei **Site URL** `https://mygames.chaoten.online` eintragen und **Save** klicken.
   (Es gibt nur eine Site URL pro Projekt. Das ist nur die Standard-Adresse, wenn eine App keine eigene angibt.
   Die Spieleliste gibt ihre Adresse selbst mit.)
3. Bei **Redirect URLs** auf **Add URL** klicken, `https://mygames.chaoten.online/**` eintragen und speichern.
   Kommen später weitere private Apps dazu, trägst du deren Adressen hier zusätzlich ein.

### 4. Zugangsdaten an die App geben
1. Links unten **Project Settings** (Zahnrad) öffnen und dann **API Keys**.
2. Den **Publishable key** kopieren (beginnt mit `sb_publishable_`).
   Gibt es den nicht, nimmst du unter „Legacy API Keys“ den **anon public** key.
3. Die **Project URL** findest du oben über den Knopf **Connect** oder unter
   **Project Settings → Data API**. Sie sieht so aus: `https://abcdefgh.supabase.co`
4. Für die Übergabe an die App hast du zwei Möglichkeiten:
   - **Einfach:** Schick mir (Claude) beide Werte. Ich trage sie in `config.js` ein, dann sind sie auf
     allen Geräten automatisch drin. Beide Werte sind nicht geheim, sie stehen sowieso in jeder Web-App.
   - **Selbst:** In der App oben auf die **Wolke ☁** tippen, beide Werte eintragen und **Verbinden** tippen.
     Das musst du dann auf jedem Gerät einmal machen.

### 5. Konto anlegen und anmelden
1. In der App auf die **Wolke ☁** tippen, E-Mail und ein Passwort (mindestens 8 Zeichen) eingeben
   und auf **Konto anlegen** tippen.
2. Du bekommst eine E-Mail von Supabase. Tippe darin auf den Link.
3. Zurück in der App mit E-Mail und Passwort auf **Anmelden** tippen.
4. Auf jedem weiteren Gerät (PC, Handy) einfach **Anmelden**, kein neues Konto.

**Tipp:** Melde dich zuerst auf dem Gerät an, auf dem deine Daten am aktuellsten sind.
Die App gleicht Spiel für Spiel ab, die jeweils neuere Änderung gewinnt.

Der kleine Punkt an der Wolke zeigt den Zustand:
grün = abgeglichen, blau blinkend = läuft gerade, orange = offline (wird nachgeholt), rot = Fehler.

### 6. Fremde Anmeldungen sperren (empfohlen)
Nachdem dein Konto angelegt ist:
**Authentication → Sign In / Providers**, dort **Allow new users to sign up** ausschalten und speichern.
Dann kann sich niemand sonst in deinem Projekt ein Konto anlegen.

### Weitere private Apps im selben Projekt
- Jede App bekommt ihre **eigenen Tabellen** mit eigenen Zugriffsregeln (Row Level Security).
  Die Spieleliste nutzt nur die Tabelle `spielelisten` und fasst nichts anderes an.
- Du hast **ein Konto für alle Apps**: dieselbe E-Mail und dasselbe Passwort.
- Die Gratis-Grenzen (z. B. 500 MB Datenbank) gelten für das ganze Projekt, also für alle Apps zusammen.
  Die Spieleliste braucht davon weniger als 1 MB.

### Gut zu wissen
- Kostenlose Supabase-Projekte werden nach etwa einer Woche **ohne jede Nutzung pausiert**.
  Du bekommst dann eine E-Mail und kannst das Projekt im Dashboard mit **Restore** wieder starten.
  Deine Daten bleiben erhalten, und die App funktioniert in der Zeit normal weiter (nur ohne Abgleich).
- Wenn du die App regelmäßig benutzt, passiert das nicht.

---

## Teil 2: Spielzeiten automatisch aus Steam holen

Voraussetzung: Teil 1 ist erledigt und du bist in der App angemeldet.

### 1. Steam-API-Schlüssel besorgen
1. Öffne https://steamcommunity.com/dev/apikey und melde dich mit deinem Steam-Konto an.
2. Bei **Domain Name** `mygames.chaoten.online` eintragen, den Bedingungen zustimmen und **Register** klicken.
3. Den angezeigten **Key** kopieren (32 Zeichen). Der ist **geheim**: Er kommt nur in Supabase,
   nirgendwo sonst hin und auch nicht in den Chat.

### 2. Deine Steam-ID herausfinden
- Im Steam-Programm oben rechts auf deinen Namen klicken, dann **Kontodetails**.
  Unter deinem Namen steht **Steam-ID: 7656119…** (17 Ziffern).
- Oder dein Profil im Browser öffnen: Steht in der Adresse `steamcommunity.com/profiles/7656119…`,
  ist das die Zahl.

### 3. Spieldetails öffentlich machen
Steam → dein Profil → **Profil bearbeiten** → **Privatsphäre-Einstellungen** →
**Spieldetails** auf **Öffentlich** stellen.
Wenn du **„Gesamte Spielzeit immer privat halten“** angehakt hast, nimm den Haken raus.

### 4. Die Steam-Funktion in Supabase anlegen
1. Im Supabase-Dashboard links **Edge Functions** öffnen, dann **Deploy a new function** und **Via Editor**.
2. Als Namen oben `steam-spielzeit` eintragen (genau so).
3. Den Beispielcode im Editor komplett löschen und den Inhalt von
   `supabase/functions/steam-spielzeit/index.ts` aus diesem Projekt einfügen.
4. Unten rechts auf **Deploy function** klicken.

### 5. Geheimnisse hinterlegen
**Edge Functions → Secrets** (oder **Project Settings → Edge Functions**), dann **Add new secret**:

| Name | Wert |
|---|---|
| `STEAM_API_KEY` | dein Steam-Schlüssel aus Schritt 1 |
| `STEAM_ID` | deine 17-stellige Steam-ID aus Schritt 2 |
| `ERLAUBTE_EMAIL` | deine E-Mail-Adresse aus der App (optional, aber empfohlen) |

Speichern mit **Save**.

### 6. Ausprobieren
In der App **⋯ → Spielzeiten von Steam holen → Spielzeiten jetzt holen**.
Danach siehst du, wie viele Spiele aktualisiert wurden und welche Namen nicht zugeordnet werden konnten.
Für solche Spiele trägst du unter **Bearbeiten → Steam-App-ID** die Nummer aus der Steam-Shop-Adresse ein,
z. B. `store.steampowered.com/app/620/` → `620`.
