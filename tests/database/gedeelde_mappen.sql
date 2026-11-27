-- ============================================================
-- Databasetest: een gedeelde map vult zich niet meer vanzelf (20261127120000)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: tot 27 november 2026 was een gedeelde map live. Wat een collega er
-- later in zette, zag de klant meteen, zonder dat iemand op Delen drukte. Nu
-- ziet de ontvanger alleen wat er bij het delen in stond, plus wat iemand er
-- met "Ook delen" bij zet. Deze test:
--
--   1. deelt een map met een submap en kijkt wat de ontvanger ziet;
--   2. zet er daarna iets bij: de ontvanger ziet het niet, de drive meldt het;
--   3. vult de deling aan: alleen met schrijfrechten op Inhoud, alleen met wat
--      in de map staat, alleen binnen de eigen organisatie, alleen zolang de
--      deling loopt;
--   4. verplaatst een gedeeld item uit de map en terug;
--   5. controleert dat de lijst alleen via de functies te vullen is, en dat
--      opnieuw delen (de deeldienst) de huidige inhoud vastlegt.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

-- ── Organisaties en leden ───────────────────────────────────────────────────
select gen_random_uuid() as eigenaar, gen_random_uuid() as lezer, gen_random_uuid() as eigenaar_b \gset
insert into auth.users (id, email, aud, role) values
  (:'eigenaar',   'eigenaar@mappen.test',   'authenticated', 'authenticated'),
  (:'lezer',      'lezer@mappen.test',      'authenticated', 'authenticated'),
  (:'eigenaar_b', 'eigenaar-b@mappen.test', 'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Mappen')).id as org_a \gset
reset role;
select pg_temp.als(:'eigenaar_b');
set local role authenticated;
select (public.create_organization('Bureau Elders')).id as org_b \gset
reset role;

select pg_temp.beheer();
set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 10 where id in (:'org_a', :'org_b');
insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org_a', :'lezer', 'lezer@mappen.test', 'member', 'active', '{"content":"read"}');

-- ── 1. Een map met een submap, en wat erin staat ───────────────────────────
insert into public.content_folders (organization_id, name) values (:'org_a', 'Werkwijze') returning id as map \gset
insert into public.content_folders (organization_id, name, parent_id) values (:'org_a', 'Bijlagen', :'map') returning id as submap \gset
insert into public.content_folders (organization_id, name) values (:'org_a', 'Elders') returning id as andere_map \gset

insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
values (:'org_a', 'folder', :'map', 'a1.pdf', 'application/pdf', 10, :'org_a' || '/folder/a1.pdf') returning id as a1 \gset
insert into public.notes (organization_id, folder_id, title) values (:'org_a', :'map', 'Notitie 1') returning id as n1 \gset
insert into public.documents (organization_id, folder_id, title) values (:'org_a', :'submap', 'Document 1') returning id as d1 \gset
insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
values (:'org_a', 'folder', :'andere_map', 'elders.pdf', 'application/pdf', 10, :'org_a' || '/folder/elders.pdf') returning id as elders \gset

-- Zoals de deeldienst (file-share) het doet: met de service-role.
insert into public.drive_shares (organization_id, created_by, item_type, item_id, item_name, recipient_kind, recipient_email, token_hash)
values (:'org_a', :'eigenaar', 'folder', :'map', 'Werkwijze', 'link', 'gast@voorbeeld.test', 'hash-1') returning id as deling \gset

create function pg_temp.gedeeld(p_share uuid) returns text language sql as $$
  select coalesce(string_agg(name, ',' order by name), '') from public.drive_share_items(p_share);
$$;

select pg_temp.gelijk(pg_temp.gedeeld(:'deling'), 'a1.pdf,Document 1,Notitie 1', 'bij het delen: wat er toen in de map en de submap stond');

-- ── 2. Later toegevoegd: niet gedeeld, wel gemeld ──────────────────────────
insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
values (:'org_a', 'folder', :'map', 'a2.pdf', 'application/pdf', 10, :'org_a' || '/folder/a2.pdf') returning id as a2 \gset
insert into public.notes (organization_id, folder_id, title) values (:'org_a', :'submap', 'Notitie 2') returning id as n2 \gset

select pg_temp.gelijk(pg_temp.gedeeld(:'deling'), 'a1.pdf,Document 1,Notitie 1', 'later toegevoegd: de ontvanger ziet het niet');

create function pg_temp.gaten(p_user uuid, p_folder uuid) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  select coalesce(string_agg(g.item_type || ':' || g.item_id::text, ',' order by g.item_type, g.item_id), '')
    into v from public.drive_share_folder_gaps(p_folder) g;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

select pg_temp.gelijk(pg_temp.gaten(:'eigenaar', :'map'), 'attachment:' || :'a2', 'de drive meldt het nieuwe bestand in de map');
select pg_temp.gelijk(pg_temp.gaten(:'eigenaar', :'submap'), 'note:' || :'n2', 'en de nieuwe notitie in de submap');
select pg_temp.gelijk(pg_temp.gaten(:'lezer', :'map'), 'attachment:' || :'a2', 'wie Inhoud mag lezen, ziet de melding ook');
select pg_temp.gelijk(pg_temp.gaten(:'eigenaar_b', :'map'), '', 'een andere organisatie hoort niets');
select pg_temp.gelijk(pg_temp.gaten(:'eigenaar', :'andere_map'), '', 'een map die niet gedeeld is, heeft geen gaten');

