# Mollie koppelen in Instellingen — 6 november 2026

Vraag: "Via instellingen kunnen gebruikers zelf hun Mollie-account koppelen.
Controleer of dit helemaal op een goede, correcte en veilige manier gaat. Doe
daarna een zorgvuldige controle of de functionaliteit werkt en veilig gebeurt."

Het gaat om Instellingen → Online betalen: een eigenaar of beheerder plakt de
API-key van het eigen Mollie-account. Daarmee maakt ResoFly betaallinks bij
facturen, kijkt de webhook betalingen na, en lopen terugbetalingen en
e-facturen via Mollie. Het geld komt dus binnen op het account van die key.

## Wat al goed zat

- Alleen een eigenaar of beheerder koppelt, vervangt of ontkoppelt (server én
  scherm). Een lid, lezer, kijker of boekhouder niet, en een andere organisatie
  ook niet.
- De key gaat over HTTPS naar `invoice-workflow`, wordt bij Mollie gecontroleerd
  en versleuteld opgeslagen (AES-GCM). Naar de browser gaan alleen de status,
  de modus en de laatste vier tekens.
- De tabel `organization_invoice_mollie_settings` is alleen voor de server. Op
  staging nagekeken: RLS aan, geen rechten voor `anon` of `authenticated`, en
  geen databasefunctie die hem leest.
- Gerrie, de agents, MCP en de openbare API kunnen de key niet zetten, lezen of
  wissen.
- De webhook vertrouwt niets uit het verzoek: hij vraagt de betaling op bij
  Mollie, met de key van de organisatie, en controleert de metadata.

## Wat er misging

1. **Koppelen werkte niet op staging.** Het geheim `MOLLIE_TOKEN_ENCRYPTION_KEY`
   ontbrak in de secrets van de edge functions. Sinds 5 november weigert
   versleutelen zonder dat geheim (terecht). Maar de functie belde eerst Mollie,
   en gaf daarna een algemene serverfout. Het rapport van 5 november
   (`REVIEW_CONTRACT_OFFERTE_FACTUUR_2026-11-05.md`, actie 3) vroeg al om het
   geheim te zetten. Dat was niet gebeurd, en geen controle zag het.
2. **De key op staging was in feite onversleuteld.** De koppeling van 2 juni is
   opgeslagen met de oude terugval: een vaste sleutel die in de code staat.
3. **Het scherm zei niet waarom.** Bij een geweigerde key toonde Instellingen
   "Edge Function returned a non-2xx status code". De reden van de server
   (begint niet met live_/test_, Mollie weigert de key, geen rechten) kwam niet
   door.
4. **De key kon in de logs belanden.** Plakte je een key met een regeleinde
   erin (bijvoorbeeld uit een afgebroken mail), dan gooide `fetch` een fout met
   de hele header erin. Die melding ging terug naar het scherm, en naar de logs
   van de edge function. Nagespeeld met Deno 2.9:
   `Invalid header value: "Bearer live_…"`.
5. **Niets in het auditlog.** Koppelen, een key vervangen en ontkoppelen
   werden nergens vastgelegd. Een beheerder kon zo een key van een ander
   Mollie-account plakken, en niemand kon later zien wie dat deed, of wanneer.
6. **Je zag niet welk account gekoppeld was.** Alleen "Test-modus · key ••••3f2a".
7. **Testmodus zonder uitleg.** Met een test-key gaat er bij elke factuur een
   testbetaallink mee. Daar kiest de betaler zelf "betaald", en dan zet ResoFly
   de factuur op betaald en boekt hem. Het scherm zei daar niets over.
8. **Wisselen van account terwijl er links openstaan.** Een key van een ander
   account (of van test naar live) ziet de lopende betalingen van de vorige key
   niet. Daar werd niet voor gewaarschuwd. Bij ontkoppelen wel.

## Wat er nu gebeurt

