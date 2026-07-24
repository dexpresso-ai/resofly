-- ============================================================
-- ResoFly — Boekhouding: verkoopketen automatisch naar het grootboek (factuurstelsel)
-- Date: 2026-07-24
--
-- Context (review-bevinding "omzet-gat"):
-- Verkoopfacturen, klantbetalingen en creditnota's kwamen tot nu toe ALLEEN via
-- een handmatige knop in het grootboek. Een verstuurde/betaalde factuur die
-- niemand handmatig boekte, verscheen nooit in de omzet → W&V structureel te laag.
--
-- Keuze gebruiker (2026-07-24): FACTUURSTELSEL — een verkoopfactuur wordt geboekt
-- zodra hij is verstuurd/definitief (status sent/accepted/paid/overdue). Mollie-
-- betalingen lopen via een TUSSENREKENING (1102), zodat een gebundelde payout later
-- tegen die tussenrekening afgeletterd wordt.
--
-- Aanpak: pad-onafhankelijke DB-triggers i.p.v. losse app-hooks, zodat élke route
-- (versturen per e-mail, Mollie-webhook, portal, handmatig markeren, import) dezelfde
-- boeking krijgt en het niet "vergeten" kan worden. De boeking loopt via de bestaande
-- security-definer RPC's (post_sales_invoice_to_ledger / post_credit_note_to_ledger)
-- en is idempotent (journal_entry_id-guard). Faalt een boeking onverhoopt, dan blijft
-- journal_entry_id NULL en toont de UI een "niet geboekt"-signaal (nooit stil verlies).
--
-- Onderdelen:
--   1. Twee systeemrekeningen: 1102 Kruisposten Mollie/PSP, 4130 Betaalproviderkosten.
--   2. post_sales_invoice_to_ledger krijgt een statusguard (geen concept/geannuleerd).
--   3. ensure_sales_invoice_booked: veilige, idempotente wrapper (skip i.p.v. fout).
--   4. book_invoice_payment: Mollie-betaling → 1102 tegen 1300 (debiteuren).
--   5. book_all_unbooked_sales_invoices: bulk/vangnet ("boek openstaande alsnog").
--   6. Triggers: auto-boeken van factuur (sent), betaling (paid) en creditnota (issued).
--   7. freeze_booked_invoice: een geboekte factuur is inhoudelijk onveranderbaar
--      (corrigeren via creditnota) — houdt grootboek en factuur gelijk.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Rekeningschema uitbreiden: 1102 PSP-kruisposten + 4130 betaalproviderkosten
--    (volledige seed opnieuw, idempotent; basis: 20260723200000 blok C/D).
-- ------------------------------------------------------------
create or replace function public.ensure_default_ledger_accounts(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system)
  values
    (p_organization_id, '0100', 'Vaste activa', 'asset', 'fixed_asset', null, true),
    (p_organization_id, '0150', 'Cumulatieve afschrijving', 'asset', 'accumulated_depreciation', null, true),
    (p_organization_id, '0500', 'Eigen vermogen', 'equity', 'equity', null, true),
    (p_organization_id, '0510', 'Onverdeeld resultaat', 'equity', 'retained_earnings', null, true),
    (p_organization_id, '1100', 'Bank', 'asset', 'bank', null, true),
    (p_organization_id, '1102', 'Kruisposten Mollie/PSP', 'asset', 'psp_clearing', null, true),
    (p_organization_id, '1300', 'Debiteuren', 'asset', 'accounts_receivable', null, true),
    (p_organization_id, '1500', 'Te vorderen BTW (voorbelasting)', 'asset', 'vat_input', null, true),
    (p_organization_id, '1510', 'Af te dragen BTW (verkoop)', 'liability', 'vat_output', null, true),
    (p_organization_id, '1520', 'Af te dragen BTW verlegd/ICP', 'liability', 'vat_reverse', null, true),
    (p_organization_id, '1530', 'Te betalen omzetbelasting', 'liability', 'vat_payable', null, true),
    (p_organization_id, '1600', 'Crediteuren', 'liability', 'accounts_payable', null, true),
    (p_organization_id, '4000', 'Afschrijvingskosten', 'expense', 'depreciation', null, true),
    (p_organization_id, '4130', 'Betaalproviderkosten', 'expense', 'payment_fees', null, false),
    (p_organization_id, '4500', 'Algemene kosten', 'expense', 'general_cost', 'HOOG', false),
    (p_organization_id, '4900', 'Afrondingsverschillen', 'expense', 'rounding', null, true),
    (p_organization_id, '8000', 'Omzet hoog (21%)', 'revenue', 'sales', 'HOOG', false),
    (p_organization_id, '8010', 'Omzet laag (9%)', 'revenue', 'sales', 'LAAG', false),
    (p_organization_id, '8020', 'Omzet 0% / vrijgesteld', 'revenue', 'sales', 'NUL', false),
    (p_organization_id, '8030', 'Omzet buitenland (ICP/verlegd)', 'revenue', 'sales', 'ICP_DIENST', false)
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
end;
$$;

