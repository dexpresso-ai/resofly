-- ============================================================
-- ResoFly — Bank: mutaties met de hand boeken
-- Date: 2026-11-07
--
-- Wat er tot nu toe niet kon, en nu wel:
--
--   1. Zelf een mutatie invoeren. Een banktransactie kwam alleen binnen via een
--      afschrift (CAMT.053, MT940, CSV) of de bankkoppeling (PSD2). Wie contant
--      geld stortte, een rekening zonder export had, of niet wilde wachten op de
--      bank, kon niets. Nu: create_manual_bank_transaction (en bewerken en
--      verwijderen zolang er niets geboekt is).
--   2. Eén transactie over meerdere grootboekrekeningen verdelen. De database
--      kon het half (p_lines), het scherm stuurde altijd één regel.
--   3. Eén betaling tegen meerdere facturen (verzamelbetaling, Mollie-
--      uitbetaling). Eén transactie hoorde bij precies één factuur.
--   4. Een terugbetaling koppelen aan een creditnota. Een betaling kon alleen
--      tegen een inkoopfactuur; een handmatige terugbetaling aan een klant kwam
--      nergens in de boeken ("loopt via de bank en boek je daar",
--      recompute_invoice_refund_state), terwijl de bank er geen weg voor had.
--   5. Een eigen omschrijving van de boeking.
--
-- Daarvoor:
--
--   * bank_transaction_allocations: per boeking de verdeling (factuur,
--     creditnota, inkoopfactuur of grootboekrekening, met het bedrag). Alles
--     wat uitrekent wat er op een factuur openstaat, telt voortaan uit deze
--     verdeling en niet meer uit matched_invoice_id: met één kolom kon één
--     betaling maar één factuur raken, en de oude som telde álle debiteuren-
--     regels van de boeking bij die ene factuur op. De verdeling ligt vast;
--     terugdraaien maakt een tegenboeking en dan telt de verdeling van die
--     boeking niet meer mee (net als in het grootboek).
--   * Handmatige mutaties naast de bankkoppeling. Komt dezelfde mutatie later
--     van de bank (afschrift of koppeling), dan voegt de matcher die samen met
--     de handmatige: de bankregel gaat op 'merged' en verwijst naar de
--     handmatige, die de boeking draagt. Zonder dat stond hetzelfde geld er
--     twee keer, of boekte een automatische bankregel het nog eens. Alleen bij
--     één duidelijke kandidaat (zelfde rekening en bedrag, binnen 7 dagen, geen
--     ander IBAN); anders kiest de gebruiker. Losmaken kan altijd, en daarna
--     voegt de matcher die bankregel niet meer vanzelf samen.
--   * De saldo-aansluiting telt een samengevoegd paar één keer en meldt
--     handmatige boekingen die (nog) niet op het afschrift staan.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. Banktransacties: handmatig en samengevoegd ───────────────────────────

alter table public.bank_transactions add column if not exists is_manual boolean not null default false;
alter table public.bank_transactions add column if not exists created_by uuid references auth.users(id) on delete set null;
-- De bankregel die een handmatige mutatie bevestigt, verwijst naar die mutatie.
-- Bewust zonder ON DELETE-actie: een handmatige mutatie met een bankregel eraan
-- verwijder je niet (de functie zegt waarom); samen weg met de bankrekening mag.
alter table public.bank_transactions add column if not exists merged_into_id uuid references public.bank_transactions(id);
alter table public.bank_transactions add column if not exists merged_at timestamptz;
alter table public.bank_transactions add column if not exists merged_by uuid references auth.users(id) on delete set null;
-- Na "losmaken" voegt de matcher deze bankregel niet meer vanzelf samen: anders
-- deed de volgende import het meteen weer.
alter table public.bank_transactions add column if not exists auto_merge_blocked boolean not null default false;

alter table public.bank_transactions drop constraint if exists bank_transactions_status_check;
alter table public.bank_transactions add constraint bank_transactions_status_check
  check (status in ('unmatched', 'suggested', 'booked', 'ignored', 'merged'));

alter table public.bank_transactions drop constraint if exists bank_transactions_merge_consistent;
alter table public.bank_transactions add constraint bank_transactions_merge_consistent
  check ((status = 'merged') = (merged_into_id is not null) and not (is_manual and merged_into_id is not null));

create unique index if not exists uidx_bank_transactions_merged_into
  on public.bank_transactions(merged_into_id) where merged_into_id is not null;
create index if not exists idx_bank_transactions_manual
  on public.bank_transactions(bank_account_id, amount_cents) where is_manual;

-- Wie een mutatie invoerde, samenvoegde of boekte, is wie er ingelogd was
-- (zoals 20261101150000 voor de andere financiële tabellen).
drop trigger if exists bank_transactions_stamp_actor on public.bank_transactions;
create trigger bank_transactions_stamp_actor
  before insert or update of created_by, booked_by, merged_by on public.bank_transactions
  for each row execute function public.stamp_actor_columns('created_by', 'booked_by', 'merged_by');

-- Samenvoegen alleen met een handmatige mutatie van dezelfde rekening en
-- hetzelfde bedrag, en zo'n paar verandert niet stil van bedrag of rekening.
-- De functies controleren het ook; dit is de grens als iemand ze omzeilt.
create or replace function public.bank_transactions_merge_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_target public.bank_transactions;
begin
  if new.merged_into_id is not null then
    if new.is_manual then
      raise exception 'Een handmatige mutatie kan niet in een andere worden samengevoegd.' using errcode = '23514';
    end if;
    select * into v_target from public.bank_transactions where id = new.merged_into_id;
    if not found
       or not v_target.is_manual
       or v_target.organization_id <> new.organization_id
       or v_target.bank_account_id <> new.bank_account_id
       or v_target.amount_cents <> new.amount_cents
       or v_target.merged_into_id is not null then
      raise exception 'Samenvoegen kan alleen met een handmatige mutatie van dezelfde rekening en met hetzelfde bedrag.'
        using errcode = '23514';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.is_manual
     and (new.amount_cents <> old.amount_cents or new.bank_account_id <> old.bank_account_id)
     and exists (select 1 from public.bank_transactions b where b.merged_into_id = new.id) then
    raise exception 'Deze mutatie is bevestigd door de bank; bedrag en rekening liggen daarmee vast. Maak het samenvoegen eerst los.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists bank_transactions_merge_guard on public.bank_transactions;
create trigger bank_transactions_merge_guard
  before insert or update of merged_into_id, amount_cents, bank_account_id on public.bank_transactions
  for each row execute function public.bank_transactions_merge_guard();

-- ── 2. De verdeling van een bankboeking ─────────────────────────────────────
-- amount_cents in BANKRICHTING: positief = geld erbij, negatief = geld eraf.
-- De som over een boeking is het bedrag van de transactie.
--   sales_invoice      > 0  ontvangst op een verkoopfactuur (credit 1300)
--   sales_credit_note  < 0  terugbetaling van een creditnota (debet 1300);
--                           invoice_id is de factuur van die creditnota
--   purchase_invoice        betaling (< 0, debet 1600) of, bij een creditnota
--                           van de leverancier, terugontvangst (> 0, credit 1600)
--   ledger                  rechtstreeks op een grootboekrekening, met btw-code
create table if not exists public.bank_transaction_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bank_transaction_id uuid not null references public.bank_transactions(id) on delete cascade,
  journal_entry_id uuid not null references public.journal_entries(id),
  position integer not null default 0,
  kind text not null,
  invoice_id uuid references public.invoices(id),
  credit_note_id uuid references public.credit_notes(id),
  purchase_invoice_id uuid references public.purchase_invoices(id),
  account_id uuid references public.ledger_accounts(id),
  vat_code text,
  client_id uuid references public.clients(id) on delete set null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  amount_cents bigint not null,
  description text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint bank_allocations_kind_check check (kind in ('sales_invoice', 'sales_credit_note', 'purchase_invoice', 'ledger')),
  constraint bank_allocations_amount_nonzero check (amount_cents <> 0),
  constraint bank_allocations_target check (
    (kind = 'sales_invoice' and invoice_id is not null and credit_note_id is null and purchase_invoice_id is null and account_id is null and amount_cents > 0)
    or (kind = 'sales_credit_note' and credit_note_id is not null and invoice_id is not null and purchase_invoice_id is null and account_id is null and amount_cents < 0)
    or (kind = 'purchase_invoice' and purchase_invoice_id is not null and invoice_id is null and credit_note_id is null and account_id is null)
    or (kind = 'ledger' and account_id is not null and invoice_id is null and credit_note_id is null and purchase_invoice_id is null)
  )
);

create index if not exists idx_bank_alloc_transaction on public.bank_transaction_allocations(bank_transaction_id);
create index if not exists idx_bank_alloc_entry on public.bank_transaction_allocations(journal_entry_id);
create index if not exists idx_bank_alloc_invoice on public.bank_transaction_allocations(organization_id, invoice_id) where invoice_id is not null;
create index if not exists idx_bank_alloc_credit_note on public.bank_transaction_allocations(organization_id, credit_note_id) where credit_note_id is not null;
create index if not exists idx_bank_alloc_purchase on public.bank_transaction_allocations(organization_id, purchase_invoice_id) where purchase_invoice_id is not null;

alter table public.bank_transaction_allocations enable row level security;
drop policy if exists "bank_transaction_allocations read" on public.bank_transaction_allocations;
create policy "bank_transaction_allocations read" on public.bank_transaction_allocations
  for select using (public.can_read_org(organization_id));
do $$ begin perform public.apply_module_gate('bank_transaction_allocations', 'finance'); end $$;
-- Alleen de boekfunctie schrijft hier; geen policy, en ook geen tabelrecht.
revoke insert, update, delete, truncate on public.bank_transaction_allocations from anon, authenticated;
revoke all on public.bank_transaction_allocations from anon;

drop trigger if exists bank_transaction_allocations_stamp_actor on public.bank_transaction_allocations;
create trigger bank_transaction_allocations_stamp_actor
  before insert on public.bank_transaction_allocations
  for each row execute function public.stamp_actor_columns('created_by');

create or replace function public.bank_transaction_allocations_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'De verdeling van een bankboeking ligt vast. Draai de boeking terug en boek opnieuw.' using errcode = '23514';
end;
$$;

drop trigger if exists bank_transaction_allocations_immutable on public.bank_transaction_allocations;
create trigger bank_transaction_allocations_immutable
  before update on public.bank_transaction_allocations
  for each row execute function public.bank_transaction_allocations_immutable();

-- Bestaande boekingen: de factuur waartegen ze afgeletterd zijn, als verdeling.
-- Vrije boekingen (op een grootboekrekening) krijgen geen verdeling: niets
-- rekent daarmee, en het scherm toont hun journaalregels.
insert into public.bank_transaction_allocations(
  organization_id, bank_transaction_id, journal_entry_id, position, kind, invoice_id, client_id, amount_cents, created_by, created_at
)
select bt.organization_id, bt.id, bt.journal_entry_id, 0, 'sales_invoice', bt.matched_invoice_id, i.client_id,
       bt.amount_cents, bt.booked_by, coalesce(bt.booked_at, now())
from public.bank_transactions bt
join public.invoices i on i.id = bt.matched_invoice_id and i.organization_id = bt.organization_id
where bt.status = 'booked' and bt.journal_entry_id is not null and bt.amount_cents > 0
  and not exists (select 1 from public.bank_transaction_allocations a where a.bank_transaction_id = bt.id);

insert into public.bank_transaction_allocations(
  organization_id, bank_transaction_id, journal_entry_id, position, kind, purchase_invoice_id, supplier_id, amount_cents, created_by, created_at
)
select bt.organization_id, bt.id, bt.journal_entry_id, 0, 'purchase_invoice', bt.matched_purchase_invoice_id, pi.supplier_id,
       bt.amount_cents, bt.booked_by, coalesce(bt.booked_at, now())
from public.bank_transactions bt
join public.purchase_invoices pi on pi.id = bt.matched_purchase_invoice_id and pi.organization_id = bt.organization_id
where bt.status = 'booked' and bt.journal_entry_id is not null and bt.amount_cents <> 0
  and not exists (select 1 from public.bank_transaction_allocations a where a.bank_transaction_id = bt.id);

-- ── 3. Kleine hulpjes ───────────────────────────────────────────────────────

