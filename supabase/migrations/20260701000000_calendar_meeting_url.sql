-- ============================================================
-- ResoFly — Videovergadering-link op agenda-items
-- Date: 2026-07-01
--
-- Voegt een vrij veld `meeting_url` toe aan native agenda-items, zodat een
-- Google Meet-, Microsoft Teams- of Zoom-link (of elke andere videocall-URL)
-- aan een afspraak gekoppeld kan worden. Externe Google/Microsoft-agenda's
-- bewaren hun videovergadering in de provider zelf (hangoutLink / onlineMeeting
-- of in de omschrijving), dus die hebben hier geen kolom voor nodig.
--
-- De CalDAV-Worker projecteert dit later naar de iCalendar CONFERENCE-property;
-- voorlopig vullen de edge-functie en de e-mailuitnodiging het rechtstreeks.
-- ============================================================

begin;

alter table public.calendar_events
  add column if not exists meeting_url text;

comment on column public.calendar_events.meeting_url is
  'Optionele videocall-link (Google Meet / Teams / Zoom / overig) voor dit agenda-item.';

commit;
