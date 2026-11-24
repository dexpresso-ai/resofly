# Starten uit de cache, en het eerste verzoek eerder — 24 november 2026

Vervolg op [CHANGELOG_OPSTARTEN_NOG_SNELLER_2026-11-22.md](CHANGELOG_OPSTARTEN_NOG_SNELLER_2026-11-22.md).
Daar stonden twee punten open:

- **Starten uit de cache:** de vorige werkruimte meteen tonen en op de
  achtergrond verversen. Eerst moest gekozen worden wat er mag zolang de
  verse gegevens er nog niet zijn, en of klantgegevens op het apparaat mogen
  blijven staan.
- **Het eerste verzoek eerder:** bij een tweede start ging het eerste verzoek
  naar de database pas op ~0,65 s.

Vraag: "Op onderstaande wijzigingen aan de slag. En voer deze uit en deploy
naar staging."

## De keuzes

- **Tot de verse gegevens binnen zijn, kun je alleen kijken.** Opslaan,
  versturen en boeken wachten; meestal is dat binnen een seconde. Een
  verstuurde of geboekte factuur (regel 6) gaat zo nooit uit van oude
  gegevens. Wie toch iets probeert, krijgt "Even geduld: ResoFly haalt de
  nieuwste gegevens op. Daarna kun je wijzigen." Onderin staat zolang de
  melding "Bijwerken…".
- **De gegevens blijven op het apparaat, maar begrensd:**
  - in IndexedDB, per gebruiker en per organisatie;
  - alleen het lidmaatschap, de kern van de werkruimte (zonder het
    briefpapier) en de gegevensgroepen van de pagina die openstond;
  - hooguit 7 dagen oud;
  - uitloggen, hier of elders, wist alles van iedereen op dit apparaat.

  Wie het apparaat deelt en niet uitlogt, laat zijn werkruimte achter. Dat
  gold al voor de sessie zelf (die staat in de browser en geeft toegang tot
  alles); de cache maakt dat niet erger, maar laat de vorige stand wel heel
  even zien voordat een ingetrokken sessie wordt afgewezen.

## Wat er was

Gemeten in Chromium met een nagebootste telefoon (CPU 4× trager, Fast 4G),
met tijdmarkeringen in de app, tweede start (warm), in ms:

| stap | moment |
| --- | --- |
| HTML binnen | 170 |
| bundel binnen | 224 |
| Supabase-code klaar | 362 |
| `main.tsx` klaar, opstartronde begint | 466 |
| sessie bekend | 686 |
| eerste verzoek | 726 |
| kern binnen | ~1.100 |
| dashboard met gegevens | ~1.600–1.800 |

De sessie (220 ms) stond achter de eerste render van React in de rij. React
later laten renderen maakte de sessie sneller bekend, maar het dashboard niet
eerder: de render (~800 ms) schoof dan naar het moment dat de gegevens binnen
waren. Renderen als *transition* won ~60 ms, binnen de ruis. Zolang de
verzoeken in de bundel zitten, kunnen ze niet eerder weg.

## Wat er nu is

### Het eerste verzoek: tijdens het lezen van de HTML (`index.html`, `lib/opstartverzoeken.ts`)

- **Een inline script in `index.html`** leest de sessie van supabase-js en de
  lijst leesverzoeken van de vorige start, en verstuurt die meteen, met
  hetzelfde token. Het draait tijdens het lezen van de HTML, nog voordat de
  bundel binnen is.
  - Alleen GET op `/rest/v1` van de eigen Supabase. Het adres en de publieke
    sleutel komen uit meta-tags, zodat de CSP-hash in elke omgeving gelijk is.
  - Alleen met een token dat nog minstens twee minuten geldig is; anders
    ververst supabase-js eerst het token en past er niets.
  - Alleen in de werkruimte (`/` en `/app/…`), niet op publieke pagina's, in
    het portaal of op een klantadres.
  - De hash staat in beide CSP-regels van `public/_headers`;
    `scripts/check-csp-hash.mjs` controleert alle inline scripts.
- **De app neemt een antwoord alleen over bij precies hetzelfde verzoek**
  (`supabaseFetch`, de fetch van de Supabase-client): hetzelfde adres, Accept,
  Prefer en token, en één keer. Al het andere gaat naar de server. Wat de app
  opvraagt en wat hij ermee doet, verandert niet; de RLS beslist zoals altijd.
- **De lijst:** de GET's die de app bij de start deed, 3 s na de eerste
  geslaagde ronde bewaard in `localStorage`, per gebruiker.
  - Zonder de gegevensgroepen (`GROUP_TABLES`, nu in `dataGroups.ts`): welke
    nodig zijn, hangt af van de pagina waarop de app opent. Anders haalde een
    start op het dashboard de banktransacties van gisteren op.
  - Zonder adressen met een datum: die zijn de volgende keer anders.
  - Uitloggen wist alle lijsten.

### Starten uit de cache (`lib/workspaceCache.ts`, `main.tsx`)

- **`BOOT_ROUND` leest de cache tegelijk met de sessie.** Is hij er eerder dan
  de verse ronde, dan zet `applyCachedWorkspace` hem neer: de organisatie,
  het lidmaatschap, de kern, de groepen van de pagina, en de tabbladen.
- **Daarna gaat de ronde verder als een ververs van dezelfde organisatie.**
  De kern komt vers binnen en vervangt alles; de groepen van de open pagina
  ook, met wat al vooruit liep. Pas dan kun je weer wijzigen.
- **De cache vervalt** als het lidmaatschap een andere organisatie kiest, of
  als rol, status, modules of het boeken door de boekhouder anders zijn dan
  in de cache (regel 1 en 3). Dan laadt de werkruimte zoals bij een eerste
  start: laadscherm, alles vers, de tabbladen opnieuw.
- **Bewaren:** 2 s na de eerste verse ronde, en bij het verlaten van de app
  (`visibilitychange`). Nooit vanuit de cache zelf.
- **`WORKSPACE_CACHE_VERSIE`:** verhoog die als een veld van AppData of
  OrganizationContext van type verandert. Een nieuw veld hoeft niet: wat
  ontbreekt, vult de app aan met de lege waarde.

## Gemeten

MEETUITSLAG

## Getest

TESTUITSLAG

## Nog open

- **Het dashboard renderen kost op een telefoon ~0,8 s** (1.700 elementen,
  ProjectTimeline, gedwongen layouts in de kaarten). Met de cache staat het
  dashboard er nu vóór de database antwoordt; dat stuk render blijft.
- **De kern kleiner** en **de bewerkvensters los** (zie 22 november) staan nog
  open.
