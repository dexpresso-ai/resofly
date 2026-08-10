-- Weekplanner fase 3 + 4
--
-- 1. Een taak mag voortaan zonder tijdschatting bestaan. `estimated_minutes`
--    stond op `not null default 60`, waardoor "niet ingevuld" en "precies een
--    uur" niet uit elkaar te houden waren en elk uurtotaal deels verzonnen was.
--    Bestaande waarden blijven staan; alleen nieuwe taken kunnen leeg zijn.
--
-- 2. De actiepunten van de week verhuizen van localStorage naar de database:
--    per persoon per week, zodat ze ook op je telefoon staan, het legen van je
--    browser overleven en in de back-up zitten.
--
-- Veilig om meermaals te draaien.

begin;

-- ── 1. Tijdschatting mag leeg ───────────────────────────────────────────
-- De bestaande check `estimated_minutes between 0 and 1440` blijft gelden:
-- een check op NULL levert NULL op en laat de rij dus door.
alter table public.tasks alter column estimated_minutes drop default;
alter table public.tasks alter column estimated_minutes drop not null;

-- ── 2. Actiepunten per persoon per week ─────────────────────────────────
create table if not exists public.planner_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Maandag van de week waar dit actiepunt bij hoort.
  week_start date not null,
  text text not null check (length(btrim(text)) > 0),
  done boolean not null default false,
  position integer not null default 0,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_planner_notes_user_week
  on public.planner_notes (organization_id, user_id, week_start, position, created_at);

-- Alleen leden van de organisatie kunnen er een actiepunt in kwijt, en alleen
-- voor zichzelf. Zelfde vorm als de integriteitschecks op task_assignees.
create or replace function public.enforce_planner_notes_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.organization_members om
    where om.organization_id = new.organization_id
      and om.user_id = new.user_id
  ) then
    raise exception 'Actiepunten kunnen alleen bij een lid van deze organisatie horen'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists planner_notes_integrity on public.planner_notes;
create trigger planner_notes_integrity
  before insert or update of organization_id, user_id
  on public.planner_notes
  for each row execute function public.enforce_planner_notes_integrity();

drop trigger if exists planner_notes_prevent_org_change on public.planner_notes;
create trigger planner_notes_prevent_org_change
  before update of organization_id on public.planner_notes
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists planner_notes_updated_at on public.planner_notes;
create trigger planner_notes_updated_at
  before update on public.planner_notes
  for each row execute function public.set_updated_at();

-- ── RLS: strikt persoonlijk ─────────────────────────────────────────────
-- Anders dan de meeste tabellen zijn deze notities NIET org-breed leesbaar.
-- Het zijn persoonlijke krabbels; collega's hebben er niets te zoeken.
alter table public.planner_notes enable row level security;

drop policy if exists "planner_notes read own" on public.planner_notes;
create policy "planner_notes read own" on public.planner_notes for select using (
  public.can_read_org(organization_id) and user_id = auth.uid()
);

drop policy if exists "planner_notes insert own" on public.planner_notes;
create policy "planner_notes insert own" on public.planner_notes for insert with check (
  public.can_write_org(organization_id) and user_id = auth.uid()
);

drop policy if exists "planner_notes update own" on public.planner_notes;
create policy "planner_notes update own" on public.planner_notes for update using (
  public.can_read_org(organization_id) and user_id = auth.uid()
) with check (
  public.can_write_org(organization_id) and user_id = auth.uid()
);

drop policy if exists "planner_notes delete own" on public.planner_notes;
create policy "planner_notes delete own" on public.planner_notes for delete using (
  public.can_write_org(organization_id) and user_id = auth.uid()
);

commit;
