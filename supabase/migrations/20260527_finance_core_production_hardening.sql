-- ============================================================
-- ResoFly — Finance core production hardening
-- Date: 2026-05-27
--
-- Scope:
-- 1. Public invoice links are versioned rows instead of one mutable invoice token.
-- 2. Mollie redirects are bound to the public invoice page.
-- 3. Invoices are locked after send/payment-link creation/paid state.
-- 4. Quote -> invoice uses the accepted/sent quote version snapshot when available.
-- 5. Only one active payment checkout flow is allowed per invoice.
-- 6. Provider payment IDs are unique.
-- 7. Sent PDF snapshots store exact generated PDF data in the version row.
-- 8. Public invoice responses can be resolved via a scoped public link.
-- 9. Invoice statuses are normalized to invoice-specific states.
-- 10. A lightweight provider outbox/reconciliation table is added.
-- ============================================================

create extension if not exists pgcrypto;

begin;

-- ------------------------------------------------------------
-- 1 + 9. Invoice status model, totals and locking fields
-- ------------------------------------------------------------
update public.invoices
   set status = case
     when status in ('accepted','rejected') then 'sent'
     when status = 'expired' then 'overdue'
     else status
   end
 where status in ('accepted','rejected','expired');

alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices
  add constraint invoices_status_check
  check (status in ('draft','sent','overdue','paid','cancelled','void','written_off'));

alter table public.invoices
  add column if not exists currency text not null default 'EUR',
  add column if not exists subtotal_amount numeric(12,2) not null default 0,
  add column if not exists vat_amount numeric(12,2) not null default 0,
  add column if not exists total_amount numeric(12,2) not null default 0,
  add column if not exists locked_at timestamptz,
  add column if not exists locked_reason text,
  add column if not exists source_quote_version_id uuid;

alter table public.invoices
  drop constraint if exists invoices_source_quote_version_fk,
  add constraint invoices_source_quote_version_fk foreign key (source_quote_version_id)
  references public.quote_versions(id) on delete set null;

create or replace function public.invoice_calculated_totals(p_lines jsonb)
returns table(subtotal numeric, vat numeric, total numeric)
language plpgsql
immutable
as $$
declare
  v_line jsonb;
  v_qty numeric;
  v_unit numeric;
  v_vat_pct numeric;
  v_sub numeric := 0;
  v_vat numeric := 0;
  v_total numeric := 0;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    return query select 0::numeric, 0::numeric, 0::numeric;
    return;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := coalesce(nullif(v_line->>'quantity', '')::numeric, 0);
    v_unit := coalesce(nullif(v_line->>'unit_price', '')::numeric, 0);
    v_vat_pct := coalesce(nullif(v_line->>'vat', '')::numeric, 0);
    v_sub := v_sub + round(v_qty * v_unit, 2);
    v_vat := v_vat + round((v_qty * v_unit) * (v_vat_pct / 100), 2);
  end loop;

  v_total := v_sub + v_vat;
  return query select round(v_sub, 2), round(v_vat, 2), round(v_total, 2);
end;
$$;

create or replace function public.normalize_invoice_totals()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_totals record;
begin
  select * into v_totals from public.invoice_calculated_totals(new.lines);
  new.subtotal_amount := coalesce(v_totals.subtotal, 0);
  new.vat_amount := coalesce(v_totals.vat, 0);
  new.total_amount := coalesce(v_totals.total, 0);
  new.currency := upper(coalesce(nullif(btrim(new.currency), ''), 'EUR'));
  new.updated_at := coalesce(new.updated_at, now());
  return new;
end;
$$;

drop trigger if exists invoices_normalize_totals on public.invoices;
create trigger invoices_normalize_totals
  before insert or update of lines, currency on public.invoices
  for each row execute function public.normalize_invoice_totals();

update public.invoices i
   set subtotal_amount = t.subtotal,
       vat_amount = t.vat,
       total_amount = t.total,
       currency = coalesce(nullif(btrim(i.currency), ''), 'EUR'),
       updated_at = now()
  from lateral public.invoice_calculated_totals(i.lines) t;

-- ------------------------------------------------------------
-- 1. Versioned public invoice links
-- ------------------------------------------------------------
create table if not exists public.invoice_public_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  token_hash text not null,
  purpose text not null default 'invoice_view' check (purpose in ('invoice_view','email','payment','portal')),
  status text not null default 'active' check (status in ('active','revoked','expired')),
  delivery_id uuid references public.invoice_email_deliveries(id) on delete set null,
  payment_record_id uuid references public.invoice_payment_records(id) on delete set null,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_viewed_at timestamptz,
  view_count integer not null default 0 check (view_count >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (token_hash)
);

