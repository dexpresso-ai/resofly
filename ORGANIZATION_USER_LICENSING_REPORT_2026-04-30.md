# Organization user licensing — 2026-04-30

## Doel
BrandCore ondersteunt meerdere gebruikers per organisatie. Deze aanpassing zorgt dat het datamodel en de server-side database-logica afdwingen dat iedere actieve gebruiker één aangekochte gebruikerslicentie/seat verbruikt.

## Toegevoegd aan datamodel

### `organizations`
Nieuwe velden:
- `licensed_seats` — aantal aangekochte gebruikerslicenties, standaard `1`.
- `license_status` — `trialing`, `active`, `past_due` of `cancelled`.
- `license_provider` — toekomstige billing-provider, bijvoorbeeld Mollie/Stripe/custom.
- `license_external_customer_id` — externe klantreferentie.
- `license_external_subscription_id` — externe abonnements-/licentiereferentie.

### `organization_invitations`
Nieuw veld:
- `consumes_license` — standaard `true`. Openstaande uitnodigingen reserveren dus alvast een licentie.

### `organization_license_events`
Nieuwe tabel voor licentiehistorie:
- legt initiële seats, aankopen, downgrades en billing-syncs vast;
- alleen admins kunnen deze events lezen via RLS;
- writes lopen niet via de client, maar via service-role/billing.

## Server-side afdwinging

### Seat-capacity
Toegevoegde databasefuncties/triggers:
- `organization_license_usage(...)` geeft purchased/used/free seats terug voor de actieve organisatie.
- `organization_reserved_license_count(...)` telt actieve leden + geldige pending invites.
- `enforce_invitation_license_capacity()` blokkeert uitnodigingen zonder vrije licentie.
- `enforce_member_license_capacity()` blokkeert activeren/accepteren van gebruikers zonder vrije licentie.
- `prevent_organization_license_direct_change()` voorkomt dat normale client-calls licentievelden direct aanpassen.

### Billing/service-role sync
Toegevoegd:
- `apply_organization_license_purchase(...)`

Deze functie is bedoeld voor de latere billing-flow/webhook. De functie is niet aan normale authenticated users toegekend, maar aan `service_role`. Daarmee kan billing na aankoop het aantal seats verhogen zonder dat een gebruiker dit via de frontend kan faken.

## Frontend
In Instellingen is een licentieblok toegevoegd met:
- aangekochte seats;
- actieve gebruikers;
- gereserveerde seats door openstaande uitnodigingen;
- vrije seats.

De knop “Uitnodigen” wordt geblokkeerd als er geen vrije licentie beschikbaar is. De database blijft de echte bron van waarheid.

## Migratie
Nieuwe migratie:
- `supabase/migrations/20260430_organization_user_licensing.sql`

Voor bestaande organisaties zet de migratie `licensed_seats` automatisch minimaal gelijk aan het huidige aantal actieve leden + geldige openstaande uitnodigingen, zodat bestaande teams niet breken.

## Uitgevoerde checks
- Gecontroleerd dat de drie complete schema-bestanden identiek zijn gebleven:
  - `supabase/schema.sql`
  - `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
  - `supabase/BRANDCORE_DATABASE_SETUP.sql`
- `npm run lint:sql` uitgevoerd; dit project bevat momenteel alleen een SQL-lint placeholder.
- `package.json` en `package-lock.json` gecontroleerd op geldige JSON.
- TypeScript build/typecheck kon in deze container niet betrouwbaar afgerond worden: er staat geen lokale `node_modules` in de zip en de beschikbare globale `tsc` bleef hangen zonder compile-output. De code is daarom statisch nagelopen op imports, types en gewijzigde context-velden.


## v2.1.3 recheck
Aanvullende hardening:
- geaccepteerde uitnodigingen zetten `consumes_license = false`;
- ingetrokken uitnodigingen geven de seat expliciet vrij;
- verlopen/pending invites worden door de trigger niet langer als licentiereservering vastgehouden;
- extra migratie toegevoegd voor bestaande v2.1.2-installaties: `20260430_organization_user_licensing_recheck.sql`;
- frontend invite-knop controleert nu ook rechten en actieve organisatie.
