# BrandCore Sprint 2 — Senior Test / Review Report

Datum: 2026-04-30  
Scope: Sprint 2 billing, Mollie Connect voorbereiding, payment/webhook flow, licentiebeheer, UI en regressiecheck op bestaande organisatiefunctionaliteit.

## Uitgevoerde checks

### 1. Bestands- en importcheck

Uitgevoerd met een Node-script dat alle relatieve TypeScript/TSX imports in `src` controleert.

Resultaat:

- 27 TS/TSX-bestanden gecontroleerd.
- Alle relatieve imports resolven naar bestaande bestanden.

### 2. SQL object smoke check

Gecontroleerd of de Sprint 2-migratie minimaal de gevraagde objecten bevat:

- `organization_billing_profiles`
- `organization_subscriptions`
- `organization_billing_events`
- `organization_payment_records`
- `organization_license_changes`
- `organization_billing_overview`
- `apply_paid_organization_payment`

Resultaat: alle objecten aanwezig.

### 3. RLS/security review

Gecontroleerd:

- Nieuwe billing-tabellen hebben RLS enabled.
- Billing-tabellen hebben alleen read policies voor owners/admins, behalve publieke actieve plan-catalogus.
- Directe writes vanuit frontend zijn bewust niet mogelijk op billing-tabellen.
- Payment/seat-mutaties lopen via Supabase Edge Function met service-role.
- `organizations.licensed_seats` blijft beschermd door de bestaande direct-change guard.
- Admin checks zitten in RPC’s en Edge Function.

Resultaat: ontwerp voldoet aan tenant-isolatie en SaaS-seat security uitgangspunt.

### 4. Webhook-idempotency review

Gecontroleerd:

- `organization_billing_events.event_key` is uniek.
- Webhook event key is opgebouwd uit provider/payment/status.
- `organization_payment_records.processed_at` voorkomt dubbele seat-toepassing.
- Failed/canceled/expired betalingen passen geen seats toe.

Resultaat: dubbele webhook-calls verhogen seats niet dubbel.

### 5. Seat-capacity review

Gecontroleerd:

- Bestaande invitation/member guards blijven actief.
- `organization_reserved_license_count` telt actieve members + geldige pending invitations.
- Verlopen pending invitations tellen niet mee.
- `expire_stale_organization_invitations` zet verlopen invitations vrij.
- Billing-profile updates worden geblokkeerd als het nieuwe aantal seats lager is dan active + pending.

Resultaat: seat-limiet wordt database-first afgedwongen.

### 6. Frontend review

Gecontroleerd:

- Nieuwe Billing & licenties-sectie is toegevoegd aan organisatie-instellingen.
- Niet-admins krijgen geen billing-acties.
- Loading/disabled states aanwezig voor refresh, Mollie connect, extra seat, mockbetaling en planwijziging.
- Foutmeldingen worden apart getoond.
- Invitation-knop gebruikt actuele seat overview, met fallback op bestaande license usage.

Resultaat: UI sluit aan op multi-user SaaS-flow.

### 7. Fresh install / migratie review

Gecontroleerd:

- Losse migratie aanwezig voor bestaande database.
- Fresh install schema’s zijn aangevuld met dezelfde Sprint 2-migratie.
- Backfill maakt billing profiles/subscriptions voor bestaande organisaties.
- Bestaande `organizations.licensed_seats` waarden worden behouden.

Resultaat: zowel fresh install als bestaande migratiepad zijn voorbereid.

## Scenario-analyse

| Scenario | Verwacht resultaat | Status |
| --- | --- | --- |
| 1 seat, 2e gebruiker uitnodigen | Invitation wordt geblokkeerd | Gedekt door DB trigger + UI melding |
| Admin koopt extra seat | Payment record wordt gemaakt, seat pas na paid webhook verhoogd | Gedekt |
| Dubbele webhook | Geen dubbele seat-verhoging | Gedekt met `event_key` + `processed_at` |
| Payment mislukt | Status failed, geen seat-mutatie | Gedekt |
| Payment verloopt | Status expired, geen seat-mutatie | Gedekt |
| Pending invitation verloopt | Seat komt vrij | Gedekt via expiry RPC/usage logic |
| Gebruiker disabled | Seat komt vrij | Gedekt door active-member count |
| Downgrade onder actieve gebruikers | Geblokkeerd | Gedekt door `request_organization_plan_change` en profile trigger |
| Niet-admin wijzigt billing | Geblokkeerd | Gedekt door UI/RPC/Edge checks |
| Directe `licensed_seats` update | Geblokkeerd | Gedekt door bestaande guard |
| Geen Mollie-koppeling, wel seat kopen | Checkout geweigerd | Gedekt |
| Fresh install | Schema bevat Sprint 2 append | Gedekt |
| Bestaande database | Migratie backfilt billing laag | Gedekt |

## Niet volledig uitgevoerd in deze container

`npm ci`, `npm run typecheck` en `npm run build` konden in deze container niet binnen de beschikbare runtime afronden. Er is geen `node_modules` map beschikbaar in de zip en de pakketinstallatie bleef hangen. Daarom is er geen volledige lokale Vite-build uitgevoerd.

Wel uitgevoerd:

- relatieve importvalidatie;
- SQL object smoke check;
- handmatige TypeScript/import review;
- handmatige SQL/RLS/RPC review;
- handmatige scenario-analyse;
- documentatiecontrole.

## Aanbevolen acceptatietest na uitpakken

```bash
npm ci
npm run typecheck
npm run build
```

Daarna:

```bash
supabase db push
supabase functions deploy billing
```

Voor lokale mocktest:

```bash
supabase secrets set MOLLIE_ALLOW_MOCK=true
```

Controleer vervolgens:

1. Log in als owner/admin.
2. Open Organisatie & instellingen.
3. Controleer Billing & licenties.
4. Koppel Mollie mock.
5. Maak extra-seat checkout.
6. Rond mockbetaling af.
7. Controleer dat seats +1 worden.
8. Nodig extra gebruiker uit.
9. Controleer audit-log en payment/license records in Supabase.

## Conclusie

De Sprint 2-codebase bevat een consistente billing- en licentiebeheerlaag met productiegerichte uitgangspunten. De volledige runtime build moet nog in een omgeving met werkende dependency-installatie worden bevestigd.
