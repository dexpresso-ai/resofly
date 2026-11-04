# Changelog — Invoice checkout failure + PDF selection fix — 2026-05-27

## Scope
Gerichte follow-up hardening op twee productiepunten in de facturatieflow:

1. Mislukte Mollie checkout mag geen actieve `creating` payment flow laten hangen.
2. Publieke PDF-download mag alleen een invoice version gebruiken waar de echte PDF-data beschikbaar is via database fallback of private R2 storage.

## Aangepast

### Supabase migration
Nieuw bestand:

- `supabase/migrations/20260527_invoice_checkout_failure_pdf_selection_fix.sql`

Deze migratie:

- Faalt verlopen/stale `creating` Mollie payment records zodat ze de one-active-checkout constraint niet blijven blokkeren.
- Introduceert `public.fail_invoice_payment_checkout(...)`.
- Zet mislukte checkout records op `failed`.
- Registreert provider job status als `retry` of `failed`.
- Logt workflow-event `payment_failed`.
- Schrijft audit-log `invoice_payment_checkout_failed`.
- Geeft execute-rechten alleen aan `service_role`.

### Edge Function: invoice-workflow
Bestand:

- `supabase/functions/invoice-workflow/index.ts`

Verbeteringen:

- Mollie create-payment call staat nu in een harde `try/catch`.
- Bij provider/config/netwerkfout wordt het payment record via RPC naar `failed` gezet.
- De provider job wordt retryable gemaakt.
- De factuur blijft niet langer geblokkeerd door een eeuwige `creating` status.
- Dubbelklikken gebruikt een server-side stabiele idempotency key: `invoice-<invoice_id>-active-payment`.
- Een al lopende `creating` checkout zonder URL geeft netjes een 409 terug in plaats van nóg een provider call te starten.

### Edge Function: invoice-public
Bestand:

- `supabase/functions/invoice-public/index.ts`

Verbeteringen:

- `getInvoicePdf` haalt nu maximaal 20 recente invoice versions op.
- Alleen versies met echte PDF-data worden bruikbaar geacht:
  - `pdf_data_base64` aanwezig, of
  - `pdf_storage_provider = 'r2'` en `pdf_storage_key` aanwezig.
- `sent_to_client` krijgt voorkeur boven latere technische snapshots zoals `payment_created`.
- Hierdoor pakt de publieke download niet meer per ongeluk een version met alleen PDF-metadata maar zonder downloadbare PDF.

## Deploy

1. SQL-migratie uitvoeren:

```sql
supabase/migrations/20260527_invoice_checkout_failure_pdf_selection_fix.sql
```

2. Edge Functions deployen:

```powershell
npx supabase functions deploy invoice-workflow --no-verify-jwt
npx supabase functions deploy invoice-public --no-verify-jwt
```

3. Frontend opnieuw deployen is niet strikt nodig voor deze fix, maar mag wel mee in dezelfde release.
