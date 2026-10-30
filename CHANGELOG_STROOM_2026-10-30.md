# Changelog — Stroom in de app, achter "Probeer Stroom" — 2026-10-30

Het designvoorstel van vandaag (`DESIGN_VOORSTEL_STROOM_2026-10-30.md`, met het werkende
prototype in `docs/design-voorstel-stroom/`) staat nu in de werkruimte zelf. Net als Zenit
eerst achter een schakelaar: wie niets doet, ziet niets veranderen. Wie op **Probeer
Stroom** klikt, krijgt de nieuwe voorkant, per gebruiker en per browser. Zenit blijft
kiesbaar tot Stroom de standaard is.

- **Aanzetten.** In de huidige look staat **Probeer Stroom** in het accountmenu. In Zenit
  en Stroom staat de keuze in de rail: **Weergave → Look**, met Zenit, Stroom en Uit.
- **Terug.** **Weergave → Look → Uit** geeft de vertrouwde look terug.

## Wat je ziet met Stroom aan

**Het licht onder het glas.** Onder de hele werkruimte ligt een lichtveld:
- de zon staat links als gloed, op zijn echte stand boven Nederland;
- het poollicht van Gerrie komt van rechts;
- bij een klant (of een project van een klant) kleurt het rechtsboven in de kleur van die
  klant;
- geef je akkoord, dan gaat er een rimpel van goud door het veld.

**Het glas.** De rail, het contextpaneel, het eiland, de panelen en de dock zijn glas dat
het thema volgt, ook in Dag. Het werkvlak van een gewone pagina is bijna dicht glas, dus
tabellen en formulieren lezen als altijd.

**Het eiland.** Bovenin, in plaats van de tabrij. Openen met <kbd>Ctrl</kbd>/<kbd>⌘</kbd>
<kbd>K</kbd> of <kbd>/</kbd>.
- **Zoeken en springen.** Hetzelfde zoeken als de zoekbalk: klanten (ook op hun vrije
  velden), projecten, taken, tickets, notities, documenten, offertes, facturen en
  leveranciers. Enter springt erheen.
- **Vragen.** Gerrie staat erbij. Klinkt het als een vraag of vindt het eiland niets, dan
  staat Gerrie voorgeselecteerd; <kbd>Tab</kbd> vraagt het hem altijd.
- **Maken.** Begin met *factuur*, *offerte*, *taak*, *afspraak* of *uren*.
  - *factuur bloem content oktober 650* wordt een factuur voor Restaurant Bloem, met één
    regel *Content oktober* van € 650 excl. btw. Je ziet de stukken als chips.
  - Enter opent het gewone formulier, vooringevuld. Er wordt niets opgeslagen of
    verstuurd tot jij dat daar doet.
  - Een taak komt bij het project van die klant als hij er één heeft, met de dag erbij.
  - Een afspraak en uren gaan naar Gerrie, die ze klaarzet met de agenda en de projecten
    erbij.
- **Je werktabs.** Die wonen nu in het eiland: open je het leeg, dan staan je open
  tabbladen bovenaan, met *Nieuw tabblad* en een kruisje om te sluiten.
  <kbd>Ctrl</kbd>+<kbd>Tab</kbd> wisselt naar het volgende tabblad (met <kbd>Shift</kbd> het
  vorige). Een gewone browser houdt die toets meestal zelf; in het geïnstalleerde venster
  werkt hij wel.
- **Meldingen en de timer.** Een melding morpht het eiland tot een regel. Loopt er een
  timer, dan staat de klok rechts in het eiland; een klik opent de urenregistratie.

**Vandaag.** De groet staat los op het licht, met een **Nu**-kaart ernaast: wat er nu loopt,
met een balk die meeloopt, of wat er straks komt. Daaronder:
- **De stroom.** Van offerte tot betaald als één lichtband, met vijf haltes:
  - *Gesprek*: offertes in de maak;
  - *Offerte*: bij de klant;
  - *Werk*: akkoord maar nog niet gefactureerd, en conceptfacturen;
  - *Factuur*: open;
  - *Betaald*: deze maand.

  De dikte van de band is het bedrag. Elke offerte of factuur is een kraal in de kleur van
  de klant. Een knoop vraagt aandacht: oranje als een offerte al een week bij de klant ligt,
  rood als een factuur te laat is of een offerte verlopen, groen als er net een herinnering
  uitging. Een kraal met een orbje heeft een kaart op de stapel. Een klik op een kraal opent
  de offerte of factuur, een klik op een halte de lijst.
