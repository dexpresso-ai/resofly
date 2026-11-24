-- ============================================================
-- De kopie van Inhoud in OneDrive (migratie 20261124100000)
--
-- Wat hier vastligt:
--   1. Zonder kopie die aanstaat, komt er niets in de wachtrij.
--   2. Bestanden in een dossiermap en Word/Excel/PowerPoint-documenten komen
--      erin; tekstdocumenten en bijlagen buiten Inhoud niet.
--   3. Per item één taak: een tweede wijziging vervangt de eerste.
--   4. Hernoemen van klant, project en map, en verwijderen (ook via een
--      cascade) komen erin.
--   5. Wie wat ziet: de stand van de kopie voor wie Inhoud leest; de tokens,
--      de wachtrij en de koppeltabel voor niemand in de app.
--   6. Oppakken gaat met gewone wijzigingen vóór het verwijderen.
--   7. Vertrekt de eigenaar die koppelde, dan gaat de kopie uit.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

-- ── Gebruikers, organisaties, een klant met een project en mappen ─────────

select gen_random_uuid() as eigenaar, gen_random_uuid() as tweede, gen_random_uuid() as lid,
       gen_random_uuid() as zonder_inhoud, gen_random_uuid() as eigenaar_b \gset

insert into auth.users (id, email, aud, role) values
  (:'eigenaar',      'eigenaar@onedrive.test',      'authenticated', 'authenticated'),
  (:'tweede',        'tweede@onedrive.test',        'authenticated', 'authenticated'),
  (:'lid',           'lid@onedrive.test',           'authenticated', 'authenticated'),
  (:'zonder_inhoud', 'zonder-inhoud@onedrive.test', 'authenticated', 'authenticated'),
  (:'eigenaar_b',    'eigenaar-b@onedrive.test',    'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Kopie Alfa')).id as org_a \gset
reset role;
select pg_temp.als(:'eigenaar_b');
set local role authenticated;
select (public.create_organization('Kopie Beta')).id as org_b \gset
reset role;
select pg_temp.beheer();

set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 20 where id in (:'org_a', :'org_b');

insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org_a', :'tweede',        'tweede@onedrive.test',        'owner',  'active', '{}'),
  (:'org_a', :'lid',           'lid@onedrive.test',           'member', 'active', '{}'),
  (:'org_a', :'zonder_inhoud', 'zonder-inhoud@onedrive.test', 'member', 'active', '{"content":"none"}');

insert into public.clients (organization_id, name) values (:'org_a', 'Bakker BV') returning id as klant \gset
insert into public.projects (organization_id, client_id, name) values (:'org_a', :'klant', 'Website') returning id as project \gset
insert into public.content_folders (organization_id, client_id, name) values (:'org_a', :'klant', 'Ontwerp') returning id as map1 \gset
insert into public.content_folders (organization_id, client_id, project_id, name) values (:'org_a', :'klant', :'project', 'Concepten') returning id as map2 \gset
insert into public.clients (organization_id, name) values (:'org_b', 'Klant B') returning id as klant_b \gset
insert into public.content_folders (organization_id, client_id, name) values (:'org_b', :'klant_b', 'Map B') returning id as map_b \gset

create temp table telling as select 0 as n;
create function pg_temp.taken(p_org uuid) returns integer language sql as $$
  select count(*)::int from public.onedrive_sync_jobs where organization_id = p_org
$$;
create function pg_temp.taak(p_org uuid, p_type text, p_id uuid) returns text language sql as $$
  select kind || ':' || seq from public.onedrive_sync_jobs where organization_id = p_org and item_type = p_type and item_id = p_id
$$;

-- ── 1. Zonder kopie die aanstaat: niets ───────────────────────────────────

select pg_temp.als(:'lid');
set local role authenticated;
insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
values (:'org_a', 'folder', :'map1', 'voor-de-kopie.pdf', 'application/pdf', 10, :'org_a' || '/folder/' || :'map1' || '/a-voor.pdf');
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(pg_temp.taken(:'org_a'), 0, 'zonder kopie komt er niets in de wachtrij');

-- De eigenaar koppelt en zet aan (zoals de edge function het doet).
insert into public.onedrive_mirrors (organization_id, connected_by, account_id, account_email, drive_id, root_item_id, root_name, enabled, scopes)
values (:'org_a', :'tweede', 'ms-1', 'tweede@bedrijf.test', 'b!drive', '01ROOT', 'ResoFly - Kopie Alfa', true, '{Files.ReadWrite}');
insert into public.onedrive_mirror_tokens (organization_id, access_token_encrypted, refresh_token_encrypted)
values (:'org_a', 'iv.data', 'iv.data');

