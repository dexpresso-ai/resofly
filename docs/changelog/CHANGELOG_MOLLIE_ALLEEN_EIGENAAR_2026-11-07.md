# Mollie koppelen: alleen de eigenaar — 7 november 2026

Vervolg op `CHANGELOG_MOLLIE_KOPPELING_2026-11-06.md`. Twee dingen.

## 1. Alleen de eigenaar koppelt Mollie of vervangt de key

Besluit van de eigenaar, open punt 2 van de controle van 6 november: "Alleen
eigenaren mogen koppelen."

Waarom: met de key bepaal je op welk Mollie-account het geld van klanten
binnenkomt. Tot nu toe kon elke beheerder een key koppelen of vervangen, ook die
van een ander account. Sinds 6 november staat dat wel in het auditlog, maar dat
zie je pas achteraf.

| Wie | Koppelen of key vervangen | Ontkoppelen | Status zien |
| --- | --- | --- | --- |
| Eigenaar | ja | ja | ja |
| Beheerder | **nee** (was: ja) | ja | ja |
| Lid, lezer, kijker, boekhouder | nee | nee | met Financiën-leesrecht via de functie, niet in Instellingen |

Ontkoppelen mag een beheerder blijven doen. Daarmee gaat geen geld ergens
anders heen, en bij een gelekte key moet het snel kunnen. Wil je ook dat alleen
voor de eigenaar, dan is dat één regel in `deleteInvoiceMollieKey`.

Wat er veranderde:
- **Server** (`saveInvoiceMollieKey` in `invoice-workflow`): weigert iedereen
  behalve de eigenaar met een 403 en de reden. Dat gebeurt vóór er iets naar
  Mollie gaat.
- **Scherm** (Instellingen → Online betalen): de eigenaar ziet het formulier.
  Een beheerder ziet de status, het profiel en "Mollie ontkoppelen", met de
  uitleg dat alleen de eigenaar koppelt.
- Gerrie, de agents, MCP en de API konden de key al niet zetten; daar
  verandert niets.

## 2. `MOLLIE_TOKEN_ENCRYPTION_KEY` staat op staging

Gezet op 7 november om 07:42 (UTC) met toestemming van de eigenaar. Dat ging
via de workflow *Deploy Supabase (staging)* met het vinkje *setup_webhooks*
(run 189). Het script heeft alleen deze sleutel gezet; de andere secrets en
taken stonden er al en zijn niet aangeraakt. De waarde is in GitHub Actions
gemaakt en gemaskeerd, en komt nergens in beeld. De rooktest is groen, ook
de nieuwe controle op de Mollie-secrets.

Rechtstreeks via de Management API zetten vanuit de sessie werd tegengehouden
(schrijven naar een geheimenopslag). De workflow is de gedocumenteerde weg.

Wat dit betekent voor de bestaande koppeling op staging: de key wordt bij het
eerstvolgende gebruik (betaallink of webhook) opnieuw versleuteld met deze
sleutel. Lukt dat niet (je ziet "ontsleutelen mislukt" in de logs van
`invoice-workflow`, of een betaallink die niet lukt), plak de key dan opnieuw in
Instellingen → Online betalen. Dat kan nu alleen de eigenaar.

## Getest

- `npm test`: 1178 van 1178. In `mollieSecrets.test.ts` staat nu dat
  `saveInvoiceMollieKey` alleen de eigenaar toelaat en ontkoppelen ook een
  beheerder.
- `npm run typecheck`: schoon.
- Stromentest (`mollie`, `facturen`, `beveiliging`): de beheerder krijgt een
  403 bij koppelen en vervangen (Mollie wordt niet gebeld, er verandert niets),
  en kan wel ontkoppelen. In `beveiliging` staat de beheerder nu in het rijtje
  rollen dat `saveInvoiceMollieKey` niet mag.
- UI-test `mollie` in Chromium: de beheerder ziet geen formulier en geen
  "Key vervangen", wel de koppeling met profiel en "Mollie ontkoppelen". De
  eigenaar koppelt. Het auditlog zegt wie wat deed.
- `npm run test:mobile` op de Instellingen-tabbladen, licht en donker.