- **De stapel.** De beslislijst van Gerrie, één kaart tegelijk:
  - <kbd>A</kbd> is akkoord, <kbd>L</kbd> is later (morgen; de knop geeft ook *vanmiddag* en
    *volgende week*) en <kbd>N</kbd> is niet nu;
  - slepen kan ook: naar rechts is akkoord, naar links is later;
  - **akkoord wacht even**: een mail gaat pas na tien seconden de deur uit, de rest na zes.
    Zolang staat in het eiland "gaat over 10 s de deur uit" met **Terughalen** en **Nu**;
  - terughalen legt de kaart terug en er is niets gebeurd. Sluit je het venster binnen die
    tijd, dan gebeurt er ook niets: de kaart staat er de volgende keer gewoon weer.
- **Je dag** staat naast de stapel: afspraken en ingeplande taken in de volgorde van de
  klok, met een gouden lijn op nu en de taken om af te vinken.
- **Wacht op je** toont wat de stroom niet laat zien (bank, tickets, btw, taken over de
  deadline). De week, de projecten en de cijfers staan, net als in Zenit, achter **Meer van
  vandaag**.

**Klant 360.** Bovenaan de klantpagina staat **In de stroom**: de stroomlijn (vijf punten,
waar de klant staat) en per halte zijn offertes en facturen, klikbaar. Op de telefoon staat
de stroomlijn klein in de kop, zodat de tabbladen hoog blijven.

**Telefoon.** Bovenin het eiland (*Vraag of zoek…*), dat openklapt tot een vel. Onderin een
glazen dock met Vandaag, Werk, Agenda en Geld, en het orbje van Gerrie in het midden. Op
Vandaag eerst de groet, dan de stroom, dan pas Nu.

**Inloggen.** Met Stroom aan ligt het licht ook achter het inlogscherm. De kaart is glas en
het verhaal links volgt het thema.

## Wat (nog) niet

Uit het voorstel nog niet gebouwd:
- Geld met de geldstroom en het papier (*Gerrie bouwt mee*);
- *Plan met Gerrie* in de agenda;
- de beslismodus van Gerrie;
- de kralen die zichtbaar verhuizen als er een betaling binnenkomt;
- de glans die de cursor volgt.

Die komen module voor module, zoals stap 4 van het voorstel beschrijft. De overige modules
houden de opbouw van Zenit, met het glas en de kleuren van Stroom.

## Onder de motorkap

- `src/lib/look.ts` kent de look `'stroom'`. Stroom bouwt op Zenit: op `<html>` staat
  `data-look="zenit"` én `data-stroom`. Elke regel van `zenit.css` geldt daardoor vanzelf,
  en `src/styles/stroom.css` (nieuw, ná `zenit.css`) legt er het licht en het glas
  overheen. `isZenitFamily()` vervangt de losse `look === 'zenit'`-checks (dashboard,
  filterbalk, planningstimeline, navigatie).
- `index.html`: het opstartscript zet `data-stroom` en de grondkleur van Stroom
  (`#07070A` / `#ECEAE4`) vóór de eerste verf. De CSP-hash staat in beide regels van
  `public/_headers` (`node scripts/check-csp-hash.mjs`).
- `src/lib/theme.ts`: de adresbalkkleur per look, ook voor Stroom.
- `src/lib/stroom.ts` (nieuw, puur) rekent de stroom, de stroomlijn van een klant en het
  ontleden van een opdracht. Dezelfde statussen en dezelfde bruto-totalen als Vandaag:
  *Factuur* in de stroom is *Openstaand*, *Betaald* is *Omzet deze maand*.
  `src/lib/stroom.test.ts` bewaakt dat, en het ontleden (13 tests).
- `src/lib/stroomBus.ts` (nieuw): meldingen met tijd om terug te halen (`deferred`,
  `undo`, `commitNow`) en de opdrachten aan het licht (`rippleLight`, `tintLight`). Buiten
  React-state, zodat een klok doorloopt als je van pagina wisselt.
