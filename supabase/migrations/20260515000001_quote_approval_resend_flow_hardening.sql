-- ============================================================
-- BrandCore / ResoFly — Quote approval + Resend hardening
-- Scope:
-- - Lock quote business fields after submission
-- - Keep timeline/email tables read-only from browser clients
-- - Add transactional send lifecycle RPCs for Resend
-- - Harden helper RPC permissions
-- ============================================================

begin;

-- Browser clients may read timeline/e-mail status, but inserts/updates must flow
-- through RPCs or service-role Edge Functions to prevent forged events/statuses.
drop policy if exists "quote approval events insert" on public.quote_approval_events;
drop policy if exists "quote email deliveries insert" on public.quote_email_deliveries;
drop policy if exists "quote email deliveries update" on public.quote_email_deliveries;

create or replace function public.insert_quote_workflow_event(
  p_organization_id uuid,
  p_quote_id uuid,
  p_event_type text,
  p_title text,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_user_id uuid default auth.uid()
)
returns public.quote_approval_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.quote_approval_events;
begin
  if auth.role() = 'authenticated' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.quotes q
    where q.id = p_quote_id and q.organization_id = p_organization_id
  ) then
    raise exception 'Offerte niet gevonden voor deze organisatie' using errcode = '02000';
  end if;

  insert into public.quote_approval_events(
    organization_id,
    quote_id,
    actor_user_id,
    event_type,
    title,
    description,
    metadata
  ) values (
    p_organization_id,
    p_quote_id,
    p_actor_user_id,
    p_event_type,
    coalesce(nullif(trim(p_title), ''), p_event_type),
    nullif(trim(coalesce(p_description, '')), ''),
    coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_event;

  return v_event;
end;
$$;

create or replace function public.insert_quote_audit_event(
  p_organization_id uuid,
  p_quote_id uuid,
  p_action text,
  p_entity_label text,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_user_id uuid default auth.uid()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'authenticated' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.quotes q
    where q.id = p_quote_id and q.organization_id = p_organization_id
  ) then
    raise exception 'Offerte niet gevonden voor deze organisatie' using errcode = '02000';
  end if;

  begin
    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (p_organization_id, p_actor_user_id, p_action, 'quote', p_quote_id, p_entity_label, coalesce(p_metadata, '{}'::jsonb));
  exception when others then
    raise warning 'quote audit event failed for quote % action %: %', p_quote_id, p_action, SQLERRM;
  end;
end;
$$;

create or replace function public.enforce_quote_immutable_after_submission()
returns trigger
language plpgsql
as $$
begin
  if TG_OP <> 'UPDATE' then return new; end if;

  if old.status = 'draft' then
    return new;
  end if;

  if old.number is distinct from new.number
    or old.date is distinct from new.date
    or old.valid_until is distinct from new.valid_until
    or old.client_id is distinct from new.client_id
    or old.project_id is distinct from new.project_id
    or old.lines is distinct from new.lines
    or old.notes is distinct from new.notes then
    raise exception 'Deze offerte is al onderdeel van de goedkeuringsflow. Maak een nieuwe offerte of reset de workflow voordat je inhoudelijke velden wijzigt.' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists quotes_immutable_after_submission_guard on public.quotes;
create trigger quotes_immutable_after_submission_guard
  before update of number, date, valid_until, client_id, project_id, lines, notes on public.quotes
  for each row execute function public.enforce_quote_immutable_after_submission();

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

  perform public.insert_quote_workflow_event(p_organization_id, v_quote.id, 'email_sent', 'E-mail geaccepteerd door Resend', null, jsonb_build_object('providerEmailId', p_provider_email_id), p_actor_user_id);
  perform public.insert_quote_workflow_event(p_organization_id, v_quote.id, 'sent_to_client', 'Offerte naar klant verzonden', 'Verstuurd naar ' || v_delivery.recipient_email || '.', jsonb_build_object('recipientEmail', v_delivery.recipient_email, 'providerEmailId', p_provider_email_id), p_actor_user_id);
  perform public.insert_quote_audit_event(p_organization_id, v_quote.id, 'quote_sent_to_client', v_quote.number, jsonb_build_object('recipientEmail', v_delivery.recipient_email, 'providerEmailId', p_provider_email_id), p_actor_user_id);

  return jsonb_build_object('delivery', to_jsonb(v_delivery), 'quote', to_jsonb(v_quote));
end;
$$;

create or replace function public.fail_quote_email_send(
  p_delivery_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery public.quote_email_deliveries;
  v_quote public.quotes;
  v_now timestamptz := now();
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de server mag een offerte-e-mail markeren als mislukt' using errcode = '42501';
  end if;

  select * into v_delivery
  from public.quote_email_deliveries
  where id = p_delivery_id and organization_id = p_organization_id
  for update;

  if not found then return; end if;

  update public.quote_email_deliveries
  set status = 'failed',
      failed_at = v_now,
      last_event_at = v_now,
      error_message = nullif(trim(coalesce(p_error_message, '')), ''),
      updated_at = v_now
  where id = v_delivery.id
  returning * into v_delivery;

  select * into v_quote
  from public.quotes
  where id = v_delivery.quote_id and organization_id = p_organization_id
  for update;

  if found and v_quote.status = 'internally_approved' then
    update public.quotes
    set last_email_delivery_status = 'failed',
        last_email_failed_at = v_now,
        updated_at = v_now
    where id = v_quote.id;

    perform public.insert_quote_workflow_event(p_organization_id, v_quote.id, 'email_failed', 'E-mail verzenden via Resend mislukt', nullif(trim(coalesce(p_error_message, '')), ''), '{}'::jsonb, p_actor_user_id);
    perform public.insert_quote_audit_event(p_organization_id, v_quote.id, 'quote_email_failed', v_quote.number, jsonb_build_object('error', p_error_message), p_actor_user_id);
  end if;
end;
$$;

grant execute on function public.begin_quote_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text) to service_role;
grant execute on function public.complete_quote_email_send(uuid, uuid, uuid, text) to service_role;
grant execute on function public.fail_quote_email_send(uuid, uuid, uuid, text) to service_role;

commit;
