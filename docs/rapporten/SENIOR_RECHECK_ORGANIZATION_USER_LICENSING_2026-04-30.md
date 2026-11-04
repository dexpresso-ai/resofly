# BrandCore v2.1.3 — Senior recheck organization user licensing

Datum: 2026-04-30

## Scope

Controle van de nieuw ingebouwde functionaliteit waarbij een organisatie meerdere gebruikers kan hebben, maar iedere actieve gebruiker of geldige openstaande uitnodiging één aangekochte gebruikerslicentie/seat moet verbruiken.

## Bevindingen uit review

### 1. Seat-reservering was functioneel aanwezig
De vorige versie bevatte al:
- `organizations.licensed_seats`
- `organization_invitations.consumes_license`
- `organization_license_usage(...)`
- `apply_organization_license_purchase(...)`
- database-triggers op leden en uitnodigingen

De belangrijkste beveiliging zat dus terecht server-side in Postgres, niet alleen in de frontend.

### 2. Aangescherpt: vrijgeven van gereserveerde seats
Ik heb de logica aangescherpt zodat een uitnodiging expliciet geen licentie meer vasthoudt zodra deze:
- geaccepteerd is;
- ingetrokken is;
- verlopen is.

Aangepast:
- `enforce_invitation_license_capacity()`
- `accept_organization_invitation(...)`
- frontend repository revoke-call

### 3. Aangescherpt: frontend invite-guard
De uitnodigknop kijkt nu niet alleen naar vrije seats, maar ook naar:
- admin/owner rechten;
- actieve organisatie;
- ingevuld e-mailadres;
- beschikbare licentie.

De database blijft de bron van waarheid; deze frontend-check is alleen UX.

### 4. Migratiepad toegevoegd
Nieuw toegevoegd:
- `supabase/migrations/20260430_organization_user_licensing_recheck.sql`

Deze is bedoeld voor installaties die v2.1.2 al hebben toegepast. Nieuwe databases gebruiken het complete fresh install schema.

## Geteste scenario's

| Scenario | Resultaat |
|---|---|
| 1 owner, 1 licentie, extra uitnodiging | Geblokkeerd |
| 1 owner, 2 licenties, extra uitnodiging | Toegestaan |
| 1 owner + 1 open uitnodiging bij 2 licenties, tweede uitnodiging | Geblokkeerd |
| Bestaande pending invite opnieuw versturen | Toegestaan, zolang dezelfde gereserveerde seat wordt gebruikt |
| Uitnodiging accepteren | Pending seat wordt vrijgegeven en actieve gebruiker gebruikt de seat |
| Disabled member heractiveren zonder vrije seat | Geblokkeerd |
| Licentievelden direct wijzigen via normale client-update | Geblokkeerd door trigger |
| Licenties aanpassen via service-role RPC | Toegestaan via `apply_organization_license_purchase(...)` |
| Licenties downgraden onder actief/gereserveerd gebruik | Geblokkeerd |
| Ingetrokken/verlopen/geaccepteerde uitnodiging | Houdt geen seat meer vast |

## Uitgevoerde technische checks

- `package.json` gevalideerd als JSON.
- `package-lock.json` gevalideerd als JSON.
- `npm run lint:sql` uitgevoerd. Dit project bevat momenteel een placeholder-script.
- Complete schema-bestanden vergeleken en gelijkgetrokken:
  - `supabase/schema.sql`
  - `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
  - `supabase/BRANDCORE_DATABASE_SETUP.sql`
- Statische checks uitgevoerd op aanwezigheid van:
  - licentievelden;
  - licentie-event tabel;
  - seat-usage RPC;
  - billing/service-role RPC;
  - capacity triggers;
  - direct-change guard;
  - grants/revokes;
  - frontend license metrics;
  - repository RPC-calls.
- Domeinlogica gesimuleerd voor seat-capacity scenario’s.

## Niet volledig uitvoerbaar in deze container

Een echte TypeScript/Vite build kon hier niet betrouwbaar worden afgerond, omdat de zip geen `node_modules` bevat en de beschikbare globale `tsc` in deze container blijft hangen zonder bruikbare compile-output. De relevante TypeScript/React-wijzigingen zijn daarom statisch gecontroleerd.

## Conclusie

De licentielaag is nu productiewaardiger: seats worden server-side afgedwongen, race-conditions worden beperkt via `for update` op de organisatie, en uitnodigingen geven hun reservering betrouwbaar vrij wanneer ze niet meer pending/geldig zijn.
