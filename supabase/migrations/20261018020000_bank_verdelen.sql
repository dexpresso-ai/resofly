-- ============================================================
-- ResoFly — Bank: één overboeking verdelen over meerdere facturen
-- Date: 2026-10-18
-- Bron: BANK_VERVOLG_2026-10-18.md §1 (bouwplan blok 3.1)
--
-- Een klant die drie facturen in één keer betaalt, een batchbetaling aan een
-- leverancier, een ontvangst die deels een factuur is en deels iets anders: een
-- banktransactie kon maar op één factuur, of op grootboekregels.
--
--  1  bank_transaction_allocations: welk deel van een geboekte banktransactie
--     op welke (inkoop)factuur ging. Het blijft één boekstuk per bankregel —
--     de bank tegen één debiteuren- of crediteurenregel per factuur, plus
--     eventuele grootboekregels — maar welke 1300/1600-regel bij welke factuur
--     hoort, staat niet in de journaalregel zelf. Dat legt deze tabel vast.
--  2  invoice_settlement / purchase_invoice_settlement tellen die delen mee
--     zolang het boekstuk staat. Een tegenboeking telt het deel weer terug, op
--     haar eigen datum: op een peildatum daartussen was de factuur betaald.
--  3  book_bank_transaction(…, p_allocations): verdelen over verkoopfacturen,
--     inkoopfacturen en grootboekregels (met btw); het totaal moet precies
--     kloppen. Elke factuur wordt begrensd op wat er nog openstaat en volgt
--     zijn eigen deel (betaald of deels betaald). In de richting van het geld:
--     een ontvangst op een verkoopfactuur en een betaling op een inkoopfactuur
--     — en ook terugbetalen: een betaling op een verkoopfactuur waar de klant
--     tegoed heeft, een ontvangst op een inkoopfactuur waar wij tegoed hebben.
--  4  unbook_bank_transaction zet alle facturen van een verdeling terug.
--  5  De matcher stelt een verdeling voor als er meerdere factuurnummers in de
--     omschrijving staan waarvan de openstaande bedragen samen precies het
--     bedrag zijn (bank_transactions.suggested_allocations).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. De verdeling
-- ------------------------------------------------------------
alter table public.bank_transactions add column if not exists suggested_allocations jsonb;
comment on column public.bank_transactions.suggested_allocations is
  'Verdeelvoorstel van de matcher: [{invoice_id | purchase_invoice_id, amount_cents}].';

create table if not exists public.bank_transaction_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bank_transaction_id uuid not null references public.bank_transactions(id) on delete cascade,
  -- Het boekstuk waar dit deel in zit; een tegenboeking ervan telt het deel terug.
  journal_entry_id uuid not null references public.journal_entries(id),
  invoice_id uuid references public.invoices(id),
  purchase_invoice_id uuid references public.purchase_invoices(id),
  amount_cents bigint not null check (amount_cents > 0),
  -- De richting van het geld bij het boeken: ontvangst (true) of betaling.
  incoming boolean not null,
  created_at timestamptz not null default now(),
  constraint bank_transaction_allocations_one_target check (num_nonnulls(invoice_id, purchase_invoice_id) = 1)
);
comment on table public.bank_transaction_allocations is
  'Welk deel van een geboekte banktransactie op welke (inkoop)factuur ging. Alleen book_bank_transaction schrijft.';

create index if not exists idx_bank_tx_alloc_invoice
  on public.bank_transaction_allocations(invoice_id) where invoice_id is not null;
create index if not exists idx_bank_tx_alloc_purchase_invoice
  on public.bank_transaction_allocations(purchase_invoice_id) where purchase_invoice_id is not null;
create index if not exists idx_bank_tx_alloc_transaction
  on public.bank_transaction_allocations(bank_transaction_id);
create index if not exists idx_bank_tx_alloc_entry
  on public.bank_transaction_allocations(journal_entry_id);

-- Alles binnen één organisatie, ook als iemand ooit buiten de boekfunctie schrijft.
create or replace function public.enforce_bank_transaction_allocations_org()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform public.assert_same_org_reference('public.bank_transactions', new.bank_transaction_id, new.organization_id, 'bank_transaction_allocations.bank_transaction_id');
  perform public.assert_same_org_reference('public.journal_entries', new.journal_entry_id, new.organization_id, 'bank_transaction_allocations.journal_entry_id');
  perform public.assert_same_org_reference('public.invoices', new.invoice_id, new.organization_id, 'bank_transaction_allocations.invoice_id');
  perform public.assert_same_org_reference('public.purchase_invoices', new.purchase_invoice_id, new.organization_id, 'bank_transaction_allocations.purchase_invoice_id');
  return new;
end;
$$;
drop trigger if exists bank_transaction_allocations_org on public.bank_transaction_allocations;
create trigger bank_transaction_allocations_org
  before insert or update on public.bank_transaction_allocations
  for each row execute function public.enforce_bank_transaction_allocations_org();

