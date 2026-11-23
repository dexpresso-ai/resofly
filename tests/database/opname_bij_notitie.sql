-- ============================================================
-- Databasetest: een opname bij een notitie (20261123150000)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: tot 23 november hing elke opname aan Agenda. Een opname bij een
-- notitie is inhoud van die notitie: wie Inhoud niet mag lezen, mag het
-- transcript ook niet krijgen, ook niet met Agenda. En wie alleen Inhoud
-- heeft, moet de opname bij zijn eigen notitie wel zien, anders blijft de
-- recorder in de notitie leeg. Deze test:
--
--   1. zet een organisatie op met vier leden: met alles, zonder Inhoud,
--      zonder Agenda, en een tweede organisatie;
--   2. maakt een opname bij een afspraak en een bij een notitie;
--   3. controleert per lid welke opnames hij ziet;
--   4. controleert de regels op de tabel: een notitie-opname heeft geen
--      afspraak of gesprek, en de notitie hoort bij dezelfde organisatie;
--   5. wist de notitie: de opname gaat mee.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

-- ── 1. Leden en organisaties ────────────────────────────────────────────────

select gen_random_uuid() as eigenaar, gen_random_uuid() as lid, gen_random_uuid() as zonder_inhoud,
       gen_random_uuid() as zonder_agenda, gen_random_uuid() as eigenaar_b \gset

insert into auth.users (id, email, aud, role) values
  (:'eigenaar',      'eigenaar@opname.test',      'authenticated', 'authenticated'),
  (:'lid',           'lid@opname.test',           'authenticated', 'authenticated'),
  (:'zonder_inhoud', 'zonder-inhoud@opname.test', 'authenticated', 'authenticated'),
  (:'zonder_agenda', 'zonder-agenda@opname.test', 'authenticated', 'authenticated'),
  (:'eigenaar_b',    'eigenaar-b@opname.test',    'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Opname')).id as org_a \gset
reset role;
select pg_temp.als(:'eigenaar_b');
set local role authenticated;
select (public.create_organization('Bureau Elders')).id as org_b \gset
reset role;
select pg_temp.beheer();

set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 10 where id in (:'org_a', :'org_b');

insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org_a', :'lid',           'lid@opname.test',           'member', 'active', '{}'),
  (:'org_a', :'zonder_inhoud', 'zonder-inhoud@opname.test', 'member', 'active', '{"content":"none"}'),
  (:'org_a', :'zonder_agenda', 'zonder-agenda@opname.test', 'member', 'active', '{"calendar":"none"}');

-- ── 2. Een notitie, een afspraakopname en een notitie-opname ───────────────
-- Als beheerder, zoals meeting-transcribe met de service-role schrijft.

insert into public.notes (organization_id, title) values (:'org_a', 'Ingesproken notitie') returning id as notitie \gset
insert into public.notes (organization_id, title) values (:'org_b', 'Notitie elders') returning id as notitie_b \gset

insert into public.meeting_recordings (organization_id, provider, event_ref, event_title_snapshot, consent_given, status)
values (:'org_a', 'native', 'afspraak-1', 'Kick-off', true, 'done') returning id as afspraak_opname \gset
insert into public.meeting_recordings (organization_id, note_id, event_title_snapshot, consent_given, status, transcript_text)
values (:'org_a', :'notitie', 'Ingesproken notitie', true, 'done', 'Wat ik insprak.') returning id as notitie_opname \gset

-- ── 3. Wie ziet wat ─────────────────────────────────────────────────────────

create function pg_temp.ziet(p_user uuid) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  select coalesce(string_agg(case when note_id is null then 'afspraak' else 'notitie' end, ',' order by note_id nulls first), '')
    into v from public.meeting_recordings;
  reset role;
  perform pg_temp.beheer();
  return v;
end $$;

select pg_temp.gelijk(pg_temp.ziet(:'eigenaar'), 'afspraak,notitie', 'eigenaar: allebei');
select pg_temp.gelijk(pg_temp.ziet(:'lid'), 'afspraak,notitie', 'lid met alles: allebei');
select pg_temp.gelijk(pg_temp.ziet(:'zonder_inhoud'), 'afspraak', 'zonder Inhoud: alleen de afspraak, niet het transcript van de notitie');
select pg_temp.gelijk(pg_temp.ziet(:'zonder_agenda'), 'notitie', 'zonder Agenda: wel de opname bij de notitie');
select pg_temp.gelijk(pg_temp.ziet(:'eigenaar_b'), '', 'andere organisatie: niets');

-- Nog steeds één keer per query: geen rechtenfunctie per rij in de leesregel.
select pg_temp.gelijk(
  (select pg_get_expr(p.polqual, p.polrelid) ~ '\m(can_read_org|can_read_module|user_is_org_member|org_module_level)\('
     from pg_policy p where p.polrelid = 'public.meeting_recordings'::regclass and p.polname = 'module gate select'),
  false, 'module gate select: geen rechtenfunctie per rij');

-- ── 4. De regels op de tabel ────────────────────────────────────────────────

select pg_temp.weigert(format(
  'insert into public.meeting_recordings (organization_id, note_id, provider, event_ref, consent_given) values (%L, %L, ''native'', ''x'', true)',
  :'org_a', :'notitie'), 'meeting_recordings_note_alleen', 'een notitie-opname hangt niet ook aan een afspraak');
select pg_temp.weigert(format(
  'insert into public.meeting_recordings (organization_id, note_id, consent_given) values (%L, %L, true)',
  :'org_a', :'notitie_b'), 'meeting_recordings.note_id', 'een notitie van een andere organisatie: geweigerd');

-- Een lid kan zelf geen opname-rij schrijven: dat loopt via de edge function.
select pg_temp.als(:'lid');
set local role authenticated;
select pg_temp.weigert(format(
  'insert into public.meeting_recordings (organization_id, note_id, consent_given) values (%L, %L, true)',
  :'org_a', :'notitie'), 'row-level security', 'lid: zelf een opname-rij aanmaken gaat niet');
reset role;
select pg_temp.beheer();

-- ── 5. Notitie weg, opname weg ──────────────────────────────────────────────

delete from public.notes where id = :'notitie';
select pg_temp.gelijk((select count(*) from public.meeting_recordings where id = :'notitie_opname'), 0::bigint,
  'notitie gewist: de opname met transcript gaat mee');
select pg_temp.gelijk((select count(*) from public.meeting_recordings where id = :'afspraak_opname'), 1::bigint,
  'de afspraakopname blijft staan');

\o
\echo Alle controles van opname_bij_notitie.sql geslaagd.
rollback;
