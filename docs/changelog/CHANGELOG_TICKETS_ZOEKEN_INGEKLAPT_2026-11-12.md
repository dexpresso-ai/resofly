# Changelog: tickets openen op Actief, zoeken en filteren ingeklapt (2026-11-12)

## Aanleiding

Onder de werkbalk van de ticketpagina stond altijd een zoekkaart: een groot
zoekveld met telkaart, zeven filterchips en vier keuzelijsten. Op een breed
scherm kostte die ruim 200px, en het eerste ticket stond pas halverwege het
scherm (501px van de 900). Meestal zoek je niet, maar werk je de lijst af.

Daarbij opende de pagina op de hele werklijst, met geweigerde en omgezette
tickets tussen het werk. Gevraagd: de zoekfunctie niet steeds in beeld, iets
slimmers ervoor in de plaats, en bij het openen alleen de actieve tickets.

## Wat er nu kan

### Actief, Alle, Archief

- Naast Lijst/Tabel staat een keuze **Actief · Alle · Archief**, elk met een
  teller. De pagina opent altijd op **Actief**: nieuw, review en goedgekeurd.
  Dat wordt niet onthouden: wie de pagina opent, wil eerst zien wat er ligt.
- **Alle** toont alles, ook geweigerd, omgezet en afgehandeld. **Archief** is
  het archief van 5 november, nu als derde keuze in plaats van een losse knop.
- Een statuskaart bovenaan die niet in je lijst past, neemt je mee. Klik je in
  Actief op *Geweigerd*, dan ga je naar Alle met het filter *Status:
  Geweigerd* aan.
- De chip *Openstaand* en de statuskeuze *Openstaand* zijn weg. Dat is nu de
  lijst Actief.
- In Actief biedt de statuskeuze alleen nieuw, review en goedgekeurd aan. In
  Alle staan alle zes statussen, ook *Afgehandeld*.

### Zoeken

- **Zoeken** is een knop in de werkbalk. Een klik maakt er een zoekveld van,
  met de cursor erin. Staat er een zoekterm, dan blijft het veld open. Leeg en
  weggeklikt klapt het dicht. Escape wist de zoekterm en zet de cursor terug
  op de knop.
- Je vindt niets in Actief of het archief? Dan staat er naast *Filters wissen*
  ook **Zoek in alle tickets**. Wat je zoekt, is vaak al afgehandeld of
  geweigerd.

### Filteren

- **Filteren** klapt een paneel open met de snelfilters (Aan mij, Niet
  toegewezen, Ongelezen, Hoge prioriteit, Om te zetten, Zonder klant) en de
  keuzelijsten (Status, Prioriteit, Klant, Toegewezen aan). Onderaan staat
  hoeveel tickets er overblijven. *Klaar* klapt het paneel dicht.
- Staat er een filter aan, dan zegt de knop hoeveel. Onder de werkbalk staat
  één regel met "x van y actieve tickets", elk filter als chip met een kruisje,
  en *Filters wissen*. Dicht is dus niet vergeten.

### Telefoon

- Rij 1: Lijst/Tabel, het vergrootglas, het filtericoon en *Nieuw ticket*.
  Rij 2: Actief · Alle · Archief over de hele breedte. Een open zoekveld
  krijgt een eigen rij eronder, in 16px, zodat iOS niet inzoomt.
- Gemeten, eerste ticket vanaf de bovenkant:

  | Scherm | Was | Nu |
  | --- | --- | --- |
  | Telefoon, lijst | 275px | 226px |
  | Telefoon, tabel | 311px | 262px |
  | Telefoon, archief | 355px | 306px |
  | Desktop (1440×900), lijst | 501px | 283px |
  | Desktop, archief | 554px | 336px |

## Waar het zit

- `src/lib/tickets.ts`: `TicketListScope` (`active`, `all`, `archive`),
  `ticketInListScope` en `ticketStatusesInListScope`. Het klantdossier houdt
  zijn werklijst (`ticketInScope`), daar is niets veranderd.
- `src/features/Tickets.tsx`:
  - `TicketScopeSwitch`, `TicketSearch`, `TicketFilterPanel` en
    `TicketFilterSummary`;
  - `useTicketFilterModel` bouwt de chips en keuzelijsten voor het paneel en
    voor de regel eronder.

  Het gedeelde `SearchFilterPanel` gebruikt de ticketpagina niet meer. De
  andere pagina's houden het.
- `src/styles/globals.css`: het blok *Tickets: de werkbalk* en de regels voor
  de telefoon (≤760px).

## Getest

- `npm run typecheck` en `npm test` (1724 tests). Nieuw: een test voor Actief,
  Alle en Archief, en voor de statussen die elke lijst aanbiedt.
- `npm run test:mobile -- --theme=both` voor de ticketpagina's op telefoon,
  tablet, liggend en desktop: geen fouten. Gemeten in Baken, en apart in
  Zenit, Cockpit en Stroom.
  - Twee nieuwe metingen: `tickets-search` (zoekveld open) en
    `tickets-filters` (paneel open).
  - De grenzen voor het eerste ticket zijn omlaag naar de nieuwe maat plus
    20%. Zo komt de vaste kaart niet ongemerkt terug.
- `npm run test:loading`: geslaagd.
- In de browser tegen de nagebootste backend:
  - de pagina opent op Actief met 4 van de 7 tickets;
  - *Geweigerd* gaat naar Alle met de chip;
  - zoeken in Actief op een afgehandeld ticket, en dan *Zoek in alle
    tickets*;
  - Escape en wegklikken klappen het zoekveld dicht;
  - het paneel, de teller op de knop en *Filters wissen* werken;
  - geen JavaScript-fouten.
- De UI-stroom in `tests/stromen/ui.mjs` (tickets) is niet gedraaid. Die heeft
  een volledige Supabase nodig. Hij zoekt de archiefknop op
  `aria-label^="Archief"` en `.ticket-archive-back`; die zijn er nog.
