-- ============================================================
-- ResoFly — Zakelijke module fase 2: vennootschapsbelasting
-- Date: 2026-08-07
--
-- Een BV betaalt Vpb over haar fiscale winst, en die fiscale winst is niet
-- hetzelfde als het commerciële resultaat dat uit het grootboek rolt. Deze
-- migratie legt de structuur aan om van het één naar het ander te komen, het
-- resultaat vast te leggen en de reservering te boeken.
--
-- WAT HIER WEL EN NIET REKENT
-- ───────────────────────────
-- Het rékenwerk staat NIET in SQL maar in supabase/functions/_shared/vpb.ts —
-- een puur, unit-getest bestand (npm test), net als dunning.ts. Deze migratie
-- levert alleen de gegevens aan (get_corporate_tax_inputs) en slaat de uitkomst
-- op (save_corporate_tax_return). Reden: de tarieftabel van art. 22 is
-- cumulatief en de verliesverrekening van art. 20 kent een drempel plus een
-- percentage; dat soort regels wil je met tests kunnen vastpinnen, en dat kan
-- niet in een plpgsql-functie die alleen op een echte database draait.
--
-- DE TARIEFTABEL IS PERIODEGEDATEERD, NOOIT HARDCODED
-- ───────────────────────────────────────────────────
-- corporate_tax_rates is nationale wetgeving, geen organisatiedata — zelfde
-- opzet als statutory_interest_rates bij de debiteurenautomaat: leesbaar voor
-- elke ingelogde gebruiker, alleen te schrijven via een migratie.
--
-- Art. 22 Wet Vpb 1969 is een tabel met vier kolommen (ondergrens, bovengrens,
-- basisbedrag, percentage) en werkt CUMULATIEF: de belasting is het basisbedrag
-- plus het percentage over het deel bóven de ondergrens. Vandaar dat elke schijf
-- hier een eigen rij is met een basisbedrag, en niet een "laag tarief / hoog
-- tarief"-paar. Op een belastbaar bedrag van € 300.000 in 2026 is de belasting
-- € 38.000 + 25,8% × € 100.000 = € 63.800 — wie het als een cliff bouwt rekent
-- € 77.400 en zit er € 13.600 naast.
--
-- Geverifieerd tegen de vastgestelde wetteksten in het Staatsblad en de
-- tarievenpagina's van de Belastingdienst (zie source_note per rij):
--   2021  15%   tot € 245.000   daarboven € 36.750 + 25%
--   2022  15%   tot € 395.000   daarboven € 59.250 + 25,8%
--   2023  19%   tot € 200.000   daarboven € 38.000 + 25,8%
--   2024  idem   2025 idem       2026 idem
--   2027  NOG NIET VASTGESTELD — bewust niet geseed. Een ontbrekend jaar geeft
--         een nette foutmelding; een gegokt tarief geeft een verkeerde aangifte.
--
-- Verliesverrekening (art. 20 lid 2, tekst sinds 1-1-2022): één jaar
-- achterwaarts, onbeperkt voorwaarts, maar per jaar hooguit € 1.000.000 plus
-- 50% van de winst dáárboven. De drempel en het percentage staan per jaar in
-- dezelfde tabel, want ze zijn even veranderlijk als het tarief.
--
-- Dit is een hulpmiddel, geen aangifte en geen fiscaal advies: wij rekenen en
-- specificeren, de klant of zijn accountant dient in. Zelfde lijn als bij de
-- BTW-aangifte.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Tarieven en drempels per boekjaar (nationaal)
-- ------------------------------------------------------------
create table if not exists public.corporate_tax_rates (
  id uuid primary key default gen_random_uuid(),
  year integer not null,
  -- Kolom I van art. 22: het bedrag waarboven deze schijf geldt, in centen.
  -- De eerste schijf van een jaar begint altijd op 0.
  lower_bound_cents bigint not null check (lower_bound_cents >= 0),
  -- Kolom III: het vaste bedrag dat al over de schijven eronder is berekend.
  base_amount_cents bigint not null check (base_amount_cents >= 0),
  -- Kolom IV: percentage in basispunten (1900 = 19,00%).
  rate_basis_points integer not null check (rate_basis_points between 0 and 10000),
  -- Art. 20 lid 2: identiek voor elke schijf van hetzelfde jaar, maar hier
  -- meegeschreven zodat één query alles oplevert wat het rekenhart nodig heeft.
  loss_relief_threshold_cents bigint not null check (loss_relief_threshold_cents >= 0),
  loss_relief_rate_basis_points integer not null check (loss_relief_rate_basis_points between 0 and 10000),
  source_note text,
  created_at timestamptz not null default now(),
  unique (year, lower_bound_cents)
);

