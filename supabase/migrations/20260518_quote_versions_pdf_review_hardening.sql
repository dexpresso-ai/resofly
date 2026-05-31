-- ============================================================
-- BrandCore / ResoFly — Quote versions + PDF attachment review hardening
-- Date: 2026-05-18
-- Scope:
-- - Do not write PDF metadata for non-PDF snapshots
-- - Require real PDF metadata/hash for sent quote snapshots
-- - Return quote rows after snapshot pointers are updated
-- - Add consistency checks for immutable quote version items
-- ============================================================

begin;

-- Guardrails around generated PDF metadata.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quote_versions'::regclass
      and conname = 'quote_versions_pdf_size_positive_check'
  ) then
    alter table public.quote_versions
      add constraint quote_versions_pdf_size_positive_check
      check (pdf_size_bytes is null or pdf_size_bytes > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quote_versions'::regclass
      and conname = 'quote_versions_pdf_sha256_check'
  ) then
    alter table public.quote_versions
      add constraint quote_versions_pdf_sha256_check
      check (pdf_sha256 is null or pdf_sha256 ~ '^[0-9a-f]{64}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quote_email_deliveries'::regclass
      and conname = 'quote_email_deliveries_attachment_size_positive_check'
  ) then
    alter table public.quote_email_deliveries
      add constraint quote_email_deliveries_attachment_size_positive_check
      check (attachment_size_bytes is null or attachment_size_bytes > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quote_email_deliveries'::regclass
      and conname = 'quote_email_deliveries_attachment_sha256_check'
  ) then
    alter table public.quote_email_deliveries
      add constraint quote_email_deliveries_attachment_sha256_check
      check (attachment_sha256 is null or attachment_sha256 ~ '^[0-9a-f]{64}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quote_versions'::regclass
      and conname = 'quote_versions_identity_scope_unique'
  ) then
    alter table public.quote_versions
      add constraint quote_versions_identity_scope_unique unique (id, organization_id, quote_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quote_version_items'::regclass
      and conname = 'quote_version_items_version_scope_fk'
  ) then
    alter table public.quote_version_items
      add constraint quote_version_items_version_scope_fk
      foreign key (quote_version_id, organization_id, quote_id)
      references public.quote_versions(id, organization_id, quote_id)
      on delete cascade;
  end if;
end $$;

