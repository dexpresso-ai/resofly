# Mobiel en tablet: compact, met de ruimte voor het werk (2026-09-13)

## Wat de PO vroeg

> Ik wil een goede en uitgebreide user experience voor de smartphone en tablets.
> Loop het design van alle functies door. Maak de app compact, met veel behoud
> van ruimte voor de echte functionaliteit, minder voor instellingen of menu's.

## Hoe het gemeten is

Elke pagina is met een nagebootste backend geopend in Chromium op drie maten:
telefoon (390×844), staande tablet (820×1180) en liggende tablet (1180×820).
Per pagina is gemeten hoeveel pixels de vaste chrome kost en op welke hoogte
het eerste échte item (klant, project, taak, factuur) begint.

| Telefoon, 390×844                 | Vóór   | Na     |
| --------------------------------- | ------ | ------ |
| Vaste chrome (titel + tabs + onderbalk) | 163 px | 100 px |
| Dashboard: eerste taak van vandaag | ±510 px | ±200 px |
| Klanten: eerste klantkaart        | ±680 px | ±250 px |
| Projecten: eerste project         | ±620 px | ±310 px |
| Tickets: eerste ticket            | ±770 px | ±260 px |
| Weekplanner: het rooster          | ±750 px | ±560 px |
| Uren: eerste cijfers              | ±570 px | ±300 px |
| Klantdossier: de tabbladen        | ±800 px | ±430 px |

Op de staande tablet begon het dashboard op ±550 px en de klantenlijst op
±560 px; dat is nu ±270 en ±320 px.

## Wat er veranderd is

### De shell op de telefoon

- **Geen titelbalk meer.** Het actieve werktabblad draagt de naam van de pagina
  al; de titelbalk herhaalde die eronder nog een keer, met "Ververs" ernaast.
  De tabbalk is nu de enige bovenrij, met de hamburger links.
- **Ververs en "alleen lezen" zitten in het uitschuifmenu** — naast het
  sluitkruisje, en als regel onder de organisatiekeuze.
- **De teamchat-knop staat in de bovenrij** in plaats van als tweede zwevende
  knop rechtsonder. Alleen Gerrie zweeft nog (kleiner), met de agenda-"+"
  erboven waar die hoort. De laatste kaart van elke lijst lag daardoor niet
  meer onder twee knoppen.
- **Onderbalk 54 px** in plaats van 58, iets grotere labels. Inhoud met 12 px
  marge in plaats van 16: elke kaart wint 8 px breedte.
- Zolang Gerrie of de teamchat schermvullend openstaat, verdwijnt de
  hamburger — die lag over de kop van het paneel.

### Het zoek-/filterblok (klanten, projecten, tickets, offertes, facturen, campagnes, weekplanner)

Was op de telefoon een kaart van ±330 px: label "Snel zoeken", zoekveld, een
telkaart "6 van 6 klanten zichtbaar" van 44 px hoog, chips, een knop "Meer
filters" en een regel "N filters actief". Nu één rij: zoekveld met het
vergrootglas erin en een filterknop (icoon met teller). Chips als veegrij.
De telkaart is weg — zolang je niets filtert zegt "6 van 6" niets; zodra je
wél filtert staat het aantal in de wisregel ("15 van 16 taken · 2 filters
actief · Filters wissen"). Dit geldt tot en met de staande tablet.

### Per pagina

- **Dashboard:** zes cijferkaarten in drie kolommen (was 2×3 kaarten van
  230 px, samen 750 px). Chips van een taak staan rechts onder elkaar zodat de
  titel zijn ruimte houdt. Scope-schakelaar in de kop van "Vandaag".
- **Klanten:** weergave, importeren (als icoon) en "+ Nieuwe klant" op één rij;
  de tabstrook "Klanten / Niet gekoppeld" verschijnt alleen als de opvangbak
  iets bevat. Het klantoverzicht stond hard op twee kolommen en liep op elk
  smal scherm 240 px buiten beeld — nu één kolom, met projecten en geld vóór
  de contactgegevens.
- **Tickets:** de vijf statuskaarten (470 px) zijn vijf pillen op één veegrij;
  weergave en "+ Nieuw ticket" delen een rij; de twee knoppen op een kaart
  staan naast elkaar.
- **Projecten:** de knoppen in de kop als veegrij naast het zoekveld.
- **Projectpagina:** kleinere kop, cijfers in drie kolommen met de voortgang
  als één rij; het kanban toont één kolom per veeg (was twee kolommen van
  175 px).
- **Klantdossier:** terugknop als tekst, avatar naast de naam, acties als
  veegrij, cijfers in drie kolommen.
- **Weekplanner:** "Compact/Ruim" verdwijnt op de telefoon (één kolom heeft
  geen dichtheid), de minder belangrijke weekcijfers ook; het meeneem-paneel
  gaat van vijf naar vier regels.
- **Agenda:** datum en bladerknoppen op één rij, weergavetabs eronder zonder
  iconen.
- **Uren:** periodeknoppen op één rij, de timerkaart van 600 px naar twee
  rijen, cijfers in drie kolommen.
- **Projectplanning:** de kop met uitleg weg (het tabblad zegt waar je bent),
  vier cijfers op één rij, zoeken en klant naast elkaar.
- **Statistieken:** de rapportnaam liep over de CSV-knop heen en "Mijn
  rapportages" over de sjabloonkeuze (invoervelden krimpen niet onder hun
  eigen breedte). Nu onder elkaar; de instellingen twee per rij.
- **Instellingen:** de lege kopkaart (tekst verborgen, rand bleef) is weg.
- **Gerrie:** de uitlegalinea onder "Je agents" weg, tabs breken niet meer af.

