-- ============================================================
-- ResoFly — Vennootschapsbelasting: achterwaartse verliesverrekening
-- Date: 2026-11-04
--
-- Art. 20 lid 2 Wet Vpb 1969: "Het verlies van een jaar wordt verrekend met de
-- belastbare winsten van het voorafgaande jaar en de volgende jaren, mits het
-- verlies door de inspecteur is vastgesteld bij voor bezwaar vatbare
-- beschikking. Daarbij vindt verrekening in een jaar slechts plaats tot een
-- bedrag van € 1.000.000 vermeerderd met 50% van de belastbare winst van dat
-- jaar nadat die winst is verminderd met een bedrag van € 1.000.000."
--
-- Tot nu toe schoof een verlies alleen vooruit. Dat is in strijd met de
-- volgorde van de wet: eerst achterwaarts (één jaar), dan pas voorwaarts. Dat
-- is geen keuze van de belastingplichtige. Gevolg was een te hoge
-- verliespositie voor latere jaren en een gemiste teruggaaf over het jaar
-- ervoor.
--
-- HOE HET NU WERKT
-- ────────────────
--   * Het rekenhart (_shared/vpb.ts, computeCarryBack) verrekent een verlies
--     eerst met het DIRECT voorafgaande boekjaar, als daarvan een vastgestelde
--     berekening bestaat.
--   * De ruimte in dat jaar is de bovengrens van art. 20 lid 2 over de winst
--     van dat jaar, min wat dat jaar al voorwaarts verrekende (Kennisgroep
--     KG:011:2023:14). Drempel en percentage komen uit de regels van het
--     VERLIESJAAR: het recht op verrekening volgt de wettekst van het
--     verliesjaar (zelfde standpunt), dus een verlies uit 2022 is ook met
--     2021 beperkt verrekenbaar.
--   * De teruggaaf is de belasting van het voorafgaande jaar vóór en ná de
--     verrekening, tegen het tarief van dát jaar.
--   * Bij vaststellen boekt de database de teruggaaf in het verliesjaar: debet
--     1540 (vordering op de Belastingdienst) aan 9900 (belastingbate). Een
--     teruggaaf door achterwaartse verliesverrekening is een vordering die bij
--     het verliesjaar hoort, niet een correctie van het jaar ervoor; de
--     vastgestelde cijfers van dat jaar blijven dus staan.
--   * Alleen wat niet achterwaarts past, gaat de verliesadministratie in.
--   * save_corporate_tax_return rekent dit alles zelf na. Een aanroeper kan dus
--     geen andere verrekening of teruggaaf in het grootboek zetten dan de wet
--     geeft.
--   * Een berekening waarnaar een later verlies is teruggewenteld, kan pas
--     worden teruggedraaid als die latere berekening eerst is teruggedraaid.
--
-- Procedure bij de Belastingdienst (ter informatie, ResoFly dient niets in):
-- het verlies wordt verrekend nadat het bij beschikking is vastgesteld. Wie
-- niet wil wachten, vraagt bij het indienen van de aangifte schriftelijk om
-- een voorlopige verliesverrekening; daarbij wordt voorlopig maximaal 80% van
-- het aangegeven verlies verrekend, mits de aanslag over het voorafgaande jaar
-- vaststaat (Belastingdienst, "Vpb: verrekenen van verliezen").
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Vastleggen welke teruggaaf bij welke berekening hoort ────────────────
alter table public.corporate_tax_returns
  add column if not exists carry_back_cents bigint not null default 0,
  add column if not exists carry_back_refund_cents bigint not null default 0,
  add column if not exists carry_back_to_return_id uuid
    references public.corporate_tax_returns(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'corporate_tax_returns_carry_back_ck') then
    alter table public.corporate_tax_returns
      add constraint corporate_tax_returns_carry_back_ck
      check (carry_back_cents >= 0 and carry_back_refund_cents >= 0);
  end if;
end $$;

