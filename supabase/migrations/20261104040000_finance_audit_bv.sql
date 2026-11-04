-- ============================================================
-- ResoFly — Controle financiën en BV (4 november 2026), deel 5: de BV
--
-- Uit de controle van 4 november (CHANGELOG_FINANCIEN_BV_CONTROLE_2026-11-04.md).
--
--   1. Grootteklasse (art. 2:395a/396/397 lid 1 BW): de overgangsregel sprong
--      naar de rauwe klasse van dit jaar zodra twee jaren van de vorige klasse
--      afweken. Maar de klassen zijn genest (wie klein is, voldoet ook aan de
--      criteria voor middelgroot) en de toets loopt per klasse. Zo werd
--      middelgroot, middelgroot, groot, klein "klein" (geen controleplicht),
--      terwijl de wet middelgroot geeft (wel controleplicht, art. 2:393 BW).
--      Nu de regel per klasse; testvector 1 klopte zelf ook niet.
--   2. Balanstotaal voor de groottetoets: een creditsaldo op een activarekening
--      (rekening-courant DGA die de BV schuldig is, roodstand) verlaagde het
--      totaal in plaats van als schuld mee te tellen.
--   3. Uitkeringstoets (art. 2:216 lid 1 BW): het resultaat van het lopende jaar
--      telde niet mee (een interim-dividend kon een verlies negeren), de
--      winstbestemming toetste op de balansdatum in plaats van op de
--      besluitdatum, en een teruggedateerd besluit zag latere uitkeringen niet.
--      Nu: eigen vermogen inclusief lopend resultaat, op de besluitdatum én
--      op vandaag, het laagste telt.
--   4. Dividend aan iemand zonder aandelen op de besluitdatum kan niet meer.
--   5. Winstbestemming en dividend: de vriendelijke controle op afgesloten
--      perioden keek ook naar btw-sloten en dwong zo een onjuiste besluitdatum
--      af (zie deel 1: een btw-slot houdt deze boekingen niet meer tegen).
--   6. Vpb: bij een gebroken boekjaar stond het verlies onder het eindjaar en
--      bood de volgende berekening het niet aan (te hoge belasting). Het jaar
--      volgt nu overal het aanvangsjaar. Een tariefwijziging tijdens het
--      boekjaar (2021 → 2022) werd niet herkend. En de opgeslagen berekening
--      wordt nu nagerekend tegen het grootboek, de correcties en de
--      verliesadministratie, in plaats van aangenomen.
--   7. Jaarrekening NV: het vrij uitkeerbaar vermogen telde het gestorte
--      kapitaal mee (art. 2:105 lid 2 BW).
--   8. Rente rekening-courant DGA: niet meer boeken voor een jaar dat nog
--      loopt, en niet tegelijk met het afsluiten van het boekjaar.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- company_size_rank(text) bestaat al (micro 1 … groot 4) en wordt hieronder gebruikt.

-- ── 3. Uitkeringstoets: eigen vermogen inclusief lopend resultaat ──────────
CREATE OR REPLACE FUNCTION public.org_distributable_equity(p_organization_id uuid, p_as_of date, p_lock_share_capital boolean DEFAULT false)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- GEWIJZIGD (20261104040000): ook het resultaat dat nog niet naar het eigen
    -- vermogen is overgeboekt (lopend en niet-afgesloten jaar) hoort bij het
    -- eigen vermogen. Een afgesloten jaar telt per saldo nul op de resultaat-
    -- rekeningen (de jaarafsluiting zet het op 0510), dus dubbel telt niets.
    and la.type in ('equity', 'revenue', 'expense');

  return v_total;
end;
$function$;
revoke all on function public.org_distributable_equity(uuid, date, boolean) from public, anon;
grant execute on function public.org_distributable_equity(uuid, date, boolean) to authenticated, service_role;

