-- ============================================================
-- ResoFly — Zakelijke module: losse eindjes uit fase 1
-- Date: 2026-08-07
--
-- Drie gaten die bij het bouwen van fase 1 zichtbaar werden en die nú al bijten,
-- vóór de vennootschapsbelasting erbovenop komt.
--
-- 1. DE BEGINBALANS ZETTE ALLES OP AANDELENKAPITAAL.
--    create_opening_balance sluit het verschil tussen debet en credit af op
--    rekening 0500. Bij een eenmanszaak heet die "Eigen vermogen" en klopt dat.
--    Sinds fase 1 heet 0500 bij een BV "Geplaatst en gestort aandelenkapitaal"
--    (subtype 'share_capital'), en dan is het fout: een BV die overstapt van een
--    ander pakket boekte zo haar hele opgebouwde vermogen als gestort kapitaal.
--    Dat is niet alleen een verkeerde rubriek — bij een NV telt gestort kapitaal
--    mee in de ondergrens van de balanstest (art. 2:105 lid 2 BW), dus zo'n
--    beginbalans zou een dividend weigeren waar de vennootschap recht op heeft.
--    Wat wél klopt: het opgebouwde vermogen van vóór de overstap hoort op de
--    overige reserves (0520), en anders op het onverdeeld resultaat (0510).
--
-- 2. HET BV-SCHEMA KWAM ZONDER DE MODULE BINNEN.
--    ensure_business_ledger_accounts controleerde de rechtsvorm maar niet of de
--    zakelijke module is afgenomen. Wie zonder module de rechtsvorm op BV zette,
--    kreeg bij de eerstvolgende boeking het complete BV-schema — dertien
--    systeemrekeningen die daarna niet meer te verwijderen zijn.
--
-- 3. DE RECHTSVORM ZELF WAS HELEMAAL NIET BEWAAKT.
--    company_settings wordt door de app met een gewone PostgREST-upsert
--    geschreven, dus er kwam geen enkele serverregel aan te pas. Een trigger is
--    hier de enige plek waar dat wél kan.
--    Belangrijk: de trigger blokkeert alleen de OVERGANG naar een
--    Vpb-rechtsvorm. Een administratie die al op BV staat en waarvan de module
--    verloopt, moet haar eigen instellingen blijven kunnen opslaan — anders
--    sluit een betaalprobleem de klant buiten zijn eigen bedrijfsgegevens.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Beginbalans: de sluitpost naar een rekening die klopt
--    Volledige functie opnieuw (basis: 20260723200000, inclusief de
--    dubbele-beginbalans-guard uit die migratie); alleen de keuze van de
--    sluitpostrekening is nieuw.
-- ------------------------------------------------------------
create or replace function public.create_opening_balance(
  p_organization_id uuid,
  p_as_of_date date,
  p_lines jsonb,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lines jsonb;
  v_debit bigint;
  v_credit bigint;
  v_equity bigint;
  v_existing text;
  v_plug_code text;
  v_plug_label text;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Beginbalans heeft minimaal één regel nodig.' using errcode = '23514';
  end if;

  select coalesce(je.entry_number, je.id::text) into v_existing
  from public.journal_entries je
  where je.organization_id = p_organization_id
    and je.source_type = 'opening_balance'
    and je.status = 'posted'
    and je.reversed_by_entry_id is null
  limit 1;
  if v_existing is not null then
    raise exception 'Er is al een beginbalans geboekt (boekstuk %). Boek die eerst tegen voordat je een nieuwe vastlegt.', v_existing
      using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Sluit het verschil op eigen vermogen zodat de openingsbalans in balans is.
  select coalesce(sum(coalesce((l->>'debit_cents')::bigint,0)),0),
         coalesce(sum(coalesce((l->>'credit_cents')::bigint,0)),0)
    into v_debit, v_credit
  from jsonb_array_elements(p_lines) l;

  v_lines := p_lines;
  v_equity := v_debit - v_credit;
  if v_equity <> 0 then
    -- Welke rekening de sluitpost draagt, hangt aan de rechtsvorm. Bij een
    -- kapitaalvennootschap is het meegebrachte vermogen géén gestort kapitaal —
    -- dat is precies het bedrag dat de aandeelhouder ooit heeft volgestort en
    -- dat legt de gebruiker zelf op 0500. Alles wat de onderneming daarna heeft
    -- opgebouwd hoort bij de reserves.
    -- Een ketting en geen vaste keuze: 0520 bestaat alleen ná het BV-schema, en
    -- bookkeeping_account_id werpt een fout in plaats van terug te vallen.
    if public.org_fiscal_regime(p_organization_id) = 'vpb' then
      select code into v_plug_code
      from public.ledger_accounts
      where organization_id = p_organization_id and code in ('0520', '0510', '0500')
      order by array_position(array['0520','0510','0500'], code)
      limit 1;
      v_plug_label := 'Meegebracht eigen vermogen (sluitpost beginbalans)';
    else
      v_plug_code := '0500';
      v_plug_label := 'Eigen vermogen (sluitpost beginbalans)';
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, coalesce(v_plug_code, '0500')),
      'description', v_plug_label,
      'debit_cents', case when v_equity < 0 then -v_equity else 0 end,
      'credit_cents', case when v_equity > 0 then v_equity else 0 end
    ));
  end if;

  return public.post_journal_entry(
    p_organization_id, p_as_of_date, 'Beginbalans per ' || p_as_of_date,
    'opening_balance', null, v_lines, p_created_by
  );
