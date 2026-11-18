-- ============================================================
-- ResoFly — Bank: matchen sneller, en het budget groeit mee met de grens
-- Date: 2026-11-18
--
-- Vraag: "Kunnen we de 3 sec verlengen en snelheid optimaliseren?"
-- Vervolg op 20261118190000_bank_inkoop_automatisch_afletteren.sql.
--
-- Wat er was:
--
--   * Een matchronde boekte hoogstens 3 seconden lang vanzelf. Vast, dus ook
--     voor de bankkoppeling, die 120 seconden heeft (service_role) in plaats
--     van de 8 seconden van de app (authenticated). En het nalopen zelf had
--     geen grens: een achterstand van tienduizenden bankregels liep alsnog
--     tegen de 8 seconden aan, en dan was de hele import weg.
--   * Een boeking kostte ~10 ms, waarvan 5 ms in
--     ensure_default_ledger_accounts: twee keer per boeking het hele
--     rekeningschema invoegen met "on conflict do nothing", waarbij de
--     triggers van ledger_accounts en vat_codes voor elke rij liepen, ook als
--     alles er al stond.
--   * Het nalopen kostte ~0,45 ms per bankregel, ook als er niets kon
--     matchen: per ontvangst een zoekvraag over alle verkoopfacturen, per
--     regel de bankregels, het IBAN-zoeken en het bedrag-zoeken, en twee
--     doorlopen over de inkoopfacturen voor de naam.
--
-- Wat er nu is:
--
--   * De deadline volgt de echte grens: 70% van statement_timeout, gemeten
--     vanaf het begin van de aanroep (statement_timestamp, de klok die
--     PostgREST ook gebruikt), hoogstens 25 seconden. In de app is dat 5,6 s,
--     bij de bankkoppeling 25 s. Geldt voor het hele nalopen, niet alleen voor
--     het boeken: daarna stopt de ronde netjes.
--   * Rondes: de ronde loopt op vaste volgorde (boekdatum, id) en geeft bij
--     een stop next_cursor en remaining terug. De volgende ronde
--     (match_bank_transactions met p_cursor) gaat daar verder. De app doet
--     dat zelf tot alles is nagelopen. Er bestaat dus geen "zeker, maar nog
--     niet geboekt" meer: wat nog niet is nagelopen, komt in de volgende
--     ronde aan de beurt.
--   * ensure_default_ledger_accounts kijkt eerst of de codes er al zijn. Is
--     dat zo, dan doet "on conflict do nothing" niets; de uitkomst is
--     dezelfde, het werk is weg.
--   * Vooraf, één keer per ronde: de verkoopfacturen met een nummer, of er
--     bankregels zijn, en de openstaande bedragen. Per bankregel alleen nog
--     zoeken waar iets kan passen; de namen in één doorloop.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Het rekeningschema: niet invoegen wat er al staat ────────────────────
-- Gelijk aan 20261118090000, met de bestaanscontroles (TOEGEVOEGD).
create or replace function public.ensure_default_ledger_accounts(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_regime text;
  v_equity_name text;
  v_equity_subtype text;
  -- TOEGEVOEGD (20261118200000): staan ze er al, dan niet nog eens invoegen.
  v_codes text[] := array['0100','0150','0500','0510','1100','1102','1300','1500','1510','1520','1530','1600','4000','4130','4500','4900','8000','8010','8020','8030'];
  v_prive text[] := array['0550','0560'];
  v_ib text[] := array['1000','4100','4200','4300','4400','4600','4700','7000'];
  v_btw text[] := array['HOOG','LAAG','NUL','VRIJ','VERL_VERK','VERL_INK','ICP_GOED','ICP_DIENST','EU_VERW','EXPORT','IMPORT','KOR'];
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
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

  -- TOEGEVOEGD (20261118200000): elke bankboeking roept dit twee keer aan
  -- (book_bank_transaction en post_journal_entry). Ook als alles er al
  -- staat, liepen de triggers van ledger_accounts voor elke rij van elke
  -- insert: 5 van de 10 ms van een boeking. Bestaan alle codes al, dan doet
  -- "on conflict do nothing" niets, dus deze controle verandert de uitkomst
  -- niet; hij slaat alleen het werk over.
  if (select count(*) from public.ledger_accounts
      where organization_id = p_organization_id and code = any(v_codes)) < cardinality(v_codes) then
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
  end if;

  -- TOEGEVOEGD (20261104070000): privé-opnamen en -stortingen bij een
  -- IB-onderneming. Herkenning gaat op het subtype, niet op de code: heeft een
  -- administratie 0550 of 0560 al voor iets anders in gebruik, dan blijft die
  -- rekening ongemoeid en telt hij niet als privé.
  if v_regime = 'ib' and (select count(*) from public.ledger_accounts
      where organization_id = p_organization_id and code = any(v_prive)) < cardinality(v_prive) then
    insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
    values
      (p_organization_id, '0550', 'Privé-opnamen', 'equity', 'private_withdrawals', null, true, 'eigen_vermogen'),
      (p_organization_id, '0560', 'Privé-stortingen', 'equity', 'private_contributions', null, true, 'eigen_vermogen')
    on conflict (organization_id, code) do nothing;
  end if;
  -- TOEGEVOEGD (20261118090000): kas en de kosten in de indeling van de
  -- aangifte inkomstenbelasting (zie de toelichting boven deze functie).
  -- Geen systeemrekeningen: naam, btw-code en actief blijven vrij.
  if v_regime = 'ib' and (select count(*) from public.ledger_accounts
      where organization_id = p_organization_id and code = any(v_ib)) < cardinality(v_ib) then
    perform public.ensure_ib_ledger_accounts(p_organization_id);
  end if;

  if (select count(*) from public.vat_codes
      where organization_id = p_organization_id and code = any(v_btw)) < cardinality(v_btw) then
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
  end if;

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
$function$;

-- ── 2. Verkoopfacturen één keer per ronde ───────────────────────────────────
-- Een geboekte verkoopfactuur met een nummer, zoals de matcher hem per
-- ontvangst zocht. Een vast rijtype, net als bank_open_purchase_invoice.
do $$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'bank_sales_invoice_ref'
  ) then
    create type public.bank_sales_invoice_ref as (
      id uuid,
      number text,
      number_norm text,
      total_cents bigint,
      date date
    );
  end if;
end $$;

-- ── 3. Eén transactie tegen de openstaande inkoopfacturen ───────────────────
-- Gelijk aan 20261118190000, behalve (GEWIJZIGD) de naam als tegenpartij en
-- in de omschrijving in één doorloop, en de namen pas uitgerekend als het
-- nodig is.
drop function if exists public.bank_purchase_match(public.bank_transactions, text, public.bank_open_purchase_invoice[], jsonb, uuid[], text);

