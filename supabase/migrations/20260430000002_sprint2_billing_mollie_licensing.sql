-- ============================================================
-- BrandCore — Sprint 2 billing, Mollie preparation & SaaS seats
-- Date: 2026-04-30
--
-- Purpose:
-- - Add a production-oriented organization billing layer.
-- - Keep organizations.licensed_seats as the compatibility field, but make
--   organization_billing_profiles the billing source of truth.
-- - Prepare Mollie Connect, checkout payments and idempotent webhooks.
-- ============================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

-- Audit actions become broader in Sprint 2. Existing audit triggers still work,
-- but billing can now write explicit business events.
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
      'licensed_seats_changed','invitation_blocked_insufficient_seats','billing_synced'
    ));
end $$;

create table if not exists public.billing_plans (
  plan_key text primary key,
  name text not null,
  description text,
  included_seats integer check (included_seats is null or included_seats >= 1),
  monthly_price_cents integer not null default 0 check (monthly_price_cents >= 0),
  extra_seat_price_cents integer not null default 900 check (extra_seat_price_cents >= 0),
  currency text not null default 'EUR',
  is_custom boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 100,
  limits jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.billing_plans(plan_key, name, description, included_seats, monthly_price_cents, extra_seat_price_cents, currency, is_custom, sort_order, limits)
values
  ('starter', 'Starter', 'Voor solo-gebruikers en kleine starts.', 1, 1500, 900, 'EUR', false, 10, jsonb_build_object('included_seats', 1)),
  ('team', 'Team', 'Voor kleine teams met standaard samenwerking.', 3, 3900, 800, 'EUR', false, 20, jsonb_build_object('included_seats', 3)),
  ('pro', 'Pro', 'Voor grotere teams met ruimere capaciteit.', 10, 9900, 700, 'EUR', false, 30, jsonb_build_object('included_seats', 10)),
  ('custom', 'Custom', 'Handmatig afgestemd contract.', null, 0, 0, 'EUR', true, 90, jsonb_build_object('manual_seats', true))
on conflict (plan_key) do update set
  name = excluded.name,
  description = excluded.description,
  included_seats = excluded.included_seats,
  monthly_price_cents = excluded.monthly_price_cents,
  extra_seat_price_cents = excluded.extra_seat_price_cents,
  currency = excluded.currency,
  is_custom = excluded.is_custom,
  is_active = excluded.is_active,
  sort_order = excluded.sort_order,
  limits = excluded.limits,
  updated_at = now();

create table if not exists public.organization_billing_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  plan_key text not null default 'starter' references public.billing_plans(plan_key),
  included_seats integer not null default 1 check (included_seats >= 1),
  purchased_seats integer not null default 0 check (purchased_seats >= 0),
  licensed_seats integer not null default 1 check (licensed_seats >= 1),
  subscription_status text not null default 'active' check (subscription_status in ('trialing','active','past_due','cancelled','incomplete','incomplete_expired','paused')),
  payment_status text not null default 'none' check (payment_status in ('none','open','pending','paid','failed','expired','canceled','authorized','refunded','charged_back')),
  mollie_connect_status text not null default 'not_connected' check (mollie_connect_status in ('not_connected','pending','connected','mock_connected','error','revoked')),
  mollie_connect_account_id text,
  mollie_customer_id text,
  mollie_mandate_id text,
  mollie_subscription_id text,
  last_payment_status text,
  next_invoice_date date,
  trial_ends_at timestamptz,
  current_period_ends_at timestamptz,
  billing_email citext,
  vat_number text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_billing_profiles_seat_math check (licensed_seats = included_seats + purchased_seats)
);

create table if not exists public.organization_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  billing_profile_id uuid references public.organization_billing_profiles(id) on delete set null,
  plan_key text not null references public.billing_plans(plan_key),
  status text not null default 'active' check (status in ('trialing','active','past_due','cancelled','incomplete','incomplete_expired','paused')),
  provider text not null default 'brandcore',
  provider_customer_id text,
  provider_mandate_id text,
  provider_subscription_id text,
  included_seats integer not null default 1 check (included_seats >= 1),
  purchased_seats integer not null default 0 check (purchased_seats >= 0),
  licensed_seats integer not null default 1 check (licensed_seats >= 1),
  started_at timestamptz not null default now(),
  current_period_starts_at timestamptz,
  current_period_ends_at timestamptz,
  trial_ends_at timestamptz,
  cancelled_at timestamptz,
  next_invoice_date date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_subscriptions_seat_math check (licensed_seats = included_seats + purchased_seats)
);

