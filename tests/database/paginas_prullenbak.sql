-- ============================================================
-- Databasetest: de prullenbak van pagina's (20261128100000, stap 1A-5b)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: weggooien was definitief, en de bijlagen van subpagina's bleven
-- achter. Nu gaat een pagina met haar subpagina's naar de prullenbak, is ze
-- daar voor iedereen onzichtbaar, kan ze 30 dagen terug, en gaat ze daarna
-- definitief weg met haar bijlagen via de opruimwachtrij. Deze test:
--
--   1. gooit een pagina met subpagina's weg: onzichtbaar en niet te wijzigen;
--   2. laat archived_at niet zelf zetten;
--   3. toont de prullenbak, alleen aan wie Inhoud mag lezen;
--   4. zet terug, ook een subpagina waarvan de ouder nog in de prullenbak ligt;
--   5. verwijdert definitief, met de bijlage in de opruimwachtrij;
--   6. ruimt na 30 dagen op, en niet eerder;
--   7. weigert een buitenstaander en een tekstdocument.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

select gen_random_uuid() as eigenaar, gen_random_uuid() as lezer, gen_random_uuid() as zonder, gen_random_uuid() as vreemde \gset
insert into auth.users (id, email, aud, role) values
  (:'eigenaar', 'eigenaar@prullenbak.test', 'authenticated', 'authenticated'),
  (:'lezer',    'lezer@prullenbak.test',    'authenticated', 'authenticated'),
  (:'zonder',   'zonder@prullenbak.test',   'authenticated', 'authenticated'),
  (:'vreemde',  'vreemde@prullenbak.test',  'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Prullenbak')).id as org \gset
reset role;
select pg_temp.als(:'vreemde');
set local role authenticated;
select (public.create_organization('Bureau Vreemd')).id as org_v \gset
reset role;
select pg_temp.beheer();
set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 10 where id = :'org';
insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org', :'lezer',  'lezer@prullenbak.test',  'member', 'active', '{"content":"read"}'),
  (:'org', :'zonder', 'zonder@prullenbak.test', 'member', 'active', '{"content":"none"}');

select set_config('test.org', :'org', true), set_config('test.eigenaar', :'eigenaar', true);

