# Test Report — Finance Advanced Search (2026-05-28)

## Uitgevoerde checks

### TypeScript
Command:
```bash
npm run typecheck
```
Resultaat: geslaagd.

### Production build
Command:
```bash
npm run build
```
Resultaat: geslaagd.

## Build-opmerking
Vite geeft een bestaande waarschuwing dat de hoofdchunk groter is dan 500 kB. Dit blokkeert de build niet. Voor een latere optimalisatiesprint kan code-splitting/manual chunks worden toegevoegd.

## Functionele dekking
- Offertes kunnen worden gezocht op nummer, klant, project, regels, bedragen, datums, status en e-mailinformatie.
- Facturen kunnen worden gezocht op nummer, klant, project, gekoppelde offerte, regels, bedragen, datums, status, e-mailinformatie en Mollie-betaalinformatie.
- Filters werken onafhankelijk en gecombineerd.
- Resetknop wist alle filters.
- Geen-resultaten-state verschijnt alleen wanneer er wel documenten zijn, maar filters niets opleveren.
- Bestaande detailmodals, PDF-exportknoppen en tabelrij-acties blijven gekoppeld aan de juiste originele offerte/factuur.
