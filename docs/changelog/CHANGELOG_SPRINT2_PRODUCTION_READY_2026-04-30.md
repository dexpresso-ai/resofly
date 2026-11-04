# Changelog — Sprint 2 production-ready afronding

Versie: `2.2.3-sprint2-production-ready`

## Gewijzigde bestanden

- `package.json`
- `package-lock.json`
- `supabase/functions/billing/index.ts`
- `supabase/migrations/README.md`
- `supabase/migrations/20260430_sprint2_mollie_connect_production_hardening.sql`
- `supabase/migrations/20260430_sprint2_mollie_connect_final_hardening.sql`
- `supabase/migrations/20260430_sprint2_completion_production_ready.sql` nieuw
- `supabase/schema.sql`
- `supabase/BRANDCORE_DATABASE_SETUP.sql`
- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
- `src/features/SimplePages.tsx`
- `SPRINT2_PRODUCTION_READY_COMPLETION_REPORT_2026-04-30.md` nieuw
- `SPRINT2_PRODUCTION_READY_TEST_REPORT_2026-04-30.md` nieuw
- `CHANGELOG_SPRINT2_PRODUCTION_READY_2026-04-30.md` nieuw

## Belangrijkste wijzigingen

- Plan-change checkout server-side herbouwd zonder user-bound billing overview RPC.
- BillingPlan type uitgebreid met `is_active`.
- Reusable open checkout lookup prijsveilig gemaakt met `amount_cents` en `currency`.
- Nieuwe idempotente afrondingsmigratie toegevoegd.
- `MOLLIE_WEBHOOK_SECRET` verplicht gemaakt voor productie.
- Mollie refresh-token rotation concurrency verhard met `refresh_token_version` CAS.
- `last_error` wordt pas gezet bij echte refresh failure.
- Billing UI toont geen beheeracties meer voor niet-admins en toont Custom als handmatige optie.

## Deploy-notitie

Voor bestaande Sprint 2-installaties minimaal uitvoeren:

```text
supabase/migrations/20260430_sprint2_completion_production_ready.sql
```

Voor bestaande Sprint 1-installaties de volledige volgorde uit `supabase/migrations/README.md` volgen.
