-- Uren aan de taak
--
-- `time_entries` had `project_id` en `client_id` maar geen `task_id`. Daardoor
-- kon wat de weekplanner per dag begroot structureel nooit tegen werkelijk
-- gemaakte uren worden gelegd: "begroot vs. werkelijk" bestond alleen op
-- projectniveau, met een handmatig ingetypt `budgeted_minutes`.
--
-- De koppeling is optioneel en `on delete set null`: een uur dat je schreef
-- blijft bestaan als de taak later verdwijnt. Dat is bewust — geschreven tijd is
-- een feit, ook als de planning eromheen wordt opgeruimd.
--
-- Veilig om meermaals te draaien.

begin;

alter table public.time_entries
  add column if not exists task_id uuid references public.tasks(id) on delete set null;

comment on column public.time_entries.task_id is
  'Optionele koppeling naar de taak waar dit uur bij hoort. Leeg = alleen op project/klant geboekt.';

-- Waar de weekplanner op leunt: alle uren van één taak.
create index if not exists idx_time_entries_task
  on public.time_entries (organization_id, task_id)
  where task_id is not null;

-- ── Integriteit ─────────────────────────────────────────────────────────
-- `validate_time_entry` bestaat al en controleert project en klant; die logica
-- blijft hier ongewijzigd staan en krijgt de taak erbij. Bewust dezelfde functie
-- uitbreiden in plaats van een tweede trigger ernaast zetten: twee triggers die
-- allebei `new.client_id` afleiden vechten om dezelfde waarde.
create or replace function public.validate_time_entry()
returns trigger language plpgsql as $$
declare
  v_project_org uuid;
  v_project_client uuid;
  v_client_org uuid;
  v_task_org uuid;
  v_task_project uuid;
  v_task_client uuid;
begin
  -- Hangt het uur aan een taak, dan is die taak leidend voor project en klant.
  -- Anders kun je een uur op taak A boeken dat op project B belandt, en dan is
  -- "begroot vs. werkelijk" per taak meteen weer onbetrouwbaar.
  if new.task_id is not null then
    select organization_id, project_id, client_id
      into v_task_org, v_task_project, v_task_client
      from public.tasks where id = new.task_id;
    if v_task_org is null then
      raise exception 'time_entries.task_id verwijst naar een niet-bestaande taak' using errcode = '23514';
    end if;
    if v_task_org <> new.organization_id then
      raise exception 'time_entries.task_id hoort bij een andere organisatie' using errcode = '23514';
    end if;
    new.project_id := v_task_project;
    if v_task_client is not null then
      new.client_id := v_task_client;
    end if;
  end if;

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

-- De bestaande trigger vuurt al op elke insert/update; opnieuw aanmaken zodat
-- een herdraai van deze migratie hem hoe dan ook aan de nieuwe functie hangt.
drop trigger if exists time_entries_validate on public.time_entries;
create trigger time_entries_validate
  before insert or update on public.time_entries
  for each row execute function public.validate_time_entry();

commit;
