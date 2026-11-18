-- ============================================================
-- ResoFly — Prognose: wat je de komende maanden verwacht
-- Date: 2026-11-17
--
-- WAAROM
-- Vraag: "Maak een extra submenu om een forecast te maken. Zorg ervoor dat AI
-- inzetbaar is om dit naar wens aan te passen. De forecast gaat over aantal
-- projecten, verkoop, winst, etc."
-- ResoFly keek tot nu toe alleen terug (Winst & verlies, Rapportages). Vooruit
-- kijken deed je in een eigen spreadsheet, los van je cijfers, en die liep na
-- een maand al achter.
--
-- WAT
-- 1. forecasts: de prognoses van een organisatie ("Basis", "Voorzichtig"). De
--    aannames staan als jsonb in één kolom; de rekenregels staan in
--    supabase/functions/_shared/forecast.ts, voor de app én voor Gerrie. Een
--    lege aanname betekent "automatisch": die waarde komt uit de cijfers van
--    het afgelopen jaar en schuift dus vanzelf mee.
-- 2. forecast_versions: elke stand van een prognose. Een trigger schrijft hem,
--    welke weg de wijziging ook nam (het scherm, een goedgekeurd voorstel van
--    Gerrie, de API). Zo kun je elke wijziging terugzetten, ook een die je
--    goedkeurde en achteraf toch niet wilde.
-- 3. forecast_history(organisatie, van, tot): de cijfers per maand waar de
--    prognose op rust (nieuwe projecten, gefactureerde omzet met en zonder
--    project, kosten uit de boekhouding en uit de inkoopfacturen) en de
--    offertes die nog openstaan. De app en de handelingen van Gerrie lezen
--    dezelfde functie; daardoor rekenen ze dezelfde prognose uit. Met twee
--    eigen optellingen kon Gerrie een andere winst noemen dan het scherm, en
--    dan klopt de kaart die je goedkeurt niet met wat je daarna ziet.
--
-- RECHTEN
-- - Module Financiën: de prognose toont omzet, kosten en winst. Lezen met
--   leesrecht op Financiën (ook de boekhouder), wijzigen met schrijfrecht.
-- - Het aantal projecten alleen voor wie Projecten mag lezen; anders null.
--   Een nul zou zeggen dat er geen projecten waren.
-- - forecast_versions schrijft alleen de trigger: geen schrijfpolicy en geen
--   tabelrecht. Een geschiedenis die je zelf kunt bijwerken, is er geen.
--
-- Veilig om opnieuw te draaien: if not exists, create or replace, drop … if exists.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Prognoses
-- ------------------------------------------------------------
create table if not exists public.forecasts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  notes text,
  assumptions jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  change_note text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.forecasts drop constraint if exists forecasts_name_check;
alter table public.forecasts
  add constraint forecasts_name_check check (char_length(btrim(name)) between 1 and 80);
alter table public.forecasts drop constraint if exists forecasts_notes_check;
alter table public.forecasts
  add constraint forecasts_notes_check check (notes is null or char_length(notes) <= 2000);
-- De vorm controleren de rekenregels (forecast.ts); de database bewaakt dat het
-- een object is en dat het klein blijft. Vijftig extra posten en drie jaar aan
-- afwijkende maanden passen ruim in 64 kB.
alter table public.forecasts drop constraint if exists forecasts_assumptions_check;
alter table public.forecasts
  add constraint forecasts_assumptions_check
  check (jsonb_typeof(assumptions) = 'object' and octet_length(assumptions::text) <= 65536);
alter table public.forecasts drop constraint if exists forecasts_change_note_check;
alter table public.forecasts
  add constraint forecasts_change_note_check check (change_note is null or char_length(change_note) <= 500);
alter table public.forecasts drop constraint if exists forecasts_version_check;
alter table public.forecasts
  add constraint forecasts_version_check check (version >= 1);

-- Eén naam per organisatie: "pas de prognose Basis aan" moet naar één prognose wijzen.
create unique index if not exists uidx_forecasts_name
  on public.forecasts (organization_id, lower(name));
create index if not exists idx_forecasts_org
  on public.forecasts (organization_id, created_at);

comment on table public.forecasts is
  'Prognoses (forecast) van een organisatie: aannames als jsonb, de rekenregels staan in supabase/functions/_shared/forecast.ts. Elke stand staat in forecast_versions.';
comment on column public.forecasts.assumptions is
  'Aannames (forecast.ts, ForecastAssumptions). Een lege waarde = automatisch, uit de cijfers van de laatste twaalf maanden.';