-- Tekst naar uuid, of null als het geen uuid is (een cast gaf een Engelse
-- foutmelding die niemand begreep).
create or replace function public.bank_parse_uuid(p_text text)
returns uuid
language sql
immutable
set search_path = public
as $$
  select case
    when btrim(coalesce(p_text, '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then btrim(p_text)::uuid
  end;
$$;

-- € 1234,56 voor in een melding.
create or replace function public.bank_eur(p_cents bigint)
returns text
language sql
immutable
set search_path = public
as $$
  select '€ ' || replace(to_char(coalesce(p_cents, 0) / 100.0, 'FM999999999990.00'), '.', ',');
$$;

-- ── 4. Wat staat er open: uit de verdeling ──────────────────────────────────

-- GEWIJZIGD (20261107100000): de bankontvangsten en -terugbetalingen komen uit
-- de verdeling. Eerder telde hier élke debiteurenregel van de bankboeking met
-- matched_invoice_id = deze factuur; een betaling over drie facturen telde dan
-- drie keer het hele bedrag af.
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
    select coalesce(sum(a.amount_cents), 0) as cents
    from public.bank_transaction_allocations a
    join public.journal_entries je on je.id = a.journal_entry_id and je.status = 'posted'
      and je.reversed_by_entry_id is null and je.reverses_entry_id is null
    where a.organization_id = p_organization_id
      and a.invoice_id = p_invoice_id
      and a.kind in ('sales_invoice', 'sales_credit_note')
      and a.bank_transaction_id is distinct from p_exclude_bank_transaction_id
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

-- GEWIJZIGD (20261107100000): betalingen uit de verdeling (zie hierboven).
create or replace function public.purchase_invoice_open_payable_cents(p_organization_id uuid, p_purchase_invoice_id uuid)
returns bigint
language sql
stable
set search_path = public
as $$
  select coalesce((
    select sum(jl.credit_cents - jl.debit_cents)
    from public.purchase_invoices pi
    join public.journal_entries je on je.id = pi.journal_entry_id and je.reversed_by_entry_id is null
    join public.journal_lines jl on jl.entry_id = je.id
    join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
    where pi.id = p_purchase_invoice_id and pi.organization_id = p_organization_id
  ), 0)::bigint - coalesce((
    select sum(-a.amount_cents)
    from public.bank_transaction_allocations a
    join public.journal_entries je on je.id = a.journal_entry_id and je.status = 'posted'
      and je.reversed_by_entry_id is null and je.reverses_entry_id is null
    where a.organization_id = p_organization_id
      and a.purchase_invoice_id = p_purchase_invoice_id
      and a.kind = 'purchase_invoice'
  ), 0)::bigint;
$$;

-- GEWIJZIGD (20261107100000): betaaldatum uit de verdeling, en een creditnota
-- van de leverancier (negatief totaal) staat op betaald zodra hij het geld
-- terugstortte. Die bleef eerder voorgoed op 'unpaid'.
create or replace function public.refresh_purchase_invoice_payment_status(p_organization_id uuid, p_purchase_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pi public.purchase_invoices;
  v_total bigint;
  v_open bigint;
  v_status text;
  v_paid_at timestamptz;
begin
  select * into v_pi from public.purchase_invoices
  where id = p_purchase_invoice_id and organization_id = p_organization_id;
  if not found or v_pi.journal_entry_id is null then
    return;
  end if;

  select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_total
  from public.journal_lines jl
  join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_payable'
  where jl.entry_id = v_pi.journal_entry_id;

  v_open := public.purchase_invoice_open_payable_cents(p_organization_id, p_purchase_invoice_id);
  v_status := case
    when v_total > 0 and v_open <= 0 then 'paid'
    when v_total < 0 and v_open >= 0 then 'paid'
    when v_total <> 0 and abs(v_open) < abs(v_total) then 'partially_paid'
    else 'unpaid'
  end;
  if v_status = 'paid' then
    select max(bt.booking_date)::timestamptz into v_paid_at
    from public.bank_transaction_allocations a
    join public.journal_entries je on je.id = a.journal_entry_id and je.status = 'posted'
      and je.reversed_by_entry_id is null and je.reverses_entry_id is null
    join public.bank_transactions bt on bt.id = a.bank_transaction_id
    where a.organization_id = p_organization_id
      and a.purchase_invoice_id = p_purchase_invoice_id;
    v_paid_at := coalesce(v_paid_at, now());
  end if;

  update public.purchase_invoices
  set payment_status = v_status, paid_at = v_paid_at
  where id = p_purchase_invoice_id
    and (payment_status is distinct from v_status or paid_at is distinct from v_paid_at);
end;
$$;

-- ── 5. Samenvoegen: de bank bevestigt een handmatige mutatie ────────────────

-- Eén paar samenvoegen. Alleen voor de functies hieronder; die controleren
-- vooraf of het paar mag (de trigger bank_transactions_merge_guard ook).
create or replace function public.bank_merge_pair(
  p_organization_id uuid,
  p_bank_transaction_id uuid,
  p_manual_transaction_id uuid,
  p_actor uuid,
  p_automatic boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bank public.bank_transactions;
  v_manual public.bank_transactions;
begin
  select * into v_bank from public.bank_transactions
  where id = p_bank_transaction_id and organization_id = p_organization_id for update;
  select * into v_manual from public.bank_transactions
  where id = p_manual_transaction_id and organization_id = p_organization_id for update;
  if v_bank.id is null or v_manual.id is null then
    raise exception 'Banktransactie niet gevonden.' using errcode = '02000';
  end if;

  update public.bank_transactions set
    status = 'merged',
    merged_into_id = v_manual.id,
    merged_at = now(),
    merged_by = p_actor,
    suggested_account_id = null,
    suggested_vat_code = null,
    matched_rule_id = null,
    match_confidence = null,
    matched_invoice_id = null,
    matched_purchase_invoice_id = null,
    updated_at = now()
  where id = v_bank.id;

  -- Nog niet geboekt: dan geldt voortaan de datum van de bank (die boek je),
  -- en vult de bank aan wat de gebruiker leeg liet. Al geboekt: de boeking
  -- ligt vast, en de aansluiting vangt een datumverschil op.
  if v_manual.status <> 'booked' then
    update public.bank_transactions set
      booking_date = v_bank.booking_date,
      value_date = coalesce(v_bank.value_date, v_bank.booking_date),
      counterparty_iban = coalesce(v_manual.counterparty_iban, v_bank.counterparty_iban),
      counterparty_name = coalesce(v_manual.counterparty_name, v_bank.counterparty_name),
      updated_at = now()
    where id = v_manual.id;
  end if;

  -- De ingelogde gebruiker, niet wat de aanroeper als p_actor meegaf (die is
  -- via /rest/v1/rpc vrij in te vullen). Zonder gebruiker (import door de
  -- bankkoppeling) blijft p_actor staan.
  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (
    p_organization_id, coalesce(auth.uid(), p_actor), 'updated', 'bank_transaction', v_manual.id,
    left(coalesce(nullif(v_manual.counterparty_name, ''), nullif(v_manual.description, ''), 'Handmatige mutatie'), 200),
    jsonb_build_object(
      'wat', case when p_automatic then 'automatisch samengevoegd met de bank' else 'samengevoegd met de bank' end,
      'bank_transaction_id', v_bank.id,
      'datum_bank', v_bank.booking_date,
      'datum_handmatig', v_manual.booking_date,
      'amount_cents', v_manual.amount_cents
    )
  );
end;
$$;

-- Alle eenduidige paren van een organisatie (of één rekening) samenvoegen.
-- Een paar is eenduidig als de bankregel precies één kandidaat heeft en die
-- handmatige mutatie ook precies één bankregel. Twee keer € 50 aan dezelfde
-- partij in één week laten we dus aan de gebruiker.
create or replace function public.merge_manual_bank_transactions(
  p_organization_id uuid,
  p_bank_account_id uuid default null,
  p_created_by uuid default auth.uid()
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_count integer := 0;
begin
  -- Twee imports tegelijk mogen niet allebei hetzelfde paar maken.
  perform pg_advisory_xact_lock(hashtext(p_organization_id::text || ':bank-samenvoegen'));

  for r in
    with manual as (
      select m.*
      from public.bank_transactions m
      where m.organization_id = p_organization_id
        and m.is_manual
        and m.status in ('unmatched', 'suggested', 'booked')
        and (p_bank_account_id is null or m.bank_account_id = p_bank_account_id)
        and not exists (select 1 from public.bank_transactions x where x.merged_into_id = m.id)
    ),
    pairs as (
      select b.id as bank_id, m.id as manual_id
      from manual m
      join public.bank_transactions b
        on b.organization_id = m.organization_id
       and b.bank_account_id = m.bank_account_id
       and b.amount_cents = m.amount_cents
       and not b.is_manual
       and b.status in ('unmatched', 'suggested')
       and not b.auto_merge_blocked
       and b.booking_date between m.booking_date - 7 and m.booking_date + 7
       and (m.counterparty_iban is null or b.counterparty_iban is null
            or upper(regexp_replace(b.counterparty_iban, '\s', '', 'g')) = upper(regexp_replace(m.counterparty_iban, '\s', '', 'g')))
    )
    select p.bank_id, p.manual_id
    from pairs p
    where (select count(*) from pairs p2 where p2.bank_id = p.bank_id) = 1
      and (select count(*) from pairs p3 where p3.manual_id = p.manual_id) = 1
  loop
    perform public.bank_merge_pair(p_organization_id, r.bank_id, r.manual_id, p_created_by, true);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ── 6. Matchen ──────────────────────────────────────────────────────────────
-- GEWIJZIGD (20261107100000): eerst samenvoegen, dan pas matchen. Anders boekte
-- een bankregel met "automatisch boeken" de bankregel die bij een al geboekte
-- handmatige mutatie hoorde: hetzelfde geld twee keer in de boeken.
-- Nieuw: p_transaction_id (alleen die ene) en p_auto_book (false = alleen
-- voorstellen). Een zojuist ingevoerde mutatie krijgt zo een voorstel zonder
-- dat een regel hem al boekt terwijl de gebruiker nog kijkt.
drop function if exists public.match_bank_transactions(uuid, uuid, uuid);

create or replace function public.match_bank_transactions(
  p_organization_id uuid,
  p_bank_account_id uuid default null,
  p_created_by uuid default auth.uid(),
  p_transaction_id uuid default null,
  p_auto_book boolean default true
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
  v_merged integer := 0;
  v_haystack text;
  v_iban text;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if p_transaction_id is null then
    v_merged := public.merge_manual_bank_transactions(p_organization_id, p_bank_account_id, p_created_by);
  end if;

  for v_txn in
    select * from public.bank_transactions
    where organization_id = p_organization_id
      and status = 'unmatched'
      and (p_bank_account_id is null or bank_account_id = p_bank_account_id)
      and (p_transaction_id is null or id = p_transaction_id)
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
        -- GEWIJZIGD (20261105233000): als los kenmerk (niet "42" binnen
        -- "4211"), en alleen een factuur waarop nog iets openstaat.
        and public.bank_text_mentions_reference(v_haystack, i.number)
        and public.invoice_open_receivable_cents(p_organization_id, i.id) > 0
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
        -- GEWIJZIGD (20261105233000): een los kenmerk van minstens drie tekens
        -- (cijfers alleen vanaf vijf), en alleen wat nog openstaat. Een geboekte
        -- inkoopfactuur "42" werd anders bij elke pinbetaling "BEA Shell 4211"
        -- voorgesteld, en de bankregel voor Shell kwam nooit aan de beurt.
        and (
          (pi.internal_number is not null and public.bank_text_mentions_reference(v_haystack, pi.internal_number))
          or (pi.supplier_invoice_number is not null and public.bank_text_mentions_reference(v_haystack, pi.supplier_invoice_number))
        )
        and public.purchase_invoice_open_payable_cents(p_organization_id, pi.id) > 0
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
      if p_auto_book and v_rule.auto_book and v_rule.target_account_id is not null then
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
    -- GEWIJZIGD (20261105233000): op die rekening betaal je ook loonheffing,
    -- Vpb en inkomstenbelasting. Alleen 1530 voorstellen als het bedrag past op
    -- een ingediende, nog niet betaalde btw-aangifte, of als de omschrijving
    -- over btw gaat. Anders kiest de gebruiker zelf.
    if (v_iban = 'NL86INGB0002445588'
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

  return jsonb_build_object('suggested', v_suggested, 'auto_booked', v_auto, 'merged', v_merged);
end;
$$;

-- ── 7. Inlezen: de afschriftcontrole telt alleen wat van de bank komt ───────
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
  -- GEWIJZIGD (20261107100000): handmatige mutaties staan op geen enkel
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

-- ── 8. Boeken: een verdeling over facturen, creditnota's en rekeningen ──────
-- GEWIJZIGD (20261107100000): nieuwe parameters p_allocations en p_description.
-- De oude manieren (p_matched_invoice_id, p_matched_purchase_invoice_id,
-- p_lines) werken zoals voorheen: ze worden omgezet naar een verdeling van één
-- of meer regels. Nieuw is dat de regels precies op het bedrag van de
-- transactie moeten uitkomen; eerder boekte post_journal_entry een verschil
-- tot een paar cent stil op 4900.
drop function if exists public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid);

create or replace function public.book_bank_transaction(
  p_organization_id uuid,
  p_transaction_id uuid,
  p_lines jsonb default null,
  p_matched_invoice_id uuid default null,
  p_matched_purchase_invoice_id uuid default null,
  p_created_by uuid default auth.uid(),
  p_allocations jsonb default null,
  p_description text default null
)
returns public.journal_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions;
  v_ba public.bank_accounts;
  v_partner public.bank_transactions;
  v_abs bigint;
  v_dir integer;
  v_items jsonb;
  v_item jsonb;
  v_n integer := 0;
  v_kind text;
  v_amt bigint;        -- in de richting van de transactie (zoals de invoer)
  v_bank_amt bigint;   -- in bankrichting: + geld erbij, − geld eraf
  v_sum bigint := 0;
  v_id uuid;
  v_key text;
  v_seen text[] := '{}';
  v_line_desc text;
  v_desc text;
  v_date date;
  v_lines jsonb;
  v_alloc jsonb := '[]'::jsonb;
  v_entry public.journal_entries;
  v_inv public.invoices;
  v_cn public.credit_notes;
  v_pi public.purchase_invoices;
  v_acc public.ledger_accounts;
  v_vc public.vat_codes;
  v_entry_reversed boolean;
  v_open bigint;
  v_cn_total bigint;
  v_cn_refunded bigint;
  v_room bigint;
  v_used jsonb := '{}'::jsonb;   -- per factuur: tegoed dat deze boeking al terugbetaalt
  v_inv_ids uuid[] := '{}';
  v_pi_ids uuid[] := '{}';
  v_sales_invoice_ids uuid[] := '{}';
  v_vat_payable_id uuid;
  v_vat_payable_booked bigint := 0;
  v_vat_1510 bigint := 0;  -- positief → credit 1510, negatief → debet 1510
  v_vat_1500 bigint := 0;  -- positief → debet 1500, negatief → credit 1500
  v_vat_1520 bigint := 0;  -- positief → credit 1520, negatief → debet 1520
  v_is_credit boolean;
  v_gross bigint;
  v_net bigint;
  v_vat bigint;
  v_rate numeric;
  v_vkind text;
  v_vcode text;
  v_client uuid;
  v_supplier uuid;
  v_project uuid;
  v_target_saldo bigint;
  v_match_count integer;
  v_match_id uuid;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;
  if p_matched_invoice_id is not null and p_matched_purchase_invoice_id is not null then
    raise exception 'Koppel een transactie aan één factuur: een verkoopfactuur óf een inkoopfactuur. Meer stukken tegelijk gaat met een verdeling.' using errcode = '23514';
  end if;

  select * into v_txn from public.bank_transactions
  where id = p_transaction_id and organization_id = p_organization_id for update;
  if not found then
    raise exception 'Banktransactie niet gevonden.' using errcode = '02000';
  end if;
  if v_txn.status = 'booked' or v_txn.journal_entry_id is not null then
    raise exception 'Deze transactie is al geboekt.' using errcode = '23514';
  end if;
  if v_txn.status = 'merged' then
    raise exception 'Deze banktransactie is samengevoegd met een handmatige mutatie; die draagt de boeking. Boek de handmatige mutatie, of maak het samenvoegen los.'
      using errcode = '23514';
  end if;
  if upper(coalesce(nullif(btrim(v_txn.currency), ''), 'EUR')) <> 'EUR' then
    raise exception 'Deze banktransactie is in %. Het grootboek boekt in euro''s: reken het bedrag om en boek het met een memoriaalpost.', upper(v_txn.currency)
      using errcode = '23514';
  end if;

  select * into v_ba from public.bank_accounts where id = v_txn.bank_account_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Bankrekening niet gevonden.' using errcode = '02000';
  end if;

  v_abs := abs(v_txn.amount_cents);
  if v_abs = 0 then
    raise exception 'Een transactie van € 0,00 kan niet worden geboekt.' using errcode = '23514';
  end if;
  v_dir := case when v_txn.amount_cents > 0 then 1 else -1 end;

  perform public.ensure_default_ledger_accounts(p_organization_id);
  v_vat_payable_id := public.bookkeeping_account_id(p_organization_id, '1530');

  -- Alles wordt één verdeling. Bedragen in de invoer staan in de richting van
  -- de transactie: positief = mee met het geld (bij een betaling: wat je
  -- betaalt), negatief = de andere kant op (bijvoorbeeld kosten die van een
  -- uitbetaling zijn afgehouden).
  if p_allocations is not null and jsonb_typeof(p_allocations) = 'array' and jsonb_array_length(p_allocations) > 0 then
    if p_lines is not null or p_matched_invoice_id is not null or p_matched_purchase_invoice_id is not null then
      raise exception 'Geef óf een verdeling, óf een factuur, óf regels — niet door elkaar.' using errcode = '23514';
    end if;
    v_items := p_allocations;
  elsif p_matched_invoice_id is not null then
    v_items := jsonb_build_array(jsonb_build_object('kind', 'sales_invoice', 'invoice_id', p_matched_invoice_id, 'amount_cents', v_abs));
  elsif p_matched_purchase_invoice_id is not null then
    v_items := jsonb_build_array(jsonb_build_object('kind', 'purchase_invoice', 'purchase_invoice_id', p_matched_purchase_invoice_id, 'amount_cents', v_abs));
  elsif p_lines is not null and jsonb_typeof(p_lines) = 'array' and jsonb_array_length(p_lines) > 0 then
    select jsonb_agg(case when jsonb_typeof(l) = 'object' then l || jsonb_build_object('kind', 'ledger') else l end order by ord)
    into v_items
    from jsonb_array_elements(p_lines) with ordinality as t(l, ord);
  else
    raise exception 'Geen tegenrekening: letter een factuur af of kies een grootboekrekening.' using errcode = '23514';
  end if;
  if jsonb_array_length(v_items) > 100 then
    raise exception 'Een boeking heeft hoogstens 100 regels.' using errcode = '23514';
  end if;

  v_desc := nullif(btrim(coalesce(p_description, '')), '');
  if v_desc is not null and length(v_desc) > 300 then
    raise exception 'De omschrijving van de boeking is te lang (hoogstens 300 tekens).' using errcode = '23514';
  end if;
  v_desc := coalesce(v_desc,
    'Bank ' || coalesce(v_ba.name, '') || ': ' ||
    coalesce(nullif(v_txn.counterparty_name, ''), nullif(v_txn.description, ''), 'transactie'));

  -- Een handmatige mutatie die de bank al bevestigde, boekt op de datum van de bank.
  v_date := v_txn.booking_date;
  if v_txn.is_manual then
    select * into v_partner from public.bank_transactions where merged_into_id = v_txn.id;
    if found then
      v_date := v_partner.booking_date;
    end if;
  end if;

  -- Bankregel (debet bij ontvangst, credit bij betaling).
  v_lines := jsonb_build_array(jsonb_build_object(
    'account_id', v_ba.ledger_account_id,
    'description', v_desc,
    'debit_cents', case when v_dir > 0 then v_abs else 0 end,
    'credit_cents', case when v_dir < 0 then v_abs else 0 end
  ));

  for v_item in select value from jsonb_array_elements(v_items)
  loop
    v_n := v_n + 1;
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Regel % van de verdeling is onleesbaar.', v_n using errcode = '22023';
    end if;
    v_kind := coalesce(nullif(v_item->>'kind', ''), 'ledger');
    if v_kind not in ('sales_invoice', 'sales_credit_note', 'purchase_invoice', 'ledger') then
      raise exception 'Regel %: onbekende soort "%".', v_n, v_kind using errcode = '22023';
    end if;
    if coalesce(v_item->>'amount_cents', '') !~ '^-?[0-9]{1,15}$' then
      raise exception 'Regel %: geef een bedrag (in hele centen).', v_n using errcode = '22023';
    end if;
    v_amt := (v_item->>'amount_cents')::bigint;
    if v_amt = 0 then
      -- Een lege regel sloeg de oude boeking ook over.
      if v_kind = 'ledger' then continue; end if;
      raise exception 'Regel %: geef een bedrag.', v_n using errcode = '22023';
    end if;
    v_bank_amt := v_amt * v_dir;
    v_sum := v_sum + v_amt;
    v_line_desc := nullif(btrim(coalesce(v_item->>'description', '')), '');
    if v_line_desc is not null and length(v_line_desc) > 300 then
      raise exception 'Regel %: de omschrijving is te lang (hoogstens 300 tekens).', v_n using errcode = '23514';
    end if;

    if v_kind = 'sales_invoice' then
      v_id := public.bank_parse_uuid(v_item->>'invoice_id');
      if v_id is null then
        raise exception 'Regel %: kies een verkoopfactuur.', v_n using errcode = '22023';
      end if;
      v_key := 'i:' || v_id::text;
      if v_key = any(v_seen) then
        raise exception 'Regel %: deze factuur staat al op een andere regel.', v_n using errcode = '23514';
      end if;
      v_seen := v_seen || v_key;
      if v_bank_amt <= 0 then
        raise exception 'Regel %: een verkoopfactuur betaalt de klant aan jou; dat gaat alleen met geld dat binnenkomt. Een terugbetaling koppel je aan de creditnota.', v_n
          using errcode = '23514';
      end if;
      -- for update: gelijktijdig twee ontvangsten op dezelfde factuur boeken zou
      -- anders allebei de openstaand-check passeren.
      select * into v_inv from public.invoices
      where id = v_id and organization_id = p_organization_id for update;
      if not found then
        raise exception 'Regel %: verkoopfactuur niet gevonden.', v_n using errcode = '02000';
      end if;
      if v_inv.status in ('cancelled', 'void') then
        raise exception 'Factuur % is geannuleerd; daar letter je niets meer op af.', coalesce(v_inv.number, '') using errcode = '23514';
      end if;
      -- Afletteren kan alleen tegen een factuur die in het grootboek staat. Zonder
      -- debitering van 1300 zou de creditering hier Debiteuren negatief maken.
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
      v_open := public.invoice_open_receivable_cents(p_organization_id, v_inv.id, v_txn.id);
      if v_open <= 0 then
        raise exception 'Factuur % is al volledig afgeletterd.', coalesce(v_inv.number, '') using errcode = '23514';
      end if;
      if v_bank_amt > v_open then
        raise exception 'Ontvangst (%) is hoger dan het openstaande saldo van factuur % (%). Zet op die regel hoogstens het openstaande bedrag en boek de rest op een eigen regel (bijvoorbeeld een grootboekrekening).',
          public.bank_eur(v_bank_amt), coalesce(v_inv.number, ''), public.bank_eur(v_open)
          using errcode = '23514';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
        'description', coalesce(v_line_desc, 'Debiteuren — factuur ' || coalesce(v_inv.number, '')),
        'debit_cents', 0, 'credit_cents', v_bank_amt,
        'client_id', v_inv.client_id
      ));
      v_alloc := v_alloc || jsonb_build_array(jsonb_build_object(
        'kind', 'sales_invoice', 'invoice_id', v_inv.id, 'client_id', v_inv.client_id,
        'amount_cents', v_bank_amt, 'description', v_line_desc));
      v_inv_ids := v_inv_ids || v_inv.id;
      v_sales_invoice_ids := v_sales_invoice_ids || v_inv.id;

    elsif v_kind = 'sales_credit_note' then
      v_id := public.bank_parse_uuid(v_item->>'credit_note_id');
      if v_id is null then
        raise exception 'Regel %: kies een creditnota.', v_n using errcode = '22023';
      end if;
      v_key := 'c:' || v_id::text;
      if v_key = any(v_seen) then
        raise exception 'Regel %: deze creditnota staat al op een andere regel.', v_n using errcode = '23514';
      end if;
      v_seen := v_seen || v_key;
      if v_bank_amt >= 0 then
        raise exception 'Regel %: een creditnota betaal je terug aan de klant; dat gaat alleen met geld dat van je rekening gaat.', v_n
          using errcode = '23514';
      end if;
      select * into v_cn from public.credit_notes
      where id = v_id and organization_id = p_organization_id for update;
      if not found then
        raise exception 'Regel %: creditnota niet gevonden.', v_n using errcode = '02000';
      end if;
      if v_cn.status <> 'issued' then
        raise exception 'Creditnota % is niet uitgegeven (status: %).', v_cn.number, v_cn.status using errcode = '23514';
      end if;
      if v_cn.journal_entry_id is null then
        raise exception 'Creditnota % staat nog niet in het grootboek. Boek hem eerst; daarna koppel je de terugbetaling.', v_cn.number
          using errcode = '23514';
      end if;
      select je.reversed_by_entry_id is not null into v_entry_reversed
      from public.journal_entries je where je.id = v_cn.journal_entry_id;
      if coalesce(v_entry_reversed, false) then
        raise exception 'De grootboekboeking van creditnota % is tegengeboekt; er valt niets terug te betalen.', v_cn.number
          using errcode = '23514';
      end if;
      select * into v_inv from public.invoices
      where id = v_cn.invoice_id and organization_id = p_organization_id for update;
      if not found then
        raise exception 'De factuur bij creditnota % is niet gevonden.', v_cn.number using errcode = '02000';
      end if;
      -- Wat de klant op deze factuur tegoed heeft: een negatief openstaand saldo
      -- (de creditnota kwam na de betaling). Min wat deze boeking op een andere
      -- regel al terugbetaalt.
      v_open := public.invoice_open_receivable_cents(p_organization_id, v_inv.id, v_txn.id)
              + coalesce((v_used->>v_inv.id::text)::bigint, 0);
      if v_open >= 0 then
        raise exception 'Op factuur % staat geen tegoed voor de klant (openstaand %): creditnota % is verrekend met wat er nog openstond. Er valt niets terug te betalen.',
          coalesce(v_inv.number, ''), public.bank_eur(greatest(v_open, 0)), v_cn.number
          using errcode = '23514';
      end if;
      select coalesce(sum(jl.credit_cents - jl.debit_cents), 0) into v_cn_total
      from public.journal_lines jl
      join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
      where jl.entry_id = v_cn.journal_entry_id;
      select coalesce(sum(-a.amount_cents), 0) into v_cn_refunded
      from public.bank_transaction_allocations a
      join public.journal_entries je on je.id = a.journal_entry_id and je.status = 'posted'
        and je.reversed_by_entry_id is null and je.reverses_entry_id is null
      where a.organization_id = p_organization_id and a.credit_note_id = v_cn.id
        and a.bank_transaction_id <> v_txn.id;
      v_room := least(v_cn_total - v_cn_refunded, -v_open);
      if -v_bank_amt > v_room then
        raise exception 'Terugbetaling (%) is hoger dan wat er van creditnota % nog terug te betalen is (%).',
          public.bank_eur(-v_bank_amt), v_cn.number, public.bank_eur(greatest(v_room, 0))
          using errcode = '23514';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1300'),
        'description', coalesce(v_line_desc, 'Terugbetaling creditnota ' || v_cn.number || ' (factuur ' || coalesce(v_inv.number, '') || ')'),
        'debit_cents', -v_bank_amt, 'credit_cents', 0,
        'client_id', v_inv.client_id
      ));
      v_alloc := v_alloc || jsonb_build_array(jsonb_build_object(
        'kind', 'sales_credit_note', 'credit_note_id', v_cn.id, 'invoice_id', v_inv.id, 'client_id', v_inv.client_id,
        'amount_cents', v_bank_amt, 'description', v_line_desc));
      v_used := v_used || jsonb_build_object(v_inv.id::text, coalesce((v_used->>v_inv.id::text)::bigint, 0) - v_bank_amt);
      v_inv_ids := v_inv_ids || v_inv.id;

    elsif v_kind = 'purchase_invoice' then
      v_id := public.bank_parse_uuid(v_item->>'purchase_invoice_id');
      if v_id is null then
        raise exception 'Regel %: kies een inkoopfactuur.', v_n using errcode = '22023';
      end if;
      v_key := 'p:' || v_id::text;
      if v_key = any(v_seen) then
        raise exception 'Regel %: deze inkoopfactuur staat al op een andere regel.', v_n using errcode = '23514';
      end if;
      v_seen := v_seen || v_key;
      select * into v_pi from public.purchase_invoices
      where id = v_id and organization_id = p_organization_id for update;
      if not found then
        raise exception 'Regel %: inkoopfactuur niet gevonden.', v_n using errcode = '02000';
      end if;
      if v_pi.status = 'cancelled' then
        raise exception 'Inkoopfactuur % is geannuleerd.', coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
      end if;
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
      v_open := public.purchase_invoice_open_payable_cents(p_organization_id, v_pi.id);
      if v_open = 0 then
        raise exception 'Inkoopfactuur % is al volledig afgeletterd.',
          coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
      end if;
      if v_open > 0 then
        if v_bank_amt >= 0 then
          raise exception 'Regel %: inkoopfactuur % betaal je aan de leverancier; dat gaat alleen met geld dat van je rekening gaat.',
            v_n, coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
        end if;
        if -v_bank_amt > v_open then
          raise exception 'Betaling (%) is hoger dan het openstaande saldo van inkoopfactuur % (%). Zet op die regel hoogstens het openstaande bedrag en boek de rest op een eigen regel.',
            public.bank_eur(-v_bank_amt), coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''), public.bank_eur(v_open)
            using errcode = '23514';
        end if;
      else
        -- Een creditnota van de leverancier: hij is jou geld schuldig.
        if v_bank_amt <= 0 then
          raise exception 'Regel %: % is een creditnota van de leverancier; daar hoort geld bij dat binnenkomt.',
            v_n, coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '') using errcode = '23514';
        end if;
        if v_bank_amt > -v_open then
          raise exception 'Ontvangst (%) is hoger dan wat de leverancier op % nog terug moet betalen (%).',
            public.bank_eur(v_bank_amt), coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, ''), public.bank_eur(-v_open)
            using errcode = '23514';
        end if;
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.bookkeeping_account_id(p_organization_id, '1600'),
        'description', coalesce(v_line_desc, 'Crediteuren — ' || coalesce(v_pi.supplier_invoice_number, v_pi.internal_number, '')),
        'debit_cents', case when v_bank_amt < 0 then -v_bank_amt else 0 end,
        'credit_cents', case when v_bank_amt > 0 then v_bank_amt else 0 end,
        'supplier_id', v_pi.supplier_id
      ));
      v_alloc := v_alloc || jsonb_build_array(jsonb_build_object(
        'kind', 'purchase_invoice', 'purchase_invoice_id', v_pi.id, 'supplier_id', v_pi.supplier_id,
        'amount_cents', v_bank_amt, 'description', v_line_desc));
      v_pi_ids := v_pi_ids || v_pi.id;

    else
      -- Rechtstreeks op een grootboekrekening, bruto bedrag met btw-code.
      v_id := public.bank_parse_uuid(v_item->>'account_id');
      if v_id is null and nullif(btrim(coalesce(v_item->>'account_code', '')), '') is not null then
        select la.id into v_id from public.ledger_accounts la
        where la.organization_id = p_organization_id and la.code = btrim(v_item->>'account_code');
      end if;
      if v_id is null then
        raise exception 'Regel %: kies een grootboekrekening.', v_n using errcode = '22023';
      end if;
      select * into v_acc from public.ledger_accounts where id = v_id and organization_id = p_organization_id;
      if not found then
        raise exception 'Regel %: grootboekrekening niet gevonden.', v_n using errcode = '02000';
      end if;
      if not v_acc.is_active then
        raise exception 'Regel %: % · % staat op inactief.', v_n, v_acc.code, v_acc.name using errcode = '23514';
      end if;
      if v_acc.id = v_ba.ledger_account_id then
        raise exception 'Regel %: % is de grootboekrekening van deze bankrekening zelf. Kies de tegenrekening.', v_n, v_acc.code
          using errcode = '23514';
      end if;

      v_vcode := nullif(btrim(coalesce(v_item->>'vat_code', '')), '');
      if v_vcode is not null then
        select * into v_vc from public.vat_codes where organization_id = p_organization_id and code = v_vcode;
        if not found then
          raise exception 'Regel %: btw-code % bestaat niet.', v_n, v_vcode using errcode = '22023';
        end if;
        v_rate := v_vc.rate;
        v_vkind := coalesce(v_vc.kind, 'standard');
      else
        -- Zonder code een los tarief, zoals de oude regels het mochten meesturen.
        if coalesce(v_item->>'vat_rate', '') !~ '^([0-9]{1,2}(\.[0-9]{1,2})?)?$' then
          raise exception 'Regel %: ongeldig btw-tarief.', v_n using errcode = '22023';
        end if;
        v_rate := coalesce(nullif(v_item->>'vat_rate', '')::numeric, 0);
        v_vkind := 'standard';
      end if;

      v_client := public.bank_parse_uuid(v_item->>'client_id');
      v_supplier := public.bank_parse_uuid(v_item->>'supplier_id');
      v_project := public.bank_parse_uuid(v_item->>'project_id');
      if (nullif(btrim(coalesce(v_item->>'client_id', '')), '') is not null and v_client is null)
         or (nullif(btrim(coalesce(v_item->>'supplier_id', '')), '') is not null and v_supplier is null)
         or (nullif(btrim(coalesce(v_item->>'project_id', '')), '') is not null and v_project is null) then
        raise exception 'Regel %: ongeldige klant, leverancier of project.', v_n using errcode = '22023';
      end if;
      if v_client is not null then
        if not (v_acc.subtype = 'accounts_receivable' or v_acc.type = 'revenue') then
          raise exception 'Regel %: een klant hoort op een debiteuren- of omzetrekening; % is dat niet.', v_n, v_acc.code using errcode = '23514';
        end if;
        if not exists (select 1 from public.clients c where c.id = v_client and c.organization_id = p_organization_id) then
          raise exception 'Regel %: klant niet gevonden.', v_n using errcode = '02000';
        end if;
      end if;
      if v_supplier is not null then
        if coalesce(v_acc.subtype, '') <> 'accounts_payable' then
          raise exception 'Regel %: een leverancier hoort op een crediteurenrekening; % is dat niet.', v_n, v_acc.code using errcode = '23514';
        end if;
        if not exists (select 1 from public.suppliers s where s.id = v_supplier and s.organization_id = p_organization_id) then
          raise exception 'Regel %: leverancier niet gevonden.', v_n using errcode = '02000';
        end if;
      end if;
      if v_project is not null
         and not exists (select 1 from public.projects p where p.id = v_project and p.organization_id = p_organization_id) then
        raise exception 'Regel %: project niet gevonden.', v_n using errcode = '02000';
      end if;

      -- Onthoud wat er op 1530 Te betalen omzetbelasting valt (voor de
      -- automatische koppeling met de aangifte hieronder).
      if v_acc.id = v_vat_payable_id then
        v_vat_payable_booked := v_vat_payable_booked + v_amt;
      end if;

      -- De kant volgt het geld van DEZE regel: geld erbij → tegenregel credit.
      -- De btw kijkt naar vat_codes.kind én naar de aard van de rekening
      -- (zoals sinds 20261104010000), per regel in plaats van per transactie.
      v_is_credit := v_bank_amt > 0;
      v_gross := abs(v_amt);
      if v_vkind in ('reverse_charge_purchase', 'eu_acquisition', 'import_non_eu') then
        -- Verlegd/EU-verwerving/invoer: het volle bedrag is de grondslag; btw
        -- zelf aangeven én aftrekken.
        v_net := v_gross;
        v_vat := round(v_gross * v_rate / 100.0);
        if v_is_credit then
          v_vat_1500 := v_vat_1500 - v_vat;
          v_vat_1520 := v_vat_1520 - v_vat;
        else
          v_vat_1500 := v_vat_1500 + v_vat;
          v_vat_1520 := v_vat_1520 + v_vat;
        end if;
      else
        -- Inclusief-btw-splitsing (bruto → netto + btw), centneutraal.
        v_net := round(v_gross / (1 + v_rate / 100.0));
        v_vat := v_gross - v_net;
        if v_acc.type = 'revenue' then
          v_vat_1510 := v_vat_1510 + case when v_is_credit then v_vat else -v_vat end;
        elsif v_acc.type in ('expense', 'asset') then
          v_vat_1500 := v_vat_1500 + case when v_is_credit then -v_vat else v_vat end;
        else
          if v_is_credit then
            v_vat_1510 := v_vat_1510 + v_vat;
          else
            v_vat_1500 := v_vat_1500 + v_vat;
          end if;
        end if;
      end if;

      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_acc.id,
        'description', coalesce(v_line_desc, nullif(v_txn.counterparty_name, ''), nullif(v_txn.description, ''),
                                case when v_is_credit then 'Ontvangst' else 'Betaling' end),
        'debit_cents', case when v_is_credit then 0 else v_net end,
        'credit_cents', case when v_is_credit then v_net else 0 end,
        'vat_code', v_vcode, 'vat_rate', v_rate,
        -- Rubriekconsistentie: op omzetregels telt compute_vat_return
        -- vat_amount_cents op naast credit−debit; een debet-omzetregel
        -- (terugbetaling) moet dus een negatieve grondslag/btw dragen.
        'vat_base_cents', case when v_acc.type = 'revenue' and not v_is_credit then -v_net else v_net end,
        'vat_amount_cents', case when v_acc.type = 'revenue' and not v_is_credit then -v_vat else v_vat end,
        'client_id', v_client, 'supplier_id', v_supplier, 'project_id', v_project
      ));
      v_alloc := v_alloc || jsonb_build_array(jsonb_build_object(
        'kind', 'ledger', 'account_id', v_acc.id, 'vat_code', v_vcode,
        'client_id', v_client, 'supplier_id', v_supplier, 'project_id', v_project,
        'amount_cents', v_bank_amt, 'description', v_line_desc));
    end if;
  end loop;

  if jsonb_array_length(v_alloc) = 0 then
    raise exception 'Geen tegenrekening: letter een factuur af of kies een grootboekrekening.' using errcode = '23514';
  end if;
  if v_sum <> v_abs then
    raise exception 'De regels tellen op tot %, maar de transactie is %. Verdeel precies het hele bedrag (verschil %).',
      public.bank_eur(v_sum), public.bank_eur(v_abs), public.bank_eur(abs(v_abs - v_sum))
      using errcode = '23514';
  end if;

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

  v_entry := public.post_journal_entry(
    p_organization_id, v_date, v_desc, 'payment', v_txn.id, v_lines, p_created_by
  );

  -- De verdeling eerst: de trigger op bank_transactions rekent de betaalstatus
  -- van inkoopfacturen hiermee uit.
  insert into public.bank_transaction_allocations(
    organization_id, bank_transaction_id, journal_entry_id, position, kind,
    invoice_id, credit_note_id, purchase_invoice_id, account_id, vat_code,
    client_id, supplier_id, project_id, amount_cents, description, created_by
  )
  select
    p_organization_id, v_txn.id, v_entry.id, (e.ord - 1)::integer, e.a->>'kind',
    public.bank_parse_uuid(e.a->>'invoice_id'), public.bank_parse_uuid(e.a->>'credit_note_id'),
    public.bank_parse_uuid(e.a->>'purchase_invoice_id'), public.bank_parse_uuid(e.a->>'account_id'),
    nullif(e.a->>'vat_code', ''),
    public.bank_parse_uuid(e.a->>'client_id'), public.bank_parse_uuid(e.a->>'supplier_id'), public.bank_parse_uuid(e.a->>'project_id'),
    (e.a->>'amount_cents')::bigint, nullif(e.a->>'description', ''), p_created_by
  from jsonb_array_elements(v_alloc) with ordinality as e(a, ord);

  -- De matchvelden beschrijven wat deze boeking DAADWERKELIJK deed, en alleen
  -- als dat één factuur was (voor wie ze nog leest). Rekenen gaat via de verdeling.
  update public.bank_transactions set
    status = 'booked',
    journal_entry_id = v_entry.id,
    matched_invoice_id = case when cardinality(v_sales_invoice_ids) = 1 then v_sales_invoice_ids[1] end,
    matched_purchase_invoice_id = case when cardinality(v_pi_ids) = 1 then v_pi_ids[1] end,
    booking_date = v_date,
    booked_at = now(),
    booked_by = p_created_by,
    updated_at = now()
  where id = v_txn.id;

  -- Volledig betaald → betaald. Anders liep de factuur naar "achterstallig" en
  -- kreeg de klant herinneringen voor een al betaalde factuur.
  update public.invoices i
  set status = 'paid',
      paid_at = coalesce(i.paid_at, (v_date::timestamp + time '12:00') at time zone 'Europe/Amsterdam'),
      updated_at = now()
  where i.organization_id = p_organization_id
    and i.id = any(v_inv_ids)
    and i.status in ('sent', 'overdue')
    and public.invoice_open_receivable_cents(p_organization_id, i.id) <= 0;

  for v_id in select distinct x from unnest(v_pi_ids) as x
  loop
    perform public.refresh_purchase_invoice_payment_status(p_organization_id, v_id);
  end loop;

  -- Lus sluiten: viel deze boeking op 1530 Te betalen omzetbelasting? Zoek dan de
  -- afgeronde aangifte (finalized/filed) met datzelfde saldo in dezelfde richting.
  -- Altijd op het AFGERONDE saldo (hele euro's); alleen bij één aangifte.
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

-- ── 9. Terugdraaien ─────────────────────────────────────────────────────────
-- GEWIJZIGD (20261107100000): alle facturen uit de verdeling gaan mee terug
-- (eerder alleen matched_invoice_id), en inkoopfacturen krijgen hun betaalstatus
-- opnieuw. De verdeling blijft bewaard: ze hoort bij de tegengeboekte boeking.
create or replace function public.unbook_bank_transaction(p_organization_id uuid, p_transaction_id uuid, p_created_by uuid default auth.uid())
returns public.bank_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions;
  v_inv_ids uuid[] := '{}';
  v_pi_ids uuid[] := '{}';
  v_id uuid;
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

  select coalesce(array_agg(distinct a.invoice_id) filter (where a.invoice_id is not null), '{}'),
         coalesce(array_agg(distinct a.purchase_invoice_id) filter (where a.purchase_invoice_id is not null), '{}')
  into v_inv_ids, v_pi_ids
  from public.bank_transaction_allocations a
  where a.bank_transaction_id = v_txn.id and a.journal_entry_id = v_txn.journal_entry_id;
  if v_txn.matched_invoice_id is not null and not (v_txn.matched_invoice_id = any(v_inv_ids)) then
    v_inv_ids := v_inv_ids || v_txn.matched_invoice_id;
  end if;
  if v_txn.matched_purchase_invoice_id is not null and not (v_txn.matched_purchase_invoice_id = any(v_pi_ids)) then
    v_pi_ids := v_pi_ids || v_txn.matched_purchase_invoice_id;
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

  -- TOEGEVOEGD (20261104010000): zette deze betaling de factuur op betaald en
  -- staat er nu weer iets open, dan gaat de factuur terug naar verzonden of
  -- achterstallig. GEWIJZIGD (20261107100000): elke factuur uit de verdeling.
  update public.invoices
  set status = case when due_date is not null and due_date < current_date then 'overdue' else 'sent' end,
      paid_at = null,
      updated_at = now()
  where organization_id = p_organization_id
    and id = any(v_inv_ids)
    and status = 'paid'
    and public.invoice_open_receivable_cents(p_organization_id, id) > 0;

  foreach v_id in array v_pi_ids
  loop
    perform public.refresh_purchase_invoice_payment_status(p_organization_id, v_id);
  end loop;

  return v_txn;
end;
$$;

-- ── 10. Negeren of weer openzetten ──────────────────────────────────────────
create or replace function public.set_bank_transaction_status(p_organization_id uuid, p_transaction_id uuid, p_status text)
returns public.bank_transactions
language plpgsql
security definer
set search_path = public
as $$
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
  -- TOEGEVOEGD (20261107100000)
  if v_txn.status = 'merged' then
    raise exception 'Deze banktransactie is samengevoegd met een handmatige mutatie. Maak dat eerst los als hij apart moet.' using errcode = '23514';
  end if;
  if p_status = 'ignored' and v_txn.is_manual
     and exists (select 1 from public.bank_transactions b where b.merged_into_id = v_txn.id) then
    raise exception 'Deze mutatie is bevestigd door de bank; negeren zou een echte bankmutatie verbergen. Maak het samenvoegen eerst los.'
      using errcode = '23514';
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

-- ── 11. Handmatige mutaties ─────────────────────────────────────────────────

-- Controle van wat iemand invoert; gedeeld door invoeren en bewerken.
create or replace function public.bank_manual_input_check(
  p_organization_id uuid,
  p_bank_account public.bank_accounts,
  p_booking_date date,
  p_amount_cents bigint,
  p_counterparty_name text,
  p_counterparty_iban text,
  p_description text
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_start date;
begin
  if not p_bank_account.is_active then
    raise exception 'Bankrekening % staat op inactief. Zet hem eerst weer aan.', p_bank_account.name using errcode = '23514';
  end if;
  if p_booking_date is null then
    raise exception 'Kies de datum van de mutatie.' using errcode = '23514';
  end if;
  if coalesce(p_amount_cents, 0) = 0 then
    raise exception 'Een mutatie heeft een bedrag nodig (niet € 0,00).' using errcode = '23514';
  end if;
  if abs(p_amount_cents) > 100000000000 then
    raise exception 'Een bedrag van % is vast een tikfout.', public.bank_eur(abs(p_amount_cents)) using errcode = '23514';
  end if;
  if p_booking_date > (current_date + interval '1 year')::date then
    raise exception 'Een datum meer dan een jaar vooruit (%) is vast een tikfout.', to_char(p_booking_date, 'DD-MM-YYYY') using errcode = '23514';
  end if;
  select cs.bookkeeping_start_date into v_start
  from public.company_settings cs where cs.organization_id = p_organization_id;
  if v_start is not null and p_booking_date < v_start then
    raise exception 'Je boekhouding in ResoFly begint op %. Wat daarvoor gebeurde, zit in de beginbalans; kies een datum vanaf die dag.', to_char(v_start, 'DD-MM-YYYY')
      using errcode = '23514';
  end if;
  if p_counterparty_name is null and p_description is null then
    raise exception 'Geef een tegenpartij of een omschrijving, zodat je de mutatie later terugvindt.' using errcode = '23514';
  end if;
  if length(coalesce(p_counterparty_name, '')) > 200 then
    raise exception 'De naam van de tegenpartij is te lang (hoogstens 200 tekens).' using errcode = '23514';
  end if;
  if length(coalesce(p_description, '')) > 1000 then
    raise exception 'De omschrijving is te lang (hoogstens 1000 tekens).' using errcode = '23514';
  end if;
  if p_counterparty_iban is not null and p_counterparty_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$' then
    raise exception 'IBAN % klopt niet. Laat het leeg als je het niet weet.', p_counterparty_iban using errcode = '23514';
  end if;
end;
$$;

create or replace function public.create_manual_bank_transaction(
  p_organization_id uuid,
  p_bank_account_id uuid,
  p_booking_date date,
  p_amount_cents bigint,
  p_counterparty_name text default null,
  p_counterparty_iban text default null,
  p_description text default null,
  p_allow_duplicate boolean default false,
  p_created_by uuid default auth.uid()
)
returns public.bank_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ba public.bank_accounts;
  v_txn public.bank_transactions;
  v_dup public.bank_transactions;
  v_id uuid := gen_random_uuid();
  v_name text := nullif(btrim(coalesce(p_counterparty_name, '')), '');
  v_iban text := nullif(upper(regexp_replace(coalesce(p_counterparty_iban, ''), '\s', '', 'g')), '');
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_ba from public.bank_accounts
  where id = p_bank_account_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Bankrekening niet gevonden.' using errcode = '02000';
  end if;
  perform public.bank_manual_input_check(p_organization_id, v_ba, p_booking_date, p_amount_cents, v_name, v_iban, v_desc);

  -- Staat dezelfde mutatie er al (van de bank of eerder ingevoerd)? Dan eerst
  -- vragen; anders stond hetzelfde geld er straks twee keer.
  if not coalesce(p_allow_duplicate, false) then
    select * into v_dup from public.bank_transactions t
    where t.organization_id = p_organization_id
      and t.bank_account_id = p_bank_account_id
      and t.amount_cents = p_amount_cents
      and t.status <> 'merged'
      and t.booking_date between p_booking_date - 7 and p_booking_date + 7
      and (v_iban is null or t.counterparty_iban is null
           or upper(regexp_replace(t.counterparty_iban, '\s', '', 'g')) = v_iban)
    order by abs(t.booking_date - p_booking_date), t.created_at desc
    limit 1;
    if found then
      raise exception 'Lijkt dubbel: op % staat al een % van % (%, %). Is dit een andere mutatie, voer hem dan toch in.',
        to_char(v_dup.booking_date, 'DD-MM-YYYY'),
        case when v_dup.amount_cents > 0 then 'ontvangst' else 'betaling' end,
        public.bank_eur(abs(v_dup.amount_cents)),
        coalesce(nullif(v_dup.counterparty_name, ''), nullif(v_dup.description, ''), 'zonder omschrijving'),
        case when v_dup.is_manual then 'handmatig ingevoerd'
             when v_dup.status = 'booked' then 'van de bank, geboekt'
             when v_dup.status = 'ignored' then 'van de bank, genegeerd'
             else 'van de bank, nog te boeken' end
        using errcode = 'P0001', hint = 'mogelijk_dubbel';
    end if;
  end if;

  insert into public.bank_transactions(
    id, organization_id, bank_account_id, statement_id, dedup_key, booking_date, value_date,
    amount_cents, currency, counterparty_name, counterparty_iban, description, status, is_manual, created_by
  ) values (
    v_id, p_organization_id, p_bank_account_id, null, 'm:' || v_id::text, p_booking_date, p_booking_date,
    p_amount_cents, coalesce(nullif(btrim(v_ba.currency), ''), 'EUR'), v_name, v_iban, v_desc, 'unmatched', true, p_created_by
  ) returning * into v_txn;

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (
    p_organization_id, coalesce(auth.uid(), p_created_by), 'created', 'bank_transaction', v_txn.id,
    left(coalesce(v_name, v_desc), 200),
    jsonb_build_object('wat', 'handmatig ingevoerd', 'bank_account_id', p_bank_account_id,
                       'booking_date', p_booking_date, 'amount_cents', p_amount_cents,
                       'toch_ingevoerd', coalesce(p_allow_duplicate, false))
  );

  -- Een voorstel (factuurnummer, bankregel, leverancier), maar niet al boeken
  -- terwijl de gebruiker nog kijkt.
  perform public.match_bank_transactions(p_organization_id, p_bank_account_id, p_created_by, v_txn.id, false);

  select * into v_txn from public.bank_transactions where id = v_txn.id;
  return v_txn;
end;
$$;

create or replace function public.update_manual_bank_transaction(
  p_organization_id uuid,
  p_transaction_id uuid,
  p_booking_date date,
  p_amount_cents bigint,
  p_counterparty_name text default null,
  p_counterparty_iban text default null,
  p_description text default null
)
returns public.bank_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions;
  v_ba public.bank_accounts;
  v_name text := nullif(btrim(coalesce(p_counterparty_name, '')), '');
  v_iban text := nullif(upper(regexp_replace(coalesce(p_counterparty_iban, ''), '\s', '', 'g')), '');
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_txn from public.bank_transactions
  where id = p_transaction_id and organization_id = p_organization_id for update;
  if not found then raise exception 'Banktransactie niet gevonden.' using errcode = '02000'; end if;
  if not v_txn.is_manual then
    raise exception 'Alleen een handmatige mutatie kun je bewerken; wat van de bank komt, blijft zoals de bank het gaf.' using errcode = '23514';
  end if;
  if v_txn.status = 'booked' then
    raise exception 'Deze mutatie is geboekt. Draai de boeking eerst terug; daarna kun je hem bewerken.' using errcode = '23514';
  end if;
  if exists (select 1 from public.bank_transactions b where b.merged_into_id = v_txn.id) then
    raise exception 'Deze mutatie is bevestigd door de bank. Maak het samenvoegen eerst los als hij anders moet.' using errcode = '23514';
  end if;

  select * into v_ba from public.bank_accounts where id = v_txn.bank_account_id and organization_id = p_organization_id;
  perform public.bank_manual_input_check(p_organization_id, v_ba, p_booking_date, p_amount_cents, v_name, v_iban, v_desc);

  update public.bank_transactions set
    booking_date = p_booking_date,
    value_date = p_booking_date,
    amount_cents = p_amount_cents,
    counterparty_name = v_name,
    counterparty_iban = v_iban,
    description = v_desc,
    status = case when status = 'ignored' then 'ignored' else 'unmatched' end,
    suggested_account_id = null,
    suggested_vat_code = null,
    matched_rule_id = null,
    match_confidence = null,
    matched_invoice_id = null,
    matched_purchase_invoice_id = null,
    updated_at = now()
  where id = v_txn.id;

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (
    p_organization_id, auth.uid(), 'updated', 'bank_transaction', v_txn.id,
    left(coalesce(v_name, v_desc), 200),
    jsonb_build_object('wat', 'handmatige mutatie bewerkt',
                       'was', jsonb_build_object('booking_date', v_txn.booking_date, 'amount_cents', v_txn.amount_cents,
                                                 'counterparty_name', v_txn.counterparty_name, 'description', v_txn.description),
                       'wordt', jsonb_build_object('booking_date', p_booking_date, 'amount_cents', p_amount_cents,
                                                   'counterparty_name', v_name, 'description', v_desc))
  );

  perform public.match_bank_transactions(p_organization_id, v_txn.bank_account_id, auth.uid(), v_txn.id, false);

  select * into v_txn from public.bank_transactions where id = v_txn.id;
  return v_txn;
end;
$$;

create or replace function public.delete_manual_bank_transaction(p_organization_id uuid, p_transaction_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_txn from public.bank_transactions
  where id = p_transaction_id and organization_id = p_organization_id for update;
  if not found then raise exception 'Banktransactie niet gevonden.' using errcode = '02000'; end if;
  if not v_txn.is_manual then
    raise exception 'Alleen een handmatige mutatie kun je verwijderen. Wat van de bank komt, blijft staan; negeer hem als hij niet meetelt.' using errcode = '23514';
  end if;
  if v_txn.status = 'booked' then
    raise exception 'Deze mutatie is geboekt. Draai de boeking eerst terug.' using errcode = '23514';
  end if;
  if exists (select 1 from public.bank_transactions b where b.merged_into_id = v_txn.id) then
    raise exception 'Deze mutatie is bevestigd door de bank. Maak het samenvoegen eerst los; daarna kun je hem verwijderen.' using errcode = '23514';
  end if;
  -- Bewaarplicht: een boeking die ooit is gemaakt en teruggedraaid, verwijst
  -- naar deze mutatie. Die geschiedenis blijft.
  if exists (
    select 1 from public.journal_entries je
    where je.organization_id = p_organization_id and je.source_type = 'payment' and je.source_id = v_txn.id
  ) or exists (select 1 from public.bank_transaction_allocations a where a.bank_transaction_id = v_txn.id) then
    raise exception 'Deze mutatie is eerder geboekt en teruggedraaid; die boekingen blijven bewaard en verwijzen ernaar. Zet hem op Negeren als hij niet meer meetelt.'
      using errcode = '23514';
  end if;

  delete from public.bank_transactions where id = v_txn.id;

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (
    p_organization_id, auth.uid(), 'deleted', 'bank_transaction', v_txn.id,
    left(coalesce(nullif(v_txn.counterparty_name, ''), nullif(v_txn.description, ''), 'Handmatige mutatie'), 200),
    jsonb_build_object('wat', 'handmatige mutatie verwijderd', 'bank_account_id', v_txn.bank_account_id,
                       'booking_date', v_txn.booking_date, 'amount_cents', v_txn.amount_cents)
  );
end;
$$;

-- Een bankregel en een handmatige mutatie met de hand samenvoegen (als de
-- matcher het niet zeker wist: twee kandidaten, ander IBAN, verder uit elkaar).
create or replace function public.merge_bank_transactions(
  p_organization_id uuid,
  p_bank_transaction_id uuid,
  p_manual_transaction_id uuid,
  p_created_by uuid default auth.uid()
)
returns public.bank_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bank public.bank_transactions;
  v_manual public.bank_transactions;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Vaste volgorde van vergrendelen, zodat twee gelijktijdige aanroepen niet op elkaar wachten.
  perform 1 from public.bank_transactions
  where id in (p_bank_transaction_id, p_manual_transaction_id) and organization_id = p_organization_id
  order by id for update;
  select * into v_bank from public.bank_transactions where id = p_bank_transaction_id and organization_id = p_organization_id;
  select * into v_manual from public.bank_transactions where id = p_manual_transaction_id and organization_id = p_organization_id;
  if v_bank.id is null or v_manual.id is null then
    raise exception 'Banktransactie niet gevonden.' using errcode = '02000';
  end if;
  if v_bank.is_manual then
    raise exception 'Kies als eerste de transactie die van de bank kwam.' using errcode = '23514';
  end if;
  if not v_manual.is_manual then
    raise exception 'Samenvoegen gaat met een mutatie die je zelf invoerde; twee transacties van de bank voeg je niet samen.' using errcode = '23514';
  end if;
  if v_bank.status = 'booked' then
    raise exception 'Deze banktransactie is al geboekt. Draai die boeking eerst terug, of laat de handmatige mutatie vallen.' using errcode = '23514';
  end if;
  if v_bank.status = 'merged' then
    raise exception 'Deze banktransactie is al samengevoegd.' using errcode = '23514';
  end if;
  if v_manual.status = 'ignored' then
    raise exception 'Je hebt de handmatige mutatie genegeerd. Zet hem eerst weer open.' using errcode = '23514';
  end if;
  if exists (select 1 from public.bank_transactions b where b.merged_into_id = v_manual.id) then
    raise exception 'De handmatige mutatie is al bevestigd door een andere banktransactie.' using errcode = '23514';
  end if;
  if v_bank.bank_account_id <> v_manual.bank_account_id then
    raise exception 'De twee transacties staan op verschillende bankrekeningen.' using errcode = '23514';
  end if;
  if v_bank.amount_cents <> v_manual.amount_cents then
    raise exception 'De bedragen verschillen (% bij de bank, % handmatig). Pas de handmatige mutatie eerst aan.',
      public.bank_eur(v_bank.amount_cents), public.bank_eur(v_manual.amount_cents) using errcode = '23514';
  end if;

  perform public.bank_merge_pair(p_organization_id, v_bank.id, v_manual.id, p_created_by, false);

  select * into v_manual from public.bank_transactions where id = v_manual.id;
  return v_manual;
end;
$$;

-- Losmaken: de bankregel staat weer open. Geef de bankregel of de handmatige
-- mutatie. Daarna voegt de matcher deze bankregel niet meer vanzelf samen.
create or replace function public.unmerge_bank_transaction(
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
  v_bank public.bank_transactions;
begin
  if auth.role() <> 'service_role' and not (public.can_write_org(p_organization_id) and public.can_write_module(p_organization_id, 'finance')) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_txn from public.bank_transactions
  where id = p_transaction_id and organization_id = p_organization_id;
  if not found then raise exception 'Banktransactie niet gevonden.' using errcode = '02000'; end if;
  if v_txn.is_manual then
    select * into v_bank from public.bank_transactions
    where merged_into_id = v_txn.id and organization_id = p_organization_id for update;
  else
    select * into v_bank from public.bank_transactions
    where id = v_txn.id and organization_id = p_organization_id for update;
  end if;
  if v_bank.id is null or v_bank.status <> 'merged' then
    raise exception 'Deze transactie is niet samengevoegd.' using errcode = '23514';
  end if;

  update public.bank_transactions set
    status = 'unmatched',
    merged_into_id = null,
    merged_at = null,
    merged_by = null,
    auto_merge_blocked = true,
    updated_at = now()
  where id = v_bank.id
  returning * into v_bank;

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (
    p_organization_id, coalesce(auth.uid(), p_created_by), 'updated', 'bank_transaction', coalesce(v_txn.merged_into_id, v_txn.id),
    left(coalesce(nullif(v_bank.counterparty_name, ''), nullif(v_bank.description, ''), 'Banktransactie'), 200),
    jsonb_build_object('wat', 'samenvoegen losgemaakt', 'bank_transaction_id', v_bank.id,
                       'booking_date', v_bank.booking_date, 'amount_cents', v_bank.amount_cents)
  );

  -- Een voorstel voor de losse bankregel, zonder automatisch te boeken: de
  -- handmatige mutatie kan al geboekt zijn.
  perform public.match_bank_transactions(p_organization_id, v_bank.bank_account_id, p_created_by, v_bank.id, false);

  select * into v_bank from public.bank_transactions where id = v_bank.id;
  return v_bank;
end;
$$;

-- ── 12. Wat staat er open om tegen af te letteren ───────────────────────────
-- Voor het verdeelscherm: openstaande verkoopfacturen, creditnota's met nog
-- terug te betalen tegoed en openstaande inkoopfacturen, met het bedrag dat de
-- boekfunctie ook rekent. Alleen voor wie Financiën mag lezen.
create or replace function public.bank_allocation_candidates(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sales jsonb;
  v_credit jsonb;
  v_purchase jsonb;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- Verkoopfacturen die nog geld moeten krijgen.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'number', x.number, 'date', x.date, 'due_date', x.due_date,
           'client_id', x.client_id, 'client_name', x.client_name,
           'total_cents', x.total_cents, 'open_cents', x.open_cents
         ) order by x.date desc, x.number desc), '[]'::jsonb)
  into v_sales
  from (
    select i.id, i.number, i.date, i.due_date, i.client_id, c.name as client_name,
           round(coalesce(i.total_amount, 0) * 100)::bigint as total_cents,
           public.invoice_open_receivable_cents(p_organization_id, i.id) as open_cents
    from public.invoices i
    left join public.clients c on c.id = i.client_id
    where i.organization_id = p_organization_id
      and i.journal_entry_id is not null
      and i.status in ('sent', 'overdue')
  ) x
  where x.open_cents > 0;

  -- Creditnota's waarvan de klant nog geld terug krijgt: het tegoed op de
  -- factuur, en per creditnota niet meer dan wat er nog niet terug is.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', y.id, 'number', y.number, 'date', y.date,
           'invoice_id', y.invoice_id, 'invoice_number', y.invoice_number,
           'client_id', y.client_id, 'client_name', y.client_name,
           'total_cents', y.total_cents, 'open_cents', y.refundable_cents
         ) order by y.date desc, y.number desc), '[]'::jsonb)
  into v_credit
  from (
    select cn.id, cn.number, cn.date, cn.invoice_id, i.number as invoice_number, i.client_id, c.name as client_name,
           round(coalesce(cn.total_amount, 0) * 100)::bigint as total_cents,
           least(
             greatest(-io.open_cents, 0),
             coalesce((
               select sum(jl.credit_cents - jl.debit_cents)
               from public.journal_lines jl
               join public.ledger_accounts la on la.id = jl.account_id and la.subtype = 'accounts_receivable'
               where jl.entry_id = cn.journal_entry_id
             ), 0) - coalesce((
               select sum(-a.amount_cents)
               from public.bank_transaction_allocations a
               join public.journal_entries je on je.id = a.journal_entry_id and je.status = 'posted'
                 and je.reversed_by_entry_id is null and je.reverses_entry_id is null
               where a.organization_id = p_organization_id and a.credit_note_id = cn.id
             ), 0)
           ) as refundable_cents
    from public.credit_notes cn
    join public.invoices i on i.id = cn.invoice_id and i.organization_id = p_organization_id
    left join public.clients c on c.id = i.client_id
    join public.journal_entries cje on cje.id = cn.journal_entry_id and cje.status = 'posted'
      and cje.reversed_by_entry_id is null and cje.reverses_entry_id is null
    cross join lateral (select public.invoice_open_receivable_cents(p_organization_id, i.id) as open_cents) io
    where cn.organization_id = p_organization_id
      and cn.status = 'issued'
  ) y
  where y.refundable_cents > 0;

  -- Inkoopfacturen: nog te betalen (positief) of nog terug te krijgen van de
  -- leverancier (negatief, een creditnota).
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', z.id, 'number', z.number, 'date', z.date, 'due_date', z.due_date,
           'supplier_id', z.supplier_id, 'supplier_name', z.supplier_name,
           'total_cents', z.total_cents, 'open_cents', z.open_cents
         ) order by z.date desc, z.number desc), '[]'::jsonb)
  into v_purchase
  from (
    select pi.id, coalesce(nullif(pi.internal_number, ''), nullif(pi.supplier_invoice_number, ''), '—') as number,
           pi.date, pi.due_date, pi.supplier_id, s.name as supplier_name, pi.total_cents,
           public.purchase_invoice_open_payable_cents(p_organization_id, pi.id) as open_cents
    from public.purchase_invoices pi
    left join public.suppliers s on s.id = pi.supplier_id
    join public.journal_entries pje on pje.id = pi.journal_entry_id and pje.reversed_by_entry_id is null
    where pi.organization_id = p_organization_id
      and pi.status <> 'cancelled'
      and pi.payment_status <> 'paid'
  ) z
  where z.open_cents <> 0;

  return jsonb_build_object('sales_invoices', v_sales, 'credit_notes', v_credit, 'purchase_invoices', v_purchase);
