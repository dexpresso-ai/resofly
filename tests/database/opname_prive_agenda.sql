-- ============================================================
-- Databasetest: afspraakopnames uit een privé-agenda (20261125110000)
--
-- Draait op een database met alle migraties (supabase db start), in één
-- transactie die altijd wordt teruggedraaid:
--
--   npm run test:database
--
-- Waarom: wie Agenda kon lezen, las ook de opnames (titel, transcript,
-- notulen) uit de privé-agenda van een collega. Deze test:
--
--   1. een collega ziet de opname uit jouw privé-agenda niet, wel die uit een
--      gedeelde agenda, wel als hij in Inhoud staat, en wel een telefoongesprek
--      en een notitie-opname;
--   2. jij ziet al je eigen opnames, ook zonder agenda; een opname die de
--      collega zelf maakte bij jouw privé-afspraak ziet hij ook;
--   3. iemand zonder Agenda ziet nog steeds geen afspraakopname (de module gate
--      blijft), wel wat in Inhoud staat;
--   4. de rechten worden één keer per query opgehaald (een InitPlan);
--   5. notulen uit een privé-agenda worden geen kaart op de gedeelde
--      beslislijst; uit een gedeelde agenda wel;
--   6. "notulen klaar" gaat alleen naar agents van iemand die de opname mag zien;
--   7. wat er al stond (signalen, kaarten, wachtende gebeurtenissen) gaat dicht
--      en noemt niets meer van de inhoud.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

begin;

\ir hulpjes.psql

select gen_random_uuid() as eigenaar, gen_random_uuid() as collega, gen_random_uuid() as inhoudlid \gset
insert into auth.users (id, email, aud, role) values
  (:'eigenaar', 'eigenaar@prive.test', 'authenticated', 'authenticated'),
  (:'collega', 'collega@prive.test', 'authenticated', 'authenticated'),
  (:'inhoudlid', 'inhoud@prive.test', 'authenticated', 'authenticated');

select pg_temp.als(:'eigenaar');
set local role authenticated;
select (public.create_organization('Bureau Privé')).id as org \gset
reset role;
select pg_temp.beheer();

set local brandcore.license_sync = 'true';
update public.organizations set licensed_seats = 10 where id = :'org';
insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
  (:'org', :'collega', 'collega@prive.test', 'member', 'active', '{}'),
  (:'org', :'inhoudlid', 'inhoud@prive.test', 'member', 'active', '{"calendar":"none"}');

insert into public.calendar_sources (organization_id, user_id, provider, provider_calendar_id, name, visibility) values
  (:'org', :'eigenaar', 'native', 'prive', 'Privé', 'private') returning id as prive \gset
insert into public.calendar_sources (organization_id, user_id, provider, provider_calendar_id, name, visibility) values
  (:'org', :'eigenaar', 'native', 'team', 'Team', 'organization') returning id as gedeeld \gset

insert into public.notes (organization_id, title) values (:'org', 'Meeting in Inhoud') returning id as inhoudnotitie \gset
insert into public.notes (organization_id, title) values (:'org', 'Notitie met opname') returning id as notitie \gset
insert into public.client_calls (organization_id, direction, outcome) values (:'org', 'outbound', 'answered') returning id as gesprek \gset

insert into public.meeting_recordings (organization_id, created_by, provider, source_id, event_ref, event_title_snapshot, consent_given)
values (:'org', :'eigenaar', 'native', :'prive', 'ev-1', 'Gesprek met de bank', true) returning id as r_prive \gset
insert into public.meeting_recordings (organization_id, created_by, provider, source_id, event_ref, event_title_snapshot, consent_given)
values (:'org', :'eigenaar', 'native', :'gedeeld', 'ev-2', 'Weekstart', true) returning id as r_gedeeld \gset
insert into public.meeting_recordings (organization_id, created_by, provider, source_id, event_ref, event_title_snapshot, consent_given, content_note_id)
values (:'org', :'eigenaar', 'native', :'prive', 'ev-3', 'Kick-off', true, :'inhoudnotitie') returning id as r_inhoud \gset
insert into public.meeting_recordings (organization_id, created_by, call_id, consent_given)
values (:'org', :'eigenaar', :'gesprek', true) returning id as r_gesprek \gset
insert into public.meeting_recordings (organization_id, created_by, note_id, consent_given)
values (:'org', :'eigenaar', :'notitie', true) returning id as r_notitie \gset
insert into public.meeting_recordings (organization_id, created_by, provider, source_id, event_ref, event_title_snapshot, consent_given)
values (:'org', :'eigenaar', 'native', null, 'ev-4', 'Agenda weg', true) returning id as r_zonder \gset
insert into public.meeting_recordings (organization_id, created_by, provider, source_id, event_ref, event_title_snapshot, consent_given)
values (:'org', :'collega', 'native', :'prive', 'ev-5', 'Collega nam op', true) returning id as r_collega \gset

