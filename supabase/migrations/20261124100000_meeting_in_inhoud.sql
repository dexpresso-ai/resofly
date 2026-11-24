-- ============================================================
-- ResoFly — Een meeting uit de agenda opslaan in Inhoud
-- Date: 2026-11-24
--
-- Waarom: na het transcriberen stonden het transcript en de notulen alleen
-- bij de afspraak in de agenda. Om een meeting later terug te vinden moest je
-- de agenda doorzoeken. Nu vraagt de opnamekaart of de meeting ook in Inhoud
-- moet. Zeg je ja, dan komt er bij de klant (of onder Geen klant) een map
-- Meetings met een notitie "<titel> — <datum>". In die notitie wissel je
-- tussen de notulen en het volledige transcript.
--
-- Wat er verandert:
-- 1. meeting_recordings.content_note_id: de notitie in Inhoud waarin deze
--    opname is opgeslagen. Wis je die notitie, dan blijft de opname bij de
--    afspraak staan (set null). Wis je de opname, dan blijft de notitie met
--    de notulen staan; alleen het transcript is dan weg. Eén notitie per
--    opname en andersom.
--    Dit is iets anders dan note_id (20261123150000). Daar hoort de opname
--    bij de notitie en nergens anders bij. Hier blijft de opname bij de
--    afspraak horen, en staat er een kopie van de notulen in Inhoud.
-- 2. De notitie hoort bij dezelfde organisatie (zelfde controle als de andere
--    verwijzingen).
-- 3. Lezen. Een opname bij een afspraak viel tot nu toe alleen onder Agenda.
--    Staat hij in Inhoud, dan mag ook wie Inhoud kan lezen het transcript
--    zien: hij staat dan immers in Inhoud. Zonder deze regel bleef de
--    wissel naar het transcript leeg voor wie Agenda niet heeft.
--    Nog steeds één keer per query (20261122200000): de lijsten zijn
--    subqueries zonder verwijzing naar de rij.
--
-- Schrijven gaat zoals altijd alleen via de service-role in de edge function
-- meeting-transcribe (actie saveToContent). Die controleert schrijfrecht op
-- Agenda én op Inhoud.
--
-- Veilig om opnieuw te draaien.
-- ============================================================

begin;

-- 1. De kolom
alter table public.meeting_recordings
  add column if not exists content_note_id uuid references public.notes(id) on delete set null;

create unique index if not exists uq_meeting_recordings_content_note
  on public.meeting_recordings(content_note_id) where content_note_id is not null;

comment on column public.meeting_recordings.content_note_id is
  'De notitie in Inhoud (map Meetings) waarin deze meeting uit de agenda is opgeslagen.';

-- Een notitie-opname staat al in Inhoud; die krijgt geen tweede notitie.
alter table public.meeting_recordings drop constraint if exists meeting_recordings_inhoud_alleen_afspraak;
alter table public.meeting_recordings add constraint meeting_recordings_inhoud_alleen_afspraak check (
  content_note_id is null or note_id is null
);

-- 2. Zelfde organisatie
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
  perform public.assert_same_org_reference('public.notes', new.content_note_id, new.organization_id, 'meeting_recordings.content_note_id');
  return new;
end;
$$;

revoke all on function public.enforce_meeting_recordings_org_integrity() from public, anon, authenticated;

drop trigger if exists meeting_recordings_org_integrity on public.meeting_recordings;
create trigger meeting_recordings_org_integrity
  before insert or update of organization_id, client_id, project_id, source_id, call_id, note_id, content_note_id on public.meeting_recordings
  for each row execute function public.enforce_meeting_recordings_org_integrity();

-- 3. Lezen: wie Inhoud kan lezen, ziet ook de opname die in Inhoud staat
drop policy if exists "module gate select" on public.meeting_recordings;
create policy "module gate select" on public.meeting_recordings
  as restrictive for select to authenticated
  using (
    case when note_id is null
      then organization_id = any ((select public.my_module_organization_ids('calendar'))::uuid[])
        or (content_note_id is not null
            and organization_id = any ((select public.my_module_organization_ids('content'))::uuid[]))
      else organization_id = any ((select public.my_module_organization_ids('content'))::uuid[])
    end
  );

commit;
