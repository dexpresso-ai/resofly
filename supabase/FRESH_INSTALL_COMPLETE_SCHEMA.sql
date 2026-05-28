-- ============================================================
-- BrandCore Database Setup — Fresh Supabase Project
-- Version: 2.2.1-sprint2-mollie-connect-hardening
--
-- Gebruik dit bestand voor een NIEUWE / LEGE Supabase database.
-- Plak de volledige inhoud in Supabase SQL Editor en klik Run.
--
-- Multi-tenant opzet:
-- - organizations = tenant/account/workspace
-- - organization_members = gebruikers binnen organisaties met rollen
-- - alle app-data hangt aan organization_id
-- - RLS leest/schrijft op basis van actieve organisatie-memberships
-- - relationele integriteit borgt dat gekoppelde records binnen dezelfde organisatie vallen
-- - elke actieve gebruiker/open uitnodiging verbruikt één aangekochte organisatie-licentie
-- ============================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

create or replace function public.current_user_email()
returns citext
language sql
stable
as $$
  select nullif(lower(coalesce(auth.jwt() ->> 'email', '')), '')::citext;
$$;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  licensed_seats integer not null default 1 check (licensed_seats >= 1),
  license_status text not null default 'active' check (license_status in ('trialing','active','past_due','cancelled')),
  license_provider text,
  license_external_customer_id text,
  license_external_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email citext,
  role text not null check (role in ('owner','admin','member','viewer')),
  status text not null default 'active' check (status in ('active','disabled')),
  invited_by uuid references auth.users(id) on delete set null,
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email citext not null,
  role text not null check (role in ('admin','member','viewer')),
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  consumes_license boolean not null default true,
  invited_by uuid not null references auth.users(id) on delete cascade,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  expires_at timestamptz default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);


create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null default auth.uid(),
  action text not null check (action in ('created','updated','deleted','invited','accepted','revoked','role_changed','disabled')),
  entity_type text not null,
  entity_id uuid,
  entity_label text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_audit_logs_org_created on public.audit_logs(organization_id, created_at desc);
create index idx_audit_logs_entity on public.audit_logs(organization_id, entity_type, entity_id);

create unique index idx_org_invites_pending_unique on public.organization_invitations(organization_id, email) where status = 'pending';
create index idx_org_members_user on public.organization_members(user_id, status);
create index idx_org_members_org on public.organization_members(organization_id, status);
create index idx_org_invites_email on public.organization_invitations(email, status);

create table public.organization_license_events (
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

create index idx_org_license_events_org_created on public.organization_license_events(organization_id, created_at desc);

create or replace function public.slugify(value text)
returns text
language plpgsql
immutable
as $$
declare
  v text;
begin
  v := lower(trim(coalesce(value, 'organisatie')));
  v := regexp_replace(v, '[^a-z0-9]+', '-', 'g');
  v := regexp_replace(v, '(^-|-$)', '', 'g');
  if v = '' then v := 'organisatie'; end if;
  return left(v, 60);
end;
$$;

create or replace function public.user_is_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members om
    where om.organization_id = p_organization_id
      and om.user_id = auth.uid()
      and om.status = 'active'
  );
$$;

create or replace function public.user_has_org_role(p_organization_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members om
    where om.organization_id = p_organization_id
      and om.user_id = auth.uid()
      and om.status = 'active'
      and om.role = any(p_roles)
  );
$$;

create or replace function public.can_read_org(p_organization_id uuid)
returns boolean
language sql
stable
as $$
  select public.user_is_org_member(p_organization_id);
$$;

create or replace function public.can_write_org(p_organization_id uuid)
returns boolean
language sql
stable
as $$
  select public.user_has_org_role(p_organization_id, array['owner','admin','member']);
$$;

create or replace function public.can_admin_org(p_organization_id uuid)
returns boolean
language sql
stable
as $$
  select public.user_has_org_role(p_organization_id, array['owner','admin']);
$$;

create or replace function public.can_owner_org(p_organization_id uuid)
returns boolean
language sql
stable
as $$
  select public.user_has_org_role(p_organization_id, array['owner']);
$$;

create or replace function public.create_organization(p_name text)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email citext := public.current_user_email();
  v_base_slug text := public.slugify(p_name);
  v_slug text := v_base_slug;
  v_counter int := 1;
  v_org public.organizations;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd' using errcode = '28000';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'Organisatienaam ontbreekt' using errcode = '23514';
  end if;

  while exists (select 1 from public.organizations where slug = v_slug) loop
    v_counter := v_counter + 1;
    v_slug := left(v_base_slug, 52) || '-' || v_counter::text;
  end loop;

  insert into public.organizations(name, slug, created_by)
  values (trim(p_name), v_slug, v_user_id)
  returning * into v_org;

  insert into public.organization_members(organization_id, user_id, email, role, status, invited_by)
  values (v_org.id, v_user_id, v_email, 'owner', 'active', v_user_id);

  insert into public.organization_license_events(organization_id, delta_seats, seats_after, reason, provider, created_by, metadata)
  values (v_org.id, 1, 1, 'initial', 'system', v_user_id, jsonb_build_object('source', 'create_organization'));

  return v_org;
end;
$$;

create or replace function public.ensure_user_default_organization()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email citext := public.current_user_email();
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd' using errcode = '28000';
  end if;

  update public.organization_members
  set email = coalesce(email, v_email), updated_at = now()
  where user_id = v_user_id and email is null;

  if exists (select 1 from public.organization_members where user_id = v_user_id and status = 'active') then
    return;
  end if;

  v_name := coalesce(nullif(split_part(v_email::text, '@', 1), ''), 'Mijn organisatie');
  perform public.create_organization(initcap(v_name));
end;
$$;


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

create or replace function public.prevent_last_owner_change()
returns trigger
language plpgsql
as $$
declare
  v_owner_count int;
begin
  if TG_OP = 'UPDATE' and old.role = 'owner' and (new.role <> 'owner' or new.status <> 'active') then
    select count(*) into v_owner_count from public.organization_members where organization_id = old.organization_id and role = 'owner' and status = 'active' and id <> old.id;
    if v_owner_count = 0 then
      raise exception 'Een organisatie moet minimaal één actieve owner houden' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.prevent_member_identity_change()
returns trigger
language plpgsql
as $$
begin
  if old.organization_id is distinct from new.organization_id then
    raise exception 'organization_members.organization_id kan niet worden gewijzigd' using errcode = '23514';
  end if;
  if old.user_id is distinct from new.user_id then
    raise exception 'organization_members.user_id kan niet worden gewijzigd' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.prevent_invitation_identity_change()
returns trigger
language plpgsql
as $$
begin
  if old.organization_id is distinct from new.organization_id then
    raise exception 'organization_invitations.organization_id kan niet worden gewijzigd' using errcode = '23514';
  end if;
  if old.email is distinct from new.email then
    raise exception 'organization_invitations.email kan niet worden gewijzigd' using errcode = '23514';
  end if;
  return new;
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

create trigger organizations_updated before update on public.organizations for each row execute function public.set_updated_at();
create trigger organizations_license_guard before update of licensed_seats, license_status, license_provider, license_external_customer_id, license_external_subscription_id on public.organizations for each row execute function public.prevent_organization_license_direct_change();
create trigger organization_members_updated before update on public.organization_members for each row execute function public.set_updated_at();
create trigger organization_invitations_updated before update on public.organization_invitations for each row execute function public.set_updated_at();
create trigger organization_members_license_capacity before insert or update of status on public.organization_members for each row execute function public.enforce_member_license_capacity();
create trigger organization_invitations_license_capacity before insert or update of status, consumes_license, expires_at on public.organization_invitations for each row execute function public.enforce_invitation_license_capacity();
create trigger organization_members_last_owner before update of role, status on public.organization_members for each row execute function public.prevent_last_owner_change();
create trigger organization_members_identity_guard before update of organization_id, user_id on public.organization_members for each row execute function public.prevent_member_identity_change();
create trigger organization_invitations_identity_guard before update of organization_id, email on public.organization_invitations for each row execute function public.prevent_invitation_identity_change();

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  name text not null,
  client_code text,
  contact_name text,
  email text,
  phone text,
  notes text,
  color text not null default '#FFD966',
  status text not null default 'active' check (status in ('active','prospect','inactive')),
  tags text[] not null default '{}',
  follow_up date,
  value_eur numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  name text not null,
  description text,
  color text not null default '#FFD966',
  archived boolean not null default false,
  start_date date,
  end_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'todo' check (status in ('todo','doing','review','done')),
  priority text not null default 'med' check (priority in ('low','med','high')),
  tags text[] not null default '{}',
  start_date date,
  end_date date,
  planned_date date,
  planned_order integer,
  estimated_minutes integer not null default 60 check (estimated_minutes >= 0 and estimated_minutes <= 1440),
  subtasks jsonb not null default '[]'::jsonb,
  comments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  title text not null,
  description text,
  priority text not null default 'med' check (priority in ('low','med','high')),
  status text not null default 'new' check (status in ('new','review','approved','rejected','converted')),
  notes text,
  converted_to_project_id uuid references public.projects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  title text not null,
  content text not null default '',
  note_type text not null default 'general' check (note_type in ('general','meeting','action','decision','idea','support')),
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.company_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  company_name text not null default '',
  trade_name text,
  address_line1 text,
  address_line2 text,
  postal_code text,
  city text,
  country text not null default 'Nederland',
  email text,
  phone text,
  website text,
  kvk_number text,
  vat_number text,
  iban text,
  invoice_payment_terms text,
  invoice_footer text,
  invoice_template_kind text not null default 'none' check (invoice_template_kind in ('none','pdf','image')),
  invoice_template_file_name text,
  invoice_template_mime_type text,
  invoice_template_file_size bigint not null default 0,
  invoice_template_data_url text,
  invoice_template_text_color text not null default '#1a1a1a',
  invoice_accent_color text not null default '#FFD966',
  invoice_template_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  number text not null,
  date date not null default current_date,
  valid_until date,
  lines jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft','sent','accepted','rejected','expired','paid','overdue','cancelled')),
  notes text,
  sent_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  quote_id uuid references public.quotes(id) on delete set null,
  number text not null,
  date date not null default current_date,
  due_date date,
  lines jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft','sent','accepted','rejected','expired','paid','overdue','cancelled')),
  notes text,
  sent_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  entity_type text not null check (entity_type in ('client','project','task','subtask','ticket','note','quote','invoice')),
  entity_id uuid not null,
  parent_task_id uuid,
  name text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  storage_key text not null,
  public_url text,
  created_at timestamptz not null default now()
);

create or replace function public.assert_same_org_reference(p_ref_table regclass, p_ref_id uuid, p_organization_id uuid, p_label text)
returns void
language plpgsql
as $$
declare
  v_exists boolean;
