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
--
--  5  MOLLIE-TERUGBETALINGEN EN -TERUGBOEKINGEN IN HET GROOTBOEK. Zodra
--     "betaald" de Mollie-betalingen meetelt, moet ook het geld dat via Mollie
--     teruggaat meetellen: een terugboeking (chargeback) zette de factuur anders
--     op "voldaan" terwijl de klant weer moet betalen, en een terugbetaling met
--     creditnota liet een tegoed van de klant zien dat er niet is. Beide boeken
--     nu 1300 tegen 1102, met de factuur als bron, net als de betaling zelf.
--
--  6  DE STATUS VOLGT OOK DE CREDITNOTA. Eerst 30 per bank en dan een
--     creditnota van 70 liet de factuur op 'overdue' staan (herinneringen en
--     aanmaningen liepen door), andersom ging hij op betaald. De regel is nu
--     voor beide volgordes dezelfde: niets meer open én er is echt betaald.
--
--  7  DE BANKKOPPELING OP DE FACTUUR (paid_bank_transaction_id) zet alleen de
--     afletterlogica, altijd binnen de eigen organisatie; een statuswijziging
--     buiten de bank om maakt hem leeg. Betaald via de bank krijgt dezelfde
--     tijdlijnregel, auditregel en versie als betaald via Mollie.
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

-- Geld dat via Mollie teruggaat, krijgt een eigen boekstuk (zie sectie 11).
alter table public.invoice_refunds
  add column if not exists journal_entry_id uuid references public.journal_entries(id) on delete set null;
alter table public.invoice_chargebacks
  add column if not exists journal_entry_id uuid references public.journal_entries(id) on delete set null;

-- Tijdlijn: een teruggedraaide bankbetaling (intern; de klant ziet alleen dat
-- de eerdere "Betaald" verdwijnt, zie _shared/publicTimeline.ts).
-- Lijst = 20261010000000 + 'payment_unbooked'.
alter table public.invoice_workflow_events drop constraint if exists invoice_workflow_events_event_type_check;
alter table public.invoice_workflow_events
  add constraint invoice_workflow_events_event_type_check
  check (event_type in (
    'created_from_quote','public_token_created','public_link_created','sent_to_client',
    'email_sent','email_delivered','email_opened','email_clicked','email_bounced','email_failed','email_complained',
    'client_viewed','payment_link_created','payment_open','payment_paid','payment_failed','payment_expired',
    'invoice_version_created','invoice_pdf_attached','locked','expired','cancelled','void','written_off',
    'payment_refunded','credit_note_issued',
    'payment_charged_back','chargeback_reversed','credit_note_emailed',
    'marked_overdue','reminder_sent','reminder_failed',
    'dunning_proposed','dunning_sent','dunning_failed','dunning_cancelled',
    'e_invoice_sent','e_invoice_delivered','e_invoice_failed',
    'payment_unbooked'
  ));

