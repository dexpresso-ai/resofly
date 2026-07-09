-- ============================================================
-- ResoFly — Teamleden koppelen aan projecten + toewijzen aan taken
-- Date: 2026-07-10
--
-- Scope:
-- - Een project krijgt een "projectteam": specifieke organisatieleden die aan
--   het project zijn gekoppeld (project_members).
-- - Binnen dat project kunnen taken worden toegewezen aan één of meerdere leden
--   van dat projectteam (task_assignees — meerdere toewijzingen per taak).
--
-- Ontwerpkeuzes (afgestemd met de gebruiker):
-- - MEERDERE teamleden per taak → koppeltabel task_assignees i.p.v. een enkele
--   assignee-kolom.
-- - De koppeling is PUUR voor overzicht + toewijzing; ze beperkt GEEN toegang.
--   RLS op projects/tasks blijft ongewijzigd: elk organisatielid blijft alle
--   projecten zien/bewerken (can_read_org/can_write_org). Deze tabellen volgen
--   exact hetzelfde RLS-patroon.
-- - Invariant "taak-toewijzing komt uit het projectteam": de UI biedt alleen
--   projectleden aan, en als een lid van het projectteam wordt gehaald worden
--   diens toewijzingen op taken ván dat project automatisch opgeruimd
--   (cleanup-trigger hieronder). Cross-org/vreemde gebruikers worden op
--   insert geweigerd door een lidmaatschapscheck.
--
-- Beide tabellen zijn zuivere koppeltabellen (add/remove), dus zonder
-- updated_at: er zijn geen inhoudelijk muteerbare kolommen.
-- ============================================================

begin;

-- ── project_members ─────────────────────────────────────────────────────
create table if not exists public.project_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);

-- ── task_assignees ──────────────────────────────────────────────────────
create table if not exists public.task_assignees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (task_id, user_id)
);

-- ── Integriteit: project_members ────────────────────────────────────────
-- 1) project_id moet bij dezelfde organisatie horen (zelfde patroon als
--    enforce_projects_org_integrity / enforce_client_contacts_org_integrity).
-- 2) user_id moet daadwerkelijk lid zijn van diezelfde organisatie — anders
--    zou een willekeurige auth.users-id aan een project gekoppeld kunnen
--    worden (of een lid uit een andere organisatie).
create or replace function public.enforce_project_members_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.projects', new.project_id, new.organization_id, 'project_members.project_id');

  if not exists (
    select 1 from public.organization_members om
    where om.organization_id = new.organization_id
      and om.user_id = new.user_id
  ) then
    raise exception 'Alleen leden van deze organisatie kunnen aan een project worden gekoppeld'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists project_members_integrity on public.project_members;
create trigger project_members_integrity
  before insert or update of organization_id, project_id, user_id
  on public.project_members
  for each row execute function public.enforce_project_members_integrity();

-- ── Integriteit: task_assignees ─────────────────────────────────────────
-- Zelfde twee checks, nu voor de taak i.p.v. het project.
create or replace function public.enforce_task_assignees_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.tasks', new.task_id, new.organization_id, 'task_assignees.task_id');

  if not exists (
    select 1 from public.organization_members om
    where om.organization_id = new.organization_id
      and om.user_id = new.user_id
  ) then
    raise exception 'Alleen leden van deze organisatie kunnen aan een taak worden toegewezen'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists task_assignees_integrity on public.task_assignees;
create trigger task_assignees_integrity
  before insert or update of organization_id, task_id, user_id
  on public.task_assignees
  for each row execute function public.enforce_task_assignees_integrity();

-- ── Opruimen: lid van projectteam af → toewijzingen op dát project weg ───
-- Houdt de invariant "taak-toewijzing hoort bij het projectteam" robuust,
-- ook bij directe DB-mutaties (dus niet alleen via de app). Bij het
-- verwijderen van een heel project vervalt dit vanzelf via de FK-cascade
-- (projects → tasks → task_assignees).
create or replace function public.cleanup_task_assignees_on_member_removal()
returns trigger
language plpgsql
as $$
begin
  delete from public.task_assignees ta
  using public.tasks t
  where ta.task_id = t.id
    and t.project_id = old.project_id
    and ta.user_id = old.user_id
    and ta.organization_id = old.organization_id;
  return old;
end;
$$;

drop trigger if exists project_members_cleanup_assignees on public.project_members;
create trigger project_members_cleanup_assignees
  after delete on public.project_members
  for each row execute function public.cleanup_task_assignees_on_member_removal();

-- ── Bescherming tegen org-wissel + audit ────────────────────────────────
drop trigger if exists project_members_prevent_org_change on public.project_members;
create trigger project_members_prevent_org_change
  before update of organization_id on public.project_members
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists task_assignees_prevent_org_change on public.task_assignees;
create trigger task_assignees_prevent_org_change
  before update of organization_id on public.task_assignees
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists project_members_audit on public.project_members;
create trigger project_members_audit
  after insert or update or delete on public.project_members
  for each row execute function public.audit_row_change('project_member', 'user_id');

drop trigger if exists task_assignees_audit on public.task_assignees;
create trigger task_assignees_audit
  after insert or update or delete on public.task_assignees
  for each row execute function public.audit_row_change('task_assignee', 'user_id');

-- ── Indexen ─────────────────────────────────────────────────────────────
create index if not exists idx_project_members_org
  on public.project_members (organization_id, project_id);
create index if not exists idx_project_members_user
  on public.project_members (organization_id, user_id);
create index if not exists idx_task_assignees_org
  on public.task_assignees (organization_id, task_id);
create index if not exists idx_task_assignees_user
  on public.task_assignees (organization_id, user_id);

-- ── RLS (identiek patroon als projects/tasks/client_contacts) ───────────
alter table public.project_members enable row level security;

drop policy if exists "project_members read" on public.project_members;
create policy "project_members read" on public.project_members for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "project_members insert" on public.project_members;
create policy "project_members insert" on public.project_members for insert with check (
  public.can_write_org(organization_id)
);

drop policy if exists "project_members update" on public.project_members;
create policy "project_members update" on public.project_members for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);

drop policy if exists "project_members delete" on public.project_members;
create policy "project_members delete" on public.project_members for delete using (
  public.can_write_org(organization_id)
);

alter table public.task_assignees enable row level security;

drop policy if exists "task_assignees read" on public.task_assignees;
create policy "task_assignees read" on public.task_assignees for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "task_assignees insert" on public.task_assignees;
create policy "task_assignees insert" on public.task_assignees for insert with check (
  public.can_write_org(organization_id)
);

drop policy if exists "task_assignees update" on public.task_assignees;
create policy "task_assignees update" on public.task_assignees for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);

drop policy if exists "task_assignees delete" on public.task_assignees;
create policy "task_assignees delete" on public.task_assignees for delete using (
  public.can_write_org(organization_id)
);

commit;