- **Koppelen** (`saveInvoiceMollieKey` in `invoice-workflow`): eerst de rol,
  dan of de server de key kan versleutelen. Zo niet, dan een duidelijke melding
  en wordt Mollie niet gebeld. Daarna de vorm van de key: `test_` of `live_`
  met daarachter alleen letters en cijfers (16 tot 128). Een key met een
  regeleinde wordt geweigerd vóór er iets naar Mollie gaat, en geen enkele
  melding bevat nog de tekst van `fetch`.
- **Welk account** (`_shared/mollieSecrets.ts`): de controle vraagt
  `GET /v2/profiles/me`. Mollie geeft dan het profiel van de key: id, naam,
  website en status. Dat staat in `metadata.profile` (geen geheim) en de
  instellingen tonen het. Geeft dat adres iets anders dan goed of geweigerd,
  dan geldt de oude controle (`/v2/methods`), zonder profiel. Koppelen loopt
  dus niet vast op die extra informatie.
- **Auditlog**: "Mollie gekoppeld", "Bijgewerkt" (key vervangen) en
  "Ingetrokken" (ontkoppeld), met wie, de modus, de laatste vier tekens en het
  profiel. Bij vervangen ook het vorige profiel, en of het account wisselde.
  Nooit de key. Soort `mollie_connection`: alleen eigenaren en beheerders lezen
  deze regels (migratie `20261106173000_mollie_koppeling_logboek.sql`).
- **Wisselen van account**: koppel je een key van een ander profiel (of van
  test naar live) terwijl er betaallinks openstaan, dan zegt het scherm dat
  ResoFly die betalingen niet meer kan nakijken, en wat je dan doet. Een nieuwe
  key van hetzelfde profiel (rotatie) geeft geen waarschuwing: die ziet de
  lopende betalingen wel.
- **Oude opslag wordt opnieuw versleuteld** (`_shared/invoiceMollieKey.ts`): één
  plek die de key ophaalt, voor `invoice-workflow`, het klantportaal en de
  publieke factuurpagina. Kon de key alleen met de ingebouwde sleutel worden
  gelezen (alleen mogelijk met `MOLLIE_ALLOW_MOCK`, dus op staging), en staat
  de echte sleutel er nu, dan wordt hij bij het eerste gebruik opnieuw
  versleuteld. Dat gebeurt alleen als de rij nog die oude waarde heeft: een key
  die een beheerder op dat moment vervangt, blijft staan. Niemand hoeft zijn
  key opnieuw in te voeren.
- **Het scherm** (Instellingen → Online betalen): de echte reden bij een fout,
  het profiel, een waarschuwing in testmodus (en bij een live-profiel dat Mollie
  nog niet goedkeurde of blokkeerde), en "Status laden…" in plaats van even
  "Niet gekoppeld".
- **Rooktest** (`scripts/supabase-smoke-test.sh`): na elke deploy staan
  `MOLLIE_TOKEN_ENCRYPTION_KEY` en het secret van de Mollie-webhook er. Alleen
  de namen, via de Management API.
- **Eenmalig inrichten** (`scripts/supabase-setup-webhooks.sh`, vinkje
  `setup_webhooks` in de workflow): zet `MOLLIE_TOKEN_ENCRYPTION_KEY` als hij
  ontbreekt, en vervangt hem nooit. Het script stopt nu als de lijst met
  secrets niet te lezen is; anders zou "ontbreekt" een bestaande sleutel
  vervangen, en zijn alle opgeslagen geheimen onleesbaar.

## Wat jij moet doen

**`MOLLIE_TOKEN_ENCRYPTION_KEY` op staging zetten.** Tot dan kan niemand op
staging Mollie koppelen of een key vervangen. Het scherm zegt dat nu netjes. De
bestaande koppeling blijft werken. De rooktest meldt het als fout. Kies één van
deze:

- GitHub → Actions → *Deploy Supabase (staging)* → *Run workflow*, met het
  vinkje *setup_webhooks* aan. Het script zet alleen wat ontbreekt.