alter table public.bank_transaction_allocations enable row level security;
drop policy if exists "bank_transaction_allocations read" on public.bank_transaction_allocations;
create policy "bank_transaction_allocations read" on public.bank_transaction_allocations
  for select using (public.can_read_org(organization_id));
-- Geen schrijf-policies: alleen book_bank_transaction (security definer) schrijft.
revoke insert, update, delete, truncate on public.bank_transaction_allocations from anon, authenticated;
-- Zoals de andere banktabellen: alleen wie bij Financiën mag (ook voor de boekhouder).
select public.apply_module_gate('bank_transaction_allocations', 'finance');

-- ------------------------------------------------------------
-- 2. invoice_settlement en purchase_invoice_settlement
--    (Basis: 20261018000000. Nieuw: de delen uit een verdeling, met hun tegenboekingen.)
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
  with recursive docs(kind, source_type, source_id) as (
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
  -- Verdeelde bankboekingen (20261018020000): het deel voor deze factuur, in
  -- het boekstuk van de verdeling en de keten van tegenboekingen erachter (om
  -- en om +1, −1, …). Zo telt een teruggedraaide verdeling niet meer mee, en op
  -- een peildatum tussen boeken en terugdraaien juist wel.
  alloc_chain(debit_cents, entry_id, sign) as (
    select (case when a.incoming then -a.amount_cents else a.amount_cents end)::bigint, a.journal_entry_id, 1
    from public.bank_transaction_allocations a
    where a.organization_id = p_organization_id and a.invoice_id = p_invoice_id
    union all
    select c.debit_cents, e.reversed_by_entry_id, -c.sign
    from alloc_chain c
    join public.journal_entries e on e.id = c.entry_id
    where e.reversed_by_entry_id is not null
  ),
  -- Een eerdere verdeling van een transactie die nu op deze factuur staat (en
  -- haar tegenboekingen) telt alleen via haar delen: via de bron zou de hele
  -- verdeling meetellen, op een peildatum tussen boeken en terugdraaien.
  split_entries(entry_id) as (
    select a.journal_entry_id
    from public.bank_transaction_allocations a
    where a.organization_id = p_organization_id
      and a.bank_transaction_id in (select d.source_id from docs d where d.kind = 'paid')
    union
    select e.reversed_by_entry_id
    from split_entries s
    join public.journal_entries e on e.id = s.entry_id
    where e.reversed_by_entry_id is not null
  ),
  moves(kind, debit_cents) as (
    select d.kind, (jl.debit_cents - jl.credit_cents)::bigint
    from docs d
    join public.journal_entries je
      on je.organization_id = p_organization_id
     and je.source_type = d.source_type
     and je.source_id = d.source_id
     and je.status = 'posted'
     and (p_as_of is null or je.date <= p_as_of)
     and not exists (select 1 from split_entries se where se.entry_id = je.id)
    join public.journal_lines jl on jl.entry_id = je.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
    union all
    select 'paid', c.debit_cents * c.sign
    from alloc_chain c
    join public.journal_entries je
      on je.id = c.entry_id
     and je.status = 'posted'
     and (p_as_of is null or je.date <= p_as_of)
  ),
  net as (
    select m.kind, sum(m.debit_cents)::bigint as debit_cents from moves m group by m.kind
  )
  select
    coalesce((select n.debit_cents from net n where n.kind = 'booked'), 0)::bigint,
    coalesce(-(select n.debit_cents from net n where n.kind = 'paid'), 0)::bigint,
    coalesce(-(select n.debit_cents from net n where n.kind = 'credited'), 0)::bigint,
    coalesce((select sum(n.debit_cents) from net n), 0)::bigint;
$$;

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
  with recursive docs(kind, source_type, source_id) as (
    select 'booked', 'purchase_invoice', p_purchase_invoice_id
    union all
    select 'paid', 'payment', bt.id
    from public.bank_transactions bt
    where bt.organization_id = p_organization_id
      and bt.matched_purchase_invoice_id = p_purchase_invoice_id
      and bt.status = 'booked'
  ),
  -- Verdeelde bankboekingen (20261018020000), zoals bij invoice_settlement.
  alloc_chain(credit_cents, entry_id, sign) as (
    select (case when a.incoming then a.amount_cents else -a.amount_cents end)::bigint, a.journal_entry_id, 1
    from public.bank_transaction_allocations a
    where a.organization_id = p_organization_id and a.purchase_invoice_id = p_purchase_invoice_id
    union all
    select c.credit_cents, e.reversed_by_entry_id, -c.sign
    from alloc_chain c
    join public.journal_entries e on e.id = c.entry_id
    where e.reversed_by_entry_id is not null
  ),
  split_entries(entry_id) as (
    select a.journal_entry_id
    from public.bank_transaction_allocations a
    where a.organization_id = p_organization_id
      and a.bank_transaction_id in (select d.source_id from docs d where d.kind = 'paid')
    union
    select e.reversed_by_entry_id
    from split_entries s
    join public.journal_entries e on e.id = s.entry_id
    where e.reversed_by_entry_id is not null
  ),
  moves(kind, credit_cents) as (
    select d.kind, (jl.credit_cents - jl.debit_cents)::bigint
    from docs d
    join public.journal_entries je
      on je.organization_id = p_organization_id
     and je.source_type = d.source_type
     and je.source_id = d.source_id
     and je.status = 'posted'
     and (p_as_of is null or je.date <= p_as_of)
     and not exists (select 1 from split_entries se where se.entry_id = je.id)
    join public.journal_lines jl on jl.entry_id = je.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
    union all
    select 'paid', c.credit_cents * c.sign
    from alloc_chain c
    join public.journal_entries je
      on je.id = c.entry_id
     and je.status = 'posted'
     and (p_as_of is null or je.date <= p_as_of)
  ),
  net as (
    select m.kind, sum(m.credit_cents)::bigint as credit_cents from moves m group by m.kind
  )
  select
    coalesce((select n.credit_cents from net n where n.kind = 'booked'), 0)::bigint,
    coalesce(-(select n.credit_cents from net n where n.kind = 'paid'), 0)::bigint,
    coalesce((select sum(n.credit_cents) from net n), 0)::bigint;
$$;

-- ------------------------------------------------------------
-- 3. sync_invoice_payment_status
--    (Basis: 20261018000000. Nieuw: de koppeling kan ook naar een verdeelde ontvangst wijzen.)
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
  v_bank_gone boolean;
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

  -- De laatste afgeletterde bankbetaling (de net geboekte als die er is): op
  -- de factuur zelf, of als deel van een verdeelde ontvangst (20261018020000).
  select bt.* into v_txn
  from (
    select b.* from public.bank_transactions b
    where b.organization_id = p_organization_id
      and b.matched_invoice_id = p_invoice_id
      and b.status = 'booked'
    union all
    select b.* from public.bank_transaction_allocations a
    join public.bank_transactions b on b.id = a.bank_transaction_id and b.journal_entry_id = a.journal_entry_id
    where a.organization_id = p_organization_id
      and a.invoice_id = p_invoice_id
      and a.incoming
      and b.status = 'booked'
  ) bt
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
    v_bank_gone := not exists (
      select 1 from public.bank_transactions bt
      where bt.id = v_inv.paid_bank_transaction_id
        and bt.organization_id = p_organization_id
        and bt.status = 'booked'
    );
    -- Weer open als er iets openstaat, maar ook als er niets meer betaald is
    -- (betaald, volledig gecrediteerd, en dan de betaling teruggedraaid): dan
    -- is hij "voldaan" door de creditnota alleen, en dat is niet betaald.
    if v_open > 0 or v_paid <= 0 then
      update public.invoices
      set status = case when due_date is not null and due_date < current_date then 'overdue' else 'sent' end,
          paid_at = null,
          paid_bank_transaction_id = null,
          updated_at = now()
      where id = v_inv.id;

      if v_bank_gone then
        perform public.insert_invoice_workflow_event(
          p_organization_id, v_inv.id, 'payment_unbooked', 'Bankbetaling teruggedraaid',
          'De afgeletterde bankbetaling is teruggedraaid; de factuur staat weer open.',
          jsonb_build_object('source', 'bank', 'bank_transaction_id', v_inv.paid_bank_transaction_id),
          auth.uid());
        insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
        values (p_organization_id, auth.uid(), 'updated', 'invoice', v_inv.id, coalesce(v_inv.number, ''),
                jsonb_build_object('reason', 'bank_payment_unbooked', 'bank_transaction_id', v_inv.paid_bank_transaction_id));
      else
        -- De bankbetaling staat er nog; iets anders opende de factuur weer (bv.
        -- een Mollie-terugboeking, die zijn eigen tijdlijnregel schrijft). Geen
        -- melding dat de bankbetaling is teruggedraaid, want dat is niet zo.
        insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
        values (p_organization_id, auth.uid(), 'updated', 'invoice', v_inv.id, coalesce(v_inv.number, ''),
                jsonb_build_object('reason', 'reopened', 'open_cents', v_open, 'paid_cents', v_paid));
      end if;
    elsif v_bank_gone then
      -- Nog steeds voldaan, maar niet meer door die transactie: naar de
      -- bankbetaling die er nog is, of leeg (dan kwam het geld via Mollie).
      update public.invoices set paid_bank_transaction_id = v_txn.id where id = v_inv.id;
    end if;
  end if;

  perform set_config('resofly.bank_payment_sync', '', true);
end;
$$;

-- ------------------------------------------------------------
-- 4. book_bank_transaction
--    (Basis: 20261018000000, verder 1-op-1. Nieuw: p_allocations. De oude versie met zes
--    parameters gaat eerst weg: twee versies naast elkaar maken een aanroep zonder
--    p_allocations dubbelzinnig voor PostgREST.)
-- ------------------------------------------------------------
drop function if exists public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid);

