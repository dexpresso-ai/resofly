-- ============================================================
-- ResoFly — Een kopie van Inhoud in OneDrive
-- Date: 2026-11-24
--
-- Plan en keuzes: docs/plannen/ONEDRIVE_KOPIE_PLAN_2026-11-24.md.
--
-- Wat er kan:
-- De eigenaar van een organisatie koppelt zijn OneDrive en zet de kopie aan.
-- ResoFly blijft de bestanden zelf bewaren (R2) en houdt daarnaast een kopie
-- bij in één map in die OneDrive: klant, project, dossiermap, bestand. Wat er
-- in ResoFly gebeurt (uploaden, hernoemen, verplaatsen, bewerken in de editor,
-- verwijderen), gebeurt daar ook. ResoFly is leidend: wat iemand in OneDrive
-- zelf doet, neemt ResoFly niet over.
--
-- Wat er meegaat: bestanden in een dossiermap (attachments met entity_type
-- 'folder') en Word/Excel/PowerPoint-documenten in Inhoud (documents met een
-- storage_key). Niet: notities, tekstdocumenten, financiële stukken, de
-- galerij en zendingen. Die laatste drie bewaart ResoFly; in OneDrive kan
-- iemand ze wissen, en dan kan ResoFly de bewaarplicht niet meer waarmaken.
--
-- Hoe:
--   1. onedrive_mirrors (+ _tokens): de koppeling van de organisatie, door de
--      eigenaar. De tokens staan versleuteld; alleen de edge function
--      onedrive-sync leest ze.
--   2. onedrive_sync_jobs: wat er in OneDrive moet gebeuren. Triggers zetten
--      er een taak in bij elke wijziging, ook bij een cascade (een verwijderde
--      klant), zolang de kopie aanstaat. Per item één rij: een tweede wijziging
--      voor hetzelfde item vervangt de eerste. De edge function rekent bij het
--      afwerken uit hoe het er in OneDrive uit moet zien.
--   3. onedrive_sync_items: welk item in OneDrive bij welk item in ResoFly
--      hoort. Hernoemen en verplaatsen werken op dat id, ook als de naam in
--      OneDrive inmiddels anders is.
--
-- Beveiliging:
-- - Harde regel 1: organization_id komt uit de rij, nooit uit invoer. Alle
--   tabellen hebben RLS aan; schrijven doet alleen de service-role.
-- - Harde regel 3: in OneDrive gelden de modulerechten van ResoFly niet. Wie
--   bij die map kan, ziet alle bestanden erin. Daarom alleen de eigenaar, en
--   zegt het scherm het bij het aanzetten.
-- - Vertrekt de eigenaar, of is hij geen eigenaar meer, dan gaat de kopie uit
--   en zijn token weg (onedrive_mirror_on_member_change).
--
-- Veilig om meermaals te draaien.
-- ============================================================

begin;

-- ── 1. De koppeling van de organisatie ─────────────────────────────────────

create table if not exists public.onedrive_mirrors (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- De eigenaar die koppelde. Verwijder je zijn account, dan gaat de koppeling mee.
  connected_by uuid not null references auth.users(id) on delete cascade,
  account_id text not null,
  account_email text,
  display_name text,
  drive_id text,
  root_item_id text,
  root_name text,
  root_web_url text,
  enabled boolean not null default false,
  -- active: werkt · expired: opnieuw koppelen nodig · error: iets anders (OneDrive vol, instelling)
  status text not null default 'active' check (status in ('active', 'expired', 'error')),
  scopes text[] not null default '{}',
  last_error text,
  last_synced_at timestamptz,
  enabled_at timestamptz,
  -- Wie de wachtrij van deze organisatie nu afwerkt, tot wanneer (zie
  -- onedrive_lock_org). Eén ronde tegelijk per organisatie.
  processing_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint onedrive_mirrors_enabled_has_root check (not enabled or (drive_id is not null and root_item_id is not null))
);

alter table public.onedrive_mirrors add column if not exists processing_until timestamptz;

drop trigger if exists onedrive_mirrors_updated on public.onedrive_mirrors;
create trigger onedrive_mirrors_updated
  before update on public.onedrive_mirrors
  for each row execute function public.set_updated_at();