- Of vanaf een laptop:
  `supabase secrets set --project-ref enzghpduqwaojcxgwarr MOLLIE_TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 32)"`

Zet hem één keer en vervang hem nooit: met een nieuwe sleutel zijn de
opgeslagen keys onleesbaar. Daarna wordt de key van de bestaande koppeling bij
het eerstvolgende gebruik (betaallink of webhook) vanzelf opnieuw versleuteld.

Voor productie: zet dit geheim vóór de eerste koppeling, en laat
`MOLLIE_ALLOW_MOCK` uit. Dan telt de ingebouwde sleutel nergens.

## Open punten, met een voorstel

1. **Testsleutels in productie** (open punt 2 van 5 november). Het scherm
   waarschuwt nu, maar een testbetaling zet de factuur nog steeds op betaald.
   Voorstel blijft: testsleutels alleen toestaan waar dat bedoeld is (staging),
   of testbetalingen niet boeken. *Jouw keuze.*
2. **Melding aan de eigenaar.** Het auditlog legt vast wie de koppeling
   wijzigde. Een mail aan de eigenaar(s) bij een ander Mollie-account zou het
   ook meteen zichtbaar maken. Of: koppelen en vervangen alleen voor
   eigenaren.

## Getest

- `npm test`: alle unit-tests groen, met nieuw `mollieSecrets.test.ts` en
  `invoiceMollieKey.test.ts` (versleutelen, oude opslag, de vorm van de key, de
  controle bij Mollie met nep-fetch, opnieuw versleutelen, tenancy, wat er naar
  buiten gaat).
- `npm run typecheck`: schoon.
- `deno check` op de gewijzigde gedeelde bestanden: schoon. `invoice-workflow`,
  `client-portal` en `invoice-public` (niet in de CI-lijst) vóór en na
  vergeleken: geen nieuwe meldingen. Twee oude meldingen in `mollieSecrets.ts`
  zijn weg.
- Stromentest, nieuw scenario `mollie` (`tests/stromen/mollie.mjs`), met de echte
  `invoice-workflow` tegen een lokale database met alle migraties en nep-Mollie:
  14 van 14 stappen. Het scenario doet dit:
  - een key met een regeleinde: niet in het antwoord en niet in het logboek;
  - koppelen zonder versleutelsleutel;
  - koppelen met profiel;
  - het auditlog, en wie het mag lezen;
  - rotatie;
  - een ander account met een open link;
  - ontkoppelen;
  - een oude opslag die opnieuw versleuteld wordt.
- Stromentest `rook`, `facturen`, `herinneringen` en `beveiliging`: 315 stappen.
  Alles groen, behalve 5 stappen in `herinneringen` over de rente van
  aanmaningen. Die falen tussen middernacht en 01:00 Nederlandse tijd: de test
  rekent met de datum in UTC, de server met die in Nederland. Op de code van
  vóór deze wijziging falen precies dezelfde 5. Ze hebben niets met Mollie te
  maken; een aparte reparatie van de test.
- UI-test `mollie` in Chromium (`tests/stromen/ui.mjs`), de echte app tegen de
  echte functie: 8 van 8. Getoetst:
  - een geweigerde key toont de reden, niet "non-2xx";
  - koppelen met profiel en de waarschuwing voor de testmodus;
  - na herladen staat alles er nog;
  - ontkoppelen vraagt eerst om bevestiging;
  - een lid ziet geen formulier.
- `npm run test:mobile -- --theme=both`: 344 pagina's, 0 met problemen, met
  Instellingen → Betalen erbij (telefoon, tablet en liggend, licht en donker).
- `deno check` op `api`, `mcp` en `gerrie-agent` (gebruiken `actions/admin.ts`):
  schoon.
- De migratieketen vanaf nul (`supabase start`, 250 migraties): de rechten op
  `audit_entity_module` zijn daarna gelijk aan die op staging.
