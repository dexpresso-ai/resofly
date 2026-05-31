-- ============================================================
-- BrandCore / ResoFly — Quote PDF snapshot storage (private R2)
-- Date: 2026-05-29
-- Scope:
-- - Persist the exact PDF that was e-mailed to the client as an immutable
--   quote snapshot, so it can always be re-downloaded from the quote page.
-- - Mirror the invoice snapshot architecture: store the bytes in private R2
--   (through the Cloudflare Worker) with a base64-in-database fallback when
--   R2 is not configured.
--
-- Changes:
-- 1. Add pdf_data_base64 / pdf_storage_provider / pdf_storage_key / is_immutable
--    columns to public.quote_versions (parity with invoice_versions).
-- 2. Carry attachment storage metadata on the queued delivery so the snapshot
--    created at send-time can be linked to the stored object.
-- 3. Extend begin_quote_email_send to accept + persist the storage pointers.
-- 4. Extend complete_quote_email_send to copy the storage pointers onto the
--    'sent_to_client' quote version that create_quote_version_snapshot creates.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Immutable PDF storage columns on quote_versions
-- ------------------------------------------------------------
alter table public.quote_versions
  add column if not exists pdf_data_base64 text,
  add column if not exists pdf_storage_provider text,
  add column if not exists pdf_storage_key text,
  add column if not exists is_immutable boolean not null default true;

-- ------------------------------------------------------------
-- 2. begin_quote_email_send: accept + persist storage pointers
--    (drop the previous 13-arg signature before recreating).
-- ------------------------------------------------------------
drop function if exists public.begin_quote_email_send(
  uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text
);

