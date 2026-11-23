-- ============================================================
-- ResoFly — Google Drive en OneDrive koppelen aan Inhoud
-- Date: 2026-11-23
--
-- Wat er kan:
-- Een teamlid koppelt zijn eigen Google Drive of OneDrive en zet bestanden
-- daaruit in een dossiermap. ResoFly bewaart alleen een verwijzing: het
-- bestand blijft in Drive of OneDrive staan en opent daar ook. Verwijder je
-- het in ResoFly, dan gaat het in Drive of OneDrive naar de prullenbak (op
-- verzoek: "verwijderen uit ResoFly is ook verwijderen uit Drive").
--
-- Hoe:
--   1. cloud_drive_connections (+ _tokens): de koppeling per teamlid, per
--      organisatie, per account. De tokens staan versleuteld en alleen de
--      edge function cloud-files leest ze.
--   2. Kolommen op attachments: een gekoppeld bestand is een gewone bijlage in
--      een dossiermap, met cloud_provider en cloud_file_id erbij. Zo verschijnt
--      het vanzelf in de verkenner, met verplaatsen, hernoemen en selecteren.
--      De opslagsleutel is '<organisatie>/cloud/<provider>/<id>': daar ligt
--      niets in R2, en een worker die hem toch opvraagt, vindt niets.
--   3. cloud_file_deletions: de wachtrij van wat er in Drive of OneDrive weg
--      moet. Een trigger vult hem bij élk verwijderen van een gekoppeld
--      bestand: vanuit de verkenner, via Gerrie, of omdat de map of de klant
--      wordt verwijderd (purge_folder_files). Alleen het scherm aanroepen was
--      niet genoeg: bij een verwijderde klant komt niemand langs het scherm,
--      net als bij de galerij (20261112170000).
--
-- Beveiliging:
-- - Harde regel 1: organization_id komt uit de rij, nooit uit invoer. De
--   wachtrij en de koppelingen hebben RLS aan; schrijven doet alleen de
--   service-role (de edge function).
-- - De cloud-kolommen schrijft alleen de service-role (attachments_cloud_guard).
--   Kon een teamlid ze zelf zetten, dan maakte hij een "gekoppeld bestand" met
--   het bestands-id en de koppeling van een collega, en gooide hij door het te
--   verwijderen een bestand uit diens Drive weg.
-- - Verwijderen gebeurt met de koppeling van wie het bestand koppelde: die gaf
--   daar bij het koppelen toestemming voor (het venster zegt het erbij). Wie
--   mag verwijderen, beslist de database zoals altijd: RLS en de module Inhoud.
-- - De prullenbak, niet definitief: Google houdt hem 30 dagen, OneDrive 30
--   (privé) of 93 dagen (werk). Zo is een vergissing nog te herstellen.
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. De koppelingen ──────────────────────────────────────────────────────

create table if not exists public.cloud_drive_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  provider_account_id text not null,
  provider_account_email text,
  display_name text,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked', 'error')),
  scopes text[] not null default '{}',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id, provider, provider_account_id)
);

create index if not exists idx_cloud_drive_connections_user
  on public.cloud_drive_connections (organization_id, user_id, provider);

drop trigger if exists cloud_drive_connections_updated on public.cloud_drive_connections;
create trigger cloud_drive_connections_updated
  before update on public.cloud_drive_connections
  for each row execute function public.set_updated_at();

