-- ============================================================
-- Databasetest: verwijzingen in een pagina (20261127150000, stap 1A-4b)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: een pagina verwijst met een id naar een afbeelding, een bestand of
-- een subpagina. Wie een id van een andere organisatie of een ander dossier in
-- body zette, kreeg die verwijzing erdoor, en de editor liet dan de naam zien.
-- Deze test:
--
--   1. laat toe: een afbeelding van de pagina zelf, een bestand uit hetzelfde
--      dossier, een subpagina, en een verwijzing naar iets dat niet meer bestaat;
--   2. weigert: een bestand uit een ander dossier of een andere organisatie, een
--      subpagina van een andere organisatie, een tekstdocument als subpagina,
--      en de pagina als haar eigen subpagina; ook bij een nieuwe pagina;
--   3. kijkt alleen nieuwe verwijzingen na: verhuist een bestand later naar een
--      ander dossier, dan kun je de pagina gewoon verder bewerken.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

select gen_random_uuid() as eigenaar, gen_random_uuid() as eigenaar_b \gset
insert into auth.users (id, email, aud, role) values
  (:'eigenaar',   'eigenaar@verwijzingen.test',   'authenticated', 'authenticated'),
  (:'eigenaar_b', 'eigenaar-b@verwijzingen.test', 'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Verwijzing')).id as org \gset
reset role;
select pg_temp.als(:'eigenaar_b');
set local role authenticated;
select (public.create_organization('Bureau Elders')).id as org_b \gset
reset role;
select pg_temp.beheer();

insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org', :'eigenaar', 'Klant Een', 'een@verwijzingen.test', 'business') returning id as klant1 \gset
insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org', :'eigenaar', 'Klant Twee', 'twee@verwijzingen.test', 'business') returning id as klant2 \gset
insert into public.content_folders (organization_id, client_id, name) values (:'org', :'klant1', 'Stukken') returning id as map1 \gset
insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org_b', :'eigenaar_b', 'Klant Elders', 'elders@verwijzingen.test', 'business') returning id as klant_b \gset

select set_config('test.eigenaar', :'eigenaar', true), set_config('test.org', :'org', true);

-- Schrijven zoals de app: ingelogd, onder RLS.
create function pg_temp.nieuw(p_body jsonb, p_client uuid, p_parent uuid default null) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.als(current_setting('test.eigenaar')::uuid);
  set local role authenticated;
  insert into public.documents (organization_id, created_by, title, format, body, client_id, parent_id)
  values (current_setting('test.org')::uuid, current_setting('test.eigenaar')::uuid, 'Verwijzing', 'page', p_body, p_client, p_parent)
  returning id into v;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

create function pg_temp.zet(p_page uuid, p_body jsonb) returns void language plpgsql as $$
begin
  perform pg_temp.als(current_setting('test.eigenaar')::uuid);
  set local role authenticated;
  update public.documents set body = p_body where id = p_page;
  reset role;
  perform pg_temp.beheer();
end $$;

-- Een body met één blok dat verwijst, plus een alinea met tekst.
create function pg_temp.met(p_type text, p_attr text, p_id uuid, p_tekst text default 'tekst') returns jsonb language sql as $$
  select jsonb_build_object('type', 'doc', 'content', jsonb_build_array(
    jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_tekst))),
    jsonb_build_object('type', p_type, 'attrs', jsonb_build_object(p_attr, p_id::text))));
$$;

create function pg_temp.bijlage(p_org uuid, p_type text, p_entity uuid) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
  values (p_org, p_type, p_entity, 'foto.png', 'image/png', 10, p_org::text || '/' || p_type || '/' || p_entity::text || '/' || gen_random_uuid()::text || '-foto.png')
  returning id into v;
  return v;
end $$;

