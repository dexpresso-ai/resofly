-- ============================================================
-- Databasetest: de audio van een meeting wissen (20261125090000)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: Inhoud → Meetings wist alleen de audio; transcript en notulen
-- blijven staan. De edge function haalt het bestand meteen uit R2. Lukt dat
-- niet, dan moet de opruimwachtrij het alsnog doen, anders blijft er audio in
-- R2 staan waar niets meer naar wijst (en die niemand meer opruimt). Deze test:
--
--   1. storage_key leeg maken zet de oude sleutel in storage_purge_queue,
--      meteen te verwerken, met de reden meeting_recording;
--   2. een hele opname wissen doet dat ook;
--   3. "audio verwijderd" kan niet met een sleutel of grootte erbij (anders
--      telde de opslagmeter hem nog mee);
--   4. alleen sleutels onder <organisatie>/meeting_recording/: een opname die
--      (vervalst) naar een notitiebestand of een factuur-PDF wijst, zet dat
--      bestand niet in de wachtrij;
--   5. een sleutel die nog bij een andere opname hoort, blijft staan;
--   6. een lid kan de audio niet zelf als gewist markeren (RLS: alleen lezen).
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

select gen_random_uuid() as eigenaar \gset
insert into auth.users (id, email, aud, role) values
  (:'eigenaar', 'eigenaar@audio.test', 'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Audio')).id as org \gset
reset role;
select pg_temp.beheer();

select gen_random_uuid() as opname \gset
select format('%s/meeting_recording/%s/meeting.webm', :'org', :'opname') as sleutel \gset

insert into public.meeting_recordings (id, organization_id, provider, event_ref, event_title_snapshot, consent_given,
                                       status, storage_key, size_bytes, transcript_text)
values (:'opname', :'org', 'native', 'afspraak-1', 'Kick-off', true, 'done', :'sleutel', 38400000, 'Spreker 1: hallo');

-- ── 1. Audio wissen: de sleutel gaat de wachtrij in ─────────────────────────

update public.meeting_recordings
   set storage_key = null, size_bytes = null, audio_deleted_at = now()
 where id = :'opname';

select pg_temp.gelijk((select count(*)::int from public.storage_purge_queue
                        where storage_key = :'sleutel' and reason = 'meeting_recording' and purge_after <= now()),
  1, 'de gewiste audio staat in de opruimwachtrij, meteen te verwerken');
select pg_temp.gelijk((select transcript_text from public.meeting_recordings where id = :'opname'), 'Spreker 1: hallo',
  'het transcript blijft staan');

-- Nog eens (een tweede klik, of de edge function die het opnieuw probeert): niet dubbel.
update public.meeting_recordings set storage_key = :'sleutel', size_bytes = 1, audio_deleted_at = null where id = :'opname';
update public.meeting_recordings set storage_key = null, size_bytes = null, audio_deleted_at = now() where id = :'opname';
select pg_temp.gelijk((select count(*)::int from public.storage_purge_queue where storage_key = :'sleutel'),
  1, 'dezelfde sleutel staat er maar één keer in');

-- Iets anders bijwerken (de notulen) zet niets in de wachtrij.
delete from public.storage_purge_queue where storage_key = :'sleutel';
update public.meeting_recordings set summary_text = 'Samenvatting' where id = :'opname';
select pg_temp.gelijk((select count(*)::int from public.storage_purge_queue where organization_id = :'org'),
  0, 'de notulen bijwerken raakt de opslag niet');

-- ── 2. Een hele opname wissen ───────────────────────────────────────────────

select gen_random_uuid() as tweede \gset
select format('%s/meeting_recording/%s/meeting.webm', :'org', :'tweede') as tweede_sleutel \gset
insert into public.meeting_recordings (id, organization_id, consent_given, status, storage_key, size_bytes)
values (:'tweede', :'org', true, 'uploaded', :'tweede_sleutel', 1000);
delete from public.meeting_recordings where id = :'tweede';
select pg_temp.gelijk((select count(*)::int from public.storage_purge_queue
                        where storage_key = :'tweede_sleutel' and reason = 'meeting_recording'),
  1, 'een gewiste opname zet zijn audio in de opruimwachtrij');

