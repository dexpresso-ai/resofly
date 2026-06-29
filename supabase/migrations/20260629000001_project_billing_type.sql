-- ============================================================
-- ResoFly — Projecttype: urenbasis vs aangenomen prijs
-- Date: 2026-06-29
--
-- Bij het aanmaken van een project kies je hoe het gefactureerd wordt:
-- - 'hourly'      = urenbasis → geregistreerde uren zijn de factuurbasis en komen
--                   standaard binnen als declarabel.
-- - 'fixed_price' = aangenomen prijs (offertetraject) → factureren loopt via
--                   offerte/factuur; uren worden wél geregistreerd voor inzicht,
--                   maar standaard NIET declarabel (ze zitten al in de vaste prijs).
--
-- De declarabel-default van afgeleide agenda-uren volgt hieronder het projecttype;
-- handmatige overrides blijven behouden (de sync-trigger overschrijft `billable`
-- bewust niet bij een update).
-- ============================================================

begin;

alter table public.projects
  add column if not exists billing_type text not null default 'hourly';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'projects_billing_type_check') then
    alter table public.projects
      add constraint projects_billing_type_check check (billing_type in ('hourly','fixed_price'));
  end if;
end $$;

-- Sync-trigger bijwerken: declarabel-default afgeleid uit het projecttype.
create or replace function public.sync_time_entry_from_link()
returns trigger language plpgsql as $$
declare
  v_minutes integer;
  v_rate integer;
  v_billable boolean := true;
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
    if new.project_id is not null then
      select (billing_type <> 'fixed_price') into v_billable from public.projects where id = new.project_id;
      v_billable := coalesce(v_billable, true);
    end if;
    insert into public.time_entries (
      organization_id, created_by, user_id, project_id, client_id, source,
      calendar_event_link_id, description, entry_date, started_at, ended_at, minutes, billable, hourly_rate_cents
    ) values (
      new.organization_id, coalesce(auth.uid(), new.created_by), coalesce(new.created_by, auth.uid()),
      new.project_id, new.client_id, 'calendar', new.id,
      new.event_title_snapshot, (new.event_starts_at)::date, new.event_starts_at, new.event_ends_at,
      v_minutes, v_billable, v_rate
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
    -- billable en user_id bewust niet overschreven bij update: handmatige
    -- declarabel-wijziging blijft behouden als de afspraak verschuift.
  else
    delete from public.time_entries where calendar_event_link_id = new.id;
  end if;
  return new;
end; $$;

commit;
