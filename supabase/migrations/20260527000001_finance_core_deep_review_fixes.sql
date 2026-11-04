-- ============================================================
-- ResoFly — Finance core deep review fixes
-- Date: 2026-05-27
-- Purpose: Finalize the 10 finance-core hardening points after code review.
-- ============================================================

create extension if not exists pgcrypto;

begin;

-- 1. Public invoice links are the source of truth. Legacy invoice token columns
-- may remain for older rows/UI labels, but new flows resolve through this table.
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
    p_organization_id,
    p_invoice_id,
    v_token_hash,
    case when p_purpose in ('invoice_view','email','payment','portal') then p_purpose else 'invoice_view' end,
    'active',
    p_delivery_id,
    p_payment_record_id,
    p_expires_at,
    p_created_by,
    coalesce(p_metadata, '{}'::jsonb)
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
  if nullif(btrim(coalesce(p_token, '')), '') is null then
    return;
  end if;

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

  -- Legacy fallback only for old links that existed before invoice_public_links.
  select * into v_invoice
  from public.invoices
  where public_token_hash = v_hash
    and (public_token_expires_at is null or public_token_expires_at > now())
  limit 1;

  if found then
    return query select null::uuid, v_invoice.organization_id, v_invoice.id, 'invoice_view'::text, v_invoice.public_token_expires_at;
  end if;
end;
$$;

