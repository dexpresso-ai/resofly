-- ============================================================
-- ResoFly — Zakelijke module fase 1b: resultaatbestemming in twee stappen
-- Date: 2026-08-07
--
-- Aanleiding:
-- close_fiscal_year boekt het resultaat rechtstreeks naar 0510 Onverdeeld
-- resultaat en daarmee is het klaar. Bij een IB-onderneming klopt dat: de winst
-- is van de ondernemer. Bij een BV zijn dat twee juridisch verschillende
-- momenten met verschillende beslissers:
--
--   1. JAARAFSLUITING (bestuur) — het resultaat ná belasting gaat naar 0510.
--      Dat blijft precies zoals het was; close_fiscal_year verandert niet.
--   2. VASTSTELLING DOOR DE ALGEMENE VERGADERING — pas dán wordt besloten wat er
--      met de winst gebeurt: naar de overige reserves, of uitkeren als dividend.
--      Dat is deze migratie.
--
-- Waarom een aparte tabel en niet nog een kolom op fiscal_years:
-- een besluit van de AvA is een eigen gebeurtenis met een eigen datum, een eigen
-- bestuursgoedkeuring en een eigen boekstuk, en het moet terug te draaien zijn
-- zonder het boekjaar te heropenen. Bovendien hangt fase 4 (aandeelhouders-
-- register, dividendbelasting) hieraan.
--
-- DE UITKERINGSTOETS VAN ART. 2:216 BW — beide delen, want ze zijn allebei
-- dwingend en ze doen iets anders:
--
--   * Balanstest (lid 1). De AvA mag alleen uitkeren "voor zover het eigen
--     vermogen groter is dan de reserves die krachtens de wet of de statuten
--     moeten worden aangehouden". Dat is een BEPERKTE toets: de ondergrens is
--     niet het hele eigen vermogen maar alleen de wettelijke en statutaire
--     reserves. Deze RPC rekent hem uit op de balansdatum van het vastgestelde
--     boekjaar en WEIGERT een dividend dat eroverheen gaat.
--   * Uitkeringstest (lid 2). Het bestuur moet goedkeuren en weigert die
--     goedkeuring als het weet of behoort te voorzien dat de vennootschap haar
--     opeisbare schulden daarna niet meer kan betalen. Dat is een oordeel over
--     de toekomst; dat kunnen wij niet uitrekenen. Zonder bestuursgoedkeuring
--     "heeft het besluit geen gevolgen" (lid 2), dus wij eisen een expliciete
--     bevestiging en leggen vast wie hem wanneer gaf. Blijkt de vennootschap
--     daarna haar opeisbare schulden niet te kunnen betalen, dan zijn de
--     bestuurders die dat wisten of behoorden te voorzien hoofdelijk verbonden
--     voor het tekort, en moet ook een ontvanger die dat wist of behoorde te
--     voorzien zijn uitkering terugbetalen (lid 3) — vandaar dat de bevestiging
--     in de app een bewuste handeling is en geen vinkje dat standaard aanstaat.
--
-- Dit is een hulpmiddel, geen advies: wij rekenen en leggen vast, het bestuur
-- besluit. Zelfde lijn als bij de BTW-periodeafsluiting.
--
-- DATUM VAN HET BOEKSTUK — het besluit valt ná de balansdatum, dus het boekstuk
-- valt in een volgend boekjaar. Dat moet ook: post_journal_entry weigert elke
-- boeking binnen een afgesloten jaar (alleen 'year_close' mag dat). Een
-- besluitdatum op of vóór period_end wordt daarom hier al geweigerd, met een
-- begrijpelijke melding in plaats van de generieke periodeslot-fout.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Nieuw boekstuk-brontype (volledige lijst overnemen)
-- ------------------------------------------------------------
alter table public.journal_entries drop constraint if exists journal_entries_source_type_check;
alter table public.journal_entries
  add constraint journal_entries_source_type_check check (source_type in (
    'sales_invoice','purchase_invoice','asset_depreciation','asset_acquisition','asset_disposal',
    'vat_return','payment','opening_balance','manual','year_close','credit_note',
    'result_appropriation'
  ));

