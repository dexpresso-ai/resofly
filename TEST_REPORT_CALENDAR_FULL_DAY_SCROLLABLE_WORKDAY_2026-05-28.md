# Test report — Calendar full-day scrollable workday refinement — 2026-05-28

## Uitgevoerde checks
- `npm run typecheck` ✅
- `npm run build` ✅

## Resultaat
- TypeScript compileert zonder fouten.
- Vite production build is succesvol.
- Bestaande Vite-waarschuwing over grote JS-chunk blijft aanwezig, maar blokkeert de build niet.

## Verwacht gedrag
- Dag/weekweergave opent compact rond 08:00.
- Gebruiker kan omhoog scrollen naar tijden vóór 08:00.
- Gebruiker kan omlaag scrollen naar tijden na 18:00.
- Meetings buiten werktijd blijven klikbaar en tonen tijd, titel en brongegevens in dezelfde kalenderstijl.
