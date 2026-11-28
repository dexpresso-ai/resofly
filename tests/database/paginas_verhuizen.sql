-- ============================================================
-- Databasetest: een gedeelde pagina die naar een ander dossier verhuist
-- (20261128150000, stap 1C)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: een pagina onder een pagina van een andere klant zetten (alleen
-- parent_id, zoals nestPageUnder in de app en een aanroep via de API) gaf de
-- pagina de klant van haar nieuwe ouder via een BEFORE-trigger. De
-- AFTER-triggers op client_id vuurden dan niet: haar subpagina's hielden de
-- oude klant, en haar delingen bleven lopen. Na "Bijwerken bij klant" zag een
-- ontvanger van de oude klant, of via een geheime link, de pagina van de
-- nieuwe klant. Deze test:
--
--   1. verhuist een pagina met subpagina onder een pagina van een andere
--      klant: de subpagina gaat mee;
--   2. trekt de deling met een contactpersoon van de oude klant in;
--   3. trekt een geheime link in van een pagina uit het eigen dossier die
--      onder een klantpagina komt;
--   4. werkt bij "Bijwerken bij klant" alleen delingen bij die nog passen.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

select gen_random_uuid() as eigenaar \gset
insert into auth.users (id, email, aud, role) values (:'eigenaar', 'eigenaar@verhuizen.test', 'authenticated', 'authenticated');
select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Verhuizen')).id as org \gset
reset role;
select pg_temp.beheer();

insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org', :'eigenaar', 'Klant Een', 'een@verhuizen.test', 'business') returning id as klant1 \gset
insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org', :'eigenaar', 'Klant Twee', 'twee@verhuizen.test', 'business') returning id as klant2 \gset
insert into public.client_contacts (organization_id, client_id, name, email, gives_portal_access, is_active)
values (:'org', :'klant1', 'Contact Een', 'contact@verhuizen.test', true, true) returning id as contact1 \gset

create function pg_temp.pagina(p_titel text, p_client uuid, p_parent uuid default null) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.als(current_setting('test.eigenaar')::uuid);
  set local role authenticated;
  insert into public.documents (organization_id, created_by, title, format, body, client_id, parent_id)
  values (current_setting('test.org')::uuid, current_setting('test.eigenaar')::uuid, p_titel, 'page',
          '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb, p_client, p_parent)
  returning id into v;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

-- Zoals de app (nestPageUnder): alleen parent_id, als de gebruiker.
create function pg_temp.onder(p_page uuid, p_parent uuid) returns void language plpgsql as $$
begin
  perform pg_temp.als(current_setting('test.eigenaar')::uuid);
  set local role authenticated;
  update public.documents set parent_id = p_parent where id = p_page;
  reset role;
  perform pg_temp.beheer();
end $$;

create function pg_temp.deel(p_page uuid, p_soort text, p_contact uuid default null) returns uuid language plpgsql as $$
declare v uuid; v_versie uuid;
begin
  perform pg_temp.als(current_setting('test.eigenaar')::uuid);
  set local role authenticated;
  select (public.save_page_version(p_page, 'vrijgave')).id into v_versie;
  insert into public.drive_shares (organization_id, created_by, item_type, item_id, item_name, recipient_kind,
                                   client_contact_id, recipient_email, token_hash, document_version_id)
  values (current_setting('test.org')::uuid, current_setting('test.eigenaar')::uuid, 'document', p_page, 'Pagina', p_soort,
          p_contact, case when p_soort = 'link' then 'gast@verhuizen.test' end,
          case when p_soort = 'link' then 'hash-' || gen_random_uuid() end, v_versie)
  returning id into v;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

select set_config('test.eigenaar', :'eigenaar', true), set_config('test.org', :'org', true);

select pg_temp.pagina('Werkwijze', :'klant1') as werkwijze \gset
select pg_temp.pagina('Bellen', null, :'werkwijze') as bellen \gset
select pg_temp.pagina('Bij klant twee', :'klant2') as doel \gset
select pg_temp.pagina('Handboek', null) as handboek \gset

select pg_temp.deel(:'werkwijze', 'contact', :'contact1') as contactdeling \gset
select pg_temp.deel(:'handboek', 'link') as linkdeling \gset
select pg_temp.gelijk((select client_id from public.documents where id = :'bellen'), :'klant1'::uuid, 'de subpagina hoort eerst bij klant 1');

-- ── 1 en 2. Een klantpagina onder een pagina van een andere klant ───────────
select pg_temp.onder(:'werkwijze', :'doel');
select pg_temp.gelijk((select client_id from public.documents where id = :'werkwijze'), :'klant2'::uuid, 'de pagina hoort nu bij klant 2');
select pg_temp.gelijk((select client_id from public.documents where id = :'bellen'), :'klant2'::uuid, 'haar subpagina gaat mee naar klant 2');
select pg_temp.gelijk((select revoked_at is not null from public.drive_shares where id = :'contactdeling'), true, 'de deling met een contactpersoon van klant 1 is ingetrokken');

-- ── 3. Een pagina uit het eigen dossier onder een klantpagina ───────────────
select pg_temp.onder(:'handboek', :'doel');
select pg_temp.gelijk((select revoked_at is not null from public.drive_shares where id = :'linkdeling'), true, 'de geheime link is ingetrokken: een klantpagina gaat niet via een losse link');

-- ── 4. Bijwerken: alleen delingen die nog passen ────────────────────────────
-- Een deling die buiten de triggers om is blijven lopen (zoals vóór deze
-- migratie), wordt niet bijgewerkt en telt niet mee in de status.
-- (De controle op de ontvanger weigert dat terecht; daarom buiten de triggers om.)
alter table public.drive_shares disable trigger user;
update public.drive_shares set revoked_at = null, revoked_by = null where id = :'contactdeling';
alter table public.drive_shares enable trigger user;
update public.documents set body = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Nieuw bij klant 2"}]}]}'::jsonb where id = :'werkwijze';
select pg_temp.gelijk((select count(*) from public.page_share_status(:'werkwijze')), 0::bigint, 'de status laat een deling die niet meer past weg');
select pg_temp.als(:'eigenaar');
set local role authenticated;
select pg_temp.gelijk(public.release_page_to_shares(:'werkwijze'), 0, 'bijwerken slaat een deling die niet meer past over');
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(
  (select v.body #>> '{content,0,content,0,text}' from public.drive_shares s join public.document_versions v on v.id = s.document_version_id where s.id = :'contactdeling'),
  null, 'de oude klant krijgt de tekst van klant 2 niet');

\o
\echo Alle controles van paginas_verhuizen.sql geslaagd.
rollback;
