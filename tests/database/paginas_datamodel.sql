-- ============================================================
-- Databasetest: pagina's, het datamodel (20261127130000)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: een pagina is een rij in documents met de inhoud als JSON in body.
-- De database is de laatste grens voor alles wat erin komt (app, Gerrie, MCP,
-- API). Deze test:
--
--   1. maakt een pagina: de platte tekst en de korte tekst komen vanzelf;
--   2. weigert onbekende blokken, gevaarlijke links en plaatjes van buiten;
--   3. bouwt een boom: subpagina's erven klant en project, kringen en
--      vreemde ouders kunnen niet;
--   4. regelt wie bewerkt: één tegelijk, overnemen na twee minuten stilte;
--   5. houdt versies bij, alleen via de functies, en zet er een terug;
--   6. zoekt in titel en tekst, met de rechten van wie zoekt.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

-- ── Organisaties, leden en klanten ──────────────────────────────────────────
select gen_random_uuid() as eigenaar, gen_random_uuid() as collega, gen_random_uuid() as lezer,
       gen_random_uuid() as zonder, gen_random_uuid() as eigenaar_b \gset
insert into auth.users (id, email, aud, role) values
  (:'eigenaar',   'eigenaar@paginas.test',   'authenticated', 'authenticated'),
  (:'collega',    'collega@paginas.test',    'authenticated', 'authenticated'),
  (:'lezer',      'lezer@paginas.test',      'authenticated', 'authenticated'),
  (:'zonder',     'zonder@paginas.test',     'authenticated', 'authenticated'),
  (:'eigenaar_b', 'eigenaar-b@paginas.test', 'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Pagina')).id as org_a \gset
reset role;
select pg_temp.als(:'eigenaar_b');
set local role authenticated;
select (public.create_organization('Bureau Elders')).id as org_b \gset
reset role;

select pg_temp.beheer();
set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 10 where id in (:'org_a', :'org_b');
insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org_a', :'collega', 'collega@paginas.test', 'member', 'active', '{}'),
  (:'org_a', :'lezer',   'lezer@paginas.test',   'member', 'active', '{"content":"read"}'),
  (:'org_a', :'zonder',  'zonder@paginas.test',  'member', 'active', '{"content":"none"}');

insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org_a', :'eigenaar', 'Klant Een', 'een@paginas.test', 'business') returning id as klant1 \gset
insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org_a', :'eigenaar', 'Klant Twee', 'twee@paginas.test', 'business') returning id as klant2 \gset
insert into public.content_folders (organization_id, client_id, name) values (:'org_a', :'klant1', 'Werkwijze') returning id as map \gset

-- Schrijven zoals de app: ingelogd, onder RLS.
create function pg_temp.pagina(p_user uuid, p_org uuid, p_title text, p_body jsonb, p_parent uuid default null,
                               p_client uuid default null, p_folder uuid default null) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  insert into public.documents (organization_id, created_by, title, format, body, parent_id, client_id, folder_id)
  values (p_org, p_user, p_title, 'page', p_body, p_parent, p_client, p_folder) returning id into v;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

create function pg_temp.alinea(p_tekst text) returns jsonb language sql as $$
  select jsonb_build_object('type', 'doc', 'content', jsonb_build_array(
    jsonb_build_object('type', 'heading', 'attrs', jsonb_build_object('level', 1), 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'Welkom'))),
    jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
      jsonb_build_object('type', 'text', 'text', p_tekst),
      jsonb_build_object('type', 'text', 'text', ' vet', 'marks', jsonb_build_array(jsonb_build_object('type', 'bold')))
    ))
  ));
$$;

-- ── 1. Een pagina maken ─────────────────────────────────────────────────────
select pg_temp.pagina(:'eigenaar', :'org_a', 'Handboek', pg_temp.alinea('Koffie is gratis in de keuken.'), null, :'klant1', :'map') as wortel \gset
select pg_temp.gelijk((select content from public.documents where id = :'wortel'), 'Welkom Koffie is gratis in de keuken. vet', 'de platte tekst komt uit de blokken');
select pg_temp.gelijk((select excerpt from public.documents where id = :'wortel'), 'Welkom Koffie is gratis in de keuken. vet', 'en de korte tekst ook');
select pg_temp.gelijk((select format from public.documents where id = :'wortel'), 'page', 'het is een pagina');

