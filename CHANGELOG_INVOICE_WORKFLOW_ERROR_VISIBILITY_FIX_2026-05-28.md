# Invoice workflow error visibility + mock payment fix

## Changes

- Improved `invoice-workflow` error handling so Supabase/PostgREST objects are no longer logged as `Onbekende fout`.
- RPC/helper failures now return and log the concrete database function or lookup that failed.
- Added `INVOICE_DEBUG_ERRORS=true` optional secret for staging to surface internal error details in the UI response.
- Changed invoice mock payment behavior: when `MOLLIE_ALLOW_MOCK=true`, invoice payments always use mock mode, even if a generic `MOLLIE_API_KEY` exists for SaaS billing.

## Deploy

```powershell
npx supabase functions deploy invoice-workflow --no-verify-jwt
```

Optional staging debug secret:

```powershell
npx supabase secrets set INVOICE_DEBUG_ERRORS="true"
```
