-- ============================================================
-- ResoFly — Zakelijke module fase 1a: BV-rekeningschema + balansrubrieken
-- Date: 2026-08-07
--
-- Aanleiding:
-- Fase 0 (20260807000000) gaf elke administratie een rechtsvorm en zette
-- organisaties in een boom. Het rekeningschema is nog dat van een IB-ondernemer:
-- één "0500 Eigen vermogen", geen aandelenkapitaal, geen reserves, geen
-- vennootschapsbelasting. En de balans is een platte lijst rekeningen die de UI
-- in twee kolommen zet; een BV-balans hoort ingedeeld te zijn volgens Titel 9
-- Boek 2 BW. Deze migratie doet beide. Roadmap: BV_VPB_MODULE_ROADMAP_2026-08-06.md.
--
-- Twee kernbeslissingen:
--
-- 1. RUBRIEK OP DE REKENING, NIET IN DE RAPPORTAGE.
--    De indeling van de balans (art. 2:364 BW) en van de winst- en verliesrekening
--    (art. 2:377 BW) hangt aan de rekening zelf, in een nieuwe kolom
--    ledger_accounts.report_group. Afleiden uit `type` + `subtype` op het moment
--    van rapporteren zou betekenen dat de gebruiker zijn eigen rekeningen nooit
--    goed kan indelen — en juist daar zit het verschil tussen een voorziening en
--    een langlopende schuld, dat wij niet kunnen raden.
--    Bestaande rekeningen worden éénmalig gerubriceerd op basis van hun subtype
--    en code, zodat elke administratie meteen een ingedeelde balans heeft.
--
-- 2. HET BV-SCHEMA KOMT ER ALLEEN BIJ ALS DE RECHTSVORM DAAROM VRAAGT.
--    ensure_default_ledger_accounts wordt rechtsvormbewust, maar er is GEEN
--    backfill: een bestaande eenmanszaak krijgt nooit met terugwerkende kracht
--    aandelenkapitaal en dividendbelasting in haar grootboek. Zet iemand de
--    rechtsvorm bewust op BV, dan verschijnen de BV-rekeningen er wél bij — dat
--    is precies wat je dan wilt. De naam van een bestaande 0500 blijft ongemoeid
--    (on conflict do nothing), zodat een lopende administratie niet ineens een
--    andere rekeningnaam onder haar boekingen krijgt.
--
-- LET OP — post_journal_entry roept ensure_default_ledger_accounts aan bij ELKE
-- boeking. De BV-tak is daarom afgeschermd met een goedkope bestaanscheck op
-- code '0505'; in de normale situatie kost dat één indexprobe.
--
-- Juridische grondslag van de rubrieken:
--   Balans   — art. 2:364 BW (hoofdindeling), art. 2:373 BW (eigen vermogen),
--              art. 2:375 BW (schulden, looptijd) en Model A van het Besluit
--              modellen jaarrekening.
--   W&V      — art. 2:377 BW en Model E (categoriale indeling). Sinds de
--              Uitvoeringswet richtlijn jaarrekening (Stb. 2015, 349/350) kent
--              het model geen buitengewone baten en lasten meer; de subtotalen
--              heten "Resultaat voor belastingen" en "Resultaat na belastingen".
--   Het aandeel in het resultaat van deelnemingen staat in Model E bewust NÁ de
--   belastingregel — vandaar een eigen rubriek met een rang achter 'belastingen'.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Rubriek op de grootboekrekening
-- ------------------------------------------------------------
alter table public.ledger_accounts
  add column if not exists report_group text;

comment on column public.ledger_accounts.report_group is
  'Rubriek in de balans of de winst- en verliesrekening volgens Titel 9 Boek 2 BW. Null = nog niet ingedeeld; de rekening valt dan in de restgroep onderaan het overzicht.';

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.ledger_accounts'::regclass
      and conname = 'ledger_accounts_report_group_check'
  ) then
    alter table public.ledger_accounts drop constraint ledger_accounts_report_group_check;
  end if;
  alter table public.ledger_accounts
    add constraint ledger_accounts_report_group_check
    check (report_group is null or report_group in (
      -- Activa (art. 2:364 lid 3 BW)
      'immateriele_vaste_activa',
      'materiele_vaste_activa',
      'financiele_vaste_activa',
      'voorraden',
      'vorderingen',
      'effecten',
      'liquide_middelen',
      -- Passiva (art. 2:364 lid 4 BW; de splitsing lang/kort volgt art. 2:375 lid 2)
      'eigen_vermogen',
      'voorzieningen',
      'langlopende_schulden',
      'kortlopende_schulden',
      -- Winst- en verliesrekening (art. 2:377 lid 3 BW, Model E)
      'netto_omzet',
      'overige_bedrijfsopbrengsten',
      'inkoopwaarde',
      'personeelskosten',
      'afschrijvingen',
      'overige_bedrijfskosten',
      'financiele_baten',
      'financiele_lasten',
      'belastingen',
      'resultaat_deelnemingen'
    ));
end $$;