create table if not exists public.cloud_drive_connection_tokens (
  connection_id uuid primary key references public.cloud_drive_connections(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  token_type text,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists cloud_drive_connection_tokens_updated on public.cloud_drive_connection_tokens;
create trigger cloud_drive_connection_tokens_updated
  before update on public.cloud_drive_connection_tokens
  for each row execute function public.set_updated_at();

-- Een token hoort bij precies zijn koppeling: zelfde organisatie, persoon en
-- aanbieder. De edge function zet ze zo, maar een vergissing in de code mag
-- nooit het token van de één onder de koppeling van een ander leggen.
create or replace function public.enforce_cloud_drive_tokens_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_connection public.cloud_drive_connections;
begin
  select * into v_connection from public.cloud_drive_connections where id = new.connection_id;
  if not found
     or v_connection.organization_id <> new.organization_id
     or v_connection.user_id <> new.user_id
     or v_connection.provider <> new.provider then
    raise exception 'Dit token hoort niet bij deze koppeling.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_cloud_drive_tokens_integrity() from public, anon, authenticated;

drop trigger if exists cloud_drive_tokens_integrity on public.cloud_drive_connection_tokens;
create trigger cloud_drive_tokens_integrity
  before insert or update on public.cloud_drive_connection_tokens
  for each row execute function public.enforce_cloud_drive_tokens_integrity();

alter table public.cloud_drive_connections enable row level security;
alter table public.cloud_drive_connection_tokens enable row level security;

-- Je ziet alleen je eigen koppelingen. Schrijven doet de edge function.
drop policy if exists "cloud drive connections read own" on public.cloud_drive_connections;
create policy "cloud drive connections read own" on public.cloud_drive_connections
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and organization_id = any ((select public.my_organization_ids())::uuid[])
  );

revoke insert, update, delete on table public.cloud_drive_connections from anon, authenticated;
revoke all on table public.cloud_drive_connection_tokens from anon, authenticated;
select public.apply_accountant_fence('cloud_drive_connections');
select public.apply_accountant_fence('cloud_drive_connection_tokens');

-- Vertrekt een teamlid, dan gaat zijn koppeling uit en zijn tokens weg, net
-- als bij de agenda (disable_integrations_on_member_exit). Wat hij koppelde,
-- blijft in ResoFly staan; verwijderen gaat dan niet meer door naar zijn Drive.
create or replace function public.cloud_drive_on_member_exit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_user uuid;
begin
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
    v_user := old.user_id;
  elsif old.status = 'active' and new.status is distinct from 'active' then
    v_org := new.organization_id;
    v_user := new.user_id;
  else
    return new;
  end if;

  update public.cloud_drive_connections
     set status = 'revoked',
         last_error = 'Ingetrokken: het teamlid is uit de organisatie.'
   where organization_id = v_org
     and user_id = v_user
     and status <> 'revoked';

  delete from public.cloud_drive_connection_tokens
   where organization_id = v_org
     and user_id = v_user;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.cloud_drive_on_member_exit() from public, anon, authenticated;

drop trigger if exists organization_members_cloud_drive_exit on public.organization_members;
create trigger organization_members_cloud_drive_exit
  after delete or update of status on public.organization_members
  for each row execute function public.cloud_drive_on_member_exit();

-- ── 2. Een gekoppeld bestand is een bijlage in een dossiermap ──────────────

alter table public.attachments
  add column if not exists cloud_provider text,
  add column if not exists cloud_file_id text,
  add column if not exists cloud_drive_id text,
  add column if not exists cloud_connection_id uuid,
  add column if not exists cloud_web_url text,
  add column if not exists cloud_size_bytes bigint;

-- Bewust zonder foreign key naar de koppeling. Een "on delete set null" is een
-- UPDATE op attachments in naam van wie er iets verwijdert, en die houdt
-- attachments_cloud_guard (hieronder) tegen: dan kon niemand meer een account
-- of organisatie met gekoppelde bestanden verwijderen. De edge function zoekt
-- de koppeling op en controleert zelf de organisatie; bestaat hij niet meer,
-- dan zegt de wachtrij dat het bestand niet uit Drive kon.

-- Eén vorm voor een gekoppeld bestand. size_bytes blijft 0: het bestand ligt
-- niet in onze opslag en telt dus niet mee in het quotum
-- (organization_storage_status telt size_bytes). De grootte in Drive staat in
-- cloud_size_bytes, alleen om te tonen.
alter table public.attachments drop constraint if exists attachments_cloud_shape;
alter table public.attachments add constraint attachments_cloud_shape check (
  (cloud_provider is null
    and cloud_file_id is null
    and cloud_drive_id is null
    and cloud_connection_id is null
    and cloud_web_url is null
    and cloud_size_bytes is null)
  or (cloud_provider in ('google', 'microsoft')
    and cloud_file_id is not null
    and length(cloud_file_id) between 1 and 512
    and (cloud_provider <> 'microsoft' or (cloud_drive_id is not null and length(cloud_drive_id) between 1 and 512))
    and (cloud_web_url is null or (cloud_web_url like 'https://%' and length(cloud_web_url) <= 2048))
    and entity_type = 'folder'
    and size_bytes = 0
    and storage_key like organization_id::text || '/cloud/' || cloud_provider || '/%')
);

-- Hetzelfde bestand twee keer koppelen in één organisatie kan niet. Anders
-- gooide het verwijderen van de ene verwijzing het bestand weg terwijl de
-- andere er nog naar wees.
create unique index if not exists attachments_cloud_file_unique
  on public.attachments (organization_id, cloud_provider, cloud_file_id)
  where cloud_provider is not null;

create index if not exists idx_attachments_cloud_connection
  on public.attachments (cloud_connection_id)
  where cloud_connection_id is not null;

-- De cloud-kolommen (en bij een gekoppeld bestand de opslagsleutel) schrijft
-- alleen de service-role. Een teamlid mag een gekoppeld bestand wel hernoemen
-- en verplaatsen.
create or replace function public.attachments_cloud_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.cloud_provider is not null or new.cloud_file_id is not null or new.cloud_drive_id is not null
       or new.cloud_connection_id is not null or new.cloud_web_url is not null or new.cloud_size_bytes is not null
       or split_part(new.storage_key, '/', 2) = 'cloud' then
      raise exception 'Een bestand uit Google Drive of OneDrive zet je in ResoFly met "+ Nieuw → Uit Google Drive" of "Uit OneDrive".'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if new.cloud_provider is distinct from old.cloud_provider
     or new.cloud_file_id is distinct from old.cloud_file_id
     or new.cloud_drive_id is distinct from old.cloud_drive_id
     or new.cloud_connection_id is distinct from old.cloud_connection_id
     or new.cloud_web_url is distinct from old.cloud_web_url
     or new.cloud_size_bytes is distinct from old.cloud_size_bytes
     or ((old.cloud_provider is not null or split_part(new.storage_key, '/', 2) = 'cloud')
         and new.storage_key is distinct from old.storage_key) then
    raise exception 'De koppeling met Google Drive of OneDrive kun je niet zelf aanpassen.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.attachments_cloud_guard() from public, anon, authenticated;

drop trigger if exists attachments_cloud_guard on public.attachments;
create trigger attachments_cloud_guard
  before insert or update on public.attachments
  for each row execute function public.attachments_cloud_guard();

-- ── 3. Wat er in Drive of OneDrive weg moet ────────────────────────────────

create table if not exists public.cloud_file_deletions (
  id uuid primary key default gen_random_uuid(),
  -- Geen foreign keys: de rij ontstaat juist terwijl de bijlage, en soms de
  -- hele organisatie of de koppeling, in dezelfde cascade verdwijnt.
  organization_id uuid not null,
  connection_id uuid,
  provider text not null check (provider in ('google', 'microsoft')),
  file_id text not null check (length(file_id) between 1 and 512),
  drive_id text check (drive_id is null or length(drive_id) between 1 and 512),
  name text not null default '',
  attachment_id uuid,
  requested_by uuid,
  -- pending: nog te doen · done: in de prullenbak (of was er al niet meer) ·
  -- failed: lukte niet en wacht op een mens (opnieuw koppelen, eigenaar).
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  -- Waarom het niet lukte. 'connection': de koppeling is verlopen of uit;
  -- opnieuw koppelen zet deze rijen weer klaar. 'permission': Drive of
  -- OneDrive laat dit account het bestand niet weggooien (geen eigenaar).
  failure text check (failure is null or failure in ('connection', 'permission', 'other')),
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  done_at timestamptz
);

create index if not exists idx_cloud_file_deletions_due
  on public.cloud_file_deletions (next_attempt_at)
  where status = 'pending';
create index if not exists idx_cloud_file_deletions_org
  on public.cloud_file_deletions (organization_id, status, created_at desc);
create index if not exists idx_cloud_file_deletions_connection
  on public.cloud_file_deletions (connection_id)
  where connection_id is not null;

alter table public.cloud_file_deletions enable row level security;

-- Lezen: wie Inhoud mag lezen, ziet wat er nog in Drive of OneDrive weg moet
-- (het verkennervenster toont het). Schrijven doet alleen de edge function.
drop policy if exists "cloud file deletions read" on public.cloud_file_deletions;
create policy "cloud file deletions read" on public.cloud_file_deletions
  for select to authenticated
  using (organization_id = any ((select public.my_organization_ids())::uuid[]));

-- Alleen de leeskant van de module gate (zoals apply_module_gate hem maakt).
-- Niet de schrijftrigger daarvan: de rijen komen uit de trigger hieronder, in
-- naam van wie er verwijdert, en het verwijderen zelf is al door de module
-- gate op attachments gegaan.
drop policy if exists "module gate select" on public.cloud_file_deletions;
create policy "module gate select" on public.cloud_file_deletions
  as restrictive for select to authenticated
  using (organization_id = any ((select public.my_module_organization_ids('content'))::uuid[]));

revoke insert, update, delete on table public.cloud_file_deletions from anon, authenticated;
select public.apply_accountant_fence('cloud_file_deletions');

-- Per statement met een transitietabel: een map of klant met honderd
-- gekoppelde bestanden is één insert.
create or replace function public.queue_cloud_file_deletions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.cloud_file_deletions
    (organization_id, connection_id, provider, file_id, drive_id, name, attachment_id, requested_by)
  select o.organization_id, o.cloud_connection_id, o.cloud_provider, o.cloud_file_id, o.cloud_drive_id,
         left(coalesce(o.name, ''), 500), o.id, auth.uid()
    from old_rows o
   where o.cloud_provider is not null
     and o.cloud_file_id is not null;
  return null;
end;
$$;

revoke all on function public.queue_cloud_file_deletions() from public, anon, authenticated;

drop trigger if exists attachments_queue_cloud_deletions on public.attachments;
create trigger attachments_queue_cloud_deletions
  after delete on public.attachments
  referencing old table as old_rows
  for each statement execute function public.queue_cloud_file_deletions();

-- Een verwijderde map: dezelfde functie als in 20261106160000, met alleen het
-- segment 'cloud' uitgezonderd van de R2-wachtrij. Een gekoppeld bestand ligt
-- niet in R2; storage_purge_queue_guard liet het al niet toe, maar gaf bij elke
-- verwijderde map met zo'n bestand een waarschuwing. Het bestand zelf gaat via
-- de delete hieronder naar cloud_file_deletions.
create or replace function public.purge_folder_files()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.storage_purge_queue (organization_id, storage_key, reason, purge_after)
  select a.organization_id, a.storage_key, 'folder', now() + interval '1 day'
    from public.attachments a
   where a.entity_type = 'folder'
     and a.entity_id = old.id
     and a.organization_id = old.organization_id
     and a.storage_key is not null
     and a.cloud_provider is null
     and position('..' in a.storage_key) = 0
     and a.storage_key like a.organization_id::text || '/%'
     and not exists (select 1 from public.attachments b where b.storage_key = a.storage_key and b.id <> a.id)
     and not exists (select 1 from public.documents d where d.storage_key = a.storage_key);

  delete from public.attachments a
   where a.entity_type = 'folder'
     and a.entity_id = old.id
     and a.organization_id = old.organization_id;
  return old;
end;
$$;

revoke all on function public.purge_folder_files() from public, anon, authenticated;

-- ── 4. Delen en de klant: een gekoppeld bestand gaat niet mee ─────────────
--
-- Delen loopt via het portaal en de deellink, en die halen het bestand uit
-- R2. Een gekoppeld bestand ligt daar niet; de klant kreeg dan een regel die
-- bij openen "niet gevonden" gaf. Delen doe je met zo'n bestand in Drive of
-- OneDrive zelf.

create or replace function public.drive_share_not_cloud()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.item_type is distinct from 'attachment' or new.revoked_at is not null then
    return new;
  end if;
  if exists (
    select 1 from public.attachments a
     where a.id = new.item_id
       and a.organization_id = new.organization_id
       and a.cloud_provider is not null
  ) then
    raise exception 'Dit bestand staat in Google Drive of OneDrive. Deel het daar; ResoFly kan het niet aan je klant geven.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.drive_share_not_cloud() from public, anon, authenticated;

drop trigger if exists drive_shares_not_cloud on public.drive_shares;
create trigger drive_shares_not_cloud
  before insert or update on public.drive_shares
  for each row execute function public.drive_share_not_cloud();

-- Een gedeelde map: dezelfde functie als in 20260823000000, met alleen
-- "a.cloud_provider is null" erbij in beide bijlage-takken.
create or replace function public.drive_share_items(p_share_id uuid)
returns table (
  item_type text,
  item_id uuid,
  name text,
  mime_type text,
  size_bytes bigint,
  storage_key text,
  modified timestamptz,
  path text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_share  public.drive_shares;
  v_client uuid;
begin
  select * into v_share from public.drive_shares s where s.id = p_share_id;
  if not found then
    return;
  end if;

  -- De klant van de deling, LIVE afgeleid. Elk blad moet bij diezelfde klant
  -- horen; anders zou een submap of een later verplaatste notitie van een ándere
  -- klant meeliften op deze deling.
  select ctx.client_id into v_client
  from public.drive_item_client_safe(v_share.organization_id, v_share.item_type, v_share.item_id) ctx;

  if v_share.item_type = 'folder' then
    return query
    with recursive tree as (
      select f.id, f.name, ''::text as path, 0 as depth
      from public.content_folders f
      where f.id = v_share.item_id and f.organization_id = v_share.organization_id
      union all
      select c.id, c.name, case when t.path = '' then t.name else t.path || ' / ' || t.name end, t.depth + 1
      from public.content_folders c
      join tree t on c.parent_id = t.id
      where t.depth < 20
        and c.organization_id = v_share.organization_id
        and coalesce((select p.client_id from public.projects p where p.id = c.project_id), c.client_id)
            is not distinct from v_client
    )
    select 'attachment'::text, a.id, a.name, a.mime_type, a.size_bytes, a.storage_key,
           a.created_at,
           case when t.path = '' then t.name else t.path || ' / ' || t.name end
    from tree t
    join public.attachments a
      on a.entity_type = 'folder' and a.entity_id = t.id
     and a.organization_id = v_share.organization_id
     and a.cloud_provider is null
    union all
    select 'note'::text, n.id, n.title, 'text/html'::text, 0::bigint, null::text,
           coalesce(n.updated_at, n.created_at),
           case when t.path = '' then t.name else t.path || ' / ' || t.name end
    from tree t
    join public.notes n on n.folder_id = t.id and n.organization_id = v_share.organization_id
     and coalesce((select p.client_id from public.projects p where p.id = n.project_id), n.client_id)
         is not distinct from v_client
    union all
    select 'document'::text, d.id, d.title,
           coalesce(d.mime_type, 'text/html'), coalesce(d.size_bytes, 0)::bigint, d.storage_key,
           coalesce(d.updated_at, d.created_at),
           case when t.path = '' then t.name else t.path || ' / ' || t.name end
    from tree t
    join public.documents d on d.folder_id = t.id and d.organization_id = v_share.organization_id
     and coalesce((select p.client_id from public.projects p where p.id = d.project_id), d.client_id)
         is not distinct from v_client;

  elsif v_share.item_type = 'attachment' then
    return query
    select 'attachment'::text, a.id, a.name, a.mime_type, a.size_bytes, a.storage_key, a.created_at, ''::text
    from public.attachments a
    where a.id = v_share.item_id and a.organization_id = v_share.organization_id
      and a.cloud_provider is null;

  elsif v_share.item_type = 'note' then
    return query
    select 'note'::text, n.id, n.title, 'text/html'::text, 0::bigint, null::text,
           coalesce(n.updated_at, n.created_at), ''::text
    from public.notes n
    where n.id = v_share.item_id and n.organization_id = v_share.organization_id;

  else
    return query
    select 'document'::text, d.id, d.title,
           coalesce(d.mime_type, 'text/html'), coalesce(d.size_bytes, 0)::bigint, d.storage_key,
           coalesce(d.updated_at, d.created_at), ''::text
    from public.documents d
    where d.id = v_share.item_id and d.organization_id = v_share.organization_id;
  end if;
end;
$$;

revoke all on function public.drive_share_items(uuid) from public, anon, authenticated;
grant execute on function public.drive_share_items(uuid) to service_role;

commit;
