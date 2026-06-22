-- ============================================================
-- ResoFly — Boekhouding fase 5: bankfeed + automatisch journaliseren (fase 1)
-- Date: 2026-06-22
--
-- Context:
-- Verkoopfacturen boeken naar Debiteuren (1300), inkoopfacturen naar Crediteuren
-- (1600), maar bij betaling werd de Bank (1100) nooit geraakt — de open posten
-- bleven dus eeuwig openstaan. Deze migratie legt de bankzijde: ingelezen/gekoppelde
-- banktransacties, een aflettering/match-laag en een journaliseer-engine die de
-- transactie omzet in een sluitende journaalpost. Omdat report_profit_and_loss en
-- report_balance_sheet rechtstreeks uit geboekte journaalposten aggregeren, werken
-- W&V, balans en rekeningschema automatisch bij zodra een transactie geboekt is.
--
-- Kernbeslissingen:
--  1. Eén datamodel voor beide ingestiewegen (afschrift-import én PSD2-koppeling).
--     bank_accounts.source onderscheidt 'import' van 'gocardless'; de match- en
--     boekingslaag is identiek. De koppeling (edge function) komt in fase 2.
--  2. Idempotentie: bank_transactions heeft unique(bank_account_id, dedup_key).
--     Her-importeren van hetzelfde afschrift of opnieuw syncen voegt niets dubbel
--     toe (ON CONFLICT DO NOTHING).
--  3. Boeken via security definer RPC's, net als de rest van het grootboek. Geboekte
--     transacties zijn onveranderbaar; corrigeren gaat via unbook_bank_transaction
--     (tegenboeking + transactie terug op 'unmatched'). bank_transactions en
--     bank_statements hebben dus geen schrijf-policy.
--  4. Afletteren tegen een verkoop-/inkoopfactuur verplaatst alleen de grootboek-
--     stand (Debiteuren/Crediteuren -> Bank). De betaalstatus van de factuur zelf
--     en de Mollie-betaalstroom blijven in fase 1 ongemoeid, om dubbeltellen te
--     voorkomen; matched_invoice_id legt wel de koppeling vast voor traceability.
--
-- Bedragen in hele centen (bigint). amount_cents is SIGNED: positief = ontvangen,
-- negatief = betaald.
-- ============================================================

create extension if not exists pgcrypto;

begin;

-- ------------------------------------------------------------
-- 1. Bankrekeningen (gekoppeld aan een grootboekrekening)
-- ------------------------------------------------------------
create table if not exists public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  name text not null,
  iban text,
  currency text not null default 'EUR',
  -- De grootboekrekening (meestal 1100 Bank) waarop deze rekening boekt. Meerdere
  -- bankrekeningen kunnen elk een eigen GL-rekening krijgen (1100/1101/...).
  ledger_account_id uuid not null references public.ledger_accounts(id) on delete restrict,
  source text not null default 'import',
  -- Velden voor de PSD2-koppeling (fase 2); leeg bij pure afschrift-import.
  provider text,
  external_account_id text,
  last_synced_at timestamptz,
  last_imported_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_accounts_name_not_blank check (length(btrim(name)) > 0),
  constraint bank_accounts_source_check check (source in ('import','gocardless'))
);
create index if not exists idx_bank_accounts_org on public.bank_accounts(organization_id, name);

-- ------------------------------------------------------------
-- 2. Bankafschriften (per geïmporteerd bestand of sync-batch)
-- ------------------------------------------------------------
create table if not exists public.bank_statements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  format text not null default 'csv',
  file_name text,
  file_hash text,
  period_start date,
  period_end date,
  opening_balance_cents bigint,
  closing_balance_cents bigint,
  transaction_count integer not null default 0,
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint bank_statements_format_check check (format in ('camt053','mt940','csv','gocardless'))
);
create index if not exists idx_bank_statements_account on public.bank_statements(bank_account_id, imported_at desc);

