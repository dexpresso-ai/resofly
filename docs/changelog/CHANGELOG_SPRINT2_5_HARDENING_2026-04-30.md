# Changelog — Sprint 2.5 hardening

Datum: 2026-04-30

## Fixed

- Billing Edge Function geeft onverwachte server/provider-errors niet meer raw terug aan de frontend.
- Mollie OAuth callback lekt interne foutdetails niet meer via de return URL.
- Mollie token/payment/organization provider errors worden veilig vertaald naar generieke frontendmeldingen.
- Return URL validatie blokkeert niet-HTTP(S) protocollen en URLs met userinfo.
- Onbekende Mollie webhooks worden veilig genegeerd met HTTP 200 om retry-stormen te voorkomen.
- Parallelle incomplete checkout-records worden database-level voorkomen via nieuwe unieke partial index.
- Edge Function herstelt netjes van `23505` race-conflicten door bestaande incomplete checkout terug te lezen.

## Added

- `supabase/migrations/20260430_sprint25_billing_hardening.sql`
- Sprint 2.5 hardening report.
- Sprint 2.5 test report.

## Unchanged

- Geen Sprint 3 klantportaalfunctionaliteit toegevoegd.
- Geen wijzigingen aan bestaande CRM/project/factuur-template flows.
- Geen wijzigingen aan pricing/plannen buiten hardening.