-- Vaste volgorde van de rubrieken. Staat in de database zodat élke rapport-RPC
-- dezelfde volgorde aanhoudt, ook de exports die later nog bijkomen. Immutable,
-- zodat de planner hem in een order by mag inlijnen.
create or replace function public.ledger_report_group_rank(p_group text)
returns integer
language sql
immutable
as $$
  select case p_group
    when 'immateriele_vaste_activa'   then 10
    when 'materiele_vaste_activa'     then 20
    when 'financiele_vaste_activa'    then 30
    when 'voorraden'                  then 40
    when 'vorderingen'                then 50
    when 'effecten'                   then 60
    when 'liquide_middelen'           then 70
    when 'eigen_vermogen'             then 110
    when 'voorzieningen'              then 120
    when 'langlopende_schulden'       then 130
    when 'kortlopende_schulden'       then 140
    when 'netto_omzet'                then 210
    when 'overige_bedrijfsopbrengsten' then 220
    when 'inkoopwaarde'               then 230
    when 'personeelskosten'           then 240
    when 'afschrijvingen'             then 250
    when 'overige_bedrijfskosten'     then 260
    when 'financiele_baten'           then 270
    when 'financiele_lasten'          then 280
    when 'belastingen'                then 290
    -- Model E zet het aandeel in het resultaat van deelnemingen ná de
    -- belastingregel, tussen "Resultaat voor belastingen" en "Resultaat na
    -- belastingen". Vandaar een rang achter 'belastingen'.
    when 'resultaat_deelnemingen'     then 300
    else 999
  end;
$$;

comment on function public.ledger_report_group_rank(text) is
  'Volgorde van de balans- en W&V-rubrieken volgens Model A en Model E van het Besluit modellen jaarrekening. Niet-ingedeelde rekeningen sorteren achteraan.';

-- ------------------------------------------------------------
-- 1b. Beperkt uitkeerbare reserve
--     De balanstest van art. 2:216 lid 1 BW mag alleen uitkeren "voor zover het
--     eigen vermogen groter is dan de reserves die krachtens de wet of de
--     statuten moeten worden aangehouden". Een WETTELIJKE reserve zetten wij
--     zelf klaar (0530), maar een STATUTAIRE reserve staat in de statuten van
--     déze BV en kan alleen de gebruiker aanwijzen. Zonder een expliciet vakje
--     zou zo'n reserve stilzwijgend als vrij uitkeerbaar meetellen en zou de
--     toets een te hoog dividend goedkeuren.
-- ------------------------------------------------------------
alter table public.ledger_accounts
  add column if not exists is_restricted_reserve boolean not null default false;

comment on column public.ledger_accounts.is_restricted_reserve is
  'Reserve die wettelijk of statutair moet worden aangehouden en dus niet uitkeerbaar is (balanstest art. 2:216 lid 1 BW).';

-- ------------------------------------------------------------
-- 2. Bestaande rekeningen éénmalig rubriceren
--    Dit is een PRESENTATIEkolom: er verandert geen enkel saldo en geen enkele
--    boeking. Zonder deze backfill zou elke bestaande administratie een lege
--    indeling zien terwijl haar rekeningschema prima te rubriceren is.
--    Alleen rijen die nog geen rubriek hebben, zodat een handmatige correctie
--    een herhaalde run overleeft.
--
--    De audittrigger gaat er even uit: hij schrijft per rekening een regel
--    "Bijgewerkt · <rekening>" zonder actor, en dat zou de activiteitenlijst en
--    het dashboard van élke bestaande administratie in één klap vullen met
--    ruis over een kolom die de gebruiker nooit heeft aangeraakt.
-- ------------------------------------------------------------
alter table public.ledger_accounts disable trigger ledger_accounts_audit;

update public.ledger_accounts la
set report_group = case
  -- Eerst op subtype: dat is de betekenis die de boekhoudmotor zelf toekent.
  when la.subtype in ('fixed_asset', 'accumulated_depreciation') then 'materiele_vaste_activa'
  when la.subtype = 'bank'                                       then 'liquide_middelen'
  -- Kruisposten Mollie/PSP: geld dat al binnen is maar nog bij de betaalprovider
  -- staat, is een vordering op die provider — geen liquide middel.
  when la.subtype in ('accounts_receivable', 'vat_input', 'psp_clearing') then 'vorderingen'
  when la.subtype in ('accounts_payable', 'vat_output', 'vat_reverse', 'vat_payable') then 'kortlopende_schulden'
  when la.subtype = 'sales'                                      then 'netto_omzet'
  when la.subtype = 'depreciation'                               then 'afschrijvingen'
  -- Daarna op hoofdsoort; binnen activa/passiva scheidt de 0-reeks vast van
  -- vlottend, precies zoals het rekeningschema is opgebouwd. Testen op het
  -- eerste teken en niet op `code < '1000'`: dat laatste is een TEKST-
  -- vergelijking, waardoor een korte code als '05' of '300' ook kleiner is dan
  -- '1000' en per ongeluk als vast actief zou worden gerubriceerd.
  when la.type = 'equity'                                        then 'eigen_vermogen'
  when la.type = 'revenue'                                       then 'netto_omzet'
  when la.type = 'asset'     then case when left(la.code, 1) = '0' then 'materiele_vaste_activa' else 'vorderingen' end
  when la.type = 'liability' then case when left(la.code, 1) = '0' then 'langlopende_schulden'  else 'kortlopende_schulden' end
  else 'overige_bedrijfskosten'
end
where la.report_group is null;

alter table public.ledger_accounts enable trigger ledger_accounts_audit;

