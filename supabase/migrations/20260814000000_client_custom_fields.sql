-- ============================================================
-- ResoFly — Vrije invulvelden op klanten + variabelen in mailings
-- Date: 2026-08-14
--
-- Scope:
-- - Een organisatie definieert zelf extra klantvelden (label, type, opties).
--   De WAARDEN staan als JSONB op de klantrij zelf (clients.custom_fields), niet
--   in een aparte waardentabel. Reden: het campagne-verzendpad laadt de klanten
--   toch al integraal (loadAllClients in de `campaigns` Edge Function); één kolom
--   erbij in de select kost niets, terwijl een EAV-tabel per verzendbatch een
--   tweede query zou toevoegen. Bovendien erven de waarden zo automatisch de
--   RLS + module-gate van `clients`.
-- - De definities bepalen ook de terugvalwaarde ({{veld.x|fallback}}) en of het
--   veld als kolom in de klantenlijst verschijnt.
--
-- LET OP (bekende valkuil, zie 20260723100000): create_client_with_next_code
-- whitelist zijn kolommen expliciet in de INSERT. Zonder herdefinitie zouden
-- vrije velden bij het AANMAKEN van een klant stilzwijgend verdwijnen, terwijl
-- bewerken (PostgREST) wél werkt. We herdefiniëren de RPC op basis van de
-- NIEUWSTE versie (20260723100000, mét UBL-kopervelden).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Definitietabel: welke vrije velden kent deze organisatie?
-- ------------------------------------------------------------
create table if not exists public.client_field_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  -- Sleutel in clients.custom_fields én de naam in de mailing: {{veld.<field_key>}}.
  -- Bewust beperkt tot [a-z0-9_] zodat de token-regex hem altijd kan vinden.
  field_key text not null,
  label text not null,
  field_type text not null default 'text'
    check (field_type in ('text','textarea','number','amount','date','select','multiselect','boolean','url','email','phone')),
  -- Keuzemogelijkheden voor select/multiselect; leeg voor de overige types.
  options text[] not null default '{}',
  help_text text,
  -- Terugvalwaarde in mailings als de klant dit veld leeg heeft. Zonder dit
  -- wordt "Beste {{veld.aanhef}}," letterlijk "Beste ,".
  default_fallback text,
  position integer not null default 0,
  -- Toont dit veld als kolom in het klantenoverzicht.
  show_in_list boolean not null default false,
  -- Archiveren i.p.v. verwijderen: bestaande waarden blijven staan, het veld
  -- verdwijnt alleen uit de invoerformulieren en de tokenlijst.
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, field_key),
  constraint client_field_definitions_key_format
    check (field_key ~ '^[a-z][a-z0-9_]{0,38}$'),
  constraint client_field_definitions_label_filled
    check (btrim(label) <> ''),
  -- select/multiselect zonder opties is een veld dat je nooit kunt invullen.
  constraint client_field_definitions_options_required
    check (field_type not in ('select','multiselect') or array_length(options, 1) >= 1)
);

comment on table public.client_field_definitions is
  'Zelf gedefinieerde extra klantvelden per organisatie. Waarden staan als JSONB in clients.custom_fields; de sleutel is field_key.';
comment on column public.client_field_definitions.default_fallback is
  'Terugvalwaarde bij het invullen van {{veld.<field_key>}} in campagnes/stromen wanneer de klant het veld leeg heeft.';

create index if not exists idx_client_field_definitions_org
  on public.client_field_definitions(organization_id, is_archived, position, created_at);

-- ------------------------------------------------------------
-- 2. De waarden op de klant
-- ------------------------------------------------------------
alter table public.clients
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

comment on column public.clients.custom_fields is
  'Waarden van de vrije velden, als {field_key: waarde}. Gevalideerd tegen client_field_definitions; lege waarden worden weggelaten zodat de mailing-terugval werkt.';

-- Containment-index: doelgroepfilters vragen "welke klanten hebben veld X = Y".
create index if not exists idx_clients_custom_fields
  on public.clients using gin (custom_fields jsonb_path_ops);

