# BrandCore Sprint 2 — Billing, Mollie & Licentiebeheer

Datum: 2026-04-30  
Versie: `2.2.0-sprint2-billing`

## Samenvatting

Sprint 2 bouwt een productiegerichte billing- en licentiebeheerlaag bovenop de bestaande BrandCore multi-tenant organisatiebasis. De bestaande Sprint 1-functionaliteit blijft intact: organisaties, members, invitations, rollen, audit-log, dashboard, tenant-isolatie, agenda-privacy en de bestaande CRM/project/finance flows zijn niet verwijderd of vervangen.

Belangrijk ontwerpprincipe: `organizations.licensed_seats` blijft bestaan voor backwards compatibility, maar wordt vanaf Sprint 2 aangestuurd vanuit `organization_billing_profiles`. Frontendgebruikers kunnen `licensed_seats` niet direct verhogen; seat-mutaties lopen via service-role RPC's, payment records en webhookverwerking.

## Aangepaste / toegevoegde bestanden

### Database

- `supabase/migrations/20260430_sprint2_billing_mollie_licensing.sql`
- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
- `supabase/schema.sql`
- `supabase/BRANDCORE_DATABASE_SETUP.sql`

### Supabase Edge Function

- `supabase/functions/billing/index.ts`

### Frontend services

- `src/services/billingService.ts`
- `src/services/mollieService.ts`
- `src/services/licenseService.ts`

### Frontend / types / styling

- `src/types.ts`
- `src/lib/repository.ts`
- `src/features/SimplePages.tsx`
- `src/styles/globals.css`
- `.env.example`
- `package.json`

## Nieuwe tabellen

### `billing_plans`
Plan-catalogus met uitbreidbare prijzen en limieten.

Default plans:

| Plan | Inbegrepen seats | Extra seat-prijs |
| --- | ---: | ---: |
| Starter | 1 | €9,00 |
| Team | 3 | €8,00 |
| Pro | 10 | €7,00 |
| Custom | handmatig | handmatig |

### `organization_billing_profiles`
Source-of-truth voor plan, seats, subscription status, payment status en Mollie-identifiers per organisatie.

Belangrijke velden:

- `plan_key`
- `included_seats`
- `purchased_seats`
- `licensed_seats`
- `subscription_status`
- `payment_status`
- `mollie_connect_status`
- `mollie_connect_account_id`
- `mollie_customer_id`
- `mollie_mandate_id`
- `mollie_subscription_id`
- `last_payment_status`
- `next_invoice_date`
- `trial_ends_at`
- `current_period_ends_at`

### `organization_subscriptions`
Subscriptionlaag voor huidige/ toekomstige Mollie subscriptions.

### `organization_payment_records`
Payment records voor checkout/payment intent flows. Extra seats worden pas toegepast wanneer een payment succesvol is verwerkt.

### `organization_billing_events`
Idempotente event-log voor webhooks en billing events. `event_key` is uniek, zodat dubbele webhooks veilig verwerkt kunnen worden.

### `organization_license_changes`
Auditbare licentiewijzigingen: initial, plan changes, seat purchases, downgrade requests, manual corrections en billing syncs.

## Nieuwe / aangepaste RPC's en triggers

### RPC's

- `organization_billing_overview(p_organization_id)`
- `ensure_organization_billing_profile(p_organization_id)`
- `apply_paid_organization_payment(p_provider_payment_id, p_payment_status, p_payload)`
- `request_organization_plan_change(p_organization_id, p_plan_key)`
- `record_invitation_blocked_insufficient_seats(p_organization_id, p_email)`
- `expire_stale_organization_invitations(p_organization_id)`
- `organization_used_license_count(p_organization_id)`
- vernieuwde backwards-compatible `apply_organization_license_purchase(...)`

### Triggers

- `organization_billing_profiles_capacity_guard`
- `organization_billing_profiles_sync_org`
- `organization_billing_profiles_audit`
- `organization_subscriptions_audit`
- `organization_payment_records_audit`
- `organization_billing_events_audit`
- `organization_license_changes_audit`

De bestaande Sprint 1 triggers voor member/invitation seat capacity blijven bestaan.