-- ------------------------------------------------------------
-- 3. Het BV-rekeningschema
--    Los van ensure_default_ledger_accounts zodat de basis-seed onaangeroerd
--    blijft en de BV-tak in één oogopslag te lezen is.
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

  -- De rechtsvormcheck staat ook HIER en niet alleen bij de aanroeper: dertien
  -- van deze rekeningen zijn systeemrekeningen, en die kan de gebruiker niet
  -- meer verwijderen. Belandden ze per ongeluk in het schema van een
  -- eenmanszaak, dan zit die er voorgoed mee.
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'Het BV-rekeningschema hoort bij een BV, NV of coöperatie. Pas eerst de rechtsvorm aan bij Instellingen → Bedrijfsgegevens.'
      using errcode = '23514';
  end if;

  insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group, is_restricted_reserve)
  values
    -- Vaste activa die een BV wél heeft en een eenmanszaak zelden.
    (p_organization_id, '0020', 'Immateriële vaste activa', 'asset', 'intangible_asset', null, true, 'immateriele_vaste_activa', false),
    -- "Afschrijving", niet "amortisatie": art. 2:386 lid 4 BW en Model E kennen
    -- één woord voor immateriële én materiële vaste activa.
    (p_organization_id, '0025', 'Cumulatieve afschrijving immateriële vaste activa', 'asset', 'accumulated_amortization', null, true, 'immateriele_vaste_activa', false),
    (p_organization_id, '0300', 'Deelnemingen', 'asset', 'participation', null, true, 'financiele_vaste_activa', false),
    (p_organization_id, '0310', 'Vorderingen op groepsmaatschappijen', 'asset', 'group_receivable', null, false, 'financiele_vaste_activa', false),
    (p_organization_id, '0350', 'Latente belastingvordering', 'asset', 'deferred_tax_asset', null, false, 'financiele_vaste_activa', false),

    -- Eigen vermogen van een kapitaalvennootschap (art. 2:373 lid 1 BW).
    -- 0500 en 0510 staan al in de basis-seed; hier alleen wat een BV extra kent.
    (p_organization_id, '0505', 'Agio', 'equity', 'share_premium', null, true, 'eigen_vermogen', false),
    (p_organization_id, '0520', 'Overige reserves', 'equity', 'other_reserves', null, true, 'eigen_vermogen', false),
    -- Een wettelijke reserve mag niet worden uitgekeerd; is_restricted_reserve
    -- houdt hem buiten de balanstest van art. 2:216 lid 1 BW. Een STATUTAIRE
    -- reserve staat in de statuten van deze BV — die maakt de gebruiker zelf aan
    -- en vinkt hij daar aan.
    (p_organization_id, '0530', 'Wettelijke reserves', 'equity', 'legal_reserve', null, true, 'eigen_vermogen', true),

    -- Voorzieningen en langlopend.
    (p_organization_id, '0600', 'Voorzieningen', 'liability', 'provision', null, false, 'voorzieningen', false),
    (p_organization_id, '0610', 'Voorziening latente belastingverplichting', 'liability', 'deferred_tax_liability', null, false, 'voorzieningen', false),
    (p_organization_id, '0700', 'Langlopende schulden', 'liability', 'long_term_debt', null, false, 'langlopende_schulden', false),
    (p_organization_id, '0710', 'Lening o/g DGA', 'liability', 'dga_loan', null, false, 'langlopende_schulden', false),

    -- Rekening-courant DGA. Het saldo mag beide kanten op; wij zetten hem onder
    -- de vorderingen omdat dat de gebruikelijke stand is (de DGA staat rood bij
    -- zijn eigen BV). Slaat het saldo om, dan hoort hij in de jaarrekening naar
    -- de schulden — dat is een presentatiekeuze bij het opmaken, geen boeking.
    (p_organization_id, '1400', 'Rekening-courant DGA', 'asset', 'dga_current_account', null, true, 'vorderingen', false),

    -- Vennootschapsbelasting: de reservering, de voorlopige aanslagen en de
    -- afrekening lopen alle drie over eigen rekeningen (fase 2 boekt hierop).
    (p_organization_id, '1540', 'Te betalen vennootschapsbelasting', 'liability', 'corporate_tax_payable', null, true, 'kortlopende_schulden', false),
    (p_organization_id, '1545', 'Betaalde voorlopige aanslagen Vpb', 'asset', 'corporate_tax_prepaid', null, true, 'vorderingen', false),

    -- Loonheffingen. Wij voeren géén salarisadministratie; dit zijn de
    -- tegenrekeningen voor de journaalpost van de salarisverwerker (fase 3).
    (p_organization_id, '1550', 'Te betalen loonheffingen', 'liability', 'payroll_tax_payable', null, true, 'kortlopende_schulden', false),
    (p_organization_id, '1555', 'Te betalen pensioenpremies', 'liability', 'pension_payable', null, false, 'kortlopende_schulden', false),
    (p_organization_id, '1570', 'Nettolonen te betalen', 'liability', 'net_wages_payable', null, false, 'kortlopende_schulden', false),

    -- Dividend: de schuld aan de aandeelhouder en de in te houden
    -- dividendbelasting (fase 4 vult de aangifte, fase 1 boekt alleen de schuld).
    (p_organization_id, '1560', 'Te betalen dividendbelasting', 'liability', 'dividend_tax_payable', null, true, 'kortlopende_schulden', false),
    (p_organization_id, '1580', 'Te betalen dividend', 'liability', 'dividend_payable', null, true, 'kortlopende_schulden', false),

    -- Loonkosten. Het DGA-loon hoort hier: bij een BV is de directeur werknemer,
    -- niet ondernemer — er bestaat geen privé-opname.
    (p_organization_id, '4100', 'Brutolonen', 'expense', 'wages', null, false, 'personeelskosten', false),
    (p_organization_id, '4110', 'Sociale lasten', 'expense', 'social_charges', null, false, 'personeelskosten', false),
    (p_organization_id, '4120', 'Pensioenlasten', 'expense', 'pension_charges', null, false, 'personeelskosten', false),

    -- Financiële baten en lasten: in Model E een eigen blok ná de bedrijfslasten.
    -- Rente is geen omzet voor de omzetbelasting; de aangifte-berekening laat
    -- deze rubrieken daarom buiten beschouwing (zie punt 6 hieronder).
    (p_organization_id, '9000', 'Rentebaten en soortgelijke opbrengsten', 'revenue', 'interest_income', 'VRIJ', false, 'financiele_baten', false),
    (p_organization_id, '9100', 'Rentelasten en soortgelijke kosten', 'expense', 'interest_expense', 'VRIJ', false, 'financiele_lasten', false),

    -- Vennootschapsbelasting staat in de W&V ONDER het bedrijfsresultaat, als
    -- aparte regel tussen "Resultaat voor belastingen" en "Resultaat na
    -- belastingen". Daarom een eigen rubriek en niet 'overige_bedrijfskosten'.
    (p_organization_id, '9900', 'Vennootschapsbelasting', 'expense', 'corporate_tax', null, true, 'belastingen', false)
  on conflict (organization_id, code) do nothing;