### Tablet (761–1024 px)

- Titelbalk 52 px op één regel (was 72 px met kopregel "ResoFly workspace").
- De paginakoppen die de titelbalk herhalen zijn ook hier weg.
- Cijferrasters in drie kolommen; kleinere kaarten.
- Het zoekblok in dezelfde compacte vorm als op de telefoon.
- De vastzetknop van de zijbalk is altijd zichtbaar: een tablet kent geen
  "hover", dus de labels waren anders niet te bereiken.

## Tweede ronde: wat de klant ziet, en de vensters

De eerste ronde ging over de werkruimte. Daarna zijn ook de pagina's die een
**klant** op zijn telefoon opent nagelopen, plus de bewerkvensters en de
subtabbladen van klant en project.

- **Publieke offerte, factuur en contract:** kop van 380 naar 150 px (titel
  25 px, kaartrand 16 px, paginamarge 12 px); de regels van een offerte staan
  nu op ±490 px in plaats van 1.250 px. De titel liep bij een lang woord uit
  de kaart en de intro brak buiten beeld af (de eerste kolom nam de breedte
  van het langste woord): opgelost met `min-width:0` en `overflow-wrap`.
- **Boekingslink:** twee tijden naast elkaar met een korte dagnaam
  ("ma 14 sep"); op het bureaublad blijft de volle naam staan.
- **Klantportaal:** kop op één rij, tabbladen als veegrij in plaats van drie
  rijen, cijfers twee naast elkaar en kleiner, elke factuur- of offerteregel
  op twee lijnen (nummer + datum, dan bedrag + status). Eerste factuur van
  ±500 naar ±300 px.
- **Galerij:** de drie knoppen (diavoorstelling, volledig scherm, menu)
  lagen over de gecentreerde titel; op de telefoon staan ze als rij erboven.
- **Bewerkvensters:** de titel stond er als "Nieuw invoice" en "Bewerk task"
  (de interne sleutel); nu "Nieuwe factuur", "Taak bewerken", enzovoort. De
  kop van het factuur-/offertevenster (nummer op 40 px, uitleg, drie
  totaalkaarten onder elkaar: 500 px) is één regel met de drie totalen
  ernaast; de kop van het klantvenster van 430 naar 130 px.
- **Regressietest:** de publieke pagina's, het portaal en beide inlogpagina's
  zitten nu ook in `npm run test:mobile` (met een nagebootste media-worker
  voor de galerijfoto's).

## Bestanden

- `src/styles/globals.css` — nieuw blok "MOBIEL & TABLET · COMPACT" achteraan.
- `src/main.tsx`, `src/components/Sidebar.tsx` — ververs en alleen-lezen in de
  drawer.
- `src/components/SearchFilterPanel.tsx` — label van de filterknop en het
  aantal in de wisregel als eigen elementen, zodat de CSS ze kan tonen of
  verbergen.
- `src/features/Clients.tsx` — importknop met verbergbaar label; tabstrook
  `is-idle` bij een lege opvangbak.
- `src/features/WeekPlanner.tsx` — `wp-meta-minor` op de weekcijfers die op de
  telefoon wegvallen.
- `src/features/PublicBookingPage.tsx` — klassen op de tijdknoppen en een
  korte dagnaam voor de telefoon.
- `src/main.tsx` — Nederlandse titels van de bewerkvensters.
- `tests/mobile/` — de regressietest, met `mock/publicdata.mjs` voor de
  publieke pagina's.

## Controle

- `npm run typecheck`, `npm test` en `npm run build` slagen.
- Alle 27 pagina's zijn op telefoon- en tabletformaat opnieuw geschoten; geen
  enkele pagina scrolt nog horizontaal (het klantoverzicht deed dat wel).
- De taakbewerker, het Gerrie-paneel, de teamchat, het projectkanban en de
  tabelweergave van klanten zijn op de telefoon nagelopen.
- **Licht thema:** dezelfde pagina's nog eens in het lichte thema geschoten
  (telefoon en tablet). Alle nieuwe vlakken lopen via de kleurtokens en
  houden hun contrast; niets hoefde aangepast.
- **Desktop-regressie:** de oude code (`f801a78`) en de nieuwe zijn naast
  elkaar gedraaid en per pixel vergeleken op 1440×900 en 1180×800, alle 27
  pagina's. Op 1440 zijn ze tot op de pixel gelijk; op 1180 wijkt alleen de
  agenda af, met 343 pixels van de "nu"-lijn die tussen de twee opnamen een
  minuut verder stond. Boven de 1024 px verandert er dus niets.
- **Toegankelijkheid:** de filterknop is op telefoon en tablet alleen een
  icoon; hij heeft nu een `aria-label`, want tekst op `display:none` telt
  voor een schermlezer niet mee.

## Vaste regressietest: `npm run test:mobile`

Het meethárnas van deze ronde staat nu in de repo (`tests/mobile/`), met
Playwright en een nagebootste backend (`tests/mobile/mock/`). De test opent
elke pagina op telefoon- en tabletformaat en faalt op een JavaScript-fout,
horizontale overloop, chrome boven 112 px (telefoon) of 100 px (tablet), en
op een eerste item dat lager begint dan de grens in `FIRST_ITEM` (zo'n 20%
boven de meting van vandaag). `--theme=both` draait hem ook in het lichte
thema; `--shots=<map>` schrijft screenshots weg.

De nieuwe workflow `.github/workflows/frontend-checks.yml` draait typecheck,
unit tests en deze lay-outtest (beide thema's) op elke pull request en op
staging. Eenmalig lokaal: `npx playwright install chromium`.
