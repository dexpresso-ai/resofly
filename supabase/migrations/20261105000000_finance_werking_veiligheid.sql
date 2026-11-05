-- ============================================================
-- ResoFly — Financiën: werking en beveiliging (eenmanszaak, vof en BV)
-- Date: 2026-11-05
--
-- Uitkomst van een volledige controle van de financiële functies voor alle
-- rechtsvormen: een eind-tot-eindcyclus per rechtsvorm (offerte → factuur →
-- bank → inkoop → activum → btw → jaarafsluiting → heropenen; bij de BV ook
-- Vpb, resultaatbestemming, dividend en jaarrekening), een rol-/tenantmatrix
-- over alle financiële tabellen en functies, en plpgsql_check over alle
-- PL/pgSQL-functies.
--
--   1. GROOTBOEKKAART KAPOT. report_account_ledger gaf voor iedereen
--      "column reference entry_id is ambiguous": de laatste union-tak noemde
--      de kolommen van de CTE zonder alias, en die botsten met de
--      uitvoerkolommen van de functie. De grootboekkaart in Boekhouding en
--      de leeshandeling voor Gerrie/API/MCP werkten daardoor niet. Nu
--      gekwalificeerd.
--   2. SCHRIJFRECHT OP FINANCIËN NIET IN DE FUNCTIE ZELF. 27 boekingsfuncties
--      (boeken, btw, boekjaar, bank, activa, Vpb, dividend, offerte indienen,
--      contract intrekken) vroegen alleen schrijfrecht op de organisatie
--      (de rol), niet op de module Financiën. Een lid met Financiën op
--      "lezen" of "geen" kwam zo tot in de functie; de module-trigger op de
--      tabellen hield de schrijfactie wel tegen, dus er lekte niets, maar de
--      functie moet zelf weigeren — vóór validatie en vóór een eerste
--      tussenstap. Nu: can_write_org én can_write_module(..., 'finance'),
--      net als de functies die dat al deden. close_vat_period krijgt de
--      controle ook expliciet.
--   3. VERWIJZINGEN NAAR EEN ANDERE ORGANISATIE. Zes kolommen die een
--      gebruiker zelf invult, werden niet op dezelfde organisatie
--      gecontroleerd: bankrekening → grootboekrekening, bankregel →
--      grootboekrekening/leverancier/klant, Vpb-correctie → boekjaar,
--      inkoopfactuur → leverancier/project, leverancier → standaard
--      kostenrekening en contract → sjabloon. Boeken liep wel vast op de
--      controle van boekingsregels, maar de verwijzing zelf hoort niet te
--      kunnen. Bestaande gegevens zijn nagelopen: geen overtredingen.
--   4. VPB-CORRECTIES NA VASTSTELLEN. Fiscale correcties konden worden
--      gewijzigd terwijl de Vpb-berekening van dat boekjaar al was
--      vastgesteld en geboekt. Het scherm verborg de knoppen, de database
--      niet. Nu: eerst de berekening terugdraaien.
--   5. BETALEN, CREDITEREN, HERINNEREN, ONDERTEKENEN. Een betaallink vroeg
--      na een deelbetaling nog het hele factuurbedrag; een dubbelklik kon twee
--      creditnota's geven; een late "betaald" van Mollie zette een
--      geannuleerde factuur terug op betaald; een volgende herinnering brak de
--      link in de vorige; een contract kon worden getekend op een andere tekst
--      dan was verstuurd, na de uiterste datum, en met een ander e-mailadres
--      dat dan als geverifieerd gold.
--   6. DIRECTE UITVOERING ALS HET TEAMLID. API, MCP en Gerrie schreven op de
--      service-role, langs RLS en de bewakers heen (bijv. code en soort van
--      een rekening waarop al geboekt is). Nu via action_member_write.
--   7. RECHTSVORM, BANKREGELS EN GERESERVEERDE CODES. BV-registers en Vpb
--      weigeren bij een IB-onderneming; een bankregel heeft een voorwaarde en
--      % en _ zijn letterlijk; een eigen rekening kan geen code van een
--      latere systeemrekening (9900, 1540, …) bezetten.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Grootboekkaart ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.report_account_ledger(p_organization_id uuid, p_account_id uuid, p_from date, p_to date)
 RETURNS TABLE(entry_id uuid, entry_number text, date date, description text, debit_cents bigint, credit_cents bigint, running_balance_cents bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_opening bigint;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.ledger_accounts la where la.id = p_account_id and la.organization_id = p_organization_id) then
    raise exception 'Grootboekrekening niet gevonden.' using errcode = '02000';
  end if;

  -- Beginsaldo: netto beweging (debet − credit) op deze rekening vóór p_from.
  select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)
    into v_opening
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  where jl.organization_id = p_organization_id
    and jl.account_id = p_account_id
    and je.status = 'posted'
    and je.date < p_from;

  return query
    with period as (
      select
        je.id as entry_id, je.entry_number, je.date as d,
        coalesce(nullif(jl.description, ''), je.description) as description,
        jl.debit_cents, jl.credit_cents, jl.line_index
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id
      where jl.organization_id = p_organization_id
        and jl.account_id = p_account_id
        and je.status = 'posted'
        and je.date between p_from and p_to
    ),
    running as (
      select
        p.entry_id, p.entry_number, p.d, p.description,
        p.debit_cents, p.credit_cents,
        v_opening + sum(p.debit_cents - p.credit_cents) over (
          order by p.d, p.entry_number, p.line_index
          rows between unbounded preceding and current row
        ) as running_balance_cents,
        row_number() over (order by p.d, p.entry_number, p.line_index) as rn
      from period p
    )
    select r.entry_id, r.entry_number, r.d, r.description,
           r.debit_cents, r.credit_cents, r.running_balance_cents::bigint
    from (
      -- Beginsaldo-regel (rn = 0 → altijd bovenaan).
      select null::uuid as entry_id, null::text as entry_number, null::date as d,
             'Beginsaldo'::text as description, 0::bigint as debit_cents, 0::bigint as credit_cents,
             v_opening as running_balance_cents, 0::bigint as rn
      union all
      select ru.entry_id, ru.entry_number, ru.d, ru.description, ru.debit_cents, ru.credit_cents, ru.running_balance_cents, ru.rn
      from running ru
    ) r
    order by r.rn;
end;
$function$;


-- ── 2. Schrijfrecht op Financiën in de functie zelf ─────────────────────────

CREATE OR REPLACE FUNCTION public.book_all_unbooked_sales_invoices(p_organization_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count integer := 0;
  r record;
  v_je uuid;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  for r in
    select id from public.invoices
    where organization_id = p_organization_id
      and journal_entry_id is null
      and status in ('sent', 'accepted', 'paid', 'overdue')
    order by date asc
  loop
    v_je := public.ensure_sales_invoice_booked(p_organization_id, r.id, p_created_by);
    if v_je is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$function$;


CREATE OR REPLACE FUNCTION public.book_asset_acquisition(p_organization_id uuid, p_asset_id uuid, p_credit_account_id uuid, p_date date DEFAULT NULL::date, p_created_by uuid DEFAULT auth.uid())
 RETURNS fixed_assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_asset public.fixed_assets;
  v_entry public.journal_entries;
  v_lines jsonb;
  v_book_date date;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;
  if v_asset.acquisition_journal_entry_id is not null then
    raise exception 'De aanschaf van dit activum is al geboekt.' using errcode = '23514';
  end if;
  if v_asset.acquisition_cost_cents <= 0 then
    raise exception 'De aanschafwaarde moet groter zijn dan nul.' using errcode = '23514';
  end if;
  if p_credit_account_id = v_asset.asset_account_id then
    raise exception 'De tegenrekening mag niet gelijk zijn aan de activarekening.' using errcode = '23514';
  end if;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', v_asset.asset_account_id,
      'description', 'Aanschaf ' || v_asset.name,
      'debit_cents', v_asset.acquisition_cost_cents, 'credit_cents', 0
    ),
    jsonb_build_object(
      'account_id', p_credit_account_id,
      'description', 'Aanschaf ' || v_asset.name,
      'debit_cents', 0, 'credit_cents', v_asset.acquisition_cost_cents
    )
  );

  v_book_date := public.first_open_booking_date_for(p_organization_id, coalesce(p_date, v_asset.acquisition_date), public.journal_lines_touch_vat(p_organization_id, v_lines));
  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date,
    'Aanschaf ' || coalesce(v_asset.asset_number, v_asset.name),
    'asset_acquisition', p_asset_id, v_lines, p_created_by
  );

  update public.fixed_assets set acquisition_journal_entry_id = v_entry.id where id = p_asset_id;
  select * into v_asset from public.fixed_assets where id = p_asset_id;
  return v_asset;
end;
$function$;


CREATE OR REPLACE FUNCTION public.book_asset_disposal(p_organization_id uuid, p_asset_id uuid, p_counter_account_id uuid, p_proceeds_cents bigint DEFAULT 0, p_disposal_date date DEFAULT NULL::date, p_created_by uuid DEFAULT auth.uid())
 RETURNS fixed_assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_asset public.fixed_assets;
  v_accumulated bigint;
  v_book_value bigint;
  v_proceeds bigint := greatest(coalesce(p_proceeds_cents, 0), 0);
  v_result bigint;                 -- opbrengst − boekwaarde (winst > 0, verlies < 0)
  v_result_account uuid;
  v_lines jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_disposal_date date;
  v_book_date date;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;
  if v_asset.status = 'disposed' then
    raise exception 'Dit activum is al afgestoten.' using errcode = '23514';
  end if;
  if v_asset.acquisition_journal_entry_id is null then
    raise exception 'De aanschaf van dit activum staat nog niet in het grootboek; boek die eerst.' using errcode = '23514';
  end if;
  if p_counter_account_id is null then
    raise exception 'Kies een tegenrekening voor de opbrengst (bank/debiteuren, of dezelfde als geen opbrengst).' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  -- Zelfvoorzienend: zorg dat het boekresultaat-rekeningnummer bestaat.
  insert into public.ledger_accounts (organization_id, code, name, type, subtype, is_system)
  values (p_organization_id, '4950', 'Boekresultaat vaste activa', 'expense', 'asset_disposal_result', true)
  on conflict (organization_id, code) do nothing;

  v_disposal_date := coalesce(p_disposal_date, current_date);

  -- Opgebouwde afschrijving = som van de GEBOEKTE afschrijvingen van dit activum.
  select coalesce(sum(amount_cents), 0) into v_accumulated
  from public.asset_depreciations
  where asset_id = p_asset_id and status = 'posted';

  v_book_value := v_asset.acquisition_cost_cents - v_accumulated;
  v_result := v_proceeds - v_book_value;

  -- a) Aanschafwaarde van de balans halen (credit activarekening).
  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_asset.asset_account_id, 'description', 'Afboeken aanschaf ' || v_asset.name,
    'debit_cents', 0, 'credit_cents', v_asset.acquisition_cost_cents));

  -- b) Opgebouwde afschrijving terugnemen (debet cumulatieve-afschrijvingrekening).
  if v_accumulated <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_asset.accumulated_depreciation_account_id, 'description', 'Afboeken cum. afschrijving ' || v_asset.name,
      'debit_cents', v_accumulated, 'credit_cents', 0));
  end if;

  -- c) Opbrengst (debet tegenrekening: bank/debiteuren).
  if v_proceeds > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', p_counter_account_id, 'description', 'Opbrengst verkoop ' || v_asset.name,
      'debit_cents', v_proceeds, 'credit_cents', 0));
  end if;

  -- d) Boekwinst (credit) of boekverlies (debet) als sluitpost op 4950.
  if v_result <> 0 then
    v_result_account := public.bookkeeping_account_id(p_organization_id, '4950');
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_result_account,
      'description', case when v_result > 0 then 'Boekwinst' else 'Boekverlies' end || ' verkoop ' || v_asset.name,
      'debit_cents', case when v_result < 0 then -v_result else 0 end,
      'credit_cents', case when v_result > 0 then v_result else 0 end));
  end if;

  v_book_date := public.first_open_booking_date_for(p_organization_id, v_disposal_date, public.journal_lines_touch_vat(p_organization_id, v_lines));
  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date,
    'Desinvestering ' || coalesce(v_asset.asset_number, v_asset.name),
    'asset_disposal', p_asset_id, v_lines, p_created_by);

  -- Resterende geplande afschrijvingen vervallen; activum op 'disposed'.
  delete from public.asset_depreciations where asset_id = p_asset_id and status = 'scheduled';
  update public.fixed_assets
  set status = 'disposed', disposal_date = v_disposal_date, disposal_proceeds_cents = v_proceeds
  where id = p_asset_id;

  select * into v_asset from public.fixed_assets where id = p_asset_id;
  return v_asset;
end;
$function$;