-- p_name_tokens (TOEGEVOEGD 20261118200000): alle woorden van de namen van
-- leveranciers met iets openstaand, als jsonb-object. Elke naamtreffer
-- (gelijk, de naam in de tekst, de tekst in de naam) deelt minstens één woord
-- met die namen; zonder gedeeld woord hoeft de doorloop niet.
create or replace function public.bank_purchase_match(
  p_txn public.bank_transactions,
  p_haystack text,
  p_open public.bank_open_purchase_invoice[],
  p_ibans jsonb,
  p_claimed uuid[],
  p_mode text,
  p_name_tokens jsonb default null
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_need bigint := abs(p_txn.amount_cents);
  -- Wat een stuk "van nature" krijgt in de richting van de transactie: bij een
  -- betaling het openstaande bedrag (een creditnota is dan negatief), bij een
  -- ontvangst het omgekeerde.
  v_flip integer := case when p_txn.amount_cents < 0 then 1 else -1 end;
  v_iban text := public.bank_norm_iban(p_txn.counterparty_iban);
  -- GEWIJZIGD (20261118200000): pas uitgerekend als het nodig is (niet bij
  -- 'amount'); twee keer regex per bankregel telde op.
  v_cp text;
  v_desc text;
  v_names uuid[];
  v_descs uuid[];
  v_cp_pad text;
  v_desc_pad text;
  v_rows jsonb;
  v_n integer;
  v_sum bigint;
  v_left bigint;
  v_take bigint;
  v_allocs jsonb;
  v_labels text;
  r record;
  v_sup_iban uuid;
  v_sup_name uuid;
  v_sup_desc uuid;
  v_ref_sup uuid;
  v_ref_ok boolean;
  v_try record;
  v_cands jsonb;
  v_exact integer;
  v_pick record;
  v_running bigint;
  v_k integer;
begin
  if v_need = 0 or p_open is null or cardinality(p_open) = 0 then
    return null;
  end if;

  -- ── Alleen het bedrag ─────────────────────────────────────────────────────
  if p_mode = 'amount' then
    select count(*) into v_n
    from unnest(p_open) c
    where c.open_cents * v_flip = v_need
      and p_txn.booking_date between c.date - 30 and c.date + 365;
    if v_n <> 1 then
      return null;
    end if;
    select c.id, c.supplier_id, c.supplier_name, c.label into r
    from unnest(p_open) c
    where c.open_cents * v_flip = v_need
      and p_txn.booking_date between c.date - 30 and c.date + 365;
    -- Hing die ene factuur in deze ronde al aan een andere betaling, dan niet
    -- nog eens: twee betalingen van € 50 en één factuur van € 50 is twijfel.
    if r.id = any(coalesce(p_claimed, '{}'::uuid[])) then
      return null;
    end if;
    return jsonb_build_object(
      'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', r.id, 'amount_cents', v_need)),
      'certain', false,
      'confidence', 'purchase_amount',
      'supplier_id', r.supplier_id,
      'reason', format('Alleen het bedrag past: inkoopfactuur %s%s staat precies zo open. Controleer het voordat je boekt.',
                       r.label, coalesce(' van ' || r.supplier_name, ''))
    );
  end if;

  -- Wie is de tegenpartij? Op IBAN (alleen als dat IBAN bij precies één
  -- leverancier hoort), op de naam van de tegenpartij, en op de naam in de
  -- omschrijving. Voor de naam tellen alleen leveranciers met iets openstaand
  -- in deze richting. Een naam telt als hele woorden: "kpn" in "kpn mobile",
  -- niet "ns" in "nsinternational"; in een omschrijving pas vanaf vier tekens.
  if v_iban is not null and coalesce(p_ibans ->> v_iban, '') <> '' then
    v_sup_iban := (p_ibans ->> v_iban)::uuid;
  end if;
  -- GEWIJZIGD (20261118200000): naam als tegenpartij en naam in de
  -- omschrijving in één doorloop over de facturen in plaats van twee.
  v_cp := public.bank_name_norm(p_txn.counterparty_name);
  v_desc := public.bank_name_norm(coalesce(p_txn.description, '') || ' ' || coalesce(p_txn.structured_reference, ''));
  if (v_cp is not null or v_desc is not null)
     and (p_name_tokens is null
          or exists (select 1 from unnest(string_to_array(coalesce(v_cp, '') || ' ' || coalesce(v_desc, ''), ' ')) as w
                     where w <> '' and p_name_tokens ? w)) then
    v_cp_pad := ' ' || coalesce(v_cp, '') || ' ';
    v_desc_pad := ' ' || coalesce(v_desc, '') || ' ';
    select array_agg(distinct c.supplier_id) filter (where
             v_cp is not null
             and ((length(c.name_norm) >= 2 and c.name_norm = v_cp)
                  or (length(c.name_norm) >= 3 and strpos(v_cp_pad, ' ' || c.name_norm || ' ') > 0)
                  or (length(v_cp) >= 4 and strpos(' ' || c.name_norm || ' ', v_cp_pad) > 0))),
           array_agg(distinct c.supplier_id) filter (where
             v_desc is not null
             and length(c.name_norm) >= 4 and strpos(v_desc_pad, ' ' || c.name_norm || ' ') > 0)
    into v_names, v_descs
    from unnest(p_open) c
    where c.supplier_id is not null and c.open_cents * v_flip > 0 and c.name_norm is not null
      and ((v_cp is not null
            and ((length(c.name_norm) >= 2 and c.name_norm = v_cp)
                 or (length(c.name_norm) >= 3 and strpos(v_cp_pad, ' ' || c.name_norm || ' ') > 0)
                 or (length(v_cp) >= 4 and strpos(' ' || c.name_norm || ' ', v_cp_pad) > 0)))
           or (v_desc is not null
               and length(c.name_norm) >= 4 and strpos(v_desc_pad, ' ' || c.name_norm || ' ') > 0));
    v_sup_name := case when cardinality(v_names) = 1 then v_names[1] end;
    v_sup_desc := case when cardinality(v_descs) = 1 then v_descs[1] end;
  end if;
  v_ref_sup := coalesce(v_sup_iban, v_sup_name);

  -- ── Het nummer in de omschrijving ────────────────────────────────────────
  -- Op volgorde van noemen. Een factuur en een creditnota van de leverancier
  -- in één betaling mogen samen: dan is de creditnota negatief. Twee
  -- leveranciers kunnen hetzelfde factuurnummer gebruiken: is de tegenpartij
  -- bekend en noemt de omschrijving een factuur van hem, dan alleen die van hem.
  if length(coalesce(p_haystack, '')) >= 3 then
    with genoemd as (
      select x.id, x.label, x.supplier_id, x.natural, x.pos
      from (
        -- Eerst goedkoop: staat de tekst er letterlijk in? Pas dan de
        -- strengere controle (los kenmerk, niet "42" in "4211").
        select c.id, c.label, c.supplier_id, c.open_cents * v_flip as natural,
               least(
                 case when strpos(p_haystack, c.ref1_norm) > 0 and public.bank_text_mentions_reference(p_haystack, c.ref1) then strpos(p_haystack, c.ref1_norm) end,
                 case when strpos(p_haystack, c.ref2_norm) > 0 and public.bank_text_mentions_reference(p_haystack, c.ref2) then strpos(p_haystack, c.ref2_norm) end,
                 case when strpos(p_haystack, c.ref3_norm) > 0 and public.bank_text_mentions_reference(p_haystack, c.ref3) then strpos(p_haystack, c.ref3_norm) end
               ) as pos
        from unnest(p_open) c
        where strpos(p_haystack, c.ref1_norm) > 0
           or strpos(p_haystack, c.ref2_norm) > 0
           or strpos(p_haystack, c.ref3_norm) > 0
      ) x
      where x.pos is not null
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'label', m.label, 'natural', m.natural, 'supplier_id', m.supplier_id) order by m.pos), '[]'::jsonb),
           count(*), coalesce(sum(m.natural), 0),
           -- Zeker alleen als het geld naar het IBAN van die leverancier ging,
           -- of als het IBAN niemand van ons zegt.
           v_sup_iban is null or bool_and(m.supplier_id is not distinct from v_sup_iban)
    into v_rows, v_n, v_sum, v_ref_ok
    from genoemd m
    where v_ref_sup is null
       or m.supplier_id = v_ref_sup
       or not exists (select 1 from genoemd g where g.supplier_id = v_ref_sup);
  else
    v_n := 0;
  end if;

  if v_n = 1 and (v_rows -> 0 ->> 'natural')::bigint > 0 then
    v_take := (v_rows -> 0 ->> 'natural')::bigint;
    if v_take = v_need then
      return jsonb_build_object(
        'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_rows -> 0 ->> 'id', 'amount_cents', v_need)),
        'certain', coalesce(v_ref_ok, false), 'confidence', 'purchase_invoice', 'supplier_id', v_rows -> 0 -> 'supplier_id',
        'reason', format('Factuurnummer %s staat in de omschrijving en het bedrag klopt.', v_rows -> 0 ->> 'label')
          || case when coalesce(v_ref_ok, false) then '' else ' Het rekeningnummer hoort bij een andere leverancier; controleer het voordat je boekt.' end);
    elsif v_take > v_need then
      return jsonb_build_object(
        'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_rows -> 0 ->> 'id', 'amount_cents', v_need)),
        'certain', false, 'confidence', 'purchase_invoice', 'supplier_id', v_rows -> 0 -> 'supplier_id',
        'reason', format('Factuurnummer %s staat in de omschrijving. Er staat %s open, dus dit lijkt een deelbetaling.',
                         v_rows -> 0 ->> 'label', public.bank_eur(v_take)));
    else
      return jsonb_build_object(
        'allocations', jsonb_build_array(
          jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_rows -> 0 ->> 'id', 'amount_cents', v_take),
          jsonb_build_object('kind', 'ledger', 'amount_cents', v_need - v_take)),
        'certain', false, 'confidence', 'purchase_invoice', 'supplier_id', v_rows -> 0 -> 'supplier_id',
        'reason', format('Factuurnummer %s staat in de omschrijving, maar de betaling is %s hoger dan wat er openstaat (%s). Kies een rekening voor de rest.',
                         v_rows -> 0 ->> 'label', public.bank_eur(v_need - v_take), public.bank_eur(v_take)));
    end if;
  elsif v_n >= 2 then
    select string_agg(e ->> 'label', ', ') into v_labels from jsonb_array_elements(v_rows) e;
    if v_sum = v_need and exists (select 1 from jsonb_array_elements(v_rows) e where (e ->> 'natural')::bigint > 0) then
      select jsonb_agg(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', e ->> 'id', 'amount_cents', (e ->> 'natural')::bigint))
      into v_allocs from jsonb_array_elements(v_rows) e;
      return jsonb_build_object(
        'allocations', v_allocs, 'certain', coalesce(v_ref_ok, false), 'confidence', 'purchase_invoice',
        'supplier_id', case when (select count(distinct e ->> 'supplier_id') from jsonb_array_elements(v_rows) e) = 1 then v_rows -> 0 -> 'supplier_id' end,
        'reason', format('De omschrijving noemt %s, en samen klopt het bedrag precies.', v_labels)
          || case when coalesce(v_ref_ok, false) then '' else ' Het rekeningnummer hoort bij een andere leverancier; controleer het voordat je boekt.' end);
    end if;
    -- Klopt het niet precies: op volgorde van noemen tot het bedrag op is, de
    -- rest op een eigen regel. Hetzelfde als het verdeelscherm voorstelt.
    v_allocs := '[]'::jsonb;
    v_left := v_need;
    for r in select e ->> 'id' as id, (e ->> 'natural')::bigint as natural from jsonb_array_elements(v_rows) e loop
      if r.natural > 0 then
        v_take := least(r.natural, v_left);
        continue when v_take <= 0;
      else
        v_take := r.natural;
      end if;
      v_allocs := v_allocs || jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', r.id, 'amount_cents', v_take));
      v_left := v_left - v_take;
    end loop;
    if jsonb_array_length(v_allocs) > 0 then
      if v_left > 0 then
        v_allocs := v_allocs || jsonb_build_array(jsonb_build_object('kind', 'ledger', 'amount_cents', v_left));
      end if;
      return jsonb_build_object(
        'allocations', v_allocs, 'certain', false, 'confidence', 'purchase_invoice', 'supplier_id', null,
        'reason', format('De omschrijving noemt %s, maar samen komt dat niet precies op het bedrag. Controleer de verdeling.', v_labels));
    end if;
  end if;

  -- ── De leverancier ───────────────────────────────────────────────────────
  -- Hoort het IBAN bij een andere leverancier dan de naam, dan is de naam
  -- hooguit een voorstel: het geld ging naar dat IBAN.
  for v_try in
    select * from (values
      (1, v_sup_iban, 'iban', true),
      (2, v_sup_name, 'name', v_sup_iban is null),
      (3, v_sup_desc, 'description', false)
    ) as t(ord, supplier_id, how, may_be_certain)
    where t.supplier_id is not null
    order by t.ord
  loop
    -- De openstaande facturen van deze leverancier, oudste eerst. Een
    -- betaling ruim vóór de factuurdatum hoort er niet bij.
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'name', c.supplier_name,
                                                 'natural', c.open_cents * v_flip) order by c.due, c.date, c.id), '[]'::jsonb)
    into v_cands
    from unnest(p_open) c
    where c.supplier_id = v_try.supplier_id
      and c.open_cents * v_flip > 0
      and p_txn.booking_date >= c.date - 60;
    continue when jsonb_array_length(v_cands) = 0;

    select count(*) into v_exact from jsonb_array_elements(v_cands) e where (e ->> 'natural')::bigint = v_need;

    if v_exact = 1 then
      select e ->> 'id' as id, e ->> 'label' as label, e ->> 'name' as name into v_pick
      from jsonb_array_elements(v_cands) e where (e ->> 'natural')::bigint = v_need;
      return jsonb_build_object(
        'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_pick.id, 'amount_cents', v_need)),
        'certain', v_try.may_be_certain and v_try.how in ('iban', 'name'), 'confidence', 'purchase_supplier', 'supplier_id', v_try.supplier_id,
        'reason', case v_try.how
          when 'iban' then format('Rekeningnummer van %s en het bedrag van inkoopfactuur %s.', v_pick.name, v_pick.label)
          when 'name' then format('Naam %s en het bedrag van inkoopfactuur %s.', v_pick.name, v_pick.label)
            || case when v_try.may_be_certain then '' else ' Het rekeningnummer hoort bij een andere leverancier; controleer het voordat je boekt.' end
          else format('%s staat in de omschrijving en het bedrag past op inkoopfactuur %s. Controleer het voordat je boekt.', v_pick.name, v_pick.label)
        end);
    elsif v_exact > 1 then
      -- Meer facturen van deze leverancier met dit bedrag (een abonnement):
      -- de oudste die in deze ronde nog niet aan een andere betaling hing.
      select e ->> 'id' as id, e ->> 'label' as label, e ->> 'name' as name into v_pick
      from jsonb_array_elements(v_cands) with ordinality as t(e, ord)
      where (e ->> 'natural')::bigint = v_need
      order by ((e ->> 'id')::uuid = any(coalesce(p_claimed, '{}'::uuid[]))), ord
      limit 1;
      return jsonb_build_object(
        'allocations', jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', v_pick.id, 'amount_cents', v_need)),
        'certain', false, 'confidence', 'purchase_supplier', 'supplier_id', v_try.supplier_id,
        'reason', format('%s openstaande facturen van %s hebben dit bedrag; de oudste (%s) is voorgesteld. Kies een andere als dat niet klopt.',
                         v_exact, v_pick.name, v_pick.label));
    end if;

    -- Een verzamelbetaling: precies de oudste k facturen samen (k ≥ 2).
    v_running := 0; v_k := 0; v_allocs := '[]'::jsonb; v_labels := null;
    for r in select e ->> 'id' as id, e ->> 'label' as label, e ->> 'name' as name, (e ->> 'natural')::bigint as natural
             from jsonb_array_elements(v_cands) with ordinality as t(e, ord) order by ord
    loop
      v_running := v_running + r.natural;
      v_k := v_k + 1;
      v_allocs := v_allocs || jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', r.id, 'amount_cents', r.natural));
      v_labels := coalesce(v_labels || ', ', '') || r.label;
      exit when v_running >= v_need;
    end loop;
    if v_k >= 2 and v_running = v_need then
      return jsonb_build_object(
        'allocations', v_allocs,
        'certain', v_try.may_be_certain and v_try.how in ('iban', 'name'), 'confidence', 'purchase_supplier', 'supplier_id', v_try.supplier_id,
        'reason', format('Verzamelbetaling aan %s: samen precies de %s oudste openstaande facturen (%s).', r.name, v_k, v_labels)
          || case when v_try.may_be_certain and v_try.how in ('iban', 'name') then '' else ' Controleer het voordat je boekt.' end);
    end if;
  end loop;

  return null;
