-- ============================================================
-- ResoFly — Controle financiën en BV (4 november 2026), deel 2:
-- btw-aangifte, bank en inkoopfacturen
--
-- Uit de controle van 4 november (CHANGELOG_FINANCIEN_BV_CONTROLE_2026-11-04.md).
--
--   1. Rubriek 2a/4a/4b telde een tegenboeking dubbel in plaats van terug: de
--      grondslag en btw op de regel zijn al gespiegeld, en het teken van de
--      boekzijde kwam er nog eens overheen. Een tegengeboekte EU-verwerving van
--      € 1.000 gaf 4b € 2.000 / € 420 in plaats van nul (op staging nagespeeld).
--   2. Een bankboeking met de code IMPORT (invoer/diensten van buiten de EU,
--      rubriek 4a) werd als binnenlandse inclusief-btw-betaling gesplitst:
--      voorbelasting zonder aangifte in 4a, en te lage kosten.
--   3. Een factuur die volledig per bank was betaald, bleef op verzonden staan,
--      liep naar "achterstallig" en kreeg herinneringen en een aanmaning (met
--      incassokosten) terwijl de klant al betaald had. Nu gaat hij bij volledige
--      betaling op betaald, en terug als de bankboeking wordt teruggedraaid.
--   4. Het openstaande saldo van een factuur telde alleen bankbetalingen: een
--      Mollie-betaling of creditnota telde niet, zodat er nog eens tegen kon
--      worden afgeletterd. Nu één berekening: invoice_open_receivable_cents.
--   5. Inkoopfacturen:
--      - een creditnota of kortingsregel (negatief bedrag) liep vast op de
--        databaseregel "geen negatieve debet";
--      - met de KOR verdween de verlegde btw (EU-dienst, verlegd, invoer) uit de
--        administratie, terwijl die ook dan moet worden aangegeven en betaald;
--      - een factuur in vreemde valuta werd 1-op-1 als euro's geboekt.
--   6. Suppletie: een boekstuk dat al in een afgesloten aangifte zat, kon nog
--      eens in een suppletie (dubbele voorbelasting).
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 4. Openstaand saldo van een verkoopfactuur ───────────────────────────────
-- Geboekte vordering (1300 op de factuurboeking) min alles wat hem afboekte:
-- bankontvangsten, Mollie-betalingen (en -terugbetalingen en -chargebacks) en
-- creditnota's. Tegengeboekte paren tellen niet mee.
-- p_exclude_bank_transaction_id laat de bankboeking weg die nu wordt beoordeeld.

create or replace function public.invoice_open_receivable_cents(
  p_organization_id uuid,
  p_invoice_id uuid,
  p_exclude_bank_transaction_id uuid default null
)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  -- Beide helften van een tegengeboekt paar vallen weg (ze tellen samen nul).
  with booked as (
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) as cents
    from public.invoices i
    join public.journal_entries je on je.id = i.journal_entry_id and je.status = 'posted'
      and je.reversed_by_entry_id is null and je.reverses_entry_id is null
    join public.journal_lines jl on jl.entry_id = je.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
    where i.id = p_invoice_id and i.organization_id = p_organization_id
  ),
  bank as (
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) as cents
    from public.bank_transactions bt
    join public.journal_entries je on je.id = bt.journal_entry_id and je.status = 'posted'
      and je.reversed_by_entry_id is null and je.reverses_entry_id is null
    join public.journal_lines jl on jl.entry_id = je.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
    where bt.organization_id = p_organization_id
      and bt.matched_invoice_id = p_invoice_id
      and bt.status = 'booked'
      and bt.id is distinct from p_exclude_bank_transaction_id
  ),
  -- Mollie: betalingen, terugbetalingen en chargebacks boeken met de factuur
  -- als bron (source_type 'payment', source_id = factuur).
  psp as (
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) as cents
    from public.journal_entries je
    join public.journal_lines jl on jl.entry_id = je.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
    where je.organization_id = p_organization_id
      and je.source_type = 'payment'
      and je.source_id = p_invoice_id
      and je.status = 'posted'
      and je.reversed_by_entry_id is null and je.reverses_entry_id is null
  ),
  credits as (
    select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) as cents
    from public.credit_notes cn
    join public.journal_entries je on je.id = cn.journal_entry_id and je.status = 'posted'
      and je.reversed_by_entry_id is null and je.reverses_entry_id is null
    join public.journal_lines jl on jl.entry_id = je.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
    where cn.organization_id = p_organization_id and cn.invoice_id = p_invoice_id
  )
  select (select cents from booked) - (select cents from bank) - (select cents from psp) - (select cents from credits);
$$;

revoke all on function public.invoice_open_receivable_cents(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.invoice_open_receivable_cents(uuid, uuid, uuid) to service_role;

-- ── 1. compute_vat_boxes: 2a/4a/4b niet dubbel negeren ──────────────────────
CREATE OR REPLACE FUNCTION public.compute_vat_boxes(p_organization_id uuid, p_from date, p_to date, p_entry_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
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
      -- GEWIJZIGD (20261104010000): de richting komt alleen van de boekzijde.
      -- Grondslag en btw op de regel kunnen al een teken dragen (tegenboeking,
      -- memoriaal, creditnota); met abs() telt dat niet nog eens mee.
      case when acc_type in ('expense','asset') and has_code and sales_box in ('2a','4a','4b')
        then (case when debit_cents > 0 then 1 when credit_cents > 0 then -1 else 0 end)
             * abs(coalesce(vat_base_cents, case when debit_cents > 0 then debit_cents else credit_cents end))
        else 0 end as pur_base,
      case when acc_type in ('expense','asset') and has_code and sales_box in ('2a','4a','4b')
        then (case when debit_cents > 0 then 1 when credit_cents > 0 then -1 else 0 end)
             * abs(coalesce(vat_amount_cents, 0))
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
$function$;
revoke all on function public.compute_vat_boxes(uuid, date, date, uuid[]) from public, anon;
grant execute on function public.compute_vat_boxes(uuid, date, date, uuid[]) to authenticated, service_role;

-- ── 2-4. book_bank_transaction: IMPORT verlegd, één openstaand saldo, betaald ─
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
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
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
revoke all on function public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid) from public, anon;
grant execute on function public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid) to authenticated, service_role;
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
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
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
revoke all on function public.unbook_bank_transaction(uuid, uuid, uuid) from public, anon;
grant execute on function public.unbook_bank_transaction(uuid, uuid, uuid) to authenticated, service_role;

-- ── 5. book_purchase_invoice: creditnota's, KOR met verlegde btw, valuta ────
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
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
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
revoke all on function public.book_purchase_invoice(uuid, uuid, uuid) from public, anon;
grant execute on function public.book_purchase_invoice(uuid, uuid, uuid) to authenticated, service_role;

-- ── 6. create_vat_supplement: niets dubbel aangeven ─────────────────────────
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
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
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
revoke all on function public.create_vat_supplement(uuid, uuid, uuid[], date, text, uuid) from public, anon;
grant execute on function public.create_vat_supplement(uuid, uuid, uuid[], date, text, uuid) to authenticated, service_role;

commit;