begin
  if p_ref_id is null then return; end if;

  execute format('select exists(select 1 from %s where id = $1 and organization_id = $2)', p_ref_table)
    into v_exists
    using p_ref_id, p_organization_id;

  if not v_exists then
    raise exception '% verwijst naar een record buiten de organisatie of een niet-bestaand record', p_label
      using errcode = '23514';
  end if;
end;
$$;

create or replace function public.enforce_projects_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'projects.client_id');
  return new;
end; $$;

create or replace function public.enforce_tasks_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.projects', new.project_id, new.organization_id, 'tasks.project_id');
  return new;
end; $$;

create or replace function public.normalize_ticket_conversion_state()
returns trigger language plpgsql as $$
begin
  if new.converted_to_project_id is null and new.status = 'converted' then
    if TG_OP = 'UPDATE' and old.status is not null and old.status <> 'converted' then
      new.status = old.status;
    else
      new.status = 'new';
    end if;
  end if;

  if new.converted_to_project_id is not null then
    new.status = 'converted';
  end if;

  return new;
end; $$;

create or replace function public.enforce_tickets_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'tickets.client_id');
  perform public.assert_same_org_reference('public.projects', new.converted_to_project_id, new.organization_id, 'tickets.converted_to_project_id');
  return new;
end; $$;

create or replace function public.enforce_notes_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'notes.client_id');
  perform public.assert_same_org_reference('public.projects', new.project_id, new.organization_id, 'notes.project_id');
  return new;
end; $$;

create or replace function public.enforce_quotes_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'quotes.client_id');
  perform public.assert_same_org_reference('public.projects', new.project_id, new.organization_id, 'quotes.project_id');
  return new;
end; $$;

create or replace function public.enforce_invoices_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'invoices.client_id');
  perform public.assert_same_org_reference('public.projects', new.project_id, new.organization_id, 'invoices.project_id');
  perform public.assert_same_org_reference('public.quotes', new.quote_id, new.organization_id, 'invoices.quote_id');
  return new;
end; $$;

create or replace function public.enforce_attachments_org_integrity()
returns trigger language plpgsql as $$
begin
  perform public.assert_same_org_reference('public.tasks', new.parent_task_id, new.organization_id, 'attachments.parent_task_id');

  case new.entity_type
    when 'client' then perform public.assert_same_org_reference('public.clients', new.entity_id, new.organization_id, 'attachments.entity_id(client)');
    when 'project' then perform public.assert_same_org_reference('public.projects', new.entity_id, new.organization_id, 'attachments.entity_id(project)');
    when 'task' then perform public.assert_same_org_reference('public.tasks', new.entity_id, new.organization_id, 'attachments.entity_id(task)');
    when 'subtask' then
      if new.parent_task_id is null then
        raise exception 'attachments.parent_task_id is verplicht voor subtask attachments' using errcode = '23514';
      end if;
      perform public.assert_same_org_reference('public.tasks', new.parent_task_id, new.organization_id, 'attachments.parent_task_id');
      if not exists (
        select 1 from public.tasks t
        where t.id = new.parent_task_id
          and t.organization_id = new.organization_id
          and t.subtasks @> jsonb_build_array(jsonb_build_object('id', new.entity_id::text))
      ) then
        raise exception 'attachments.entity_id(subtask) verwijst niet naar een bestaande subtaak op parent_task_id' using errcode = '23514';
      end if;
    when 'ticket' then perform public.assert_same_org_reference('public.tickets', new.entity_id, new.organization_id, 'attachments.entity_id(ticket)');
    when 'note' then perform public.assert_same_org_reference('public.notes', new.entity_id, new.organization_id, 'attachments.entity_id(note)');
    when 'quote' then perform public.assert_same_org_reference('public.quotes', new.entity_id, new.organization_id, 'attachments.entity_id(quote)');
    when 'invoice' then perform public.assert_same_org_reference('public.invoices', new.entity_id, new.organization_id, 'attachments.entity_id(invoice)');
    else raise exception 'Onbekend attachments.entity_type: %', new.entity_type using errcode = '23514';
  end case;
  return new;
end; $$;


create or replace function public.prevent_organization_id_change()
returns trigger language plpgsql as $$
begin
  if old.organization_id is distinct from new.organization_id then
    raise exception 'organization_id kan niet worden gewijzigd' using errcode = '23514';
  end if;
  return new;
end; $$;


