-- ============================================================
-- Fase 3: chargebacks (terugboekingen), externe refund-ingest,
--         creditnota-mailvocabulaire
-- ============================================================
-- Bouwt voort op fase 1 (invoice_refunds + credit_notes) en fase 2
-- (Mollie-refund-uitvoering). Dit voegt toe:
--   * invoice_chargebacks: ledger voor bank-/kaartterugboekingen (Mollie chargebacks)
--   * invoices.charged_back_amount / charged_back_at: aggregaat per factuur
--   * RPC record_invoice_chargeback + recompute_invoice_chargeback_state
--   * RPC ingest_external_refund: in Mollie aangemaakte refunds in de ledger opnemen
--   * extra event-/audit-vocab voor chargebacks en creditnota-mails
--
-- Alle schrijf-RPC's zijn service_role-only; de tabel is read-only voor leden.

-- ------------------------------------------------------------
-- 1. Aggregaatkolommen op invoices
-- ------------------------------------------------------------
alter table public.invoices add column if not exists charged_back_amount numeric(12,2) not null default 0;
alter table public.invoices add column if not exists charged_back_at timestamptz;

-- ------------------------------------------------------------
-- 2. Event- en audit-vocabulaire uitbreiden (idempotent herdefiniëren)
-- ------------------------------------------------------------
alter table public.invoice_workflow_events drop constraint if exists invoice_workflow_events_event_type_check;
alter table public.invoice_workflow_events
  add constraint invoice_workflow_events_event_type_check
  check (event_type in (
    'created_from_quote','public_token_created','public_link_created','sent_to_client',
    'email_sent','email_delivered','email_opened','email_clicked','email_bounced','email_failed','email_complained',
    'client_viewed','payment_link_created','payment_open','payment_paid','payment_failed','payment_expired',
    'invoice_version_created','invoice_pdf_attached','locked','expired','cancelled','void','written_off',
    'payment_refunded','credit_note_issued',
    'payment_charged_back','chargeback_reversed','credit_note_emailed'
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
      'invoice_refunded','credit_note_issued',
      'invoice_charged_back','chargeback_reversed','credit_note_emailed'
    ));
end $$;

-- ------------------------------------------------------------
-- 3. Tabel: invoice_chargebacks (ledger)
-- ------------------------------------------------------------
create table if not exists public.invoice_chargebacks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  payment_record_id uuid references public.invoice_payment_records(id) on delete set null,
  provider text not null default 'mollie',
  provider_chargeback_id text,
  -- 'charged_back' = geld teruggeboekt; 'reversed' = terugboeking door de bank teruggedraaid.
  status text not null default 'charged_back' check (status in ('charged_back','reversed')),
  amount_cents integer not null check (amount_cents > 0),
  settlement_amount_cents integer,
  currency text not null default 'EUR',
  reason text,
  charged_back_at timestamptz not null default now(),
  reversed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_invoice_chargebacks_invoice
  on public.invoice_chargebacks(organization_id, invoice_id, created_at desc);
create index if not exists idx_invoice_chargebacks_payment
  on public.invoice_chargebacks(payment_record_id) where payment_record_id is not null;
create unique index if not exists idx_invoice_chargebacks_provider
  on public.invoice_chargebacks(provider, provider_chargeback_id) where provider_chargeback_id is not null;

alter table public.invoice_chargebacks enable row level security;

drop policy if exists "invoice chargebacks read" on public.invoice_chargebacks;
create policy "invoice chargebacks read" on public.invoice_chargebacks
  for select using (public.can_read_org(organization_id));