CREATE OR REPLACE FUNCTION public.book_bank_transaction(p_organization_id uuid, p_transaction_id uuid, p_lines jsonb DEFAULT NULL::jsonb, p_matched_invoice_id uuid DEFAULT NULL::uuid, p_matched_purchase_invoice_id uuid DEFAULT NULL::uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_txn public.bank_transactions;
  v_ba public.bank_accounts;
  v_abs bigint;
  v_lines jsonb;
  v_entry public.journal_entries;
  v_inv public.invoices;
  v_pi public.purchase_invoices;
  v_desc text;
  r record;
  v_vat_payable_id uuid;
  v_vat_payable_booked bigint := 0;
  v_target_saldo bigint;
  v_match_count integer;
  v_match_id uuid;
  -- FIX 2: openstaand-saldo-bewaking
  v_entry_reversed boolean;
  v_doc_total bigint;
  v_already bigint;
  v_open bigint;
  -- FIX 3: BTW-accumulatoren met richting (positief = natuurlijke kant)
  v_vat_1510 bigint := 0;  -- positief → credit 1510, negatief → debet 1510
  v_vat_1500 bigint := 0;  -- positief → debet 1500, negatief → credit 1500
  v_vat_1520 bigint := 0;  -- positief → credit 1520, negatief → debet 1520
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  -- Eén factuur per transactie: met beide ids gezet werd het tweede id
  -- ongecontroleerd opgeslagen (ook een inkoopfactuur van een andere organisatie).
  if p_matched_invoice_id is not null and p_matched_purchase_invoice_id is not null then
    raise exception 'Koppel een transactie aan één factuur: een verkoopfactuur óf een inkoopfactuur.' using errcode = '23514';
  end if;

  select * into v_txn from public.bank_transactions
  where id = p_transaction_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Banktransactie niet gevonden.' using errcode = '02000';
  end if;
  if v_txn.status = 'booked' or v_txn.journal_entry_id is not null then
    raise exception 'Deze transactie is al geboekt.' using errcode = '23514';
  end if;

  select * into v_ba from public.bank_accounts where id = v_txn.bank_account_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Bankrekening niet gevonden.' using errcode = '02000';
  end if;

  v_abs := abs(v_txn.amount_cents);
  if v_abs = 0 then
    raise exception 'Een transactie van € 0,00 kan niet worden geboekt.' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  v_vat_payable_id := public.bookkeeping_account_id(p_organization_id, '1530');

  v_desc := 'Bank ' || coalesce(v_ba.name, '') || ': ' ||
            coalesce(nullif(v_txn.counterparty_name, ''), nullif(v_txn.description, ''), 'transactie');

  -- Bankregel (debet bij ontvangst, credit bij betaling).
  v_lines := jsonb_build_array(jsonb_build_object(
    'account_id', v_ba.ledger_account_id,
    'description', v_desc,
    'debit_cents', case when v_txn.amount_cents > 0 then v_abs else 0 end,
    'credit_cents', case when v_txn.amount_cents < 0 then v_abs else 0 end
  ));

  if p_matched_invoice_id is not null then
    if v_txn.amount_cents <= 0 then
      raise exception 'Een verkoopfactuur afletteren kan alleen bij een ontvangst.' using errcode = '23514';
    end if;
    -- for update: gelijktijdig twee ontvangsten op dezelfde factuur boeken zou
    -- anders allebei de openstaand-check passeren.
    select * into v_inv from public.invoices
    where id = p_matched_invoice_id and organization_id = p_organization_id for update;
    if not found then raise exception 'Verkoopfactuur niet gevonden.' using errcode = '02000'; end if;

    -- FIX 2: afletteren kan alleen tegen een factuur die in het grootboek staat.
    -- Zonder debitering van 1300 zou de creditering hier Debiteuren negatief maken.
    if v_inv.journal_entry_id is null then
      raise exception 'Factuur % staat nog niet in het grootboek. Boek de factuur eerst ("Boek naar grootboek") en letter daarna af.', coalesce(v_inv.number, '')
        using errcode = '23514';
    end if;
    select je.reversed_by_entry_id is not null into v_entry_reversed
    from public.journal_entries je where je.id = v_inv.journal_entry_id;
    if coalesce(v_entry_reversed, false) then
      raise exception 'De grootboekboeking van factuur % is tegengeboekt; er valt niets meer af te letteren.', coalesce(v_inv.number, '')
        using errcode = '23514';
    end if;

    -- FIX 2: begrens op het openstaande saldo. GEWIJZIGD (20261104010000):
    -- één berekening voor heel de app, die ook Mollie-betalingen en
    -- creditnota's meetelt (eerder alleen bankboekingen, zodat een via Mollie
    -- betaalde of gecrediteerde factuur nog eens kon worden afgeletterd).
    v_open := public.invoice_open_receivable_cents(p_organization_id, v_inv.id, v_txn.id);
    if v_open <= 0 then
      raise exception 'Factuur % is al volledig afgeletterd.', coalesce(v_inv.number, '') using errcode = '23514';
    end if;
    if v_abs > v_open then
      raise exception 'Ontvangst (€ %) is hoger dan het openstaande saldo van factuur % (€ %). Koppelen aan deze factuur kan dan niet; boek de transactie via een grootboekrekening (vrije boeking).',
        to_char(v_abs / 100.0, 'FM999999990.00'), coalesce(v_inv.number, ''), to_char(v_open / 100.0, 'FM999999990.00')
        using errcode = '23514';
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
      'description', 'Debiteuren — factuur ' || coalesce(v_inv.number, ''),
      'debit_cents', 0, 'credit_cents', v_abs,
      'client_id', v_inv.client_id
    ));

  elsif p_matched_purchase_invoice_id is not null then
    if v_txn.amount_cents >= 0 then
      raise exception 'Een inkoopfactuur afletteren kan alleen bij een betaling.' using errcode = '23514';
    end if;
    select * into v_pi from public.purchase_invoices
    where id = p_matched_purchase_invoice_id and organization_id = p_organization_id for update;
    if not found then raise exception 'Inkoopfactuur niet gevonden.' using errcode = '02000'; end if;

    -- FIX 2: zelfde bewaking als bij verkoopfacturen, spiegelbeeldig op 1600.
    if v_pi.journal_entry_id is null then
      raise exception 'Inkoopfactuur % staat nog niet in het grootboek. Boek de inkoopfactuur eerst en letter daarna af.',
        coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
    end if;
    select je.reversed_by_entry_id is not null into v_entry_reversed
    from public.journal_entries je where je.id = v_pi.journal_entry_id;
    if coalesce(v_entry_reversed, false) then
      raise exception 'De grootboekboeking van inkoopfactuur % is tegengeboekt; er valt niets meer af te letteren.',
        coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
    end if;

    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_doc_total
    from public.journal_lines jl
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.entry_id = v_pi.journal_entry_id and la.subtype = 'accounts_payable';

    -- Spiegelbeeldig aan de verkoopkant: eerdere betalingen uit de journaalregels
    -- (debet op 1600), niet uit het matchveld.
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) into v_already
    from public.bank_transactions bt
    join public.journal_entries je2 on je2.id = bt.journal_entry_id and je2.reversed_by_entry_id is null
    join public.journal_lines jl on jl.entry_id = je2.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
    where bt.organization_id = p_organization_id
      and bt.matched_purchase_invoice_id = v_pi.id
      and bt.status = 'booked'
      and bt.id <> v_txn.id;

    v_open := v_doc_total - v_already;
    if v_open <= 0 then
      raise exception 'Inkoopfactuur % is al volledig afgeletterd.',
        coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
    end if;
    if v_abs > v_open then
      raise exception 'Betaling (€ %) is hoger dan het openstaande saldo van inkoopfactuur % (€ %). Koppelen aan deze inkoopfactuur kan dan niet; boek de transactie via een grootboekrekening (vrije boeking).',
        to_char(v_abs / 100.0, 'FM999999990.00'),
        coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''),
        to_char(v_open / 100.0, 'FM999999990.00')
        using errcode = '23514';
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1600'),
      'description', 'Crediteuren — ' || coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''),
      'debit_cents', v_abs, 'credit_cents', 0,
      'supplier_id', v_pi.supplier_id
    ));

  elsif p_lines is not null and jsonb_typeof(p_lines) = 'array' and jsonb_array_length(p_lines) > 0 then
    -- Vrije boeking: per regel bruto bedrag + BTW-code; net/BTW worden gesplitst.
    -- FIX 3: de BTW-verwerking kijkt nu naar vat_codes.kind én naar de AARD van
    -- de tegenrekening, niet naar het teken van de banktransactie:
    --   · omzetrekening       → 1510 Af te dragen BTW (kant volgt de regel)
    --   · kosten/activa       → 1500 Voorbelasting   (kant volgt de regel)
    --   · verlegd/EU-verwerving (kind) → grondslag = volle bankbedrag,
    --     BTW als 1500 + 1520 tegen elkaar in, zoals book_purchase_invoice.
    for r in
      select
        acc.account_id,
        la.type as account_type,
        coalesce((l->>'amount_cents')::bigint, 0) as gross_cents,
        nullif(l->>'vat_code','') as vat_code,
        nullif(l->>'description','') as description,
        coalesce(vc.rate, nullif(l->>'vat_rate','')::numeric, 0) as rate,
        coalesce(vc.kind, 'standard') as kind
      from jsonb_array_elements(p_lines) l
      cross join lateral (
        select coalesce(nullif(l->>'account_id','')::uuid, public.bookkeeping_account_id(p_organization_id, l->>'account_code')) as account_id
      ) acc
      left join public.ledger_accounts la
        on la.id = acc.account_id and la.organization_id = p_organization_id
      left join public.vat_codes vc
        on vc.organization_id = p_organization_id and vc.code = (l->>'vat_code')
    loop
      if r.gross_cents = 0 then continue; end if;
      -- Onthoud hoeveel er op 1530 Te betalen omzetbelasting wordt geboekt (voor de
      -- automatische koppeling met de aangifte hieronder).
      if r.account_id = v_vat_payable_id then
        v_vat_payable_booked := v_vat_payable_booked + r.gross_cents;
      end if;
      declare
        v_is_credit boolean := v_txn.amount_cents > 0; -- regelkant volgt de bank
        v_net bigint;
        v_vat bigint;
      begin
        -- GEWIJZIGD (20261104010000): invoer/diensten van buiten de EU (IMPORT,
        -- rubriek 4a) is net zo verlegd; de leverancier rekent geen Nederlandse btw.
        if r.kind in ('reverse_charge_purchase', 'eu_acquisition', 'import_non_eu') then
          -- Verlegd/EU-verwerving: de betaling is exclusief BTW — het volle
          -- bankbedrag is de grondslag. BTW zelf aangeven én aftrekken.
          v_net := r.gross_cents;
          v_vat := round(r.gross_cents * r.rate / 100.0);
          if v_is_credit then
            -- Terugontvangst van een verlegde leverancier: beide kanten terugdraaien.
            v_vat_1500 := v_vat_1500 - v_vat;
            v_vat_1520 := v_vat_1520 - v_vat;
          else
            v_vat_1500 := v_vat_1500 + v_vat;
            v_vat_1520 := v_vat_1520 + v_vat;
          end if;
        else
          -- Inclusief-BTW-splitsing (bruto → net + BTW), centneutraal.
          v_net := round(r.gross_cents / (1 + r.rate / 100.0));
          v_vat := r.gross_cents - v_net;
          if r.account_type = 'revenue' then
            -- Omzet: BTW hoort op 1510 — ook bij een terugbetaling aan een
            -- klant (dan als debet, zodat de af te dragen BTW dáált i.p.v.
            -- dat er voorbelasting bij wordt verzonnen).
            v_vat_1510 := v_vat_1510 + case when v_is_credit then v_vat else -v_vat end;
          elsif r.account_type in ('expense', 'asset') then
            -- Kosten/activa: BTW hoort op 1500 — ook bij een terugstorting
            -- van een leverancier (dan als credit: voorbelasting terugnemen).
            v_vat_1500 := v_vat_1500 + case when v_is_credit then -v_vat else v_vat end;
          else
            -- Balansrekening/onbekend: gedrag van vóór deze fix (geldrichting).
            if v_is_credit then
              v_vat_1510 := v_vat_1510 + v_vat;
            else
              v_vat_1500 := v_vat_1500 + v_vat;
            end if;
          end if;
        end if;

        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', r.account_id,
          'description', coalesce(r.description, case when v_is_credit then 'Ontvangst' else 'Betaling' end),
          'debit_cents', case when v_is_credit then 0 else v_net end,
          'credit_cents', case when v_is_credit then v_net else 0 end,
          'vat_code', r.vat_code, 'vat_rate', r.rate,
          -- Rubriekconsistentie: op omzetregels telt compute_vat_return
          -- vat_amount_cents op naast credit−debit; een debet-omzetregel
          -- (terugbetaling) moet dus een negatieve grondslag/BTW dragen.
          'vat_base_cents', case when r.account_type = 'revenue' and not v_is_credit then -v_net else v_net end,
          'vat_amount_cents', case when r.account_type = 'revenue' and not v_is_credit then -v_vat else v_vat end));
      end;
    end loop;

    if v_vat_1510 <> 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
        'description', 'Af te dragen BTW',
        'debit_cents', case when v_vat_1510 < 0 then -v_vat_1510 else 0 end,
        'credit_cents', case when v_vat_1510 > 0 then v_vat_1510 else 0 end));
    end if;
    if v_vat_1500 <> 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1500'),
        'description', 'Voorbelasting',
        'debit_cents', case when v_vat_1500 > 0 then v_vat_1500 else 0 end,
        'credit_cents', case when v_vat_1500 < 0 then -v_vat_1500 else 0 end));
    end if;
    if v_vat_1520 <> 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1520'),
        'description', 'Verschuldigde BTW verlegd/ICP',
        'debit_cents', case when v_vat_1520 < 0 then -v_vat_1520 else 0 end,
        'credit_cents', case when v_vat_1520 > 0 then v_vat_1520 else 0 end));
    end if;

  else
    raise exception 'Geen tegenrekening: letter een factuur af of kies een grootboekrekening.' using errcode = '23514';
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, v_txn.booking_date, v_desc, 'payment', v_txn.id, v_lines, p_created_by
  );

  -- De matchvelden beschrijven wat deze boeking DAADWERKELIJK deed. Voorheen
  -- (coalesce) bleef een achtergebleven matcher-suggestie staan wanneer er via
  -- vrije regels werd geboekt — waardoor die rij ten onrechte als aflettering op
  -- die factuur telde. Nu: vrije boeking → beide matchvelden leeg.
  update public.bank_transactions set
    status = 'booked',
    journal_entry_id = v_entry.id,
    matched_invoice_id = p_matched_invoice_id,
    matched_purchase_invoice_id = p_matched_purchase_invoice_id,
    booked_at = now(),
    booked_by = p_created_by,
    updated_at = now()
  where id = v_txn.id;

  -- TOEGEVOEGD (20261104010000): is de factuur hiermee volledig betaald, dan
  -- staat hij op betaald. Anders liep hij naar "achterstallig" en kreeg de klant
  -- herinneringen en een aanmaning voor een al betaalde factuur.
  if p_matched_invoice_id is not null
     and public.invoice_open_receivable_cents(p_organization_id, p_matched_invoice_id) <= 0 then
    update public.invoices
    set status = 'paid',
        paid_at = coalesce(paid_at, (v_txn.booking_date::timestamp + time '12:00') at time zone 'Europe/Amsterdam'),
        updated_at = now()
    where id = p_matched_invoice_id
      and organization_id = p_organization_id
      and status in ('sent', 'overdue');
  end if;

  -- Lus sluiten: viel deze boeking op 1530 Te betalen omzetbelasting? Zoek dan de
  -- afgeronde aangifte (finalized/filed) met datzelfde saldo in dezelfde richting.
  -- We matchen ALTIJD op het AFGERONDE saldo (hele euro's); voor aangiftes van vóór
  -- 20260710010000 (zonder saldo_afgerond in de snapshot) ronden we hun exacte saldo
  -- hier op dezelfde manier af. Alleen bij een ondubbelzinnige match markeren.
  if v_vat_payable_booked > 0 then
    v_target_saldo := case when v_txn.amount_cents < 0 then v_vat_payable_booked else -v_vat_payable_booked end;
    select count(*) into v_match_count
    from public.vat_returns
    where organization_id = p_organization_id
      and status in ('finalized', 'filed')
      and coalesce(
        (rubrieken->>'saldo_afgerond')::bigint,
        round((rubrieken->>'saldo')::bigint::numeric / 100.0)::bigint * 100
      ) = v_target_saldo;
    if v_match_count = 1 then
      select id into v_match_id
      from public.vat_returns
      where organization_id = p_organization_id
        and status in ('finalized', 'filed')
        and coalesce(
          (rubrieken->>'saldo_afgerond')::bigint,
          round((rubrieken->>'saldo')::bigint::numeric / 100.0)::bigint * 100
        ) = v_target_saldo
      limit 1;
      update public.vat_returns
      set status = 'paid', paid_bank_transaction_id = v_txn.id, updated_at = now()
      where id = v_match_id;
    end if;
  end if;

  return v_entry;
end;
$function$;


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
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
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


CREATE OR REPLACE FUNCTION public.book_purchase_invoice(p_organization_id uuid, p_purchase_invoice_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_pi public.purchase_invoices;
  v_kor boolean;
  v_lines jsonb := '[]'::jsonb;
  v_expense jsonb := '[]'::jsonb;
  v_input_vat bigint := 0;
  v_reverse_vat bigint := 0;
  v_creditors bigint := 0;
  v_entry public.journal_entries;
  v_book_date date;
  v_desc text;
  r record;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_pi from public.purchase_invoices
  where id = p_purchase_invoice_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Inkoopfactuur niet gevonden.' using errcode = '02000';
  end if;
  if v_pi.status <> 'draft' then
    raise exception 'Inkoopfactuur is al geboekt of geannuleerd.' using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104010000): het grootboek rekent niet om; een bedrag in
  -- vreemde valuta kwam er anders 1-op-1 als euro's in (kosten, btw, 4a/4b).
  if upper(coalesce(nullif(btrim(v_pi.currency), ''), 'EUR')) <> 'EUR' then
    raise exception 'Deze inkoopfactuur is in % opgesteld. Reken de bedragen om naar euro''s (koers van de factuurdatum) en zet de valuta op EUR voordat je boekt.',
      upper(v_pi.currency) using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  select coalesce(kor_enabled, false) into v_kor from public.company_settings where organization_id = p_organization_id;
  v_kor := coalesce(v_kor, false);

  -- Aggregeer per kostenrekening + btw-code + tarief; rond de BTW per groep.
  -- De code blijft op de regel staan zodat de aangifte 2a/4a/4b kan scheiden.
  for r in
    select
      coalesce(nullif(l->>'account_id','')::uuid, public.bookkeeping_account_id(p_organization_id, '4500')) as account_id,
      nullif(btrim(coalesce(l->>'vat_code', '')), '') as vat_code,
      coalesce(vc.kind, 'standard') as kind,
      coalesce(nullif(l->>'vat_rate','')::numeric, vc.rate, 0) as rate,
      sum(coalesce((l->>'amount_cents')::bigint, 0)) as base_cents
    from jsonb_array_elements(v_pi.lines) as l
    left join public.vat_codes vc
      on vc.organization_id = p_organization_id and vc.code = nullif(btrim(coalesce(l->>'vat_code', '')), '')
    group by 1, 2, 3, 4
  loop
    declare
      v_vat bigint := round(r.base_cents * r.rate / 100.0);
      v_expense_debit bigint := r.base_cents;
    begin
      if v_kor and r.kind in ('reverse_charge_purchase','eu_acquisition','icp_goods','icp_services','import_non_eu') then
        -- TOEGEVOEGD (20261104010000): ook met de KOR moet verlegde btw worden
        -- aangegeven en betaald (2a/4a/4b), zonder aftrek. De leverancier krijgt
        -- alleen de grondslag; de btw is een schuld aan de Belastingdienst en
        -- komt bij de kosten.
        v_expense_debit := r.base_cents + v_vat;
        v_reverse_vat := v_reverse_vat + v_vat;
        v_creditors := v_creditors + r.base_cents;
      elsif v_kor then
        -- KOR: geen aftrek; BTW wordt onderdeel van de kosten.
        v_expense_debit := r.base_cents + v_vat;
        v_creditors := v_creditors + r.base_cents + v_vat;
      elsif r.kind in ('reverse_charge_purchase','eu_acquisition','icp_goods','icp_services','import_non_eu') then
        -- Verlegd/EU-verwerving/invoer art. 23: zelf afdragen én aftrekken;
        -- de leverancier factureert exclusief BTW.
        v_input_vat := v_input_vat + v_vat;
        v_reverse_vat := v_reverse_vat + v_vat;
        v_creditors := v_creditors + r.base_cents;
      else
        -- Normaal binnenland (21/9/0/vrijgesteld).
        v_input_vat := v_input_vat + v_vat;
        v_creditors := v_creditors + r.base_cents + v_vat;
      end if;

      -- GEWIJZIGD (20261104010000): een negatieve groep (creditnota van de
      -- leverancier, kortingsregel) komt aan de creditzijde; een negatieve
      -- debet bestaat niet en liet het boeken vastlopen.
      v_expense := v_expense || jsonb_build_array(jsonb_build_object(
        'account_id', r.account_id,
        'description', 'Inkoopkosten',
        'debit_cents', greatest(v_expense_debit, 0),
        'credit_cents', greatest(-v_expense_debit, 0),
        'vat_code', r.vat_code,
        'vat_rate', r.rate,
        'vat_base_cents', r.base_cents,
        'vat_amount_cents', v_vat,
        'supplier_id', v_pi.supplier_id
      ));
    end;
  end loop;

  v_lines := v_expense;

  if v_input_vat <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1500'),
      'description', 'Voorbelasting',
      'debit_cents', greatest(v_input_vat, 0), 'credit_cents', greatest(-v_input_vat, 0),
      'supplier_id', v_pi.supplier_id
    ));
  end if;
  if v_reverse_vat <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1520'),
      'description', 'Verschuldigde BTW verlegd/ICP',
      'debit_cents', greatest(-v_reverse_vat, 0), 'credit_cents', greatest(v_reverse_vat, 0),
      'supplier_id', v_pi.supplier_id
    ));
  end if;

  if v_creditors = 0 and not exists (select 1 from jsonb_array_elements(v_lines) x where coalesce((x->>'debit_cents')::bigint, 0) <> 0 or coalesce((x->>'credit_cents')::bigint, 0) <> 0) then
    raise exception 'Deze inkoopfactuur heeft geen bedragen om te boeken.' using errcode = '23514';
  end if;
  if v_creditors <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1600'),
      'description', case when v_creditors < 0 then 'Crediteuren (creditnota)' else 'Crediteuren' end,
      'debit_cents', greatest(-v_creditors, 0), 'credit_cents', greatest(v_creditors, 0),
      'supplier_id', v_pi.supplier_id
    ));
  end if;

  -- Nagekomen inkoopfactuur (bv. maart-factuur ontdekt in juli terwijl Q1 al
  -- is ingediend): boek op de eerstvolgende open datum i.p.v. hard weigeren.
  v_book_date := public.first_open_booking_date(p_organization_id, v_pi.date);
  v_desc := 'Inkoopfactuur ' || coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '');
  if v_book_date <> v_pi.date then
    v_desc := v_desc || ' (factuurdatum ' || to_char(v_pi.date, 'DD-MM-YYYY') || ', geboekt in eerstvolgende open periode)';
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date, v_desc,
    'purchase_invoice', v_pi.id, v_lines, p_created_by
  );

  update public.purchase_invoices
  set status = 'booked', journal_entry_id = v_entry.id
  where id = v_pi.id;

  return v_entry;
end;
$function$;


CREATE OR REPLACE FUNCTION public.close_fiscal_year(p_organization_id uuid, p_fiscal_year_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS fiscal_years
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_fy public.fiscal_years;
  v_kor boolean;
  v_vat_period text;
  v_result_code text;
  v_lines jsonb := '[]'::jsonb;
  v_debit_total bigint := 0;   -- som van de debiteringen tegen omzetrekeningen
  v_credit_total bigint := 0;  -- som van de crediteringen tegen kostenrekeningen
  v_result_cents bigint := 0;  -- nettoresultaat (winst > 0, verlies < 0)
  v_entry public.journal_entries;
  v_result_account uuid;
  r record;
  v_cursor date;
  v_p_start date;
  v_p_end date;
  v_regime text;
  v_partnership boolean := false;
  v_share_total integer := 0;
  v_capital uuid;
  s record;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Serialiseer close/reopen per organisatie (voorkomt dubbele resultaatbestemming).
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':fyclose'));
  -- TOEGEVOEGD (20261104000000): exclusief op de boekingsgrendel, zodat er
  -- geen boeking meer in dit jaar valt tussen het optellen en het slot.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':periodegrendel'));

  select * into v_fy from public.fiscal_years
  where id = p_fiscal_year_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Boekjaar niet gevonden.' using errcode = '02000';
  end if;
  if v_fy.status = 'closed' then
    raise exception 'Dit boekjaar is al afgesloten.' using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): een lopend boekjaar sluit je niet af; latere
  -- boekingen zouden anders naar het volgende jaar schuiven.
  if v_fy.period_end >= current_date then
    raise exception 'Dit boekjaar loopt nog tot en met %; afsluiten kan vanaf de dag daarna.',
      to_char(v_fy.period_end, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  -- Sequentiële volgorde: geen geboekte transacties vóór dit boekjaar die niet in
  -- een afgesloten jaar-slot vallen (dus het voorgaande boekjaar moet dicht zijn).
  if exists (
    select 1 from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.source_type <> 'year_close'
      and je.date < v_fy.period_start
      and not exists (
        select 1 from public.closed_periods cp
        where cp.organization_id = p_organization_id
          and cp.period_type = 'year'
          and je.date between cp.period_start and cp.period_end
      )
  ) then
    raise exception 'Sluit eerst het voorgaande boekjaar af voordat je dit boekjaar afsluit.' using errcode = '23514';
  end if;

  -- BTW hard block (tenzij KOR): elke kalender-aangifteperiode die binnen het
  -- boekjaar begint, moet gefinaliseerd (afgesloten) zijn.
  select coalesce(kor_enabled, false), coalesce(vat_return_period, 'quarterly'),
         coalesce(year_result_account_code, '0510')
    into v_kor, v_vat_period, v_result_code
  from public.company_settings where organization_id = p_organization_id;
  v_kor := coalesce(v_kor, false);
  v_vat_period := coalesce(v_vat_period, 'quarterly');
  v_result_code := coalesce(v_result_code, '0510');

  if not v_kor then
    v_cursor := date_trunc(case when v_vat_period = 'monthly' then 'month' else 'quarter' end, v_fy.period_start)::date;
    while v_cursor <= v_fy.period_end loop
      if v_vat_period = 'monthly' then
        v_p_start := v_cursor;
        v_p_end := (v_cursor + interval '1 month' - interval '1 day')::date;
      else
        v_p_start := v_cursor;
        v_p_end := (v_cursor + interval '3 months' - interval '1 day')::date;
      end if;
      -- Elke kalender-aangifteperiode die het boekjaar OVERLAPT moet gefinaliseerd
      -- zijn (ook een leidende/afsluitende deelperiode bij een gebroken boekjaar dat
      -- niet op een kwartaal-/maandgrens begint). Match strikt op de ingestelde
      -- frequentie én het volledige bereik dat finalize_vat_return vastlegt, zodat een
      -- maand-finalisatie niet ten onrechte als kwartaal-finalisatie telt.
      if v_p_end >= v_fy.period_start and v_p_start <= v_fy.period_end then
        if not exists (
          select 1 from public.closed_periods cp
          where cp.organization_id = p_organization_id
            and cp.period_type = case when v_vat_period = 'monthly' then 'month' else 'quarter' end
            and cp.period_start = v_p_start
            and cp.period_end = v_p_end
        ) then
          raise exception 'Finaliseer eerst alle BTW-aangiften van dit boekjaar (ontbreekt de periode % t/m %).',
            to_char(v_p_start, 'DD-MM-YYYY'), to_char(v_p_end, 'DD-MM-YYYY')
            using errcode = '23514';
        end if;
      end if;
      v_cursor := (v_p_end + interval '1 day')::date;
    end loop;
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Sluitregels per W&V-rekening (exclusief eerdere/teruggedraaide year_close).
  for r in
    select jl.account_id, la.type as account_type,
           sum(jl.debit_cents) as d, sum(jl.credit_cents) as c
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.source_type <> 'year_close'
      and je.date between v_fy.period_start and v_fy.period_end
      and la.type in ('revenue', 'expense')
    group by jl.account_id, la.type
    having sum(jl.credit_cents - jl.debit_cents) <> 0
  loop
    if (r.c - r.d) > 0 then
      -- creditsaldo (typisch omzet): debiteer om op nul te zetten.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', r.account_id, 'description', 'Resultaatbestemming jaarafsluiting',
        'debit_cents', (r.c - r.d), 'credit_cents', 0));
      v_debit_total := v_debit_total + (r.c - r.d);
    else
      -- debetsaldo (typisch kosten): crediteer om op nul te zetten.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', r.account_id, 'description', 'Resultaatbestemming jaarafsluiting',
        'debit_cents', 0, 'credit_cents', (r.d - r.c)));
      v_credit_total := v_credit_total + (r.d - r.c);
    end if;
  end loop;

  -- Nettoresultaat volgt als restpost → boekstuk sluit exact (geen 4900-vangnet).
  v_result_cents := v_debit_total - v_credit_total;

  -- TOEGEVOEGD (20261104070000): bij een vof, maatschap of cv met vastgelegde
  -- vennoten is de winst van de vennoten. Het resultaat gaat dan naar hun
  -- kapitaalrekeningen, volgens de winstverdeling, tot op de cent sluitend.
  v_regime := public.org_fiscal_regime(p_organization_id);
  v_partnership := v_regime = 'ib'
    and public.org_legal_form(p_organization_id) in ('vof', 'maatschap', 'cv')
    and exists (
      select 1 from public.partnership_partners pp
      where pp.organization_id = p_organization_id and pp.is_active
    );

  if v_partnership then
    select coalesce(sum(pp.profit_share_basis_points), 0)::int into v_share_total
    from public.partnership_partners pp
    where pp.organization_id = p_organization_id and pp.is_active;
    if v_share_total <> 10000 then
      raise exception 'De winstverdeling van de vennoten telt op tot % procent; dat moet precies 100 procent zijn. Pas de verdeling aan bij Financiën → Vennoten.',
        replace(rtrim(to_char(v_share_total / 100.0, 'FM990.99'), '.'), '.', ',') using errcode = '23514';
    end if;

    if v_result_cents <> 0 then
      for s in select * from public.partnership_result_shares(p_organization_id, v_result_cents) loop
        if s.share_cents > 0 then
          v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'account_id', s.capital_account_id,
            'description', 'Winstaandeel ' || s.name || ' boekjaar ' || v_fy.label,
            'debit_cents', 0, 'credit_cents', s.share_cents));
        elsif s.share_cents < 0 then
          v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'account_id', s.capital_account_id,
            'description', 'Verliesaandeel ' || s.name || ' boekjaar ' || v_fy.label,
            'debit_cents', -s.share_cents, 'credit_cents', 0));
        end if;
      end loop;
    end if;

    -- Het privé van elke vennoot (ook een vertrokken vennoot) gaat naar zijn
    -- eigen kapitaal.
    for s in
      select pp.name, pp.capital_account_id, acc.account_id, acc.label,
             (select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)
              from public.journal_lines jl
              join public.journal_entries je on je.id = jl.entry_id
              where jl.organization_id = p_organization_id
                and je.status = 'posted'
                and je.date <= v_fy.period_end
                and jl.account_id = acc.account_id)::bigint as bal
      from public.partnership_partners pp
      cross join lateral (values
        (pp.withdrawals_account_id, 'Privé-opnamen'),
        (pp.contributions_account_id, 'Privé-stortingen')
      ) as acc(account_id, label)
      where pp.organization_id = p_organization_id
      order by pp.partner_number, acc.label
    loop
      if s.bal <> 0 then
        v_lines := v_lines || jsonb_build_array(
          jsonb_build_object('account_id', s.account_id,
            'description', s.label || ' ' || s.name || ' naar kapitaal',
            'debit_cents', greatest(-s.bal, 0), 'credit_cents', greatest(s.bal, 0)),
          jsonb_build_object('account_id', s.capital_account_id,
            'description', s.label || ' ' || s.name || ' boekjaar ' || v_fy.label,
            'debit_cents', greatest(s.bal, 0), 'credit_cents', greatest(-s.bal, 0)));
      end if;
    end loop;
  elsif v_result_cents <> 0 then
    v_result_account := public.bookkeeping_account_id(p_organization_id, v_result_code);
    if v_result_cents > 0 then
      -- winst → crediteer de resultaatrekening (eigen vermogen stijgt).
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_result_account, 'description', 'Resultaat boekjaar ' || v_fy.label,
        'debit_cents', 0, 'credit_cents', v_result_cents));
    else
      -- verlies → debiteer de resultaatrekening (eigen vermogen daalt).
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_result_account, 'description', 'Resultaat boekjaar ' || v_fy.label,
        'debit_cents', -v_result_cents, 'credit_cents', 0));
    end if;
  end if;

  -- TOEGEVOEGD (20261104070000): privé-opnamen en -stortingen van een
  -- IB-onderneming (0550/0560, herkend aan het subtype) gaan naar het eigen
  -- vermogen. Bij een vof met vennoten staat hier alleen wat niet op de
  -- privérekening van een vennoot is geboekt; dat komt op 0500 en blijft in
  -- het overzicht als "nog niet aan een vennoot toegewezen" zichtbaar.
  if v_regime = 'ib' then
    v_capital := public.bookkeeping_account_id(p_organization_id, '0500');
    for s in
      select la.id as account_id, la.name,
             (select coalesce(sum(jl.debit_cents - jl.credit_cents), 0)
              from public.journal_lines jl
              join public.journal_entries je on je.id = jl.entry_id
              where jl.organization_id = p_organization_id
                and je.status = 'posted'
                and je.date <= v_fy.period_end
                and jl.account_id = la.id)::bigint as bal
      from public.ledger_accounts la
      where la.organization_id = p_organization_id
        and la.subtype in ('private_withdrawals', 'private_contributions')
      order by la.code
    loop
      if s.bal <> 0 then
        v_lines := v_lines || jsonb_build_array(
          jsonb_build_object('account_id', s.account_id,
            'description', s.name || ' naar eigen vermogen',
            'debit_cents', greatest(-s.bal, 0), 'credit_cents', greatest(s.bal, 0)),
          jsonb_build_object('account_id', v_capital,
            'description', s.name || ' boekjaar ' || v_fy.label,
            'debit_cents', greatest(s.bal, 0), 'credit_cents', greatest(-s.bal, 0)));
      end if;
    end loop;
  end if;

  -- Post het afsluitboekstuk (leeg boekjaar → geen boekstuk).
  if jsonb_array_length(v_lines) > 0 then
    perform set_config('resofly.trusted_journal_source', 'year_close', true);
    v_entry := public.post_journal_entry(
      p_organization_id, v_fy.period_end,
      'Jaarafsluiting ' || v_fy.label,
      'year_close', p_fiscal_year_id, v_lines, p_created_by
    );
  end if;

  -- Vergrendel het volledige boekjaarbereik.
  insert into public.closed_periods(organization_id, period_type, year, quarter, month, period_start, period_end, closed_by)
  values (
    p_organization_id, 'year', extract(year from v_fy.period_start)::int, null, null,
    v_fy.period_start, v_fy.period_end, p_created_by
  )
  on conflict (organization_id, period_type, period_start, period_end) do nothing;

  update public.fiscal_years
  set status = 'closed', close_journal_entry_id = v_entry.id,
      result_account_code = case when v_partnership then 'vennoten' else v_result_code end,
      result_cents = v_result_cents,
      closed_at = now(), closed_by = p_created_by
  where id = p_fiscal_year_id
  returning * into v_fy;

  return v_fy;
