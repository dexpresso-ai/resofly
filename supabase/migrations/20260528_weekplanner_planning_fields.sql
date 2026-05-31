-- Weekplanner hardening: separate planning from deadlines, stable ordering and workload estimates.
-- Safe to run multiple times.

alter table public.tasks
  add column if not exists planned_date date,
  add column if not exists planned_order integer,
  add column if not exists estimated_minutes integer not null default 60;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_estimated_minutes_range'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_estimated_minutes_range
      check (estimated_minutes >= 0 and estimated_minutes <= 1440);
  end if;
end $$;

-- Preserve the current UI behavior for existing data: historically end_date was used as the planner date.
-- From this migration onward, end_date remains the deadline and planned_date drives the planner.
update public.tasks
set planned_date = end_date
where planned_date is null
  and end_date is not null;

with ordered as (
  select
    id,
    row_number() over (
      partition by organization_id, planned_date
      order by coalesce(planned_order, 2147483647), created_at, id
    ) as rn
  from public.tasks
  where planned_date is not null
)
update public.tasks t
set planned_order = ordered.rn * 1000
from ordered
where ordered.id = t.id
  and (t.planned_order is null or t.planned_order <> ordered.rn * 1000);

create index if not exists idx_tasks_org_planned_date_order
  on public.tasks(organization_id, planned_date, planned_order, created_at, id);

create index if not exists idx_tasks_org_status_planned_date
  on public.tasks(organization_id, status, planned_date);

create or replace function public.compact_task_planning_order(
  p_organization_id uuid,
  p_planned_date date
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row record;
  v_index integer := 0;
begin
  if p_organization_id is null or p_planned_date is null then
    return;
  end if;

  for v_row in
    select id
    from public.tasks
    where organization_id = p_organization_id
      and planned_date = p_planned_date
    order by coalesce(planned_order, 2147483647), created_at, id
    for update
  loop
    v_index := v_index + 1;
    update public.tasks
    set planned_order = v_index * 1000,
        updated_at = now()
    where id = v_row.id;
  end loop;
end;
$$;

create or replace function public.reorder_task_planning(
  p_organization_id uuid,
  p_task_id uuid,
  p_planned_date date,
  p_before_task_id uuid default null
)
returns public.tasks
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_before_task public.tasks%rowtype;
  v_old_planned_date date;
  v_existing_ids uuid[] := array[]::uuid[];
  v_new_ids uuid[] := array[]::uuid[];
  v_id uuid;
  v_index integer := 0;
  v_inserted boolean := false;
  v_result public.tasks%rowtype;
begin
  if p_organization_id is null or p_task_id is null then
    raise exception 'Organisatie en taak zijn verplicht.';
  end if;

  if not public.can_write_org(p_organization_id) then
    raise exception 'Geen rechten om deze taak te plannen.' using errcode = '42501';
  end if;

  select * into v_task
  from public.tasks
  where id = p_task_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Taak niet gevonden binnen deze organisatie.';
  end if;

  v_old_planned_date := v_task.planned_date;

  if p_before_task_id is not null then
    if p_before_task_id = p_task_id then
      return v_task;
    end if;

    select * into v_before_task
    from public.tasks
    where id = p_before_task_id
      and organization_id = p_organization_id
    for update;

    if not found then
      raise exception 'Doeltaak niet gevonden binnen deze organisatie.';
    end if;

    if v_before_task.planned_date is distinct from p_planned_date then
      raise exception 'Doeltaak hoort niet bij deze plandatum.';
    end if;
  end if;

  if p_planned_date is null then
    update public.tasks
    set planned_date = null,
        planned_order = null,
        updated_at = now()
    where id = p_task_id
      and organization_id = p_organization_id
    returning * into v_result;

    if v_old_planned_date is not null then
      perform public.compact_task_planning_order(p_organization_id, v_old_planned_date);
    end if;

    return v_result;
  end if;

  -- Lock the destination date before rebuilding its sequence.
  perform 1
  from public.tasks
  where organization_id = p_organization_id
    and planned_date = p_planned_date
  order by coalesce(planned_order, 2147483647), created_at, id
  for update;

  select coalesce(array_agg(id order by coalesce(planned_order, 2147483647), created_at, id), array[]::uuid[])
  into v_existing_ids
  from public.tasks
  where organization_id = p_organization_id
    and planned_date = p_planned_date
    and id <> p_task_id;

  if p_before_task_id is null then
    v_new_ids := array_append(v_existing_ids, p_task_id);
  else
    foreach v_id in array v_existing_ids loop
      if v_id = p_before_task_id and not v_inserted then
        v_new_ids := array_append(v_new_ids, p_task_id);
        v_inserted := true;
      end if;
      v_new_ids := array_append(v_new_ids, v_id);
    end loop;

    if not v_inserted then
      v_new_ids := array_append(v_new_ids, p_task_id);
    end if;
  end if;

  foreach v_id in array v_new_ids loop
    v_index := v_index + 1;
    update public.tasks
    set planned_date = p_planned_date,
        planned_order = v_index * 1000,
        updated_at = now()
    where id = v_id
      and organization_id = p_organization_id;
  end loop;

  if v_old_planned_date is not null and v_old_planned_date <> p_planned_date then
    perform public.compact_task_planning_order(p_organization_id, v_old_planned_date);
  end if;

  select * into v_result
  from public.tasks
  where id = p_task_id
    and organization_id = p_organization_id;

  return v_result;
end;
$$;

grant execute on function public.compact_task_planning_order(uuid, date) to authenticated;
grant execute on function public.reorder_task_planning(uuid, uuid, date, uuid) to authenticated;
