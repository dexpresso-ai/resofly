# Test Report — Resend Outbox Retry Hardening — 2026-05-27

## Uitgevoerde checks

### Frontend build
```bash
npm run build
```
Resultaat: geslaagd.

Bekende waarschuwing: Vite meldt dat enkele chunks groter zijn dan 500 kB. Dit bestond al en is geen blocker voor deze wijziging.

### Edge Function syntax/bundling smoke-test
```bash
./node_modules/.bin/esbuild supabase/functions/invoice-workflow/index.ts --bundle --platform=neutral --format=esm --external:https://* --external:../_shared/* --outfile=/tmp/invoice-workflow.js
./node_modules/.bin/esbuild supabase/functions/invoice-public/index.ts --bundle --platform=neutral --format=esm --external:https://* --external:../_shared/* --outfile=/tmp/invoice-public.js
```
Resultaat: beide geslaagd.

## Handmatige stagingtest aanbevolen
1. Zet tijdelijk een foutieve `RESEND_API_KEY` of gebruik een Resend testfout.
2. Verstuur een factuurmail.
3. Controleer:
   - `invoice_email_deliveries.status = failed`
   - `invoice_email_deliveries.error_message` gevuld
   - `invoices.last_email_delivery_status = failed`
   - `finance_provider_jobs.status = retry` of `failed`
   - `finance_provider_jobs.last_error` gevuld
   - `finance_provider_jobs.next_retry_at` gevuld bij retry
   - workflow-event `email_failed` aanwezig
   - audit-log `invoice_email_send_failed` aanwezig
4. Zet de correcte Resend key terug en test opnieuw verzenden.
