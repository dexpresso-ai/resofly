-- ============================================================
-- ResoFly — Bank: afletteren zet de factuur op betaald, één definitie van
-- "betaald", en een banksaldo voor gekoppelde rekeningen
-- Date: 2026-10-18
-- Bron: ENABLEBANKING_BOEKINGEN_ONDERZOEK_2026-10-18.md (§6, blok 1 + 2.1)
--
--  1  ÉÉN DEFINITIE VAN "BETAALD". invoice_settlement() en
--     purchase_invoice_settlement() halen per factuur geboekt − betaald −
--     gecrediteerd uit het GROOTBOEK. Betaald telt nu ook de Mollie-betalingen:
--     book_invoice_payment (20260724100000) boekt met de factuur zelf als bron,
--     terwijl book_bank_transaction en report_open_items alleen betalingen
--     telden die via een banktransactie liepen. Elke via Mollie betaalde factuur
--     stond daardoor als open in de openstaande-postenlijst en was nog een keer
--     tegen de bank af te letteren. Beide gebruiken nu dezelfde functie, net als
--     de matcher.
--
--  2  AFLETTEREN ZET DE FACTUUR OP BETAALD. book_bank_transaction werkte alleen
--     de banktransactie bij. De factuur bleef 'sent'/'overdue', en herinneringen
--     en aanmaningen selecteren op status = 'overdue' — een klant die per
--     overboeking betaalde kreeg dus gewoon de herinnering en de aanmaning.
--     Nu: is een verkoopfactuur na de bankboeking volledig voldaan, dan gaat hij
--     op 'paid' (paid_at = boekdatum, paid_bank_transaction_id = de transactie).
--     Bij inkoop worden payment_status en status (booked/paid) uit het grootboek
--     afgeleid. unbook_bank_transaction zet het terug zodra er weer iets open
--     staat — maar alleen als de bank het op betaald had gezet: een handmatig of
--     via Mollie op betaald gezette factuur blijft ongemoeid.
--
--  3  DE MATCHER stelt geen volledig betaalde facturen meer voor (die boeking
--     faalde gegarandeerd) en kiest bij meerdere kandidaten eerst die waarvan
--     het OPENSTAANDE bedrag klopt — bij een restbetaling is dat iets anders dan
--     het factuurtotaal.
--
--  4  record_bank_balance(): een banksaldo op een peildatum vastleggen als
--     afschriftsaldo. report_bank_reconciliation zoekt het laatste eindsaldo, en
--     dat bestond alleen voor CAMT/MT940-imports: een via PSD2 gekoppelde
--     rekening had nooit een saldo, waardoor de aansluitcontrole juist daar niet
--     werkte. bank-sync haalt nu het geboekte saldo op en legt het hiermee vast.
--     Eén rij per rekening per peildatum (herhaald synchroniseren werkt hem bij).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Welke banktransactie zette de factuur op betaald? Nodig om bij
--    terugdraaien alleen terug te zetten wat de bank zelf deed.
-- ------------------------------------------------------------
alter table public.invoices
  add column if not exists paid_bank_transaction_id uuid
  references public.bank_transactions(id) on delete set null;
alter table public.purchase_invoices
  add column if not exists paid_bank_transaction_id uuid
  references public.bank_transactions(id) on delete set null;

-- invoice_settlement zoekt de bankbetalingen per factuur op.
create index if not exists idx_bank_transactions_matched_invoice
  on public.bank_transactions(matched_invoice_id) where matched_invoice_id is not null;
create index if not exists idx_bank_transactions_matched_purchase_invoice
  on public.bank_transactions(matched_purchase_invoice_id) where matched_purchase_invoice_id is not null;