-- Bestaande organisaties meteen de nieuwe rekeningen geven.
insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system)
select distinct la.organization_id, '1102', 'Kruisposten Mollie/PSP', 'asset', 'psp_clearing', null, true
from public.ledger_accounts la
on conflict (organization_id, code) do nothing;

insert into public.ledger_accounts (organization_id, code, name, type, subtype, default_vat_code, is_system)
select distinct la.organization_id, '4130', 'Betaalproviderkosten', 'expense', 'payment_fees', null, false
from public.ledger_accounts la
on conflict (organization_id, code) do nothing;

-- ------------------------------------------------------------
-- 2. Betaalregistratie koppelen aan zijn journaalpost (idempotentie-anker).
-- ------------------------------------------------------------
alter table public.invoice_payment_records
  add column if not exists journal_entry_id uuid references public.journal_entries(id) on delete set null;

-- ------------------------------------------------------------
-- 3. post_sales_invoice_to_ledger: statusguard toevoegen.
--    (Verder identiek aan 20260723200000 blok C/D: vat_code→8030-routing,
--    per-groep afronding, boekdatum-verschuiving bij nagekomen documenten.)
--    Een concept of geannuleerde factuur mag nooit omzet boeken — de UI dekte
--    dit al af, maar een directe RPC-aanroep kon het omzeilen (defense in depth).
-- ------------------------------------------------------------
create or replace function public.post_sales_invoice_to_ledger(
  p_organization_id uuid,
  p_invoice_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
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
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
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
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, v_revenue_account),
        'description', 'Omzet',
        'debit_cents', 0, 'credit_cents', r.base_cents,
        'vat_code', r.vat_code,
        'vat_rate', r.rate, 'vat_base_cents', r.base_cents, 'vat_amount_cents', v_vat,
        'client_id', v_inv.client_id, 'project_id', v_inv.project_id
      ));
      v_output_vat := v_output_vat + v_vat;
      v_receivable := v_receivable + r.base_cents + v_vat;
    end;
  end loop;

  if v_output_vat > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1510'),
      'description', 'Af te dragen BTW',
      'debit_cents', 0, 'credit_cents', v_output_vat,
      'client_id', v_inv.client_id
    ));
  end if;

  v_lines := jsonb_build_array(jsonb_build_object(
    'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
    'description', 'Debiteuren',
    'debit_cents', v_receivable, 'credit_cents', 0,
    'client_id', v_inv.client_id
  )) || v_lines;

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
$$;

