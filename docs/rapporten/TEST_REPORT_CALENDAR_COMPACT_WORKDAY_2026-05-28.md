# Test report — Calendar compact workday view — 2026-05-28

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
Vite geeft de bestaande waarschuwing dat de hoofd-JavaScript chunk groter is dan 500 kB na minification. Dit blokkeert de build niet en is geen regressie vanuit deze kalenderwijziging.

## Dependency-opmerking
Voor lokale validatie is `npm ci` uitgevoerd, omdat de aangeleverde zip geen `node_modules` bevatte. `node_modules` is niet opgenomen in de oplever-zip.
