# Sprint 2.5 hardening report — Billing, licenties & Mollie

Datum: 2026-04-30  
Scope: compacte hardening vóór Sprint 3 Klantportaal Light. Geen klantportaalfunctionaliteit toegevoegd.

## Conclusie

Status: **bijna / klaar voor Sprint 3 na Supabase-migratie en Edge Function deploy-check**.

De Sprint 2-laag is functioneel volwassen genoeg om Sprint 3 op te bouwen, mits de nieuwe Sprint 2.5-migratie wordt uitgevoerd en de billing Edge Function opnieuw wordt gedeployed met productie-secrets.

## Belangrijkste uitgevoerde hardening

1. **Veiligere publieke foutmeldingen in de billing Edge Function**
   - Onverwachte server/provider-errors worden niet meer raw teruggegeven aan de frontend.
   - Mollie token/payment/organization errors worden server-side gelogd, maar frontend krijgt een veilige generieke melding.
   - Mollie OAuth callback redirect lekt geen interne foutdetails meer via `billing_error`.

2. **Open redirect / return URL hardening**
   - Return URLs accepteren alleen `http:`/`https:`.
   - URLs met username/password worden geweigerd.
   - Origins blijven verplicht via `BILLING_ALLOWED_RETURN_ORIGINS`, behalve lokale mock-mode.

3. **Webhook-afhandeling onbekende Mollie payment IDs**
   - Onbekende provider payment IDs worden veilig genegeerd met HTTP 200 `{ ok: true, ignored: true }`.
   - Dit voorkomt retry-stormen en onnodige provider-herpogingen.

4. **Checkout race-condition hardening**
   - Nieuwe migratie `20260430_sprint25_billing_hardening.sql` toegevoegd.
   - Dubbele incomplete local checkout records zonder provider payment ID worden eerst veilig gecanceld.
   - Daarna voorkomt een unieke partial index dat parallelle retries meerdere incomplete checkout-records voor dezelfde payment-shape maken.
   - Edge Function vangt `23505` nu op en hergebruikt het bestaande incomplete checkout-record.

## Status per onderdeel

| Onderdeel | Status | Bevinding | Actie uitgevoerd |
|---|---:|---|---:|
| Plan-change checkout Edge Function | OK | JWT-user en adminrol worden server-side gecontroleerd; custom/inactieve plannen geblokkeerd; paid upgrade via Mollie checkout. | Ja, foutmeldingen/return URL aangescherpt |
| Extra-seat checkout idempotency | Verhard | Bestaande open checkouts werden al hergebruikt; parallelle incomplete insert-race is nu extra afgedekt. | Ja |
| Mollie Connect tokenveiligheid | OK | Access/refresh tokens blijven server-side encrypted; refresh-token CAS-rotation aanwezig; geen tokens in frontend. | Ja, provider errors veiliger gemaakt |
| Tenant-specifieke Mollie API-calls | OK | Payments en webhook status-fetch gebruiken organisatie-specifieke Connect-token; geen globale tenant-payment fallback gevonden. | Nee, alleen gecontroleerd |
| Mollie webhook idempotency | OK/verhard | RPC heeft receive_count/last_seen_at en verwerkt duplicate status-events idempotent; onbekende IDs nu veilig 200 ignored. | Ja |
| Billing/licentie RLS | OK | Kritieke billingtabellen hebben RLS; Mollie token-table is niet beschikbaar voor anon/authenticated en alleen service_role krijgt rechten. | Nee, gecontroleerd |
| Seat-limit/licentieconsistentie | OK | Seats worden pas na paid verwerkt; failed/expired/canceled wijzigen geen seats; DB-triggers blokkeren overcapaciteit. | Nee, gecontroleerd |
| Open redirect/CORS/return URL | Verhard | Allowed origins verplicht; return URL protocol/userinfo extra gecontroleerd. | Ja |
| Factuurbetaling-voorbereiding Sprint 3 | Bijna OK | Payment record model, provider IDs, webhook sync en auditbasis zijn geschikt; Sprint 3 moet eigen payment_type/statusmapping toevoegen zonder bestaande flows te mengen. | Documentatie |

## Niet binnen Sprint 2.5 gebouwd

- Geen klantportaalpagina's.
- Geen offerte-acceptatieflow.
- Geen factuur-betaallink UI.
- Geen nieuwe Mollie payment_type voor facturen; dat hoort bij Sprint 3.
- Geen echte end-to-end Mollie-sandboxbetaling uitgevoerd in deze lokale omgeving.

## Aangepaste bestanden

- `supabase/functions/billing/index.ts`
- `supabase/migrations/20260430_sprint25_billing_hardening.sql`
- `supabase/schema.sql`
- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
- `supabase/BRANDCORE_DATABASE_SETUP.sql`
- `SPRINT2_5_HARDENING_REPORT_2026-04-30.md`
- `SPRINT2_5_TEST_REPORT_2026-04-30.md`
- `CHANGELOG_SPRINT2_5_HARDENING_2026-04-30.md`

## Eindadvies

Sprint 3 Klantportaal Light kan veilig worden gestart **nadat**:

1. De nieuwe migratie `20260430_sprint25_billing_hardening.sql` is uitgevoerd.
2. De `billing` Edge Function opnieuw is gedeployed.
3. Productie-secrets zijn gezet:
   - `MOLLIE_CONNECT_CLIENT_ID`
   - `MOLLIE_CONNECT_CLIENT_SECRET`
   - `MOLLIE_CONNECT_REDIRECT_URL`
   - `MOLLIE_WEBHOOK_URL`
   - `MOLLIE_WEBHOOK_SECRET`
   - `MOLLIE_OAUTH_STATE_SECRET`
   - `MOLLIE_TOKEN_ENCRYPTION_KEY`
   - `BILLING_ALLOWED_RETURN_ORIGINS`
4. Een Mollie sandbox/live smoke test is uitgevoerd voor connect, checkout, webhook en idempotente retry.