comment on column public.corporate_tax_returns.carry_back_cents is
  'Verlies van dit jaar dat achterwaarts is verrekend met het voorafgaande boekjaar (art. 20 lid 2 Wet Vpb 1969).';
comment on column public.corporate_tax_returns.carry_back_refund_cents is
  'Teruggaaf van vennootschapsbelasting over het voorafgaande boekjaar door die verrekening; bij vaststellen geboekt op 1540/9900.';
comment on column public.corporate_tax_returns.carry_back_to_return_id is
  'De vastgestelde berekening van het voorafgaande boekjaar waarmee is verrekend.';

-- Een jaar kan maar één opvolger hebben; meer dan één vastgestelde terugwenteling
-- naar dezelfde berekening is altijd een fout.
create unique index if not exists uq_corporate_tax_returns_carry_back_target
  on public.corporate_tax_returns(carry_back_to_return_id)
  where status = 'final' and carry_back_to_return_id is not null;

-- ── 2. De invoer: het voorafgaande boekjaar en zijn vastgestelde berekening ─
CREATE OR REPLACE FUNCTION public.get_corporate_tax_inputs(p_organization_id uuid, p_fiscal_year_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_fy public.fiscal_years;
  v_year integer;
  v_commercial bigint;
  v_prepaid bigint;
  v_brackets jsonb;
  v_threshold bigint;
  v_relief_rate integer;
  v_prev_fy public.fiscal_years;
  v_prev_ret public.corporate_tax_returns;
  v_prev_has_ret boolean := false;
  v_prev_brackets jsonb;
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

  -- De aangifte hoort bij het kalenderjaar waarin het boekjaar AANVANGT
  -- (art. 7 lid 4 Wet Vpb: de winst wordt bepaald over het boekjaar, en de
  -- aanslag draagt het jaar van aanvang). Aanknopen bij het eindjaar zou een
  -- gebroken boekjaar 1-7-2022/30-6-2023 onder 2023 brengen.
  v_year := extract(year from v_fy.period_start)::int;

  -- Loopt het boekjaar door een tariefwijziging heen, dan schrijft art. 31 Wet
  -- Vpb een tijdsevenredige splitsing voor: de belasting naar rato van de dagen
  -- per kalenderjaar, elk tegen zijn eigen tabel. Dat kunnen we hier nog niet,
  -- en een uitkomst tegen één tabel zou er tienduizenden euro's naast zitten.
  -- Dus weigeren met een duidelijke reden in plaats van stilzwijgend fout
  -- rekenen.
  -- GEWIJZIGD (20261104040000): de hele tabel vergelijken, niet alleen de
  -- regels met dezelfde ondergrens. 2021 → 2022 verschoof de schijfgrens
  -- (€ 245.000 → € 395.000) en dat zag de oude vergelijking niet.
  if extract(year from v_fy.period_end)::int <> v_year
     and (
       exists (
         select a.lower_bound_cents, a.base_amount_cents, a.rate_basis_points, a.loss_relief_threshold_cents, a.loss_relief_rate_basis_points
         from public.corporate_tax_rates a where a.year = v_year
         except
         select b.lower_bound_cents, b.base_amount_cents, b.rate_basis_points, b.loss_relief_threshold_cents, b.loss_relief_rate_basis_points
         from public.corporate_tax_rates b where b.year = extract(year from v_fy.period_end)::int
       )
       or exists (
         select b.lower_bound_cents, b.base_amount_cents, b.rate_basis_points, b.loss_relief_threshold_cents, b.loss_relief_rate_basis_points
         from public.corporate_tax_rates b where b.year = extract(year from v_fy.period_end)::int
         except
         select a.lower_bound_cents, a.base_amount_cents, a.rate_basis_points, a.loss_relief_threshold_cents, a.loss_relief_rate_basis_points
         from public.corporate_tax_rates a where a.year = v_year
       )
     ) then
    raise exception 'Dit boekjaar loopt door een tariefwijziging heen (% en %). De wet vraagt dan een tijdsevenredige berekening per kalenderjaar (art. 31 Wet Vpb); die ondersteunen we nog niet. Laat deze aangifte door je accountant berekenen.',
      v_year, extract(year from v_fy.period_end)::int using errcode = '0A000';
  end if;

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
    -- De vennootschapsbelasting zelf hoort niet in haar eigen grondslag. Filteren
    -- op het SUBTYPE en niet op de rubriek: de rubriek is een presentatiekolom die
    -- de gebruiker vrij mag zetten, en wie zijn motorrijtuigenbelasting onder
    -- "Belastingen" schuift zou anders die kosten uit de grondslag zien vallen.
    -- Het subtype 'corporate_tax' kent de boekhoudmotor zelf toe aan 9900.
    and coalesce(la.subtype, '') <> 'corporate_tax';

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

  -- TOEGEVOEGD (20261104050000): achterwaartse verliesverrekening (art. 20 lid 2
  -- Wet Vpb). Het "voorafgaande jaar" is het boekjaar dat direct vóór dit
  -- boekjaar eindigt; zit er een gat tussen, dan staat het voorafgaande jaar
  -- niet in deze administratie. Alleen een VASTGESTELDE berekening telt: een
  -- concept kan nog veranderen.
  select * into v_prev_fy
  from public.fiscal_years fy
  where fy.organization_id = p_organization_id
    and fy.period_end = v_fy.period_start - 1
  limit 1;

  if v_prev_fy.id is not null then
    select * into v_prev_ret
    from public.corporate_tax_returns r
    where r.organization_id = p_organization_id
      and r.fiscal_year_id = v_prev_fy.id
      and r.status = 'final'
      and not exists (
        select 1 from public.corporate_tax_returns o
        where o.carry_back_to_return_id = r.id
          and o.status = 'final'
          and o.fiscal_year_id <> p_fiscal_year_id
      );
    v_prev_has_ret := found;

    if v_prev_has_ret then
      select jsonb_agg(jsonb_build_object(
               'lowerBoundCents', r.lower_bound_cents,
               'baseAmountCents', r.base_amount_cents,
               'rateBasisPoints', r.rate_basis_points
             ) order by r.lower_bound_cents)
      into v_prev_brackets
      from public.corporate_tax_rates r
      where r.year = v_prev_ret.year;
    end if;
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
    ), '[]'::jsonb),
    'precedingFiscalYear', case when v_prev_fy.id is null then null else jsonb_build_object(
      'id', v_prev_fy.id,
      'label', v_prev_fy.label,
      'year', extract(year from v_prev_fy.period_start)::int,
      'hasFinalReturn', v_prev_has_ret
    ) end,
    'carryBackBasis', case when v_prev_has_ret and v_prev_brackets is not null then jsonb_build_object(
      'year', v_prev_ret.year,
      'fiscalYearId', v_prev_fy.id,
      'label', v_prev_fy.label,
      'returnId', v_prev_ret.id,
      'fiscalProfitCents', v_prev_ret.fiscal_profit_cents,
      'lossUsedCents', v_prev_ret.loss_used_cents,
      'taxableAmountCents', v_prev_ret.taxable_amount_cents,
      'taxCents', v_prev_ret.tax_cents,
      'brackets', v_prev_brackets
    ) end
  );