-- 4. Quote -> invoice must use the accepted/sent immutable quote snapshot,
-- not the mutable live quote row.
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
    and qv.id = coalesce(v_quote.accepted_sent_version_id, v_quote.accepted_version_id, v_quote.sent_version_id)
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

  if not found or v_quote_version.id is null then
    raise exception 'Deze offerte heeft geen geaccepteerde/verzonden versie-snapshot. Maak of herstel eerst een offerteversie voordat je factureert.' using errcode = '23514';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'id', coalesce(qvi.source_line_id, qvi.id::text),
      'description', qvi.description,
      'quantity', qvi.quantity,
      'unit_price', qvi.unit_price,
      'vat', qvi.vat_percentage
    ) order by qvi.line_index
  ) into v_lines
  from public.quote_version_items qvi
  where qvi.quote_version_id = v_quote_version.id
    and qvi.organization_id = p_organization_id
    and qvi.quote_id = p_quote_id;

  v_lines := coalesce(v_lines, v_quote_version.snapshot_data #> '{quote,lines}');
  v_notes := v_quote_version.notes;
  v_quote_date := v_quote_version.quote_date;
  v_valid_until := v_quote_version.valid_until;

  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'De geaccepteerde offerteversie bevat geen geldige regels.' using errcode = '23514';
  end if;

  v_invoice_number := public.allocate_next_invoice_number(p_organization_id, current_date);

  insert into public.invoices(
    organization_id, created_by, client_id, project_id, quote_id, source_quote_version_id,
    number, date, due_date, lines, status, notes
  ) values (
    p_organization_id, v_user_id, v_quote_version.client_id, v_quote_version.project_id, v_quote.id, v_quote_version.id,
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

-- 7. Store exact PDF snapshot location in immutable invoice versions.
drop function if exists public.begin_invoice_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text);
drop function if exists public.begin_invoice_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text, text);
drop function if exists public.begin_invoice_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text, text, text);
drop function if exists public.begin_invoice_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text, text, text, text);

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
  p_attachment_data_base64 text default null,
  p_attachment_storage_provider text default null,
  p_attachment_storage_key text default null
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
  v_storage_provider text := nullif(btrim(coalesce(p_attachment_storage_provider, '')), '');
  v_storage_key text := nullif(btrim(coalesce(p_attachment_storage_key, '')), '');
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

  if p_attachment_file_name is null or p_attachment_size_bytes is null or p_attachment_size_bytes <= 0 or p_attachment_sha256 is null then
    raise exception 'Factuurmail vereist een echte PDF-snapshot met bestandsnaam, grootte en SHA-256 hash.' using errcode = '23514';
  end if;

  if v_storage_provider = 'r2' and v_storage_key is null then
    raise exception 'R2 PDF storage provider vereist een storage key.' using errcode = '23514';
  end if;

  if v_storage_provider is null and nullif(btrim(coalesce(p_attachment_data_base64, '')), '') is null then
    raise exception 'PDF-snapshot moet in private storage of als database-fallback worden vastgelegd.' using errcode = '23514';
  end if;

  insert into public.invoice_email_deliveries(
    organization_id, invoice_id, recipient_email, recipient_name, subject, status,
    attachment_file_name, attachment_mime_type, attachment_size_bytes, attachment_sha256,
    metadata
  ) values (
    p_organization_id, p_invoice_id, lower(btrim(p_recipient_email)), nullif(btrim(coalesce(p_recipient_name, '')), ''), p_subject, 'queued',
    nullif(btrim(coalesce(p_attachment_file_name, '')), ''), coalesce(nullif(btrim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'), p_attachment_size_bytes, lower(nullif(btrim(coalesce(p_attachment_sha256, '')), '')),
    jsonb_strip_nulls(jsonb_build_object(
      'publicUrl', p_public_url,
      'attachmentDataBase64', p_attachment_data_base64,
      'attachmentStorageProvider', v_storage_provider,
      'attachmentStorageKey', v_storage_key
    ))
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
  v_storage_provider text;
  v_storage_key text;
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
  v_storage_provider := nullif(v_delivery.metadata->>'attachmentStorageProvider', '');
  v_storage_key := nullif(v_delivery.metadata->>'attachmentStorageKey', '');

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
    jsonb_build_object(
      'provider_email_id', p_provider_email_id,
      'pdfStoredInDatabase', v_pdf_base64 is not null,
      'pdfStorageProvider', v_storage_provider,
      'pdfStorageKeyPresent', v_storage_key is not null
    )
  );

  update public.invoice_versions
     set pdf_data_base64 = case when v_pdf_base64 is not null then v_pdf_base64 else pdf_data_base64 end,
         pdf_storage_provider = coalesce(v_storage_provider, case when v_pdf_base64 is not null then 'database' else pdf_storage_provider end),
         pdf_storage_key = coalesce(v_storage_key, case when v_pdf_base64 is not null then 'invoice_versions/' || v_version.id::text || '.pdf.base64' else pdf_storage_key end)
   where id = v_version.id
   returning * into v_version;

  update public.invoice_email_deliveries
     set invoice_version_id = v_version.id,
         updated_at = now()
   where id = v_delivery.id
   returning * into v_delivery;

  update public.finance_provider_jobs
     set status = 'completed', provider_object_id = nullif(btrim(p_provider_email_id), ''), updated_at = now()
   where provider = 'resend' and job_type = 'send_invoice_email' and idempotency_key = 'invoice-email-' || v_delivery.id::text;

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    v_delivery.invoice_id,
    'sent_to_client',
    'Factuur verzonden',
    'Factuur is via Resend verzonden en inhoudelijk vergrendeld.',
    jsonb_build_object('delivery_id', v_delivery.id, 'provider_email_id', p_provider_email_id, 'version_id', v_version.id, 'storage_provider', v_version.pdf_storage_provider),
    p_actor_user_id
  );

  perform public.insert_invoice_workflow_event(
    p_organization_id,
    v_delivery.invoice_id,
    'locked',
    'Factuur vergrendeld',
    'De verzonden factuur kan niet meer inhoudelijk worden gewijzigd.',
    jsonb_build_object('reason', 'sent_to_client', 'version_id', v_version.id),
    p_actor_user_id
  );

  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, p_actor_user_id, 'invoice_sent_to_client', 'invoice', v_invoice.id, v_invoice.number, jsonb_build_object('delivery_id', v_delivery.id, 'provider_email_id', p_provider_email_id, 'version_id', v_version.id));

  return jsonb_build_object('delivery', to_jsonb(v_delivery), 'invoice', to_jsonb(v_invoice), 'version', to_jsonb(v_version));
end;
$$;

-- 5 + 6. Re-assert hard payment constraints after any prior migrations.
with ranked_active as (
  select id, row_number() over (partition by organization_id, invoice_id order by created_at desc, id desc) as rn
  from public.invoice_payment_records
  where provider = 'mollie' and status in ('creating','open','pending','authorized')
)
update public.invoice_payment_records p
   set status = 'expired',
       error_message = coalesce(error_message, 'Expired by deep finance hardening because another active checkout exists.'),
       updated_at = now()
from ranked_active r
where p.id = r.id and r.rn > 1;

drop index if exists public.idx_invoice_payment_one_active_mollie;
create unique index idx_invoice_payment_one_active_mollie
  on public.invoice_payment_records(organization_id, invoice_id)
  where provider = 'mollie' and status in ('creating','open','pending','authorized');

with ranked_provider as (
  select id, row_number() over (partition by provider, provider_payment_id order by created_at desc, id desc) as rn
  from public.invoice_payment_records
  where provider_payment_id is not null
)
update public.invoice_payment_records p
   set provider_payment_id = p.provider_payment_id || '_duplicate_' || p.id::text,
       status = case when p.status in ('creating','open','pending','authorized') then 'failed' else p.status end,
       error_message = coalesce(error_message, 'Duplicate provider payment id quarantined by deep finance hardening.'),
       updated_at = now()