-- ------------------------------------------------------------
-- 4. recompute_invoice_chargeback_state — aggregaat + betaalrecordstatus
-- ------------------------------------------------------------
create or replace function public.recompute_invoice_chargeback_state(p_invoice_id uuid, p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charged_back_cents bigint;
begin
  -- Alleen actieve (niet-teruggedraaide) chargebacks tellen mee.
  select coalesce(sum(amount_cents), 0) into v_charged_back_cents
  from public.invoice_chargebacks
  where invoice_id = p_invoice_id and organization_id = p_organization_id
    and status = 'charged_back';

  -- Betaalrecord met een actieve chargeback → status 'charged_back'.
  update public.invoice_payment_records p
     set status = 'charged_back', updated_at = now()
   where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id
     and p.status in ('paid','refunded')
     and exists (
       select 1 from public.invoice_chargebacks c
       where c.payment_record_id = p.id and c.status = 'charged_back'
     );

  -- Teruggedraaide chargeback en geen andere actieve chargeback → terug naar 'paid'.
  update public.invoice_payment_records p
     set status = 'paid', updated_at = now()
   where p.invoice_id = p_invoice_id and p.organization_id = p_organization_id
     and p.status = 'charged_back'
     and not exists (
       select 1 from public.invoice_chargebacks c
       where c.payment_record_id = p.id and c.status = 'charged_back'
     );

  update public.invoices
     set charged_back_amount = round(v_charged_back_cents::numeric / 100, 2),
         charged_back_at = case when v_charged_back_cents > 0 then coalesce(charged_back_at, now()) else null end,
         updated_at = now()
   where id = p_invoice_id and organization_id = p_organization_id;
end;
$$;

-- ------------------------------------------------------------
-- 5. record_invoice_chargeback — idempotente upsert per provider_chargeback_id
-- ------------------------------------------------------------
create or replace function public.record_invoice_chargeback(
  p_organization_id uuid,
  p_invoice_id uuid,
  p_payment_record_id uuid,
  p_provider_chargeback_id text,
  p_amount_cents integer,
  p_currency text default 'EUR',
  p_reason text default null,
  p_reversed boolean default false,
  p_settlement_amount_cents integer default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_chargebacks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.invoice_chargebacks;
  v_existing public.invoice_chargebacks;
  v_invoice public.invoices;
  v_status text := case when p_reversed then 'reversed' else 'charged_back' end;
  v_prev_status text := null;
  v_amount_eur text;
begin
  if p_organization_id is null or p_invoice_id is null then
    raise exception 'Organisatie en factuur zijn verplicht.' using errcode = '23514';
  end if;
  if p_provider_chargeback_id is null or btrim(p_provider_chargeback_id) = '' then
    raise exception 'Chargeback-id is verplicht.' using errcode = '23514';
  end if;
  if coalesce(p_amount_cents, 0) <= 0 then
    raise exception 'Het chargeback-bedrag moet groter zijn dan 0.' using errcode = '23514';
  end if;

  select * into v_invoice from public.invoices
   where id = p_invoice_id and organization_id = p_organization_id
   for update;
  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;

  select * into v_existing from public.invoice_chargebacks
   where organization_id = p_organization_id and provider_chargeback_id = p_provider_chargeback_id;

  if found then
    v_prev_status := v_existing.status;
    update public.invoice_chargebacks
       set status = v_status,
           amount_cents = p_amount_cents,
           settlement_amount_cents = coalesce(p_settlement_amount_cents, settlement_amount_cents),
           reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), reason),
           reversed_at = case when v_status = 'reversed' then coalesce(reversed_at, now()) else null end,
           metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
           updated_at = now()
     where id = v_existing.id
     returning * into v_row;
  else
    insert into public.invoice_chargebacks(
      organization_id, invoice_id, payment_record_id, provider, provider_chargeback_id,
      status, amount_cents, settlement_amount_cents, currency, reason, charged_back_at, reversed_at, metadata
    ) values (
      p_organization_id, p_invoice_id, p_payment_record_id, 'mollie', p_provider_chargeback_id,
      v_status, p_amount_cents, p_settlement_amount_cents, coalesce(nullif(p_currency, ''), 'EUR'),
      nullif(btrim(coalesce(p_reason, '')), ''), now(),
      case when v_status = 'reversed' then now() else null end,
      coalesce(p_metadata, '{}'::jsonb)
    ) returning * into v_row;
  end if;

  perform public.recompute_invoice_chargeback_state(p_invoice_id, p_organization_id);

  -- Event + audit alleen bij een echte statuswijziging (voorkomt webhook-spam).
  if v_prev_status is distinct from v_status then
    v_amount_eur := to_char(p_amount_cents::numeric / 100, 'FM999999990.00');
    perform public.insert_invoice_workflow_event(
      p_organization_id,
      p_invoice_id,
      case when v_status = 'reversed' then 'chargeback_reversed' else 'payment_charged_back' end,
      case when v_status = 'reversed' then 'Terugboeking teruggedraaid' else 'Terugboeking ontvangen' end,
      case when v_status = 'reversed'
           then 'Mollie heeft de terugboeking teruggedraaid (' || coalesce(nullif(v_invoice.currency, ''), 'EUR') || ' ' || v_amount_eur || ').'
           else 'Mollie meldde een terugboeking van ' || coalesce(nullif(v_invoice.currency, ''), 'EUR') || ' ' || v_amount_eur || '.'
      end,
      jsonb_build_object('chargeback_id', v_row.id, 'provider_chargeback_id', p_provider_chargeback_id, 'amount_cents', p_amount_cents, 'status', v_status),
      null
    );

    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (p_organization_id, null,
            case when v_status = 'reversed' then 'chargeback_reversed' else 'invoice_charged_back' end,
            'invoice', p_invoice_id, coalesce(v_invoice.number, ''),
            jsonb_build_object('chargeback_id', v_row.id, 'amount_cents', p_amount_cents, 'status', v_status));
  end if;

  return v_row;
