# Agenda — videovergaderingen (Google Meet / Teams / Zoom) op agenda-items

**Datum:** 2026-07-01
**Status:** Gebouwd, typecheck + build groen. **Nog niet gedeployed** naar staging.

## Wat is er toegevoegd
Bij het aanmaken én bewerken van een agenda-item kan nu een videocall aan de
afspraak gekoppeld worden, om videocalls maximaal te ondersteunen:

- **Automatisch genereren** (één klik, echte werkende link, géén extra koppeling/scope nodig):
  - **Google-agenda → Google Meet** via `conferenceData.createRequest`
    (`conferenceDataVersion=1`); de `hangoutLink` wordt teruggelezen.
  - **Microsoft-agenda → Teams-vergadering** via `isOnlineMeeting: true` +
    `onlineMeetingProvider: 'teamsForBusiness'`; `onlineMeeting.joinUrl` wordt teruggelezen.
- **Zelf een link plakken** (Meet / Teams / Zoom / overig), werkt op elke agenda:
  - **Native ResoFly-agenda**: opgeslagen in nieuwe kolom `calendar_events.meeting_url`.
  - **Google/Microsoft**: als herkenbare regel (`🎥 Videocall: <url>`) onderaan de
    omschrijving gezet — zo blijft de link ook in Google Calendar/Outlook zichtbaar —
    en er weer uit gelezen bij het ophalen. Bestaande Meet/Teams-links van events die
    buiten ResoFly zijn aangemaakt, worden ook herkend (join-knop verschijnt vanzelf).

## Waar zichtbaar
- **Deelnemen-knop** in het afspraak-detailpaneel (met provider-label: Google Meet / Teams / Zoom / Videocall).
- **Videocall-icoontje** op het afspraakblok (dag/week) en in de lijstweergave.
- **E-mailuitnodigingen** (native agenda met genodigden): join-link in de mailtekst,
  in het `.ics` (`DESCRIPTION` + RFC 7986 `CONFERENCE`-property). Niet in annuleringen.

## Bestanden
- `supabase/migrations/20260701000000_calendar_meeting_url.sql` — kolom `meeting_url` (nullable).
- `supabase/functions/calendar-integrations/index.ts` — normalisatie (`sanitizeMeetingUrl`,
  `withMeetingLine`/`stripMeetingLine`/`readMeetingUrl`, `googleConferenceUrl`), Google/Microsoft
  body-builders + base-event-mappers met conference-generatie en teruglezen, native create/update +
  `nativeRowToBaseEvent`, list-normalisatie (MS `$select` + `isOnlineMeeting,onlineMeeting`),
  privé-maskering, ICS + uitnodigingsmail.
- `src/types.ts` — `CalendarExternalEvent.meeting_url`.
- `src/lib/calendar-api.ts` — `CalendarEventInput.meetingUrl` + `addConference`.
- `src/lib/meeting.ts` — `detectMeetingKind` (provider-label) + `isValidMeetingUrl`.
- `src/features/CalendarPage.tsx` — `MeetingFields`-component (in beide formulieren), state +
  resets, submit/edit/reschedule (link behouden bij verplaatsen), Deelnemen-knop, blok/lijst-icoon.
- `src/styles/globals.css` — `.event-detail-join-link`, `.tb-ev-video`, `.calendar-item-video`,
  `.event-meeting-field`, `.calendar-help-warn`.

## Resteert / aandachtspunten
- **Deployen naar staging**: migratie toepassen + `calendar-integrations` opnieuw deployen.
  Edge-functie zit niet in `npm run typecheck` → ná deploy losse `tsc`/boot-health-check draaien
  (zie geheugen "verify-edge-function-deploys"), Deno was hier lokaal niet beschikbaar.
- **Geen nieuwe OAuth-scopes** nodig (Meet gebruikt de bestaande Agenda-scope, Teams de
  bestaande Calendars.ReadWrite).
- Bekende v1-beperking: een handmatige link op een Microsoft-agenda met een héél lange
  omschrijving kan buiten de 255-teken `bodyPreview` vallen bij het teruglezen; op zulke
  agenda's is auto-Teams de aanbevolen route. Bij het bewerken van een auto-gegenereerde
  Meet/Teams-afspraak toont het plakveld de bestaande link (informatief, ongevaarlijk).