end;
$function$;


CREATE OR REPLACE FUNCTION public.create_opening_balance(p_organization_id uuid, p_as_of_date date, p_lines jsonb, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lines jsonb;
  v_debit bigint;
  v_credit bigint;
  v_equity bigint;
  v_existing text;
  v_plug_code text;
  v_plug_label text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
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
    -- GEWIJZIGD (20261104000000): de tegenboeking van een beginbalans is zelf
    -- geen beginbalans; anders kon er nooit een nieuwe komen.
    and je.reverses_entry_id is null
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
$function$;


CREATE OR REPLACE FUNCTION public.create_vat_supplement(p_organization_id uuid, p_original_return_id uuid, p_entry_ids uuid[], p_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_created_by uuid DEFAULT auth.uid())
 RETURNS vat_returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_orig public.vat_returns;
  v_ids uuid[];
  v_cnt integer;
  v_bad text;
  v_delta jsonb;
  v_clear_output bigint;
  v_clear_reverse bigint;
  v_clear_input bigint;
  v_saldo_afgerond bigint;
  v_afronding bigint;
  v_lines jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_book_date date;
  v_label text;
  v_ret public.vat_returns;
  v_id uuid;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_orig from public.vat_returns
  where id = p_original_return_id and organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Aangifte niet gevonden.' using errcode = '02000';
  end if;
  if v_orig.supplements_return_id is not null then
    raise exception 'Maak de suppletie aan op de oorspronkelijke aangifte, niet op een eerdere suppletie.' using errcode = '23514';
  end if;
  if v_orig.status not in ('finalized', 'filed', 'paid') then
    raise exception 'Alleen een definitieve aangifte kan een suppletie krijgen; deze periode is nog een concept.' using errcode = '23514';
  end if;

  -- Ontdubbelen + valideren.
  select array_agg(distinct e) into v_ids from unnest(coalesce(p_entry_ids, '{}'::uuid[])) e;
  if v_ids is null or array_length(v_ids, 1) is null then
    raise exception 'Kies minimaal één boekstuk voor de suppletie.' using errcode = '23514';
  end if;

  select count(*) into v_cnt from public.journal_entries je
  where je.id = any(v_ids) and je.organization_id = p_organization_id and je.status = 'posted';
  if v_cnt <> array_length(v_ids, 1) then
    raise exception 'Eén of meer gekozen boekstukken bestaan niet (of zijn niet geboekt) binnen deze organisatie.' using errcode = '23514';
  end if;

  select coalesce(je.entry_number, je.id::text) into v_bad from public.journal_entries je
  where je.id = any(v_ids) and je.source_type in ('year_close', 'vat_return', 'opening_balance')
  limit 1;
  if v_bad is not null then
    raise exception 'Boekstuk % is een systeemboekstuk (jaarafsluiting/aangifte/beginbalans) en hoort niet in een suppletie.', v_bad using errcode = '23514';
  end if;

  select coalesce(je.entry_number, je.id::text) into v_bad from public.journal_entries je
  where je.id = any(v_ids) and je.reversed_by_entry_id is not null
  limit 1;
  if v_bad is not null then
    raise exception 'Boekstuk % is al tegengeboekt (het paar telt netto nul); verreken het niet in een suppletie.', v_bad using errcode = '23514';
  end if;

  select coalesce(je.entry_number, je.id::text) into v_bad
  from public.vat_supplement_entries vse
  join public.journal_entries je on je.id = vse.entry_id
  where vse.entry_id = any(v_ids)
  limit 1;
  if v_bad is not null then
    raise exception 'Boekstuk % is al in een eerdere suppletie verrekend.', v_bad using errcode = '23514';
  end if;

  -- TOEGEVOEGD (20261104010000): een boekstuk binnen een afgesloten
  -- btw-periode zat al in de aangifte over die periode. Nog eens verrekenen
  -- gaf dubbele voorbelasting (of dubbel af te dragen btw).
  select coalesce(je.entry_number, je.id::text) into v_bad
  from public.journal_entries je
  where je.id = any(v_ids)
    and exists (
      select 1 from public.closed_periods cp
      where cp.organization_id = p_organization_id
        and cp.period_type in ('month', 'quarter')
        and je.date between cp.period_start and cp.period_end
    )
  limit 1;
  if v_bad is not null then
    raise exception 'Boekstuk % valt in een al afgesloten btw-periode en zat dus al in die aangifte; het hoort niet (nog eens) in een suppletie.', v_bad
      using errcode = '23514';
  end if;

  -- Delta over exact deze boekstukken.
  v_delta := public.compute_vat_boxes(p_organization_id, null, null, v_ids);
  v_clear_output := (v_delta->>'clear_output')::bigint;
  v_clear_reverse := (v_delta->>'clear_reverse')::bigint;
  v_clear_input := (v_delta->>'clear_input')::bigint;
  v_saldo_afgerond := (v_delta->>'saldo_afgerond')::bigint;
  v_afronding := (v_delta->>'afronding_cents')::bigint;

  v_label := case when v_orig.period_type = 'quarter'
    then 'Q' || v_orig.period_index || ' ' || v_orig.year
    else lpad(v_orig.period_index::text, 2, '0') || '-' || v_orig.year end;

  -- Doorboeking: de btw-effecten van de correctieboekstukken van 1510/1520/1500
  -- naar 1530 (het bedrag dat de suppletie werkelijk oplevert/kost). De
  -- boekdatum valt in de eerstvolgende open periode; door de verrekening via
  -- vat_supplement_entries telt dit paar daar niet in de reguliere aangifte.
  perform public.ensure_default_ledger_accounts(p_organization_id);
  if v_clear_output <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Suppletie ' || v_label || ': af te dragen BTW',
      'debit_cents', case when v_clear_output > 0 then v_clear_output else 0 end,
      'credit_cents', case when v_clear_output < 0 then -v_clear_output else 0 end));
  end if;
  if v_clear_reverse <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1520'),
      'description', 'Suppletie ' || v_label || ': verlegde/ICP BTW',
      'debit_cents', case when v_clear_reverse > 0 then v_clear_reverse else 0 end,
      'credit_cents', case when v_clear_reverse < 0 then -v_clear_reverse else 0 end));
  end if;
  if v_clear_input <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1500'),
      'description', 'Suppletie ' || v_label || ': voorbelasting',
      'debit_cents', case when v_clear_input < 0 then -v_clear_input else 0 end,
      'credit_cents', case when v_clear_input > 0 then v_clear_input else 0 end));
  end if;
  if v_saldo_afgerond <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1530'),
      'description', 'Suppletie ' || v_label || ': te betalen/terug te ontvangen',
      'debit_cents', case when v_saldo_afgerond < 0 then -v_saldo_afgerond else 0 end,
      'credit_cents', case when v_saldo_afgerond > 0 then v_saldo_afgerond else 0 end));
  end if;
  if v_afronding <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '4900'),
      'description', 'Suppletie ' || v_label || ': afrondingsverschil',
      'debit_cents', case when v_afronding < 0 then -v_afronding else 0 end,
      'credit_cents', case when v_afronding > 0 then v_afronding else 0 end));
  end if;

  if jsonb_array_length(v_lines) > 0 then
    v_book_date := public.first_open_booking_date(p_organization_id, coalesce(p_date, current_date));
    v_entry := public.post_journal_entry(
      p_organization_id, v_book_date,
      'BTW-suppletie ' || v_label,
      'vat_return', v_orig.id, v_lines, p_created_by
    );
  end if;

  insert into public.vat_returns(
    organization_id, created_by, period_type, year, period_index, period_start, period_end,
    status, rubrieken, journal_entry_id, supplements_return_id, notes, finalized_at
  ) values (
    p_organization_id, p_created_by, v_orig.period_type, v_orig.year, v_orig.period_index,
    v_orig.period_start, v_orig.period_end,
    'finalized',
    v_delta || jsonb_build_object('is_supplement', true, 'entry_ids', to_jsonb(v_ids)),
    v_entry.id, v_orig.id, nullif(btrim(coalesce(p_notes, '')), ''), now()
  )
  returning * into v_ret;

  -- Verrekende boekstukken + de doorboeking zelf uitsluiten van de reguliere aangifte.
  foreach v_id in array v_ids loop
    insert into public.vat_supplement_entries(organization_id, supplement_id, entry_id)
    values (p_organization_id, v_ret.id, v_id);
  end loop;
  if v_entry.id is not null then
    insert into public.vat_supplement_entries(organization_id, supplement_id, entry_id)
    values (p_organization_id, v_ret.id, v_entry.id);
  end if;

  return v_ret;
end;
$function$;


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
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
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


CREATE OR REPLACE FUNCTION public.ensure_default_ledger_accounts(p_organization_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_regime text;
  v_equity_name text;
  v_equity_subtype text;
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

  -- TOEGEVOEGD (20261104070000): privé-opnamen en -stortingen bij een
  -- IB-onderneming. Herkenning gaat op het subtype, niet op de code: heeft een
  -- administratie 0550 of 0560 al voor iets anders in gebruik, dan blijft die
  -- rekening ongemoeid en telt hij niet als privé.
  if v_regime = 'ib' then
    insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system, report_group)
    values
      (p_organization_id, '0550', 'Privé-opnamen', 'equity', 'private_withdrawals', null, true, 'eigen_vermogen'),
      (p_organization_id, '0560', 'Privé-stortingen', 'equity', 'private_contributions', null, true, 'eigen_vermogen')
    on conflict (organization_id, code) do nothing;
  end if;

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
$function$;


CREATE OR REPLACE FUNCTION public.finalize_vat_return(p_organization_id uuid, p_period_type text, p_year integer, p_period_index integer, p_from date, p_to date, p_created_by uuid DEFAULT auth.uid())
 RETURNS vat_returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ret public.vat_returns;
  v_rubrieken jsonb;
  v_clear_output bigint;
  v_clear_reverse bigint;
  v_clear_input bigint;
  v_saldo_afgerond bigint;
  v_afronding bigint;
  v_lines jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_expected_from date;
  v_expected_to date;
  v_existing_status text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_period_type not in ('month', 'quarter') then
    raise exception 'Ongeldige periodesoort.' using errcode = '23514';
  end if;
  -- GEWIJZIGD (20261104000000): de periode volgt uit soort, jaar en nummer.
  -- Andere datums gaven een tweede, willekeurig slot (tot en met de hele
  -- administratie) en overschreven de aangifte van die periode.
  if p_year is null or p_year < 2000 or p_year > 2100
     or p_period_index is null or p_period_index < 1
     or p_period_index > (case when p_period_type = 'month' then 12 else 4 end) then
    raise exception 'Ongeldige aangifteperiode.' using errcode = '23514';
  end if;
  v_expected_from := make_date(p_year, case when p_period_type = 'month' then p_period_index else (p_period_index - 1) * 3 + 1 end, 1);
  v_expected_to := (v_expected_from
    + case when p_period_type = 'month' then interval '1 month' else interval '3 months' end
    - interval '1 day')::date;
  if p_from is distinct from v_expected_from or p_to is distinct from v_expected_to then
    raise exception 'Deze aangifteperiode loopt van % t/m %; andere datums kunnen niet.',
      to_char(v_expected_from, 'DD-MM-YYYY'), to_char(v_expected_to, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;

  -- Exclusief: geen boeking tussen het optellen en het vergrendelen.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':periodegrendel'));

  -- Een afgesloten aangifte blijft staan; een correctie loopt via een suppletie.
  select status into v_existing_status
  from public.vat_returns
  where organization_id = p_organization_id
    and period_type = p_period_type and year = p_year and period_index = p_period_index
    and supplements_return_id is null;
  if v_existing_status is not null and v_existing_status <> 'draft' then
    raise exception 'De aangifte over deze periode is al afgesloten (%). Een correctie loopt via een suppletie.',
      case v_existing_status when 'finalized' then 'doorgeboekt' when 'filed' then 'ingediend' when 'paid' then 'betaald' else v_existing_status end
      using errcode = '23514';
  end if;

  -- Geen overlap met een ander btw-slot (bv. januari terwijl Q1 al dicht is,
  -- of na een wissel van kwartaal- naar maandaangifte).
  if exists (
    select 1 from public.closed_periods cp
    where cp.organization_id = p_organization_id
      and cp.period_type in ('month', 'quarter')
      and cp.period_start <= p_to and cp.period_end >= p_from
  ) then
    raise exception 'Deze periode valt (deels) in een al afgesloten btw-periode.' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Eén aanroep = één statement = één consistente MVCC-momentopname: wat wordt
  -- doorgeboekt is exact wat in de bevroren rubrieken-snapshot komt.
  v_rubrieken := public.compute_vat_boxes(p_organization_id, p_from, p_to, null);
  v_clear_output := (v_rubrieken->>'clear_output')::bigint;
  v_clear_reverse := (v_rubrieken->>'clear_reverse')::bigint;
  v_clear_input := (v_rubrieken->>'clear_input')::bigint;
  v_saldo_afgerond := (v_rubrieken->>'saldo_afgerond')::bigint;
  v_afronding := (v_rubrieken->>'afronding_cents')::bigint;

  -- Doorboeking: BTW-rekeningen exact afsluiten naar 1530 (tekenvast — een
  -- negatief periodesaldo op een rekening wordt aan de andere kant geboekt).
  if v_clear_output <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Afsluiten af te dragen BTW',
      'debit_cents', case when v_clear_output > 0 then v_clear_output else 0 end,
      'credit_cents', case when v_clear_output < 0 then -v_clear_output else 0 end));
  end if;
  if v_clear_reverse <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1520'),
      'description', 'Afsluiten verlegde/ICP BTW',
      'debit_cents', case when v_clear_reverse > 0 then v_clear_reverse else 0 end,
      'credit_cents', case when v_clear_reverse < 0 then -v_clear_reverse else 0 end));
  end if;
  if v_clear_input <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1500'),
      'description', 'Afsluiten voorbelasting',
      'debit_cents', case when v_clear_input < 0 then -v_clear_input else 0 end,
      'credit_cents', case when v_clear_input > 0 then v_clear_input else 0 end));
  end if;
  if v_saldo_afgerond <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1530'),
      'description', 'Te betalen omzetbelasting (hele euro''s per rubriek)',
      'debit_cents', case when v_saldo_afgerond < 0 then -v_saldo_afgerond else 0 end,
      'credit_cents', case when v_saldo_afgerond > 0 then v_saldo_afgerond else 0 end
    ));
  end if;
  if v_afronding <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '4900'),
      'description', 'Afrondingsverschil BTW-aangifte (cent → hele euro''s)',
      'debit_cents', case when v_afronding < 0 then -v_afronding else 0 end,
      'credit_cents', case when v_afronding > 0 then v_afronding else 0 end
    ));
  end if;

  if jsonb_array_length(v_lines) > 0 then
    v_entry := public.post_journal_entry(
      p_organization_id, p_to,
      'BTW-aangifte doorboeken ' || p_period_type || ' ' || p_period_index || '-' || p_year,
      'vat_return', null, v_lines, p_created_by
    );
  end if;

  insert into public.vat_returns(
    organization_id, created_by, period_type, year, period_index, period_start, period_end,
    status, rubrieken, journal_entry_id, finalized_at
  ) values (
    p_organization_id, p_created_by, p_period_type, p_year, p_period_index, p_from, p_to,
    'finalized', v_rubrieken, v_entry.id, now()
  )
  on conflict (organization_id, period_type, year, period_index) where supplements_return_id is null do update
    set status = 'finalized', rubrieken = excluded.rubrieken, journal_entry_id = excluded.journal_entry_id,
        period_start = excluded.period_start, period_end = excluded.period_end, finalized_at = now(), updated_at = now()
  returning * into v_ret;

  -- Periode vergrendelen (datumbereik).
  insert into public.closed_periods(organization_id, period_type, year, quarter, month, period_start, period_end, closed_by)
  values (
    p_organization_id, p_period_type, p_year,
    case when p_period_type = 'quarter' then p_period_index::smallint else null end,
    case when p_period_type = 'month' then p_period_index::smallint else null end,
    p_from, p_to, p_created_by
  )
  on conflict (organization_id, period_type, period_start, period_end) do nothing;

  return v_ret;
end;
$function$;


CREATE OR REPLACE FUNCTION public.generate_depreciation_schedule(p_organization_id uuid, p_asset_id uuid)
 RETURNS SETOF asset_depreciations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_asset public.fixed_assets;
  v_base bigint;
  v_n integer;
  v_monthly bigint;
  v_remainder bigint;
  v_i integer;
  v_amount bigint;
  v_accum bigint := 0;
  v_period_date date;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;
  -- TOEGEVOEGD (20261104000000): geen nieuw schema voor een afgestoten activum.
  if v_asset.status = 'disposed' then
    raise exception 'Dit activum is afgestoten; een nieuw afschrijvingsschema kan niet meer.' using errcode = '23514';
  end if;

  v_n := v_asset.useful_life_months;
  if v_n <= 0 then
    raise exception 'Ongeldige gebruiksduur.' using errcode = '23514';
  end if;
  v_base := greatest(v_asset.acquisition_cost_cents - v_asset.residual_value_cents, 0);
  v_monthly := v_base / v_n;                 -- gehele centen (afkap)
  v_remainder := v_base - v_monthly * v_n;   -- 0 .. v_n-1 cent restant

  -- Verwijder alleen de nog niet geboekte regels; geboekte regels zijn onveranderbaar.
  delete from public.asset_depreciations where asset_id = p_asset_id and status = 'scheduled';

  for v_i in 1..v_n loop
    -- Restant over de eerste periodes verdelen (elk +1 cent) → som exact v_base.
    v_amount := v_monthly + case when v_i <= v_remainder then 1 else 0 end;
    if v_amount <= 0 then
      continue;                              -- geen nul-regels (bv. nul-basis)
    end if;
    v_accum := v_accum + v_amount;
    v_period_date := (v_asset.start_date + ((v_i - 1) || ' months')::interval)::date;

    -- Bestaat er al een geboekte regel voor deze periode, laat die staan.
    if exists (select 1 from public.asset_depreciations where asset_id = p_asset_id and period_index = v_i and status = 'posted') then
      continue;
    end if;

    insert into public.asset_depreciations(
      organization_id, asset_id, period_index, year, month, date,
      amount_cents, accumulated_after_cents, book_value_after_cents, status
    ) values (
      p_organization_id, p_asset_id, v_i,
      extract(year from v_period_date)::int, extract(month from v_period_date)::smallint, v_period_date,
      v_amount, v_accum, v_asset.acquisition_cost_cents - v_accum, 'scheduled'
    );
  end loop;

  return query select * from public.asset_depreciations where asset_id = p_asset_id order by period_index;