end;
$$;

-- ── 13. Saldo-aansluiting ───────────────────────────────────────────────────
-- GEWIJZIGD (20261107100000):
--   * een handmatige mutatie staat op geen afschrift: niet bij "nog te boeken"
--     of "genegeerd", niet bij de vermoedelijke dubbelen en niet in de
--     afschriftcontrole;
--   * een samengevoegde bankregel telt één keer: als "nog te boeken" zolang de
--     handmatige mutatie open staat, en anders niet (die staat in het grootboek);
--   * viel de handmatige boeking aan de andere kant van de peildatum dan de
--     bankregel, dan is dat een datumverschil (timing_*), geen fout;
--   * een geboekte handmatige mutatie die de bank niet bevestigde en vóór de
--     peildatum valt, verklaart een verschil (manual_unconfirmed_*).
create or replace function public.report_bank_reconciliation(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
as $$
declare
  v_out jsonb;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(s.row_json order by s.acc_name), '[]'::jsonb) into v_out
  from (
    select
      ba.name as acc_name,
      jsonb_build_object(
        'bank_account_id', ba.id,
        'name', ba.name,
        'iban', ba.iban,
        'source', ba.source,
        'ledger_code', la.code,
        'ledger_name', la.name,
        -- Meerdere bankrekeningen op dezelfde grootboekrekening (standaard boekt
        -- alles op 1100): dan is de stand van die rekening de SOM van beide en
        -- kun je niet per rekening aansluiten. De UI waarschuwt daarvoor.
        'shares_ledger_account', shr.shared,
        'as_of', st.period_end,
        'statement_id', st.id,
        'statement_closing_cents', st.closing_balance_cents,
        'ledger_balance_cents', led.balance_cents,
        'has_opening_balance', coalesce(led.has_opening, false),
        'unbooked_count', tx.unbooked_count,
        'unbooked_sum_cents', tx.unbooked_sum,
        'ignored_count', tx.ignored_count,
        'ignored_sum_cents', tx.ignored_sum,
        'booked_count', tx.booked_count,
        'manual_count', tx.manual_count,
        'timing_count', tim.n,
        'timing_sum_cents', tim.sum_cents,
        'manual_unconfirmed_count', man.n,
        'manual_unconfirmed_sum_cents', man.sum_cents,
        'expected_cents', led.balance_cents + tx.unbooked_sum + tx.ignored_sum + tim.sum_cents,
        -- Delen meerdere bankrekeningen dezelfde grootboekrekening, dan is die stand
        -- de SOM van al die rekeningen en is een verschil per rekening betekenisloos.
        -- Liever geen getal dan een fout getal: null, en de UI legt uit waarom.
        'difference_cents', case
          when st.closing_balance_cents is null or shr.shared then null
          else st.closing_balance_cents - (led.balance_cents + tx.unbooked_sum + tx.ignored_sum + tim.sum_cents)
        end,
        'duplicate_suspects', dup.n,
        'statement_issues', iss.items
      ) as row_json
    from public.bank_accounts ba
    join public.ledger_accounts la on la.id = ba.ledger_account_id
    cross join lateral (
      select count(*) > 1 as shared
      from public.bank_accounts b2
      where b2.organization_id = p_organization_id
        and b2.ledger_account_id = ba.ledger_account_id
    ) shr
    -- Laatste afschrift mét eindsaldo; dat is de peildatum van de aansluiting.
    left join lateral (
      select s2.id, s2.period_end, s2.closing_balance_cents
      from public.bank_statements s2
      where s2.bank_account_id = ba.id and s2.closing_balance_cents is not null
      order by s2.period_end desc nulls last, s2.imported_at desc
      limit 1
    ) st on true
    cross join lateral (
      select
        coalesce(sum(jl.debit_cents - jl.credit_cents), 0) as balance_cents,
        bool_or(je.source_type = 'opening_balance') as has_opening
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.entry_id and je.status = 'posted'
      where jl.organization_id = p_organization_id
        and jl.account_id = ba.ledger_account_id
        -- Tegenboekingsparen tellen niet mee. Sinds Blok A blijft het origineel
        -- 'posted' en krijgt de spiegelpost de datum van vandáág — die valt dus
        -- buiten de peildatum terwijl het origineel erbinnen valt. Zonder deze
        -- uitsluiting telt elke teruggedraaide bankboeking dubbel: één keer in het
        -- grootboek en nog eens in "nog te boeken". Een paar is netto nul, dus
        -- beide zijden weglaten is datumonafhankelijk correct.
        and je.reversed_by_entry_id is null
        and je.reverses_entry_id is null
        and (st.period_end is null or je.date <= st.period_end)
    ) led
    cross join lateral (
      select
        count(*) filter (where t.status = 'booked') as booked_count,
        count(*) filter (where t.is_manual) as manual_count,
        count(*) filter (where not t.is_manual and (t.status in ('unmatched','suggested')
                           or (t.status = 'merged' and m.status in ('unmatched','suggested')))) as unbooked_count,
        coalesce(sum(t.amount_cents) filter (where not t.is_manual and (t.status in ('unmatched','suggested')
                           or (t.status = 'merged' and m.status in ('unmatched','suggested')))), 0) as unbooked_sum,
        count(*) filter (where not t.is_manual and t.status = 'ignored') as ignored_count,
        coalesce(sum(t.amount_cents) filter (where not t.is_manual and t.status = 'ignored'), 0) as ignored_sum
      from public.bank_transactions t
      left join public.bank_transactions m on m.id = t.merged_into_id
      where t.bank_account_id = ba.id
        and (st.period_end is null or t.booking_date <= st.period_end)
    ) tx
    -- Samengevoegde paren waarvan de handmatige boeking aan de andere kant van
    -- de peildatum valt dan de bankregel: op het afschrift maar nog niet in het
    -- grootboek (+), of andersom (−).
    cross join lateral (
      select
        count(*) as n,
        coalesce(sum(case when r.booking_date <= st.period_end then r.amount_cents else -r.amount_cents end), 0) as sum_cents
      from public.bank_transactions r
      join public.bank_transactions m on m.id = r.merged_into_id and m.status = 'booked'
      join public.journal_entries mje on mje.id = m.journal_entry_id
      where r.bank_account_id = ba.id
        and r.status = 'merged'
        and st.period_end is not null
        and (r.booking_date <= st.period_end) <> (mje.date <= st.period_end)
    ) tim
    -- Geboekte handmatige mutaties die de bank (nog) niet bevestigde en vóór de
    -- peildatum vallen: die staan in het grootboek en niet op het afschrift.
    cross join lateral (
      select count(*) as n, coalesce(sum(m.amount_cents), 0) as sum_cents
      from public.bank_transactions m
      join public.journal_entries mje on mje.id = m.journal_entry_id
      where m.bank_account_id = ba.id
        and m.is_manual
        and m.status = 'booked'
        and st.period_end is not null
        and mje.date <= st.period_end
        and not exists (select 1 from public.bank_transactions r where r.merged_into_id = m.id)
    ) man
    -- Transacties die op inhoud identiek zijn (datum, bedrag, tegenrekening,
    -- omschrijving). Meestal een dubbele import; soms echt twee gelijke
    -- betalingen. Daarom melden, niet automatisch opruimen.
    cross join lateral (
      select coalesce(sum(d.c - 1), 0)::int as n
      from (
        select count(*) as c
        from public.bank_transactions t2
        where t2.bank_account_id = ba.id
          and not t2.is_manual
        group by public.bank_canonical_key(t2.booking_date, t2.amount_cents, t2.counterparty_iban, t2.description)
        having count(*) > 1
      ) d
    ) dup
    -- Afschriften die intern niet kloppen: beginsaldo + alle mutaties in de
    -- afschriftperiode ≠ eindsaldo. Op datumbereik (niet op statement_id), zodat
    -- overlappende imports geen vals alarm geven — zie de toelichting bij de
    -- afschriftcontrole in import_bank_transactions.
    cross join lateral (
      select coalesce(jsonb_agg(q.item order by q.period_start desc nulls last), '[]'::jsonb) as items
      from (
        select s3.period_start, jsonb_build_object(
          'statement_id', s3.id,
          'file_name', s3.file_name,
          'period_start', s3.period_start,
          'period_end', s3.period_end,
          'opening_balance_cents', s3.opening_balance_cents,
          'closing_balance_cents', s3.closing_balance_cents,
          'transactions_sum_cents', sums.sum_cents,
          'difference_cents', s3.closing_balance_cents - (s3.opening_balance_cents + sums.sum_cents)
        ) as item
        from public.bank_statements s3
        cross join lateral (
          select coalesce(sum(t3.amount_cents), 0) as sum_cents
          from public.bank_transactions t3
          where t3.bank_account_id = ba.id
            and not t3.is_manual
            and t3.booking_date between s3.period_start and s3.period_end
        ) sums
        where s3.bank_account_id = ba.id
          and s3.opening_balance_cents is not null
          and s3.closing_balance_cents is not null
          and s3.period_start is not null
          and s3.period_end is not null
          and s3.closing_balance_cents <> s3.opening_balance_cents + sums.sum_cents
        order by s3.period_start desc nulls last
        limit 5
      ) q
    ) iss
    where ba.organization_id = p_organization_id
  ) s;

  return v_out;
