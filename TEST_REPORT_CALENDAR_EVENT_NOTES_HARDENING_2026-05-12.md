# Test Report — Calendar Event Notes Hardening

Datum: 2026-05-12  
Versie: `2.2.4-calendar-event-notes-hardening`

## Uitgevoerde checks

```bash
npm install --ignore-scripts
npm run typecheck
npm run build
npm run lint:sql
npm audit --omit=dev
```

## Resultaat

| Check | Status | Opmerking |
|---|---:|---|
| TypeScript typecheck | Geslaagd | Geen TypeScript-errors |
| Productiebuild | Geslaagd | Alleen bestaande Vite chunk-size warning |
| SQL lint placeholder | Geslaagd | Project bevat placeholder script |
| Production dependency audit | Geslaagd | `npm audit --omit=dev` geeft 0 vulnerabilities |

## Functionele validatie op code-niveau

### Event-detailpaneel sluiten
Gecontroleerd dat de callbacks in `CalendarEventDetailPanel` nu eerst `onClose()` uitvoeren vóór:
- nieuwe notitie openen;
- bestaande gekoppelde notitie openen.

### Transactionele note + calendar link
Gecontroleerd dat `saveEdit(...)` voor nieuwe agenda-notities nu `createNoteWithCalendarLink(...)` gebruikt. Daardoor worden de notitie en de agenda-link via één Supabase RPC aangemaakt.

### Databaseconsistentie
Gecontroleerd dat de nieuwe RPC en note-calendar-link laag aanwezig zijn in:
- migraties;
- actuele schema-export;
- fresh install schema;
- `BRANDCORE_DATABASE_SETUP.sql`.

## Bekende nuance
`npm install --ignore-scripts` is gebruikt om te voorkomen dat de Supabase CLI postinstall in deze omgeving externe binaries probeert te downloaden. Dit raakt de frontend typecheck/build niet.

De productiebuild geeft nog de bestaande waarschuwing dat de gegenereerde JS-bundle groter is dan 500 kB. Dit is geen nieuwe fout door deze hardening.