create or replace function public.book_bank_transaction(
  p_organization_id uuid,
  p_transaction_id uuid,
  p_lines jsonb default null,
  p_matched_invoice_id uuid default null,
  p_matched_purchase_invoice_id uuid default null,
  p_created_by uuid default auth.uid(),
  p_allocations jsonb default null
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
  -- Verdelen (20261018020000)
  v_has_alloc boolean := p_allocations is not null and jsonb_typeof(p_allocations) = 'array' and jsonb_array_length(p_allocations) > 0;
  v_has_lines boolean := p_lines is not null and jsonb_typeof(p_lines) = 'array' and jsonb_array_length(p_lines) > 0;
  -- Verdelen in het scherm: een verdeling, of meer dan één grootboekregel.
  v_split boolean;
  v_incoming boolean;
  v_alloc_done jsonb := '[]'::jsonb;  -- [{kind, id, amount_cents}] na controle
  v_alloc_total bigint := 0;
  v_lines_total bigint := 0;
  v_prev_kind text;
  v_prev_id uuid;
  v_label text;
  a record;
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

  -- for share: zo kan assign_own_bank_ledger_account de rekening niet tegelijk naar
  -- een andere grootboekrekening verhangen (dan zou deze boeking op de oude landen).
  select * into v_ba from public.bank_accounts where id = v_txn.bank_account_id and organization_id = p_organization_id for share;
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

  v_incoming := v_txn.amount_cents > 0;
  v_split := v_has_alloc or (v_has_lines and jsonb_array_length(p_lines) > 1);
  if v_has_alloc and (p_matched_invoice_id is not null or p_matched_purchase_invoice_id is not null) then
    raise exception 'Verdelen en één factuur afletteren gaan niet samen: zet de factuur in de verdeling.' using errcode = '22023';
  end if;

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

  elsif v_has_alloc or v_has_lines then
    -- Verdelen (20261018020000): delen op (inkoop)facturen, elk begrensd op wat
    -- er nog openstaat, in de richting van het geld. In een vaste volgorde
    -- (soort, id) vergrendeld: twee verdelingen over dezelfde facturen wachten
    -- dan op elkaar in plaats van elkaar vast te zetten.
    -- Eerst de vorm van alle regels, dan pas per factuur: zo krijgt een fout in de
    -- invoer altijd dezelfde melding, welke factuur ook vooraan staat.
    for a in
      select
        case when nullif(e->>'invoice_id', '') is not null and nullif(e->>'purchase_invoice_id', '') is null then 'invoice'
             when nullif(e->>'purchase_invoice_id', '') is not null and nullif(e->>'invoice_id', '') is null then 'purchase_invoice'
        end as kind,
        coalesce(nullif(e->>'invoice_id', ''), nullif(e->>'purchase_invoice_id', ''))::uuid as id,
        case when (e->>'amount_cents') ~ '^\s*[0-9]+\s*$' then (e->>'amount_cents')::bigint end as amount_cents
      from jsonb_array_elements(case when v_has_alloc then p_allocations else '[]'::jsonb end) as e
      order by 1, 2
    loop
      if a.kind is null then
        raise exception 'Elke verdeelregel hoort bij precies één verkoop- of inkoopfactuur.' using errcode = '22023';
      end if;
      if a.amount_cents is null or a.amount_cents <= 0 then
        raise exception 'Elke verdeelregel heeft een bedrag in hele centen, groter dan € 0,00.' using errcode = '22023';
      end if;
      if a.kind = v_prev_kind and a.id = v_prev_id then
        raise exception 'Dezelfde factuur staat twee keer in de verdeling; tel de bedragen bij elkaar op.' using errcode = '22023';
      end if;
      v_prev_kind := a.kind; v_prev_id := a.id;
    end loop;
    for a in
      select
        case when nullif(e->>'invoice_id', '') is not null and nullif(e->>'purchase_invoice_id', '') is null then 'invoice'
             when nullif(e->>'purchase_invoice_id', '') is not null and nullif(e->>'invoice_id', '') is null then 'purchase_invoice'
        end as kind,
        coalesce(nullif(e->>'invoice_id', ''), nullif(e->>'purchase_invoice_id', ''))::uuid as id,
        case when (e->>'amount_cents') ~ '^\s*[0-9]+\s*$' then (e->>'amount_cents')::bigint end as amount_cents
      from jsonb_array_elements(case when v_has_alloc then p_allocations else '[]'::jsonb end) as e
      order by 1, 2
    loop
      if a.kind = 'invoice' then
        select * into v_inv from public.invoices
        where id = a.id and organization_id = p_organization_id for update;
        if not found then raise exception 'Verkoopfactuur niet gevonden.' using errcode = '02000'; end if;
        v_label := 'factuur ' || coalesce(v_inv.number, '');
        if v_inv.journal_entry_id is null then
          raise exception 'Factuur % staat nog niet in het grootboek. Boek de factuur eerst ("Boek naar grootboek") en verdeel daarna.', coalesce(v_inv.number, '')
            using errcode = '23514';
        end if;
        select je.reversed_by_entry_id is not null into v_entry_reversed
        from public.journal_entries je where je.id = v_inv.journal_entry_id;
        if coalesce(v_entry_reversed, false) then
          raise exception 'De grootboekboeking van factuur % is tegengeboekt; daar valt niets op te verdelen.', coalesce(v_inv.number, '')
            using errcode = '23514';
        end if;
        select s.open_cents into v_open from public.invoice_settlement(p_organization_id, v_inv.id) s;
        if v_incoming then
          -- De klant betaalt.
          if v_open <= 0 then
            raise exception 'Factuur % is al volledig betaald of gecrediteerd; er staat niets meer open.', coalesce(v_inv.number, '')
              using errcode = '23514';
          end if;
          if a.amount_cents > v_open then
            raise exception 'Op factuur % staat nog € % open; je verdeelt er € % op.',
              coalesce(v_inv.number, ''), to_char(v_open / 100.0, 'FM999999990.00'), to_char(a.amount_cents / 100.0, 'FM999999990.00')
              using errcode = '23514';
          end if;
        else
          -- Wij betalen de klant terug: alleen een tegoed (te veel betaald of gecrediteerd).
          if v_open >= 0 then
            raise exception 'Op factuur % heeft de klant geen tegoed; een betaling kan daar niet op.', coalesce(v_inv.number, '')
              using errcode = '23514';
          end if;
          if a.amount_cents > -v_open then
            raise exception 'Het tegoed van de klant op factuur % is € %; je verdeelt er € % op.',
              coalesce(v_inv.number, ''), to_char(-v_open / 100.0, 'FM999999990.00'), to_char(a.amount_cents / 100.0, 'FM999999990.00')
              using errcode = '23514';
          end if;
        end if;
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
          'description', 'Debiteuren — ' || case when v_incoming then '' else 'terugbetaling ' end || v_label,
          'debit_cents', case when v_incoming then 0 else a.amount_cents end,
          'credit_cents', case when v_incoming then a.amount_cents else 0 end,
          'client_id', v_inv.client_id
        ));
      else
        select * into v_pi from public.purchase_invoices
        where id = a.id and organization_id = p_organization_id for update;
        if not found then raise exception 'Inkoopfactuur niet gevonden.' using errcode = '02000'; end if;
        v_label := 'inkoopfactuur ' || coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '');
        if v_pi.journal_entry_id is null then
          raise exception 'Inkoopfactuur % staat nog niet in het grootboek. Boek de inkoopfactuur eerst en verdeel daarna.',
            coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
        end if;
        select je.reversed_by_entry_id is not null into v_entry_reversed
        from public.journal_entries je where je.id = v_pi.journal_entry_id;
        if coalesce(v_entry_reversed, false) then
          raise exception 'De grootboekboeking van inkoopfactuur % is tegengeboekt; daar valt niets op te verdelen.',
            coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
        end if;
        select s.open_cents into v_open from public.purchase_invoice_settlement(p_organization_id, v_pi.id) s;
        if not v_incoming then
          -- Wij betalen de leverancier.
          if v_open <= 0 then
            raise exception 'Inkoopfactuur % is al volledig betaald; er staat niets meer open.',
              coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
          end if;
          if a.amount_cents > v_open then
            raise exception 'Op inkoopfactuur % staat nog € % open; je verdeelt er € % op.',
              coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''), to_char(v_open / 100.0, 'FM999999990.00'),
              to_char(a.amount_cents / 100.0, 'FM999999990.00') using errcode = '23514';
          end if;
        else
          -- De leverancier betaalt ons terug: alleen een tegoed (te veel betaald).
          if v_open >= 0 then
            raise exception 'Op inkoopfactuur % heb je geen tegoed bij de leverancier; een ontvangst kan daar niet op.',
              coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
          end if;
          if a.amount_cents > -v_open then
            raise exception 'Je tegoed op inkoopfactuur % is € %; je verdeelt er € % op.',
              coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''), to_char(-v_open / 100.0, 'FM999999990.00'),
              to_char(a.amount_cents / 100.0, 'FM999999990.00') using errcode = '23514';
          end if;
        end if;
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'account_id', public.bookkeeping_account_id(p_organization_id, '1600'),
          'description', 'Crediteuren — ' || case when v_incoming then 'terugbetaling ' else '' end || v_label,
          'debit_cents', case when v_incoming then 0 else a.amount_cents end,
          'credit_cents', case when v_incoming then a.amount_cents else 0 end,
          'supplier_id', v_pi.supplier_id
        ));
      end if;
      v_alloc_done := v_alloc_done || jsonb_build_array(jsonb_build_object('kind', a.kind, 'id', a.id, 'amount_cents', a.amount_cents));
      v_alloc_total := v_alloc_total + a.amount_cents;
    end loop;

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
        la.subtype as account_subtype,
        la.code as account_code,
        coalesce((l->>'amount_cents')::bigint, 0) as gross_cents,
        nullif(l->>'vat_code','') as vat_code,
        nullif(l->>'description','') as description,
        coalesce(vc.rate, nullif(l->>'vat_rate','')::numeric, 0) as rate,
        coalesce(vc.kind, 'standard') as kind
      from jsonb_array_elements(case when v_has_lines then p_lines else '[]'::jsonb end) l
      cross join lateral (
        select coalesce(nullif(l->>'account_id','')::uuid, public.bookkeeping_account_id(p_organization_id, l->>'account_code')) as account_id
      ) acc
      left join public.ledger_accounts la
        on la.id = acc.account_id and la.organization_id = p_organization_id
      left join public.vat_codes vc
        on vc.organization_id = p_organization_id and vc.code = (l->>'vat_code')
    loop
      if r.gross_cents = 0 then continue; end if;
      v_lines_total := v_lines_total + r.gross_cents;
      -- In een verdeling hoort elke debiteuren- of crediteurenregel bij een
      -- factuur: een losse regel op 1300/1600 staat bij geen enkele factuur open
      -- en de openstaande posten sluiten dan niet meer aan op het grootboek.
      if v_split and r.account_subtype in ('accounts_receivable', 'accounts_payable') then
        raise exception 'Debiteuren en crediteuren gaan in een verdeling via de factuur zelf: kies de factuur in plaats van grootboekrekening %.', coalesce(r.account_code, '')
          using errcode = '23514';
      end if;
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

    -- Een verdeling moet precies kloppen: het verschil zou anders stil op 4900
    -- Afrondingsverschillen belanden (post_journal_entry staat een paar cent toe).
    if v_split and v_alloc_total + v_lines_total <> v_abs then
      raise exception 'De verdeling (€ %) is niet gelijk aan de transactie (€ %): nog € % te verdelen.',
        to_char((v_alloc_total + v_lines_total) / 100.0, 'FM999999990.00'), to_char(v_abs / 100.0, 'FM999999990.00'),
        to_char((v_abs - v_alloc_total - v_lines_total) / 100.0, 'FM999999990.00')
        using errcode = '23514';
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
    suggested_allocations = null,
    matched_invoice_id = p_matched_invoice_id,
    matched_purchase_invoice_id = p_matched_purchase_invoice_id,
    booked_at = now(),
    booked_by = p_created_by,
    updated_at = now()
  where id = v_txn.id;

  -- De verdeling vastleggen (20261018020000): welk deel van dit boekstuk bij
  -- welke factuur hoort. Vóór het bijwerken van de status hieronder.
  insert into public.bank_transaction_allocations(
    organization_id, bank_transaction_id, journal_entry_id, invoice_id, purchase_invoice_id, amount_cents, incoming
  )
  select p_organization_id, v_txn.id, v_entry.id,
         case when x->>'kind' = 'invoice' then (x->>'id')::uuid end,
         case when x->>'kind' = 'purchase_invoice' then (x->>'id')::uuid end,
         (x->>'amount_cents')::bigint, v_incoming
  from jsonb_array_elements(v_alloc_done) x;

  -- De factuur volgt de betaling: volledig voldaan → betaald. Ná de update
  -- hierboven, zodat deze transactie in het openstaande saldo meetelt.
  if p_matched_invoice_id is not null then
    perform public.sync_invoice_payment_status(p_organization_id, p_matched_invoice_id, v_txn.id, v_txn.booking_date);
  elsif p_matched_purchase_invoice_id is not null then
    perform public.sync_purchase_invoice_payment_status(p_organization_id, p_matched_purchase_invoice_id, v_txn.id, v_txn.booking_date);
  end if;
  for a in select x->>'kind' as kind, (x->>'id')::uuid as id from jsonb_array_elements(v_alloc_done) x loop
    if a.kind = 'invoice' then
      perform public.sync_invoice_payment_status(p_organization_id, a.id, v_txn.id, v_txn.booking_date);
    else
      perform public.sync_purchase_invoice_payment_status(p_organization_id, a.id, v_txn.id, v_txn.booking_date);
    end if;
  end loop;

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
-- 5. unbook_bank_transaction
--    (Basis: 20261018000000. Nieuw: alle facturen van een verdeling terug.)
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
  v_alloc jsonb;  -- de verdeling van het huidige boekstuk (20261018020000)
  a record;
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
  -- Een verdeling: al haar facturen, in dezelfde vaste volgorde als bij boeken.
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', case when al.invoice_id is not null then 'invoice' else 'purchase_invoice' end,
           'id', coalesce(al.invoice_id, al.purchase_invoice_id))
         order by case when al.invoice_id is not null then 'invoice' else 'purchase_invoice' end, coalesce(al.invoice_id, al.purchase_invoice_id)), '[]'::jsonb)
    into v_alloc
  from public.bank_transaction_allocations al
  where al.bank_transaction_id = v_txn.id and al.journal_entry_id = v_txn.journal_entry_id;
  for a in select x->>'kind' as kind, (x->>'id')::uuid as id from jsonb_array_elements(v_alloc) x loop
    if a.kind = 'invoice' then
      perform 1 from public.invoices where id = a.id and organization_id = p_organization_id for update;
    else
      perform 1 from public.purchase_invoices where id = a.id and organization_id = p_organization_id for update;
    end if;
  end loop;

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
  -- De verdeling blijft als geschiedenis staan; de tegenboeking telt haar terug.
  for a in select x->>'kind' as kind, (x->>'id')::uuid as id from jsonb_array_elements(v_alloc) x loop
    if a.kind = 'invoice' then
      perform public.sync_invoice_payment_status(p_organization_id, a.id);
    else
      perform public.sync_purchase_invoice_payment_status(p_organization_id, a.id);
    end if;
  end loop;

  return v_txn;