## RLS en security

Nieuwe billing-tabellen hebben RLS aan.

- `billing_plans`: leesbaar als plan actief is.
- `organization_billing_profiles`: alleen leesbaar voor owners/admins van de organisatie.
- `organization_subscriptions`: alleen leesbaar voor owners/admins.
- `organization_payment_records`: alleen leesbaar voor owners/admins.
- `organization_billing_events`: alleen leesbaar voor owners/admins.
- `organization_license_changes`: alleen leesbaar voor owners/admins.

Er zijn bewust geen directe frontend write-policies toegevoegd voor billing-tabellen. Mutaties lopen via:

- authenticated admin RPC's voor planwijzigingen en audit-signalen;
- Supabase Edge Function met service-role voor Mollie checkout/webhook;
- service-role RPC's voor daadwerkelijke payment/seat-mutaties.

`organizations.licensed_seats` blijft beschermd door de bestaande `prevent_organization_license_direct_change()` trigger. Een gemanipuleerde frontend/API-call kan dit veld niet rechtstreeks verhogen.

## Mollie-configuratie

Voeg deze secrets toe aan de Supabase Edge Function environment:

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
MOLLIE_API_KEY=test_xxx_or_live_xxx
MOLLIE_CONNECT_CLIENT_ID=...
MOLLIE_CONNECT_CLIENT_SECRET=...
MOLLIE_CONNECT_REDIRECT_URL=https://YOUR_PROJECT.functions.supabase.co/billing
MOLLIE_WEBHOOK_URL=https://YOUR_PROJECT.functions.supabase.co/billing?webhook=mollie
MOLLIE_WEBHOOK_SECRET=<long-random-secret>
MOLLIE_OAUTH_STATE_SECRET=<long-random-secret>
BILLING_ALLOWED_RETURN_ORIGINS=http://localhost:5173,https://app.jouwdomein.nl
MOLLIE_ALLOW_MOCK=false
```

Voor lokale/mock-tests kan tijdelijk:

```bash
MOLLIE_ALLOW_MOCK=true
```

Als Mollie Connect secrets ontbreken en mock aan staat, zet de Edge Function de organisatie op `mock_connected`. Daarmee kun je de extra-seat flow lokaal testen zonder echte Mollie API-call.

## Webhook-configuratie

Configureer in Mollie de webhook URL als:

```text
https://YOUR_PROJECT.functions.supabase.co/billing?webhook=mollie&secret=<MOLLIE_WEBHOOK_SECRET>
```

De webhook:

1. ontvangt Mollie `id`;
2. haalt server-side de actuele payment status bij Mollie op;
3. roept `apply_paid_organization_payment(...)` aan;
4. schrijft `organization_billing_events` met unieke `event_key`;
5. werkt `organization_payment_records` bij;
6. verhoogt seats alleen wanneer status `paid` is en `processed_at` nog leeg is;
7. schrijft audit-events.

Dubbele webhook-calls zijn veilig: hetzelfde event krijgt dezelfde `event_key` en een payment met `processed_at` wordt niet opnieuw toegepast.

## Extra seats flow

1. Admin opent Organisatie-instellingen → Billing & licenties.
2. Admin koppelt Mollie.
3. Admin klikt op “Extra licentie kopen”.
4. Edge Function maakt een `organization_payment_records` record aan.
5. Bij echte Mollie-configuratie wordt een Mollie checkout gemaakt.
6. Na succesvolle payment verwerkt de webhook het payment record.
7. `organization_billing_profiles.purchased_seats` en `licensed_seats` worden verhoogd.
8. Trigger synchroniseert `organizations.licensed_seats`.
9. De invitation-flow kan daarna een extra pending invitation reserveren.

Openstaande invitations blijven seats reserveren. Actieve leden + pending invitations kunnen niet boven `licensed_seats` uitkomen.

## UI

Nieuwe Billing & licenties-sectie in `src/features/SimplePages.tsx` toont:

- huidig plan;
- actieve gebruikers;
- pending invitations;
- inbegrepen seats;
- aangekochte extra seats;
- vrije seats;
- betaalstatus;
- Mollie status;
- volgende factuurdatum;
- acties: Mollie koppelen, extra licentie kopen, plan wijzigen, billing verversen.

Niet-admins zien geen billing-acties.

## Geteste / geanalyseerde scenario's

| Scenario | Resultaat |
| --- | --- |
| Organisatie heeft 1 seat en probeert 2e gebruiker uit te nodigen | Database-trigger blokkeert invitation; frontend toont melding; audit RPC registreert blokkade in aparte transactie. |
| Admin koopt extra seat en nodigt daarna gebruiker uit | Payment record → webhook/RPC → profile sync → `organizations.licensed_seats` omhoog → invitation toegestaan. |
| Payment webhook komt dubbel binnen | `organization_billing_events.event_key` + `payment_records.processed_at` voorkomen dubbele seat-verhoging. |
| Payment mislukt | Payment status wordt `failed`; geen seat-mutatie; audit `payment_failed`. |
| Payment verloopt | Payment status wordt `expired`; geen seat-mutatie; audit `payment_expired`. |
| Pending invitation verloopt | `expire_stale_organization_invitations` zet verlopen pending invites op `expired` en `consumes_license=false`; usage telt verlopen invites niet mee. |
| Gebruiker wordt verwijderd/disabled | Bestaande member status flow laat seat vrij omdat alleen `active` members tellen. |
| Downgrade naar minder seats dan actieve gebruikers | `request_organization_plan_change` blokkeert als nieuwe seat-cap lager is dan active + pending. |
| Niet-admin probeert billing te wijzigen | RLS/RPC/Edge Function role checks blokkeren. |
| Gemanipuleerde call probeert `licensed_seats` direct te verhogen | Bestaande `organizations_license_guard` blokkeert direct updates. |
| Organisatie zonder Mollie-koppeling probeert extra seats te kopen | Edge Function weigert checkout met duidelijke melding. |
| Fresh install | Fresh schema-bestanden bevatten Sprint 2 append en eindigen in dezelfde staat als migratie. |
| Bestaande database | Losse migration backfilt billing profiles/subscriptions op basis van bestaande organisaties en seat-aantallen. |

## Testnotitie

In deze omgeving kon `npm ci` niet afronden binnen de beschikbare runtime, waardoor een volledige Vite build met geïnstalleerde `node_modules` niet volledig is uitgevoerd. Wel uitgevoerd/gecontroleerd:

- package-structuur en imports handmatig nagelopen;
- statische consistentie van TypeScript imports/exports gecontroleerd;
- Supabase migratie op hoofdonderdelen nagekeken;
- RLS-grants/revokes nagekeken;
- frontend state en disabled/loading states nagekeken;
- webhook-idempotency ontwerp gecontroleerd;
- edge cases handmatig geanalyseerd.

Aanbevolen na uitpakken:

```bash
npm ci
npm run typecheck
npm run build
```

Daarna in Supabase:

```bash
supabase db push
supabase functions deploy billing
```

## Bekende beperkingen / productiepunten

1. De Mollie Connect OAuth flow slaat in deze basis alleen account/status identifiers op. Voor volledig handelen namens gekoppelde merchant accounts moet je access/refresh tokens encrypted opslaan in een vault/tokens-table en token rotation toevoegen.
2. Automatische recurring Mollie subscriptions zijn voorbereid in het datamodel, maar nog niet volledig geactiveerd voor maandelijkse incasso's.
3. Prijzen zijn technisch uitbreidbaar in `billing_plans`, maar moeten zakelijk definitief worden vastgesteld.
4. Webhook security gebruikt een geheime URL-token, omdat Mollie webhooks zelf geen standaard HMAC-signature meesturen. Gebruik een lange random secret en beperk logs.

## Conclusie

Sprint 2 legt een serieuze SaaS-basis onder BrandCore: organisatiebilling, seat-management, Mollie voorbereiding, veilige service-role paymentverwerking, idempotente webhooklogica, RLS-afscherming en een duidelijke admin UI. Bestaande Sprint 1-functionaliteit en organisatie-/gebruikerslicentiefunctionaliteit zijn behouden.