create or replace function public.normalize_client_lookup_value(p_value text)
returns text
language sql
immutable
as $$
  select nullif(lower(regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g')), '');
$$;

create or replace function public.normalize_client_phone_value(p_value text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(coalesce(p_value, ''), '[^0-9]+', '', 'g'), '');
$$;

create or replace function public.enforce_clients_duplicate_guard()
returns trigger
language plpgsql
as $$
declare
  v_client_code_norm text;
  v_email_norm text;
  v_name_norm text;
  v_phone_norm text;
  v_contact_norm text;
  v_duplicate_label text;
begin
  new.name := btrim(coalesce(new.name, ''));
  if new.name = '' then
    raise exception 'Klantnaam is verplicht.' using errcode = '23514';
  end if;

  new.client_code := nullif(btrim(new.client_code), '');
  new.email := public.normalize_client_lookup_value(new.email);
  new.contact_name := nullif(btrim(new.contact_name), '');
  new.phone := nullif(btrim(new.phone), '');

  v_client_code_norm := public.normalize_client_lookup_value(new.client_code);
  v_email_norm := public.normalize_client_lookup_value(new.email);
  v_name_norm := public.normalize_client_lookup_value(new.name);
  v_phone_norm := public.normalize_client_phone_value(new.phone);
  v_contact_norm := public.normalize_client_lookup_value(new.contact_name);

  perform pg_advisory_xact_lock(hashtext(new.organization_id::text), hashtext('clients_duplicate_guard'));

  if v_client_code_norm is not null then
    select c.name || coalesce(' (' || c.client_code || ')', '')
      into v_duplicate_label
    from public.clients c
    where c.organization_id = new.organization_id
      and c.id is distinct from new.id
      and public.normalize_client_lookup_value(c.client_code) = v_client_code_norm
    limit 1;

    if found then
      raise exception 'Klantnummer "%" bestaat al binnen deze organisatie bij %.', new.client_code, v_duplicate_label using errcode = '23505';
    end if;
  end if;

  if v_email_norm is not null then
    select c.name || coalesce(' (' || c.client_code || ')', '')
      into v_duplicate_label
    from public.clients c
    where c.organization_id = new.organization_id
      and c.id is distinct from new.id
      and public.normalize_client_lookup_value(c.email) = v_email_norm
    limit 1;

    if found then
      raise exception 'Er bestaat al een klant met dit e-mailadres binnen deze organisatie: %.', v_duplicate_label using errcode = '23505';
    end if;
  end if;

  if v_name_norm is not null and v_phone_norm is not null then
    select c.name || coalesce(' (' || c.client_code || ')', '')
      into v_duplicate_label
    from public.clients c
    where c.organization_id = new.organization_id
      and c.id is distinct from new.id
      and public.normalize_client_lookup_value(c.name) = v_name_norm
      and public.normalize_client_phone_value(c.phone) = v_phone_norm
    limit 1;

    if found then
      raise exception 'Er bestaat al een klant met dezelfde naam en hetzelfde telefoonnummer binnen deze organisatie: %.', v_duplicate_label using errcode = '23505';
    end if;
  end if;

  if v_name_norm is not null and v_contact_norm is not null then
    select c.name || coalesce(' (' || c.client_code || ')', '')
      into v_duplicate_label
    from public.clients c
    where c.organization_id = new.organization_id
      and c.id is distinct from new.id
      and public.normalize_client_lookup_value(c.name) = v_name_norm
      and public.normalize_client_lookup_value(c.contact_name) = v_contact_norm
    limit 1;

    if found then
      raise exception 'Er bestaat al een klant met dezelfde naam en contactpersoon binnen deze organisatie: %.', v_duplicate_label using errcode = '23505';
    end if;
  end if;

  return new;
end;
$$;

create index idx_clients_org on public.clients(organization_id, created_at desc);
create index if not exists idx_clients_org_client_code_lookup on public.clients(organization_id, public.normalize_client_lookup_value(client_code)) where nullif(btrim(coalesce(client_code, '')), '') is not null;
create index if not exists idx_clients_org_email_lookup on public.clients(organization_id, public.normalize_client_lookup_value(email)) where nullif(btrim(coalesce(email, '')), '') is not null;
create index if not exists idx_clients_org_name_lookup on public.clients(organization_id, public.normalize_client_lookup_value(name));
create index if not exists idx_clients_org_phone_lookup on public.clients(organization_id, public.normalize_client_phone_value(phone)) where nullif(regexp_replace(coalesce(phone, ''), '[^0-9]+', '', 'g'), '') is not null;
create index idx_projects_org on public.projects(organization_id, archived, created_at desc);
create index idx_projects_client on public.projects(client_id);
create index idx_tasks_org on public.tasks(organization_id, status, end_date);
create index idx_tasks_org_planned_date_order on public.tasks(organization_id, planned_date, planned_order, created_at, id);
create index idx_tasks_org_status_planned_date on public.tasks(organization_id, status, planned_date);
create index idx_tasks_project on public.tasks(project_id);
create index idx_tickets_org on public.tickets(organization_id, status, created_at desc);
create index idx_tickets_client on public.tickets(client_id);
create index idx_notes_org on public.notes(organization_id, created_at desc);
create index idx_notes_client on public.notes(client_id);
create index idx_notes_project on public.notes(project_id);
create index idx_notes_type on public.notes(organization_id, note_type, created_at desc);
create index idx_notes_tags on public.notes using gin(tags);
create index idx_quotes_org on public.quotes(organization_id, created_at desc);
create index idx_quotes_client on public.quotes(client_id);
create index idx_quotes_project on public.quotes(project_id);
create index idx_invoices_org on public.invoices(organization_id, created_at desc);
create index idx_invoices_client on public.invoices(client_id);
create index idx_invoices_project on public.invoices(project_id);
create index idx_invoices_quote on public.invoices(quote_id);
create index idx_attachments_org on public.attachments(organization_id, created_at desc);
create index idx_attachments_entity on public.attachments(entity_type, entity_id);
create index idx_attachments_parent_task on public.attachments(parent_task_id) where parent_task_id is not null;

create trigger clients_updated before update on public.clients for each row execute function public.set_updated_at();
create trigger clients_duplicate_guard before insert or update of organization_id, name, client_code, email, phone, contact_name on public.clients for each row execute function public.enforce_clients_duplicate_guard();
create trigger projects_updated before update on public.projects for each row execute function public.set_updated_at();
create trigger tasks_updated before update on public.tasks for each row execute function public.set_updated_at();
create trigger tickets_updated before update on public.tickets for each row execute function public.set_updated_at();
create trigger notes_updated before update on public.notes for each row execute function public.set_updated_at();
create trigger company_settings_updated before update on public.company_settings for each row execute function public.set_updated_at();
create trigger quotes_updated before update on public.quotes for each row execute function public.set_updated_at();
create trigger invoices_updated before update on public.invoices for each row execute function public.set_updated_at();


create trigger clients_prevent_org_change before update of organization_id on public.clients for each row execute function public.prevent_organization_id_change();
create trigger projects_prevent_org_change before update of organization_id on public.projects for each row execute function public.prevent_organization_id_change();
create trigger tasks_prevent_org_change before update of organization_id on public.tasks for each row execute function public.prevent_organization_id_change();
create trigger tickets_prevent_org_change before update of organization_id on public.tickets for each row execute function public.prevent_organization_id_change();
create trigger notes_prevent_org_change before update of organization_id on public.notes for each row execute function public.prevent_organization_id_change();
create trigger company_settings_prevent_org_change before update of organization_id on public.company_settings for each row execute function public.prevent_organization_id_change();
create trigger quotes_prevent_org_change before update of organization_id on public.quotes for each row execute function public.prevent_organization_id_change();
create trigger invoices_prevent_org_change before update of organization_id on public.invoices for each row execute function public.prevent_organization_id_change();
create trigger attachments_prevent_org_change before update of organization_id on public.attachments for each row execute function public.prevent_organization_id_change();

create trigger projects_org_integrity before insert or update of organization_id, client_id on public.projects for each row execute function public.enforce_projects_org_integrity();
create trigger tasks_org_integrity before insert or update of organization_id, project_id on public.tasks for each row execute function public.enforce_tasks_org_integrity();
create trigger tickets_00_conversion_state before insert or update of status, converted_to_project_id on public.tickets for each row execute function public.normalize_ticket_conversion_state();
create trigger tickets_org_integrity before insert or update of organization_id, client_id, converted_to_project_id on public.tickets for each row execute function public.enforce_tickets_org_integrity();
create trigger notes_org_integrity before insert or update of organization_id, client_id, project_id on public.notes for each row execute function public.enforce_notes_org_integrity();
create trigger quotes_org_integrity before insert or update of organization_id, client_id, project_id on public.quotes for each row execute function public.enforce_quotes_org_integrity();
create trigger invoices_org_integrity before insert or update of organization_id, client_id, project_id, quote_id on public.invoices for each row execute function public.enforce_invoices_org_integrity();
create trigger attachments_org_integrity before insert or update of organization_id, entity_type, entity_id, parent_task_id on public.attachments for each row execute function public.enforce_attachments_org_integrity();


create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity_type text := coalesce(nullif(TG_ARGV[0], ''), TG_TABLE_NAME);
  v_label_column text := coalesce(nullif(TG_ARGV[1], ''), 'name');
  v_old jsonb := case when TG_OP in ('UPDATE','DELETE') then to_jsonb(old) else '{}'::jsonb end;
  v_new jsonb := case when TG_OP in ('INSERT','UPDATE') then to_jsonb(new) else '{}'::jsonb end;
  v_org uuid;
  v_entity_id uuid;
  v_label text;
  v_action text;
  v_changed text[] := array[]::text[];
begin
  if TG_TABLE_NAME = 'organizations' then
    v_org := coalesce(nullif(v_new ->> 'id', '')::uuid, nullif(v_old ->> 'id', '')::uuid);
  else
    v_org := coalesce(nullif(v_new ->> 'organization_id', '')::uuid, nullif(v_old ->> 'organization_id', '')::uuid);
  end if;

  v_entity_id := coalesce(nullif(v_new ->> 'id', '')::uuid, nullif(v_old ->> 'id', '')::uuid);
  v_label := coalesce(
    nullif(v_new ->> v_label_column, ''), nullif(v_old ->> v_label_column, ''),
    nullif(v_new ->> 'title', ''), nullif(v_old ->> 'title', ''),
    nullif(v_new ->> 'number', ''), nullif(v_old ->> 'number', ''),
    nullif(v_new ->> 'email', ''), nullif(v_old ->> 'email', ''),
    v_entity_id::text
  );

  if TG_OP = 'INSERT' then
    v_action := 'created';
  elsif TG_OP = 'DELETE' then
    v_action := 'deleted';
  else
    select coalesce(array_agg(key order by key), array[]::text[])
      into v_changed
    from jsonb_object_keys(v_new || v_old) as changed(key)
    where (v_old -> key) is distinct from (v_new -> key)
      and key not in ('updated_at');

    if coalesce(array_length(v_changed, 1), 0) = 0 then
      return new;
    end if;

    v_action := 'updated';
  end if;

  if TG_TABLE_NAME = 'organization_invitations' then
    v_entity_type := 'invitation';
    if TG_OP = 'INSERT' then
      v_action := 'invited';
    elsif TG_OP = 'UPDATE' and v_old ->> 'status' is distinct from v_new ->> 'status' then
      if v_new ->> 'status' in ('accepted','revoked') then
        v_action := v_new ->> 'status';
      end if;
    end if;
  elsif TG_TABLE_NAME = 'organization_members' then
    v_entity_type := 'member';
    if TG_OP = 'UPDATE' and v_old ->> 'role' is distinct from v_new ->> 'role' then
      v_action := 'role_changed';
    elsif TG_OP = 'UPDATE' and v_new ->> 'status' = 'disabled' and v_old ->> 'status' is distinct from v_new ->> 'status' then
      v_action := 'disabled';
    elsif TG_OP = 'INSERT' and v_new ->> 'role' <> 'owner' then
      v_action := 'accepted';
    end if;
  end if;

  if v_org is not null then
    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (
      v_org,
      auth.uid(),
      v_action,
      v_entity_type,
      v_entity_id,
      v_label,
      jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP, 'changed_columns', to_jsonb(v_changed))
    );
  end if;

  if TG_OP = 'DELETE' then return old; end if;
  return new;
exception when others then
  raise warning 'audit logging failed for %.%: %', TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLERRM;
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger organizations_audit after insert or update or delete on public.organizations for each row execute function public.audit_row_change('organization','name');
create trigger organization_members_audit after insert or update or delete on public.organization_members for each row execute function public.audit_row_change('member','email');
create trigger organization_invitations_audit after insert or update or delete on public.organization_invitations for each row execute function public.audit_row_change('invitation','email');
create trigger organization_license_events_audit after insert or update or delete on public.organization_license_events for each row execute function public.audit_row_change('license_event','reason');
create trigger clients_audit after insert or update or delete on public.clients for each row execute function public.audit_row_change('client','name');
create trigger projects_audit after insert or update or delete on public.projects for each row execute function public.audit_row_change('project','name');
create trigger tasks_audit after insert or update or delete on public.tasks for each row execute function public.audit_row_change('task','title');
create trigger tickets_audit after insert or update or delete on public.tickets for each row execute function public.audit_row_change('ticket','title');
create trigger notes_audit after insert or update or delete on public.notes for each row execute function public.audit_row_change('note','title');
create trigger company_settings_audit after insert or update or delete on public.company_settings for each row execute function public.audit_row_change('company_settings','company_name');
create trigger quotes_audit after insert or update or delete on public.quotes for each row execute function public.audit_row_change('quote','number');
create trigger invoices_audit after insert or update or delete on public.invoices for each row execute function public.audit_row_change('invoice','number');
create trigger attachments_audit after insert or update or delete on public.attachments for each row execute function public.audit_row_change('attachment','name');


create or replace function public.convert_ticket_to_project(p_ticket_id uuid, p_organization_id uuid)
returns public.projects
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_ticket public.tickets;
  v_project public.projects;
begin
  select * into v_ticket
  from public.tickets
  where id = p_ticket_id
    and organization_id = p_organization_id
    and public.can_write_org(p_organization_id)
  for update;

  if not found then raise exception 'Ticket niet gevonden of geen toegang' using errcode = 'P0002'; end if;
  if v_ticket.status = 'converted' or v_ticket.converted_to_project_id is not null then raise exception 'Ticket is al omgezet' using errcode = 'P0001'; end if;
  if v_ticket.status not in ('new','review','approved') then raise exception 'Ticketstatus % kan niet worden omgezet naar een project', v_ticket.status using errcode = 'P0001'; end if;

  insert into public.projects (organization_id, created_by, client_id, name, description, color, archived)
  values (
    v_ticket.organization_id,
    auth.uid(),
    v_ticket.client_id,
    v_ticket.title,
    v_ticket.description,
    case when v_ticket.priority = 'high' then '#f06b6b' else '#FFD966' end,
    false
  ) returning * into v_project;

  update public.tickets
  set status = 'converted', converted_to_project_id = v_project.id, updated_at = now()
  where id = p_ticket_id
    and organization_id = p_organization_id;

  return v_project;
end;
$$;

-- Calendar integrations: per organization, per connected user account.
create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft')),
  provider_account_id text not null,
  provider_account_email text,
  display_name text,
  status text not null default 'active' check (status in ('active','expired','revoked','error')),
  scopes text[] not null default '{}',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id, provider, provider_account_id)
);

