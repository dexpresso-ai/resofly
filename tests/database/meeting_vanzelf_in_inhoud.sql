-- ============================================================
-- Databasetest: een meeting komt vanzelf in Inhoud (20261124170000)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: zodra het transcript er is, zet de server een meeting uit de agenda
-- in de map Meetings van de klant. Wat de app bij het opnemen wist (vraag om
-- Inhoud, dag en tijd van de afspraak) staat daarvoor op de opname. Deze test:
--
--   1. een nieuwe opname vraagt niets, tot de server het aanzet;
--   2. alleen een opname bij een afspraak kan het vragen: een notitie-opname
--      staat al in Inhoud, een gesprek hoort bij het klantdossier;
--   3. een lid kan de vraag niet zelf aanzetten: dat loopt via de edge
--      function, die de rechten controleert.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

select gen_random_uuid() as eigenaar \gset
insert into auth.users (id, email, aud, role) values
  (:'eigenaar', 'eigenaar@vanzelf.test', 'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Vanzelf')).id as org \gset
reset role;
select pg_temp.beheer();

insert into public.notes (organization_id, title) values (:'org', 'Notitie met opname') returning id as notitie \gset
insert into public.client_calls (organization_id, direction, outcome) values (:'org', 'outbound', 'answered') returning id as gesprek \gset

-- ── 1. Standaard niet ───────────────────────────────────────────────────────

insert into public.meeting_recordings (organization_id, provider, event_ref, event_title_snapshot, consent_given)
values (:'org', 'native', 'afspraak-1', 'Kick-off', true) returning id as opname \gset
select pg_temp.gelijk((select save_to_content from public.meeting_recordings where id = :'opname'), false,
  'een nieuwe opname vraagt niet om Inhoud');

-- Zoals meeting-transcribe hem aanmaakt bij een gedeelde afspraak.
insert into public.meeting_recordings (organization_id, provider, event_ref, event_title_snapshot, consent_given,
                                       save_to_content, meeting_date, event_starts_at, event_ends_at)
values (:'org', 'native', 'afspraak-2', 'Voortgang', true, true, '2026-11-20', '2026-11-20T09:00:00+01', '2026-11-20T10:00:00+01')
returning id as vanzelf \gset
select pg_temp.gelijk((select meeting_date from public.meeting_recordings where id = :'vanzelf'), '2026-11-20'::date,
  'de dag van de afspraak staat op de opname');

-- ── 2. Alleen bij een afspraak ──────────────────────────────────────────────

select pg_temp.weigert(format(
  'insert into public.meeting_recordings (organization_id, note_id, consent_given, save_to_content) values (%L, %L, true, true)',
  :'org', :'notitie'), 'meeting_recordings_vanzelf_alleen_afspraak', 'een notitie-opname vraagt niet om de map Meetings');
select pg_temp.weigert(format(
  'insert into public.meeting_recordings (organization_id, call_id, consent_given, save_to_content) values (%L, %L, true, true)',
  :'org', :'gesprek'), 'meeting_recordings_vanzelf_alleen_afspraak', 'een gespreksopname vraagt niet om de map Meetings');

-- ── 3. Niet zelf aanzetten ──────────────────────────────────────────────────

select pg_temp.als(:'eigenaar');
set local role authenticated;
update public.meeting_recordings set save_to_content = true where id = :'opname';
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((select save_to_content from public.meeting_recordings where id = :'opname'), false,
  'eigenaar: zelf de vraag aanzetten gaat niet');

\o
\echo Alle controles van meeting_vanzelf_in_inhoud.sql geslaagd.
rollback;
