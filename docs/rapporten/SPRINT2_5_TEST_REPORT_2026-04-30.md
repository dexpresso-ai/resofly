# Sprint 2.5 test report — Billing, licenties & Mollie

Datum: 2026-04-30

## Uitgevoerde technische checks

| Test/check | Resultaat | Opmerking |
|---|---:|---|
| `npm ci --no-audit --no-fund` | Geslaagd | Dependencies schoon geïnstalleerd vanuit lockfile. |
| `npm run build` | Geslaagd | TypeScript build + Vite production build geslaagd. Vite gaf alleen een bekende chunk-size warning. |
| `npm run typecheck` | Geslaagd | Geen TypeScript-errors in frontend/service-laag. |
| `npm run lint:sql` | Geslaagd | Script is een placeholder in deze codebase; geen echte SQL-linter aanwezig. |
| Secrets in frontend grep | Geslaagd | Geen Mollie Connect secrets/tokens in `src/`; alleen Supabase sessie-token voor function invoke. |
| RLS brede policy grep | Geslaagd | Geen `USING (true)`/`WITH CHECK (true)` gevonden in billing-scope. |

## Niet lokaal uitvoerbaar

| Test/check | Reden | Handmatige vervangende stap |
|---|---|---|
| `deno check supabase/functions/billing/index.ts` | Deno is niet geïnstalleerd in deze omgeving. | Run lokaal/CI: `deno check supabase/functions/billing/index.ts`. |
| Supabase migratie-run | Geen gekoppelde Supabase database in deze sandbox. | Run: `supabase db push` of pas de nieuwe migratie toe op staging. |
| Mollie sandbox E2E | Geen Mollie sandbox credentials en webhook endpoint actief in deze sandbox. | Test in staging met Mollie Connect sandbox/live testaccount. |
| Webhook retry vanuit Mollie | Externe provider-callback vereist publiek endpoint. | Herhaal dezelfde webhook POST meerdere keren naar de Edge Function en controleer receive_count/geen dubbele seatmutatie. |

## Gerichte denktests

### Extra-seat checkout idempotency

1. Admin start extra-seat checkout.
2. Edge Function zoekt open/reusable checkout op basis van organisatie, payment_type, plan_key, license_delta, amount, currency en geldige TTL.
3. Bestaat er al provider payment ID + checkout URL, dan wordt deze hergebruikt.
4. Bij parallelle retries zonder provider ID voorkomt `idx_org_payment_records_one_incomplete_checkout` dubbele incomplete local records.
5. Bij `23505` leest de Edge Function het bestaande incomplete record terug en gaat daarmee verder.

Resultaat: **voldoende verhard voor Sprint 3**.

### Mollie webhook idempotency

1. Webhook verifieert secret.
2. Webhook zoekt eerst lokaal `organization_payment_records` op via provider payment ID.
3. Daarna haalt hij payment-status op via het juiste organisatie-token.
4. RPC registreert event_key, receive_count en last_seen_at.
5. Exact dubbele status-events worden niet opnieuw gemuteerd.
6. `paid` met `processed_at` veroorzaakt geen tweede seat-/planmutatie.

Resultaat: **voldoende voor checkout/seat/plan flows**.

### Seat-limit consistentie

1. Extra seats verhogen `licensed_seats` pas na `paid`.
2. `failed`, `expired` en `canceled` wijzigen seats niet.
3. Membership/invitation triggers blokkeren overschrijding van actieve + pending seats.
4. Billing profile capacity-trigger voorkomt dat licensed seats onder gebruik zakken.

Resultaat: **voldoende voor Sprint 3 basis**.

### Factuurbetaling-voorbereiding Sprint 3

Het bestaande patroon is geschikt voor factuurbetalingen, mits Sprint 3:

- een expliciete `invoice_payment`/vergelijkbare payment_type toevoegt;
- payment records koppelt aan invoice IDs;
- webhookstatussen idempotent op factuurstatussen mapt;
- audit-events per klantactie toevoegt;
- factuurbetalingen niet mengt met seat-/plan-mutaties.

Resultaat: **basis is geschikt, maar Sprint 3 moet eigen factuurpayment-scope toevoegen**.