-- Een tekstdocument (de oude soort): de korte tekst zonder HTML.
insert into public.documents (organization_id, created_by, title, content)
values (:'org_a', :'eigenaar', 'Oud document', '<p>Thee &amp; koffie</p><p>Tweede alinea</p>') returning id as oud \gset
select pg_temp.gelijk((select excerpt from public.documents where id = :'oud'), 'Thee & koffie Tweede alinea', 'een tekstdocument krijgt een korte tekst zonder HTML');
select pg_temp.gelijk((select format from public.documents where id = :'oud'), 'html', 'en blijft de oude soort');

-- ── 2. Wat niet in een pagina mag ───────────────────────────────────────────
create function pg_temp.probeer(p_body jsonb) returns text language sql as $$
  select format('select pg_temp.pagina(%L, %L, %L, %L::jsonb)', current_setting('test.eigenaar'), current_setting('test.org_a'), 'Probeer', p_body::text);
$$;
select set_config('test.eigenaar', :'eigenaar', true), set_config('test.org_a', :'org_a', true);

select pg_temp.weigert(pg_temp.probeer('{"type":"doc","content":[{"type":"script","content":[]}]}'), 'Onbekend of kapot blok: script', 'een onbekend blok');
reset role; select pg_temp.beheer();
select pg_temp.weigert(pg_temp.probeer('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"klik","marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]}]}]}'), 'Een link mag alleen naar', 'een javascript-link');
reset role; select pg_temp.beheer();
select pg_temp.weigert(pg_temp.probeer('{"type":"doc","content":[{"type":"image","attrs":{"src":"https://volg.test/pixel.gif","attachmentId":"00000000-0000-0000-0000-000000000000"}}]}'), 'Een afbeelding van buiten', 'een plaatje van buiten');
reset role; select pg_temp.beheer();
select pg_temp.weigert(pg_temp.probeer('{"type":"doc","content":[{"type":"image","attrs":{}}]}'), 'zonder geldige verwijzing', 'een afbeelding zonder bestand');
reset role; select pg_temp.beheer();
select pg_temp.weigert(pg_temp.probeer('{"type":"paragraph"}'), 'Een pagina begint met een document', 'iets anders dan een document');
reset role; select pg_temp.beheer();
select pg_temp.weigert(pg_temp.probeer('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"onclick"}]}]}]}'), 'Onbekende opmaak: onclick', 'onbekende opmaak');
reset role; select pg_temp.beheer();

-- ── 3. De boom ──────────────────────────────────────────────────────────────
select pg_temp.pagina(:'eigenaar', :'org_a', 'Procedures', pg_temp.alinea('Zo werken wij.'), :'wortel', :'klant2', :'map') as kind \gset
select pg_temp.pagina(:'collega', :'org_a', 'Klachten', pg_temp.alinea('Bij een klacht bel je eerst.'), :'kind') as kleinkind \gset
select pg_temp.gelijk((select client_id from public.documents where id = :'kind'), :'klant1'::uuid, 'een subpagina erft de klant, ook als de app een andere opgeeft');
select pg_temp.gelijk((select folder_id from public.documents where id = :'kind'), null::uuid, 'alleen de bovenste pagina staat in een map');
select pg_temp.gelijk((select client_id from public.documents where id = :'kleinkind'), :'klant1'::uuid, 'ook twee lagen diep');

select pg_temp.als(:'eigenaar');
set local role authenticated;
update public.documents set client_id = :'klant2', folder_id = null where id = :'wortel';
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((select client_id from public.documents where id = :'kleinkind'), :'klant2'::uuid, 'de bovenste naar een andere klant: de hele boom gaat mee');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select pg_temp.weigert(format('update public.documents set parent_id = %L where id = %L', :'kleinkind', :'wortel'), 'niet onder zichzelf', 'een kring');
select pg_temp.weigert(format('update public.documents set parent_id = %L where id = %L', :'oud', :'kind'), 'hoort onder een pagina', 'een tekstdocument als ouder');
select pg_temp.weigert(format('update public.documents set parent_id = %L where id = %L', :'wortel', :'oud'), 'documents_parent_page_check', 'een tekstdocument als subpagina');
reset role;
select pg_temp.beheer();

