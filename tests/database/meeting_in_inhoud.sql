-- ============================================================
-- Databasetest: een meeting uit de agenda in Inhoud (20261124100000)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: een opname bij een afspraak viel alleen onder Agenda. Zet je hem in
-- Inhoud, dan staat hij in een notitie in de map Meetings, en moet wie Inhoud
-- kan lezen ook het transcript zien. Wie Inhoud niet heeft, ziet hem alleen
-- via Agenda, zoals altijd. Deze test:
--
--   1. zet een organisatie op met een lid zonder Inhoud en een zonder Agenda;
--   2. maakt twee afspraakopnames, waarvan één in Inhoud staat;
--   3. controleert per lid welke opnames hij ziet;
--   4. controleert de regels: de notitie hoort bij dezelfde organisatie, een
--      notitie-opname krijgt geen tweede notitie, één notitie per opname;
--   5. wist de notitie: de opname blijft bij de afspraak.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

-- ── 1. Leden en organisaties ────────────────────────────────────────────────

select gen_random_uuid() as eigenaar, gen_random_uuid() as zonder_inhoud,
       gen_random_uuid() as zonder_agenda, gen_random_uuid() as eigenaar_b \gset

insert into auth.users (id, email, aud, role) values
  (:'eigenaar',      'eigenaar@meeting.test',      'authenticated', 'authenticated'),
  (:'zonder_inhoud', 'zonder-inhoud@meeting.test', 'authenticated', 'authenticated'),
  (:'zonder_agenda', 'zonder-agenda@meeting.test', 'authenticated', 'authenticated'),
  (:'eigenaar_b',    'eigenaar-b@meeting.test',    'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Meeting')).id as org_a \gset
reset role;
select pg_temp.als(:'eigenaar_b');
set local role authenticated;
select (public.create_organization('Bureau Elders')).id as org_b \gset
reset role;
select pg_temp.beheer();

set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 10 where id in (:'org_a', :'org_b');

insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org_a', :'zonder_inhoud', 'zonder-inhoud@meeting.test', 'member', 'active', '{"content":"none"}'),
  (:'org_a', :'zonder_agenda', 'zonder-agenda@meeting.test', 'member', 'active', '{"calendar":"none"}');

-- ── 2. Twee afspraakopnames, één in Inhoud ─────────────────────────────────
-- Als beheerder, zoals meeting-transcribe met de service-role schrijft.

insert into public.content_folders (organization_id, name) values (:'org_a', 'Meetings') returning id as map \gset
insert into public.notes (organization_id, folder_id, title, note_type)
values (:'org_a', :'map', 'Kick-off — 24 november 2026', 'meeting') returning id as notitie \gset
insert into public.notes (organization_id, title) values (:'org_a', 'Andere notitie') returning id as andere_notitie \gset
insert into public.notes (organization_id, title) values (:'org_b', 'Notitie elders') returning id as notitie_b \gset

insert into public.meeting_recordings (organization_id, provider, event_ref, event_title_snapshot, consent_given, status, transcript_text, content_note_id)
values (:'org_a', 'native', 'afspraak-1', 'Kick-off', true, 'done', 'Spreker 1: Welkom.', :'notitie') returning id as in_inhoud \gset
insert into public.meeting_recordings (organization_id, provider, event_ref, event_title_snapshot, consent_given, status, transcript_text)
values (:'org_a', 'native', 'afspraak-2', 'Intern overleg', true, 'done', 'Spreker 1: Alleen agenda.') returning id as alleen_agenda \gset

-- ── 3. Wie ziet wat ─────────────────────────────────────────────────────────

create function pg_temp.ziet(p_user uuid) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  select coalesce(string_agg(event_title_snapshot, ',' order by event_title_snapshot), '')
    into v from public.meeting_recordings;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

select pg_temp.gelijk(pg_temp.ziet(:'eigenaar'), 'Intern overleg,Kick-off', 'eigenaar: allebei');
select pg_temp.gelijk(pg_temp.ziet(:'zonder_inhoud'), 'Intern overleg,Kick-off', 'zonder Inhoud: allebei, via Agenda');
select pg_temp.gelijk(pg_temp.ziet(:'zonder_agenda'), 'Kick-off', 'zonder Agenda: alleen de meeting die in Inhoud staat');
select pg_temp.gelijk(pg_temp.ziet(:'eigenaar_b'), '', 'andere organisatie: niets');

-- Nog steeds één keer per query: geen rechtenfunctie per rij in de leesregel.
select pg_temp.gelijk(
  (select pg_get_expr(p.polqual, p.polrelid) ~ '\m(can_read_org|can_read_module|user_is_org_member|org_module_level)\('
     from pg_policy p where p.polrelid = 'public.meeting_recordings'::regclass and p.polname = 'module gate select'),
  false, 'module gate select: geen rechtenfunctie per rij');

-- ── 4. De regels op de tabel ────────────────────────────────────────────────

select pg_temp.weigert(format(
  'update public.meeting_recordings set content_note_id = %L where id = %L', :'notitie_b', :'alleen_agenda'),
  'meeting_recordings.content_note_id', 'een notitie van een andere organisatie: geweigerd');
select pg_temp.weigert(format(
  'update public.meeting_recordings set content_note_id = %L where id = %L', :'notitie', :'alleen_agenda'),
  'uq_meeting_recordings_content_note', 'één notitie hoort bij één opname');
select pg_temp.weigert(format(
  'insert into public.meeting_recordings (organization_id, note_id, content_note_id, consent_given) values (%L, %L, %L, true)',
  :'org_a', :'andere_notitie', :'notitie'), 'meeting_recordings_inhoud_alleen_afspraak',
  'een notitie-opname staat al in Inhoud en krijgt geen tweede notitie');

-- Een lid kan de koppeling niet zelf leggen: dat loopt via de edge function.
select pg_temp.als(:'eigenaar');
set local role authenticated;
update public.meeting_recordings set content_note_id = :'andere_notitie' where id = :'alleen_agenda';
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((select content_note_id from public.meeting_recordings where id = :'alleen_agenda'), null::uuid,
  'eigenaar: zelf koppelen aan Inhoud gaat niet');

-- ── 5. Notitie weg, opname blijft ───────────────────────────────────────────

delete from public.notes where id = :'notitie';
select pg_temp.gelijk((select count(*) from public.meeting_recordings where id = :'in_inhoud'), 1::bigint,
  'notitie in Inhoud gewist: de opname blijft bij de afspraak');
select pg_temp.gelijk((select content_note_id from public.meeting_recordings where id = :'in_inhoud'), null::uuid,
  'en hangt niet meer aan Inhoud');
select pg_temp.gelijk(pg_temp.ziet(:'zonder_agenda'), '', 'zonder Agenda: nu niets meer');

\o
\echo Alle controles van meeting_in_inhoud.sql geslaagd.
rollback;
