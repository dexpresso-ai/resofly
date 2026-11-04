# Test Report — Calendar Event Notes Squashed Migration

Datum: 2026-05-12  
Versie: `2.2.5-calendar-event-notes-squashed-migration`

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

## Code-level controle

Gecontroleerd dat:
- `20260514_calendar_event_notes_complete.sql` de inhoud van de eerdere tabel-/RLS-migratie én de RPC-migratie bevat;
- `20260512_note_calendar_links.sql` en `20260513_calendar_note_transaction_rpc.sql` niet meer in de codebase staan;
- `src/lib/repository.ts` bij ontbrekende `note_calendar_links` naar de nieuwe gecombineerde migratie verwijst;
- `supabase/schema.sql`, `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql` en `supabase/BRANDCORE_DATABASE_SETUP.sql` inhoudelijk gelijk blijven voor fresh installs;
- de frontendcode zelf functioneel ongewijzigd is gebleven behalve de migratiewaarschuwing.

## Gebruik

Voor handmatige toepassing in Supabase SQL Editor hoef je alleen de volledige inhoud van dit bestand uit te voeren:

```text
supabase/migrations/20260514_calendar_event_notes_complete.sql
```

## Bekende nuance

`npm install --ignore-scripts` is gebruikt om te voorkomen dat de Supabase CLI postinstall in deze omgeving externe binaries probeert te downloaden. Dit raakt de frontend typecheck/build niet.

De productiebuild geeft nog de bestaande waarschuwing dat de gegenereerde JS-bundle groter is dan 500 kB. Dit is geen nieuwe fout door deze migratie-opschoning.