-- ------------------------------------------------------------
-- 4. ensure_sales_invoice_booked: veilige idempotente wrapper.
--    Geeft de bestaande/nieuwe journal_entry_id terug, of NULL als er (bewust)
--    niet geboekt hoeft te worden (concept, geannuleerd, of vóór de startdatum).
--    Faalt NOOIT op die "skip"-condities — geschikt om vanuit een trigger of
--    een bulk-run aan te roepen.
-- ------------------------------------------------------------
create or replace function public.ensure_sales_invoice_booked(
  p_organization_id uuid,
  p_invoice_id uuid,
  p_created_by uuid default auth.uid()
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invoices;
  v_start date;
  v_entry public.journal_entries;
begin
  select * into v_inv from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id;
  if not found then
    return null;
  end if;
  if v_inv.journal_entry_id is not null then
    return v_inv.journal_entry_id;                 -- al geboekt
  end if;
  if v_inv.status in ('draft', 'cancelled') then
    return null;                                   -- (nog) geen uitgegeven factuur
  end if;

  select bookkeeping_start_date into v_start
  from public.company_settings where organization_id = p_organization_id;
  if v_start is not null and v_inv.date < v_start then
    return null;                                   -- zit al in de beginbalans
  end if;

  v_entry := public.post_sales_invoice_to_ledger(p_organization_id, p_invoice_id, p_created_by);
  return v_entry.id;
end;
$$;

-- ------------------------------------------------------------
-- 5. book_invoice_payment: Mollie-betaling → tussenrekening 1102 tegen 1300.
--    De klant betaalt bij de PSP (het geld is onderweg); de latere bank-payout
--    letter je af tegen 1102. Idempotent per betaalregistratie (journal_entry_id).
--    Boekt eerst de factuur zelf als die nog niet in het grootboek staat, zodat
--    er altijd een debiteurenpost is om af te boeken.
-- ------------------------------------------------------------
create or replace function public.book_invoice_payment(
  p_organization_id uuid,
  p_payment_record_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay public.invoice_payment_records;
  v_inv_je uuid;
  v_book_date date;
  v_lines jsonb;
  v_entry public.journal_entries;
begin
  select * into v_pay from public.invoice_payment_records
  where id = p_payment_record_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Betaalregistratie niet gevonden.' using errcode = '02000';
  end if;
  if v_pay.journal_entry_id is not null then
    return null;                                   -- al geboekt (idempotent)
  end if;
  if v_pay.status <> 'paid' or coalesce(v_pay.amount_cents, 0) <= 0 then
    return null;                                   -- niets te boeken
  end if;

  -- Zorg dat de bijbehorende factuur (en dus 1300) in het grootboek staat.
  v_inv_je := public.ensure_sales_invoice_booked(p_organization_id, v_pay.invoice_id, p_created_by);
  if v_inv_je is null then
    -- Factuur (nog) niet boekbaar (concept/vóór startdatum): geen debiteurenpost
    -- om tegen af te boeken. Laat de betaling ongeboekt; de UI signaleert dit.
    return null;
  end if;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  v_book_date := public.first_open_booking_date(
    p_organization_id, coalesce(v_pay.paid_at::date, current_date));

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1102'),
      'description', 'Ontvangst via Mollie (onderweg)',
      'debit_cents', v_pay.amount_cents, 'credit_cents', 0),
    jsonb_build_object(
      'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
      'description', 'Debiteuren afboeken (betaling)',
      'debit_cents', 0, 'credit_cents', v_pay.amount_cents)
  );

  v_entry := public.post_journal_entry(
    p_organization_id, v_book_date,
    'Betaling factuur (Mollie)', 'payment', v_pay.invoice_id, v_lines, p_created_by);

  update public.invoice_payment_records set journal_entry_id = v_entry.id where id = v_pay.id;
  return v_entry;
end;
$$;