end;
$function$;


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
  if v_stmt_id is not null and v_opening is not null and v_closing is not null
     and v_period_start is not null and v_period_end is not null then
    select coalesce(sum(amount_cents), 0) into v_sum
    from public.bank_transactions
    where bank_account_id = p_bank_account_id
      and booking_date between v_period_start and v_period_end;
    v_balance_diff := v_closing - (v_opening + v_sum);
    v_balance_ok := v_balance_diff = 0;
  end if;

  -- Alleen matchen als er echt iets bij is gekomen: match_bank_transactions loopt
  -- rij voor rij door álle openstaande transacties van de organisatie, en dat is
  -- zonde bij een her-import die niets toevoegt. De knop "Opnieuw matchen" blijft
  -- beschikbaar om het alsnog af te dwingen.
  if v_inserted > 0 then
    perform public.match_bank_transactions(p_organization_id, p_bank_account_id, p_created_by);
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
    'balance_difference_cents', v_balance_diff
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.match_bank_transactions(p_organization_id uuid, p_bank_account_id uuid DEFAULT NULL::uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_txn public.bank_transactions;
  v_inv_id uuid;
  v_pi_id uuid;
  v_rule public.bank_rules;
  v_sup public.suppliers;
  v_suggested integer := 0;
  v_auto integer := 0;
  v_haystack text;
  v_iban text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  for v_txn in
    select * from public.bank_transactions
    where organization_id = p_organization_id
      and status = 'unmatched'
      and (p_bank_account_id is null or bank_account_id = p_bank_account_id)
    order by booking_date
  loop
    v_inv_id := null; v_pi_id := null; v_rule := null; v_sup := null;
    v_haystack := lower(replace(coalesce(v_txn.description,'') || ' ' || coalesce(v_txn.structured_reference,''), ' ', ''));
    v_iban := upper(replace(coalesce(v_txn.counterparty_iban,''), ' ', ''));

    if v_txn.amount_cents > 0 then
      -- Ontvangst: zoek verkoopfactuur op factuurnummer in omschrijving/kenmerk.
      -- FIX 2: alleen facturen die in het grootboek staan (afletterbaar).
      select i.id into v_inv_id
      from public.invoices i
      where i.organization_id = p_organization_id
        and i.status not in ('cancelled','void')
        and i.journal_entry_id is not null
        and i.number is not null and length(btrim(i.number)) > 0
        and position(lower(replace(i.number,' ','')) in v_haystack) > 0
      order by (case when round(coalesce(i.total_amount,0) * 100) = abs(v_txn.amount_cents) then 0 else 1 end), i.date desc
      limit 1;
    elsif v_txn.amount_cents < 0 then
      -- Betaling: zoek inkoopfactuur op intern/leveranciers-nummer.
      -- FIX 2: alleen geboekte inkoopfacturen (afletterbaar).
      select pi.id into v_pi_id
      from public.purchase_invoices pi
      where pi.organization_id = p_organization_id
        and pi.status <> 'cancelled'
        and pi.journal_entry_id is not null
        and (
          (pi.internal_number is not null and position(lower(replace(pi.internal_number,' ','')) in v_haystack) > 0)
          or (pi.supplier_invoice_number is not null and position(lower(replace(pi.supplier_invoice_number,' ','')) in v_haystack) > 0)
        )
      order by (case when pi.total_cents = abs(v_txn.amount_cents) then 0 else 1 end), pi.date desc
      limit 1;
    end if;

    if v_inv_id is not null then
      update public.bank_transactions
      set status = 'suggested', matched_invoice_id = v_inv_id, match_confidence = 'invoice', updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;
    if v_pi_id is not null then
      update public.bank_transactions
      set status = 'suggested', matched_purchase_invoice_id = v_pi_id, match_confidence = 'purchase_invoice', updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;

    -- Regels op prioriteit; eerste match wint.
    select * into v_rule
    from public.bank_rules r
    where r.organization_id = p_organization_id
      and r.is_active
      and (r.match_direction = 'both'
           or (r.match_direction = 'in' and v_txn.amount_cents > 0)
           or (r.match_direction = 'out' and v_txn.amount_cents < 0))
      and (r.match_counterparty_iban is null or upper(replace(r.match_counterparty_iban,' ','')) = v_iban)
      and (r.match_counterparty_name_contains is null or coalesce(v_txn.counterparty_name,'') ilike '%' || r.match_counterparty_name_contains || '%')
      and (r.match_description_contains is null or coalesce(v_txn.description,'') ilike '%' || r.match_description_contains || '%')
      and (r.match_amount_cents is null or r.match_amount_cents = abs(v_txn.amount_cents))
    order by r.priority, r.created_at
    limit 1;

    if v_rule.id is not null then
      if v_rule.auto_book and v_rule.target_account_id is not null then
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
          v_auto := v_auto + 1;
        exception when others then
          -- Automatisch boeken mislukt (bv. afgesloten periode): zet als voorstel klaar
          -- i.p.v. de hele import/match terug te draaien.
          update public.bank_transactions
          set status = 'suggested',
              suggested_account_id = v_rule.target_account_id,
              suggested_vat_code = v_rule.target_vat_code,
              matched_rule_id = v_rule.id,
              match_confidence = 'rule',
              updated_at = now()
          where id = v_txn.id;
          v_suggested := v_suggested + 1;
        end;
      else
        update public.bank_transactions
        set status = 'suggested',
            suggested_account_id = v_rule.target_account_id,
            suggested_vat_code = v_rule.target_vat_code,
            matched_rule_id = v_rule.id,
            match_confidence = 'rule',
            updated_at = now()
        where id = v_txn.id;
        v_suggested := v_suggested + 1;
      end if;
      continue;
    end if;

    -- Belastingdienst herkennen (betaling én teruggave): stel 1530 Te betalen
    -- omzetbelasting voor. NL86INGB0002445588 is de inningsrekening; teruggaven komen
    -- binnen onder tegenpartijnaam "Belastingdienst".
    if v_iban = 'NL86INGB0002445588'
       or coalesce(v_txn.counterparty_name,'') ilike '%belastingdienst%' then
      update public.bank_transactions
      set status = 'suggested',
          suggested_account_id = public.bookkeeping_account_id(p_organization_id, '1530'),
          suggested_vat_code = null,
          match_confidence = 'tax_authority',
          updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;

    -- Geen regel: bij een betaling de leverancier op IBAN voorstellen.
    if v_txn.amount_cents < 0 and v_txn.counterparty_iban is not null then
      select * into v_sup from public.suppliers s
      where s.organization_id = p_organization_id
        and s.iban is not null
        and upper(replace(s.iban,' ','')) = v_iban
      limit 1;
      if v_sup.id is not null then
        update public.bank_transactions
        set status = 'suggested',
            suggested_account_id = v_sup.default_expense_account_id,
            suggested_vat_code = v_sup.default_vat_code,
            match_confidence = 'supplier_iban',
            updated_at = now()
        where id = v_txn.id;
        v_suggested := v_suggested + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('suggested', v_suggested, 'auto_booked', v_auto);
end;
$function$;


CREATE OR REPLACE FUNCTION public.open_fiscal_year(p_organization_id uuid, p_period_start date, p_period_end date, p_label text DEFAULT NULL::text, p_created_by uuid DEFAULT auth.uid())
 RETURNS fiscal_years
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_fy public.fiscal_years;
  v_label text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_period_end <= p_period_start then
    raise exception 'De einddatum van het boekjaar moet na de begindatum liggen.' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.fiscal_years f
    where f.organization_id = p_organization_id
      and daterange(f.period_start, f.period_end, '[]') && daterange(p_period_start, p_period_end, '[]')
  ) then
    raise exception 'Dit boekjaar overlapt met een bestaand boekjaar.' using errcode = '23514';
  end if;

  v_label := coalesce(nullif(btrim(p_label), ''),
    case when extract(year from p_period_start) = extract(year from p_period_end)
         then extract(year from p_period_start)::text
         else extract(year from p_period_start)::text || '/' || extract(year from p_period_end)::text end);

  insert into public.fiscal_years(organization_id, created_by, label, period_start, period_end, status)
  values (p_organization_id, p_created_by, v_label, p_period_start, p_period_end, 'open')
  returning * into v_fy;

  return v_fy;
end;
$function$;


CREATE OR REPLACE FUNCTION public.post_asset_depreciation(p_organization_id uuid, p_asset_id uuid, p_through_date date, p_created_by uuid DEFAULT auth.uid())
 RETURNS fixed_assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_asset public.fixed_assets;
  r record;
  v_lines jsonb;
  v_entry public.journal_entries;
  v_remaining integer;
  v_book_date date;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_asset from public.fixed_assets
  where id = p_asset_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Activum niet gevonden.' using errcode = '02000';
  end if;
  -- De aanschaf moet op de balans staan (debet 0100) voordat er wordt afgeschreven,
  -- anders zou 0150 gecrediteerd worden zonder tegenpost → negatieve netto-activa.
  if v_asset.acquisition_journal_entry_id is null then
    raise exception 'Boek eerst de aanschaf van dit activum naar het grootboek voordat je afschrijft.' using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): een afgestoten activum staat niet meer op de
  -- balans; afschrijven zou 0150 crediteren zonder activum erachter.
  if v_asset.status = 'disposed' then
    raise exception 'Dit activum is afgestoten; er valt niets meer op af te schrijven.' using errcode = '23514';
  end if;

  for r in
    select * from public.asset_depreciations
    where asset_id = p_asset_id and status = 'scheduled' and date <= p_through_date
    order by period_index
  loop
    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', v_asset.depreciation_account_id,
        'description', 'Afschrijving ' || v_asset.name,
        'debit_cents', r.amount_cents, 'credit_cents', 0
      ),
      jsonb_build_object(
        'account_id', v_asset.accumulated_depreciation_account_id,
        'description', 'Cumulatieve afschrijving ' || v_asset.name,
        'debit_cents', 0, 'credit_cents', r.amount_cents
      )
    );
    -- Nagekomen afschrijving in een al afgesloten periode → eerstvolgende open datum.
    -- GEWIJZIGD (20261104000000): een afschrijving raakt geen btw-rubriek en
    -- schuift dus alleen over een afgesloten boekjaar heen, niet over een btw-slot.
    v_book_date := public.first_open_booking_date_for(p_organization_id, r.date, public.journal_lines_touch_vat(p_organization_id, v_lines));
    v_entry := public.post_journal_entry(
      p_organization_id, v_book_date,
      'Afschrijving ' || coalesce(v_asset.asset_number, v_asset.name),
      'asset_depreciation', p_asset_id, v_lines, p_created_by
    );
    update public.asset_depreciations
    set status = 'posted', journal_entry_id = v_entry.id, posted_at = now()
    where id = r.id;
  end loop;

  select count(*) into v_remaining from public.asset_depreciations
  where asset_id = p_asset_id and status = 'scheduled';
  if v_remaining = 0 then
    update public.fixed_assets set status = 'fully_depreciated' where id = p_asset_id and status = 'active';
  end if;

  select * into v_asset from public.fixed_assets where id = p_asset_id;
  return v_asset;
end;
$function$;


CREATE OR REPLACE FUNCTION public.post_credit_note_to_ledger(p_organization_id uuid, p_credit_note_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cn public.credit_notes;
  v_inv public.invoices;
  v_start date;
  v_lines jsonb := '[]'::jsonb;
  v_groups jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_book_date date;
  v_desc text;
  v_doc_subtotal bigint;
  v_doc_vat bigint;
  v_doc_total bigint;
  v_sum_base bigint := 0;
  v_sum_vat bigint := 0;
  v_base_diff bigint;
  v_vat_diff bigint;
  v_n_groups integer := 0;
  v_biggest_idx integer := -1;
  -- FIX 2: geen kunstmatige startwaarde meer; v_biggest_idx < 0 is de
  -- "nog niets gekozen"-check.
  v_biggest_base bigint;
  v_g jsonb;
  v_i integer;
  r record;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_cn from public.credit_notes
  where id = p_credit_note_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Creditnota niet gevonden.' using errcode = '02000';
  end if;
  if v_cn.journal_entry_id is not null then
    raise exception 'Creditnota % is al naar het grootboek geboekt.', v_cn.number using errcode = '23514';
  end if;
  if v_cn.status <> 'issued' then
    raise exception 'Alleen een uitgegeven creditnota kan worden geboekt (status: %).', v_cn.status using errcode = '23514';
  end if;

  select * into v_inv from public.invoices
  where id = v_cn.invoice_id and organization_id = p_organization_id;
  if not found then
    raise exception 'De factuur bij deze creditnota is niet gevonden.' using errcode = '02000';
  end if;

  -- FIX 1: zonder de oorspronkelijke debitering van 1300 zou de creditering
  -- hieronder Debiteuren negatief maken. Zelfde bewaking als in
  -- book_bank_transaction (Blok A, FIX 2).
  if v_inv.journal_entry_id is null then
    raise exception 'Factuur % staat nog niet in het grootboek. Boek de factuur eerst ("Boek naar grootboek") en boek daarna de creditnota.',
      coalesce(v_inv.number, '') using errcode = '23514';
  end if;

  select bookkeeping_start_date into v_start
  from public.company_settings where organization_id = p_organization_id;
  if v_start is not null and v_cn.date < v_start then
    raise exception 'Creditnotadatum ligt vóór de boekhoud-startdatum (%); deze correctie zit al in de beginbalans.', v_start
      using errcode = '23514';
  end if;

  v_doc_subtotal := round(v_cn.subtotal_amount * 100);
  v_doc_vat := round(v_cn.vat_amount * 100);
  v_doc_total := round(v_cn.total_amount * 100);
  if v_doc_total <= 0 then
    raise exception 'Creditnota % heeft geen bedrag.', v_cn.number using errcode = '23514';
  end if;
  if v_doc_subtotal + v_doc_vat <> v_doc_total then
    raise exception 'Creditnota % is niet consistent (netto + btw ≠ totaal).', v_cn.number using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Groepen per (btw-code, tarief), zoals bij de verkoopfactuur.
  for r in
    select
      nullif(btrim(coalesce(line->>'vat_code', '')), '') as vat_code,
      (vc.id is not null) as has_code,
      vc.kind, vc.sales_box,
      coalesce((line->>'vat')::numeric, 0) as rate,
      sum(round(coalesce((line->>'quantity')::numeric, 0) * coalesce((line->>'unit_price')::numeric, 0) * 100)) as base_cents
    from jsonb_array_elements(v_cn.lines) as line
    left join public.vat_codes vc
      on vc.organization_id = p_organization_id
     and vc.code = nullif(btrim(coalesce(line->>'vat_code', '')), '')
    group by 1, 2, 3, 4, 5
  loop
    declare
      v_vat bigint := round(r.base_cents * r.rate / 100.0);
      v_revenue_account text := case
        when r.has_code and (r.sales_box in ('3a','3b','3c') or r.kind = 'reverse_charge_sales') then '8030'
        when r.rate >= 21 then '8000'
        when r.rate > 0 then '8010'
        else '8020'
      end;
    begin
      v_groups := v_groups || jsonb_build_array(jsonb_build_object(
        'account', v_revenue_account, 'vat_code', r.vat_code, 'rate', r.rate,
        'base', r.base_cents, 'vat', v_vat));
      v_sum_base := v_sum_base + r.base_cents;
      v_sum_vat := v_sum_vat + v_vat;
      v_n_groups := v_n_groups + 1;
      -- FIX 2: grootste groep op ABSOLUTE grondslag, met expliciete
      -- "nog niets gekozen"-check.
      if v_biggest_idx < 0 or abs(r.base_cents) > v_biggest_base then
        v_biggest_base := abs(r.base_cents); v_biggest_idx := v_n_groups - 1;
      end if;
    end;
  end loop;

  if v_n_groups = 0 then
    -- Creditnota zonder regels (hoort niet voor te komen): boek als één groep
    -- op 8000/8010/8020 valt niet te bepalen → weiger expliciet.
    raise exception 'Creditnota % heeft geen regels en kan niet worden geboekt.', v_cn.number using errcode = '23514';
  end if;

  -- Aansluiting op het document: restcenten in de grootste groep rechttrekken.
  -- Pro-rata-creditnota's dragen een "blended" tarief dat op 2 decimalen is
  -- afgerond; bij grote bedragen wijkt de herberekende btw daardoor tot
  -- ~0,005% van de grondslag af. De tolerantie schaalt daarom mee (0,01% van
  -- het totaal, minimaal 4 cent); grotere afwijkingen betekenen een echt
  -- inconsistent document → weigeren.
  v_base_diff := v_doc_subtotal - v_sum_base;
  v_vat_diff := v_doc_vat - v_sum_vat;
  if abs(v_base_diff) > greatest(4, 2 * v_n_groups, ceil(v_doc_total * 0.0001)::bigint)
     or abs(v_vat_diff) > greatest(4, 2 * v_n_groups, ceil(v_doc_total * 0.0001)::bigint) then
    raise exception 'Creditnota % sluit niet aan op zijn regels (verschil netto % cent, btw % cent).',
      v_cn.number, v_base_diff, v_vat_diff using errcode = '23514';
  end if;
  if v_base_diff <> 0 or v_vat_diff <> 0 then
    v_g := v_groups->v_biggest_idx;
    v_groups := jsonb_set(v_groups, array[v_biggest_idx::text], v_g
      || jsonb_build_object(
        'base', (v_g->>'base')::bigint + v_base_diff,
        'vat', (v_g->>'vat')::bigint + v_vat_diff));
  end if;

  -- Journaalregels: debet omzet (negatieve rubriek-metadata zodat de aangifte
  -- de grondslag en btw netjes terugtelt), debet 1510, credit 1300.
  for v_i in 0 .. v_n_groups - 1 loop
    v_g := v_groups->v_i;
    declare
      v_base bigint := (v_g->>'base')::bigint;
    begin
      if v_base <> 0 then
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', public.bookkeeping_account_id(p_organization_id, v_g->>'account'),
          'description', 'Creditering omzet',
          'debit_cents', case when v_base > 0 then v_base else 0 end,
          'credit_cents', case when v_base < 0 then -v_base else 0 end,
          'vat_code', nullif(v_g->>'vat_code', ''),
          'vat_rate', (v_g->>'rate')::numeric,
          'vat_base_cents', -v_base,
          'vat_amount_cents', -((v_g->>'vat')::bigint),
          'client_id', v_inv.client_id, 'project_id', v_inv.project_id
        ));
      end if;
    end;
  end loop;

  if v_doc_vat <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Af te dragen BTW (creditering)',
      'debit_cents', case when v_doc_vat > 0 then v_doc_vat else 0 end,
      'credit_cents', case when v_doc_vat < 0 then -v_doc_vat else 0 end,
      'client_id', v_inv.client_id
    ));
  end if;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
    'description', 'Debiteuren — creditnota ' || v_cn.number || ' op factuur ' || coalesce(v_inv.number, ''),
    'debit_cents', case when v_doc_total < 0 then -v_doc_total else 0 end,
    'credit_cents', case when v_doc_total > 0 then v_doc_total else 0 end,
    'client_id', v_inv.client_id
  ));

  v_book_date := public.first_open_booking_date(p_organization_id, v_cn.date);
  v_desc := 'Creditnota ' || v_cn.number || ' (factuur ' || coalesce(v_inv.number, '') || ')';
  if v_book_date <> v_cn.date then
    v_desc := v_desc || ' (creditnotadatum ' || to_char(v_cn.date, 'DD-MM-YYYY') || ', geboekt in eerstvolgende open periode)';
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date, v_desc,
    'credit_note', v_cn.id, v_lines, p_created_by
  );

  update public.credit_notes set journal_entry_id = v_entry.id, updated_at = now() where id = v_cn.id;
  return v_entry;
end;
$function$;