comment on column public.forecasts.change_note is
  'Wat de laatste wijziging deed, in gewone woorden ("Groei per jaar: 0% → 10%"). Geldt voor één wijziging; de trigger maakt hem leeg als een wijziging er niets over zegt.';

-- Naam en tekst netjes, het versienummer telt mee, en wie het deed staat er.
-- Het versienummer en de aanmaker komen nooit uit de app: een wijziging die
-- versie 1 meestuurt, zou anders de geschiedenis overschrijven.
create or replace function public.forecasts_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.name := btrim(regexp_replace(coalesce(new.name, ''), '\s+', ' ', 'g'));
  new.notes := nullif(btrim(coalesce(new.notes, '')), '');
  new.change_note := nullif(btrim(regexp_replace(coalesce(new.change_note, ''), '\s+', ' ', 'g')), '');

  if tg_op = 'INSERT' then
    new.version := 1;
    new.updated_by := coalesce(auth.uid(), new.created_by);
    return new;
  end if;

  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.version := old.version;
  -- Een omschrijving hoort bij één wijziging. Staat er nog die van de vorige,
  -- dan zei deze wijziging niets over zichzelf.
  if new.change_note is not distinct from old.change_note then
    new.change_note := null;
  end if;
  if new.name is distinct from old.name
     or new.notes is distinct from old.notes
     or new.assumptions is distinct from old.assumptions then
    new.version := old.version + 1;
    new.updated_by := coalesce(auth.uid(), old.updated_by);
  else
    new.updated_by := old.updated_by;
  end if;
  return new;
end;
$$;

drop trigger if exists forecasts_guard on public.forecasts;
create trigger forecasts_guard
  before insert or update on public.forecasts
  for each row execute function public.forecasts_guard();

drop trigger if exists forecasts_updated on public.forecasts;
create trigger forecasts_updated
  before update on public.forecasts
  for each row execute function public.set_updated_at();

drop trigger if exists forecasts_prevent_org_change on public.forecasts;
create trigger forecasts_prevent_org_change
  before update of organization_id on public.forecasts
  for each row execute function public.prevent_organization_id_change();

alter table public.forecasts enable row level security;

drop policy if exists "forecasts read" on public.forecasts;
create policy "forecasts read" on public.forecasts
  for select using (public.can_read_org(organization_id));

drop policy if exists "forecasts insert" on public.forecasts;
create policy "forecasts insert" on public.forecasts
  for insert with check (public.can_write_org(organization_id) and created_by = auth.uid());

drop policy if exists "forecasts update" on public.forecasts;
create policy "forecasts update" on public.forecasts
  for update using (public.can_write_org(organization_id))
  with check (public.can_write_org(organization_id));

drop policy if exists "forecasts delete" on public.forecasts;
create policy "forecasts delete" on public.forecasts
  for delete using (public.can_write_org(organization_id));

do $$ begin perform public.apply_module_gate('forecasts', 'finance'); end $$;

revoke all on public.forecasts from anon;
grant select, insert, update, delete on public.forecasts to authenticated;
grant all on public.forecasts to service_role;

-- ------------------------------------------------------------
-- 2. Elke stand van een prognose
-- ------------------------------------------------------------
create table if not exists public.forecast_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  forecast_id uuid not null references public.forecasts(id) on delete cascade,
  version integer not null,
  name text not null,
  notes text,
  assumptions jsonb not null,
  change_note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (forecast_id, version)
);

create index if not exists idx_forecast_versions_org
  on public.forecast_versions (organization_id, forecast_id, version desc);

comment on table public.forecast_versions is
  'Elke stand van een prognose (forecasts), geschreven door de trigger forecasts_snapshot. De laatste vijftig per prognose. Terugzetten = de oude aannames opnieuw opslaan: dat wordt een nieuwe versie.';

-- Security definer: de tabel heeft bewust geen schrijfpolicy en geen
-- schrijfrecht voor de app. De modulepoort op forecast_versions kijkt wel mee
-- (auth.uid() blijft die van wie de prognose wijzigde), en die heeft
-- schrijfrecht op Financiën, anders kwam de wijziging hier niet.
create or replace function public.forecasts_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.version = old.version then
    return null;
  end if;
  insert into public.forecast_versions
    (organization_id, forecast_id, version, name, notes, assumptions, change_note, created_by)
  values
    (new.organization_id, new.id, new.version, new.name, new.notes, new.assumptions, new.change_note, new.updated_by)
  on conflict (forecast_id, version) do nothing;
  -- Genoeg om terug te kunnen, niet eindeloos.
  delete from public.forecast_versions v
   where v.forecast_id = new.id and v.version <= new.version - 50;
  return null;
