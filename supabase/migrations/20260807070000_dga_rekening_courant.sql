-- ============================================================
-- ResoFly — Zakelijke module fase 3b: rente op de rekening-courant DGA
-- Date: 2026-08-07
--
-- Leent de DGA van zijn eigen BV, dan moet daar een ZAKELIJKE rente over worden
-- berekend. Wat "zakelijk" is, staat nergens: de Belastingdienst schrijft geen
-- percentage voor en verwerpt uitdrukkelijk hypotheekrentes, interbancaire
-- tarieven en rekening-courantkredieten als maatstaf. De percentages die op
-- adviessites circuleren zijn commentaar, geen norm.
--
-- Daarom: het percentage komt van de GEBRUIKER, met een ingangsdatum, en ResoFly
-- vult nooit iets voor. Geen standaardwaarde, geen suggestie, geen grijze
-- placeholder — dat zou een norm verzinnen die niet bestaat en is feitelijk
-- fiscaal advies. Wij rekenen alleen uit wat de gebruiker met zijn adviseur
-- heeft afgesproken.
--
-- De berekening zelf is dagelijks samengesteld: het saldo van elke dag maal het
-- percentage dat op díe dag gold, gedeeld door 365. Een rekening-courant
-- beweegt het hele jaar door; rekenen over alleen het eindsaldo zou een DGA die
-- in november aflost een jaar rente besparen.
--
-- Richting van de boeking volgt het saldo:
--   * DGA staat rood bij de BV (debetsaldo)  → de BV ontvangt rente:
--       debet 1400 Rekening-courant DGA / credit 9000 Rentebaten
--   * BV staat rood bij de DGA (creditsaldo) → de BV betaalt rente:
--       debet 9100 Rentelasten / credit 1400
-- De rente wordt bijgeschreven op de rekening-courant zelf, wat de gebruikelijke
-- gang van zaken is; wie hem apart wil afrekenen boekt dat daarna handmatig.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Het percentage — per administratie, met ingangsdatum
-- ------------------------------------------------------------
create table if not exists public.dga_interest_rates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  valid_from date not null,
  -- Basispunten: 450 = 4,50%. Geen default — dit moet een bewuste invoer zijn.
  rate_basis_points integer not null check (rate_basis_points >= 0 and rate_basis_points <= 10000),
  -- Waar het percentage op gebaseerd is. Vrij tekstveld, maar wel gevraagd:
  -- bij een controle is de onderbouwing het enige dat telt.
  basis_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, valid_from)
);

comment on table public.dga_interest_rates is
  'Door de gebruiker vastgelegd rentepercentage op de rekening-courant DGA, met ingangsdatum. ResoFly kent geen standaard: de wet schrijft geen percentage voor.';

create index if not exists idx_dga_interest_rates_org
  on public.dga_interest_rates(organization_id, valid_from desc);

alter table public.dga_interest_rates enable row level security;
drop policy if exists "dga_interest_rates read" on public.dga_interest_rates;
create policy "dga_interest_rates read" on public.dga_interest_rates
  for select using (public.can_read_org(organization_id));
drop policy if exists "dga_interest_rates write" on public.dga_interest_rates;
create policy "dga_interest_rates write" on public.dga_interest_rates
  for all using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
select public.apply_module_gate('dga_interest_rates', 'finance');

drop trigger if exists dga_interest_rates_touch_updated_at on public.dga_interest_rates;
create trigger dga_interest_rates_touch_updated_at before update on public.dga_interest_rates
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists dga_interest_rates_prevent_org_change on public.dga_interest_rates;
create trigger dga_interest_rates_prevent_org_change before update of organization_id on public.dga_interest_rates
  for each row execute function public.prevent_organization_id_change();

-- ------------------------------------------------------------
-- 2. Vastleggen dat de rente over een jaar is geboekt
--    Eén berekening per jaar, zodat er niet twee keer rente op dezelfde
--    rekening-courant belandt.
-- ------------------------------------------------------------
create table if not exists public.dga_interest_postings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  year integer not null,
  interest_cents bigint not null,
  -- De volledige onderbouwing: per renteperiode het gemiddelde saldo, het
  -- percentage en het aantal dagen. Voor de gebruiker én voor een controle.
  computation jsonb not null default '{}'::jsonb,
  journal_entry_id uuid references public.journal_entries(id) on delete set null,
  status text not null default 'posted',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dga_interest_postings_status_check check (status in ('posted', 'reversed'))
);

create unique index if not exists uq_dga_interest_postings_active
  on public.dga_interest_postings(organization_id, year)
  where status = 'posted';

alter table public.dga_interest_postings enable row level security;
drop policy if exists "dga_interest_postings read" on public.dga_interest_postings;
create policy "dga_interest_postings read" on public.dga_interest_postings
  for select using (public.can_read_org(organization_id));