create table public.calendar_connection_tokens (
  connection_id uuid primary key references public.calendar_connections(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft')),
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  token_type text,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.calendar_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.calendar_connections(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft')),
  provider_calendar_id text not null,
  name text not null,
  description text,
  color text,
  timezone text,
  is_primary boolean not null default false,
  access_role text,
  sync_enabled boolean not null default true,
  write_enabled boolean not null default false,
  visibility text not null default 'private' check (visibility in ('private','organization')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, provider_calendar_id)
);

create index idx_calendar_connections_org on public.calendar_connections(organization_id, user_id, provider);
create index idx_calendar_connection_tokens_org on public.calendar_connection_tokens(organization_id, user_id, provider);
create index idx_calendar_sources_org on public.calendar_sources(organization_id, sync_enabled);
create index idx_calendar_sources_org_visibility on public.calendar_sources(organization_id, visibility, sync_enabled);
create index idx_calendar_sources_connection on public.calendar_sources(connection_id);

create or replace function public.enforce_calendar_tokens_integrity()
returns trigger language plpgsql as $$
declare v_connection public.calendar_connections;
begin
  select * into v_connection from public.calendar_connections where id = new.connection_id;
  if not found then raise exception 'calendar_connection_tokens.connection_id verwijst naar een niet-bestaande koppeling' using errcode = '23514'; end if;
  if v_connection.organization_id <> new.organization_id then raise exception 'calendar_connection_tokens.organization_id wijkt af van de gekoppelde calendar_connection' using errcode = '23514'; end if;
  if v_connection.user_id <> new.user_id then raise exception 'calendar_connection_tokens.user_id wijkt af van de gekoppelde calendar_connection' using errcode = '23514'; end if;
  if v_connection.provider <> new.provider then raise exception 'calendar_connection_tokens.provider wijkt af van de gekoppelde calendar_connection provider' using errcode = '23514'; end if;
  return new;
end; $$;

create or replace function public.enforce_calendar_sources_integrity()
returns trigger language plpgsql as $$
declare v_connection public.calendar_connections;
begin
  select * into v_connection from public.calendar_connections where id = new.connection_id;
  if not found then raise exception 'calendar_sources.connection_id verwijst naar een niet-bestaande koppeling' using errcode = '23514'; end if;
  if v_connection.organization_id <> new.organization_id then raise exception 'calendar_sources.organization_id wijkt af van de gekoppelde calendar_connection' using errcode = '23514'; end if;
  if v_connection.user_id <> new.user_id then raise exception 'calendar_sources.user_id wijkt af van de gekoppelde calendar_connection' using errcode = '23514'; end if;
  if v_connection.provider <> new.provider then raise exception 'calendar_sources.provider wijkt af van de gekoppelde calendar_connection provider' using errcode = '23514'; end if;
  return new;
end; $$;

create trigger calendar_connections_updated before update on public.calendar_connections for each row execute function public.set_updated_at();
create trigger calendar_connection_tokens_updated before update on public.calendar_connection_tokens for each row execute function public.set_updated_at();
create trigger calendar_sources_updated before update on public.calendar_sources for each row execute function public.set_updated_at();

create trigger calendar_connections_prevent_org_change before update of organization_id on public.calendar_connections for each row execute function public.prevent_organization_id_change();
create trigger calendar_connection_tokens_prevent_org_change before update of organization_id on public.calendar_connection_tokens for each row execute function public.prevent_organization_id_change();
create trigger calendar_sources_prevent_org_change before update of organization_id on public.calendar_sources for each row execute function public.prevent_organization_id_change();

create trigger calendar_connection_tokens_integrity before insert or update of connection_id, organization_id, user_id, provider on public.calendar_connection_tokens for each row execute function public.enforce_calendar_tokens_integrity();
create trigger calendar_sources_integrity before insert or update of connection_id, organization_id, user_id, provider on public.calendar_sources for each row execute function public.enforce_calendar_sources_integrity();

create trigger calendar_connections_audit after insert or update or delete on public.calendar_connections for each row execute function public.audit_row_change('calendar_connection','provider_account_email');
create trigger calendar_sources_audit after insert or update or delete on public.calendar_sources for each row execute function public.audit_row_change('calendar_source','name');

-- Row Level Security
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.organization_invitations enable row level security;
alter table public.audit_logs enable row level security;
alter table public.organization_license_events enable row level security;
alter table public.clients enable row level security;
alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.tickets enable row level security;
alter table public.notes enable row level security;
alter table public.company_settings enable row level security;
alter table public.quotes enable row level security;
alter table public.invoices enable row level security;
alter table public.attachments enable row level security;
alter table public.calendar_connections enable row level security;
alter table public.calendar_connection_tokens enable row level security;
alter table public.calendar_sources enable row level security;

create policy "organizations read by members" on public.organizations for select using (public.can_read_org(id));
create policy "organizations update by admins" on public.organizations for update using (public.can_admin_org(id)) with check (public.can_admin_org(id));

create policy "members read by org members" on public.organization_members for select using (public.can_read_org(organization_id));
create policy "members update by owners" on public.organization_members for update using (public.can_owner_org(organization_id)) with check (public.can_owner_org(organization_id));

create policy "invitations read by invitee or admins" on public.organization_invitations for select using (email = public.current_user_email() or public.can_admin_org(organization_id));
create policy "invitations insert by admins" on public.organization_invitations for insert with check (public.can_admin_org(organization_id) and invited_by = auth.uid());
create policy "invitations update by admins" on public.organization_invitations for update using (public.can_admin_org(organization_id)) with check (public.can_admin_org(organization_id));

create policy "audit logs read by org members" on public.audit_logs for select using (public.can_read_org(organization_id));
create policy "license events read by org admins" on public.organization_license_events for select using (public.can_admin_org(organization_id));

create policy "clients read" on public.clients for select using (public.can_read_org(organization_id));
create policy "clients insert" on public.clients for insert with check (public.can_write_org(organization_id));
create policy "clients update" on public.clients for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
create policy "clients delete" on public.clients for delete using (public.can_write_org(organization_id));

create policy "projects read" on public.projects for select using (public.can_read_org(organization_id));
create policy "projects insert" on public.projects for insert with check (public.can_write_org(organization_id));
create policy "projects update" on public.projects for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
create policy "projects delete" on public.projects for delete using (public.can_write_org(organization_id));

create policy "tasks read" on public.tasks for select using (public.can_read_org(organization_id));
create policy "tasks insert" on public.tasks for insert with check (public.can_write_org(organization_id));
create policy "tasks update" on public.tasks for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
create policy "tasks delete" on public.tasks for delete using (public.can_write_org(organization_id));

create policy "tickets read" on public.tickets for select using (public.can_read_org(organization_id));
create policy "tickets insert" on public.tickets for insert with check (public.can_write_org(organization_id));
create policy "tickets update" on public.tickets for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
create policy "tickets delete" on public.tickets for delete using (public.can_write_org(organization_id));

create policy "notes read" on public.notes for select using (public.can_read_org(organization_id));
create policy "notes insert" on public.notes for insert with check (public.can_write_org(organization_id));
create policy "notes update" on public.notes for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
create policy "notes delete" on public.notes for delete using (public.can_write_org(organization_id));

create policy "company settings read" on public.company_settings for select using (public.can_read_org(organization_id));
create policy "company settings insert" on public.company_settings for insert with check (public.can_admin_org(organization_id));
create policy "company settings update" on public.company_settings for update using (public.can_admin_org(organization_id)) with check (public.can_admin_org(organization_id));
create policy "company settings delete" on public.company_settings for delete using (public.can_admin_org(organization_id));

create policy "quotes read" on public.quotes for select using (public.can_read_org(organization_id));
create policy "quotes insert" on public.quotes for insert with check (public.can_write_org(organization_id));
create policy "quotes update" on public.quotes for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
create policy "quotes delete" on public.quotes for delete using (public.can_write_org(organization_id));

create policy "invoices read" on public.invoices for select using (public.can_read_org(organization_id));
create policy "invoices insert" on public.invoices for insert with check (public.can_write_org(organization_id));
create policy "invoices update" on public.invoices for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
create policy "invoices delete" on public.invoices for delete using (public.can_write_org(organization_id));

create policy "attachments read" on public.attachments for select using (public.can_read_org(organization_id));
create policy "attachments insert" on public.attachments for insert with check (public.can_write_org(organization_id));
create policy "attachments update" on public.attachments for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
create policy "attachments delete" on public.attachments for delete using (public.can_write_org(organization_id));

create policy "calendar connections read own or shared" on public.calendar_connections for select using (
  user_id = auth.uid()
  or (public.can_read_org(organization_id) and exists (
    select 1 from public.calendar_sources source
    where source.connection_id = calendar_connections.id
      and source.visibility = 'organization'
  ))
);
create policy "calendar connections insert own" on public.calendar_connections for insert with check (public.can_write_org(organization_id) and user_id = auth.uid());
create policy "calendar connections update own" on public.calendar_connections for update using (public.can_write_org(organization_id) and user_id = auth.uid()) with check (public.can_write_org(organization_id) and user_id = auth.uid());
create policy "calendar connections delete own" on public.calendar_connections for delete using (public.can_write_org(organization_id) and user_id = auth.uid());
create policy "calendar sources read own or shared" on public.calendar_sources for select using (user_id = auth.uid() or (visibility = 'organization' and public.can_read_org(organization_id)));
create policy "calendar sources insert own" on public.calendar_sources for insert with check (public.can_write_org(organization_id) and user_id = auth.uid());
create policy "calendar sources update own" on public.calendar_sources for update using (public.can_write_org(organization_id) and user_id = auth.uid()) with check (public.can_write_org(organization_id) and user_id = auth.uid());
create policy "calendar sources delete own" on public.calendar_sources for delete using (public.can_write_org(organization_id) and user_id = auth.uid());
-- Deliberately no policies on calendar_connection_tokens. Tokens are only accessible via Edge Functions with service role.

revoke all on function public.create_organization(text) from public;
revoke all on function public.ensure_user_default_organization() from public;
revoke all on function public.invite_organization_member(uuid, citext, text) from public;
revoke all on function public.accept_organization_invitation(uuid) from public;
revoke all on function public.organization_reserved_license_count(uuid, uuid, uuid) from public;
revoke all on function public.organization_license_usage(uuid) from public;
revoke all on function public.apply_organization_license_purchase(uuid, integer, text, text, jsonb) from public;
revoke all on function public.convert_ticket_to_project(uuid, uuid) from public;
grant execute on function public.create_organization(text) to authenticated;
grant execute on function public.ensure_user_default_organization() to authenticated;
grant execute on function public.invite_organization_member(uuid, citext, text) to authenticated;
grant execute on function public.accept_organization_invitation(uuid) to authenticated;
grant execute on function public.organization_license_usage(uuid) to authenticated;
grant execute on function public.apply_organization_license_purchase(uuid, integer, text, text, jsonb) to service_role;
grant execute on function public.convert_ticket_to_project(uuid, uuid) to authenticated;

-- ============================================================
-- Sprint 2 billing / Mollie / license management extension
-- This section is appended so fresh installs end in the same state as applying
-- supabase/migrations/20260430_sprint2_billing_mollie_licensing.sql.
-- ============================================================
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
    v_old_plan_key := v_profile.plan_key;

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

-- ============================================================
-- Final Sprint 2 Mollie Connect hardening: checkout recovery/audit-noise guard
-- ============================================================
create index if not exists idx_org_payment_records_reusable_open_checkout
  on public.organization_payment_records(organization_id, payment_type, plan_key, license_delta, amount_cents, currency, status, created_at desc)
  where status in ('open','pending')
    and provider_payment_id is not null
    and provider_checkout_url is not null;

create index if not exists idx_org_payment_records_recoverable_incomplete_checkout
  on public.organization_payment_records(organization_id, payment_type, license_delta, plan_key, amount_cents, currency, created_at desc)
  where status in ('open','pending')
    and provider_payment_id is null
    and provider_checkout_url is null;

drop trigger if exists organization_billing_events_audit on public.organization_billing_events;
comment on table public.organization_billing_events is 'Internal billing/webhook idempotency ledger. Duplicate receive_count updates are intentionally not mirrored into audit_logs.';
-- ============================================================
-- BrandCore — Sprint 2.5 billing/Mollie hardening
-- Date: 2026-04-30
--
-- Purpose:
-- - Close the last checkout race window before Sprint 3 customer portal work.
-- - Keep incomplete local checkout recovery idempotent under parallel retries.
-- - Preserve existing Sprint 1/Sprint 2 behaviour; no Sprint 3 features added.
-- ============================================================

-- Stale duplicate incomplete records have no provider_payment_id and no checkout URL,
-- so they were never handed to Mollie. Cancel older duplicates before adding the guard.
with ranked_incomplete_checkouts as (
  select
    id,
    row_number() over (
      partition by organization_id, payment_type, coalesce(plan_key, ''), license_delta, amount_cents, currency
      order by created_at desc, id desc
    ) as duplicate_rank
  from public.organization_payment_records
  where status in ('open', 'pending')
    and provider_payment_id is null
    and provider_checkout_url is null
)
update public.organization_payment_records p
set status = 'canceled',
    canceled_at = coalesce(p.canceled_at, now()),
    updated_at = now(),
    metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object('sprint25_cancel_reason', 'duplicate_incomplete_checkout_before_unique_guard')
from ranked_incomplete_checkouts r
where p.id = r.id
  and r.duplicate_rank > 1;

create unique index if not exists idx_org_payment_records_one_incomplete_checkout
  on public.organization_payment_records(
    organization_id,
    payment_type,
    coalesce(plan_key, ''),
    license_delta,
    amount_cents,
    currency
  )
  where status in ('open', 'pending')
    and provider_payment_id is null
    and provider_checkout_url is null;

comment on index public.idx_org_payment_records_one_incomplete_checkout is
  'Sprint 2.5: prevents parallel retries from creating multiple incomplete local checkout records for the same organization/payment shape.';


-- Note/calendar links, added 2026-05-12.
-- Link internal rich-text notes to external Google/Microsoft calendar events.
-- Events remain external; ResoFly stores only a stable reference + safe snapshots.

create table if not exists public.note_calendar_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  note_id uuid not null references public.notes(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft')),
  calendar_source_id uuid not null references public.calendar_sources(id) on delete cascade,
  provider_calendar_id text,
  provider_event_id text not null,
  event_starts_at timestamptz not null,
  event_ends_at timestamptz,
  event_title_snapshot text,
  event_location_snapshot text,
  event_html_link text,
  visibility_snapshot text not null default 'organization' check (visibility_snapshot in ('private','organization')),
  is_private_masked_snapshot boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, note_id, provider, calendar_source_id, provider_event_id, event_starts_at)
);

create index if not exists idx_note_calendar_links_event
  on public.note_calendar_links(organization_id, provider, calendar_source_id, provider_event_id, event_starts_at desc);

create index if not exists idx_note_calendar_links_note
  on public.note_calendar_links(organization_id, note_id, created_at desc);

create or replace function public.enforce_note_calendar_links_integrity()
returns trigger language plpgsql as $$
declare
  v_note public.notes;
  v_source public.calendar_sources;
begin
  if new.visibility_snapshot <> 'organization' then
    raise exception 'Notities koppelen aan privé-agenda-items is geblokkeerd' using errcode = '23514';
  end if;

  if coalesce(new.is_private_masked_snapshot, false) then
    raise exception 'Notities koppelen aan afgeschermde agenda-items is geblokkeerd' using errcode = '23514';
  end if;

  select * into v_note from public.notes where id = new.note_id;
  if not found then
    raise exception 'note_calendar_links.note_id verwijst naar een niet-bestaande notitie' using errcode = '23514';
  end if;
  if v_note.organization_id <> new.organization_id then
    raise exception 'note_calendar_links.organization_id wijkt af van de gekoppelde notitie' using errcode = '23514';
  end if;

  select * into v_source from public.calendar_sources where id = new.calendar_source_id;
  if not found then
    raise exception 'note_calendar_links.calendar_source_id verwijst naar een niet-bestaande agenda' using errcode = '23514';
  end if;
  if v_source.organization_id <> new.organization_id then
    raise exception 'note_calendar_links.organization_id wijkt af van de gekoppelde agenda' using errcode = '23514';
  end if;
  if v_source.provider <> new.provider then
    raise exception 'note_calendar_links.provider wijkt af van de gekoppelde agenda-provider' using errcode = '23514';
  end if;
  if v_source.visibility <> 'organization' then
    raise exception 'Notities koppelen is alleen toegestaan voor agenda’s die met de organisatie gedeeld zijn' using errcode = '23514';
  end if;

  new.provider_calendar_id := coalesce(new.provider_calendar_id, v_source.provider_calendar_id);
  return new;
end;
$$;

drop trigger if exists note_calendar_links_prevent_org_change on public.note_calendar_links;
create trigger note_calendar_links_prevent_org_change
  before update of organization_id on public.note_calendar_links
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists note_calendar_links_integrity on public.note_calendar_links;
create trigger note_calendar_links_integrity
  before insert or update of note_id, organization_id, provider, calendar_source_id, visibility_snapshot, is_private_masked_snapshot
  on public.note_calendar_links
  for each row execute function public.enforce_note_calendar_links_integrity();

drop trigger if exists note_calendar_links_audit on public.note_calendar_links;
create trigger note_calendar_links_audit
  after insert or update or delete on public.note_calendar_links
  for each row execute function public.audit_row_change('note_calendar_link','event_title_snapshot');

alter table public.note_calendar_links enable row level security;

drop policy if exists "note calendar links read" on public.note_calendar_links;
create policy "note calendar links read" on public.note_calendar_links for select using (
  public.can_read_org(organization_id)
  and visibility_snapshot = 'organization'
  and is_private_masked_snapshot = false
  and exists (
    select 1 from public.notes note
    where note.id = note_calendar_links.note_id
      and note.organization_id = note_calendar_links.organization_id
  )
  and exists (
    select 1 from public.calendar_sources source
    where source.id = note_calendar_links.calendar_source_id
      and source.organization_id = note_calendar_links.organization_id
      and source.visibility = 'organization'
  )
);

drop policy if exists "note calendar links insert" on public.note_calendar_links;
create policy "note calendar links insert" on public.note_calendar_links for insert with check (
  public.can_write_org(organization_id)
  and created_by = auth.uid()
  and visibility_snapshot = 'organization'
  and is_private_masked_snapshot = false
  and exists (
    select 1 from public.notes note
    where note.id = note_calendar_links.note_id
      and note.organization_id = note_calendar_links.organization_id
  )
  and exists (
    select 1 from public.calendar_sources source
    where source.id = note_calendar_links.calendar_source_id
      and source.organization_id = note_calendar_links.organization_id
      and source.visibility = 'organization'
  )
);

drop policy if exists "note calendar links update" on public.note_calendar_links;
create policy "note calendar links update" on public.note_calendar_links for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
  and visibility_snapshot = 'organization'
  and is_private_masked_snapshot = false
  and exists (
    select 1 from public.notes note
    where note.id = note_calendar_links.note_id
      and note.organization_id = note_calendar_links.organization_id
  )
  and exists (
    select 1 from public.calendar_sources source
    where source.id = note_calendar_links.calendar_source_id
      and source.organization_id = note_calendar_links.organization_id
      and source.visibility = 'organization'
  )
);

