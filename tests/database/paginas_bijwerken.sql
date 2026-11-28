-- ============================================================
-- Databasetest: zien of de klant de pagina van nu ziet, en bijwerken
-- (20261128130000, stap 1C-3)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: na het delen wijzig je een pagina verder. De app moet zien dat de
-- klant een oudere versie ziet, en met "Bijwerken bij klant" in één keer elke
-- lopende deling een nieuwe vrijgave geven. Deze test:
--
--   1. page_share_status: de versie per deling, en of die de pagina van nu
--      is; alleen voor wie Inhoud mag lezen, in de eigen organisatie;
--   2. release_page_to_shares: alleen voor wie Inhoud mag schrijven;
--   3. werkt alle lopende delingen bij, niet een ingetrokken of verlopen
--      deling, en ook niet als een contactpersoon geen portaaltoegang meer
--      heeft;
--   4. maakt geen nieuwe versie als iedereen de pagina van nu al ziet;
--   5. weigert een tekstdocument en een pagina in de prullenbak.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

select gen_random_uuid() as eigenaar, gen_random_uuid() as lezer, gen_random_uuid() as zonder, gen_random_uuid() as vreemde \gset
insert into auth.users (id, email, aud, role) values
  (:'eigenaar', 'eigenaar@bijwerken.test', 'authenticated', 'authenticated'),
  (:'lezer',    'lezer@bijwerken.test',    'authenticated', 'authenticated'),
  (:'zonder',   'zonder@bijwerken.test',   'authenticated', 'authenticated'),
  (:'vreemde',  'vreemde@bijwerken.test',  'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Bijwerken')).id as org \gset
reset role;
select pg_temp.als(:'vreemde');
set local role authenticated;
select (public.create_organization('Bureau Vreemd')).id as org_v \gset
reset role;
select pg_temp.beheer();
set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 10 where id = :'org';
insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org', :'lezer',  'lezer@bijwerken.test',  'member', 'active', '{"content":"read"}'),
  (:'org', :'zonder', 'zonder@bijwerken.test', 'member', 'active', '{"content":"none"}');

insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org', :'eigenaar', 'Klant Een', 'klant@bijwerken.test', 'business') returning id as klant \gset
insert into public.client_contacts (organization_id, client_id, name, email, gives_portal_access, is_active)
values (:'org', :'klant', 'Contact Een', 'contact@bijwerken.test', true, true) returning id as contact \gset

-- Als iemand: een functie, onder RLS.
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