comment on table public.corporate_tax_rates is
  'Tarieftabel van art. 22 Wet Vpb 1969 per boekjaar, cumulatief per schijf, plus de verliesverrekeningsdrempel van art. 20 lid 2. Nationale wetgeving; alleen via migraties te wijzigen.';

alter table public.corporate_tax_rates enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'corporate_tax_rates' and policyname = 'corporate tax rates read'
  ) then
    -- Nationale wetgeving, geen org-data: leesbaar voor elke ingelogde gebruiker.
    create policy "corporate tax rates read" on public.corporate_tax_rates
      for select using (auth.role() = 'authenticated');
  end if;
end $$;

-- De schijven. Basisbedrag is telkens het lage tarief × de schijfgrens, precies
-- zoals kolom III van de wettabel het noemt.
insert into public.corporate_tax_rates
  (year, lower_bound_cents, base_amount_cents, rate_basis_points, loss_relief_threshold_cents, loss_relief_rate_basis_points, source_note)
values
  (2021,          0,          0, 1500, 100000000, 5000, 'Art. 22 Wet Vpb 1969 per 1-1-2021 (Belastingplan 2021, Stb. 2020, 540). Let op: de verliesverrekeningsbeperking geldt pas vanaf 2022; voor 2021 hier gelijk gezet aan de latere norm en niet gebruikt.'),
  (2021,   24500000,    3675000, 2500, 100000000, 5000, 'Art. 22 Wet Vpb 1969 per 1-1-2021: boven € 245.000 → € 36.750 + 25%.'),
  (2022,          0,          0, 1500, 100000000, 5000, 'Art. 22 Wet Vpb 1969 per 1-1-2022 (Belastingplan 2021, Stb. 2020, 540). Verliesverrekening art. 20 lid 2 nieuw per 1-1-2022: € 1 mln + 50%.'),
  (2022,   39500000,    5925000, 2580, 100000000, 5000, 'Art. 22 per 1-1-2022; toptarief naar 25,8% via Belastingplan 2022 (Stb. 2021, 651).'),
  (2023,          0,          0, 1900, 100000000, 5000, 'Art. 22 Wet Vpb 1969 per 1-1-2023 (Belastingplan 2023, Stb. 2022, 532).'),
  (2023,   20000000,    3800000, 2580, 100000000, 5000, 'Art. 22 per 1-1-2023: boven € 200.000 → € 38.000 + 25,8%.'),
  (2024,          0,          0, 1900, 100000000, 5000, 'Ongewijzigd t.o.v. 2023 (Belastingdienst, tarieven vennootschapsbelasting).'),
  (2024,   20000000,    3800000, 2580, 100000000, 5000, 'Ongewijzigd t.o.v. 2023.'),
  (2025,          0,          0, 1900, 100000000, 5000, 'Ongewijzigd t.o.v. 2023 (Belastingdienst, veranderingen vennootschapsbelasting 2025).'),
  (2025,   20000000,    3800000, 2580, 100000000, 5000, 'Ongewijzigd t.o.v. 2023.'),
  (2026,          0,          0, 1900, 100000000, 5000, 'Ongewijzigd t.o.v. 2023 (Belastingdienst, veranderingen vennootschapsbelasting 2026).'),
  (2026,   20000000,    3800000, 2580, 100000000, 5000, 'Ongewijzigd t.o.v. 2023.')
on conflict (year, lower_bound_cents) do nothing;

