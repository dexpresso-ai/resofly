-- ============================================================
-- ResoFly — Native (eigen) agenda's + agenda-items
-- Date: 2026-06-25
--
-- Scope (fase 0 van het CalDAV-traject):
-- - Native agenda's = rijen in calendar_sources met provider = 'native'
--   (geen externe Google/Microsoft-koppeling). Ze erven het bestaande
--   deel-/zichtbaarheidsmodel (visibility) en de klant/project/notitie-
--   koppelingen.
-- - Nieuwe tabel calendar_events: één rij per CalDAV-resource (UID), met
--   geprojecteerde velden voor de UI plus ruimte voor de canonieke iCalendar-
--   tekst (icalendar_raw, gevuld zodra de telefoon via CalDAV PUT schrijft).
-- - Per-agenda change_seq-teller voor de latere CalDAV CTag/sync-token, plus
--   een per-event sync_rev + etag die bij elke wijziging meelopen.
--
-- Beveiliging:
-- - RLS staat lezen toe aan organisatieleden die de agenda mogen zien (eigen
--   agenda of met de organisatie gedeeld); schrijven alleen op NATIVE agenda's
--   die de gebruiker bezit of die org-breed gedeeld zijn.
-- ============================================================

begin;

-- ── 1. provider-checks uitbreiden met 'native' ──────────────────────────────
-- calendar_sources: native agenda's hebben geen externe connection.
alter table public.calendar_sources drop constraint if exists calendar_sources_provider_check;
alter table public.calendar_sources
  add constraint calendar_sources_provider_check check (provider in ('google','microsoft','native'));
alter table public.calendar_sources alter column connection_id drop not null;

-- Koppeltabellen: native agenda-items moeten ook aan klant/project/notitie
-- gekoppeld kunnen worden.
alter table public.calendar_event_links drop constraint if exists calendar_event_links_provider_check;
alter table public.calendar_event_links
  add constraint calendar_event_links_provider_check check (provider in ('google','microsoft','native'));

alter table public.note_calendar_links drop constraint if exists note_calendar_links_provider_check;
alter table public.note_calendar_links
  add constraint note_calendar_links_provider_check check (provider in ('google','microsoft','native'));

-- ── 2. Integriteitstrigger calendar_sources: native overslaan ───────────────
create or replace function public.enforce_calendar_sources_integrity()
returns trigger language plpgsql as $$
declare v_connection public.calendar_connections;
begin
  if new.provider = 'native' then
    -- Native agenda's horen niet aan een externe connection te hangen.
    if new.connection_id is not null then
      raise exception 'native calendar_sources mogen geen connection_id hebben' using errcode = '23514';
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

-- ── 3. change_seq-teller per agenda (basis voor CalDAV CTag/sync-token) ──────
alter table public.calendar_sources add column if not exists change_seq bigint not null default 0;

-- ── 4. Tabel calendar_events ────────────────────────────────────────────────
create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null references public.calendar_sources(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  -- iCalendar UID; de CalDAV-resource is <uid>.ics. Uniek binnen de agenda.
  uid text not null,
  -- Canonieke volledige iCalendar-tekst (van de telefoon via PUT). Voor in-app
  -- aangemaakte afspraken null: de Worker genereert dan uit de velden hieronder.
  icalendar_raw text,
  -- Geprojecteerde velden voor de UI en tijdvenster-queries.
  title text not null default '',
  description text,
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  timezone text,
  rrule text,
  exdate text[],
  recurs boolean not null default false,
  -- CalDAV-concurrency + sync.
  etag text not null default '',
  sequence integer not null default 0,
  sync_rev bigint not null default 0,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, uid)
);

create index if not exists idx_calendar_events_source_time
  on public.calendar_events(source_id, starts_at) where deleted_at is null;
create index if not exists idx_calendar_events_org
  on public.calendar_events(organization_id);
create index if not exists idx_calendar_events_sync
  on public.calendar_events(source_id, sync_rev);

