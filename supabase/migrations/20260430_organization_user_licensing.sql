-- ============================================================
-- BrandCore — Organization user licensing / seats
-- Date: 2026-04-30
--
-- Purpose:
-- - Elke actieve organisatiegebruiker verbruikt 1 gebruikerslicentie.
-- - Openstaande teamuitnodigingen reserveren alvast 1 licentie.
-- - Extra gebruikers kunnen pas worden uitgenodigd/geactiveerd als billing
--   via service-role extra seats heeft gesynchroniseerd.
-- ============================================================

alter table public.organizations add column if not exists licensed_seats integer not null default 1;
alter table public.organizations add column if not exists license_status text not null default 'active';
alter table public.organizations add column if not exists license_provider text;
alter table public.organizations add column if not exists license_external_customer_id text;
alter table public.organizations add column if not exists license_external_subscription_id text;
alter table public.organization_invitations add column if not exists consumes_license boolean not null default true;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_licensed_seats_positive') then
    alter table public.organizations add constraint organizations_licensed_seats_positive check (licensed_seats >= 1);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'organizations_license_status_check') then
    alter table public.organizations add constraint organizations_license_status_check check (license_status in ('trialing','active','past_due','cancelled'));
  end if;
end $$;

create table if not exists public.organization_license_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  delta_seats integer not null,
  seats_after integer not null check (seats_after >= 1),
  reason text not null check (reason in ('initial','purchase','downgrade','cancellation','manual_correction','billing_sync')),
  provider text,
  provider_reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_org_license_events_org_created on public.organization_license_events(organization_id, created_at desc);

-- Existing workspaces krijgen genoeg seats voor de huidige actieve leden + open uitnodigingen,
-- zodat de migratie geen bestaande organisaties breekt.
with usage as (
  select
    o.id as organization_id,
    greatest(
      1,
      count(distinct om.id)::integer + count(distinct oi.id)::integer
    ) as required_seats
  from public.organizations o
  left join public.organization_members om
    on om.organization_id = o.id
   and om.status = 'active'
  left join public.organization_invitations oi
    on oi.organization_id = o.id
   and oi.status = 'pending'
   and oi.consumes_license = true
   and (oi.expires_at is null or oi.expires_at > now())
  group by o.id
)
update public.organizations o
set licensed_seats = greatest(o.licensed_seats, usage.required_seats),
    license_status = coalesce(nullif(o.license_status, ''), 'active'),
    updated_at = now()
from usage
where usage.organization_id = o.id
  and (o.licensed_seats < usage.required_seats or o.license_status is null or o.license_status = '');

insert into public.organization_license_events(organization_id, delta_seats, seats_after, reason, provider, metadata)
select o.id, o.licensed_seats, o.licensed_seats, 'initial', 'migration', jsonb_build_object('source', '20260430_organization_user_licensing')
from public.organizations o
where not exists (
  select 1 from public.organization_license_events e
  where e.organization_id = o.id and e.reason = 'initial'
);