-- ------------------------------------------------------------
-- 2. invoice_settlement: per verkoopfactuur uit het grootboek (1300).
--    Per bron worden ALLE geboekte boekstukken gesommeerd, dus een
--    tegenboeking (zelfde bron) valt er vanzelf tegen weg.
--      geboekt      = de factuurboeking
--      betaald      = Mollie (bron = de factuur) + afgeletterde bankbetalingen
--      gecrediteerd = creditnota's op de factuur
--      open         = geboekt − betaald − gecrediteerd (negatief = tegoed klant)
--    Security invoker: rechtstreeks aangeroepen beschermt RLS de gegevens;
--    vanuit de security definer-boekfuncties draait hij als eigenaar.
-- ------------------------------------------------------------
create or replace function public.invoice_settlement(
  p_organization_id uuid,
  p_invoice_id uuid,
  p_as_of date default null
)
returns table (booked_cents bigint, paid_cents bigint, credited_cents bigint, open_cents bigint)
language sql
stable
set search_path = public
as $$
  with docs(kind, source_type, source_id) as (
    select 'booked', 'sales_invoice', p_invoice_id
    union all
    -- book_invoice_payment (Mollie) boekt met de factuur zelf als bron.
    select 'paid', 'payment', p_invoice_id
    union all
    -- book_bank_transaction boekt met de banktransactie als bron.
    select 'paid', 'payment', bt.id
    from public.bank_transactions bt
    where bt.organization_id = p_organization_id
      and bt.matched_invoice_id = p_invoice_id
      and bt.status = 'booked'
    union all
    select 'credited', 'credit_note', cn.id
    from public.credit_notes cn
    where cn.organization_id = p_organization_id
      and cn.invoice_id = p_invoice_id
  ),
  net as (
    select d.kind, sum(jl.debit_cents - jl.credit_cents)::bigint as debit_cents
    from docs d
    join public.journal_entries je
      on je.organization_id = p_organization_id
     and je.source_type = d.source_type
     and je.source_id = d.source_id
     and je.status = 'posted'
     and (p_as_of is null or je.date <= p_as_of)
    join public.journal_lines jl on jl.entry_id = je.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
    group by d.kind
  )
  select
    coalesce((select n.debit_cents from net n where n.kind = 'booked'), 0)::bigint,
    coalesce(-(select n.debit_cents from net n where n.kind = 'paid'), 0)::bigint,
    coalesce(-(select n.debit_cents from net n where n.kind = 'credited'), 0)::bigint,
    coalesce((select sum(n.debit_cents) from net n), 0)::bigint;
$$;

-- ------------------------------------------------------------
-- 3. purchase_invoice_settlement: hetzelfde voor inkoop, op 1600. Inkoop-
--    facturen worden alleen via de bank betaald.
-- ------------------------------------------------------------
create or replace function public.purchase_invoice_settlement(
  p_organization_id uuid,
  p_purchase_invoice_id uuid,
  p_as_of date default null
)
returns table (booked_cents bigint, paid_cents bigint, open_cents bigint)
language sql
stable
set search_path = public
as $$
  with docs(kind, source_type, source_id) as (
    select 'booked', 'purchase_invoice', p_purchase_invoice_id
    union all
    select 'paid', 'payment', bt.id
    from public.bank_transactions bt
    where bt.organization_id = p_organization_id
      and bt.matched_purchase_invoice_id = p_purchase_invoice_id
      and bt.status = 'booked'
  ),
  net as (
    select d.kind, sum(jl.credit_cents - jl.debit_cents)::bigint as credit_cents
    from docs d
    join public.journal_entries je
      on je.organization_id = p_organization_id
     and je.source_type = d.source_type
     and je.source_id = d.source_id
     and je.status = 'posted'
     and (p_as_of is null or je.date <= p_as_of)
    join public.journal_lines jl on jl.entry_id = je.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
    group by d.kind
  )
  select
    coalesce((select n.credit_cents from net n where n.kind = 'booked'), 0)::bigint,
    coalesce(-(select n.credit_cents from net n where n.kind = 'paid'), 0)::bigint,
    coalesce((select sum(n.credit_cents) from net n), 0)::bigint;
$$;