create table if not exists public.organization_payment_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  billing_profile_id uuid references public.organization_billing_profiles(id) on delete set null,
  subscription_id uuid references public.organization_subscriptions(id) on delete set null,
  payment_type text not null check (payment_type in ('extra_seat','plan_change','subscription','manual_adjustment')),
  provider text not null default 'mollie',
  provider_payment_id text,
  provider_checkout_url text,
  provider_customer_id text,
  provider_subscription_id text,
  idempotency_key text,
  status text not null default 'open' check (status in ('open','pending','paid','failed','expired','canceled','authorized','refunded','charged_back')),
  amount_cents integer not null default 0 check (amount_cents >= 0),
  currency text not null default 'EUR',
  plan_key text references public.billing_plans(plan_key),
  license_delta integer not null default 0,
  seats_before integer,
  seats_after integer,
  checkout_expires_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  canceled_at timestamptz,
  expired_at timestamptz,
  processed_at timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_org_payment_records_provider_payment_id
  on public.organization_payment_records(provider, provider_payment_id)
  where provider_payment_id is not null;
create unique index if not exists idx_org_payment_records_idempotency
  on public.organization_payment_records(organization_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists idx_org_payment_records_org_created on public.organization_payment_records(organization_id, created_at desc);
create index if not exists idx_org_payment_records_status on public.organization_payment_records(organization_id, status, created_at desc);

create table if not exists public.organization_billing_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_key text not null,
  event_type text not null,
  event_source text not null default 'brandcore',
  provider text,
  provider_resource_id text,
  status text not null default 'received' check (status in ('received','processed','ignored','failed')),
  payment_record_id uuid references public.organization_payment_records(id) on delete set null,
  subscription_id uuid references public.organization_subscriptions(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  error_message text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_key)
);

create index if not exists idx_org_billing_events_org_created on public.organization_billing_events(organization_id, created_at desc);
create index if not exists idx_org_billing_events_resource on public.organization_billing_events(provider, provider_resource_id);

create table if not exists public.organization_license_changes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  billing_profile_id uuid references public.organization_billing_profiles(id) on delete set null,
  payment_record_id uuid references public.organization_payment_records(id) on delete set null,
  change_type text not null check (change_type in ('initial','plan_change','seat_purchase','seat_downgrade_request','manual_correction','billing_sync','subscription_cancelled')),
  status text not null default 'applied' check (status in ('requested','pending_payment','applied','blocked','cancelled','failed')),
  old_plan_key text,
  new_plan_key text,
  old_licensed_seats integer,
  new_licensed_seats integer,
  delta_seats integer not null default 0,
  reason text,
  requested_by uuid references auth.users(id) on delete set null,
  applied_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  applied_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_org_license_changes_org_created on public.organization_license_changes(organization_id, created_at desc);

-- Keep existing organizations compatibility fields synchronized from billing.
create or replace function public.map_billing_subscription_status_to_license_status(p_status text)
returns text
language sql
immutable
as $$
  select case
    when p_status in ('trialing') then 'trialing'
    when p_status in ('active') then 'active'
    when p_status in ('past_due','incomplete','incomplete_expired','paused') then 'past_due'
    when p_status in ('cancelled') then 'cancelled'
    else 'active'
  end;
$$;