select pg_temp.weigert(format('select pg_temp.pagina(%L, %L, %L, %L::jsonb, %L)', :'eigenaar_b', :'org_b', 'Indringer', pg_temp.alinea('x')::text, :'wortel'),
  'bestaat niet in deze organisatie', 'een ouder uit een andere organisatie');
reset role;
select pg_temp.beheer();

-- ── 4. Wie bewerkt ──────────────────────────────────────────────────────────
create function pg_temp.claim(p_user uuid, p_doc uuid) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  select c.claimed::text || ':' || c.user_id::text into v from public.claim_page_edit(p_doc) c;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

select pg_temp.gelijk(pg_temp.claim(:'eigenaar', :'wortel'), 'true:' || :'eigenaar', 'de eigenaar claimt de pagina');
select pg_temp.gelijk(pg_temp.claim(:'collega', :'wortel'), 'false:' || :'eigenaar', 'een collega ziet wie bewerkt, en wacht');
select pg_temp.gelijk(pg_temp.claim(:'eigenaar', :'wortel'), 'true:' || :'eigenaar', 'de hartslag van de eigenaar');
update public.document_edit_claims set seen_at = now() - interval '3 minutes' where document_id = :'wortel';
select pg_temp.gelijk(pg_temp.claim(:'collega', :'wortel'), 'true:' || :'collega', 'na twee minuten stilte neemt de collega het over');
select pg_temp.weigert(format('select pg_temp.claim(%L, %L)', :'lezer', :'wortel'), 'Je mag deze pagina niet bewerken', 'wie alleen mag lezen, claimt niet');
reset role;
select pg_temp.beheer();

select pg_temp.als(:'collega');
set local role authenticated;
select public.release_page_edit(:'wortel');
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((select count(*) from public.document_edit_claims where document_id = :'wortel'), 0::bigint, 'loslaten haalt de claim weg');

-- ── 5. Versies ──────────────────────────────────────────────────────────────
create function pg_temp.versie(p_user uuid, p_doc uuid, p_reden text default 'sessie') returns integer language plpgsql as $$
declare v integer;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  select (public.save_page_version(p_doc, p_reden)).version into v;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

select edit_version as ev0 from public.documents where id = :'wortel' \gset
select pg_temp.gelijk(pg_temp.versie(:'eigenaar', :'wortel'), 1, 'de eerste versie');
select pg_temp.gelijk(pg_temp.versie(:'eigenaar', :'wortel'), 1, 'zonder wijziging geen nieuwe versie');
update public.documents set body = pg_temp.alinea('Koffie kost nu een euro.') where id = :'wortel';
select pg_temp.gelijk((select edit_version from public.documents where id = :'wortel'), :'ev0'::integer + 1, 'een nieuwe inhoud verhoogt edit_version');
select pg_temp.weigert(format('update public.documents set content = %L where id = %L', 'Andere tekst', :'wortel'), 'via de blokken', 'bij een pagina alleen content wijzigen kan niet');
select pg_temp.gelijk(pg_temp.versie(:'eigenaar', :'wortel'), 2, 'na een wijziging versie 2');
select pg_temp.weigert(format('select pg_temp.versie(%L, %L)', :'lezer', :'wortel'), 'Je mag deze pagina niet bewerken', 'wie alleen mag lezen, legt geen versie vast');
reset role;
select pg_temp.beheer();

select pg_temp.als(:'eigenaar');
set local role authenticated;
select pg_temp.weigert(format('insert into public.document_versions (organization_id, document_id, version, title, body, reason) values (%L, %L, 99, %L, %L::jsonb, %L)',
  :'org_a', :'wortel', 'Vals', pg_temp.alinea('vals')::text, 'sessie'), 'row-level security', 'zelf een versie schrijven kan niet');