-- ------------------------------------------------------------
-- 1b. De bankkoppeling bewaken. Alleen de sync-functies hieronder zetten hem
--     (met een transactie-lokale vlag). Van buitenaf:
--     · bij aanmaken altijd leeg (een kopie van een betaalde factuur is niet betaald);
--     · een statuswijziging maakt hem leeg: wie de status met de hand zet,
--       neemt het over van de bank — terugdraaien raakt die status dan niet;
--     · leegmaken mag altijd (ook de cascade bij het verwijderen van een
--       bankrekening), zelf een transactie aanwijzen niet.
--     En nooit een transactie van een andere organisatie.
-- ------------------------------------------------------------
create or replace function public.guard_paid_bank_transaction_id()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_by_sync boolean := coalesce(current_setting('resofly.bank_payment_sync', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if not v_by_sync then
      new.paid_bank_transaction_id := null;
    end if;
  elsif not v_by_sync then
    if new.status is distinct from old.status then
      new.paid_bank_transaction_id := null;
    elsif new.paid_bank_transaction_id is distinct from old.paid_bank_transaction_id
          and new.paid_bank_transaction_id is not null then
      raise exception 'De bankbetaling bij een factuur wordt alleen door het afletteren vastgelegd.'
        using errcode = '42501';
    end if;
  end if;

  if new.paid_bank_transaction_id is not null
     and (tg_op = 'INSERT' or new.paid_bank_transaction_id is distinct from old.paid_bank_transaction_id)
     and not exists (
       select 1 from public.bank_transactions bt
       where bt.id = new.paid_bank_transaction_id and bt.organization_id = new.organization_id
     ) then
    raise exception 'Deze banktransactie hoort niet bij deze organisatie.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_guard_paid_bank_transaction on public.invoices;
create trigger invoices_guard_paid_bank_transaction
  before insert or update of status, paid_bank_transaction_id on public.invoices
  for each row execute function public.guard_paid_bank_transaction_id();
drop trigger if exists purchase_invoices_guard_paid_bank_transaction on public.purchase_invoices;
create trigger purchase_invoices_guard_paid_bank_transaction
  before insert or update of status, paid_bank_transaction_id on public.purchase_invoices
  for each row execute function public.guard_paid_bank_transaction_id();

-- ------------------------------------------------------------
-- 2. invoice_settlement: per verkoopfactuur uit het grootboek (1300).
--    Per bron worden ALLE geboekte boekstukken gesommeerd, dus een
--    tegenboeking (zelfde bron) valt er vanzelf tegen weg.
--      geboekt      = de factuurboeking
--      betaald      = Mollie (bron = de factuur; terugbetalingen en
--                     terugboekingen via Mollie tellen daar negatief in mee,
--                     sectie 10c) + afgeletterde bankbetalingen
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
-- 4. sync_invoice_payment_status: de factuurstatus volgt het grootboek.
--    Aangeroepen na een bankboeking, het terugdraaien daarvan, een creditnota
--    en een Mollie-terugboeking — in elke volgorde dezelfde uitkomst:
--    · niets meer open én er is echt betaald (niet alleen gecrediteerd):
--      'sent'/'overdue' → 'paid', met de laatste afgeletterde bankbetaling als
--      koppeling (leeg als het geld via Mollie kwam);
--    · zette de bank de factuur op betaald (koppeling gevuld) en staat er weer
--      iets open: terug naar 'sent'/'overdue'. Handmatig of via Mollie op
--      betaald gezet (geen koppeling) blijft ongemoeid.
--    Bij betaald dezelfde sporen als de Mollie-route: tijdlijn, audit, versie
--    en vergrendeling.
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
  v_paid bigint;
  v_open bigint;
  v_txn public.bank_transactions;
  v_date date;
begin
  -- for update: boeken, terugdraaien en crediteren van dezelfde factuur wachten
  -- op elkaar, ook als hun boekdatums in verschillende jaren vallen (de
  -- boekstuk-lock in post_journal_entry is per jaar).
  select * into v_inv from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;
  if not found then
    return;
  end if;

  select s.paid_cents, s.open_cents into v_paid, v_open
  from public.invoice_settlement(p_organization_id, p_invoice_id) s;

  -- De laatste afgeletterde bankbetaling (de net geboekte als die er is).
  select bt.* into v_txn
  from public.bank_transactions bt
  where bt.organization_id = p_organization_id
    and bt.matched_invoice_id = p_invoice_id
    and bt.status = 'booked'
  order by (bt.id = p_paying_transaction_id) desc, bt.booking_date desc, bt.booked_at desc nulls last
  limit 1;

  -- Alleen hier mag de koppeling worden gezet (guard_paid_bank_transaction_id).
  perform set_config('resofly.bank_payment_sync', 'on', true);

  if v_open <= 0 and v_paid > 0 and v_inv.status in ('sent', 'overdue') then
    v_date := coalesce(p_paid_date, v_txn.booking_date, current_date);
    update public.invoices
    set status = 'paid',
        paid_at = coalesce(paid_at, v_date::timestamptz),
        paid_bank_transaction_id = v_txn.id,
        locked_at = coalesce(locked_at, now()),
        locked_reason = coalesce(locked_reason, 'paid'),
        updated_at = now()
    where id = v_inv.id
    returning * into v_inv;

    perform public.insert_invoice_workflow_event(
      p_organization_id, v_inv.id, 'payment_paid', 'Factuur betaald',
      case when v_txn.id is not null
           then 'Betaling ontvangen op de bank (' || to_char(v_txn.booking_date, 'DD-MM-YYYY') || ').'
           else 'Voldaan: betaald en de rest gecrediteerd.' end,
      jsonb_build_object('source', case when v_txn.id is not null then 'bank' else 'settlement' end,
                         'bank_transaction_id', v_txn.id),
      auth.uid());
    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (p_organization_id, auth.uid(), 'invoice_paid', 'invoice', v_inv.id, coalesce(v_inv.number, ''),
            jsonb_build_object('source', case when v_txn.id is not null then 'bank' else 'settlement' end,
                               'bank_transaction_id', v_txn.id));
    -- De versie is een spoor, geen voorwaarde: mislukt hij, dan gaat de boeking door.
    begin
      perform public.create_invoice_version_snapshot(
        v_inv.id, p_organization_id, 'paid', auth.uid(), null, null,
        v_inv.last_pdf_file_name, v_inv.last_pdf_mime_type, v_inv.last_pdf_size_bytes, v_inv.last_pdf_sha256,
        null, jsonb_build_object('bank_transaction_id', v_txn.id));
    exception when others then
      raise warning 'Versie bij betaald (factuur %) niet vastgelegd: %', v_inv.id, sqlerrm;
    end;

  elsif v_inv.status = 'paid' and v_inv.paid_bank_transaction_id is not null then
    if v_open > 0 then
      update public.invoices
      set status = case when due_date is not null and due_date < current_date then 'overdue' else 'sent' end,
          paid_at = null,
          paid_bank_transaction_id = null,
          updated_at = now()
      where id = v_inv.id;

      perform public.insert_invoice_workflow_event(
        p_organization_id, v_inv.id, 'payment_unbooked', 'Bankbetaling teruggedraaid',
        'De afgeletterde bankbetaling is teruggedraaid; de factuur staat weer open.',
        jsonb_build_object('source', 'bank', 'bank_transaction_id', v_inv.paid_bank_transaction_id),
        auth.uid());
      insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
      values (p_organization_id, auth.uid(), 'updated', 'invoice', v_inv.id, coalesce(v_inv.number, ''),
              jsonb_build_object('reason', 'bank_payment_unbooked', 'bank_transaction_id', v_inv.paid_bank_transaction_id));
    elsif not exists (
      select 1 from public.bank_transactions bt
      where bt.id = v_inv.paid_bank_transaction_id
        and bt.organization_id = p_organization_id
        and bt.status = 'booked'
    ) then
      -- Nog steeds voldaan, maar niet meer door die transactie: naar de
      -- bankbetaling die er nog is, of leeg (dan kwam het geld via Mollie).
      update public.invoices set paid_bank_transaction_id = v_txn.id where id = v_inv.id;
    end if;
  end if;

  perform set_config('resofly.bank_payment_sync', '', true);
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
  where id = p_purchase_invoice_id and organization_id = p_organization_id
  for update;
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
    perform set_config('resofly.bank_payment_sync', 'on', true);
    update public.purchase_invoices
    set payment_status = v_payment_status,
        status = v_status,
        paid_at = v_paid_at,
        paid_bank_transaction_id = v_paid_txn
    where id = v_pi.id;
    perform set_config('resofly.bank_payment_sync', '', true);
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

  -- De factuur vóór het tegenboeken vergrendelen, in dezelfde volgorde als
  -- book_bank_transaction (transactie → factuur → boekstuk). De tegenboeking
  -- krijgt de datum van vandaag en kan dus in een ander jaar vallen dan de
  -- boeking; de boekstuk-lock per jaar houdt die twee dan niet uit elkaar.
  if v_invoice_id is not null then
    perform 1 from public.invoices
    where id = v_invoice_id and organization_id = p_organization_id for update;
  end if;
  if v_purchase_invoice_id is not null then
    perform 1 from public.purchase_invoices
    where id = v_purchase_invoice_id and organization_id = p_organization_id for update;
  end if;

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
--    (Basis: 20260721000000 Blok A. Nieuw: alleen facturen waar het bedrag nog
--    in past, voorrang voor de factuur waarvan het OPENSTAANDE bedrag klopt, en
--    per transactie een rijlock: een rij die intussen is geboekt of genegeerd,
--    of die iemand nu aan het boeken is, slaat de matcher over. Zonder die
--    lock zette een matchronde een net geboekte transactie terug op
--    'suggested' — met boekstuk en al, en de factuur weer open.)
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
    -- Opnieuw lezen mét lock: de lijst hierboven is een momentopname.
    select * into v_txn from public.bank_transactions
    where id = v_txn.id and status = 'unmatched'
    for update skip locked;
    if not found then
      continue;
    end if;

    v_inv_id := null; v_pi_id := null; v_rule := null; v_sup := null;
    v_haystack := lower(replace(coalesce(v_txn.description,'') || ' ' || coalesce(v_txn.structured_reference,''), ' ', ''));
    v_iban := upper(replace(coalesce(v_txn.counterparty_iban,''), ' ', ''));

    if v_txn.amount_cents > 0 then
      -- Ontvangst: verkoopfactuur op factuurnummer in omschrijving/kenmerk. Alleen
      -- geboekte facturen waar dit bedrag nog in past (meer dan het openstaande
      -- saldo weigert book_bank_transaction; één overboeking voor meerdere
      -- facturen vraagt om splitsen). Het nummerfilter gaat vóór de
      -- saldoberekening, die dus alleen voor echte kandidaten draait.
      select i.id into v_inv_id
      from public.invoices i
      cross join lateral public.invoice_settlement(p_organization_id, i.id) s
      where i.organization_id = p_organization_id
        and i.status not in ('cancelled','void')
        and i.journal_entry_id is not null
        and i.number is not null and length(btrim(i.number)) > 0
        and position(lower(replace(i.number,' ','')) in v_haystack) > 0
        and s.open_cents >= abs(v_txn.amount_cents)
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
        and s.open_cents >= abs(v_txn.amount_cents)
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
-- 10b. post_credit_note_to_ledger
--      (Basis: 20260726100000, verder 1-op-1. Nieuw: de factuur wordt vóór het
--      boekstuk vergrendeld, en daarna volgt de factuurstatus het nieuwe saldo.)
-- ------------------------------------------------------------
create or replace function public.post_credit_note_to_ledger(
  p_organization_id uuid,
  p_credit_note_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
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
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
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

  -- GEWIJZIGD (20261018000000): for update — de factuur vóór het boekstuk
  -- vergrendelen, net als book_bank_transaction (anders kunnen een creditnota
  -- en een bankboeking op dezelfde factuur op elkaar wachten).
  select * into v_inv from public.invoices
  where id = v_cn.invoice_id and organization_id = p_organization_id
  for update;
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

  -- TOEGEVOEGD (20261018000000): de factuurstatus volgt ook de creditnota.
  -- Eerst 30 per bank en dan 70 gecrediteerd is net zo voldaan als andersom.
  perform public.sync_invoice_payment_status(p_organization_id, v_inv.id);
  return v_entry;
end;
$$;

-- ------------------------------------------------------------
-- 10c. Geld dat via Mollie teruggaat: 1300 tegen 1102.
--      book_invoice_payment boekt een Mollie-betaling als 1102 aan 1300, met de
--      factuur als bron. Een terugbetaling (refund, 'refunded') en een
--      terugboeking (chargeback, 'charged_back') zijn daar het spiegelbeeld
--      van: de vordering komt weer open (of het tegoed van een creditnota valt
--      weg) en Mollie houdt het geld in. Zelfde bron, dus invoice_settlement
--      telt ze vanzelf als negatieve betaling. Alleen als de betaling zelf in
--      het grootboek staat: anders is er niets om terug te nemen. Een
--      teruggedraaide terugboeking ('reversed') wordt tegengeboekt.
--      Handmatige terugbetalingen (kind 'manual') gaan via de bank en vallen
--      hierbuiten.
-- ------------------------------------------------------------
create or replace function public.book_mollie_money_back(
  p_organization_id uuid,
  p_kind text,
  p_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice_id uuid;
  v_payment_record_id uuid;
  v_amount bigint;
  v_at timestamptz;
  v_entry_id uuid;
  v_should_book boolean;
  v_inv public.invoices;
  v_payment_booked boolean;
  v_entry public.journal_entries;
  v_what text := case when p_kind = 'refund' then 'terugbetaling' else 'terugboeking' end;
begin
  if p_kind = 'refund' then
    select r.invoice_id, r.payment_record_id, r.amount_cents, coalesce(r.refunded_at, r.updated_at),
           r.journal_entry_id, (r.status = 'refunded' and r.kind = 'mollie')
      into v_invoice_id, v_payment_record_id, v_amount, v_at, v_entry_id, v_should_book
    from public.invoice_refunds r
    where r.id = p_id and r.organization_id = p_organization_id
    for update;
  elsif p_kind = 'chargeback' then
    select c.invoice_id, c.payment_record_id, c.amount_cents, c.charged_back_at,
           c.journal_entry_id, (c.status = 'charged_back')
      into v_invoice_id, v_payment_record_id, v_amount, v_at, v_entry_id, v_should_book
    from public.invoice_chargebacks c
    where c.id = p_id and c.organization_id = p_organization_id
    for update;
  else
    raise exception 'Onbekende soort: %.', p_kind using errcode = '22023';
  end if;
  if not found or v_should_book = (v_entry_id is not null) then
    return v_entry_id;  -- niet gevonden, of al in orde
  end if;

  -- De factuur vóór het boekstuk, net als bij de bankboeking.
  select * into v_inv from public.invoices
  where id = v_invoice_id and organization_id = p_organization_id
  for update;

  if v_should_book then
    select p.journal_entry_id is not null
           and not exists (select 1 from public.journal_entries je
                           where je.id = p.journal_entry_id and je.reversed_by_entry_id is not null)
      into v_payment_booked
    from public.invoice_payment_records p
    where p.id = v_payment_record_id and p.organization_id = p_organization_id;
    if not coalesce(v_payment_booked, false) then
      return null;
    end if;

    perform public.ensure_default_ledger_accounts(p_organization_id);
    v_entry := public.post_journal_entry(
      p_organization_id,
      public.first_open_booking_date(p_organization_id, coalesce(v_at, now())::date),
      initcap(v_what) || ' via Mollie (factuur ' || coalesce(v_inv.number, '') || ')',
      'payment', v_invoice_id,
      jsonb_build_array(
        jsonb_build_object(
          'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
          'description', 'Debiteuren — ' || v_what || ' factuur ' || coalesce(v_inv.number, ''),
          'debit_cents', v_amount, 'credit_cents', 0, 'client_id', v_inv.client_id),
        jsonb_build_object(
          'account_id', public.bookkeeping_account_id(p_organization_id, '1102'),
          'description', case when p_kind = 'refund' then 'Mollie: terugbetaald aan de klant'
                              else 'Mollie: teruggeboekt door de bank van de klant' end,
          'debit_cents', 0, 'credit_cents', v_amount)),
      null);
    v_entry_id := v_entry.id;
  else
    perform public.reverse_journal_entry(
      v_entry_id, public.first_open_booking_date(p_organization_id, current_date), null);
    v_entry_id := null;
  end if;

  if p_kind = 'refund' then
    update public.invoice_refunds set journal_entry_id = v_entry_id where id = p_id;
  else
    update public.invoice_chargebacks set journal_entry_id = v_entry_id where id = p_id;
    -- Zette de bank de factuur op betaald, dan staat hij nu weer open.
    perform public.sync_invoice_payment_status(p_organization_id, v_invoice_id);
  end if;
  return v_entry_id;
end;
$$;

-- Automatisch, net als de betaling zelf (trg_autobook_invoice_payment): een
-- mislukte boeking mag de verwerking van de Mollie-webhook niet tegenhouden.
create or replace function public.trg_book_mollie_money_back()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.book_mollie_money_back(new.organization_id, tg_argv[0], new.id);
  exception when others then
    raise warning 'Mollie-% % niet in het grootboek geboekt: %', tg_argv[0], new.id, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists invoice_refunds_autobook on public.invoice_refunds;
create trigger invoice_refunds_autobook
  after insert or update of status on public.invoice_refunds
  for each row execute function public.trg_book_mollie_money_back('refund');
drop trigger if exists invoice_chargebacks_autobook on public.invoice_chargebacks;
create trigger invoice_chargebacks_autobook
  after insert or update of status on public.invoice_chargebacks
  for each row execute function public.trg_book_mollie_money_back('chargeback');

-- ------------------------------------------------------------
-- 11. Bestaande gegevens bijwerken:
--     a. Mollie-terugbetalingen en -terugboekingen boeken (sectie 10c);
--     b. facturen die al volledig via de bank zijn betaald maar nog op
--        'sent'/'overdue' staan, gaan op betaald; bij inkoop wordt de
--        betaalstatus afgeleid.
--     Zonder push "Factuur betaald" en zonder webhook invoice.paid: dit is
--     achterstallig bijwerken, geen betaling van vandaag. Tijdlijn en audit
--     krijgen hun regel wel.
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_trigger where tgrelid = 'public.invoices'::regclass and tgname = 'push_invoices_paid') then
    alter table public.invoices disable trigger push_invoices_paid;
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.invoices'::regclass and tgname = 'zz_webhook_capture') then
    alter table public.invoices disable trigger zz_webhook_capture;
  end if;
end $$;

do $$
declare
  r record;
  v_role text := current_setting('request.jwt.claim.role', true);
begin
  -- De boekfuncties vragen schrijfrechten; de migratie boekt als systeem.
  perform set_config('request.jwt.claim.role', 'service_role', true);

  for r in
    select 'refund' as kind, id, organization_id, created_at from public.invoice_refunds
    where status = 'refunded' and kind = 'mollie' and journal_entry_id is null
    union all
    select 'chargeback', id, organization_id, created_at from public.invoice_chargebacks
    where status = 'charged_back' and journal_entry_id is null
    order by created_at
  loop
    begin
      perform public.book_mollie_money_back(r.organization_id, r.kind, r.id);
    exception when others then
      raise warning 'Mollie-% % niet geboekt: %', r.kind, r.id, sqlerrm;
    end;
  end loop;

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

  perform set_config('request.jwt.claim.role', coalesce(v_role, ''), true);
end $$;

do $$
begin
  if exists (select 1 from pg_trigger where tgrelid = 'public.invoices'::regclass and tgname = 'push_invoices_paid') then
    alter table public.invoices enable trigger push_invoices_paid;
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.invoices'::regclass and tgname = 'zz_webhook_capture') then
    alter table public.invoices enable trigger zz_webhook_capture;
  end if;
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
revoke all on function public.post_credit_note_to_ledger(uuid, uuid, uuid) from public, anon;
grant execute on function public.post_credit_note_to_ledger(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.book_mollie_money_back(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.book_mollie_money_back(uuid, text, uuid) to service_role;

commit;
