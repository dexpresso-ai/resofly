# Changelog — De galerij voor iedereen — 2026-11-14

## Aanleiding

> Esmay kan geen gallerij aanmaken zodra ze een project heeft aangemaakt. Daar missen we de
> optie gallerij.

> Zet de gallerij altijd open voor ieder abonnement. Push meteen naar staging als je klaar bent.

## Wat er mis was

De galerij hoorde bij de **creatieve module**, een betaalde optie van €9 per maand
(20260806000000). Die kon je pas aanzetten op een lopend abonnement. Zonder de module liet het
project geen tabblad Galerij zien, en nergens stond waarom. Wie net begon of zonder abonnement
werkte, kon dus nooit een galerij maken en wist niet dat die bestond.

Daarnaast zat er een fout in `organization_creative_status`. Die functie zocht het
billingprofiel van de organisatie zelf. Een dochter-administratie (bijvoorbeeld een werk-bv
onder een holding) heeft geen eigen profiel. Daar was het tabblad dus altijd weg, ook als de
moeder de module had. De database liet het aanmaken wel toe.

## Wat er nu kan

- **Elke organisatie heeft de galerij**, bij elk plan en ook zonder betaald abonnement. Het
  tabblad Galerij staat bij elk project.
- In **Instellingen → Abonnement** en in de inrichting staat de creatieve module als
  "Inbegrepen". Er is geen knop en geen vinkje van €9 meer.
- Ook **dochter-administraties** zien de galerij.

## Hoe

Migratie `20261114100000_galerij_voor_iedereen.sql`:

1. Elk plan in `billing_plans` krijgt `limits.creative_included = true`, zoals custom al had.
   De billing-functie rekent de module dan nergens meer (`planIncludesCreative`).
2. `org_has_creative` is true voor ieder lid, los van het billingprofiel. De ledencontrole uit
   20261110140000 blijft: een buitenstaander krijgt false.
3. `organization_creative_status` leest het profiel van de moeder en geeft `active` en
   `included_in_plan` true, ook als er geen profiel is.

De schrijf-gate op de galerijtabellen en de bevries-logica blijven staan. Ze vragen
`org_has_creative` en laten nu alles door. Moet de galerij ooit weer achter een betaalmuur, dan
is dat één functie.

In de app:

- `creativePlanCents` (Instellingen → Abonnement) en de prijs in de inrichting geven 0 als het
  plan de module bevat. Zonder die controle bood het scherm een vinkje van €9 aan voor iets wat
  al inbegrepen was. De billing-functie rekende het niet, maar het getoonde totaal wel.
- De testmock van de inrichting (`tests/mobile/mock/backend.mjs`) volgt de nieuwe plannen.
- `EXPORT_SCHEMA_VERSION` gaat naar 20261114100000. Er zijn geen tabellen of kolommen bij
  gekomen.

## Let op: wie al betaalde

Organisaties die de creatieve module al aan hadden, betalen de €9 nog op hun lopende
Mollie-abonnement. Bij de volgende herberekening valt die weg: wisselen van plan, een seat of
een opslagbundel erbij. Wil je dat meteen rechtzetten, pas dan het bedrag van die abonnementen
aan in Mollie, of laat de billing-functie het bedrag één keer opnieuw zetten. Op staging speelt
dit niet.

## Getest

- `npm run typecheck` en `npm test`: groen (1775 tests).
- `supabase db reset`: de hele keten vanaf nul, de nieuwe migratie twee keer achter elkaar
  zonder fouten. Alle vier de plannen hebben daarna `creative_included = true`.
- In die verse database, als ingelogd lid:
  - een moeder op starter zonder module: `org_has_creative` true, status active en inbegrepen;
  - haar dochter-administratie zonder eigen profiel: hetzelfde;
  - een organisatie zonder billingprofiel: hetzelfde;
  - een buitenstaander: `org_has_creative` false;
  - de server (service-role): active.
- De restrictive policies op `galleries` vragen alleen `org_has_creative`. Verder lezen alleen
  `apply_organization_creative_change`, `organization_billing_overview` en
  `organization_creative_status` de vlaggen.
- `npm run test:inrichten`: alle 111 controles geslaagd, met de bijgewerkte mock.
