# Test report — Quote create modal refinement (2026-05-19)

## Uitgevoerde checks
- `npm ci --ignore-scripts`
- `npm run build`

## Resultaat
- TypeScript build succesvol.
- Vite production build succesvol.

## Build-opmerking
Vite geeft een bestaande waarschuwing dat de hoofdchunk groter is dan 500 kB. Dit blokkeert de build niet en is niet veroorzaakt door de offerte-modal wijziging.

## Functionele checks in code
- Nieuwe quote krijgt direct een zichtbaar nummer via `createNextFinanceNumber('quote', data)`.
- Nummering pakt het hoogste bestaande `OFF-YYYY-####` nummer en telt door.
- Datum en verloopdatum zijn expliciet gelabeld.
- Offerteregels tonen duidelijke invoervelden en live regeltotaal.
- Totalen bovenin gebruiken dezelfde `total()` en `euro()` helpers als de rest van de applicatie.
- Workflowstatus blijft read-only bij offertes.
