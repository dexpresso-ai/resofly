-- ============================================================
-- Google Drive en OneDrive koppelen (migratie 20261123150000)
--
-- Wat hier vastligt:
--   1. Een teamlid kan zelf geen "gekoppeld bestand" maken of de koppeling
--      ervan veranderen. Anders zette hij het bestands-id en de koppeling van
--      een collega in een rij, en gooide hij door die rij te verwijderen een
--      bestand uit diens Drive weg.
--   2. Hernoemen en verplaatsen mag wel.
--   3. Elk verwijderen van een gekoppeld bestand komt in de wachtrij: los, en
--      ook als de map wordt verwijderd (purge_folder_files).
--   4. De wachtrij en de koppelingen zijn per organisatie, en alleen te lezen;
--      de tokens helemaal niet.
--   5. Vertrekt een teamlid, dan gaat zijn koppeling uit en zijn token weg.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

-- ── Gebruikers, organisaties, een klant met twee mappen ───────────────────

select gen_random_uuid() as eigenaar, gen_random_uuid() as lid, gen_random_uuid() as collega,
       gen_random_uuid() as zonder_inhoud, gen_random_uuid() as eigenaar_b \gset

insert into auth.users (id, email, aud, role) values
  (:'eigenaar',      'eigenaar@drive.test',      'authenticated', 'authenticated'),
  (:'lid',           'lid@drive.test',           'authenticated', 'authenticated'),
  (:'collega',       'collega@drive.test',       'authenticated', 'authenticated'),
  (:'zonder_inhoud', 'zonder-inhoud@drive.test', 'authenticated', 'authenticated'),
  (:'eigenaar_b',    'eigenaar-b@drive.test',    'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Drive Alfa')).id as org_a \gset
reset role;
select pg_temp.als(:'eigenaar_b');
set local role authenticated;
select (public.create_organization('Drive Beta')).id as org_b \gset
reset role;
select pg_temp.beheer();

set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 20 where id in (:'org_a', :'org_b');

insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org_a', :'lid',           'lid@drive.test',           'member', 'active', '{}'),
  (:'org_a', :'collega',       'collega@drive.test',       'member', 'active', '{}'),
  (:'org_a', :'zonder_inhoud', 'zonder-inhoud@drive.test', 'member', 'active', '{"content":"none"}');

insert into public.clients (organization_id, name) values (:'org_a', 'Bakker BV') returning id as klant \gset
insert into public.content_folders (organization_id, client_id, name) values (:'org_a', :'klant', 'Ontwerp') returning id as map1 \gset
insert into public.content_folders (organization_id, client_id, name) values (:'org_a', :'klant', 'Archief') returning id as map2 \gset

-- De koppeling van de collega, zoals de edge function hem zet.
insert into public.cloud_drive_connections (organization_id, user_id, provider, provider_account_id, provider_account_email, scopes)
values (:'org_a', :'collega', 'google', 'g-123', 'collega@gmail.test', '{openid,https://www.googleapis.com/auth/drive.file}')
returning id as koppeling \gset
insert into public.cloud_drive_connection_tokens (connection_id, organization_id, user_id, provider, access_token_encrypted, refresh_token_encrypted)
values (:'koppeling', :'org_a', :'collega', 'google', 'iv.data', 'iv.data');

select pg_temp.gelijk(
  (select count(*) from public.cloud_drive_connection_tokens where connection_id = :'koppeling')::int, 1,
  'de edge function kan een token bij de koppeling zetten');

select pg_temp.weigert(
  format($q$insert into public.cloud_drive_connection_tokens (connection_id, organization_id, user_id, provider, access_token_encrypted)
            values (%L, %L, %L, 'google', 'x') on conflict (connection_id) do update set user_id = excluded.user_id$q$,
         :'koppeling', :'org_a', :'lid'),
  'hoort niet bij deze koppeling',
  'een token kan niet onder de koppeling van een ander');

-- ── 1. Een teamlid maakt zelf geen gekoppeld bestand ──────────────────────

select pg_temp.als(:'lid');
set local role authenticated;

select pg_temp.weigert(
  format($q$insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key,
              cloud_provider, cloud_file_id, cloud_connection_id)
            values (%L, 'folder', %L, 'Van collega.pdf', 'application/pdf', 0, %L, 'google', 'bestand-van-collega', %L)$q$,
         :'org_a', :'map1', :'org_a' || '/cloud/google/' || gen_random_uuid(), :'koppeling'),
  'Uit Google Drive',
  'een teamlid kan geen gekoppeld bestand aanmaken');