-- ------------------------------------------------------------
-- 3. Banktransacties (de regels)
-- ------------------------------------------------------------
create table if not exists public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  statement_id uuid references public.bank_statements(id) on delete set null,
  -- Stabiele sleutel voor idempotente (her)import/sync. Voorkeur: het unieke id van
  -- de bank (CAMT AcctSvcrRef / MT940-ref / GoCardless transactionId); anders een
  -- hash van datum+bedrag+tegenpartij+kenmerk+volgnummer, berekend door de client.
  dedup_key text not null,
  booking_date date not null,
  value_date date,
  amount_cents bigint not null,
  currency text not null default 'EUR',
  counterparty_name text,
  counterparty_iban text,
  description text,
  structured_reference text,
  end_to_end_id text,
  bank_tx_id text,
  status text not null default 'unmatched',
  -- Voorstel uit een regel of leverancier-IBAN-match (vóór boeken).
  suggested_account_id uuid references public.ledger_accounts(id) on delete set null,
  suggested_vat_code text,
  matched_rule_id uuid,
  match_confidence text,
  -- Afgeletterde factuur (verkoop of inkoop).
  matched_invoice_id uuid references public.invoices(id) on delete set null,
  matched_purchase_invoice_id uuid references public.purchase_invoices(id) on delete set null,
  -- Resultaat van het boeken.
  journal_entry_id uuid references public.journal_entries(id) on delete set null,
  booked_at timestamptz,
  booked_by uuid references auth.users(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_transactions_status_check check (status in ('unmatched','suggested','booked','ignored')),
  constraint bank_transactions_dedup_unique unique (bank_account_id, dedup_key)
);
create index if not exists idx_bank_transactions_account on public.bank_transactions(bank_account_id, booking_date desc);
create index if not exists idx_bank_transactions_status on public.bank_transactions(organization_id, status);

-- ------------------------------------------------------------
-- 4. Automatisch-boeken-regels
-- ------------------------------------------------------------
create table if not exists public.bank_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  name text not null,
  priority integer not null default 100,
  match_direction text not null default 'both',
  match_counterparty_iban text,
  match_counterparty_name_contains text,
  match_description_contains text,
  match_amount_cents bigint,
  target_account_id uuid references public.ledger_accounts(id) on delete set null,
  target_vat_code text,
  set_supplier_id uuid references public.suppliers(id) on delete set null,
  set_client_id uuid references public.clients(id) on delete set null,
  auto_book boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_rules_name_not_blank check (length(btrim(name)) > 0),
  constraint bank_rules_direction_check check (match_direction in ('in','out','both'))
);
create index if not exists idx_bank_rules_org on public.bank_rules(organization_id, priority);

-- bank_transactions.matched_rule_id verwijst naar bank_rules (na creatie van beide).
alter table public.bank_transactions drop constraint if exists bank_transactions_rule_fk;
alter table public.bank_transactions
  add constraint bank_transactions_rule_fk
  foreign key (matched_rule_id) references public.bank_rules(id) on delete set null;

-- ------------------------------------------------------------
-- 5. Triggers (updated_at, org-lock, audit)
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['bank_accounts','bank_transactions','bank_rules']
  loop
    execute format('drop trigger if exists %1$s_touch_updated_at on public.%1$s', t);
    execute format('create trigger %1$s_touch_updated_at before update on public.%1$s for each row execute function public.bookkeeping_touch_updated_at()', t);
    execute format('drop trigger if exists %1$s_prevent_org_change on public.%1$s', t);
    execute format('create trigger %1$s_prevent_org_change before update of organization_id on public.%1$s for each row execute function public.prevent_organization_id_change()', t);
  end loop;
end $$;

drop trigger if exists bank_accounts_audit on public.bank_accounts;
create trigger bank_accounts_audit after insert or update or delete on public.bank_accounts
  for each row execute function public.audit_row_change('bank_account', 'name');
drop trigger if exists bank_rules_audit on public.bank_rules;
create trigger bank_rules_audit after insert or update or delete on public.bank_rules
  for each row execute function public.audit_row_change('bank_rule', 'name');