CREATE OR REPLACE FUNCTION public.post_journal_entry(p_organization_id uuid, p_date date, p_description text, p_source_type text, p_source_id uuid, p_lines jsonb, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_entry public.journal_entries;
  v_year integer := extract(year from p_date)::int;
  v_quarter smallint := extract(quarter from p_date)::smallint;
  v_month smallint := extract(month from p_date)::smallint;
  v_seq bigint;
  v_number text;
  v_line jsonb;
  v_idx integer := 0;
  v_account uuid;
  v_debit bigint;
  v_credit bigint;
  v_total_debit bigint := 0;
  v_total_credit bigint := 0;
  v_diff bigint;
  v_count integer;
  v_tolerance bigint;
  v_alien_code text;
  v_locked_through date;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Een journaalpost heeft minimaal één boekingsregel nodig.' using errcode = '23514';
  end if;

  -- De vrijgestelde soorten (jaarafsluiting, Vpb, dga-rente) mogen in een
  -- afgesloten periode boeken. Alleen de functies die ze maken, zetten de vlag
  -- resofly.trusted_journal_source (voor de rest van de transactie); een
  -- rechtstreekse aanroep met p_source_type => 'dga_interest' boekte anders
  -- in elke gesloten btw-periode of elk afgesloten boekjaar.
  if coalesce(p_source_type, 'manual') in ('year_close', 'corporate_tax', 'dga_interest')
     and auth.role() <> 'service_role'
     and coalesce(current_setting('resofly.trusted_journal_source', true), '') <> p_source_type then
    raise exception 'Dit soort boeking maakt alleen de jaarafsluiting, de Vpb-aangifte of de dga-renteboeking zelf.'
      using errcode = '42501';
  end if;

  -- Periodeslot: weiger boeken in een afgesloten aangifteperiode (maand/kwartaal/jaar).
  -- Uitzondering: het jaarafsluit-boekstuk ('year_close') zelf, dat op de laatste dag
  -- van het boekjaar valt en dus vaak binnen een reeds gesloten Q4/december-slot.
  -- GEWIJZIGD (20260807050000): 'corporate_tax' krijgt dezelfde vrijstelling.
  -- De Vpb-reservering valt per definitie op de balansdatum, en die ligt altijd
  -- in de laatste btw-periode van het boekjaar. Zonder deze uitzondering zou de
  -- reservering nooit geboekt kunnen worden zodra die aangifte is gefinaliseerd —
  -- een slot dat nooit meer opengaat. De post raakt alleen 9900 en 1540 en komt
  -- in geen enkele btw-rubriek voor, dus er valt niets te beschermen.
  -- GEWIJZIGD (20260807090000): 'dga_interest' erbij. De renteboeking valt per
  -- definitie op 31 december, en die dag ligt altijd in de laatste btw-periode
  -- van het jaar — een slot dat nooit meer opengaat. Zonder deze uitzondering
  -- kon de rente nooit geboekt worden zodra die aangifte definitief was.
  -- 'payroll' juist NIET: een loonjournaalpost in een afgesloten maand hoort
  -- wél te stuiten, want die raakt de btw-aangifte wel degelijk.
  -- GEWIJZIGD (20261104000000): één grendel per organisatie. Boekingen nemen
  -- hem gedeeld, de jaarafsluiting en het afsluiten van een btw-periode
  -- exclusief: zo glipt er geen boeking tussen het optellen en het vergrendelen.
  perform pg_advisory_xact_lock_shared(hashtext(p_organization_id::text || ':periodegrendel'));

  if coalesce(p_source_type, 'manual') not in ('year_close', 'corporate_tax', 'dga_interest') then
    -- GEWIJZIGD (20261104000000): het boekjaarslot geldt voor alles tot en met
    -- het einde van het laatst afgesloten boekjaar, ook voor datums vóór het
    -- eerste boekjaar. Afsluiten gaat op volgorde, dus de jaarsloten vormen één
    -- aaneengesloten blok.
    select max(cp.period_end) into v_locked_through
    from public.closed_periods cp
    where cp.organization_id = p_organization_id and cp.period_type = 'year';
    if v_locked_through is not null and p_date <= v_locked_through then
      raise exception 'Het boekjaar tot en met % is afgesloten; kies een boekdatum daarna.', to_char(v_locked_through, 'DD-MM-YYYY')
        using errcode = '23514';
    end if;

    -- GEWIJZIGD (20261104000000): een btw-slot houdt alleen boekingen tegen die
    -- de aangifte raken. Afschrijvingen, lonen, overlopende posten, de winst-
    -- bestemming en dividend komen in geen rubriek en horen op hun eigen datum.
    if exists (
      select 1 from public.closed_periods cp
      where cp.organization_id = p_organization_id
        and cp.period_type in ('month', 'quarter')
        and cp.period_start is not null and cp.period_end is not null
        and p_date between cp.period_start and cp.period_end
    ) and public.journal_lines_touch_vat(p_organization_id, p_lines) then
      raise exception 'De btw-aangifteperiode rond % is afgesloten; kies een boekdatum in de eerstvolgende open periode.', p_date
        using errcode = '23514';
    end if;
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':' || v_year::text));
  select count(*) + 1 into v_seq from public.journal_entries
  where organization_id = p_organization_id and year = v_year;
  v_number := 'JP-' || v_year || '-' || lpad(v_seq::text, greatest(5, length(v_seq::text)), '0');

  insert into public.journal_entries(
    organization_id, created_by, entry_number, date, year, quarter, month,
    description, source_type, source_id, status
  ) values (
    p_organization_id, p_created_by, v_number, p_date, v_year, v_quarter, v_month,
    p_description, coalesce(p_source_type, 'manual'), p_source_id, 'draft'
  ) returning * into v_entry;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    if (v_line ? 'account_id') and nullif(v_line->>'account_id','') is not null then
      v_account := (v_line->>'account_id')::uuid;
    else
      v_account := public.bookkeeping_account_id(p_organization_id, v_line->>'account_code');
    end if;

    v_debit := coalesce((v_line->>'debit_cents')::bigint, 0);
    v_credit := coalesce((v_line->>'credit_cents')::bigint, 0);
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;

    insert into public.journal_lines(
      organization_id, entry_id, account_id, line_index, description,
      debit_cents, credit_cents, vat_code, vat_rate, vat_base_cents, vat_amount_cents,
      client_id, supplier_id, project_id
    ) values (
      p_organization_id, v_entry.id, v_account, v_idx, nullif(v_line->>'description',''),
      v_debit, v_credit,
      nullif(v_line->>'vat_code',''),
      nullif(v_line->>'vat_rate','')::numeric,
      nullif(v_line->>'vat_base_cents','')::bigint,
      nullif(v_line->>'vat_amount_cents','')::bigint,
      nullif(v_line->>'client_id','')::uuid,
      nullif(v_line->>'supplier_id','')::uuid,
      nullif(v_line->>'project_id','')::uuid
    );
    v_idx := v_idx + 1;
  end loop;

  -- Org-integriteit (FIX 6): elke regel moet op een grootboekrekening van
  -- déze organisatie boeken. Een account_id van een andere org zou de balans
  -- vervuilen met andermans rekening (cross-tenant lek in de rapportages).
  select la.code into v_alien_code
  from public.journal_lines jl
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.entry_id = v_entry.id
    and la.organization_id <> p_organization_id
  limit 1;
  if v_alien_code is not null then
    raise exception 'Grootboekrekening % hoort niet bij deze organisatie.', v_alien_code
      using errcode = '42501';
  end if;

  v_diff := v_total_debit - v_total_credit;
  v_count := v_idx;
  v_tolerance := greatest(2 * v_count, 2);

  if v_diff <> 0 then
    if abs(v_diff) <= v_tolerance then
      v_account := public.bookkeeping_account_id(p_organization_id, '4900');
      insert into public.journal_lines(
        organization_id, entry_id, account_id, line_index, description, debit_cents, credit_cents
      ) values (
        p_organization_id, v_entry.id, v_account, v_idx, 'Afrondingsverschil',
        case when v_diff < 0 then -v_diff else 0 end,
        case when v_diff > 0 then v_diff else 0 end
      );
    else
      raise exception 'Journaalpost niet in balans: debet % ≠ credit % (verschil % cent).',
        v_total_debit, v_total_credit, v_diff using errcode = '23514';
    end if;
  end if;

  update public.journal_entries
  set status = 'posted', posted_at = now(), posted_by = p_created_by
  where id = v_entry.id
  returning * into v_entry;

  return v_entry;
end;
$function$;


CREATE OR REPLACE FUNCTION public.post_payroll_journal(p_organization_id uuid, p_date date, p_description text, p_lines jsonb, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_line jsonb;
  v_code text;
  v_debit bigint;
  v_credit bigint;
  v_total_debit bigint := 0;
  v_total_credit bigint := 0;
  v_lines jsonb := '[]'::jsonb;
  v_idx integer := 0;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if not public.org_has_business(p_organization_id) then
    raise exception 'De loonjournaalpost hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.'
      using errcode = '42501';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'De loonjournaalpost heeft geen regels.' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_idx := v_idx + 1;
    v_code := nullif(btrim(v_line->>'account_code'), '');
    v_debit := coalesce((v_line->>'debit_cents')::bigint, 0);
    v_credit := coalesce((v_line->>'credit_cents')::bigint, 0);

    if v_code is null then
      raise exception 'Regel %: er staat geen rekeningnummer bij.', v_idx using errcode = '23514';
    end if;
    if v_debit < 0 or v_credit < 0 then
      raise exception 'Regel % (%): een negatief bedrag kan niet. Zet het aan de andere kant.', v_idx, v_code
        using errcode = '23514';
    end if;
    if v_debit > 0 and v_credit > 0 then
      raise exception 'Regel % (%): er staat zowel een debet- als een creditbedrag.', v_idx, v_code
        using errcode = '23514';
    end if;
    if v_debit = 0 and v_credit = 0 then
      raise exception 'Regel % (%): er staat geen bedrag.', v_idx, v_code using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.ledger_accounts la
      where la.organization_id = p_organization_id and la.code = v_code
    ) then
      raise exception 'Regel %: grootboekrekening % bestaat niet in dit rekeningschema. Maak hem aan of pas de kolomkoppeling aan.', v_idx, v_code
        using errcode = '02000';
    end if;

    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_code', v_code,
      'description', coalesce(nullif(btrim(v_line->>'description'), ''), 'Loonjournaalpost'),
      'debit_cents', v_debit,
      'credit_cents', v_credit
    ));
  end loop;

  -- Strenger dan post_journal_entry: geen tolerantie. Een loonjournaalpost komt
  -- kant-en-klaar binnen en hoort exact te sluiten; wijkt hij af, dan is er iets
  -- misgegaan bij het overnemen en moet de gebruiker dat zien.
  if v_total_debit <> v_total_credit then
    raise exception 'De loonjournaalpost sluit niet: debet % cent tegen credit % cent (verschil % cent). Controleer de kolomkoppeling en of alle regels zijn meegekomen.',
      v_total_debit, v_total_credit, v_total_debit - v_total_credit using errcode = '23514';
  end if;

  return public.post_journal_entry(
    p_organization_id, p_date,
    coalesce(nullif(btrim(p_description), ''), 'Loonjournaalpost ' || to_char(p_date, 'MM-YYYY')),
    'payroll', null, v_lines, p_created_by
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.post_sales_invoice_to_ledger(p_organization_id uuid, p_invoice_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_inv public.invoices;
  v_start date;
  v_kor boolean;
  v_lines jsonb := '[]'::jsonb;
  v_output_vat bigint := 0;
  v_receivable bigint := 0;
  v_entry public.journal_entries;
  v_book_date date;
  v_desc text;
  r record;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_inv from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Factuur niet gevonden.' using errcode = '02000';
  end if;
  if v_inv.journal_entry_id is not null then
    raise exception 'Deze factuur is al naar het grootboek geboekt.' using errcode = '23514';
  end if;
  -- Statusguard: alleen een uitgegeven factuur boekt omzet. Concept/geannuleerd niet.
  if v_inv.status in ('draft', 'cancelled') then
    raise exception 'Een % factuur kan niet naar het grootboek worden geboekt.', v_inv.status using errcode = '23514';
  end if;

  select bookkeeping_start_date, coalesce(kor_enabled, false)
    into v_start, v_kor
  from public.company_settings where organization_id = p_organization_id;
  v_kor := coalesce(v_kor, false);

  if v_start is not null and v_inv.date < v_start then
    raise exception 'Factuurdatum ligt vóór de boekhoud-startdatum (%); deze omzet zit al in de beginbalans.', v_start
      using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Omzet per (btw-code, tarief); btw per groep afgerond. Het TARIEF komt van
  -- de factuurregel (dat is wat gefactureerd is); de CODE bepaalt de rubriek
  -- (via vat_codes.sales_box in de aangifte) en de omzetrekening: buitenland/
  -- verlegd (3a/3b/3c of verlegd-verkoop) → 8030, anders op tarief.
  for r in
    select
      nullif(btrim(coalesce(line->>'vat_code', '')), '') as vat_code,
      (vc.id is not null) as has_code,
      vc.kind, vc.sales_box,
      coalesce((line->>'vat')::numeric, 0) as rate,
      sum(round(coalesce((line->>'quantity')::numeric, 0) * coalesce((line->>'unit_price')::numeric, 0) * 100)) as base_cents
    from jsonb_array_elements(v_inv.lines) as line
    left join public.vat_codes vc
      on vc.organization_id = p_organization_id
     and vc.code = nullif(btrim(coalesce(line->>'vat_code', '')), '')
    group by 1, 2, 3, 4, 5
  loop
    declare
      v_vat bigint := case when v_kor then 0 else round(r.base_cents * r.rate / 100.0) end;
      v_revenue_account text := case
        when r.has_code and (r.sales_box in ('3a','3b','3c') or r.kind = 'reverse_charge_sales') then '8030'
        when r.rate >= 21 then '8000'
        when r.rate > 0 then '8010'
        else '8020'
      end;
    begin
      -- GEWIJZIGD (20261104020000): een negatieve groep (korting, correctie)
      -- komt aan de debetzijde; een negatieve credit bestaat niet en liet het
      -- boeken stil mislukken. Grondslag en btw houden hun teken.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, v_revenue_account),
        'description', 'Omzet',
        'debit_cents', greatest(-r.base_cents, 0), 'credit_cents', greatest(r.base_cents, 0),
        'vat_code', r.vat_code,
        'vat_rate', r.rate, 'vat_base_cents', r.base_cents, 'vat_amount_cents', v_vat,
        'client_id', v_inv.client_id, 'project_id', v_inv.project_id
      ));
      v_output_vat := v_output_vat + v_vat;
      v_receivable := v_receivable + r.base_cents + v_vat;
    end;
  end loop;

  if v_output_vat <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Af te dragen BTW',
      'debit_cents', greatest(-v_output_vat, 0), 'credit_cents', greatest(v_output_vat, 0),
      'client_id', v_inv.client_id
    ));
  end if;

  if v_receivable <> 0 then
    v_lines := jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
      'description', 'Debiteuren',
      'debit_cents', greatest(v_receivable, 0), 'credit_cents', greatest(-v_receivable, 0),
      'client_id', v_inv.client_id
    )) || v_lines;
  end if;

  -- Nagekomen factuur in een al ingediende periode: boek op de eerstvolgende
  -- open datum (documentdatum blijft leidend op de factuur zelf). De btw komt
  -- dan in de eerstvolgende aangifte (kleine correctie) of via een suppletie.
  v_book_date := public.first_open_booking_date(p_organization_id, v_inv.date);
  v_desc := 'Verkoopfactuur ' || coalesce(v_inv.number, '');
  if v_book_date <> v_inv.date then
    v_desc := v_desc || ' (factuurdatum ' || to_char(v_inv.date, 'DD-MM-YYYY') || ', geboekt in eerstvolgende open periode)';
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date, v_desc,
    'sales_invoice', v_inv.id, v_lines, p_created_by
  );

  update public.invoices set journal_entry_id = v_entry.id where id = v_inv.id;
  return v_entry;
end;
$function$;


CREATE OR REPLACE FUNCTION public.reverse_journal_entry(p_entry_id uuid, p_date date DEFAULT NULL::date, p_created_by uuid DEFAULT auth.uid())
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_src public.journal_entries;
  v_lines jsonb;
  v_reversal public.journal_entries;
  v_asset public.fixed_assets;
begin
  -- for update: twee gelijktijdige tegenboekingen van hetzelfde boekstuk
  -- zouden anders allebei de reversed_by-check passeren.
  select * into v_src from public.journal_entries where id = p_entry_id for update;
  if not found then
    raise exception 'Boekstuk niet gevonden.' using errcode = '02000';
  end if;
  if auth.role() <> 'service_role' and not (public.can_write_org(v_src.organization_id) and public.can_write_module(v_src.organization_id, 'finance')) then
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
  -- TOEGEVOEGD (20260807100000): idem voor een dividenduitkering. Die bestaat
  -- bovendien uit twee boekstukken; er één van tegenboeken laat een halve
  -- inhouding achter en zet dividend_distributions op slot.
  if v_src.source_type = 'dividend' then
    raise exception 'Een dividendboeking boek je niet los tegen; gebruik "Uitkering terugdraaien" bij het dividend.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): de doorboeking van een btw-aangifte of
  -- suppletie hoort bij een afgesloten aangifte. De spiegelpost viel in een
  -- open periode en telde daar de hele aangifte nog eens mee.
  if v_src.source_type = 'vat_return' then
    raise exception 'De doorboeking van een btw-aangifte boek je niet tegen. Een fout in een afgesloten aangifte corrigeer je met een suppletie.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): een tegenboeking tegenboeken maakt een keten
  -- die de rapporten en de beginbalanscontrole niet meer kunnen volgen.
  if v_src.reverses_entry_id is not null then
    raise exception 'Dit boekstuk is zelf een tegenboeking. Boek het oorspronkelijke boekstuk opnieuw in plaats van de tegenboeking tegen te boeken.'
      using errcode = '23514';
  end if;
  -- TOEGEVOEGD (20261104000000): boekingen van activa houden het activaregister
  -- bij. Tegenboeken mag, maar dan gaat het register mee terug (zie onderaan);
  -- eerst wel in de juiste volgorde: desinvestering, afschrijvingen, aanschaf.
  if v_src.source_type = 'asset_acquisition' then
    select * into v_asset from public.fixed_assets
    where id = v_src.source_id and organization_id = v_src.organization_id
    for update;
    if found and v_asset.acquisition_journal_entry_id = v_src.id then
      if v_asset.status = 'disposed'
         or exists (select 1 from public.asset_depreciations ad where ad.asset_id = v_asset.id and ad.status = 'posted') then
        raise exception 'Draai eerst de desinvestering en de geboekte afschrijvingen van "%" terug; daarna de aanschaf.', v_asset.name
          using errcode = '23514';
      end if;
    end if;
  elsif v_src.source_type = 'asset_depreciation' then
    select * into v_asset from public.fixed_assets
    where id = v_src.source_id and organization_id = v_src.organization_id
    for update;
    if found and v_asset.status = 'disposed' then
      raise exception 'Draai eerst de desinvestering van "%" terug; daarna de afschrijving.', v_asset.name
        using errcode = '23514';
    end if;
  elsif v_src.source_type = 'asset_disposal' then
    select * into v_asset from public.fixed_assets
    where id = v_src.source_id and organization_id = v_src.organization_id
    for update;
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

  -- TOEGEVOEGD (20261104000000): het activaregister gaat mee terug, zodat
  -- grootboek en register gelijk blijven (anders boekte de desinvestering de
  -- verkeerde cumulatieve afschrijving af, en bleef een tegengeboekte termijn
  -- voorgoed als geboekt staan).
  if v_src.source_type = 'asset_acquisition' then
    update public.fixed_assets
    set acquisition_journal_entry_id = null
    where id = v_src.source_id and organization_id = v_src.organization_id
      and acquisition_journal_entry_id = v_src.id;
  elsif v_src.source_type = 'asset_depreciation' then
    update public.asset_depreciations
    set status = 'scheduled', journal_entry_id = null, posted_at = null
    where journal_entry_id = v_src.id and organization_id = v_src.organization_id;
    update public.fixed_assets
    set status = 'active'
    where id = v_src.source_id and organization_id = v_src.organization_id and status = 'fully_depreciated';
  elsif v_src.source_type = 'asset_disposal' then
    update public.fixed_assets
    set status = 'active', disposal_date = null, disposal_proceeds_cents = null
    where id = v_src.source_id and organization_id = v_src.organization_id and status = 'disposed';
    if found then
      perform public.generate_depreciation_schedule(v_src.organization_id, v_src.source_id);
      if not exists (
        select 1 from public.asset_depreciations ad
        where ad.asset_id = v_src.source_id and ad.status = 'scheduled'
      ) then
        update public.fixed_assets set status = 'fully_depreciated'
        where id = v_src.source_id and organization_id = v_src.organization_id and status = 'active';
      end if;
    end if;
  end if;

  return v_reversal;
end;
$function$;


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
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
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


CREATE OR REPLACE FUNCTION public.set_bank_transaction_status(p_organization_id uuid, p_transaction_id uuid, p_status text)
 RETURNS bank_transactions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_txn public.bank_transactions;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_status not in ('unmatched','ignored') then
    raise exception 'Ongeldige status.' using errcode = '23514';
  end if;

  select * into v_txn from public.bank_transactions
  where id = p_transaction_id and organization_id = p_organization_id for update;
  if not found then raise exception 'Banktransactie niet gevonden.' using errcode = '02000'; end if;
  if v_txn.status = 'booked' then
    raise exception 'Een geboekte transactie moet eerst worden teruggedraaid.' using errcode = '23514';
  end if;

  update public.bank_transactions set
    status = p_status,
    suggested_account_id = case when p_status = 'unmatched' then null else suggested_account_id end,
    matched_rule_id = case when p_status = 'unmatched' then null else matched_rule_id end,
    matched_invoice_id = case when p_status = 'unmatched' then null else matched_invoice_id end,
    matched_purchase_invoice_id = case when p_status = 'unmatched' then null else matched_purchase_invoice_id end,
    updated_at = now()
  where id = v_txn.id
  returning * into v_txn;

  return v_txn;
end;
$function$;


CREATE OR REPLACE FUNCTION public.submit_quote_for_internal_approval(p_quote_id uuid, p_organization_id uuid)
 RETURNS quotes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote public.quotes;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then raise exception 'Geen schrijfrechten voor deze organisatie' using errcode = '42501'; end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status <> 'draft' then
    raise exception 'Deze offerte kan niet ter goedkeuring worden ingediend vanuit status %', v_quote.status using errcode = '23514';
  end if;
  if jsonb_array_length(coalesce(v_quote.lines, '[]'::jsonb)) = 0 then
    raise exception 'Een offerte zonder regels kan niet ter goedkeuring worden ingediend' using errcode = '23514';
  end if;

  update public.quotes
  set status = 'pending_internal_approval',
      internal_approval_status = 'pending',
      internal_approval_requested_at = now(),
      internal_approval_requested_by = v_user_id,
      internal_approved_at = null,
      internal_approved_by = null,
      internal_rejected_at = null,
      internal_rejected_by = null,
      internal_rejection_note = null,
      updated_at = now()
  where id = p_quote_id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'submitted_for_internal_approval', 'Ter interne goedkeuring ingediend', null, '{}'::jsonb, v_user_id);
  perform public.insert_quote_audit_event(p_organization_id, p_quote_id, 'quote_submitted_for_approval', v_quote.number, '{}'::jsonb, v_user_id);
  return v_quote;
end;
$function$;