drop policy if exists "note calendar links delete" on public.note_calendar_links;
create policy "note calendar links delete" on public.note_calendar_links for delete using (
  public.can_write_org(organization_id)
);

-- Transactional creation of a rich-text note plus its calendar-event link.
-- This prevents orphan notes when creating a note from a calendar event and the link insert fails.
create or replace function public.create_note_with_calendar_link(
  p_organization_id uuid,
  p_client_id uuid,
  p_project_id uuid,
  p_title text,
  p_content text,
  p_note_type text,
  p_tags text[],
  p_provider text,
  p_calendar_source_id uuid,
  p_provider_calendar_id text,
  p_provider_event_id text,
  p_event_starts_at timestamptz,
  p_event_ends_at timestamptz,
  p_event_title_snapshot text,
  p_event_location_snapshot text,
  p_event_html_link text,
  p_visibility_snapshot text,
  p_is_private_masked_snapshot boolean
)
returns public.notes
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_note public.notes;
  v_clean_title text := nullif(trim(coalesce(p_title, '')), '');
  v_note_type text := coalesce(nullif(trim(p_note_type), ''), 'general');
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '28000';
  end if;

  if not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if p_visibility_snapshot <> 'organization' or coalesce(p_is_private_masked_snapshot, false) then
    raise exception 'Notities koppelen is alleen toegestaan bij gedeelde agenda-items waarvan de details zichtbaar zijn.' using errcode = '23514';
  end if;

  if v_note_type not in ('general','meeting','action','decision','idea','support') then
    raise exception 'Ongeldig notitietype: %', v_note_type using errcode = '23514';
  end if;

  insert into public.notes (
    organization_id,
    created_by,
    client_id,
    project_id,
    title,
    content,
    note_type,
    tags
  ) values (
    p_organization_id,
    v_user_id,
    p_client_id,
    p_project_id,
    coalesce(v_clean_title, 'Notitie ' || to_char(now(), 'DD-MM-YYYY')),
    coalesce(p_content, ''),
    v_note_type,
    coalesce(p_tags, '{}'::text[])
  ) returning * into v_note;

  insert into public.note_calendar_links (
    organization_id,
    created_by,
    note_id,
    provider,
    calendar_source_id,
    provider_calendar_id,
    provider_event_id,
    event_starts_at,
    event_ends_at,
    event_title_snapshot,
    event_location_snapshot,
    event_html_link,
    visibility_snapshot,
    is_private_masked_snapshot
  ) values (
    p_organization_id,
    v_user_id,
    v_note.id,
    p_provider,
    p_calendar_source_id,
    p_provider_calendar_id,
    p_provider_event_id,
    p_event_starts_at,
    p_event_ends_at,
    p_event_title_snapshot,
    p_event_location_snapshot,
    p_event_html_link,
    p_visibility_snapshot,
    coalesce(p_is_private_masked_snapshot, false)
  );

  return v_note;
end;
$$;

revoke all on function public.create_note_with_calendar_link(
  uuid, uuid, uuid, text, text, text, text[], text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, boolean
) from public;
grant execute on function public.create_note_with_calendar_link(
  uuid, uuid, uuid, text, text, text, text[], text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, boolean
) to authenticated;

-- ============================================================
-- Included post-schema migration: Quote approval + Resend flow
-- Source: supabase/migrations/20260515_quote_approval_resend_flow.sql
-- ============================================================
-- ============================================================
-- BrandCore / ResoFly — Quote approval + Resend delivery flow
-- Date: 2026-05-15
--
-- Scope:
-- - Project-linked quote workflow
-- - Internal approval state machine
-- - Public quote approval tokens
-- - Resend delivery tracking
-- - Quote timeline events
-- - Audit-log entries for critical quote actions
-- ============================================================