-- Als iemand: een functie of een telling, onder RLS.
create function pg_temp.als_rpc(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  execute p_sql into v;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

create function pg_temp.pagina(p_titel text, p_ouder uuid default null) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.documents (organization_id, created_by, title, format, body, parent_id)
  values (current_setting('test.org')::uuid, current_setting('test.eigenaar')::uuid, p_titel, 'page', '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb, p_ouder)
  returning id into v;
  return v;
end $$;

select pg_temp.pagina('Handboek') as p \gset
select pg_temp.pagina('Hoofdstuk', :'p') as c \gset
select pg_temp.pagina('Paragraaf', :'c') as g \gset
select pg_temp.pagina('Los') as los \gset

-- ── 1. Weggooien: met de subpagina's, onzichtbaar en vast ──────────────────
select pg_temp.gelijk(pg_temp.als_rpc(:'eigenaar', format('select public.trash_page(%L)', :'p')), '3', 'de pagina en haar twee subpagina''s gaan in de prullenbak');
select pg_temp.gelijk((select count(distinct archived_at)::int from public.documents where id in (:'p', :'c', :'g')), 1, 'met hetzelfde moment');
select pg_temp.gelijk(pg_temp.als_rpc(:'eigenaar', format('select count(*) from public.documents where id in (%L, %L, %L)', :'p', :'c', :'g')), '0', 'onzichtbaar, ook voor de eigenaar');
select pg_temp.gelijk(pg_temp.als_rpc(:'eigenaar', format('with u as (update public.documents set title = %L where id = %L returning 1) select count(*) from u', 'Nieuw', :'p')), '0', 'en niet te wijzigen');
select pg_temp.gelijk((select title from public.documents where id = :'p'), 'Handboek', 'de titel is gebleven');
select pg_temp.gelijk(pg_temp.als_rpc(:'eigenaar', format('select public.trash_page(%L)', :'p')), '0', 'nog eens weggooien doet niets');

-- ── 2. archived_at zet je niet zelf ────────────────────────────────────────
select pg_temp.weigert(format('select pg_temp.als_rpc(%L, %L)', :'eigenaar', format('update public.documents set archived_at = now() where id = %L', :'los')),
  'row-level security', 'archived_at met de hand zetten');

-- ── 3. De prullenbak bekijken ──────────────────────────────────────────────
select pg_temp.gelijk(pg_temp.als_rpc(:'eigenaar', format('select string_agg(title || '':'' || subpages, '','') from public.list_page_trash(%L)', :'org')), 'Handboek:2', 'één regel: de weggegooide pagina met twee subpagina''s');
select pg_temp.gelijk(pg_temp.als_rpc(:'lezer', format('select count(*) from public.list_page_trash(%L)', :'org')), '1', 'wie Inhoud mag lezen, ziet de prullenbak');
select pg_temp.weigert(format('select pg_temp.als_rpc(%L, %L)', :'zonder', format('select count(*) from public.list_page_trash(%L)', :'org')),
  'niet zien', 'zonder Inhoud geen prullenbak');
select pg_temp.weigert(format('select pg_temp.als_rpc(%L, %L)', :'lezer', format('select public.restore_page(%L)', :'p')),
  'niet terugzetten', 'een lezer zet niets terug');

-- ── 4. Terugzetten ─────────────────────────────────────────────────────────
select pg_temp.gelijk(pg_temp.als_rpc(:'eigenaar', format('select public.restore_page(%L)', :'p')), '3', 'de pagina komt terug met haar subpagina''s');
select pg_temp.gelijk(pg_temp.als_rpc(:'eigenaar', format('select count(*) from public.documents where id in (%L, %L, %L)', :'p', :'c', :'g')), '3', 'weer zichtbaar');
-- Eerst het hoofdstuk weggooien, dan het handboek: twee keer, twee regels.
select pg_temp.als_rpc(:'eigenaar', format('select public.trash_page(%L)', :'c'));
select pg_temp.als_rpc(:'eigenaar', format('select public.trash_page(%L)', :'p'));
select pg_temp.gelijk(pg_temp.als_rpc(:'eigenaar', format('select string_agg(title || '':'' || subpages, '','' order by title) from public.list_page_trash(%L)', :'org')),
  'Handboek:0,Hoofdstuk:1', 'twee keer weggegooid: twee regels');
-- Het hoofdstuk terug terwijl het handboek nog in de prullenbak ligt: los in het dossier.
select pg_temp.gelijk(pg_temp.als_rpc(:'eigenaar', format('select public.restore_page(%L)', :'c')), '2', 'het hoofdstuk komt terug met zijn paragraaf');
select pg_temp.gelijk((select parent_id from public.documents where id = :'c'), null::uuid, 'los in het dossier, want de ouder ligt nog in de prullenbak');
select pg_temp.gelijk((select parent_id from public.documents where id = :'g'), :'c'::uuid, 'de paragraaf hangt nog onder het hoofdstuk');

-- ── 5. Definitief, met de bijlage ──────────────────────────────────────────
insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
values (:'org', 'document', :'p', 'foto.png', 'image/png', 10, :'org' || '/document/' || :'p' || '/x-foto.png');
select pg_temp.weigert(format('select pg_temp.als_rpc(%L, %L)', :'eigenaar', format('select public.delete_page_forever(%L)', :'los')),
  'Alleen een pagina in de prullenbak', 'wat niet in de prullenbak ligt, verwijder je niet zo');
select pg_temp.gelijk(pg_temp.als_rpc(:'eigenaar', format('select public.delete_page_forever(%L)', :'p')), '1', 'het handboek is definitief weg');
select pg_temp.gelijk((select count(*)::int from public.documents where id = :'p'), 0, 'ook in de database');
select pg_temp.gelijk((select count(*)::int from public.attachments where entity_id = :'p'), 0, 'zijn bijlage is weg');
select pg_temp.gelijk((select count(*)::int from public.storage_purge_queue where storage_key = :'org' || '/document/' || :'p' || '/x-foto.png' and reason = 'document'), 1,
  'en staat in de opruimwachtrij');

-- ── 6. Na 30 dagen ─────────────────────────────────────────────────────────
select pg_temp.als_rpc(:'eigenaar', format('select public.trash_page(%L)', :'c'));
select pg_temp.als_rpc(:'eigenaar', format('select public.trash_page(%L)', :'los'));
update public.documents set archived_at = now() - interval '31 days' where id in (:'c', :'g');
select pg_temp.gelijk(public.purge_page_trash() >= 2, true, 'wat langer dan 30 dagen ligt, gaat weg');
select pg_temp.gelijk((select count(*)::int from public.documents where id in (:'c', :'g')), 0, 'het hoofdstuk en zijn paragraaf');
select pg_temp.gelijk((select count(*)::int from public.documents where id = :'los'), 1, 'wat net is weggegooid, blijft');

-- ── 7. Buitenstaanders en tekstdocumenten ──────────────────────────────────
select pg_temp.weigert(format('select pg_temp.als_rpc(%L, %L)', :'vreemde', format('select public.restore_page(%L)', :'los')),
  'niet terugzetten', 'iemand van een andere organisatie');
insert into public.documents (organization_id, created_by, title, content) values (:'org', :'eigenaar', 'Oud', '<p>oud</p>') returning id as oud \gset
select pg_temp.weigert(format('select pg_temp.als_rpc(%L, %L)', :'eigenaar', format('select public.trash_page(%L)', :'oud')),
  'Alleen een pagina', 'een tekstdocument gaat niet in de prullenbak');

\o
\echo Alle controles van paginas_prullenbak.sql geslaagd.
rollback;
