-- ============================================================
-- Databasetest: @-vermeldingen in een pagina (20261128160000, stap 2-1a)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: een vermelding noemt een klant, project, taak, factuur of collega.
-- Ze bewaart alleen de soort en het id, geen naam: wie Inhoud mag lezen maar
-- Klanten of Financiën niet, leest de body wel. Deze test:
--
--   1. neemt een vermelding aan met een bekende soort en een geldig id, en
--      weigert een onbekende soort, een ongeldig id, een naam of inhoud;
--   2. weigert een nieuwe vermelding van iets uit een andere organisatie, en
--      laat een id dat nergens bestaat toe; een oude vermelding blokkeert
--      het opslaan niet;
--   3. houdt page_mentions bij, elke vermelding één keer;
--   4. laat page_mentions alleen lezen wie de pagina mag lezen (Inhoud, niet
--      in de prullenbak, eigen organisatie), en niemand schrijven;
--   5. zet geen naam in de platte tekst.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

select gen_random_uuid() as eigenaar \gset
select gen_random_uuid() as lezer \gset
select gen_random_uuid() as zonder \gset
select gen_random_uuid() as vreemde \gset
insert into auth.users (id, email, aud, role) values
  (:'eigenaar', 'eigenaar@vermeldingen.test', 'authenticated', 'authenticated'),
  (:'lezer', 'lezer@vermeldingen.test', 'authenticated', 'authenticated'),
  (:'zonder', 'zonder@vermeldingen.test', 'authenticated', 'authenticated'),
  (:'vreemde', 'vreemde@vermeldingen.test', 'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Vermeldingen')).id as org \gset
reset role;
select pg_temp.als(:'vreemde');
set local role authenticated;
select (public.create_organization('Bureau Elders')).id as org_v \gset
reset role;
select pg_temp.beheer();
set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 10 where id = :'org';
insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org', :'lezer',  'lezer@vermeldingen.test',  'member', 'active', '{"content":"read"}'),
  (:'org', :'zonder', 'zonder@vermeldingen.test', 'member', 'active', '{"content":"none"}');

insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org', :'eigenaar', 'Bakkerij Jansen', 'jansen@vermeldingen.test', 'business') returning id as klant \gset
insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org_v', :'vreemde', 'Klant Elders', 'elders@vermeldingen.test', 'business') returning id as klant_v \gset
insert into public.projects (organization_id, name, client_id) values (:'org', 'Verbouwing', :'klant') returning id as project \gset
insert into public.projects (organization_id, name) values (:'org_v', 'Project Elders') returning id as project_v \gset
insert into public.invoices (organization_id, number) values (:'org', 'F-TEST-001') returning id as factuur \gset

-- Een body met één alinea: tekst, en daarna de knopen uit p_knopen.
create function pg_temp.body(p_knopen jsonb) returns jsonb language sql as $$
  select jsonb_build_object('type', 'doc', 'content', jsonb_build_array(
    jsonb_build_object('type', 'paragraph', 'content',
      jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'Bel ')) || p_knopen)));
$$;
create function pg_temp.noem(p_kind text, p_id text) returns jsonb language sql as $$
  select jsonb_build_object('type', 'mention', 'attrs', jsonb_build_object('kind', p_kind, 'id', p_id));
$$;
create function pg_temp.genoemd(p_pagina uuid) returns text language sql as $$
  select coalesce(string_agg(m.kind || ':' || m.entity_id, ',' order by m.kind, m.entity_id), '')
  from public.page_mentions m where m.document_id = p_pagina;
$$;

-- ── 1. De vorm ──────────────────────────────────────────────────────────────
select pg_temp.als(:'eigenaar');
set local role authenticated;
insert into public.documents (organization_id, created_by, title, format, body, client_id)
values (:'org', :'eigenaar', 'Afspraken', 'page',
  pg_temp.body(jsonb_build_array(pg_temp.noem('client', :'klant'), pg_temp.noem('project', :'project'),
    pg_temp.noem('invoice', :'factuur'), pg_temp.noem('member', :'lezer'), pg_temp.noem('client', :'klant'))),
  :'klant') returning id as pagina \gset
select pg_temp.gelijk((select count(*)::int from public.documents where id = :'pagina'), 1, 'een pagina met vier soorten vermeldingen');

select pg_temp.weigert(format($q$update public.documents set body = %L where id = %L$q$,
  pg_temp.body(jsonb_build_array(pg_temp.noem('leverancier', :'klant'))), :'pagina'),
  'bekende soort en een geldig id', 'een onbekende soort');
select pg_temp.weigert(format($q$update public.documents set body = %L where id = %L$q$,
  pg_temp.body(jsonb_build_array(pg_temp.noem('client', 'abc'))), :'pagina'),
  'bekende soort en een geldig id', 'een ongeldig id');
select pg_temp.weigert(format($q$update public.documents set body = %L where id = %L$q$,
  pg_temp.body(jsonb_build_array(jsonb_build_object('type', 'mention', 'attrs',
    jsonb_build_object('kind', 'client', 'id', :'klant', 'label', 'Bakkerij Jansen')))), :'pagina'),
  'bekende soort en een geldig id', 'een naam in de vermelding');
select pg_temp.weigert(format($q$update public.documents set body = %L where id = %L$q$,
  pg_temp.body(jsonb_build_array(jsonb_build_object('type', 'mention', 'attrs',
    jsonb_build_object('kind', 'client', 'id', :'klant'), 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'x'))))), :'pagina'),
  'bekende soort en een geldig id', 'inhoud in de vermelding');