-- ------------------------------------------------------------
-- 4. sync_invoice_payment_status: de factuurstatus volgt de bank.
--    · Met p_paying_transaction_id (direct na een bankboeking): is er niets
--      meer open, dan 'sent'/'overdue' → 'paid'. Alleen in dit geval: een
--      factuur die door een creditnota op nul staat is niet "betaald".
--    · Zonder (na terugdraaien): zette de bank de factuur op betaald en staat
--      er weer iets open, dan terug naar 'sent'/'overdue'. Een factuur die
--      handmatig of via Mollie op betaald staat (geen bankkoppeling) blijft
--      ongemoeid.
-- ------------------------------------------------------------
create or replace function public.sync_invoice_payment_status(
  p_organization_id uuid,
  p_invoice_id uuid,
  p_paying_transaction_id uuid default null,
  p_paid_date date default null
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_inv public.invoices;
  v_open bigint;
begin
  select * into v_inv from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id;
  if not found then
    return;
  end if;

  select s.open_cents into v_open from public.invoice_settlement(p_organization_id, p_invoice_id) s;

  if p_paying_transaction_id is not null then
    if v_open <= 0 and v_inv.status in ('sent', 'overdue') then
      update public.invoices
      set status = 'paid',
          paid_at = coalesce(paid_at, coalesce(p_paid_date, current_date)::timestamptz),
          paid_bank_transaction_id = p_paying_transaction_id
      where id = v_inv.id;
    end if;
    return;
  end if;

  if v_inv.paid_bank_transaction_id is null then
    return;
  end if;

  if v_open > 0 and v_inv.status = 'paid' then
    update public.invoices
    set status = case when due_date is not null and due_date < current_date then 'overdue' else 'sent' end,
        paid_at = null,
        paid_bank_transaction_id = null
    where id = v_inv.id;
  elsif not exists (
    select 1 from public.bank_transactions bt
    where bt.id = v_inv.paid_bank_transaction_id
      and bt.organization_id = p_organization_id
      and bt.status = 'booked'
  ) then
    -- Nog steeds voldaan (bv. ook via Mollie), maar niet meer door deze transactie.
    update public.invoices set paid_bank_transaction_id = null where id = v_inv.id;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 5. sync_purchase_invoice_payment_status: payment_status en booked/paid
--    volledig uit het grootboek. Niets anders schrijft deze velden (ze stonden
--    sinds het aanmaken op 'unpaid'), dus afleiden is hier veilig.
-- ------------------------------------------------------------
create or replace function public.sync_purchase_invoice_payment_status(
  p_organization_id uuid,
  p_purchase_invoice_id uuid,
  p_paying_transaction_id uuid default null,
  p_paid_date date default null
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_pi public.purchase_invoices;
  v_booked bigint;
  v_paid bigint;
  v_open bigint;
  v_payment_status text;
  v_status text;
  v_paid_at timestamptz;
  v_paid_txn uuid;
begin
  select * into v_pi from public.purchase_invoices
  where id = p_purchase_invoice_id and organization_id = p_organization_id;
  if not found or v_pi.status not in ('booked', 'paid') then
    return;
  end if;

  select s.booked_cents, s.paid_cents, s.open_cents into v_booked, v_paid, v_open
  from public.purchase_invoice_settlement(p_organization_id, p_purchase_invoice_id) s;
  if v_booked <= 0 then
    return;  -- niet (meer) in het grootboek: niets af te leiden
  end if;

  v_payment_status := case when v_open <= 0 then 'paid' when v_paid > 0 then 'partially_paid' else 'unpaid' end;
  v_status := case when v_payment_status = 'paid' then 'paid' else 'booked' end;
  if v_payment_status = 'paid' then
    v_paid_at := coalesce(v_pi.paid_at, coalesce(p_paid_date, current_date)::timestamptz);
    v_paid_txn := coalesce(
      p_paying_transaction_id,
      (select bt.id from public.bank_transactions bt
       where bt.id = v_pi.paid_bank_transaction_id
         and bt.organization_id = p_organization_id
         and bt.status = 'booked'));
  else
    v_paid_at := null;
    v_paid_txn := null;
  end if;

  -- Geen lege update: die zou alleen een auditregel opleveren.
  if (v_pi.payment_status, v_pi.status, v_pi.paid_at, v_pi.paid_bank_transaction_id)
     is distinct from (v_payment_status, v_status, v_paid_at, v_paid_txn) then
    update public.purchase_invoices
    set payment_status = v_payment_status,
        status = v_status,
        paid_at = v_paid_at,
        paid_bank_transaction_id = v_paid_txn
    where id = v_pi.id;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 6. book_bank_transaction
--    (Basis: 20260721000000 Blok A. Nieuw: openstaand saldo via
--    invoice_settlement/purchase_invoice_settlement, en de factuurstatus
--    volgt de boeking. De btw-verwerking en de 1530-koppeling zijn ongewijzigd.)
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
  v_desc text;
  r record;
  v_vat_payable_id uuid;
  v_vat_payable_booked bigint := 0;
  v_target_saldo bigint;
  v_match_count integer;
  v_match_id uuid;
  v_entry_reversed boolean;
  v_open bigint;
  -- BTW-accumulatoren met richting (positief = natuurlijke kant)
  v_vat_1510 bigint := 0;  -- positief → credit 1510, negatief → debet 1510
  v_vat_1500 bigint := 0;  -- positief → debet 1500, negatief → credit 1500
  v_vat_1520 bigint := 0;  -- positief → credit 1520, negatief → debet 1520
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
    -- for update: gelijktijdig twee ontvangsten op dezelfde factuur boeken zou
    -- anders allebei de openstaand-check passeren.
    select * into v_inv from public.invoices
    where id = p_matched_invoice_id and organization_id = p_organization_id for update;
    if not found then raise exception 'Verkoopfactuur niet gevonden.' using errcode = '02000'; end if;

    -- Afletteren kan alleen tegen een factuur die in het grootboek staat.
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

    -- Begrens op het openstaande saldo: geboekt − betaald (bank én Mollie) −
    -- gecrediteerd. Deelbetalingen blijven mogelijk.
    select s.open_cents into v_open from public.invoice_settlement(p_organization_id, v_inv.id) s;
    if v_open <= 0 then
      raise exception 'Factuur % is al volledig betaald of gecrediteerd; er staat niets meer open.', coalesce(v_inv.number, '')
        using errcode = '23514';
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

    -- Zelfde bewaking als bij verkoopfacturen, spiegelbeeldig op 1600.
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

    select s.open_cents into v_open from public.purchase_invoice_settlement(p_organization_id, v_pi.id) s;
    if v_open <= 0 then
      raise exception 'Inkoopfactuur % is al volledig betaald; er staat niets meer open.',
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
    -- De BTW-verwerking kijkt naar vat_codes.kind én naar de AARD van de
    -- tegenrekening, niet naar het teken van de banktransactie:
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
        if r.kind in ('reverse_charge_purchase', 'eu_acquisition') then
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
            -- Balansrekening/onbekend: gedrag van vóór Blok A (geldrichting).
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

  -- De matchvelden beschrijven wat deze boeking DAADWERKELIJK deed: bij een
  -- vrije boeking zijn ze leeg (een achtergebleven matcher-suggestie zou anders
  -- als aflettering op die factuur tellen).
  update public.bank_transactions set
    status = 'booked',
    journal_entry_id = v_entry.id,
    matched_invoice_id = p_matched_invoice_id,
    matched_purchase_invoice_id = p_matched_purchase_invoice_id,
    booked_at = now(),
    booked_by = p_created_by,
    updated_at = now()
  where id = v_txn.id;

  -- De factuur volgt de betaling: volledig voldaan → betaald. Ná de update
  -- hierboven, zodat deze transactie in het openstaande saldo meetelt.
  if p_matched_invoice_id is not null then
    perform public.sync_invoice_payment_status(p_organization_id, p_matched_invoice_id, v_txn.id, v_txn.booking_date);
  elsif p_matched_purchase_invoice_id is not null then
    perform public.sync_purchase_invoice_payment_status(p_organization_id, p_matched_purchase_invoice_id, v_txn.id, v_txn.booking_date);
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
$$;

-- ------------------------------------------------------------
-- 7. unbook_bank_transaction
--    (Basis: 20260623000001. Nieuw: de afgeletterde factuur gaat terug van
--    betaald naar open als de bank hem daarop had gezet.)
-- ------------------------------------------------------------
create or replace function public.unbook_bank_transaction(
  p_organization_id uuid,
  p_transaction_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.bank_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions;
  v_invoice_id uuid;
  v_purchase_invoice_id uuid;
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
  v_purchase_invoice_id := v_txn.matched_purchase_invoice_id;

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

  -- Ná het vrijgeven hierboven telt deze betaling niet meer mee.
  if v_invoice_id is not null then
    perform public.sync_invoice_payment_status(p_organization_id, v_invoice_id);
  end if;
  if v_purchase_invoice_id is not null then
    perform public.sync_purchase_invoice_payment_status(p_organization_id, v_purchase_invoice_id);
  end if;

  return v_txn;
end;
$$;

-- ------------------------------------------------------------
-- 8. match_bank_transactions
--    (Basis: 20260721000000 Blok A. Nieuw: alleen facturen met een openstaand
--    saldo, en voorrang voor de factuur waarvan het OPENSTAANDE bedrag klopt.)
-- ------------------------------------------------------------
create or replace function public.match_bank_transactions(
  p_organization_id uuid,
  p_bank_account_id uuid default null,
  p_created_by uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
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
      -- Ontvangst: verkoopfactuur op factuurnummer in omschrijving/kenmerk. Alleen
      -- geboekte facturen met een openstaand saldo; het nummerfilter gaat vóór
      -- de saldoberekening, die dus alleen voor echte kandidaten draait.
      select i.id into v_inv_id
      from public.invoices i
      cross join lateral public.invoice_settlement(p_organization_id, i.id) s
      where i.organization_id = p_organization_id
        and i.status not in ('cancelled','void')
        and i.journal_entry_id is not null
        and i.number is not null and length(btrim(i.number)) > 0
        and position(lower(replace(i.number,' ','')) in v_haystack) > 0
        and s.open_cents > 0
      order by
        (case when s.open_cents = abs(v_txn.amount_cents) then 0
              when round(coalesce(i.total_amount,0) * 100) = abs(v_txn.amount_cents) then 1
              else 2 end),
        i.date desc
      limit 1;
    elsif v_txn.amount_cents < 0 then
      -- Betaling: inkoopfactuur op intern/leveranciers-nummer, alleen geboekt en open.
      select pi.id into v_pi_id
      from public.purchase_invoices pi
      cross join lateral public.purchase_invoice_settlement(p_organization_id, pi.id) s
      where pi.organization_id = p_organization_id
        and pi.status <> 'cancelled'
        and pi.journal_entry_id is not null
        and (
          (pi.internal_number is not null and position(lower(replace(pi.internal_number,' ','')) in v_haystack) > 0)
          or (pi.supplier_invoice_number is not null and position(lower(replace(pi.supplier_invoice_number,' ','')) in v_haystack) > 0)
        )
        and s.open_cents > 0
      order by
        (case when s.open_cents = abs(v_txn.amount_cents) then 0
              when pi.total_cents = abs(v_txn.amount_cents) then 1
              else 2 end),
        pi.date desc
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
$$;

-- ------------------------------------------------------------
-- 9. report_open_items
--    (Basis: 20260723200000 Blok C/D. Nieuw: per factuur uit
--    invoice_settlement/purchase_invoice_settlement — dezelfde definitie als de
--    bankaflettering, dus mét de Mollie-betalingen. Uitvoer ongewijzigd.)
-- ------------------------------------------------------------
create or replace function public.report_open_items(
  p_organization_id uuid,
  p_as_of date default current_date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_recv_rows jsonb;
  v_recv_open bigint;
  v_recv_gl bigint;
  v_pay_rows jsonb;
  v_pay_open bigint;
  v_pay_gl bigint;
begin
  if auth.role() <> 'service_role' and not public.can_read_org(p_organization_id) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- ---------------- Debiteuren (1300) ----------------
  with inv_rows as (
    select
      i.id, i.number, i.date, i.due_date, i.client_id, c.name as client_name,
      s.booked_cents, s.paid_cents, s.credited_cents, s.open_cents
    from public.invoices i
    cross join lateral public.invoice_settlement(p_organization_id, i.id, p_as_of) s
    left join public.clients c on c.id = i.client_id
    where i.organization_id = p_organization_id
      and (s.booked_cents <> 0 or s.paid_cents <> 0 or s.credited_cents <> 0)
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'invoice_id', r.id, 'number', r.number, 'date', r.date, 'due_date', r.due_date,
      'client_id', r.client_id, 'client_name', r.client_name,
      'booked_cents', r.booked_cents, 'paid_cents', r.paid_cents,
      'credited_cents', r.credited_cents, 'open_cents', r.open_cents
    ) order by r.date, r.number) filter (where r.open_cents <> 0), '[]'::jsonb),
    coalesce(sum(r.open_cents), 0)
  into v_recv_rows, v_recv_open
  from inv_rows r;

  select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) into v_recv_gl
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.date <= p_as_of
    and la.subtype = 'accounts_receivable';

  -- ---------------- Crediteuren (1600) ----------------
  with pi_rows as (
    select
      pi.id, coalesce(pi.supplier_invoice_number, pi.internal_number) as number,
      pi.date, pi.due_date, pi.supplier_id, s2.name as supplier_name,
      s.booked_cents, s.paid_cents, s.open_cents
    from public.purchase_invoices pi
    cross join lateral public.purchase_invoice_settlement(p_organization_id, pi.id, p_as_of) s
    left join public.suppliers s2 on s2.id = pi.supplier_id
    where pi.organization_id = p_organization_id
      and (s.booked_cents <> 0 or s.paid_cents <> 0)
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'purchase_invoice_id', r.id, 'number', r.number, 'date', r.date, 'due_date', r.due_date,
      'supplier_id', r.supplier_id, 'supplier_name', r.supplier_name,
      'booked_cents', r.booked_cents, 'paid_cents', r.paid_cents, 'open_cents', r.open_cents
    ) order by r.date, r.number) filter (where r.open_cents <> 0), '[]'::jsonb),
    coalesce(sum(r.open_cents), 0)
  into v_pay_rows, v_pay_open
  from pi_rows r;

  select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_pay_gl
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.entry_id
  join public.ledger_accounts la on la.id = jl.account_id
  where jl.organization_id = p_organization_id
    and je.status = 'posted'
    and je.date <= p_as_of
    and la.subtype = 'accounts_payable';

  return jsonb_build_object(
    'as_of', p_as_of,
    'receivables', jsonb_build_object(
      'rows', v_recv_rows,
      'open_total_cents', v_recv_open,
      'gl_balance_cents', v_recv_gl,
      -- Beweging op 1300 die niet aan een factuur toe te rekenen is
      -- (beginbalans, vrije boekingen): het gat tussen lijst en grootboek.
      'unmatched_cents', v_recv_gl - v_recv_open
    ),
    'payables', jsonb_build_object(
      'rows', v_pay_rows,
      'open_total_cents', v_pay_open,
      'gl_balance_cents', v_pay_gl,
      'unmatched_cents', v_pay_gl - v_pay_open
    )
  );
