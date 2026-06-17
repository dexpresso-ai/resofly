# Changelog — Agenda-item koppelen aan klant & project — 2026-06-17

Je kunt een agenda-item (meeting/event) nu direct bij het aanmaken aan een **klant**
en/of **project** koppelen. Daarna maak je met één klik een notitie of document met de
juiste klant/project al vooringevuld — precies waar de Inhoud-mappenboom op leunt.

## Toegevoegd
- **Nieuwe tabel `calendar_event_links`** (migratie `20260617000002_calendar_event_links.sql`):
  koppelt een extern agenda-item (Google/Microsoft) aan `client_id` en/of `project_id`.
  Org-scoped; het event wordt geïdentificeerd zoals `note_calendar_links` (provider +
  agenda + `provider_event_id` + starttijd, uniek). `client_id`/`project_id` zijn
  `on delete set null`. RLS + triggers (updated_at, validatie van org/provider/klant/
  project, `prevent_organization_id_change`, audit). De klant wordt automatisch uit het
  project afgeleid als die leeg is.
- **Event aanmaken** (`CalendarPage`): het aanmaakformulier (zowel het zwevende paneel als
  de lijstweergave-zijbalk) heeft nu een **Klant**- en **Project**-keuze. Bij opslaan wordt
  de koppeling meteen weggeschreven. Het projectmenu filtert op de gekozen klant.
- **Eventdetail**: een sectie **Koppeling (klant & project)** om de koppeling achteraf te
  zetten/wijzigen, plus naast **+ Notitie** nu ook **+ Document**. Beide vullen de
  klant/het project van de koppeling automatisch voor.
- Herbruikbare `ClientProjectPicker` in `CalendarPage`.

## Aangepast
- `openNoteForCalendarEvent` (main.tsx) vult klant/project voor uit de eventkoppeling;
  nieuwe `openDocumentForCalendarEvent` en `setCalendarEventLink` (upsert/verwijderen).
- Repository: `selectCalendarEventLinks` (met nette fallback als de migratie nog niet is
  uitgevoerd), `upsertCalendarEventLink`, `deleteCalendarEventLink`; geladen in
  `loadAppData`. `AppData` bevat nu `calendarEventLinks`.
- Types: `CalendarEventLink` + `CalendarEventLinkInput`.
- CSS: `.event-link-panel`, `.event-notes-actions`, `.tb-panel-section-label` e.a.

## Privacy / integriteit
- Voor privé-agenda-items wordt de event-**titel niet** in de (org-breed leesbare)
  koppeltabel opgeslagen, en is koppelen/notitie/document maken vanuit het eventdetail
  uitgeschakeld — zelfde lijn als de bestaande notitie-koppeling.
- Koppelingen zijn strikt org-scoped via RLS; de validatie-trigger blokkeert een agenda,
  klant of project van een andere organisatie.

## Nog te doen bij uitrol
- Migratie `20260617000002_calendar_event_links.sql` op de database uitvoeren. Zonder deze
  migratie blijft de koppeling leeg en geeft het opslaan een nette foutmelding; de rest van
  de agenda blijft werken.

## Verificatie
- `tsc --noEmit` en `npm run build` slagen; de app boot foutloos zonder console-/serverfouten.
  De ingelogde agenda is niet live gerenderd (login vereist een magic-link).
