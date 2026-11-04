# ResoFly — Finance Core Production Hardening

Datum: 2026-05-27

Deze iteratie hardent de offerte- en factuurstroom op de 10 kritieke punten uit de senior review.

## Implementatie

1. **Publieke factuurlinks als aparte tabel**
   - Nieuwe tabel `invoice_public_links` met `purpose`, `expires_at`, `revoked_at`, `delivery_id`, `payment_record_id` en view tracking.
   - Nieuwe RPC's `create_invoice_public_link` en `resolve_invoice_public_link`.
   - `invoice-public` resolved nu via de linktabel en gebruikt `invoices.public_token_hash` alleen nog als fallback.

2. **Mollie redirect hardening**
   - `invoice-workflow` accepteert niet langer blind `redirectUrl` vanuit frontend.
   - Redirect moet exact naar `/invoice/<token>` verwijzen; anders wordt server-side `publicUrl` gebruikt.
   - Frontend stuurt geen `window.location.origin` meer mee.

3. **Factuurimmutability**
   - Nieuwe invoice lockvelden: `locked_at`, `locked_reason`.
   - Trigger `enforce_invoice_immutability` blokkeert inhoudelijke wijzigingen na verzending, betaalrecord of gesloten status.

4. **Quote -> invoice vanaf geaccepteerde snapshot**
   - `convert_accepted_quote_to_invoice` gebruikt nu `accepted_sent_version_id`, `accepted_version_id`, `sent_version_id` of de laatste geaccepteerde/verzonden `quote_versions` snapshot.
   - Nieuwe kolom `source_quote_version_id` op `invoices`.

5. **Eén actieve betaalflow per factuur**
   - Payment records krijgen status `creating` tijdens provider setup.
   - Partial unique index `idx_invoice_payment_one_active_mollie` dwingt maximaal één actieve Mollie checkout per factuur af.

6. **Unieke provider payment IDs**
   - Nieuwe unique index op `(provider, provider_payment_id)`.
   - Bestaande duplicaten worden veilig gequarantined.

7. **Echte PDF snapshotdata**
   - `invoice_versions` krijgt `pdf_data_base64`, `pdf_storage_provider`, `pdf_storage_key`.
   - De exacte verzonden PDF wordt als base64 snapshot opgeslagen bij de verzonden invoice version.

8. **Publieke factuurresponse geminimaliseerd**
   - `invoice-public` retourneert geen interne invoice/client/project/quote UUID's meer.
   - Provider payment IDs en interne metadata worden niet meer gelekt naar publieke klanten.

9. **Factuurstatusmodel opgeschoond**
   - Invoice statussen genormaliseerd naar `draft | sent | overdue | paid | cancelled | void | written_off`.
   - Oude offerteachtige invoice statussen worden gemigreerd.

10. **Provider outbox/reconciliation basis**
   - Nieuwe tabel `finance_provider_jobs` voor Resend/Mollie jobtracking.
   - E-mail- en payment-setup schrijven provider job records voor herstel/retry/reconciliation.

## Aangepaste bestanden

- `supabase/migrations/20260527_finance_core_production_hardening.sql`
- `supabase/functions/invoice-workflow/index.ts`
- `supabase/functions/invoice-public/index.ts`
- `src/main.tsx`
- `src/features/Finance.tsx`
- `src/features/PublicInvoicePage.tsx`
- `src/types.ts`

