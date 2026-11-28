-- ============================================================
-- Databasetest: een regel in een takenlijst wordt een taak
-- (20261128170000, stap 2-2a)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: een taak onthoudt uit welke pagina en regel ze komt (tasks.page_id
-- en page_block_id), zonder foreign key. Deze test:
--
--   1. neemt een taak aan bij een pagina van de eigen organisatie, één per
--      regel, en weigert een regel zonder pagina;
--   2. weigert iets dat geen pagina is, een pagina van een ander bureau, een
--      pagina in de prullenbak, en een pagina die je niet mag lezen;
--   3. controleert de link alleen als die verandert: wie Inhoud niet mag
--      lezen, kan zo'n taak gewoon verplaatsen, afvinken en hernoemen;
--   4. laat wie alleen Inhoud mag schrijven de pagina definitief wissen; de
--      taak blijft, met een id dat nergens meer heen wijst. Met een foreign
--      key ("on delete set null") hield de schrijfpoort van Projecten dat
--      tegen.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

select gen_random_uuid() as eigenaar \gset
select gen_random_uuid() as planner \gset
select gen_random_uuid() as schrijver \gset
select gen_random_uuid() as vreemde \gset
insert into auth.users (id, email, aud, role) values
  (:'eigenaar', 'eigenaar@taken.test', 'authenticated', 'authenticated'),
  (:'planner', 'planner@taken.test', 'authenticated', 'authenticated'),
  (:'schrijver', 'schrijver@taken.test', 'authenticated', 'authenticated'),
  (:'vreemde', 'vreemde@taken.test', 'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Taken')).id as org \gset
reset role;
select pg_temp.als(:'vreemde');
set local role authenticated;
select (public.create_organization('Bureau Elders')).id as org_v \gset
reset role;
select pg_temp.beheer();
set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 10 where id = :'org';
-- De planner mag Projecten schrijven maar Inhoud niet lezen; de schrijver
-- precies andersom.
insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org', :'planner',   'planner@taken.test',   'member', 'active', '{"projects":"write","content":"none"}'),
  (:'org', :'schrijver', 'schrijver@taken.test', 'member', 'active', '{"projects":"none","content":"write"}');

insert into public.projects (organization_id, name) values (:'org', 'Verbouwing') returning id as project \gset
insert into public.projects (organization_id, name) values (:'org', 'Onderhoud') returning id as project2 \gset

select gen_random_uuid() as regel \gset
select gen_random_uuid() as regel2 \gset
insert into public.documents (organization_id, created_by, title, format, body) values
  (:'org', :'eigenaar', 'Notulen', 'page', jsonb_build_object('type', 'doc', 'content', jsonb_build_array(
    jsonb_build_object('type', 'taskList', 'content', jsonb_build_array(
      jsonb_build_object('type', 'taskItem', 'attrs', jsonb_build_object('checked', false, 'id', :'regel'), 'content', jsonb_build_array(
        jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'Offerte sturen'))))))))))
  returning id as pagina \gset
insert into public.documents (organization_id, created_by, title, format, content)
values (:'org', :'eigenaar', 'Gewoon document', 'html', '<p>Tekst</p>') returning id as document \gset
insert into public.documents (organization_id, created_by, title, format, body)
values (:'org_v', :'vreemde', 'Elders', 'page', '{"type":"doc","content":[]}'::jsonb) returning id as pagina_v \gset

-- Een taak maken als deze gebruiker; geeft het id terug.
create function pg_temp.maak(p_user uuid, p_org uuid, p_pagina uuid, p_regel uuid, p_titel text) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  insert into public.tasks (organization_id, title, project_id, page_id, page_block_id)
  values (p_org, p_titel, (select id from public.projects where organization_id = p_org order by name desc limit 1), p_pagina, p_regel)
  returning id into v;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

-- ── 1. Een taak bij een regel ───────────────────────────────────────────────
select pg_temp.maak(:'eigenaar', :'org', :'pagina', :'regel', 'Offerte sturen') as taak \gset
select pg_temp.gelijk((select page_id::text || '/' || page_block_id::text from public.tasks where id = :'taak'),
  :'pagina' || '/' || :'regel', 'de taak onthoudt pagina en regel');