-- ── 3. Aanvullen met "Ook delen" ───────────────────────────────────────────
create function pg_temp.vul_aan(p_user uuid, p_share uuid, p_items jsonb) returns integer language plpgsql as $$
declare v integer;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  v := public.drive_share_add_items(p_share, p_items);
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

select pg_temp.weigert(
  format('select pg_temp.vul_aan(%L, %L, %L)', :'lezer', :'deling', jsonb_build_array(jsonb_build_object('item_type', 'attachment', 'item_id', :'a2'))),
  'Je mag deze deling niet aanvullen.', 'alleen lezen: aanvullen kan niet');
reset role;
select pg_temp.beheer();

select pg_temp.weigert(
  format('select pg_temp.vul_aan(%L, %L, %L)', :'eigenaar_b', :'deling', jsonb_build_array(jsonb_build_object('item_type', 'attachment', 'item_id', :'a2'))),
  'Je mag deze deling niet aanvullen.', 'een andere organisatie kan niet aanvullen');
reset role;
select pg_temp.beheer();

select pg_temp.weigert(
  format('select pg_temp.vul_aan(%L, %L, %L)', :'eigenaar', :'deling', jsonb_build_array(jsonb_build_object('item_type', 'attachment', 'item_id', :'elders'))),
  'Niet alles staat in de gedeelde map.', 'een bestand van buiten de map kan er niet bij');
reset role;
select pg_temp.beheer();

select pg_temp.weigert(
  format('select pg_temp.vul_aan(%L, %L, %L)', :'eigenaar', :'deling', '[]'),
  'Geef de items op als lijst', 'een lege lijst wordt geweigerd');
reset role;
select pg_temp.beheer();

select pg_temp.gelijk(
  pg_temp.vul_aan(:'eigenaar', :'deling', jsonb_build_array(jsonb_build_object('item_type', 'attachment', 'item_id', :'a2'))),
  1, 'de eigenaar deelt het nieuwe bestand');
select pg_temp.gelijk(pg_temp.gedeeld(:'deling'), 'a1.pdf,a2.pdf,Document 1,Notitie 1', 'nu ziet de ontvanger het');
select pg_temp.gelijk(pg_temp.gaten(:'eigenaar', :'map'), '', 'en de melding is weg');
select pg_temp.gelijk(
  pg_temp.vul_aan(:'eigenaar', :'deling', jsonb_build_array(jsonb_build_object('item_type', 'attachment', 'item_id', :'a2'))),
  0, 'nog een keer delen voegt niets toe');
select pg_temp.gelijk(
  (select added_by from public.drive_share_entries where share_id = :'deling' and item_id = :'a2'),
  :'eigenaar'::uuid, 'de lijst onthoudt wie het deelde');

-- ── 4. Verplaatsen uit de map en terug ─────────────────────────────────────
update public.attachments set entity_id = :'andere_map' where id = :'a1';
select pg_temp.gelijk(pg_temp.gedeeld(:'deling'), 'a2.pdf,Document 1,Notitie 1', 'uit de map verplaatst: niet meer zichtbaar');
update public.attachments set entity_id = :'map' where id = :'a1';
select pg_temp.gelijk(pg_temp.gedeeld(:'deling'), 'a1.pdf,a2.pdf,Document 1,Notitie 1', 'terugverplaatst: weer zichtbaar');

-- ── 5. Alleen via de functies; opnieuw delen legt vast ─────────────────────
select pg_temp.als(:'eigenaar');
set local role authenticated;
select pg_temp.weigert(
  format('insert into public.drive_share_entries (share_id, organization_id, item_type, item_id) values (%L, %L, %L, %L)', :'deling', :'org_a', 'note', :'n2'),
  'row-level security', 'zelf een regel in de lijst zetten kan niet');
select pg_temp.weigert(format('select public.drive_share_capture(%L)', :'deling'), 'permission denied', 'vastleggen is alleen voor de deeldienst');
select pg_temp.weigert(format('select * from public.drive_share_items(%L)', :'deling'), 'permission denied', 'de inhoud van een deling lezen ook');
reset role;
select pg_temp.beheer();

-- De deeldienst roept dit aan als iemand de map opnieuw deelt.
select pg_temp.gelijk(public.drive_share_capture(:'deling'), 1, 'opnieuw delen legt de nieuwe notitie vast');
select pg_temp.gelijk(pg_temp.gedeeld(:'deling'), 'a1.pdf,a2.pdf,Document 1,Notitie 1,Notitie 2', 'en de ontvanger ziet hem');

update public.drive_shares set revoked_at = now() where id = :'deling';
insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
values (:'org_a', 'folder', :'map', 'a3.pdf', 'application/pdf', 10, :'org_a' || '/folder/a3.pdf') returning id as a3 \gset
select pg_temp.weigert(
  format('select pg_temp.vul_aan(%L, %L, %L)', :'eigenaar', :'deling', jsonb_build_array(jsonb_build_object('item_type', 'attachment', 'item_id', :'a3'))),
  'Deze deling loopt niet meer.', 'een ingetrokken deling vul je niet aan');
reset role;
select pg_temp.beheer();
select pg_temp.gelijk(pg_temp.gaten(:'eigenaar', :'map'), '', 'een ingetrokken deling geeft geen melding meer');

\o
\echo Alle controles van gedeelde_mappen.sql geslaagd.
rollback;