select public.apply_module_gate('dga_interest_postings', 'finance');

drop trigger if exists dga_interest_postings_touch_updated_at on public.dga_interest_postings;
create trigger dga_interest_postings_touch_updated_at before update on public.dga_interest_postings
  for each row execute function public.bookkeeping_touch_updated_at();

-- ------------------------------------------------------------
-- 3. De berekening: dagsaldo maal dagtarief
-- ------------------------------------------------------------
create or replace function public.compute_dga_interest(p_organization_id uuid, p_year integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_start date := make_date(p_year, 1, 1);
  v_end date := make_date(p_year, 12, 31);
  v_days integer := (v_end - v_start) + 1;   -- 365 of 366
  v_result jsonb;
  v_total bigint;
  v_missing boolean;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  with mutaties as (
    -- Saldomutatie per boekdatum, vanaf het begin tot en met het jaareinde:
    -- de beginstand van het jaar zit zo vanzelf in de loop.
    select je.date as d, sum(jl.debit_cents - jl.credit_cents) as delta
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= v_end
      and la.subtype = 'dga_current_account'
    group by je.date
  ),
  loop_saldo as (
    select d, sum(delta) over (order by d) as balance from mutaties
  ),
  dagen as (
    select generate_series(v_start, v_end, interval '1 day')::date as dag
  ),
  dagsaldo as (
    select
      d.dag,
      coalesce((select l.balance from loop_saldo l where l.d <= d.dag order by l.d desc limit 1), 0) as balance,
      -- Het percentage dat op díe dag gold. Geen tarief = geen rente over die
      -- dag, en dat melden we apart: stil op nul rekenen zou verhullen dat er
      -- nog niets is afgesproken.
      (select r.rate_basis_points from public.dga_interest_rates r
        where r.organization_id = p_organization_id and r.valid_from <= d.dag
        order by r.valid_from desc limit 1) as bp
    from dagen d
  ),
  per_tarief as (
    select
      bp,
      count(*)::int as dagen,
      round(avg(balance))::bigint as gemiddeld_saldo,
      -- Per dag: saldo × percentage / 10000 / dagen-in-jaar.
      round(sum(balance::numeric * coalesce(bp, 0)) / 10000 / v_days)::bigint as rente
    from dagsaldo
    group by bp
  )
  select
    jsonb_build_object(
      'year', p_year,
      'daysInYear', v_days,
      'periods', coalesce(jsonb_agg(jsonb_build_object(
        'rateBasisPoints', bp,
        'days', dagen,
        'averageBalanceCents', gemiddeld_saldo,
        'interestCents', rente
      ) order by bp nulls first), '[]'::jsonb),
      'interestCents', coalesce(sum(rente), 0),
      'hasDaysWithoutRate', bool_or(bp is null)
    ),
    coalesce(sum(rente), 0),
    bool_or(bp is null)
  into v_result, v_total, v_missing
  from per_tarief;

  return coalesce(v_result, jsonb_build_object(
    'year', p_year, 'daysInYear', v_days, 'periods', '[]'::jsonb,
    'interestCents', 0, 'hasDaysWithoutRate', true
  ));
end;
$$;

revoke all on function public.compute_dga_interest(uuid, integer) from public, anon, authenticated;
grant execute on function public.compute_dga_interest(uuid, integer) to authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Boeken
-- ------------------------------------------------------------
create or replace function public.book_dga_interest(
  p_organization_id uuid,
  p_year integer,
  p_created_by uuid default auth.uid()
)
returns public.dga_interest_postings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_calc jsonb;
  v_interest bigint;
  v_date date := make_date(p_year, 12, 31);
  v_rc uuid;
  v_income uuid;
  v_expense uuid;
  v_entry public.journal_entries;
  v_row public.dga_interest_postings;
  v_closed record;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':dga'));

  if not public.org_has_business(p_organization_id) then
    raise exception 'De rekening-courant DGA hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;

  if exists (
    select 1 from public.dga_interest_postings p
    where p.organization_id = p_organization_id and p.year = p_year and p.status = 'posted'
  ) then
    raise exception 'De rente over % is al geboekt.', p_year using errcode = '23505';
  end if;

  v_calc := public.compute_dga_interest(p_organization_id, p_year);
  v_interest := coalesce((v_calc->>'interestCents')::bigint, 0);

  if (v_calc->>'hasDaysWithoutRate')::boolean then
    raise exception 'Voor een deel van % is nog geen rentepercentage vastgelegd. Leg eerst vast wat je met je adviseur hebt afgesproken.', p_year
      using errcode = '23514';
  end if;
  if v_interest = 0 then
    raise exception 'Over % valt geen rente te boeken: het saldo van de rekening-courant was nul.', p_year
      using errcode = '23514';
  end if;

  -- Alleen een JAAR-slot blokkeert; een gefinaliseerde btw-aangifte dekt de
  -- balansdatum altijd en gaat nooit meer open. Deze post raakt de
  -- rekening-courant en een rentegrootboekrekening — geen btw-rubriek.
  select cp.period_start, cp.period_end into v_closed
  from public.closed_periods cp
  where cp.organization_id = p_organization_id
    and cp.period_type = 'year'
    and v_date between cp.period_start and cp.period_end
  limit 1;
  if found then
    raise exception 'Het boekjaar rond % is afgesloten. Heropen het om de rente alsnog te boeken.',
      to_char(v_date, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  v_rc := public.bookkeeping_account_id(p_organization_id, '1400');

  if v_interest > 0 then
    -- De DGA staat rood: de BV ontvangt rente.
    v_income := public.bookkeeping_account_id(p_organization_id, '9000');
    v_entry := public.post_journal_entry(
      p_organization_id, v_date, 'Rente rekening-courant DGA ' || p_year,
      'dga_interest', null,
      jsonb_build_array(
        jsonb_build_object('account_id', v_rc, 'description', 'Rente bijgeschreven ' || p_year,
          'debit_cents', v_interest, 'credit_cents', 0),
        jsonb_build_object('account_id', v_income, 'description', 'Rente rekening-courant DGA ' || p_year,
          'debit_cents', 0, 'credit_cents', v_interest)
      ), p_created_by);
  else
    -- De BV staat rood bij de DGA: de BV betaalt rente.
    v_expense := public.bookkeeping_account_id(p_organization_id, '9100');
    v_entry := public.post_journal_entry(
      p_organization_id, v_date, 'Rente rekening-courant DGA ' || p_year,
      'dga_interest', null,
      jsonb_build_array(
        jsonb_build_object('account_id', v_expense, 'description', 'Rente rekening-courant DGA ' || p_year,
          'debit_cents', -v_interest, 'credit_cents', 0),
        jsonb_build_object('account_id', v_rc, 'description', 'Rente bijgeschreven ' || p_year,
          'debit_cents', 0, 'credit_cents', -v_interest)
      ), p_created_by);
  end if;

  insert into public.dga_interest_postings(
    organization_id, created_by, year, interest_cents, computation, journal_entry_id, status)
  values (p_organization_id, p_created_by, p_year, v_interest, v_calc, v_entry.id, 'posted')
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.book_dga_interest(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.book_dga_interest(uuid, integer, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Terugdraaien — boekstuk op 'reversed', zelfde keuze als elders
-- ------------------------------------------------------------
create or replace function public.reverse_dga_interest(
  p_organization_id uuid,
  p_posting_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.dga_interest_postings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.dga_interest_postings;
begin
  if auth.role() <> 'service_role' and not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen een eigenaar of beheerder mag een renteboeking terugdraaien.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':dga'));

  select * into v_row from public.dga_interest_postings
  where id = p_posting_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Renteboeking niet gevonden.' using errcode = '02000';
  end if;
  if v_row.status <> 'posted' then
    raise exception 'Deze renteboeking is al teruggedraaid.' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_type = 'year'
      and make_date(v_row.year, 12, 31) between cp.period_start and cp.period_end
  ) then
    raise exception 'Boekjaar % is afgesloten. Heropen het eerst.', v_row.year using errcode = '23514';
  end if;

  if v_row.journal_entry_id is not null then
    update public.journal_entries set status = 'reversed'
    where id = v_row.journal_entry_id and organization_id = p_organization_id and status = 'posted';
  end if;

  update public.dga_interest_postings
  set status = 'reversed', updated_at = now()
  where id = p_posting_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.reverse_dga_interest(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.reverse_dga_interest(uuid, uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 6. Nieuw boekstuk-brontype + los tegenboeken afschermen
--    reverse_journal_entry is LETTERLIJK overgenomen uit 20260807050000;
--    alleen de guard hierboven is toegevoegd.
-- ------------------------------------------------------------
alter table public.journal_entries drop constraint if exists journal_entries_source_type_check;
alter table public.journal_entries
  add constraint journal_entries_source_type_check check (source_type in (
    'sales_invoice','purchase_invoice','asset_depreciation','asset_acquisition','asset_disposal',
    'vat_return','payment','opening_balance','manual','year_close','credit_note',
    'result_appropriation','corporate_tax','dga_interest'
  ));

create or replace function public.reverse_journal_entry(
  p_entry_id uuid,
  p_date date default null,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src public.journal_entries;
  v_lines jsonb;
  v_reversal public.journal_entries;
begin
  -- for update: twee gelijktijdige tegenboekingen van hetzelfde boekstuk
  -- zouden anders allebei de reversed_by-check passeren.
  select * into v_src from public.journal_entries where id = p_entry_id for update;
  if not found then
    raise exception 'Boekstuk niet gevonden.' using errcode = '02000';
  end if;
  if auth.role() <> 'service_role' and not public.can_write_org(v_src.organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if v_src.status <> 'posted' then
    raise exception 'Alleen een geboekt (posted) boekstuk kan worden tegengeboekt.' using errcode = '23514';
  end if;
  if v_src.reversed_by_entry_id is not null then
    raise exception 'Boekstuk % is al tegengeboekt.', coalesce(v_src.entry_number, v_src.id::text)
      using errcode = '23514';
  end if;
  if v_src.source_type = 'year_close' then
    raise exception 'Een jaarafsluitboekstuk boek je niet tegen; gebruik "Boekjaar heropenen".'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20260807030000): een resultaatbestemming is net zo'n
  -- systeemboekstuk. Wie hem hier tegenboekt, laat de rij in
  -- result_appropriations op 'posted' staan; het boekjaar blijft dan
  -- geblokkeerd voor heropenen én de nette weg ("Bestemming terugdraaien")
  -- weigert daarna met "al tegengeboekt". Dus meteen hier afvangen.
  if v_src.source_type = 'result_appropriation' then
    raise exception 'Een resultaatbestemming boek je niet los tegen; gebruik "Bestemming terugdraaien" bij het boekjaar.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20260807050000): idem voor de Vpb-reservering. Los tegenboeken
  -- laat corporate_tax_returns op 'final' staan en de verliesadministratie
  -- ongemoeid; daarna weigert "Berekening terugdraaien" met "al tegengeboekt".
  if v_src.source_type = 'corporate_tax' then
    raise exception 'Een Vpb-reservering boek je niet los tegen; gebruik "Berekening terugdraaien" bij het boekjaar.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20260807070000): idem voor de renteboeking op de
  -- rekening-courant DGA. Los tegenboeken laat dga_interest_postings op
  -- 'posted' staan, waardoor de rente over dat jaar nooit opnieuw geboekt kan
  -- worden en "Rente terugdraaien" daarna weigert.
  if v_src.source_type = 'dga_interest' then
    raise exception 'Een renteboeking op de rekening-courant boek je niet los tegen; gebruik "Rente terugdraaien".'
      using errcode = '23514';
  end if;
  -- Suppletie-integriteit: het origineel is uitgesloten van de reguliere
  -- aangifte, maar de spiegelpost zou er WEL in tellen → scheefstand. Correctie
  -- op een suppletie = nieuwe correctieboeking + desgewenst nieuwe suppletie.
  if exists (select 1 from public.vat_supplement_entries vse where vse.entry_id = v_src.id) then
    raise exception 'Boekstuk % is verrekend in een btw-suppletie en kan niet worden tegengeboekt. Maak een nieuwe correctieboeking (memoriaal) en verreken die in een nieuwe suppletie.',
      coalesce(v_src.entry_number, v_src.id::text) using errcode = '23514';
  end if;

  -- Wissel debet/credit per regel om.
  select jsonb_agg(jsonb_build_object(
    'account_id', jl.account_id,
    'description', coalesce(jl.description, '') || ' (tegenboeking)',
    'debit_cents', jl.credit_cents,
    'credit_cents', jl.debit_cents,
    'vat_code', jl.vat_code,
    'vat_rate', jl.vat_rate,
    'vat_base_cents', case when jl.vat_base_cents is null then null else -jl.vat_base_cents end,
    'vat_amount_cents', case when jl.vat_amount_cents is null then null else -jl.vat_amount_cents end,
    'client_id', jl.client_id,
    'supplier_id', jl.supplier_id,
    'project_id', jl.project_id
  ) order by jl.line_index)
  into v_lines
  from public.journal_lines jl
  where jl.entry_id = p_entry_id;

  v_reversal := public.post_journal_entry(
    v_src.organization_id,
    coalesce(p_date, current_date),
    'Tegenboeking van ' || coalesce(v_src.entry_number, v_src.id::text),
    v_src.source_type,
    v_src.source_id,
    v_lines,
    p_created_by
  );

  update public.journal_entries set reverses_entry_id = v_src.id where id = v_reversal.id;

  -- Het origineel blijft 'posted': het is echt gebeurd en blijft meetellen;
  -- de spiegelpost neutraliseert het saldo (netto 0 i.p.v. −1×). Alleen
  -- reversed_by_entry_id markeert het paar. NB: status='reversed' betekent
  -- "volledig uit de rapporten" en is gereserveerd voor reopen_fiscal_year.
  update public.journal_entries
  set reversed_by_entry_id = v_reversal.id, updated_at = now()
  where id = v_src.id;

  return v_reversal;
end;
$$;

commit;