-- Financiële veiligheid: een bankrekening met geboekte transacties mag niet zomaar
-- weg. De journaalposten zijn onveranderbaar en blijven bestaan; zou je de rekening
-- (en daarmee via cascade haar transacties) verwijderen, dan kun je hetzelfde
-- afschrift later opnieuw inlezen én opnieuw boeken => dubbele boeking. Eerst
-- terugdraaien dus.
create or replace function public.bank_account_block_delete_with_bookings()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.bank_transactions where bank_account_id = old.id and status = 'booked') then
    raise exception 'Deze bankrekening heeft geboekte transacties. Draai die eerst terug voordat je de rekening verwijdert.'
      using errcode = '23514';
  end if;
  return old;
end; $$;
drop trigger if exists bank_accounts_block_delete on public.bank_accounts;
create trigger bank_accounts_block_delete before delete on public.bank_accounts
  for each row execute function public.bank_account_block_delete_with_bookings();

-- ------------------------------------------------------------
-- 6. Row level security
-- Stamdata (bankrekeningen, regels): volledige CRUD voor can_write_org.
-- bank_transactions + bank_statements: alleen lezen; alle mutaties via de
-- security definer RPC's hieronder, zodat geboekte transacties onveranderbaar zijn.
-- ------------------------------------------------------------
alter table public.bank_accounts enable row level security;
alter table public.bank_statements enable row level security;
alter table public.bank_transactions enable row level security;
alter table public.bank_rules enable row level security;

