-- ============================================================
-- Databasetest: pagina's delen met een vrijgegeven versie
-- (20261128120000, stap 1C-2)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: een klant hoort van een pagina de versie te zien die gedeeld is,
-- nooit de pagina zoals ze nu is. Tot deze stap weigerde de database elke
-- deling van een pagina. Deze test:
--
--   1. weigert een deling zonder versie, met een tussenversie, met de versie
--      van een andere pagina of organisatie, en een versie bij iets anders;
--   2. deelt met een geheime link (eigen dossier) en met een contactpersoon
--      (klantdossier); een klantpagina niet via een losse link;
--   3. toont in drive_share_items de titel van de gedeelde versie, ook als de
--      pagina daarna verandert;
--   4. werkt bij naar een nieuwe vrijgave, en dat staat in het logboek;
--   5. toont niets zolang de pagina in de prullenbak ligt, en weer na
--      terugzetten;
--   6. ruimt de deling op als de pagina definitief weg is, zonder dat de
--      prullenbak daarop vastloopt.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

select gen_random_uuid() as eigenaar, gen_random_uuid() as eigenaar_b \gset
insert into auth.users (id, email, aud, role) values
  (:'eigenaar',   'eigenaar@delen.test',   'authenticated', 'authenticated'),
  (:'eigenaar_b', 'eigenaar-b@delen.test', 'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Delen')).id as org \gset
reset role;
select pg_temp.als(:'eigenaar_b');
set local role authenticated;
select (public.create_organization('Bureau Elders')).id as org_b \gset
reset role;
select pg_temp.beheer();

insert into public.clients (organization_id, created_by, name, email, client_kind)
values (:'org', :'eigenaar', 'Klant Een', 'klant@delen.test', 'business') returning id as klant \gset
insert into public.client_contacts (organization_id, client_id, name, email, gives_portal_access, is_active)
values (:'org', :'klant', 'Contact Een', 'contact@delen.test', true, true) returning id as contact \gset

select set_config('test.eigenaar', :'eigenaar', true);

