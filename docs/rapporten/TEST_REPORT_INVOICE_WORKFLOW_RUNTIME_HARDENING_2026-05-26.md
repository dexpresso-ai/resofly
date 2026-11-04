# Test report — Invoice workflow runtime hardening — 2026-05-26

## Uitgevoerde checks

### Frontend build
Command:

```bash
npm run build
```

Resultaat: geslaagd.

Opmerking: Vite geeft nog de bestaande chunk-size waarschuwing voor de grote app-bundle. Geen build blocker.

### Edge Function syntax/bundle smoke test
Commands:

```bash
npx esbuild supabase/functions/invoice-public/index.ts --bundle --platform=neutral --format=esm --outfile=/tmp/invoice-public.bundle.js --external:https://*
npx esbuild supabase/functions/invoice-workflow/index.ts --bundle --platform=neutral --format=esm --outfile=/tmp/invoice-workflow.bundle.js --external:https://*
npx esbuild supabase/functions/resend-webhook/index.ts --bundle --platform=neutral --format=esm --outfile=/tmp/resend-webhook.bundle.js --external:https://*
```

Resultaat: alle drie bundelen syntactisch correct.

### Niet lokaal uitgevoerd
- Supabase CLI deploy is niet lokaal uitgevoerd in deze sandbox, omdat de Supabase CLI postinstall binary hier niet beschikbaar is zonder GitHub download.
- De nieuwe SQL-migratie is niet tegen een live Supabase database uitgevoerd in deze sandbox.

## Aanbevolen staging-test na deploy
1. Voer `20260526_invoice_workflow_runtime_hardening.sql` uit in Supabase SQL Editor of via `supabase db push`.
2. Deploy `invoice-public` en `invoice-workflow` opnieuw.
3. Maak een nieuwe Mollie/mock-betaallink aan op een conceptfactuur.
4. Controleer dat de URL `/invoice/<token>?mock_payment=...` bevat.
5. Open de URL en controleer dat de publieke factuurpagina laadt.
6. Controleer dat mockbetalingen bij `MOLLIE_ALLOW_MOCK=true` automatisch naar paid gaan.
7. Controleer in de factuurdetailmodal dat tijdlijn, betaling, verzendhistorie en snapshots zichtbaar blijven.
