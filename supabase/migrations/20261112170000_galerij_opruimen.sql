-- ============================================================
-- ResoFly — Galerij: wat uit de database gaat, gaat ook uit Cloudflare
-- Date: 2026-11-12
--
-- Aanleiding:
-- Een album verwijderen haalde de rijen weg en liet de browser daarna de
-- bestanden in R2 en de video's bij Cloudflare Stream één voor één wissen.
-- Dat ging mis op vier manieren:
--   1. Sloot iemand het tabblad halverwege, of viel er een verzoek weg, dan
--      bleven de bestanden staan. Onzichtbaar, maar wel betaald.
--   2. Een album verdwijnt ook als zijn project of organisatie wordt
--      verwijderd (on delete cascade). Dan kwam er helemaal niemand langs R2
--      en Stream.
--   3. Per bestand een eigen verzoek met eigen controles: bij een album van
--      2.000 foto's waren dat 6.000 verzoeken aan de worker.
--   4. Een mislukte of afgebroken upload laat een bestand achter in de map van
--      het album zonder rij in de database. Dat werd nooit opgeruimd.
--
-- Wat er nu gebeurt:
-- De database legt bij het verwijderen zelf vast wat er weg moet, in
-- gallery_purge_queue. De media-worker werkt die wachtrij af: meteen, als de
-- app hem na het verwijderen aanroept (POST /gallery/purge), en anders via
-- zijn eigen geplande taak.
--   - 'folder': een verwijderd album. De worker wist de hele map
--     {organisatie}/gallery/{album}/ in R2, ook wat daar zonder rij stond.
--     Een tweede ronde een uur later pakt wat er nog binnenkwam terwijl het
--     album werd verwijderd.
--   - 'object': één bestand van een los verwijderd item of een vervangen
--     coverbeeld, terwijl het album zelf blijft.
--   - 'stream': een kijkkopie bij Cloudflare Stream. Die ligt niet in R2, dus
--     de map dekt hem niet.
--
-- Beveiliging (harde regel 1):
-- - organization_id en gallery_id komen uit de verwijderde rij, nooit uit
--   invoer. De sleutels in een rij schrijft de browser zelf; de trigger zet
--   alleen sleutels in de wachtrij die onder de map van dat album liggen, en
--   de check-constraint dwingt dezelfde vorm af. De worker toetst het nog een
--   keer voordat hij iets wist.
-- - Wie mag verwijderen, beslist de database zoals altijd: RLS (can_write_org)
--   plus de modulegate op Projecten. Deze migratie verandert daar niets aan;
--   de wachtrij vult zich alleen met wat werkelijk is verwijderd.
-- - De tabel heeft RLS aan en geen policy: alleen de service-role (de worker)
--   leest en schrijft.
-- ============================================================

begin;

-- ── 1. De wachtrij ─────────────────────────────────────────────────────────

create table if not exists public.gallery_purge_queue (
  id uuid primary key default gen_random_uuid(),
  -- Geen foreign keys: de rij moet een verwijderde organisatie of een
  -- verwijderd album juist overleven.
  organization_id uuid not null,
  gallery_id uuid not null,
  kind text not null,
  target text not null,
  -- Een map gaat twee keer langs (zie de kop); 'passes' telt de rondes.
  passes integer not null default 0,
  purge_after timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  constraint gallery_purge_queue_kind check (kind in ('folder', 'object', 'stream')),
  constraint gallery_purge_queue_target check (
    case kind
      when 'folder' then target = organization_id::text || '/gallery/' || gallery_id::text || '/'
      when 'object' then position('..' in target) = 0
        and target like organization_id::text || '/gallery/' || gallery_id::text || '/_%'
      when 'stream' then target ~ '^[a-f0-9]{32}$'
      else false
    end
  )
);

create unique index if not exists gallery_purge_queue_unique
  on public.gallery_purge_queue (organization_id, kind, target);
create index if not exists gallery_purge_queue_due
  on public.gallery_purge_queue (purge_after);
create index if not exists gallery_purge_queue_gallery
  on public.gallery_purge_queue (organization_id, gallery_id);

alter table public.gallery_purge_queue enable row level security;
revoke all on table public.gallery_purge_queue from anon, authenticated;
select public.apply_accountant_fence('gallery_purge_queue');

-- ── 2. Een album weg: de hele map ──────────────────────────────────────────
--
-- Per statement met een transitietabel: ook een project met twintig albums
-- of een hele organisatie is één insert.

