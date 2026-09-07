-- ============================================================
-- ResoFly — Afspraak ↔ taak
-- Date: 2026-09-07
--
-- Een agenda-koppeling (`calendar_event_links`) hing aan een klant en een
-- project, en telde met `track_time` als urenpost. Sinds 20260822010000 kent
-- een urenpost ook een taak — maar de koppeling zelf niet. Daardoor kon een
-- meeting nooit "een deel van de taak" zijn: de uren landden op het project,
-- de kaart in de weekplanner wist van niets.
--
-- Scope:
-- - `calendar_event_links.task_id` (optioneel, `on delete set null`): een
--   afspraak hoort bij hooguit één taak; verdwijnt de taak, dan blijft de
--   koppeling met klant/project bestaan.
-- - De taak is leidend voor project en klant — precies de regel die
--   `validate_time_entry` al hanteert. Zo kan een meeting van project A nooit
--   op de kaart van project B belanden.
-- - De afgeleide urenpost krijgt de taak mee, zodat de weekplanner "gewerkt
--   van geschat" ook uit meetings kan halen. Een koppeling met alléén een taak
--   (losse taak zonder project of klant) telt nu ook mee voor de uren.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

alter table public.calendar_event_links
  add column if not exists task_id uuid references public.tasks(id) on delete set null;

comment on column public.calendar_event_links.task_id is
  'Optionele taak waar deze afspraak bij hoort. Leidend voor project en klant van de koppeling.';

-- Waar de weekplanner en het taakvenster op leunen: alle afspraken van één taak.
create index if not exists idx_calendar_event_links_task
  on public.calendar_event_links (organization_id, task_id)
  where task_id is not null;

-- ── Integriteit ─────────────────────────────────────────────────────────
-- Bestaande functie uit 20260617000002, uitgebreid met de taak. Bewust
-- dezelfde functie in plaats van een tweede trigger ernaast: twee triggers die
-- allebei `new.client_id` afleiden vechten om dezelfde waarde.
create or replace function public.validate_calendar_event_link()
returns trigger language plpgsql as $$
declare
  v_source public.calendar_sources;
  v_client_org uuid;
  v_project_org uuid;
  v_project_client uuid;
  v_task_org uuid;
  v_task_project uuid;
  v_task_client uuid;
begin
  select * into v_source from public.calendar_sources where id = new.calendar_source_id;
  if not found then
    raise exception 'calendar_event_links.calendar_source_id verwijst naar een niet-bestaande agenda' using errcode = '23514';
  end if;
  if v_source.organization_id <> new.organization_id then
    raise exception 'calendar_event_links.organization_id wijkt af van de gekoppelde agenda' using errcode = '23514';
  end if;
  if v_source.provider <> new.provider then
    raise exception 'calendar_event_links.provider wijkt af van de gekoppelde agenda-provider' using errcode = '23514';
  end if;
  new.provider_calendar_id := coalesce(new.provider_calendar_id, v_source.provider_calendar_id);

  -- Hangt de afspraak aan een taak, dan bepaalt die taak het project en de
  -- klant. Een losse taak (zonder project én klant) laat de eigen keuze staan.
  if new.task_id is not null then
    select organization_id, project_id, client_id
      into v_task_org, v_task_project, v_task_client
      from public.tasks where id = new.task_id;
    if v_task_org is null then
      raise exception 'calendar_event_links.task_id verwijst naar een niet-bestaande taak' using errcode = '23514';
    end if;
    if v_task_org <> new.organization_id then
      raise exception 'calendar_event_links.task_id hoort bij een andere organisatie' using errcode = '23514';
    end if;
    if v_task_project is not null then
      new.project_id := v_task_project;
    end if;
    if v_task_client is not null then
      new.client_id := v_task_client;
    end if;
  end if;

  if new.project_id is not null then
    select organization_id, client_id into v_project_org, v_project_client
    from public.projects where id = new.project_id;
    if v_project_org is null then
      raise exception 'calendar_event_links.project_id verwijst naar een niet-bestaand project' using errcode = '23514';
    end if;
    if v_project_org <> new.organization_id then
      raise exception 'calendar_event_links.project_id hoort bij een andere organisatie' using errcode = '23514';
    end if;
    -- Leid de klant af uit het project als die niet expliciet is gekozen.
    if new.client_id is null then
      new.client_id := v_project_client;
    end if;
  end if;

  if new.client_id is not null then
    select organization_id into v_client_org from public.clients where id = new.client_id;
    if v_client_org is null then
      raise exception 'calendar_event_links.client_id verwijst naar een niet-bestaande klant' using errcode = '23514';
    end if;
    if v_client_org <> new.organization_id then
      raise exception 'calendar_event_links.client_id hoort bij een andere organisatie' using errcode = '23514';
    end if;
  end if;

  return new;
end; $$;

drop trigger if exists calendar_event_links_validate on public.calendar_event_links;
create trigger calendar_event_links_validate
  before insert or update on public.calendar_event_links
  for each row execute function public.validate_calendar_event_link();

-- ── Sync: koppeling → afgeleide urenpost ────────────────────────────────
-- Laatste versie uit 20260629000001 (declarabel volgt het facturatietype van
-- het project), nu mét de taak. `validate_time_entry` leidt daar vervolgens
-- zelf project en klant uit af, dus die blijven consistent met de koppeling.
create or replace function public.sync_time_entry_from_link()
returns trigger language plpgsql as $$
declare
  v_minutes integer;
  v_rate integer;
  v_billable boolean := true;
begin
  if new.track_time
     and (new.task_id is not null or new.project_id is not null or new.client_id is not null)
     and new.event_ends_at is not null
     and not new.event_all_day
  then
    v_minutes := floor(extract(epoch from (new.event_ends_at - new.event_starts_at)) / 60)::int;
    if v_minutes is null or v_minutes <= 0 then
      delete from public.time_entries where calendar_event_link_id = new.id;
      return new;
    end if;
    v_rate := public.resolve_hourly_rate(new.organization_id, new.project_id);
    if new.project_id is not null then
      select (billing_type <> 'fixed_price') into v_billable from public.projects where id = new.project_id;
      v_billable := coalesce(v_billable, true);
    end if;
    insert into public.time_entries (
      organization_id, created_by, user_id, project_id, client_id, task_id, source,
      calendar_event_link_id, description, entry_date, started_at, ended_at, minutes, billable, hourly_rate_cents
    ) values (
      new.organization_id, coalesce(auth.uid(), new.created_by), coalesce(new.created_by, auth.uid()),
      new.project_id, new.client_id, new.task_id, 'calendar', new.id,
      new.event_title_snapshot, (new.event_starts_at)::date, new.event_starts_at, new.event_ends_at,
      v_minutes, v_billable, v_rate
    )
    on conflict (calendar_event_link_id) do update set
      project_id = excluded.project_id,
      client_id = excluded.client_id,
      task_id = excluded.task_id,
      description = excluded.description,
      entry_date = excluded.entry_date,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      minutes = excluded.minutes,
      hourly_rate_cents = excluded.hourly_rate_cents,
      updated_at = now();
    -- billable en user_id bewust niet overschreven bij update: handmatige
    -- declarabel-wijziging blijft behouden als de afspraak verschuift.
  else
    delete from public.time_entries where calendar_event_link_id = new.id;
  end if;
  return new;
end; $$;

drop trigger if exists calendar_event_links_sync_time on public.calendar_event_links;
create trigger calendar_event_links_sync_time
  after insert or update on public.calendar_event_links
  for each row execute function public.sync_time_entry_from_link();

commit;
