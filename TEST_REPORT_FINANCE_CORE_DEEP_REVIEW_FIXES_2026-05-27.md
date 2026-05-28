# Test report — Finance core deep review fixes (2026-05-27)

## Uitgevoerde statische checks

Omdat `npm install` in de sandbox geen GitHub/Supabase CLI postinstall kon downloaden, is de volledige Vite build hier niet opnieuw gedraaid. Wel zijn de belangrijkste TypeScript/Edge bundling checks uitgevoerd met esbuild.

### Edge Function syntax/bundling

```bash
npx --yes esbuild supabase/functions/invoice-workflow/index.ts --bundle --platform=neutral --format=esm --outfile=/tmp/invoice-workflow.js --external:https://*
npx --yes esbuild supabase/functions/invoice-public/index.ts --bundle --platform=neutral --format=esm --outfile=/tmp/invoice-public.js --external:https://*
npx --yes esbuild cloudflare-worker/worker.ts --bundle --platform=neutral --format=esm --outfile=/tmp/worker.js --external:cloudflare:*
```

Resultaat: geslaagd.

### Frontend bundling smoke-test

```bash
npx --yes esbuild src/main.tsx --bundle --platform=browser --format=esm --outfile=/tmp/main.js --external:react --external:react-dom --external:react-dom/client --external:@supabase/supabase-js --external:lucide-react --external:pdf-lib
```

Resultaat: geslaagd.

## Functionele staging-test checklist

Na deploy op staging minimaal testen:

1. Offerte aanmaken → intern goedkeuren → verzenden.
2. Publieke offerte accepteren.
3. `Maak factuur van offerte` klikken.
4. Controleren dat `source_quote_version_id` is gevuld.
5. Factuur verzenden via Resend.
6. Controleren dat invoice status `sent`, `locked_at` gevuld en invoice version aangemaakt is.
7. PDF-snapshot downloaden vanaf publieke factuurpagina.
8. Mollie/mock betaallink aanmaken.
9. Controleren dat er maximaal één actieve `invoice_payment_records` rij bestaat.
10. Betaling afronden/mocken.
11. Controleren dat factuur `paid` wordt, `paid_at` gevuld is en duplicate webhook geen dubbel event maakt.
12. Controleren dat wijziging van regels/klant/project op een locked factuur wordt geweigerd.
13. Controleren dat public invoice response geen interne UUID/provider ids toont.
14. Controleren dat R2 object alleen via internal Worker endpoint bereikbaar is.

