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