select pg_temp.weigert(
  format($q$insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
            values (%L, 'folder', %L, 'nep.pdf', 'application/pdf', 0, %L)$q$,
         :'org_a', :'map1', :'org_a' || '/cloud/google/' || gen_random_uuid()),
  'Uit Google Drive',
  'ook niet via alleen een cloud-sleutel');

reset role;
select pg_temp.beheer();

-- Zoals de edge function het doet (service-role: geen ingelogde gebruiker).
insert into public.attachments (organization_id, created_by, entity_type, entity_id, name, mime_type, size_bytes, storage_key,
  cloud_provider, cloud_file_id, cloud_connection_id, cloud_web_url, cloud_size_bytes)
values (:'org_a', :'collega', 'folder', :'map1', 'Logo.pdf', 'application/pdf', 0, :'org_a' || '/cloud/google/' || gen_random_uuid(),
  'google', 'g-file-1', :'koppeling', 'https://drive.google.com/file/d/g-file-1/view', 2048)
returning id as bestand1 \gset
insert into public.attachments (organization_id, created_by, entity_type, entity_id, name, mime_type, size_bytes, storage_key,
  cloud_provider, cloud_file_id, cloud_connection_id, cloud_web_url)
values (:'org_a', :'collega', 'folder', :'map2', 'Oud.docx', 'application/octet-stream', 0, :'org_a' || '/cloud/google/' || gen_random_uuid(),
  'google', 'g-file-2', :'koppeling', 'https://drive.google.com/file/d/g-file-2/view')
returning id as bestand2 \gset

select pg_temp.weigert(
  format($q$insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key, cloud_provider, cloud_file_id)
            values (%L, 'folder', %L, 'dubbel.pdf', 'application/pdf', 0, %L, 'google', 'g-file-1')$q$,
         :'org_a', :'map2', :'org_a' || '/cloud/google/' || gen_random_uuid()),
  'attachments_cloud_file_unique',
  'hetzelfde bestand twee keer koppelen in één organisatie kan niet');

select pg_temp.weigert(
  format($q$insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key, cloud_provider, cloud_file_id)
            values (%L, 'client', %L, 'bij klant.pdf', 'application/pdf', 0, %L, 'google', 'g-file-3')$q$,
         :'org_a', :'klant', :'org_a' || '/cloud/google/' || gen_random_uuid()),
  'attachments_cloud_shape',
  'een gekoppeld bestand staat alleen in een dossiermap');

select pg_temp.weigert(
  format($q$insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key, cloud_provider, cloud_file_id)
            values (%L, 'folder', %L, 'groot.pdf', 'application/pdf', 5000, %L, 'google', 'g-file-4')$q$,
         :'org_a', :'map1', :'org_a' || '/cloud/google/' || gen_random_uuid()),
  'attachments_cloud_shape',
  'een gekoppeld bestand telt niet mee in de opslag (size_bytes 0)');

select pg_temp.weigert(
  format($q$insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key, cloud_provider, cloud_file_id)
            values (%L, 'folder', %L, 'od.pdf', 'application/pdf', 0, %L, 'microsoft', 'od-1')$q$,
         :'org_a', :'map1', :'org_a' || '/cloud/microsoft/' || gen_random_uuid()),
  'attachments_cloud_shape',
  'een OneDrive-bestand heeft altijd zijn schijf erbij');

-- ── 2. Hernoemen en verplaatsen mag; de koppeling aanpassen niet ──────────

select pg_temp.als(:'lid');
set local role authenticated;

update public.attachments set name = 'Logo definitief.pdf' where id = :'bestand1';
select pg_temp.gelijk((select name from public.attachments where id = :'bestand1'), 'Logo definitief.pdf', 'een teamlid mag een gekoppeld bestand hernoemen');
update public.attachments set entity_id = :'map2' where id = :'bestand1';
select pg_temp.gelijk((select entity_id from public.attachments where id = :'bestand1'), :'map2'::uuid, 'en verplaatsen');
update public.attachments set entity_id = :'map1' where id = :'bestand1';

select pg_temp.weigert(format($q$update public.attachments set cloud_file_id = 'ander-bestand' where id = %L$q$, :'bestand1'),
  'niet zelf aanpassen', 'het bestands-id is niet aan te passen');
