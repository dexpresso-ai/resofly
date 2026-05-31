-- ResoFly / BrandCore
-- Klant-deduplicatie binnen dezelfde organisatie.
-- Doel: dezelfde klant mag wel in verschillende organisaties bestaan, maar niet dubbel binnen dezelfde organisatie.

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

  -- Serialiseer klant-mutaties per organisatie. Hiermee voorkomen we dat twee
  -- gelijktijdige inserts dezelfde duplicate-check tegelijk passeren.
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

create index if not exists idx_clients_org_client_code_lookup
  on public.clients (organization_id, public.normalize_client_lookup_value(client_code))
  where nullif(btrim(coalesce(client_code, '')), '') is not null;

create index if not exists idx_clients_org_email_lookup
  on public.clients (organization_id, public.normalize_client_lookup_value(email))
  where nullif(btrim(coalesce(email, '')), '') is not null;

create index if not exists idx_clients_org_name_lookup
  on public.clients (organization_id, public.normalize_client_lookup_value(name));

create index if not exists idx_clients_org_phone_lookup
  on public.clients (organization_id, public.normalize_client_phone_value(phone))
  where nullif(regexp_replace(coalesce(phone, ''), '[^0-9]+', '', 'g'), '') is not null;

drop trigger if exists clients_duplicate_guard on public.clients;
create trigger clients_duplicate_guard
  before insert or update of organization_id, name, client_code, email, phone, contact_name
  on public.clients
  for each row execute function public.enforce_clients_duplicate_guard();