create table if not exists public.onedrive_mirror_tokens (
  organization_id uuid primary key references public.onedrive_mirrors(organization_id) on delete cascade,
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  token_type text,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

drop trigger if exists onedrive_mirror_tokens_updated on public.onedrive_mirror_tokens;
create trigger onedrive_mirror_tokens_updated
  before update on public.onedrive_mirror_tokens
  for each row execute function public.set_updated_at();

alter table public.onedrive_mirrors enable row level security;
alter table public.onedrive_mirror_tokens enable row level security;

-- Wie Inhoud mag lezen, ziet óf er een kopie in OneDrive staat (de verkenner
-- zegt het, en de bevestiging bij verwijderen), en de link naar de map. Niet
-- welk Microsoft-account de eigenaar koppelde, of wat er misging: dat is voor
-- de eigenaar, en die leest het via de edge function. Daarom kolomrechten:
-- eerst kon elk teamlid met Inhoud, ook een kijker, de hele rij lezen, met het
-- adres en de id's van het account van de eigenaar (review van 24 november).
-- Schrijven doet de edge function.
drop policy if exists "onedrive mirrors read" on public.onedrive_mirrors;
create policy "onedrive mirrors read" on public.onedrive_mirrors
  for select to authenticated
  using (organization_id = any ((select public.my_module_organization_ids('content'))::uuid[]));

revoke all on table public.onedrive_mirrors from anon, authenticated;
grant select (organization_id, enabled, status, root_web_url) on public.onedrive_mirrors to authenticated;
revoke all on table public.onedrive_mirror_tokens from anon, authenticated;
select public.apply_accountant_fence('onedrive_mirrors');
select public.apply_accountant_fence('onedrive_mirror_tokens');

-- ── 2. Welk item in OneDrive bij welk item in ResoFly hoort ───────────────
--
-- Geen foreign keys: een delete-taak heeft de koppeling nog nodig als het item
-- in ResoFly al weg is, en bij een verwijderde organisatie ruimt de geplande
-- taak de rest op.

create table if not exists public.onedrive_sync_items (
  organization_id uuid not null,
  -- root en noclient zijn de map van de organisatie en "Zonder klant"; hun
  -- item_id is het id van de organisatie.
  item_type text not null check (item_type in ('noclient', 'client', 'project', 'folder', 'attachment', 'document')),
  item_id uuid not null,
  drive_item_id text not null,
  parent_drive_item_id text,
  -- name: zoals het in OneDrive heet. desired_name: wat ResoFly vroeg. Die
  -- verschillen als OneDrive er " (2)" achter zette omdat de naam al bestond;
  -- zonder het onderscheid probeerde elke ronde opnieuw te hernoemen.
  name text not null,
  desired_name text not null,
  content_version text,
  -- cTag van OneDrive na onze laatste upload: zo ziet "Alles opnieuw kopiëren"
  -- of iemand het bestand in OneDrive heeft veranderd.
  remote_tag text,
  synced_at timestamptz not null default now(),
  primary key (organization_id, item_type, item_id)
);

alter table public.onedrive_sync_items enable row level security;
revoke all on table public.onedrive_sync_items from anon, authenticated;
select public.apply_accountant_fence('onedrive_sync_items');

-- ── 3. De wachtrij ─────────────────────────────────────────────────────────

create table if not exists public.onedrive_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  item_type text not null check (item_type in ('client', 'project', 'folder', 'attachment', 'document')),
  item_id uuid not null,
  kind text not null check (kind in ('sync', 'delete')),
  -- Bij "Alles opnieuw kopiëren": in OneDrive kijken of het er nog is en of
  -- het niet is veranderd, in plaats van op de eigen administratie te vertrouwen.
  verify boolean not null default false,
  -- Telt op bij elke nieuwe wijziging. Wie een taak afwerkt, haalt hem alleen
  -- weg als er intussen niets nieuws bij kwam; anders loopt hij nog een keer.
  seq bigint not null default 1,
  status text not null default 'pending' check (status in ('pending', 'failed')),
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  -- Wie hem nu afwerkt, tot wanneer. De app en de geplande taak kunnen
  -- tegelijk lopen; zonder dit uploadden ze hetzelfde bestand twee keer.
  claimed_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, item_type, item_id)
);

create index if not exists idx_onedrive_sync_jobs_due
  on public.onedrive_sync_jobs (next_attempt_at)
  where status = 'pending';
create index if not exists idx_onedrive_sync_jobs_org
  on public.onedrive_sync_jobs (organization_id, status);

alter table public.onedrive_sync_jobs enable row level security;
revoke all on table public.onedrive_sync_jobs from anon, authenticated;
select public.apply_accountant_fence('onedrive_sync_jobs');