-- ------------------------------------------------------------
-- 2. Tabel result_appropriations
-- ------------------------------------------------------------
create table if not exists public.result_appropriations (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  fiscal_year_id         uuid not null references public.fiscal_years(id) on delete cascade,
  created_by             uuid references auth.users(id) on delete set null default auth.uid(),
  -- Datum van het besluit van de algemene vergadering; tevens de boekdatum.
  decision_date          date not null,
  -- Het te bestemmen resultaat zoals het bij de afsluiting op 0510 landde.
  result_cents           bigint not null,
  reserves_cents         bigint not null default 0,
  dividend_cents         bigint not null default 0,
  reserves_account_code  text not null,
  dividend_account_code  text,
  -- Uitkomst van de balanstest op de balansdatum, bewaard zodat later
  -- navolgbaar is waarop het besluit is beoordeeld.
  distributable_cents    bigint,
  -- Bestuursgoedkeuring (uitkeringstest, art. 2:216 lid 2 BW).
  board_approved         boolean not null default false,
  board_approved_by      uuid references auth.users(id) on delete set null,
  board_approved_at      timestamptz,
  journal_entry_id       uuid references public.journal_entries(id) on delete set null,
  status                 text not null default 'posted',
  reversed_at            timestamptz,
  reversed_by            uuid references auth.users(id) on delete set null,
  note                   text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint result_appropriations_status_check check (status in ('posted','reversed')),
  constraint result_appropriations_dividend_nonneg check (dividend_cents >= 0),
  -- Winst verdeel je over reserves en dividend; een verlies kan alleen naar de
  -- reserves. In beide gevallen moet het besluit het hele resultaat bestemmen,
  -- anders blijft er een onverklaarbaar restant op 0510 staan.
  constraint result_appropriations_split_check check (reserves_cents + dividend_cents = result_cents)
);

create index if not exists idx_result_appropriations_org
  on public.result_appropriations(organization_id, decision_date desc);

-- Eén geldige bestemming per boekjaar. Een teruggedraaide bestemming blijft
-- staan voor de audittrail en blokkeert een nieuwe niet.
create unique index if not exists uq_result_appropriations_active
  on public.result_appropriations(fiscal_year_id)
  where status = 'posted';

alter table public.result_appropriations enable row level security;
-- Alleen lezen; alle mutatie via de security-definer RPC's hieronder.
drop policy if exists "result_appropriations read" on public.result_appropriations;
create policy "result_appropriations read" on public.result_appropriations
  for select using (public.can_read_org(organization_id));

-- Modulerechten, net als bij fiscal_years en de rest van de boekhouding
-- (20260730100000): een teamlid met financiën op "geen" mag een dividendbesluit
-- niet kunnen inzien. can_read_org kijkt alleen naar lidmaatschap, dus zonder
-- deze restrictieve policies zou de tabel voor iedereen in de organisatie open
-- staan.
select public.apply_module_gate('result_appropriations', 'finance');

drop trigger if exists result_appropriations_touch_updated_at on public.result_appropriations;
create trigger result_appropriations_touch_updated_at before update on public.result_appropriations
  for each row execute function public.bookkeeping_touch_updated_at();
drop trigger if exists result_appropriations_prevent_org_change on public.result_appropriations;
create trigger result_appropriations_prevent_org_change before update of organization_id on public.result_appropriations
  for each row execute function public.prevent_organization_id_change();
drop trigger if exists result_appropriations_audit on public.result_appropriations;
create trigger result_appropriations_audit after insert or update or delete on public.result_appropriations
  -- Tweede argument is de kolom waaruit het LABEL in de activiteitenlijst komt.
  -- De tabel heeft geen naam; de besluitdatum is het herkenbaarste dat er is.
  for each row execute function public.audit_row_change('result_appropriation', 'decision_date');

