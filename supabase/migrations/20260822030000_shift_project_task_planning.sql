-- Als een project schuift, schuift zijn werk mee
--
-- De projecttijdbalk tekent uitsluitend `projects.start_date`/`end_date`, de
-- weekplanner uitsluitend taakdatums, en op de projectkanban komt `planned_date`
-- nul keer voor. Verzet je een project twee weken, dan blijven negen ingeplande
-- taken stilletjes staan waar ze stonden. Dat is geen ontbrekende functie maar
-- een stille fout: je ontdekt hem pas als de week eromheen niet meer klopt.
--
-- Eén RPC in één transactie, want een lus vanuit de client die halverwege
-- strandt laat de helft van je project verzet achter — precies wat
-- `carryOverTasks` vandaag laat zien.
--
-- De deadlines schuiven alleen mee als je daar expliciet om vraagt: doe je dat
-- niet, dan staat elke taak ineens ná zijn eigen deadline.
--
-- Veilig om meermaals te draaien.

begin;

create or replace function public.shift_project_task_planning(
  p_organization_id uuid,
  p_project_id uuid,
  p_task_ids uuid[],
  p_days integer,
  p_shift_deadlines boolean default false
)
returns setof public.tasks
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten in deze organisatie' using errcode = '42501';
  end if;

  if p_days = 0 or p_task_ids is null or array_length(p_task_ids, 1) is null then
    return;
  end if;

  if not exists (
    select 1 from public.projects
    where id = p_project_id and organization_id = p_organization_id
  ) then
    raise exception 'Project niet gevonden in deze organisatie' using errcode = '23514';
  end if;

  return query
  update public.tasks t
     set planned_date     = case when t.planned_date is null then null
                                 else t.planned_date + p_days end,
         planned_end_date = case when t.planned_end_date is null then null
                                 else t.planned_end_date + p_days end,
         start_date       = case when p_shift_deadlines and t.start_date is not null
                                 then t.start_date + p_days else t.start_date end,
         end_date         = case when p_shift_deadlines and t.end_date is not null
                                 then t.end_date + p_days else t.end_date end,
         updated_at       = now()
   where t.organization_id = p_organization_id
     and t.project_id = p_project_id
     and t.id = any(p_task_ids)
  returning t.*;
end;
$$;

revoke all on function public.shift_project_task_planning(uuid, uuid, uuid[], integer, boolean) from public;
grant execute on function public.shift_project_task_planning(uuid, uuid, uuid[], integer, boolean) to authenticated;

commit;
