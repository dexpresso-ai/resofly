-- ============================================================
-- BrandCore — Sprint 2 production hardening: org-owned Mollie Connect
-- Date: 2026-04-30
--
-- Purpose:
-- - Store Mollie OAuth access/refresh tokens encrypted in a dedicated table.
-- - Support refresh-token rotation from the Edge Function.
-- - Make Mollie payment/webhook handling tenant-specific per organization.
-- - Make checkout and webhook processing idempotent for retries/duplicates.
-- - Prevent direct/free paid plan upgrades through the legacy RPC path.
-- ============================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

create table if not exists public.organization_mollie_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  billing_profile_id uuid references public.organization_billing_profiles(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','connected','mock_connected','error','revoked')),
  mollie_organization_id text,
  token_type text not null default 'Bearer',
  access_token_encrypted text,
  refresh_token_encrypted text,
  scopes text[] not null default '{}'::text[],
  expires_at timestamptz,
  last_refreshed_at timestamptz,
  last_error text,
  refresh_token_version integer not null default 0 check (refresh_token_version >= 0),
  connected_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_org_mollie_connections_status on public.organization_mollie_connections(organization_id, status);

alter table public.organization_billing_events
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists receive_count integer not null default 1 check (receive_count >= 1);

alter table public.organization_mollie_connections enable row level security;

-- Token rows are intentionally not exposed to anon/authenticated users. The billing Edge Function uses the service role.
revoke all on public.organization_mollie_connections from anon, authenticated;
grant select, insert, update, delete on public.organization_mollie_connections to service_role;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'organization_mollie_connections_updated_at') then
    create trigger organization_mollie_connections_updated_at before update on public.organization_mollie_connections for each row execute function public.set_updated_at();
  end if;
end $$;

create or replace function public.request_organization_plan_change(p_organization_id uuid, p_plan_key text)
returns public.organization_billing_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.organization_billing_profiles;
begin
  if not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen owners/admins mogen het plan wijzigen.' using errcode = '42501';
  end if;

  v_profile := public.ensure_organization_billing_profile(p_organization_id);

  raise exception 'Automatische planwijzigingen lopen via de billing Edge Function met Mollie-checkout. Gebruik createPlanChangeCheckout zodat betaalde upgrades niet gratis toegepast kunnen worden.' using errcode = '23514';

  return v_profile;
end;
$$;

create or replace function public.apply_paid_organization_payment(
  p_provider_payment_id text,
  p_payment_status text,
  p_payload jsonb default '{}'::jsonb
)
returns public.organization_payment_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.organization_payment_records;
  v_profile public.organization_billing_profiles;
  v_plan public.billing_plans;
  v_old_seats integer;
  v_new_seats integer;
  v_event public.organization_billing_events;
  v_event_key text := 'mollie:payment:' || coalesce(p_provider_payment_id, 'unknown') || ':' || coalesce(p_payment_status, 'unknown');
  v_action text;
  v_old_plan_key text;