select pg_temp.weigert(format('select pg_temp.maak(%L, %L, %L, %L, %L)', :'eigenaar', :'org', :'pagina', :'regel', 'Nog een keer'),
  'tasks_page_block_unique', 'twee taken voor dezelfde regel');
select pg_temp.weigert(format('select pg_temp.maak(%L, %L, null, %L, %L)', :'eigenaar', :'org', :'regel2', 'Zonder pagina'),
  'tasks_page_block_needs_page', 'een regel zonder pagina');
-- Een pagina zonder regel mag: "Uit pagina", zonder dat er een regel bij hoort.
select pg_temp.gelijk(pg_temp.maak(:'eigenaar', :'org', :'pagina', null, 'Uit de pagina') is not null, true, 'een pagina zonder regel');

-- ── 2. Wat geen pagina van jou is ───────────────────────────────────────────
select pg_temp.weigert(format('select pg_temp.maak(%L, %L, %L, %L, %L)', :'eigenaar', :'org', :'document', :'regel2', 'Document'),
  'tasks.page_id verwijst', 'een document dat geen pagina is');
select pg_temp.weigert(format('select pg_temp.maak(%L, %L, %L, %L, %L)', :'eigenaar', :'org', :'pagina_v', :'regel2', 'Elders'),
  'tasks.page_id verwijst', 'een pagina van een ander bureau');
select pg_temp.weigert(format('select pg_temp.maak(%L, %L, %L, %L, %L)', :'planner', :'org', :'pagina', :'regel2', 'Zonder Inhoud'),
  'tasks.page_id verwijst', 'wie Inhoud niet mag lezen');
-- Ook zonder ingelogde gebruiker (een edge function met de service-role): de organisatie telt.
select pg_temp.weigert(format($q$insert into public.tasks (organization_id, title, page_id) values (%L, 'Service', %L)$q$, :'org', :'pagina_v'),
  'tasks.page_id verwijst', 'de service-role met een pagina van een ander bureau');
update public.documents set archived_at = now(), archived_by = :'eigenaar' where id = :'pagina';
select pg_temp.weigert(format('select pg_temp.maak(%L, %L, %L, %L, %L)', :'eigenaar', :'org', :'pagina', :'regel2', 'Prullenbak'),
  'tasks.page_id verwijst', 'een pagina in de prullenbak');
update public.documents set archived_at = null, archived_by = null where id = :'pagina';

-- ── 3. Alleen als de link verandert ─────────────────────────────────────────
select pg_temp.als(:'planner');
set local role authenticated;
update public.tasks set project_id = :'project2', status = 'done', title = 'Offerte gestuurd' where id = :'taak';
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((select status || '/' || title || '/' || page_id::text from public.tasks where id = :'taak'),
  'done/Offerte gestuurd/' || :'pagina', 'wie Inhoud niet mag lezen, verplaatst, vinkt af en hernoemt');
-- Maar een andere pagina eraan hangen, kan die niet.
select pg_temp.weigert(format($q$
  do $do$ begin
    perform pg_temp.als(%L);
    set local role authenticated;
    update public.tasks set page_id = %L where id = %L;
  end $do$$q$, :'planner', :'pagina_v', :'taak'),
  'tasks.page_id verwijst', 'de link veranderen naar een pagina van een ander bureau');
reset role;
select pg_temp.beheer();

-- ── 4. Definitief wissen door wie alleen Inhoud mag schrijven ───────────────
select pg_temp.als(:'schrijver');
set local role authenticated;
select public.trash_page(:'pagina');
select public.delete_page_forever(:'pagina');
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((select count(*)::int from public.documents where id = :'pagina'), 0, 'de pagina is weg');
select pg_temp.gelijk((select page_id::text from public.tasks where id = :'taak'), :'pagina', 'de taak blijft, met het oude id');

\o
\echo Alle controles van paginas_taken.sql geslaagd.
rollback;