select pg_temp.weigert(
  format($q$update public.onedrive_mirrors set enabled = true, root_item_id = null where organization_id = %L$q$, :'org_a'),
  'onedrive_mirrors_enabled_has_root', 'een kopie die aanstaat, heeft altijd een map in OneDrive');

-- ── 2. Wat erin komt, en wat niet ─────────────────────────────────────────

select pg_temp.als(:'lid');
set local role authenticated;
insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
values (:'org_a', 'folder', :'map1', 'logo.png', 'image/png', 100, :'org_a' || '/folder/' || :'map1' || '/b-logo.png')
returning id as bestand \gset
insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
values (:'org_a', 'client', :'klant', 'bij-de-klant.pdf', 'application/pdf', 10, :'org_a' || '/client/' || :'klant' || '/c-bij.pdf')
returning id as klantbijlage \gset
insert into public.documents (organization_id, client_id, folder_id, title, content, storage_key, mime_type, size_bytes)
values (:'org_a', :'klant', :'map1', 'Offerte', '', :'org_a' || '/document/d-offerte.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 2000)
returning id as worddoc \gset
insert into public.documents (organization_id, client_id, title, content)
values (:'org_a', :'klant', 'Gewone tekst', '<p>hallo</p>')
returning id as tekstdoc \gset
reset role;
select pg_temp.beheer();

select pg_temp.gelijk(pg_temp.taak(:'org_a', 'attachment', :'bestand'), 'sync:1', 'een bestand in een dossiermap komt in de wachtrij');
select pg_temp.gelijk(pg_temp.taak(:'org_a', 'attachment', :'klantbijlage'), null::text, 'een bijlage buiten Inhoud niet');
select pg_temp.gelijk(pg_temp.taak(:'org_a', 'document', :'worddoc'), 'sync:1', 'een Word-document wel');
select pg_temp.gelijk(pg_temp.taak(:'org_a', 'document', :'tekstdoc'), null::text, 'een tekstdocument niet');

-- ── 3. Per item één taak ─────────────────────────────────────────────────

select pg_temp.als(:'lid');
set local role authenticated;
update public.attachments set name = 'logo-definitief.png' where id = :'bestand';
update public.attachments set edit_version = edit_version + 1 where id = :'bestand';
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(pg_temp.taak(:'org_a', 'attachment', :'bestand'), 'sync:3', 'twee wijzigingen later nog steeds één taak, met een hogere teller');

-- ── 4. Klant, project en map hernoemen; verwijderen, ook via een cascade ──

select pg_temp.als(:'lid');
set local role authenticated;
update public.clients set name = 'Bakker & Zn' where id = :'klant';
update public.projects set name = 'Website 2026' where id = :'project';
update public.content_folders set name = 'Concepten v2' where id = :'map2';
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(pg_temp.taak(:'org_a', 'client', :'klant'), 'sync:1', 'een hernoemde klant');
select pg_temp.gelijk(pg_temp.taak(:'org_a', 'project', :'project'), 'sync:1', 'een hernoemd project');
select pg_temp.gelijk(pg_temp.taak(:'org_a', 'folder', :'map2'), 'sync:1', 'een hernoemde map');

select pg_temp.als(:'lid');
set local role authenticated;
delete from public.content_folders where id = :'map1';
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(pg_temp.taak(:'org_a', 'folder', :'map1'), 'delete:1', 'een verwijderde map');
select pg_temp.gelijk(left(pg_temp.taak(:'org_a', 'attachment', :'bestand'), 7), 'delete:', 'het bestand erin gaat mee (purge_folder_files)');
select pg_temp.gelijk(left(pg_temp.taak(:'org_a', 'document', :'worddoc'), 5), 'sync:', 'het document schuift naar de klantmap (folder_id wordt leeg)');

-- In organisatie B staat geen kopie aan: daar gebeurt niets.
insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
values (:'org_b', 'folder', :'map_b', 'b.pdf', 'application/pdf', 1, :'org_b' || '/folder/' || :'map_b' || '/b.pdf');
select pg_temp.gelijk(pg_temp.taken(:'org_b'), 0, 'een andere organisatie zonder kopie krijgt geen taken');

-- ── 5. Wie wat ziet ───────────────────────────────────────────────────────

select pg_temp.als(:'lid');
set local role authenticated;
select pg_temp.gelijk((select count(*) from public.onedrive_mirrors)::int, 1, 'wie Inhoud leest, ziet dat er een kopie is');
select pg_temp.weigert('select count(*) from public.onedrive_mirror_tokens', 'permission denied', 'de tokens nooit');
select pg_temp.weigert('select count(*) from public.onedrive_sync_jobs', 'permission denied', 'de wachtrij niet');
select pg_temp.weigert('select count(*) from public.onedrive_sync_items', 'permission denied', 'de koppeltabel niet');
select pg_temp.weigert(format($q$update public.onedrive_mirrors set enabled = false where organization_id = %L$q$, :'org_a'),
  'permission denied', 'de kopie zet alleen de edge function aan of uit');
select pg_temp.weigert(format($q$select public.onedrive_enqueue(%L, 'attachment', gen_random_uuid(), 'delete')$q$, :'org_a'),
  'permission denied', 'zelf een taak klaarzetten kan niet');
select pg_temp.weigert(format($q$select * from public.onedrive_claim_jobs(%L, 10)$q$, :'org_a'),
  'permission denied', 'taken oppakken kan niet');
select pg_temp.weigert(format($q$select public.onedrive_queue_full_sync(%L)$q$, :'org_a'),
  'permission denied', 'alles opnieuw klaarzetten kan alleen de edge function');
reset role;

select pg_temp.als(:'zonder_inhoud');
set local role authenticated;
select pg_temp.gelijk((select count(*) from public.onedrive_mirrors)::int, 0, 'zonder de module Inhoud zie je de kopie niet');
reset role;

select pg_temp.als(:'eigenaar_b');
set local role authenticated;
select pg_temp.gelijk((select count(*) from public.onedrive_mirrors)::int, 0, 'een andere organisatie ziet niets');
reset role;
select pg_temp.beheer();

-- ── 6. Oppakken: gewone wijzigingen vóór het verwijderen ─────────────────

select kind as eerste from public.onedrive_claim_jobs(:'org_a', 1) \gset
select pg_temp.gelijk(:'eerste', 'sync', 'eerst wat blijft, dan wat weg moet');
select pg_temp.gelijk((select count(*) from public.onedrive_claim_jobs(:'org_a', 200))::int,
  pg_temp.taken(:'org_a') - 1, 'een opgepakte taak pakt een tweede ronde niet nog eens');

-- Uit: niets meer erbij, en alles opnieuw klaarzetten doet niets.
update public.onedrive_mirrors set enabled = false where organization_id = :'org_a';
delete from public.onedrive_sync_jobs where organization_id = :'org_a';
select pg_temp.als(:'lid');
set local role authenticated;
update public.projects set name = 'Website 2027' where id = :'project';
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(pg_temp.taken(:'org_a'), 0, 'een kopie die uit staat, krijgt geen taken');
select pg_temp.gelijk(public.onedrive_queue_full_sync(:'org_a'), 0, 'en alles opnieuw kopiëren doet dan niets');

-- Weer aan: "Alles opnieuw kopiëren" zet elk bestand en Word-document klaar, met controle.
update public.onedrive_mirrors set enabled = true where organization_id = :'org_a';
select pg_temp.gelijk(public.onedrive_queue_full_sync(:'org_a'),
  (select count(*)::int from public.attachments where organization_id = :'org_a' and entity_type = 'folder')
  + (select count(*)::int from public.documents where organization_id = :'org_a' and storage_key is not null),
  'alles opnieuw kopiëren: elk bestand in een map en elk Word-document');
select pg_temp.gelijk((select bool_and(verify) from public.onedrive_sync_jobs where organization_id = :'org_a'), true,
  'met controle in OneDrive');

-- ── 7. De eigenaar die koppelde, vertrekt ─────────────────────────────────

update public.organization_members set status = 'disabled' where organization_id = :'org_a' and user_id = :'tweede';
select pg_temp.gelijk((select enabled from public.onedrive_mirrors where organization_id = :'org_a'), false, 'de kopie staat uit');
select pg_temp.gelijk((select status from public.onedrive_mirrors where organization_id = :'org_a'), 'expired', 'en vraagt om opnieuw koppelen');
select pg_temp.gelijk((select count(*)::int from public.onedrive_mirror_tokens where organization_id = :'org_a'), 0, 'het token is weg');
select pg_temp.gelijk(pg_temp.taken(:'org_a'), 0, 'de wachtrij is leeg');

-- Ontkoppelen: de opruimtaak haalt wat er nog over de kopie bekend was weg.
insert into public.onedrive_sync_items (organization_id, item_type, item_id, drive_item_id, name, desired_name)
values (:'org_a', 'client', :'klant', '01CLIENT', 'Bakker BV', 'Bakker BV');
delete from public.onedrive_mirrors where organization_id = :'org_a';
select public.onedrive_cleanup();
select pg_temp.gelijk((select count(*)::int from public.onedrive_sync_items where organization_id = :'org_a'), 0, 'ontkoppeld: de koppeltabel is leeg');

rollback;
