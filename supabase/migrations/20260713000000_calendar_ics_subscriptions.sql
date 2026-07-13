-- ============================================================
-- ResoFly — Agenda's via link (iCal/ICS-abonnementen)
-- Date: 2026-07-13
--
-- Scope:
-- - Nieuw brontype: calendar_sources.provider = 'ics'. Een ICS-abonnement is
--   een read-only agenda die de gebruiker toevoegt met een iCal/ICS-URL (bv. de
--   "geheime" iCal-link uit Google Calendar of de gepubliceerde .ics uit Outlook).
--   Net als native agenda's heeft het GEEN externe OAuth-connection (connection_id
--   blijft null) en erft het het bestaande zichtbaarheids-/deelmodel (visibility).
-- - De opgehaalde afspraken worden gecachet als gewone rijen in calendar_events
--   (dezelfde tabel als native), gevuld door de edge function met de service-role.
--   Ze zijn READ-ONLY: de calendar_events-write-RLS staat schrijven alleen toe op
--   provider='native', dus de client kan ICS-items niet bewerken/verwijderen. De
--   sync-worker schrijft ze buiten RLS om (service-role).
-- - Feed-boekhouding op de bron: URL, ETag/hash voor conditionele GET, laatste
--   sync-tijd en laatste fout.
--
-- Beveiliging: geen nieuwe write-paden voor de client. De server-side fetch van de
-- feed-URL is SSRF-gehard in de edge function (alleen https, geen privé-IP's).
-- ============================================================

begin;

-- ── 1. provider-check uitbreiden met 'ics' ─────────────────────────────────
alter table public.calendar_sources drop constraint if exists calendar_sources_provider_check;
alter table public.calendar_sources
  add constraint calendar_sources_provider_check check (provider in ('google','microsoft','native','ics'));

-- ── 2. Feed-boekhouding (alleen gevuld voor provider='ics') ────────────────
alter table public.calendar_sources add column if not exists feed_url text;
alter table public.calendar_sources add column if not exists feed_etag text;
alter table public.calendar_sources add column if not exists feed_content_hash text;
alter table public.calendar_sources add column if not exists feed_last_synced_at timestamptz;
alter table public.calendar_sources add column if not exists feed_last_error text;

-- Een ICS-bron moet een feed-URL hebben en geen externe connection; niet-ICS
-- bronnen mogen geen feed_url dragen. (Constraint tolereert bestaande rijen:
-- die zijn allemaal niet-ICS en hebben feed_url null.)
alter table public.calendar_sources drop constraint if exists calendar_sources_ics_shape_check;
alter table public.calendar_sources
  add constraint calendar_sources_ics_shape_check check (
    (provider = 'ics' and feed_url is not null and connection_id is null)
    or (provider <> 'ics' and feed_url is null)
  );

-- ── 3. Integriteitstrigger: 'ics' net als 'native' loskoppelen van connections ─
create or replace function public.enforce_calendar_sources_integrity()
returns trigger language plpgsql as $$
declare v_connection public.calendar_connections;
begin
  -- Native én ICS agenda's horen niet aan een externe connection te hangen.
  if new.provider in ('native','ics') then
    if new.connection_id is not null then
      raise exception '% agenda mag geen connection_id hebben', new.provider using errcode = '23514';
    end if;
    return new;
  end if;
  select * into v_connection from public.calendar_connections where id = new.connection_id;
  if not found then raise exception 'calendar_sources.connection_id verwijst naar een niet-bestaande koppeling' using errcode = '23514'; end if;
  if v_connection.organization_id <> new.organization_id then raise exception 'calendar_sources.organization_id wijkt af van de gekoppelde calendar_connection' using errcode = '23514'; end if;
  if v_connection.user_id <> new.user_id then raise exception 'calendar_sources.user_id wijkt af van de gekoppelde calendar_connection' using errcode = '23514'; end if;
  if v_connection.provider <> new.provider then raise exception 'calendar_sources.provider wijkt af van de gekoppelde calendar_connection provider' using errcode = '23514'; end if;
  return new;
end; $$;

-- ── 4. Index voor de refresh-cron (ICS-bronnen op sync-leeftijd) ───────────
create index if not exists idx_calendar_sources_ics_refresh
  on public.calendar_sources(feed_last_synced_at)
  where provider = 'ics' and sync_enabled;

commit;