end;
$function$;
revoke all on function public.get_corporate_tax_inputs(uuid, uuid) from public, anon;
grant execute on function public.get_corporate_tax_inputs(uuid, uuid) to authenticated, service_role;

-- ── 3. Opslaan en vaststellen: nagerekend en de teruggaaf geboekt ──────────
CREATE OR REPLACE FUNCTION public.save_corporate_tax_return(p_organization_id uuid, p_fiscal_year_id uuid, p_computation jsonb, p_finalize boolean DEFAULT false, p_note text DEFAULT NULL::text, p_created_by uuid DEFAULT auth.uid())
 RETURNS corporate_tax_returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_fy public.fiscal_years;
  v_row public.corporate_tax_returns;
  v_year integer;
  v_ledger_commercial bigint;
  v_table_corrections bigint;
  v_used_sum bigint;
  v_used_count integer;
  v_used_years integer;
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
  v_expected_tax bigint;
  v_expected_cap bigint;
  v_cb jsonb;
  v_prev_fy public.fiscal_years;
  v_prev_ret public.corporate_tax_returns;
  v_cb_threshold bigint;
  v_cb_rate integer;
  v_cb_cap bigint := 0;
  v_cb_room bigint := 0;
  v_cb_used bigint := 0;
  v_cb_refund bigint := 0;
  v_cb_taxable_after bigint;
  v_cb_tax_after bigint;
  v_cb_return_id uuid;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':vpb'));
  -- TOEGEVOEGD (20261104040000): de Vpb-boeking mag in een afgesloten periode;
  -- daarom de boekingsgrendel gedeeld, zodat hij niet tussen het optellen en
  -- het slot van de jaarafsluiting valt.
  perform pg_advisory_xact_lock_shared(hashtext(p_organization_id::text || ':periodegrendel'));

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
  -- GEWIJZIGD (20261104040000): het aanvangsjaar, net als get_corporate_tax_inputs
  -- (art. 7 lid 4 Wet Vpb). Met het eindjaar kwam het verlies van een gebroken
  -- boekjaar onder het verkeerde jaar en bood de volgende berekening het niet aan.
  v_year := extract(year from v_fy.period_start)::int;

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
  -- TOEGEVOEGD (20261104040000): de invoer zelf nagerekend. Het commerciële
  -- resultaat moet het grootboek zijn (zelfde afbakening als
  -- get_corporate_tax_inputs), de correcties de vastgelegde correcties, en het
  -- verrekende verlies moet in de verliesadministratie openstaan.
  select coalesce(sum(
    case when la.type = 'revenue' then jl.credit_cents - jl.debit_cents
         else -(jl.debit_cents - jl.credit_cents) end
  ), 0)::bigint
  into v_ledger_commercial
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.source_type <> 'year_close'
    and je.date between v_fy.period_start and v_fy.period_end
    and la.type in ('revenue', 'expense')
    and coalesce(la.subtype, '') <> 'corporate_tax';
  if v_ledger_commercial <> v_commercial then
    raise exception 'Het commerciële resultaat in de berekening (% cent) wijkt af van het grootboek (% cent); er is sinds de berekening geboekt. Herbereken de aangifte.',
      v_commercial, v_ledger_commercial using errcode = '23514';
  end if;

  select coalesce(sum(c.amount_cents), 0)::bigint into v_table_corrections
  from public.corporate_tax_corrections c
  where c.organization_id = p_organization_id and c.fiscal_year_id = p_fiscal_year_id;
  if v_table_corrections <> v_corrections then
    raise exception 'De fiscale correcties in de berekening (% cent) wijken af van de vastgelegde correcties (% cent). Herbereken de aangifte.',
      v_corrections, v_table_corrections using errcode = '23514';
  end if;

  select coalesce(sum((e->>'usedCents')::bigint), 0)::bigint, count(*), count(distinct (e->>'year')::int)
  into v_used_sum, v_used_count, v_used_years
  from jsonb_array_elements(coalesce(p_computation->'lossesUsed', '[]'::jsonb)) e;
  if v_used_sum <> v_loss_used or v_used_count <> v_used_years then
    raise exception 'De verliesverrekening in de berekening telt niet op (of noemt een jaar twee keer). Herbereken de aangifte.'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_computation->'lossesUsed', '[]'::jsonb)) e
    left join public.corporate_tax_losses l
      on l.organization_id = p_organization_id and l.year = (e->>'year')::int
    where (e->>'usedCents')::bigint <= 0
       or l.id is null
       or l.year >= v_year
       or (e->>'usedCents')::bigint > l.remaining_cents
  ) then
    raise exception 'De berekening verrekent verlies dat niet (meer) openstaat in de verliesadministratie. Herbereken de aangifte.'
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

  -- Het bedrag dat straks in het grootboek belandt komt van de aanroeper. Dus
  -- hier hetzelfde als bij de btw-aangifte: de database rekent het zelf na en
  -- weigert bij afwijking. De tarieftabel staat er toch al; hem niet gebruiken
  -- zou betekenen dat één fout in de client rechtstreeks een verkeerde
  -- belastinglast boekt.
  select coalesce(r.base_amount_cents, 0)
       + round(((v_taxable - coalesce(r.lower_bound_cents, 0))::numeric * r.rate_basis_points) / 10000)
  into v_expected_tax
  from public.corporate_tax_rates r
  where r.year = v_year
    and r.lower_bound_cents < greatest(v_taxable, 1)
  order by r.lower_bound_cents desc
  limit 1;

  if v_taxable = 0 then
    v_expected_tax := 0;
  end if;
  if v_expected_tax is null then
    raise exception 'Voor % zijn geen Vpb-tarieven vastgelegd; de berekening kan niet worden nagerekend.', v_year
      using errcode = '02000';
  end if;
  if v_tax <> v_expected_tax then
    raise exception 'De berekende belasting (% cent) komt niet overeen met de tarieftabel van % (% cent). Herbereken de aangifte.',
      v_tax, v_year, v_expected_tax using errcode = '23514';
  end if;

  -- En de verliesverrekening tegen de wettelijke bovengrens van art. 20 lid 2.
  select case
    when v_fiscal <= 0 then 0
    when v_fiscal <= r.loss_relief_threshold_cents then v_fiscal
    else r.loss_relief_threshold_cents
         + round(((v_fiscal - r.loss_relief_threshold_cents)::numeric * r.loss_relief_rate_basis_points) / 10000)
  end
  into v_expected_cap
  from public.corporate_tax_rates r
  where r.year = v_year
  order by r.lower_bound_cents
  limit 1;

  if v_loss_used > coalesce(v_expected_cap, 0) then
    raise exception 'Er wordt meer verlies verrekend (% cent) dan art. 20 lid 2 Wet Vpb toestaat (% cent).',
      v_loss_used, coalesce(v_expected_cap, 0) using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261104050000): achterwaartse verliesverrekening, nagerekend
  -- (art. 20 lid 2 Wet Vpb). Een verlies gaat eerst naar het direct
  -- voorafgaande boekjaar, als daarvan een vastgestelde berekening bestaat. De
  -- ruimte is de bovengrens over de winst van dat jaar (drempel en percentage
  -- van het verliesjaar) min wat dat jaar al voorwaarts verrekende
  -- (KG:011:2023:14). De teruggaaf volgt het tarief van dat jaar.
  v_cb := p_computation->'carryBack';
  if v_cb is not null and jsonb_typeof(v_cb) <> 'object' then
    v_cb := null;
  end if;

  if v_fiscal < 0 then
    select * into v_prev_fy
    from public.fiscal_years fy
    where fy.organization_id = p_organization_id
      and fy.period_end = v_fy.period_start - 1
    limit 1;

    if v_prev_fy.id is not null then
      select * into v_prev_ret
      from public.corporate_tax_returns r
      where r.organization_id = p_organization_id
        and r.fiscal_year_id = v_prev_fy.id
        and r.status = 'final'
        and not exists (
          select 1 from public.corporate_tax_returns o
          where o.carry_back_to_return_id = r.id
            and o.status = 'final'
            and o.fiscal_year_id <> p_fiscal_year_id
        )
      for update;

      if found then
        select min(r.loss_relief_threshold_cents), min(r.loss_relief_rate_basis_points)
        into v_cb_threshold, v_cb_rate
        from public.corporate_tax_rates r
        where r.year = v_year;

        v_cb_cap := case
          when v_prev_ret.fiscal_profit_cents <= 0 then 0
          when v_prev_ret.fiscal_profit_cents <= v_cb_threshold then v_prev_ret.fiscal_profit_cents
          else v_cb_threshold
               + round(((v_prev_ret.fiscal_profit_cents - v_cb_threshold)::numeric * v_cb_rate) / 10000)
        end;
        v_cb_room := greatest(0, v_cb_cap - greatest(0, v_prev_ret.loss_used_cents));
        v_cb_used := least(-v_fiscal, v_cb_room);

        if v_cb_used > 0 then
          v_cb_taxable_after := greatest(0, v_prev_ret.fiscal_profit_cents - greatest(0, v_prev_ret.loss_used_cents) - v_cb_used);
          -- Naar beneden afgerond op hele veelvouden van € 5, net als het rekenhart.
          v_cb_taxable_after := (v_cb_taxable_after / 500) * 500;

          if v_cb_taxable_after = 0 then
            v_cb_tax_after := 0;
          else
            select coalesce(r.base_amount_cents, 0)
                 + round(((v_cb_taxable_after - coalesce(r.lower_bound_cents, 0))::numeric * r.rate_basis_points) / 10000)
            into v_cb_tax_after
            from public.corporate_tax_rates r
            where r.year = v_prev_ret.year
              and r.lower_bound_cents < v_cb_taxable_after
            order by r.lower_bound_cents desc
            limit 1;
          end if;

          if v_cb_tax_after is null then
            raise exception 'Voor % zijn geen Vpb-tarieven vastgelegd; de teruggaaf door achterwaartse verliesverrekening kan niet worden berekend.', v_prev_ret.year
              using errcode = '02000';
          end if;

          v_cb_refund := greatest(0, v_prev_ret.tax_cents - v_cb_tax_after);
          v_cb_return_id := v_prev_ret.id;
        end if;
      end if;
    end if;
  end if;

  if coalesce((v_cb->>'usedCents')::bigint, 0) <> v_cb_used
     or coalesce((v_cb->>'refundCents')::bigint, 0) <> v_cb_refund
     or (v_cb_used > 0 and coalesce((v_cb->>'year')::int, -1) <> v_prev_ret.year) then
    raise exception 'De achterwaartse verliesverrekening in de berekening (% cent, teruggaaf % cent) wijkt af van wat art. 20 lid 2 Wet Vpb met het voorafgaande boekjaar geeft (% cent, teruggaaf % cent). Herbereken de aangifte.',
      coalesce((v_cb->>'usedCents')::bigint, 0), coalesce((v_cb->>'refundCents')::bigint, 0), v_cb_used, v_cb_refund
      using errcode = '23514';
  end if;

  insert into public.corporate_tax_returns as t (
    organization_id, fiscal_year_id, created_by, year,
    commercial_result_cents, corrections_cents, fiscal_profit_cents,
    loss_relief_cap_cents, loss_used_cents, taxable_amount_cents,
    tax_cents, prepaid_cents, balance_due_cents, computation, status, note,
    carry_back_cents, carry_back_refund_cents, carry_back_to_return_id
  ) values (
    p_organization_id, p_fiscal_year_id, p_created_by, v_year,
    v_commercial, v_corrections, v_fiscal,
    coalesce((p_computation->>'lossReliefCapCents')::bigint, 0), v_loss_used, v_taxable,
    v_tax, v_prepaid, v_tax - v_prepaid, p_computation, 'draft', nullif(btrim(p_note), ''),
    v_cb_used, v_cb_refund, v_cb_return_id
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
    carry_back_cents        = excluded.carry_back_cents,
    carry_back_refund_cents = excluded.carry_back_refund_cents,
    carry_back_to_return_id = excluded.carry_back_to_return_id,
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

  -- Alleen een JAAR-slot blokkeert. Een gefinaliseerde btw-aangifte vergrendelt
  -- ook de maand of het kwartaal waarin de balansdatum valt — en die sloten gaan
  -- nóóit meer open (alleen 'year'-rijen worden ooit verwijderd). Zou dat hier
  -- blokkeren, dan kon de Vpb-reservering per definitie nooit geboekt worden:
  -- de balansdatum ligt altijd in de laatste btw-periode van het boekjaar.
  -- Dat mag ook: deze post raakt alleen 9900 en 1540, en die komen in geen enkele
  -- btw-rubriek voor — precies de reden waarom 'year_close' dezelfde vrijstelling
  -- heeft.
  if exists (
    select 1 from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_type = 'year'
      and v_post_date between cp.period_start and cp.period_end
  ) then
    raise exception 'Boekjaar % is al afgesloten; de Vpb-last hoort ín dat boekjaar. Heropen het boekjaar om de reservering alsnog te boeken.',
      v_fy.label using errcode = '23514';
  end if;

  if v_tax <> 0 then
    perform public.ensure_default_ledger_accounts(p_organization_id);
    v_expense := public.bookkeeping_account_id(p_organization_id, '9900');
    v_payable := public.bookkeeping_account_id(p_organization_id, '1540');

    perform set_config('resofly.trusted_journal_source', 'corporate_tax', true);
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

  -- TOEGEVOEGD (20261104050000): de teruggaaf door achterwaartse
  -- verliesverrekening hoort bij het verliesjaar. Vordering op de
  -- Belastingdienst (1540, debet) tegen een belastingbate (9900, credit), op de
  -- balansdatum van het verliesjaar. Een verliesjaar heeft zelf geen
  -- belasting, dus dit is het enige boekstuk van deze berekening.
  if v_cb_refund > 0 then
    if v_tax <> 0 then
      raise exception 'Een jaar met belasting kan geen verlies terugwentelen.' using errcode = '23514';
    end if;
    perform public.ensure_default_ledger_accounts(p_organization_id);
    v_expense := public.bookkeeping_account_id(p_organization_id, '9900');
    v_payable := public.bookkeeping_account_id(p_organization_id, '1540');

    perform set_config('resofly.trusted_journal_source', 'corporate_tax', true);
    v_entry := public.post_journal_entry(
      p_organization_id, v_post_date,
      'Teruggaaf vennootschapsbelasting ' || v_prev_fy.label || ' door verlies ' || v_fy.label,
      'corporate_tax', v_row.id,
      jsonb_build_array(
        jsonb_build_object('account_id', v_payable,
          'description', 'Te vorderen vennootschapsbelasting ' || v_prev_fy.label
            || ' (achterwaartse verliesverrekening, art. 20 lid 2 Wet Vpb)',
          'debit_cents', v_cb_refund, 'credit_cents', 0),
        jsonb_build_object('account_id', v_expense,
          'description', 'Belastingbate door achterwaartse verliesverrekening ' || v_fy.label,
          'debit_cents', 0, 'credit_cents', v_cb_refund)
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

  -- GEWIJZIGD (20261104050000): wat achterwaarts is verrekend, staat niet meer
  -- open voor volgende jaren.
  if v_fiscal < 0 then
    insert into public.corporate_tax_losses(organization_id, created_by, year, amount_cents, remaining_cents)
    values (p_organization_id, p_created_by, v_year, -v_fiscal, -v_fiscal - v_cb_used)
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
$function$;
revoke all on function public.save_corporate_tax_return(uuid, uuid, jsonb, boolean, text, uuid) from public, anon;
grant execute on function public.save_corporate_tax_return(uuid, uuid, jsonb, boolean, text, uuid) to authenticated, service_role;

-- ── 4. Terugdraaien: niet onder een teruggewenteld verlies vandaan ─────────
CREATE OR REPLACE FUNCTION public.reverse_corporate_tax_return(p_organization_id uuid, p_return_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS corporate_tax_returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.corporate_tax_returns;
  v_fy public.fiscal_years;
  v_later text;
  v_carried_from text;
begin
  if auth.role() <> 'service_role' and not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen een eigenaar of beheerder mag een Vpb-berekening terugdraaien.' using errcode = '42501';
  end if;

  -- Dezelfde sleutel als close_fiscal_year, reopen_fiscal_year en de
  -- resultaatbestemming: anders zouden de controles hieronder een race verliezen
  -- van een gelijktijdige jaarafsluiting.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':vpb'));

  select * into v_row from public.corporate_tax_returns
  where id = p_return_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Vpb-berekening niet gevonden.' using errcode = '02000';
  end if;
  if v_row.status = 'reversed' then
    raise exception 'Deze berekening is al teruggedraaid.' using errcode = '23514';
  end if;
  -- Een concept heeft niets in het grootboek en niets aan de verliezen gedaan;
  -- terugdraaien zou verliezen terugboeken die nooit zijn afgeboekt.
  if v_row.status <> 'final' then
    raise exception 'Deze berekening is nog een concept en hoeft niet teruggedraaid te worden; pas hem aan of laat hem staan.'
      using errcode = '23514';
  end if;

  select * into v_fy from public.fiscal_years where id = v_row.fiscal_year_id;

  -- Het boekstuk uit de rapporten halen verandert de balans van het boekjaar
  -- waarin de last valt. Is dat jaar afgesloten, dan zou de vastgestelde balans
  -- met terugwerkende kracht scheef komen te staan — en niet meer te herstellen
  -- zijn, want opnieuw vaststellen weigert in een afgesloten jaar.
  if v_fy.id is not null and exists (
    select 1 from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_type = 'year'
      and v_fy.period_end between cp.period_start and cp.period_end
  ) then
    raise exception 'Boekjaar % is afgesloten. Heropen dat boekjaar eerst; anders verandert de vastgestelde balans ervan met terugwerkende kracht.',
      v_fy.label using errcode = '23514';
  end if;

  -- Heeft een later boekjaar het verlies van dit jaar al verrekend, dan zou het
  -- terugdraaien die verrekening in de lucht laten hangen en het verlies
  -- dubbel beschikbaar maken.
  select r.year::text into v_later
  from public.corporate_tax_returns r
  where r.organization_id = p_organization_id
    and r.status = 'final'
    and r.year > v_row.year
    and exists (
      select 1 from jsonb_array_elements(coalesce(r.computation->'lossesUsed', '[]'::jsonb)) e
      where (e->>'year')::int = v_row.year
    )
  order by r.year
  limit 1;
  if v_later is not null then
    raise exception 'Het verlies van % is al verrekend in de vastgestelde aangifte over %. Draai die eerst terug.',
      v_row.year, v_later using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261104050000): is een later verlies teruggewenteld naar deze
  -- berekening, dan hangt de teruggaaf in dat latere jaar eraan. Eerst dat jaar
  -- terugdraaien, anders blijft er een teruggaaf staan over een aanslag die
  -- hier niet meer bestaat.
  select r.year::text into v_carried_from
  from public.corporate_tax_returns r
  where r.organization_id = p_organization_id
    and r.status = 'final'
    and r.carry_back_to_return_id = v_row.id
  order by r.year
  limit 1;
  if v_carried_from is not null then
    raise exception 'Het verlies van % is achterwaarts verrekend met deze berekening; de teruggaaf is geboekt in %. Draai eerst de berekening over % terug.',
      v_carried_from, v_carried_from, v_carried_from using errcode = '23514';
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
$function$;
revoke all on function public.reverse_corporate_tax_return(uuid, uuid, uuid) from public, anon;
grant execute on function public.reverse_corporate_tax_return(uuid, uuid, uuid) to authenticated, service_role;

commit;