end;
$$;

-- ── 14. Openstaande posten ──────────────────────────────────────────────────
-- GEWIJZIGD (20261107100000): wat per factuur betaald is komt uit de verdeling,
-- met de datum van de boeking en van een eventuele tegenboeking (zoals de
-- grootboekregels op die peildatum). Eerder: alle debiteurenregels van een
-- boeking bij matched_invoice_id.
CREATE OR REPLACE FUNCTION public.report_open_items(p_organization_id uuid, p_as_of date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_recv_rows jsonb;
  v_recv_open bigint;
  v_recv_matched bigint;
  v_recv_gl bigint;
  v_pay_rows jsonb;
  v_pay_open bigint;
  v_pay_matched bigint;
  v_pay_gl bigint;
begin
  if auth.role() <> 'service_role'
     and not (public.can_read_org(p_organization_id) and public.can_read_module(p_organization_id, 'finance')) then
    raise exception 'Geen leesrechten voor deze organisatie.' using errcode = '42501';
  end if;

  -- ---------------- Debiteuren (1300) ----------------
  with ar_lines as (
    select je.source_type, je.source_id, jl.debit_cents, jl.credit_cents
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= p_as_of
      and la.subtype = 'accounts_receivable'
  ),
  inv_booked as (
    select source_id as invoice_id, sum(debit_cents - credit_cents)::bigint as amt
    from ar_lines where source_type = 'sales_invoice' group by 1
  ),
  inv_credited as (
    select cn.invoice_id, sum(al.credit_cents - al.debit_cents)::bigint as amt
    from ar_lines al
    join public.credit_notes cn on cn.organization_id = p_organization_id and cn.id = al.source_id
    where al.source_type = 'credit_note'
    group by 1
  ),
  inv_paid as (
    select a.invoice_id,
           sum(case when je.date <= p_as_of then a.amount_cents else 0 end
             - case when rev.status = 'posted' and rev.date <= p_as_of then a.amount_cents else 0 end)::bigint as amt
    from public.bank_transaction_allocations a
    join public.journal_entries je on je.id = a.journal_entry_id and je.status = 'posted'
    left join public.journal_entries rev on rev.id = je.reversed_by_entry_id
    where a.organization_id = p_organization_id
      and a.kind in ('sales_invoice', 'sales_credit_note')
      and a.invoice_id is not null
    group by 1
  ),
  -- TOEGEVOEGD (20261104020000): Mollie-betalingen, -terugbetalingen en
  -- -chargebacks boeken met de factuur zelf als bron. Zonder deze tak stond
  -- elke via Mollie betaalde factuur voorgoed als openstaand in de lijst.
  inv_psp as (
    select i.id as invoice_id, sum(al.credit_cents - al.debit_cents)::bigint as amt
    from ar_lines al
    join public.invoices i on i.organization_id = p_organization_id and i.id = al.source_id
    where al.source_type = 'payment'
    group by 1
  ),
  inv_rows as (
    select
      i.id, i.number, i.date, i.due_date, i.client_id, c.name as client_name,
      coalesce(b.amt, 0) as booked_cents,
      coalesce(p.amt, 0) + coalesce(pp.amt, 0) as paid_cents,
      coalesce(cr.amt, 0) as credited_cents,
      coalesce(b.amt, 0) - coalesce(p.amt, 0) - coalesce(pp.amt, 0) - coalesce(cr.amt, 0) as open_cents
    from public.invoices i
    left join inv_booked b on b.invoice_id = i.id
    left join inv_paid p on p.invoice_id = i.id
    left join inv_psp pp on pp.invoice_id = i.id
    left join inv_credited cr on cr.invoice_id = i.id
    left join public.clients c on c.id = i.client_id
    where i.organization_id = p_organization_id
      and (coalesce(b.amt, 0) <> 0 or coalesce(p.amt, 0) <> 0 or coalesce(pp.amt, 0) <> 0 or coalesce(cr.amt, 0) <> 0)
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'invoice_id', r.id, 'number', r.number, 'date', r.date, 'due_date', r.due_date,
      'client_id', r.client_id, 'client_name', r.client_name,
      'booked_cents', r.booked_cents, 'paid_cents', r.paid_cents,
      'credited_cents', r.credited_cents, 'open_cents', r.open_cents
    ) order by r.date, r.number) filter (where r.open_cents <> 0), '[]'::jsonb),
    coalesce(sum(r.open_cents), 0),
    coalesce(sum(r.booked_cents - r.paid_cents - r.credited_cents), 0),
    (select coalesce(sum(debit_cents - credit_cents), 0) from ar_lines)
  into v_recv_rows, v_recv_open, v_recv_matched, v_recv_gl
  from inv_rows r;

  -- ---------------- Crediteuren (1600) ----------------
  with ap_lines as (
    select je.source_type, je.source_id, jl.debit_cents, jl.credit_cents
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.entry_id
    join public.ledger_accounts la on la.id = jl.account_id
    where jl.organization_id = p_organization_id
      and je.status = 'posted'
      and je.date <= p_as_of
      and la.subtype = 'accounts_payable'
  ),
  pi_booked as (
    select source_id as pi_id, sum(credit_cents - debit_cents)::bigint as amt
    from ap_lines where source_type = 'purchase_invoice' group by 1
  ),
  pi_paid as (
    select a.purchase_invoice_id as pi_id,
           sum(case when je.date <= p_as_of then -a.amount_cents else 0 end
             - case when rev.status = 'posted' and rev.date <= p_as_of then -a.amount_cents else 0 end)::bigint as amt
    from public.bank_transaction_allocations a
    join public.journal_entries je on je.id = a.journal_entry_id and je.status = 'posted'
    left join public.journal_entries rev on rev.id = je.reversed_by_entry_id
    where a.organization_id = p_organization_id
      and a.kind = 'purchase_invoice'
    group by 1
  ),
  pi_rows as (
    select
      pi.id, coalesce(pi.supplier_invoice_number, pi.internal_number) as number,
      pi.date, pi.due_date, pi.supplier_id, s.name as supplier_name,
      coalesce(b.amt, 0) as booked_cents,
      coalesce(p.amt, 0) as paid_cents,
      coalesce(b.amt, 0) - coalesce(p.amt, 0) as open_cents
    from public.purchase_invoices pi
    left join pi_booked b on b.pi_id = pi.id
    left join pi_paid p on p.pi_id = pi.id
    left join public.suppliers s on s.id = pi.supplier_id
    where pi.organization_id = p_organization_id
      and (coalesce(b.amt, 0) <> 0 or coalesce(p.amt, 0) <> 0)
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'purchase_invoice_id', r.id, 'number', r.number, 'date', r.date, 'due_date', r.due_date,
      'supplier_id', r.supplier_id, 'supplier_name', r.supplier_name,
      'booked_cents', r.booked_cents, 'paid_cents', r.paid_cents, 'open_cents', r.open_cents
    ) order by r.date, r.number) filter (where r.open_cents <> 0), '[]'::jsonb),
    coalesce(sum(r.open_cents), 0),
    coalesce(sum(r.booked_cents - r.paid_cents), 0),
    (select coalesce(sum(credit_cents - debit_cents), 0) from ap_lines)
  into v_pay_rows, v_pay_open, v_pay_matched, v_pay_gl
  from pi_rows r;

  return jsonb_build_object(
    'as_of', p_as_of,
    'receivables', jsonb_build_object(
      'rows', v_recv_rows,
      'open_total_cents', v_recv_open,
      'gl_balance_cents', v_recv_gl,
      -- Beweging op 1300 die niet aan een factuur toe te rekenen is
      -- (beginbalans, vrije boekingen): het gat tussen lijst en grootboek.
      'unmatched_cents', v_recv_gl - v_recv_matched
    ),
    'payables', jsonb_build_object(
      'rows', v_pay_rows,
      'open_total_cents', v_pay_open,
      'gl_balance_cents', v_pay_gl,
      'unmatched_cents', v_pay_gl - v_pay_matched
    )
  );