end;
$$;

-- ------------------------------------------------------------
-- 10. record_bank_balance: banksaldo op een peildatum als afschriftsaldo.
--     report_bank_reconciliation pakt het laatste afschrift mét eindsaldo, dus
--     dit is precies wat hij nodig heeft. Geen beginsaldo: de afschriftcontrole
--     (begin + regels = eind) slaat zulke rijen terecht over.
-- ------------------------------------------------------------
create unique index if not exists idx_bank_statements_balance_key
  on public.bank_statements(bank_account_id, file_hash)
  where file_hash like 'saldo:%';

create or replace function public.record_bank_balance(
  p_organization_id uuid,
  p_bank_account_id uuid,
  p_balance_date date,
  p_balance_cents bigint,
  p_source text default 'enablebanking',
  p_label text default null,
  p_created_by uuid default auth.uid()
)
returns public.bank_statements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ba public.bank_accounts;
  v_key text;
  v_stmt public.bank_statements;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_balance_date is null or p_balance_cents is null then
    raise exception 'Saldo en peildatum zijn verplicht.' using errcode = '23514';
  end if;
  -- Eén dag speling voor tijdzones; verder vooruit is een fout in de bron.
  if p_balance_date > current_date + 1 then
    raise exception 'De peildatum van een saldo kan niet in de toekomst liggen.' using errcode = '23514';
  end if;
  if coalesce(p_source, '') not in ('enablebanking', 'gocardless', 'camt053', 'mt940', 'csv') then
    raise exception 'Onbekende saldobron: %.', p_source using errcode = '23514';
  end if;

  select * into v_ba from public.bank_accounts
  where id = p_bank_account_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Bankrekening niet gevonden.' using errcode = '02000';
  end if;

  -- to_char i.p.v. date::text: die laatste volgt de DateStyle van de sessie.
  v_key := 'saldo:' || p_source || ':' || to_char(p_balance_date, 'YYYY-MM-DD');

  insert into public.bank_statements as bs (
    organization_id, created_by, bank_account_id, format, file_name, file_hash,
    period_start, period_end, opening_balance_cents, closing_balance_cents, transaction_count
  ) values (
    p_organization_id, p_created_by, p_bank_account_id, p_source, p_label, v_key,
    p_balance_date, p_balance_date, null, p_balance_cents, 0
  )
  on conflict (bank_account_id, file_hash) where file_hash like 'saldo:%' do update
    set closing_balance_cents = excluded.closing_balance_cents,
        file_name = coalesce(excluded.file_name, bs.file_name),
        imported_at = now()
  returning * into v_stmt;

  return v_stmt;