-- ------------------------------------------------------------
-- 3. Balanstest: hoeveel mag er hoogstens uit?
--    Eigen vermogen op de peildatum minus de reserves die niet uitgekeerd mogen
--    worden. Peildatum is de balansdatum van het vastgestelde boekjaar: op dat
--    moment staat het resultaat al op 0510 (het year_close-boekstuk valt op
--    period_end), dus het eigen vermogen is precies dat van de vastgestelde
--    jaarrekening.
--
--    BV en NV hebben NIET dezelfde ondergrens:
--      * BV — art. 2:216 lid 1 BW: alleen de wettelijke en statutaire reserves.
--              Het gestorte kapitaal is bij een BV géén ondergrens meer sinds de
--              Wet vereenvoudiging en flexibilisering bv-recht.
--      * NV — art. 2:105 lid 2 BW: het gestorte en opgevraagde deel van het
--              kapitaal telt WÉL mee in de ondergrens. Daar is p_lock_share_capital
--              voor; agio (0505) blijft ook dan vrij uitkeerbaar.
--
--    Welke rekeningen niet uitkeerbaar zijn, staat op de rekening zelf
--    (is_restricted_reserve, migratie 20260807020000). Het subtype telt mee als
--    vangnet voor administraties die de vlag nog niet hebben gezet.
-- ------------------------------------------------------------
create or replace function public.org_distributable_equity(
  p_organization_id uuid,
  p_as_of date,
  p_lock_share_capital boolean default false
)
returns bigint
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_total bigint;
begin
  -- Ook de modulecontrole: het vrij uitkeerbaar vermogen is een financieel
  -- kerngetal en hoort niet zichtbaar te zijn voor een teamlid dat de
  -- financiële module niet mag inzien. Een SECURITY DEFINER-functie loopt langs
  -- RLS heen, dus de restrictieve policies op de onderliggende tabellen doen
  -- hier niets.
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Let op de precieze afbakening van p_lock_share_capital: alleen subtype
  -- 'share_capital', niet het generieke 'equity'. Op een 0500 met subtype
  -- 'equity' heeft create_opening_balance ook de sluitpost van de beginbalans
  -- geparkeerd, en dat is opgebouwd vermogen, geen gestort kapitaal. Die
  -- meerekenen als ondergrens zou een NV een dividend weigeren waar zij wél
  -- recht op heeft.
  select coalesce(sum(
    case
      when la.is_restricted_reserve then 0
      when la.subtype in ('legal_reserve', 'statutory_reserve') then 0
      when p_lock_share_capital and la.subtype = 'share_capital' then 0
      else jl.credit_cents - jl.debit_cents
    end
  ), 0)::bigint
  into v_total
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.date <= p_as_of
    and la.type = 'equity';

  return v_total;
end;
$$;

comment on function public.org_distributable_equity(uuid, date, boolean) is
  'Vrij uitkeerbaar eigen vermogen op een peildatum: eigen vermogen minus de reserves die wettelijk of statutair moeten worden aangehouden (balanstest art. 2:216 lid 1 BW). Met p_lock_share_capital telt ook het gestorte kapitaal mee in de ondergrens, zoals art. 2:105 lid 2 BW voor een NV voorschrijft.';

revoke all on function public.org_distributable_equity(uuid, date, boolean) from public, anon, authenticated;
grant execute on function public.org_distributable_equity(uuid, date, boolean) to authenticated, service_role;

