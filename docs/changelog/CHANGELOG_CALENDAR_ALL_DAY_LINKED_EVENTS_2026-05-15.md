# Changelog — Linked calendar all-day event fix — 2026-05-15

## Probleem
Gekoppelde Google/Microsoft all-day events konden één dag te lang zichtbaar zijn in de agenda. Dit kwam doordat provider all-day ranges een exclusieve einddatum gebruiken, terwijl de frontend de opgeslagen UTC-midnights via `Date`-objecten vergeleek met lokale daggrenzen. In NL-tijd kon bijvoorbeeld `2026-05-15T00:00:00.000Z` nog binnen de lokale dag van 15 mei vallen, waardoor een feestdag van 14 mei ook op 15 mei zichtbaar werd.

## Aangepast
- `src/features/CalendarPage.tsx`
  - All-day events worden nu date-only vergeleken op `YYYY-MM-DD`.
  - De exclusieve einddatum van Google/Microsoft wordt correct behandeld.
  - All-day labels gebruiken date-only formatting zonder timezone shift.
  - Zelf aangemaakte all-day events sturen nu lokale datumvelden veilig door naar de Edge Function, zonder UTC-datumverschuiving.

- `supabase/functions/calendar-integrations/index.ts`
  - Google all-day events worden genormaliseerd als date-only start + exclusieve einddatum.
  - Microsoft all-day events worden eveneens date-only genormaliseerd.
  - Aangemaakte Google/Microsoft all-day events worden bij response normalisatie via dezelfde helper verwerkt.
  - Kleine dedupe-laag toegevoegd op provider/source/event/start om dubbele provider-items in dezelfde response te voorkomen.

## Verwacht resultaat
Een gekoppelde feestdag zoals Hemelvaartsdag met:

```ts
start.date = "2026-05-14"
end.date = "2026-05-15"
```

wordt alleen getoond op 14 mei, niet meer ook op 15 mei.
