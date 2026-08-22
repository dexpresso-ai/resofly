-- Weekplanner: een streep die jíj zet
--
-- De dagbalk schaalde op de volste dag van diezelfde week. Je drukste dag was
-- dus per definitie 100%, en een halflege week zag er net zo vol uit als een
-- overvolle: de planner kon letterlijk nooit zeggen dat iets niet paste — en dat
-- is precies de vraag van maandagochtend.
--
-- Dit is bewust GEEN werkweeknorm en geen bedrijfsregel. Zeven gelijkwaardige
-- dagen zonder norm blijft de standaard; wie een streep wil zet hem zelf, voor
-- zichzelf, en kan hem altijd weer uitzetten. Daarom staat de rij er alleen als
-- iemand hem aanmaakt en is de tabel strikt persoonlijk — dezelfde RLS-vorm als
-- planner_notes, want "wiens streep?" is in de teamweergave onbeantwoordbaar.
--
-- Veilig om meermaals te draaien.

begin;

create table if not exists public.planner_day_capacity (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Hoeveel minuten jij op een werkdag kwijt wilt kunnen. 0 = geen streep.
  minutes integer not null default 480 check (minutes between 0 and 1440),
  -- Telt het weekend mee als werkdag? Standaard niet.
  include_weekend boolean not null default false,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Eén streep per persoon per organisatie.
  unique (organization_id, user_id)
);

-- Alleen een lid van deze organisatie kan hier een streep hebben; zelfde vorm
-- als de integriteitscheck op planner_notes.
create or replace function public.enforce_planner_day_capacity_integrity()
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
    raise exception 'Een dagstreep hoort bij een lid van deze organisatie'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists planner_day_capacity_integrity on public.planner_day_capacity;
create trigger planner_day_capacity_integrity
  before insert or update of organization_id, user_id
  on public.planner_day_capacity
  for each row execute function public.enforce_planner_day_capacity_integrity();

drop trigger if exists planner_day_capacity_prevent_org_change on public.planner_day_capacity;
create trigger planner_day_capacity_prevent_org_change
  before update of organization_id on public.planner_day_capacity
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists planner_day_capacity_updated_at on public.planner_day_capacity;
create trigger planner_day_capacity_updated_at
  before update on public.planner_day_capacity
  for each row execute function public.set_updated_at();

-- ── RLS: strikt persoonlijk ─────────────────────────────────────────────
-- Hoeveel uur jij op een dag kwijt wilt is geen bedrijfsgegeven. Collega's —
-- ook eigenaren — hebben hier niets te zoeken.
alter table public.planner_day_capacity enable row level security;

drop policy if exists "planner_day_capacity read own" on public.planner_day_capacity;
create policy "planner_day_capacity read own" on public.planner_day_capacity for select using (
  public.can_read_org(organization_id) and user_id = auth.uid()
);

drop policy if exists "planner_day_capacity insert own" on public.planner_day_capacity;
create policy "planner_day_capacity insert own" on public.planner_day_capacity for insert with check (
  public.can_write_org(organization_id) and user_id = auth.uid()
);

drop policy if exists "planner_day_capacity update own" on public.planner_day_capacity;
create policy "planner_day_capacity update own" on public.planner_day_capacity for update using (
  public.can_read_org(organization_id) and user_id = auth.uid()
) with check (
  public.can_write_org(organization_id) and user_id = auth.uid()
);

drop policy if exists "planner_day_capacity delete own" on public.planner_day_capacity;
create policy "planner_day_capacity delete own" on public.planner_day_capacity for delete using (
  public.can_write_org(organization_id) and user_id = auth.uid()
);

commit;