-- De pagina in het dossier van klant 1, en de bijlagen.
select pg_temp.nieuw('{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb, :'klant1') as pagina \gset
select pg_temp.bijlage(:'org', 'document', :'pagina') as eigen_foto \gset
select pg_temp.bijlage(:'org', 'folder', :'map1') as dossier_bestand \gset
select pg_temp.bijlage(:'org', 'client', :'klant2') as ander_dossier \gset
select pg_temp.bijlage(:'org_b', 'client', :'klant_b') as andere_org \gset
insert into public.documents (organization_id, created_by, title, content, client_id)
values (:'org', :'eigenaar', 'Oud document', '<p>oud</p>', :'klant1') returning id as tekstdocument \gset
select pg_temp.als(:'eigenaar_b');
set local role authenticated;
insert into public.documents (organization_id, created_by, title, format, body)
values (:'org_b', :'eigenaar_b', 'Elders', 'page', '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb) returning id as pagina_b \gset
reset role;
select pg_temp.beheer();

-- ── 1. Wat mag ──────────────────────────────────────────────────────────────
select pg_temp.zet(:'pagina', pg_temp.met('image', 'attachmentId', :'eigen_foto'));
select pg_temp.gelijk((select body->'content'->1->'attrs'->>'attachmentId' from public.documents where id = :'pagina'), :'eigen_foto', 'een afbeelding van de pagina zelf');
select pg_temp.zet(:'pagina', pg_temp.met('fileBlock', 'attachmentId', :'dossier_bestand'));
select pg_temp.gelijk((select body->'content'->1->>'type' from public.documents where id = :'pagina'), 'fileBlock', 'een bestand uit hetzelfde dossier');
select pg_temp.nieuw('{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb, null, :'pagina') as kind \gset
select pg_temp.zet(:'pagina', pg_temp.met('subpage', 'pageId', :'kind'));
select pg_temp.gelijk((select body->'content'->1->'attrs'->>'pageId' from public.documents where id = :'pagina'), :'kind', 'een subpagina');
select pg_temp.zet(:'pagina', pg_temp.met('image', 'attachmentId', gen_random_uuid()));
select pg_temp.gelijk((select body->'content'->1->>'type' from public.documents where id = :'pagina'), 'image',
  'een verwijzing naar iets dat niet meer bestaat (een oude versie terugzetten)');

-- ── 2. Wat niet mag ─────────────────────────────────────────────────────────
select pg_temp.weigert(format('select pg_temp.zet(%L, pg_temp.met(%L, %L, %L))', :'pagina', 'image', 'attachmentId', :'ander_dossier'),
  'uit een ander dossier', 'een afbeelding uit het dossier van een andere klant');
select pg_temp.weigert(format('select pg_temp.zet(%L, pg_temp.met(%L, %L, %L))', :'pagina', 'fileBlock', 'attachmentId', :'andere_org'),
  'hoort niet bij deze organisatie', 'een bestand van een andere organisatie');
select pg_temp.weigert(format('select pg_temp.zet(%L, pg_temp.met(%L, %L, %L))', :'pagina', 'subpage', 'pageId', :'pagina_b'),
  'andere pagina van deze organisatie', 'een subpagina van een andere organisatie');
select pg_temp.weigert(format('select pg_temp.zet(%L, pg_temp.met(%L, %L, %L))', :'pagina', 'subpage', 'pageId', :'tekstdocument'),
  'andere pagina van deze organisatie', 'een tekstdocument als subpagina');
select pg_temp.weigert(format('select pg_temp.zet(%L, pg_temp.met(%L, %L, %L))', :'pagina', 'subpage', 'pageId', :'pagina'),
  'andere pagina van deze organisatie', 'de pagina als haar eigen subpagina');
select pg_temp.weigert(format('select pg_temp.nieuw(pg_temp.met(%L, %L, %L), %L)', 'image', 'attachmentId', :'ander_dossier', :'klant1'),
  'uit een ander dossier', 'ook bij een nieuwe pagina');
-- Een pagina zonder klant neemt geen bestand uit een klantdossier.
select pg_temp.weigert(format('select pg_temp.nieuw(pg_temp.met(%L, %L, %L), null)', 'fileBlock', 'attachmentId', :'dossier_bestand'),
  'uit een ander dossier', 'een bestand van klant 1 in een pagina zonder klant');

-- ── 3. Alleen nieuwe verwijzingen ───────────────────────────────────────────
select pg_temp.zet(:'pagina', pg_temp.met('fileBlock', 'attachmentId', :'dossier_bestand', 'eerst'));
-- Het bestand verhuist naar het dossier van klant 2.
update public.attachments set entity_type = 'client', entity_id = :'klant2' where id = :'dossier_bestand';
select pg_temp.zet(:'pagina', pg_temp.met('fileBlock', 'attachmentId', :'dossier_bestand', 'daarna'));
select pg_temp.gelijk((select content from public.documents where id = :'pagina'), 'daarna',
  'een bestaande verwijzing houdt verder bewerken niet tegen');

\o
\echo Alle controles van paginas_verwijzingen.sql geslaagd.
rollback;
