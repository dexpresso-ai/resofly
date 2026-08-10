-- Weekstroken: een taak kan over meerdere dagen lopen.
--
-- `planned_date` blijft de dag waarop het werk begint; `planned_end_date` is de
-- laatste dag. Blijft die leeg, dan is het een gewone dagtaak en verandert er
-- niets aan het bestaande gedrag. Veilig om meermaals te draaien.

alter table public.tasks
  add column if not exists planned_end_date date;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_planned_range'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_planned_range
      check (
        planned_end_date is null
        or (planned_date is not null and planned_end_date >= planned_date)
      );
  end if;
end $$;

create index if not exists idx_tasks_org_planned_range
  on public.tasks(organization_id, planned_date, planned_end_date);

-- Een taak op één dag laten vallen maakt er per definitie een dagtaak van; een
-- eventuele looptijd hoort dan te vervallen. Zonder dit zou een strook die in
-- een dagkolom belandt een einddatum vóór de startdatum kunnen krijgen en op de
-- check-constraint stuklopen. Alleen de versleepte taak wordt aangepast — de
-- overige taken op die dag worden in deze functie alleen hernummerd.
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
        planned_end_date = null,
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
        -- Alleen de versleepte taak verliest zijn looptijd.
        planned_end_date = case when v_id = p_task_id then null else planned_end_date end,
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

-- Zet of verschuift de looptijd van een taak: verplaatsen én herschalen van een
-- weekstrook lopen allebei hierlangs. Valt begin en einde op dezelfde dag, dan
-- wordt het weer een gewone dagtaak (`planned_end_date` leeg).
create or replace function public.set_task_planning_period(
  p_organization_id uuid,
  p_task_id uuid,
  p_planned_date date,
  p_planned_end_date date default null
)
returns public.tasks
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_old_planned_date date;
  v_end date;
  v_next_order integer;
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

  if p_planned_date is null then
    update public.tasks
    set planned_date = null,
        planned_end_date = null,
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

  v_end := case
             when p_planned_end_date is null or p_planned_end_date <= p_planned_date then null
             else p_planned_end_date
           end;

  -- Belandt de taak op een andere dag, dan sluit hij achteraan aan; blijft hij
  -- op zijn dag staan, dan houdt hij zijn plek in de rij.
  select coalesce(max(planned_order), 0) + 1000
  into v_next_order
  from public.tasks
  where organization_id = p_organization_id
    and planned_date = p_planned_date
    and id <> p_task_id;

  update public.tasks
  set planned_date = p_planned_date,
      planned_end_date = v_end,
      planned_order = case
                        when v_task.planned_date is distinct from p_planned_date or v_task.planned_order is null
                          then v_next_order
                        else v_task.planned_order
                      end,
      updated_at = now()
  where id = p_task_id
    and organization_id = p_organization_id;

  perform public.compact_task_planning_order(p_organization_id, p_planned_date);
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

grant execute on function public.set_task_planning_period(uuid, uuid, date, date) to authenticated;