-- ------------------------------------------------------------
-- 2. De aangifteberekening per boekjaar
-- ------------------------------------------------------------
create table if not exists public.corporate_tax_returns (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  fiscal_year_id           uuid not null references public.fiscal_years(id) on delete cascade,
  created_by               uuid references auth.users(id) on delete set null default auth.uid(),
  year                     integer not null,
  -- Alles wat het rekenhart heeft opgeleverd, bevroren op het moment van
  -- vaststellen. Nooit herleiden uit het grootboek: dat verandert.
  commercial_result_cents  bigint not null default 0,
  corrections_cents        bigint not null default 0,
  fiscal_profit_cents      bigint not null default 0,
  loss_relief_cap_cents    bigint not null default 0,
  loss_used_cents          bigint not null default 0,
  taxable_amount_cents     bigint not null default 0,
  tax_cents                bigint not null default 0,
  prepaid_cents            bigint not null default 0,
  balance_due_cents        bigint not null default 0,
  -- De volledige uitkomst van vpb.ts, inclusief welk verlies uit welk jaar is
  -- gebruikt. Voor de specificatie aan de accountant en om achteraf te kunnen
  -- laten zien hoe een bedrag tot stand kwam.
  computation              jsonb not null default '{}'::jsonb,
  status                   text not null default 'draft',
  accrual_entry_id         uuid references public.journal_entries(id) on delete set null,
  finalized_at             timestamptz,
  finalized_by             uuid references auth.users(id) on delete set null,
  note                     text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint corporate_tax_returns_status_check check (status in ('draft', 'final', 'reversed')),
  constraint corporate_tax_returns_year_ck check (year between 2000 and 2100)
);

create index if not exists idx_corporate_tax_returns_org
  on public.corporate_tax_returns(organization_id, year desc);

-- Eén geldige berekening per boekjaar; een teruggedraaide blijft staan.
create unique index if not exists uq_corporate_tax_returns_active
  on public.corporate_tax_returns(fiscal_year_id)
  where status <> 'reversed';

alter table public.corporate_tax_returns enable row level security;
drop policy if exists "corporate_tax_returns read" on public.corporate_tax_returns;
create policy "corporate_tax_returns read" on public.corporate_tax_returns
  for select using (public.can_read_org(organization_id));
select public.apply_module_gate('corporate_tax_returns', 'finance');

drop trigger if exists corporate_tax_returns_touch_updated_at on public.corporate_tax_returns;
create trigger corporate_tax_returns_touch_updated_at before update on public.corporate_tax_returns
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists corporate_tax_returns_prevent_org_change on public.corporate_tax_returns;
create trigger corporate_tax_returns_prevent_org_change before update of organization_id on public.corporate_tax_returns
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists corporate_tax_returns_audit on public.corporate_tax_returns;
create trigger corporate_tax_returns_audit after insert or update or delete on public.corporate_tax_returns
  for each row execute function public.audit_row_change('corporate_tax_return', 'status');

-- ------------------------------------------------------------
-- 3. Fiscale correcties per boekjaar
--    Vrij invulbaar: de wet kent tientallen posten en welke van toepassing is,
--    weet de ondernemer of zijn accountant beter dan wij. Wel met een vaste
--    codelijst, zodat de specificatie navolgbaar blijft en fase 5 hem kan
--    hergebruiken in de toelichting.
-- ------------------------------------------------------------
create table if not exists public.corporate_tax_corrections (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  fiscal_year_id  uuid not null references public.fiscal_years(id) on delete cascade,
  created_by      uuid references auth.users(id) on delete set null default auth.uid(),
  code            text not null,
  label           text not null,
  -- Positief verhoogt de fiscale winst (niet-aftrekbare kosten), negatief
  -- verlaagt hem (investeringsaftrek).
  amount_cents    bigint not null,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint corporate_tax_corrections_label_not_blank check (length(btrim(label)) > 0),
  constraint corporate_tax_corrections_code_check check (code in (
    'niet_aftrekbaar',        -- boetes, de Vpb zelf, giften boven de grens (art. 3.14 Wet IB via art. 8 Wet Vpb)
    'gemengde_kosten',        -- beperkt aftrekbaar: eten, drinken, representatie (art. 8 lid 5 Wet Vpb jo. art. 3.15 Wet IB)
    'afschrijvingsbeperking', -- gebouwen tot de bodemwaarde (art. 3.30a Wet IB)
    'investeringsaftrek',     -- KIA/EIA/MIA — verlaagt de winst, dus negatief
    'deelnemingsvrijstelling',
    'overig'
  ))
);

create index if not exists idx_corporate_tax_corrections_year
  on public.corporate_tax_corrections(organization_id, fiscal_year_id);