create or replace function public.begin_quote_email_send(
  p_quote_id uuid,
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
  v_quote public.quotes;
  v_delivery public.quote_email_deliveries;
  v_storage_provider text := nullif(btrim(coalesce(p_attachment_storage_provider, '')), '');
  v_storage_key text := nullif(btrim(coalesce(p_attachment_storage_key, '')), '');
  v_data_base64 text := nullif(btrim(coalesce(p_attachment_data_base64, '')), '');
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de server mag een offerte-e-mail voorbereiden' using errcode = '42501';
  end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status <> 'internally_approved' or v_quote.internal_approval_status <> 'approved' then
    raise exception 'Alleen intern goedgekeurde offertes kunnen worden verstuurd' using errcode = '23514';
  end if;
  if v_quote.valid_until is not null and v_quote.valid_until < current_date then
    raise exception 'Deze offerte is verlopen en kan niet meer worden verstuurd' using errcode = '23514';
  end if;

  -- A real PDF snapshot is mandatory: either stored in private R2 or as a
  -- base64 database fallback. This guarantees the sent PDF can always be
  -- re-downloaded afterwards.
  if v_storage_provider = 'r2' and v_storage_key is null then
    raise exception 'R2 PDF storage provider vereist een storage key.' using errcode = '23514';
  end if;
  if v_storage_provider is null and v_data_base64 is null then
    raise exception 'PDF-snapshot moet in private storage of als database-fallback worden vastgelegd.' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.quote_email_deliveries d
    where d.quote_id = p_quote_id
      and d.organization_id = p_organization_id
      and d.status = 'queued'
      and d.created_at > now() - interval '15 minutes'
  ) then
    raise exception 'Er loopt al een recente Resend-verzendpoging voor deze offerte' using errcode = '23505';
  end if;

  update public.quotes
  set public_token_hash = p_token_hash,
      public_token_created_at = now(),
      public_token_expires_at = p_token_expires_at,
      last_email_delivery_status = 'queued',
      last_pdf_file_name = coalesce(nullif(trim(coalesce(p_attachment_file_name, '')), ''), last_pdf_file_name),
      last_pdf_mime_type = coalesce(nullif(trim(coalesce(p_attachment_mime_type, '')), ''), last_pdf_mime_type),
      last_pdf_size_bytes = coalesce(p_attachment_size_bytes, last_pdf_size_bytes),
      last_pdf_sha256 = coalesce(nullif(trim(coalesce(p_attachment_sha256, '')), ''), last_pdf_sha256),
      updated_at = now()
  where id = p_quote_id
  returning * into v_quote;

  insert into public.quote_email_deliveries(
    organization_id,
    quote_id,
    provider,
    provider_email_id,
    recipient_email,
    recipient_name,
    subject,
    status,
    last_event_at,
    attachment_file_name,
    attachment_mime_type,
    attachment_size_bytes,
    attachment_sha256,
    metadata
  ) values (
    p_organization_id,
    p_quote_id,
    'resend',
    null,
    lower(trim(p_recipient_email)),
    nullif(trim(coalesce(p_recipient_name, '')), ''),
    p_subject,
    'queued',
    now(),
    nullif(trim(coalesce(p_attachment_file_name, '')), ''),
    coalesce(nullif(trim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'),
    p_attachment_size_bytes,
    nullif(trim(coalesce(p_attachment_sha256, '')), ''),
    jsonb_strip_nulls(jsonb_build_object(
      'publicUrl', p_public_url,
      'expiresAt', p_token_expires_at,
      'attachmentDataBase64', v_data_base64,
      'attachmentStorageProvider', v_storage_provider,
      'attachmentStorageKey', v_storage_key,
      'attachment', jsonb_build_object(
        'fileName', nullif(trim(coalesce(p_attachment_file_name, '')), ''),
        'mimeType', coalesce(nullif(trim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'),
        'sizeBytes', p_attachment_size_bytes,
        'sha256', nullif(trim(coalesce(p_attachment_sha256, '')), '')
      )
    ))
  ) returning * into v_delivery;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'public_token_created', 'Publieke offertelink aangemaakt', 'Link voorbereid voor verzending via Resend.', jsonb_build_object('expiresAt', p_token_expires_at), p_actor_user_id);

  return jsonb_build_object('deliveryId', v_delivery.id, 'quoteId', v_quote.id);
end;
$$;

-- ------------------------------------------------------------
-- 3. complete_quote_email_send: copy storage pointers onto the
--    sent_to_client snapshot version.
-- ------------------------------------------------------------
create or replace function public.complete_quote_email_send(
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
  v_delivery public.quote_email_deliveries;
  v_quote public.quotes;
  v_version public.quote_versions;
  v_now timestamptz := now();
  v_pdf_base64 text;
  v_storage_provider text;
  v_storage_key text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de server mag een offerte-e-mail afronden' using errcode = '42501';
  end if;

  select * into v_delivery
  from public.quote_email_deliveries
  where id = p_delivery_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'E-maildelivery niet gevonden' using errcode = '02000'; end if;

  select * into v_quote
  from public.quotes
  where id = v_delivery.quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status <> 'internally_approved' or v_quote.internal_approval_status <> 'approved' then
    raise exception 'Offerte staat niet meer klaar om te verzenden' using errcode = '23514';
  end if;

  update public.quote_email_deliveries
  set provider_email_id = nullif(trim(coalesce(p_provider_email_id, '')), ''),
      status = 'sent',
      sent_at = v_now,
      last_event_at = v_now,
      updated_at = v_now
  where id = v_delivery.id
  returning * into v_delivery;

  update public.quotes
  set status = 'sent',
      sent_at = v_now,
      resend_last_email_id = nullif(trim(coalesce(p_provider_email_id, '')), ''),
      last_email_delivery_status = 'sent',
      updated_at = v_now
  where id = v_quote.id
  returning * into v_quote;

  v_pdf_base64 := nullif(btrim(coalesce(v_delivery.metadata->>'attachmentDataBase64', '')), '');
  v_storage_provider := nullif(btrim(coalesce(v_delivery.metadata->>'attachmentStorageProvider', '')), '');
  v_storage_key := nullif(btrim(coalesce(v_delivery.metadata->>'attachmentStorageKey', '')), '');

  v_version := public.create_quote_version_snapshot(
    v_quote.id,
    p_organization_id,
    'sent_to_client',
    p_actor_user_id,
    v_delivery.id,
    v_delivery.attachment_file_name,
    v_delivery.attachment_mime_type,
    v_delivery.attachment_size_bytes,
    v_delivery.attachment_sha256,
    null,
    jsonb_build_object(
      'provider', 'resend',
      'providerEmailId', p_provider_email_id,
      'recipientEmail', v_delivery.recipient_email,
      'pdfStoredInDatabase', v_pdf_base64 is not null,
      'pdfStorageProvider', v_storage_provider,
      'pdfStorageKeyPresent', v_storage_key is not null
    )
  );

  -- Persist the immutable PDF pointers on the just-created sent version.
  -- Note on pdf_storage_key for the database fallback: when there is no R2 key
  -- (provider = 'database'), we record a SYNTHETIC pointer of the form
  -- 'db://quote_versions/{version_id}.pdf.base64'. This is NOT an R2 object key
  -- and must never be sent to the Cloudflare Worker. It exists only as a stable,
  -- human-readable marker that the bytes live inline in pdf_data_base64. Real R2
  -- keys follow the schema '{org}/quote-pdfs/{quoteId}/{uuid}-{name}.pdf'; the
  -- 'db://' prefix makes the two unambiguously distinguishable.
  update public.quote_versions
  set pdf_data_base64 = case when v_pdf_base64 is not null then v_pdf_base64 else pdf_data_base64 end,
      pdf_storage_provider = coalesce(v_storage_provider, case when v_pdf_base64 is not null then 'database' else pdf_storage_provider end),
      pdf_storage_key = coalesce(v_storage_key, case when v_pdf_base64 is not null then 'db://quote_versions/' || v_version.id::text || '.pdf.base64' else pdf_storage_key end)
  where id = v_version.id
  returning * into v_version;

  perform public.insert_quote_workflow_event(p_organization_id, v_quote.id, 'email_sent', 'E-mail geaccepteerd door Resend', null, jsonb_build_object('providerEmailId', p_provider_email_id, 'versionId', v_version.id, 'storageProvider', v_version.pdf_storage_provider), p_actor_user_id);
  perform public.insert_quote_workflow_event(p_organization_id, v_quote.id, 'sent_to_client', 'Offerte naar klant verzonden', 'Verstuurd naar ' || v_delivery.recipient_email || '.', jsonb_build_object('recipientEmail', v_delivery.recipient_email, 'providerEmailId', p_provider_email_id, 'versionId', v_version.id), p_actor_user_id);
  perform public.insert_quote_audit_event(p_organization_id, v_quote.id, 'quote_sent_to_client', v_quote.number, jsonb_build_object('recipientEmail', v_delivery.recipient_email, 'providerEmailId', p_provider_email_id, 'versionId', v_version.id), p_actor_user_id);

  return jsonb_build_object('delivery', to_jsonb(v_delivery), 'quote', to_jsonb(v_quote), 'version', to_jsonb(v_version));
end;
$$;

-- ------------------------------------------------------------
-- 4. Re-apply grants (signatures changed).
-- ------------------------------------------------------------
revoke execute on function public.begin_quote_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text, text, text, text) from public, anon, authenticated;
grant execute on function public.begin_quote_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text, text, text, text) to service_role;
grant execute on function public.complete_quote_email_send(uuid, uuid, uuid, text) to service_role;

commit;
