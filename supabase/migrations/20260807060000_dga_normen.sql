-- ============================================================
-- ResoFly — Zakelijke module fase 3a: DGA-normen en signalen
-- Date: 2026-08-07
--
-- Een directeur-grootaandeelhouder is bij zijn eigen BV werknemer én
-- aandeelhouder, en de wet knoopt daar twee harde bedragen aan vast:
--
--   1. GEBRUIKELIJK LOON (art. 12a Wet LB 1964). De DGA moet zichzelf ten minste
--      het HOOGSTE betalen van: het loon uit de meest vergelijkbare
--      dienstbetrekking, het hoogste loon van een gewone werknemer in de groep,
--      of een normbedrag dat jaarlijks wordt vastgesteld.
--   2. EXCESSIEF LENEN (art. 4.14a Wet IB 2001, sinds 1-1-2023). Leent de DGA
--      op 31 december meer van zijn eigen BV dan een maximumbedrag, dan wordt
--      het meerdere belast als inkomen uit aanmerkelijk belang (box 2).
--
-- Beide staan hier periodegedateerd in de database, zelfde opzet als
-- corporate_tax_rates en statutory_interest_rates: nationale wetgeving,
-- leesbaar voor elke ingelogde gebruiker, alleen via een migratie te wijzigen.
--
-- WAT ER BEWUST NIET IN STAAT
-- ───────────────────────────
-- Een RENTEPERCENTAGE voor de rekening-courant. Dat bestaat niet: de
-- Belastingdienst schrijft geen tarief voor en eist "zakelijk" — wat de BV
-- elders als particuliere belegger zou kunnen krijgen. De percentages die op
-- adviessites circuleren zijn commentaar, geen norm. Zou ResoFly er één
-- invullen, ook als suggestie of grijze placeholder, dan verzint het een norm
-- die niet bestaat en geeft het feitelijk fiscaal advies. De gebruiker vult zijn
-- eigen, met zijn adviseur afgesproken percentage in — dat komt in fase 3b.
--
-- TWEE DINGEN DIE MAKKELIJK MISGAAN
-- ─────────────────────────────────
--   * 2024 en 2025 hebben HETZELFDE normbedrag (€ 56.000). "Elk jaar stijgt het"
--     is een verkeerde aanname.
--   * De grens van € 17.500 voor de rekening-courant is een HELE-JAAR-maximum
--     ("er mag het hele jaar nooit meer dan € 17.500 op staan"), terwijl de
--     grens voor excessief lenen op één peildatum wordt gemeten (31 december).
--     Twee verschillende toetsen; niet samenvoegen.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. De normen per kalenderjaar
-- ------------------------------------------------------------
create table if not exists public.dga_norms (
  id uuid primary key default gen_random_uuid(),
  year integer not null unique,
  -- Art. 12a lid 1 onderdeel c Wet LB 1964, in centen.
  usual_salary_norm_cents bigint not null check (usual_salary_norm_cents > 0),
  -- Art. 12a lid 1 onderdeel a: welk deel van het loon uit de meest
  -- vergelijkbare dienstbetrekking meetelt. Tot en met 2022 was dat 75% (het
  -- verschil van 25 procentpunt heette de doelmatigheidsmarge); die marge is
  -- per 1-1-2023 afgeschaft, dus sindsdien 100%.
  comparable_salary_basis_points integer not null check (comparable_salary_basis_points between 0 and 10000),
  -- Art. 12a lid 4 (vóór 2023: lid 6): onder dit bedrag hoeft er geen loon te
  -- worden vastgesteld. Niet geïndexeerd; staat al jaren op € 5.000.
  de_minimis_cents bigint not null check (de_minimis_cents >= 0),
  -- Art. 4.14a lid 2 Wet IB 2001, gemeten op 31 december. Null voor jaren vóór
  -- 2023: de regeling bestond toen nog niet.
  excessive_loan_threshold_cents bigint check (excessive_loan_threshold_cents > 0),
  source_note text,
  created_at timestamptz not null default now()
);

comment on table public.dga_norms is
  'Normbedrag gebruikelijk loon (art. 12a Wet LB 1964) en de grens voor excessief lenen (art. 4.14a Wet IB 2001) per kalenderjaar. Nationale wetgeving; alleen via migraties te wijzigen.';

alter table public.dga_norms enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='dga_norms' and policyname='dga norms read') then
    create policy "dga norms read" on public.dga_norms for select using (auth.role() = 'authenticated');
  end if;
end $$;

insert into public.dga_norms
  (year, usual_salary_norm_cents, comparable_salary_basis_points, de_minimis_cents, excessive_loan_threshold_cents, source_note)
values
  (2021, 4700000, 7500, 500000, null,      'Art. 12a Wet LB 1964 per 1-1-2021. Doelmatigheidsmarge nog van kracht (factor 75%). Excessief lenen bestond nog niet.'),
  (2022, 4800000, 7500, 500000, null,      'Art. 12a Wet LB 1964 per 1-1-2022. Laatste jaar met de doelmatigheidsmarge.'),
  (2023, 5100000, 10000, 500000, 70000000, 'Normbedrag per 1-1-2023; doelmatigheidsmarge afgeschaft (Belastingplan 2023, Stb. 2022, 532). Excessief lenen ingevoerd per 1-1-2023 met een maximum van € 700.000.'),
  (2024, 5600000, 10000, 500000, 50000000, 'Normbedrag per 1-1-2024. Grens excessief lenen verlaagd naar € 500.000 door Belastingplan 2024 (Stb. 2023, 499), amendement-Grinwis.'),
  (2025, 5600000, 10000, 500000, 50000000, 'Normbedrag ONGEWIJZIGD t.o.v. 2024 — geen verhoging per 2025.'),
  (2026, 5800000, 10000, 500000, 50000000, 'Normbedrag per 1-1-2026 (Belastingdienst, Handboek Loonheffingen 2026).')
  -- 2027 bewust NIET geseed: het Belastingplan 2027 verschijnt pas op
  -- Prinsjesdag 2026. Een ontbrekend jaar geeft een nette melding; een gegokt
  -- bedrag geeft een verkeerd signaal.
