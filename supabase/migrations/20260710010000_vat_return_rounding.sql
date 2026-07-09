-- ============================================================
-- ResoFly — BTW-aangifte: afronding op hele euro's bij de doorboeking
-- Date: 2026-07-10
--
-- Context:
-- finalize_vat_return boekte het exacte cent-saldo door naar 1530 Te betalen
-- omzetbelasting. Maar de aangifte bij de Belastingdienst — en dus de
-- bankbetaling of -teruggave — gaat in HELE EURO'S. Daardoor bleef er
-- structureel een centenrestje op 1530 staan, en brak de automatische
-- aflettering in book_bank_transaction: die vergeleek de werkelijke (afgeronde)
-- bankbetaling met het ongeronde cent-saldo, wat vrijwel nooit exact gelijk is.
--
-- Fix:
--  - 1510/1520/1500 blijven exact dichtgeboekt (ongewijzigd: die rekeningen
--    moeten na de doorboeking precies nul zijn).
--  - Het saldo naar 1530 wordt rekenkundig afgerond op hele euro's (.50 weg van
--    nul, dezelfde afronding als op het aangifteformulier). Het verschil met
--    het exacte cent-saldo (maximaal €0,50) gaat naar 4900 Afrondingsverschillen,
--    zodat de journaalpost in balans blijft en 1530 precies het bedrag bevat
--    dat werkelijk wordt afgedragen of teruggevraagd.
--  - compute_vat_return geeft het afgeronde saldo (saldo_afgerond) en het
--    afrondingsverschil (afronding_cents) nu ook mee, zodat de UI het al vóór
--    het doorboeken toont.
--  - book_bank_transaction matcht de bankbetaling voortaan op saldo_afgerond
--    (met terugval op saldo voor aangiftes van vóór deze migratie, die geen
--    saldo_afgerond in hun bevroren rubrieken-snapshot hebben).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. compute_vat_return: afgerond saldo + afrondingsverschil meegeven
-- ------------------------------------------------------------
create or replace function public.compute_vat_return(
  p_organization_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_omzet_hoog_base bigint; v_omzet_hoog_btw bigint;
  v_omzet_laag_base bigint; v_omzet_laag_btw bigint;
  v_omzet_nul_base bigint;
  v_verlegd_btw bigint;
  v_verschuldigd bigint;
  v_voorbelasting bigint;
  v_saldo bigint;
  v_saldo_afgerond bigint;
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) >= 21 then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) >= 21 then coalesce(jl.vat_amount_cents, 0) else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) > 0 and coalesce(jl.vat_rate, 0) < 21 then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) > 0 and coalesce(jl.vat_rate, 0) < 21 then coalesce(jl.vat_amount_cents, 0) else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) = 0 then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype = 'vat_reverse' then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype in ('vat_output', 'vat_reverse') then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype = 'vat_input' then jl.debit_cents - jl.credit_cents else 0 end), 0)
  into v_omzet_hoog_base, v_omzet_hoog_btw, v_omzet_laag_base, v_omzet_laag_btw, v_omzet_nul_base,
       v_verlegd_btw, v_verschuldigd, v_voorbelasting
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.date between p_from and p_to;

  v_saldo := v_verschuldigd - v_voorbelasting;
  -- Aangifte/afdracht gaat in hele euro's; rekenkundig afronden (weg van nul bij .50).
  v_saldo_afgerond := round(v_saldo::numeric / 100.0)::bigint * 100;

  return jsonb_build_object(
    'omzet_hoog_base', v_omzet_hoog_base, 'omzet_hoog_btw', v_omzet_hoog_btw,
    'omzet_laag_base', v_omzet_laag_base, 'omzet_laag_btw', v_omzet_laag_btw,
    'omzet_nul_base', v_omzet_nul_base,
    'verlegd_btw', v_verlegd_btw,
    'verschuldigd_total', v_verschuldigd,
    'voorbelasting', v_voorbelasting,
    'saldo', v_saldo,
    'saldo_afgerond', v_saldo_afgerond,
    'afronding_cents', v_saldo - v_saldo_afgerond
  );
