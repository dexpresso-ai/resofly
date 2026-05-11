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

create index idx_clients_org on public.clients(organization_id, created_at desc);
create index idx_projects_org on public.projects(organization_id, archived, created_at desc);
create index idx_projects_client on public.projects(client_id);
create index idx_tasks_org on public.tasks(organization_id, status, end_date);
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
