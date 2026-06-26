-- ============================================================
-- ResoFly — Interne/gratis organisaties (billing_exempt) + seat-cap bypass
-- Date: 2026-06-26
--
-- Doel:
-- - Een organisatie kan als "intern/gratis" gemarkeerd worden (billing_exempt).
--   Voor zulke organisaties geldt GEEN seat-limiet: uitnodigen en teamleden
--   activeren werkt onbeperkt, los van licensed_seats of een Mollie-koppeling.
-- - De vlag is uitsluitend via service-role/RPC te zetten; organisaties kunnen
--   zichzelf niet vrijstellen.
-- - De ResoFly-eigen organisatie wordt direct vrijgesteld zodat het team nu
--   gebruikers kan toevoegen, onafhankelijk van de (nog te bouwen) klant-billing.
-- ============================================================

-- 1) Vlag op het billingprofiel (RLS: alleen service-role/RPC schrijft hier).
alter table public.organization_billing_profiles
  add column if not exists billing_exempt boolean not null default false;

-- 2) Hulpfunctie: is een organisatie vrijgesteld van facturatie/seat-limiet?
create or replace function public.organization_is_billing_exempt(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select bp.billing_exempt
    from public.organization_billing_profiles bp
    where bp.organization_id = p_organization_id
  ), false);
$$;

-- 3) Capacity-trigger uitnodigingen: cap overslaan voor vrijgestelde organisaties.
create or replace function public.enforce_invitation_license_capacity()
returns trigger
language plpgsql
as $$
declare
  v_licensed integer;
  v_reserved integer;
begin
  -- Alleen geldige pending uitnodigingen reserveren een seat. Zodra een
  -- uitnodiging wordt geaccepteerd, ingetrokken of verlopen is, komt de
  -- gereserveerde seat direct vrij.
  if new.status <> 'pending' or (new.expires_at is not null and new.expires_at <= now()) then
    new.consumes_license := false;
    return new;
  end if;

  new.consumes_license := true;

  -- Interne/gratis organisaties hebben geen seat-limiet.
  if public.organization_is_billing_exempt(new.organization_id) then
    return new;
  end if;

  select licensed_seats into v_licensed
  from public.organizations
  where id = new.organization_id
  for update;

  if v_licensed is null then
    raise exception 'Organisatie niet gevonden.' using errcode = 'P0002';
  end if;

  v_reserved := public.organization_reserved_license_count(new.organization_id, null, case when TG_OP = 'UPDATE' then new.id else null end);
  if v_reserved + 1 > v_licensed then
    raise exception 'Geen vrije gebruikerslicentie beschikbaar. Koop eerst een extra gebruikerslicentie voordat je iemand uitnodigt.' using errcode = '23514';
  end if;

  return new;
end;
$$;

-- 4) Capacity-trigger teamleden: cap overslaan voor vrijgestelde organisaties.
create or replace function public.enforce_member_license_capacity()
returns trigger
language plpgsql
as $$
declare
  v_licensed integer;
  v_reserved integer;
begin
  if new.status = 'active' then
    -- Interne/gratis organisaties hebben geen seat-limiet.
    if public.organization_is_billing_exempt(new.organization_id) then
      return new;
    end if;

    select licensed_seats into v_licensed
    from public.organizations
    where id = new.organization_id
    for update;

    if v_licensed is null then
      raise exception 'Organisatie niet gevonden.' using errcode = 'P0002';
    end if;

    v_reserved := public.organization_reserved_license_count(new.organization_id, case when TG_OP = 'UPDATE' then new.id else null end, null);
    if v_reserved + 1 > v_licensed then
      raise exception 'Geen vrije gebruikerslicentie beschikbaar. Koop eerst een extra licentie voordat je dit teamlid activeert.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- 5) Billingprofiel-capacity: bij vrijstelling de "licensed < gebruikt"-check overslaan