end;
$$;

-- ── 4. De matchronde ────────────────────────────────────────────────────────
-- Nieuwe parameter p_cursor: een andere handtekening, dus eerst de oude weg.
-- De aanroepers (match_bank_transactions, de trigger op purchase_invoices,
-- bank_match_for_purchase_invoice) zijn plpgsql en vinden de nieuwe vanzelf.
drop function if exists public.bank_match_run(uuid, uuid, uuid, uuid[], boolean, integer);

-- GEWIJZIGD (20261118200000): sneller, en een deadline die meegroeit met de
-- echte grens in plaats van vast 3 seconden. Zie de kop van deze migratie.
--   p_cursor — 'JJJJ-MM-DD|<id>': ga verder ná die bankregel (boekdatum, id).
--              De vorige ronde gaf hem terug als next_cursor.
create or replace function public.bank_match_run(
  p_organization_id uuid,
  p_bank_account_id uuid,
  p_created_by uuid,
  p_transaction_ids uuid[],
  p_auto_book boolean,
  p_depth integer default 0,
  p_cursor text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions;
  v_inv record;
  v_rule public.bank_rules;
  v_sup public.suppliers;
  v_suggested integer := 0;
  v_auto integer := 0;
  v_auto_purchase integer := 0;
  v_merged integer := 0;
  v_haystack text;
  v_iban text;
  v_open public.bank_open_purchase_invoice[];
  v_open_amounts bigint[];
  v_name_tokens jsonb;
  v_sales public.bank_sales_invoice_ref[];
  v_has_rules boolean;
  v_ibans jsonb;
  v_auto_accounts jsonb;
  v_claimed uuid[] := '{}';
  v_match jsonb;
  v_ids uuid[];
  v_booked boolean;
  v_done boolean;
  v_sup_open integer;
  v_paid uuid[] := '{}';        -- in deze ronde vanzelf betaald
  v_sugg_txns uuid[] := '{}';   -- in deze ronde een voorstel met een inkoopfactuur
  v_redo uuid[];
  v_inner jsonb;
  -- De grens: PostgREST breekt een aanroep van de app af na statement_timeout
  -- (8 s voor ingelogde gebruikers), de bankkoppeling na 120 s. De ronde stopt
  -- op 70% daarvan, gemeten vanaf het begin van de aanroep (dus ook het
  -- inlezen zelf telt mee), en nooit later dan na 25 s. Wat dan nog niet is
  -- nagelopen, doet de volgende ronde: die begint na next_cursor.
  v_timeout_ms bigint;
  v_budget_ms numeric;
  v_test text;
  v_deadline timestamptz;
  v_cur_date date;
  v_cur_id uuid;
  v_last_date date;
  v_last_id uuid;
  v_processed integer := 0;
  v_stopped boolean := false;
  v_remaining integer := 0;
  -- Het voorstel voor deze transactie; aan het eind één update.
  o_status text;
  o_account uuid;
  o_vat text;
  o_rule uuid;
  o_conf text;
  o_inv uuid;
  o_pi uuid;
  o_reason text;
  o_allocs jsonb;
begin
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\|[0-9a-fA-F-]{36}$' then
      raise exception 'Ongeldige cursor voor het matchen.' using errcode = '22023';
    end if;
    v_cur_date := split_part(p_cursor, '|', 1)::date;
    v_cur_id := split_part(p_cursor, '|', 2)::uuid;
  end if;

  select s.setting::bigint into v_timeout_ms from pg_settings s where s.name = 'statement_timeout';
  v_budget_ms := case when coalesce(v_timeout_ms, 0) <= 0 then 25000 else least(v_timeout_ms * 0.7, 25000) end;
  -- Voor de databasetest: een kleiner budget, zodat de rondes te zien zijn.
  -- Alleen korter, nooit langer.
  v_test := nullif(current_setting('resofly.bank_match_budget_ms', true), '');
  if v_test ~ '^[0-9]{1,9}$' then
    v_budget_ms := least(v_budget_ms, v_test::numeric);
  end if;
  v_deadline := statement_timestamp() + make_interval(secs => v_budget_ms / 1000.0);

  if p_transaction_ids is null and p_cursor is null then
    v_merged := public.merge_manual_bank_transactions(p_organization_id, p_bank_account_id, p_created_by);
  end if;

  -- Eén keer per ronde: wat er openstaat en wat er aan regels en IBAN's is.
  v_open := public.bank_open_purchase_invoices(p_organization_id);
  v_open_amounts := array(select c.open_cents from unnest(v_open) c);
  -- Alle woorden van de leveranciersnamen (zie bank_purchase_match). Na een
  -- automatische boeking niet opnieuw: te veel woorden kost alleen tijd.
  v_name_tokens := coalesce((
    select jsonb_object_agg(x.w, true)
    from (select distinct w from unnest(v_open) c, unnest(string_to_array(c.name_norm, ' ')) as w
          where c.name_norm is not null and w <> '') x
  ), '{}'::jsonb);
  v_ibans := public.bank_supplier_ibans(p_organization_id);
  select coalesce(jsonb_object_agg(ba.id::text, ba.auto_book_purchase_invoices), '{}'::jsonb)
  into v_auto_accounts
  from public.bank_accounts ba where ba.organization_id = p_organization_id;
  v_has_rules := exists (select 1 from public.bank_rules r where r.organization_id = p_organization_id and r.is_active);
  -- Geboekte verkoopfacturen met een nummer (zoals de matcher ze al zocht).
  -- Of er nog iets openstaat, kijkt hij pas bij een treffer.
  v_sales := array(
    select row(i.id, i.number, lower(regexp_replace(i.number, '\s', '', 'g')),
               round(coalesce(i.total_amount, 0) * 100)::bigint, i.date)::public.bank_sales_invoice_ref
    from public.invoices i
    where i.organization_id = p_organization_id
      and i.status not in ('cancelled', 'void')
      and i.journal_entry_id is not null
      and i.number is not null and length(btrim(i.number)) > 0
  );

  for v_txn in
    select * from public.bank_transactions
    where organization_id = p_organization_id
      -- GEWIJZIGD (20261118190000): ook bestaande voorstellen opnieuw. Kwam de
      -- inkoopfactuur na de betaling, dan bleef "boek op 4500" staan.
      and status in ('unmatched', 'suggested')
      and (p_bank_account_id is null or bank_account_id = p_bank_account_id)
      and (p_transaction_ids is null or id = any(p_transaction_ids))
      and (p_cursor is null or (booking_date, id) > (v_cur_date, v_cur_id))
    order by booking_date, id
  loop
    -- De deadline: minstens één bankregel per ronde, zodat elke ronde opschiet.
    if v_processed > 0 and clock_timestamp() > v_deadline then
      v_stopped := true;
      exit;
    end if;
    v_processed := v_processed + 1;
    v_last_date := v_txn.booking_date;
    v_last_id := v_txn.id;

    o_status := 'unmatched'; o_account := null; o_vat := null; o_rule := null; o_conf := null;
    o_inv := null; o_pi := null; o_reason := null; o_allocs := null;
    v_done := false; v_booked := false; v_match := null; v_rule := null; v_sup := null;
    v_haystack := lower(replace(coalesce(v_txn.description,'') || ' ' || coalesce(v_txn.structured_reference,''), ' ', ''));
    v_iban := upper(replace(coalesce(v_txn.counterparty_iban,''), ' ', ''));

    -- 1. Ontvangst: verkoopfactuur op factuurnummer (zoals voorheen).
    if v_txn.amount_cents > 0 and cardinality(v_sales) > 0 and length(v_haystack) >= 3 then
      select s.id, s.number into v_inv
      from unnest(v_sales) s
      where strpos(v_haystack, s.number_norm) > 0
        and public.bank_text_mentions_reference(v_haystack, s.number)
        and public.invoice_open_receivable_cents(p_organization_id, s.id) > 0
      order by (case when s.total_cents = abs(v_txn.amount_cents) then 0 else 1 end), s.date desc
      limit 1;
      if v_inv.id is not null then
        o_status := 'suggested'; o_inv := v_inv.id; o_conf := 'invoice';
        o_reason := format('Factuurnummer %s staat in de omschrijving.', v_inv.number);
        v_done := true;
      end if;
    end if;

    -- 2. Inkoopfactuur op nummer of leverancier. Vóór de bankregels: een
    --    regel "KPN → 4500" boekte anders de betaling van een geboekte
    --    KPN-factuur nog eens als kosten.
    if not v_done and cardinality(v_open) > 0 then
      v_match := public.bank_purchase_match(v_txn, v_haystack, v_open, v_ibans, v_claimed, 'strong', v_name_tokens);
    end if;

    if not v_done and v_match is not null then
      select array_agg((a ->> 'purchase_invoice_id')::uuid) into v_ids
      from jsonb_array_elements(v_match -> 'allocations') a
      where a ->> 'kind' = 'purchase_invoice';
      o_reason := v_match ->> 'reason';

      if (v_match ->> 'certain')::boolean then
        if v_txn.auto_book_blocked then
          o_reason := o_reason || ' Je draaide een automatische boeking hiervan terug; ResoFly boekt hem niet meer vanzelf.';
        elsif not coalesce((v_auto_accounts ->> v_txn.bank_account_id::text)::boolean, true) then
          o_reason := o_reason || ' Automatisch boeken staat uit voor deze rekening.';
        elsif p_auto_book then
          begin
            perform public.book_bank_transaction(
              p_organization_id, v_txn.id, null, null, null, p_created_by, v_match -> 'allocations', null);
            update public.bank_transactions set
              auto_booked = true,
              match_confidence = v_match ->> 'confidence',
              match_reason = v_match ->> 'reason',
              suggested_allocations = null,
              suggested_account_id = null,
              suggested_vat_code = null,
              matched_rule_id = null,
              updated_at = now()
            where id = v_txn.id;
            v_booked := true;
          exception when others then
            -- Afgesloten periode, een andere valuta, net door iemand anders
            -- geboekt: dan blijft het een voorstel, met de reden erbij.
            o_reason := o_reason || ' Automatisch boeken lukte niet: ' || sqlerrm;
          end;
        end if;
      end if;

      if v_booked then
        v_auto := v_auto + 1;
        v_auto_purchase := v_auto_purchase + 1;
        v_paid := v_paid || coalesce(v_ids, '{}'::uuid[]);
        -- Wat er nu nog openstaat; zo krijgt een tweede betaling van hetzelfde
        -- bedrag deze factuur niet ook.
        select coalesce(array_agg(x.c order by (x.c).due, (x.c).date, (x.c).id), '{}') into v_open
        from (
          select case when c.id = any(v_ids)
                      then row(c.id, c.supplier_id, c.supplier_name, c.name_norm, c.label,
                               c.ref1, c.ref2, c.ref3, c.ref1_norm, c.ref2_norm, c.ref3_norm,
                               public.purchase_invoice_open_payable_cents(p_organization_id, c.id), c.date, c.due)::public.bank_open_purchase_invoice
                      else row(c.*)::public.bank_open_purchase_invoice end as c
          from unnest(v_open) c
        ) x
        where (x.c).open_cents <> 0;
        v_open_amounts := array(select c.open_cents from unnest(v_open) c);
        continue;
      end if;

      o_status := 'suggested';
      o_conf := v_match ->> 'confidence';
      if jsonb_array_length(v_match -> 'allocations') = 1 then
        o_pi := v_ids[1];
      else
        o_allocs := v_match -> 'allocations';
      end if;
      v_claimed := v_claimed || coalesce(v_ids, '{}'::uuid[]);
      v_done := true;
    end if;

    -- 3. Bankregels op prioriteit; eerste match wint. Alleen als er regels zijn.
    if not v_done and v_has_rules then
      select * into v_rule
      from public.bank_rules r
      where r.organization_id = p_organization_id
        and r.is_active
        and (r.match_direction = 'both'
             or (r.match_direction = 'in' and v_txn.amount_cents > 0)
             or (r.match_direction = 'out' and v_txn.amount_cents < 0))
        and (r.match_counterparty_iban is null or upper(replace(r.match_counterparty_iban,' ','')) = v_iban)
        and (r.match_counterparty_name_contains is null or coalesce(v_txn.counterparty_name,'') ilike public.like_contains_pattern(r.match_counterparty_name_contains))
        and (r.match_description_contains is null or coalesce(v_txn.description,'') ilike public.like_contains_pattern(r.match_description_contains))
        and (r.match_amount_cents is null or r.match_amount_cents = abs(v_txn.amount_cents))
      order by r.priority, r.created_at
      limit 1;

      if v_rule.id is not null then
        o_reason := format('Bankregel "%s".', v_rule.name);
        if p_auto_book and v_rule.auto_book and v_rule.target_account_id is not null then
          if v_txn.auto_book_blocked then
            -- GEWIJZIGD (20261118190000): na terugdraaien niet opnieuw vanzelf.
            o_reason := o_reason || ' Je draaide een automatische boeking hiervan terug; ResoFly boekt hem niet meer vanzelf.';
          else
            begin
              perform public.book_bank_transaction(
                p_organization_id, v_txn.id,
                jsonb_build_array(jsonb_build_object(
                  'account_id', v_rule.target_account_id,
                  'amount_cents', abs(v_txn.amount_cents),
                  'vat_code', v_rule.target_vat_code,
                  'description', v_rule.name
                )),
                null, null, p_created_by
              );
              update public.bank_transactions set
                auto_booked = true,
                matched_rule_id = v_rule.id,
                match_confidence = 'rule',
                match_reason = format('Bankregel "%s".', v_rule.name),
                suggested_allocations = null,
                updated_at = now()
              where id = v_txn.id;
              v_booked := true;
            exception when others then
              -- Automatisch boeken mislukt (bv. afgesloten periode): zet als
              -- voorstel klaar i.p.v. de hele import/match terug te draaien.
              o_reason := o_reason || ' Automatisch boeken lukte niet: ' || sqlerrm;
            end;
          end if;
        end if;
        if v_booked then
          v_auto := v_auto + 1;
          continue;
        end if;
        o_status := 'suggested';
        o_account := v_rule.target_account_id;
        o_vat := v_rule.target_vat_code;
        o_rule := v_rule.id;
        o_conf := 'rule';
        v_done := true;
      end if;
    end if;

    -- 4. Belastingdienst herkennen (betaling én teruggave): stel 1530 Te betalen
    --    omzetbelasting voor, alleen als het bedrag past op een ingediende, nog
    --    niet betaalde aangifte of de omschrijving over btw gaat (zoals voorheen).
    if not v_done
       and (v_iban = 'NL86INGB0002445588'
            or coalesce(v_txn.counterparty_name,'') ilike '%belastingdienst%')
       and (
         exists (
           select 1 from public.vat_returns vr
           where vr.organization_id = p_organization_id
             and vr.status = 'filed'
             and vr.paid_bank_transaction_id is null
             and coalesce((vr.rubrieken->>'saldo_afgerond')::bigint, 0) = -v_txn.amount_cents
         )
         or lower(coalesce(v_txn.description, '') || ' ' || coalesce(v_txn.structured_reference, '')) ~ '(omzetbelasting|\mbtw\M|\mob\M)'
       ) then
      o_status := 'suggested';
      o_account := public.bookkeeping_account_id(p_organization_id, '1530');
      o_conf := 'tax_authority';
      o_reason := 'Herkend als Belastingdienst: omzetbelasting (1530).';
      v_done := true;
    end if;

    -- 5. Alleen het bedrag van één openstaande inkoopfactuur. Na de regels en
    --    de Belastingdienst: dit is het zwakste signaal. Eerst kijken of er
    --    überhaupt een factuur met dat bedrag openstaat (open = −bedrag, in
    --    beide richtingen).
    if not v_done and (-v_txn.amount_cents) = any(v_open_amounts) then
      v_match := public.bank_purchase_match(v_txn, v_haystack, v_open, v_ibans, v_claimed, 'amount');
      if v_match is not null then
        o_status := 'suggested';
        o_conf := 'purchase_amount';
        o_pi := (v_match -> 'allocations' -> 0 ->> 'purchase_invoice_id')::uuid;
        o_reason := v_match ->> 'reason';
        v_claimed := v_claimed || o_pi;
        v_done := true;
      end if;
    end if;

    -- 6. Geen regel: bij een betaling de leverancier op IBAN, met zijn
    --    standaard kostenrekening (zoals voorheen). Alleen zoeken als het IBAN
    --    bij een leverancier hoort.
    if not v_done and v_txn.amount_cents < 0 and v_txn.counterparty_iban is not null
       and v_ibans ? coalesce(public.bank_norm_iban(v_txn.counterparty_iban), '') then
      select * into v_sup from public.suppliers s
      where s.organization_id = p_organization_id
        and s.iban is not null
        and upper(replace(s.iban,' ','')) = v_iban
      limit 1;
      if v_sup.id is not null then
        o_status := 'suggested';
        o_account := v_sup.default_expense_account_id;
        o_vat := v_sup.default_vat_code;
        o_conf := 'supplier_iban';
        o_reason := format('Rekeningnummer van %s; de standaard kostenrekening van die leverancier.', v_sup.name);
        -- TOEGEVOEGD (20261118190000): staat er bij deze leverancier nog iets
        -- open, dan telt deze betaling op een kostenrekening de kosten dubbel.
        select count(*) into v_sup_open
        from unnest(v_open) c
        where c.supplier_id = v_sup.id and c.open_cents > 0;
        if v_sup_open > 0 then
          o_reason := o_reason || format(' Let op: %s heeft nog %s openstaande inkoopfactu%s, maar geen met dit bedrag. Hoort de betaling bij een factuur, kies die dan; op een kostenrekening tellen de kosten anders dubbel.',
                                         v_sup.name, v_sup_open, case when v_sup_open = 1 then 'ur' else 'ren' end);
        end if;
        v_done := true;
      end if;
    end if;

    update public.bank_transactions set
      status = o_status,
      suggested_account_id = o_account,
      suggested_vat_code = o_vat,
      matched_rule_id = o_rule,
      match_confidence = o_conf,
      matched_invoice_id = o_inv,
      matched_purchase_invoice_id = o_pi,
      match_reason = o_reason,
      suggested_allocations = o_allocs,
      updated_at = now()
    where id = v_txn.id
      and (status, suggested_account_id, suggested_vat_code, matched_rule_id, match_confidence,
           matched_invoice_id, matched_purchase_invoice_id, match_reason, suggested_allocations)
          is distinct from
          (o_status, o_account, o_vat, o_rule, o_conf, o_inv, o_pi, o_reason, o_allocs);
    if o_status = 'suggested' then
      v_suggested := v_suggested + 1;
    end if;
    if o_pi is not null or o_allocs is not null then
      v_sugg_txns := v_sugg_txns || v_txn.id;
    end if;
  end loop;

  -- Wat er nog na de laatst nagelopen bankregel ligt (alleen bij een stop).
  if v_stopped then
    select count(*) into v_remaining
    from public.bank_transactions t
    where t.organization_id = p_organization_id
      and t.status in ('unmatched', 'suggested')
      and (p_bank_account_id is null or t.bank_account_id = p_bank_account_id)
      and (p_transaction_ids is null or t.id = any(p_transaction_ids))
      and (t.booking_date, t.id) > (v_last_date, v_last_id);
  end if;

  -- Een voorstel kan in dezelfde ronde zijn ingehaald: een later gedateerde
  -- betaling bleek zeker bij die factuur te horen en is geboekt. Dan wees het
  -- voorstel naar een betaalde factuur. Die transacties nog één keer, nu
  -- tegen wat er werkelijk nog openstaat. Niet als de tijd al op is: dan doet
  -- een volgende ronde het.
  if p_depth < 2 and not v_stopped and cardinality(v_paid) > 0 and cardinality(v_sugg_txns) > 0 then
    select array_agg(t.id) into v_redo
    from public.bank_transactions t
    where t.organization_id = p_organization_id
      and t.id = any(v_sugg_txns)
      and t.status = 'suggested'
      and (t.matched_purchase_invoice_id = any(v_paid)
           or exists (select 1 from jsonb_array_elements(coalesce(t.suggested_allocations, '[]'::jsonb)) a
                      where a ->> 'purchase_invoice_id' is not null
                        and (a ->> 'purchase_invoice_id')::uuid = any(v_paid)));
    if v_redo is not null then
      v_inner := public.bank_match_run(p_organization_id, null, p_created_by, v_redo, p_auto_book, p_depth + 1);
      v_suggested := v_suggested - cardinality(v_redo) + coalesce((v_inner ->> 'suggested')::integer, 0);
      v_auto := v_auto + coalesce((v_inner ->> 'auto_booked')::integer, 0);
      v_auto_purchase := v_auto_purchase + coalesce((v_inner ->> 'auto_booked_purchase')::integer, 0);
    end if;
  end if;

  return jsonb_build_object(
    'suggested', v_suggested,
    'auto_booked', v_auto,
    'auto_booked_purchase', v_auto_purchase,
    'merged', v_merged,
    -- Nagelopen in deze ronde, en wat er nog ligt (> 0: geef next_cursor aan
    -- de volgende ronde).
    'processed', v_processed,
    'remaining', v_remaining,
    -- Vast formaat: date::text volgt DateStyle van de sessie.
    'next_cursor', case when v_remaining > 0 then to_char(v_last_date, 'YYYY-MM-DD') || '|' || v_last_id::text end
  );
end;
$$;


-- ── 5. De openbare ingang: met p_cursor ─────────────────────────────────────
drop function if exists public.match_bank_transactions(uuid, uuid, uuid, uuid, boolean);

create or replace function public.match_bank_transactions(
  p_organization_id uuid,
  p_bank_account_id uuid default null,
  p_created_by uuid default auth.uid(),
  p_transaction_id uuid default null,
  p_auto_book boolean default true,
  p_cursor text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  -- Een rekening van een andere organisatie levert niets op (bank_match_run
  -- filtert op de organisatie), maar zeg het liever hardop.
  if p_bank_account_id is not null and not exists (
    select 1 from public.bank_accounts ba where ba.id = p_bank_account_id and ba.organization_id = p_organization_id
  ) then
    raise exception 'Bankrekening niet gevonden.' using errcode = '02000';
  end if;
  return public.bank_match_run(
    p_organization_id, p_bank_account_id, p_created_by,
    case when p_transaction_id is null then null else array[p_transaction_id] end,
    p_auto_book, 0, p_cursor);
end;
$$;

-- ── 6. Inlezen: ook remaining en next_cursor ────────────────────────────────
-- Gelijk aan 20261118190000, met remaining en next_cursor van de matcher in
-- de uitkomst (en zonder auto_book_pending, dat niet meer bestaat).
CREATE OR REPLACE FUNCTION public.import_bank_transactions(p_organization_id uuid, p_bank_account_id uuid, p_statement jsonb, p_transactions jsonb, p_created_by uuid DEFAULT auth.uid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ba public.bank_accounts;
  v_stmt_id uuid;
  v_inserted integer := 0;
  v_total integer := 0;
  v_hash text;
  v_opening bigint;
  v_closing bigint;
  v_period_start date;
  v_period_end date;
  v_sum bigint;
  v_balance_ok boolean := null;
  v_balance_diff bigint := null;
  v_no_date integer := 0;
  v_zero integer := 0;
  -- TOEGEVOEGD (20261118190000): wat de matcher deed.
  v_match jsonb := null;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_transactions is null or jsonb_typeof(p_transactions) <> 'array' or jsonb_array_length(p_transactions) = 0 then
    raise exception 'Geen transacties om te importeren.' using errcode = '23514';
  end if;

  select * into v_ba from public.bank_accounts
  where id = p_bank_account_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Bankrekening niet gevonden.' using errcode = '02000';
  end if;

  v_total := jsonb_array_length(p_transactions);

  -- Uitgesplitst tellen wat er niet ingaat. Voorheen was er één 'skipped'-getal
  -- dat "al bekend" betekende; nu vallen er ook regels af op een ontbrekende
  -- datum of een bedrag van € 0,00 en dan wil je weten wélke van de drie het is.
  select
    count(*) filter (where nullif(l->>'booking_date','')::date is null),
    count(*) filter (where nullif(l->>'booking_date','')::date is not null
                       and coalesce((l->>'amount_cents')::bigint, 0) = 0)
  into v_no_date, v_zero
  from jsonb_array_elements(p_transactions) l;

  if p_statement is not null and jsonb_typeof(p_statement) = 'object' then
    v_hash := nullif(p_statement->>'file_hash', '');
    v_opening := nullif(p_statement->>'opening_balance_cents', '')::bigint;
    v_closing := nullif(p_statement->>'closing_balance_cents', '')::bigint;
    v_period_start := nullif(p_statement->>'period_start', '')::date;
    v_period_end := nullif(p_statement->>'period_end', '')::date;

    -- Hetzelfde bestand nogmaals inlezen hoort geen tweede afschriftrij te maken:
    -- dat vertroebelt de saldocontrole (een her-import zou als "afschrift zonder
    -- transacties" verschijnen omdat alle regels op de dedup afketsen).
    if v_hash is not null then
      select id into v_stmt_id from public.bank_statements
      where bank_account_id = p_bank_account_id and file_hash = v_hash
      order by imported_at limit 1;
    end if;

    if v_stmt_id is not null then
      update public.bank_statements set
        period_start = coalesce(v_period_start, period_start),
        period_end = coalesce(v_period_end, period_end),
        opening_balance_cents = coalesce(v_opening, opening_balance_cents),
        closing_balance_cents = coalesce(v_closing, closing_balance_cents),
        transaction_count = greatest(transaction_count, v_total)
      where id = v_stmt_id;
    else
      insert into public.bank_statements(
        organization_id, created_by, bank_account_id, format, file_name, file_hash,
        period_start, period_end, opening_balance_cents, closing_balance_cents, transaction_count
      ) values (
        p_organization_id, p_created_by, p_bank_account_id,
        coalesce(nullif(p_statement->>'format',''), 'csv'),
        nullif(p_statement->>'file_name',''),
        v_hash,
        v_period_start, v_period_end,
        v_opening, v_closing, v_total
      ) returning id into v_stmt_id;
    end if;
  end if;

  -- De dedup-sleutel wordt hier afgeleid; een door de client meegestuurde
  -- dedup_key wordt bewust genegeerd (zie kop van deze migratie).
  with src as (
    select
      nullif(l->>'booking_date','')::date as booking_date,
      nullif(l->>'value_date','')::date as value_date,
      coalesce((l->>'amount_cents')::bigint, 0) as amount_cents,
      coalesce(nullif(l->>'currency',''), v_ba.currency) as currency,
      nullif(l->>'counterparty_name','') as counterparty_name,
      nullif(l->>'counterparty_iban','') as counterparty_iban,
      nullif(l->>'description','') as description,
      nullif(l->>'structured_reference','') as structured_reference,
      nullif(l->>'end_to_end_id','') as end_to_end_id,
      nullif(l->>'bank_tx_id','') as bank_tx_id,
      ord
    from jsonb_array_elements(p_transactions) with ordinality as t(l, ord)
  ),
  keyed as (
    select
      src.*,
      'c:' || public.bank_canonical_key(booking_date, amount_cents, counterparty_iban, description)
          || ':' ||
          row_number() over (
            partition by public.bank_canonical_key(booking_date, amount_cents, counterparty_iban, description)
            order by ord
          ) as dedup_key
    from src
    where src.booking_date is not null and src.amount_cents <> 0
  ),
  ins as (
    insert into public.bank_transactions(
      organization_id, bank_account_id, statement_id, dedup_key, booking_date, value_date,
      amount_cents, currency, counterparty_name, counterparty_iban, description,
      structured_reference, end_to_end_id, bank_tx_id, status
    )
    select
      p_organization_id, p_bank_account_id, v_stmt_id, keyed.dedup_key, keyed.booking_date, keyed.value_date,
      keyed.amount_cents, keyed.currency, keyed.counterparty_name, keyed.counterparty_iban, keyed.description,
      keyed.structured_reference, keyed.end_to_end_id, keyed.bank_tx_id, 'unmatched'
    from keyed
    on conflict (bank_account_id, dedup_key) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  update public.bank_accounts set last_imported_at = now() where id = p_bank_account_id;

  -- Afschriftcontrole: beginsaldo + alle mutaties in de afschriftperiode moet het
  -- eindsaldo opleveren. Klopt dat niet, dan mist het bestand regels — dat wil je
  -- direct weten, niet pas bij de jaarrekening.
  --
  -- Bewust op DATUMBEREIK en niet op statement_id: bij overlappende afschriften
  -- (eerst jan.csv, dan jan-feb.csv) ketsen de januari-regels af op de dedup en
  -- houden ze het statement_id van de eerste import. Tellen op statement_id zou
  -- dan alleen februari zien tegen een begin-/eindsaldo over jan+feb — structureel
  -- vals alarm, precies de ruis die deze controle onbruikbaar zou maken.
  -- GEWIJZIGD (20261107110000): handmatige mutaties staan op geen enkel
  -- afschrift; die tellen hier niet mee (anders klopte geen afschrift meer).
  if v_stmt_id is not null and v_opening is not null and v_closing is not null
     and v_period_start is not null and v_period_end is not null then
    select coalesce(sum(amount_cents), 0) into v_sum
    from public.bank_transactions
    where bank_account_id = p_bank_account_id
      and not is_manual
      and booking_date between v_period_start and v_period_end;
    v_balance_diff := v_closing - (v_opening + v_sum);
    v_balance_ok := v_balance_diff = 0;
  end if;

  -- Alleen matchen als er echt iets bij is gekomen: match_bank_transactions loopt
  -- rij voor rij door álle openstaande transacties van de organisatie, en dat is
  -- zonde bij een her-import die niets toevoegt. De knop "Opnieuw matchen" blijft
  -- beschikbaar om het alsnog af te dwingen.
  if v_inserted > 0 then
    v_match := public.match_bank_transactions(p_organization_id, p_bank_account_id, p_created_by);
  end if;

  return jsonb_build_object(
    'inserted', v_inserted,
    -- 'skipped' blijft het totaal-overgeslagen voor bestaande aanroepers; de
    -- uitsplitsing zegt waaróm, zodat de UI niet hoeft te gissen.
    'skipped', v_total - v_inserted,
    'duplicates', greatest(v_total - v_inserted - v_no_date - v_zero, 0),
    'skipped_no_date', v_no_date,
    'skipped_zero_amount', v_zero,
    'statement_id', v_stmt_id,
    'balance_ok', v_balance_ok,
    'balance_difference_cents', v_balance_diff,
    -- TOEGEVOEGD (20261118190000): zodat het scherm kan zeggen "5 meteen
    -- geboekt, 3 voorstellen" in plaats van alleen "8 nieuw".
    'auto_booked', coalesce((v_match ->> 'auto_booked')::integer, 0),
    'auto_booked_purchase', coalesce((v_match ->> 'auto_booked_purchase')::integer, 0),
    'suggested', coalesce((v_match ->> 'suggested')::integer, 0),
    'merged', coalesce((v_match ->> 'merged')::integer, 0),
    -- TOEGEVOEGD (20261118200000): stopte de matcher op de tijdgrens, dan
    -- gaat de app verder met next_cursor ("Opnieuw matchen" in rondes).
    'remaining', coalesce((v_match ->> 'remaining')::integer, 0),
    'next_cursor', v_match ->> 'next_cursor'
  );
end;
$function$;

-- ── 7. Rechten ──────────────────────────────────────────────────────────────

revoke all on function public.bank_purchase_match(public.bank_transactions, text, public.bank_open_purchase_invoice[], jsonb, uuid[], text, jsonb) from public, anon, authenticated;
grant execute on function public.bank_purchase_match(public.bank_transactions, text, public.bank_open_purchase_invoice[], jsonb, uuid[], text, jsonb) to service_role;
revoke all on function public.bank_match_run(uuid, uuid, uuid, uuid[], boolean, integer, text) from public, anon, authenticated;
grant execute on function public.bank_match_run(uuid, uuid, uuid, uuid[], boolean, integer, text) to service_role;
revoke all on function public.match_bank_transactions(uuid, uuid, uuid, uuid, boolean, text) from public, anon;
grant execute on function public.match_bank_transactions(uuid, uuid, uuid, uuid, boolean, text) to authenticated, service_role;
revoke all on function public.import_bank_transactions(uuid, uuid, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.import_bank_transactions(uuid, uuid, jsonb, jsonb, uuid) to authenticated, service_role;
revoke all on function public.ensure_default_ledger_accounts(uuid) from public, anon;
grant execute on function public.ensure_default_ledger_accounts(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
