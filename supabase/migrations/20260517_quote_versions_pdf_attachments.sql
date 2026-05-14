-- ============================================================
-- BrandCore / ResoFly — Quote versions + server-side PDF attachments
-- Date: 2026-05-17
-- Scope:
-- - Attach a server-generated quote PDF to Resend quote e-mails
-- - Store quote versions/snapshots at internal approval, send and accept
-- - Link sent PDF metadata/hash to the quote delivery and sent quote version
-- ============================================================

begin;

create table if not exists public.quote_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  quote_id uuid not null references public.quotes(id) on delete cascade,
  delivery_id uuid references public.quote_email_deliveries(id) on delete set null,
  version_number integer not null,
  snapshot_reason text not null check (snapshot_reason in ('internal_approval','sent_to_client','client_accepted','manual')),
  status_at_snapshot text not null,
  internal_approval_status_at_snapshot text,
  quote_number text not null,
  client_id uuid references public.clients(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  quote_date date not null,
  valid_until date,
  notes text,
  subtotal_amount numeric(12,2) not null default 0,
  vat_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  quote_version_pdf_url text,
  pdf_file_name text,
  pdf_mime_type text,
  pdf_size_bytes integer,
  pdf_sha256 text,
  snapshot_data jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, quote_id, version_number)
);

create table if not exists public.quote_version_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  quote_id uuid not null references public.quotes(id) on delete cascade,
  quote_version_id uuid not null references public.quote_versions(id) on delete cascade,
  source_line_id text,
  line_index integer not null,
  description text not null,
  quantity numeric(12,2) not null default 0,
  unit_price numeric(12,2) not null default 0,
  vat_percentage numeric(6,2) not null default 0,
  line_subtotal numeric(12,2) not null default 0,
  line_vat numeric(12,2) not null default 0,
  line_total numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  unique (quote_version_id, line_index)
);

alter table public.quote_email_deliveries
  add column if not exists quote_version_id uuid references public.quote_versions(id) on delete set null,
  add column if not exists attachment_file_name text,
  add column if not exists attachment_mime_type text,
  add column if not exists attachment_size_bytes integer,
  add column if not exists attachment_sha256 text;

alter table public.quotes
  add column if not exists latest_version_id uuid references public.quote_versions(id) on delete set null,
  add column if not exists internal_approved_version_id uuid references public.quote_versions(id) on delete set null,
  add column if not exists sent_version_id uuid references public.quote_versions(id) on delete set null,
  add column if not exists accepted_version_id uuid references public.quote_versions(id) on delete set null,
  add column if not exists last_pdf_file_name text,
  add column if not exists last_pdf_mime_type text,
  add column if not exists last_pdf_size_bytes integer,
  add column if not exists last_pdf_sha256 text;

create index if not exists idx_quote_versions_quote on public.quote_versions(organization_id, quote_id, version_number desc);
create index if not exists idx_quote_versions_reason on public.quote_versions(organization_id, snapshot_reason, created_at desc);
create index if not exists idx_quote_version_items_version on public.quote_version_items(quote_version_id, line_index);
create index if not exists idx_quote_email_deliveries_version on public.quote_email_deliveries(quote_version_id) where quote_version_id is not null;

alter table public.quote_versions enable row level security;
alter table public.quote_version_items enable row level security;

drop policy if exists "quote versions read" on public.quote_versions;
create policy "quote versions read" on public.quote_versions for select using (public.can_read_org(organization_id));

drop policy if exists "quote version items read" on public.quote_version_items;
create policy "quote version items read" on public.quote_version_items for select using (public.can_read_org(organization_id));

-- Keep browser clients read-only for immutable quote snapshots. Creation happens
-- through trusted workflow RPCs/Edge Functions only.
drop policy if exists "quote versions insert" on public.quote_versions;
drop policy if exists "quote versions update" on public.quote_versions;
drop policy if exists "quote versions delete" on public.quote_versions;
drop policy if exists "quote version items insert" on public.quote_version_items;
drop policy if exists "quote version items update" on public.quote_version_items;
drop policy if exists "quote version items delete" on public.quote_version_items;