create or replace function public.expire_stale_organization_invitations(p_organization_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.organization_invitations
  set status = 'expired', consumes_license = false, updated_at = now()
  where organization_id = p_organization_id
    and status = 'pending'
    and expires_at is not null
    and expires_at <= now();

  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

create or replace function public.organization_used_license_count(p_organization_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select public.organization_reserved_license_count(p_organization_id);
$$;

create or replace function public.log_billing_audit(
  p_organization_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid default null,
  p_entity_label text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_user_id uuid default auth.uid()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, p_actor_user_id, p_action, p_entity_type, p_entity_id, p_entity_label, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

create or replace function public.ensure_organization_billing_profile(p_organization_id uuid)
returns public.organization_billing_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org public.organizations;
  v_profile public.organization_billing_profiles;
  v_plan public.billing_plans;
  v_included integer;
  v_purchased integer;
begin
  select * into v_org from public.organizations where id = p_organization_id for update;
  if not found then
    raise exception 'Organisatie niet gevonden.' using errcode = 'P0002';
  end if;

  select * into v_profile from public.organization_billing_profiles where organization_id = p_organization_id;
  if found then
    return v_profile;
  end if;

  select * into v_plan from public.billing_plans where plan_key = 'starter';
  v_included := coalesce(v_plan.included_seats, 1);
  v_purchased := greatest(v_org.licensed_seats - v_included, 0);

  insert into public.organization_billing_profiles(
    organization_id, plan_key, included_seats, purchased_seats, licensed_seats,
    subscription_status, payment_status, mollie_customer_id, mollie_subscription_id, metadata
  ) values (
    p_organization_id,
    'starter',
    v_included,
    v_purchased,
    v_included + v_purchased,
    coalesce(nullif(v_org.license_status, ''), 'active'),
    'none',
    v_org.license_external_customer_id,
    v_org.license_external_subscription_id,
    jsonb_build_object('source', 'ensure_organization_billing_profile')
  ) returning * into v_profile;

  insert into public.organization_subscriptions(
    organization_id, billing_profile_id, plan_key, status, provider,
    provider_customer_id, provider_subscription_id,
    included_seats, purchased_seats, licensed_seats, metadata
  ) values (
    p_organization_id, v_profile.id, v_profile.plan_key, v_profile.subscription_status, coalesce(v_org.license_provider, 'brandcore'),
    v_profile.mollie_customer_id, v_profile.mollie_subscription_id,
    v_profile.included_seats, v_profile.purchased_seats, v_profile.licensed_seats,
    jsonb_build_object('source', 'ensure_organization_billing_profile')
  );

  insert into public.organization_license_changes(
    organization_id, billing_profile_id, change_type, status,
    new_plan_key, old_licensed_seats, new_licensed_seats, delta_seats,
    reason, applied_at, metadata
  ) values (
    p_organization_id, v_profile.id, 'initial', 'applied',
    v_profile.plan_key, null, v_profile.licensed_seats, v_profile.licensed_seats,
    'Initial billing profile created', now(), jsonb_build_object('source', 'ensure_organization_billing_profile')
  ) on conflict do nothing;

  return v_profile;
end;
$$;

create or replace function public.enforce_billing_profile_capacity()
returns trigger
language plpgsql
as $$
declare
  v_used integer;
begin
  if new.licensed_seats <> new.included_seats + new.purchased_seats then
    raise exception 'licensed_seats moet gelijk zijn aan included_seats + purchased_seats.' using errcode = '23514';
  end if;

  v_used := public.organization_reserved_license_count(new.organization_id);
  if new.licensed_seats < v_used then
    raise exception 'Aantal licenties (%) is lager dan het aantal gebruikte/gereserveerde licenties (%). Trek eerst uitnodigingen in of schakel teamleden uit.', new.licensed_seats, v_used using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function public.sync_organization_license_from_billing_profile()
returns trigger
language plpgsql
as $$
declare
  v_old_seats integer;
  v_new_license_status text;
begin
  select licensed_seats into v_old_seats from public.organizations where id = new.organization_id for update;
  v_new_license_status := public.map_billing_subscription_status_to_license_status(new.subscription_status);

  if v_old_seats is distinct from new.licensed_seats
     or exists (
       select 1 from public.organizations o
       where o.id = new.organization_id
         and (
           o.license_status is distinct from v_new_license_status
           or (new.mollie_customer_id is not null and o.license_provider is distinct from 'mollie')
           or o.license_external_customer_id is distinct from new.mollie_customer_id
           or o.license_external_subscription_id is distinct from new.mollie_subscription_id
         )
     ) then
    perform set_config('brandcore.license_sync', 'true', true);

    update public.organizations
    set licensed_seats = new.licensed_seats,
        license_status = v_new_license_status,
        license_provider = case when new.mollie_customer_id is not null or new.mollie_subscription_id is not null then 'mollie' else coalesce(license_provider, 'brandcore') end,
        license_external_customer_id = new.mollie_customer_id,
        license_external_subscription_id = new.mollie_subscription_id,
        updated_at = now()
    where id = new.organization_id;
  end if;

  if tg_op = 'UPDATE' and old.licensed_seats is distinct from new.licensed_seats then
    insert into public.organization_license_events(organization_id, delta_seats, seats_after, reason, provider, provider_reference, metadata)
    values (
      new.organization_id,
      new.licensed_seats - old.licensed_seats,
      new.licensed_seats,
      'billing_sync',
      'mollie',
      new.mollie_subscription_id,
      jsonb_build_object('old_licensed_seats', old.licensed_seats, 'new_licensed_seats', new.licensed_seats, 'billing_profile_id', new.id)
    );

    perform public.log_billing_audit(
      new.organization_id,
      'licensed_seats_changed',
      'billing_profile',
      new.id,
      new.plan_key,
      jsonb_build_object('old_licensed_seats', old.licensed_seats, 'new_licensed_seats', new.licensed_seats, 'source', 'billing_profile_sync'),
      auth.uid()
    );
  end if;

  return new;
end;
$$;

create or replace function public.organization_billing_overview(p_organization_id uuid)
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
  currency text
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
    bp.currency
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

create or replace function public.record_invitation_blocked_insufficient_seats(p_organization_id uuid, p_email citext default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usage record;
begin
  if not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen owners/admins mogen billing-events registreren.' using errcode = '42501';
  end if;

  select * into v_usage from public.organization_license_usage(p_organization_id) limit 1;
  perform public.log_billing_audit(
    p_organization_id,
    'invitation_blocked_insufficient_seats',
    'invitation',
    null,
    coalesce(p_email::text, 'unknown'),
    jsonb_build_object('email', p_email, 'usage', row_to_json(v_usage)),
    auth.uid()
  );
end;
$$;

create or replace function public.request_organization_plan_change(p_organization_id uuid, p_plan_key text)
returns public.organization_billing_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.organization_billing_profiles;
  v_plan public.billing_plans;
  v_used integer;
  v_old_profile public.organization_billing_profiles;
begin
  if not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen owners/admins mogen het plan wijzigen.' using errcode = '42501';
  end if;

  select * into v_plan from public.billing_plans where plan_key = p_plan_key and is_active = true;
  if not found then
    raise exception 'Onbekend of inactief plan.' using errcode = '23514';
  end if;
  if v_plan.is_custom then
    raise exception 'Custom-plannen worden handmatig via billing beheerd.' using errcode = '23514';
  end if;

  v_old_profile := public.ensure_organization_billing_profile(p_organization_id);
  v_used := public.organization_reserved_license_count(p_organization_id);

  if coalesce(v_plan.included_seats, v_old_profile.included_seats) + v_old_profile.purchased_seats < v_used then
    insert into public.organization_license_changes(
      organization_id, billing_profile_id, change_type, status,
      old_plan_key, new_plan_key, old_licensed_seats, new_licensed_seats, delta_seats,
      reason, requested_by, metadata
    ) values (
      p_organization_id, v_old_profile.id, 'plan_change', 'blocked',
      v_old_profile.plan_key, p_plan_key, v_old_profile.licensed_seats,
      coalesce(v_plan.included_seats, v_old_profile.included_seats) + v_old_profile.purchased_seats,
      (coalesce(v_plan.included_seats, v_old_profile.included_seats) + v_old_profile.purchased_seats) - v_old_profile.licensed_seats,
      'Planwijziging geblokkeerd: te weinig seats voor actieve gebruikers en pending uitnodigingen.',
      auth.uid(), jsonb_build_object('used_seats', v_used)
    );
    perform public.log_billing_audit(p_organization_id, 'seat_downgrade_requested', 'billing_profile', v_old_profile.id, p_plan_key, jsonb_build_object('blocked', true, 'used_seats', v_used), auth.uid());
    raise exception 'Dit plan heeft te weinig seats voor de huidige actieve gebruikers en openstaande uitnodigingen.' using errcode = '23514';
  end if;

  update public.organization_billing_profiles
  set plan_key = p_plan_key,
      included_seats = coalesce(v_plan.included_seats, included_seats),
      licensed_seats = coalesce(v_plan.included_seats, included_seats) + purchased_seats,
      subscription_status = 'active',
      updated_at = now(),
      metadata = metadata || jsonb_build_object('last_plan_change_at', now())
  where organization_id = p_organization_id
  returning * into v_profile;

  update public.organization_subscriptions
  set plan_key = v_profile.plan_key,
      included_seats = v_profile.included_seats,
      purchased_seats = v_profile.purchased_seats,
      licensed_seats = v_profile.licensed_seats,
      status = v_profile.subscription_status,
      updated_at = now()
  where organization_id = p_organization_id
    and cancelled_at is null;

  insert into public.organization_license_changes(
    organization_id, billing_profile_id, change_type, status,
    old_plan_key, new_plan_key, old_licensed_seats, new_licensed_seats, delta_seats,
    reason, requested_by, applied_at, metadata
  ) values (
    p_organization_id, v_profile.id, 'plan_change', 'applied',
    v_old_profile.plan_key, v_profile.plan_key, v_old_profile.licensed_seats, v_profile.licensed_seats,
    v_profile.licensed_seats - v_old_profile.licensed_seats,
    'Plan gewijzigd door organisatie-admin.', auth.uid(), now(), jsonb_build_object('used_seats', v_used)
  );

  perform public.log_billing_audit(p_organization_id, 'plan_changed', 'billing_profile', v_profile.id, v_profile.plan_key, jsonb_build_object('old_plan_key', v_old_profile.plan_key, 'new_plan_key', v_profile.plan_key), auth.uid());
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
  v_old_seats integer;
  v_new_seats integer;
  v_event_key text := 'mollie:payment:' || coalesce(p_provider_payment_id, 'unknown') || ':' || coalesce(p_payment_status, 'unknown');
  v_action text;
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
    organization_id, event_key, event_type, event_source, provider, provider_resource_id, status, payment_record_id, payload
  ) values (
    v_payment.organization_id, v_event_key, 'payment.' || p_payment_status, 'mollie_webhook', 'mollie', p_provider_payment_id, 'received', v_payment.id, coalesce(p_payload, '{}'::jsonb)
  ) on conflict (event_key) do nothing;

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

  if p_payment_status = 'paid' and v_payment.processed_at is null then
    v_profile := public.ensure_organization_billing_profile(v_payment.organization_id);
    select * into v_profile from public.organization_billing_profiles where organization_id = v_payment.organization_id for update;
    v_old_seats := v_profile.licensed_seats;

    if v_payment.payment_type = 'extra_seat' and v_payment.license_delta > 0 then
      v_new_seats := v_profile.licensed_seats + v_payment.license_delta;

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
        'Extra seat betaald via Mollie.', now(), jsonb_build_object('provider_payment_id', v_payment.provider_payment_id)
      );

      update public.organization_payment_records
      set processed_at = now(), seats_before = v_old_seats, seats_after = v_profile.licensed_seats, updated_at = now()
      where id = v_payment.id
      returning * into v_payment;

      perform public.log_billing_audit(v_payment.organization_id, 'payment_succeeded', 'payment', v_payment.id, v_payment.provider_payment_id, jsonb_build_object('payment_type', v_payment.payment_type, 'amount_cents', v_payment.amount_cents), null);
      perform public.log_billing_audit(v_payment.organization_id, 'seat_purchased', 'license_change', v_payment.id, 'Extra seat', jsonb_build_object('delta_seats', v_payment.license_delta, 'old_licensed_seats', v_old_seats, 'new_licensed_seats', v_profile.licensed_seats), null);
    else
      update public.organization_payment_records
      set processed_at = now(), updated_at = now()
      where id = v_payment.id
      returning * into v_payment;
      perform public.log_billing_audit(v_payment.organization_id, 'payment_succeeded', 'payment', v_payment.id, v_payment.provider_payment_id, jsonb_build_object('payment_type', v_payment.payment_type, 'note', 'Geen seatmutatie vereist'), null);
    end if;

    update public.organization_billing_events
    set status = 'processed', processed_at = now()
    where event_key = v_event_key;
  elsif p_payment_status in ('failed','canceled','expired') then
    v_action := case when p_payment_status = 'expired' then 'payment_expired' else 'payment_failed' end;
    perform public.log_billing_audit(v_payment.organization_id, v_action, 'payment', v_payment.id, v_payment.provider_payment_id, jsonb_build_object('status', p_payment_status, 'payment_type', v_payment.payment_type), null);
    update public.organization_billing_events set status = 'processed', processed_at = now() where event_key = v_event_key;
  else
    update public.organization_billing_events set status = 'ignored', processed_at = now() where event_key = v_event_key;
  end if;

  return v_payment;
end;
$$;

-- Backwards-compatible wrapper. Existing integrations can still call this RPC,
-- but it now syncs billing profile first and therefore keeps organizations.licensed_seats coherent.
create or replace function public.apply_organization_license_purchase(
  p_organization_id uuid,
  p_licensed_seats integer,
  p_provider text default null,
  p_provider_reference text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_profile public.organization_billing_profiles;
  v_profile public.organization_billing_profiles;
  v_delta integer;
  v_org public.organizations;
begin
  if p_licensed_seats is null or p_licensed_seats < 1 then
    raise exception 'Aantal licenties moet minimaal 1 zijn.' using errcode = '23514';
  end if;

  v_old_profile := public.ensure_organization_billing_profile(p_organization_id);
  if p_licensed_seats < public.organization_reserved_license_count(p_organization_id) then
    raise exception 'Aantal licenties is lager dan actieve gebruikers plus openstaande uitnodigingen.' using errcode = '23514';
  end if;

  v_delta := p_licensed_seats - v_old_profile.licensed_seats;

  update public.organization_billing_profiles
  set purchased_seats = greatest(p_licensed_seats - included_seats, 0),
      licensed_seats = included_seats + greatest(p_licensed_seats - included_seats, 0),
      subscription_status = 'active',
      payment_status = case when v_delta > 0 then 'paid' else payment_status end,
      mollie_subscription_id = coalesce(p_provider_reference, mollie_subscription_id),
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
    case when v_delta > 0 then 'seat_purchase' when v_delta < 0 then 'seat_downgrade_request' else 'billing_sync' end,
    'applied', v_old_profile.plan_key, v_profile.plan_key,
    v_old_profile.licensed_seats, v_profile.licensed_seats, v_delta,
    'Legacy license purchase RPC', now(), coalesce(p_metadata, '{}'::jsonb)
  );

  select * into v_org from public.organizations where id = p_organization_id;
  return v_org;
end;
$$;

-- Timestamp triggers.
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'billing_plans_updated_at') then
    create trigger billing_plans_updated_at before update on public.billing_plans for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'organization_billing_profiles_capacity_guard') then
    create trigger organization_billing_profiles_capacity_guard before insert or update of included_seats, purchased_seats, licensed_seats on public.organization_billing_profiles for each row execute function public.enforce_billing_profile_capacity();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'organization_billing_profiles_updated_at') then
    create trigger organization_billing_profiles_updated_at before update on public.organization_billing_profiles for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'organization_billing_profiles_sync_org') then
    create trigger organization_billing_profiles_sync_org after insert or update of licensed_seats, subscription_status, mollie_customer_id, mollie_subscription_id on public.organization_billing_profiles for each row execute function public.sync_organization_license_from_billing_profile();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'organization_subscriptions_updated_at') then
    create trigger organization_subscriptions_updated_at before update on public.organization_subscriptions for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'organization_payment_records_updated_at') then
    create trigger organization_payment_records_updated_at before update on public.organization_payment_records for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'organization_billing_profiles_audit') then
    create trigger organization_billing_profiles_audit after insert or update or delete on public.organization_billing_profiles for each row execute function public.audit_row_change('billing_profile','plan_key');
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'organization_subscriptions_audit') then
    create trigger organization_subscriptions_audit after insert or update or delete on public.organization_subscriptions for each row execute function public.audit_row_change('subscription','plan_key');
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'organization_payment_records_audit') then
    create trigger organization_payment_records_audit after insert or update or delete on public.organization_payment_records for each row execute function public.audit_row_change('payment','payment_type');
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'organization_billing_events_audit') then
    create trigger organization_billing_events_audit after insert or update or delete on public.organization_billing_events for each row execute function public.audit_row_change('billing_event','event_type');
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'organization_license_changes_audit') then
    create trigger organization_license_changes_audit after insert or update or delete on public.organization_license_changes for each row execute function public.audit_row_change('license_change','change_type');
  end if;
