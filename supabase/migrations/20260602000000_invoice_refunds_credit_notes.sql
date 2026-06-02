-- ============================================================
-- ResoFly — Terugbetalingen (refunds) + creditfacturen (Fase 1)
-- Date: 2026-06-02
--
-- Scope (Fase 1 — boekhoudkundig fundament):
-- - invoice_refunds: ledger met één rij per (deel)terugbetaling. Meerdere
--   refunds per factuur zijn toegestaan (Mollie staat partial refunds toe).
-- - credit_notes: formele creditfactuur met eigen CN-nummerreeks en PDF-snapshot,
--   hergebruikt dezelfde opslag/pipeline als de factuur-PDF.
-- - Aggregaten: invoice_payment_records.amount_refunded_cents en
--   invoices.refunded_amount / refunded_at, autoritatief herberekend.
-- - Factuurstatus 'refunded' (alleen bij volledige terugbetaling). Gedeeltelijk
--   blijft 'paid' + refunded_amount > 0 (afgeleide badge in de UI).
-- - RPC's: begin/complete/fail_invoice_refund, recompute_invoice_refund_state,
--   issue_credit_note + CN-nummering.
--
-- Bewust voorbereid op Fase 2 (Mollie-uitvoering) en Fase 3 (chargebacks):
-- invoice_refunds.kind onderscheidt 'manual' van 'mollie' en de statusset
-- spiegelt de Mollie refund-lifecycle (queued/pending/processing/refunded/
-- failed/canceled). De edge function gebruikt in Fase 1 alleen het manuele pad.
--
-- Alle schrijfacties lopen via SECURITY DEFINER RPC's (service_role). Op de
-- nieuwe tabellen staat daarom BEWUST alleen een SELECT-policy (can_read_org):
-- terugbetalingen mogen nooit rechtstreeks via PostgREST worden ingevoerd,
-- alleen via de gevalideerde RPC's achter de invoice-workflow Edge Function.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. Aggregaatkolommen op bestaande tabellen
-- ------------------------------------------------------------
alter table public.invoice_payment_records
  add column if not exists amount_refunded_cents integer not null default 0
    check (amount_refunded_cents >= 0);

alter table public.invoices
  add column if not exists refunded_amount numeric(12,2) not null default 0,
  add column if not exists refunded_at timestamptz;

-- Factuurstatus 'refunded' toestaan (volledige terugbetaling). Gedeeltelijke
-- terugbetaling laat de status op 'paid' staan.
alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices
  add constraint invoices_status_check
  check (status in ('draft','sent','overdue','paid','cancelled','void','written_off','refunded'));

-- ------------------------------------------------------------
-- 2. Event- en audit-vocabulaire uitbreiden
-- ------------------------------------------------------------
alter table public.invoice_workflow_events drop constraint if exists invoice_workflow_events_event_type_check;
alter table public.invoice_workflow_events
  add constraint invoice_workflow_events_event_type_check
  check (event_type in (
    'created_from_quote','public_token_created','public_link_created','sent_to_client',
    'email_sent','email_delivered','email_opened','email_clicked','email_bounced','email_failed','email_complained',
    'client_viewed','payment_link_created','payment_open','payment_paid','payment_failed','payment_expired',
    'invoice_version_created','invoice_pdf_attached','locked','expired','cancelled','void','written_off',
    'payment_refunded','credit_note_issued'
  ));

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.audit_logs'::regclass
      and conname = 'audit_logs_action_check'
  ) then
    alter table public.audit_logs drop constraint audit_logs_action_check;
  end if;

  alter table public.audit_logs
    add constraint audit_logs_action_check
    check (action in (
      'created','updated','deleted','invited','accepted','revoked','role_changed','disabled','expired',
      'mollie_connected','plan_changed','seat_purchased','seat_downgrade_requested',
      'payment_succeeded','payment_failed','payment_expired','subscription_cancelled',
      'licensed_seats_changed','invitation_blocked_insufficient_seats','billing_synced',
      'quote_submitted_for_approval','quote_internal_approved','quote_internal_rejected',
      'quote_sent_to_client','quote_client_accepted','quote_client_rejected',
      'quote_email_delivered','quote_email_failed','quote_version_created','quote_pdf_attached',
      'invoice_created_from_quote','invoice_sent_to_client','invoice_payment_link_created','invoice_paid',
      'invoice_refunded','credit_note_issued'
    ));