alter table public.quote_approval_events drop constraint if exists quote_approval_events_event_type_check;
alter table public.quote_approval_events
  add constraint quote_approval_events_event_type_check
  check (event_type in (
    'created',
    'updated',
    'submitted_for_internal_approval',
    'internal_approval_granted',
    'internal_approval_rejected',
    'public_token_created',
    'sent_to_client',
    'email_sent',
    'email_delivered',
    'email_opened',
    'email_clicked',
    'email_bounced',
    'email_failed',
    'email_complained',
    'client_viewed',
    'client_accepted',
    'client_rejected',
    'quote_version_created',
    'quote_pdf_attached',
    'expired',
    'cancelled'
  ));

-- Extend explicit audit event vocabulary.
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
      'quote_email_delivered','quote_email_failed','quote_version_created','quote_pdf_attached'
    ));
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
  v_pdf_mime_type text := coalesce(nullif(trim(coalesce(p_pdf_mime_type, '')), ''), 'application/pdf');
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

  for v_line in select * from jsonb_array_elements(coalesce(v_quote.lines, '[]'::jsonb)) loop
    v_quantity := coalesce(nullif(v_line->>'quantity', '')::numeric, 0);
    v_unit_price := coalesce(nullif(v_line->>'unit_price', '')::numeric, 0);
    v_vat_percentage := coalesce(nullif(v_line->>'vat', '')::numeric, 0);
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
    nullif(trim(coalesce(p_quote_version_pdf_url, '')), ''),
    nullif(trim(coalesce(p_pdf_file_name, '')), ''),
    v_pdf_mime_type,
    p_pdf_size_bytes,
    nullif(trim(coalesce(p_pdf_sha256, '')), ''),
    jsonb_build_object(
      'quote', to_jsonb(v_quote) - 'public_token_hash',
      'totals', jsonb_build_object('subtotal', round(v_subtotal, 2), 'vat', round(v_vat_total, 2), 'total', round(v_total, 2)),
      'reason', p_snapshot_reason,
      'deliveryId', p_delivery_id,
      'pdf', jsonb_build_object(
        'fileName', nullif(trim(coalesce(p_pdf_file_name, '')), ''),
        'mimeType', v_pdf_mime_type,
        'sizeBytes', p_pdf_size_bytes,
        'sha256', nullif(trim(coalesce(p_pdf_sha256, '')), ''),
        'url', nullif(trim(coalesce(p_quote_version_pdf_url, '')), '')
      ),
      'metadata', coalesce(p_metadata, '{}'::jsonb)
    ),
    p_actor_user_id
  ) returning * into v_version;

  v_index := 0;
  for v_line in select * from jsonb_array_elements(coalesce(v_quote.lines, '[]'::jsonb)) loop
    v_quantity := coalesce(nullif(v_line->>'quantity', '')::numeric, 0);
    v_unit_price := coalesce(nullif(v_line->>'unit_price', '')::numeric, 0);
    v_vat_percentage := coalesce(nullif(v_line->>'vat', '')::numeric, 0);
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
      coalesce(nullif(v_line->>'description', ''), '-'),
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
      last_pdf_file_name = coalesce(nullif(trim(coalesce(p_pdf_file_name, '')), ''), last_pdf_file_name),
      last_pdf_mime_type = coalesce(v_pdf_mime_type, last_pdf_mime_type),
      last_pdf_size_bytes = coalesce(p_pdf_size_bytes, last_pdf_size_bytes),
      last_pdf_sha256 = coalesce(nullif(trim(coalesce(p_pdf_sha256, '')), ''), last_pdf_sha256),
      updated_at = now()
  where id = p_quote_id
    and organization_id = p_organization_id;

  if p_delivery_id is not null then
    update public.quote_email_deliveries
    set quote_version_id = v_version.id,
        attachment_file_name = coalesce(nullif(trim(coalesce(p_pdf_file_name, '')), ''), attachment_file_name),
        attachment_mime_type = coalesce(v_pdf_mime_type, attachment_mime_type),
        attachment_size_bytes = coalesce(p_pdf_size_bytes, attachment_size_bytes),
        attachment_sha256 = coalesce(nullif(trim(coalesce(p_pdf_sha256, '')), ''), attachment_sha256),
        updated_at = now()
    where id = p_delivery_id;
  end if;

  perform public.insert_quote_workflow_event(
    p_organization_id,
    p_quote_id,
    'quote_version_created',
    'Offerteversie vastgelegd',
    'Versie ' || v_version.version_number || ' opgeslagen voor ' || p_snapshot_reason || '.',
    jsonb_build_object('versionId', v_version.id, 'versionNumber', v_version.version_number, 'reason', p_snapshot_reason, 'pdfSha256', p_pdf_sha256),
    p_actor_user_id
  );

  if p_pdf_sha256 is not null then
    perform public.insert_quote_workflow_event(
      p_organization_id,
      p_quote_id,
      'quote_pdf_attached',
      'PDF-bijlage vastgelegd',
      coalesce(nullif(trim(coalesce(p_pdf_file_name, '')), ''), 'Offerte PDF') || ' is als verzonden PDF-snapshot geregistreerd.',
      jsonb_build_object('versionId', v_version.id, 'fileName', p_pdf_file_name, 'sizeBytes', p_pdf_size_bytes, 'sha256', p_pdf_sha256),
      p_actor_user_id
    );
    perform public.insert_quote_audit_event(
      p_organization_id,
      p_quote_id,
      'quote_pdf_attached',
      v_quote.number,
      jsonb_build_object('versionId', v_version.id, 'fileName', p_pdf_file_name, 'sizeBytes', p_pdf_size_bytes, 'sha256', p_pdf_sha256),
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

-- Recreate internal approval to snapshot the approved version.
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
    raise exception 'Deze offerte moet eerst ter interne goedkeuring worden ingediend voordat deze kan worden goedgekeurd' using errcode = '23514';
  end if;
  if jsonb_array_length(coalesce(v_quote.lines, '[]'::jsonb)) = 0 then
    raise exception 'Een offerte zonder regels kan niet intern worden goedgekeurd' using errcode = '23514';
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
  return v_quote;
end;
$$;

-- New begin RPC stores attachment metadata with the queued delivery. The PDF bytes
-- themselves are sent to Resend and not written to Postgres.
drop function if exists public.begin_quote_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text);
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
    jsonb_build_object(
      'publicUrl', p_public_url,
      'expiresAt', p_token_expires_at,
      'attachment', jsonb_build_object(
        'fileName', nullif(trim(coalesce(p_attachment_file_name, '')), ''),
        'mimeType', coalesce(nullif(trim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf'),
        'sizeBytes', p_attachment_size_bytes,
        'sha256', nullif(trim(coalesce(p_attachment_sha256, '')), '')
      )
    )
  ) returning * into v_delivery;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'public_token_created', 'Publieke offertelink aangemaakt', 'Link voorbereid voor verzending via Resend.', jsonb_build_object('expiresAt', p_token_expires_at), p_actor_user_id);

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
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de publieke offerte-service mag klantbeslissingen verwerken' using errcode = '42501';
  end if;

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
  return v_quote;
