# BrandCore Sprint 2 — Mollie Connect Production Hardening

Datum: 2026-04-30  
Versie: `2.2.1-sprint2-mollie-connect-hardening`

## Doel

Deze release hardent Sprint 2 rondom het gekozen model: **elke organisatie koppelt een eigen Mollie-account**. De eerdere globale `MOLLIE_API_KEY`-flow is vervangen door een tenant-specifieke Mollie Connect-flow voor betalingen en webhooks.

## Gebouwd

### 1. Encrypted Mollie token storage

Nieuwe tabel:

- `organization_mollie_connections`

Belangrijke velden:

- `organization_id`
- `billing_profile_id`
- `status`
- `mollie_organization_id`
- `access_token_encrypted`
- `refresh_token_encrypted`
- `scopes`
- `expires_at`
- `last_refreshed_at`
- `last_error`
- `connected_by`

De tabel heeft RLS aan, maar geen leespolicy voor normale appgebruikers. Tokens zijn alleen bereikbaar via de Supabase service role in de Edge Function.

### 2. Refresh-token rotation

De billing Edge Function:

- bewaart access- en refresh tokens versleuteld met AES-GCM;
- gebruikt `MOLLIE_TOKEN_ENCRYPTION_KEY` als server-side encryption secret;
- ververst access tokens automatisch vlak voor expiry;
- schrijft geroteerde refresh tokens terug als Mollie een nieuwe refresh token retourneert;
- bewaart `last_refreshed_at`, `expires_at` en `last_error`.

### 3. Tenant-specific Mollie API calls

Nieuwe betaalflow:

1. Organisatie-admin start Mollie Connect.
2. OAuth callback wisselt `code` om voor access/refresh token.
3. Tokens worden encrypted opgeslagen per organisatie.
4. Extra-seat checkout gebruikt het access token van exact die organisatie.
5. Webhook zoekt het payment record op, bepaalt de organisatie en haalt de payment status op met het tenant-token van die organisatie.

Hiermee gebruikt de app niet langer één globale Mollie API key voor seat-checkouts.

### 4. Retry-idempotente checkout-creatie

De Edge Function hergebruikt bestaande open checkouts op basis van:

- organisatie;
- payment type;
- license delta;
- niet-verlopen checkout;
- bestaande provider payment id en checkout URL.

Daarnaast stuurt de frontend een idempotency key mee. De Mollie payment call krijgt ook een `Idempotency-Key` header mee.

### 5. Striktere webhook-idempotency

`apply_paid_organization_payment` is vervangen door een strikt idempotente variant:

- duplicate events worden herkend op `event_key`;
- verwerkte events krijgen `receive_count` en `last_seen_at` updates, maar geen extra seatmutatie of audit-spam;
- een reeds als `paid` verwerkte betaling kan niet later terugvallen naar `failed`, `expired` of `canceled`;
- duplicate `paid` webhooks retourneren de bestaande payment zonder seats opnieuw te verhogen;
- failed/canceled/expired events loggen nog maar één keer.

### 6. Planwijzigingen niet langer direct/gratis

De oude RPC `request_organization_plan_change` past geen plan meer direct toe. Self-service plan upgrades lopen via de billing Edge Function en Mollie-checkout.

Nieuwe action:

- `createPlanChangeCheckout`

Na succesvolle betaling past de idempotente payment-RPC het plan toe. Custom-plannen en downgrades blijven handmatig, zodat contract/proratie niet foutief automatisch wordt verwerkt.

### 7. UI-hardening

Aangepast:

- Custom-plannen worden niet meer als self-service dropdownoptie getoond.
- Planwijziging-knop start nu een checkout in plaats van directe RPC-planmutatie.
- Mockbetalingen kunnen zowel extra-seat als plan-change flows afronden.
- UI-teksten verduidelijken dat betaalde upgrades via Mollie lopen.

### 8. Security hardening

Aangescherpt:

- `MOLLIE_OAUTH_STATE_SECRET` is verplicht in productie.
- `MOLLIE_TOKEN_ENCRYPTION_KEY` is verplicht in productie.
- `BILLING_ALLOWED_RETURN_ORIGINS` is verplicht in productie.
- Return URLs worden alleen toegestaan voor expliciet geconfigureerde origins.
- CORS is origin-aware en staat niet meer standaard breed open in productie.

## Nieuwe/gewijzigde bestanden

- `supabase/functions/billing/index.ts`
- `supabase/migrations/20260430_sprint2_mollie_connect_production_hardening.sql`
- `supabase/schema.sql`
- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
- `supabase/BRANDCORE_DATABASE_SETUP.sql`
- `src/services/billingService.ts`
- `src/services/mollieService.ts`
- `src/features/SimplePages.tsx`
- `src/types.ts`
- `.env.example`
- `package.json`
- `package-lock.json`

## Nieuwe Supabase secrets

Gebruik minimaal:

```bash
supabase secrets set \
  MOLLIE_CONNECT_CLIENT_ID="..." \
  MOLLIE_CONNECT_CLIENT_SECRET="..." \
  MOLLIE_CONNECT_REDIRECT_URL="https://YOUR_PROJECT.functions.supabase.co/billing" \
  MOLLIE_WEBHOOK_URL="https://YOUR_PROJECT.functions.supabase.co/billing?webhook=mollie" \
  MOLLIE_WEBHOOK_SECRET="..." \
  MOLLIE_OAUTH_STATE_SECRET="..." \
  MOLLIE_TOKEN_ENCRYPTION_KEY="..." \
  BILLING_ALLOWED_RETURN_ORIGINS="https://app.jouwdomein.nl" \
  MOLLIE_ALLOW_MOCK="false"
```

Voor lokaal/mock:

```bash
supabase secrets set \
  MOLLIE_ALLOW_MOCK="true" \
  BILLING_ALLOWED_RETURN_ORIGINS="http://localhost:5173"
```

## Acceptatiepunten

- Een organisatie kan eigen Mollie-account koppelen.
- Access/refresh tokens worden niet plaintext opgeslagen.
- Extra-seat checkout gebruikt het tenant-token van die organisatie.
- Webhook haalt payment status tenant-specifiek op.
- Duplicate paid webhook verhoogt seats niet dubbel.
- Duplicate failed/expired/canceled webhook schrijft geen audit-spam.
- Plan upgrade loopt via checkout in plaats van directe gratis RPC-mutatie.
- Custom plan is niet per ongeluk self-service selecteerbaar.
