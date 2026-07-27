-- Weekplanner: taken direct op een dag aanmaken en pas later koppelen.
--
-- Tot nu toe was `tasks.project_id` verplicht: een taak kon alleen binnen een project
-- bestaan, dus je moest eerst een project kiezen voor je iets kon inplannen. Vanaf nu
-- is het project optioneel en heeft een taak een eigen (optionele) klantkoppeling.
-- Daarmee kan ook "taak voor klant X, project nog onbekend".

alter table public.tasks alter column project_id drop not null;
alter table public.tasks add column if not exists client_id uuid references public.clients(id) on delete set null;

create index if not exists idx_tasks_org_client on public.tasks(organization_id, client_id);

-- Bestaande taken krijgen de klant van hun project, zodat de nieuwe kolom meteen klopt.
update public.tasks t
   set client_id = p.client_id
  from public.projects p
 where p.id = t.project_id
   and t.client_id is distinct from p.client_id;

-- Org-integriteit uitgebreid met de klantkoppeling. Zolang er een project mét klant aan
-- hangt is dat project leidend: de klant volgt automatisch en kan er niet van afwijken.
-- Bij een project zonder klant (intern project) blijft de eigen klantkeuze staan.
create or replace function public.enforce_tasks_org_integrity()
returns trigger language plpgsql as $$
declare
  v_project_client uuid;
begin
  perform public.assert_same_org_reference('public.projects', new.project_id, new.organization_id, 'tasks.project_id');
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'tasks.client_id');

  if new.project_id is not null then
    select client_id into v_project_client from public.projects where id = new.project_id;
    if v_project_client is not null then
      new.client_id := v_project_client;
    end if;
  end if;

  return new;
end; $$;

-- Trigger opnieuw aanmaken zodat hij ook op client_id afvuurt.
drop trigger if exists tasks_org_integrity on public.tasks;
create trigger tasks_org_integrity
  before insert or update of organization_id, project_id, client_id on public.tasks
  for each row execute function public.enforce_tasks_org_integrity();