end;
$$;

-- De app toont vooraf welke rekening de sluitpost krijgt; anders staat er
-- "0500 Eigen vermogen" in beeld terwijl er op 0520 wordt geboekt.
create or replace function public.opening_balance_plug_account(p_organization_id uuid)
returns table (code text, name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if public.org_fiscal_regime(p_organization_id) = 'vpb' then
    return query
      select la.code, la.name
      from public.ledger_accounts la
      where la.organization_id = p_organization_id and la.code in ('0520', '0510', '0500')
      order by array_position(array['0520','0510','0500'], la.code)
      limit 1;
  else
    return query
      select la.code, la.name
      from public.ledger_accounts la
      where la.organization_id = p_organization_id and la.code = '0500'
      limit 1;
  end if;
end;
$$;

revoke all on function public.opening_balance_plug_account(uuid) from public, anon, authenticated;
grant execute on function public.opening_balance_plug_account(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Het BV-schema alleen mét de zakelijke module
--    Volledige functie opnieuw (basis: 20260807020000); alleen de
--    module-controle is nieuw. De controle staat hier en niet alleen bij de
--    aanroeper, want de dertien systeemrekeningen die deze functie plaatst zijn
--    daarna niet meer door de gebruiker te verwijderen.
-- ------------------------------------------------------------
create or replace function public.ensure_business_ledger_accounts(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'Het BV-rekeningschema hoort bij een BV, NV of coöperatie. Pas eerst de rechtsvorm aan bij Instellingen → Bedrijfsgegevens.'
      using errcode = '23514';
  end if;

  if not public.org_has_business(p_organization_id) then
    raise exception 'Het BV-rekeningschema hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;

  insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group, is_restricted_reserve)
  values
    (p_organization_id, '0020', 'Immateriële vaste activa', 'asset', 'intangible_asset', null, true, 'immateriele_vaste_activa', false),
    (p_organization_id, '0025', 'Cumulatieve afschrijving immateriële vaste activa', 'asset', 'accumulated_amortization', null, true, 'immateriele_vaste_activa', false),
    (p_organization_id, '0300', 'Deelnemingen', 'asset', 'participation', null, true, 'financiele_vaste_activa', false),
    (p_organization_id, '0310', 'Vorderingen op groepsmaatschappijen', 'asset', 'group_receivable', null, false, 'financiele_vaste_activa', false),
    (p_organization_id, '0350', 'Latente belastingvordering', 'asset', 'deferred_tax_asset', null, false, 'financiele_vaste_activa', false),
    (p_organization_id, '0505', 'Agio', 'equity', 'share_premium', null, true, 'eigen_vermogen', false),
    (p_organization_id, '0520', 'Overige reserves', 'equity', 'other_reserves', null, true, 'eigen_vermogen', false),
    (p_organization_id, '0530', 'Wettelijke reserves', 'equity', 'legal_reserve', null, true, 'eigen_vermogen', true),
    (p_organization_id, '0600', 'Voorzieningen', 'liability', 'provision', null, false, 'voorzieningen', false),
    (p_organization_id, '0610', 'Voorziening latente belastingverplichting', 'liability', 'deferred_tax_liability', null, false, 'voorzieningen', false),
    (p_organization_id, '0700', 'Langlopende schulden', 'liability', 'long_term_debt', null, false, 'langlopende_schulden', false),
    (p_organization_id, '0710', 'Lening o/g DGA', 'liability', 'dga_loan', null, false, 'langlopende_schulden', false),
    (p_organization_id, '1400', 'Rekening-courant DGA', 'asset', 'dga_current_account', null, true, 'vorderingen', false),
    (p_organization_id, '1540', 'Te betalen vennootschapsbelasting', 'liability', 'corporate_tax_payable', null, true, 'kortlopende_schulden', false),
    (p_organization_id, '1545', 'Betaalde voorlopige aanslagen Vpb', 'asset', 'corporate_tax_prepaid', null, true, 'vorderingen', false),
    (p_organization_id, '1550', 'Te betalen loonheffingen', 'liability', 'payroll_tax_payable', null, true, 'kortlopende_schulden', false),
    (p_organization_id, '1555', 'Te betalen pensioenpremies', 'liability', 'pension_payable', null, false, 'kortlopende_schulden', false),
    (p_organization_id, '1570', 'Nettolonen te betalen', 'liability', 'net_wages_payable', null, false, 'kortlopende_schulden', false),
    (p_organization_id, '1560', 'Te betalen dividendbelasting', 'liability', 'dividend_tax_payable', null, true, 'kortlopende_schulden', false),
    (p_organization_id, '1580', 'Te betalen dividend', 'liability', 'dividend_payable', null, true, 'kortlopende_schulden', false),
    (p_organization_id, '4100', 'Brutolonen', 'expense', 'wages', null, false, 'personeelskosten', false),
    (p_organization_id, '4110', 'Sociale lasten', 'expense', 'social_charges', null, false, 'personeelskosten', false),
    (p_organization_id, '4120', 'Pensioenlasten', 'expense', 'pension_charges', null, false, 'personeelskosten', false),
    (p_organization_id, '9000', 'Rentebaten en soortgelijke opbrengsten', 'revenue', 'interest_income', 'VRIJ', false, 'financiele_baten', false),
    (p_organization_id, '9100', 'Rentelasten en soortgelijke kosten', 'expense', 'interest_expense', 'VRIJ', false, 'financiele_lasten', false),
    (p_organization_id, '9900', 'Vennootschapsbelasting', 'expense', 'corporate_tax', null, true, 'belastingen', false)
  on conflict (organization_id, code) do nothing;
end;
$$;

revoke all on function public.ensure_business_ledger_accounts(uuid) from public, anon, authenticated;
grant execute on function public.ensure_business_ledger_accounts(uuid) to service_role;

-- ensure_default_ledger_accounts roept de BV-tak aan zodra het regime 'vpb' is.
-- Zonder module moet dat stilzwijgend overslaan en niet de hele boeking laten
-- klappen: post_journal_entry komt hier bij élke journaalpost langs, en een
-- verlopen abonnement mag nooit betekenen dat er niet meer geboekt kan worden.
create or replace function public.ensure_default_ledger_accounts(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_regime text;
  v_equity_name text;
  v_equity_subtype text;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  v_regime := public.org_fiscal_regime(p_organization_id);

  if v_regime = 'vpb' then
    v_equity_name := 'Geplaatst en gestort aandelenkapitaal';
    v_equity_subtype := 'share_capital';
  else
    v_equity_name := 'Eigen vermogen';
    v_equity_subtype := 'equity';
  end if;

  insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
  values
    (p_organization_id, '0100', 'Vaste activa', 'asset', 'fixed_asset', null, true, 'materiele_vaste_activa'),
    (p_organization_id, '0150', 'Cumulatieve afschrijving', 'asset', 'accumulated_depreciation', null, true, 'materiele_vaste_activa'),
    (p_organization_id, '0500', v_equity_name, 'equity', v_equity_subtype, null, true, 'eigen_vermogen'),
    (p_organization_id, '0510', 'Onverdeeld resultaat', 'equity', 'retained_earnings', null, true, 'eigen_vermogen'),
    (p_organization_id, '1100', 'Bank', 'asset', 'bank', null, true, 'liquide_middelen'),
    (p_organization_id, '1102', 'Kruisposten Mollie/PSP', 'asset', 'psp_clearing', null, true, 'vorderingen'),
    (p_organization_id, '1300', 'Debiteuren', 'asset', 'accounts_receivable', null, true, 'vorderingen'),
    (p_organization_id, '1500', 'Te vorderen BTW (voorbelasting)', 'asset', 'vat_input', null, true, 'vorderingen'),
    (p_organization_id, '1510', 'Af te dragen BTW (verkoop)', 'liability', 'vat_output', null, true, 'kortlopende_schulden'),
    (p_organization_id, '1520', 'Af te dragen BTW verlegd/ICP', 'liability', 'vat_reverse', null, true, 'kortlopende_schulden'),
    (p_organization_id, '1530', 'Te betalen omzetbelasting', 'liability', 'vat_payable', null, true, 'kortlopende_schulden'),
    (p_organization_id, '1600', 'Crediteuren', 'liability', 'accounts_payable', null, true, 'kortlopende_schulden'),
    (p_organization_id, '4000', 'Afschrijvingskosten', 'expense', 'depreciation', null, true, 'afschrijvingen'),
    (p_organization_id, '4130', 'Betaalproviderkosten', 'expense', 'payment_fees', null, false, 'overige_bedrijfskosten'),
    (p_organization_id, '4500', 'Algemene kosten', 'expense', 'general_cost', 'HOOG', false, 'overige_bedrijfskosten'),
    (p_organization_id, '4900', 'Afrondingsverschillen', 'expense', 'rounding', null, true, 'overige_bedrijfskosten'),
    (p_organization_id, '8000', 'Omzet hoog (21%)', 'revenue', 'sales', 'HOOG', false, 'netto_omzet'),
    (p_organization_id, '8010', 'Omzet laag (9%)', 'revenue', 'sales', 'LAAG', false, 'netto_omzet'),
    (p_organization_id, '8020', 'Omzet 0% / vrijgesteld', 'revenue', 'sales', 'NUL', false, 'netto_omzet'),
    (p_organization_id, '8030', 'Omzet buitenland (ICP/verlegd)', 'revenue', 'sales', 'ICP_DIENST', false, 'netto_omzet')
  on conflict (organization_id, code) do nothing;

  insert into public.vat_codes (organization_id, code, label, rate, kind, sales_box, vat_box, is_system)
  values
    (p_organization_id, 'HOOG', 'BTW 21%', 21, 'standard', '1a', '1a', true),
    (p_organization_id, 'LAAG', 'BTW 9%', 9, 'reduced', '1b', '1b', true),
    (p_organization_id, 'NUL', 'BTW 0%', 0, 'zero', '1e', null, true),
    (p_organization_id, 'VRIJ', 'Vrijgesteld', 0, 'exempt', null, null, true),
    (p_organization_id, 'VERL_VERK', 'BTW verlegd (verkoop)', 0, 'reverse_charge_sales', '1e', null, true),
    (p_organization_id, 'VERL_INK', 'BTW verlegd (inkoop)', 21, 'reverse_charge_purchase', '2a', '5b', true),
    (p_organization_id, 'ICP_GOED', 'ICP goederen', 0, 'icp_goods', '3b', null, true),
    (p_organization_id, 'ICP_DIENST', 'ICP diensten', 0, 'icp_services', '3b', null, true),
    (p_organization_id, 'EU_VERW', 'Verwerving EU (verlegd)', 21, 'eu_acquisition', '4b', '5b', true),
    (p_organization_id, 'EXPORT', 'Export buiten EU (0%)', 0, 'zero', '3a', null, true),
    (p_organization_id, 'IMPORT', 'Invoer buiten EU (verlegd, art. 23)', 21, 'import_non_eu', '4a', '5b', true),
    (p_organization_id, 'KOR', 'KOR (vrijgesteld, geen aftrek)', 0, 'kor', null, null, true)
  on conflict (organization_id, code) do nothing;

  -- Goedkope bestaanscheck eerst (unieke index op organization_id, code), en
  -- daarna pas de module-vraag: in de normale situatie kost dit één indexprobe.
  if v_regime = 'vpb'
     and not exists (
       select 1 from public.ledger_accounts
       where organization_id = p_organization_id and code = '0505'
     )
     and public.org_has_business(p_organization_id) then
    perform public.ensure_business_ledger_accounts(p_organization_id);
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 3. De rechtsvorm bewaken bij de bron
--    company_settings gaat via een gewone upsert vanuit de app, dus dit is de
--    enige plek waar een regel kan staan.
-- ------------------------------------------------------------
create or replace function public.enforce_company_legal_form()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_form text;
begin
  if tg_op = 'UPDATE' then
    v_old_form := old.legal_form;
  else
    -- De app schrijft met een UPSERT. Postgres vuurt dan éérst de BEFORE
    -- INSERT-tak, ook als de rij allang bestaat en er niets aan de rechtsvorm
    -- verandert. Zonder deze opzoeking zou een BV met een verlopen abonnement
    -- zichzelf buitensluiten uit zijn eigen bedrijfsgegevens zodra hij een
    -- adres wil bijwerken.
    select cs.legal_form into v_old_form
    from public.company_settings cs
    where cs.organization_id = new.organization_id;
  end if;

  -- Alleen de OVERGANG naar een Vpb-rechtsvorm is gebonden aan de module.
  -- Blijft de rechtsvorm ongewijzigd, dan mag de rij altijd opgeslagen worden:
  -- een klant van wie het abonnement verloopt moet zijn adres en KvK-nummer
  -- kunnen blijven bijwerken, en de administratie zelf blijft in de
  -- respijtperiode gewoon leesbaar.
  if new.legal_form is not distinct from v_old_form then
    return new;
  end if;

  if new.legal_form in ('bv', 'nv', 'cooperatie')
     and not public.org_has_business(new.organization_id) then
    raise exception 'Boekhouden voor een BV, NV of coöperatie hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists company_settings_legal_form_guard on public.company_settings;
create trigger company_settings_legal_form_guard
  before insert or update of legal_form on public.company_settings
  for each row execute function public.enforce_company_legal_form();

commit;