-- ── 3/5. Winstbestemming: toets op de besluitdatum, alleen het boekjaarslot ─
CREATE OR REPLACE FUNCTION public.appropriate_result(p_organization_id uuid, p_fiscal_year_id uuid, p_decision_date date, p_reserves_cents bigint, p_dividend_cents bigint DEFAULT 0, p_board_approved boolean DEFAULT false, p_reserves_account_code text DEFAULT '0520'::text, p_dividend_account_code text DEFAULT '1580'::text, p_note text DEFAULT NULL::text, p_created_by uuid DEFAULT auth.uid())
 RETURNS result_appropriations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
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
  -- GEWIJZIGD (20261104040000): alleen het boekjaarslot telt. Een btw-slot
  -- raakt deze boeking niet, en dwong anders een onjuiste besluitdatum af.
  select cp.period_start, cp.period_end into v_closed
  from public.closed_periods cp
  where cp.organization_id = p_organization_id
    and cp.period_type = 'year'
    and p_decision_date <= cp.period_end
  order by cp.period_end desc
  limit 1;
  if found then
    raise exception 'Het boekjaar tot en met % is afgesloten; kies een besluitdatum daarna.',
      to_char(v_closed.period_end, 'DD-MM-YYYY')
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
  -- GEWIJZIGD (20261104040000): getoetst op de besluitdatum (niet op de
  -- balansdatum: tussentijdse uitkeringen sindsdien tellen mee) én op vandaag
  -- (een teruggedateerd besluit ziet anders latere uitkeringen niet). Het
  -- laagste bedrag telt.
  v_distributable := least(
    public.org_distributable_equity(p_organization_id, p_decision_date, v_legal_form = 'nv'),
    public.org_distributable_equity(p_organization_id, greatest(p_decision_date, current_date), v_legal_form = 'nv')
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
$function$;
revoke all on function public.appropriate_result(uuid, uuid, date, bigint, bigint, boolean, text, text, text, uuid) from public, anon;
grant execute on function public.appropriate_result(uuid, uuid, date, bigint, bigint, boolean, text, text, text, uuid) to authenticated, service_role;

-- ── 3/4/5. Dividend: toets ook op vandaag, alleen aan aandeelhouders ───────
CREATE OR REPLACE FUNCTION public.declare_dividend(p_organization_id uuid, p_kind text, p_decision_date date, p_available_date date, p_lines jsonb, p_result_appropriation_id uuid DEFAULT NULL::uuid, p_board_approved boolean DEFAULT false, p_source_account_code text DEFAULT '0520'::text, p_note text DEFAULT NULL::text, p_created_by uuid DEFAULT auth.uid())
 RETURNS dividend_distributions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.dividend_distributions;
  v_appropriation public.result_appropriations;
  v_kind text := coalesce(nullif(btrim(p_kind), ''), 'interim');
  v_rate integer;
  v_gross bigint := 0;
  v_tax bigint := 0;
  v_line jsonb;
  v_shareholder uuid;
  v_line_gross bigint;
  v_line_tax bigint;
  v_exempt boolean;
  v_exempt_note text;
  v_shares bigint;
  v_seen uuid[] := array[]::uuid[];
  v_distributable bigint;
  v_legal_form text;
  v_source_code text := coalesce(nullif(btrim(p_source_account_code), ''), '0520');
  v_source_account uuid;
  v_payable_account uuid;
  v_tax_account uuid;
  v_account_type text;
  v_restricted boolean;
  v_subtype text;
  -- Bewust losse uuid's en geen rowtype-variabelen: bij een dividend uit de
  -- vastgestelde winst valt boekstuk A weg en bij een volledig vrijgestelde
  -- uitkering boekstuk B, en dan moet het veld gewoon leeg blijven.
  v_declaration_entry uuid;
  v_withholding_entry uuid;
  v_board boolean := coalesce(p_board_approved, false);
  v_closed record;
  v_prepared jsonb := '[]'::jsonb;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  -- De winstbestemming moet van deze organisatie zijn, ook bij een interim-
  -- dividend: anders kon een lid van organisatie A een dividend aan B's
  -- winstbestemming hangen en daarmee B's terugdraaien en slotdividend blokkeren.
  if p_result_appropriation_id is not null and not exists (
    select 1 from public.result_appropriations ra
    where ra.id = p_result_appropriation_id and ra.organization_id = p_organization_id
  ) then
    raise exception 'Deze winstbestemming hoort niet bij deze organisatie.' using errcode = '42501';
  end if;

  -- Zelfde slot als het afsluiten en de resultaatbestemming: die verplaatsen
  -- hetzelfde eigen vermogen en dezelfde schuld op 1580.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));

  if not public.org_has_business(p_organization_id) then
    raise exception 'Dividend hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if not public.org_is_corporate(p_organization_id) then
    raise exception 'Dividend op aandelen hoort bij een BV of NV. Bij deze rechtsvorm speelt het niet.'
      using errcode = '23514';
  end if;

  if v_kind not in ('final', 'interim') then
    raise exception 'Onbekende soort uitkering: %.', v_kind using errcode = '23514';
  end if;
  if p_decision_date is null or p_available_date is null then
    raise exception 'Zowel de besluitdatum als de datum van terbeschikkingstelling is verplicht.' using errcode = '23514';
  end if;
  if p_available_date < p_decision_date then
    raise exception 'Het dividend kan niet ter beschikking zijn gesteld vóór het besluit.' using errcode = '23514';
  end if;

  v_rate := public.dividend_tax_rate_on(p_available_date);
  if v_rate is null then
    raise exception 'Voor % is geen tarief dividendbelasting vastgelegd.', to_char(p_available_date, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  -- ---- De verdeling over de aandeelhouders --------------------------------
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Een dividendbesluit heeft minstens één aandeelhouder nodig.' using errcode = '23514';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_shareholder := nullif(v_line->>'shareholder_id', '')::uuid;
    v_line_gross := coalesce((v_line->>'gross_cents')::bigint, 0);

    if v_shareholder is null then
      raise exception 'Elke regel moet een aandeelhouder noemen.' using errcode = '23514';
    end if;
    if v_line_gross < 0 then
      raise exception 'Een dividendbedrag kan niet negatief zijn.' using errcode = '23514';
    end if;
    if v_shareholder = any (v_seen) then
      raise exception 'Dezelfde aandeelhouder staat twee keer in het besluit.' using errcode = '23505';
    end if;
    v_seen := v_seen || v_shareholder;

    select sh.withholding_exempt, sh.withholding_exempt_note
    into v_exempt, v_exempt_note
    from public.shareholders sh
    where sh.id = v_shareholder and sh.organization_id = p_organization_id;
    if not found then
      raise exception 'Aandeelhouder niet gevonden in deze administratie.' using errcode = '02000';
    end if;

    -- Aantal aandelen op de besluitdatum, alleen als onderbouwing van de
    -- verdeling. Het bedrag komt van de aanroeper: de statuten kunnen
    -- soorten aandelen kennen die niet gelijk delen, en dan is pro rata fout.
    select coalesce(sum(p.shares), 0) into v_shares
    from public.shareholder_positions(p_organization_id, p_decision_date) p
    where p.shareholder_id = v_shareholder;
    -- TOEGEVOEGD (20261104040000): dividend gaat naar wie op de besluitdatum
    -- aandelen heeft.
    if v_line_gross > 0 and v_shares <= 0 then
      raise exception 'Aandeelhouder heeft op % geen aandelen volgens het register; aan hem kan geen dividend worden uitgekeerd.',
        to_char(p_decision_date, 'DD-MM-YYYY') using errcode = '23514';
    end if;

    -- Vrijgesteld = niets inhouden (art. 4 Wet DB 1965). Anders het tarief over
    -- het bruto bedrag, per aandeelhouder afgerond — zo telt de som van de
    -- regels altijd op tot het totaal van de uitkering.
    v_line_tax := case when v_exempt then 0
                       else round(v_line_gross::numeric * v_rate / 10000)::bigint end;

    v_gross := v_gross + v_line_gross;
    v_tax := v_tax + v_line_tax;

    v_prepared := v_prepared || jsonb_build_array(jsonb_build_object(
      'shareholder_id', v_shareholder,
      'shares', v_shares,
      'gross_cents', v_line_gross,
      'withholding_exempt', v_exempt,
      'exempt_note', case when v_exempt then v_exempt_note end,
      'tax_cents', v_line_tax,
      'net_cents', v_line_gross - v_line_tax
    ));
  end loop;

  if v_gross <= 0 then
    raise exception 'Er valt niets uit te keren: het totaal is nul.' using errcode = '23514';
  end if;

  -- ---- Waar komt het vandaan? ---------------------------------------------
  v_legal_form := public.org_legal_form(p_organization_id);

  if v_kind = 'final' then
    if p_result_appropriation_id is null then
      raise exception 'Een dividend uit de vastgestelde winst hoort bij een besluit van de algemene vergadering.'
        using errcode = '23514';
    end if;

    select * into v_appropriation from public.result_appropriations
    where id = p_result_appropriation_id and organization_id = p_organization_id for update;
    if not found then
      raise exception 'Resultaatbestemming niet gevonden.' using errcode = '02000';
    end if;
    if v_appropriation.status <> 'posted' then
      raise exception 'Die resultaatbestemming is teruggedraaid.' using errcode = '23514';
    end if;
    if v_appropriation.dividend_cents <= 0 then
      raise exception 'Dat besluit kende geen dividend toe.' using errcode = '23514';
    end if;
    if v_gross <> v_appropriation.dividend_cents then
      raise exception 'De verdeling moet precies het toegekende dividend van % cent bedragen, nu % cent.',
        v_appropriation.dividend_cents, v_gross using errcode = '23514';
    end if;
    if exists (
      select 1 from public.dividend_distributions d
      where d.result_appropriation_id = p_result_appropriation_id and d.organization_id = p_organization_id and d.status = 'posted'
    ) then
      raise exception 'Dit dividend is al uitgekeerd. Draai die uitkering eerst terug.' using errcode = '23505';
    end if;
    if p_decision_date < v_appropriation.decision_date then
      raise exception 'De uitkering kan niet vóór het besluit van % liggen.',
        to_char(v_appropriation.decision_date, 'DD-MM-YYYY') using errcode = '23514';
    end if;

    -- De balanstest en de bestuursgoedkeuring zijn bij dát besluit al gedaan;
    -- opnieuw toetsen zou onzin opleveren, want het bruto bedrag staat al niet
    -- meer in het eigen vermogen maar op 1580.
    v_distributable := v_appropriation.distributable_cents;
    v_board := v_appropriation.board_approved;
    v_source_code := null;
  else
    -- ---- Interim: hier gelden beide toetsen van art. 2:216 BW wél ----------
    -- Lid 1 spreekt van "vaststelling van uitkeringen" en dekt daarmee ook de
    -- tussentijdse. Peildatum is de besluitdatum: dat is het moment waarop het
    -- bestuur en de vergadering naar het vermogen kijken.
    -- GEWIJZIGD (20261104040000): ook op vandaag, zodat een teruggedateerd
    -- besluit latere uitkeringen en verliezen ziet; het laagste telt.
    v_distributable := least(
      public.org_distributable_equity(p_organization_id, p_decision_date, v_legal_form = 'nv'),
      public.org_distributable_equity(p_organization_id, greatest(p_decision_date, current_date), v_legal_form = 'nv')
    );

    if v_gross > v_distributable then
      if v_legal_form = 'nv' then
        raise exception 'Balanstest (art. 2:105 lid 2 BW): vrij uitkeerbaar is op % nog % cent — het eigen vermogen boven het gestorte kapitaal en de wettelijke en statutaire reserves. Het besluit keert % cent uit.',
          to_char(p_decision_date, 'DD-MM-YYYY'), v_distributable, v_gross using errcode = '23514';
      else
        raise exception 'Balanstest (art. 2:216 lid 1 BW): vrij uitkeerbaar is op % nog % cent — het eigen vermogen boven de wettelijke en statutaire reserves. Het besluit keert % cent uit.',
          to_char(p_decision_date, 'DD-MM-YYYY'), v_distributable, v_gross using errcode = '23514';
      end if;
    end if;

    if not v_board then
      raise exception 'Uitkeringstest (art. 2:216 lid 2 BW): het bestuur moet bevestigen dat de vennootschap haar opeisbare schulden ook ná deze uitkering kan blijven betalen. Zonder die goedkeuring heeft het besluit geen gevolgen.'
        using errcode = '23514';
    end if;
  end if;

  -- ---- Periodesloten, vriendelijk gemeld ----------------------------------
  -- post_journal_entry weigert straks alsnog, maar met een generieke melding.
  -- Een dividend raakt geen btw-rubriek, dus hier is geen vrijstelling nodig
  -- zoals bij de jaarafsluiting: de datum ligt gewoon in een open periode of de
  -- gebruiker kiest een andere.
  -- GEWIJZIGD (20261104040000): alleen het boekjaarslot telt; een btw-slot
  -- raakt deze boekingen niet en dwong anders onjuiste data af.
  select cp.period_start, cp.period_end into v_closed
  from public.closed_periods cp
  where cp.organization_id = p_organization_id
    and cp.period_type = 'year'
    and (
      (v_kind = 'interim' and p_decision_date <= cp.period_end)
      or (v_tax > 0 and p_available_date <= cp.period_end)
    )
  order by cp.period_end desc
  limit 1;
  if found then
    raise exception 'Het boekjaar tot en met % is afgesloten; kies data daarna.',
      to_char(v_closed.period_end, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  -- ---- Boeken --------------------------------------------------------------
  perform public.ensure_default_ledger_accounts(p_organization_id);

  v_payable_account := public.bookkeeping_account_id(p_organization_id, '1580');
  select la.type into v_account_type from public.ledger_accounts la where la.id = v_payable_account;
  if v_account_type <> 'liability' then
    raise exception 'Rekening 1580 is geen schuldrekening; een dividendbesluit levert een schuld aan de aandeelhouder op.'
      using errcode = '23514';
  end if;

  if v_kind = 'interim' then
    v_source_account := public.bookkeeping_account_id(p_organization_id, v_source_code);
    select la.type, la.is_restricted_reserve, la.subtype
    into v_account_type, v_restricted, v_subtype
    from public.ledger_accounts la where la.id = v_source_account;

    if v_account_type <> 'equity' then
      raise exception 'Rekening % is geen eigen-vermogensrekening; een tussentijdse uitkering gaat ten laste van de reserves.', v_source_code
        using errcode = '23514';
    end if;
    -- Een wettelijke of statutaire reserve is nu juist het deel dat NIET
    -- uitgekeerd mag worden; daar een dividend uit boeken zou de balanstest
    -- via de achterdeur omzeilen.
    if coalesce(v_restricted, false) or coalesce(v_subtype, '') in ('legal_reserve', 'statutory_reserve') then
      raise exception 'Rekening % is een wettelijke of statutaire reserve; die moet worden aangehouden en kan niet worden uitgekeerd (art. 2:216 lid 1 BW).', v_source_code
        using errcode = '23514';
    end if;

    v_declaration_entry := (public.post_journal_entry(
      p_organization_id, p_decision_date,
      'Interim-dividend ' || to_char(p_decision_date, 'DD-MM-YYYY'),
      'dividend', null,
      jsonb_build_array(
        jsonb_build_object('account_id', v_source_account,
          'description', 'Tussentijdse uitkering ten laste van de reserves',
          'debit_cents', v_gross, 'credit_cents', 0),
        jsonb_build_object('account_id', v_payable_account,
          'description', 'Te betalen dividend',
          'debit_cents', 0, 'credit_cents', v_gross)
      ), p_created_by)).id;
  end if;

  if v_tax > 0 then
    v_tax_account := public.bookkeeping_account_id(p_organization_id, '1560');
    select la.type into v_account_type from public.ledger_accounts la where la.id = v_tax_account;
    if v_account_type <> 'liability' then
      raise exception 'Rekening 1560 is geen schuldrekening; ingehouden dividendbelasting is een schuld aan de Belastingdienst.'
        using errcode = '23514';
    end if;

    -- Inhouden verplaatst een deel van de schuld aan de aandeelhouder naar een
    -- schuld aan de Belastingdienst. Het eigen vermogen verandert hier niet
    -- meer: dat gebeurde bij het besluit.
    v_withholding_entry := (public.post_journal_entry(
      p_organization_id, p_available_date,
      'Dividendbelasting ' || to_char(p_available_date, 'DD-MM-YYYY'),
      'dividend', null,
      jsonb_build_array(
        jsonb_build_object('account_id', v_payable_account,
          'description', 'Ingehouden dividendbelasting',
          'debit_cents', v_tax, 'credit_cents', 0),
        jsonb_build_object('account_id', v_tax_account,
          'description', 'Af te dragen dividendbelasting',
          'debit_cents', 0, 'credit_cents', v_tax)
      ), p_created_by)).id;
  end if;

  -- ---- Vastleggen ----------------------------------------------------------
  insert into public.dividend_distributions(
    organization_id, created_by, kind, result_appropriation_id,
    decision_date, available_date,
    gross_cents, tax_cents, net_cents, tax_rate_basis_points,
    source_account_code, payable_account_code, tax_account_code,
    distributable_cents, board_approved, board_approved_by, board_approved_at,
    declaration_entry_id, withholding_entry_id, status, note
  ) values (
    p_organization_id, p_created_by, v_kind, p_result_appropriation_id,
    p_decision_date, p_available_date,
    v_gross, v_tax, v_gross - v_tax, v_rate,
    v_source_code, '1580', '1560',
    v_distributable, v_board,
    case when v_board then p_created_by end,
    case when v_board then now() end,
    v_declaration_entry, v_withholding_entry,
    'posted', nullif(btrim(p_note), '')
  )
  returning * into v_row;

  insert into public.dividend_distribution_lines(
    organization_id, distribution_id, shareholder_id, shares,
    gross_cents, withholding_exempt, exempt_note, tax_cents, net_cents
  )
  select
    p_organization_id, v_row.id,
    (l->>'shareholder_id')::uuid,
    (l->>'shares')::bigint,
    (l->>'gross_cents')::bigint,
    (l->>'withholding_exempt')::boolean,
    nullif(l->>'exempt_note', ''),
    (l->>'tax_cents')::bigint,
    (l->>'net_cents')::bigint
  from jsonb_array_elements(v_prepared) l;

  return v_row;
end;
$function$;
revoke all on function public.declare_dividend(uuid, text, date, date, jsonb, uuid, boolean, text, text, uuid) from public, anon;
grant execute on function public.declare_dividend(uuid, text, date, date, jsonb, uuid, boolean, text, text, uuid) to authenticated, service_role;

-- ── 1/2. Grootteklasse: regel per klasse, bruto balanstotaal ───────────────
CREATE OR REPLACE FUNCTION public.determine_company_size(p_organization_id uuid, p_fiscal_year_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_fy public.fiscal_years;
  v_in public.fiscal_year_size_inputs;
  v_has_in boolean := false;
  v_row public.fiscal_year_size_inputs;
  r record;

  v_year integer;
  v_lookup_year integer;

  v_index integer := 0;
  v_chain_broken boolean := false;
  v_first_confirmed boolean := false;

  -- Het boekjaar dat op dít moment in de lus wordt behandeld; na de lus is dat
  -- per definitie het gevraagde boekjaar.
  v_cur_fy_id uuid;
  v_cur_label text;
  v_cur_year integer;
  v_cur_start date;
  v_cur_end date;
  v_cur_days integer;
  v_cur_assets bigint;
  v_cur_turnover bigint;
  v_cur_employees numeric;
  v_cur_src_assets text;
  v_cur_src_turnover text;
  v_cur_src_employees text;
  v_cur_has_in boolean := false;
  v_cur_early boolean := false;
  v_cur_override_reason text;
  v_cur_eval jsonb;
  v_cur_raw text;
  v_cur_class text;
  v_cur_carried jsonb := null;
  -- De drempelreeks die BIJ DIT BOEKJAAR hoort (aanvangsjaar, met early-adopt).
  v_cur_lookup_year integer;
  -- De rauwe klasse van het VORIGE boekjaar, opnieuw getoetst aan de reeks van
  -- dit boekjaar. De tweejaarstoets van lid 1 kent geen gemengde maatstaf.
  v_prev_raw_at_cur text;
  -- Sluit dit boekjaar aan op het vorige? Zit er een gat, dan zijn het geen
  -- "twee opeenvolgende balansdata" en begint de keten opnieuw.
  v_cur_gap boolean := false;
  -- Door de gebruiker vastgelegde klasse op de balansdatum vóór dit boekjaar.
  v_cur_opening text;

  -- Het boekjaar dat er direct aan voorafging (doorgeschoven aan het begin van
  -- elke ronde); na de lus het vergelijkende boekjaar.
  v_prev_fy_id uuid;
  v_prev_label text;
  v_prev_year integer;
  v_prev_end date;
  v_prev_days integer;
  v_prev_assets bigint;
  v_prev_turnover bigint;
  v_prev_employees numeric;
  v_prev_src_assets text;
  v_prev_src_turnover text;
  v_prev_src_employees text;
  v_prev_eval jsonb;
  v_prev_raw text;
  v_prev_class text;
  v_prev_early boolean := false;

  -- Het boekjaar waarin de uiteindelijke klasse is ontstaan (dus waar de rauwe
  -- klasse zich voor het tweede jaar herhaalde, of de keten begon). Daar hoort
  -- de drempelrij bij die de uitkomst verantwoordt.
  v_source_eval jsonb := null;
  v_source_year integer := null;
  v_source_label text := null;

  v_chain jsonb := '[]'::jsonb;
  v_tested_years jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_blocking text := null;
  v_thresholds jsonb := null;
  v_in_group boolean := false;
  v_has_prev boolean := false;
  v_first_year boolean := false;
  v_prev_unknown boolean := false;
  v_class text := null;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if not public.org_has_business(p_organization_id) then
    raise exception 'De groottebepaling hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'De groottecriteria van art. 2:395a, 2:396 en 2:397 BW gelden voor een BV, NV of coöperatie. Pas eerst de rechtsvorm aan bij Instellingen → Bedrijfsgegevens.'
      using errcode = '23514';
  end if;

  select * into v_fy from public.fiscal_years fy
  where fy.id = p_fiscal_year_id and fy.organization_id = p_organization_id;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;

  select * into v_in from public.fiscal_year_size_inputs si
  where si.organization_id = p_organization_id and si.fiscal_year_id = v_fy.id;
  v_has_in := found;

  -- De drempelreeks knoopt aan bij de AANVANG van het boekjaar (art. III lid 2
  -- Stb. 2015, 349 en art. 4 Stb. 2024, 52), niet bij de balansdatum. Dit is de
  -- reeks van het GEVRAAGDE boekjaar; elk boekjaar in de keten bepaalt verderop
  -- zijn eigen reeks, en alleen het paar dat de wissel bepaalt gaat door één en
  -- dezelfde reeks — zie kernbeslissing E in de kop. Deze waarde dient hier dus
  -- alleen nog voor de verantwoording in de uitkomst.
  v_year := extract(year from v_fy.period_start)::int;
  v_lookup_year := case
    when coalesce(v_has_in and v_in.early_adopt_new_thresholds, false) and v_year = 2023 then 2024
    else v_year
  end;

  -- Maakt deze administratie deel uit van een groep? Dan geldt de meetelregel
  -- van art. 2:395a lid 2 / 2:396 lid 2 / 2:397 lid 2 BW en telt ResoFly de
  -- boom niet op — dat mag geen generieke voetnoot blijven.
  select (o.parent_organization_id is not null)
         or exists (select 1 from public.organizations c where c.parent_organization_id = o.id)
    into v_in_group
  from public.organizations o
  where o.id = p_organization_id;
  v_in_group := coalesce(v_in_group, false);

  -- ── De keten ────────────────────────────────────────────────────────────
  -- Chronologisch over alle boekjaren t/m het gevraagde jaar. De sticky regel
  -- heeft de EFFECTIEVE klasse van het vorige jaar nodig, en die heeft op haar
  -- beurt het jaar daarvóór nodig; er is geen kortere weg. Per boekjaar kost dat
  -- één doorloop van report_balance_sheet en één van report_profit_and_loss,
  -- tenzij de gebruiker beide heeft overschreven.
  -- Begrensd op twaalf boekjaren terug. Verder terug voegt niets toe — de
  -- klasse van 2011 zegt niets meer over vandaag — en het scheelt evenveel
  -- rapportdoorlopen. Valt het startpunt van de keten daardoor buiten beeld, dan
  -- vraagt de functie om een opening_size_class; ze gokt niet.
  for r in
    select fy.*
    from public.fiscal_years fy
    where fy.organization_id = p_organization_id
      and fy.period_start <= v_fy.period_start
      and fy.period_end <= v_fy.period_end
      and fy.period_start > (v_fy.period_start - interval '12 years')
    order by fy.period_start asc, fy.period_end asc
  loop
    v_index := v_index + 1;

    -- Schuif het vorige jaar door voordat we de huidige velden overschrijven.
    if v_index > 1 then
      v_prev_fy_id        := v_cur_fy_id;
      v_prev_label        := v_cur_label;
      v_prev_year         := v_cur_year;
      v_prev_end          := v_cur_end;
      v_prev_days         := v_cur_days;
      v_prev_assets       := v_cur_assets;
      v_prev_turnover     := v_cur_turnover;
      v_prev_employees    := v_cur_employees;
      v_prev_src_assets   := v_cur_src_assets;
      v_prev_src_turnover := v_cur_src_turnover;
      v_prev_src_employees:= v_cur_src_employees;
      v_prev_eval         := v_cur_eval;
      v_prev_raw          := v_cur_raw;
      v_prev_class        := v_cur_class;
      v_prev_early        := v_cur_early;
    end if;

    select * into v_row from public.fiscal_year_size_inputs si
    where si.organization_id = p_organization_id and si.fiscal_year_id = r.id;
    v_cur_has_in := found;

    v_cur_fy_id          := r.id;
    v_cur_label          := r.label;
    v_cur_year           := extract(year from r.period_start)::int;
    v_cur_start          := r.period_start;
    v_cur_end            := r.period_end;
    v_cur_days           := (r.period_end - r.period_start) + 1;
    v_cur_early          := coalesce(v_cur_has_in and v_row.early_adopt_new_thresholds, false);
    v_cur_override_reason:= case when v_cur_has_in then v_row.override_reason else null end;
    v_cur_employees      := case when v_cur_has_in then v_row.average_employees else null end;
    v_cur_src_employees  := case when v_cur_has_in then 'input' else null end;
    v_cur_opening        := case when v_cur_has_in then v_row.opening_size_class else null end;
    v_cur_carried        := null;

    if v_cur_has_in and v_row.total_assets_cents is not null then
      v_cur_assets := v_row.total_assets_cents;
      v_cur_src_assets := 'override';
    else
      -- GEWIJZIGD (20261104040000): de waarde der activa op bruto basis. Een
      -- activarekening met een creditsaldo (rekening-courant DGA die de BV
      -- schuldig is, roodstand) is een schuld en geen negatief activum; een
      -- schuldrekening met een debetsaldo is een vordering.
      select coalesce(sum(case
               when rb.section = 'asset' then greatest(rb.amount_cents, 0)
               when rb.section = 'liability' then greatest(-rb.amount_cents, 0)
               else 0 end), 0)::bigint into v_cur_assets
      from public.report_balance_sheet(p_organization_id, r.period_end) rb;
      v_cur_src_assets := 'derived';
    end if;

    if v_cur_has_in and v_row.net_turnover_cents is not null then
      v_cur_turnover := v_row.net_turnover_cents;
      v_cur_src_turnover := 'override';
    else
      select coalesce(sum(pl.amount_cents), 0)::bigint into v_cur_turnover
      from public.report_profit_and_loss(p_organization_id, r.period_start, r.period_end) pl
      where pl.report_group = 'netto_omzet';
      v_cur_src_turnover := 'derived';

      -- Nul afgeleide omzet terwijl er wél opbrengst is geboekt betekent bijna
      -- altijd dat de omzetrekeningen niet in de rubriek netto_omzet staan. Stil
      -- nul teruggeven zou het omzetcriterium gratis laten slagen en de klasse
      -- te licht maken; daarom hier een expliciet signaal.
      if v_cur_turnover = 0 and r.id = v_fy.id then
        if exists (
          select 1 from public.report_profit_and_loss(p_organization_id, r.period_start, r.period_end) pl2
          where pl2.account_type = 'revenue' and pl2.amount_cents <> 0
        ) then
          v_warnings := v_warnings || to_jsonb(array[
            'Er is wél omzet geboekt, maar geen enkele rekening valt in de rubriek "netto_omzet"; het omzetcriterium van art. 2:395a/396/397 lid 1 onder b BW is daardoor op nul uitgekomen. Controleer de rubriekindeling van het rekeningschema, of leg de netto-omzet handmatig vast bij de groottegegevens van dit boekjaar.']);
        end if;
      end if;
    end if;

    if v_index = 1 then
      v_first_confirmed := coalesce(v_cur_has_in and v_row.is_first_fiscal_year_of_entity, false);
    end if;

    -- ── De drempelreeks van DIT boekjaar ──────────────────────────────────
    -- Elk boekjaar wordt getoetst aan de reeks die vóór dat boekjaar geldt; de
    -- reeks knoopt aan bij de AANVANG van het boekjaar (art. III lid 2 Stb.
    -- 2015, 349 en art. 4 Stb. 2024, 52). Boekjaar 2018 gaat dus niet door de
    -- bedragen van 2026 — een eerdere ronde legde de reeks van het gevraagde
    -- jaar over de hele historie en dat is onjuist.
    --
    -- Voor het PAAR dat de klassewissel bepaalt gaan beide balansdata wél door
    -- dezelfde reeks, namelijk die van het jongste jaar van het paar: de
    -- tweejaarstoets van lid 1 kent geen gemengde maatstaf. Daarom wordt het
    -- vorige boekjaar hier een tweede keer getoetst, nu onder de reeks van dit
    -- jaar. Dat kost géén extra rapportaanroep — de bedragen van vorig jaar
    -- staan al in de variabelen; alleen de drempelvergelijking wordt herhaald.
    v_cur_lookup_year := case
      when v_cur_early and v_cur_year = 2023 then 2024
      else v_cur_year
    end;

    v_cur_eval := public.company_size_evaluate_year(
      v_cur_lookup_year, v_cur_assets, v_cur_turnover, v_cur_employees, false
    );
    v_cur_raw := nullif(v_cur_eval ->> 'class', '');

    if v_index > 1 then
      v_prev_raw_at_cur := nullif(public.company_size_evaluate_year(
        v_cur_lookup_year, v_prev_assets, v_prev_turnover, v_prev_employees, false
      ) ->> 'class', '');
    else
      v_prev_raw_at_cur := null;
    end if;

    -- Sluiten de boekjaren op elkaar aan? open_fiscal_year verbiedt overlap maar
    -- niet een gat; zonder deze controle zouden balansdata die jaren uit elkaar
    -- liggen als "opeenvolgend" gelden.
    v_cur_gap := v_index > 1 and v_cur_start <> (v_prev_end + 1);

    -- ── De sticky tweejaarsregel ──────────────────────────────────────────
    if v_chain_broken then
      v_cur_class := null;

    elsif v_cur_raw is null then
      v_chain_broken := true;
      v_cur_class := null;
      if v_blocking is null then
        if coalesce((v_cur_eval ->> 'inputsMissing')::boolean, false) then
          v_blocking := format(
            'Voor boekjaar %s ontbreekt het gemiddeld aantal werknemers (art. 2:396 lid 1 onder c BW; te vermelden op grond van art. 2:382 BW). De toets van art. 2:395a/396/397 lid 1 BW loopt over twee opeenvolgende balansdata en draagt de klasse door; zonder dat getal breekt die keten en is de grootteklasse niet te bepalen. Vul het aan bij dat boekjaar, of leg de klasse handmatig vast met een onderbouwing.',
            coalesce(v_cur_label, v_cur_year::text));
        else
          v_blocking := format(
            'Voor boekjaren die aanvangen in %s zijn geen groottedrempels vastgelegd. De reeksen in ResoFly beginnen bij boekjaar 2016; oudere boekjaren zijn niet geverifieerd en worden bewust niet geraden. Dit raakt boekjaar %s in de keten.',
            v_cur_lookup_year, coalesce(v_cur_label, v_cur_year::text));
        end if;
      end if;

    elsif v_index = 1 or v_cur_gap then
      -- Startpunt van de keten: het oudste boekjaar, of het eerste boekjaar ná
      -- een gat. Een klasse die op één balansdatum rust is alleen verdedigbaar
      -- als dit óók het eerste boekjaar van de rechtspersoon is, of als de
      -- gebruiker zelf heeft vastgelegd welke klasse op de vórige balansdatum
      -- gold. Anders zou lid 1 op één meetpunt worden toegepast.
      if v_cur_gap then
        v_warnings := v_warnings || to_jsonb(array[format(
          'Boekjaar %s sluit niet aan op het voorgaande boekjaar (dat eindigde op %s). De toets van art. 2:395a/396/397 lid 1 BW gaat over twee OPEENVOLGENDE balansdata; door het gat begint de keten hier opnieuw.',
          coalesce(v_cur_label, v_cur_year::text), to_char(v_prev_end, 'DD-MM-YYYY'))]);
      end if;

      if v_cur_opening is not null then
        -- De vastgelegde openingsklasse geldt als de klasse op de balansdatum
        -- vóór dit boekjaar; de plakkerige regel draait daar meteen op door.
        if v_cur_raw = v_cur_opening then
          v_cur_class   := v_cur_raw;
          v_source_eval := v_cur_eval;
          v_source_year := v_cur_year;
          v_source_label:= v_cur_label;
        else
          v_cur_class   := v_cur_opening;
          v_cur_carried := jsonb_build_object(
            'source', 'opening_size_class',
            'class', v_cur_opening,
            'fiscalYearId', v_cur_fy_id,
            'fiscalYearLabel', v_cur_label
          );
        end if;

      elsif v_index = 1 and v_first_confirmed then
        v_cur_class   := v_cur_raw;
        v_source_eval := v_cur_eval;
        v_source_year := v_cur_year;
        v_source_label:= v_cur_label;

      else
        v_chain_broken := true;
        v_cur_class := null;
        if v_blocking is null then
          v_blocking := format(
            'De keten van de groottetoets begint bij boekjaar %s, maar daarvóór is niets bekend. De regimes van art. 2:395a lid 1 / 2:396 lid 1 / 2:397 lid 1 BW gelden pas als op TWEE opeenvolgende balansdata aan de vereisten is voldaan. Kies één van drie: bevestig bij dat boekjaar dat het het eerste boekjaar van de rechtspersoon is, leg vast welke grootteklasse op de vorige balansdatum gold, of voer het voorgaande boekjaar alsnog in.',
            coalesce(v_cur_label, v_cur_year::text));
        end if;
      end if;

    -- ── De plakkerige tweejaarsregel ──────────────────────────────────────
    -- De klasse blijft staan tot de rechtspersoon er TWEE OPEENVOLGENDE
    -- balansdata niet meer in valt; dan springt hij naar de rauwe klasse van
    -- dit boekjaar. Symmetrisch, dus even goed bij groeien als bij krimpen
    -- (art. 2:395a/396/397 lid 1 BW; richtlijn 2013/34/EU art. 3 lid 10).
    --
    -- LET OP — dit is bewust NIET de regel "rauw(k) = rauw(k-1)". Die stond
    -- hier eerder en is fout: bij rauw klein, klein, middelgroot, groot houdt
    -- zij de klasse op klein, terwijl de BV dan al twee opeenvolgende
    -- balansdata boven de kleingrens zit.
    --
    -- GEWIJZIGD (20261104040000): de regel geldt per klasse, en de klassen zijn
    -- genest (wie aan de criteria voor klein voldoet, voldoet ook aan die voor
    -- middelgroot). Een klasse begint na twee opeenvolgende balansdata waarop
    -- aan haar criteria is voldaan en eindigt pas na twee opeenvolgende
    -- balansdata waarop dat niet zo is. Met P de klasse van vorig jaar en r1,
    -- r2 de rauwe klassen van vorig jaar en dit jaar (op dezelfde drempels):
    --   * beide lager dan P  → de hoogste van de twee;
    --   * beide hoger dan P  → de laagste van de twee;
    --   * anders blijft P staan.
    -- De vorige versie sprong naar r2 zodra r1 en r2 allebei van P afweken; zo
    -- werd middelgroot, middelgroot, groot, klein ten onrechte "klein".
    --
    -- Verplichte testvectoren (rauw per boekjaar → effectieve klasse):
    --   1. klein, klein, middelgroot, groot        → klein, klein, klein, MIDDELGROOT
    --   2. middelgroot, klein, klein               → mg, mg, KLEIN
    --   3. klein, middelgroot, klein               → klein, klein, klein
    --   4. middelgroot (enig boekjaar)             → middelgroot
    --   5. klein, mg, mg, klein, klein             → klein, klein, MG, mg, KLEIN
    --   6. groot, groot, klein, middelgroot        → groot, groot, groot, MIDDELGROOT
    --   7. middelgroot, middelgroot, groot, klein  → mg, mg, mg, mg
    --   8. middelgroot, middelgroot, klein, micro  → mg, mg, mg, KLEIN
    --   9. micro, micro, klein, middelgroot        → micro, micro, micro, KLEIN
    elsif v_prev_raw_at_cur is not null
          and (greatest(public.company_size_rank(v_cur_raw), public.company_size_rank(v_prev_raw_at_cur))
                 < public.company_size_rank(v_prev_class)
               or least(public.company_size_rank(v_cur_raw), public.company_size_rank(v_prev_raw_at_cur))
                 > public.company_size_rank(v_prev_class)) then
      if greatest(public.company_size_rank(v_cur_raw), public.company_size_rank(v_prev_raw_at_cur))
           < public.company_size_rank(v_prev_class) then
        v_cur_class := case when public.company_size_rank(v_cur_raw) >= public.company_size_rank(v_prev_raw_at_cur)
                            then v_cur_raw else v_prev_raw_at_cur end;
      else
        v_cur_class := case when public.company_size_rank(v_cur_raw) <= public.company_size_rank(v_prev_raw_at_cur)
                            then v_cur_raw else v_prev_raw_at_cur end;
      end if;
      if v_cur_class = v_cur_raw then
        v_source_eval := v_cur_eval;
        v_source_year := v_cur_year;
        v_source_label:= v_cur_label;
      else
        -- De klasse rust op de rauwe klasse van vorig jaar (op de drempels van dit jaar).
        v_cur_carried := jsonb_build_object(
          'fiscalYearId', v_prev_fy_id,
          'fiscalYearLabel', v_prev_label,
          'year', v_prev_year,
          'class', v_cur_class,
          'rawClass', v_prev_raw,
          'rawClassAtCurrentThresholds', v_prev_raw_at_cur
        );
      end if;

    else
      -- Hooguit één van de twee balansdata valt buiten de geldende klasse: die
      -- beweegt dus niet mee. De effectieve klasse van vorig jaar blijft staan,
      -- en daarmee ook de drempelrij waarop die klasse berust.
      v_cur_class := v_prev_class;
      v_cur_carried := jsonb_build_object(
        'fiscalYearId', v_prev_fy_id,
        'fiscalYearLabel', v_prev_label,
        'year', v_prev_year,
        'class', v_prev_class,
        'rawClass', v_prev_raw,
        'rawClassAtCurrentThresholds', v_prev_raw_at_cur
      );
    end if;

    -- ── Boekjaarlengte ────────────────────────────────────────────────────
    -- Niet normaliseren (kernbeslissing H), wel benoemen. Een echt boekjaar van
    -- twaalf maanden telt 365 of 366 dagen; alles daarbuiten is materieel anders.
    -- Alleen melden voor de twee boekjaren die de klasse bepalen. Een afwijkende
    -- lengte in 2019 zegt niets meer over de jaarrekening die nu wordt opgemaakt
    -- en zou de waarschuwingenlijst vullen met ruis.
    if (v_cur_days < 355 or v_cur_days > 376) and v_cur_fy_id = v_fy.id then
      v_warnings := v_warnings || to_jsonb(array[format(
        'Boekjaar %s telt %s dagen en wijkt daarmee materieel af van twaalf maanden. De omzetgrens van art. 2:395a/396/397 lid 1 onder b BW is een JAARgrens; de netto-omzet over dit boekjaar is hier ongecorrigeerd tegen die jaargrens gelegd. Een kort boekjaar valt daardoor te licht uit, een lang boekjaar te zwaar. ResoFly rekent bewust niet zelf om — de herrekeningsregel is niet geverifieerd. Corrigeer zo nodig met de hand via het balanstotaal en de netto-omzet bij de groottegegevens van dat boekjaar, en leg de reden vast.',
        coalesce(v_cur_label, v_cur_year::text), v_cur_days)]);
    end if;

    v_chain := v_chain || jsonb_build_array(jsonb_build_object(
      'fiscalYearId', v_cur_fy_id,
      'fiscalYearLabel', v_cur_label,
      'year', v_cur_year,
      'periodStart', v_cur_start,
      'periodEnd', v_cur_end,
      'days', v_cur_days,
      'assetsCents', v_cur_assets,
      'turnoverCents', v_cur_turnover,
      'employees', v_cur_employees,
      'assetsSource', v_cur_src_assets,
      'turnoverSource', v_cur_src_turnover,
      'employeesSource', v_cur_src_employees,
      'rawClass', v_cur_raw,
      'effectiveClass', v_cur_class,
      'thresholdLookupYear', v_cur_lookup_year,
      'previousRawAtTheseThresholds', v_prev_raw_at_cur,
      'followsPreviousFiscalYear', not v_cur_gap,
      'carriedForwardFrom', v_cur_carried
    ));
    v_tested_years := v_tested_years || jsonb_build_array(to_jsonb(v_cur_year));
  end loop;

  v_has_prev   := v_index > 1;
  v_first_year := not v_has_prev;
  v_prev_unknown := v_has_prev and v_prev_class is null;
  v_class := v_cur_class;

  -- Het vergelijkingsjaar telt even zwaar mee in de tweejaarstoets, dus een
  -- afwijkende lengte dáár is net zo goed een reden tot voorzichtigheid.
  if v_has_prev and v_prev_days is not null and (v_prev_days < 355 or v_prev_days > 376) then
    v_warnings := v_warnings || to_jsonb(array[format(
      'Het vergelijkende boekjaar %s telt %s dagen en wijkt daarmee materieel af van twaalf maanden. De omzetgrens van art. 2:395a/396/397 lid 1 onder b BW is een jaargrens; de netto-omzet van dat jaar is hier ongecorrigeerd getoetst en weegt wél mee in de tweejaarstoets. Corrigeer zo nodig met de hand bij de groottegegevens van dat boekjaar.',
      coalesce(v_prev_label, v_prev_year::text), v_prev_days)]);
  end if;

  -- Vangnet: een klasse die om een niet voorziene reden leeg bleef mag nooit
  -- stilzwijgend als "geen bijzonderheden" doorgaan.
  if v_class is null and v_blocking is null then
    v_blocking := 'De grootteklasse kon niet worden bepaald. Controleer de groottegegevens van dit en de voorgaande boekjaren, of leg de klasse handmatig vast met een onderbouwing.';
  end if;
  if v_blocking is not null then
    v_class := null;
  end if;

  -- ── Vaste waarschuwingen; deze uitkomst is een hulpmiddel ───────────────
  v_warnings := v_warnings || to_jsonb(array[
    'De grootteklasse is per administratie bepaald. De cijfers van groepsmaatschappijen die in een consolidatie zouden moeten worden betrokken tellen mee op grond van art. 2:395a lid 2 / 2:396 lid 2 / 2:397 lid 2 BW, tenzij de rechtspersoon art. 2:408 BW toepast; ResoFly telt de administratie-boom niet op.',
    'Het balanstotaal is afgeleid uit het grootboek en dus op boekwaarde; art. 2:395a/396 lid 1 onder a gaat uit van de verkrijgings- of vervaardigingsprijs. Waardeer je op actuele waarde, corrigeer het balanstotaal dan met de hand.'
  ]);

  if v_in_group then
    v_warnings := v_warnings || to_jsonb(array[
      'Deze administratie maakt deel uit van een groep (er is een moeder- of een dochter-administratie gekoppeld). De waarde van de activa, de netto-omzet en het aantal werknemers van groepsmaatschappijen die in de consolidatie zouden moeten worden betrokken, moeten worden meegeteld (art. 2:395a lid 2 / 2:396 lid 2 / 2:397 lid 2 BW), tenzij de rechtspersoon art. 2:408 BW toepast. ResoFly telt die cijfers NIET op: twee entiteiten die apart onder de kleingrens blijven en samen erboven, komen hier ten onrechte als klein uit. Tel de groepscijfers met de hand op via het balanstotaal en de netto-omzet, of leg de klasse handmatig vast. Zolang dat niet is gebeurd, doet ResoFly bewust geen uitspraak over de controleplicht van art. 2:393 lid 1 BW.'
    ]);
  end if;

  if v_cur_src_turnover = 'derived' then
    v_warnings := v_warnings || to_jsonb(array[
      'De netto-omzet is de som van de rekeningen met rubriek "Netto-omzet". Die rubriek mag je zelf per rekening aanpassen; controleer of de indeling klopt voordat je de klasse vastlegt.'
    ]);
  end if;
  if (v_cur_src_assets = 'override' or v_cur_src_turnover = 'override')
     and nullif(btrim(coalesce(v_cur_override_reason, '')), '') is null then
    v_warnings := v_warnings || to_jsonb(array[
      'Balanstotaal of netto-omzet is met de hand overschreven zonder toelichting. Leg de reden vast; bij een controle moet navolgbaar zijn waarop de klasse berust.'
    ]);
  end if;

  -- De vlag hangt aan de opgeslagen rij, het effect aan het aanvangsjaar. Wordt
  -- period_start later verplaatst (of zet de service-role de rij rechtstreeks),
  -- dan doet de vlag niets meer — dan mag de onderbouwing niet blijven beweren
  -- dat de verhoogde bedragen zijn toegepast.
  if coalesce(v_has_in and v_in.early_adopt_new_thresholds, false) then
    if v_year = 2023 then
      v_warnings := v_warnings || to_jsonb(array[format(
        'Voor dit boekjaar (aanvang %s) zijn de verhoogde grensbedragen van Stb. 2024, 52 vervroegd toegepast (art. 4). Dat mag, maar het is een keuze: zonder die keuze gelden de bedragen uit Stb. 2015, 349. De gekozen reeks is op alle getoetste balansdata toegepast.',
        v_year)]);
    else
      v_warnings := v_warnings || to_jsonb(array[format(
        'Bij dit boekjaar staat de keuze aan om de verhoogde grensbedragen van Stb. 2024, 52 vervroegd toe te passen, maar het boekjaar vangt aan in %s. Art. 4 van dat besluit staat dat alleen toe voor boekjaren die aanvangen in 2023, dus de keuze doet hier niets. Zet hem uit, of controleer de aanvangsdatum van het boekjaar.',
        v_year)]);
    end if;
  end if;

  if v_first_year and v_class is not null then
    v_warnings := v_warnings || to_jsonb(array[
      'Dit is het eerste boekjaar van de rechtspersoon, zoals bij de groottegegevens is bevestigd. Er is dus maar één balansdatum om aan te toetsen; de klasse rust op dat ene jaar en beweegt vanaf volgend jaar pas mee volgens de tweejaarsregel van art. 2:395a lid 1 / 2:396 lid 1 / 2:397 lid 1 BW.'
    ]);
  end if;

  if v_cur_carried is not null and v_class is not null then
    v_warnings := v_warnings || to_jsonb(array[format(
      'De rauwe toets van dit boekjaar komt uit op "%s", maar de klasse blijft "%s". Dat is de regel van art. 2:395a lid 1 / 2:396 lid 1 / 2:397 lid 1 BW: een over- of onderschrijding telt pas als zij zich op twee opeenvolgende balansdata voordoet. Herhaalt de rauwe uitkomst zich volgend boekjaar, dan wisselt de klasse alsnog.',
      v_cur_raw, v_class)]);
  end if;

  -- ── Welke drempelrij verantwoordt de uiteindelijke klasse ───────────────
  -- Uit de evaluatie van het boekjaar waarin die klasse is ontstaan, niet uit
  -- een tweede lookup: anders toont de onderbouwing een andere rij dan waarop de
  -- klasse berust. Elk boekjaar in de keten is aan de reeks van ZIJN EIGEN
  -- aanvangsjaar getoetst; alleen het paar dat de wissel bepaalt ging door één
  -- en dezelfde reeks (kernbeslissing E). De hier getoonde rij is dus die van
  -- het boekjaar waarin de klasse ontstond, en `chain` laat per jaar zien welke
  -- reeks daar is gebruikt.
  if v_class is not null and v_source_eval is not null
     and v_source_eval -> 'thresholdsUsed' is not null
     and jsonb_typeof(v_source_eval -> 'thresholdsUsed') = 'object' then
    v_thresholds := (v_source_eval -> 'thresholdsUsed') || jsonb_build_object(
      'requestedYearLookupYear', v_lookup_year,
      'testedFiscalYears', v_tested_years,
      'basedOnYear', v_source_year,
      'basedOnFiscalYearLabel', v_source_label
    );
  end if;

  return jsonb_build_object(
    'fiscalYearId', v_fy.id,
    'fiscalYearLabel', v_fy.label,
    'year', v_year,
    'periodStart', v_fy.period_start,
    'periodEnd', v_fy.period_end,
    'periodDays', v_cur_days,
    'current', jsonb_build_object(
      'assetsCents', v_cur_assets,
      'turnoverCents', v_cur_turnover,
      'employees', v_cur_employees,
      'assetsSource', v_cur_src_assets,
      'turnoverSource', v_cur_src_turnover,
      'employeesSource', v_cur_src_employees,
      'days', v_cur_days,
      'earlyAdoptNewThresholds', coalesce(v_has_in and v_in.early_adopt_new_thresholds, false)
    ),
    'previous', case when v_has_prev then jsonb_build_object(
      'fiscalYearId', v_prev_fy_id,
      'fiscalYearLabel', v_prev_label,
      'year', v_prev_year,
      'periodEnd', v_prev_end,
      'days', v_prev_days,
      'assetsCents', v_prev_assets,
      'turnoverCents', v_prev_turnover,
      'employees', v_prev_employees,
      'assetsSource', v_prev_src_assets,
      'turnoverSource', v_prev_src_turnover,
      'employeesSource', v_prev_src_employees,
      'earlyAdoptNewThresholds', v_prev_early
    ) end,
    -- rawClass = zonder tweejaarsregel; currentClass = mét, en dus gelijk aan
    -- sizeClass. Staan er allebei in zodat het scherm het verschil kan uitleggen.
    'rawClass', v_cur_raw,
    'currentClass', v_class,
    'previousClass', v_prev_class,
    'previousRawClass', v_prev_raw,
    'carriedForwardFrom', v_cur_carried,
    'sizeClass', v_class,
    'criteriaMet', coalesce(v_cur_eval -> 'criteriaMet', '{}'::jsonb),
    'previousCriteriaMet', case when v_prev_eval is not null then v_prev_eval -> 'criteriaMet' end,
    'thresholdsUsed', v_thresholds,
    'thresholdsLookupYear', v_lookup_year,
    'chain', v_chain,
    'firstYear', v_first_year,
    'firstFiscalYearConfirmed', v_first_confirmed,
    'previousUnknown', v_prev_unknown,
    'inGroup', v_in_group,
    'publicationSet', v_class,
    -- Art. 2:393 lid 1 BW: controleplicht. De vrijstelling van art. 2:396 lid 7
    -- geldt alleen voor klein (en daarmee ook voor micro); middelgroot en groot
    -- moeten de jaarrekening laten controleren. Null = ResoFly doet er bewust
    -- geen uitspraak over: geen klasse, of een groepsstructuur waarvan de
    -- cijfers niet zijn opgeteld.
    'auditRequired', case
      when v_class is null or v_in_group then null
      else v_class in ('middelgroot','groot')
    end,
    'blockingReason', v_blocking,
    'warnings', v_warnings
  );
end;
$function$;
revoke all on function public.determine_company_size(uuid, uuid) from public, anon;
grant execute on function public.determine_company_size(uuid, uuid) to authenticated, service_role;

-- ── 6. Vpb: één jaarsleutel, tariefwissel herkennen, berekening nagerekend ─
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
$function$;
revoke all on function public.get_corporate_tax_inputs(uuid, uuid) from public, anon;
grant execute on function public.get_corporate_tax_inputs(uuid, uuid) to authenticated, service_role;
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
$function$;
revoke all on function public.save_corporate_tax_return(uuid, uuid, jsonb, boolean, text, uuid) from public, anon;
grant execute on function public.save_corporate_tax_return(uuid, uuid, jsonb, boolean, text, uuid) to authenticated, service_role;

-- ── 7. Jaarrekening NV: vrij uitkeerbaar zonder gestort kapitaal ───────────
CREATE OR REPLACE FUNCTION public.build_annual_accounts_snapshot(p_organization_id uuid, p_fiscal_year_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_fy public.fiscal_years;
  v_prev public.fiscal_years;
  v_has_prev boolean := false;
  -- Bewust losse variabelen en geen record: een SELECT INTO die niets oplevert
  -- laat een record-variabele zonder tuple-structuur achter, en dan valt de
  -- functie om op "record is not assigned yet" in plaats van netjes null te
  -- geven. Een organisatie zónder company_settings komt hier niet eens: dan is
  -- org_fiscal_regime niet 'vpb' en is er hierboven al geweigerd.
  v_org_name text;
  v_company_name text;
  v_trade_name text;
  v_legal_form text;
  v_kvk text;
  v_vat text;
  v_addr1 text;
  v_addr2 text;
  v_postal text;
  v_city text;
  v_country text;

  v_balance jsonb := '[]'::jsonb;
  v_equity jsonb := '[]'::jsonb;
  v_assets bigint := 0;
  v_liab_equity bigint := 0;

  v_pl jsonb := '[]'::jsonb;

  v_tb_debit bigint := 0;
  v_tb_credit bigint := 0;

  v_size jsonb;
  v_ra public.result_appropriations;
  v_has_ra boolean := false;
  v_ct public.corporate_tax_returns;
  v_has_ct boolean := false;

  v_distributable bigint;
  v_shareholders jsonb := '[]'::jsonb;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if not public.org_has_business(p_organization_id) then
    raise exception 'De jaarrekening hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'Een jaarrekening volgens Titel 9 Boek 2 BW hoort bij een BV, NV of coöperatie. Pas eerst de rechtsvorm aan bij Instellingen → Bedrijfsgegevens.'
      using errcode = '23514';
  end if;

  select * into v_fy from public.fiscal_years fy
  where fy.id = p_fiscal_year_id and fy.organization_id = p_organization_id;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;

  -- De balans ná resultaatbestemming bestaat alleen voor een afgesloten
  -- boekjaar. Die controle staat óók in report_balance_sheet_after_appropriation,
  -- maar hier komt hij mét de knop erbij die de gebruiker moet indrukken.
  if v_fy.status <> 'closed' then
    raise exception 'Sluit boekjaar % eerst af (Boekjaren → Boekjaar afsluiten). Een jaarrekening wordt opgemaakt op de afgesloten cijfers; zolang het jaar open staat, staat het resultaat nog op de opbrengst- en kostenrekeningen.', v_fy.label
      using errcode = '23514';
  end if;

  select * into v_prev from public.fiscal_years fy
  where fy.organization_id = p_organization_id
    and fy.period_end < v_fy.period_start
  order by fy.period_end desc
  limit 1;
  v_has_prev := found;

  select o.name into v_org_name from public.organizations o where o.id = p_organization_id;
  select cs.company_name, cs.trade_name, cs.legal_form, cs.kvk_number, cs.vat_number,
         cs.address_line1, cs.address_line2, cs.postal_code, cs.city, cs.country
    into v_company_name, v_trade_name, v_legal_form, v_kvk, v_vat,
         v_addr1, v_addr2, v_postal, v_city, v_country
  from public.company_settings cs
  where cs.organization_id = p_organization_id;

  -- ── Balans ná resultaatbestemming ─────────────────────────────────────────
  -- Eén doorloop, drie uitkomsten: de regels, het verloop van het eigen
  -- vermogen, en de twee balanstotalen voor de sluitcontrole. De join op
  -- ledger_accounts is een LEFT join: de RPC levert alleen bestaande rekeningen,
  -- maar een inner join zou bij een onverwachte rij stil een regel laten vallen
  -- en dan klopt het balanstotaal niet meer.
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'accountId', b.account_id,
      'code', b.code,
      'name', b.name,
      'section', b.section,
      'reportGroup', b.report_group,
      'groupRank', b.group_rank,
      'amountCents', b.amount_cents,
      'amountPrevCents', b.amount_prev_cents,
      'appropriationDeltaCents', b.appropriation_delta_cents,
      'isRestrictedReserve', coalesce(la.is_restricted_reserve, false),
      'subtype', la.subtype
    ) order by b.group_rank, b.code), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
      'accountId', b.account_id,
      'code', b.code,
      'name', b.name,
      'openingCents', b.amount_prev_cents,
      'movementCents', b.amount_cents - b.amount_prev_cents,
      'closingCents', b.amount_cents,
      'appropriationDeltaCents', b.appropriation_delta_cents,
      -- Wettelijke en statutaire reserves horen in de toelichting APART te
      -- staan; ze bepalen bovendien de uitkeerbare ruimte (art. 2:216 lid 1 BW).
      'isRestrictedReserve', coalesce(la.is_restricted_reserve, false),
      'subtype', la.subtype
    ) order by b.code) filter (where b.section = 'equity'), '[]'::jsonb),
    coalesce(sum(case when b.section = 'asset' then b.amount_cents else 0 end), 0)::bigint,
    coalesce(sum(case when b.section <> 'asset' then b.amount_cents else 0 end), 0)::bigint
  into v_balance, v_equity, v_assets, v_liab_equity
  from public.report_balance_sheet_after_appropriation(p_organization_id, p_fiscal_year_id) b
  left join public.ledger_accounts la on la.id = b.account_id;

  -- ── Winst-en-verliesrekening, vergelijkend ────────────────────────────────
  -- Subtotalen worden hier bewust NIET gemaakt: die volgen uit de rubrieken en
  -- horen bij de renderer. "Bedrijfsresultaat" is bovendien praktijk/RJ en geen
  -- wettelijke modelregel; zo'n label hoort niet uit de database te komen.
  select coalesce(jsonb_agg(jsonb_build_object(
    'accountId', pl.account_id,
    'code', pl.code,
    'name', pl.name,
    'accountType', pl.account_type,
    'reportGroup', pl.report_group,
    'groupRank', pl.group_rank,
    'amountCents', pl.amount_cents,
    'amountPrevCents', pl.amount_prev_cents
  ) order by pl.group_rank, pl.code), '[]'::jsonb)
  into v_pl
  from public.report_profit_and_loss_comparative(p_organization_id, p_fiscal_year_id) pl;

  -- ── Aansluitcontrole op de proefbalans ────────────────────────────────────
  -- De proefbalans telt het year_close-boekstuk mee, dus Σ debet moet gelijk
  -- zijn aan Σ credit. Een verschil betekent dat er iets grondig mis is met het
  -- grootboek en dan mag er niets bevroren worden.
  select coalesce(sum(tb.debit_cents), 0)::bigint, coalesce(sum(tb.credit_cents), 0)::bigint
  into v_tb_debit, v_tb_credit
  from public.report_trial_balance(p_organization_id, v_fy.period_end) tb;

  v_size := public.determine_company_size(p_organization_id, p_fiscal_year_id);

  select * into v_ra from public.result_appropriations ra
  where ra.organization_id = p_organization_id
    and ra.fiscal_year_id = p_fiscal_year_id
    and ra.status = 'posted';
  v_has_ra := found;

  select * into v_ct from public.corporate_tax_returns ct
  where ct.organization_id = p_organization_id
    and ct.fiscal_year_id = p_fiscal_year_id
    and ct.status <> 'reversed';
  v_has_ct := found;

  -- GEWIJZIGD (20261104040000): bij een NV telt het gestorte en opgevraagde
  -- kapitaal niet mee als vrij uitkeerbaar (art. 2:105 lid 2 BW).
  v_distributable := public.org_distributable_equity(p_organization_id, v_fy.period_end, public.org_legal_form(p_organization_id) = 'nv');

  select coalesce(jsonb_agg(jsonb_build_object(
    'shareholderId', sp.shareholder_id,
    'name', sp.name,
    'kind', sp.kind,
    'shareClass', sp.share_class,
    'shares', sp.shares,
    'nominalCents', sp.nominal_cents,
    'paidUpCents', sp.paid_up_cents,
    'shareBasisPoints', sp.share_basis_points
  ) order by sp.name, sp.share_class), '[]'::jsonb)
  into v_shareholders
  from public.shareholder_positions(p_organization_id, v_fy.period_end) sp;

  return jsonb_build_object(
    'version', 1,
    'generatedAt', now(),
    'entity', jsonb_build_object(
      'organizationId', p_organization_id,
      'organizationName', v_org_name,
      'companyName', coalesce(nullif(btrim(coalesce(v_company_name, '')), ''), v_org_name),
      'tradeName', v_trade_name,
      'legalForm', coalesce(v_legal_form, public.org_legal_form(p_organization_id)),
      'kvkNumber', v_kvk,
      'vatNumber', v_vat,
      'addressLine1', v_addr1,
      'addressLine2', v_addr2,
      'postalCode', v_postal,
      'city', v_city,
      'country', v_country
    ),
    'fiscalYear', jsonb_build_object(
      'id', v_fy.id,
      'label', v_fy.label,
      'periodStart', v_fy.period_start,
      'periodEnd', v_fy.period_end,
      'status', v_fy.status,
      'resultCents', v_fy.result_cents,
      'resultAccountCode', v_fy.result_account_code
    ),
    'previousFiscalYear', case when v_has_prev then jsonb_build_object(
      'id', v_prev.id,
      'label', v_prev.label,
      'periodStart', v_prev.period_start,
      'periodEnd', v_prev.period_end,
      'status', v_prev.status
    ) end,
    'balanceSheetAfterAppropriation', jsonb_build_object(
      'rows', v_balance,
      'totalAssetsCents', v_assets,
      'totalEquityAndLiabilitiesCents', v_liab_equity,
      'differenceCents', v_assets - v_liab_equity,
      'balances', (v_assets - v_liab_equity) = 0
    ),
    'equityMovement', v_equity,
    'profitAndLossComparative', jsonb_build_object('rows', v_pl),
    -- De RAUWE uitkomst van de groottetoets. prepare_annual_accounts vult hier
    -- vóór het bevriezen appliedSizeClass, manualOverride en
    -- manualOverrideReason bij: de klasse waarop het stuk werkelijk berust kan
    -- afwijken van de berekende (handmatige klasse bij een groepsstructuur), en
    -- de PDF haalt álles uit de snapshot. Wie hier alleen 'sizeClass' leest,
    -- drukt bij de overrideroute de verkeerde klasse af — of null.
    'size', v_size,
    'resultAppropriation', case when v_has_ra then jsonb_build_object(
      'id', v_ra.id,
      'decisionDate', v_ra.decision_date,
      'resultCents', v_ra.result_cents,
      'reservesCents', v_ra.reserves_cents,
      'dividendCents', v_ra.dividend_cents,
      'reservesAccountCode', v_ra.reserves_account_code,
      'dividendAccountCode', v_ra.dividend_account_code,
      'distributableCents', v_ra.distributable_cents,
      'boardApproved', v_ra.board_approved,
      'journalEntryId', v_ra.journal_entry_id,
      'note', v_ra.note
    ) end,
    'corporateTax', case when v_has_ct then jsonb_build_object(
      'id', v_ct.id,
      'year', v_ct.year,
      'status', v_ct.status,
      'commercialResultCents', v_ct.commercial_result_cents,
      'correctionsCents', v_ct.corrections_cents,
      'fiscalProfitCents', v_ct.fiscal_profit_cents,
      'lossUsedCents', v_ct.loss_used_cents,
      'taxableAmountCents', v_ct.taxable_amount_cents,
      'taxCents', v_ct.tax_cents,
      'computation', v_ct.computation
    ) end,
    'reconciliation', jsonb_build_object(
      'trialBalanceDebitCents', v_tb_debit,
      'trialBalanceCreditCents', v_tb_credit,
      'trialBalanceDifferenceCents', v_tb_debit - v_tb_credit,
      'trialBalanceBalances', (v_tb_debit - v_tb_credit) = 0,
      'balanceSheetDifferenceCents', v_assets - v_liab_equity,
      'balanceSheetBalances', (v_assets - v_liab_equity) = 0,
      'balances', (v_tb_debit - v_tb_credit) = 0 and (v_assets - v_liab_equity) = 0
    ),
    -- Let op bij het gebruik in de toelichting: org_distributable_equity telt
    -- uitsluitend EQUITY-rekeningen op de balansdatum. Het is dus NIET "het
    -- volledige vrij uitkeerbare vermogen" — het resultaat van een lopend
    -- boekjaar zit er niet in. Nooit anders presenteren.
    'distributableEquityCents', v_distributable,
    'shareholders', v_shareholders,
    'disclaimer', 'Opgesteld met ResoFly als hulpmiddel. Geen accountantsproduct en geen fiscaal of juridisch advies; de rechtspersoon blijft verantwoordelijk voor de inhoud van de jaarrekening.'
  );