end;
$$;

-- Ook anon en authenticated expliciet noemen: Supabase zet via ALTER DEFAULT
-- PRIVILEGES een échte grant op elke nieuwe functie in schema public, en
-- "revoke ... from public" haalt alleen het PUBLIC-recht weg — die losse grant
-- aan anon blijft dan gewoon staan.
-- Geen grant aan authenticated: alleen ensure_default_ledger_accounts roept dit
-- aan, en die draait als eigenaar. Zo is het BV-schema niet los aan te roepen.
revoke all on function public.ensure_business_ledger_accounts(uuid) from public, anon, authenticated;
grant execute on function public.ensure_business_ledger_accounts(uuid) to service_role;

-- ------------------------------------------------------------
-- 4. ensure_default_ledger_accounts: rechtsvormbewust + rubrieken
--    Volledige seed opnieuw (create or replace, nieuwste wint); basis is
--    20260724100000 blok "autobook revenue chain".
-- ------------------------------------------------------------
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

  -- Bij een BV is 0500 het gestorte aandelenkapitaal, niet "eigen vermogen" als
  -- verzamelpost. Alleen relevant voor een NIEUWE administratie: een bestaande
  -- 0500 blijft door de on conflict-clausule ongemoeid, inclusief haar naam.
  --
  -- Het subtype verschilt mee, en dat is niet alleen cosmetisch: bij een NV is
  -- het gestorte kapitaal een ondergrens voor een uitkering (art. 2:105 lid 2
  -- BW), en org_distributable_equity herkent het aan 'share_capital'. Een
  -- BESTAANDE 0500 houdt subtype 'equity' — daar is create_opening_balance
  -- namelijk ook de sluitpost van de beginbalans op kwijtgeraakt, en die is
  -- géén aandelenkapitaal. Die administratie krijgt dus de mildere toets; de
  -- gebruiker kan 0500 desgewenst zelf als beperkt uitkeerbaar aanvinken.
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

  -- De BV-tak. post_journal_entry komt hier bij ELKE boeking langs, dus eerst een
  -- goedkope bestaanscheck op de unieke index (organization_id, code): staat 0505
  -- er al, dan is het schema compleet en doen we niets.
  if v_regime = 'vpb' and not exists (
    select 1 from public.ledger_accounts
    where organization_id = p_organization_id and code = '0505'
  ) then
    perform public.ensure_business_ledger_accounts(p_organization_id);
  end if;
end;
$$;

-- Bewust GEEN backfill van BV-rekeningen naar bestaande administraties: die
-- staan vandaag allemaal op 'eenmanszaak' en horen niet ongevraagd met
-- aandelenkapitaal en dividendbelasting in hun grootboek te eindigen.