end;
$function$;

-- ── 15. Tegenboeken: een betaalde inkoopfactuur ─────────────────────────────
-- GEWIJZIGD (20261107100000): "er is al op betaald" kijkt naar de verdeling, zodat
-- ook een verzamelbetaling over meerdere inkoopfacturen telt. Verder gelijk aan
-- 20261105233000.
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
  v_context text;
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
  -- TOEGEVOEGD (20261105233000): een verkoopfactuur en een creditnota zijn
  -- uitgegeven stukken. Los tegenboeken liet de factuur op 'verzonden' staan
  -- met de boeking er nog aan: opnieuw boeken kon niet meer, het openstaande
  -- bedrag werd 0, en daarmee weigerden crediteren, herinneren en de
  -- betaallink. De btw bleef verschuldigd (art. 37 Wet OB 1968), terwijl de
  -- aangifte hem kwijt was. Een betaling heeft een eigen terugweg ("Boeking
  -- ongedaan maken" bij de bank, of een terugbetaling); los tegenboeken liet de
  -- factuur op betaald staan. Die twee interne functies gebruiken deze functie
  -- zelf en mogen dus wel.
  if v_src.source_type in ('sales_invoice', 'credit_note', 'payment') then
    get diagnostics v_context = pg_context;
    if v_context !~* 'function (public\.)?(unbook_bank_transaction|recompute_invoice_chargeback_state)\(' then
      if v_src.source_type = 'sales_invoice' then
        raise exception 'Een verkoopfactuur boek je niet tegen: de factuur is uitgegeven en de btw blijft verschuldigd. Corrigeer met "Crediteren" bij de factuur; dat boekt omzet en btw netjes terug.'
          using errcode = '23514';
      elsif v_src.source_type = 'credit_note' then
        raise exception 'Een creditnota boek je niet tegen: die is uitgegeven. Maak zo nodig een nieuwe factuur.'
          using errcode = '23514';
      else
        raise exception 'Een betaling boek je hier niet tegen. Bij de bank: "Boeking ongedaan maken" bij de transactie. Een Mollie-betaling draai je terug met een terugbetaling.'
          using errcode = '23514';
      end if;
    end if;
  end if;
  -- TOEGEVOEGD (20261105233000): een geboekte inkoopfactuur ligt vast, en de
  -- bewaker verwijst voor een correctie naar tegenboeken. Daarna bleef de
  -- factuur op 'geboekt' staan, met de oude boeking eraan: corrigeren of
  -- opnieuw boeken kon nooit meer. Nu gaat hij mee terug naar concept
  -- (onderaan). Is er al op betaald, dan eerst die betaling: anders blijft de
  -- betaling op 1600 staan zonder factuur ertegenover.
  -- GEWIJZIGD (20261107100000): uit de verdeling, zodat een betaling over
  -- meerdere inkoopfacturen ook telt; de oude kolom blijft als vangnet.
  if v_src.source_type = 'purchase_invoice' and (exists (
    select 1 from public.bank_transaction_allocations a
    join public.journal_entries pje on pje.id = a.journal_entry_id and pje.status = 'posted'
      and pje.reversed_by_entry_id is null and pje.reverses_entry_id is null
    where a.organization_id = v_src.organization_id
      and a.purchase_invoice_id = v_src.source_id
  ) or exists (
    select 1 from public.bank_transactions bt
    where bt.organization_id = v_src.organization_id
      and bt.matched_purchase_invoice_id = v_src.source_id
      and bt.status = 'booked'
  )) then
    raise exception 'Op deze inkoopfactuur is al een betaling afgeletterd. Draai eerst die betaling terug (Bank: "Boeking ongedaan maken"); daarna de inkoopfactuur.'
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

  -- TOEGEVOEGD (20261105233000): de inkoopfactuur gaat terug naar concept, zodat
  -- je hem kunt corrigeren en opnieuw boeken. De inbox volgt.
  if v_src.source_type = 'purchase_invoice' then
    update public.purchase_invoices
    set status = 'draft', journal_entry_id = null, payment_status = 'unpaid', paid_at = null
    where id = v_src.source_id and organization_id = v_src.organization_id
      and journal_entry_id = v_src.id;
    update public.purchase_invoice_inbox
    set status = 'ready'
    where purchase_invoice_id = v_src.source_id and organization_id = v_src.organization_id
      and status = 'booked';
  end if;

  return v_reversal;
end;
$function$;

-- ── 16. Auditlog: handmatige mutaties horen bij Financiën ───────────────────
-- Gelijk aan 20261106173000, plus 'bank_transaction' (invoeren, bewerken,
-- verwijderen, samenvoegen en losmaken van handmatige mutaties).
create or replace function public.audit_entity_module(p_entity_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_entity_type in ('member', 'organization') then null
    when p_entity_type in ('api_key', 'webhook_endpoint', 'invitation', 'calendar_connection', 'mollie_connection', 'subscription',
                           'billing_profile', 'billing_event', 'payment', 'license_change', 'license_event') then 'admin'
    when p_entity_type in ('annual_account', 'annual_account_filing', 'annual_account_signature', 'bank_account', 'bank_rule',
                           'bank_transaction', 'company_settings', 'contract', 'contract_note', 'contract_project', 'contract_template',
                           'corporate_tax_return', 'credit_note', 'dividend_distribution', 'fiscal_year', 'fiscal_year_size_input',
                           'fixed_asset', 'invoice', 'journal_entry', 'ledger_account', 'partnership_partner', 'purchase_invoice', 'quote',
                           'result_appropriation', 'share_transaction', 'shareholder', 'supplier', 'vat_return') then 'finance'
    when p_entity_type in ('calendar_event', 'calendar_event_link', 'calendar_source', 'note_calendar_link') then 'calendar'
    when p_entity_type in ('client', 'client_call', 'client_contact') then 'clients'
    when p_entity_type in ('project', 'project_member', 'project_template', 'project_template_task', 'task', 'task_assignee') then 'projects'
    when p_entity_type in ('ticket', 'ticket_note') then 'tickets'
    when p_entity_type in ('time_entry') then 'time'
    when p_entity_type in ('attachment', 'content_folder', 'document', 'drive_share', 'file_transfer', 'note', 'note_handwriting') then 'content'
    when p_entity_type in ('saved_report') then 'stats'
    else 'admin'
  end;
$$;

-- ── 17. Rechten ─────────────────────────────────────────────────────────────
-- Elke functie hierboven dicht voor anon (en PUBLIC); wat de app aanroept voor
-- ingelogde gebruikers, de rest alleen voor de server.

-- Triggerfuncties: de trigger vuurt toch.
revoke all on function public.bank_transactions_merge_guard() from public, anon, authenticated;
revoke all on function public.bank_transaction_allocations_immutable() from public, anon, authenticated;

-- Interne hulpjes: alleen vanuit de functies hierboven (en de server).
revoke all on function public.bank_parse_uuid(text) from public, anon, authenticated;
revoke all on function public.bank_eur(bigint) from public, anon, authenticated;
revoke all on function public.bank_merge_pair(uuid, uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.merge_manual_bank_transactions(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.bank_manual_input_check(uuid, public.bank_accounts, date, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.invoice_open_receivable_cents(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.purchase_invoice_open_payable_cents(uuid, uuid) from public, anon, authenticated;
revoke all on function public.refresh_purchase_invoice_payment_status(uuid, uuid) from public, anon, authenticated;
grant execute on function public.bank_parse_uuid(text) to service_role;
grant execute on function public.bank_eur(bigint) to service_role;
grant execute on function public.bank_merge_pair(uuid, uuid, uuid, uuid, boolean) to service_role;
grant execute on function public.merge_manual_bank_transactions(uuid, uuid, uuid) to service_role;
grant execute on function public.bank_manual_input_check(uuid, public.bank_accounts, date, bigint, text, text, text) to service_role;
grant execute on function public.invoice_open_receivable_cents(uuid, uuid, uuid) to service_role;
grant execute on function public.purchase_invoice_open_payable_cents(uuid, uuid) to service_role;
grant execute on function public.refresh_purchase_invoice_payment_status(uuid, uuid) to service_role;

-- Wat de app, Gerrie en de API aanroepen.
revoke all on function public.match_bank_transactions(uuid, uuid, uuid, uuid, boolean) from public, anon;
revoke all on function public.import_bank_transactions(uuid, uuid, jsonb, jsonb, uuid) from public, anon;
revoke all on function public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid, jsonb, text) from public, anon;
revoke all on function public.unbook_bank_transaction(uuid, uuid, uuid) from public, anon;
revoke all on function public.set_bank_transaction_status(uuid, uuid, text) from public, anon;
revoke all on function public.create_manual_bank_transaction(uuid, uuid, date, bigint, text, text, text, boolean, uuid) from public, anon;
revoke all on function public.update_manual_bank_transaction(uuid, uuid, date, bigint, text, text, text) from public, anon;
revoke all on function public.delete_manual_bank_transaction(uuid, uuid) from public, anon;
revoke all on function public.merge_bank_transactions(uuid, uuid, uuid, uuid) from public, anon;
revoke all on function public.unmerge_bank_transaction(uuid, uuid, uuid) from public, anon;
revoke all on function public.bank_allocation_candidates(uuid) from public, anon;
revoke all on function public.report_bank_reconciliation(uuid) from public, anon;
revoke all on function public.report_open_items(uuid, date) from public, anon;
revoke all on function public.reverse_journal_entry(uuid, date, uuid) from public, anon;
revoke all on function public.audit_entity_module(text) from public, anon;
grant execute on function public.match_bank_transactions(uuid, uuid, uuid, uuid, boolean) to authenticated, service_role;
grant execute on function public.import_bank_transactions(uuid, uuid, jsonb, jsonb, uuid) to authenticated, service_role;
grant execute on function public.book_bank_transaction(uuid, uuid, jsonb, uuid, uuid, uuid, jsonb, text) to authenticated, service_role;
grant execute on function public.unbook_bank_transaction(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.set_bank_transaction_status(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.create_manual_bank_transaction(uuid, uuid, date, bigint, text, text, text, boolean, uuid) to authenticated, service_role;
grant execute on function public.update_manual_bank_transaction(uuid, uuid, date, bigint, text, text, text) to authenticated, service_role;
grant execute on function public.delete_manual_bank_transaction(uuid, uuid) to authenticated, service_role;
grant execute on function public.merge_bank_transactions(uuid, uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.unmerge_bank_transaction(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.bank_allocation_candidates(uuid) to authenticated, service_role;
grant execute on function public.report_bank_reconciliation(uuid) to authenticated, service_role;
grant execute on function public.report_open_items(uuid, date) to authenticated, service_role;
grant execute on function public.reverse_journal_entry(uuid, date, uuid) to authenticated, service_role;
grant execute on function public.audit_entity_module(text) to authenticated, service_role;

commit;