create extension if not exists pgcrypto;

begin;

-- Existing quotes get extra workflow states. Invoices keep using the legacy subset.
alter table public.quotes drop constraint if exists quotes_status_check;
alter table public.quotes
  add constraint quotes_status_check
  check (status in (
    'draft',
    'pending_internal_approval',
    'internally_approved',
    'sent',
    'accepted',
    'rejected',
    'expired',
    'paid',
    'overdue',
    'cancelled'
  ));

alter table public.quotes
  add column if not exists internal_approval_status text not null default 'draft',
  add column if not exists internal_approval_requested_at timestamptz,
  add column if not exists internal_approval_requested_by uuid references auth.users(id) on delete set null,
  add column if not exists internal_approved_at timestamptz,
  add column if not exists internal_approved_by uuid references auth.users(id) on delete set null,
  add column if not exists internal_rejected_at timestamptz,
  add column if not exists internal_rejected_by uuid references auth.users(id) on delete set null,
  add column if not exists internal_rejection_note text,
  add column if not exists client_decision_at timestamptz,
  add column if not exists client_decision_by_name text,
  add column if not exists client_decision_by_email text,
  add column if not exists client_decision_note text,
  add column if not exists public_token_hash text,
  add column if not exists public_token_created_at timestamptz,
  add column if not exists public_token_expires_at timestamptz,
  add column if not exists resend_last_email_id text,
  add column if not exists last_email_delivery_status text,
  add column if not exists last_email_delivery_at timestamptz,
  add column if not exists last_email_opened_at timestamptz,
  add column if not exists last_email_clicked_at timestamptz,
  add column if not exists last_email_failed_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quotes'::regclass
      and conname = 'quotes_internal_approval_status_check'
  ) then
    alter table public.quotes
      add constraint quotes_internal_approval_status_check
      check (internal_approval_status in ('draft','pending','approved','rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quotes'::regclass
      and conname = 'quotes_public_token_hash_unique'
  ) then
    alter table public.quotes
      add constraint quotes_public_token_hash_unique unique (public_token_hash);
  end if;
end $$;

create table if not exists public.quote_approval_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  quote_id uuid not null references public.quotes(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in (
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
    'expired',
    'cancelled'
  )),
  title text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.quote_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  quote_id uuid not null references public.quotes(id) on delete cascade,
  provider text not null default 'resend',
  provider_email_id text,
  recipient_email text not null,
  recipient_name text,
  subject text not null,
  status text not null default 'queued' check (status in ('queued','sent','delivered','opened','clicked','bounced','failed','complained')),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  bounced_at timestamptz,
  failed_at timestamptz,
  complained_at timestamptz,
  last_event_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.quote_email_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  quote_id uuid references public.quotes(id) on delete set null,
  delivery_id uuid references public.quote_email_deliveries(id) on delete set null,
  provider text not null default 'resend',
  provider_event_id text not null,
  provider_email_id text,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create index if not exists idx_quotes_workflow_org_status on public.quotes(organization_id, status, internal_approval_status, created_at desc);
create index if not exists idx_quotes_public_token_hash on public.quotes(public_token_hash) where public_token_hash is not null;
create index if not exists idx_quote_approval_events_quote on public.quote_approval_events(organization_id, quote_id, created_at desc);
create index if not exists idx_quote_email_deliveries_quote on public.quote_email_deliveries(organization_id, quote_id, created_at desc);
create index if not exists idx_quote_email_deliveries_provider_email on public.quote_email_deliveries(provider, provider_email_id) where provider_email_id is not null;
create index if not exists idx_quote_email_events_provider_email on public.quote_email_events(provider, provider_email_id, occurred_at desc);

alter table public.quote_approval_events enable row level security;
alter table public.quote_email_deliveries enable row level security;
alter table public.quote_email_events enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_approval_events' and policyname = 'quote approval events read') then
    create policy "quote approval events read" on public.quote_approval_events for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_approval_events' and policyname = 'quote approval events insert') then
    create policy "quote approval events insert" on public.quote_approval_events for insert with check (public.can_write_org(organization_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_email_deliveries' and policyname = 'quote email deliveries read') then
    create policy "quote email deliveries read" on public.quote_email_deliveries for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_email_deliveries' and policyname = 'quote email deliveries insert') then
    create policy "quote email deliveries insert" on public.quote_email_deliveries for insert with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_email_deliveries' and policyname = 'quote email deliveries update') then
    create policy "quote email deliveries update" on public.quote_email_deliveries for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_email_events' and policyname = 'quote email events read') then
    create policy "quote email events read" on public.quote_email_events for select using (public.can_read_org(organization_id));
  end if;
end $$;

-- Extend explicit audit event vocabulary. Existing row-change triggers keep working.
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
      'quote_email_delivered','quote_email_failed'
    ));
end $$;

create or replace function public.quote_token_hash(p_token text)
returns text
language sql
immutable
as $$
  select encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
$$;

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
  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, p_actor_user_id, p_action, 'quote', p_quote_id, p_entity_label, coalesce(p_metadata, '{}'::jsonb));
exception when others then
  raise warning 'quote audit event failed for quote % action %: %', p_quote_id, p_action, SQLERRM;
end;
$$;

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
  if v_quote.status in ('sent','accepted','rejected','expired','cancelled') then
    raise exception 'Deze offerte kan niet meer intern worden ingediend vanuit status %', v_quote.status using errcode = '23514';
  end if;
  if jsonb_array_length(coalesce(v_quote.lines, '[]'::jsonb)) = 0 then
    raise exception 'Een offerte zonder regels kan niet ter goedkeuring worden ingediend' using errcode = '23514';
  end if;

  update public.quotes
  set status = 'pending_internal_approval',
      internal_approval_status = 'pending',
      internal_approval_requested_at = now(),
      internal_approval_requested_by = v_user_id,
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
  if v_quote.status not in ('pending_internal_approval','internally_approved','draft') then
    raise exception 'Deze offerte kan niet intern worden goedgekeurd vanuit status %', v_quote.status using errcode = '23514';
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
  if v_quote.status in ('sent','accepted','rejected','expired','cancelled') then
    raise exception 'Deze offerte kan niet intern worden afgewezen vanuit status %', v_quote.status using errcode = '23514';
  end if;

  update public.quotes
  set status = 'draft',
      internal_approval_status = 'rejected',
      internal_rejected_at = now(),
      internal_rejected_by = v_user_id,
      internal_rejection_note = nullif(trim(coalesce(p_note, '')), ''),
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
  select * into v_quote
  from public.quotes
  where public_token_hash = p_token_hash
    and public_token_expires_at is not null
    and public_token_expires_at > now()
  for update;

  if not found then raise exception 'Offertelink is ongeldig of verlopen' using errcode = '28000'; end if;
  if v_quote.status <> 'sent' then raise exception 'Deze offerte kan niet meer worden geaccepteerd' using errcode = '23514'; end if;

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
  select * into v_quote
  from public.quotes
  where public_token_hash = p_token_hash
    and public_token_expires_at is not null
    and public_token_expires_at > now()
  for update;

  if not found then raise exception 'Offertelink is ongeldig of verlopen' using errcode = '28000'; end if;
  if v_quote.status <> 'sent' then raise exception 'Deze offerte kan niet meer worden geweigerd' using errcode = '23514'; end if;

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


create or replace function public.enforce_quote_status_transition()
returns trigger
language plpgsql
as $$
begin
  if TG_OP <> 'UPDATE' then return new; end if;
  if old.status is not distinct from new.status then return new; end if;

  if old.status = 'draft' and new.status in ('pending_internal_approval','cancelled') then return new; end if;
  if old.status = 'pending_internal_approval' and new.status in ('internally_approved','draft','cancelled') then return new; end if;
  if old.status = 'internally_approved' and new.status in ('sent','draft','cancelled') then return new; end if;
  if old.status = 'sent' and new.status in ('accepted','rejected','expired','cancelled') then return new; end if;
  if old.status in ('accepted','rejected','expired','cancelled') and new.status = old.status then return new; end if;

  raise exception 'Ongeldige offerte-statusovergang van % naar %. Gebruik de offerte-workflow acties.', old.status, new.status using errcode = '23514';
end;
$$;

drop trigger if exists quotes_status_transition_guard on public.quotes;
create trigger quotes_status_transition_guard
  before update of status on public.quotes
  for each row execute function public.enforce_quote_status_transition();

grant execute on function public.submit_quote_for_internal_approval(uuid, uuid) to authenticated;
grant execute on function public.approve_quote_internal(uuid, uuid) to authenticated;
grant execute on function public.reject_quote_internal(uuid, uuid, text) to authenticated;
grant execute on function public.accept_quote_public(text, text, text, text) to service_role;
grant execute on function public.reject_quote_public(text, text, text, text) to service_role;
grant execute on function public.insert_quote_workflow_event(uuid, uuid, text, text, text, jsonb, uuid) to authenticated, service_role;
grant execute on function public.insert_quote_audit_event(uuid, uuid, text, text, jsonb, uuid) to authenticated, service_role;

commit;
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

-- ============================================================
-- Source: supabase/migrations/20260515_quote_approval_resend_flow_final_recheck.sql
-- ============================================================
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



-- ============================================================
-- Included latest migration: 20260517_quote_versions_pdf_attachments.sql
-- ============================================================

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

-- ============================================================
-- BrandCore / ResoFly — Quote versions + PDF attachment review hardening
-- Date: 2026-05-18
-- Scope:
-- - Do not write PDF metadata for non-PDF snapshots
-- - Require real PDF metadata/hash for sent quote snapshots
-- - Return quote rows after snapshot pointers are updated
-- - Add consistency checks for immutable quote version items
-- ============================================================

begin;

