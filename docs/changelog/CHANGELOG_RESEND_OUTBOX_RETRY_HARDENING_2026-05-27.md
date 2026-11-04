# Resend Outbox Retry Hardening — 2026-05-27

## Doel
Laat een mislukte Resend-verzendpoging niet alleen als `invoice_email_deliveries.failed` eindigen, maar koppel die fout ook netjes terug naar de provider-outbox (`finance_provider_jobs`) zodat retry/reconciliation mogelijk blijft.

## Aangepast

### Edge Function: `invoice-workflow`
- De Resend `fetch()` call is nu expliciet gewrapt in `try/catch`.
- Ook netwerk-/runtimefouten vóórdat Resend een HTTP-response geeft, roepen nu `failInvoiceEmailSend(...)` aan.
- Daardoor blijft een delivery niet meer in `queued` hangen bij bijvoorbeeld DNS-, TLS-, netwerk- of provider-timeoutproblemen.

### Migratie: `20260527_resend_outbox_retry_hardening.sql`
- `public.fail_invoice_email_send(...)` is vervangen door een outbox-aware versie.
- Bij fout wordt nu:
  - `invoice_email_deliveries.status = failed`
  - `invoice_email_deliveries.error_message` gevuld
  - `invoices.last_email_delivery_status = failed`
  - `invoices.last_email_failed_at` gevuld
  - gekoppelde `finance_provider_jobs` naar `retry` of `failed` gezet
  - `finance_provider_jobs.last_error` gevuld
  - `finance_provider_jobs.next_retry_at` gevuld wanneer retry mogelijk is
  - `response_payload.failure` aangevuld met foutcontext
  - `invoice_email_send_failed` audit-log geschreven
  - `email_failed` workflow-event geschreven
- Bestaande failed deliveries krijgen een outbox-status via backfill.
- Ontbrekende provider jobs voor bestaande failed deliveries worden defensief aangemaakt.

## Productie-impact
Deze wijziging maakt het Resend-pad gelijkwaardiger aan de geharde Mollie-failure-flow. Een providerfout is nu zichtbaar én retrybaar vanuit de outbox-laag.