alter table public.corporate_tax_corrections enable row level security;
drop policy if exists "corporate_tax_corrections read" on public.corporate_tax_corrections;
create policy "corporate_tax_corrections read" on public.corporate_tax_corrections
  for select using (public.can_read_org(organization_id));
drop policy if exists "corporate_tax_corrections write" on public.corporate_tax_corrections;
create policy "corporate_tax_corrections write" on public.corporate_tax_corrections
  for all using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
select public.apply_module_gate('corporate_tax_corrections', 'finance');

drop trigger if exists corporate_tax_corrections_touch_updated_at on public.corporate_tax_corrections;
create trigger corporate_tax_corrections_touch_updated_at before update on public.corporate_tax_corrections
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists corporate_tax_corrections_prevent_org_change on public.corporate_tax_corrections;
create trigger corporate_tax_corrections_prevent_org_change before update of organization_id on public.corporate_tax_corrections
  for each row execute function public.prevent_organization_id_change();

-- ------------------------------------------------------------
-- 4. Openstaande verliezen
--    Wij houden ze zelf bij, maar het laatste woord heeft de Belastingdienst:
--    een verlies staat pas vast bij verliesvaststellingsbeschikking. Vandaar
--    established_by_assessment — zolang dat vinkje uit staat is het onze eigen
--    berekening en niet meer dan dat.
-- ------------------------------------------------------------
create table if not exists public.corporate_tax_losses (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations(id) on delete cascade,
  created_by                uuid references auth.users(id) on delete set null default auth.uid(),
  year                      integer not null,
  /** Het oorspronkelijke verlies van dat jaar, positief bedrag in centen. */
  amount_cents              bigint not null check (amount_cents > 0),
  /** Wat er nog van openstaat na eerdere verrekeningen. */
  remaining_cents           bigint not null check (remaining_cents >= 0),
  established_by_assessment boolean not null default false,
  note                      text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (organization_id, year)
);

alter table public.corporate_tax_losses enable row level security;
drop policy if exists "corporate_tax_losses read" on public.corporate_tax_losses;
create policy "corporate_tax_losses read" on public.corporate_tax_losses
  for select using (public.can_read_org(organization_id));
drop policy if exists "corporate_tax_losses write" on public.corporate_tax_losses;
create policy "corporate_tax_losses write" on public.corporate_tax_losses
  for all using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
select public.apply_module_gate('corporate_tax_losses', 'finance');

drop trigger if exists corporate_tax_losses_touch_updated_at on public.corporate_tax_losses;
create trigger corporate_tax_losses_touch_updated_at before update on public.corporate_tax_losses
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists corporate_tax_losses_prevent_org_change on public.corporate_tax_losses;
create trigger corporate_tax_losses_prevent_org_change before update of organization_id on public.corporate_tax_losses
  for each row execute function public.prevent_organization_id_change();

-- ------------------------------------------------------------
-- 5. Nieuw boekstuk-brontype (volledige lijst overnemen)
-- ------------------------------------------------------------
alter table public.journal_entries drop constraint if exists journal_entries_source_type_check;
alter table public.journal_entries
  add constraint journal_entries_source_type_check check (source_type in (
    'sales_invoice','purchase_invoice','asset_depreciation','asset_acquisition','asset_disposal',
    'vat_return','payment','opening_balance','manual','year_close','credit_note',
    'result_appropriation','corporate_tax'
  ));

