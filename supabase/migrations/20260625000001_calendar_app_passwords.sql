-- ============================================================
-- ResoFly — App-wachtwoorden voor agenda-synchronisatie (CalDAV)
-- Date: 2026-06-25
--
-- Scope (fase 1 van het CalDAV-traject):
-- - CalDAV-clients (iPhone Apple Agenda, Android DAVx5) authenticeren met HTTP
--   Basic bij elke request. Daarvoor genereert een gebruiker per apparaat een
--   app-wachtwoord. Het wachtwoord is een willekeurig token met hoge entropie;
--   wij bewaren alleen een gesalte SHA-256-hash, nooit de plain tekst.
-- - Elk app-wachtwoord is aan één organisatie gebonden (een gebruiker kan in
--   meerdere organisaties zitten). De latere CalDAV-Worker leidt uit een geldig
--   wachtwoord het paar (user_id, organization_id) af.
--
-- Beveiliging:
-- - Net als calendar_connection_tokens: RLS aan, MAAR bewust GEEN policies. De
--   hash/salt zijn uitsluitend benaderbaar via Edge Functions / de CalDAV-Worker
--   met de service-role key. De client krijgt nooit hash of salt te zien.
-- ============================================================

begin;

create table if not exists public.calendar_app_passwords (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  label text not null default 'Apparaat',
  -- Gesalte SHA-256 (hex). Salt is per rij willekeurig.
  password_hash text not null,
  salt text not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_calendar_app_passwords_active
  on public.calendar_app_passwords(user_id, organization_id) where revoked_at is null;

-- Blokkeer verplaatsen naar een andere organisatie na aanmaken.
drop trigger if exists calendar_app_passwords_prevent_org_change on public.calendar_app_passwords;
create trigger calendar_app_passwords_prevent_org_change
  before update of organization_id on public.calendar_app_passwords
  for each row execute function public.prevent_organization_id_change();

-- RLS aan, geen policies: alleen toegankelijk via service-role (Edge Functions
-- en de CalDAV-Worker), nooit rechtstreeks vanuit de client.
alter table public.calendar_app_passwords enable row level security;

commit;