on conflict (year) do nothing;

-- ------------------------------------------------------------
-- 2. Grens rekening-courant zonder rente
--    Losse constante, want hij hoort bij een andere toets (hele jaar, niet één
--    peildatum) en heeft een eigen grondslag. Als aparte rij zodat een wijziging
--    geen migratie in de code vraagt.
-- ------------------------------------------------------------
create table if not exists public.dga_current_account_limits (
  id uuid primary key default gen_random_uuid(),
  valid_from date not null unique,
  -- Onder dit saldo hoeft er geen rente te worden berekend — maar alleen als het
  -- saldo het HELE JAAR eronder blijft. Wordt het overschreden, dan is over het
  -- volle bedrag rente verschuldigd, niet alleen over het meerdere.
  interest_free_limit_cents bigint not null check (interest_free_limit_cents >= 0),
  source_note text,
  created_at timestamptz not null default now()
);

alter table public.dga_current_account_limits enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='dga_current_account_limits' and policyname='dga ca limits read') then
    create policy "dga ca limits read" on public.dga_current_account_limits for select using (auth.role() = 'authenticated');
  end if;
end $$;

insert into public.dga_current_account_limits (valid_from, interest_free_limit_cents, source_note)
values ('2023-01-01', 1750000, 'Belastingdienst, "Voorwaarden bij de rekening-courant": bij bedragen tot € 17.500 hoeft geen rente te worden berekend, mits het saldo het hele jaar daaronder blijft.')
on conflict (valid_from) do nothing;

-- ------------------------------------------------------------
-- 3. De signalen: wat zegt de administratie zelf?
--    Uitsluitend feiten uit het eigen grootboek plus het wettelijke bedrag
--    ernaast. Géén oordeel: of een schuld een eigenwoningschuld is, of er een
--    hypotheekrecht is verstrekt, of er verbonden personen meetellen — dat staat
--    niet in een boekhouding en mag het product niet invullen.
-- ------------------------------------------------------------
create or replace function public.dga_signals(p_organization_id uuid, p_year integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_norm public.dga_norms;
  v_limit bigint;
  v_year_end date := make_date(p_year, 12, 31);
  v_rc_year_end bigint := 0;
  v_rc_peak bigint := 0;
  v_wages bigint := 0;
  v_has_rc boolean;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_norm from public.dga_norms where year = p_year;

  select l.interest_free_limit_cents into v_limit
  from public.dga_current_account_limits l
  where l.valid_from <= v_year_end
  order by l.valid_from desc
  limit 1;

  -- Rekening-courant DGA: het saldo op de peildatum (31 december) én de hoogste
  -- stand van het jaar. Twee cijfers, want de twee toetsen meten verschillend.
  select exists (
    select 1 from public.ledger_accounts la
    where la.organization_id = p_organization_id and la.subtype = 'dga_current_account'
  ) into v_has_rc;

  if v_has_rc then
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint
    into v_rc_year_end
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= v_year_end
      and la.subtype = 'dga_current_account';

    -- Hoogste loopsaldo binnen het jaar: cumulatief per boekdatum.
    select coalesce(max(running), 0)::bigint into v_rc_peak
    from (
      select sum(sum(jl.debit_cents - jl.credit_cents)) over (order by je.date) as running
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      join public.ledger_accounts la on la.id = jl.account_id
      where jl.organization_id = p_organization_id
        and je.status = 'posted'
        and je.date <= v_year_end
        and la.subtype = 'dga_current_account'
      group by je.date
    ) s;
  end if;

  -- Geboekt brutoloon in het jaar. Dit is het loon van ALLE werknemers samen;
  -- wij weten niet welk deel van de DGA is. Daarom alleen als signaal "er is
  -- dit jaar nog niets geboekt", nooit als "je loon is te laag".
  select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint
  into v_wages
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and extract(year from je.date)::int = p_year
    and la.subtype = 'wages';

  return jsonb_build_object(
    'year', p_year,
    'normsKnown', v_norm.year is not null,
    'usualSalaryNormCents', v_norm.usual_salary_norm_cents,
    'deMinimisCents', v_norm.de_minimis_cents,
    'comparableSalaryBasisPoints', v_norm.comparable_salary_basis_points,
    'excessiveLoanThresholdCents', v_norm.excessive_loan_threshold_cents,
    'interestFreeLimitCents', v_limit,
    'hasCurrentAccount', v_has_rc,
    'currentAccountYearEndCents', v_rc_year_end,
    'currentAccountPeakCents', v_rc_peak,
    'wagesBookedCents', v_wages,
    -- Kale feiten; de app maakt er een zin van. Bewust geen "je moet"-taal:
    -- of een grens echt is overschreden hangt af van gegevens die niet in een
    -- boekhouding staan (partner, verbonden personen, eigenwoningschuld).
    'noWagesBooked', v_wages = 0,
    'aboveInterestFreeLimit', v_limit is not null and v_rc_peak > v_limit,
    'aboveExcessiveLoanThreshold',
      v_norm.excessive_loan_threshold_cents is not null
      and v_rc_year_end > v_norm.excessive_loan_threshold_cents
  );
end;
$$;

revoke all on function public.dga_signals(uuid, integer) from public, anon, authenticated;
grant execute on function public.dga_signals(uuid, integer) to authenticated, service_role;

commit;