-- ------------------------------------------------------------
-- 3. Validatie + normalisatie van custom_fields
-- ------------------------------------------------------------
-- Waarom een trigger en geen CHECK: de toegestane sleutels en types staan in een
-- ANDERE tabel (de definities), dus de regel is niet met een rij-lokale check
-- uit te drukken. De trigger doet drie dingen:
--   1. lege waarden ('' / null / lege array) verwijderen — dan grijpt de
--      terugvalwaarde in de mailing, i.p.v. dat er een leeg gat valt;
--   2. onbekende sleutels weigeren (typefout wordt zichtbaar i.p.v. stil bewaard);
--   3. het type afdwingen dat in de definitie staat.
create or replace function public.validate_client_custom_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key      text;
  v_value    jsonb;
  v_def      record;
  v_result   jsonb := '{}'::jsonb;
  v_text     text;
  v_element  text;
begin
  if new.custom_fields is null then
    new.custom_fields := '{}'::jsonb;
    return new;
  end if;

  if jsonb_typeof(new.custom_fields) <> 'object' then
    raise exception 'custom_fields moet een JSON-object zijn.' using errcode = '22023';
  end if;

  if new.custom_fields = '{}'::jsonb then
    return new;
  end if;

  for v_key, v_value in select key, value from jsonb_each(new.custom_fields) loop
    -- 1. Leeg = weglaten (niet bewaren als lege string/array/null).
    if v_value is null or jsonb_typeof(v_value) = 'null' then
      continue;
    end if;
    if jsonb_typeof(v_value) = 'string' and btrim(v_value #>> '{}') = '' then
      continue;
    end if;
    if jsonb_typeof(v_value) = 'array' and jsonb_array_length(v_value) = 0 then
      continue;
    end if;

    -- 2. Sleutel moet bestaan binnen dezelfde organisatie. Gearchiveerde velden
    --    zijn bewust wél toegestaan: archiveren mag het bewerken van een klant
    --    die de waarde al had niet blokkeren.
    select d.field_type, d.options
      into v_def
      from public.client_field_definitions d
     where d.organization_id = new.organization_id
       and d.field_key = v_key;

    if not found then
      raise exception 'Onbekend klantveld: %', v_key using errcode = '22023';
    end if;

    -- 3. Type afdwingen.
    if v_def.field_type in ('text','textarea','url','email','phone') then
      if jsonb_typeof(v_value) <> 'string' then
        raise exception 'Klantveld % verwacht tekst.', v_key using errcode = '22023';
      end if;
      v_result := v_result || jsonb_build_object(v_key, to_jsonb(btrim(v_value #>> '{}')));

    elsif v_def.field_type in ('number','amount') then
      if jsonb_typeof(v_value) <> 'number' then
        raise exception 'Klantveld % verwacht een getal.', v_key using errcode = '22023';
      end if;
      v_result := v_result || jsonb_build_object(v_key, v_value);

    elsif v_def.field_type = 'boolean' then
      if jsonb_typeof(v_value) <> 'boolean' then
        raise exception 'Klantveld % verwacht ja/nee.', v_key using errcode = '22023';
      end if;
      v_result := v_result || jsonb_build_object(v_key, v_value);

    elsif v_def.field_type = 'date' then
      if jsonb_typeof(v_value) <> 'string' then
        raise exception 'Klantveld % verwacht een datum (JJJJ-MM-DD).', v_key using errcode = '22023';
      end if;
      v_text := btrim(v_value #>> '{}');
      begin
        perform v_text::date;
      exception when others then
        raise exception 'Klantveld % bevat geen geldige datum: %', v_key, v_text using errcode = '22023';
      end;
      v_result := v_result || jsonb_build_object(v_key, to_jsonb(v_text));

    elsif v_def.field_type = 'select' then
      if jsonb_typeof(v_value) <> 'string' then
        raise exception 'Klantveld % verwacht één keuze.', v_key using errcode = '22023';
      end if;
      v_text := btrim(v_value #>> '{}');
      if not (v_text = any(v_def.options)) then
        raise exception 'Klantveld % kent de keuze % niet.', v_key, v_text using errcode = '22023';
      end if;
      v_result := v_result || jsonb_build_object(v_key, to_jsonb(v_text));

    elsif v_def.field_type = 'multiselect' then
      if jsonb_typeof(v_value) <> 'array' then
        raise exception 'Klantveld % verwacht een lijst met keuzes.', v_key using errcode = '22023';
      end if;
      for v_element in select jsonb_array_elements_text(v_value) loop
        if not (btrim(v_element) = any(v_def.options)) then
          raise exception 'Klantveld % kent de keuze % niet.', v_key, v_element using errcode = '22023';
        end if;
      end loop;
      v_result := v_result || jsonb_build_object(v_key, v_value);

    else
      raise exception 'Onbekend veldtype % voor klantveld %', v_def.field_type, v_key using errcode = '22023';
    end if;
  end loop;

  new.custom_fields := v_result;
  return new;
end;
$$;

drop trigger if exists clients_validate_custom_fields on public.clients;
create trigger clients_validate_custom_fields
  before insert or update of custom_fields on public.clients
  for each row execute function public.validate_client_custom_fields();

-- ------------------------------------------------------------
-- 4. Definitie verwijderd → de waarde ook van de klanten af
-- ------------------------------------------------------------
-- Zonder dit blijven wees-sleutels achter, en weigert de validatietrigger
-- daarna élke bewerking van die klant ('Onbekend klantveld'). Archiveren is de
-- normale weg; verwijderen is definitief en ruimt dus ook op.
create or replace function public.strip_deleted_client_field()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.clients
     set custom_fields = custom_fields - old.field_key
   where organization_id = old.organization_id
     and custom_fields ? old.field_key;
  return old;
end;
$$;

drop trigger if exists client_field_definitions_strip_values on public.client_field_definitions;
create trigger client_field_definitions_strip_values
  after delete on public.client_field_definitions
  for each row execute function public.strip_deleted_client_field();

-- Hernoemen van een field_key zou dezelfde wees-situatie geven; verplaats de
-- waarden mee zodat een hernoemde sleutel geen data verliest.
create or replace function public.rename_client_field_key()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.field_key = old.field_key then
    return new;
  end if;
  update public.clients
     set custom_fields = (custom_fields - old.field_key)
                       || jsonb_build_object(new.field_key, custom_fields -> old.field_key)
   where organization_id = old.organization_id
     and custom_fields ? old.field_key;
  return new;
end;
$$;

drop trigger if exists client_field_definitions_rename_values on public.client_field_definitions;
create trigger client_field_definitions_rename_values
  after update of field_key on public.client_field_definitions
  for each row execute function public.rename_client_field_key();

-- ------------------------------------------------------------
-- 5. Hardening-triggers
-- ------------------------------------------------------------
drop trigger if exists client_field_definitions_updated on public.client_field_definitions;
create trigger client_field_definitions_updated
  before update on public.client_field_definitions
  for each row execute function public.set_updated_at();

drop trigger if exists client_field_definitions_prevent_org_change on public.client_field_definitions;
create trigger client_field_definitions_prevent_org_change
  before update of organization_id on public.client_field_definitions
  for each row execute function public.prevent_organization_id_change();

-- ------------------------------------------------------------
-- 6. RLS + module-gate (de vrije velden horen bij de module 'clients')
-- ------------------------------------------------------------
alter table public.client_field_definitions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='client_field_definitions' and policyname='client field definitions read') then
    create policy "client field definitions read" on public.client_field_definitions
      for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='client_field_definitions' and policyname='client field definitions insert') then
    create policy "client field definitions insert" on public.client_field_definitions
      for insert with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='client_field_definitions' and policyname='client field definitions update') then
    create policy "client field definitions update" on public.client_field_definitions
      for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='client_field_definitions' and policyname='client field definitions delete') then
    create policy "client field definitions delete" on public.client_field_definitions
      for delete using (public.can_write_org(organization_id));
  end if;
end $$;

-- Zelfde modulepoort als de klantentabel: wie 'geen' toegang tot Klanten heeft,
-- ziet ook de velddefinities niet.
do $$
begin
  perform public.apply_module_gate('client_field_definitions', 'clients', 'write');
end $$;

-- ------------------------------------------------------------
-- 7. create_client_with_next_code opnieuw, mét custom_fields.
--    Basis = 20260723100000 (nieuwste versie, incl. UBL-kopervelden).
-- ------------------------------------------------------------
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
  v_client_kind text := coalesce(nullif(btrim(p_payload ->> 'client_kind'), ''), 'business');
  v_value_eur numeric(12,2) := 0;
  v_tags text[] := '{}';
  v_custom_fields jsonb := '{}'::jsonb;
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

  if v_client_kind not in ('business','consumer') then
    raise exception 'Ongeldig klanttype.' using errcode = '23514';
  end if;

  if jsonb_typeof(p_payload -> 'tags') = 'array' then
    select coalesce(array_agg(nullif(btrim(value), '')) filter (where nullif(btrim(value), '') is not null), '{}')
      into v_tags
    from jsonb_array_elements_text(p_payload -> 'tags') as tags(value);
  end if;

  if nullif(p_payload ->> 'value_eur', '') is not null then
    v_value_eur := (p_payload ->> 'value_eur')::numeric(12,2);
  end if;

  -- Vrije velden. De validatietrigger op clients normaliseert en keurt af;
  -- hier alleen doorgeven zodat ze niet stilzwijgend verdwijnen bij aanmaken.
  if jsonb_typeof(p_payload -> 'custom_fields') = 'object' then
    v_custom_fields := p_payload -> 'custom_fields';
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
    client_kind,
    tags,
    value_eur,
    follow_up,
    vat_number,
    kvk_number,
    address_line1,
    address_line2,
    postal_code,
    city,
    country,
    custom_fields
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
    v_client_kind,
    v_tags,
    v_value_eur,
    nullif(p_payload ->> 'follow_up', '')::date,
    nullif(btrim(p_payload ->> 'vat_number'), ''),
    nullif(btrim(p_payload ->> 'kvk_number'), ''),
    nullif(btrim(p_payload ->> 'address_line1'), ''),
    nullif(btrim(p_payload ->> 'address_line2'), ''),
    nullif(btrim(p_payload ->> 'postal_code'), ''),
    nullif(btrim(p_payload ->> 'city'), ''),
    nullif(btrim(p_payload ->> 'country'), ''),
    v_custom_fields
  )
  returning * into v_client;

  return v_client;
end;
$$;

-- ------------------------------------------------------------
-- 8. Momentopname van de ingevulde variabelen per ontvanger
-- ------------------------------------------------------------
-- Gevuld bij het MATERIALISEREN van de ontvangers, niet pas bij het versturen.
-- Reden: een campagne kan uren lopen en client_id is `on delete set null` — een
-- klant die halverwege hernoemd of verwijderd wordt zou anders de ene helft van
-- de lijst een andere aanhef geven dan de andere. De momentopname is bovendien
-- exact wat in de voorbeeldweergave stond.
alter table public.email_campaign_recipients
  add column if not exists merge_data jsonb not null default '{}'::jsonb;

comment on column public.email_campaign_recipients.merge_data is
  'Momentopname van de variabelewaarden ({{token}} → waarde) op het moment van materialiseren.';

alter table public.email_flow_enrollments
  add column if not exists merge_data jsonb not null default '{}'::jsonb;

comment on column public.email_flow_enrollments.merge_data is
  'Momentopname van de variabelewaarden voor deze inschrijving; elke stap in de stroom gebruikt dezelfde waarden.';

commit;