-- ── 5. Trigger: change_seq ophogen + sync_rev/etag/updated_at stempelen ──────
-- Verwijderen gebeurt als soft-delete (deleted_at zetten = een UPDATE), dus een
-- BEFORE INSERT OR UPDATE-trigger volstaat om elke mutatie te tellen.
create or replace function public.bump_calendar_event_sync()
returns trigger language plpgsql as $$
declare v_seq bigint;
begin
  update public.calendar_sources
    set change_seq = change_seq + 1
    where id = new.source_id
    returning change_seq into v_seq;
  if v_seq is null then
    raise exception 'calendar_events.source_id verwijst naar een niet-bestaande agenda' using errcode = '23514';
  end if;
  new.sync_rev := v_seq;
  new.updated_at := now();
  -- ETag verandert bij elke mutatie (sterke validator voor CalDAV If-Match).
  new.etag := md5(new.id::text || ':' || v_seq::text);
  return new;
end; $$;

drop trigger if exists calendar_events_bump_sync on public.calendar_events;
create trigger calendar_events_bump_sync
  before insert or update on public.calendar_events
  for each row execute function public.bump_calendar_event_sync();

drop trigger if exists calendar_events_prevent_org_change on public.calendar_events;
create trigger calendar_events_prevent_org_change
  before update of organization_id on public.calendar_events
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists calendar_events_audit on public.calendar_events;
create trigger calendar_events_audit
  after insert or update or delete on public.calendar_events
  for each row execute function public.audit_row_change('calendar_event', 'title');

-- ── 6. RLS ──────────────────────────────────────────────────────────────────
alter table public.calendar_events enable row level security;

-- Lezen: organisatielid dat de agenda mag zien (eigen agenda of org-gedeeld).
drop policy if exists "calendar_events read" on public.calendar_events;
create policy "calendar_events read" on public.calendar_events for select using (
  public.can_read_org(organization_id)
  and exists (
    select 1 from public.calendar_sources s
    where s.id = calendar_events.source_id
      and s.organization_id = calendar_events.organization_id
      and (s.user_id = auth.uid() or s.visibility = 'organization')
  )
);

-- Schrijven: alleen op NATIVE agenda's die de gebruiker bezit of die org-breed
-- gedeeld zijn. (Externe Google/Microsoft-agenda's worden via hun API beschreven.)
drop policy if exists "calendar_events insert" on public.calendar_events;
create policy "calendar_events insert" on public.calendar_events for insert with check (
  public.can_write_org(organization_id)
  and exists (
    select 1 from public.calendar_sources s
    where s.id = calendar_events.source_id
      and s.organization_id = calendar_events.organization_id
      and s.provider = 'native'
      and (s.user_id = auth.uid() or s.visibility = 'organization')
  )
);

drop policy if exists "calendar_events update" on public.calendar_events;
create policy "calendar_events update" on public.calendar_events for update using (
  public.can_write_org(organization_id)
  and exists (
    select 1 from public.calendar_sources s
    where s.id = calendar_events.source_id
      and s.organization_id = calendar_events.organization_id
      and s.provider = 'native'
      and (s.user_id = auth.uid() or s.visibility = 'organization')
  )
) with check (
  public.can_write_org(organization_id)
  and exists (
    select 1 from public.calendar_sources s
    where s.id = calendar_events.source_id
      and s.organization_id = calendar_events.organization_id
      and s.provider = 'native'
      and (s.user_id = auth.uid() or s.visibility = 'organization')
  )
);

drop policy if exists "calendar_events delete" on public.calendar_events;
create policy "calendar_events delete" on public.calendar_events for delete using (
  public.can_write_org(organization_id)
  and exists (
    select 1 from public.calendar_sources s
    where s.id = calendar_events.source_id
      and s.organization_id = calendar_events.organization_id
      and s.provider = 'native'
      and (s.user_id = auth.uid() or s.visibility = 'organization')
  )
);

commit;