end $$;

-- ------------------------------------------------------------
-- 3. Tabel: invoice_refunds (ledger)
-- ------------------------------------------------------------
create table if not exists public.invoice_refunds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  -- Null voor offline/handmatige terugbetalingen die nooit een Mollie-payment raken.
  payment_record_id uuid references public.invoice_payment_records(id) on delete set null,
  kind text not null default 'manual' check (kind in ('manual','mollie')),
  provider text not null default 'mollie',
  provider_refund_id text,
  status text not null default 'queued'
    check (status in ('queued','pending','processing','refunded','failed','canceled')),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'EUR',
  reason text,
  credit_note_id uuid, -- FK toegevoegd nadat credit_notes bestaat
  idempotency_key text,
  refunded_at timestamptz,
  failed_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  initiated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_invoice_refunds_invoice
  on public.invoice_refunds(organization_id, invoice_id, created_at desc);
create index if not exists idx_invoice_refunds_payment
  on public.invoice_refunds(payment_record_id) where payment_record_id is not null;
create unique index if not exists idx_invoice_refunds_provider
  on public.invoice_refunds(provider, provider_refund_id) where provider_refund_id is not null;
create unique index if not exists idx_invoice_refunds_idempotency
  on public.invoice_refunds(organization_id, invoice_id, idempotency_key) where idempotency_key is not null;

alter table public.invoice_refunds enable row level security;

drop policy if exists "invoice refunds read" on public.invoice_refunds;
create policy "invoice refunds read" on public.invoice_refunds
  for select using (public.can_read_org(organization_id));

-- ------------------------------------------------------------
-- 4. Creditfactuur-nummerreeks (eigen CN-reeks, los van de FAC-reeks)
-- ------------------------------------------------------------
create table if not exists public.organization_credit_note_number_sequences (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  credit_note_year integer not null,
  prefix text not null default 'CN',
  padding integer not null default 4 check (padding between 1 and 12),
  next_number integer not null default 1 check (next_number > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, credit_note_year)
);

alter table public.organization_credit_note_number_sequences enable row level security;

drop policy if exists "credit note sequences read by org admins" on public.organization_credit_note_number_sequences;
create policy "credit note sequences read by org admins"
  on public.organization_credit_note_number_sequences
  for select
  using (public.can_admin_org(organization_id));