create or replace function public.create_quote_version_snapshot(
  p_quote_id uuid,
  p_organization_id uuid,
  p_snapshot_reason text,
  p_actor_user_id uuid default null,
  p_delivery_id uuid default null,
  p_pdf_file_name text default null,
  p_pdf_mime_type text default null,
  p_pdf_size_bytes integer default null,
  p_pdf_sha256 text default null,
  p_quote_version_pdf_url text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.quote_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_delivery public.quote_email_deliveries;
  v_version public.quote_versions;
  v_version_number integer;
  v_line jsonb;
  v_lines jsonb;
  v_index integer := 0;
  v_quantity numeric := 0;
  v_unit_price numeric := 0;
  v_vat_percentage numeric := 0;
  v_line_subtotal numeric := 0;
  v_line_vat numeric := 0;
  v_line_total numeric := 0;
  v_subtotal numeric := 0;
  v_vat_total numeric := 0;
  v_total numeric := 0;
  v_pdf_file_name text := nullif(trim(coalesce(p_pdf_file_name, '')), '');
  v_pdf_sha256 text := lower(nullif(trim(coalesce(p_pdf_sha256, '')), ''));
  v_pdf_url text := nullif(trim(coalesce(p_quote_version_pdf_url, '')), '');
  v_has_pdf boolean;
  v_pdf_mime_type text;
begin
  if p_snapshot_reason not in ('internal_approval','sent_to_client','client_accepted','manual') then
    raise exception 'Ongeldige offerte snapshot reason: %', p_snapshot_reason using errcode = '23514';
  end if;

  if auth.role() = 'authenticated' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie' using errcode = '42501';
  end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;

  if p_delivery_id is not null then
    select * into v_delivery
    from public.quote_email_deliveries
    where id = p_delivery_id
      and quote_id = p_quote_id
      and organization_id = p_organization_id
    for update;

    if not found then raise exception 'E-maildelivery hoort niet bij deze offerte' using errcode = '23514'; end if;
  end if;

  v_has_pdf := v_pdf_file_name is not null or v_pdf_sha256 is not null or p_pdf_size_bytes is not null or v_pdf_url is not null;
  v_pdf_mime_type := case
    when v_has_pdf then coalesce(nullif(trim(coalesce(p_pdf_mime_type, '')), ''), 'application/pdf')
    else null
  end;

  if p_snapshot_reason = 'sent_to_client' then
    if not v_has_pdf or v_pdf_file_name is null or p_pdf_size_bytes is null or p_pdf_size_bytes <= 0 or v_pdf_sha256 is null then
      raise exception 'Een verzonden offerteversie vereist een echte PDF-bijlage met bestandsnaam, grootte en SHA-256 hash' using errcode = '23514';
    end if;
  end if;

  if v_pdf_sha256 is not null and v_pdf_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'PDF SHA-256 hash is ongeldig' using errcode = '23514';
  end if;

  if p_pdf_size_bytes is not null and p_pdf_size_bytes <= 0 then
    raise exception 'PDF-bestandsgrootte moet groter zijn dan 0 bytes' using errcode = '23514';
  end if;

  if v_has_pdf and v_pdf_mime_type <> 'application/pdf' then
    raise exception 'Alleen application/pdf is toegestaan als offertebijlage' using errcode = '23514';
  end if;

  v_lines := coalesce(v_quote.lines, '[]'::jsonb);
  if jsonb_typeof(v_lines) <> 'array' then
    v_lines := '[]'::jsonb;
  end if;

  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_quantity := case when coalesce(v_line->>'quantity', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'quantity')::numeric else 0 end;
    v_unit_price := case when coalesce(v_line->>'unit_price', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'unit_price')::numeric else 0 end;
    v_vat_percentage := case when coalesce(v_line->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'vat')::numeric else 0 end;
    v_line_subtotal := round(v_quantity * v_unit_price, 2);
    v_line_vat := round(v_line_subtotal * (v_vat_percentage / 100), 2);
    v_line_total := round(v_line_subtotal + v_line_vat, 2);
    v_subtotal := v_subtotal + v_line_subtotal;
    v_vat_total := v_vat_total + v_line_vat;
    v_total := v_total + v_line_total;
  end loop;

  select coalesce(max(version_number), 0) + 1
  into v_version_number
  from public.quote_versions
  where organization_id = p_organization_id
    and quote_id = p_quote_id;

  insert into public.quote_versions(
    organization_id,
    quote_id,
    delivery_id,
    version_number,
    snapshot_reason,
    status_at_snapshot,
    internal_approval_status_at_snapshot,
    quote_number,
    client_id,
    project_id,
    quote_date,
    valid_until,
    notes,
    subtotal_amount,
    vat_amount,
    total_amount,
    quote_version_pdf_url,
    pdf_file_name,
    pdf_mime_type,
    pdf_size_bytes,
    pdf_sha256,
    snapshot_data,
    created_by
  ) values (
    p_organization_id,
    p_quote_id,
    p_delivery_id,
    v_version_number,
    p_snapshot_reason,
    v_quote.status,
    v_quote.internal_approval_status,
    v_quote.number,
    v_quote.client_id,
    v_quote.project_id,
    v_quote.date,
    v_quote.valid_until,
    v_quote.notes,
    round(v_subtotal, 2),
    round(v_vat_total, 2),
    round(v_total, 2),
    v_pdf_url,
    v_pdf_file_name,
    v_pdf_mime_type,
    case when v_has_pdf then p_pdf_size_bytes else null end,
    v_pdf_sha256,
    jsonb_build_object(
      'quote', to_jsonb(v_quote) - 'public_token_hash',
      'totals', jsonb_build_object('subtotal', round(v_subtotal, 2), 'vat', round(v_vat_total, 2), 'total', round(v_total, 2)),
      'reason', p_snapshot_reason,
      'deliveryId', p_delivery_id,
      'pdf', case when v_has_pdf then jsonb_build_object(
        'fileName', v_pdf_file_name,
        'mimeType', v_pdf_mime_type,
        'sizeBytes', p_pdf_size_bytes,
        'sha256', v_pdf_sha256,
        'url', v_pdf_url
      ) else '{}'::jsonb end,
      'metadata', coalesce(p_metadata, '{}'::jsonb)
    ),
    p_actor_user_id
  ) returning * into v_version;

  v_index := 0;
  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_quantity := case when coalesce(v_line->>'quantity', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'quantity')::numeric else 0 end;
    v_unit_price := case when coalesce(v_line->>'unit_price', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'unit_price')::numeric else 0 end;
    v_vat_percentage := case when coalesce(v_line->>'vat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_line->>'vat')::numeric else 0 end;
    v_line_subtotal := round(v_quantity * v_unit_price, 2);
    v_line_vat := round(v_line_subtotal * (v_vat_percentage / 100), 2);
    v_line_total := round(v_line_subtotal + v_line_vat, 2);

    insert into public.quote_version_items(
      organization_id,
      quote_id,
      quote_version_id,
      source_line_id,
      line_index,
      description,
      quantity,
      unit_price,
      vat_percentage,
      line_subtotal,
      line_vat,
      line_total
    ) values (
      p_organization_id,
      p_quote_id,
      v_version.id,
      nullif(v_line->>'id', ''),
      v_index,
      coalesce(nullif(trim(coalesce(v_line->>'description', '')), ''), '-'),
      v_quantity,
      v_unit_price,
      v_vat_percentage,
      v_line_subtotal,
      v_line_vat,
      v_line_total
    );

    v_index := v_index + 1;
  end loop;

  update public.quotes
  set latest_version_id = v_version.id,
      internal_approved_version_id = case when p_snapshot_reason = 'internal_approval' then v_version.id else internal_approved_version_id end,
      sent_version_id = case when p_snapshot_reason = 'sent_to_client' then v_version.id else sent_version_id end,
      accepted_version_id = case when p_snapshot_reason = 'client_accepted' then v_version.id else accepted_version_id end,
      last_pdf_file_name = case when v_has_pdf then coalesce(v_pdf_file_name, last_pdf_file_name) else last_pdf_file_name end,
      last_pdf_mime_type = case when v_has_pdf then coalesce(v_pdf_mime_type, last_pdf_mime_type) else last_pdf_mime_type end,
      last_pdf_size_bytes = case when v_has_pdf then coalesce(p_pdf_size_bytes, last_pdf_size_bytes) else last_pdf_size_bytes end,
      last_pdf_sha256 = case when v_has_pdf then coalesce(v_pdf_sha256, last_pdf_sha256) else last_pdf_sha256 end,
      updated_at = now()
  where id = p_quote_id
    and organization_id = p_organization_id;

  if p_delivery_id is not null then
    update public.quote_email_deliveries
    set quote_version_id = v_version.id,
        attachment_file_name = case when v_has_pdf then coalesce(v_pdf_file_name, attachment_file_name) else attachment_file_name end,
        attachment_mime_type = case when v_has_pdf then coalesce(v_pdf_mime_type, attachment_mime_type) else attachment_mime_type end,
        attachment_size_bytes = case when v_has_pdf then coalesce(p_pdf_size_bytes, attachment_size_bytes) else attachment_size_bytes end,
        attachment_sha256 = case when v_has_pdf then coalesce(v_pdf_sha256, attachment_sha256) else attachment_sha256 end,
        updated_at = now()
    where id = p_delivery_id;
  end if;

  perform public.insert_quote_workflow_event(
    p_organization_id,
    p_quote_id,
    'quote_version_created',
    'Offerteversie vastgelegd',
    'Versie ' || v_version.version_number || ' opgeslagen voor ' || p_snapshot_reason || '.',
    jsonb_build_object('versionId', v_version.id, 'versionNumber', v_version.version_number, 'reason', p_snapshot_reason, 'pdfSha256', v_pdf_sha256),
    p_actor_user_id
  );

  if v_has_pdf and v_pdf_sha256 is not null then
    perform public.insert_quote_workflow_event(
      p_organization_id,
      p_quote_id,
      'quote_pdf_attached',
      'PDF-bijlage vastgelegd',
      coalesce(v_pdf_file_name, 'Offerte PDF') || ' is als verzonden PDF-snapshot geregistreerd.',
      jsonb_build_object('versionId', v_version.id, 'fileName', v_pdf_file_name, 'sizeBytes', p_pdf_size_bytes, 'sha256', v_pdf_sha256),
      p_actor_user_id
    );
    perform public.insert_quote_audit_event(
      p_organization_id,
      p_quote_id,
      'quote_pdf_attached',
      v_quote.number,
      jsonb_build_object('versionId', v_version.id, 'fileName', v_pdf_file_name, 'sizeBytes', p_pdf_size_bytes, 'sha256', v_pdf_sha256),
      p_actor_user_id
    );
  end if;

  perform public.insert_quote_audit_event(
    p_organization_id,
    p_quote_id,
    'quote_version_created',
    v_quote.number,
    jsonb_build_object('versionId', v_version.id, 'versionNumber', v_version.version_number, 'reason', p_snapshot_reason),
    p_actor_user_id
  );

  return v_version;
end;
$$;

create or replace function public.approve_quote_internal(p_quote_id uuid, p_organization_id uuid)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if not public.can_admin_org(p_organization_id) then raise exception 'Alleen owners/admins kunnen offertes intern goedkeuren' using errcode = '42501'; end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status <> 'pending_internal_approval' or v_quote.internal_approval_status <> 'pending' then
    raise exception 'Deze offerte kan alleen vanuit de status ter interne goedkeuring worden goedgekeurd' using errcode = '23514';
  end if;
  if jsonb_typeof(coalesce(v_quote.lines, '[]'::jsonb)) <> 'array' then
    raise exception 'Offerte-regels hebben een ongeldig formaat' using errcode = '23514';
  end if;
  if jsonb_array_length(coalesce(v_quote.lines, '[]'::jsonb)) = 0 then
    raise exception 'Een offerte zonder regels kan niet intern worden goedgekeurd' using errcode = '23514';
  end if;
  if v_quote.valid_until is not null and v_quote.valid_until < current_date then
    raise exception 'Deze offerte is verlopen en kan niet intern worden goedgekeurd' using errcode = '23514';
  end if;

  update public.quotes
  set status = 'internally_approved',
      internal_approval_status = 'approved',
      internal_approved_at = now(),
      internal_approved_by = v_user_id,
      internal_rejected_at = null,
      internal_rejected_by = null,
      internal_rejection_note = null,
      updated_at = now()
  where id = p_quote_id
  returning * into v_quote;

  perform public.create_quote_version_snapshot(p_quote_id, p_organization_id, 'internal_approval', v_user_id, null, null, null, null, null, null, jsonb_build_object('source', 'approve_quote_internal'));
  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'internal_approval_granted', 'Intern goedgekeurd', null, '{}'::jsonb, v_user_id);
  perform public.insert_quote_audit_event(p_organization_id, p_quote_id, 'quote_internal_approved', v_quote.number, '{}'::jsonb, v_user_id);

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id;

  return v_quote;
end;
$$;

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
  p_attachment_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_delivery public.quote_email_deliveries;
  v_attachment_file_name text := nullif(trim(coalesce(p_attachment_file_name, '')), '');
  v_attachment_mime_type text := coalesce(nullif(trim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf');
  v_attachment_sha256 text := lower(nullif(trim(coalesce(p_attachment_sha256, '')), ''));
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de server mag een offerte-e-mail voorbereiden' using errcode = '42501';
  end if;

  if lower(trim(coalesce(p_recipient_email, ''))) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Geldig klant-e-mailadres is verplicht' using errcode = '23514';
  end if;

  if v_attachment_file_name is null or p_attachment_size_bytes is null or p_attachment_size_bytes <= 0 or v_attachment_sha256 is null then
    raise exception 'Een offerte-e-mail vereist een servergegenereerde PDF-bijlage met bestandsnaam, grootte en SHA-256 hash' using errcode = '23514';
  end if;

  if v_attachment_mime_type <> 'application/pdf' then
    raise exception 'Alleen application/pdf is toegestaan als offertebijlage' using errcode = '23514';
  end if;

  if v_attachment_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'PDF SHA-256 hash is ongeldig' using errcode = '23514';
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
      last_pdf_file_name = v_attachment_file_name,
      last_pdf_mime_type = v_attachment_mime_type,
      last_pdf_size_bytes = p_attachment_size_bytes,
      last_pdf_sha256 = v_attachment_sha256,
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
    v_attachment_file_name,
    v_attachment_mime_type,
    p_attachment_size_bytes,
    v_attachment_sha256,
    jsonb_build_object(
      'publicUrl', p_public_url,
      'expiresAt', p_token_expires_at,
      'attachment', jsonb_build_object(
        'fileName', v_attachment_file_name,
        'mimeType', v_attachment_mime_type,
        'sizeBytes', p_attachment_size_bytes,
        'sha256', v_attachment_sha256
      )
    )
  ) returning * into v_delivery;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'public_token_created', 'Publieke offertelink aangemaakt', 'Link voorbereid voor verzending via Resend.', jsonb_build_object('expiresAt', p_token_expires_at, 'deliveryId', v_delivery.id), p_actor_user_id);

  return jsonb_build_object('deliveryId', v_delivery.id, 'quoteId', v_quote.id);
end;
$$;

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
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de server mag een offerte-e-mail afronden' using errcode = '42501';
  end if;

  select * into v_delivery
  from public.quote_email_deliveries
  where id = p_delivery_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'E-maildelivery niet gevonden' using errcode = '02000'; end if;

  if v_delivery.attachment_file_name is null or v_delivery.attachment_size_bytes is null or v_delivery.attachment_size_bytes <= 0 or v_delivery.attachment_sha256 is null then
    raise exception 'Delivery mist PDF-bijlagemetadata en kan niet als verzonden offerteversie worden afgerond' using errcode = '23514';
  end if;

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
    jsonb_build_object('provider', 'resend', 'providerEmailId', p_provider_email_id, 'recipientEmail', v_delivery.recipient_email)
  );

  select * into v_delivery
  from public.quote_email_deliveries
  where id = p_delivery_id and organization_id = p_organization_id;

  select * into v_quote
  from public.quotes
  where id = v_delivery.quote_id and organization_id = p_organization_id;

  perform public.insert_quote_workflow_event(p_organization_id, v_quote.id, 'email_sent', 'E-mail geaccepteerd door Resend', null, jsonb_build_object('providerEmailId', p_provider_email_id, 'versionId', v_version.id), p_actor_user_id);
  perform public.insert_quote_workflow_event(p_organization_id, v_quote.id, 'sent_to_client', 'Offerte naar klant verzonden', 'Verstuurd naar ' || v_delivery.recipient_email || '.', jsonb_build_object('recipientEmail', v_delivery.recipient_email, 'providerEmailId', p_provider_email_id, 'versionId', v_version.id), p_actor_user_id);
  perform public.insert_quote_audit_event(p_organization_id, v_quote.id, 'quote_sent_to_client', v_quote.number, jsonb_build_object('recipientEmail', v_delivery.recipient_email, 'providerEmailId', p_provider_email_id, 'versionId', v_version.id), p_actor_user_id);

  return jsonb_build_object('delivery', to_jsonb(v_delivery), 'quote', to_jsonb(v_quote), 'version', to_jsonb(v_version));
