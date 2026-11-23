-- ============================================================
-- ResoFly — Een opname bij een notitie
-- Date: 2026-11-23
--
-- Waarom: bij een meeting neem je op, en krijg je een transcript en notulen.
-- Bij een notitie kon dat niet: een opname hing aan een afspraak
-- (provider/event_ref) of sinds 18 september aan een telefoongesprek
-- (call_id). Nu ook aan een notitie. De pijplijn erachter (upload naar R2,
-- ElevenLabs Scribe, Claude-notulen, transcript bijwerken, mailen) is precies
-- dezelfde; zie supabase/functions/meeting-transcribe.
--
-- Wat er verandert:
-- 1. meeting_recordings.note_id, met cascade: wis je de notitie, dan gaan
--    opname, transcript en notulen mee (de audio in R2 wist de app zelf,
--    deleteEntityCascade in src/lib/repository.ts).
-- 2. Een opname hangt aan één ding. Een notitie-opname heeft geen afspraak en
--    geen gesprek; anders kon iemand met alleen Inhoud via een notitie een
--    opname op andermans agenda-item zetten.
-- 3. note_id hoort bij dezelfde organisatie (zelfde controle als de andere
--    verwijzingen, 20260926000000).
-- 4. De module gate voor lezen. Tot nu toe hing elke opname aan Agenda. Een
--    opname bij een notitie is inhoud van die notitie en hangt aan Inhoud:
--    wie Inhoud niet mag lezen, krijgt het transcript niet terug, ook niet
--    als hij Agenda wel heeft (CLAUDE.md, harde regel 3). Opnames bij een
--    afspraak of gesprek blijven aan Agenda hangen, zoals ze waren.
--    Nog steeds één keer per query (20261122200000): de lijsten zijn
--    subqueries zonder verwijzing naar de rij.
-- 5. Agents krijgen geen gebeurtenis "opname klaar" voor een notitie-opname.
--    Die gebeurtenis en de handelingen erachter (meeting_recording.*) vallen
--    onder Agenda.
--
-- Schrijven gaat zoals altijd alleen via de service-role in de edge functions;
-- daar staat de poort per soort opname (resolveModuleKey).
--
-- Veilig om opnieuw te draaien.
-- ============================================================

begin;

-- 1. De kolom
alter table public.meeting_recordings
  add column if not exists note_id uuid references public.notes(id) on delete cascade;

create index if not exists idx_meeting_recordings_note
  on public.meeting_recordings(note_id) where note_id is not null;

comment on column public.meeting_recordings.note_id is
  'Gevuld als deze opname bij een notitie hoort in plaats van bij een afspraak of gesprek.';

-- 2. Eén eigenaar
alter table public.meeting_recordings drop constraint if exists meeting_recordings_note_alleen;
alter table public.meeting_recordings add constraint meeting_recordings_note_alleen check (
  note_id is null
  or (call_id is null and provider is null and source_id is null and event_ref is null)
);

-- 3. Zelfde organisatie
create or replace function public.enforce_meeting_recordings_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'meeting_recordings.client_id');
  perform public.assert_same_org_reference('public.projects', new.project_id, new.organization_id, 'meeting_recordings.project_id');
  perform public.assert_same_org_reference('public.calendar_sources', new.source_id, new.organization_id, 'meeting_recordings.source_id');
  perform public.assert_same_org_reference('public.client_calls', new.call_id, new.organization_id, 'meeting_recordings.call_id');
  perform public.assert_same_org_reference('public.notes', new.note_id, new.organization_id, 'meeting_recordings.note_id');
  return new;
end;
$$;

-- Een triggerfunctie is geen RPC: niemand roept hem rechtstreeks aan.
revoke all on function public.enforce_meeting_recordings_org_integrity() from public, anon, authenticated;

drop trigger if exists meeting_recordings_org_integrity on public.meeting_recordings;
create trigger meeting_recordings_org_integrity
  before insert or update of organization_id, client_id, project_id, source_id, call_id, note_id on public.meeting_recordings
  for each row execute function public.enforce_meeting_recordings_org_integrity();

-- 4. Lezen: een notitie-opname onder Inhoud, de rest onder Agenda
drop policy if exists "module gate select" on public.meeting_recordings;
create policy "module gate select" on public.meeting_recordings
  as restrictive for select to authenticated
  using (
    case when note_id is null
      then organization_id = any ((select public.my_module_organization_ids('calendar'))::uuid[])
      else organization_id = any ((select public.my_module_organization_ids('content'))::uuid[])
    end
  );

-- 5. Geen agentgebeurtenis voor een notitie-opname
create or replace function public.agent_event_recording_ready() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.note_id is null and new.status = 'done' and old.status is distinct from 'done' then
    perform public.enqueue_agent_event(new.organization_id, 'meeting_recording.ready', 'meeting_recording', new.id,
      jsonb_build_object('title', left(coalesce(new.event_title_snapshot, ''), 200),
        'client_id', new.client_id, 'project_id', new.project_id));
  end if;
  return new;
end;
$$;

revoke all on function public.agent_event_recording_ready() from public, anon, authenticated;

commit;
