# BrandCore Sprint 2 — Test Report Mollie Connect Hardening

Datum: 2026-04-30  
Versie: `2.2.1-sprint2-mollie-connect-hardening`

## Uitgevoerde controles in deze omgeving

| Controle | Resultaat | Opmerking |
| --- | --- | --- |
| Codebase uitgepakt | Geslaagd | `brandcore-webapp-v2.2.0-sprint2-billing.zip` is uitgepakt en aangepast. |
| Auditbevindingen vertaald naar implementatie | Geslaagd | Focus op org-owned Mollie Connect, token storage, refresh rotation, tenant calls, checkout/webhook-idempotency. |
| TypeScript syntax parse van gewijzigde bestanden | Geslaagd | `supabase/functions/billing/index.ts`, `src/services/billingService.ts`, `src/features/SimplePages.tsx`, `src/types.ts`. |
| `npm ci` | Niet afgerond | Dependency-installatie werd in de container afgebroken met SIGTERM/time-out. Offline install mistte cache voor transitive package `yallist`. |
| `npm run typecheck` | Niet hard bewezen | Zonder `node_modules` ontbreken React/Supabase/lucide type packages. De gewijzigde bestanden zijn wel syntactisch geparseerd met de TypeScript compiler API. |
| `npm run build` | Niet hard bewezen | Build vereist dependency-installatie. |
| SQL migratie live uitvoeren | Niet uitgevoerd | Geen gekoppelde Supabase database in deze container. SQL is idempotent opgezet met `if not exists` en `create or replace function`. |

## Aanbevolen stagingtests

1. Run op lege Supabase database:

```sql
-- Gebruik supabase/BRANDCORE_DATABASE_SETUP.sql of supabase/schema.sql
```

2. Run op bestaande Sprint 2 database:

```sql
-- Gebruik supabase/migrations/20260430_sprint2_mollie_connect_production_hardening.sql
```

3. Deploy Edge Function:

```bash
supabase functions deploy billing
```

4. Zet secrets:

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

5. Acceptatietests:

| Scenario | Verwachting |
| --- | --- |
| Owner/admin opent billing | Billing overview laadt. |
| Member/viewer probeert billing mutatie | Wordt geblokkeerd. |
| Organisatie koppelt Mollie | `organization_mollie_connections` krijgt encrypted tokens; billing profile status wordt `connected`. |
| Access token is bijna verlopen | Edge Function refresht met refresh token en schrijft geroteerde token terug. |
| Extra-seat checkout dubbel geklikt | Bestaande open checkout wordt hergebruikt. |
| Mollie paid webhook 1e keer | Payment wordt `paid`, seats +1, audit wordt geschreven. |
| Mollie paid webhook 2e keer | Seats blijven gelijk, event receive_count stijgt, geen dubbele audit. |
| failed/expired webhook dubbel | Geen seatmutatie en geen audit-spam. |
| Team/Pro plan upgrade | Checkout wordt aangemaakt; plan wijzigt pas na paid webhook. |
| Custom plan in UI | Niet selecteerbaar als self-service plan. |

## Eindoordeel

De codebase is functioneel gehard richting productie, maar live productieacceptatie vereist nog een echte Supabase staging run met geïnstalleerde dependencies, Edge Function deploy en Mollie sandbox/live Connect test.