-- ------------------------------------------------------------
-- 5. Rapport-RPC's: de rubriek meegeven
--    De OUT-kolommen wijzigen, dus drop + create (Postgres weigert een replace
--    die de returnkolommen verandert). Beide functies hebben nooit een expliciete
--    grant gehad en draaien op de Postgres-default (execute voor PUBLIC); na een
--    drop+create geldt diezelfde default weer, dus de rechten blijven gelijk.
--    De autorisatie zit hoe dan ook in de can_read_org-check in de body.
-- ------------------------------------------------------------
drop function if exists public.report_profit_and_loss(uuid, date, date);
create function public.report_profit_and_loss(
  p_organization_id uuid,
  p_from date,
  p_to date
)
returns table(
  account_id uuid,
  code text,
  name text,
  account_type text,
  report_group text,
  group_rank integer,
  amount_cents bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  return query
    select
      la.id, la.code, la.name, la.type,
      -- Een rekening zonder rubriek belandt in een restgroep: opbrengsten bij de
      -- overige bedrijfsopbrengsten, kosten bij de overige bedrijfskosten. Zo
      -- telt élke rekening mee in het bedrijfsresultaat en kan er nooit een
      -- bedrag buiten de optelling vallen.
      coalesce(la.report_group, case when la.type = 'revenue' then 'overige_bedrijfsopbrengsten' else 'overige_bedrijfskosten' end),
      public.ledger_report_group_rank(coalesce(la.report_group, case when la.type = 'revenue' then 'overige_bedrijfsopbrengsten' else 'overige_bedrijfskosten' end)),
      (case when la.type = 'revenue'
            then sum(jl.credit_cents - jl.debit_cents)
            else sum(jl.debit_cents - jl.credit_cents) end)::bigint
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.source_type <> 'year_close'
      and je.date between p_from and p_to
      and la.type in ('revenue', 'expense')
    group by la.id, la.code, la.name, la.type, la.report_group
    having sum(jl.debit_cents - jl.credit_cents) <> 0
    order by 6, la.code;
end;
$$;

drop function if exists public.report_balance_sheet(uuid, date);
create function public.report_balance_sheet(
  p_organization_id uuid,
  p_as_of date
)
returns table(
  account_id uuid,
  code text,
  name text,
  section text,
  report_group text,
  group_rank integer,
  amount_cents bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  return query
    -- Balansrekeningen. 0510 verschijnt vanzelf als eigen-vermogenrij zodra een
    -- jaar is afgesloten (year_close boekt daar het resultaat naartoe).
    select
      la.id, la.code, la.name, la.type::text,
      -- Zonder rubriek: activa onder de vorderingen, passiva onder de
      -- kortlopende schulden, eigen vermogen bij het eigen vermogen. Nooit
      -- buiten de balans laten vallen — dan klopt het balanstotaal niet meer.
      coalesce(la.report_group, case la.type
        when 'asset' then 'vorderingen'
        when 'equity' then 'eigen_vermogen'
        else 'kortlopende_schulden' end),
      public.ledger_report_group_rank(coalesce(la.report_group, case la.type
        when 'asset' then 'vorderingen'
        when 'equity' then 'eigen_vermogen'
        else 'kortlopende_schulden' end)),
      (case when la.type = 'asset'
            then sum(jl.debit_cents - jl.credit_cents)
            else sum(jl.credit_cents - jl.debit_cents) end)::bigint
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= p_as_of
      and la.type in ('asset', 'liability', 'equity')
    group by la.id, la.code, la.name, la.type, la.report_group
    having sum(jl.debit_cents - jl.credit_cents) <> 0

    union all

    -- Virtuele resultaatregel: alleen het resultaat van NIET-afgesloten boekjaren.
    -- Sluit 'year_close'-boekstukken uit én elke datum die binnen een 'year'-slot
    -- valt (dan zit het resultaat al bestemd in 0510) → geen dubbeltelling.
    select
      null::uuid, null::text, 'Resultaat lopend boekjaar'::text, 'result'::text,
      'eigen_vermogen'::text,
      public.ledger_report_group_rank('eigen_vermogen'),
      coalesce(sum(jl.credit_cents - jl.debit_cents), 0)::bigint
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.source_type <> 'year_close'
      and je.date <= p_as_of
      and la.type in ('revenue', 'expense')
      -- Sluit een afgesloten jaar pas uit zodra de resultaatbestemming óók in het
      -- account-part zit (het year_close-boekstuk valt op period_end): dus alleen als
      -- p_as_of >= period_end. Anders zou het resultaat op een intra-jaars peildatum
      -- uit de virtuele regel verdwijnen terwijl 0510 het nog niet heeft overgenomen.
      and not exists (
        select 1 from public.closed_periods cp
        where cp.organization_id = p_organization_id
          and cp.period_type = 'year'
          and je.date between cp.period_start and cp.period_end
          and p_as_of >= cp.period_end
      )

    -- Op rubriekvolgorde en daarbinnen op rekeningnummer, over de hele unie heen.
    -- De virtuele resultaatregel heeft geen code en sorteert daardoor (nulls last)
    -- onderaan het eigen vermogen — precies waar hij hoort.
    order by 6, 2;
end;
$$;

-- ------------------------------------------------------------
-- 6. Omzetbelasting: financiële baten en lasten zijn geen omzet
--    compute_vat_boxes classificeert een omzetregel ZONDER btw-code op het
--    tarief, en valt bij tarief 0 terug op rubriek 1e. De nieuwe rekening
--    9000 Rentebaten is van het type 'revenue', dus ontvangen rente zonder
--    btw-code zou als omzet 0%/vrijgesteld op de aangifte belanden. Rente,
--    dividend en het resultaat uit deelnemingen zijn geen prestatie voor de
--    omzetbelasting en horen in geen enkele rubriek.
--
--    De functie is LETTERLIJK overgenomen uit 20260723200000; alleen de
--    acc_type-expressie in de CTE `lines` is aangepast. De sentinelwaarde
--    'non_vat' valt buiten elke acc_type-test, terwijl de grootboektotalen
--    (gl_output/gl_reverse/gl_input) over acc_subtype lopen en dus onveranderd
--    blijven — het te betalen bedrag verandert niet, alleen de gerapporteerde
--    omzet klopt weer.
-- ------------------------------------------------------------

create or replace function public.compute_vat_boxes(
  p_organization_id uuid,
  p_from date,
  p_to date,
  p_entry_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r record;
  v_saldo bigint;
  v_saldo_afgerond bigint;
  v_box_vat_total bigint;
  v_consistent boolean;
  v_form_1a bigint; v_form_1b bigint; v_form_1c bigint; v_form_1d bigint;
  v_form_2a bigint; v_form_4a bigint; v_form_4b bigint;
  v_form_5a bigint; v_form_5b bigint; v_form_5c bigint;
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_entry_ids is null and (p_from is null or p_to is null) then
    raise exception 'Periode (van/tot) is verplicht.' using errcode = '23514';
  end if;

  with lines as (
    select
      jl.debit_cents, jl.credit_cents, jl.vat_rate, jl.vat_base_cents, jl.vat_amount_cents,
      -- GEWIJZIGD (20260807020000): financiële baten en lasten en het resultaat
      -- uit deelnemingen zijn geen omzet voor de omzetbelasting. Zonder deze
      -- uitzondering valt rente zonder btw-code hieronder in de terugval op het
      -- tarief en belandt hij in rubriek 1e — omzet op de aangifte die er niet
      -- hoort te staan. De sentinelwaarde valt buiten élke acc_type-test
      -- ('revenue' en ('expense','asset')); de grootboektotalen hieronder lopen
      -- over acc_subtype en blijven dus ongemoeid.
      -- Alleen op de TERUGVAL-tak: een regel MÉT btw-code volgt altijd zijn code.
      -- De rubriek is een presentatiekeuze die de gebruiker vrij mag aanpassen;
      -- zonder deze voorwaarde zou zo'n keuze belaste omzet uit rubriek 1a
      -- kunnen halen terwijl de btw wel op 1510 blijft staan.
      case
        when vc.id is null
         and la.report_group in ('financiele_baten', 'financiele_lasten', 'resultaat_deelnemingen')
          then 'non_vat'
        else la.type
      end as acc_type,
      la.subtype as acc_subtype,
      (vc.id is not null) as has_code, vc.sales_box, vc.vat_box
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    left join public.vat_codes vc
      on vc.organization_id = jl.organization_id and vc.code = jl.vat_code
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and (
        case when p_entry_ids is not null
          then je.id = any(p_entry_ids)
          else (
            je.date between p_from and p_to
            -- Het jaarafsluitboekstuk debiteert omzetrekeningen zonder vat_rate;
            -- zonder dit filter lekt dat als negatieve omzet in rubriek 1e.
            and je.source_type <> 'year_close'
            -- In een suppletie verrekende boekstukken zijn al aangegeven.
            and not exists (
              select 1 from public.vat_supplement_entries vse where vse.entry_id = je.id
            )
          )
        end
      )
  ),
  classified as (
    select
      -- Omzetkant: rubriek voor de grondslag. Mét code: sales_box (kan null
      -- zijn — vrijgesteld/KOR telt in geen enkele rubriek). Zonder code:
      -- terugval op het tarief.
      case when acc_type = 'revenue' then
        case
          when has_code then sales_box
          when coalesce(vat_rate, 0) >= 21 then '1a'
          when coalesce(vat_rate, 0) > 0 then '1b'
          else '1e'
        end
      end as rev_box,
      case when acc_type = 'revenue' then credit_cents - debit_cents else 0 end as rev_base,
      -- Omzetkant: rubriek voor de btw (alleen 1a–1d dragen btw).
      case when acc_type = 'revenue' then
        case
          when has_code then (case when coalesce(vat_box, sales_box) in ('1a','1b','1c','1d') then coalesce(vat_box, sales_box) end)
          when coalesce(vat_rate, 0) >= 21 then '1a'
          when coalesce(vat_rate, 0) > 0 then '1b'
        end
      end as rev_vat_box,
      case when acc_type = 'revenue' then coalesce(vat_amount_cents, 0) else 0 end as rev_vat,
      -- Inkoopkant: 2a (binnenland verlegd) / 4a (invoer) / 4b (EU-verwerving)
      -- van kosten-/activaregels met zo'n code. Richting volgt de boekzijde.
      case when acc_type in ('expense','asset') and has_code and sales_box in ('2a','4a','4b')
        then sales_box end as pur_box,
      case when acc_type in ('expense','asset') and has_code and sales_box in ('2a','4a','4b')
        then (case when debit_cents > 0 then 1 when credit_cents > 0 then -1 else 0 end)
             * coalesce(vat_base_cents, case when debit_cents > 0 then debit_cents else credit_cents end)
        else 0 end as pur_base,
      case when acc_type in ('expense','asset') and has_code and sales_box in ('2a','4a','4b')
        then (case when debit_cents > 0 then 1 when credit_cents > 0 then -1 else 0 end)
             * coalesce(vat_amount_cents, 0)
        else 0 end as pur_vat,
      -- Grootboek-totalen: gezaghebbend voor doorboeking en saldo.
      case when acc_subtype = 'vat_output' then credit_cents - debit_cents else 0 end as gl_output,
      case when acc_subtype = 'vat_reverse' then credit_cents - debit_cents else 0 end as gl_reverse,
      case when acc_subtype = 'vat_input' then debit_cents - credit_cents else 0 end as gl_input
    from lines
  )
  select
    coalesce(sum(rev_base) filter (where rev_box = '1a'), 0) as b1a_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1a'), 0) as b1a_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1b'), 0) as b1b_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1b'), 0) as b1b_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1c'), 0) as b1c_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1c'), 0) as b1c_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1d'), 0) as b1d_base,
    coalesce(sum(rev_vat) filter (where rev_vat_box = '1d'), 0) as b1d_vat,
    coalesce(sum(rev_base) filter (where rev_box = '1e'), 0) as b1e_base,
    coalesce(sum(rev_base) filter (where rev_box = '3a'), 0) as b3a_base,
    coalesce(sum(rev_base) filter (where rev_box = '3b'), 0) as b3b_base,
    coalesce(sum(rev_base) filter (where rev_box = '3c'), 0) as b3c_base,
    coalesce(sum(pur_base) filter (where pur_box = '2a'), 0) as b2a_base,
    coalesce(sum(pur_vat) filter (where pur_box = '2a'), 0) as b2a_vat,
    coalesce(sum(pur_base) filter (where pur_box = '4a'), 0) as b4a_base,
    coalesce(sum(pur_vat) filter (where pur_box = '4a'), 0) as b4a_vat,
    coalesce(sum(pur_base) filter (where pur_box = '4b'), 0) as b4b_base,
    coalesce(sum(pur_vat) filter (where pur_box = '4b'), 0) as b4b_vat,
    coalesce(sum(gl_output), 0) as clear_output,
    coalesce(sum(gl_reverse), 0) as clear_reverse,
    coalesce(sum(gl_input), 0) as clear_input
  into r
  from classified;

  v_saldo := (r.clear_output + r.clear_reverse) - r.clear_input;

  -- Formulierwaarden: hele euro's PER RUBRIEK (rekenkundig, .50 weg van nul —
  -- zoals round(numeric)); 5a is de som van de afgeronde btw-rubrieken en 5c
  -- volgt uit 5a − 5b, precies zoals de Belastingdienst rekent (review 2.9).
  v_form_1a := round(r.b1a_vat::numeric / 100.0)::bigint;
  v_form_1b := round(r.b1b_vat::numeric / 100.0)::bigint;
  v_form_1c := round(r.b1c_vat::numeric / 100.0)::bigint;
  v_form_1d := round(r.b1d_vat::numeric / 100.0)::bigint;
  v_form_2a := round(r.b2a_vat::numeric / 100.0)::bigint;
  v_form_4a := round(r.b4a_vat::numeric / 100.0)::bigint;
  v_form_4b := round(r.b4b_vat::numeric / 100.0)::bigint;
  v_form_5a := v_form_1a + v_form_1b + v_form_1c + v_form_1d + v_form_2a + v_form_4a + v_form_4b;
  v_form_5b := round(r.clear_input::numeric / 100.0)::bigint;
  v_form_5c := v_form_5a - v_form_5b;

  -- Sluiten de rubrieken op het grootboek aan? De btw per rubriek komt uit
  -- regel-metadata (vat_amount_cents); het grootboek (1510+1520) is de waarheid.
  -- Bij een gaaf geboekte administratie zijn die exact gelijk. Wijken ze meer
  -- dan € 1 af (bijv. handmatig op 1510 geboekt zonder metadata), dan is de
  -- rubriekverdeling onvolledig: saldo_afgerond valt dan terug op het oude
  -- gedrag (saldo in één keer afronden) en de UI toont een waarschuwing.
  v_box_vat_total := r.b1a_vat + r.b1b_vat + r.b1c_vat + r.b1d_vat + r.b2a_vat + r.b4a_vat + r.b4b_vat;
  v_consistent := abs(v_box_vat_total - (r.clear_output + r.clear_reverse)) <= 100;

  if v_consistent then
    v_saldo_afgerond := v_form_5c * 100;
  else
    v_saldo_afgerond := round(v_saldo::numeric / 100.0)::bigint * 100;
  end if;

  return jsonb_build_object(
    'boxes', jsonb_build_object(
      '1a', jsonb_build_object('base', r.b1a_base, 'vat', r.b1a_vat),
      '1b', jsonb_build_object('base', r.b1b_base, 'vat', r.b1b_vat),
      '1c', jsonb_build_object('base', r.b1c_base, 'vat', r.b1c_vat),
      '1d', jsonb_build_object('base', r.b1d_base, 'vat', r.b1d_vat),
      '1e', jsonb_build_object('base', r.b1e_base),
      '2a', jsonb_build_object('base', r.b2a_base, 'vat', r.b2a_vat),
      '3a', jsonb_build_object('base', r.b3a_base),
      '3b', jsonb_build_object('base', r.b3b_base),
      '3c', jsonb_build_object('base', r.b3c_base),
      '4a', jsonb_build_object('base', r.b4a_base, 'vat', r.b4a_vat),
      '4b', jsonb_build_object('base', r.b4b_base, 'vat', r.b4b_vat)
    ),
    'form', jsonb_build_object(
      '1a', jsonb_build_object('base', round(r.b1a_base::numeric / 100.0)::bigint, 'vat', v_form_1a),
      '1b', jsonb_build_object('base', round(r.b1b_base::numeric / 100.0)::bigint, 'vat', v_form_1b),
      '1c', jsonb_build_object('base', round(r.b1c_base::numeric / 100.0)::bigint, 'vat', v_form_1c),
      '1d', jsonb_build_object('base', round(r.b1d_base::numeric / 100.0)::bigint, 'vat', v_form_1d),
      '1e', jsonb_build_object('base', round(r.b1e_base::numeric / 100.0)::bigint),
      '2a', jsonb_build_object('base', round(r.b2a_base::numeric / 100.0)::bigint, 'vat', v_form_2a),
      '3a', jsonb_build_object('base', round(r.b3a_base::numeric / 100.0)::bigint),
      '3b', jsonb_build_object('base', round(r.b3b_base::numeric / 100.0)::bigint),
      '3c', jsonb_build_object('base', round(r.b3c_base::numeric / 100.0)::bigint),
      '4a', jsonb_build_object('base', round(r.b4a_base::numeric / 100.0)::bigint, 'vat', v_form_4a),
      '4b', jsonb_build_object('base', round(r.b4b_base::numeric / 100.0)::bigint, 'vat', v_form_4b),
      '5a', v_form_5a, '5b', v_form_5b, '5c', v_form_5c
    ),
    'boxes_consistent', v_consistent,
    'boxes_vat_diff_cents', v_box_vat_total - (r.clear_output + r.clear_reverse),
    -- Bestaande sleutels (oudere UI-versies, bevroren snapshots, bankmatching):
    'omzet_hoog_base', r.b1a_base, 'omzet_hoog_btw', r.b1a_vat,
    'omzet_laag_base', r.b1b_base, 'omzet_laag_btw', r.b1b_vat,
    'omzet_nul_base', r.b1e_base,
    'verlegd_btw', r.clear_reverse,
    'verschuldigd_total', r.clear_output + r.clear_reverse,
    'voorbelasting', r.clear_input,
    'saldo', v_saldo,
    'saldo_afgerond', v_saldo_afgerond,
    'afronding_cents', v_saldo - v_saldo_afgerond,
    'clear_output', r.clear_output,
    'clear_reverse', r.clear_reverse,
    'clear_input', r.clear_input
  );