end;
$$;

drop trigger if exists forecasts_snapshot on public.forecasts;
create trigger forecasts_snapshot
  after insert or update on public.forecasts
  for each row execute function public.forecasts_snapshot();

alter table public.forecast_versions enable row level security;

drop policy if exists "forecast versions read" on public.forecast_versions;
create policy "forecast versions read" on public.forecast_versions
  for select using (public.can_read_org(organization_id));

do $$ begin perform public.apply_module_gate('forecast_versions', 'finance'); end $$;

revoke all on public.forecast_versions from anon;
revoke insert, update, delete, truncate on public.forecast_versions from authenticated;
grant select on public.forecast_versions to authenticated;
grant all on public.forecast_versions to service_role;

-- ------------------------------------------------------------
-- 3. De cijfers waar de prognose op rust
-- ------------------------------------------------------------
-- Per maand:
-- - projects: nieuwe projecten, op de startdatum (of de dag van aanmaken als
--   die leeg is). Null zonder leesrecht op Projecten.
-- - revenue_project_cents / revenue_other_cents: gefactureerd, exclusief btw,
--   op factuurdatum, met en zonder project. Verstuurd, te laat, betaald of
--   afgeschreven telt; een concept, een geannuleerde, vervallen of
--   terugbetaalde factuur niet. Een creditnota bij een factuur die nog
--   meetelt, gaat eraf in de maand van de creditnota.
-- - purchase_cents: inkoopfacturen, exclusief btw, geboekt of betaald.
-- - ledger_revenue_cents / ledger_expense_cents: de geboekte journaalposten op
--   omzet- en kostenrekeningen, zonder de afsluiting van een boekjaar. Dezelfde
--   regel als report_profit_and_loss, zodat "Winst & verlies" en de prognose
--   voor een maand hetzelfde zeggen.
-- Daarnaast pipeline: de verstuurde offertes die nog geldig zijn, de
-- geaccepteerde die nog geen factuur hebben, en hoeveel van de offertes uit
-- het afgelopen jaar het werden.
create or replace function public.forecast_history(p_organization_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_service boolean := coalesce(auth.role(), '') = 'service_role';
  v_projects boolean;
  v_from date;
  v_to date;
  v_today date := (now() at time zone 'Europe/Amsterdam')::date;
  v_months jsonb;
  v_pipeline jsonb;
begin
  if p_organization_id is null or p_from is null or p_to is null then
    raise exception 'Geef een organisatie en een periode.' using errcode = '22023';
  end if;
  -- De service-role (Gerrie, de API) controleert de organisatie zelf: die
  -- komt daar uit de geverifieerde sessie.
  if not v_service
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  v_from := date_trunc('month', p_from)::date;
  v_to := (date_trunc('month', p_to) + interval '1 month' - interval '1 day')::date;
  if v_from > v_to then
    raise exception 'Het begin ligt na het einde.' using errcode = '22023';
  end if;
  if v_to >= (v_from + interval '6 years')::date then
    raise exception 'Hooguit zes jaar tegelijk.' using errcode = '22023';
  end if;

  v_projects := v_service or public.can_read_module(p_organization_id, 'projects');

  with months as (
    select gs::date as m from generate_series(v_from, v_to, interval '1 month') gs
  ),
  proj as (
    select date_trunc('month', coalesce(p.start_date, (p.created_at at time zone 'Europe/Amsterdam')::date))::date as m,
           count(*)::integer as n
      from public.projects p
     where p.organization_id = p_organization_id
       and coalesce(p.start_date, (p.created_at at time zone 'Europe/Amsterdam')::date) between v_from and v_to
     group by 1
  ),
  inv as (
    select date_trunc('month', i.date)::date as m,
           sum(case when i.project_id is not null then round(i.subtotal_amount * 100) else 0 end)::bigint as with_project,
           sum(case when i.project_id is null then round(i.subtotal_amount * 100) else 0 end)::bigint as without_project
      from public.invoices i
     where i.organization_id = p_organization_id
       and i.status in ('sent', 'overdue', 'paid', 'written_off')
       and i.date between v_from and v_to
     group by 1
  ),
  credit as (
    select date_trunc('month', c.date)::date as m,
           sum(case when i.project_id is not null then round(c.subtotal_amount * 100) else 0 end)::bigint as with_project,
           sum(case when i.project_id is null then round(c.subtotal_amount * 100) else 0 end)::bigint as without_project
      from public.credit_notes c
      join public.invoices i on i.id = c.invoice_id and i.organization_id = c.organization_id
     where c.organization_id = p_organization_id
       and c.status = 'issued'
       -- Telt de factuur zelf al niet meer mee (geannuleerd, terugbetaald),
       -- dan ging de omzet er al af; de creditnota nog eens aftrekken telt dubbel.
       and i.status in ('sent', 'overdue', 'paid', 'written_off')
       and c.date between v_from and v_to
     group by 1
  ),
  purchase as (
    select date_trunc('month', pi.date)::date as m, sum(pi.subtotal_cents)::bigint as cents
      from public.purchase_invoices pi
     where pi.organization_id = p_organization_id
       and pi.status in ('booked', 'paid')
       and pi.date between v_from and v_to
     group by 1
  ),
  ledger as (
    select date_trunc('month', je.date)::date as m,
           sum(case when la.type = 'revenue' then jl.credit_cents - jl.debit_cents else 0 end)::bigint as revenue,
           sum(case when la.type = 'expense' then jl.debit_cents - jl.credit_cents else 0 end)::bigint as expense
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      join public.ledger_accounts la on la.id = jl.account_id
     where jl.organization_id = p_organization_id
       and je.status = 'posted'
       and je.source_type <> 'year_close'
       and je.date between v_from and v_to
       and la.type in ('revenue', 'expense')
     group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'month', to_char(months.m, 'YYYY-MM'),
           'projects', case when v_projects then coalesce(proj.n, 0) else null end,
           'revenue_project_cents', coalesce(inv.with_project, 0) - coalesce(credit.with_project, 0),
           'revenue_other_cents', coalesce(inv.without_project, 0) - coalesce(credit.without_project, 0),
           'purchase_cents', coalesce(purchase.cents, 0),
           'ledger_revenue_cents', coalesce(ledger.revenue, 0),
           'ledger_expense_cents', coalesce(ledger.expense, 0)
         ) order by months.m), '[]'::jsonb)
    into v_months
    from months
    left join proj on proj.m = months.m
    left join inv on inv.m = months.m
    left join credit on credit.m = months.m
    left join purchase on purchase.m = months.m
    left join ledger on ledger.m = months.m;

  -- Een offerte bewaart geen bedrag: dat staat in de regels. Een regel met
  -- iets anders dan een getal telt als nul in plaats van de hele prognose te
  -- laten struikelen.
  with q as (
    select q.status,
           q.date,
           q.valid_until,
           exists (
             select 1 from public.invoices i
              where i.organization_id = p_organization_id
                and i.quote_id = q.id
                and i.status not in ('cancelled', 'void')
           ) as invoiced,
           (select coalesce(sum(round(
                     (case when (l.value->>'quantity') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (l.value->>'quantity')::numeric else 0 end)
                   * (case when (l.value->>'unit_price') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (l.value->>'unit_price')::numeric else 0 end)
                   * 100)), 0)
              from jsonb_array_elements(case when jsonb_typeof(q.lines) = 'array' then q.lines else '[]'::jsonb end) l
           )::bigint as cents
      from public.quotes q
     where q.organization_id = p_organization_id
       and q.status in ('sent', 'accepted', 'paid', 'rejected', 'expired')
  )
  select jsonb_build_object(
           'open_count', count(*) filter (where status = 'sent' and (valid_until is null or valid_until >= v_today)),
           'open_cents', coalesce(sum(cents) filter (where status = 'sent' and (valid_until is null or valid_until >= v_today)), 0),
           'accepted_count', count(*) filter (where status = 'accepted' and not invoiced),
           'accepted_cents', coalesce(sum(cents) filter (where status = 'accepted' and not invoiced), 0),
           'won_count', count(*) filter (where status in ('accepted', 'paid') and date > v_today - 365),
           'lost_count', count(*) filter (where (status in ('rejected', 'expired')
                                                 or (status = 'sent' and valid_until < v_today))
                                                and date > v_today - 365)
         )
    into v_pipeline
    from q;

  return jsonb_build_object(
    'from', to_char(v_from, 'YYYY-MM'),
    'to', to_char(v_to, 'YYYY-MM'),
    'today', to_char(v_today, 'YYYY-MM-DD'),
    'projects_visible', v_projects,
    'months', v_months,
    'pipeline', v_pipeline
  );
end;
$$;

revoke all on function public.forecast_history(uuid, date, date) from public, anon;
grant execute on function public.forecast_history(uuid, date, date) to authenticated, service_role;

-- Triggerfuncties: niemand roept ze zelf aan, de trigger vuurt toch.
revoke all on function public.forecasts_guard() from public, anon, authenticated;
revoke all on function public.forecasts_snapshot() from public, anon, authenticated;

commit;