--    (de seat-math-check blijft altijd gelden).
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

  if coalesce(new.billing_exempt, false) then
    return new;
  end if;

  v_used := public.organization_reserved_license_count(new.organization_id);
  if new.licensed_seats < v_used then
    raise exception 'Aantal licenties (%) is lager dan het aantal gebruikte/gereserveerde licenties (%). Trek eerst uitnodigingen in of schakel teamleden uit.', new.licensed_seats, v_used using errcode = '23514';
  end if;

  return new;
end;
$$;

-- 6) Usage-RPC uitbreiden met billing_exempt (drop+recreate i.v.m. gewijzigde returns).
drop function if exists public.organization_license_usage(uuid);
create function public.organization_license_usage(p_organization_id uuid)
returns table (
  organization_id uuid,
  licensed_seats integer,
  active_members integer,
  pending_invitations integer,
  used_seats integer,
  available_seats integer,
  license_status text,
  billing_exempt boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_read_org(p_organization_id) then
    raise exception 'Geen toegang tot deze organisatie.' using errcode = '42501';
  end if;

  return query
  select
    o.id,
    o.licensed_seats,
    coalesce(active_counts.active_members, 0)::integer,
    coalesce(pending_counts.pending_invitations, 0)::integer,
    (coalesce(active_counts.active_members, 0) + coalesce(pending_counts.pending_invitations, 0))::integer,
    greatest(o.licensed_seats - (coalesce(active_counts.active_members, 0) + coalesce(pending_counts.pending_invitations, 0)), 0)::integer,
    o.license_status,
    public.organization_is_billing_exempt(o.id)
  from public.organizations o
  left join lateral (
    select count(*)::integer as active_members
    from public.organization_members om
    where om.organization_id = o.id and om.status = 'active'
  ) active_counts on true
  left join lateral (
    select count(*)::integer as pending_invitations
    from public.organization_invitations oi
    where oi.organization_id = o.id
      and oi.status = 'pending'
      and oi.consumes_license = true
      and (oi.expires_at is null or oi.expires_at > now())
  ) pending_counts on true
  where o.id = p_organization_id;
end;
$$;

revoke all on function public.organization_license_usage(uuid) from public;
grant execute on function public.organization_license_usage(uuid) to authenticated;

-- 7) Billing-overview uitbreiden met billing_exempt (drop+recreate i.v.m. gewijzigde returns).
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
  billing_exempt boolean
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
    p.billing_exempt
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

-- 8) Service-role RPC om de vrijstelling te zetten (geen self-service).
create or replace function public.set_organization_billing_exempt(p_organization_id uuid, p_exempt boolean)
returns public.organization_billing_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.organization_billing_profiles;
begin
  v_profile := public.ensure_organization_billing_profile(p_organization_id);

  update public.organization_billing_profiles
  set billing_exempt = coalesce(p_exempt, false),
      updated_at = now()
  where organization_id = p_organization_id
  returning * into v_profile;

  perform public.log_billing_audit(
    p_organization_id,
    'billing_synced',
    'billing_profile',
    v_profile.id,
    v_profile.plan_key,
    jsonb_build_object('billing_exempt', coalesce(p_exempt, false), 'source', 'set_organization_billing_exempt'),
    null
  );

  return v_profile;
end;
$$;

revoke all on function public.set_organization_billing_exempt(uuid, boolean) from public;
grant execute on function public.set_organization_billing_exempt(uuid, boolean) to service_role;

-- 9) ResoFly-eigen organisatie(s) direct vrijstellen zodat het team nu gebruikers
--    kan toevoegen. Identificatie via de eigenaar (owner) op gerjanvanlopik@gmail.com.
--    Zorg dat er een billingprofiel bestaat en zet de vlag.
do $$
declare
  v_org uuid;
begin
  for v_org in
    select distinct om.organization_id
    from public.organization_members om
    where lower(om.email::text) = 'gerjanvanlopik@gmail.com'
      and om.role = 'owner'
      and om.status = 'active'
  loop
    perform public.ensure_organization_billing_profile(v_org);
    update public.organization_billing_profiles
    set billing_exempt = true, updated_at = now()
    where organization_id = v_org;
  end loop;
end $$;