end;
$$;

-- ------------------------------------------------------------
-- 2. finalize_vat_return: 1530 op het afgeronde bedrag boeken, verschil naar 4900
-- ------------------------------------------------------------
create or replace function public.finalize_vat_return(
  p_organization_id uuid,
  p_period_type text,
  p_year integer,
  p_period_index integer,
  p_from date,
  p_to date,
  p_created_by uuid default auth.uid()
)
returns public.vat_returns
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ret public.vat_returns;
  v_omzet_hoog_base bigint; v_omzet_hoog_btw bigint;
  v_omzet_laag_base bigint; v_omzet_laag_btw bigint;
  v_omzet_nul_base bigint;
  v_clear_output bigint;
  v_clear_reverse bigint;
  v_clear_input bigint;
  v_saldo bigint;
  v_saldo_afgerond bigint;
  v_afronding bigint;
  v_lines jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_rubrieken jsonb;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_period_type not in ('month', 'quarter') then
    raise exception 'Ongeldige periodesoort.' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.closed_periods
    where organization_id = p_organization_id and period_start = p_from and period_end = p_to
  ) then
    raise exception 'Deze aangifteperiode is al afgesloten.' using errcode = '23514';
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);

  -- Beweging op de BTW-rekeningen in de periode (vóór de doorboeking), in dezelfde
  -- query als de rubrieken-uitsplitsing (1a/1b/1e/2a) berekend: één druk op de
  -- database, één consistente snapshot. Zo kan een gelijktijdige boeking nooit een
  -- ander saldo opleveren voor wat er wordt doorgeboekt dan wat in de bevroren
  -- rubrieken-snapshot van de aangifte terechtkomt (die twee liepen voorheen via
  -- aparte queries, elk met hun eigen MVCC-snapshot).
  select
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) >= 21 then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) >= 21 then coalesce(jl.vat_amount_cents, 0) else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) > 0 and coalesce(jl.vat_rate, 0) < 21 then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) > 0 and coalesce(jl.vat_rate, 0) < 21 then coalesce(jl.vat_amount_cents, 0) else 0 end), 0),
    coalesce(sum(case when la.type = 'revenue' and coalesce(jl.vat_rate, 0) = 0 then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype = 'vat_output' then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype = 'vat_reverse' then jl.credit_cents - jl.debit_cents else 0 end), 0),
    coalesce(sum(case when la.subtype = 'vat_input' then jl.debit_cents - jl.credit_cents else 0 end), 0)
  into v_omzet_hoog_base, v_omzet_hoog_btw, v_omzet_laag_base, v_omzet_laag_btw, v_omzet_nul_base,
       v_clear_output, v_clear_reverse, v_clear_input
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id and je.status = 'posted'
    and je.date between p_from and p_to;

  v_saldo := (v_clear_output + v_clear_reverse) - v_clear_input;
  -- Aangifte/afdracht gaat in hele euro's; rekenkundig afronden (weg van nul bij .50).
  -- Het verschil met het exacte cent-saldo (maximaal €0,50) gaat naar 4900, zodat
  -- 1530 precies het bedrag bevat dat werkelijk wordt afgedragen of teruggevraagd
  -- en de post toch in balans blijft.
  v_saldo_afgerond := round(v_saldo::numeric / 100.0)::bigint * 100;
  v_afronding := v_saldo - v_saldo_afgerond;
  v_rubrieken := jsonb_build_object(
    'omzet_hoog_base', v_omzet_hoog_base, 'omzet_hoog_btw', v_omzet_hoog_btw,
    'omzet_laag_base', v_omzet_laag_base, 'omzet_laag_btw', v_omzet_laag_btw,
    'omzet_nul_base', v_omzet_nul_base,
    'verlegd_btw', v_clear_reverse,
    'verschuldigd_total', v_clear_output + v_clear_reverse,
    'voorbelasting', v_clear_input,
    'saldo', v_saldo,
    'saldo_afgerond', v_saldo_afgerond,
    'afronding_cents', v_afronding
  );

  -- Doorboeking: BTW-rekeningen afsluiten naar 1530 Te betalen omzetbelasting.
  if v_clear_output <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', public.bookkeeping_account_id(p_organization_id, '1510'), 'description', 'Afsluiten af te dragen BTW', 'debit_cents', v_clear_output, 'credit_cents', 0));
  end if;
  if v_clear_reverse <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', public.bookkeeping_account_id(p_organization_id, '1520'), 'description', 'Afsluiten verlegde/ICP BTW', 'debit_cents', v_clear_reverse, 'credit_cents', 0));
  end if;
  if v_clear_input <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', public.bookkeeping_account_id(p_organization_id, '1500'), 'description', 'Afsluiten voorbelasting', 'debit_cents', 0, 'credit_cents', v_clear_input));
  end if;
  if v_saldo_afgerond <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1530'),
      'description', 'Te betalen omzetbelasting (afgerond op hele euro''s)',
      'debit_cents', case when v_saldo_afgerond < 0 then -v_saldo_afgerond else 0 end,
      'credit_cents', case when v_saldo_afgerond > 0 then v_saldo_afgerond else 0 end
    ));
  end if;
  if v_afronding <> 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '4900'),
      'description', 'Afrondingsverschil BTW-aangifte (cent → hele euro)',
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
  on conflict (organization_id, period_type, year, period_index) do update
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
  on conflict (organization_id, period_start, period_end) do nothing;

  return v_ret;
