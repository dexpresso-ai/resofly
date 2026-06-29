-- ============================================================
-- ResoFly — Urenregistratie (time tracking)
-- Date: 2026-06-29
--
-- Scope (fase 1):
-- - Werken vanuit de kalender: een agenda-koppeling (calendar_event_links) die
--   aan een klant/project hangt en waarvan `track_time` aanstaat, levert
--   automatisch een geregistreerde urenpost op. Daarvoor moet de koppeling de
--   eindtijd kennen, dus die wordt hier toegevoegd.
-- - Nieuwe tabel `time_entries` als enige bron van waarheid voor geregistreerde
--   uren: bron 'calendar' (afgeleid uit een koppeling, gesynchroniseerd via
--   trigger), 'manual' (handmatig) en 'timer' (start/stop).
-- - Optioneel uurtarief per project + bedrijfsbreed default, zodat het dashboard
--   declarabele waarde (€) kan tonen.
--
-- Beveiliging:
-- - RLS: lezen door organisatieleden, schrijven door org-schrijvers (zelfde
--   patroon als calendar_event_links). De sync-trigger draait in de context van
--   de org-schrijver die de koppeling muteert, dus RLS blijft sluitend.
-- ============================================================

begin;

-- ── 1. calendar_event_links uitbreiden ──────────────────────────────────────
-- De koppeling bewaarde alleen de starttijd; voor urenregistratie hebben we ook
-- de eindtijd nodig, plus of het een hele-dag-item is en of het meetelt.
alter table public.calendar_event_links
  add column if not exists event_ends_at timestamptz,
  add column if not exists event_all_day boolean not null default false,
  add column if not exists track_time boolean not null default true;

-- ── 2. Uurtarieven ──────────────────────────────────────────────────────────
alter table public.projects
  add column if not exists hourly_rate_cents integer;
alter table public.company_settings
  add column if not exists default_hourly_rate_cents integer;

-- Tarief resolven: project-tarief, anders het bedrijfsbrede default. NULL = geen
-- tarief bekend (dan toont de UI alleen uren, geen €).
create or replace function public.resolve_hourly_rate(p_organization_id uuid, p_project_id uuid)
returns integer language sql stable as $$
  select coalesce(
    (select hourly_rate_cents from public.projects where id = p_project_id),
    (select default_hourly_rate_cents from public.company_settings where organization_id = p_organization_id)
  );
$$;

-- ── 3. Tabel time_entries ───────────────────────────────────────────────────
create table if not exists public.time_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  -- Aan wie de uren toegerekend worden (kan afwijken van created_by).
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  source text not null default 'manual' check (source in ('manual','calendar','timer')),
  -- Bij source='calendar': de koppeling waaruit de post is afgeleid. Verwijderen
  -- van de koppeling ruimt de afgeleide urenpost automatisch op (FK cascade).
  -- Uniek zodat er per koppeling hooguit één afgeleide post bestaat (NULL voor
  -- handmatige/timer-posten telt niet mee in de uniciteit).
  calendar_event_link_id uuid references public.calendar_event_links(id) on delete cascade,
  description text,
  entry_date date not null default current_date,
  started_at timestamptz,
  ended_at timestamptz,
  minutes integer not null check (minutes >= 0),
  billable boolean not null default true,
  -- Snapshot van het gehanteerde tarief op het moment van registreren (optioneel).
  hourly_rate_cents integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (calendar_event_link_id)
);

create index if not exists idx_time_entries_org_date on public.time_entries(organization_id, entry_date desc);
create index if not exists idx_time_entries_project on public.time_entries(organization_id, project_id);
create index if not exists idx_time_entries_client on public.time_entries(organization_id, client_id);
create index if not exists idx_time_entries_user on public.time_entries(organization_id, user_id);
create index if not exists idx_time_entries_link on public.time_entries(calendar_event_link_id);

-- updated_at automatisch bijhouden.
create or replace function public.touch_time_entry_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end; $$;

drop trigger if exists time_entries_touch_updated_at on public.time_entries;
create trigger time_entries_touch_updated_at
  before update on public.time_entries
  for each row execute function public.touch_time_entry_updated_at();

-- Integriteit: project/klant horen bij dezelfde organisatie; klant wordt uit het
-- project afgeleid als die leeg is (zelfde patroon als validate_calendar_event_link).
create or replace function public.validate_time_entry()
returns trigger language plpgsql as $$
declare
  v_project_org uuid;
  v_project_client uuid;
  v_client_org uuid;