create or replace function public.queue_gallery_folder_purge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.gallery_purge_queue (organization_id, gallery_id, kind, target)
  select o.organization_id, o.id, 'folder', o.organization_id::text || '/gallery/' || o.id::text || '/'
    from old_rows o
  on conflict do nothing;
  return null;
end;
$$;

revoke all on function public.queue_gallery_folder_purge() from public, anon, authenticated;

drop trigger if exists galleries_purge_queue on public.galleries;
create trigger galleries_purge_queue
  after delete on public.galleries
  referencing old table as old_rows
  for each statement execute function public.queue_gallery_folder_purge();

-- ── 3. Een item weg: zijn bestanden en zijn kijkkopie ──────────────────────
--
-- Bestaan het album en de organisatie nog, dan gaan de losse sleutels in de
-- wachtrij. Is het album weg (cascade), dan dekt de map ze al en komt alleen
-- de kijkkopie erbij; bij een verwijderde organisatie kunnen de items vóór
-- de albums aan de beurt zijn, en ook dan doet de map het werk. Een sleutel
-- die nog bij een ander item of als cover van het album in gebruik is, blijft
-- staan. Dat zoeken gebeurt binnen het album: een sleutel onder zijn map hoort
-- nergens anders, en zo gebruikt het de index op gallery_id.

create or replace function public.queue_gallery_item_purge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.gallery_purge_queue (organization_id, gallery_id, kind, target)
  select distinct o.organization_id, o.gallery_id, 'object', k.key
    from old_rows o
    cross join lateral (values (o.storage_key), (o.preview_key), (o.thumb_key)) as k(key)
   where k.key is not null
     and position('..' in k.key) = 0
     and k.key like o.organization_id::text || '/gallery/' || o.gallery_id::text || '/_%'
     and exists (select 1 from public.galleries g where g.id = o.gallery_id)
     and exists (select 1 from public.organizations org where org.id = o.organization_id)
     and not exists (
       select 1 from public.gallery_items gi
        where gi.gallery_id = o.gallery_id
          and (gi.storage_key = k.key or gi.preview_key = k.key or gi.thumb_key = k.key))
     and not exists (
       select 1 from public.galleries g
        where g.id = o.gallery_id and (g.cover_preview_key = k.key or g.cover_thumb_key = k.key))
  on conflict do nothing;

  insert into public.gallery_purge_queue (organization_id, gallery_id, kind, target)
  select distinct on (o.stream_uid) o.organization_id, o.gallery_id, 'stream', o.stream_uid
    from old_rows o
   where o.stream_uid ~ '^[a-f0-9]{32}$'
     and not exists (select 1 from public.gallery_items gi where gi.stream_uid = o.stream_uid)
  on conflict do nothing;

  return null;
end;
$$;

revoke all on function public.queue_gallery_item_purge() from public, anon, authenticated;

drop trigger if exists gallery_items_purge_queue on public.gallery_items;
create trigger gallery_items_purge_queue
  after delete on public.gallery_items
  referencing old table as old_rows
  for each statement execute function public.queue_gallery_item_purge();

-- ── 4. Een ander coverbeeld: het oude eigen beeld ──────────────────────────

create or replace function public.queue_gallery_cover_purge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text := old.organization_id::text || '/gallery/' || old.id::text || '/';
  v_key text;
begin
  foreach v_key in array array[old.cover_preview_key, old.cover_thumb_key] loop
    continue when v_key is null
      or v_key is not distinct from new.cover_preview_key
      or v_key is not distinct from new.cover_thumb_key
      or position('..' in v_key) > 0
      or v_key not like v_prefix || '_%';
    continue when exists (
      select 1 from public.gallery_items gi
       where gi.gallery_id = old.id
         and (gi.storage_key = v_key or gi.preview_key = v_key or gi.thumb_key = v_key));
    insert into public.gallery_purge_queue (organization_id, gallery_id, kind, target)
    values (old.organization_id, old.id, 'object', v_key)
    on conflict do nothing;
  end loop;
  return null;
end;
$$;

revoke all on function public.queue_gallery_cover_purge() from public, anon, authenticated;

drop trigger if exists galleries_cover_purge_queue on public.galleries;
create trigger galleries_cover_purge_queue
  after update of cover_preview_key, cover_thumb_key on public.galleries
  for each row
  when (old.cover_preview_key is distinct from new.cover_preview_key
        or old.cover_thumb_key is distinct from new.cover_thumb_key)
  execute function public.queue_gallery_cover_purge();

commit;
