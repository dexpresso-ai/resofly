-- ============================================================
-- ResoFly — Maand/jaar-factuurinterval voor ResoFly-abonnementen
-- Date: 2026-06-26
--
-- Doel:
-- - Klanten kunnen bij het starten van een abonnement kiezen tussen maandelijks
--   en jaarlijks betalen. Het gekozen interval geldt voor het hele abonnement,
--   inclusief extra seats.
-- - Jaarprijzen worden per plan ingesteld (standaard 0 = jaar niet aangeboden;
--   de UI toont 'jaar' alleen wanneer er een jaarprijs > 0 staat).
-- ============================================================

-- 1) Jaarprijzen per plan (basis + per extra seat). Standaard 0 = niet aangeboden.
alter table public.billing_plans
  add column if not exists yearly_price_cents integer not null default 0 check (yearly_price_cents >= 0),
  add column if not exists extra_seat_yearly_price_cents integer not null default 0 check (extra_seat_yearly_price_cents >= 0);

-- 2) Gekozen factuurinterval op het billingprofiel.
alter table public.organization_billing_profiles
  add column if not exists billing_interval text not null default 'month' check (billing_interval in ('month','year'));

-- 3) Overview uitbreiden met billing_interval + jaarprijzen (drop+recreate i.v.m. returns).
drop function if exists public.organization_billing_overview(uuid);
create function public.organization_billing_overview(p_organization_id uuid)
returns table (
  organization_id uuid,
  plan_key text,
  plan_name text,
  included_seats integer,
  purchased_seats integer,
  licensed_seats integer,
  active_members integer,
  pending_invitations integer,
  used_seats integer,
  available_seats integer,
  subscription_status text,
  payment_status text,
  mollie_connect_status text,
  mollie_customer_id text,
  mollie_mandate_id text,
  mollie_subscription_id text,
  last_payment_status text,
  next_invoice_date date,
  trial_ends_at timestamptz,
  current_period_ends_at timestamptz,
  monthly_price_cents integer,
  extra_seat_price_cents integer,
  currency text,
  billing_exempt boolean,
  billing_interval text,
  yearly_price_cents integer,
  extra_seat_yearly_price_cents integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.organization_billing_profiles;
begin
  if not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen owners/admins mogen billing bekijken.' using errcode = '42501';
  end if;

  perform public.expire_stale_organization_invitations(p_organization_id);
  v_profile := public.ensure_organization_billing_profile(p_organization_id);

  return query
  select
    p.organization_id,
    p.plan_key,
    bp.name,
    p.included_seats,
    p.purchased_seats,
    p.licensed_seats,
    coalesce(active_counts.active_members, 0)::integer,
    coalesce(pending_counts.pending_invitations, 0)::integer,
    (coalesce(active_counts.active_members, 0) + coalesce(pending_counts.pending_invitations, 0))::integer,
    greatest(p.licensed_seats - (coalesce(active_counts.active_members, 0) + coalesce(pending_counts.pending_invitations, 0)), 0)::integer,
    p.subscription_status,
    p.payment_status,
    p.mollie_connect_status,
    p.mollie_customer_id,
    p.mollie_mandate_id,
    p.mollie_subscription_id,
    p.last_payment_status,
    p.next_invoice_date,
    p.trial_ends_at,
    p.current_period_ends_at,
    bp.monthly_price_cents,
    bp.extra_seat_price_cents,
    bp.currency,
    p.billing_exempt,
    p.billing_interval,
    bp.yearly_price_cents,
    bp.extra_seat_yearly_price_cents
  from public.organization_billing_profiles p
  join public.billing_plans bp on bp.plan_key = p.plan_key
  left join lateral (
    select count(*)::integer as active_members
    from public.organization_members om
    where om.organization_id = p.organization_id and om.status = 'active'
  ) active_counts on true
  left join lateral (
    select count(*)::integer as pending_invitations
    from public.organization_invitations oi
    where oi.organization_id = p.organization_id
      and oi.status = 'pending'
      and oi.consumes_license = true
      and (oi.expires_at is null or oi.expires_at > now())
  ) pending_counts on true
  where p.organization_id = p_organization_id;
end;
$$;

revoke all on function public.organization_billing_overview(uuid) from public;
grant execute on function public.organization_billing_overview(uuid) to authenticated;

-- 4) Activatie: interval meenemen en periode-einde per interval bepalen.
drop function if exists public.activate_organization_subscription(uuid, text, text, text, text, timestamptz, jsonb);
create function public.activate_organization_subscription(
  p_organization_id uuid,
  p_plan_key text,
  p_mollie_customer_id text,
  p_mollie_mandate_id text,
  p_mollie_subscription_id text,
  p_billing_interval text default 'month',
  p_metadata jsonb default '{}'::jsonb
)
returns public.organization_billing_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.organization_billing_profiles;
  v_plan public.billing_plans;
  v_included integer;
  v_interval text := case when p_billing_interval = 'year' then 'year' else 'month' end;
  v_period_end timestamptz := case when v_interval = 'year' then now() + interval '1 year' else now() + interval '1 month' end;