-- Schrijven zoals de app: ingelogd, onder RLS.
create function pg_temp.pagina(p_user uuid, p_org uuid, p_titel text, p_tekst text, p_client uuid default null, p_parent uuid default null)
returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  insert into public.documents (organization_id, created_by, title, format, body, client_id, parent_id)
  values (p_org, p_user, p_titel, 'page',
          jsonb_build_object('type', 'doc', 'content', jsonb_build_array(jsonb_build_object('type', 'paragraph',
            'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_tekst))))),
          p_client, p_parent)
  returning id into v;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

create function pg_temp.versie(p_user uuid, p_doc uuid, p_reden text) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  select (public.save_page_version(p_doc, p_reden)).id into v;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

-- Een deling maken zoals de app of de edge function dat doen, als de eigenaar.
create function pg_temp.deel(p_doc uuid, p_versie uuid, p_soort text default 'link', p_token text default null) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.als(current_setting('test.eigenaar')::uuid);
  set local role authenticated;
  insert into public.drive_shares (organization_id, created_by, item_type, item_id, item_name, recipient_kind,
                                   recipient_email, client_contact_id, token_hash, document_version_id)
  select d.organization_id, current_setting('test.eigenaar')::uuid, 'document', d.id, d.title, p_soort,
         case when p_soort = 'link' then 'gast@delen.test' end,
         case when p_soort = 'contact' then (select c.id from public.client_contacts c where c.client_id = d.client_id limit 1) end,
         case when p_soort = 'link' then coalesce(p_token, 'hash-' || gen_random_uuid()) end,
         p_versie
  from public.documents d where d.id = p_doc
  returning id into v;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

create function pg_temp.zichtbaar(p_share uuid) returns text language sql as $$
  select coalesce(string_agg(i.name || '|' || coalesce(i.storage_key, '-') || '|' || i.mime_type, ',' order by i.name), '')
  from public.drive_share_items(p_share) i;
$$;

select pg_temp.pagina(:'eigenaar', :'org', 'Handboek', 'Koffie is gratis.') as handboek \gset
select pg_temp.pagina(:'eigenaar', :'org', 'Werkwijze klant', 'Wij bellen elke maandag.', :'klant') as klantpagina \gset
select pg_temp.pagina(:'eigenaar', :'org', 'Ander', 'Iets anders.') as ander \gset
select pg_temp.pagina(:'eigenaar_b', :'org_b', 'Elders', 'Niet van ons.') as elders \gset
insert into public.documents (organization_id, created_by, title, content)
values (:'org', :'eigenaar', 'Huisregels', '<p>Thee is gratis.</p>') returning id as tekstdoc \gset

select pg_temp.versie(:'eigenaar', :'handboek', 'vrijgave') as vrij1 \gset
select pg_temp.versie(:'eigenaar', :'ander', 'vrijgave') as vrij_ander \gset
select pg_temp.versie(:'eigenaar_b', :'elders', 'vrijgave') as vrij_elders \gset
update public.documents set body = jsonb_set(body, '{content,0,content,0,text}', '"Koffie kost een euro."') where id = :'handboek';
select pg_temp.versie(:'eigenaar', :'handboek', 'sessie') as sessie \gset

-- ── 1. Wat de database weigert ──────────────────────────────────────────────
select pg_temp.weigert(format('select pg_temp.deel(%L, null)', :'handboek'),
  'Een pagina deel je met een vrijgegeven versie', 'een pagina zonder versie');
select pg_temp.weigert(format('select pg_temp.deel(%L, %L)', :'handboek', :'sessie'),
  'Alleen een vrijgegeven versie kun je delen', 'een tussenversie (een bewerksessie)');
select pg_temp.weigert(format('select pg_temp.deel(%L, %L)', :'handboek', :'vrij_ander'),
  'Deze versie hoort niet bij deze pagina', 'de versie van een andere pagina');
select pg_temp.weigert(format('select pg_temp.deel(%L, %L)', :'handboek', :'vrij_elders'),
  'Deze versie hoort niet bij deze pagina', 'de versie van een pagina van een andere organisatie');
select pg_temp.weigert(format('select pg_temp.deel(%L, %L)', :'tekstdoc', :'vrij1'),
  'Alleen een pagina deel je met een versie', 'een tekstdocument met een versie');
-- Een tekstdocument deel je zoals altijd, zonder versie.
select pg_temp.deel(:'tekstdoc', null) as tekstdeling \gset
select pg_temp.gelijk(pg_temp.zichtbaar(:'tekstdeling'), 'Huisregels|-|text/html', 'een tekstdocument deel je zoals voorheen');

-- ── 2. Delen met een link en met een contactpersoon ─────────────────────────
select pg_temp.deel(:'handboek', :'vrij1', 'link', 'hash-handboek') as linkdeling \gset
select pg_temp.gelijk(pg_temp.zichtbaar(:'linkdeling'), 'Handboek|-|text/html', 'de gedeelde pagina: geen bestand, wel te lezen');

select pg_temp.versie(:'eigenaar', :'klantpagina', 'vrijgave') as vrij_klant \gset
select pg_temp.weigert(format('select pg_temp.deel(%L, %L, %L)', :'klantpagina', :'vrij_klant', 'link'),
  'Klantgerelateerde bestanden mogen alleen', 'een klantpagina gaat niet via een losse link');
select pg_temp.deel(:'klantpagina', :'vrij_klant', 'contact') as contactdeling \gset
select pg_temp.gelijk(
  (select count(*) from public.portal_drive_shares_for_email('contact@delen.test') s where s.id = :'contactdeling'),
  1::bigint, 'de contactpersoon ziet de deling in het portaal');

-- ── 3. De klant ziet de gedeelde versie, niet de pagina van nu ──────────────
update public.documents set title = 'Concept: nieuwe prijzen' where id = :'handboek';
select pg_temp.gelijk(pg_temp.zichtbaar(:'linkdeling'), 'Handboek|-|text/html', 'een nieuwe titel komt niet bij de klant');
select pg_temp.gelijk(
  (select v.body #>> '{content,0,content,0,text}' from public.drive_shares s join public.document_versions v on v.id = s.document_version_id where s.id = :'linkdeling'),
  'Koffie is gratis.', 'de deling wijst naar de tekst van toen');

-- ── 4. Bijwerken bij klant ──────────────────────────────────────────────────
select pg_temp.versie(:'eigenaar', :'handboek', 'vrijgave') as vrij2 \gset
select pg_temp.als(:'eigenaar');
set local role authenticated;
select pg_temp.weigert(format('update public.drive_shares set document_version_id = %L where id = %L', :'sessie', :'linkdeling'),
  'Alleen een vrijgegeven versie kun je delen', 'bijwerken naar een tussenversie kan niet');
select pg_temp.weigert(format('update public.drive_shares set document_version_id = null where id = %L', :'linkdeling'),
  'Een pagina deel je met een vrijgegeven versie', 'de versie weghalen kan niet');
update public.drive_shares set document_version_id = :'vrij2', item_name = 'Concept: nieuwe prijzen' where id = :'linkdeling';
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(pg_temp.zichtbaar(:'linkdeling'), 'Concept: nieuwe prijzen|-|text/html', 'na bijwerken de nieuwe versie');
select pg_temp.gelijk(
  (select count(*) from public.audit_logs a
    where a.entity_type = 'drive_share' and a.entity_id = :'linkdeling' and a.action = 'updated'
      and a.metadata #>> '{changes,document_version_id,old}' = :'vrij1'
      and a.metadata #>> '{changes,document_version_id,new}' = :'vrij2'),
  1::bigint, 'het logboek houdt bij welke versie de klant vanaf nu ziet');

-- Alleen de versie wijzigen is ook een regel.
select pg_temp.versie(:'eigenaar', :'handboek', 'vrijgave') as vrij3 \gset
select pg_temp.als(:'eigenaar');
set local role authenticated;
update public.drive_shares set document_version_id = :'vrij3' where id = :'linkdeling';
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(
  (select count(*) from public.audit_logs a
    where a.entity_type = 'drive_share' and a.entity_id = :'linkdeling'
      and a.metadata #>> '{changes,document_version_id,new}' = :'vrij3'),
  1::bigint, 'ook als alleen de versie verandert');

-- ── 5. De prullenbak ────────────────────────────────────────────────────────
select pg_temp.als(:'eigenaar');
set local role authenticated;
select public.trash_page(:'klantpagina');
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(pg_temp.zichtbaar(:'contactdeling'), '', 'in de prullenbak ziet de klant niets');
select pg_temp.als(:'eigenaar');
set local role authenticated;
select pg_temp.weigert(format('update public.drive_shares set document_version_id = %L where id = %L', :'vrij_klant', :'contactdeling'),
  'Een pagina in de prullenbak kun je niet delen', 'een pagina in de prullenbak werk je niet bij');
select public.restore_page(:'klantpagina');
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(pg_temp.zichtbaar(:'contactdeling'), 'Werkwijze klant|-|text/html', 'teruggezet: de klant ziet haar weer');

-- ── 6. Definitief weg ───────────────────────────────────────────────────────
select pg_temp.als(:'eigenaar');
set local role authenticated;
select public.trash_page(:'klantpagina');
select public.delete_page_forever(:'klantpagina');
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((select count(*) from public.drive_shares where id = :'contactdeling'), 0::bigint, 'de deling gaat mee met de pagina');
select pg_temp.gelijk((select count(*) from public.drive_shares where id = :'linkdeling'), 1::bigint, 'een andere deling blijft staan');

\o
\echo Alle controles van paginas_delen.sql geslaagd.
rollback;