-- Eén taak per item: een nieuwe wijziging vervangt wat er stond. Alleen als de
-- kopie voor deze organisatie aanstaat.
create or replace function public.onedrive_enqueue(p_org uuid, p_type text, p_id uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_org is null or p_id is null then
    return;
  end if;
  if not exists (select 1 from public.onedrive_mirrors m where m.organization_id = p_org and m.enabled) then
    return;
  end if;
  insert into public.onedrive_sync_jobs (organization_id, item_type, item_id, kind)
  values (p_org, p_type, p_id, p_kind)
  on conflict (organization_id, item_type, item_id) do update
     set kind = excluded.kind,
         seq = public.onedrive_sync_jobs.seq + 1,
         status = 'pending',
         attempts = 0,
         last_error = null,
         next_attempt_at = now(),
         updated_at = now();
end;
$$;

revoke all on function public.onedrive_enqueue(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.onedrive_enqueue(uuid, text, uuid, text) to service_role;

-- ── 4. De triggers ─────────────────────────────────────────────────────────

-- Bestanden in een dossiermap. Een bestand dat uit een map verdwijnt (naar een
-- taak of project verplaatst), gaat in OneDrive weg.
create or replace function public.onedrive_track_attachments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.entity_type = 'folder' then
      perform public.onedrive_enqueue(new.organization_id, 'attachment', new.id, 'sync');
    end if;
  elsif tg_op = 'DELETE' then
    if old.entity_type = 'folder' then
      perform public.onedrive_enqueue(old.organization_id, 'attachment', old.id, 'delete');
    end if;
  elsif new.entity_type = 'folder' then
    if new.name is distinct from old.name
       or new.entity_type is distinct from old.entity_type
       or new.entity_id is distinct from old.entity_id
       or new.storage_key is distinct from old.storage_key
       or new.size_bytes is distinct from old.size_bytes
       or new.edit_version is distinct from old.edit_version then
      perform public.onedrive_enqueue(new.organization_id, 'attachment', new.id, 'sync');
    end if;
  elsif old.entity_type = 'folder' then
    perform public.onedrive_enqueue(old.organization_id, 'attachment', old.id, 'delete');
  end if;
  return null;
end;
$$;

revoke all on function public.onedrive_track_attachments() from public, anon, authenticated;

drop trigger if exists attachments_onedrive on public.attachments;
create trigger attachments_onedrive
  after insert or update or delete on public.attachments
  for each row execute function public.onedrive_track_attachments();

-- Word/Excel/PowerPoint-documenten (een document met een bestand). Een
-- tekstdocument heeft geen storage_key en gaat niet mee.
create or replace function public.onedrive_track_documents()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.storage_key is not null then
      perform public.onedrive_enqueue(new.organization_id, 'document', new.id, 'sync');
    end if;
  elsif tg_op = 'DELETE' then
    if old.storage_key is not null then
      perform public.onedrive_enqueue(old.organization_id, 'document', old.id, 'delete');
    end if;
  elsif new.storage_key is not null then
    if new.title is distinct from old.title
       or new.storage_key is distinct from old.storage_key
       or new.mime_type is distinct from old.mime_type
       or new.client_id is distinct from old.client_id
       or new.project_id is distinct from old.project_id
       or new.folder_id is distinct from old.folder_id
       or new.size_bytes is distinct from old.size_bytes
       or new.edit_version is distinct from old.edit_version then
      perform public.onedrive_enqueue(new.organization_id, 'document', new.id, 'sync');
    end if;
  elsif old.storage_key is not null then
    perform public.onedrive_enqueue(old.organization_id, 'document', old.id, 'delete');
  end if;
  return null;
end;
$$;

revoke all on function public.onedrive_track_documents() from public, anon, authenticated;

drop trigger if exists documents_onedrive on public.documents;
create trigger documents_onedrive
  after insert or update or delete on public.documents
  for each row execute function public.onedrive_track_documents();

-- Mappen, klanten en projecten: alleen hernoemen, verplaatsen en verwijderen.
-- Een nieuwe map maakt de edge function pas aan als er een bestand in komt;
-- anders stonden er honderden lege klantmappen in OneDrive.
create or replace function public.onedrive_track_containers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text := tg_argv[0];
begin
  if tg_op = 'DELETE' then
    perform public.onedrive_enqueue(old.organization_id, v_type, old.id, 'delete');
    return null;
  end if;
  if v_type = 'client' then
    if new.name is distinct from old.name then
      perform public.onedrive_enqueue(new.organization_id, v_type, new.id, 'sync');
    end if;
  elsif v_type = 'project' then
    if new.name is distinct from old.name or new.client_id is distinct from old.client_id then
      perform public.onedrive_enqueue(new.organization_id, v_type, new.id, 'sync');
    end if;
  elsif new.name is distinct from old.name
     or new.parent_id is distinct from old.parent_id
     or new.client_id is distinct from old.client_id
     or new.project_id is distinct from old.project_id then
    perform public.onedrive_enqueue(new.organization_id, v_type, new.id, 'sync');
  end if;
  return null;
end;
$$;

revoke all on function public.onedrive_track_containers() from public, anon, authenticated;

drop trigger if exists content_folders_onedrive on public.content_folders;
create trigger content_folders_onedrive
  after update or delete on public.content_folders
  for each row execute function public.onedrive_track_containers('folder');

drop trigger if exists clients_onedrive on public.clients;
create trigger clients_onedrive
  after update or delete on public.clients
  for each row execute function public.onedrive_track_containers('client');

drop trigger if exists projects_onedrive on public.projects;
create trigger projects_onedrive
  after update or delete on public.projects
  for each row execute function public.onedrive_track_containers('project');

-- ── 5. De eigenaar vertrekt of is geen eigenaar meer ──────────────────────
--
-- Dan staat de kopie uit en is zijn token weg, net als bij de agenda
-- (disable_integrations_on_member_exit). Wat er in OneDrive staat, blijft.
create or replace function public.onedrive_mirror_on_member_change()
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
  elsif old.status = 'active' and old.role = 'owner'
        and (new.status is distinct from 'active' or new.role is distinct from 'owner') then
    v_org := new.organization_id;
    v_user := new.user_id;
  else
    return new;
  end if;

  if exists (select 1 from public.onedrive_mirrors m where m.organization_id = v_org and m.connected_by = v_user) then
    update public.onedrive_mirrors
       set enabled = false,
           status = 'expired',
           last_error = 'Uitgezet: wie OneDrive koppelde, is geen eigenaar van deze organisatie meer. Een eigenaar kan opnieuw koppelen.'
     where organization_id = v_org;
    delete from public.onedrive_mirror_tokens where organization_id = v_org;
    delete from public.onedrive_sync_jobs where organization_id = v_org;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.onedrive_mirror_on_member_change() from public, anon, authenticated;

drop trigger if exists organization_members_onedrive on public.organization_members;
create trigger organization_members_onedrive
  after delete or update of status, role on public.organization_members
  for each row execute function public.onedrive_mirror_on_member_change();

-- ── 6. "Alles opnieuw kopiëren" ───────────────────────────────────────────
--
-- Zet voor elk bestand en document dat meegaat een taak klaar die in OneDrive
-- controleert of het er nog is en niet is veranderd. Alleen de edge function
-- roept dit aan, na de controle dat de aanvrager eigenaar is.
create or replace function public.onedrive_queue_full_sync(p_org uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_rows integer;
begin
  if not exists (select 1 from public.onedrive_mirrors m where m.organization_id = p_org and m.enabled) then
    return 0;
  end if;

  insert into public.onedrive_sync_jobs (organization_id, item_type, item_id, kind, verify)
  select a.organization_id, 'attachment', a.id, 'sync', true
    from public.attachments a
   where a.organization_id = p_org and a.entity_type = 'folder'
  on conflict (organization_id, item_type, item_id) do update
     set kind = 'sync', verify = true, seq = public.onedrive_sync_jobs.seq + 1, status = 'pending',
         attempts = 0, last_error = null, next_attempt_at = now(), updated_at = now();
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  insert into public.onedrive_sync_jobs (organization_id, item_type, item_id, kind, verify)
  select d.organization_id, 'document', d.id, 'sync', true
    from public.documents d
   where d.organization_id = p_org and d.storage_key is not null
  on conflict (organization_id, item_type, item_id) do update
     set kind = 'sync', verify = true, seq = public.onedrive_sync_jobs.seq + 1, status = 'pending',
         attempts = 0, last_error = null, next_attempt_at = now(), updated_at = now();
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  return v_count;
end;
$$;

revoke all on function public.onedrive_queue_full_sync(uuid) from public, anon, authenticated;
grant execute on function public.onedrive_queue_full_sync(uuid) to service_role;

-- ── 7. Taken oppakken en opruimen (alleen de edge function) ───────────────
--
-- Eén ronde tegelijk per organisatie. De app (na een wijziging), het scherm
-- Instellingen → OneDrive en de geplande taak kunnen tegelijk lopen. Twee
-- rondes die elk een ontbrekende klantmap aanmaakten, gaven in OneDrive
-- "Acme" én "Acme 1", met de helft van de bestanden in elk (review van
-- 24 november). Daarom pakt een ronde eerst de organisatie (processing_until),
-- en laat hij hem los als hij klaar is. Valt hij halverwege om, dan verloopt
-- de greep vanzelf.
create or replace function public.onedrive_lock_org(p_org uuid, p_lease_seconds integer default 900, p_exclude uuid[] default '{}')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select m.organization_id into v_org
    from public.onedrive_mirrors m
   where m.enabled
     and m.status = 'active'
     and (m.processing_until is null or m.processing_until < now())
     and (p_org is null or m.organization_id = p_org)
     and not (m.organization_id = any (coalesce(p_exclude, '{}')))
     and exists (
       select 1 from public.onedrive_sync_jobs j
        where j.organization_id = m.organization_id
          and j.status = 'pending'
          and j.next_attempt_at <= now()
          and (j.claimed_until is null or j.claimed_until < now()))
   order by m.last_synced_at nulls first
   limit 1
   for update of m skip locked;
  if v_org is null then
    return null;
  end if;
  update public.onedrive_mirrors
     set processing_until = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 900), 1800)))
   where organization_id = v_org;
  return v_org;