end;
$$;

-- ------------------------------------------------------------
-- 3. book_bank_transaction: matchen op het afgeronde saldo (terugval op het
--    exacte saldo voor aangiftes van vóór deze migratie).
-- ------------------------------------------------------------
create or replace function public.book_bank_transaction(
  p_organization_id uuid,
  p_transaction_id uuid,
  p_lines jsonb default null,
  p_matched_invoice_id uuid default null,
  p_matched_purchase_invoice_id uuid default null,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions;
  v_ba public.bank_accounts;
  v_abs bigint;
  v_lines jsonb;
  v_entry public.journal_entries;
  v_inv public.invoices;
  v_pi public.purchase_invoices;
  v_input_vat bigint := 0;
  v_output_vat bigint := 0;
  v_desc text;
  r record;
  v_vat_payable_id uuid;
  v_vat_payable_booked bigint := 0;
  v_target_saldo bigint;
  v_match_count integer;
  v_match_id uuid;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
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
    select * into v_inv from public.invoices where id = p_matched_invoice_id and organization_id = p_organization_id;
    if not found then raise exception 'Verkoopfactuur niet gevonden.' using errcode = '02000'; end if;
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
    select * into v_pi from public.purchase_invoices where id = p_matched_purchase_invoice_id and organization_id = p_organization_id;
    if not found then raise exception 'Inkoopfactuur niet gevonden.' using errcode = '02000'; end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1600'),
      'description', 'Crediteuren — ' || coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''),
      'debit_cents', v_abs, 'credit_cents', 0,
      'supplier_id', v_pi.supplier_id
    ));

  elsif p_lines is not null and jsonb_typeof(p_lines) = 'array' and jsonb_array_length(p_lines) > 0 then
    -- Vrije boeking: per regel bruto bedrag + BTW-code; net/BTW worden gesplitst.
    for r in
      select
        coalesce(nullif(l->>'account_id','')::uuid, public.bookkeeping_account_id(p_organization_id, l->>'account_code')) as account_id,
        coalesce((l->>'amount_cents')::bigint, 0) as gross_cents,
        nullif(l->>'vat_code','') as vat_code,
        nullif(l->>'description','') as description,
        coalesce(vc.rate, nullif(l->>'vat_rate','')::numeric, 0) as rate
      from jsonb_array_elements(p_lines) l
      left join public.vat_codes vc on vc.organization_id = p_organization_id and vc.code = (l->>'vat_code')
    loop
      if r.gross_cents = 0 then continue; end if;
      -- Onthoud hoeveel er op 1530 Te betalen omzetbelasting wordt geboekt (voor de
      -- automatische koppeling met de aangifte hieronder).
      if r.account_id = v_vat_payable_id then
        v_vat_payable_booked := v_vat_payable_booked + r.gross_cents;
      end if;
      declare
        v_net bigint := round(r.gross_cents / (1 + r.rate / 100.0));
        v_vat bigint := r.gross_cents - round(r.gross_cents / (1 + r.rate / 100.0));
      begin
        if v_txn.amount_cents > 0 then
          v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'account_id', r.account_id, 'description', coalesce(r.description, 'Ontvangst'),
            'debit_cents', 0, 'credit_cents', v_net,
            'vat_code', r.vat_code, 'vat_rate', r.rate, 'vat_base_cents', v_net, 'vat_amount_cents', v_vat));
          v_output_vat := v_output_vat + v_vat;
        else
          v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'account_id', r.account_id, 'description', coalesce(r.description, 'Betaling'),
            'debit_cents', v_net, 'credit_cents', 0,
            'vat_code', r.vat_code, 'vat_rate', r.rate, 'vat_base_cents', v_net, 'vat_amount_cents', v_vat));
          v_input_vat := v_input_vat + v_vat;
        end if;
      end;
    end loop;

    if v_output_vat > 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
        'description', 'Af te dragen BTW', 'debit_cents', 0, 'credit_cents', v_output_vat));
    end if;
    if v_input_vat > 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1500'),
        'description', 'Voorbelasting', 'debit_cents', v_input_vat, 'credit_cents', 0));
    end if;

  else
    raise exception 'Geen tegenrekening: letter een factuur af of kies een grootboekrekening.' using errcode = '23514';
  end if;

  v_entry := public.post_journal_entry(
    p_organization_id, v_txn.booking_date, v_desc, 'payment', v_txn.id, v_lines, p_created_by
  );

  update public.bank_transactions set
    status = 'booked',
    journal_entry_id = v_entry.id,
    matched_invoice_id = coalesce(p_matched_invoice_id, matched_invoice_id),
    matched_purchase_invoice_id = coalesce(p_matched_purchase_invoice_id, matched_purchase_invoice_id),
    booked_at = now(),
    booked_by = p_created_by,
    updated_at = now()
  where id = v_txn.id;

  -- Lus sluiten: viel deze boeking op 1530 Te betalen omzetbelasting? Zoek dan de
  -- afgeronde aangifte (finalized/filed) met datzelfde saldo in dezelfde richting.
  -- Saldo in rubrieken is in centen: positief = te betalen, negatief = terug te
  -- ontvangen. Betaling (amount<0) → saldo positief; ontvangst (amount>0) → negatief.
  -- We matchen ALTIJD op het AFGERONDE saldo (hele euro's), ook voor aangiftes van
  -- vóór deze migratie: die hebben geen saldo_afgerond in hun bevroren snapshot, dus
  -- ronden we hun exacte 'saldo' hier alsnog op dezelfde manier af. Zonder die
  -- consistente afronding zou een echte (afgeronde) bankbetaling het exacte
  -- cent-saldo van een oude aangifte bijna nooit raken, terwijl hij toevallig wél het
  -- afgeronde saldo van een heel andere (latere) aangifte kan raken — dat zou een
  -- bankbetaling aan de VERKEERDE aangifteperiode koppelen. Door beide kanten altijd
  -- in dezelfde (afgeronde) eenheid te vergelijken kan dat niet meer gebeuren: in het
  -- ergste geval botsen twee aangiftes op hetzelfde afgeronde bedrag, en dan blokkeert
  -- de ondubbelzinnigheids-check hieronder de automatische koppeling voor allebei
  -- (net als bij elke andere onduidelijke match) — de gebruiker koppelt dan zelf.
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
$$;

commit;