end;
$$;

create or replace function public.accept_quote_public(
  p_token_hash text,
  p_name text,
  p_email text,
  p_note text default null
)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
begin
  select * into v_quote
  from public.quotes
  where public_token_hash = p_token_hash
    and public_token_expires_at is not null
    and public_token_expires_at > now()
  for update;

  if not found then raise exception 'Offertelink is ongeldig of verlopen' using errcode = '28000'; end if;
  if v_quote.status <> 'sent' then raise exception 'Deze offerte kan niet meer worden geaccepteerd' using errcode = '23514'; end if;
  if v_quote.valid_until is not null and v_quote.valid_until < current_date then
    raise exception 'Deze offerte is verlopen en kan niet meer worden geaccepteerd' using errcode = '23514';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'Naam is verplicht om de offerte te accepteren' using errcode = '23514';
  end if;
  if nullif(lower(trim(coalesce(p_email, ''))), '') is null or lower(trim(coalesce(p_email, ''))) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Geldig e-mailadres is verplicht om de offerte te accepteren' using errcode = '23514';
  end if;

  update public.quotes
  set status = 'accepted',
      accepted_at = now(),
      client_decision_at = now(),
      client_decision_by_name = nullif(trim(coalesce(p_name, '')), ''),
      client_decision_by_email = nullif(lower(trim(coalesce(p_email, ''))), ''),
      client_decision_note = nullif(trim(coalesce(p_note, '')), ''),
      updated_at = now()
  where id = v_quote.id
  returning * into v_quote;

  perform public.create_quote_version_snapshot(
    v_quote.id,
    v_quote.organization_id,
    'client_accepted',
    null,
    null,
    v_quote.last_pdf_file_name,
    v_quote.last_pdf_mime_type,
    v_quote.last_pdf_size_bytes,
    v_quote.last_pdf_sha256,
    null,
    jsonb_build_object('clientDecisionName', p_name, 'clientDecisionEmail', p_email)
  );

  perform public.insert_quote_workflow_event(v_quote.organization_id, v_quote.id, 'client_accepted', 'Klant heeft de offerte geaccepteerd', nullif(trim(coalesce(p_note, '')), ''), jsonb_build_object('name', p_name, 'email', p_email), null);
  perform public.insert_quote_audit_event(v_quote.organization_id, v_quote.id, 'quote_client_accepted', v_quote.number, jsonb_build_object('name', p_name, 'email', p_email), null);

  select * into v_quote
  from public.quotes
  where id = v_quote.id and organization_id = v_quote.organization_id;

  return v_quote;
end;
$$;

revoke execute on function public.create_quote_version_snapshot(uuid, uuid, text, uuid, uuid, text, text, integer, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.begin_quote_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text) from public, anon, authenticated;
revoke execute on function public.complete_quote_email_send(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.accept_quote_public(text, text, text, text) from public, anon, authenticated;

grant execute on function public.create_quote_version_snapshot(uuid, uuid, text, uuid, uuid, text, text, integer, text, text, jsonb) to service_role;
grant execute on function public.begin_quote_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text, text, text, integer, text) to service_role;
grant execute on function public.complete_quote_email_send(uuid, uuid, uuid, text) to service_role;
grant execute on function public.accept_quote_public(text, text, text, text) to service_role;
grant execute on function public.approve_quote_internal(uuid, uuid) to authenticated;

commit;
