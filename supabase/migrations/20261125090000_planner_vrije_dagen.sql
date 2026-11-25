-- ============================================================
-- ResoFly — Weekplanner: vrije dagen
-- Date: 2026-11-25
--
-- Waarom: sinds 24 november rekent de weekplanner met netto tijd (werktijd
-- min afspraken). Een vakantiedag of een vrije vrijdag telde daarin gewoon
-- als acht uur werktijd: de dagkop zei "8u vrij" en "Vul mijn week" plande er
-- werk op. Een hele-dag-afspraak "Vakantie" in de agenda hielp niet: agenda's
-- geven niet betrouwbaar door of zo'n item bezet of vrij is, en een
-- verjaardag is ook een hele-dag-item. Daarom kies je het hier zelf, per dag.
--
-- Zelfde vorm als planner_day_capacity: strikt persoonlijk. Of jij vrijdag
-- vrij bent, regel je zelf; collega's (ook eigenaren) lezen dit niet. Alleen
-- toevoegen en weghalen, geen bijwerken: een rij is "deze dag ben ik vrij".
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

create table if not exists public.planner_days_off (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- De kalenderdag die vrij is.
  day date not null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  -- Een dag is vrij of niet; twee keer dezelfde dag zegt niets meer.
  unique (organization_id, user_id, day)
);

-- De planner vraagt per week: jouw dagen tussen maandag en zondag.
create index if not exists idx_planner_days_off_user_day
  on public.planner_days_off (organization_id, user_id, day);

-- Alleen een lid van deze organisatie kan hier een vrije dag hebben; zelfde
-- controle als bij de werktijd (planner_day_capacity).
create or replace function public.enforce_planner_days_off_integrity()
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
    raise exception 'Een vrije dag hoort bij een lid van deze organisatie'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_planner_days_off_integrity() from public, anon, authenticated;

drop trigger if exists planner_days_off_integrity on public.planner_days_off;
create trigger planner_days_off_integrity
  before insert or update of organization_id, user_id
  on public.planner_days_off
  for each row execute function public.enforce_planner_days_off_integrity();

drop trigger if exists planner_days_off_prevent_org_change on public.planner_days_off;
create trigger planner_days_off_prevent_org_change
  before update of organization_id on public.planner_days_off
  for each row execute function public.prevent_organization_id_change();

-- ── Rechten ─────────────────────────────────────────────────────────────
alter table public.planner_days_off enable row level security;
revoke all on table public.planner_days_off from public, anon, authenticated;
grant select, insert, delete on table public.planner_days_off to authenticated;
grant all on table public.planner_days_off to service_role;

-- Lezen: de rechten één keer per vraag, niet per rij (zie
-- 20261122200000_rls_een_keer_per_query en supabase/migrations/README.md).
drop policy if exists "planner_days_off read own" on public.planner_days_off;
create policy "planner_days_off read own" on public.planner_days_off for select using (
  organization_id = any ((select public.my_organization_ids())::uuid[])
  and user_id = (select auth.uid())
);

drop policy if exists "planner_days_off insert own" on public.planner_days_off;
create policy "planner_days_off insert own" on public.planner_days_off for insert with check (
  public.can_write_org(organization_id) and user_id = auth.uid()
);

drop policy if exists "planner_days_off delete own" on public.planner_days_off;
create policy "planner_days_off delete own" on public.planner_days_off for delete using (
  public.can_write_org(organization_id) and user_id = auth.uid()
);

-- Modulerechten gelden overal (CLAUDE.md, regel 3): de weekplanner hoort bij
-- Projecten. Wie die module niet mag lezen, krijgt hier niets terug; wie hem
-- alleen mag lezen, zet geen vrije dag (net als de knop in de planner, die
-- canWritePage('weekplanner') volgt). De boekhouder heeft geen Projecten en
-- staat er daarmee ook buiten. De poort leest één keer per vraag, niet per rij.
select public.apply_module_gate('planner_days_off', 'projects');

commit;