begin
  if nullif(trim(coalesce(p_provider_payment_id, '')), '') is null then
    raise exception 'provider payment id ontbreekt.' using errcode = '23514';
  end if;

  select * into v_payment
  from public.organization_payment_records
  where provider = 'mollie' and provider_payment_id = p_provider_payment_id
  for update;

  if not found then
    raise exception 'Payment record niet gevonden voor Mollie payment id %.', p_provider_payment_id using errcode = 'P0002';
  end if;

  insert into public.organization_billing_events(
    organization_id, event_key, event_type, event_source, provider, provider_resource_id,
    status, payment_record_id, payload, last_seen_at, receive_count
  ) values (
    v_payment.organization_id, v_event_key, 'payment.' || p_payment_status, 'mollie_webhook', 'mollie',
    p_provider_payment_id, 'received', v_payment.id, coalesce(p_payload, '{}'::jsonb), now(), 1
  )
  on conflict (event_key) do update set
    last_seen_at = now(),
    receive_count = public.organization_billing_events.receive_count + 1,
    payload = case
      when public.organization_billing_events.status = 'received' then excluded.payload
      else public.organization_billing_events.payload
    end
  returning * into v_event;

  -- Strict idempotency: once this exact provider/status event is handled, never write audit/seat changes again.
  if v_event.status in ('processed','ignored') then
    return v_payment;
  end if;

  -- Never regress a successfully processed paid payment to a later non-paid status.
  if v_payment.status = 'paid' and v_payment.processed_at is not null and p_payment_status <> 'paid' then
    update public.organization_billing_events
    set status = 'ignored', processed_at = now(), error_message = 'Payment was already processed as paid; later non-paid event ignored.'
    where id = v_event.id;
    return v_payment;
  end if;

  -- Duplicate paid webhook for the same payment remains processed and does not mutate seats or audit again.
  if p_payment_status = 'paid' and v_payment.processed_at is not null then
    update public.organization_billing_events
    set status = 'processed', processed_at = coalesce(processed_at, now())
    where id = v_event.id;
    return v_payment;
  end if;

  update public.organization_payment_records
  set status = p_payment_status,
      raw_payload = coalesce(p_payload, '{}'::jsonb),
      paid_at = case when p_payment_status = 'paid' then coalesce(paid_at, now()) else paid_at end,
      failed_at = case when p_payment_status = 'failed' then coalesce(failed_at, now()) else failed_at end,
      canceled_at = case when p_payment_status = 'canceled' then coalesce(canceled_at, now()) else canceled_at end,
      expired_at = case when p_payment_status = 'expired' then coalesce(expired_at, now()) else expired_at end,
      updated_at = now()
  where id = v_payment.id
  returning * into v_payment;

  update public.organization_billing_profiles
  set payment_status = p_payment_status,
      last_payment_status = p_payment_status,
      updated_at = now()
  where organization_id = v_payment.organization_id;

  if p_payment_status = 'paid' then
    v_profile := public.ensure_organization_billing_profile(v_payment.organization_id);
    select * into v_profile from public.organization_billing_profiles where organization_id = v_payment.organization_id for update;
    v_old_seats := v_profile.licensed_seats;
    v_old_plan_key := v_profile.plan_key;

    if v_payment.payment_type = 'extra_seat' and v_payment.license_delta > 0 then
      update public.organization_billing_profiles
      set purchased_seats = purchased_seats + v_payment.license_delta,
          licensed_seats = included_seats + purchased_seats + v_payment.license_delta,
          payment_status = 'paid',
          last_payment_status = 'paid',
          updated_at = now(),
          metadata = metadata || jsonb_build_object('last_successful_payment_id', v_payment.provider_payment_id)
      where id = v_profile.id
      returning * into v_profile;

      insert into public.organization_license_changes(
        organization_id, billing_profile_id, payment_record_id, change_type, status,
        old_plan_key, new_plan_key, old_licensed_seats, new_licensed_seats, delta_seats,
        reason, applied_at, metadata
      ) values (
        v_payment.organization_id, v_profile.id, v_payment.id, 'seat_purchase', 'applied',
        v_profile.plan_key, v_profile.plan_key, v_old_seats, v_profile.licensed_seats, v_payment.license_delta,
        'Extra seat betaald via tenant-specifieke Mollie Connect checkout.', now(), jsonb_build_object('provider_payment_id', v_payment.provider_payment_id)
      );

      update public.organization_payment_records
      set processed_at = now(), seats_before = v_old_seats, seats_after = v_profile.licensed_seats, updated_at = now()
      where id = v_payment.id
      returning * into v_payment;

      perform public.log_billing_audit(v_payment.organization_id, 'payment_succeeded', 'payment', v_payment.id, v_payment.provider_payment_id, jsonb_build_object('payment_type', v_payment.payment_type, 'amount_cents', v_payment.amount_cents), null);
      perform public.log_billing_audit(v_payment.organization_id, 'seat_purchased', 'license_change', v_payment.id, 'Extra seat', jsonb_build_object('delta_seats', v_payment.license_delta, 'old_licensed_seats', v_old_seats, 'new_licensed_seats', v_profile.licensed_seats), null);

    elsif v_payment.payment_type = 'plan_change' then
      if v_payment.plan_key is null then
        raise exception 'Plan change payment mist plan_key.' using errcode = '23514';
      end if;

      select * into v_plan from public.billing_plans where plan_key = v_payment.plan_key and is_active = true and is_custom = false;
      if not found then
        raise exception 'Plan change target is onbekend, inactief of custom.' using errcode = '23514';
      end if;

      v_new_seats := coalesce(v_plan.included_seats, v_profile.included_seats) + v_profile.purchased_seats;
      if v_new_seats < public.organization_reserved_license_count(v_payment.organization_id) then
        raise exception 'Planwijziging kan niet worden toegepast: te weinig seats voor actieve/pending gebruikers.' using errcode = '23514';
      end if;

      update public.organization_billing_profiles
      set plan_key = v_plan.plan_key,
          included_seats = coalesce(v_plan.included_seats, included_seats),
          licensed_seats = coalesce(v_plan.included_seats, included_seats) + purchased_seats,
          subscription_status = 'active',
          payment_status = 'paid',
          last_payment_status = 'paid',
          updated_at = now(),
          metadata = metadata || jsonb_build_object('last_plan_change_payment_id', v_payment.provider_payment_id)
      where id = v_profile.id
      returning * into v_profile;

      update public.organization_subscriptions
      set plan_key = v_profile.plan_key,
          included_seats = v_profile.included_seats,
          purchased_seats = v_profile.purchased_seats,
          licensed_seats = v_profile.licensed_seats,
          status = v_profile.subscription_status,
          updated_at = now()
      where organization_id = v_payment.organization_id
        and cancelled_at is null;

      insert into public.organization_license_changes(
        organization_id, billing_profile_id, payment_record_id, change_type, status,
        old_plan_key, new_plan_key, old_licensed_seats, new_licensed_seats, delta_seats,
        reason, applied_at, metadata
      ) values (
        v_payment.organization_id, v_profile.id, v_payment.id, 'plan_change', 'applied',
        v_old_plan_key, v_profile.plan_key, v_old_seats, v_profile.licensed_seats, v_profile.licensed_seats - v_old_seats,
        'Planwijziging toegepast na Mollie-betaling.', now(), jsonb_build_object('provider_payment_id', v_payment.provider_payment_id)
      );

      update public.organization_payment_records
      set processed_at = now(), seats_before = v_old_seats, seats_after = v_profile.licensed_seats, updated_at = now()
      where id = v_payment.id
      returning * into v_payment;

      perform public.log_billing_audit(v_payment.organization_id, 'payment_succeeded', 'payment', v_payment.id, v_payment.provider_payment_id, jsonb_build_object('payment_type', v_payment.payment_type, 'amount_cents', v_payment.amount_cents), null);
      perform public.log_billing_audit(v_payment.organization_id, 'plan_changed', 'billing_profile', v_profile.id, v_profile.plan_key, jsonb_build_object('old_plan_key', v_old_plan_key, 'new_plan_key', v_profile.plan_key, 'old_licensed_seats', v_old_seats, 'new_licensed_seats', v_profile.licensed_seats), null);

    else
      update public.organization_payment_records
      set processed_at = now(), updated_at = now()
      where id = v_payment.id
      returning * into v_payment;
      perform public.log_billing_audit(v_payment.organization_id, 'payment_succeeded', 'payment', v_payment.id, v_payment.provider_payment_id, jsonb_build_object('payment_type', v_payment.payment_type, 'note', 'Geen seatmutatie vereist'), null);
    end if;

    update public.organization_billing_events
    set status = 'processed', processed_at = now()
    where id = v_event.id;

  elsif p_payment_status in ('failed','canceled','expired') then
    v_action := case when p_payment_status = 'expired' then 'payment_expired' else 'payment_failed' end;
    perform public.log_billing_audit(v_payment.organization_id, v_action, 'payment', v_payment.id, v_payment.provider_payment_id, jsonb_build_object('status', p_payment_status, 'payment_type', v_payment.payment_type), null);
    update public.organization_billing_events set status = 'processed', processed_at = now() where id = v_event.id;
  else
    update public.organization_billing_events set status = 'ignored', processed_at = now() where id = v_event.id;
  end if;

  return v_payment;
end;
$$;

revoke all on function public.request_organization_plan_change(uuid, text) from public;
revoke all on function public.apply_paid_organization_payment(text, text, jsonb) from public;
grant execute on function public.request_organization_plan_change(uuid, text) to authenticated;
grant execute on function public.apply_paid_organization_payment(text, text, jsonb) to service_role;