end;
$$;

-- ------------------------------------------------------------
-- 7. Rechten aantrekken
--    Supabase zet met ALTER DEFAULT PRIVILEGES een échte EXECUTE-grant aan anon
--    én authenticated op elke nieuwe functie in schema public. "revoke ... from
--    public" haalt daar niets van weg. Deze functies controleren allemaal zelf
--    de toegang, dus anon liep tegen een foutmelding aan — maar bereikbaar zijn
--    voor de publieke anon-sleutel hoort niet en kost niets om te sluiten.
-- ------------------------------------------------------------
revoke all on function public.report_profit_and_loss(uuid, date, date) from public, anon;
grant execute on function public.report_profit_and_loss(uuid, date, date) to authenticated, service_role;
revoke all on function public.report_balance_sheet(uuid, date) from public, anon;
grant execute on function public.report_balance_sheet(uuid, date) to authenticated, service_role;
revoke all on function public.compute_vat_boxes(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.compute_vat_boxes(uuid, date, date, uuid[]) to authenticated, service_role;

-- Fase 0 (20260807000000) zette dezelfde revoke-from-public op deze helpers; ze
-- hebben géén eigen toegangscontrole en zijn nog steeds bereikbaar voor anon.
-- Geen enkele client roept ze rechtstreeks aan — de app gebruikt
-- organization_business_status, dat zijn eigen can_read_org-check doet — dus ze
-- kunnen dicht tot service_role. De aanroepen vanuit andere SECURITY DEFINER-
-- functies blijven werken: die draaien als eigenaar.
revoke all on function public.org_legal_form(uuid) from public, anon, authenticated;
grant execute on function public.org_legal_form(uuid) to service_role;
revoke all on function public.org_fiscal_regime(uuid) from public, anon, authenticated;
grant execute on function public.org_fiscal_regime(uuid) to service_role;
revoke all on function public.org_is_corporate(uuid) from public, anon, authenticated;
grant execute on function public.org_is_corporate(uuid) to service_role;
revoke all on function public.org_has_business(uuid) from public, anon, authenticated;
grant execute on function public.org_has_business(uuid) to service_role;
revoke all on function public.org_business_in_grace(uuid) from public, anon, authenticated;
grant execute on function public.org_business_in_grace(uuid) to service_role;
revoke all on function public.org_entity_allowance(uuid) from public, anon, authenticated;
grant execute on function public.org_entity_allowance(uuid) to service_role;
revoke all on function public.org_entity_count(uuid) from public, anon, authenticated;
grant execute on function public.org_entity_count(uuid) to service_role;
revoke all on function public.billing_root_organization(uuid) from public, anon, authenticated;
grant execute on function public.billing_root_organization(uuid) to service_role;
revoke all on function public.org_family(uuid) from public, anon, authenticated;
grant execute on function public.org_family(uuid) to service_role;

commit;
