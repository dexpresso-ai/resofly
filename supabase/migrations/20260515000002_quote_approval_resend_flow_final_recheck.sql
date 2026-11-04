-- ============================================================
-- BrandCore / ResoFly — Quote approval + Resend final recheck hardening
-- Date: 2026-05-15
-- Scope:
-- - Prevent browser clients from directly mutating quote workflow fields
-- - Prevent direct helper-RPC event/audit forgery
-- - Require proper pending state before internal approval
-- - Enforce quote validity date during public acceptance
-- ============================================================

begin;

-- Direct table updates from browser clients may edit draft business fields,
-- but workflow/status/delivery fields must only change through trusted RPCs
-- and service-role Edge Functions. SECURITY DEFINER RPCs run as the function
-- owner and are therefore not blocked by this guard.
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
      or new.accepted_at is not null then
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
      or old.accepted_at is distinct from new.accepted_at then
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
    accepted_at
  on public.quotes
  for each row execute function public.enforce_quote_workflow_fields_server_only();

-- Prevent direct browser RPC calls that could forge timeline/audit records.
-- Workflow RPCs and Edge Functions can still call these helpers from trusted
-- SECURITY DEFINER/server-role contexts.
revoke execute on function public.insert_quote_workflow_event(uuid, uuid, text, text, text, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.insert_quote_audit_event(uuid, uuid, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.insert_quote_workflow_event(uuid, uuid, text, text, text, jsonb, uuid) to service_role;
grant execute on function public.insert_quote_audit_event(uuid, uuid, text, text, jsonb, uuid) to service_role;

revoke execute on function public.accept_quote_public(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.reject_quote_public(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.begin_quote_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.complete_quote_email_send(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.fail_quote_email_send(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.accept_quote_public(text, text, text, text) to service_role;
grant execute on function public.reject_quote_public(text, text, text, text) to service_role;
grant execute on function public.begin_quote_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text) to service_role;
grant execute on function public.complete_quote_email_send(uuid, uuid, uuid, text) to service_role;
grant execute on function public.fail_quote_email_send(uuid, uuid, uuid, text) to service_role;

create or replace function public.submit_quote_for_internal_approval(p_quote_id uuid, p_organization_id uuid)
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
  if not public.can_write_org(p_organization_id) then raise exception 'Geen schrijfrechten voor deze organisatie' using errcode = '42501'; end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status <> 'draft' then
    raise exception 'Deze offerte kan niet ter goedkeuring worden ingediend vanuit status %', v_quote.status using errcode = '23514';
  end if;
  if jsonb_array_length(coalesce(v_quote.lines, '[]'::jsonb)) = 0 then
    raise exception 'Een offerte zonder regels kan niet ter goedkeuring worden ingediend' using errcode = '23514';
  end if;

  update public.quotes
  set status = 'pending_internal_approval',
      internal_approval_status = 'pending',
      internal_approval_requested_at = now(),
      internal_approval_requested_by = v_user_id,
      internal_approved_at = null,
      internal_approved_by = null,
      internal_rejected_at = null,
      internal_rejected_by = null,
      internal_rejection_note = null,
      updated_at = now()
  where id = p_quote_id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'submitted_for_internal_approval', 'Ter interne goedkeuring ingediend', null, '{}'::jsonb, v_user_id);
  perform public.insert_quote_audit_event(p_organization_id, p_quote_id, 'quote_submitted_for_approval', v_quote.number, '{}'::jsonb, v_user_id);
  return v_quote;
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

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'internal_approval_granted', 'Intern goedgekeurd', null, '{}'::jsonb, v_user_id);
  perform public.insert_quote_audit_event(p_organization_id, p_quote_id, 'quote_internal_approved', v_quote.number, '{}'::jsonb, v_user_id);
  return v_quote;
end;
$$;

create or replace function public.reject_quote_internal(p_quote_id uuid, p_organization_id uuid, p_note text default null)
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
  if not public.can_admin_org(p_organization_id) then raise exception 'Alleen owners/admins kunnen offertes intern afwijzen' using errcode = '42501'; end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status not in ('pending_internal_approval','internally_approved') then
    raise exception 'Deze offerte kan niet intern worden afgewezen vanuit status %', v_quote.status using errcode = '23514';
  end if;

  update public.quotes
  set status = 'draft',
      internal_approval_status = 'rejected',
      internal_rejected_at = now(),
      internal_rejected_by = v_user_id,
      internal_rejection_note = nullif(trim(coalesce(p_note, '')), ''),
      internal_approved_at = null,
      internal_approved_by = null,
      updated_at = now()
  where id = p_quote_id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'internal_approval_rejected', 'Intern afgewezen', nullif(trim(coalesce(p_note, '')), ''), '{}'::jsonb, v_user_id);
  perform public.insert_quote_audit_event(p_organization_id, p_quote_id, 'quote_internal_rejected', v_quote.number, jsonb_build_object('note', nullif(trim(coalesce(p_note, '')), '')), v_user_id);
  return v_quote;
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

  perform public.insert_quote_workflow_event(v_quote.organization_id, v_quote.id, 'client_accepted', 'Klant heeft de offerte geaccepteerd', nullif(trim(coalesce(p_note, '')), ''), jsonb_build_object('name', p_name, 'email', p_email), null);
  perform public.insert_quote_audit_event(v_quote.organization_id, v_quote.id, 'quote_client_accepted', v_quote.number, jsonb_build_object('name', p_name, 'email', p_email), null);
  return v_quote;
end;
$$;

create or replace function public.reject_quote_public(
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
  if v_quote.status <> 'sent' then raise exception 'Deze offerte kan niet meer worden geweigerd' using errcode = '23514'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'Naam is verplicht om de offerte te weigeren' using errcode = '23514';
  end if;
  if nullif(lower(trim(coalesce(p_email, ''))), '') is null or lower(trim(coalesce(p_email, ''))) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Geldig e-mailadres is verplicht om de offerte te weigeren' using errcode = '23514';
  end if;

  update public.quotes
  set status = 'rejected',
      client_decision_at = now(),
      client_decision_by_name = nullif(trim(coalesce(p_name, '')), ''),
      client_decision_by_email = nullif(lower(trim(coalesce(p_email, ''))), ''),
      client_decision_note = nullif(trim(coalesce(p_note, '')), ''),
      updated_at = now()
  where id = v_quote.id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(v_quote.organization_id, v_quote.id, 'client_rejected', 'Klant heeft de offerte geweigerd', nullif(trim(coalesce(p_note, '')), ''), jsonb_build_object('name', p_name, 'email', p_email), null);
  perform public.insert_quote_audit_event(v_quote.organization_id, v_quote.id, 'quote_client_rejected', v_quote.number, jsonb_build_object('name', p_name, 'email', p_email), null);
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
  p_public_url text
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
    jsonb_build_object('publicUrl', p_public_url, 'expiresAt', p_token_expires_at)
  ) returning * into v_delivery;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'public_token_created', 'Publieke offertelink aangemaakt', 'Link voorbereid voor verzending via Resend.', jsonb_build_object('expiresAt', p_token_expires_at), p_actor_user_id);

  return jsonb_build_object('deliveryId', v_delivery.id, 'quoteId', v_quote.id);
end;
$$;


grant execute on function public.submit_quote_for_internal_approval(uuid, uuid) to authenticated;
grant execute on function public.approve_quote_internal(uuid, uuid) to authenticated;
grant execute on function public.reject_quote_internal(uuid, uuid, text) to authenticated;
grant execute on function public.accept_quote_public(text, text, text, text) to service_role;
grant execute on function public.reject_quote_public(text, text, text, text) to service_role;

commit;
