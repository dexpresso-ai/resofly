-- ============================================================
-- ResoFly — Projectsjablonen (project_templates)
-- Date: 2026-07-30
--
-- Scope:
-- - Vakmensen die elk project op dezelfde manier aanpakken (filmmakers,
--   timmerlieden, fotografen) moeten hun vaste werkwijze één keer kunnen
--   vastleggen en daarna bij elk nieuw project kunnen uitrollen.
-- - `project_templates` is de sjabloonkop (naam + omschrijving).
-- - `project_template_tasks` bevat de standaardtaken van dat sjabloon, in
--   volgorde, elk met eigen subtaken.
--
-- Ontwerp:
-- - Subtaken staan als JSONB op de sjabloontaak, precies zoals `tasks.subtasks`
--   dat al doet. Een aparte tabel zou hier niets toevoegen: subtaken worden
--   altijd samen met hun taak gelezen en geschreven, en nooit los bevraagd.
--   Verschil met `tasks.subtasks`: in een sjabloon staat géén `done`, want een
--   sjabloon heeft geen voortgang. Die vlag komt er bij het uitrollen bij.
-- - Datums liggen in het sjabloon RELATIEF vast, als dagoffsets t.o.v. de
--   startdatum van het project ("deadline = dag +14"). Een sjabloon is immers
--   niet aan een kalender gebonden. Bij het uitrollen worden ze omgerekend naar
--   echte datums; zonder startdatum blijven de taken simpelweg zonder datum.
-- - Uitrollen gebeurt server-side via `apply_project_template()` zodat óf alle
--   taken worden aangemaakt, óf geen enkele — een half uitgerold sjabloon is
--   erger dan een leeg project. De functie draait bewust als `security invoker`:
--   het is een gewone schrijfactie, dus RLS moet gewoon van toepassing zijn.
--
-- Beveiliging:
-- - RLS zoals bij alle org-tabellen: lezen voor organisatieleden, schrijven voor
--   leden met schrijfrechten (`can_write_org`).
-- - `assert_same_org_reference` bewaakt dat een sjabloontaak nooit aan een
--   sjabloon van een ándere organisatie kan hangen, en dat `apply_project_template`
--   nooit een sjabloon van organisatie A op een project van organisatie B loslaat.
-- ============================================================

begin;

-- ── Sjabloonkop ────────────────────────────────────────────────────────────
create table if not exists public.project_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  name text not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.project_templates
  drop constraint if exists project_templates_name_not_blank;
alter table public.project_templates
  add constraint project_templates_name_not_blank
  check (length(btrim(name)) > 0);

create index if not exists idx_project_templates_org
  on public.project_templates (organization_id, is_active, name);