create or replace function public.organization_reserved_license_count(
  p_organization_id uuid,
  p_exclude_member_id uuid default null,
  p_exclude_invitation_id uuid default null
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select (
    select count(*)::integer
    from public.organization_members om
    where om.organization_id = p_organization_id
      and om.status = 'active'
      and (p_exclude_member_id is null or om.id <> p_exclude_member_id)
  ) + (
    select count(*)::integer
    from public.organization_invitations oi
    where oi.organization_id = p_organization_id
      and oi.status = 'pending'
      and oi.consumes_license = true
      and (oi.expires_at is null or oi.expires_at > now())
      and (p_exclude_invitation_id is null or oi.id <> p_exclude_invitation_id)
  );
$$;

create or replace function public.organization_license_usage(p_organization_id uuid)
returns table (
  organization_id uuid,
  licensed_seats integer,
  active_members integer,
  pending_invitations integer,
  used_seats integer,
  available_seats integer,
  license_status text
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
    o.license_status
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
  v_old_seats integer;
  v_reserved integer;
  v_org public.organizations;
begin
  if p_licensed_seats is null or p_licensed_seats < 1 then
    raise exception 'Aantal licenties moet minimaal 1 zijn.' using errcode = '23514';
  end if;

  select licensed_seats into v_old_seats
  from public.organizations
  where id = p_organization_id
  for update;

  if not found then
    raise exception 'Organisatie niet gevonden.' using errcode = 'P0002';
  end if;

  v_reserved := public.organization_reserved_license_count(p_organization_id);
  if p_licensed_seats < v_reserved then
    raise exception 'Aantal licenties (%) is lager dan het aantal gebruikte/gereserveerde licenties (%). Trek eerst uitnodigingen in of schakel teamleden uit.', p_licensed_seats, v_reserved using errcode = '23514';
  end if;

  perform set_config('brandcore.license_sync', 'true', true);

  update public.organizations
  set licensed_seats = p_licensed_seats,
      license_status = 'active',
      license_provider = p_provider,
      license_external_subscription_id = coalesce(p_provider_reference, license_external_subscription_id),
      updated_at = now()
  where id = p_organization_id
  returning * into v_org;

  insert into public.organization_license_events(organization_id, delta_seats, seats_after, reason, provider, provider_reference, metadata, created_by)
  values (
    p_organization_id,
    p_licensed_seats - v_old_seats,
    p_licensed_seats,
    case
      when p_licensed_seats > v_old_seats then 'purchase'
      when p_licensed_seats < v_old_seats then 'downgrade'
      else 'billing_sync'
    end,
    p_provider,
    p_provider_reference,
    coalesce(p_metadata, '{}'::jsonb),
    auth.uid()
  );

  return v_org;
end;
$$;

create or replace function public.invite_organization_member(p_organization_id uuid, p_email citext, p_role text)
returns public.organization_invitations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_clean_email citext := lower(trim(p_email::text))::citext;
  v_invitation public.organization_invitations;
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if not public.user_has_org_role(p_organization_id, array['owner','admin']) then
    raise exception 'Alleen owners/admins mogen teamleden uitnodigen' using errcode = '42501';
  end if;
  if p_role not in ('admin','member','viewer') then
    raise exception 'Ongeldige organisatierol' using errcode = '23514';
  end if;
  if nullif(trim(p_email::text), '') is null then
    raise exception 'E-mailadres ontbreekt' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.organization_members
    where organization_id = p_organization_id
      and email = v_clean_email
      and status = 'active'
  ) then
    raise exception 'Dit e-mailadres is al actief lid van deze organisatie.' using errcode = '23505';
  end if;

  insert into public.organization_invitations(organization_id, email, role, consumes_license, invited_by, status, expires_at)
  values (p_organization_id, v_clean_email, p_role, true, v_user_id, 'pending', now() + interval '14 days')
  on conflict (organization_id, email) where status = 'pending'
  do update set role = excluded.role, consumes_license = true, invited_by = excluded.invited_by, expires_at = excluded.expires_at, updated_at = now()
  returning * into v_invitation;

  return v_invitation;
end;
$$;

create or replace function public.accept_organization_invitation(p_invitation_id uuid)
returns public.organization_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email citext := public.current_user_email();
  v_invitation public.organization_invitations;
  v_member public.organization_members;
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if v_email is null then raise exception 'Geen e-mail bekend in sessie' using errcode = '23514'; end if;

  select * into v_invitation
  from public.organization_invitations
  where id = p_invitation_id
    and status = 'pending'
    and email = v_email
    and (expires_at is null or expires_at > now())
  for update;

  if not found then
    raise exception 'Uitnodiging niet gevonden of verlopen' using errcode = 'P0002';
  end if;

  update public.organization_invitations
  set status = 'accepted', consumes_license = false, accepted_by = v_user_id, accepted_at = now(), updated_at = now()
  where id = v_invitation.id;

  insert into public.organization_members(organization_id, user_id, email, role, status, invited_by, joined_at)
  values (v_invitation.organization_id, v_user_id, v_email, v_invitation.role, 'active', v_invitation.invited_by, now())
  on conflict (organization_id, user_id)
  do update set role = excluded.role, status = 'active', email = excluded.email, updated_at = now()
  returning * into v_member;

  return v_member;
end;
$$;

create or replace function public.prevent_organization_license_direct_change()
returns trigger
language plpgsql
as $$
begin
  if (
    old.licensed_seats is distinct from new.licensed_seats
    or old.license_status is distinct from new.license_status
    or old.license_provider is distinct from new.license_provider
    or old.license_external_customer_id is distinct from new.license_external_customer_id
    or old.license_external_subscription_id is distinct from new.license_external_subscription_id
  ) and coalesce(current_setting('brandcore.license_sync', true), '') <> 'true' then
    raise exception 'Licentievelden kunnen alleen via de billing/service-role worden aangepast.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_member_license_capacity()
returns trigger
language plpgsql
as $$
declare
  v_licensed integer;
  v_reserved integer;
begin
  if new.status = 'active' then
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

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'organizations_license_guard') then
    create trigger organizations_license_guard before update of licensed_seats, license_status, license_provider, license_external_customer_id, license_external_subscription_id on public.organizations for each row execute function public.prevent_organization_license_direct_change();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'organization_members_license_capacity') then
    create trigger organization_members_license_capacity before insert or update of status on public.organization_members for each row execute function public.enforce_member_license_capacity();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'organization_invitations_license_capacity') then
    create trigger organization_invitations_license_capacity before insert or update of status, consumes_license, expires_at on public.organization_invitations for each row execute function public.enforce_invitation_license_capacity();
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'organization_license_events_audit') then
    create trigger organization_license_events_audit after insert or update or delete on public.organization_license_events for each row execute function public.audit_row_change('license_event','reason');
  end if;
end $$;

alter table public.organization_license_events enable row level security;

drop policy if exists "license events read by org admins" on public.organization_license_events;
create policy "license events read by org admins" on public.organization_license_events for select using (public.can_admin_org(organization_id));

revoke all on function public.organization_reserved_license_count(uuid, uuid, uuid) from public;
revoke all on function public.organization_license_usage(uuid) from public;
revoke all on function public.apply_organization_license_purchase(uuid, integer, text, text, jsonb) from public;
grant execute on function public.organization_license_usage(uuid) to authenticated;
grant execute on function public.apply_organization_license_purchase(uuid, integer, text, text, jsonb) to service_role;