end;
$$;

-- ------------------------------------------------------------
-- 6. match_bank_transactions
--    (Basis: 20261018010000, verder 1-op-1. Nieuw: een verdeling voorstellen.)
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
  v_clearing uuid;
  v_cands jsonb;     -- genoemde facturen met iets open (20261018020000)
  v_match_id uuid;
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

    -- Overboeking tussen eigen rekeningen: de tegenrekening is een andere, actieve
    -- bankrekening van deze organisatie. Beide kanten komen binnen en vallen op de
    -- kruispostenrekening tegen elkaar weg. Vóór de factuurherkenning: een eigen
    -- IBAN zegt meer dan een getal in de omschrijving. Maar niet als de gebruiker
    -- zelf een regel voor die IBAN heeft: die gaat voor (ook automatisch boeken).
    if v_iban <> '' and exists (
      select 1 from public.bank_accounts ob
      where ob.organization_id = p_organization_id
        and ob.id <> v_txn.bank_account_id
        and ob.is_active
        and upper(replace(coalesce(ob.iban, ''), ' ', '')) = v_iban
    ) and not exists (
      select 1 from public.bank_rules br
      where br.organization_id = p_organization_id
        and br.is_active
        and br.match_counterparty_iban is not null
        and upper(replace(br.match_counterparty_iban, ' ', '')) = v_iban
    ) then
      v_clearing := public.bank_clearing_account_id(p_organization_id);
      if v_clearing is not null then
        update public.bank_transactions
        set status = 'suggested',
            suggested_account_id = v_clearing,
            suggested_vat_code = null,
            match_confidence = 'own_transfer',
            updated_at = now()
        where id = v_txn.id;
        v_suggested := v_suggested + 1;
        continue;
      end if;
    end if;

    -- Factuurherkenning (20261018020000): welke geboekte facturen met iets open
    -- noemt de omschrijving? Eén keer opgezocht, voor een verdeling én voor één
    -- factuur. Een nummer dat binnen een ander genoemd nummer valt ("2026-1" in
    -- "2026-10"), telt niet: de omschrijving noemt dan het langere. Het
    -- nummerfilter gaat vóór de saldoberekening, die dus alleen voor echte
    -- kandidaten draait.
    v_cands := null;
    if v_txn.amount_cents > 0 then
      with hits as (
        select i.id, lower(replace(i.number, ' ', '')) as key
        from public.invoices i
        where i.organization_id = p_organization_id
          and i.number is not null and length(btrim(i.number)) > 0
          and position(lower(replace(i.number, ' ', '')) in v_haystack) > 0
      )
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'open', s.open_cents, 'total', round(coalesce(i.total_amount, 0) * 100), 'date', i.date)
             order by i.date, i.number)
        into v_cands
      from hits h
      join public.invoices i on i.id = h.id
      cross join lateral public.invoice_settlement(p_organization_id, i.id) s
      where not exists (select 1 from hits h2 where length(h2.key) > length(h.key) and position(h.key in h2.key) > 0)
        and i.status not in ('cancelled','void')
        and i.journal_entry_id is not null
        and s.open_cents > 0;
    elsif v_txn.amount_cents < 0 then
      -- Betaling: inkoopfactuur op intern of leveranciersnummer.
      with hits as (
        select pi.id, lower(replace(pi.internal_number, ' ', '')) as key
        from public.purchase_invoices pi
        where pi.organization_id = p_organization_id
          and pi.internal_number is not null and length(btrim(pi.internal_number)) > 0
          and position(lower(replace(pi.internal_number, ' ', '')) in v_haystack) > 0
        union
        select pi.id, lower(replace(pi.supplier_invoice_number, ' ', ''))
        from public.purchase_invoices pi
        where pi.organization_id = p_organization_id
          and pi.supplier_invoice_number is not null and length(btrim(pi.supplier_invoice_number)) > 0
          and position(lower(replace(pi.supplier_invoice_number, ' ', '')) in v_haystack) > 0
      ),
      kept as (
        select distinct h.id from hits h
        where not exists (select 1 from hits h2 where length(h2.key) > length(h.key) and position(h.key in h2.key) > 0)
      )
      select jsonb_agg(jsonb_build_object(
               'id', pi.id, 'open', s.open_cents, 'total', pi.total_cents, 'date', pi.date)
             order by pi.date, pi.id)
        into v_cands
      from kept k
      join public.purchase_invoices pi on pi.id = k.id
      cross join lateral public.purchase_invoice_settlement(p_organization_id, pi.id) s
      where pi.status <> 'cancelled'
        and pi.journal_entry_id is not null
        and s.open_cents > 0;
    end if;
    v_cands := coalesce(v_cands, '[]'::jsonb);

    -- Eén overboeking voor meerdere facturen: noemt de omschrijving er meer dan
    -- één en zijn hun openstaande bedragen samen precies het bedrag, dan een
    -- verdeling. Alleen bij een exacte som: bij minder valt niet te zeggen welke
    -- factuur (deels) betaald is.
    if jsonb_array_length(v_cands) >= 2
       and (select sum((x->>'open')::bigint) from jsonb_array_elements(v_cands) x) = abs(v_txn.amount_cents) then
      update public.bank_transactions
      set status = 'suggested',
          suggested_allocations = (
            select jsonb_agg(jsonb_build_object(
                     case when v_txn.amount_cents > 0 then 'invoice_id' else 'purchase_invoice_id' end, e.x->>'id',
                     'amount_cents', (e.x->>'open')::bigint) order by e.o)
            from jsonb_array_elements(v_cands) with ordinality as e(x, o)),
          matched_invoice_id = null,
          matched_purchase_invoice_id = null,
          match_confidence = case when v_txn.amount_cents > 0 then 'invoices' else 'purchase_invoices' end,
          updated_at = now()
      where id = v_txn.id;
      v_suggested := v_suggested + 1;
      continue;
    end if;

    -- Eén factuur waar dit bedrag nog in past (meer dan het openstaande saldo
    -- weigert book_bank_transaction): het exacte openstaande bedrag eerst, dan het
    -- factuurbedrag, dan de nieuwste.
    select (x->>'id')::uuid into v_match_id
    from jsonb_array_elements(v_cands) x
    where (x->>'open')::bigint >= abs(v_txn.amount_cents)
    order by (case when (x->>'open')::bigint = abs(v_txn.amount_cents) then 0
                   when (x->>'total')::bigint = abs(v_txn.amount_cents) then 1
                   else 2 end),
             x->>'date' desc
    limit 1;
    if v_txn.amount_cents > 0 then v_inv_id := v_match_id; else v_pi_id := v_match_id; end if;

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
-- 7. set_bank_transaction_status
--    (Basis: 20260622000004. Nieuw: "weer openen" vergeet ook het verdeelvoorstel.)
-- ------------------------------------------------------------
create or replace function public.set_bank_transaction_status(
  p_organization_id uuid,
  p_transaction_id uuid,
  p_status text
)
returns public.bank_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
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
    suggested_allocations = case when p_status = 'unmatched' then null else suggested_allocations end,
    updated_at = now()
  where id = v_txn.id
  returning * into v_txn;

  return v_txn;