-- ------------------------------------------------------------
-- 4. appropriate_result: het besluit van de AvA vastleggen en boeken
-- ------------------------------------------------------------
create or replace function public.appropriate_result(
  p_organization_id uuid,
  p_fiscal_year_id uuid,
  p_decision_date date,
  p_reserves_cents bigint,
  p_dividend_cents bigint default 0,
  p_board_approved boolean default false,
  p_reserves_account_code text default '0520',
  p_dividend_account_code text default '1580',
  p_note text default null,
  p_created_by uuid default auth.uid()
)
returns public.result_appropriations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
  v_row public.result_appropriations;
  v_entry public.journal_entries;
  v_result bigint;
  v_reserves bigint := coalesce(p_reserves_cents, 0);
  v_dividend bigint := coalesce(p_dividend_cents, 0);
  v_result_code text;
  v_reserves_code text := coalesce(nullif(btrim(p_reserves_account_code), ''), '0520');
  v_dividend_code text := coalesce(nullif(btrim(p_dividend_account_code), ''), '1580');
  v_result_account uuid;
  v_reserves_account uuid;
  v_dividend_account uuid;
  v_distributable bigint;
  v_lines jsonb := '[]'::jsonb;
  v_closed record;
  v_legal_form text;
  v_account_type text;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Serialiseer tegen afsluiten/heropenen: die functies verplaatsen hetzelfde
  -- saldo op 0510.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  if not public.org_has_business(p_organization_id) then
    raise exception 'Resultaatbestemming hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;

  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'Een resultaatbestemming door de algemene vergadering hoort bij een BV, NV of coöperatie. Bij een IB-onderneming is de winst al van de ondernemer.'
      using errcode = '23514';
  end if;

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  if v_fy.status <> 'closed' then
    raise exception 'Sluit het boekjaar eerst af; de algemene vergadering bestemt het resultaat van een vastgestelde jaarrekening.'
      using errcode = '23514';
  end if;

  v_result := coalesce(v_fy.result_cents, 0);
  if v_result = 0 then
    raise exception 'Dit boekjaar heeft geen resultaat om te bestemmen.' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.result_appropriations ra
    where ra.fiscal_year_id = p_fiscal_year_id and ra.status = 'posted'
  ) then
    raise exception 'Het resultaat van dit boekjaar is al bestemd. Draai die bestemming eerst terug.'
      using errcode = '23505';
  end if;

  -- ---- Datum van het besluit -------------------------------------------
  if p_decision_date is null then
    raise exception 'De datum van het besluit ontbreekt.' using errcode = '23514';
  end if;
  if p_decision_date <= v_fy.period_end then
    raise exception 'De algemene vergadering besluit ná de balansdatum: kies een datum na %.',
      to_char(v_fy.period_end, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  -- Vriendelijke melding in plaats van de generieke periodeslot-fout uit
  -- post_journal_entry.
  select cp.period_start, cp.period_end into v_closed
  from public.closed_periods cp
  where cp.organization_id = p_organization_id
    and p_decision_date between cp.period_start and cp.period_end
  limit 1;
  if found then
    raise exception 'De periode % t/m % is afgesloten; kies een besluitdatum in een open periode.',
      to_char(v_closed.period_start, 'DD-MM-YYYY'), to_char(v_closed.period_end, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  -- ---- Bedragen ---------------------------------------------------------
  if v_result > 0 then
    if v_reserves < 0 or v_dividend < 0 then
      raise exception 'Een winstbestemming kent geen negatieve bedragen.' using errcode = '23514';
    end if;
    if v_reserves + v_dividend <> v_result then
      raise exception 'Het besluit moet het hele resultaat bestemmen: reserves + dividend moet % cent zijn, nu % cent.',
        v_result, v_reserves + v_dividend using errcode = '23514';
    end if;
  else
    -- Een verlies wordt niet uitgekeerd; het gaat volledig ten laste van de reserves.
    if v_dividend <> 0 then
      raise exception 'Uit een verlies kan geen dividend worden uitgekeerd.' using errcode = '23514';
    end if;
    if v_reserves <> v_result then
      raise exception 'Een verlies gaat volledig ten laste van de reserves: verwacht % cent, nu % cent.',
        v_result, v_reserves using errcode = '23514';
    end if;
  end if;

  -- ---- Uitkeringstoets ---------------------------------------------------
  -- Een NV heeft een strengere ondergrens dan een BV: bij een NV telt het
  -- gestorte en opgevraagde kapitaal mee (art. 2:105 lid 2 BW), bij een BV
  -- alleen de wettelijke en statutaire reserves (art. 2:216 lid 1 BW).
  v_legal_form := public.org_legal_form(p_organization_id);
  v_distributable := public.org_distributable_equity(
    p_organization_id, v_fy.period_end, v_legal_form = 'nv'
  );

  if v_dividend > 0 then
    if not public.org_is_corporate(p_organization_id) then
      raise exception 'Dividend hoort bij een BV of NV; een coöperatie keert uit aan haar leden en dat loopt niet via deze weg.'
        using errcode = '23514';
    end if;

    if v_dividend > v_distributable then
      if v_legal_form = 'nv' then
        raise exception 'Balanstest (art. 2:105 lid 2 BW): vrij uitkeerbaar is % cent — het eigen vermogen boven het gestorte kapitaal en de wettelijke en statutaire reserves. Het besluit keert % cent uit.',
          v_distributable, v_dividend using errcode = '23514';
      else
        raise exception 'Balanstest (art. 2:216 lid 1 BW): vrij uitkeerbaar is % cent — het eigen vermogen boven de wettelijke en statutaire reserves. Het besluit keert % cent uit.',
          v_distributable, v_dividend using errcode = '23514';
      end if;
    end if;

    -- Uitkeringstest (art. 2:216 lid 2 BW): zonder bestuursgoedkeuring heeft het
    -- besluit geen gevolgen, dus boeken we het ook niet. Bij een NV bestaat deze
    -- wettelijke goedkeuring niet; daar is het een gewoon bestuursbesluit, maar
    -- we vragen de bevestiging toch — vastleggen dat het bestuur ernaar gekeken
    -- heeft is nooit verkeerd.
    if not coalesce(p_board_approved, false) then
      raise exception 'Uitkeringstest (art. 2:216 lid 2 BW): het bestuur moet bevestigen dat de vennootschap haar opeisbare schulden ook ná de uitkering kan blijven betalen. Zonder die goedkeuring heeft het besluit geen gevolgen.'
        using errcode = '23514';
    end if;
  end if;

  -- ---- Boeken ------------------------------------------------------------
  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- De rekening waar de afsluiting het resultaat naartoe boekte; per boekjaar
  -- vastgelegd, zodat een latere wijziging van de instelling deze bestemming
  -- niet op een andere rekening laat aangrijpen.
  v_result_code := coalesce(
    v_fy.result_account_code,
    (select nullif(cs.year_result_account_code, '') from public.company_settings cs where cs.organization_id = p_organization_id),
    '0510'
  );

  v_result_account := public.bookkeeping_account_id(p_organization_id, v_result_code);
  v_reserves_account := public.bookkeeping_account_id(p_organization_id, v_reserves_code);

  -- De rekeningcodes komen van de aanroeper. bookkeeping_account_id controleert
  -- alleen dát de rekening bestaat, dus hier de soort erbij: een reserve is
  -- eigen vermogen en een dividendschuld is vreemd vermogen. Zonder deze check
  -- kan een besluit op een omzet- of kostenrekening landen en verdwijnt het
  -- resultaat opnieuw in de W&V.
  select la.type into v_account_type from public.ledger_accounts la where la.id = v_reserves_account;
  if v_account_type <> 'equity' then
    raise exception 'Rekening % is geen eigen-vermogensrekening; een resultaatbestemming gaat naar de reserves.', v_reserves_code
      using errcode = '23514';
  end if;
  -- De resultaatrekening zelf is óók eigen vermogen en zou de typecheck dus
  -- passeren. Debet én credit op dezelfde rekening is een sluitende nulboeking:
  -- het besluit lijkt vastgelegd, maar het resultaat staat nog onbestemd op
  -- 0510 en het boekjaar zit wél op slot.
  if v_reserves_account = v_result_account then
    raise exception 'De reserverekening mag niet dezelfde zijn als de resultaatrekening (%).', v_result_code
      using errcode = '23514';
  end if;

  if v_result > 0 then
    -- Winst: 0510 leegboeken (debet) tegen reserves en/of dividend (credit).
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_result_account,
      'description', 'Bestemming resultaat ' || v_fy.label,
      'debit_cents', v_result, 'credit_cents', 0));

    if v_reserves > 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_reserves_account,
        'description', 'Toevoeging aan de reserves ' || v_fy.label,
        'debit_cents', 0, 'credit_cents', v_reserves));
    end if;

    if v_dividend > 0 then
      v_dividend_account := public.bookkeeping_account_id(p_organization_id, v_dividend_code);
      select la.type into v_account_type from public.ledger_accounts la where la.id = v_dividend_account;
      if v_account_type <> 'liability' then
        raise exception 'Rekening % is geen schuldrekening; een dividendbesluit levert een schuld aan de aandeelhouder op.', v_dividend_code
          using errcode = '23514';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_dividend_account,
        'description', 'Dividenduitkering ' || v_fy.label,
        'debit_cents', 0, 'credit_cents', v_dividend));
    end if;
  else
    -- Verlies: 0510 leegboeken (credit) ten laste van de reserves (debet).
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_result_account,
      'description', 'Bestemming resultaat ' || v_fy.label,
      'debit_cents', 0, 'credit_cents', -v_result));
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_reserves_account,
      'description', 'Verlies ten laste van de reserves ' || v_fy.label,
      'debit_cents', -v_result, 'credit_cents', 0));
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, p_decision_date,
    'Resultaatbestemming ' || v_fy.label,
    'result_appropriation', p_fiscal_year_id, v_lines, p_created_by
  );

  insert into public.result_appropriations(
    organization_id, fiscal_year_id, created_by, decision_date,
    result_cents, reserves_cents, dividend_cents,
    reserves_account_code, dividend_account_code,
    distributable_cents, board_approved, board_approved_by, board_approved_at,
    journal_entry_id, status, note
  ) values (
    p_organization_id, p_fiscal_year_id, p_created_by, p_decision_date,
    v_result, v_reserves, v_dividend,
    v_reserves_code, case when v_dividend > 0 then v_dividend_code else null end,
    v_distributable,
    coalesce(p_board_approved, false),
    case when coalesce(p_board_approved, false) then p_created_by end,
    case when coalesce(p_board_approved, false) then now() end,
    v_entry.id, 'posted', nullif(btrim(p_note), '')
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.appropriate_result(uuid, uuid, date, bigint, bigint, boolean, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.appropriate_result(uuid, uuid, date, bigint, bigint, boolean, text, text, text, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 5. reverse_result_appropriation: het besluit terugdraaien
--
--    GEEN spiegelpost, maar het boekstuk op 'reversed' zetten — precies zoals
--    reopen_fiscal_year met het jaarafsluitboekstuk doet. De reden is dezelfde
--    én dwingend: een spiegelpost zou een NIEUWE boeking zijn, en die valt op
--    een besluitdatum die per definitie in een volgend boekjaar ligt. Zodra de
--    btw-aangifte over dat kwartaal is gefinaliseerd, is die datum voorgoed
--    vergrendeld (een maand- of kwartaalslot gaat nergens meer open), en dan
--    zou de bestemming permanent onomkeerbaar zijn — en met de guard in
--    reopen_fiscal_year hieronder het boekjaar permanent onheropenbaar.
--
--    Alle rapporten tellen alleen status='posted', dus 'reversed' zetten haalt
--    het boekstuk volledig uit de balans en herstelt exact de situatie van vóór
--    het besluit. Het boekstuk zelf blijft staan voor de audittrail, met de
--    ingetrokken bestemming ernaast in result_appropriations.
-- ------------------------------------------------------------
create or replace function public.reverse_result_appropriation(
  p_organization_id uuid,
  p_appropriation_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.result_appropriations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.result_appropriations;
  v_closed record;
begin
  if auth.role() <> 'service_role' and not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen een eigenaar of beheerder mag een resultaatbestemming terugdraaien.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_row from public.result_appropriations
  where id = p_appropriation_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Resultaatbestemming niet gevonden.' using errcode = '02000';
  end if;
  if v_row.status <> 'posted' then
    raise exception 'Deze resultaatbestemming is al teruggedraaid.' using errcode = '23514';
  end if;

  -- Het boekstuk uit de rapporten halen verandert de balans van het boekjaar
  -- waarin het besluit valt. Is dát boekjaar inmiddels zelf afgesloten, dan zou
  -- de vastgestelde balans ervan met terugwerkende kracht veranderen — precies
  -- wat reopen_fiscal_year ook weigert. Eerst dat jaar heropenen dus.
  --
  -- Alleen jaar-sloten tellen hier. Een gefinaliseerde btw-aangifte (maand of
  -- kwartaal) vergrendelt wél het BOEKEN, maar deze post raakt uitsluitend
  -- eigen-vermogensrekeningen en verandert geen enkele rubriek van die
  -- aangifte. Zou een btw-slot hier blokkeren, dan was de bestemming alsnog
  -- voorgoed onomkeerbaar: zo'n slot gaat nooit meer open.
  select cp.period_start, cp.period_end into v_closed
  from public.closed_periods cp
  where cp.organization_id = p_organization_id
    and cp.period_type = 'year'
    and v_row.decision_date between cp.period_start and cp.period_end
  limit 1;
  if found then
    raise exception 'Het besluit van % valt in boekjaar % t/m %, en dat is afgesloten. Heropen dat boekjaar eerst; anders verandert de vastgestelde balans ervan met terugwerkende kracht.',
      to_char(v_row.decision_date, 'DD-MM-YYYY'),
      to_char(v_closed.period_start, 'DD-MM-YYYY'), to_char(v_closed.period_end, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  if v_row.journal_entry_id is not null then
    update public.journal_entries
    set status = 'reversed'
    where id = v_row.journal_entry_id
      and organization_id = p_organization_id
      and status = 'posted';
  end if;

  update public.result_appropriations
  set status = 'reversed', reversed_at = now(), reversed_by = p_created_by
  where id = p_appropriation_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.reverse_result_appropriation(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.reverse_result_appropriation(uuid, uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 6. list_result_appropriations: overzicht voor de app
-- ------------------------------------------------------------
create or replace function public.list_result_appropriations(p_organization_id uuid)
returns table(
  id uuid,
  fiscal_year_id uuid,
  fiscal_year_label text,
  decision_date date,
  result_cents bigint,
  reserves_cents bigint,
  dividend_cents bigint,
  reserves_account_code text,
  dividend_account_code text,
  distributable_cents bigint,
  board_approved boolean,
  journal_entry_id uuid,
  entry_number text,
  status text,
  note text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Ook de modulecontrole, want een SECURITY DEFINER-RPC gaat overal langs RLS
  -- heen: de restrictieve policies op de tabel doen hier niets.
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  return query
    select
      ra.id, ra.fiscal_year_id, f.label, ra.decision_date,
      ra.result_cents, ra.reserves_cents, ra.dividend_cents,
      ra.reserves_account_code, ra.dividend_account_code,
      ra.distributable_cents, ra.board_approved,
      ra.journal_entry_id, je.entry_number,
      ra.status, ra.note, ra.created_at
    from public.result_appropriations ra
    join public.fiscal_years f on f.id = ra.fiscal_year_id
    left join public.journal_entries je on je.id = ra.journal_entry_id
    where ra.organization_id = p_organization_id
    order by ra.decision_date desc, ra.created_at desc;
end;
$$;

revoke all on function public.list_result_appropriations(uuid) from public, anon, authenticated;
grant execute on function public.list_result_appropriations(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 7. reopen_fiscal_year: eerst de bestemming terugdraaien
--    Heropenen zet het afsluitboekstuk op 'reversed' en haalt daarmee het
--    resultaat van 0510 af. Staat er dan nog een bestemming die vanaf diezelfde
--    0510 naar de reserves boekte, dan blijft die hangen en loopt 0510 negatief.
--    Volledige functie opnieuw (basis: 20260706120000), alleen de guard is nieuw.
-- ------------------------------------------------------------
create or replace function public.reopen_fiscal_year(
  p_organization_id uuid,
  p_fiscal_year_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.fiscal_years
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fy public.fiscal_years;
begin
  if auth.role() <> 'service_role' and not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen een eigenaar of beheerder mag een boekjaar heropenen.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  if v_fy.status <> 'closed' then
    raise exception 'Alleen een afgesloten boekjaar kan worden heropend.' using errcode = '23514';
  end if;

  -- Alleen het meest recent afgesloten jaar mag open: een later afgesloten jaar
  -- bouwt voort op het eindvermogen van dit jaar.
  if exists (
    select 1 from public.fiscal_years f
    where f.organization_id = p_organization_id
      and f.status = 'closed'
      and f.period_start > v_fy.period_start
  ) then
    raise exception 'Heropen eerst de latere afgesloten boekjaren (in omgekeerde volgorde).' using errcode = '23514';
  end if;

  -- Nieuw: een geldige resultaatbestemming steunt op het resultaat dat de
  -- afsluiting op 0510 zette. Dat resultaat verdwijnt hier, dus de bestemming
  -- moet eerst weg.
  if exists (
    select 1 from public.result_appropriations ra
    where ra.fiscal_year_id = p_fiscal_year_id and ra.status = 'posted'
  ) then
    raise exception 'Draai eerst de resultaatbestemming van dit boekjaar terug; die boekt vanaf dezelfde resultaatrekening.'
      using errcode = '23514';
  end if;

  -- Hef de jaar-lock op (anders blijft de balans van dit jaar vergrendeld).
  delete from public.closed_periods
  where organization_id = p_organization_id
    and period_type = 'year'
    and period_start = v_fy.period_start
    and period_end = v_fy.period_end;

  -- Void het afsluitboekstuk (blijft bewaard als 'reversed' voor audit).
  if v_fy.close_journal_entry_id is not null then
    update public.journal_entries
    set status = 'reversed'
    where id = v_fy.close_journal_entry_id
      and organization_id = p_organization_id
      and status = 'posted';
  end if;

  update public.fiscal_years
  set status = 'open', close_journal_entry_id = null,
      result_account_code = null, result_cents = null,
      reopened_at = now(), reopened_by = p_created_by
  where id = p_fiscal_year_id
  returning * into v_fy;

  return v_fy;
end;
$$;

-- ------------------------------------------------------------
-- 8. reverse_journal_entry: een resultaatbestemming niet los tegenboeken
--    Het boekstuk staat gewoon in het journaal met een knop "Tegenboeken".
--    Wie die gebruikt, laat de rij in result_appropriations op 'posted' staan:
--    het boekjaar blijft dan geblokkeerd voor heropenen, terwijl de nette weg
--    ("Bestemming terugdraaien") daarna niets meer kan. Dezelfde behandeling
--    als het jaarafsluitboekstuk dus — verwijzen naar de knop die het wél goed
--    doet. De functie is LETTERLIJK overgenomen uit 20260723200000; alleen deze
--    guard is toegevoegd.
-- ------------------------------------------------------------

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
