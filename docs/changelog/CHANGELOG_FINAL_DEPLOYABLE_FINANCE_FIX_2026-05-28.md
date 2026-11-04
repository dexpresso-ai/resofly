# Final deployable finance fix - 2026-05-28

Deze codebase bevat de laatste facturatie/finance hardening inclusief:

- Gefixte `20260527_finance_core_production_hardening.sql` migratie met correcte invoice totals CTE.
- `invoice-workflow` met betere Supabase/RPC error logging via `describeError`/`serializeError`.
- `MOLLIE_ALLOW_MOCK=true` forceert staging mock payments, ook als er een algemene `MOLLIE_API_KEY` bestaat.
- Resend outbox/retry hardening via `fail_invoice_email_send`.
- Mollie checkout failure handling via `fail_invoice_payment_checkout`.
- Public invoice PDF download kiest alleen echte snapshots met `pdf_data_base64` of private R2 storage key.

## Belangrijk

Voer de migraties in volgorde uit en deploy daarna minimaal:

```powershell
npx supabase functions deploy invoice-workflow --project-ref enzghpduqwaojcxgwarr --no-verify-jwt
npx supabase functions deploy invoice-public --project-ref enzghpduqwaojcxgwarr --no-verify-jwt
npx supabase functions deploy resend-webhook --project-ref enzghpduqwaojcxgwarr --no-verify-jwt
```
