-- ============================================================
-- Databasetest: de bijlagen van een gedeelde pagina (20261128140000, stap 1C-4)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: het portaal toont de afbeeldingen en bestandsnamen uit de gedeelde
-- versie. Die versie ligt vast, maar een bestand kan daarna naar het dossier
-- van een andere klant verhuizen. Dan hoort de klant het niet meer te zien.
-- Deze test:
--
--   1. geeft de afbeelding en het bestand uit de gedeelde versie;
--   2. laat een bestand weg dat sindsdien naar een andere klant verhuisde;
--   3. geeft niets bij een ingetrokken of verlopen deling, of een pagina in de
--      prullenbak;
--   4. is niet aan te roepen door een ingelogde gebruiker.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

select gen_random_uuid() as eigenaar \gset
insert into auth.users (id, email, aud, role) values (:'eigenaar', 'eigenaar@bijlagen.test', 'authenticated', 'authenticated');
select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Bijlagen')).id as org \gset
reset role;
select pg_temp.beheer();

insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org', :'eigenaar', 'Klant Een', 'een@bijlagen.test', 'business') returning id as klant1 \gset
insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org', :'eigenaar', 'Klant Twee', 'twee@bijlagen.test', 'business') returning id as klant2 \gset
insert into public.content_folders (organization_id, client_id, name) values (:'org', :'klant1', 'Stukken') returning id as map1 \gset
insert into public.content_folders (organization_id, client_id, name) values (:'org', :'klant2', 'Elders') returning id as map2 \gset

create function pg_temp.bijlage(p_org uuid, p_type text, p_entity uuid, p_naam text) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
  values (p_org, p_type, p_entity, p_naam, 'image/png', 10, p_org::text || '/' || p_type || '/' || p_entity::text || '/' || gen_random_uuid()::text || '-' || p_naam)
  returning id into v;
  return v;
end $$;

create function pg_temp.zichtbaar(p_share uuid) returns text language sql as $$
  select coalesce(string_agg(b.kind || ':' || b.name, ',' order by b.kind, b.name), '')
  from public.shared_page_attachments(p_share) b;
$$;

-- Een pagina bij klant 1, met een eigen afbeelding en een bestand uit de map van klant 1.
select pg_temp.als(:'eigenaar');
set local role authenticated;
insert into public.documents (organization_id, created_by, title, format, body, client_id)
values (:'org', :'eigenaar', 'Werkwijze', 'page', '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb, :'klant1') returning id as pagina \gset
reset role;
select pg_temp.beheer();
select pg_temp.bijlage(:'org', 'document', :'pagina', 'plattegrond.png') as foto \gset
select pg_temp.bijlage(:'org', 'folder', :'map1', 'offerte.pdf') as bestand \gset

select pg_temp.als(:'eigenaar');
set local role authenticated;
update public.documents set body = jsonb_build_object('type', 'doc', 'content', jsonb_build_array(
  jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'Zie hieronder.'))),
  jsonb_build_object('type', 'image', 'attrs', jsonb_build_object('attachmentId', :'foto', 'alt', 'Plattegrond')),
  jsonb_build_object('type', 'fileBlock', 'attrs', jsonb_build_object('attachmentId', :'bestand'))))
where id = :'pagina';
select (public.save_page_version(:'pagina', 'vrijgave')).id as versie \gset
insert into public.drive_shares (organization_id, created_by, item_type, item_id, item_name, recipient_kind, document_version_id)
values (:'org', :'eigenaar', 'document', :'pagina', 'Werkwijze', 'client', :'versie') returning id as deling \gset
reset role;
select pg_temp.beheer();

-- ── 1. De bijlagen uit de gedeelde versie ───────────────────────────────────
select pg_temp.gelijk(pg_temp.zichtbaar(:'deling'), 'fileBlock:offerte.pdf,image:plattegrond.png', 'de afbeelding en het bestand');

-- ── 2. Een bestand dat naar een andere klant verhuisde ──────────────────────
update public.attachments set entity_id = :'map2' where id = :'bestand';
select pg_temp.gelijk(pg_temp.zichtbaar(:'deling'), 'image:plattegrond.png', 'een bestand bij een andere klant komt niet mee');
update public.attachments set entity_id = :'map1' where id = :'bestand';
select pg_temp.gelijk(pg_temp.zichtbaar(:'deling'), 'fileBlock:offerte.pdf,image:plattegrond.png', 'terug in de map: weer zichtbaar');

-- ── 3. Niets als de deling niet loopt, of de pagina weg is ──────────────────
update public.drive_shares set revoked_at = now(), revoked_by = :'eigenaar' where id = :'deling';
select pg_temp.gelijk(pg_temp.zichtbaar(:'deling'), '', 'een ingetrokken deling');
update public.drive_shares set revoked_at = null, revoked_by = null where id = :'deling';
alter table public.drive_shares disable trigger user;
update public.drive_shares set expires_at = now() - interval '1 minute' where id = :'deling';
alter table public.drive_shares enable trigger user;
select pg_temp.gelijk(pg_temp.zichtbaar(:'deling'), '', 'een verlopen deling');
alter table public.drive_shares disable trigger user;
update public.drive_shares set expires_at = null where id = :'deling';
alter table public.drive_shares enable trigger user;
update public.documents set archived_at = now(), archived_by = :'eigenaar' where id = :'pagina';
select pg_temp.gelijk(pg_temp.zichtbaar(:'deling'), '', 'een pagina in de prullenbak');
update public.documents set archived_at = null, archived_by = null where id = :'pagina';
select pg_temp.gelijk(pg_temp.zichtbaar(:'deling'), 'fileBlock:offerte.pdf,image:plattegrond.png', 'en weer terug');
select pg_temp.gelijk(pg_temp.zichtbaar(gen_random_uuid()), '', 'een deling die niet bestaat');

-- ── 4. Alleen de service-role ───────────────────────────────────────────────
select pg_temp.als(:'eigenaar');
set local role authenticated;
select pg_temp.weigert(format('select * from public.shared_page_attachments(%L)', :'deling'), 'permission denied', 'een ingelogde gebruiker roept hem niet aan');
reset role;
select pg_temp.beheer();

\o
\echo Alle controles van paginas_portaal_bijlagen.sql geslaagd.
rollback;