-- ── 3. Gewist is zonder sleutel en zonder grootte ───────────────────────────

select pg_temp.weigert(format(
  'update public.meeting_recordings set storage_key = %L, audio_deleted_at = now() where id = %L',
  :'sleutel', :'opname'), 'meeting_recordings_audio_gewist_zonder_sleutel', 'gewist met een sleutel erbij');
select pg_temp.weigert(format(
  'update public.meeting_recordings set size_bytes = 1000 where id = %L',
  :'opname'), 'meeting_recordings_audio_gewist_zonder_sleutel', 'gewist maar nog meetellen in de opslag');

-- ── 4. Alleen opnamesleutels ────────────────────────────────────────────────

select gen_random_uuid() as vervalst \gset
select format('%s/note/%s/belangrijk.pdf', :'org', gen_random_uuid()) as notitiebestand \gset
insert into public.meeting_recordings (id, organization_id, consent_given, status, storage_key)
values (:'vervalst', :'org', true, 'done', :'notitiebestand');
update public.meeting_recordings set storage_key = null where id = :'vervalst';
select pg_temp.gelijk((select count(*)::int from public.storage_purge_queue where storage_key = :'notitiebestand'),
  0, 'een opname die naar een notitiebestand wees, zet dat bestand niet in de wachtrij');

-- De wachtrij zelf weigert een bewijsstuk onder deze reden (de guard).
select format('%s/invoice-pdfs/%s.pdf', :'org', gen_random_uuid()) as factuur \gset
insert into public.storage_purge_queue (organization_id, storage_key, reason) values (:'org', :'factuur', 'meeting_recording');
select pg_temp.gelijk((select count(*)::int from public.storage_purge_queue where storage_key = :'factuur'),
  0, 'een factuur-PDF komt nooit in de wachtrij als opname');
select format('%s/document/%s.docx', :'org', gen_random_uuid()) as document \gset
insert into public.storage_purge_queue (organization_id, storage_key, reason) values (:'org', :'document', 'meeting_recording');
select pg_temp.gelijk((select count(*)::int from public.storage_purge_queue where storage_key = :'document'),
  0, 'een document komt niet in de wachtrij onder de reden opname');

-- ── 5. Gedeelde sleutel blijft staan ────────────────────────────────────────

select gen_random_uuid() as derde \gset
select gen_random_uuid() as vierde \gset
select format('%s/meeting_recording/%s/gedeeld.webm', :'org', :'derde') as gedeeld \gset
insert into public.meeting_recordings (id, organization_id, consent_given, status, storage_key) values
  (:'derde', :'org', true, 'done', :'gedeeld'),
  (:'vierde', :'org', true, 'done', :'gedeeld');
update public.meeting_recordings set storage_key = null where id = :'derde';
select pg_temp.gelijk((select count(*)::int from public.storage_purge_queue where storage_key = :'gedeeld'),
  0, 'een sleutel die nog bij een andere opname hoort, blijft staan');

-- ── 6. Een lid markeert niets zelf ──────────────────────────────────────────

select gen_random_uuid() as vijfde \gset
insert into public.meeting_recordings (id, organization_id, consent_given, status, storage_key, size_bytes)
values (:'vijfde', :'org', true, 'done', format('%s/meeting_recording/%s/a.webm', :'org', :'vijfde'), 500);
select pg_temp.als(:'eigenaar');
set local role authenticated;
update public.meeting_recordings set storage_key = null, size_bytes = null, audio_deleted_at = now() where id = :'vijfde';
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((select audio_deleted_at is null and storage_key is not null from public.meeting_recordings where id = :'vijfde'),
  true, 'eigenaar: de audio zelf als gewist markeren gaat niet (alleen via de edge function)');

\o
\echo Alle controles van meeting_audio_verwijderen.sql geslaagd.
rollback;
