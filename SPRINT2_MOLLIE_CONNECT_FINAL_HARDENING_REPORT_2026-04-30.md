# BrandCore Sprint 2 — Mollie Connect Final Hardening

Datum: 2026-04-30  
Versie: `2.2.2-sprint2-mollie-connect-final-hardening`

## Doel

Deze release pakt de resterende productiepunten uit het vorige test-/hardeningrapport aan. De focus ligt op de delen die nog niet hard bewezen of nog niet volledig retry-safe waren: checkout-herstel na half afgemaakte Mollie-calls, token-refresh concurrency, audit-noise door duplicate webhooks en UI-randgevallen rond Custom-plannen.

## Gebouwd en aangescherpt

### 1. Recoverable checkout-creatie

De live checkout-flow is verder gehard. Als de Edge Function al een lokaal `organization_payment_records` record heeft aangemaakt, maar de Mollie-call of de update met provider-id/checkout-url faalt, kan een volgende poging dat incomplete open record nu herstellen in plaats van vast te lopen op de unieke idempotency constraint.

Aangepast in `supabase/functions/billing/index.ts`:

- nieuwe `LocalPaymentRecord` typing;
- `getOrCreateRecoverablePaymentRecord`;
- `findPaymentByIdempotencyKey`;
- `findIncompleteRecoverablePayment`;
- `insertRecoverablePaymentRecord`;
- `assertPaymentRecordCompatible`;
- centrale `checkoutResultFromPayment` helper.

Hierdoor zijn deze situaties beter afgedekt:

- lokale insert lukt, Mollie-call faalt;
- Mollie-call lukt, maar lokale update met provider-id faalt;
- gebruiker klikt opnieuw terwijl er al een incomplete open checkout bestaat;
- Postgres unique-conflict op idempotency key wordt gecontroleerd opgevangen.

### 2. Extra database-indexen voor checkout recovery

Nieuwe migratie:

- `supabase/migrations/20260430_sprint2_mollie_connect_final_hardening.sql`

Toegevoegd:

- index voor hergebruik van bestaande open checkouts met provider-id/checkout-url;
- index voor herstel van incomplete open checkouts zonder provider-id/checkout-url.

Dezelfde final-hardening is ook verwerkt in:

- `supabase/schema.sql`
- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
- `supabase/BRANDCORE_DATABASE_SETUP.sql`

### 3. Geen audit-spam meer op duplicate webhook ledger-events

`organization_billing_events` is een interne idempotency-ledger. Duplicate Mollie-webhooks verhogen `receive_count` en `last_seen_at`, maar dat hoort niet telkens als algemene audit-logregel zichtbaar te worden.

Daarom wordt de generieke audit-trigger op `organization_billing_events` nu expliciet verwijderd. De business-audit blijft intact via expliciete `log_billing_audit` calls voor onder andere:

- `payment_succeeded`
- `payment_failed`
- `payment_expired`
- `seat_purchased`
- `plan_changed`

### 4. Token-refresh concurrency guard

De refresh-token flow schrijft bij een refresh-fout nu `last_error` terug op de Mollie connection en probeert daarna een veilige fallback: als een parallelle request het token net wél succesvol heeft geroteerd, gebruikt de functie dat recent ververste access token. Dit voorkomt onnodige fouten bij gelijktijdige checkout/webhook requests vlak na token-expiry.

### 5. Plan-checkout UI-randgevallen

Custom-plannen blijven niet self-service. De UI verwerkt nu ook het randgeval waarin de actieve organisatie al op een Custom-plan staat:

- Custom-plan wordt zichtbaar als “handmatig beheerd”;
- checkout-knop blijft geblokkeerd zolang het geselecteerde plan niet self-service is;
- `changePlan()` geeft een duidelijke melding als een niet-selfservice plan wordt gekozen.

### 6. Inactieve plannen geblokkeerd

De Edge Function weigert nu ook expliciet een plan-change checkout naar een inactief plan. Custom-plannen waren al geblokkeerd; inactieve plannen nu ook.

## Gewijzigde bestanden

- `supabase/functions/billing/index.ts`
- `supabase/migrations/20260430_sprint2_mollie_connect_final_hardening.sql`
- `supabase/migrations/README.md`
- `supabase/schema.sql`
- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
- `supabase/BRANDCORE_DATABASE_SETUP.sql`
- `src/features/SimplePages.tsx`
- `package.json`
- `package-lock.json`

## Acceptatiepunten

| Scenario | Verwachting |
| --- | --- |
| Checkout faalt na lokale payment insert | Volgende poging herstelt hetzelfde incomplete record waar mogelijk. |
| Mollie geeft payment terug, lokale update faalt | Retry gebruikt dezelfde lokale payment en Mollie idempotency key. |
| Duplicate open checkout bestaat al | Checkout-url wordt hergebruikt. |
| Duplicate webhook komt meerdere keren binnen | `receive_count` stijgt, maar er ontstaat geen generieke audit-log spam. |
| Twee requests refreshen token tegelijk | Een request kan het recent geroteerde token van de andere request veilig hergebruiken. |
| Custom-plan actief in UI | Plan is zichtbaar als handmatig beheerd, maar niet self-service uitvoerbaar. |
| Inactief plan via API | Wordt geblokkeerd vóór checkout-creatie. |

## Testnotitie

De code is statisch gecontroleerd op de gewijzigde paden en de SQL is als fresh-install én incrementele migratie verwerkt. Een harde `npm ci`, `npm run typecheck` en `npm run build` blijven afhankelijk van geïnstalleerde npm dependencies in de doelomgeving; deze container had geen betrouwbare dependency-installatie beschikbaar. Voer die drie checks daarom nog in je eigen stagingomgeving uit na het uitpakken.
