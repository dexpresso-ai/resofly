-- ============================================================
-- ResoFly — Een meeting uit de agenda komt vanzelf in Inhoud
-- Date: 2026-11-24
--
-- Waarom: sinds 20261124100000 vroeg de opnamekaart na het transcriberen of
-- de meeting ook in Inhoud moest. Dat ging alleen als je de afspraak open had
-- staan op het moment dat het transcript binnenkwam. Liep het uitschrijven op
-- de achtergrond door (je sloot het venster, of de webhook van ElevenLabs kwam
-- later), dan kwam er geen vraag en ook geen notitie, tot iemand de afspraak
-- weer opende en op Opslaan klikte. Een meeting stond daardoor vaak niet in de
-- map Meetings van de klant.
--
-- Nu zet de server de meeting zelf in Inhoud, zodra het transcript er is
-- (_shared/meetingInhoud.ts, aangeroepen uit _shared/meetingPipeline.ts). Op
-- dat moment is er geen browser meer: wat de app wist toen de opname werd
-- aangemaakt, moet dus op de opname staan.
--
-- Wat er verandert, op meeting_recordings:
-- 1. save_to_content: zet deze meeting na het transcriberen in Inhoud. De app
--    zet hem aan bij een gedeelde afspraak, voor wie Agenda én Inhoud mag
--    wijzigen; meeting-transcribe controleert dat bij het aanmaken. De
--    notulen van een privé-afspraak horen niet ongemerkt in de gedeelde
--    Inhoud, dus daar blijft hij uit.
-- 2. meeting_date: de dag van de afspraak zoals je hem in de agenda zag, voor
--    de titel "<titel> — <datum>". De opname zelf ontstaat pas na afloop, en
--    wordt soms pas later uitgeschreven.
-- 3. event_starts_at en event_ends_at: begin en eind van de afspraak. Daarmee
--    hangt de server de notitie ook onder Notities bij de afspraak; een
--    koppeling (note_calendar_links) wijst een afspraak aan met zijn begintijd.
-- 4. Alleen een opname bij een afspraak kan zo in Inhoud. Een notitie-opname
--    staat er al, een gesprek hoort bij het klantdossier.
--
-- Schrijven gaat zoals altijd alleen via de service-role in meeting-transcribe.
-- Lezen verandert niet.
--
-- Veilig om opnieuw te draaien.
-- ============================================================

begin;

alter table public.meeting_recordings
  add column if not exists save_to_content boolean not null default false,
  add column if not exists meeting_date date,
  add column if not exists event_starts_at timestamptz,
  add column if not exists event_ends_at timestamptz;

comment on column public.meeting_recordings.save_to_content is
  'Zet deze meeting uit de agenda na het transcriberen vanzelf in Inhoud, in de map Meetings bij de klant (of onder Geen klant).';
comment on column public.meeting_recordings.meeting_date is
  'De dag van de afspraak zoals de gebruiker hem in de agenda zag; voor de titel van de notitie in Inhoud.';
comment on column public.meeting_recordings.event_starts_at is
  'Begin van de afspraak; om de notitie in Inhoud ook onder Notities bij de afspraak te hangen.';
comment on column public.meeting_recordings.event_ends_at is
  'Eind van de afspraak.';

alter table public.meeting_recordings drop constraint if exists meeting_recordings_vanzelf_alleen_afspraak;
alter table public.meeting_recordings add constraint meeting_recordings_vanzelf_alleen_afspraak check (
  not save_to_content or (note_id is null and call_id is null)
);

commit;