end $$;

-- Backfill billing profiles for existing organizations after all triggers exist.
insert into public.organization_billing_profiles(organization_id, plan_key, included_seats, purchased_seats, licensed_seats, subscription_status, payment_status, mollie_customer_id, mollie_subscription_id, metadata)
select
  o.id,
  'starter',
  1,
  greatest(o.licensed_seats - 1, 0),
  greatest(o.licensed_seats, 1),
  coalesce(nullif(o.license_status, ''), 'active'),
  'none',
  o.license_external_customer_id,
  o.license_external_subscription_id,
  jsonb_build_object('source', '20260430_sprint2_backfill')
from public.organizations o
where not exists (select 1 from public.organization_billing_profiles p where p.organization_id = o.id);

insert into public.organization_subscriptions(organization_id, billing_profile_id, plan_key, status, provider, provider_customer_id, provider_subscription_id, included_seats, purchased_seats, licensed_seats, metadata)
select p.organization_id, p.id, p.plan_key, p.subscription_status, 'brandcore', p.mollie_customer_id, p.mollie_subscription_id, p.included_seats, p.purchased_seats, p.licensed_seats, jsonb_build_object('source', '20260430_sprint2_backfill')
from public.organization_billing_profiles p
where not exists (select 1 from public.organization_subscriptions s where s.organization_id = p.organization_id and s.cancelled_at is null);