end;
$$;

revoke all on function public.onedrive_lock_org(uuid, integer, uuid[]) from public, anon, authenticated;
grant execute on function public.onedrive_lock_org(uuid, integer, uuid[]) to service_role;

create or replace function public.onedrive_unlock_org(p_org uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.onedrive_mirrors set processing_until = null where organization_id = p_org;
$$;

revoke all on function public.onedrive_unlock_org(uuid) from public, anon, authenticated;
grant execute on function public.onedrive_unlock_org(uuid) to service_role;

-- De taken van één organisatie oppakken (de ronde heeft die organisatie al
-- vast). Wat gewone wijzigingen zijn, gaat vóór het verwijderen. Een klant,
-- project of map gaat pas weg als er voor deze organisatie geen enkele
-- wijziging meer wacht: verhuisde er net een submap uit een map die daarna
-- werd verwijderd, en moest die verhuizing even wachten (Microsoft vroeg om
-- geduld), dan ging de submap anders met de map mee naar de prullenbak
-- (review van 24 november). Losse bestanden wachten niet: die nemen niets mee.
create or replace function public.onedrive_claim_jobs(p_org uuid, p_limit integer, p_lease_seconds integer default 900)
returns setof public.onedrive_sync_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_org is null then
    return;
  end if;
  return query
  with due as (
    select j.id
      from public.onedrive_sync_jobs j
      join public.onedrive_mirrors m
        on m.organization_id = j.organization_id and m.enabled and m.status = 'active'
     where j.organization_id = p_org
       and j.status = 'pending'
       and j.next_attempt_at <= now()
       and (j.claimed_until is null or j.claimed_until < now())
       and not (
         j.kind = 'delete'
         and j.item_type in ('client', 'project', 'folder')
         and exists (
           select 1 from public.onedrive_sync_jobs s
            where s.organization_id = j.organization_id
              and s.kind = 'sync'
              and s.status = 'pending'))
     order by (j.kind = 'delete'), j.next_attempt_at
     limit greatest(1, least(coalesce(p_limit, 25), 200))
     for update of j skip locked
  )
  update public.onedrive_sync_jobs j
     set claimed_until = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 900), 1800)))
    from due
   where j.id = due.id
  returning j.*;
end;
$$;

revoke all on function public.onedrive_claim_jobs(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.onedrive_claim_jobs(uuid, integer, integer) to service_role;

-- Taken van een organisatie zonder kopie (uitgezet, ontkoppeld, of de
-- organisatie is weg) en koppelingen van een organisatie zonder koppeling.
create or replace function public.onedrive_cleanup()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.onedrive_sync_jobs j
   where not exists (select 1 from public.onedrive_mirrors m where m.organization_id = j.organization_id and m.enabled);
  delete from public.onedrive_sync_items i
   where not exists (select 1 from public.onedrive_mirrors m where m.organization_id = i.organization_id);
end;
$$;

revoke all on function public.onedrive_cleanup() from public, anon, authenticated;
grant execute on function public.onedrive_cleanup() to service_role;

commit;
