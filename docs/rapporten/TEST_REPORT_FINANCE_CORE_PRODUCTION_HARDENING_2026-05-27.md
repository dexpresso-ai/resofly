# Test Report — Finance Core Production Hardening

Datum: 2026-05-27

## Uitgevoerde checks

### Frontend production build

```bash
npm run build
```

Resultaat: geslaagd.

Bekende waarschuwing: Vite meldt dat de hoofdchunk groter is dan 500 KB. Dit bestond al en blokkeert de build niet.

### Edge Function syntax/bundling smoke-test

```bash
npx esbuild supabase/functions/invoice-public/index.ts --bundle --platform=neutral --format=esm --external:https://* --outfile=/tmp/invoice-public-bundle.js
npx esbuild supabase/functions/invoice-workflow/index.ts --bundle --platform=neutral --format=esm --external:https://* --outfile=/tmp/invoice-workflow-bundle.js
npx esbuild supabase/functions/resend-webhook/index.ts --bundle --platform=neutral --format=esm --external:https://* --outfile=/tmp/resend-webhook-bundle.js
```

Resultaat: alle drie bundelen syntactisch goed.

## Nog handmatig te testen op staging

1. Geaccepteerde offerte omzetten naar factuur.
2. Controleren dat factuur is gebaseerd op geaccepteerde quote version.
3. Factuurmail verzenden via Resend.
4. Publieke factuurlink openen.
5. Nieuwe Mollie/mock betaallink maken.
6. Controleren dat de redirect naar `/invoice/<token>` gaat.
7. Mock payment openen en automatisch op betaald zetten.
8. Proberen om een verzonden/betaalde factuur inhoudelijk te wijzigen; dit moet geblokkeerd worden.
9. Dubbelklikken op betaallink aanmaken; er mag maar één actieve payment flow blijven.
10. Resend webhook en Mollie webhook herhaald aanbieden; dubbele events mogen geen dubbele paid/audit-snapshots veroorzaken.