end;
$$;

-- ------------------------------------------------------------
-- 8. Rechten. Anon hoort geen security-definer-functie te kunnen aanroepen
--    (20260926000000); voor de herdefinieerde functies is dat ongewijzigd en
--    hier expliciet herhaald.
-- ------------------------------------------------------------
revoke all on function public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid, jsonb) to authenticated, service_role;
revoke all on function public.unbook_bank_transaction(uuid, uuid, uuid) from public, anon;
grant execute on function public.unbook_bank_transaction(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.match_bank_transactions(uuid, uuid, uuid) from public, anon;
grant execute on function public.match_bank_transactions(uuid, uuid, uuid) to authenticated, service_role;
revoke all on function public.set_bank_transaction_status(uuid, uuid, text) from public, anon;
grant execute on function public.set_bank_transaction_status(uuid, uuid, text) to authenticated, service_role;
revoke execute on function public.invoice_settlement(uuid, uuid, date) from public, anon;
grant execute on function public.invoice_settlement(uuid, uuid, date) to authenticated, service_role;
revoke execute on function public.purchase_invoice_settlement(uuid, uuid, date) from public, anon;
grant execute on function public.purchase_invoice_settlement(uuid, uuid, date) to authenticated, service_role;
revoke execute on function public.sync_invoice_payment_status(uuid, uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.sync_invoice_payment_status(uuid, uuid, uuid, date) to service_role;

commit;