-- Guardrails around generated PDF metadata.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quote_versions'::regclass
      and conname = 'quote_versions_pdf_size_positive_check'
  ) then
    alter table public.quote_versions
      add constraint quote_versions_pdf_size_positive_check
      check (pdf_size_bytes is null or pdf_size_bytes > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quote_versions'::regclass
      and conname = 'quote_versions_pdf_sha256_check'
  ) then
    alter table public.quote_versions
      add constraint quote_versions_pdf_sha256_check
      check (pdf_sha256 is null or pdf_sha256 ~ '^[0-9a-f]{64}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quote_email_deliveries'::regclass
      and conname = 'quote_email_deliveries_attachment_size_positive_check'
  ) then
    alter table public.quote_email_deliveries
      add constraint quote_email_deliveries_attachment_size_positive_check
      check (attachment_size_bytes is null or attachment_size_bytes > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quote_email_deliveries'::regclass
      and conname = 'quote_email_deliveries_attachment_sha256_check'
  ) then
    alter table public.quote_email_deliveries
      add constraint quote_email_deliveries_attachment_sha256_check
      check (attachment_sha256 is null or attachment_sha256 ~ '^[0-9a-f]{64}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quote_versions'::regclass
      and conname = 'quote_versions_identity_scope_unique'
  ) then
    alter table public.quote_versions
      add constraint quote_versions_identity_scope_unique unique (id, organization_id, quote_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quote_version_items'::regclass
      and conname = 'quote_version_items_version_scope_fk'
  ) then
    alter table public.quote_version_items
      add constraint quote_version_items_version_scope_fk
      foreign key (quote_version_id, organization_id, quote_id)
      references public.quote_versions(id, organization_id, quote_id)
      on delete cascade;
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
    v_pdf_url,
    v_pdf_file_name,
    v_pdf_mime_type,
    case when v_has_pdf then p_pdf_size_bytes else null end,
    v_pdf_sha256,
    jsonb_build_object(
      'quote', to_jsonb(v_quote) - 'public_token_hash',
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
    jsonb_build_object('versionId', v_version.id, 'versionNumber', v_version.version_number, 'reason', p_snapshot_reason, 'pdfSha256', v_pdf_sha256),
    p_actor_user_id
  );

  if v_has_pdf and v_pdf_sha256 is not null then
    perform public.insert_quote_workflow_event(
      p_organization_id,
      p_quote_id,
      'quote_pdf_attached',
      'PDF-bijlage vastgelegd',
      coalesce(v_pdf_file_name, 'Offerte PDF') || ' is als verzonden PDF-snapshot geregistreerd.',
      jsonb_build_object('versionId', v_version.id, 'fileName', v_pdf_file_name, 'sizeBytes', p_pdf_size_bytes, 'sha256', v_pdf_sha256),
      p_actor_user_id
    );
    perform public.insert_quote_audit_event(
      p_organization_id,
      p_quote_id,
      'quote_pdf_attached',
      v_quote.number,
      jsonb_build_object('versionId', v_version.id, 'fileName', v_pdf_file_name, 'sizeBytes', p_pdf_size_bytes, 'sha256', v_pdf_sha256),
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
    raise exception 'Deze offerte kan alleen vanuit de status ter interne goedkeuring worden goedgekeurd' using errcode = '23514';
  end if;
  if jsonb_typeof(coalesce(v_quote.lines, '[]'::jsonb)) <> 'array' then
    raise exception 'Offerte-regels hebben een ongeldig formaat' using errcode = '23514';
  end if;
  if jsonb_array_length(coalesce(v_quote.lines, '[]'::jsonb)) = 0 then
    raise exception 'Een offerte zonder regels kan niet intern worden goedgekeurd' using errcode = '23514';
  end if;
  if v_quote.valid_until is not null and v_quote.valid_until < current_date then
    raise exception 'Deze offerte is verlopen en kan niet intern worden goedgekeurd' using errcode = '23514';
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

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id;

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
  v_attachment_file_name text := nullif(trim(coalesce(p_attachment_file_name, '')), '');
  v_attachment_mime_type text := coalesce(nullif(trim(coalesce(p_attachment_mime_type, '')), ''), 'application/pdf');
  v_attachment_sha256 text := lower(nullif(trim(coalesce(p_attachment_sha256, '')), ''));
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de server mag een offerte-e-mail voorbereiden' using errcode = '42501';
  end if;

  if lower(trim(coalesce(p_recipient_email, ''))) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Geldig klant-e-mailadres is verplicht' using errcode = '23514';
  end if;

  if v_attachment_file_name is null or p_attachment_size_bytes is null or p_attachment_size_bytes <= 0 or v_attachment_sha256 is null then
    raise exception 'Een offerte-e-mail vereist een servergegenereerde PDF-bijlage met bestandsnaam, grootte en SHA-256 hash' using errcode = '23514';
  end if;

  if v_attachment_mime_type <> 'application/pdf' then
    raise exception 'Alleen application/pdf is toegestaan als offertebijlage' using errcode = '23514';
  end if;

  if v_attachment_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'PDF SHA-256 hash is ongeldig' using errcode = '23514';
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
      last_pdf_file_name = v_attachment_file_name,
      last_pdf_mime_type = v_attachment_mime_type,
      last_pdf_size_bytes = p_attachment_size_bytes,
      last_pdf_sha256 = v_attachment_sha256,
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
    v_attachment_file_name,
    v_attachment_mime_type,
    p_attachment_size_bytes,
    v_attachment_sha256,
    jsonb_build_object(
      'publicUrl', p_public_url,
      'expiresAt', p_token_expires_at,
      'attachment', jsonb_build_object(
        'fileName', v_attachment_file_name,
        'mimeType', v_attachment_mime_type,
        'sizeBytes', p_attachment_size_bytes,
        'sha256', v_attachment_sha256
      )
    )
  ) returning * into v_delivery;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'public_token_created', 'Publieke offertelink aangemaakt', 'Link voorbereid voor verzending via Resend.', jsonb_build_object('expiresAt', p_token_expires_at, 'deliveryId', v_delivery.id), p_actor_user_id);

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

  select * into v_delivery
  from public.quote_email_deliveries
  where id = p_delivery_id and organization_id = p_organization_id;

  select * into v_quote
  from public.quotes
  where id = v_delivery.quote_id and organization_id = p_organization_id;

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

  select * into v_quote
  from public.quotes
  where id = v_quote.id and organization_id = v_quote.organization_id;

  return v_quote;
end;
$$;

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



-- Included latest migration: 20260519_quote_versions_audit_context_hardening.sql
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


-- ============================================================
-- Server-side klantnummer-generator per organisatie
-- Source: supabase/migrations/20260520_client_number_rpc_generator.sql
-- ============================================================
-- ResoFly / BrandCore
-- Server-side klantnummer-generator per organisatie.
-- Doel: klantnummers worden atomair in Postgres/RPC toegekend, zodat twee gelijktijdige gebruikers nooit hetzelfde nummer krijgen.