create function pg_temp.body(p_tekst text) returns jsonb language sql as $$
  select jsonb_build_object('type', 'doc', 'content', jsonb_build_array(jsonb_build_object('type', 'paragraph',
    'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_tekst)))));
$$;

select pg_temp.als(:'eigenaar');
set local role authenticated;
insert into public.documents (organization_id, created_by, title, format, body, client_id)
values (:'org', :'eigenaar', 'Werkwijze', 'page', pg_temp.body('Wij bellen op maandag.'), :'klant') returning id as pagina \gset
select (public.save_page_version(:'pagina', 'vrijgave')).id as v1 \gset
insert into public.drive_shares (organization_id, created_by, item_type, item_id, item_name, recipient_kind, document_version_id)
values (:'org', :'eigenaar', 'document', :'pagina', 'Werkwijze', 'client', :'v1') returning id as hoofdadres \gset
insert into public.drive_shares (organization_id, created_by, item_type, item_id, item_name, recipient_kind, client_contact_id, document_version_id)
values (:'org', :'eigenaar', 'document', :'pagina', 'Werkwijze', 'contact', :'contact', :'v1') returning id as contactdeling \gset
insert into public.documents (organization_id, created_by, title, content)
values (:'org', :'eigenaar', 'Huisregels', '<p>Thee.</p>') returning id as tekstdoc \gset
reset role;
select pg_temp.beheer();

-- Een ingetrokken en een verlopen deling: die blijven zoals ze waren. Buiten
-- de controles om gezet (een verlopen deling kun je niet zo aanmaken), en als
-- deellink, zodat ze niet botsen met de ene lopende deling per klant.
alter table public.drive_shares disable trigger user;
insert into public.drive_shares (organization_id, created_by, item_type, item_id, item_name, client_id, recipient_kind, recipient_email, token_hash, document_version_id, revoked_at, revoked_by)
values (:'org', :'eigenaar', 'document', :'pagina', 'Werkwijze', :'klant', 'link', 'oud@bijwerken.test', null, :'v1', now(), :'eigenaar') returning id as ingetrokken \gset
insert into public.drive_shares (organization_id, created_by, item_type, item_id, item_name, client_id, recipient_kind, recipient_email, token_hash, document_version_id, expires_at)
values (:'org', :'eigenaar', 'document', :'pagina', 'Werkwijze', :'klant', 'link', 'laat@bijwerken.test', 'hash-laat', :'v1', now() - interval '1 day') returning id as verlopen \gset
alter table public.drive_shares enable trigger user;

create function pg_temp.status(p_user uuid, p_doc uuid) returns text language sql as $$
  select pg_temp.als_rpc(p_user, format(
    'select coalesce(string_agg(case when s.is_current then ''nu'' else ''oud'' end || '':'' || s.version, '','' order by s.version, s.share_id), '''') from public.page_share_status(%L) s', p_doc));
$$;

-- ── 1. Wat ziet de klant nu? ────────────────────────────────────────────────
select pg_temp.gelijk(pg_temp.status(:'eigenaar', :'pagina'), 'nu:1,nu:1', 'twee lopende delingen, allebei de pagina van nu');
update public.documents set body = pg_temp.body('Wij bellen op dinsdag.') where id = :'pagina';
select pg_temp.gelijk(pg_temp.status(:'eigenaar', :'pagina'), 'oud:1,oud:1', 'na een wijziging: een oudere versie');
select pg_temp.gelijk(pg_temp.status(:'lezer', :'pagina'), 'oud:1,oud:1', 'wie Inhoud mag lezen, ziet het ook');
select pg_temp.gelijk(pg_temp.status(:'zonder', :'pagina'), '', 'zonder Inhoud niets');
select pg_temp.gelijk(pg_temp.status(:'vreemde', :'pagina'), '', 'een andere organisatie niets');

-- ── 2. Wie mag bijwerken ────────────────────────────────────────────────────
select pg_temp.weigert(format('select pg_temp.als_rpc(%L, %L)', :'lezer', format('select public.release_page_to_shares(%L)::text', :'pagina')),
  'Je mag deze pagina niet delen', 'wie Inhoud alleen mag lezen, werkt niet bij');
select pg_temp.weigert(format('select pg_temp.als_rpc(%L, %L)', :'vreemde', format('select public.release_page_to_shares(%L)::text', :'pagina')),
  'Je mag deze pagina niet delen', 'een andere organisatie werkt niet bij');
select pg_temp.weigert(format('select pg_temp.als_rpc(%L, %L)', :'eigenaar', format('select public.release_page_to_shares(%L)::text', :'tekstdoc')),
  'Alleen een pagina werk je zo bij', 'een tekstdocument');

-- ── 3. Bijwerken ────────────────────────────────────────────────────────────
-- De contactpersoon verliest intussen zijn portaaltoegang: dat mag het
-- bijwerken van de rest niet tegenhouden.
update public.client_contacts set gives_portal_access = false where id = :'contact';
select pg_temp.gelijk(pg_temp.als_rpc(:'eigenaar', format('select public.release_page_to_shares(%L)::text', :'pagina')), '2', 'twee lopende delingen bijgewerkt');
select pg_temp.gelijk(pg_temp.status(:'eigenaar', :'pagina'), 'nu:2,nu:2', 'en ze zien de pagina van nu, versie 2');
select pg_temp.gelijk((select reason from public.document_versions where document_id = :'pagina' and version = 2), 'vrijgave', 'versie 2 is een vrijgave');
select pg_temp.gelijk((select string_agg(v.version::text, ',' order by s.id) from public.drive_shares s join public.document_versions v on v.id = s.document_version_id
                        where s.id in (:'ingetrokken', :'verlopen')), '1,1', 'een ingetrokken of verlopen deling blijft zoals ze was');
select pg_temp.gelijk((select count(*) from public.audit_logs a
                        where a.entity_type = 'drive_share' and a.entity_id in (:'hoofdadres', :'contactdeling')
                          and a.metadata #>> '{changes,document_version_id,old}' = :'v1'),
  2::bigint, 'elke bijgewerkte deling staat in het logboek');

-- ── 4. Geen nieuwe versie zonder verschil ───────────────────────────────────
select pg_temp.gelijk(pg_temp.als_rpc(:'eigenaar', format('select public.release_page_to_shares(%L)::text', :'pagina')), '0', 'nog een keer: niets bij te werken');
select pg_temp.gelijk((select count(*) from public.document_versions where document_id = :'pagina'), 2::bigint, 'en geen nieuwe versie');

-- ── 5. De prullenbak ────────────────────────────────────────────────────────
update public.documents set body = pg_temp.body('Wij bellen op woensdag.') where id = :'pagina';
select pg_temp.als_rpc(:'eigenaar', format('select public.trash_page(%L)::text', :'pagina'));
select pg_temp.weigert(format('select pg_temp.als_rpc(%L, %L)', :'eigenaar', format('select public.release_page_to_shares(%L)::text', :'pagina')),
  'Een pagina in de prullenbak kun je niet delen', 'een pagina in de prullenbak werk je niet bij');

\o
\echo Alle controles van paginas_bijwerken.sql geslaagd.
rollback;
