# Changelog — Quote approval + Resend flow

Datum: 2026-05-12

## Toegevoegd

- Offertes kunnen nu volwaardig aan projecten gekoppeld worden en zijn zichtbaar binnen projectdetails.
- Interne offerte-goedkeuringsflow toegevoegd:
  - concept
  - ter interne goedkeuring
  - intern goedgekeurd
  - verzonden
  - klant geaccepteerd/geweigerd
- Nieuwe beveiligde workflow-acties via Supabase RPC:
  - `submit_quote_for_internal_approval`
  - `approve_quote_internal`
  - `reject_quote_internal`
  - `accept_quote_public`
  - `reject_quote_public`
- Nieuwe Supabase Edge Function `quote-workflow` voor het versturen van offertes via Resend.
- Nieuwe Supabase Edge Function `quote-public` voor publieke offertelinks en klantbeslissingen.
- Nieuwe Supabase Edge Function `resend-webhook` voor Resend delivery/open/click/bounce/failure-events.
- Publieke offertepagina via `/quote/:token` en fallback via `?quote_token=`.
- E-mailstatus per offerte:
  - queued
  - sent
  - delivered
  - opened
  - clicked
  - bounced
  - failed
  - complained
- Offerte-timeline toegevoegd met workflow-events.
- Audit-log acties toegevoegd voor kritieke offerteacties.
- Database-trigger toegevoegd die ongeldige statusovergangen blokkeert.
- Handmatige offerte-statuswijziging uit het offerteformulier gehaald; status loopt via de workflow.

## Nieuwe database-objecten

- `quote_approval_events`
- `quote_email_deliveries`
- `quote_email_events`
- extra workflowkolommen op `quotes`
- status-transition guard trigger op `quotes`

## Nieuwe migratie

- `supabase/migrations/20260515_quote_approval_resend_flow.sql`

Dezelfde idempotente migratie is ook opgenomen in:

- `supabase/schema.sql`
- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
- `supabase/BRANDCORE_DATABASE_SETUP.sql`

## Nieuwe Edge Functions

- `supabase/functions/quote-workflow/index.ts`
- `supabase/functions/quote-public/index.ts`
- `supabase/functions/resend-webhook/index.ts`

## Benodigde secrets

```bash
supabase secrets set RESEND_API_KEY=...
supabase secrets set RESEND_FROM_EMAIL=offertes@mail.jouwdomein.nl
supabase secrets set RESEND_REPLY_TO=hello@jouwdomein.nl
supabase secrets set RESEND_WEBHOOK_SIGNING_SECRET=whsec_...
supabase secrets set QUOTE_PUBLIC_BASE_URL=https://app.jouwdomein.nl
supabase secrets set QUOTE_TOKEN_TTL_DAYS=30
supabase secrets set QUOTE_ALLOWED_ORIGINS=https://app.jouwdomein.nl
supabase secrets set QUOTE_PUBLIC_ALLOWED_ORIGINS=https://app.jouwdomein.nl
```

Voor lokaal testen kan tijdelijk:

```bash
supabase secrets set QUOTE_ALLOW_LOCAL_DEV=true
supabase secrets set QUOTE_ALLOWED_ORIGINS=http://localhost:5173
supabase secrets set QUOTE_PUBLIC_ALLOWED_ORIGINS=http://localhost:5173
```
