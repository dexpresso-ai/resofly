-- ============================================================
-- ResoFly — Klant-billing op ResoFly's eigen Mollie-account (abonnementen)
-- Date: 2026-06-26
--
-- Doel:
-- - Voorbereiding voor doorlopende abonnementen die ResoFly int op zijn EIGEN
--   Mollie-account (Customers + mandaat via eerste betaling + Subscriptions),
--   i.p.v. de oude "tenant betaalt zichzelf via Mollie Connect"-richting.
-- - De edge function `billing` zet de Mollie-velden (customer/mandate/subscription),
--   periodes en status; deze migratie levert alleen de schema-/configuratiehaakjes.
--
-- Let op: de bestaande velden mollie_customer_id / mollie_mandate_id /
-- mollie_subscription_id op organization_billing_profiles worden hergebruikt en nu
-- gevuld met resources op het ResoFly-account.
-- ============================================================

-- Configureerbare proefperiode per plan (standaard 0 = geen trial). De volledige
-- trial-afhandeling (uitgestelde eerste incasso) volgt later; deze kolom maakt het
-- alvast instelbaar zonder schemawijziging.
alter table public.billing_plans
  add column if not exists trial_days integer not null default 0 check (trial_days >= 0);

-- 'subscription' is al een toegestaan payment_type (zie 20260430000002). We voegen
-- geen nieuwe types toe; de eerste betaling wordt als 'subscription' geregistreerd,
-- een directe seat-/planwijziging op een lopend mandaat als 'extra_seat'/'plan_change'.

-- Idempotente verwerking van een betaalde eerste betaling: koppel het mandaat aan het
-- profiel en zet het abonnement actief. De subscription zelf wordt door de edge
-- function bij Mollie aangemaakt; deze RPC legt de DB-staat vast (service-role).
create or replace function public.activate_organization_subscription(
  p_organization_id uuid,
  p_plan_key text,
  p_mollie_customer_id text,
  p_mollie_mandate_id text,
  p_mollie_subscription_id text,
  p_current_period_ends_at timestamptz default (now() + interval '1 month'),
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
      mollie_customer_id = coalesce(p_mollie_customer_id, mollie_customer_id),
      mollie_mandate_id = coalesce(p_mollie_mandate_id, mollie_mandate_id),
      mollie_subscription_id = coalesce(p_mollie_subscription_id, mollie_subscription_id),
      mollie_connect_status = 'connected',
      current_period_ends_at = p_current_period_ends_at,
      next_invoice_date = (p_current_period_ends_at)::date,
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
      updated_at = now()
  where organization_id = p_organization_id
  returning * into v_profile;

  perform public.log_billing_audit(
    p_organization_id, 'plan_changed', 'billing_profile', v_profile.id, v_profile.plan_key,
    jsonb_build_object('source', 'activate_organization_subscription', 'subscription_id', p_mollie_subscription_id), null
  );

  return v_profile;
end;
$$;

revoke all on function public.activate_organization_subscription(uuid, text, text, text, text, timestamptz, jsonb) from public;
grant execute on function public.activate_organization_subscription(uuid, text, text, text, text, timestamptz, jsonb) to service_role;

-- Periode verlengen / status bijwerken op basis van een (recurring) subscription-betaling.
create or replace function public.record_organization_subscription_payment(
  p_organization_id uuid,
  p_payment_status text,
  p_current_period_ends_at timestamptz default (now() + interval '1 month')
)
returns public.organization_billing_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.organization_billing_profiles;
  v_sub_status text;
begin
  v_sub_status := case
    when p_payment_status = 'paid' then 'active'
    when p_payment_status in ('failed','expired') then 'past_due'
    else null
  end;

  update public.organization_billing_profiles
  set payment_status = p_payment_status,
      last_payment_status = p_payment_status,
      subscription_status = coalesce(v_sub_status, subscription_status),
      current_period_ends_at = case when p_payment_status = 'paid' then p_current_period_ends_at else current_period_ends_at end,
      next_invoice_date = case when p_payment_status = 'paid' then (p_current_period_ends_at)::date else next_invoice_date end,
      updated_at = now()
  where organization_id = p_organization_id
  returning * into v_profile;

  perform public.log_billing_audit(
    p_organization_id,
    case when p_payment_status = 'paid' then 'payment_succeeded' else 'payment_failed' end,
    'billing_profile', v_profile.id, v_profile.plan_key,
    jsonb_build_object('source', 'subscription_payment', 'status', p_payment_status), null
  );

  return v_profile;
end;
$$;

revoke all on function public.record_organization_subscription_payment(uuid, text, timestamptz) from public;
grant execute on function public.record_organization_subscription_payment(uuid, text, timestamptz) to service_role;

-- Seats/plan direct toepassen op een lopend mandaat (de edge function PATcht het
-- Mollie-abonnementsbedrag; hier leggen we de seat-/planmutatie vast). Hergebruikt
-- de bestaande seat-wiskunde en audit.
create or replace function public.apply_organization_seat_change(
  p_organization_id uuid,
  p_plan_key text default null,
  p_purchased_seats integer default null,
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
  v_purchased integer;
  v_old_seats integer;
begin
  v_profile := public.ensure_organization_billing_profile(p_organization_id);
  v_old_seats := v_profile.licensed_seats;

  if p_plan_key is not null then
    select * into v_plan from public.billing_plans where plan_key = p_plan_key;
    if not found then
      raise exception 'Onbekend plan %.', p_plan_key using errcode = '23514';
    end if;
    v_included := coalesce(v_plan.included_seats, v_profile.included_seats);
  else
    v_included := v_profile.included_seats;
  end if;

  v_purchased := coalesce(p_purchased_seats, v_profile.purchased_seats);
  if v_purchased < 0 then
    raise exception 'Aantal extra seats kan niet negatief zijn.' using errcode = '23514';
  end if;

  update public.organization_billing_profiles
  set plan_key = coalesce(p_plan_key, plan_key),
      included_seats = v_included,
      purchased_seats = v_purchased,
      licensed_seats = v_included + v_purchased,
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
      updated_at = now()
  where organization_id = p_organization_id
  returning * into v_profile;

  insert into public.organization_license_changes(
    organization_id, billing_profile_id, change_type, status,
    old_plan_key, new_plan_key, old_licensed_seats, new_licensed_seats, delta_seats,
    reason, applied_at, metadata
  ) values (
    p_organization_id, v_profile.id,
    case when p_plan_key is not null then 'plan_change' else 'seat_purchase' end, 'applied',
    null, v_profile.plan_key, v_old_seats, v_profile.licensed_seats, v_profile.licensed_seats - v_old_seats,
    'Seat-/planwijziging op lopend Mollie-abonnement.', now(), coalesce(p_metadata, '{}'::jsonb)
  );

  return v_profile;
end;
$$;

revoke all on function public.apply_organization_seat_change(uuid, text, integer, jsonb) from public;
grant execute on function public.apply_organization_seat_change(uuid, text, integer, jsonb) to service_role;
