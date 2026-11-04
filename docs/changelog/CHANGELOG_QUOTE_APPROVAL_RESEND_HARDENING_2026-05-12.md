# Changelog — Quote approval + Resend hardening

Datum: 2026-05-12

## Aangepast

- Offerte-inhoud wordt nu vergrendeld zodra een offerte de workflow verlaat (`draft` → interne goedkeuring/verzonden/geaccepteerd/geweigerd).
- De offerte-editor toont verzonden/goedgekeurde offertes als alleen-lezen, zodat bedragen, regels, klant, project, geldigheid en toelichting niet ongemerkt wijzigen na goedkeuring.
- Browserclients kunnen workflow-timeline en e-maildeliveries alleen nog lezen; inserts/updates lopen via RPC's of service-role Edge Functions.
- Resend-verzending is opgesplitst in een transactionele lifecycle:
  - `begin_quote_email_send`
  - `complete_quote_email_send`
  - `fail_quote_email_send`
- `quote-workflow` gebruikt nu de nieuwe RPC's voor queued/sent/failed-state, in plaats van losse quote/update + delivery inserts.
- `resend-webhook` vereist standaard een Svix signing secret. Alleen lokaal kan unsigned webhook-testen met `RESEND_WEBHOOK_ALLOW_UNSIGNED=true`.
- Resend webhook-events worden niet meer teruggezet naar een lagere status wanneer events out-of-order binnenkomen.
- Oude Resend-events van eerdere mailpogingen overschrijven de actuele quote-summary niet meer.
- Fresh install schema's zijn bijgewerkt:
  - `supabase/BRANDCORE_DATABASE_SETUP.sql`
  - `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
  - `supabase/schema.sql`
- Migratie-overzicht bijgewerkt in `supabase/migrations/README.md`.

## Nieuwe migratie

```text
supabase/migrations/20260515_quote_approval_resend_flow_hardening.sql
```

Deze migratie moet na onderstaande migratie worden uitgevoerd:

```text
supabase/migrations/20260515_quote_approval_resend_flow.sql
```
