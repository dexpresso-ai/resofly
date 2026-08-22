-- Van klantvraag naar werkdag
--
-- Een ticket — het startpunt van klantwerk — had geen datum, geen toegewezene en
-- geen taakkoppeling, en de weekplanner las `tickets` niet eens. De enige uitweg
-- was "Project maken", en die functie leverde een project zonder start- en
-- einddatum en zonder enige taak af, dat op de projecttijdbalk als verzonnen
-- streepje van veertien dagen belandde.
--
-- Hier komt de directe weg bij: een ticket kun je op de planning zetten, en de
-- taak die daaruit ontstaat weet waar hij vandaan komt.
--
-- Veilig om meermaals te draaien.

begin;

-- ── 1. Een taak weet van welk ticket hij komt ───────────────────────────
alter table public.tasks
  add column if not exists ticket_id uuid references public.tickets(id) on delete set null;

comment on column public.tasks.ticket_id is
  'Optioneel: het ticket waaruit deze taak is ingepland. Leeg voor gewoon projectwerk.';

create index if not exists idx_tasks_ticket
  on public.tasks (organization_id, ticket_id)
  where ticket_id is not null;

-- Org-integriteit: het ticket moet bij dezelfde organisatie horen. De rest van
-- deze functie is ongewijzigd (project leidend voor de klant).
create or replace function public.enforce_tasks_org_integrity()
returns trigger language plpgsql as $$
declare
  v_project_client uuid;
begin
  perform public.assert_same_org_reference('public.projects', new.project_id, new.organization_id, 'tasks.project_id');
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'tasks.client_id');
  perform public.assert_same_org_reference('public.tickets', new.ticket_id, new.organization_id, 'tasks.ticket_id');

  if new.project_id is not null then
    select client_id into v_project_client from public.projects where id = new.project_id;
    if v_project_client is not null then
      new.client_id := v_project_client;
    end if;
  end if;

  return new;
end; $$;

drop trigger if exists tasks_org_integrity on public.tasks;
create trigger tasks_org_integrity
  before insert or update of organization_id, project_id, client_id, ticket_id on public.tasks
  for each row execute function public.enforce_tasks_org_integrity();

-- ── 2. Geen lege projecten meer uit een ticket ──────────────────────────
-- `convert_ticket_to_project` leverde een project zonder start- en einddatum en
-- zonder enige taak af. Zonder datums tekent de projecttijdbalk een verzonnen
-- balk van veertien dagen — dat leest als planning terwijl er niets gepland is —
-- en een leeg project geeft je geen enkel aanknopingspunt om te beginnen.
--
-- We zetten nu een eerlijke startdatum (vandaag) en maken één taak uit het
-- ticket zelf. Het einde blijft bewust leeg: dat weet op dit moment niemand, en
-- een gok is erger dan een gat.
create or replace function public.convert_ticket_to_project(p_ticket_id uuid, p_organization_id uuid)
returns public.projects
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_ticket public.tickets;
  v_project public.projects;
begin
  select * into v_ticket
  from public.tickets
  where id = p_ticket_id
    and organization_id = p_organization_id
    and public.can_write_org(p_organization_id)
  for update;

  if not found then raise exception 'Ticket niet gevonden of geen toegang' using errcode = 'P0002'; end if;
  if v_ticket.status = 'converted' or v_ticket.converted_to_project_id is not null then raise exception 'Ticket is al omgezet' using errcode = 'P0001'; end if;
  if v_ticket.status not in ('new','review','approved') then raise exception 'Ticketstatus % kan niet worden omgezet naar een project', v_ticket.status using errcode = 'P0001'; end if;

  insert into public.projects (organization_id, created_by, client_id, name, description, color, archived, start_date)
  values (
    v_ticket.organization_id,
    auth.uid(),
    v_ticket.client_id,
    v_ticket.title,
    v_ticket.description,
    case when v_ticket.priority = 'high' then '#f06b6b' else '#FFD966' end,
    false,
    current_date
  ) returning * into v_project;

  -- De eerste taak komt uit het ticket zelf, met de koppeling erbij, zodat het
  -- project niet leeg achterblijft en de taak weet waar hij vandaan komt.
  insert into public.tasks (organization_id, created_by, project_id, ticket_id, title, description, priority)
  values (
    v_ticket.organization_id,
    auth.uid(),
    v_project.id,
    v_ticket.id,
    v_ticket.title,
    v_ticket.description,
    v_ticket.priority
  );

  update public.tickets
  set status = 'converted', converted_to_project_id = v_project.id, updated_at = now()
  where id = p_ticket_id
    and organization_id = p_organization_id;

  return v_project;
end;
$$;

commit;