end;
$$;

create or replace function public.enforce_quote_workflow_fields_server_only()
returns trigger
language plpgsql
as $$
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    return new;
  end if;

  if TG_OP = 'INSERT' then
    if coalesce(new.status, 'draft') <> 'draft'
      or coalesce(new.internal_approval_status, 'draft') <> 'draft'
      or new.internal_approval_requested_at is not null
      or new.internal_approval_requested_by is not null
      or new.internal_approved_at is not null
      or new.internal_approved_by is not null
      or new.internal_rejected_at is not null
      or new.internal_rejected_by is not null
      or new.internal_rejection_note is not null
      or new.client_decision_at is not null
      or new.client_decision_by_name is not null
      or new.client_decision_by_email is not null
      or new.client_decision_note is not null
      or new.public_token_hash is not null
      or new.public_token_created_at is not null
      or new.public_token_expires_at is not null
      or new.resend_last_email_id is not null
      or new.last_email_delivery_status is not null
      or new.last_email_delivery_at is not null
      or new.last_email_opened_at is not null
      or new.last_email_clicked_at is not null
      or new.last_email_failed_at is not null
      or new.sent_at is not null
      or new.accepted_at is not null
      or new.latest_version_id is not null
      or new.internal_approved_version_id is not null
      or new.sent_version_id is not null
      or new.accepted_version_id is not null
      or new.last_pdf_file_name is not null
      or new.last_pdf_mime_type is not null
      or new.last_pdf_size_bytes is not null
      or new.last_pdf_sha256 is not null then
      raise exception 'Offerte-workflowvelden mogen niet rechtstreeks vanuit de browser worden gezet. Gebruik de offerte-workflow acties.' using errcode = '42501';
    end if;
    return new;
  end if;

  if TG_OP = 'UPDATE' then
    if old.status is distinct from new.status
      or old.internal_approval_status is distinct from new.internal_approval_status
      or old.internal_approval_requested_at is distinct from new.internal_approval_requested_at
      or old.internal_approval_requested_by is distinct from new.internal_approval_requested_by
      or old.internal_approved_at is distinct from new.internal_approved_at
      or old.internal_approved_by is distinct from new.internal_approved_by
      or old.internal_rejected_at is distinct from new.internal_rejected_at
      or old.internal_rejected_by is distinct from new.internal_rejected_by
      or old.internal_rejection_note is distinct from new.internal_rejection_note
      or old.client_decision_at is distinct from new.client_decision_at
      or old.client_decision_by_name is distinct from new.client_decision_by_name
      or old.client_decision_by_email is distinct from new.client_decision_by_email
      or old.client_decision_note is distinct from new.client_decision_note
      or old.public_token_hash is distinct from new.public_token_hash
      or old.public_token_created_at is distinct from new.public_token_created_at
      or old.public_token_expires_at is distinct from new.public_token_expires_at
      or old.resend_last_email_id is distinct from new.resend_last_email_id
      or old.last_email_delivery_status is distinct from new.last_email_delivery_status
      or old.last_email_delivery_at is distinct from new.last_email_delivery_at
      or old.last_email_opened_at is distinct from new.last_email_opened_at
      or old.last_email_clicked_at is distinct from new.last_email_clicked_at
      or old.last_email_failed_at is distinct from new.last_email_failed_at
      or old.sent_at is distinct from new.sent_at
      or old.accepted_at is distinct from new.accepted_at
      or old.latest_version_id is distinct from new.latest_version_id
      or old.internal_approved_version_id is distinct from new.internal_approved_version_id
      or old.sent_version_id is distinct from new.sent_version_id
      or old.accepted_version_id is distinct from new.accepted_version_id
      or old.last_pdf_file_name is distinct from new.last_pdf_file_name
      or old.last_pdf_mime_type is distinct from new.last_pdf_mime_type
      or old.last_pdf_size_bytes is distinct from new.last_pdf_size_bytes
      or old.last_pdf_sha256 is distinct from new.last_pdf_sha256 then
      raise exception 'Offerte-workflowvelden mogen niet rechtstreeks vanuit de browser worden gewijzigd. Gebruik de offerte-workflow acties.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists quotes_workflow_fields_server_only_guard on public.quotes;
create trigger quotes_workflow_fields_server_only_guard
  before insert or update of
    status,
    internal_approval_status,
    internal_approval_requested_at,
    internal_approval_requested_by,
    internal_approved_at,
    internal_approved_by,
    internal_rejected_at,
    internal_rejected_by,
    internal_rejection_note,
    client_decision_at,
    client_decision_by_name,
    client_decision_by_email,
    client_decision_note,
    public_token_hash,
    public_token_created_at,
    public_token_expires_at,
    resend_last_email_id,
    last_email_delivery_status,
    last_email_delivery_at,
    last_email_opened_at,
    last_email_clicked_at,
    last_email_failed_at,
    sent_at,
    accepted_at,
    latest_version_id,
    internal_approved_version_id,
    sent_version_id,
    accepted_version_id,
    last_pdf_file_name,
    last_pdf_mime_type,
    last_pdf_size_bytes,
    last_pdf_sha256
  on public.quotes
  for each row execute function public.enforce_quote_workflow_fields_server_only();

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