begin
  if new.project_id is not null then
    select organization_id, client_id into v_project_org, v_project_client
    from public.projects where id = new.project_id;
    if v_project_org is null then
      raise exception 'time_entries.project_id verwijst naar een niet-bestaand project' using errcode = '23514';
    end if;
    if v_project_org <> new.organization_id then
      raise exception 'time_entries.project_id hoort bij een andere organisatie' using errcode = '23514';
    end if;
    if new.client_id is null then
      new.client_id := v_project_client;
    end if;
  end if;

  if new.client_id is not null then
    select organization_id into v_client_org from public.clients where id = new.client_id;
    if v_client_org is null then
      raise exception 'time_entries.client_id verwijst naar een niet-bestaande klant' using errcode = '23514';
    end if;
    if v_client_org <> new.organization_id then
      raise exception 'time_entries.client_id hoort bij een andere organisatie' using errcode = '23514';
    end if;
  end if;

  return new;
end; $$;

drop trigger if exists time_entries_validate on public.time_entries;
create trigger time_entries_validate
  before insert or update on public.time_entries
  for each row execute function public.validate_time_entry();

drop trigger if exists time_entries_prevent_org_change on public.time_entries;
create trigger time_entries_prevent_org_change
  before update of organization_id on public.time_entries
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists time_entries_audit on public.time_entries;
create trigger time_entries_audit
  after insert or update or delete on public.time_entries
  for each row execute function public.audit_row_change('time_entry', 'description');

-- ── 4. Sync: koppeling → afgeleide urenpost ─────────────────────────────────
-- AFTER-trigger zodat new.client_id al door validate_calendar_event_link uit het
-- project is afgeleid. Draait als de org-schrijver die de koppeling muteert, dus
-- de RLS op time_entries (can_write_org + created_by = auth.uid()) blijft gelden.
create or replace function public.sync_time_entry_from_link()
returns trigger language plpgsql as $$
declare
  v_minutes integer;
  v_rate integer;
begin
  if new.track_time
     and (new.project_id is not null or new.client_id is not null)
     and new.event_ends_at is not null
     and not new.event_all_day
  then
    v_minutes := floor(extract(epoch from (new.event_ends_at - new.event_starts_at)) / 60)::int;
    if v_minutes is null or v_minutes <= 0 then
      delete from public.time_entries where calendar_event_link_id = new.id;
      return new;
    end if;
    v_rate := public.resolve_hourly_rate(new.organization_id, new.project_id);
    insert into public.time_entries (
      organization_id, created_by, user_id, project_id, client_id, source,
      calendar_event_link_id, description, entry_date, started_at, ended_at, minutes, billable, hourly_rate_cents
    ) values (
      new.organization_id, coalesce(auth.uid(), new.created_by), coalesce(new.created_by, auth.uid()),
      new.project_id, new.client_id, 'calendar', new.id,
      new.event_title_snapshot, (new.event_starts_at)::date, new.event_starts_at, new.event_ends_at,
      v_minutes, true, v_rate
    )
    on conflict (calendar_event_link_id) do update set
      project_id = excluded.project_id,
      client_id = excluded.client_id,
      description = excluded.description,
      entry_date = excluded.entry_date,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      minutes = excluded.minutes,
      hourly_rate_cents = excluded.hourly_rate_cents,
      updated_at = now();
    -- billable en user_id bewust niet overschreven: een handmatige wijziging
    -- (bv. niet-declarabel markeren) blijft behouden als de afspraak verschuift.
  else
    delete from public.time_entries where calendar_event_link_id = new.id;
  end if;
  return new;
end; $$;

drop trigger if exists calendar_event_links_sync_time on public.calendar_event_links;
create trigger calendar_event_links_sync_time
  after insert or update on public.calendar_event_links
  for each row execute function public.sync_time_entry_from_link();

-- ── 5. RLS ──────────────────────────────────────────────────────────────────
alter table public.time_entries enable row level security;

drop policy if exists "time_entries read" on public.time_entries;
create policy "time_entries read" on public.time_entries for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "time_entries insert" on public.time_entries;
create policy "time_entries insert" on public.time_entries for insert with check (
  public.can_write_org(organization_id)
  and created_by = auth.uid()
);

drop policy if exists "time_entries update" on public.time_entries;
create policy "time_entries update" on public.time_entries for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);

drop policy if exists "time_entries delete" on public.time_entries;
create policy "time_entries delete" on public.time_entries for delete using (
  public.can_write_org(organization_id)
);

commit;