select (public.restore_page_version((select id from public.document_versions where document_id = :'wortel' and version = 1))).version as teruggezet \gset
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(:'teruggezet'::integer, 3, 'terugzetten is zelf versie 3');
select pg_temp.gelijk((select content from public.documents where id = :'wortel'), 'Welkom Koffie is gratis in de keuken. vet', 'en de pagina heeft weer de oude tekst');
select pg_temp.gelijk((select reason from public.document_versions where document_id = :'wortel' and version = 3), 'teruggezet', 'met de reden erbij');
select pg_temp.gelijk((select edit_version from public.documents where id = :'wortel'), :'ev0'::integer + 2, 'terugzetten verhoogt edit_version ook');

-- ── 6. Zoeken ───────────────────────────────────────────────────────────────
create function pg_temp.zoek(p_user uuid, p_org uuid, p_vraag text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  select coalesce(string_agg(s.title, ',' order by s.title), '') into v from public.search_documents(p_org, p_vraag) s;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

select pg_temp.gelijk(pg_temp.zoek(:'eigenaar', :'org_a', 'koff'), 'Handboek,Oud document', 'het begin van een woord vindt pagina en tekstdocument');
select pg_temp.gelijk(pg_temp.zoek(:'eigenaar', :'org_a', 'klacht bel'), 'Klachten', 'meer woorden: alle woorden moeten erin staan');
select pg_temp.gelijk(pg_temp.zoek(:'zonder', :'org_a', 'koff'), '', 'zonder Inhoud vind je niets');
select pg_temp.gelijk(pg_temp.zoek(:'eigenaar_b', :'org_a', 'koff'), '', 'een andere organisatie vindt niets');
select pg_temp.gelijk(pg_temp.zoek(:'eigenaar', :'org_a', '<>&'), '', 'een vraag zonder woorden vindt niets, zonder fout');
update public.documents set archived_at = now() where id = :'kleinkind';
select pg_temp.gelijk(pg_temp.zoek(:'eigenaar', :'org_a', 'klacht'), '', 'wat in de prullenbak ligt, vind je niet');

-- ── 7. Een pagina delen: niet via een map, en niet zonder vrijgave ─────────
-- De vrijgave zelf test paginas_delen.sql (20261128120000, stap 1C-2).
insert into public.content_folders (organization_id, name) values (:'org_a', 'Intern') returning id as intern \gset
select pg_temp.pagina(:'eigenaar', :'org_a', 'Concept', pg_temp.alinea('Nog niet klaar.'), null, null, :'intern') as concept \gset
insert into public.documents (organization_id, created_by, title, content, folder_id)
values (:'org_a', :'eigenaar', 'Huisregels', '<p>Koffie is gratis.</p>', :'intern') returning id as huisregels \gset
insert into public.drive_shares (organization_id, created_by, item_type, item_id, item_name, recipient_kind, recipient_email, token_hash)
values (:'org_a', :'eigenaar', 'folder', :'intern', 'Intern', 'link', 'gast@paginas.test', 'hash-p') returning id as mapdeling \gset
select pg_temp.gelijk((select string_agg(name, ',' order by name) from public.drive_share_items(:'mapdeling')), 'Huisregels', 'een gedeelde map neemt geen pagina mee');
select pg_temp.weigert(format('insert into public.drive_shares (organization_id, created_by, item_type, item_id, item_name, recipient_kind, recipient_email, token_hash) values (%L, %L, %L, %L, %L, %L, %L, %L)',
  :'org_a', :'eigenaar', 'document', :'concept', 'Concept', 'link', 'gast@paginas.test', 'hash-q'), 'Een pagina deel je met een vrijgegeven versie', 'een pagina delen zonder vrijgegeven versie kan niet');
-- Versturen (een zending) pakt een map uit met drive_folder_leaves: ook zonder pagina's.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.gelijk((select string_agg(name, ',' order by name) from public.drive_folder_leaves(:'org_a', :'intern')), 'Huisregels', 'versturen neemt geen pagina mee');
select pg_temp.beheer();

\o
\echo Alle controles van paginas_datamodel.sql geslaagd.
rollback;