from ranked_provider r
where p.id = r.id and r.rn > 1;

drop index if exists public.idx_invoice_payment_provider_payment_unique;
create unique index idx_invoice_payment_provider_payment_unique
  on public.invoice_payment_records(provider, provider_payment_id)
  where provider_payment_id is not null;

with ranked_email_provider as (
  select id, row_number() over (partition by provider, provider_email_id order by created_at desc, id desc) as rn
  from public.invoice_email_deliveries
  where provider_email_id is not null
)
update public.invoice_email_deliveries d
   set provider_email_id = d.provider_email_id || '_duplicate_' || d.id::text,
       status = case when d.status in ('queued','sent') then 'failed' else d.status end,
       error_message = coalesce(d.error_message, 'Duplicate provider email id quarantined by deep finance hardening.'),
       updated_at = now()
from ranked_email_provider r
where d.id = r.id and r.rn > 1;

create unique index if not exists idx_invoice_email_provider_email_unique
  on public.invoice_email_deliveries(provider, provider_email_id)
  where provider_email_id is not null;

-- 10. Provider outbox/retry mechanism.
create or replace function public.claim_finance_provider_jobs(
  p_provider text,
  p_job_type text default null,
  p_limit integer default 10
)
returns setof public.finance_provider_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen service_role mag provider jobs claimen.' using errcode = '42501';
  end if;

  return query
  with candidates as (
    select id
    from public.finance_provider_jobs
    where provider = p_provider
      and (p_job_type is null or job_type = p_job_type)
      and status in ('queued','retry')
      and (next_retry_at is null or next_retry_at <= now())
    order by created_at asc
    limit greatest(1, least(coalesce(p_limit, 10), 50))
    for update skip locked
  )
  update public.finance_provider_jobs j
     set status = 'processing',
         retry_count = retry_count + 1,
         updated_at = now()
  from candidates c
  where j.id = c.id
  returning j.*;
end;
$$;

create or replace function public.complete_finance_provider_job(
  p_job_id uuid,
  p_provider_object_id text default null,
  p_response_payload jsonb default '{}'::jsonb
)
returns public.finance_provider_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.finance_provider_jobs;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen service_role mag provider jobs afronden.' using errcode = '42501';
  end if;

  update public.finance_provider_jobs
     set status = 'completed',
         provider_object_id = coalesce(nullif(btrim(coalesce(p_provider_object_id, '')), ''), provider_object_id),
         response_payload = coalesce(p_response_payload, '{}'::jsonb),
         last_error = null,
         updated_at = now()
   where id = p_job_id
   returning * into v_job;

  if not found then raise exception 'Provider job niet gevonden.' using errcode = '02000'; end if;
  return v_job;
end;
$$;

create or replace function public.fail_finance_provider_job(
  p_job_id uuid,
  p_error text,
  p_retry_after_seconds integer default 300,
  p_max_retries integer default 5
)
returns public.finance_provider_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.finance_provider_jobs;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen service_role mag provider jobs falen/retryen.' using errcode = '42501';
  end if;

  update public.finance_provider_jobs
     set status = case when retry_count < coalesce(p_max_retries, 5) then 'retry' else 'failed' end,
         last_error = left(coalesce(p_error, 'Onbekende providerfout'), 2000),
         next_retry_at = case when retry_count < coalesce(p_max_retries, 5) then now() + make_interval(secs => greatest(30, coalesce(p_retry_after_seconds, 300))) else null end,
         updated_at = now()
   where id = p_job_id
   returning * into v_job;

  if not found then raise exception 'Provider job niet gevonden.' using errcode = '02000'; end if;
  return v_job;
end;
$$;

revoke execute on function public.claim_finance_provider_jobs(text, text, integer) from public, anon, authenticated;
revoke execute on function public.complete_finance_provider_job(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.fail_finance_provider_job(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_finance_provider_jobs(text, text, integer) to service_role;
grant execute on function public.complete_finance_provider_job(uuid, text, jsonb) to service_role;
grant execute on function public.fail_finance_provider_job(uuid, text, integer, integer) to service_role;

-- Grants for the new begin_invoice_email_send signature.
revoke execute on function public.begin_invoice_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text, text, text, text) from public, anon, authenticated;
grant execute on function public.begin_invoice_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text, text, text, text) to service_role;

commit;
