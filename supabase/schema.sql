-- Spieleliste: Tabelle für die Synchronisation
-- In Supabase unter „SQL Editor“ → „New query“ einfügen und auf „Run“ klicken.

create table if not exists public.spielelisten (
  user_id   uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  daten     jsonb not null,
  geaendert timestamptz not null default now()
);

-- Jede Person darf nur ihre eigene Liste sehen und ändern
alter table public.spielelisten enable row level security;

drop policy if exists "Eigene Liste lesen" on public.spielelisten;
drop policy if exists "Eigene Liste anlegen" on public.spielelisten;
drop policy if exists "Eigene Liste ändern" on public.spielelisten;

create policy "Eigene Liste lesen" on public.spielelisten
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Eigene Liste anlegen" on public.spielelisten
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Eigene Liste ändern" on public.spielelisten
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Änderungen sofort an andere Geräte melden (Realtime)
do $$
begin
  alter publication supabase_realtime add table public.spielelisten;
exception when duplicate_object then null;
end $$;