end;
$$;

-- ------------------------------------------------------------
-- 11. Bestaande afletteringen bijwerken: facturen die al volledig via de bank
--     zijn betaald maar nog op 'sent'/'overdue' staan, gaan op betaald; bij
--     inkoop wordt de betaalstatus afgeleid.
-- ------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select distinct on (bt.matched_invoice_id)
      bt.organization_id, bt.matched_invoice_id as invoice_id, bt.id as transaction_id, bt.booking_date
    from public.bank_transactions bt
    join public.invoices i on i.id = bt.matched_invoice_id
    where bt.status = 'booked' and i.status in ('sent', 'overdue')
    order by bt.matched_invoice_id, bt.booking_date desc, bt.created_at desc
  loop
    perform public.sync_invoice_payment_status(r.organization_id, r.invoice_id, r.transaction_id, r.booking_date);
  end loop;

  for r in
    select distinct on (bt.matched_purchase_invoice_id)
      bt.organization_id, bt.matched_purchase_invoice_id as purchase_invoice_id, bt.id as transaction_id, bt.booking_date
    from public.bank_transactions bt
    where bt.status = 'booked' and bt.matched_purchase_invoice_id is not null
    order by bt.matched_purchase_invoice_id, bt.booking_date desc, bt.created_at desc
  loop
    perform public.sync_purchase_invoice_payment_status(r.organization_id, r.purchase_invoice_id, r.transaction_id, r.booking_date);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 12. Rechten. Anon hoort geen security-definer-functie te kunnen aanroepen