-- ── Sjabloontaken ──────────────────────────────────────────────────────────
-- Kolommen spiegelen `public.tasks` (status, priority, tags, estimated_minutes,
-- subtasks) zodat het uitrollen een rechttoe rechtaan kopie is; alleen de
-- datums zijn hier relatief.
create table if not exists public.project_template_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  template_id uuid not null references public.project_templates(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  position integer not null default 0,
  title text not null,
  description text,
  status text not null default 'todo' check (status in ('todo','doing','review','done')),
  priority text not null default 'med' check (priority in ('low','med','high')),
  tags text[] not null default '{}',
  -- Dagoffsets t.o.v. de projectstartdatum. null = die datum blijft leeg.
  start_offset_days integer check (start_offset_days between -3650 and 3650),
  due_offset_days integer check (due_offset_days between -3650 and 3650),
  planned_offset_days integer check (planned_offset_days between -3650 and 3650),
  estimated_minutes integer not null default 60 check (estimated_minutes >= 0 and estimated_minutes <= 1440),
  subtasks jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.project_template_tasks
  drop constraint if exists project_template_tasks_title_not_blank;
alter table public.project_template_tasks
  add constraint project_template_tasks_title_not_blank
  check (length(btrim(title)) > 0);

create index if not exists idx_project_template_tasks_template
  on public.project_template_tasks (template_id, position, created_at);
create index if not exists idx_project_template_tasks_org
  on public.project_template_tasks (organization_id, template_id);

-- Normaliseer de subtakenlijst: altijd een JSON-array van objecten met een
-- niet-lege `label` en een stabiele `id` (nodig als React-key in de editor).
-- Rommel uit een oudere client of een handmatige insert wordt hier stilzwijgend
-- opgeschoond in plaats van later in de UI te ontploffen.
create or replace function public.normalize_project_template_task_subtasks()
returns trigger language plpgsql as $$
declare
  v_item jsonb;
  v_label text;
  v_result jsonb := '[]'::jsonb;
begin
  new.title := btrim(coalesce(new.title, ''));
  new.description := nullif(btrim(coalesce(new.description, '')), '');

  if new.subtasks is null or jsonb_typeof(new.subtasks) <> 'array' then
    new.subtasks := '[]'::jsonb;
    return new;
  end if;

  for v_item in select value from jsonb_array_elements(new.subtasks) loop
    if jsonb_typeof(v_item) = 'string' then
      v_label := btrim(v_item #>> '{}');
    elsif jsonb_typeof(v_item) = 'object' then
      v_label := btrim(coalesce(v_item ->> 'label', ''));
    else
      v_label := '';
    end if;

    if v_label <> '' then
      v_result := v_result || jsonb_build_object(
        'id', coalesce(nullif(v_item ->> 'id', ''), gen_random_uuid()::text),
        'label', v_label
      );
    end if;
  end loop;

  new.subtasks := v_result;
  return new;
end; $$;

drop trigger if exists project_template_tasks_normalize on public.project_template_tasks;
create trigger project_template_tasks_normalize
  before insert or update of title, description, subtasks on public.project_template_tasks
  for each row execute function public.normalize_project_template_task_subtasks();

-- Org-integriteit: een sjabloontaak hoort bij een sjabloon van dezelfde
-- organisatie. Zonder deze check zou een lid van organisatie A taken kunnen
-- hangen onder een sjabloon van organisatie B.
create or replace function public.enforce_project_template_tasks_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.project_templates', new.template_id, new.organization_id, 'project_template_tasks.template_id');
  return new;
end; $$;

drop trigger if exists project_template_tasks_org_integrity on public.project_template_tasks;
create trigger project_template_tasks_org_integrity
  before insert or update of organization_id, template_id on public.project_template_tasks
  for each row execute function public.enforce_project_template_tasks_org_integrity();

-- ── Standaardtriggers (updated_at, org-lock, audit) ────────────────────────
drop trigger if exists project_templates_touch_updated_at on public.project_templates;
create trigger project_templates_touch_updated_at
  before update on public.project_templates
  for each row execute function public.set_updated_at();

drop trigger if exists project_templates_prevent_org_change on public.project_templates;
create trigger project_templates_prevent_org_change
  before update of organization_id on public.project_templates
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists project_templates_audit on public.project_templates;
create trigger project_templates_audit
  after insert or update or delete on public.project_templates
  for each row execute function public.audit_row_change('project_template', 'name');

drop trigger if exists project_template_tasks_touch_updated_at on public.project_template_tasks;
create trigger project_template_tasks_touch_updated_at
  before update on public.project_template_tasks
  for each row execute function public.set_updated_at();

drop trigger if exists project_template_tasks_prevent_org_change on public.project_template_tasks;
create trigger project_template_tasks_prevent_org_change
  before update of organization_id on public.project_template_tasks
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists project_template_tasks_audit on public.project_template_tasks;
create trigger project_template_tasks_audit
  after insert or update or delete on public.project_template_tasks
  for each row execute function public.audit_row_change('project_template_task', 'title');

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table public.project_templates enable row level security;

drop policy if exists "project_templates read" on public.project_templates;
create policy "project_templates read" on public.project_templates for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "project_templates insert" on public.project_templates;
create policy "project_templates insert" on public.project_templates for insert with check (
  public.can_write_org(organization_id)
);

drop policy if exists "project_templates update" on public.project_templates;
create policy "project_templates update" on public.project_templates for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);

drop policy if exists "project_templates delete" on public.project_templates;
create policy "project_templates delete" on public.project_templates for delete using (
  public.can_write_org(organization_id)
);

alter table public.project_template_tasks enable row level security;

drop policy if exists "project_template_tasks read" on public.project_template_tasks;
create policy "project_template_tasks read" on public.project_template_tasks for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "project_template_tasks insert" on public.project_template_tasks;
create policy "project_template_tasks insert" on public.project_template_tasks for insert with check (
  public.can_write_org(organization_id)
);

drop policy if exists "project_template_tasks update" on public.project_template_tasks;
create policy "project_template_tasks update" on public.project_template_tasks for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);

drop policy if exists "project_template_tasks delete" on public.project_template_tasks;
create policy "project_template_tasks delete" on public.project_template_tasks for delete using (
  public.can_write_org(organization_id)
);