-- Hergebruikt de generieke format/extract helpers uit de factuurnummering
-- (public.format_invoice_number / public.extract_invoice_sequence_number) met
-- prefix 'CN', zodat er één consistente nummerlogica is.
create or replace function public.reconcile_credit_note_number_sequence(p_organization_id uuid, p_year integer default extract(year from current_date)::integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_number integer;
begin
  if p_organization_id is null then
    raise exception 'Organisatie ontbreekt voor creditfactuurnummerreeks.' using errcode = '23514';
  end if;

  select greatest(coalesce(max(public.extract_invoice_sequence_number(number, 'CN', p_year)), 0) + 1, 1)
    into v_next_number
  from public.credit_notes
  where organization_id = p_organization_id;

  insert into public.organization_credit_note_number_sequences(organization_id, credit_note_year, prefix, padding, next_number)
  values (p_organization_id, p_year, 'CN', 4, v_next_number)
  on conflict (organization_id, credit_note_year) do update
    set next_number = greatest(public.organization_credit_note_number_sequences.next_number, excluded.next_number),
        updated_at = now();
end;
$$;

create or replace function public.allocate_next_credit_note_number(p_organization_id uuid, p_issue_date date default current_date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year integer := extract(year from coalesce(p_issue_date, current_date))::integer;
  v_sequence public.organization_credit_note_number_sequences;
  v_number integer;
  v_credit_note_number text;
begin
  if p_organization_id is null then
    raise exception 'Organisatie ontbreekt voor creditfactuurnummerreeks.' using errcode = '23514';
  end if;

  perform public.reconcile_credit_note_number_sequence(p_organization_id, v_year);

  select * into v_sequence
  from public.organization_credit_note_number_sequences
  where organization_id = p_organization_id and credit_note_year = v_year
  for update;

  if not found then
    raise exception 'Creditfactuurnummerreeks kon niet worden geladen.' using errcode = 'P0002';
  end if;

  v_number := greatest(v_sequence.next_number, 1);
  v_credit_note_number := public.format_invoice_number(v_sequence.prefix, v_year, v_number, v_sequence.padding);

  while exists (
    select 1
    from public.credit_notes cn
    where cn.organization_id = p_organization_id
      and upper(btrim(cn.number)) = upper(btrim(v_credit_note_number))
  ) loop
    v_number := v_number + 1;
    v_credit_note_number := public.format_invoice_number(v_sequence.prefix, v_year, v_number, v_sequence.padding);
  end loop;

  update public.organization_credit_note_number_sequences
     set next_number = v_number + 1,
         updated_at = now()
   where organization_id = p_organization_id
     and credit_note_year = v_year;

  return v_credit_note_number;
end;
$$;

-- ------------------------------------------------------------
-- 5. Tabel: credit_notes (creditfactuur)
-- ------------------------------------------------------------
create table if not exists public.credit_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  refund_id uuid references public.invoice_refunds(id) on delete set null,
  number text not null,
  date date not null default current_date,
  reason text,
  currency text not null default 'EUR',
  -- Bedragen worden POSITIEF opgeslagen; de semantiek van het document is "credit"
  -- (terug te betalen aan de klant). De PDF en UI tonen het als negatief/credit.
  subtotal_amount numeric(12,2) not null default 0,
  vat_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  lines jsonb not null default '[]'::jsonb,
  status text not null default 'issued' check (status in ('draft','issued','void')),
  pdf_file_name text,
  pdf_mime_type text,
  pdf_size_bytes integer,
  pdf_sha256 text,
  pdf_data_base64 text,
  pdf_storage_provider text,
  pdf_storage_key text,
  issued_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, number)
);

create index if not exists idx_credit_notes_invoice
  on public.credit_notes(organization_id, invoice_id, created_at desc);
create index if not exists idx_credit_notes_refund
  on public.credit_notes(refund_id) where refund_id is not null;

alter table public.credit_notes enable row level security;

drop policy if exists "credit notes read" on public.credit_notes;
create policy "credit notes read" on public.credit_notes
  for select using (public.can_read_org(organization_id));

-- Nu credit_notes bestaat: koppel invoice_refunds.credit_note_id eraan.
alter table public.invoice_refunds
  drop constraint if exists invoice_refunds_credit_note_fk,
  add constraint invoice_refunds_credit_note_fk
    foreign key (credit_note_id) references public.credit_notes(id) on delete set null;

-- updated_at triggers (conventie public.set_updated_at()).
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'invoice_refunds_updated_at') then
    create trigger invoice_refunds_updated_at before update on public.invoice_refunds
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'credit_notes_updated_at') then
    create trigger credit_notes_updated_at before update on public.credit_notes
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'organization_credit_note_number_sequences_updated_at') then
    create trigger organization_credit_note_number_sequences_updated_at before update on public.organization_credit_note_number_sequences
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- ------------------------------------------------------------
-- 6. Immutability-guard uitbreiden: een 'refunded' factuur is vergrendeld.
-- ------------------------------------------------------------
create or replace function public.enforce_invoice_immutability()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_has_active_or_paid_payment boolean;
  v_is_locked boolean;