-- Wat ziet iemand? De titels (of de soort), op volgorde.
create function pg_temp.ziet(p_user uuid) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.als(p_user);
  set local role authenticated;
  select string_agg(coalesce(m.event_title_snapshot, case when m.call_id is not null then 'gesprek' else 'notitie' end), ', '
                    order by coalesce(m.event_title_snapshot, case when m.call_id is not null then 'gesprek' else 'notitie' end) collate "C")
    into v from public.meeting_recordings m;
  reset role;
  perform pg_temp.beheer();
  return coalesce(v, '');
end $$;

-- ── 1 en 2. Wie ziet wat ────────────────────────────────────────────────────

select pg_temp.gelijk(pg_temp.ziet(:'collega'),
  'Collega nam op, Kick-off, Weekstart, gesprek, notitie',
  'collega: niet uit jouw privé-agenda, wel gedeeld, in Inhoud, gesprek, notitie en zijn eigen opname');
select pg_temp.gelijk(pg_temp.ziet(:'eigenaar'),
  'Agenda weg, Collega nam op, Gesprek met de bank, Kick-off, Weekstart, gesprek, notitie',
  'eigenaar: alles uit de eigen agenda''s, ook zonder agenda');

-- ── 3. De module gate blijft ────────────────────────────────────────────────

select pg_temp.gelijk(pg_temp.ziet(:'inhoudlid'), 'Kick-off, notitie',
  'zonder Agenda: alleen wat in Inhoud staat');

-- ── 4. Eén keer per query ───────────────────────────────────────────────────

select pg_temp.als(:'collega');
set local role authenticated;
create temp table plan_regels (regel text) on commit drop;
do $$
declare r record;
begin
  for r in execute 'explain select * from public.meeting_recordings' loop
    insert into plan_regels values (r."QUERY PLAN");
  end loop;
end $$;
reset role;
select pg_temp.beheer();
select pg_temp.gelijk((select count(*) > 0 from plan_regels where regel ~ 'source_id = ANY \(\(InitPlan \d+\)'), true,
  'plan: de agenda''s als InitPlan, niet per rij');
select pg_temp.gelijk((select count(*) from plan_regels where regel ilike '%SubPlan%'), 0::bigint, 'plan: geen subplan per rij');

-- ── 5. Beslislijst ──────────────────────────────────────────────────────────

insert into public.ai_signal_settings (organization_id, enabled) values (:'org', true)
  on conflict (organization_id) do update set enabled = true;

update public.meeting_recordings set status = 'done',
  summary_json = '{"samenvatting":"x","besproken":[],"besluiten":[],"actiepunten":["Hypotheek opzeggen"],"vervolgafspraken":[]}'
 where id in (:'r_prive', :'r_gedeeld');
select pg_temp.gelijk((select count(*) from public.ai_signals where entity_id = :'r_prive'), 0::bigint,
  'beslislijst: geen signaal voor notulen uit een privé-agenda');
select pg_temp.gelijk((select count(*) from public.ai_signals where entity_id = :'r_gedeeld' and kind = 'meeting_notes_ready'), 1::bigint,
  'beslislijst: wel voor notulen uit een gedeelde agenda');

-- De veegronde voor "nog niet gemaild": alleen opnames van meer dan een
-- etmaal oud. updated_at zet een trigger op nu; die even uit.
alter table public.meeting_recordings disable trigger meeting_recordings_updated;
update public.meeting_recordings set summary_text = 'x', summary_sent_at = null, updated_at = now() - interval '2 days'
 where id in (:'r_prive', :'r_gedeeld');
alter table public.meeting_recordings enable trigger meeting_recordings_updated;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.collect_time_signals(:'org');
select pg_temp.beheer();
select pg_temp.gelijk((select count(*) from public.ai_signals where entity_id = :'r_prive'), 0::bigint,
  'veegronde: niet "nog niet gemaild" voor een privé-meeting');
select pg_temp.gelijk((select count(*) from public.ai_signals where entity_id = :'r_gedeeld' and kind = 'meeting_notes_unsent'), 1::bigint,
  'veegronde: wel voor een gedeelde');

-- ── 6. Agents ───────────────────────────────────────────────────────────────

