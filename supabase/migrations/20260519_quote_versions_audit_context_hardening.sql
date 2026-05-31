-- ============================================================
-- BrandCore / ResoFly — Quote version audit context hardening
-- Date: 2026-05-19
-- Scope:
-- - Enrich quote version snapshots with client/project/company context
-- - Explicitly link client acceptance snapshots to the sent quote version
-- - Require a real Resend provider e-mail id before marking delivery sent
-- - Add production flow verification documentation in the codebase
-- Note: physical PDF storage is intentionally out of scope for this migration.
-- ============================================================

begin;

alter table public.quote_versions
  add column if not exists accepted_sent_version_id uuid references public.quote_versions(id) on delete set null;

alter table public.quotes
  add column if not exists accepted_sent_version_id uuid references public.quote_versions(id) on delete set null;

create index if not exists idx_quote_versions_accepted_sent_version
  on public.quote_versions(accepted_sent_version_id)
  where accepted_sent_version_id is not null;

create index if not exists idx_quotes_accepted_sent_version
  on public.quotes(accepted_sent_version_id)
  where accepted_sent_version_id is not null;

-- New sent deliveries must always have a provider id. NOT VALID prevents
-- old production data from blocking deployment, while still enforcing future writes.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quote_email_deliveries'::regclass
      and conname = 'quote_email_deliveries_sent_provider_id_check'
  ) then
    alter table public.quote_email_deliveries
      add constraint quote_email_deliveries_sent_provider_id_check
      check (status <> 'sent' or nullif(trim(coalesce(provider_email_id, '')), '') is not null)
      not valid;
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
  v_sent_version public.quote_versions;
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
  v_client_snapshot jsonb := 'null'::jsonb;
  v_project_snapshot jsonb := 'null'::jsonb;
  v_company_snapshot jsonb := 'null'::jsonb;
  v_delivery_snapshot jsonb := 'null'::jsonb;
  v_sent_version_snapshot jsonb := 'null'::jsonb;
  v_accepted_sent_version_id uuid := null;
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
    v_delivery_snapshot := to_jsonb(v_delivery);
  end if;

  if v_quote.client_id is not null then
    select to_jsonb(c) into v_client_snapshot
    from public.clients c
    where c.id = v_quote.client_id
      and c.organization_id = p_organization_id;
    v_client_snapshot := coalesce(v_client_snapshot, 'null'::jsonb);
  end if;

  if v_quote.project_id is not null then
    select to_jsonb(p) into v_project_snapshot
    from public.projects p
    where p.id = v_quote.project_id
      and p.organization_id = p_organization_id;
    v_project_snapshot := coalesce(v_project_snapshot, 'null'::jsonb);
  end if;

  select to_jsonb(cs) into v_company_snapshot
  from public.company_settings cs
  where cs.organization_id = p_organization_id;
  v_company_snapshot := coalesce(v_company_snapshot, 'null'::jsonb);

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

  if p_snapshot_reason = 'client_accepted' then
    v_accepted_sent_version_id := v_quote.sent_version_id;

    if v_accepted_sent_version_id is null then
      raise exception 'Acceptatie kan niet worden vastgelegd zonder gekoppelde verzonden offerteversie' using errcode = '23514';
    end if;

    select * into v_sent_version
    from public.quote_versions
    where id = v_accepted_sent_version_id
      and organization_id = p_organization_id
      and quote_id = p_quote_id
      and snapshot_reason = 'sent_to_client';

    if not found then
      raise exception 'Gekoppelde verzonden offerteversie is niet gevonden' using errcode = '23514';
    end if;

    if v_quote.last_pdf_sha256 is not null and v_sent_version.pdf_sha256 is not null and v_quote.last_pdf_sha256 <> v_sent_version.pdf_sha256 then
      raise exception 'Acceptatie-PDF hash komt niet overeen met de verzonden offerteversie' using errcode = '23514';
    end if;

    v_sent_version_snapshot := jsonb_build_object(
      'id', v_sent_version.id,
      'versionNumber', v_sent_version.version_number,
      'snapshotReason', v_sent_version.snapshot_reason,
      'pdfSha256', v_sent_version.pdf_sha256,
      'pdfFileName', v_sent_version.pdf_file_name,
      'pdfSizeBytes', v_sent_version.pdf_size_bytes,
      'createdAt', v_sent_version.created_at
    );
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
    accepted_sent_version_id,
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
    v_accepted_sent_version_id,
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
      'quoteLines', v_lines,
      'clientSnapshot', v_client_snapshot,
      'projectSnapshot', v_project_snapshot,
      'companySnapshot', v_company_snapshot,
      'deliverySnapshot', v_delivery_snapshot,
      'sentVersionSnapshot', v_sent_version_snapshot,
      'acceptedSentVersionId', v_accepted_sent_version_id,
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
      accepted_sent_version_id = case when p_snapshot_reason = 'client_accepted' then v_accepted_sent_version_id else accepted_sent_version_id end,
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
    jsonb_build_object('versionId', v_version.id, 'versionNumber', v_version.version_number, 'reason', p_snapshot_reason, 'pdfSha256', v_pdf_sha256, 'acceptedSentVersionId', v_accepted_sent_version_id),
    p_actor_user_id
  );

  if v_has_pdf and v_pdf_sha256 is not null then
    perform public.insert_quote_workflow_event(
      p_organization_id,
      p_quote_id,
      'quote_pdf_attached',
      'PDF-bijlage vastgelegd',
      coalesce(v_pdf_file_name, 'Offerte PDF') || ' is als verzonden PDF-snapshot geregistreerd.',
      jsonb_build_object('versionId', v_version.id, 'fileName', v_pdf_file_name, 'sizeBytes', p_pdf_size_bytes, 'sha256', v_pdf_sha256, 'acceptedSentVersionId', v_accepted_sent_version_id),
      p_actor_user_id
    );
    perform public.insert_quote_audit_event(
      p_organization_id,
      p_quote_id,
      'quote_pdf_attached',
      v_quote.number,
      jsonb_build_object('versionId', v_version.id, 'fileName', v_pdf_file_name, 'sizeBytes', p_pdf_size_bytes, 'sha256', v_pdf_sha256, 'acceptedSentVersionId', v_accepted_sent_version_id),
      p_actor_user_id
    );
  end if;

  perform public.insert_quote_audit_event(
    p_organization_id,
    p_quote_id,
    'quote_version_created',
    v_quote.number,
    jsonb_build_object('versionId', v_version.id, 'versionNumber', v_version.version_number, 'reason', p_snapshot_reason, 'acceptedSentVersionId', v_accepted_sent_version_id),
    p_actor_user_id
  );

  return v_version;
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
  v_provider_email_id text := nullif(trim(coalesce(p_provider_email_id, '')), '');
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de server mag een offerte-e-mail afronden' using errcode = '42501';
  end if;

  if v_provider_email_id is null then
    raise exception 'Resend provider e-mail-ID is verplicht om een offerte als verzonden te markeren' using errcode = '23514';
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
  set provider_email_id = v_provider_email_id,
      status = 'sent',
      sent_at = v_now,
      last_event_at = v_now,
      updated_at = v_now
  where id = v_delivery.id
  returning * into v_delivery;

  update public.quotes
  set status = 'sent',
      sent_at = v_now,
      resend_last_email_id = v_provider_email_id,
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
    jsonb_build_object('provider', 'resend', 'providerEmailId', v_provider_email_id, 'recipientEmail', v_delivery.recipient_email)
  );

  select * into v_delivery
  from public.quote_email_deliveries
  where id = p_delivery_id and organization_id = p_organization_id;

  select * into v_quote
  from public.quotes
  where id = v_delivery.quote_id and organization_id = p_organization_id;

  perform public.insert_quote_workflow_event(p_organization_id, v_quote.id, 'email_sent', 'E-mail geaccepteerd door Resend', null, jsonb_build_object('providerEmailId', v_provider_email_id, 'versionId', v_version.id), p_actor_user_id);
  perform public.insert_quote_workflow_event(p_organization_id, v_quote.id, 'sent_to_client', 'Offerte naar klant verzonden', 'Verstuurd naar ' || v_delivery.recipient_email || '.', jsonb_build_object('recipientEmail', v_delivery.recipient_email, 'providerEmailId', v_provider_email_id, 'versionId', v_version.id), p_actor_user_id);
  perform public.insert_quote_audit_event(p_organization_id, v_quote.id, 'quote_sent_to_client', v_quote.number, jsonb_build_object('recipientEmail', v_delivery.recipient_email, 'providerEmailId', v_provider_email_id, 'versionId', v_version.id), p_actor_user_id);

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
  v_version public.quote_versions;
  v_sent_version_id uuid;