do $$
declare t text;
begin
  foreach t in array array['bank_statements','bank_transactions']
  loop
    execute format('drop policy if exists "%1$s read" on public.%1$s', t);
    execute format('create policy "%1$s read" on public.%1$s for select using (public.can_read_org(organization_id))', t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['bank_accounts','bank_rules']
  loop
    execute format('drop policy if exists "%1$s read" on public.%1$s', t);
    execute format('create policy "%1$s read" on public.%1$s for select using (public.can_read_org(organization_id))', t);
    execute format('drop policy if exists "%1$s insert" on public.%1$s', t);
    execute format('create policy "%1$s insert" on public.%1$s for insert with check (public.can_write_org(organization_id) and created_by = auth.uid())', t);
    execute format('drop policy if exists "%1$s update" on public.%1$s', t);
    execute format('create policy "%1$s update" on public.%1$s for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id))', t);
    execute format('drop policy if exists "%1$s delete" on public.%1$s', t);
    execute format('create policy "%1$s delete" on public.%1$s for delete using (public.can_write_org(organization_id))', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 7. Import: banktransacties idempotent inlezen + direct matchen
-- p_transactions: array van { dedup_key, booking_date, value_date, amount_cents,
--   currency, counterparty_name, counterparty_iban, description, structured_reference,
--   end_to_end_id, bank_tx_id }
-- p_statement (optioneel): { format, file_name, file_hash, period_start, period_end,
--   opening_balance_cents, closing_balance_cents }
-- ------------------------------------------------------------
create or replace function public.import_bank_transactions(
  p_organization_id uuid,
  p_bank_account_id uuid,
  p_statement jsonb,
  p_transactions jsonb,
  p_created_by uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ba public.bank_accounts;
  v_stmt_id uuid;
  v_inserted integer := 0;
  v_total integer := 0;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
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

  if p_statement is not null and jsonb_typeof(p_statement) = 'object' then
    insert into public.bank_statements(
      organization_id, created_by, bank_account_id, format, file_name, file_hash,
      period_start, period_end, opening_balance_cents, closing_balance_cents, transaction_count
    ) values (
      p_organization_id, p_created_by, p_bank_account_id,
      coalesce(nullif(p_statement->>'format',''), 'csv'),
      nullif(p_statement->>'file_name',''),
      nullif(p_statement->>'file_hash',''),
      nullif(p_statement->>'period_start','')::date,
      nullif(p_statement->>'period_end','')::date,
      nullif(p_statement->>'opening_balance_cents','')::bigint,
      nullif(p_statement->>'closing_balance_cents','')::bigint,
      v_total
    ) returning id into v_stmt_id;
  end if;

  with src as (
    select
      nullif(l->>'dedup_key','') as dedup_key,
      nullif(l->>'booking_date','')::date as booking_date,
      nullif(l->>'value_date','')::date as value_date,
      coalesce((l->>'amount_cents')::bigint, 0) as amount_cents,
      coalesce(nullif(l->>'currency',''), v_ba.currency) as currency,
      nullif(l->>'counterparty_name','') as counterparty_name,
      nullif(l->>'counterparty_iban','') as counterparty_iban,
      nullif(l->>'description','') as description,
      nullif(l->>'structured_reference','') as structured_reference,
      nullif(l->>'end_to_end_id','') as end_to_end_id,
      nullif(l->>'bank_tx_id','') as bank_tx_id
    from jsonb_array_elements(p_transactions) l
  ),
  ins as (
    insert into public.bank_transactions(
      organization_id, bank_account_id, statement_id, dedup_key, booking_date, value_date,
      amount_cents, currency, counterparty_name, counterparty_iban, description,
      structured_reference, end_to_end_id, bank_tx_id, status
    )
    select
      p_organization_id, p_bank_account_id, v_stmt_id, src.dedup_key, src.booking_date, src.value_date,
      src.amount_cents, src.currency, src.counterparty_name, src.counterparty_iban, src.description,
      src.structured_reference, src.end_to_end_id, src.bank_tx_id, 'unmatched'
    from src
    where src.dedup_key is not null and src.booking_date is not null
    on conflict (bank_account_id, dedup_key) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  update public.bank_accounts set last_imported_at = now() where id = p_bank_account_id;

  -- Stel matches/voorstellen voor en boek auto-regels.
  perform public.match_bank_transactions(p_organization_id, p_bank_account_id, p_created_by);

  return jsonb_build_object(
    'inserted', v_inserted,
    'skipped', v_total - v_inserted,
    'statement_id', v_stmt_id
  );
end;
$$;

-- ------------------------------------------------------------
-- 8. Matchen: voorstel per open transactie (factuur, leverancier-IBAN of regel)
--    en automatisch boeken bij een auto_book-regel.
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

    if v_txn.amount_cents > 0 then
      -- Ontvangst: zoek verkoopfactuur op factuurnummer in omschrijving/kenmerk.
      select i.id into v_inv_id
      from public.invoices i
      where i.organization_id = p_organization_id
        and i.status not in ('cancelled','void')
        and i.number is not null and length(btrim(i.number)) > 0
        and position(lower(replace(i.number,' ','')) in v_haystack) > 0
      order by (case when round(coalesce(i.total_amount,0) * 100) = abs(v_txn.amount_cents) then 0 else 1 end), i.date desc
      limit 1;
    elsif v_txn.amount_cents < 0 then
      -- Betaling: zoek inkoopfactuur op intern/leveranciers-nummer.
      select pi.id into v_pi_id
      from public.purchase_invoices pi
      where pi.organization_id = p_organization_id
        and pi.status <> 'cancelled'
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
      and (r.match_counterparty_iban is null or upper(replace(r.match_counterparty_iban,' ','')) = upper(replace(coalesce(v_txn.counterparty_iban,''),' ','')))
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

    -- Geen regel: bij een betaling de leverancier op IBAN voorstellen.
    if v_txn.amount_cents < 0 and v_txn.counterparty_iban is not null then
      select * into v_sup from public.suppliers s
      where s.organization_id = p_organization_id
        and s.iban is not null
        and upper(replace(s.iban,' ','')) = upper(replace(v_txn.counterparty_iban,' ',''))
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
-- 9. Boeken: banktransactie -> sluitende journaalpost
--    Tegenzijde: een afgeletterde factuur (Debiteuren/Crediteuren) OF vrije regels
--    (p_lines: array van { account_id|account_code, amount_cents (bruto), vat_code }).
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

  return v_entry;
end;
$$;

-- ------------------------------------------------------------
-- 10. Tegenboeken: geboekte transactie terugdraaien en weer open zetten
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

  perform public.reverse_journal_entry(v_txn.journal_entry_id, null, p_created_by);

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

  return v_txn;
end;
$$;

-- ------------------------------------------------------------
-- 11. Status zetten (negeren / weer openen). Niet voor geboekte transacties.
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
    updated_at = now()
  where id = v_txn.id
  returning * into v_txn;

  return v_txn;
end;
$$;

commit;
