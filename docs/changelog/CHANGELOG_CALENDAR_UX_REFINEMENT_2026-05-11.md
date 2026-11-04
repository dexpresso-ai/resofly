# Changelog — Calendar UX refinement — 2026-05-11

## Aangepast
- `src/features/CalendarPage.tsx`
  - Gekoppelde accounts verplaatst naar een inklapbaar paneel onder de kalenderweergave.
  - Extra toggle toegevoegd om koppelingen snel te tonen/verbergen.
  - Agenda-events krijgen nu de kleur van de gekoppelde hoofdagenda via `source_id` → `CalendarSource.color`.
  - Agenda-events zijn minder transparant gemaakt door dynamische CSS-variabelen voor achtergrond, border en accentkleur.
  - Externe agenda-items in zowel tijdlijnweergave als lijstweergave gebruiken dezelfde kleurcodering.

- `src/components/Sidebar.tsx`
  - Onder `Kalender` verschijnt nu een submenu met:
    - `Agendaweergave`
    - `Gekoppelde accounts`
  - Het submenu stuurt naar het juiste onderdeel binnen de kalenderpagina en klapt gekoppelde accounts automatisch open.

- `src/styles/globals.css`
  - Styling toegevoegd voor het submenu onder `Kalender`.
  - Styling toegevoegd voor het inklapbare gekoppelde-accounts-paneel.
  - Kalenderweergave hoger gemaakt met een grotere en vaste scrollbare tijdlijnzone.
  - Eventblokken visueel steviger gemaakt: minder transparant, duidelijkere borders en kleur op basis van hoofdagenda.

## Niet aangepast
- Geen wijzigingen aan database-schema's.
- Geen wijzigingen aan Supabase Edge Functions.
- Geen wijzigingen aan OAuth-, token- of kalender-synclogica.
- Geen functionele wijzigingen buiten de kalender-UX.

## Testresultaat
- `npm run typecheck` geslaagd.
- `npm run build` geslaagd.
- Vite geeft alleen een bestaande chunk-size warning voor de grote JS-bundel; dit is geen build error.