end;
$$;

-- ------------------------------------------------------------
-- 6. ingest_external_refund — in Mollie aangemaakte refund in de ledger opnemen
-- ------------------------------------------------------------
-- Refunds die rechtstreeks in het Mollie-dashboard worden aangemaakt komen via de
-- payment-webhook binnen. Die zijn al uitgevoerd, dus hier bewust GÉÉN over-refund-
-- guard: we registreren de werkelijkheid. Idempotent op provider_refund_id.
create or replace function public.ingest_external_refund(
  p_organization_id uuid,
  p_invoice_id uuid,
  p_payment_record_id uuid,
  p_provider_refund_id text,
  p_amount_cents integer,
  p_status text default 'pending',
  p_currency text default 'EUR',
  p_reason text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_refunds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_refund public.invoice_refunds;
  v_status text := case when p_status in ('queued','pending','processing','refunded','failed','canceled') then p_status else 'pending' end;
begin
  if p_organization_id is null or p_invoice_id is null then
    raise exception 'Organisatie en factuur zijn verplicht.' using errcode = '23514';
  end if;
  if p_provider_refund_id is null or btrim(p_provider_refund_id) = '' then
    raise exception 'Refund-id is verplicht.' using errcode = '23514';
  end if;
  if coalesce(p_amount_cents, 0) <= 0 then
    raise exception 'Het terugbetaalbedrag moet groter zijn dan 0.' using errcode = '23514';
  end if;

  -- Bestaat al (race/herhaalde webhook)? Geef de bestaande terug; de gewone
  -- reconcile-flow (complete/fail_invoice_refund) werkt de status verder bij.
  select * into v_refund from public.invoice_refunds
   where organization_id = p_organization_id and provider_refund_id = p_provider_refund_id;
  if found then return v_refund; end if;

  insert into public.invoice_refunds(
    organization_id, invoice_id, payment_record_id, kind, provider, provider_refund_id,
    status, amount_cents, currency, reason, idempotency_key, initiated_by, metadata, refunded_at
  ) values (
    p_organization_id, p_invoice_id, p_payment_record_id, 'mollie', 'mollie', p_provider_refund_id,
    v_status, p_amount_cents, coalesce(nullif(p_currency, ''), 'EUR'),
    nullif(btrim(coalesce(p_reason, '')), ''),
    'external-' || p_provider_refund_id,
    null,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('source', 'mollie_dashboard', 'create_credit_note', true),
    case when v_status = 'refunded' then now() else null end
  ) returning * into v_refund;

  perform public.recompute_invoice_refund_state(p_invoice_id, p_organization_id);

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    p_invoice_id,
    'payment_refunded',
    'Externe terugbetaling gedetecteerd',
    'Een in Mollie aangemaakte terugbetaling is automatisch in de administratie opgenomen.',
    jsonb_build_object('refund_id', v_refund.id, 'provider_refund_id', p_provider_refund_id, 'amount_cents', p_amount_cents, 'status', v_status, 'external', true),
    null
  );

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, null, 'invoice_refunded', 'invoice', p_invoice_id,
          (select coalesce(number, '') from public.invoices where id = p_invoice_id and organization_id = p_organization_id),
          jsonb_build_object('refund_id', v_refund.id, 'amount_cents', p_amount_cents, 'external', true));

  return v_refund;
end;
$$;

-- ------------------------------------------------------------
-- 7. updated_at-trigger op invoice_chargebacks
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'trg_invoice_chargebacks_updated_at'
  ) then
    create trigger trg_invoice_chargebacks_updated_at
      before update on public.invoice_chargebacks
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- ------------------------------------------------------------
-- 8. Rechten: alle schrijf-RPC's zijn service_role-only.
-- ------------------------------------------------------------
revoke execute on function public.recompute_invoice_chargeback_state(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.record_invoice_chargeback(uuid, uuid, uuid, text, integer, text, text, boolean, integer, jsonb) from public, anon, authenticated;
revoke execute on function public.ingest_external_refund(uuid, uuid, uuid, text, integer, text, text, text, jsonb) from public, anon, authenticated;

grant execute on function public.recompute_invoice_chargeback_state(uuid, uuid) to service_role;
grant execute on function public.record_invoice_chargeback(uuid, uuid, uuid, text, integer, text, text, boolean, integer, jsonb) to service_role;
grant execute on function public.ingest_external_refund(uuid, uuid, uuid, text, integer, text, text, text, jsonb) to service_role;