end;
$function$;
revoke all on function public.build_annual_accounts_snapshot(uuid, uuid) from public, anon;
grant execute on function public.build_annual_accounts_snapshot(uuid, uuid) to authenticated, service_role;

-- ── 8. Rente rekening-courant DGA ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.book_dga_interest(p_organization_id uuid, p_year integer, p_created_by uuid DEFAULT auth.uid())
 RETURNS dga_interest_postings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_fy_start smallint;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':dga'));
  -- TOEGEVOEGD (20261104040000): de renteboeking mag in een afgesloten periode;
  -- daarom de boekingsgrendel gedeeld, zodat hij niet tussen het optellen en
  -- het slot van de jaarafsluiting valt.
  perform pg_advisory_xact_lock_shared(hashtext(p_organization_id::text || ':periodegrendel'));

  -- TOEGEVOEGD (20261104040000): de rente over een jaar dat nog loopt zou op het
  -- saldo van vandaag rekenen; latere mutaties vallen dan voorgoed weg.
  if v_date >= current_date then
    raise exception 'De rente over % boek je na afloop van het jaar, vanaf 1 januari %.', p_year, p_year + 1
      using errcode = '23514';
  end if;

  if not public.org_has_business(p_organization_id) then
    raise exception 'De rekening-courant DGA hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;

  -- De berekening loopt over het kalenderjaar. Bij een gebroken boekjaar zou de
  -- last daardoor in het verkeerde boekjaar vallen en doorwerken in de
  -- Vpb-grondslag. Liever weigeren met een reden dan stilzwijgend verkeerd
  -- toerekenen.
  select coalesce(cs.fiscal_year_start_month, 1) into v_fy_start
  from public.company_settings cs where cs.organization_id = p_organization_id;
  if coalesce(v_fy_start, 1) <> 1 then
    raise exception 'Deze administratie heeft een gebroken boekjaar (start in maand %). De renteberekening loopt over het kalenderjaar en zou de last in het verkeerde boekjaar zetten; boek de rente voorlopig handmatig.', v_fy_start
      using errcode = '0A000';
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
    v_income := public.bookkeeping_account_id(p_organization_id, '9000');
    perform set_config('resofly.trusted_journal_source', 'dga_interest', true);
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
    v_expense := public.bookkeeping_account_id(p_organization_id, '9100');
    perform set_config('resofly.trusted_journal_source', 'dga_interest', true);
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
$function$;
revoke all on function public.book_dga_interest(uuid, integer, uuid) from public, anon;
grant execute on function public.book_dga_interest(uuid, integer, uuid) to authenticated, service_role;

commit;