-- ── Sjabloon uitrollen op een project ──────────────────────────────────────
-- Maakt in één transactie alle taken van het sjabloon aan op `p_project_id`.
-- Geeft het aantal aangemaakte taken terug.
--
-- `p_start_date` is het ankerpunt voor de dagoffsets. Is die null, dan valt de
-- functie terug op de startdatum van het project zelf; ontbreekt die ook, dan
-- worden er géén datums gezet (de taken komen dan datumloos binnen, precies
-- zoals een handmatig aangemaakte taak zonder datum).
create or replace function public.apply_project_template(
  p_organization_id uuid,
  p_project_id uuid,
  p_template_id uuid,
  p_start_date date default null
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_anchor date;
  v_template_task record;
  v_count integer := 0;
  v_start date;
  v_due date;
  v_planned date;
  v_planned_order integer;
begin
  if p_organization_id is null or p_project_id is null or p_template_id is null then
    raise exception 'Organisatie, project en sjabloon zijn verplicht.' using errcode = '23514';
  end if;

  -- Beide kanten moeten bij de meegegeven organisatie horen. De RLS-policies
  -- dekken al af dat de gebruiker in die organisatie mag schrijven; deze check
  -- voorkomt daarnaast dat een sjabloon en project van verschillende
  -- organisaties aan elkaar geknoopt worden.
  perform public.assert_same_org_reference('public.projects', p_project_id, p_organization_id, 'apply_project_template.p_project_id');
  perform public.assert_same_org_reference('public.project_templates', p_template_id, p_organization_id, 'apply_project_template.p_template_id');

  select coalesce(p_start_date, p.start_date) into v_anchor
  from public.projects p
  where p.id = p_project_id;

  for v_template_task in
    select *
    from public.project_template_tasks
    where template_id = p_template_id
      and organization_id = p_organization_id
    order by position, created_at
  loop
    v_start := case when v_anchor is not null and v_template_task.start_offset_days is not null
                    then v_anchor + v_template_task.start_offset_days end;
    v_due := case when v_anchor is not null and v_template_task.due_offset_days is not null
                  then v_anchor + v_template_task.due_offset_days end;
    v_planned := case when v_anchor is not null and v_template_task.planned_offset_days is not null
                      then v_anchor + v_template_task.planned_offset_days end;

    -- Weekplanner-volgorde. Zonder dit zouden alle uitgerolde taken planned_order
    -- NULL houden én dezelfde created_at delen (now() is transactietijd, niet
    -- rijtijd), waardoor de weekplanner ze op id — dus willekeurig — zou sorteren.
    -- We hangen ze achter wat er al op die dag staat, in sjabloonvolgorde; de
    -- stappen van 1000 zijn dezelfde als die reorder_task_planning gebruikt.
    if v_planned is null then
      v_planned_order := null;
    else
      select coalesce(max(planned_order), 0) + 1000 into v_planned_order
      from public.tasks
      where organization_id = p_organization_id
        and planned_date = v_planned;
    end if;

    insert into public.tasks (
      organization_id, created_by, project_id, title, description, status, priority, tags,
      start_date, end_date, planned_date, planned_order, estimated_minutes, subtasks, created_at
    ) values (
      p_organization_id,
      -- tasks.created_by heeft géén default (anders dan de meeste tabellen), dus
      -- expliciet zetten — anders staat een uitgerolde taak op naam van niemand.
      auth.uid(),
      p_project_id,
      v_template_task.title,
      v_template_task.description,
      v_template_task.status,
      v_template_task.priority,
      v_template_task.tags,
      v_start,
      v_due,
      v_planned,
      v_planned_order,
      v_template_task.estimated_minutes,
      -- Subtaken krijgen bij het uitrollen hun voortgangsvlag erbij.
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', coalesce(nullif(item ->> 'id', ''), gen_random_uuid()::text),
          'label', item ->> 'label',
          'done', false
        ))
        from jsonb_array_elements(v_template_task.subtasks) as item
      ), '[]'::jsonb),
      -- clock_timestamp() i.p.v. de default now(): now() is de TRANSACTIETIJD, dus
      -- alle uitgerolde taken zouden exact dezelfde created_at krijgen en overal
      -- op id — willekeurig — gesorteerd worden. Met de wandklok staan ze in
      -- sjabloonvolgorde, milliseconden uit elkaar.
      clock_timestamp()
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.apply_project_template(uuid, uuid, uuid, date) from public, anon;
grant execute on function public.apply_project_template(uuid, uuid, uuid, date) to authenticated, service_role;

commit;