select pg_temp.weigert(format($q$update public.attachments set cloud_connection_id = gen_random_uuid() where id = %L$q$, :'bestand1'),
  'niet zelf aanpassen', 'de koppeling is niet aan te passen');
select pg_temp.weigert(format($q$update public.attachments set cloud_web_url = 'https://evil.example/' where id = %L$q$, :'bestand1'),
  'niet zelf aanpassen', 'de link is niet aan te passen');
select pg_temp.weigert(format($q$update public.attachments set storage_key = %L where id = %L$q$, :'org_a' || '/folder/echt.pdf', :'bestand1'),
  'niet zelf aanpassen', 'van een gekoppeld bestand maak je geen gewoon bestand');

-- ── 3. Verwijderen komt in de wachtrij, ook via een verwijderde map ───────

delete from public.attachments where id = :'bestand1';
select pg_temp.gelijk((select count(*) from public.attachments where id = :'bestand1')::int, 0, 'het teamlid verwijdert het gekoppelde bestand');

select pg_temp.gelijk(
  (select count(*) from public.cloud_file_deletions
    where organization_id = :'org_a' and file_id = 'g-file-1' and provider = 'google'
      and connection_id = :'koppeling' and requested_by = :'lid' and status = 'pending')::int,
  1, 'het staat in de wachtrij, met de koppeling van wie het koppelde en wie het verwijderde');

select pg_temp.weigert(format($q$update public.cloud_file_deletions set status = 'done' where organization_id = %L$q$, :'org_a'),
  'permission denied', 'een teamlid kan de wachtrij niet zelf afvinken');
select pg_temp.weigert(format($q$insert into public.cloud_file_deletions (organization_id, provider, file_id) values (%L, 'google', 'iets-anders')$q$, :'org_a'),
  'permission denied', 'en er niets zelf in zetten');

reset role;
select pg_temp.beheer();

-- De map met het tweede bestand gaat weg (zoals bij een verwijderde klant).
delete from public.content_folders where id = :'map2';
select pg_temp.gelijk(
  (select count(*) from public.cloud_file_deletions where organization_id = :'org_a' and file_id = 'g-file-2')::int,
  1, 'een verwijderde map zet zijn gekoppelde bestanden ook in de wachtrij');

-- ── 4. Wie wat ziet ────────────────────────────────────────────────────────

select pg_temp.als(:'lid');
set local role authenticated;
select pg_temp.gelijk((select count(*) from public.cloud_file_deletions)::int, 2, 'wie Inhoud leest, ziet wat er nog weg moet');
select pg_temp.gelijk((select count(*) from public.cloud_drive_connections)::int, 0, 'maar niet de koppeling van een collega');
reset role;

select pg_temp.als(:'collega');
set local role authenticated;
select pg_temp.gelijk((select count(*) from public.cloud_drive_connections)::int, 1, 'de collega ziet zijn eigen koppeling');
select pg_temp.weigert('select count(*) from public.cloud_drive_connection_tokens', 'permission denied', 'en nooit de tokens');
select pg_temp.weigert(format($q$update public.cloud_drive_connections set status = 'active' where id = %L$q$, :'koppeling'),
  'permission denied', 'een koppeling schrijft alleen de edge function');
reset role;

select pg_temp.als(:'zonder_inhoud');
set local role authenticated;
select pg_temp.gelijk((select count(*) from public.cloud_file_deletions)::int, 0, 'zonder de module Inhoud zie je de wachtrij niet');
reset role;

select pg_temp.als(:'eigenaar_b');
set local role authenticated;
select pg_temp.gelijk((select count(*) from public.cloud_file_deletions)::int, 0, 'een andere organisatie ziet niets');
reset role;
select pg_temp.beheer();

-- ── 5. Vertrekt de collega, dan gaat zijn koppeling uit ───────────────────

update public.organization_members set status = 'disabled' where organization_id = :'org_a' and user_id = :'collega';
select pg_temp.gelijk((select status from public.cloud_drive_connections where id = :'koppeling'), 'revoked', 'de koppeling van een vertrokken teamlid staat uit');
select pg_temp.gelijk((select count(*) from public.cloud_drive_connection_tokens where connection_id = :'koppeling')::int, 0, 'en zijn token is weg');

rollback;
