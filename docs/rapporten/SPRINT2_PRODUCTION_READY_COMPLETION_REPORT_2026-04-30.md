# Sprint 2 production-ready afronding — implementatierapport

Datum: 2026-04-30  
Versie: `2.2.3-sprint2-production-ready`

## Scope

Alleen de resterende Sprint 2-hardeningpunten zijn aangepast. Sprint 1- en bestaande Sprint 2-functionaliteit is ongemoeid gelaten, behalve waar dit nodig was voor billing/Mollie security, idempotency en migratiezekerheid.

## Gerealiseerd

### 1. Plan-change checkout Edge Function

Bestand: `supabase/functions/billing/index.ts`

- `createPlanChangeCheckout` gebruikt geen `organization_billing_overview` RPC meer.
- De Edge Function controleert eerst de request-JWT via `supabaseAdmin.auth.getUser(token)`.
- Daarna wordt expliciet gecontroleerd of de gebruiker `owner` of `admin` is binnen `organization_members`.
- Server-side billingberekening gebeurt nu rechtstreeks via service-role queries:
  - huidig billing profile via `ensure_organization_billing_profile`;
  - huidig plan via `billing_plans`;
  - target plan via `billing_plans`;
  - actieve members via `organization_members`;
  - pending licentie-consumerende uitnodigingen via `organization_invitations`.
- Custom-plannen, inactieve plannen, downgrades/gelijk geprijsde wijzigingen en te weinig-seat situaties worden server-side geblokkeerd.

### 2. TypeScript BillingPlan mismatch

- Lokaal Edge Function-type `BillingPlan` bevat nu `is_active: boolean`.
- `BillingProfile` is aangevuld met velden die de server-side billing overview teruggeeft.
- `MollieConnection` bevat nu `refresh_token_version`.

### 3. Prijsveilige reusable checkout idempotency

- `findReusablePayment` hergebruikt open checkouts alleen nog bij exacte match op:
  - `organization_id`
  - `payment_type`
  - `plan_key`
  - `license_delta`
  - `amount_cents`
  - `currency`
  - open/pending status
- Hergebruik via idempotency-key valideert nu ook bedrag en valuta via `assertPaymentRecordCompatible`.
- Half aangemaakte payment records worden alleen hersteld als bedrag en valuta exact overeenkomen.
- Mock checkout gebruikt nu dezelfde recoverable payment-record flow als productie-checkouts.

### 4. Migratiepad ondubbelzinnig gemaakt

Bestanden:

- `supabase/migrations/README.md`
- `supabase/migrations/20260430_sprint2_completion_production_ready.sql`
- `supabase/schema.sql`
- `supabase/BRANDCORE_DATABASE_SETUP.sql`
- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`

Actuele upgradevolgorde:

1. `20260430_sprint2_billing_mollie_licensing.sql`
2. `20260430_sprint2_mollie_connect_production_hardening.sql`
3. `20260430_sprint2_mollie_connect_final_hardening.sql`
4. `20260430_sprint2_completion_production_ready.sql`

Nieuwe migratie is idempotent opgezet met `add column if not exists`, `create index if not exists` en veilige vervanging van de verouderde reusable checkout-index.

### 5. MOLLIE_WEBHOOK_SECRET verplicht in productie

- `assertProductionBillingConfig()` vereist nu `MOLLIE_WEBHOOK_SECRET` zodra `MOLLIE_ALLOW_MOCK=false`.
- Mollie webhooks zonder of met verkeerde secret worden geweigerd wanneer een secret is geconfigureerd.
- Productie zonder webhook secret faalt veilig.

### 6. Refresh-token rotation concurrency

- `organization_mollie_connections.refresh_token_version` toegevoegd.
- Refresh-token update gebruikt compare-and-swap op `refresh_token_version`.
- `last_error` wordt pas geschreven als refresh én fallback falen.
- Succesvolle fallback wist `last_error`.
- Tokens worden niet gelogd en blijven encrypted opgeslagen.

### 7. Webhook-idempotency en audit logging

- Bestaande idempotente SQL-flow is behouden en ondersteund door de final hardening:
  - duplicate webhooks verhogen alleen `receive_count` en `last_seen_at`;
  - duplicate processed/ignored events veroorzaken geen nieuwe seat-mutaties;
  - generieke audit-trigger op `organization_billing_events` blijft uitgeschakeld;
  - paymentstatus wordt via tenant-specifieke Mollie API opgehaald, niet vertrouwd uit de webhook body.

### 8. Billing UI-randgevallen

Bestand: `src/features/SimplePages.tsx`

- Niet-admins zien geen billing beheeracties meer.
- Pending/open checkoutstatus wordt duidelijker getoond.
- Custom-plan wordt zichtbaar als handmatige optie met “Neem contact op”.
- Self-service select blijft beperkt tot actieve, niet-custom plannen.
- Server-side regels blijven leidend.