-- ------------------------------------------------------------
-- 6. Alles wat het rekenhart nodig heeft, in één aanroep
--    Het commerciële resultaat komt uit dezelfde bron als list_fiscal_years:
--    W&V-rekeningen binnen het boekjaar, exclusief jaarafsluitboekstukken —
--    zodat het cijfer op het scherm overeenkomt met wat de gebruiker bij
--    Boekjaren ziet staan. De vennootschapsbelasting zelf (rubriek
--    'belastingen') telt NIET mee: die is niet aftrekbaar en zou de grondslag
--    verlagen waar hij zelf uit volgt.
-- ------------------------------------------------------------
create or replace function public.get_corporate_tax_inputs(
  p_organization_id uuid,
  p_fiscal_year_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
  v_year integer;
  v_commercial bigint;
  v_prepaid bigint;
  v_brackets jsonb;
  v_threshold bigint;
  v_relief_rate integer;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;

  -- Het tarief hoort bij het jaar waarin het boekjaar EINDIGT; bij een gebroken
  -- boekjaar is dat de gangbare aanknoping.
  v_year := extract(year from v_fy.period_end)::int;

  select coalesce(sum(
    case when la.type = 'revenue' then jl.credit_cents - jl.debit_cents
         else -(jl.debit_cents - jl.credit_cents) end
  ), 0)::bigint
  into v_commercial
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.source_type <> 'year_close'
    and je.date between v_fy.period_start and v_fy.period_end
    and la.type in ('revenue', 'expense')
    and coalesce(la.report_group, '') <> 'belastingen';

  -- Betaalde voorlopige aanslagen: het debetsaldo op 1545 binnen het boekjaar.
  select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint
  into v_prepaid
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.date between v_fy.period_start and v_fy.period_end
    and la.subtype = 'corporate_tax_prepaid';

  select jsonb_agg(jsonb_build_object(
           'lowerBoundCents', r.lower_bound_cents,
           'baseAmountCents', r.base_amount_cents,
           'rateBasisPoints', r.rate_basis_points
         ) order by r.lower_bound_cents),
         min(r.loss_relief_threshold_cents),
         min(r.loss_relief_rate_basis_points)
  into v_brackets, v_threshold, v_relief_rate
  from public.corporate_tax_rates r
  where r.year = v_year;

  if v_brackets is null then
    raise exception 'Voor % zijn nog geen Vpb-tarieven vastgelegd. Zodra de wetgever ze vaststelt worden ze toegevoegd.', v_year
      using errcode = '02000';
  end if;

  return jsonb_build_object(
    'fiscalYear', jsonb_build_object(
      'id', v_fy.id, 'label', v_fy.label,
      'periodStart', v_fy.period_start, 'periodEnd', v_fy.period_end,
      'status', v_fy.status
    ),
    'rules', jsonb_build_object(
      'year', v_year,
      'brackets', v_brackets,
      'lossReliefThresholdCents', v_threshold,
      'lossReliefRateBasisPoints', v_relief_rate
    ),
    'commercialResultCents', v_commercial,
    'prepaidCents', v_prepaid,
    'corrections', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'code', c.code, 'label', c.label, 'amountCents', c.amount_cents
             ) order by c.created_at)
      from public.corporate_tax_corrections c
      where c.organization_id = p_organization_id and c.fiscal_year_id = p_fiscal_year_id
    ), '[]'::jsonb),
    'lossesCarriedForward', coalesce((
      select jsonb_agg(jsonb_build_object(
               'year', l.year, 'remainingCents', l.remaining_cents,
               'establishedByAssessment', l.established_by_assessment
             ) order by l.year)
      from public.corporate_tax_losses l
      where l.organization_id = p_organization_id
        and l.remaining_cents > 0
        and l.year < v_year
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_corporate_tax_inputs(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_corporate_tax_inputs(uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 7. De uitkomst vastleggen en de reservering boeken
--    p_computation is exact wat vpb.ts heeft teruggegeven; de losse kolommen
--    zijn er alleen om op te kunnen sorteren en optellen zonder in de jsonb te
--    hoeven graven. De RPC rekent NIET zelf — hij controleert wel dat de
--    aangeleverde bedragen onderling kloppen, zodat een fout in de aanroeper
--    niet stilzwijgend in het grootboek belandt.
-- ------------------------------------------------------------
create or replace function public.save_corporate_tax_return(
  p_organization_id uuid,
  p_fiscal_year_id uuid,
  p_computation jsonb,
  p_finalize boolean default false,
  p_note text default null,
  p_created_by uuid default auth.uid()
)
returns public.corporate_tax_returns
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
  v_row public.corporate_tax_returns;
  v_year integer;
  v_tax bigint;
  v_taxable bigint;
  v_fiscal bigint;
  v_commercial bigint;
  v_corrections bigint;
  v_loss_used bigint;
  v_prepaid bigint;
  v_entry public.journal_entries;
  v_expense uuid;
  v_payable uuid;
  v_post_date date;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':vpb'));

  if not public.org_has_business(p_organization_id) then
    raise exception 'De vennootschapsbelasting hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'Vennootschapsbelasting hoort bij een BV, NV of coöperatie; een IB-onderneming betaalt inkomstenbelasting.'
      using errcode = '23514';
  end if;

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  v_year := extract(year from v_fy.period_end)::int;

  v_commercial   := coalesce((p_computation->>'commercialResultCents')::bigint, 0);
  v_corrections  := coalesce((p_computation->>'totalCorrectionsCents')::bigint, 0);
  v_fiscal       := coalesce((p_computation->>'fiscalProfitCents')::bigint, 0);
  v_loss_used    := coalesce((p_computation->>'totalLossUsedCents')::bigint, 0);
  v_taxable      := coalesce((p_computation->>'taxableAmountCents')::bigint, 0);
  v_tax          := coalesce((p_computation->>'taxCents')::bigint, 0);
  v_prepaid      := coalesce((p_computation->>'prepaidCents')::bigint, 0);

  -- Onderlinge samenhang controleren. Niet om te herrekenen, maar om te
  -- voorkomen dat een aanroeper met losse bedragen iets in het grootboek zet
  -- dat nergens op slaat.
  if v_commercial + v_corrections <> v_fiscal then
    raise exception 'De berekening klopt niet: commercieel resultaat plus correcties is niet de fiscale winst.'
      using errcode = '23514';
  end if;
  if v_tax < 0 or v_taxable < 0 or v_loss_used < 0 then
    raise exception 'Een negatief belastbaar bedrag, belastingbedrag of verliesverrekening kan niet.'
      using errcode = '23514';
  end if;
  if v_taxable > greatest(v_fiscal - v_loss_used, 0) then
    raise exception 'Het belastbare bedrag is hoger dan de fiscale winst na verliesverrekening.'
      using errcode = '23514';
  end if;

  insert into public.corporate_tax_returns as t (
    organization_id, fiscal_year_id, created_by, year,
    commercial_result_cents, corrections_cents, fiscal_profit_cents,
    loss_relief_cap_cents, loss_used_cents, taxable_amount_cents,
    tax_cents, prepaid_cents, balance_due_cents, computation, status, note
  ) values (
    p_organization_id, p_fiscal_year_id, p_created_by, v_year,
    v_commercial, v_corrections, v_fiscal,
    coalesce((p_computation->>'lossReliefCapCents')::bigint, 0), v_loss_used, v_taxable,
    v_tax, v_prepaid, v_tax - v_prepaid, p_computation, 'draft', nullif(btrim(p_note), '')
  )
  on conflict (fiscal_year_id) where status <> 'reversed'
  do update set
    commercial_result_cents = excluded.commercial_result_cents,
    corrections_cents       = excluded.corrections_cents,
    fiscal_profit_cents     = excluded.fiscal_profit_cents,
    loss_relief_cap_cents   = excluded.loss_relief_cap_cents,
    loss_used_cents         = excluded.loss_used_cents,
    taxable_amount_cents    = excluded.taxable_amount_cents,
    tax_cents               = excluded.tax_cents,
    prepaid_cents           = excluded.prepaid_cents,
    balance_due_cents       = excluded.balance_due_cents,
    computation             = excluded.computation,
    note                    = coalesce(excluded.note, t.note),
    updated_at              = now()
  where t.status = 'draft'
  returning * into v_row;

  if not found then
    raise exception 'De berekening over dit boekjaar is al vastgesteld. Draai die eerst terug.'
      using errcode = '23514';
  end if;

  if not coalesce(p_finalize, false) then
    return v_row;
  end if;

  -- ---- Vaststellen: de last en de schuld in het grootboek ----------------
  -- De reservering hoort in het boekjaar zelf te vallen, want de belasting
  -- drukt op díe winst. Valt dat jaar al dicht, dan is er niets meer te boeken
  -- en moet de gebruiker eerst heropenen — stilzwijgend naar een andere datum
  -- schuiven zou het resultaat van twee jaren vervuilen.
  v_post_date := v_fy.period_end;
  if exists (
    select 1 from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and v_post_date between cp.period_start and cp.period_end
  ) then
    raise exception 'De periode rond % is afgesloten; de Vpb-last hoort in het boekjaar zelf. Heropen het boekjaar om de reservering alsnog te boeken.',
      to_char(v_post_date, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  if v_tax <> 0 then
    perform public.ensure_default_ledger_accounts(p_organization_id);
    v_expense := public.bookkeeping_account_id(p_organization_id, '9900');
    v_payable := public.bookkeeping_account_id(p_organization_id, '1540');

    v_entry := public.post_journal_entry(
      p_organization_id, v_post_date,
      'Vennootschapsbelasting ' || v_fy.label,
      'corporate_tax', v_row.id,
      jsonb_build_array(
        jsonb_build_object('account_id', v_expense,
          'description', 'Vennootschapsbelasting ' || v_fy.label,
          'debit_cents', v_tax, 'credit_cents', 0),
        jsonb_build_object('account_id', v_payable,
          'description', 'Te betalen vennootschapsbelasting ' || v_fy.label,
          'debit_cents', 0, 'credit_cents', v_tax)
      ),
      p_created_by
    );
  end if;

  -- Verliezen bijwerken: gebruikte verliezen afboeken, een verlies van dit jaar
  -- vastleggen. Beide uit de uitkomst van het rekenhart, zodat de administratie
  -- en de berekening niet uit elkaar kunnen lopen.
  update public.corporate_tax_losses l
  set remaining_cents = greatest(l.remaining_cents - u.used_cents, 0)
  from (
    select (e->>'year')::int as year, (e->>'usedCents')::bigint as used_cents
    from jsonb_array_elements(coalesce(p_computation->'lossesUsed', '[]'::jsonb)) e
  ) u
  where l.organization_id = p_organization_id and l.year = u.year;

  if v_fiscal < 0 then
    insert into public.corporate_tax_losses(organization_id, created_by, year, amount_cents, remaining_cents)
    values (p_organization_id, p_created_by, v_year, -v_fiscal, -v_fiscal)
    on conflict (organization_id, year) do update
      set amount_cents = excluded.amount_cents,
          remaining_cents = excluded.remaining_cents,
          updated_at = now();
  end if;

  update public.corporate_tax_returns
  set status = 'final', accrual_entry_id = v_entry.id,
      finalized_at = now(), finalized_by = p_created_by
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.save_corporate_tax_return(uuid, uuid, jsonb, boolean, text, uuid) from public, anon, authenticated;
grant execute on function public.save_corporate_tax_return(uuid, uuid, jsonb, boolean, text, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 8. Terugdraaien
--    Zelfde keuze als bij de resultaatbestemming: het boekstuk op 'reversed'
--    zetten in plaats van een spiegelpost. De last valt op de balansdatum van
--    het boekjaar zelf, en dat jaar kan later dicht zijn gegaan — een nieuwe
--    boeking zou dan onmogelijk zijn en de berekening voorgoed onomkeerbaar.
-- ------------------------------------------------------------
create or replace function public.reverse_corporate_tax_return(
  p_organization_id uuid,
  p_return_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.corporate_tax_returns
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.corporate_tax_returns;
begin
  if auth.role() <> 'service_role' and not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen een eigenaar of beheerder mag een Vpb-berekening terugdraaien.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':vpb'));

  select * into v_row from public.corporate_tax_returns
  where id = p_return_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Vpb-berekening niet gevonden.' using errcode = '02000';
  end if;
  if v_row.status = 'reversed' then
    raise exception 'Deze berekening is al teruggedraaid.' using errcode = '23514';
  end if;

  if v_row.accrual_entry_id is not null then
    update public.journal_entries
    set status = 'reversed'
    where id = v_row.accrual_entry_id
      and organization_id = p_organization_id
      and status = 'posted';
  end if;

  -- De verliezen terugzetten zoals ze vóór deze berekening stonden.
  update public.corporate_tax_losses l
  set remaining_cents = l.remaining_cents + u.used_cents
  from (
    select (e->>'year')::int as year, (e->>'usedCents')::bigint as used_cents
    from jsonb_array_elements(coalesce(v_row.computation->'lossesUsed', '[]'::jsonb)) e
  ) u
  where l.organization_id = p_organization_id and l.year = u.year;

  -- Een verlies dat dóór deze berekening is ontstaan, verdwijnt weer.
  if v_row.fiscal_profit_cents < 0 then
    delete from public.corporate_tax_losses
    where organization_id = p_organization_id
      and year = v_row.year
      and not established_by_assessment;
  end if;

  update public.corporate_tax_returns
  set status = 'reversed', updated_at = now()
  where id = p_return_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.reverse_corporate_tax_return(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.reverse_corporate_tax_return(uuid, uuid, uuid) to authenticated, service_role;

commit;