begin
  if TG_OP <> 'UPDATE' then
    return new;
  end if;

  select exists (
    select 1
    from public.invoice_payment_records p
    where p.organization_id = old.organization_id
      and p.invoice_id = old.id
      and p.status in ('creating','open','pending','authorized','paid','refunded','charged_back')
  ) into v_has_active_or_paid_payment;

  v_is_locked := old.locked_at is not null
    or old.status in ('sent','overdue','paid','cancelled','void','written_off','refunded')
    or v_has_active_or_paid_payment;

  if v_is_locked then
    if old.number is distinct from new.number
      or old.client_id is distinct from new.client_id
      or old.project_id is distinct from new.project_id
      or old.quote_id is distinct from new.quote_id
      or old.date is distinct from new.date
      or old.due_date is distinct from new.due_date
      or old.lines is distinct from new.lines
      or old.notes is distinct from new.notes
      or old.currency is distinct from new.currency then
      raise exception 'Deze factuur is vergrendeld. Maak een nieuwe/creditfactuur of formele versie in plaats van de verzonden factuur te wijzigen.' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

-- ------------------------------------------------------------
-- 7. invoice_total_cents — brutototaal (incl. btw) in centen uit de regels
-- ------------------------------------------------------------
-- Spiegelt BEWUST de rekenwijze van de frontend/Edge Function (calculateTotals):
-- netto per regel naar centen afronden, btw per tarief over de gesommeerde basis
-- afronden. Zo is het "betaalde" bedrag dat de over-refund-guard hanteert exact
-- gelijk aan het totaal dat de gebruiker in de UI ziet — geen 1-cent-afwijking.
create or replace function public.invoice_total_cents(p_invoice public.invoices)
returns bigint
language plpgsql
immutable
as $$
declare
  v_subtotal_cents bigint := 0;
  v_vat_cents bigint := 0;
  r record;
begin
  select coalesce(sum(round(
           coalesce(nullif(elem->>'quantity','')::numeric, 0)
           * coalesce(nullif(elem->>'unit_price','')::numeric, 0) * 100)), 0)
    into v_subtotal_cents
  from jsonb_array_elements(coalesce(p_invoice.lines, '[]'::jsonb)) as t(elem);

  for r in
    select coalesce(nullif(elem->>'vat','')::numeric, 0) as rate,
           sum(round(
             coalesce(nullif(elem->>'quantity','')::numeric, 0)
             * coalesce(nullif(elem->>'unit_price','')::numeric, 0) * 100)) as base_cents
    from jsonb_array_elements(coalesce(p_invoice.lines, '[]'::jsonb)) as t(elem)
    group by 1
  loop
    -- btw_centen = round(netto_centen * tarief% / 100); spiegelt toCents((base/100)*(rate/100)).
    v_vat_cents := v_vat_cents + round(r.base_cents * r.rate / 100)::bigint;
  end loop;

  return v_subtotal_cents + v_vat_cents;
end;
$$;