begin
  v_profile := public.ensure_organization_billing_profile(p_organization_id);

  select * into v_plan from public.billing_plans where plan_key = p_plan_key;
  if not found then
    raise exception 'Onbekend plan %.', p_plan_key using errcode = '23514';
  end if;

  v_included := coalesce(v_plan.included_seats, v_profile.included_seats);

  update public.organization_billing_profiles
  set plan_key = p_plan_key,
      included_seats = v_included,
      licensed_seats = v_included + purchased_seats,
      subscription_status = 'active',
      payment_status = 'paid',
      last_payment_status = 'paid',
      billing_interval = v_interval,
      mollie_customer_id = coalesce(p_mollie_customer_id, mollie_customer_id),
      mollie_mandate_id = coalesce(p_mollie_mandate_id, mollie_mandate_id),
      mollie_subscription_id = coalesce(p_mollie_subscription_id, mollie_subscription_id),
      mollie_connect_status = 'connected',
      current_period_ends_at = v_period_end,
      next_invoice_date = v_period_end::date,
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
      updated_at = now()
  where organization_id = p_organization_id
  returning * into v_profile;

  perform public.log_billing_audit(
    p_organization_id, 'plan_changed', 'billing_profile', v_profile.id, v_profile.plan_key,
    jsonb_build_object('source', 'activate_organization_subscription', 'subscription_id', p_mollie_subscription_id, 'interval', v_interval), null
  );

  return v_profile;
end;
$$;

revoke all on function public.activate_organization_subscription(uuid, text, text, text, text, text, jsonb) from public;
grant execute on function public.activate_organization_subscription(uuid, text, text, text, text, text, jsonb) to service_role;

-- 5) Recurring-betaling: periode verlengen volgens het opgeslagen interval.
drop function if exists public.record_organization_subscription_payment(uuid, text, timestamptz);
create function public.record_organization_subscription_payment(
  p_organization_id uuid,
  p_payment_status text
)
returns public.organization_billing_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.organization_billing_profiles;
  v_sub_status text;
  v_interval text;
  v_period_end timestamptz;
begin
  select billing_interval into v_interval
  from public.organization_billing_profiles
  where organization_id = p_organization_id;
  v_period_end := case when v_interval = 'year' then now() + interval '1 year' else now() + interval '1 month' end;

  v_sub_status := case
    when p_payment_status = 'paid' then 'active'
    when p_payment_status in ('failed','expired') then 'past_due'
    else null
  end;

  update public.organization_billing_profiles
  set payment_status = p_payment_status,
      last_payment_status = p_payment_status,
      subscription_status = coalesce(v_sub_status, subscription_status),
      current_period_ends_at = case when p_payment_status = 'paid' then v_period_end else current_period_ends_at end,
      next_invoice_date = case when p_payment_status = 'paid' then v_period_end::date else next_invoice_date end,
      updated_at = now()
  where organization_id = p_organization_id
  returning * into v_profile;

  perform public.log_billing_audit(
    p_organization_id,
    case when p_payment_status = 'paid' then 'payment_succeeded' else 'payment_failed' end,
    'billing_profile', v_profile.id, v_profile.plan_key,
    jsonb_build_object('source', 'subscription_payment', 'status', p_payment_status, 'interval', v_interval), null
  );

  return v_profile;
end;
$$;

revoke all on function public.record_organization_subscription_payment(uuid, text) from public;
grant execute on function public.record_organization_subscription_payment(uuid, text) to service_role;