create index if not exists idx_invoice_public_links_invoice on public.invoice_public_links(organization_id, invoice_id, created_at desc);
create index if not exists idx_invoice_public_links_token on public.invoice_public_links(token_hash) where status = 'active';
create index if not exists idx_invoice_public_links_payment on public.invoice_public_links(payment_record_id) where payment_record_id is not null;

alter table public.invoice_public_links enable row level security;

drop policy if exists "invoice public links read by org" on public.invoice_public_links;
create policy "invoice public links read by org" on public.invoice_public_links
  for select using (public.can_read_org(organization_id));

drop policy if exists "invoice public links write by org" on public.invoice_public_links;
create policy "invoice public links write by org" on public.invoice_public_links
  for insert with check (public.can_write_org(organization_id));

create or replace function public.create_invoice_public_link(
  p_invoice_id uuid,
  p_organization_id uuid,
  p_token text,
  p_purpose text default 'invoice_view',
  p_expires_at timestamptz default null,
  p_delivery_id uuid default null,
  p_payment_record_id uuid default null,
  p_created_by uuid default auth.uid(),
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_public_links
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_token_hash text := public.invoice_token_hash(p_token);
  v_link public.invoice_public_links;
begin
  if nullif(btrim(coalesce(p_token, '')), '') is null then
    raise exception 'Publieke token ontbreekt.' using errcode = '23514';
  end if;

  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Factuur niet gevonden.' using errcode = '02000';
  end if;

  insert into public.invoice_public_links(
    organization_id, invoice_id, token_hash, purpose, status, delivery_id,
    payment_record_id, expires_at, created_by, metadata
  ) values (
    p_organization_id, p_invoice_id, v_token_hash,
    case when p_purpose in ('invoice_view','email','payment','portal') then p_purpose else 'invoice_view' end,
    'active', p_delivery_id, p_payment_record_id, p_expires_at, p_created_by, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (token_hash) do update
     set status = 'active',
         expires_at = excluded.expires_at,
         revoked_at = null,
         delivery_id = coalesce(excluded.delivery_id, public.invoice_public_links.delivery_id),
         payment_record_id = coalesce(excluded.payment_record_id, public.invoice_public_links.payment_record_id),
         metadata = public.invoice_public_links.metadata || excluded.metadata,
         updated_at = now()
  returning * into v_link;

  -- Backward compatibility for older frontend/function versions. New code resolves via invoice_public_links.
  update public.invoices
     set public_token_hash = v_token_hash,
         public_token_created_at = coalesce(public_token_created_at, now()),
         public_token_expires_at = coalesce(p_expires_at, public_token_expires_at),
         updated_at = now()
   where id = p_invoice_id and organization_id = p_organization_id;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    p_invoice_id,
    'public_link_created',
    'Publieke factuurlink aangemaakt',
    'Veilige publieke factuurlink aangemaakt voor ' || v_link.purpose || '.',
    jsonb_build_object('link_id', v_link.id, 'purpose', v_link.purpose, 'expires_at', v_link.expires_at),
    p_created_by
  );

  return v_link;
end;
$$;

create or replace function public.resolve_invoice_public_link(p_token text, p_touch boolean default true)
returns table(
  link_id uuid,
  organization_id uuid,
  invoice_id uuid,
  purpose text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := public.invoice_token_hash(p_token);
  v_link public.invoice_public_links;
  v_invoice public.invoices;
begin
  select * into v_link
  from public.invoice_public_links
  where token_hash = v_hash
    and status = 'active'
    and revoked_at is null
    and (expires_at is null or expires_at > now())
  order by created_at desc
  limit 1;

  if found then
    if p_touch then
      update public.invoice_public_links
         set last_viewed_at = now(), view_count = view_count + 1, updated_at = now()
       where id = v_link.id;
    end if;
    return query select v_link.id, v_link.organization_id, v_link.invoice_id, v_link.purpose, v_link.expires_at;
    return;
  end if;

  -- Backward compatibility with the original single-token model.
  select * into v_invoice
  from public.invoices
  where public_token_hash = v_hash
    and (public_token_expires_at is null or public_token_expires_at > now())
  limit 1;

  if found then
    return query select null::uuid, v_invoice.organization_id, v_invoice.id, 'invoice_view'::text, v_invoice.public_token_expires_at;
    return;
  end if;
end;
$$;

-- Backfill existing latest invoice token into the new links table.
insert into public.invoice_public_links(organization_id, invoice_id, token_hash, purpose, status, expires_at, metadata)
select organization_id, id, public_token_hash, 'invoice_view', 'active', public_token_expires_at, jsonb_build_object('backfilled_from_invoice_column', true)
from public.invoices
where public_token_hash is not null
on conflict (token_hash) do nothing;

-- ------------------------------------------------------------
-- 5 + 6. Payment records are idempotent and provider IDs are unique.
-- ------------------------------------------------------------
alter table public.invoice_payment_records drop constraint if exists invoice_payment_records_status_check;
alter table public.invoice_payment_records
  add constraint invoice_payment_records_status_check
  check (status in ('creating','open','pending','authorized','paid','failed','expired','canceled','refunded','charged_back'));

drop index if exists public.idx_invoice_payment_idempotency;
create unique index if not exists idx_invoice_payment_idempotency
  on public.invoice_payment_records(organization_id, invoice_id, idempotency_key)
  where idempotency_key is not null and status in ('creating','open','pending','authorized');

with ranked_active as (
  select id,
         row_number() over (partition by organization_id, invoice_id order by created_at desc, id desc) as rn
  from public.invoice_payment_records
  where provider = 'mollie'
    and status in ('creating','open','pending','authorized')
)
update public.invoice_payment_records p
   set status = 'expired',
       error_message = coalesce(error_message, 'Expired by finance core hardening because another active checkout exists.'),
       updated_at = now()
from ranked_active r
where p.id = r.id and r.rn > 1;

create unique index if not exists idx_invoice_payment_one_active_mollie
  on public.invoice_payment_records(organization_id, invoice_id)
  where provider = 'mollie' and status in ('creating','open','pending','authorized');

with ranked_provider as (
  select id,
         row_number() over (partition by provider, provider_payment_id order by created_at desc, id desc) as rn
  from public.invoice_payment_records
  where provider_payment_id is not null
)
update public.invoice_payment_records p
   set provider_payment_id = p.provider_payment_id || '_duplicate_' || p.id::text,
       status = case when p.status in ('creating','open','pending','authorized') then 'failed' else p.status end,
       error_message = coalesce(error_message, 'Duplicate provider payment id quarantined by finance core hardening.'),
       updated_at = now()
from ranked_provider r
where p.id = r.id and r.rn > 1;

create unique index if not exists idx_invoice_payment_provider_payment_unique
  on public.invoice_payment_records(provider, provider_payment_id)
  where provider_payment_id is not null;

-- ------------------------------------------------------------
-- 7 + 10. Immutable PDF data + provider outbox/reconciliation
-- ------------------------------------------------------------
alter table public.invoice_versions
  add column if not exists pdf_data_base64 text,
  add column if not exists pdf_storage_provider text,
  add column if not exists pdf_storage_key text,
  add column if not exists is_immutable boolean not null default true;

create table if not exists public.finance_provider_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity_type text not null check (entity_type in ('invoice','quote','payment','email')),
  entity_id uuid,
  provider text not null,
  job_type text not null,
  status text not null default 'queued' check (status in ('queued','processing','provider_created','completed','failed','retry')),
  idempotency_key text,
  provider_object_id text,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  last_error text,
  retry_count integer not null default 0 check (retry_count >= 0),
  next_retry_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_finance_provider_jobs_idempotency
  on public.finance_provider_jobs(provider, job_type, idempotency_key)
  where idempotency_key is not null;

alter table public.finance_provider_jobs enable row level security;

drop policy if exists "finance provider jobs read by org" on public.finance_provider_jobs;
create policy "finance provider jobs read by org" on public.finance_provider_jobs
  for select using (public.can_admin_org(organization_id));

-- ------------------------------------------------------------
-- Workflow events: include new event types.
-- ------------------------------------------------------------
alter table public.invoice_workflow_events drop constraint if exists invoice_workflow_events_event_type_check;
alter table public.invoice_workflow_events
  add constraint invoice_workflow_events_event_type_check
  check (event_type in (
    'created_from_quote','public_token_created','public_link_created','sent_to_client',
    'email_sent','email_delivered','email_opened','email_clicked','email_bounced','email_failed','email_complained',
    'client_viewed','payment_link_created','payment_open','payment_paid','payment_failed','payment_expired',
    'invoice_version_created','invoice_pdf_attached','locked','expired','cancelled','void','written_off'
  ));

-- ------------------------------------------------------------
-- 3. Browser/API immutability guard for sent/payment-linked invoices.
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
      and p.status in ('creating','open','pending','authorized','paid')
  ) into v_has_active_or_paid_payment;

  v_is_locked := old.locked_at is not null or old.status in ('sent','overdue','paid','cancelled','void','written_off') or v_has_active_or_paid_payment;

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

drop trigger if exists invoices_immutability_guard on public.invoices;
create trigger invoices_immutability_guard
  before update on public.invoices
  for each row execute function public.enforce_invoice_immutability();

-- ------------------------------------------------------------
-- 4. Quote -> invoice based on accepted/sent quote snapshot.
-- ------------------------------------------------------------
create or replace function public.convert_accepted_quote_to_invoice(p_quote_id uuid, p_organization_id uuid)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_quote_version public.quote_versions;
  v_existing public.invoices;
  v_invoice public.invoices;
  v_user_id uuid := auth.uid();
  v_invoice_number text;
  v_due_date date := current_date + 14;
  v_lines jsonb;
  v_notes text;
  v_quote_date date;
  v_valid_until date;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text), hashtext('quote_to_invoice'));

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Offerte niet gevonden.' using errcode = '02000';
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'Alleen geaccepteerde offertes kunnen worden omgezet naar een factuur.' using errcode = '23514';
  end if;

  select * into v_existing
  from public.invoices
  where organization_id = p_organization_id
    and quote_id = p_quote_id
  order by created_at asc
  limit 1
  for update;

  if found then
    return v_existing;
  end if;

  select * into v_quote_version
  from public.quote_versions qv
  where qv.organization_id = p_organization_id
    and qv.quote_id = p_quote_id
    and qv.id = coalesce(v_quote.accepted_sent_version_id, v_quote.accepted_version_id, v_quote.sent_version_id, v_quote.latest_version_id)
  limit 1;

  if not found then
    select * into v_quote_version
    from public.quote_versions qv
    where qv.organization_id = p_organization_id
      and qv.quote_id = p_quote_id
      and qv.snapshot_reason in ('client_accepted','sent_to_client')
    order by case qv.snapshot_reason when 'client_accepted' then 0 else 1 end, qv.created_at desc
    limit 1;
  end if;

  v_lines := coalesce(v_quote_version.snapshot_data #> '{quote,lines}', v_quote.lines, '[]'::jsonb);
  v_notes := coalesce(v_quote_version.snapshot_data #>> '{quote,notes}', v_quote.notes);
  v_quote_date := coalesce((v_quote_version.snapshot_data #>> '{quote,date}')::date, v_quote.date);
  v_valid_until := coalesce((v_quote_version.snapshot_data #>> '{quote,valid_until}')::date, v_quote.valid_until);

  if jsonb_typeof(v_lines) <> 'array' then
    raise exception 'De geaccepteerde offerteversie bevat geen geldige regels.' using errcode = '23514';
  end if;

  v_invoice_number := public.allocate_next_invoice_number(p_organization_id, current_date);

  insert into public.invoices(
    organization_id, created_by, client_id, project_id, quote_id, source_quote_version_id,
    number, date, due_date, lines, status, notes
  ) values (
    p_organization_id, v_user_id, v_quote.client_id, v_quote.project_id, v_quote.id, v_quote_version.id,
    v_invoice_number, current_date, v_due_date, v_lines, 'draft', v_notes
  ) returning * into v_invoice;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    v_invoice.id,
    'created_from_quote',
    'Factuur aangemaakt uit offerte',
    'Factuur ' || v_invoice.number || ' is server-side aangemaakt uit de geaccepteerde offerteversie van ' || v_quote.number || '.',
    jsonb_build_object('quote_id', v_quote.id, 'quote_number', v_quote.number, 'quote_version_id', v_quote_version.id, 'quote_date', v_quote_date, 'quote_valid_until', v_valid_until),
    v_user_id
  );

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (
    p_organization_id,
    v_user_id,
    'invoice_created_from_quote',
    'invoice',
    v_invoice.id,
    v_invoice.number,
    jsonb_build_object('title', 'Factuur aangemaakt uit offerte', 'quote_id', v_quote.id, 'quote_number', v_quote.number, 'quote_version_id', v_quote_version.id)
  );

  return v_invoice;
end;
$$;

-- ------------------------------------------------------------
-- 1, 7, 10. Email send lifecycle with public links + exact PDF snapshot data.
-- ------------------------------------------------------------
drop function if exists public.begin_invoice_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text);

create or replace function public.begin_invoice_email_send(
  p_invoice_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_token_hash text,
  p_token_expires_at timestamptz,
  p_recipient_email text,
  p_recipient_name text,
  p_subject text,
  p_public_url text,
  p_attachment_file_name text default null,
  p_attachment_mime_type text default 'application/pdf',
  p_attachment_size_bytes integer default null,
  p_attachment_sha256 text default null,
  p_attachment_data_base64 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_delivery public.invoice_email_deliveries;
  v_public_token text;
  v_link public.invoice_public_links;
  v_job public.finance_provider_jobs;
begin
  if p_actor_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  if v_invoice.status in ('paid','cancelled','void','written_off') then
    raise exception 'Betaalde, geannuleerde of afgeboekte facturen kunnen niet opnieuw worden verstuurd.' using errcode = '23514';
  end if;

  v_public_token := substring(coalesce(p_public_url, '') from '/invoice/([^?/#]+)');
  if v_public_token is null or public.invoice_token_hash(v_public_token) <> p_token_hash then
    raise exception 'Publieke factuurlink en token-hash komen niet overeen.' using errcode = '23514';
  end if;

  insert into public.invoice_email_deliveries(
    organization_id, invoice_id, recipient_email, recipient_name, subject, status,
    attachment_file_name, attachment_mime_type, attachment_size_bytes, attachment_sha256,
    metadata
  ) values (
    p_organization_id, p_invoice_id, lower(btrim(p_recipient_email)), nullif(btrim(coalesce(p_recipient_name, '')), ''), p_subject, 'queued',
    nullif(btrim(coalesce(p_attachment_file_name, '')), ''), coalesce(nullif(btrim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'), p_attachment_size_bytes, lower(nullif(btrim(coalesce(p_attachment_sha256, '')), '')),
    jsonb_build_object('publicUrl', p_public_url, 'attachmentDataBase64', p_attachment_data_base64)
  ) returning * into v_delivery;

  v_link := public.create_invoice_public_link(
    p_invoice_id,
    p_organization_id,
    v_public_token,
    'email',
    p_token_expires_at,
    v_delivery.id,
    null,
    p_actor_user_id,
    jsonb_build_object('publicUrl', p_public_url)
  );

  insert into public.finance_provider_jobs(organization_id, entity_type, entity_id, provider, job_type, status, idempotency_key, request_payload)
  values (p_organization_id, 'email', v_delivery.id, 'resend', 'send_invoice_email', 'queued', 'invoice-email-' || v_delivery.id::text, jsonb_build_object('invoice_id', p_invoice_id, 'recipient_email', lower(btrim(p_recipient_email)), 'public_link_id', v_link.id))
  on conflict (provider, job_type, idempotency_key) where idempotency_key is not null do update
    set updated_at = now()
  returning * into v_job;

  return jsonb_build_object('deliveryId', v_delivery.id, 'invoiceId', p_invoice_id, 'publicLinkId', v_link.id, 'providerJobId', v_job.id);
end;
$$;

create or replace function public.complete_invoice_email_send(
  p_delivery_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_provider_email_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery public.invoice_email_deliveries;
  v_invoice public.invoices;
  v_version public.invoice_versions;
  v_pdf_base64 text;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_delivery
  from public.invoice_email_deliveries
  where id = p_delivery_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Factuurdelivery niet gevonden.' using errcode = '02000'; end if;

  update public.invoice_email_deliveries
     set provider_email_id = nullif(btrim(p_provider_email_id), ''),
         status = 'sent',
         sent_at = now(),
         last_event_at = now(),
         updated_at = now()
   where id = v_delivery.id
   returning * into v_delivery;

  update public.invoices
     set status = case when status = 'draft' then 'sent' else status end,
         sent_at = coalesce(sent_at, now()),
         locked_at = coalesce(locked_at, now()),
         locked_reason = coalesce(locked_reason, 'sent_to_client'),
         resend_last_email_id = nullif(btrim(p_provider_email_id), ''),
         last_email_delivery_status = 'sent',
         last_email_delivery_at = now(),
         updated_at = now()
   where id = v_delivery.invoice_id and organization_id = p_organization_id
   returning * into v_invoice;

  v_pdf_base64 := nullif(v_delivery.metadata->>'attachmentDataBase64', '');

  v_version := public.create_invoice_version_snapshot(
    v_delivery.invoice_id,
    p_organization_id,
    'sent_to_client',
    p_actor_user_id,
    v_delivery.id,
    null,
    v_delivery.attachment_file_name,
    v_delivery.attachment_mime_type,
    v_delivery.attachment_size_bytes,
    v_delivery.attachment_sha256,
    null,
    jsonb_build_object('provider_email_id', p_provider_email_id, 'pdfDataBase64Stored', v_pdf_base64 is not null)
  );

  if v_pdf_base64 is not null then
    update public.invoice_versions
       set pdf_data_base64 = v_pdf_base64,
           pdf_storage_provider = 'database',
           pdf_storage_key = 'invoice_versions/' || v_version.id::text || '.pdf.base64'
     where id = v_version.id;
  end if;

  update public.invoice_email_deliveries
     set invoice_version_id = v_version.id,
         updated_at = now()
   where id = v_delivery.id
   returning * into v_delivery;

  update public.finance_provider_jobs
     set status = 'completed', provider_object_id = nullif(btrim(p_provider_email_id), ''), updated_at = now()
   where provider = 'resend' and job_type = 'send_invoice_email' and idempotency_key = 'invoice-email-' || v_delivery.id::text;

  perform public.insert_invoice_workflow_event(p_organization_id, v_invoice.id, 'sent_to_client', 'Factuur verzonden naar klant', 'Factuur ' || v_invoice.number || ' is via Resend verzonden en vergrendeld.', jsonb_build_object('delivery_id', v_delivery.id, 'provider_email_id', p_provider_email_id, 'version_id', v_version.id), p_actor_user_id);
  perform public.insert_invoice_workflow_event(p_organization_id, v_invoice.id, 'locked', 'Factuur vergrendeld', 'Verzonden facturen kunnen niet meer inhoudelijk worden gewijzigd.', jsonb_build_object('reason', 'sent_to_client', 'version_id', v_version.id), p_actor_user_id);

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, p_actor_user_id, 'invoice_sent_to_client', 'invoice', v_invoice.id, v_invoice.number, jsonb_build_object('delivery_id', v_delivery.id, 'provider_email_id', p_provider_email_id, 'version_id', v_version.id));

  return jsonb_build_object('delivery', to_jsonb(v_delivery), 'invoice', to_jsonb(v_invoice), 'version', to_jsonb(v_version));
end;
$$;

-- ------------------------------------------------------------
-- 1, 2, 3, 5, 10. Payment checkout lifecycle.
-- ------------------------------------------------------------
create or replace function public.begin_invoice_payment_checkout(
  p_invoice_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_amount_cents integer,
  p_public_token_hash text default null,
  p_public_token_expires_at timestamptz default null,
  p_currency text default 'EUR',
  p_idempotency_key text default null,
  p_checkout_expires_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_payment_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_existing public.invoice_payment_records;
  v_payment public.invoice_payment_records;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_public_token text;
  v_link public.invoice_public_links;
begin
  if p_actor_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden.' using errcode = '02000'; end if;
  if v_invoice.status in ('paid','cancelled','void','written_off') then
    raise exception 'Voor deze factuur kan geen betaallink worden aangemaakt.' using errcode = '23514';
  end if;
  if p_amount_cents <= 0 then raise exception 'Factuurbedrag moet groter zijn dan 0.' using errcode = '23514'; end if;

  select * into v_existing
  from public.invoice_payment_records p
  where p.organization_id = p_organization_id
    and p.invoice_id = p_invoice_id
    and p.provider = 'mollie'
    and p.status in ('creating','open','pending','authorized')
    and (p.checkout_expires_at is null or p.checkout_expires_at > now())
  order by p.created_at desc
  limit 1
  for update;

  if found then
    return v_existing;
  end if;

  insert into public.invoice_payment_records(
    organization_id, invoice_id, created_by, amount_cents, currency, status,
    idempotency_key, checkout_expires_at, metadata
  ) values (
    p_organization_id, p_invoice_id, p_actor_user_id, p_amount_cents,
    upper(coalesce(nullif(btrim(p_currency), ''), 'EUR')), 'creating', v_key,
    p_checkout_expires_at, coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_payment;

  update public.invoices
     set locked_at = coalesce(locked_at, now()),
         locked_reason = coalesce(locked_reason, 'payment_checkout_created'),
         updated_at = now()
   where id = p_invoice_id and organization_id = p_organization_id;

  v_public_token := substring(coalesce(p_metadata->>'publicUrl', '') from '/invoice/([^?/#]+)');
  if v_public_token is not null and btrim(v_public_token) <> '' then
    v_link := public.create_invoice_public_link(
      p_invoice_id,
      p_organization_id,
      v_public_token,
      'payment',
      p_checkout_expires_at,
      null,
      v_payment.id,
      p_actor_user_id,
      jsonb_build_object('publicUrl', p_metadata->>'publicUrl')
    );
  end if;

  insert into public.finance_provider_jobs(organization_id, entity_type, entity_id, provider, job_type, status, idempotency_key, request_payload)
  values (p_organization_id, 'payment', v_payment.id, 'mollie', 'create_invoice_payment', 'queued', coalesce(v_key, 'invoice-payment-' || v_payment.id::text), jsonb_build_object('invoice_id', p_invoice_id, 'amount_cents', p_amount_cents))
  on conflict (provider, job_type, idempotency_key) where idempotency_key is not null do update
    set updated_at = now();

  return v_payment;
exception when unique_violation then
  select * into v_payment
  from public.invoice_payment_records
  where organization_id = p_organization_id
    and invoice_id = p_invoice_id
    and provider = 'mollie'
    and status in ('creating','open','pending','authorized')
  order by created_at desc
  limit 1;

  if found then return v_payment; end if;
  raise;
end;
$$;

create or replace function public.complete_invoice_payment_checkout(
  p_payment_record_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_provider_payment_id text,
  p_provider_checkout_url text,
  p_status text default 'open',
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_payment_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.invoice_payment_records;
  v_invoice public.invoices;
  v_public_token text;
  v_version public.invoice_versions;
  v_link public.invoice_public_links;
  v_status text := case when p_status in ('open','pending','authorized','paid','failed','expired','canceled','refunded','charged_back') then p_status else 'open' end;
begin
  if auth.role() <> 'service_role' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  update public.invoice_payment_records
     set provider_payment_id = nullif(btrim(p_provider_payment_id), ''),
         provider_checkout_url = nullif(btrim(p_provider_checkout_url), ''),
         status = v_status,
         metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
         updated_at = now()
   where id = p_payment_record_id
     and organization_id = p_organization_id
   returning * into v_payment;

  if not found then raise exception 'Payment record niet gevonden.' using errcode = '02000'; end if;

  select * into v_invoice
  from public.invoices
  where id = v_payment.invoice_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'Factuur niet gevonden bij payment record.' using errcode = '02000'; end if;

  v_public_token := substring(coalesce(p_provider_checkout_url, '') from '/invoice/([^?/#]+)');
  if v_public_token is not null and btrim(v_public_token) <> '' then
    v_link := public.create_invoice_public_link(
      v_payment.invoice_id,
      p_organization_id,
      v_public_token,
      'payment',
      v_payment.checkout_expires_at,
      null,
      v_payment.id,
      p_actor_user_id,
      jsonb_build_object('checkoutUrl', p_provider_checkout_url, 'providerPaymentId', v_payment.provider_payment_id)
    );
  end if;

  v_version := public.create_invoice_version_snapshot(
    v_payment.invoice_id,
    p_organization_id,
    'payment_created',
    p_actor_user_id,
    null,
    v_payment.id,
    v_invoice.last_pdf_file_name,
    v_invoice.last_pdf_mime_type,
    v_invoice.last_pdf_size_bytes,
    v_invoice.last_pdf_sha256,
    null,
    jsonb_build_object('provider_payment_id', v_payment.provider_payment_id, 'checkout_url_created', v_payment.provider_checkout_url is not null, 'public_link_id', v_link.id)
  );

  update public.finance_provider_jobs
     set status = 'provider_created', provider_object_id = v_payment.provider_payment_id, response_payload = coalesce(p_metadata, '{}'::jsonb), updated_at = now()
   where provider = 'mollie' and job_type = 'create_invoice_payment' and entity_id = v_payment.id;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    v_payment.invoice_id,
    'payment_link_created',
    'Mollie-betaallink aangemaakt',
    'Betaallink klaar voor factuurbetaling. De factuur is inhoudelijk vergrendeld.',
    jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', v_payment.provider_payment_id, 'version_id', v_version.id, 'public_link_id', v_link.id),
    p_actor_user_id
  );

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    v_payment.invoice_id,
    'locked',
    'Factuur vergrendeld',
    'Facturen met actieve betaalrecords kunnen niet meer inhoudelijk worden gewijzigd.',
    jsonb_build_object('reason', 'payment_checkout_created', 'payment_record_id', v_payment.id),
    p_actor_user_id
  );

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, p_actor_user_id, 'invoice_payment_link_created', 'invoice', v_invoice.id, v_invoice.number, jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', v_payment.provider_payment_id, 'version_id', v_version.id));

  return v_payment;
end;
$$;

create or replace function public.update_invoice_payment_status(
  p_provider_payment_id text,
  p_status text,
  p_paid_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.invoice_payment_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.invoice_payment_records;
  v_previous_status text;
  v_invoice public.invoices;
  v_event_type text;
  v_title text;
  v_status text := case when p_status in ('open','pending','authorized','paid','failed','expired','canceled','refunded','charged_back') then p_status else 'open' end;
begin
  select * into v_payment
  from public.invoice_payment_records
  where provider = 'mollie'
    and provider_payment_id = p_provider_payment_id
  for update;

  if not found then
    raise exception 'Payment record niet gevonden voor provider-payment-id.' using errcode = '02000';
  end if;

  v_previous_status := v_payment.status;

  update public.invoice_payment_records
     set status = v_status,
         paid_at = case when v_status = 'paid' then coalesce(v_payment.paid_at, p_paid_at, now()) else paid_at end,
         last_webhook_at = now(),
         metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
         updated_at = now()
   where id = v_payment.id
   returning * into v_payment;

  select * into v_invoice
  from public.invoices
  where id = v_payment.invoice_id and organization_id = v_payment.organization_id
  for update;

  if not found then raise exception 'Factuur niet gevonden bij payment record.' using errcode = '02000'; end if;

  if v_status = 'paid' then
    update public.invoices
       set status = 'paid',
           paid_at = coalesce(v_invoice.paid_at, v_payment.paid_at, now()),
           locked_at = coalesce(v_invoice.locked_at, now()),
           locked_reason = coalesce(v_invoice.locked_reason, 'paid'),
           updated_at = now()
     where id = v_invoice.id
     returning * into v_invoice;

    if v_previous_status is distinct from 'paid' then
      perform public.create_invoice_version_snapshot(
        v_invoice.id,
        v_invoice.organization_id,
        'paid',
        null,
        null,
        v_payment.id,
        v_invoice.last_pdf_file_name,
        v_invoice.last_pdf_mime_type,
        v_invoice.last_pdf_size_bytes,
        v_invoice.last_pdf_sha256,
        null,
        jsonb_build_object('provider_payment_id', p_provider_payment_id)
      );
    end if;
  end if;

  v_event_type := case
    when v_status = 'paid' then 'payment_paid'
    when v_status = 'expired' then 'payment_expired'
    when v_status in ('failed','canceled','refunded','charged_back') then 'payment_failed'
    else 'payment_open'
  end;
  v_title := case
    when v_status = 'paid' then 'Factuur betaald'
    when v_status = 'expired' then 'Betaallink verlopen'
    when v_status in ('failed','canceled','refunded','charged_back') then 'Betaling mislukt'
    else 'Betaalstatus bijgewerkt'
  end;

  if v_previous_status is distinct from v_status then
    perform public.insert_invoice_workflow_event(
      v_invoice.organization_id,
      v_invoice.id,
      v_event_type,
      v_title,
      'Mollie status: ' || v_status,
      jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id, 'previous_status', v_previous_status, 'status', v_status),
      null
    );
  end if;

  if v_status = 'paid' and v_previous_status is distinct from 'paid' then
    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (v_invoice.organization_id, null, 'invoice_paid', 'invoice', v_invoice.id, v_invoice.number, jsonb_build_object('payment_record_id', v_payment.id, 'provider_payment_id', p_provider_payment_id));
  end if;

  return v_payment;
end;
$$;

-- ------------------------------------------------------------
-- Permissions for new/changed RPCs.
-- ------------------------------------------------------------
revoke execute on function public.create_invoice_public_link(uuid, uuid, text, text, timestamptz, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.resolve_invoice_public_link(text, boolean) from public, anon, authenticated;
revoke execute on function public.begin_invoice_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text, text) from public, anon, authenticated;

grant execute on function public.resolve_invoice_public_link(text, boolean) to service_role;
grant execute on function public.create_invoice_public_link(uuid, uuid, text, text, timestamptz, uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.begin_invoice_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text, text) to service_role;

grant execute on function public.convert_accepted_quote_to_invoice(uuid, uuid) to authenticated;
grant execute on function public.begin_invoice_payment_checkout(uuid, uuid, uuid, integer, text, timestamptz, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.complete_invoice_payment_checkout(uuid, uuid, uuid, text, text, text, jsonb) to service_role;
grant execute on function public.update_invoice_payment_status(text, text, timestamptz, jsonb) to service_role;

commit;
