# Test report – Calendar day/week/month refinement – 2026-05-11

## Uitgevoerde checks
- `npm ci --ignore-scripts` uitgevoerd om dependencies lokaal te installeren zonder Supabase CLI postinstall-download.
- `npm run typecheck` succesvol uitgevoerd.
- `npm run build` succesvol uitgevoerd.

## Resultaat
- TypeScript compileert zonder fouten.
- Productiebuild via Vite is succesvol aangemaakt.
- Vite geeft alleen de bestaande waarschuwing dat de hoofd-JS chunk groter is dan 500 kB. Dit blokkeert de build niet.

## Handmatige smoke-test checklist voor staging
1. Open Kalender.
2. Controleer dat de tabs Dag, Week, Maand en Lijst zichtbaar zijn.
3. Controleer Weekweergave: tijden lopen van 00:00 tot en met 23:30/24:00, events tonen tijd + titel.
4. Controleer Dagweergave: één brede kolom, events zijn beter leesbaar.
5. Controleer Maandweergave: dagen tonen events/taken en `+ meer` opent de dagweergave.
6. Klik op Vorige/Volgende in dag-, week- en maandweergave.
7. Klik op een leeg tijdslot in dag/week en maak een testevent aan.
8. Controleer dat koppelingen beheren nog inklapt/uitklapt.