CREATE OR REPLACE FUNCTION public.unbook_bank_transaction(p_organization_id uuid, p_transaction_id uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS bank_transactions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_txn public.bank_transactions;
  v_invoice_id uuid;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_txn from public.bank_transactions
  where id = p_transaction_id and organization_id = p_organization_id for update;
  if not found then raise exception 'Banktransactie niet gevonden.' using errcode = '02000'; end if;
  if v_txn.status <> 'booked' or v_txn.journal_entry_id is null then
    raise exception 'Alleen een geboekte transactie kan worden teruggedraaid.' using errcode = '23514';
  end if;

  v_invoice_id := v_txn.matched_invoice_id;
  perform public.reverse_journal_entry(v_txn.journal_entry_id, null, p_created_by);

  -- Zette deze betaling een aangifte op 'betaald'? Draai dat terug naar 'ingediend'.
  update public.vat_returns
  set status = 'filed', paid_bank_transaction_id = null, updated_at = now()
  where organization_id = p_organization_id and paid_bank_transaction_id = v_txn.id;

  update public.bank_transactions set
    status = 'unmatched',
    journal_entry_id = null,
    matched_invoice_id = null,
    matched_purchase_invoice_id = null,
    booked_at = null,
    booked_by = null,
    updated_at = now()
  where id = v_txn.id
  returning * into v_txn;

  -- TOEGEVOEGD (20261104010000): zette deze betaling de factuur op betaald en
  -- staat er nu weer iets open, dan gaat de factuur terug naar verzonden of
  -- achterstallig.
  if v_invoice_id is not null
     and public.invoice_open_receivable_cents(p_organization_id, v_invoice_id) > 0 then
    update public.invoices
    set status = case when due_date is not null and due_date < current_date then 'overdue' else 'sent' end,
        paid_at = null,
        updated_at = now()
    where id = v_invoice_id and organization_id = p_organization_id and status = 'paid';
  end if;

  return v_txn;
end;
$function$;


CREATE OR REPLACE FUNCTION public.void_contract(p_contract_id uuid, p_organization_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS contracts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_contract public.contracts;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Niet ingelogd.' using errcode = '28000'; end if;
  if not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501'; end if;

  select * into v_contract from public.contracts
  where id = p_contract_id and organization_id = p_organization_id for update;
  if not found then raise exception 'Contract niet gevonden.' using errcode = '02000'; end if;
  if v_contract.status in ('signed','voided') then
    raise exception 'Een getekend of reeds ingetrokken contract kan niet worden ingetrokken.' using errcode = '23514';
  end if;

  update public.contracts
  set status = 'voided', voided_at = now(), voided_by = v_user_id,
      void_reason = nullif(btrim(coalesce(p_reason, '')), ''),
      public_token_hash = null, public_token_expires_at = null,
      updated_at = now()
  where id = p_contract_id
  returning * into v_contract;

  perform public.insert_contract_event(p_organization_id, p_contract_id, 'voided', 'Contract ingetrokken', nullif(btrim(coalesce(p_reason, '')), ''), '{}'::jsonb, v_user_id);
  return v_contract;
end;
$function$;


CREATE OR REPLACE FUNCTION public.close_vat_period(p_organization_id uuid, p_period_type text, p_year integer, p_period_index integer, p_from date, p_to date)
 RETURNS vat_returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ret public.vat_returns;
begin
  if auth.role() <> 'service_role'
     and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_ret from public.finalize_vat_return(
    p_organization_id, p_period_type, p_year, p_period_index, p_from, p_to
  );

  update public.vat_returns
    set status = 'filed', filed_at = now(), filed_by = auth.uid()
    where id = v_ret.id
    returning * into v_ret;

  return v_ret;
end;
$function$;


-- ── 3. Verwijzingen binnen de eigen organisatie ─────────────────────────────
-- Zelfde helper als bij boekingsregels (assert_same_org_reference); alleen
-- bij een nieuwe of gewijzigde verwijzing, zodat bewerken van andere velden
-- er niets van merkt.

create or replace function public.enforce_bank_accounts_org_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.ledger_account_id is distinct from old.ledger_account_id or new.organization_id is distinct from old.organization_id then
    perform public.assert_same_org_reference('public.ledger_accounts'::regclass, new.ledger_account_id, new.organization_id, 'bank_accounts.ledger_account_id');
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_bank_accounts_org_integrity() from public, anon, authenticated;
drop trigger if exists bank_accounts_org_integrity on public.bank_accounts;
create trigger bank_accounts_org_integrity
  before insert or update of organization_id, ledger_account_id on public.bank_accounts
  for each row execute function public.enforce_bank_accounts_org_integrity();

create or replace function public.enforce_bank_rules_org_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.target_account_id is distinct from old.target_account_id or new.organization_id is distinct from old.organization_id then
    perform public.assert_same_org_reference('public.ledger_accounts'::regclass, new.target_account_id, new.organization_id, 'bank_rules.target_account_id');
  end if;
  if tg_op = 'INSERT' or new.set_supplier_id is distinct from old.set_supplier_id or new.organization_id is distinct from old.organization_id then
    perform public.assert_same_org_reference('public.suppliers'::regclass, new.set_supplier_id, new.organization_id, 'bank_rules.set_supplier_id');
  end if;
  if tg_op = 'INSERT' or new.set_client_id is distinct from old.set_client_id or new.organization_id is distinct from old.organization_id then
    perform public.assert_same_org_reference('public.clients'::regclass, new.set_client_id, new.organization_id, 'bank_rules.set_client_id');
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_bank_rules_org_integrity() from public, anon, authenticated;
drop trigger if exists bank_rules_org_integrity on public.bank_rules;
create trigger bank_rules_org_integrity
  before insert or update of organization_id, target_account_id, set_supplier_id, set_client_id on public.bank_rules
  for each row execute function public.enforce_bank_rules_org_integrity();

create or replace function public.enforce_purchase_invoices_org_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.supplier_id is distinct from old.supplier_id or new.organization_id is distinct from old.organization_id then
    perform public.assert_same_org_reference('public.suppliers'::regclass, new.supplier_id, new.organization_id, 'purchase_invoices.supplier_id');
  end if;
  if tg_op = 'INSERT' or new.project_id is distinct from old.project_id or new.organization_id is distinct from old.organization_id then
    perform public.assert_same_org_reference('public.projects'::regclass, new.project_id, new.organization_id, 'purchase_invoices.project_id');
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_purchase_invoices_org_integrity() from public, anon, authenticated;
drop trigger if exists purchase_invoices_org_integrity on public.purchase_invoices;
create trigger purchase_invoices_org_integrity
  before insert or update of organization_id, supplier_id, project_id on public.purchase_invoices
  for each row execute function public.enforce_purchase_invoices_org_integrity();

create or replace function public.enforce_suppliers_org_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.default_expense_account_id is distinct from old.default_expense_account_id or new.organization_id is distinct from old.organization_id then
    perform public.assert_same_org_reference('public.ledger_accounts'::regclass, new.default_expense_account_id, new.organization_id, 'suppliers.default_expense_account_id');
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_suppliers_org_integrity() from public, anon, authenticated;
drop trigger if exists suppliers_org_integrity on public.suppliers;
create trigger suppliers_org_integrity
  before insert or update of organization_id, default_expense_account_id on public.suppliers
  for each row execute function public.enforce_suppliers_org_integrity();

create or replace function public.enforce_contracts_template_org_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.template_id is distinct from old.template_id or new.organization_id is distinct from old.organization_id then
    perform public.assert_same_org_reference('public.contract_templates'::regclass, new.template_id, new.organization_id, 'contracts.template_id');
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_contracts_template_org_integrity() from public, anon, authenticated;
drop trigger if exists contracts_template_org_integrity on public.contracts;
create trigger contracts_template_org_integrity
  before insert or update of organization_id, template_id on public.contracts
  for each row execute function public.enforce_contracts_template_org_integrity();

-- ── 3b + 4. Vpb-correcties: eigen boekjaar, en vast na vaststellen ──────────

-- Bewust security invoker: current_user moet de echte rol zijn (authenticated
-- voor een gebruiker, de eigenaar bij een cascade of een serverfunctie).
create or replace function public.guard_corporate_tax_corrections()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
  v_fy uuid;
begin
  if tg_op <> 'DELETE'
     and (tg_op = 'INSERT' or new.fiscal_year_id is distinct from old.fiscal_year_id or new.organization_id is distinct from old.organization_id) then
    perform public.assert_same_org_reference('public.fiscal_years'::regclass, new.fiscal_year_id, new.organization_id, 'corporate_tax_corrections.fiscal_year_id');
  end if;

  -- De server (service_role, cron, of een cascade bij het verwijderen van
  -- een organisatie) wordt niet tegengehouden; alleen gebruikers.
  if current_user not in ('authenticated', 'anon') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  for v_fy in
    select distinct x from unnest(array[
      case when tg_op <> 'INSERT' then old.fiscal_year_id end,
      case when tg_op <> 'DELETE' then new.fiscal_year_id end]) x
    where x is not null
  loop
    if exists (select 1 from public.corporate_tax_returns r
               where r.organization_id = v_org and r.fiscal_year_id = v_fy and r.status = 'final') then
      raise exception 'De Vpb-berekening van dit boekjaar is vastgesteld en geboekt. Draai die eerst terug (Vennootschapsbelasting → Berekening terugdraaien) om de fiscale correcties te wijzigen.'
        using errcode = '23514';
    end if;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.guard_corporate_tax_corrections() from public, anon, authenticated;
drop trigger if exists corporate_tax_corrections_guard on public.corporate_tax_corrections;
create trigger corporate_tax_corrections_guard
  before insert or update or delete on public.corporate_tax_corrections
  for each row execute function public.guard_corporate_tax_corrections();


-- ── 5. Betalen, crediteren, herinneren en ondertekenen ─────────────────────

-- 5a. Betaallink: nooit meer dan er openstaat, en geen oude link voor een
--     ander bedrag. Ook niet voor een terugbetaalde factuur.

CREATE OR REPLACE FUNCTION public.begin_invoice_payment_checkout(p_invoice_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_amount_cents integer, p_public_token_hash text DEFAULT NULL::text, p_public_token_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_currency text DEFAULT 'EUR'::text, p_idempotency_key text DEFAULT NULL::text, p_checkout_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS invoice_payment_records
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice public.invoices;
  v_open bigint;
  v_amount integer := p_amount_cents;
  v_existing public.invoice_payment_records;
  v_payment public.invoice_payment_records;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_public_token text;
  v_link public.invoice_public_links;
begin
  if p_actor_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  if v_invoice.status in ('paid','cancelled','void','written_off','refunded') then
    raise exception 'Voor deze factuur kan geen betaallink worden aangemaakt.' using errcode = '23514';
  end if;
  -- Nooit meer vragen dan er openstaat: na een deelbetaling (bank of Mollie) of
  -- een creditnota betaalde de klant anders te veel. Staat de factuur niet in
  -- het grootboek, dan geldt het gevraagde bedrag (het factuurtotaal).
  if v_invoice.journal_entry_id is not null then
    v_open := public.invoice_open_receivable_cents(p_organization_id, p_invoice_id);
    if v_open is not null then
      if v_open <= 0 then
        raise exception 'Op deze factuur staat niets meer open.' using errcode = '23514';
      end if;
      v_amount := least(p_amount_cents::bigint, v_open)::integer;
    end if;
  end if;
  if v_amount <= 0 then raise exception 'Factuurbedrag moet groter zijn dan 0.' using errcode = '23514'; end if;

  select * into v_existing
  from public.invoice_payment_records p
  where p.organization_id = p_organization_id
    and p.invoice_id = p_invoice_id
    and p.provider = 'mollie'
    and p.status in ('creating','open','pending','authorized')
    and (p.checkout_expires_at is null or p.checkout_expires_at > now())
  order by p.created_at desc
  limit 1
  for update;

  if found then
    -- Zelfde bedrag, of de klant is al aan het betalen (pending/authorized):
    -- die betaling teruggeven, geen tweede ernaast.
    if v_existing.amount_cents = v_amount or v_existing.status in ('pending','authorized') then
      return v_existing;
    end if;
    -- De open link vraagt een ander bedrag (er is intussen deels betaald of
    -- gecrediteerd): laat hem vervallen en maak er een voor het juiste bedrag.
    -- Betaalt de klant de oude toch, dan komt die betaling via de webhook
    -- gewoon binnen (expired → paid mag) en wordt hij geboekt.
    update public.invoice_payment_records
       set status = 'expired',
           checkout_expires_at = least(coalesce(checkout_expires_at, now()), now()),
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('superseded', 'open_amount_changed', 'superseded_at', now()),
           updated_at = now()
     where id = v_existing.id;
  end if;

  -- Een verlopen, nooit geopende link (creating/open, de webhook kwam niet)
  -- houdt de unieke index op één actieve betaling bezet; die vervalt ook.
  update public.invoice_payment_records p
     set status = 'expired',
         metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object('superseded', 'checkout_expired', 'superseded_at', now()),
         updated_at = now()
   where p.organization_id = p_organization_id
     and p.invoice_id = p_invoice_id
     and p.provider = 'mollie'
     and p.status in ('creating','open')
     and p.checkout_expires_at is not null
     and p.checkout_expires_at <= now();

  insert into public.invoice_payment_records(
    organization_id, invoice_id, created_by, amount_cents, currency, status,
    idempotency_key, checkout_expires_at, metadata
  ) values (
    p_organization_id, p_invoice_id, p_actor_user_id, v_amount,
    upper(coalesce(nullif(btrim(p_currency), ''), 'EUR')), 'creating', v_key,
    p_checkout_expires_at, coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_payment;

  update public.invoices
     set locked_at = coalesce(locked_at, now()),
         locked_reason = coalesce(locked_reason, 'payment_checkout_created'),
         updated_at = now()
   where id = p_invoice_id and organization_id = p_organization_id;

  v_public_token := substring(coalesce(p_metadata->>'publicUrl', '') from '/invoice/([^?/#]+)');
  if v_public_token is not null and btrim(v_public_token) <> '' then
    v_link := public.create_invoice_public_link(
      p_invoice_id,
      p_organization_id,
      v_public_token,
      'payment',
      p_checkout_expires_at,
      null,
      v_payment.id,
      p_actor_user_id,
      jsonb_build_object('publicUrl', p_metadata->>'publicUrl')
    );
  end if;

  insert into public.finance_provider_jobs(organization_id, entity_type, entity_id, provider, job_type, status, idempotency_key, request_payload)
  values (p_organization_id, 'payment', v_payment.id, 'mollie', 'create_invoice_payment', 'queued', coalesce(v_key, 'invoice-payment-' || v_payment.id::text), jsonb_build_object('invoice_id', p_invoice_id, 'amount_cents', v_amount))
  on conflict (provider, job_type, idempotency_key) where idempotency_key is not null do update
    set updated_at = now();

  return v_payment;
exception when unique_violation then
  select * into v_payment
  from public.invoice_payment_records
  where organization_id = p_organization_id
    and invoice_id = p_invoice_id
    and provider = 'mollie'
    and status in ('creating','open','pending','authorized')
  order by created_at desc
  limit 1;

  if found then return v_payment; end if;
  raise;
end;
$function$;


-- 5b. Een terugbetaalde factuur gaat niet opnieuw de deur uit (met betaallink).

CREATE OR REPLACE FUNCTION public.begin_invoice_email_send(p_invoice_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_token_hash text, p_token_expires_at timestamp with time zone, p_recipient_email text, p_recipient_name text, p_subject text, p_public_url text, p_attachment_file_name text DEFAULT NULL::text, p_attachment_mime_type text DEFAULT 'application/pdf'::text, p_attachment_size_bytes integer DEFAULT NULL::integer, p_attachment_sha256 text DEFAULT NULL::text, p_attachment_data_base64 text DEFAULT NULL::text, p_attachment_storage_provider text DEFAULT NULL::text, p_attachment_storage_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice public.invoices;
  v_delivery public.invoice_email_deliveries;
  v_public_token text;
  v_link public.invoice_public_links;
  v_job public.finance_provider_jobs;
  v_storage_provider text := nullif(btrim(coalesce(p_attachment_storage_provider, '')), '');
  v_storage_key text := nullif(btrim(coalesce(p_attachment_storage_key, '')), '');
begin
  if p_actor_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  if v_invoice.status in ('paid','cancelled','void','written_off','refunded') then
    raise exception 'Betaalde, terugbetaalde, geannuleerde of afgeboekte facturen kunnen niet opnieuw worden verstuurd.' using errcode = '23514';
  end if;

  v_public_token := substring(coalesce(p_public_url, '') from '/invoice/([^?/#]+)');
  if v_public_token is null or public.invoice_token_hash(v_public_token) <> p_token_hash then
    raise exception 'Publieke factuurlink en token-hash komen niet overeen.' using errcode = '23514';
  end if;

  if p_attachment_file_name is null or p_attachment_size_bytes is null or p_attachment_size_bytes <= 0 or p_attachment_sha256 is null then
    raise exception 'Factuurmail vereist een echte PDF-snapshot met bestandsnaam, grootte en SHA-256 hash.' using errcode = '23514';
  end if;

  if v_storage_provider = 'r2' and v_storage_key is null then
    raise exception 'R2 PDF storage provider vereist een storage key.' using errcode = '23514';
  end if;

  if v_storage_provider is null and nullif(btrim(coalesce(p_attachment_data_base64, '')), '') is null then
    raise exception 'PDF-snapshot moet in private storage of als database-fallback worden vastgelegd.' using errcode = '23514';
  end if;

  insert into public.invoice_email_deliveries(
    organization_id, invoice_id, recipient_email, recipient_name, subject, status,
    attachment_file_name, attachment_mime_type, attachment_size_bytes, attachment_sha256,
    metadata
  ) values (
    p_organization_id, p_invoice_id, lower(btrim(p_recipient_email)), nullif(btrim(coalesce(p_recipient_name, '')), ''), p_subject, 'queued',
    nullif(btrim(coalesce(p_attachment_file_name, '')), ''), coalesce(nullif(btrim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'), p_attachment_size_bytes, lower(nullif(btrim(coalesce(p_attachment_sha256, '')), '')),
    jsonb_strip_nulls(jsonb_build_object(
      'publicUrl', p_public_url,
      'attachmentDataBase64', p_attachment_data_base64,
      'attachmentStorageProvider', v_storage_provider,
      'attachmentStorageKey', v_storage_key
    ))
  ) returning * into v_delivery;

  v_link := public.create_invoice_public_link(
    p_invoice_id,
    p_organization_id,
    v_public_token,
    'email',
    p_token_expires_at,
    v_delivery.id,
    null,
    p_actor_user_id,
    jsonb_build_object('publicUrl', p_public_url)
  );

  insert into public.finance_provider_jobs(organization_id, entity_type, entity_id, provider, job_type, status, idempotency_key, request_payload)
  values (p_organization_id, 'email', v_delivery.id, 'resend', 'send_invoice_email', 'queued', 'invoice-email-' || v_delivery.id::text, jsonb_build_object('invoice_id', p_invoice_id, 'recipient_email', lower(btrim(p_recipient_email)), 'public_link_id', v_link.id))
  on conflict (provider, job_type, idempotency_key) where idempotency_key is not null do update
    set updated_at = now()
  returning * into v_job;

  return jsonb_build_object('deliveryId', v_delivery.id, 'invoiceId', p_invoice_id, 'publicLinkId', v_link.id, 'providerJobId', v_job.id);
end;
$function$;


-- 5c. Creditnota: de factuur op slot, één creditnota per terugbetaling, en
--     samen nooit meer dan het factuurbedrag. Een dubbelklik, tweede tabblad
--     of herhaalde webhook gaf anders twee genummerde creditnota's.

CREATE OR REPLACE FUNCTION public.issue_credit_note(p_organization_id uuid, p_invoice_id uuid, p_refund_id uuid, p_actor_user_id uuid, p_reason text, p_currency text, p_subtotal numeric, p_vat numeric, p_total numeric, p_lines jsonb, p_pdf_file_name text DEFAULT NULL::text, p_pdf_mime_type text DEFAULT NULL::text, p_pdf_size_bytes integer DEFAULT NULL::integer, p_pdf_sha256 text DEFAULT NULL::text, p_pdf_data_base64 text DEFAULT NULL::text, p_pdf_storage_provider text DEFAULT NULL::text, p_pdf_storage_key text DEFAULT NULL::text)
 RETURNS credit_notes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice public.invoices;
  v_credit_note public.credit_notes;
  v_number text;
  v_credited numeric;
begin
  if p_organization_id is null or p_invoice_id is null then
    raise exception 'Organisatie en factuur zijn verplicht voor een creditfactuur.' using errcode = '23514';
  end if;

  select * into v_invoice from public.invoices
   where id = p_invoice_id and organization_id = p_organization_id
   for update;
  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;

  -- Eén creditnota per terugbetaling: een tweede webhook of herhaalde poging
  -- krijgt de bestaande terug.
  if p_refund_id is not null then
    select cn.* into v_credit_note from public.credit_notes cn
     where cn.organization_id = p_organization_id and cn.refund_id = p_refund_id and cn.status <> 'void'
     order by cn.created_at
     limit 1;
    if found then return v_credit_note; end if;
  end if;

  select coalesce(sum(cn.total_amount), 0) into v_credited
    from public.credit_notes cn
   where cn.organization_id = p_organization_id and cn.invoice_id = p_invoice_id and cn.status <> 'void';
  if v_credited + round(coalesce(p_total, 0), 2) > coalesce(v_invoice.total_amount, 0) + 0.005 then
    raise exception 'Op factuur % is al € % gecrediteerd; met deze creditfactuur van € % wordt dat meer dan het factuurbedrag van € %.',
      coalesce(v_invoice.number, ''),
      replace(to_char(v_credited, 'FM999999990.00'), '.', ','),
      replace(to_char(round(coalesce(p_total, 0), 2), 'FM999999990.00'), '.', ','),
      replace(to_char(coalesce(v_invoice.total_amount, 0), 'FM999999990.00'), '.', ',')
      using errcode = '23514';
  end if;

  v_number := public.allocate_next_credit_note_number(p_organization_id, current_date);

  insert into public.credit_notes(
    organization_id, invoice_id, refund_id, number, date, reason, currency,
    subtotal_amount, vat_amount, total_amount, lines, status,
    pdf_file_name, pdf_mime_type, pdf_size_bytes, pdf_sha256, pdf_data_base64,
    pdf_storage_provider, pdf_storage_key, issued_by
  ) values (
    p_organization_id, p_invoice_id, p_refund_id, v_number, current_date,
    nullif(btrim(coalesce(p_reason, '')), ''), coalesce(nullif(p_currency, ''), 'EUR'),
    round(coalesce(p_subtotal, 0), 2), round(coalesce(p_vat, 0), 2), round(coalesce(p_total, 0), 2),
    coalesce(p_lines, '[]'::jsonb), 'issued',
    p_pdf_file_name, coalesce(nullif(p_pdf_mime_type, ''), 'application/pdf'), p_pdf_size_bytes, p_pdf_sha256,
    p_pdf_data_base64, p_pdf_storage_provider, p_pdf_storage_key, p_actor_user_id
  ) returning * into v_credit_note;

  if p_refund_id is not null then
    update public.invoice_refunds
       set credit_note_id = v_credit_note.id, updated_at = now()
     where id = p_refund_id and organization_id = p_organization_id;
  end if;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    p_invoice_id,
    'credit_note_issued',
    'Creditfactuur aangemaakt',
    'Creditfactuur ' || v_number || ' voor factuur ' || coalesce(v_invoice.number, ''),
    jsonb_build_object('credit_note_id', v_credit_note.id, 'refund_id', p_refund_id, 'number', v_number, 'total_amount', v_credit_note.total_amount),
    p_actor_user_id
  );

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, p_actor_user_id, 'credit_note_issued', 'credit_note', v_credit_note.id, v_number,
          jsonb_build_object('invoice_id', p_invoice_id, 'refund_id', p_refund_id, 'total_amount', v_credit_note.total_amount));

  return v_credit_note;
end;
$function$;


-- 5d. Een late "betaald" van Mollie zet een afgehandelde factuur (geannuleerd,
--     gecrediteerd, afgeboekt, terugbetaald) niet terug op betaald. De
--     betaling zelf staat vast en wordt geboekt — het geld is binnen — en de
--     tijdlijn vraagt om controle.

CREATE OR REPLACE FUNCTION public.update_invoice_payment_status(p_provider_payment_id text, p_status text, p_paid_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS invoice_payment_records
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_payment public.invoice_payment_records;
  v_previous_status text;
  v_invoice public.invoices;
  v_event_type text;
  v_title text;
  v_status text := case when p_status in ('open','pending','authorized','paid','failed','expired','canceled','refunded','charged_back') then p_status else 'open' end;
  v_prev_rank integer;
  v_new_rank integer;
  v_apply_status boolean;
begin
  select * into v_payment
  from public.invoice_payment_records
  where provider = 'mollie'
    and provider_payment_id = p_provider_payment_id
  for update;

  if not found then
    raise exception 'Payment record niet gevonden voor provider-payment-id.' using errcode = '02000';
  end if;

  v_previous_status := v_payment.status;

  -- Statusprioriteit. Hoger = verder in de levenscyclus / definitiever.
  -- refunded en charged_back staan bewust boven paid zodat post-betaling
  -- gebeurtenissen wel kunnen worden vastgelegd, maar paid niet kan worden
  -- gedegradeerd naar open/pending/authorized/expired/failed/canceled.
  v_prev_rank := case v_previous_status
    when 'creating' then 0
    when 'open' then 1
    when 'pending' then 2
    when 'authorized' then 3
    when 'expired' then 4
    when 'canceled' then 4
    when 'failed' then 4
    when 'paid' then 5
    when 'refunded' then 6
    when 'charged_back' then 6
    else 0
  end;
  v_new_rank := case v_status
    when 'open' then 1
    when 'pending' then 2
    when 'authorized' then 3
    when 'expired' then 4
    when 'canceled' then 4
    when 'failed' then 4
    when 'paid' then 5
    when 'refunded' then 6
    when 'charged_back' then 6
    else 1
  end;

  -- Pas de status alleen aan als de nieuwe status verder in de levenscyclus
  -- ligt. Gelijke of lagere ranken laten de status ongemoeid (idempotent /
  -- bescherming tegen out-of-order webhooks). Wel altijd metadata + audit-spoor
  -- bijwerken, ongeacht of de status verandert.
  v_apply_status := v_new_rank > v_prev_rank;

  update public.invoice_payment_records
     set status = case when v_apply_status then v_status else status end,
         paid_at = case
           when v_status = 'paid' and v_apply_status then coalesce(v_payment.paid_at, p_paid_at, now())
           else paid_at
         end,
         last_webhook_at = now(),
         metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb)
           || jsonb_build_object('lastWebhookStatus', v_status, 'lastWebhookApplied', v_apply_status),
         updated_at = now()
   where id = v_payment.id
   returning * into v_payment;

  -- Als de status niet effectief verandert, geen verdere afgeleide acties
  -- (geen dubbele snapshots, events of audit-logs).
  if not v_apply_status then
    return v_payment;
  end if;

  select * into v_invoice
  from public.invoices
  where id = v_payment.invoice_id and organization_id = v_payment.organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden bij payment record.' using errcode = '02000'; end if;

  if v_status = 'paid' and v_invoice.status in ('cancelled','void','written_off','refunded') then
    perform public.insert_invoice_workflow_event(
      v_invoice.organization_id,
      v_invoice.id,
      'payment_paid',
      'Betaling ontvangen op een afgehandelde factuur',
      'Mollie meldt een betaling, maar de factuur staat op ' || v_invoice.status
        || '. De status is niet gewijzigd; de betaling is wel geboekt. Controleer of het bedrag moet worden terugbetaald.',
      jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id,
                         'invoice_status', v_invoice.status, 'needs_review', true),
      null
    );
    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (v_invoice.organization_id, null, 'payment_succeeded', 'invoice', v_invoice.id, v_invoice.number,
            jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id,
                               'invoice_status', v_invoice.status, 'closed_invoice', true, 'needs_review', true));
    return v_payment;
  end if;

  if v_status = 'paid' then
    update public.invoices
       set status = 'paid',
           paid_at = coalesce(v_invoice.paid_at, v_payment.paid_at, now()),
           locked_at = coalesce(v_invoice.locked_at, now()),
           locked_reason = coalesce(v_invoice.locked_reason, 'paid'),
           updated_at = now()
     where id = v_invoice.id
     returning * into v_invoice;

    if v_previous_status is distinct from 'paid' then
      perform public.create_invoice_version_snapshot(
        v_invoice.id,
        v_invoice.organization_id,
        'paid',
        null,
        null,
        v_payment.id,
        v_invoice.last_pdf_file_name,
        v_invoice.last_pdf_mime_type,
        v_invoice.last_pdf_size_bytes,
        v_invoice.last_pdf_sha256,
        null,
        jsonb_build_object('provider_payment_id', p_provider_payment_id)
      );
    end if;
  end if;

  v_event_type := case
    when v_status = 'paid' then 'payment_paid'
    when v_status = 'expired' then 'payment_expired'
    when v_status in ('failed','canceled','refunded','charged_back') then 'payment_failed'
    else 'payment_open'
  end;
  v_title := case
    when v_status = 'paid' then 'Factuur betaald'
    when v_status = 'expired' then 'Betaallink verlopen'
    when v_status in ('failed','canceled') then 'Betaling mislukt'
    when v_status = 'refunded' then 'Betaling terugbetaald'
    when v_status = 'charged_back' then 'Betaling teruggeboekt'
    else 'Betaalstatus bijgewerkt'
  end;

  if v_previous_status is distinct from v_status then
    perform public.insert_invoice_workflow_event(
      v_invoice.organization_id,
      v_invoice.id,
      v_event_type,
      v_title,
      'Mollie status: ' || v_status,
      jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id, 'previous_status', v_previous_status, 'status', v_status),
      null
    );
  end if;

  if v_status = 'paid' and v_previous_status is distinct from 'paid' then
    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (v_invoice.organization_id, null, 'invoice_paid', 'invoice', v_invoice.id, v_invoice.number, jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id));
  end if;

  return v_payment;
end;
$function$;


-- 5e. Herinnering en aanmaning: elke verzonden link een eigen rij. Ze
--     schreven alleen het ene token op de factuur, zodat de volgende
--     verzending de link in de vorige herinnering (of de aanmaning) brak.

CREATE OR REPLACE FUNCTION public.begin_invoice_reminder_send(p_invoice_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_level smallint, p_token_hash text, p_token_expires_at timestamp with time zone, p_recipient_email text, p_recipient_name text, p_subject text, p_public_url text, p_attachment_file_name text DEFAULT NULL::text, p_attachment_mime_type text DEFAULT 'application/pdf'::text, p_attachment_size_bytes integer DEFAULT NULL::integer, p_attachment_sha256 text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice public.invoices;
  v_delivery public.invoice_email_deliveries;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if p_level not between 1 and 3 then
    raise exception 'Ongeldig herinneringsniveau.' using errcode = '22023';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  if v_invoice.status in ('paid','cancelled','void','written_off','refunded') then
    raise exception 'Voor een betaalde, geannuleerde of afgeboekte factuur kan geen herinnering worden verstuurd.' using errcode = '23514';
  end if;

  update public.invoices
     set public_token_hash = p_token_hash,
         public_token_created_at = now(),
         public_token_expires_at = p_token_expires_at,
         updated_at = now()
   where id = v_invoice.id;

  insert into public.invoice_email_deliveries(
    organization_id, invoice_id, recipient_email, recipient_name, subject, status,
    delivery_kind, reminder_level,
    attachment_file_name, attachment_mime_type, attachment_size_bytes, attachment_sha256,
    metadata
  ) values (
    p_organization_id, p_invoice_id, lower(btrim(p_recipient_email)), nullif(btrim(coalesce(p_recipient_name, '')), ''), p_subject, 'queued',
    'reminder', p_level,
    nullif(btrim(coalesce(p_attachment_file_name, '')), ''), coalesce(nullif(btrim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'), p_attachment_size_bytes, nullif(btrim(coalesce(p_attachment_sha256, '')), ''),
    jsonb_build_object('publicUrl', p_public_url, 'reminderLevel', p_level)
  ) returning * into v_delivery;

  insert into public.invoice_public_links(
    organization_id, invoice_id, token_hash, purpose, status, delivery_id, expires_at, created_by, metadata
  ) values (
    p_organization_id, p_invoice_id, p_token_hash, 'email', 'active', v_delivery.id, p_token_expires_at, p_actor_user_id,
    jsonb_build_object('publicUrl', p_public_url, 'kind', 'reminder', 'reminderLevel', p_level)
  )
  on conflict (token_hash) do nothing;

  return jsonb_build_object('deliveryId', v_delivery.id, 'invoiceId', p_invoice_id);
end;
$function$;


CREATE OR REPLACE FUNCTION public.begin_dunning_send(p_notice_id uuid, p_organization_id uuid, p_actor_user_id uuid, p_interest_cents bigint, p_interest_days integer, p_daily_interest_cents bigint, p_collection_costs_cents bigint, p_collection_costs_vat_cents bigint, p_total_claim_cents bigint, p_calculation_date date, p_deadline_date date, p_rate_snapshot jsonb, p_token_hash text, p_token_expires_at timestamp with time zone, p_recipient_email text, p_recipient_name text, p_subject text, p_public_url text, p_attachment_file_name text DEFAULT NULL::text, p_attachment_mime_type text DEFAULT 'application/pdf'::text, p_attachment_size_bytes integer DEFAULT NULL::integer, p_attachment_sha256 text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_notice public.invoice_dunning_notices;
  v_invoice public.invoices;
  v_delivery public.invoice_email_deliveries;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_notice
  from public.invoice_dunning_notices
  where id = p_notice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Aanmaning niet gevonden.' using errcode = '02000'; end if;
  if v_notice.status = 'sent' then
    raise exception 'Deze aanmaning is al verstuurd.' using errcode = '23514';
  end if;
  if v_notice.status = 'cancelled' then
    raise exception 'Deze aanmaning is geannuleerd.' using errcode = '23514';
  end if;
  -- Alleen een voorgestelde of eerder mislukte aanmaning mag (opnieuw) verstuurd worden.
  -- Weiger o.a. de tussenstatus 'confirmed' (verzending al in gang), zodat een dubbelklik
  -- of retry niet een TWEEDE formele aanmaning verstuurt (de FOR UPDATE-lock serialiseert
  -- de twee verzoeken, maar zonder deze guard zou de tweede alsnog doorgaan).
  if v_notice.status not in ('proposed', 'failed') then
    raise exception 'Deze aanmaning wordt al verstuurd.' using errcode = '23514';
  end if;

  select * into v_invoice
  from public.invoices
  where id = v_notice.invoice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  if v_invoice.status in ('paid','cancelled','void','written_off','refunded') then
    raise exception 'Voor een betaalde, geannuleerde of afgeboekte factuur kan geen aanmaning worden verstuurd.' using errcode = '23514';
  end if;

  update public.invoices
     set public_token_hash = p_token_hash,
         public_token_created_at = now(),
         public_token_expires_at = p_token_expires_at,
         updated_at = now()
   where id = v_invoice.id;

  insert into public.invoice_email_deliveries(
    organization_id, invoice_id, recipient_email, recipient_name, subject, status,
    delivery_kind,
    attachment_file_name, attachment_mime_type, attachment_size_bytes, attachment_sha256,
    metadata
  ) values (
    p_organization_id, v_notice.invoice_id, lower(btrim(p_recipient_email)), nullif(btrim(coalesce(p_recipient_name, '')), ''), p_subject, 'queued',
    'dunning',
    nullif(btrim(coalesce(p_attachment_file_name, '')), ''), coalesce(nullif(btrim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'), p_attachment_size_bytes, nullif(btrim(coalesce(p_attachment_sha256, '')), ''),
    jsonb_build_object('publicUrl', p_public_url, 'dunningNoticeId', v_notice.id)
  ) returning * into v_delivery;

  insert into public.invoice_public_links(
    organization_id, invoice_id, token_hash, purpose, status, delivery_id, expires_at, created_by, metadata
  ) values (
    p_organization_id, v_notice.invoice_id, p_token_hash, 'email', 'active', v_delivery.id, p_token_expires_at, p_actor_user_id,
    jsonb_build_object('publicUrl', p_public_url, 'kind', 'dunning', 'dunningNoticeId', v_notice.id)
  )
  on conflict (token_hash) do nothing;

  update public.invoice_dunning_notices
     set status = 'confirmed',
         interest_cents = p_interest_cents,
         interest_days = coalesce(p_interest_days, 0),
         daily_interest_cents = coalesce(p_daily_interest_cents, 0),
         collection_costs_cents = p_collection_costs_cents,
         collection_costs_vat_cents = p_collection_costs_vat_cents,
         total_claim_cents = p_total_claim_cents,
         calculation_date = p_calculation_date,
         deadline_date = p_deadline_date,
         rate_snapshot = coalesce(p_rate_snapshot, rate_snapshot),
         public_url = p_public_url,
         delivery_id = v_delivery.id,
         confirmed_by = p_actor_user_id,
         confirmed_at = now(),
         updated_at = now()
   where id = v_notice.id;

  return jsonb_build_object('deliveryId', v_delivery.id, 'noticeId', v_notice.id);
end;
$function$;



-- 5f. Contract ondertekenen: gekoppeld aan de verstuurde versie, binnen de
--     termijn, en het uitgenodigde adres blijft staan.
--     - De klant tekent wat hij kreeg: de pagina toont de bij verzenden
--       bevroren versie en stuurt het id daarvan mee. Is er intussen een
--       nieuwere versie verstuurd, dan weigert de ondertekening.
--     - Na "geldig tot" kan er niet meer worden getekend.
--     - Het ingetypte e-mailadres verving het uitgenodigde én werd als
--       geverifieerd gemarkeerd. Nu blijft het uitgenodigde adres staan; het
--       ingetypte staat in het bewijs (de gebeurtenis), en "geverifieerd"
--       alleen als het overeenkomt.
--     Nieuwe parameter, dus de oude handtekening eerst weg (zelfde rechten).
drop function if exists public.sign_contract_public(text, text, text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.sign_contract_public(p_token_hash text, p_signer_name text, p_signer_email text, p_signature_method text, p_signature_image text, p_consent_text text, p_ip text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text, p_version_id uuid DEFAULT NULL::uuid)
 RETURNS contracts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_contract public.contracts;
  v_latest_version uuid;
  v_invited_email text;
  v_typed_email text := nullif(lower(btrim(coalesce(p_signer_email, ''))), '');
begin
  select * into v_contract from public.contracts
  where public_token_hash = p_token_hash
    and public_token_expires_at is not null
    and public_token_expires_at > now()
  for update;
  if not found then raise exception 'Ondertekenlink is ongeldig of verlopen.' using errcode = '28000'; end if;
  if v_contract.status <> 'sent' then raise exception 'Dit contract kan niet meer worden ondertekend.' using errcode = '23514'; end if;
  if p_signature_method not in ('typed','drawn') then raise exception 'Ongeldige ondertekenmethode.' using errcode = '23514'; end if;
  if v_contract.valid_until is not null and v_contract.valid_until < (now() at time zone 'Europe/Amsterdam')::date then
    raise exception 'De termijn om dit contract te ondertekenen is verlopen (geldig tot %). Vraag de afzender om een nieuwe versie.',
      to_char(v_contract.valid_until, 'DD-MM-YYYY') using errcode = '23514';
  end if;

  select v.id into v_latest_version
    from public.contract_versions v
   where v.organization_id = v_contract.organization_id
     and v.contract_id = v_contract.id
     and v.snapshot_reason = 'sent_to_client'
   order by v.version_number desc
   limit 1;
  if v_latest_version is not null and p_version_id is distinct from v_latest_version then
    raise exception 'Dit contract is gewijzigd of opnieuw verstuurd sinds u de pagina opende. Laad de pagina opnieuw en lees de actuele versie voordat u ondertekent.'
      using errcode = '23514';
  end if;

  select s.email into v_invited_email
    from public.contract_signers s
   where s.contract_id = v_contract.id and s.role = 'client'
   order by s.signing_order
   limit 1;

  update public.contract_signers
  set status = 'signed',
      name = coalesce(nullif(btrim(p_signer_name), ''), name),
      email = coalesce(email, v_typed_email),
      signed_at = now(),
      signature_method = p_signature_method,
      signature_image = nullif(p_signature_image, ''),
      signed_ip = nullif(btrim(coalesce(p_ip, '')), ''),
      signed_user_agent = nullif(btrim(coalesce(p_user_agent, '')), ''),
      consent_text = nullif(btrim(coalesce(p_consent_text, '')), ''),
      -- De link ging naar het uitgenodigde adres; "geverifieerd" alleen als het
      -- ingetypte adres daarmee overeenkomt.
      email_verified_at = case when v_typed_email is not null and v_typed_email = lower(btrim(coalesce(email, '')))
                               then coalesce(email_verified_at, now()) else email_verified_at end,
      updated_at = now()
  where contract_id = v_contract.id and role = 'client';

  update public.contracts
  set status = 'signed', signed_at = now(), updated_at = now()
  where id = v_contract.id
  returning * into v_contract;

  perform public.insert_contract_event(
    v_contract.organization_id, v_contract.id, 'client_signed',
    'Klant heeft het contract ondertekend', null,
    jsonb_build_object('name', p_signer_name, 'email', p_signer_email, 'invited_email', v_invited_email,
                       'email_matches_invitation', v_typed_email is not distinct from lower(btrim(coalesce(v_invited_email, ''))),
                       'method', p_signature_method, 'ip', p_ip, 'version_id', v_latest_version),
    null
  );
  return v_contract;
end;
$function$;

revoke all on function public.sign_contract_public(text, text, text, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.sign_contract_public(text, text, text, text, text, text, text, text, uuid) to service_role;


-- ── 6. Directe uitvoering via API, MCP en Gerrie: als het teamlid ──────────
-- De directe uitvoerders (apply.ts) schreven op de service-role. Daar gelden
-- RLS en de bewakers voor "authenticated" niet: zo kon een koppeling met
-- gewone uitvoerrechten, zonder dat een mens meekeek, de code of soort wijzigen
-- van een grootboekrekening waarop al geboekt is (afgesloten jaren en btw-
-- rubrieken veranderen dan mee), of een btw-aangifte terugzetten. Voor de
-- tabellen van Financiën wisselt deze functie, net als api_rest_write, binnen
-- de transactie naar het teamlid; daarna gelden RLS, de modulepoort en elke
-- bewaker precies als in de app.
create or replace function public.action_member_write(
  p_user_id uuid,
  p_organization_id uuid,
  p_table text,
  p_values jsonb,
  p_row_id uuid default null,
  p_unchanged jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_values jsonb := coalesce(p_values, '{}'::jsonb);
  v_cols text;
  v_where text := '';
  v_key text;
  v_exists boolean;
  v_row jsonb;
begin
  -- Alleen de server; de wissel naar het teamlid komt hieronder, dus deze
  -- controle hoort ervoor.
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de server kan dit aanroepen.' using errcode = '42501';
  end if;
  if p_table is null or p_table not in ('invoices', 'quotes', 'ledger_accounts', 'suppliers', 'bank_accounts', 'bank_rules', 'vat_returns', 'fixed_assets') then
    raise exception 'Tabel "%" gaat niet via deze weg.', p_table using errcode = '22023';
  end if;
  if jsonb_typeof(v_values) <> 'object' then
    raise exception 'De waarden moeten een object zijn.' using errcode = '22023';
  end if;
  -- Wat een wijziging nooit raakt (zelfde lijst als PROTECTED_FIELDS in apply.ts).
  v_values := v_values - 'id' - 'organization_id' - 'created_by' - 'created_at' - 'updated_at';

  if p_user_id is null or not exists (
    select 1 from public.organization_members m
     where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status = 'active') then
    raise exception 'Deze gebruiker is geen actief lid van de organisatie.' using errcode = '42501';
  end if;

  if p_row_id is not null then
    execute format('select exists(select 1 from public.%I where id = $1 and organization_id = $2)', p_table)
      into v_exists using p_row_id, p_organization_id;
    if not v_exists then
      raise exception 'Niet gevonden in deze organisatie.' using errcode = 'P0002';
    end if;
  end if;

  -- Vanaf hier als het teamlid, tot het einde van deze transactie.
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  v_cols := (select string_agg(format('%I', k), ', ' order by k) from jsonb_object_keys(v_values) as k);

  if p_row_id is null then
    execute format(
      'insert into public.%1$I as t (organization_id, created_by%2$s) '
      || 'select $1, $2%2$s from jsonb_populate_record(null::public.%1$I, $3) '
      || 'returning to_jsonb(t.*)',
      p_table, case when v_cols is null then '' else ', ' || v_cols end)
      into v_row using p_organization_id, p_user_id, v_values;
    return v_row;
  end if;

  if v_cols is null then
    raise exception 'Er is niets om te wijzigen.' using errcode = '22023';
  end if;
  -- "Moet nog zo zijn" (bijv. de status of het e-mailadres op de goedgekeurde
  -- kaart): anders verandert er niets.
  for v_key in select jsonb_object_keys(coalesce(p_unchanged, '{}'::jsonb)) loop
    v_where := v_where || format(' and t.%I::text is not distinct from ($4->>%L)', v_key, v_key);
  end loop;
  execute format(
    'update public.%1$I as t set (%2$s, updated_at) = '
    || '(select %2$s, now() from jsonb_populate_record(null::public.%1$I, $1)) '
    || 'where t.id = $2 and t.organization_id = $3%3$s '
    || 'returning to_jsonb(t.*)',
    p_table, v_cols, v_where)
    into v_row using v_values, p_row_id, p_organization_id, coalesce(p_unchanged, '{}'::jsonb);
  if v_row is null then
    raise exception 'Niet bijgewerkt: de gegevens zijn intussen veranderd, of het teamlid mag dit niet wijzigen.' using errcode = '42501';
  end if;
  return v_row;
end;
$$;

revoke all on function public.action_member_write(uuid, uuid, text, jsonb, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.action_member_write(uuid, uuid, text, jsonb, uuid, jsonb) to service_role;


-- ── 7. Rechtsvorm en bankregels ────────────────────────────────────────────

-- 7a. Wat alleen bij een BV of NV hoort (aandeelhoudersregister, aandelen-
--     mutaties, beperkte rechten, DGA-rente) en wat bij de Vpb hoort (fiscale
--     correcties) kon ook bij een eenmanszaak of vof worden aangemaakt; de
--     schermen verbergen het, de database liet het toe. Nu bij aanmaken
--     geweigerd. Alleen bij aanmaken: bestaande rijen (van toen de organisatie
--     nog een BV was) blijven bewerkbaar en verwijderbaar, en een cascade of
--     "set null" bij het verwijderen van een gebruiker loopt niet vast.
create or replace function public.enforce_register_legal_form()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_form text;
begin
  select cs.legal_form into v_form from public.company_settings cs where cs.organization_id = new.organization_id;
  v_form := coalesce(v_form, 'eenmanszaak');
  if TG_ARGV[0] = 'share_company' and v_form not in ('bv', 'nv') then
    raise exception 'Het aandeelhoudersregister en de DGA-rente horen bij een BV of NV; deze administratie heeft rechtsvorm %.', v_form
      using errcode = '23514';
  end if;
  if TG_ARGV[0] = 'vpb' and public.org_fiscal_regime(new.organization_id) <> 'vpb' then
    raise exception 'Vennootschapsbelasting hoort bij een BV, NV of coöperatie; een IB-onderneming betaalt inkomstenbelasting.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_register_legal_form() from public, anon, authenticated;

drop trigger if exists shareholders_legal_form on public.shareholders;
create trigger shareholders_legal_form before insert on public.shareholders
  for each row execute function public.enforce_register_legal_form('share_company');
drop trigger if exists share_transactions_legal_form on public.share_transactions;
create trigger share_transactions_legal_form before insert on public.share_transactions
  for each row execute function public.enforce_register_legal_form('share_company');
drop trigger if exists share_encumbrances_legal_form on public.share_encumbrances;
create trigger share_encumbrances_legal_form before insert on public.share_encumbrances
  for each row execute function public.enforce_register_legal_form('share_company');
drop trigger if exists dga_interest_rates_legal_form on public.dga_interest_rates;
create trigger dga_interest_rates_legal_form before insert on public.dga_interest_rates
  for each row execute function public.enforce_register_legal_form('share_company');
drop trigger if exists corporate_tax_corrections_legal_form on public.corporate_tax_corrections;
create trigger corporate_tax_corrections_legal_form before insert on public.corporate_tax_corrections
  for each row execute function public.enforce_register_legal_form('vpb');

-- 7b. De Vpb-invoer weigert voor een IB-onderneming, net als het opslaan.

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
  if public.org_fiscal_regime(p_organization_id) <> 'vpb' then
    raise exception 'Vennootschapsbelasting hoort bij een BV, NV of coöperatie; een IB-onderneming betaalt inkomstenbelasting.'
      using errcode = '23514';
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


-- 7c. Bankregels: een regel zonder voorwaarde matcht op élke transactie, en
--     met automatisch boeken boekt hij ze allemaal. Bij aanmaken eiste de
--     handeling een voorwaarde, het scherm en bijwerken niet. Nu een regel in
--     de database (NOT VALID: geldt voor nieuwe en gewijzigde regels; een
--     bestaande regel zonder voorwaarde blokkeert de migratie niet).
--     En de tekstvoorwaarden zijn letterlijk: een % of _ in "omschrijving
--     bevat" was een jokerteken.
alter table public.bank_rules drop constraint if exists bank_rules_has_condition;
alter table public.bank_rules add constraint bank_rules_has_condition check (
  nullif(btrim(coalesce(match_counterparty_iban, '')), '') is not null
  or nullif(btrim(coalesce(match_counterparty_name_contains, '')), '') is not null
  or nullif(btrim(coalesce(match_description_contains, '')), '') is not null
  or match_amount_cents is not null
) not valid;

create or replace function public.like_contains_pattern(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select '%' || replace(replace(replace(coalesce(p_text, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
$$;

CREATE OR REPLACE FUNCTION public.match_bank_transactions(p_organization_id uuid, p_bank_account_id uuid DEFAULT NULL::uuid, p_created_by uuid DEFAULT auth.uid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_txn public.bank_transactions;
  v_inv_id uuid;
  v_pi_id uuid;
  v_rule public.bank_rules;
  v_sup public.suppliers;
  v_suggested integer := 0;
  v_auto integer := 0;
  v_haystack text;
  v_iban text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  for v_txn in
    select * from public.bank_transactions
    where organization_id = p_organization_id
      and status = 'unmatched'
      and (p_bank_account_id is null or bank_account_id = p_bank_account_id)
    order by booking_date
  loop
    v_inv_id := null; v_pi_id := null; v_rule := null; v_sup := null;
    v_haystack := lower(replace(coalesce(v_txn.description,'') || ' ' || coalesce(v_txn.structured_reference,''), ' ', ''));
    v_iban := upper(replace(coalesce(v_txn.counterparty_iban,''), ' ', ''));

    if v_txn.amount_cents > 0 then
      -- Ontvangst: zoek verkoopfactuur op factuurnummer in omschrijving/kenmerk.
      -- FIX 2: alleen facturen die in het grootboek staan (afletterbaar).
      select i.id into v_inv_id
      from public.invoices i
      where i.organization_id = p_organization_id
        and i.status not in ('cancelled','void')
        and i.journal_entry_id is not null
        and i.number is not null and length(btrim(i.number)) > 0
        and position(lower(replace(i.number,' ','')) in v_haystack) > 0
      order by (case when round(coalesce(i.total_amount,0) * 100) = abs(v_txn.amount_cents) then 0 else 1 end), i.date desc
      limit 1;
    elsif v_txn.amount_cents < 0 then
      -- Betaling: zoek inkoopfactuur op intern/leveranciers-nummer.
      -- FIX 2: alleen geboekte inkoopfacturen (afletterbaar).
      select pi.id into v_pi_id
      from public.purchase_invoices pi
      where pi.organization_id = p_organization_id
        and pi.status <> 'cancelled'
        and pi.journal_entry_id is not null
        and (
          (pi.internal_number is not null and position(lower(replace(pi.internal_number,' ','')) in v_haystack) > 0)
          or (pi.supplier_invoice_number is not null and position(lower(replace(pi.supplier_invoice_number,' ','')) in v_haystack) > 0)
        )
      order by (case when pi.total_cents = abs(v_txn.amount_cents) then 0 else 1 end), pi.date desc
      limit 1;
    end if;

    if v_inv_id is not null then
      update public.bank_transactions
      set status = 'suggested', matched_invoice_id = v_inv_id, match_confidence = 'invoice', updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;
    if v_pi_id is not null then
      update public.bank_transactions
      set status = 'suggested', matched_purchase_invoice_id = v_pi_id, match_confidence = 'purchase_invoice', updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;

    -- Regels op prioriteit; eerste match wint.
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
      if v_rule.auto_book and v_rule.target_account_id is not null then
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
          v_auto := v_auto + 1;
        exception when others then
          -- Automatisch boeken mislukt (bv. afgesloten periode): zet als voorstel klaar
          -- i.p.v. de hele import/match terug te draaien.
          update public.bank_transactions
          set status = 'suggested',
              suggested_account_id = v_rule.target_account_id,
              suggested_vat_code = v_rule.target_vat_code,
              matched_rule_id = v_rule.id,
              match_confidence = 'rule',
              updated_at = now()
          where id = v_txn.id;
          v_suggested := v_suggested + 1;
        end;
      else
        update public.bank_transactions
        set status = 'suggested',
            suggested_account_id = v_rule.target_account_id,
            suggested_vat_code = v_rule.target_vat_code,
            matched_rule_id = v_rule.id,
            match_confidence = 'rule',
            updated_at = now()
        where id = v_txn.id;
        v_suggested := v_suggested + 1;
      end if;
      continue;
    end if;

    -- Belastingdienst herkennen (betaling én teruggave): stel 1530 Te betalen
    -- omzetbelasting voor. NL86INGB0002445588 is de inningsrekening; teruggaven komen
    -- binnen onder tegenpartijnaam "Belastingdienst".
    if v_iban = 'NL86INGB0002445588'
       or coalesce(v_txn.counterparty_name,'') ilike '%belastingdienst%' then
      update public.bank_transactions
      set status = 'suggested',
          suggested_account_id = public.bookkeeping_account_id(p_organization_id, '1530'),
          suggested_vat_code = null,
          match_confidence = 'tax_authority',
          updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;

    -- Geen regel: bij een betaling de leverancier op IBAN voorstellen.
    if v_txn.amount_cents < 0 and v_txn.counterparty_iban is not null then
      select * into v_sup from public.suppliers s
      where s.organization_id = p_organization_id
        and s.iban is not null
        and upper(replace(s.iban,' ','')) = v_iban
      limit 1;
      if v_sup.id is not null then
        update public.bank_transactions
        set status = 'suggested',
            suggested_account_id = v_sup.default_expense_account_id,
            suggested_vat_code = v_sup.default_vat_code,
            match_confidence = 'supplier_iban',
            updated_at = now()
        where id = v_txn.id;
        v_suggested := v_suggested + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('suggested', v_suggested, 'auto_booked', v_auto);
end;
$function$;


-- 7d. Gereserveerde codes. Een eigen rekening met een code die ResoFly later
--     zelf als systeemrekening aanmaakt (9900 Vennootschapsbelasting, 1540,
--     0520 bij de overstap naar een BV; 0501–0569 voor vennoten) verdrong die
--     systeemrekening stil: het aanmaken sloeg hem over ("on conflict do
--     nothing"), en de Vpb kwam op bijvoorbeeld 9900 "Diversen" zonder het
--     Vpb-kenmerk — dan telde de Vpb mee in het commerciële resultaat. Nu: zo'n
--     code is niet zelf te kiezen, en de Vpb-boeking controleert vooraf dat
--     9900 en 1540 echt de Vpb-rekeningen zijn.
create or replace function public.ledger_reserved_code_purpose(p_code text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_code in ('0100','0150','0500','0510','0550','0560','1100','1102','1300','1500','1510','1520','1530','1600','4000','4900')
      then 'het standaard rekeningschema'
    when p_code in ('0020','0025','0300','0505','0520','0530','1400','1540','1545','1550','1560','1580','9900')
      then 'de BV-administratie (vennootschapsbelasting, eigen vermogen, DGA, loonheffing en dividend)'
    when p_code ~ '^05[056][1-9]$'
      then 'de kapitaal- en privérekeningen van vennoten'
  end;
$$;

create or replace function public.enforce_reserved_ledger_codes()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_purpose text;
begin
  if new.is_system then return new; end if;
  if TG_OP = 'UPDATE' and new.code is not distinct from old.code then return new; end if;
  v_purpose := public.ledger_reserved_code_purpose(btrim(coalesce(new.code, '')));
  if v_purpose is not null then
    raise exception 'Code % is gereserveerd voor %; ResoFly maakt die rekening zelf aan als systeemrekening. Kies een andere code.', new.code, v_purpose
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_reserved_ledger_codes() from public, anon, authenticated;

drop trigger if exists ledger_accounts_reserved_codes on public.ledger_accounts;
create trigger ledger_accounts_reserved_codes
  before insert or update of code on public.ledger_accounts
  for each row execute function public.enforce_reserved_ledger_codes();

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
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
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
    -- Een eigen rekening met code 9900 of 1540 (van vóór de overstap naar een
    -- BV) is niet de Vpb-rekening: daar hoort de Vpb niet op.
    if not exists (select 1 from public.ledger_accounts la where la.id = v_expense and la.subtype = 'corporate_tax')
       or not exists (select 1 from public.ledger_accounts la where la.id = v_payable and la.subtype = 'corporate_tax_payable') then
      raise exception 'Rekening 9900 of 1540 is geen Vpb-systeemrekening: een eigen rekening gebruikt die code al. Geef die rekening een andere code (of boek het saldo met een memoriaalpost over naar een nieuwe rekening); daarna maakt ResoFly de Vpb-rekeningen aan.'
        using errcode = '23514';
    end if;

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
    -- Een eigen rekening met code 9900 of 1540 (van vóór de overstap naar een
    -- BV) is niet de Vpb-rekening: daar hoort de Vpb niet op.
    if not exists (select 1 from public.ledger_accounts la where la.id = v_expense and la.subtype = 'corporate_tax')
       or not exists (select 1 from public.ledger_accounts la where la.id = v_payable and la.subtype = 'corporate_tax_payable') then
      raise exception 'Rekening 9900 of 1540 is geen Vpb-systeemrekening: een eigen rekening gebruikt die code al. Geef die rekening een andere code (of boek het saldo met een memoriaalpost over naar een nieuwe rekening); daarna maakt ResoFly de Vpb-rekeningen aan.'
        using errcode = '23514';
    end if;

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


-- ── 8. Rechten ──────────────────────────────────────────────────────────────
-- CREATE OR REPLACE behoudt de bestaande rechten; hier staan ze toch expliciet
-- (zelfde rollen als nu op staging), zodat elke functie in dit bestand voor
-- anon dicht staat (migrationGrants.test.ts).

revoke all on function public.begin_dunning_send(uuid, uuid, uuid, bigint, integer, bigint, bigint, bigint, bigint, date, date, jsonb, text, timestamp with time zone, text, text, text, text, text, text, integer, text) from public, anon;
grant execute on function public.begin_dunning_send(uuid, uuid, uuid, bigint, integer, bigint, bigint, bigint, bigint, date, date, jsonb, text, timestamp with time zone, text, text, text, text, text, text, integer, text) to service_role;
revoke all on function public.begin_invoice_email_send(uuid, uuid, uuid, text, timestamp with time zone, text, text, text, text, text, text, integer, text, text, text, text) from public, anon;
grant execute on function public.begin_invoice_email_send(uuid, uuid, uuid, text, timestamp with time zone, text, text, text, text, text, text, integer, text, text, text, text) to service_role;
revoke all on function public.begin_invoice_payment_checkout(uuid, uuid, uuid, integer, text, timestamp with time zone, text, text, timestamp with time zone, jsonb) from public, anon;
grant execute on function public.begin_invoice_payment_checkout(uuid, uuid, uuid, integer, text, timestamp with time zone, text, text, timestamp with time zone, jsonb) to service_role;
revoke all on function public.begin_invoice_reminder_send(uuid, uuid, uuid, smallint, text, timestamp with time zone, text, text, text, text, text, text, integer, text) from public, anon;
grant execute on function public.begin_invoice_reminder_send(uuid, uuid, uuid, smallint, text, timestamp with time zone, text, text, text, text, text, text, integer, text) to service_role;
revoke all on function public.book_all_unbooked_sales_invoices(uuid, uuid) from public, anon;
grant execute on function public.book_all_unbooked_sales_invoices(uuid, uuid) to authenticated, service_role;
revoke all on function public.book_asset_acquisition(uuid, uuid, uuid, date, uuid) from public, anon;
grant execute on function public.book_asset_acquisition(uuid, uuid, uuid, date, uuid) to authenticated, service_role;
revoke all on function public.book_asset_disposal(uuid, uuid, uuid, bigint, date, uuid) from public, anon;
grant execute on function public.book_asset_disposal(uuid, uuid, uuid, bigint, date, uuid) to authenticated, service_role;
revoke all on function public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid) from public, anon;
grant execute on function public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.book_dga_interest(uuid, integer, uuid) from public, anon;
grant execute on function public.book_dga_interest(uuid, integer, uuid) to authenticated, service_role;
revoke all on function public.book_purchase_invoice(uuid, uuid, uuid) from public, anon;
grant execute on function public.book_purchase_invoice(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.close_fiscal_year(uuid, uuid, uuid) from public, anon;
grant execute on function public.close_fiscal_year(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.close_vat_period(uuid, text, integer, integer, date, date) from public, anon;
grant execute on function public.close_vat_period(uuid, text, integer, integer, date, date) to authenticated, service_role;
revoke all on function public.create_opening_balance(uuid, date, jsonb, uuid) from public, anon;
grant execute on function public.create_opening_balance(uuid, date, jsonb, uuid) to authenticated, service_role;
revoke all on function public.create_vat_supplement(uuid, uuid, uuid[], date, text, uuid) from public, anon;
grant execute on function public.create_vat_supplement(uuid, uuid, uuid[], date, text, uuid) to authenticated, service_role;
revoke all on function public.declare_dividend(uuid, text, date, date, jsonb, uuid, boolean, text, text, uuid) from public, anon;
grant execute on function public.declare_dividend(uuid, text, date, date, jsonb, uuid, boolean, text, text, uuid) to authenticated, service_role;
revoke all on function public.ensure_default_ledger_accounts(uuid) from public, anon;
grant execute on function public.ensure_default_ledger_accounts(uuid) to authenticated, service_role;
revoke all on function public.finalize_vat_return(uuid, text, integer, integer, date, date, uuid) from public, anon;
grant execute on function public.finalize_vat_return(uuid, text, integer, integer, date, date, uuid) to authenticated, service_role;
revoke all on function public.generate_depreciation_schedule(uuid, uuid) from public, anon;
grant execute on function public.generate_depreciation_schedule(uuid, uuid) to authenticated, service_role;
revoke all on function public.get_corporate_tax_inputs(uuid, uuid) from public, anon;
grant execute on function public.get_corporate_tax_inputs(uuid, uuid) to authenticated, service_role;
revoke all on function public.import_bank_transactions(uuid, uuid, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.import_bank_transactions(uuid, uuid, jsonb, jsonb, uuid) to authenticated, service_role;
revoke all on function public.issue_credit_note(uuid, uuid, uuid, uuid, text, text, numeric, numeric, numeric, jsonb, text, text, integer, text, text, text, text) from public, anon;
grant execute on function public.issue_credit_note(uuid, uuid, uuid, uuid, text, text, numeric, numeric, numeric, jsonb, text, text, integer, text, text, text, text) to service_role;
revoke all on function public.match_bank_transactions(uuid, uuid, uuid) from public, anon;
grant execute on function public.match_bank_transactions(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.open_fiscal_year(uuid, date, date, text, uuid) from public, anon;
grant execute on function public.open_fiscal_year(uuid, date, date, text, uuid) to authenticated, service_role;
revoke all on function public.post_asset_depreciation(uuid, uuid, date, uuid) from public, anon;
grant execute on function public.post_asset_depreciation(uuid, uuid, date, uuid) to authenticated, service_role;
revoke all on function public.post_credit_note_to_ledger(uuid, uuid, uuid) from public, anon;
grant execute on function public.post_credit_note_to_ledger(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.post_journal_entry(uuid, date, text, text, uuid, jsonb, uuid) from public, anon;
grant execute on function public.post_journal_entry(uuid, date, text, text, uuid, jsonb, uuid) to authenticated, service_role;
revoke all on function public.post_payroll_journal(uuid, date, text, jsonb, uuid) from public, anon;
grant execute on function public.post_payroll_journal(uuid, date, text, jsonb, uuid) to authenticated, service_role;
revoke all on function public.post_sales_invoice_to_ledger(uuid, uuid, uuid) from public, anon;
grant execute on function public.post_sales_invoice_to_ledger(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.report_account_ledger(uuid, uuid, date, date) from public, anon;
grant execute on function public.report_account_ledger(uuid, uuid, date, date) to authenticated, service_role;
revoke all on function public.reverse_journal_entry(uuid, date, uuid) from public, anon;
grant execute on function public.reverse_journal_entry(uuid, date, uuid) to authenticated, service_role;
revoke all on function public.save_corporate_tax_return(uuid, uuid, jsonb, boolean, text, uuid) from public, anon;
grant execute on function public.save_corporate_tax_return(uuid, uuid, jsonb, boolean, text, uuid) to authenticated, service_role;
revoke all on function public.set_bank_transaction_status(uuid, uuid, text) from public, anon;
grant execute on function public.set_bank_transaction_status(uuid, uuid, text) to authenticated, service_role;
revoke all on function public.submit_quote_for_internal_approval(uuid, uuid) from public, anon;
grant execute on function public.submit_quote_for_internal_approval(uuid, uuid) to authenticated, service_role;
revoke all on function public.unbook_bank_transaction(uuid, uuid, uuid) from public, anon;
grant execute on function public.unbook_bank_transaction(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.update_invoice_payment_status(text, text, timestamp with time zone, jsonb) from public, anon;
grant execute on function public.update_invoice_payment_status(text, text, timestamp with time zone, jsonb) to service_role;
revoke all on function public.void_contract(uuid, uuid, text) from public, anon;
grant execute on function public.void_contract(uuid, uuid, text) to authenticated, service_role;


commit;