-- ------------------------------------------------------------
-- 6. book_all_unbooked_sales_invoices: vangnet/bulk. Boekt alle uitgegeven
--    facturen die nog geen journaalpost hebben. Geeft het aantal terug.
-- ------------------------------------------------------------
create or replace function public.book_all_unbooked_sales_invoices(
  p_organization_id uuid,
  p_created_by uuid default auth.uid()
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  r record;
  v_je uuid;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
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
$$;

-- ------------------------------------------------------------
-- 7a. Trigger: verkoopfactuur automatisch boeken zodra hij uitgegeven is.
--     Faalt de boeking (zeldzaam), dan blijft journal_entry_id NULL en toont de
--     UI "niet geboekt" — de verzending/betaling zelf wordt nooit geblokkeerd.
-- ------------------------------------------------------------
create or replace function public.trg_autobook_sales_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.journal_entry_id is null
     and new.status in ('sent', 'accepted', 'paid', 'overdue') then
    begin
      perform public.ensure_sales_invoice_booked(new.organization_id, new.id, new.created_by);
    exception when others then
      raise warning 'Automatisch boeken van factuur % mislukt: %', new.id, sqlerrm;
    end;
  end if;
  return null;   -- AFTER-trigger
end;
$$;

drop trigger if exists invoices_autobook on public.invoices;
create trigger invoices_autobook
  after insert or update of status on public.invoices
  for each row execute function public.trg_autobook_sales_invoice();

-- ------------------------------------------------------------
-- 7b. Trigger: Mollie-betaling automatisch doorboeken naar 1102 tegen 1300.
-- ------------------------------------------------------------
create or replace function public.trg_autobook_invoice_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- book_invoice_payment is idempotent (skipt zodra journal_entry_id gevuld is),
  -- dus een herhaalde 'paid'-update boekt niet dubbel — geen OLD-vergelijking nodig.
  if new.status = 'paid' and new.journal_entry_id is null then
    begin
      perform public.book_invoice_payment(new.organization_id, new.id, new.created_by);
    exception when others then
      raise warning 'Automatisch boeken van betaling % mislukt: %', new.id, sqlerrm;
    end;
  end if;
  return null;
end;
$$;

drop trigger if exists invoice_payment_records_autobook on public.invoice_payment_records;
create trigger invoice_payment_records_autobook
  after insert or update of status on public.invoice_payment_records
  for each row execute function public.trg_autobook_invoice_payment();

-- ------------------------------------------------------------
-- 7c. Trigger: creditnota automatisch tegenboeken zodra hij is uitgegeven.
-- ------------------------------------------------------------
create or replace function public.trg_autobook_credit_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'issued' and new.journal_entry_id is null then
    begin
      perform public.post_credit_note_to_ledger(new.organization_id, new.id, new.issued_by);
    exception when others then
      raise warning 'Automatisch boeken van creditnota % mislukt: %', new.id, sqlerrm;
    end;
  end if;
  return null;
end;
$$;

drop trigger if exists credit_notes_autobook on public.credit_notes;
create trigger credit_notes_autobook
  after insert or update of status on public.credit_notes
  for each row execute function public.trg_autobook_credit_note();

-- ------------------------------------------------------------
-- 8. freeze_booked_invoice: een geboekte factuur is inhoudelijk onveranderbaar.
--    Zodra er een journaalpost aan hangt, mogen bedragen/datum/nummer/klant niet
--    meer wijzigen (corrigeren = creditnota). Status, betaal-/lock-velden en de
--    koppeling zelf blijven muteerbaar, zodat de levenscyclus gewoon doorloopt.
-- ------------------------------------------------------------
create or replace function public.trg_freeze_booked_invoice()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.journal_entry_id is not null then
    if new.lines is distinct from old.lines
       or new.date is distinct from old.date
       or new.number is distinct from old.number
       or new.client_id is distinct from old.client_id then
      raise exception 'Deze factuur is al naar het grootboek geboekt en is onveranderbaar. Maak een creditnota om te corrigeren.'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_freeze_booked on public.invoices;
create trigger invoices_freeze_booked
  before update on public.invoices
  for each row execute function public.trg_freeze_booked_invoice();

commit;