begin
  select * into v_quote
  from public.quotes
  where public_token_hash = p_token_hash
    and public_token_expires_at is not null
    and public_token_expires_at > now()
  for update;

  if not found then raise exception 'Offertelink is ongeldig of verlopen' using errcode = '28000'; end if;
  if v_quote.status <> 'sent' then raise exception 'Deze offerte kan niet meer worden geaccepteerd' using errcode = '23514'; end if;
  if v_quote.sent_version_id is null then raise exception 'Deze offerte mist een verzonden versie en kan niet worden geaccepteerd' using errcode = '23514'; end if;
  if v_quote.valid_until is not null and v_quote.valid_until < current_date then
    raise exception 'Deze offerte is verlopen en kan niet meer worden geaccepteerd' using errcode = '23514';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'Naam is verplicht om de offerte te accepteren' using errcode = '23514';
  end if;
  if nullif(lower(trim(coalesce(p_email, ''))), '') is null or lower(trim(coalesce(p_email, ''))) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Geldig e-mailadres is verplicht om de offerte te accepteren' using errcode = '23514';
  end if;

  v_sent_version_id := v_quote.sent_version_id;

  update public.quotes
  set status = 'accepted',
      accepted_at = now(),
      client_decision_at = now(),
      client_decision_by_name = nullif(trim(coalesce(p_name, '')), ''),
      client_decision_by_email = nullif(lower(trim(coalesce(p_email, ''))), ''),
      client_decision_note = nullif(trim(coalesce(p_note, '')), ''),
      accepted_sent_version_id = v_sent_version_id,
      updated_at = now()
  where id = v_quote.id
  returning * into v_quote;

  v_version := public.create_quote_version_snapshot(
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
    jsonb_build_object('clientDecisionName', p_name, 'clientDecisionEmail', p_email, 'acceptedSentVersionId', v_sent_version_id)
  );

  perform public.insert_quote_workflow_event(v_quote.organization_id, v_quote.id, 'client_accepted', 'Klant heeft de offerte geaccepteerd', nullif(trim(coalesce(p_note, '')), ''), jsonb_build_object('name', p_name, 'email', p_email, 'acceptedVersionId', v_version.id, 'acceptedSentVersionId', v_sent_version_id), null);
  perform public.insert_quote_audit_event(v_quote.organization_id, v_quote.id, 'quote_client_accepted', v_quote.number, jsonb_build_object('name', p_name, 'email', p_email, 'acceptedVersionId', v_version.id, 'acceptedSentVersionId', v_sent_version_id), null);

  select * into v_quote
  from public.quotes
  where id = v_quote.id and organization_id = v_quote.organization_id;

  return v_quote;
end;
$$;

revoke execute on function public.create_quote_version_snapshot(uuid, uuid, text, uuid, uuid, text, text, integer, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.complete_quote_email_send(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.accept_quote_public(text, text, text, text) from public, anon, authenticated;

grant execute on function public.create_quote_version_snapshot(uuid, uuid, text, uuid, uuid, text, text, integer, text, text, jsonb) to service_role;
grant execute on function public.complete_quote_email_send(uuid, uuid, uuid, text) to service_role;
grant execute on function public.accept_quote_public(text, text, text, text) to service_role;

commit;