-- RLS.
alter table public.billing_plans enable row level security;
alter table public.organization_billing_profiles enable row level security;
alter table public.organization_subscriptions enable row level security;
alter table public.organization_payment_records enable row level security;
alter table public.organization_billing_events enable row level security;
alter table public.organization_license_changes enable row level security;

drop policy if exists "billing plans readable" on public.billing_plans;
create policy "billing plans readable" on public.billing_plans for select using (is_active = true);

drop policy if exists "billing profiles read by org admins" on public.organization_billing_profiles;
create policy "billing profiles read by org admins" on public.organization_billing_profiles for select using (public.can_admin_org(organization_id));

drop policy if exists "subscriptions read by org admins" on public.organization_subscriptions;
create policy "subscriptions read by org admins" on public.organization_subscriptions for select using (public.can_admin_org(organization_id));

drop policy if exists "payments read by org admins" on public.organization_payment_records;
create policy "payments read by org admins" on public.organization_payment_records for select using (public.can_admin_org(organization_id));

drop policy if exists "billing events read by org admins" on public.organization_billing_events;
create policy "billing events read by org admins" on public.organization_billing_events for select using (public.can_admin_org(organization_id));

drop policy if exists "license changes read by org admins" on public.organization_license_changes;
create policy "license changes read by org admins" on public.organization_license_changes for select using (public.can_admin_org(organization_id));