--     (20260926000000); voor de herdefinieerde functies is dat ongewijzigd en
--     hier expliciet herhaald. De settlement-functies zijn security invoker
--     (RLS beschermt); de sync-functies zijn intern: alleen de boekfuncties
--     roepen ze aan.
-- ------------------------------------------------------------
revoke all on function public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid) from public, anon;
grant execute on function public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.unbook_bank_transaction(uuid, uuid, uuid) from public, anon;
grant execute on function public.unbook_bank_transaction(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.match_bank_transactions(uuid, uuid, uuid) from public, anon;
grant execute on function public.match_bank_transactions(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.report_open_items(uuid, date) from public, anon;
grant execute on function public.report_open_items(uuid, date) to authenticated, service_role;
revoke execute on function public.invoice_settlement(uuid, uuid, date) from public, anon;
grant execute on function public.invoice_settlement(uuid, uuid, date) to authenticated, service_role;
revoke execute on function public.purchase_invoice_settlement(uuid, uuid, date) from public, anon;
grant execute on function public.purchase_invoice_settlement(uuid, uuid, date) to authenticated, service_role;
revoke execute on function public.sync_invoice_payment_status(uuid, uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.sync_invoice_payment_status(uuid, uuid, uuid, date) to service_role;
revoke execute on function public.sync_purchase_invoice_payment_status(uuid, uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.sync_purchase_invoice_payment_status(uuid, uuid, uuid, date) to service_role;
revoke all on function public.record_bank_balance(uuid, uuid, date, bigint, text, text, uuid) from public, anon;
grant execute on function public.record_bank_balance(uuid, uuid, date, bigint, text, text, uuid) to authenticated, service_role;

commit;