-- ------------------------------------------------------------
-- 8. recompute_invoice_refund_state — autoritatieve herberekening
-- ------------------------------------------------------------
-- Telt alleen settled refunds (status = 'refunded') mee voor het daadwerkelijk
-- terugbetaalde bedrag. In-flight refunds (queued/pending/processing) tellen NIET
-- mee in refunded_amount, maar worden wel meegewogen bij het blokkeren van
-- dubbel terugbetalen (zie begin_invoice_refund).
create or replace function public.recompute_invoice_refund_state(p_invoice_id uuid, p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_refunded_cents bigint;
  v_paid_cents bigint;
begin
  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;
  if not found then return; end if;

  -- Totaal daadwerkelijk terugbetaald (alleen settled refunds).
  select coalesce(sum(amount_cents), 0) into v_refunded_cents
  from public.invoice_refunds
  where invoice_id = p_invoice_id and organization_id = p_organization_id
    and status = 'refunded';

  -- Per Mollie-betaalrecord het terugbetaalde deel bijwerken.
  update public.invoice_payment_records p
     set amount_refunded_cents = coalesce((
           select sum(r.amount_cents) from public.invoice_refunds r
           where r.payment_record_id = p.id and r.status = 'refunded'
         ), 0),
         updated_at = now()
   where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id;

  -- Betaald bedrag: voorkeur voor de som van betaalde/terugbetaalde Mollie-records,
  -- val terug op het factuurtotaal (offline betaald zonder Mollie-record).
  select coalesce(
           nullif(sum(amount_cents) filter (where status in ('paid','refunded','charged_back')), 0),
           public.invoice_total_cents(v_invoice)
         )
    into v_paid_cents
  from public.invoice_payment_records
  where invoice_id = p_invoice_id and organization_id = p_organization_id;

  update public.invoices
     set refunded_amount = round(v_refunded_cents::numeric / 100, 2),
         refunded_at = case when v_refunded_cents > 0 then coalesce(refunded_at, now()) else null end,
         status = case
                    when v_refunded_cents > 0 and v_refunded_cents >= v_paid_cents then 'refunded'
                    when status = 'refunded' and v_refunded_cents < v_paid_cents then 'paid'
                    else status
                  end,
         locked_at = case when v_refunded_cents > 0 then coalesce(locked_at, now()) else locked_at end,
         locked_reason = case when v_refunded_cents > 0 then coalesce(locked_reason, 'refunded') else locked_reason end,
         updated_at = now()
   where id = p_invoice_id and organization_id = p_organization_id;

  -- Een volledig terugbetaald Mollie-record naar 'refunded' tillen.
  update public.invoice_payment_records p
     set status = 'refunded',
         updated_at = now()
   where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id
     and p.status = 'paid'
     and p.amount_refunded_cents >= p.amount_cents
     and p.amount_cents > 0;
end;
$$;

-- ------------------------------------------------------------
-- 9. begin_invoice_refund — start/registreer een terugbetaling
-- ------------------------------------------------------------
-- Voor kind='manual' (offline, Fase 1) wordt de terugbetaling direct als
-- 'refunded' geboekt: het geld is immers al (of wordt) handmatig overgemaakt.
-- Voor kind='mollie' (Fase 2) komt de rij als 'queued' binnen en wordt later
-- via complete/fail_invoice_refund afgerond door de Mollie-webhook.
create or replace function public.begin_invoice_refund(
  p_invoice_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_amount_cents integer,
  p_reason text default null,
  p_kind text default 'manual',
  p_payment_record_id uuid default null,
  p_idempotency_key text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_refunds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_paid_cents bigint;
  v_already_cents bigint;
  v_kind text := case when p_kind in ('manual','mollie') then p_kind else 'manual' end;
  v_refund public.invoice_refunds;
  v_amount_eur text;
begin
  if p_organization_id is null or p_invoice_id is null then
    raise exception 'Organisatie en factuur zijn verplicht.' using errcode = '23514';
  end if;
  if coalesce(p_amount_cents, 0) <= 0 then
    raise exception 'Het terugbetaalbedrag moet groter zijn dan 0.' using errcode = '23514';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;

  if v_invoice.status not in ('paid','refunded') then
    raise exception 'Alleen betaalde facturen kunnen worden terugbetaald.' using errcode = '23514';
  end if;

  -- Idempotency: dezelfde sleutel mag nooit twee terugbetalingen maken.
  if p_idempotency_key is not null then
    select * into v_refund from public.invoice_refunds
     where organization_id = p_organization_id
       and invoice_id = p_invoice_id
       and idempotency_key = p_idempotency_key;
    if found then return v_refund; end if;
  end if;

  -- Betaald bedrag bepalen (zelfde logica als recompute).
  select coalesce(
           nullif(sum(amount_cents) filter (where status in ('paid','refunded','charged_back')), 0),
           public.invoice_total_cents(v_invoice)
         )
    into v_paid_cents
  from public.invoice_payment_records
  where invoice_id = p_invoice_id and organization_id = p_organization_id;

  -- Reeds terugbetaald of in behandeling (voorkomt dubbel/over-terugbetalen).
  select coalesce(sum(amount_cents), 0) into v_already_cents
  from public.invoice_refunds
  where invoice_id = p_invoice_id and organization_id = p_organization_id
    and status in ('queued','pending','processing','refunded');

  if p_amount_cents::bigint + v_already_cents > v_paid_cents then
    raise exception 'Terugbetaalbedrag (% cent) overschrijdt het resterende betaalde bedrag (% cent).',
      p_amount_cents, greatest(v_paid_cents - v_already_cents, 0)
      using errcode = '23514';
  end if;

  insert into public.invoice_refunds(
    organization_id, invoice_id, payment_record_id, kind, provider, status,
    amount_cents, currency, reason, idempotency_key, initiated_by, metadata, refunded_at
  ) values (
    p_organization_id, p_invoice_id, p_payment_record_id, v_kind, 'mollie',
    case when v_kind = 'manual' then 'refunded' else 'queued' end,
    p_amount_cents, coalesce(nullif(v_invoice.currency, ''), 'EUR'),
    nullif(btrim(coalesce(p_reason, '')), ''), p_idempotency_key, p_actor_user_id,
    coalesce(p_metadata, '{}'::jsonb),
    case when v_kind = 'manual' then now() else null end
  ) returning * into v_refund;

  -- Voor een handmatige terugbetaling is het geld direct verwerkt.
  if v_kind = 'manual' then
    perform public.recompute_invoice_refund_state(p_invoice_id, p_organization_id);

    v_amount_eur := to_char(p_amount_cents::numeric / 100, 'FM999999990.00');
    perform public.insert_invoice_workflow_event(
      p_organization_id,
      p_invoice_id,
      'payment_refunded',
      'Terugbetaling geregistreerd',
      'Handmatige terugbetaling van ' || coalesce(nullif(v_invoice.currency, ''), 'EUR') || ' ' || v_amount_eur,
      jsonb_build_object('refund_id', v_refund.id, 'amount_cents', p_amount_cents, 'kind', v_kind),
      p_actor_user_id
    );

    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (p_organization_id, p_actor_user_id, 'invoice_refunded', 'invoice', p_invoice_id, v_invoice.number,
            jsonb_build_object('refund_id', v_refund.id, 'amount_cents', p_amount_cents, 'kind', v_kind));
  end if;

  return v_refund;
end;
$$;

-- ------------------------------------------------------------
-- 10. complete_invoice_refund / fail_invoice_refund (Fase 2-afronding)
-- ------------------------------------------------------------
create or replace function public.complete_invoice_refund(
  p_refund_id uuid,
  p_organization_id uuid,
  p_provider_refund_id text default null,
  p_status text default 'refunded',
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_refunds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_refund public.invoice_refunds;
  v_invoice public.invoices;
  v_prev_status text;
  v_status text := case when p_status in ('queued','pending','processing','refunded','failed','canceled') then p_status else 'refunded' end;
  v_amount_eur text;
begin
  select * into v_refund
  from public.invoice_refunds
  where id = p_refund_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Terugbetaling niet gevonden.' using errcode = '02000'; end if;

  v_prev_status := v_refund.status;

  update public.invoice_refunds
     set provider_refund_id = coalesce(nullif(btrim(coalesce(p_provider_refund_id, '')), ''), provider_refund_id),
         status = v_status,
         refunded_at = case when v_status = 'refunded' then coalesce(refunded_at, now()) else refunded_at end,
         failed_at = case when v_status in ('failed','canceled') then coalesce(failed_at, now()) else failed_at end,
         metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
         updated_at = now()
   where id = v_refund.id
   returning * into v_refund;

  perform public.recompute_invoice_refund_state(v_refund.invoice_id, v_refund.organization_id);

  if v_status = 'refunded' and v_prev_status is distinct from 'refunded' then
    select * into v_invoice from public.invoices
     where id = v_refund.invoice_id and organization_id = v_refund.organization_id;

    v_amount_eur := to_char(v_refund.amount_cents::numeric / 100, 'FM999999990.00');
    perform public.insert_invoice_workflow_event(
      v_refund.organization_id,
      v_refund.invoice_id,
      'payment_refunded',
      'Terugbetaling verwerkt',
      'Mollie-terugbetaling van ' || coalesce(nullif(v_refund.currency, ''), 'EUR') || ' ' || v_amount_eur,
      jsonb_build_object('refund_id', v_refund.id, 'provider_refund_id', v_refund.provider_refund_id, 'amount_cents', v_refund.amount_cents),
      null
    );

    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (v_refund.organization_id, null, 'invoice_refunded', 'invoice', v_refund.invoice_id, coalesce(v_invoice.number, ''),
            jsonb_build_object('refund_id', v_refund.id, 'provider_refund_id', v_refund.provider_refund_id, 'amount_cents', v_refund.amount_cents));
  end if;

  return v_refund;
end;
$$;

create or replace function public.fail_invoice_refund(
  p_refund_id uuid,
  p_organization_id uuid,
  p_error_message text default null,
  p_status text default 'failed',
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_refunds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_refund public.invoice_refunds;
  v_status text := case when p_status in ('failed','canceled') then p_status else 'failed' end;
begin
  select * into v_refund
  from public.invoice_refunds
  where id = p_refund_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Terugbetaling niet gevonden.' using errcode = '02000'; end if;

  update public.invoice_refunds
     set status = v_status,
         failed_at = coalesce(failed_at, now()),
         error_message = nullif(btrim(coalesce(p_error_message, '')), ''),
         metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
         updated_at = now()
   where id = v_refund.id
   returning * into v_refund;

  perform public.recompute_invoice_refund_state(v_refund.invoice_id, v_refund.organization_id);
  return v_refund;
end;
$$;

-- ------------------------------------------------------------
-- 11. issue_credit_note — formele creditfactuur aanmaken
-- ------------------------------------------------------------
-- De bedragen + regels + PDF-metadata worden door de Edge Function berekend en
-- doorgegeven; deze RPC kent het CN-nummer toe, schrijft het document atomisch
-- weg, koppelt het aan de terugbetaling en legt event + audit vast.
create or replace function public.issue_credit_note(
  p_organization_id uuid,
  p_invoice_id uuid,
  p_refund_id uuid,
  p_actor_user_id uuid,
  p_reason text,
  p_currency text,
  p_subtotal numeric,
  p_vat numeric,
  p_total numeric,
  p_lines jsonb,
  p_pdf_file_name text default null,
  p_pdf_mime_type text default null,
  p_pdf_size_bytes integer default null,
  p_pdf_sha256 text default null,
  p_pdf_data_base64 text default null,
  p_pdf_storage_provider text default null,
  p_pdf_storage_key text default null
)
returns public.credit_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_credit_note public.credit_notes;
  v_number text;
begin
  if p_organization_id is null or p_invoice_id is null then
    raise exception 'Organisatie en factuur zijn verplicht voor een creditfactuur.' using errcode = '23514';
  end if;

  select * into v_invoice from public.invoices
   where id = p_invoice_id and organization_id = p_organization_id;
  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;

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
$$;

-- ------------------------------------------------------------
-- 12. Rechten: alle schrijf-RPC's zijn service_role-only.
-- ------------------------------------------------------------
revoke execute on function public.invoice_total_cents(public.invoices) from public, anon, authenticated;
revoke execute on function public.reconcile_credit_note_number_sequence(uuid, integer) from public, anon, authenticated;
revoke execute on function public.allocate_next_credit_note_number(uuid, date) from public, anon, authenticated;
revoke execute on function public.recompute_invoice_refund_state(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.begin_invoice_refund(uuid, uuid, uuid, integer, text, text, uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.complete_invoice_refund(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.fail_invoice_refund(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.issue_credit_note(uuid, uuid, uuid, uuid, text, text, numeric, numeric, numeric, jsonb, text, text, integer, text, text, text, text) from public, anon, authenticated;

grant execute on function public.recompute_invoice_refund_state(uuid, uuid) to service_role;
grant execute on function public.begin_invoice_refund(uuid, uuid, uuid, integer, text, text, uuid, text, jsonb) to service_role;
grant execute on function public.complete_invoice_refund(uuid, uuid, text, text, jsonb) to service_role;
grant execute on function public.fail_invoice_refund(uuid, uuid, text, text, jsonb) to service_role;
grant execute on function public.issue_credit_note(uuid, uuid, uuid, uuid, text, text, numeric, numeric, numeric, jsonb, text, text, integer, text, text, text, text) to service_role;