-- Harden direct organization license updates remains enforced by previous migration.
-- New write paths are RPC/service-role only.
revoke all on function public.expire_stale_organization_invitations(uuid) from public;
revoke all on function public.organization_used_license_count(uuid) from public;
revoke all on function public.ensure_organization_billing_profile(uuid) from public;
revoke all on function public.organization_billing_overview(uuid) from public;
revoke all on function public.record_invitation_blocked_insufficient_seats(uuid, citext) from public;
revoke all on function public.request_organization_plan_change(uuid, text) from public;
revoke all on function public.apply_paid_organization_payment(text, text, jsonb) from public;
revoke all on function public.apply_organization_license_purchase(uuid, integer, text, text, jsonb) from public;
revoke all on function public.log_billing_audit(uuid, text, text, uuid, text, jsonb, uuid) from public;

grant execute on function public.organization_billing_overview(uuid) to authenticated;
grant execute on function public.record_invitation_blocked_insufficient_seats(uuid, citext) to authenticated;
grant execute on function public.request_organization_plan_change(uuid, text) to authenticated;
grant execute on function public.expire_stale_organization_invitations(uuid) to authenticated;
grant execute on function public.ensure_organization_billing_profile(uuid) to service_role;
grant execute on function public.organization_used_license_count(uuid) to service_role;
grant execute on function public.apply_paid_organization_payment(text, text, jsonb) to service_role;
grant execute on function public.apply_organization_license_purchase(uuid, integer, text, text, jsonb) to service_role;
grant execute on function public.log_billing_audit(uuid, text, text, uuid, text, jsonb, uuid) to service_role;