select pg_temp.weigert(format($q$update public.documents set body = %L where id = %L$q$,
  pg_temp.body(jsonb_build_array(jsonb_build_object('type', 'mention'))), :'pagina'),
  'bekende soort en een geldig id', 'een vermelding zonder soort en id');

-- ── 2. Niets uit een andere organisatie ─────────────────────────────────────
select pg_temp.weigert(format($q$update public.documents set body = %L where id = %L$q$,
  pg_temp.body(jsonb_build_array(pg_temp.noem('client', :'klant_v'))), :'pagina'),
  'uit een andere organisatie', 'een klant van een ander bureau');
select pg_temp.weigert(format($q$update public.documents set body = %L where id = %L$q$,
  pg_temp.body(jsonb_build_array(pg_temp.noem('project', :'project_v'))), :'pagina'),
  'uit een andere organisatie', 'een project van een ander bureau');
select pg_temp.weigert(format($q$update public.documents set body = %L where id = %L$q$,
  pg_temp.body(jsonb_build_array(pg_temp.noem('member', :'vreemde'))), :'pagina'),
  'uit een andere organisatie', 'iemand die alleen elders lid is');
-- Wat nergens bestaat, mag: zo kan een oude versie terug met een verwijderde taak erin.
update public.documents set body = pg_temp.body(jsonb_build_array(pg_temp.noem('client', :'klant'), pg_temp.noem('task', gen_random_uuid()::text)))
where id = :'pagina';
select pg_temp.gelijk(pg_temp.genoemd(:'pagina') like 'client:%,task:%', true, 'een taak die nergens bestaat');
reset role;
select pg_temp.beheer();

-- Een vermelding die er al stond, blokkeert het opslaan niet (zoals bij de verwijzingen).
set local session_replication_role = replica;
update public.documents set body = pg_temp.body(jsonb_build_array(pg_temp.noem('client', :'klant_v'))) where id = :'pagina';
set local session_replication_role = origin;
select pg_temp.als(:'eigenaar');
set local role authenticated;
update public.documents set title = 'Afspraken 2', body = jsonb_set(body, '{content,0,content,0,text}', '"Bel morgen "') where id = :'pagina';
select pg_temp.gelijk((select title from public.documents where id = :'pagina'), 'Afspraken 2', 'een oude vermelding blokkeert het opslaan niet');

-- ── 3. page_mentions ────────────────────────────────────────────────────────
update public.documents set body = pg_temp.body(jsonb_build_array(
  pg_temp.noem('client', :'klant'), pg_temp.noem('client', :'klant'), pg_temp.noem('project', :'project'), pg_temp.noem('invoice', :'factuur')))
where id = :'pagina';
select pg_temp.gelijk(pg_temp.genoemd(:'pagina'),
  (select string_agg(k || ':' || i, ',' order by k, i) from (values ('client', :'klant'::uuid), ('invoice', :'factuur'::uuid), ('project', :'project'::uuid)) v(k, i)),
  'elke vermelding één keer, na het opslaan');
update public.documents set body = pg_temp.body(jsonb_build_array(pg_temp.noem('project', :'project'))) where id = :'pagina';
select pg_temp.gelijk(pg_temp.genoemd(:'pagina'), 'project:' || :'project', 'een weggehaalde vermelding gaat weg');
-- De platte tekst: zonder naam.
select pg_temp.gelijk((select btrim(content) from public.documents where id = :'pagina'), 'Bel', 'geen naam in de platte tekst');

-- Niemand schrijft er zelf in.
select pg_temp.weigert(format($q$insert into public.page_mentions (organization_id, document_id, kind, entity_id) values (%L, %L, 'client', %L)$q$,
  :'org', :'pagina', :'klant'), 'permission denied', 'zelf een regel toevoegen');
reset role;
select pg_temp.beheer();

-- ── 4. Wie leest "Genoemd in" ───────────────────────────────────────────────
create function pg_temp.ziet(p_user uuid, p_pagina uuid) returns int language plpgsql as $$
declare v int;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  select count(*)::int into v from public.page_mentions where document_id = p_pagina;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;
select pg_temp.gelijk(pg_temp.ziet(:'eigenaar', :'pagina'), 1, 'de eigenaar');
select pg_temp.gelijk(pg_temp.ziet(:'lezer', :'pagina'), 1, 'wie Inhoud mag lezen');
select pg_temp.gelijk(pg_temp.ziet(:'zonder', :'pagina'), 0, 'wie Inhoud niet mag lezen');
select pg_temp.gelijk(pg_temp.ziet(:'vreemde', :'pagina'), 0, 'een ander bureau');
update public.documents set archived_at = now(), archived_by = :'eigenaar' where id = :'pagina';
select pg_temp.gelijk(pg_temp.ziet(:'eigenaar', :'pagina'), 0, 'een pagina in de prullenbak');
update public.documents set archived_at = null, archived_by = null where id = :'pagina';
select pg_temp.gelijk(pg_temp.ziet(:'eigenaar', :'pagina'), 1, 'en weer terug');

-- Een definitief verwijderde pagina neemt haar regels mee.
delete from public.documents where id = :'pagina';
select pg_temp.gelijk((select count(*)::int from public.page_mentions where document_id = :'pagina'), 0, 'weg met de pagina');

\o
\echo Alle controles van paginas_vermeldingen.sql geslaagd.
rollback;