create table if not exists public.organization_client_number_sequences (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  prefix text not null default 'KL',
  padding integer not null default 3 check (padding between 1 and 12),
  next_number integer not null default 1 check (next_number > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_org_client_number_sequences_next
  on public.organization_client_number_sequences(organization_id, next_number);

alter table public.organization_client_number_sequences enable row level security;

drop policy if exists "client number sequences read by org admins" on public.organization_client_number_sequences;
create policy "client number sequences read by org admins"
  on public.organization_client_number_sequences
  for select
  using (public.can_admin_org(organization_id));

create or replace function public.extract_client_sequence_number(p_client_code text, p_prefix text default 'KL')
returns integer
language plpgsql
immutable
as $$
declare
  v_value text := upper(btrim(coalesce(p_client_code, '')));
  v_prefix text := upper(btrim(coalesce(p_prefix, 'KL')));
  v_match text[];
begin
  v_match := regexp_match(v_value, '^' || regexp_replace(v_prefix, '([^A-Z0-9])', '\\\1', 'g') || '-([0-9]+)$');
  if v_match is null then
    return null;
  end if;

  return v_match[1]::integer;
exception when others then
  return null;
end;
$$;

create or replace function public.reconcile_client_number_sequence(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_number integer;
begin
  if p_organization_id is null then
    raise exception 'Organisatie ontbreekt voor klantnummerreeks.' using errcode = '23514';
  end if;

  select greatest(coalesce(max(public.extract_client_sequence_number(client_code, 'KL')), 0) + 1, 1)
    into v_next_number
  from public.clients
  where organization_id = p_organization_id;

  insert into public.organization_client_number_sequences(organization_id, prefix, padding, next_number)
  values (p_organization_id, 'KL', 3, v_next_number)
  on conflict (organization_id) do update
    set next_number = greatest(public.organization_client_number_sequences.next_number, excluded.next_number),
        updated_at = now();
end;
$$;

create or replace function public.format_client_code(p_prefix text, p_number integer, p_padding integer)
returns text
language sql
immutable
as $$
  select upper(btrim(coalesce(p_prefix, 'KL'))) || '-' || lpad(greatest(coalesce(p_number, 1), 1)::text, greatest(coalesce(p_padding, 3), 1), '0');
$$;

create or replace function public.allocate_next_client_code(p_organization_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sequence public.organization_client_number_sequences;
  v_number integer;
  v_code text;
begin
  if p_organization_id is null then
    raise exception 'Organisatie ontbreekt voor klantnummerreeks.' using errcode = '23514';
  end if;

  perform public.reconcile_client_number_sequence(p_organization_id);

  select *
    into v_sequence
  from public.organization_client_number_sequences
  where organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Klantnummerreeks kon niet worden geladen.' using errcode = 'P0002';
  end if;

  v_number := greatest(v_sequence.next_number, 1);
  v_code := public.format_client_code(v_sequence.prefix, v_number, v_sequence.padding);

  while exists (
    select 1
    from public.clients c
    where c.organization_id = p_organization_id
      and public.normalize_client_lookup_value(c.client_code) = public.normalize_client_lookup_value(v_code)
  ) loop
    v_number := v_number + 1;
    v_code := public.format_client_code(v_sequence.prefix, v_number, v_sequence.padding);
  end loop;

  update public.organization_client_number_sequences
    set next_number = v_number + 1,
        updated_at = now()
  where organization_id = p_organization_id;

  return v_code;
end;
$$;

create or replace function public.preview_next_client_code(p_organization_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sequence public.organization_client_number_sequences;
  v_number integer;
  v_code text;
begin
  if not public.can_read_org(p_organization_id) then
    raise exception 'Geen toegang tot deze organisatie.' using errcode = '42501';
  end if;

  perform public.reconcile_client_number_sequence(p_organization_id);

  select *
    into v_sequence
  from public.organization_client_number_sequences
  where organization_id = p_organization_id;

  if not found then
    return 'KL-001';
  end if;

  v_number := greatest(v_sequence.next_number, 1);
  v_code := public.format_client_code(v_sequence.prefix, v_number, v_sequence.padding);

  while exists (
    select 1
    from public.clients c
    where c.organization_id = p_organization_id
      and public.normalize_client_lookup_value(c.client_code) = public.normalize_client_lookup_value(v_code)
  ) loop
    v_number := v_number + 1;
    v_code := public.format_client_code(v_sequence.prefix, v_number, v_sequence.padding);
  end loop;

  return v_code;
end;
$$;

create or replace function public.enforce_clients_duplicate_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_code_norm text;
  v_email_norm text;
  v_name_norm text;
  v_phone_norm text;
  v_contact_norm text;
  v_duplicate_label text;
  v_code_was_generated boolean := coalesce(current_setting('resofly.client_code_generated', true), '') = 'true';
begin
  new.name := btrim(coalesce(new.name, ''));
  if new.name = '' then
    raise exception 'Klantnaam is verplicht.' using errcode = '23514';
  end if;

  new.client_code := nullif(btrim(new.client_code), '');
  new.email := public.normalize_client_lookup_value(new.email);
  new.contact_name := nullif(btrim(new.contact_name), '');
  new.phone := nullif(btrim(new.phone), '');

  -- Serialiseer klant-mutaties per organisatie. Dit is dezelfde lock die de
  -- create-client-RPC gebruikt, waardoor nummergeneratie en duplicate-checks
  -- altijd in dezelfde volgorde verlopen en deadlocks worden voorkomen.
  perform pg_advisory_xact_lock(hashtext(new.organization_id::text), hashtext('clients_duplicate_guard'));

  -- Browser/direct REST-inserts mogen het klantnummer niet meer bepalen.
  -- De RPC markeert server-generated codes met een transaction-local setting.
  if TG_OP = 'INSERT' and not v_code_was_generated then
    new.client_code := public.allocate_next_client_code(new.organization_id);
  elsif TG_OP = 'INSERT' and new.client_code is null then
    new.client_code := public.allocate_next_client_code(new.organization_id);
  end if;

  v_client_code_norm := public.normalize_client_lookup_value(new.client_code);
  v_email_norm := public.normalize_client_lookup_value(new.email);
  v_name_norm := public.normalize_client_lookup_value(new.name);
  v_phone_norm := public.normalize_client_phone_value(new.phone);
  v_contact_norm := public.normalize_client_lookup_value(new.contact_name);

  if v_client_code_norm is not null then
    select c.name || coalesce(' (' || c.client_code || ')', '')
      into v_duplicate_label
    from public.clients c
    where c.organization_id = new.organization_id
      and c.id is distinct from new.id
      and public.normalize_client_lookup_value(c.client_code) = v_client_code_norm
    limit 1;

    if found then
      raise exception 'Klantnummer "%" bestaat al binnen deze organisatie bij %.', new.client_code, v_duplicate_label using errcode = '23505';
    end if;
  end if;

  if v_email_norm is not null then
    select c.name || coalesce(' (' || c.client_code || ')', '')
      into v_duplicate_label
    from public.clients c
    where c.organization_id = new.organization_id
      and c.id is distinct from new.id
      and public.normalize_client_lookup_value(c.email) = v_email_norm
    limit 1;

    if found then
      raise exception 'Er bestaat al een klant met dit e-mailadres binnen deze organisatie: %.', v_duplicate_label using errcode = '23505';
    end if;
  end if;

  if v_name_norm is not null and v_phone_norm is not null then
    select c.name || coalesce(' (' || c.client_code || ')', '')
      into v_duplicate_label
    from public.clients c
    where c.organization_id = new.organization_id
      and c.id is distinct from new.id
      and public.normalize_client_lookup_value(c.name) = v_name_norm
      and public.normalize_client_phone_value(c.phone) = v_phone_norm
    limit 1;

    if found then
      raise exception 'Er bestaat al een klant met dezelfde naam en hetzelfde telefoonnummer binnen deze organisatie: %.', v_duplicate_label using errcode = '23505';
    end if;
  end if;

  if v_name_norm is not null and v_contact_norm is not null then
    select c.name || coalesce(' (' || c.client_code || ')', '')
      into v_duplicate_label
    from public.clients c
    where c.organization_id = new.organization_id
      and c.id is distinct from new.id
      and public.normalize_client_lookup_value(c.name) = v_name_norm
      and public.normalize_client_lookup_value(c.contact_name) = v_contact_norm
    limit 1;

    if found then
      raise exception 'Er bestaat al een klant met dezelfde naam en contactpersoon binnen deze organisatie: %.', v_duplicate_label using errcode = '23505';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists clients_duplicate_guard on public.clients;
create trigger clients_duplicate_guard
  before insert or update of organization_id, name, client_code, email, phone, contact_name
  on public.clients
  for each row execute function public.enforce_clients_duplicate_guard();

create or replace function public.create_client_with_next_code(p_organization_id uuid, p_payload jsonb default '{}'::jsonb)
returns public.clients
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients;
  v_user_id uuid := auth.uid();
  v_status text := coalesce(nullif(btrim(p_payload ->> 'status'), ''), 'active');
  v_color text := coalesce(nullif(btrim(p_payload ->> 'color'), ''), '#FFD966');
  v_value_eur numeric(12,2) := 0;
  v_tags text[] := '{}';
  v_client_code text;
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if v_status not in ('active','prospect','inactive') then
    raise exception 'Ongeldige klantstatus.' using errcode = '23514';
  end if;

  if jsonb_typeof(p_payload -> 'tags') = 'array' then
    select coalesce(array_agg(nullif(btrim(value), '')) filter (where nullif(btrim(value), '') is not null), '{}')
      into v_tags
    from jsonb_array_elements_text(p_payload -> 'tags') as tags(value);
  end if;

  if nullif(p_payload ->> 'value_eur', '') is not null then
    v_value_eur := (p_payload ->> 'value_eur')::numeric(12,2);
  end if;

  perform pg_advisory_xact_lock(hashtext(p_organization_id::text), hashtext('clients_duplicate_guard'));
  v_client_code := public.allocate_next_client_code(p_organization_id);

  perform set_config('resofly.client_code_generated', 'true', true);

  insert into public.clients(
    organization_id,
    created_by,
    name,
    client_code,
    contact_name,
    email,
    phone,
    notes,
    color,
    status,
    tags,
    value_eur,
    follow_up
  ) values (
    p_organization_id,
    v_user_id,
    btrim(coalesce(p_payload ->> 'name', '')),
    v_client_code,
    nullif(btrim(p_payload ->> 'contact_name'), ''),
    nullif(lower(btrim(p_payload ->> 'email')), ''),
    nullif(btrim(p_payload ->> 'phone'), ''),
    nullif(btrim(p_payload ->> 'notes'), ''),
    v_color,
    v_status,
    v_tags,
    v_value_eur,
    nullif(p_payload ->> 'follow_up', '')::date
  )
  returning * into v_client;

  return v_client;
end;
$$;

revoke execute on function public.reconcile_client_number_sequence(uuid) from public, anon, authenticated;
revoke execute on function public.allocate_next_client_code(uuid) from public, anon, authenticated;
revoke execute on function public.create_client_with_next_code(uuid, jsonb) from public, anon;
revoke execute on function public.preview_next_client_code(uuid) from public, anon;

grant execute on function public.preview_next_client_code(uuid) to authenticated;
grant execute on function public.create_client_with_next_code(uuid, jsonb) to authenticated;


commit;


-- Weekplanner planning helpers: separate task planning from deadlines and keep day ordering stable.
create or replace function public.compact_task_planning_order(
  p_organization_id uuid,
  p_planned_date date
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row record;
  v_index integer := 0;
begin
  if p_organization_id is null or p_planned_date is null then
    return;
  end if;

  for v_row in
    select id
    from public.tasks
    where organization_id = p_organization_id
      and planned_date = p_planned_date
    order by coalesce(planned_order, 2147483647), created_at, id
    for update
  loop
    v_index := v_index + 1;
    update public.tasks
    set planned_order = v_index * 1000,
        updated_at = now()
    where id = v_row.id;
  end loop;
end;
$$;

create or replace function public.reorder_task_planning(
  p_organization_id uuid,
  p_task_id uuid,
  p_planned_date date,
  p_before_task_id uuid default null
)
returns public.tasks
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_before_task public.tasks%rowtype;
  v_old_planned_date date;
  v_existing_ids uuid[] := array[]::uuid[];
  v_new_ids uuid[] := array[]::uuid[];
  v_id uuid;
  v_index integer := 0;
  v_inserted boolean := false;
  v_result public.tasks%rowtype;
begin
  if p_organization_id is null or p_task_id is null then
    raise exception 'Organisatie en taak zijn verplicht.';
  end if;

  if not public.can_write_org(p_organization_id) then
    raise exception 'Geen rechten om deze taak te plannen.' using errcode = '42501';
  end if;

  select * into v_task
  from public.tasks
  where id = p_task_id
    and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Taak niet gevonden binnen deze organisatie.';
  end if;

  v_old_planned_date := v_task.planned_date;

  if p_before_task_id is not null then
    if p_before_task_id = p_task_id then
      return v_task;
    end if;

    select * into v_before_task
    from public.tasks
    where id = p_before_task_id
      and organization_id = p_organization_id
    for update;

    if not found then
      raise exception 'Doeltaak niet gevonden binnen deze organisatie.';
    end if;

    if v_before_task.planned_date is distinct from p_planned_date then
      raise exception 'Doeltaak hoort niet bij deze plandatum.';
    end if;
  end if;

  if p_planned_date is null then
    update public.tasks
    set planned_date = null,
        planned_order = null,
        updated_at = now()
    where id = p_task_id
      and organization_id = p_organization_id
    returning * into v_result;

    if v_old_planned_date is not null then
      perform public.compact_task_planning_order(p_organization_id, v_old_planned_date);
    end if;

    return v_result;
  end if;

  perform 1
  from public.tasks
  where organization_id = p_organization_id
    and planned_date = p_planned_date
  order by coalesce(planned_order, 2147483647), created_at, id
  for update;

  select coalesce(array_agg(id order by coalesce(planned_order, 2147483647), created_at, id), array[]::uuid[])
  into v_existing_ids
  from public.tasks
  where organization_id = p_organization_id
    and planned_date = p_planned_date
    and id <> p_task_id;

  if p_before_task_id is null then
    v_new_ids := array_append(v_existing_ids, p_task_id);
  else
    foreach v_id in array v_existing_ids loop
      if v_id = p_before_task_id and not v_inserted then
        v_new_ids := array_append(v_new_ids, p_task_id);
        v_inserted := true;
      end if;
      v_new_ids := array_append(v_new_ids, v_id);
    end loop;

    if not v_inserted then
      v_new_ids := array_append(v_new_ids, p_task_id);
    end if;
  end if;

  foreach v_id in array v_new_ids loop
    v_index := v_index + 1;
    update public.tasks
    set planned_date = p_planned_date,
        planned_order = v_index * 1000,
        updated_at = now()
    where id = v_id
      and organization_id = p_organization_id;
  end loop;

  if v_old_planned_date is not null and v_old_planned_date <> p_planned_date then
    perform public.compact_task_planning_order(p_organization_id, v_old_planned_date);
  end if;

  select * into v_result
  from public.tasks
  where id = p_task_id
    and organization_id = p_organization_id;

  return v_result;
end;
$$;

grant execute on function public.compact_task_planning_order(uuid, date) to authenticated;
grant execute on function public.reorder_task_planning(uuid, uuid, date, uuid) to authenticated;
