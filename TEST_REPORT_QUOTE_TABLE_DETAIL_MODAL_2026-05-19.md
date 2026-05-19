# Test report – Offertes tabel + detailmodal

Datum: 2026-05-19

## Uitgevoerde checks

- `npm ci --ignore-scripts`
- `npm run build`

## Resultaat

- TypeScript build geslaagd.
- Vite production build geslaagd.
- Nieuwe productie-assets zijn gegenereerd in `dist/`.

## Opmerking

`npm ci` zonder `--ignore-scripts` probeerde de Supabase CLI via GitHub te downloaden. Dat faalde in de sandbox door netwerk/DNS (`EAI_AGAIN`). Daarna is bewust `npm ci --ignore-scripts` gebruikt; dit is voldoende voor de frontend TypeScript/Vite build.

## Build warning

Vite meldt dat de JavaScript bundle groter is dan 500 kB na minification. Dit bestond los van deze wijziging en blokkeert de build niet. Later kan code-splitting worden toegevoegd.