- `src/components/LightField.tsx` (nieuw): de shader uit het prototype.
  - Getekend op een derde van de resolutie, met hooguit 30 beelden per seconde.
  - Stil in een verborgen tabblad.
  - CSS-terugval bij minder beweging, databesparing, een bijna lege batterij (waar de
    browser die laat zien) of zonder WebGL.
- `src/components/StroomIsland.tsx` (nieuw) — het eiland. `GlobalSearch.tsx` deelt zijn
  zoekfunctie (`searchWorkspace`), zodat zoekbalk en eiland precies hetzelfde vinden.
- `src/components/StreamRibbon.tsx` (nieuw): de stroom.
  - Het canvas tekent alleen licht.
  - De haltes en kralen zijn knoppen, met tekst voor de schermlezer.
  - In dit bestand staan ook de stroomlijn en Klant 360.
- `src/features/StroomToday.tsx` (nieuw): de groet, Nu, het stroompaneel en Wacht op je.
- `src/components/DecisionFeed.tsx` krijgt `variant="deck"`. Akkoord, later en niet nu
  lopen langs dezelfde schrijfwegen als de lijst.
  - Een lijst van één (de opvolgmail aan één klant) is één besluit en kan op de stapel.
  - Een lijst van meer vink je per regel af in de beslislijst.
- `src/components/BottomNav.tsx`: de dock, met het orbje.
- `main.tsx`:
  - het lichtveld en het eiland;
  - `data-page` op elk werkvlak, zodat Vandaag open kan;
  - `createFromIntent` voor het maken vanuit het eiland;
  - het klantlicht;
  - het licht achter het inloggen.
- In Stroom volgen het nummer en de bedragen bovenin het factuur- en offerteformulier de
  inkt van het thema. Ze stonden vast in wit en vielen in Dag weg. In Cockpit en Zenit is
  dat nog zo.
- `tests/mobile/run.mjs` kent `--look=stroom`. Op Vandaag is de stroom het eerste item:
  gemeten 152px op de telefoon in Dag en Nacht, de grens ligt op 185px.

## Controle

- `npm run typecheck`, `npm test` (826 tests) en `node scripts/check-csp-hash.mjs`: groen.
- `npm run build`: gebouwd.
- `npm run test:mobile -- --theme=both`: voor Cockpit, Zenit en Stroom, zie hieronder.
- Contrast in de echte app, op Vandaag, met het WebGL-licht, in Dag en Nacht, op desktop en
  telefoon. Werkwijze: alle tekst verborgen, en per tekstvak het slechtste contrast tegen
  de echte pixels eronder.
  - 172 metingen, alle AA. Gewone tekst minstens 5,0:1.
  - De gouden naam in de groet (grote tekst, eis 3:1), gemeten met zijn donkerste kleur:
    4,9:1 in Dag en 5,4:1 in Nacht.
  - Twee punten zijn onderweg rechtgezet. Het actieve icoon in de dock was vlak goud uit
    Cockpit (1,5:1 in Dag) en is nu goud-als-tekst. *in oktober* onder Betaald (4,36:1 op
    de gouden poel in Nacht) is een tint lichter.
- Een functionele ronde in Chromium tegen de nagebootste backend: 35 controles, allemaal
  groen, in Nacht met minder beweging (CSS-licht) en in Dag met beweging (WebGL-licht).
  Gecontroleerd:
  - het lichtveld (WebGL, en de CSS-terugval bij minder beweging);
  - *Factuur* in de stroom gelijk aan Openstaand;
  - de vonk op de kraal met een kaart, en de tooltip;
  - de stapel: <kbd>A</kbd> met "gaat over 10 s de deur uit", terughalen zonder dat er iets
    naar de server ging, en <kbd>L</kbd> naar morgen;
  - het eiland: <kbd>Ctrl</kbd> <kbd>K</kbd> en <kbd>/</kbd>, zoeken en springen naar een
    klant;
  - het klantlicht;
  - *factuur bloem content oktober 650* tot een vooringevuld formulier (€ 786,50);
  - *taak bel van dijk over de offerte morgen* tot een taak bij het project van Van Dijk,
    voor morgen;
  - <kbd>Ctrl</kbd>+<kbd>Tab</kbd>;
  - de look wisselen naar Zenit en terug;
  - op de telefoon: het eiland als vel, en het orbje in de dock dat Gerrie opent;
  - geen JavaScript-fouten.