insert into public.ai_agents (organization_id, created_by, run_as_user_id, name, status, schedule_kind, trigger_events)
values (:'org', :'eigenaar', :'eigenaar', 'Agent eigenaar', 'active', 'event', array['meeting_recording.ready']) returning id as agent_eigenaar \gset
insert into public.ai_agents (organization_id, created_by, run_as_user_id, name, status, schedule_kind, trigger_events)
values (:'org', :'collega', :'collega', 'Agent collega', 'active', 'event', array['meeting_recording.ready']) returning id as agent_collega \gset
insert into public.ai_agents (organization_id, created_by, run_as_user_id, name, status, schedule_kind, trigger_events)
values (:'org', :'collega', null, 'Agent collega zonder run_as', 'active', 'event', array['meeting_recording.ready']) returning id as agent_collega2 \gset

insert into public.meeting_recordings (organization_id, created_by, provider, source_id, event_ref, event_title_snapshot, consent_given)
values (:'org', :'eigenaar', 'native', :'prive', 'ev-6', 'Privé twee', true) returning id as r_prive2 \gset
insert into public.meeting_recordings (organization_id, created_by, provider, source_id, event_ref, event_title_snapshot, consent_given)
values (:'org', :'eigenaar', 'native', :'gedeeld', 'ev-7', 'Gedeeld twee', true) returning id as r_gedeeld2 \gset
update public.meeting_recordings set status = 'done' where id in (:'r_prive2', :'r_gedeeld2');

select pg_temp.gelijk((select string_agg(a.name, ', ' order by a.name collate "C") from public.ai_agent_events e join public.ai_agents a on a.id = e.agent_id where e.entity_id = :'r_prive2'),
  'Agent eigenaar', 'agents: notulen uit een privé-agenda alleen naar de agent van de eigenaar');
select pg_temp.gelijk((select count(*) from public.ai_agent_events where entity_id = :'r_gedeeld2'), 3::bigint,
  'agents: uit een gedeelde agenda naar alle drie');

-- ── 7. Wat er al stond ──────────────────────────────────────────────────────
-- Zoals vóór deze migratie: een signaal, een open kaart en een wachtende
-- gebeurtenis bij de collega, met de inhoud erin. Dan de opruimstap die de
-- migratie draait (close_private_meeting_signals).

insert into public.ai_signals (organization_id, kind, signal_key, entity_type, entity_id, payload, status)
values (:'org', 'meeting_notes_ready', 'meeting:oud:tasks', 'meeting_recording', :'r_prive',
        '{"title":"Gesprek met de bank","actiepunten":["Hypotheek opzeggen"]}', 'queued');
insert into public.ai_decisions (organization_id, kind, module, origin, severity, entity_type, entity_id, title, summary, evidence, status, signal_key)
values (:'org', 'meeting_notes_ready', 'calendar', 'rule', 'normal', 'meeting_recording', :'r_prive',
        'Actiepunten uit Gesprek met de bank', 'Hypotheek opzeggen', '[{"x":"Hypotheek opzeggen"}]', 'open', 'meeting:oud:tasks');
insert into public.ai_agent_events (organization_id, agent_id, event_type, entity_type, entity_id, summary)
values (:'org', :'agent_collega', 'meeting_recording.ready', 'meeting_recording', :'r_prive', '{"title":"Gesprek met de bank"}');

select public.close_private_meeting_signals();

select pg_temp.gelijk((select status || ' | ' || payload::text from public.ai_signals where signal_key = 'meeting:oud:tasks'),
  format('skipped | {"recording_id": "%s"}', :'r_prive'), 'oud signaal: overgeslagen, zonder titel en actiepunten');
select pg_temp.gelijk((select status || ' | ' || title || ' | ' || summary || ' | ' || evidence::text from public.ai_decisions where signal_key = 'meeting:oud:tasks'),
  'expired | Notulen van een privé-afspraak |  | []', 'oude kaart: dicht, zonder wat er besproken is');
select pg_temp.gelijk((select status || ' | ' || summary::text from public.ai_agent_events where agent_id = :'agent_collega' and entity_id = :'r_prive'),
  'skipped | {}', 'oude gebeurtenis bij de collega: overgeslagen, zonder titel');
select pg_temp.gelijk((select status from public.ai_agent_events where agent_id = :'agent_eigenaar' and entity_id = :'r_prive2'),
  'pending', 'de gebeurtenis bij de eigenaar blijft staan');
select pg_temp.gelijk((select count(*) from public.ai_signals where entity_id = :'r_gedeeld' and status = 'queued'), 2::bigint,
  'signalen over een gedeelde meeting blijven staan');

\o
\echo Alle controles van opname_prive_agenda.sql geslaagd.
rollback;
