# Test Report — Quote Approval + Resend Final Recheck

Datum: 2026-05-12

## Uitgevoerde controles

### Frontend TypeScript

```text
npm run typecheck
```

Resultaat: geslaagd.

### Productie-build

```text
npm run build
```

Resultaat: geslaagd.

Opmerking: Vite geeft een bestaande chunk-size warning voor de grote applicatiebundle. Dit is geen build error en blokkeert deployment niet.

### SQL/migratie-review
Handmatig gecontroleerd op:

- statusflow: draft → pending_internal_approval → internally_approved → sent → accepted/rejected
- directe browsermutaties op workflowvelden
- rechten op helper-RPC's
- publieke acceptatie met verlopen `valid_until`
- publieke tokenvalidatie
- Resend-send lifecycle: queued → sent/failed
- Resend webhook-idempotency
- out-of-order Resend delivery-events
- oude Resend-events die niet meer de actuele offerte mogen overschrijven

Resultaat: risico's gevonden en opgelost in `20260515_quote_approval_resend_flow_final_recheck.sql` en de Edge Functions.

### Edge Function static review
Gecontroleerde functies:

```text
quote-workflow
quote-public
resend-webhook
```

Controlepunten:

- CORS/origin checks
- service-role scheiding
- tokenhashing
- publieke accept/reject route
- Resend API aanroep
- webhook signature + replay-window
- idempotente webhook event-opslag
- throttling van publieke view-events

Resultaat: geen resterende blocker gevonden in statische review.

## Niet live getest
Niet live getest tegen echte Supabase Edge Functions/Resend, omdat daarvoor nodig is:

- gedeployde Supabase Edge Functions
- echte `SUPABASE_SERVICE_ROLE_KEY`
- echte `RESEND_API_KEY`
- verified Resend verzenddomein
- `RESEND_WEBHOOK_SIGNING_SECRET`
- correct ingestelde allowed origins

## Aanbevolen smoke-test na deploy

1. Maak conceptofferte met klant, project en regels.
2. Dien offerte ter interne goedkeuring in.
3. Controleer dat inhoudelijke velden vergrendeld zijn.
4. Probeer als niet-admin goed te keuren: moet falen.
5. Keur als admin goed.
6. Verstuur via Resend.
7. Open publieke `/quote/{token}` zonder login.
8. Accepteer offerte met naam/e-mail.
9. Controleer status `accepted` in app.
10. Controleer timeline en audit-log.
11. Trigger Resend webhook-testevent en controleer delivery-status.
12. Test verlopen offerte: publieke acceptatie moet falen.

## Eindoordeel
De flow is na deze tweede review duidelijk robuuster. De grootste productierisico's zaten niet in React/TypeScript, maar in database-rechten en server-side flowguarding. Die zijn in deze versie afgevangen.
