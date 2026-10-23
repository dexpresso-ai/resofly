# Changelog — Onbewolkt: Zenit zonder ruis — 2026-10-23

Zenit gaf de werkruimte een zon; Onbewolkt haalt de wolken weg. Het dashboard, de
planningstimeline en de zoek- en filterblokken boven de lijsten waren druk: veel filters,
veel cijfers, en hetzelfde feit op twee of drie plekken. Dit is een rustiger opbouw van
diezelfde schermen, met dezelfde gegevens en dezelfde rechten.

Alles hieronder geldt alleen met Zenit aan (accountmenu → **Probeer Zenit**). Wie Cockpit
houdt, ziet niets veranderen.

## Vijf regels

1. **Eén keer zeggen.** Elk feit staat één keer op het scherm. Een te late factuur staat in
   Aandacht, niet ook in de kopzin, een cijfertegel en een strook.
2. **Eerst de zin, dan de cijfers.** Een zin zegt wat er speelt ("5 projecten in beeld ·
   drukste week: W43"); de cijfers staan erachter voor wie ze zoekt.
3. **Filters slapen tot je ze wekt.** Zoeken en de snelkeuzes staan klaar; de rest zit achter
   **Verfijnen**. Wat aanstaat, blijft zichtbaar als chip met een kruisje.
4. **Dichtbij scherp, veraf zacht.** Vandaag in detail; de week, de projecten en de cijfers
   zacht, achter één balk.
5. **Vandaag eerst.** Je dag en wat op je wacht staan op een scherm van 1440 × 900 boven de
   vouw.

## Wat je ziet

### Vandaag

- **De Dagboog** zonder de baan eronder: de afspraken staan al op de boog en in Je dag. De
  strook met Nu en Volgende verschijnt alleen als je de zon versleept of de dag afspeelt.
  Wijs een stuk boog aan voor de tijd en de titel.
- **De kopzin** noemt alleen afspraken en taken; te late facturen staan in Aandacht.
- **Je dag**: afspraken en taken van vandaag op volgorde van de klok, met een gouden lijn op
  nu. Wat is blijven liggen staat erboven, wat nog geen tijd heeft eronder ("Ergens
  vandaag"). Een afspraak met een videolink heeft **Deelnemen**; Mijn en Team blijven.
- **Aandacht**: wat op je wacht, één regel per soort: te late facturen, offertes die open
  staan bij klanten, onbehandelde tickets en taken over hun deadline. Is er niets, dan staat
  er "Niets dat op je wacht".
- **Meer van vandaag**: één balk onder de dag. Dicht fluistert hij de omzet van de maand,
  het openstaande bedrag en het aantal acties deze week. Open toont hij:
  - **Deze week**: zeven dagen met het aantal open acties en de kleuren van de projecten;
  - **Projecten**: per lopend project de voortgang tegen de verstreken tijd, met *achter*,
    *te laat*, *start over n dagen* of *nog n dagen*;
  - de **Puls** (de kerncijfers), de rapportages en de laatste activiteit.

  Open of dicht wordt onthouden.
- De pagina is 954px hoog in plaats van 2.828px (1440 × 900, de demo-werkruimte).

### Planningstimeline

- **Eén zin** in plaats van vier cijfertegels: "5 projecten in beeld · drukste week: W43 met
  5 tegelijk · 14 open taken", met het aantal te late projecten in rood als dat er is.
- **Eén werkbalk**: drie lenzen met hun aantal (**Lopend**, **Te laat**, **Alles**), zoeken,
  **Verfijnen**, Week/Maand/Kwartaal en Vandaag. De rij met vijf fasechips is weg.
- **Verfijnen** opent klant, fases en archief in een zachte la. Dicht blijft een eigen keuze
  staan als chip ("Klant: …", "Eigen keuze: Bezig, Review, Te laat"); het kruisje zet je
  terug op Lopend.
- In de balken staan alleen de data; de naam staat al in de kolom ernaast. De bezetting is
  een zachte hoogtekaart; het aantal staat in de tooltip.
- De titel staat niet meer tegen de rand van de kaart.

### Zoeken en filteren boven de lijsten

Klanten, tickets, projecten, offertes, facturen, campagnes en de weekplanner delen één
zoekblok. Onder Zenit is dat geen kaart meer maar één regel boven de tabel:

- **Zoeken**, met een korte tekst in het veld ("Zoek in facturen"). Waarop je kunt zoeken,
  staat in de tooltip.
- **De snelkeuzes** (Openstaand, Over de datum, …). Een snelkeuze die niets zou tonen, staat
  er niet zolang hij uit staat.
- **Verfijnen**: de velden (klant, project, status, datums, bedragen) slapen tot je erop
  drukt. Open staan ze in een zachte la, met hun naam erboven, ook in de weekplanner.
- **Chips**: wat in Verfijnen aanstaat, staat in dezelfde regel als chip met een kruisje
  ("Klant: Bakkerij De Korenaar ×"). Verfijnen toont hoeveel.
- **De telling** verschijnt pas als je filtert ("1 van 6 facturen"), met **Filters wissen**
  ernaast. Bij offertes en facturen staat het totaalbedrag er altijd. Een schermlezer hoort
  de telling ook als hij uit beeld is.
- In de weekplanner tellen de standaardwaarden (Open taken, Alle prioriteiten) niet meer als
  filter.
- Het blok boven facturen is 36px hoog in plaats van 353px; bij klanten en tickets 36px in
  plaats van 207px.
- Op de telefoon staan zoeken en de filterknop op één regel en de snelkeuzes als veegrij
  eronder.

## Gevonden onderweg

- **De weekplanner verstopte zijn zoekregel.** Op een scherm van 900px hoog kneep de pagina
  het zoek- en filterblok samen tot 106px. Daardoor viel de regel met zoeken en de vier
  filters weg, ook in Cockpit. Onder Zenit staat die regel er weer. Cockpit is hier niet
  aangepast.

## Onder de motorkap

- `src/features/DashboardCalm.tsx` (nieuw) — Je dag (`DayAgenda`), Aandacht
  (`AttentionList`), Meer van vandaag (`MoreFold`, stand in `resofly.dashboard.meer`), Deze
  week (`WeekStrip`) en Projecten (`ProjectGlance`). Alleen weergave: de regels voor "mijn"
  taken, rechten en "te laat" blijven op één plek in `Dashboard.tsx`.
- `src/features/Dashboard.tsx` — onder Zenit de nieuwe opbouw. De Cockpit-tak tekent dezelfde
  blokken als voorheen.
- `src/features/DayArc.tsx` — `showLane` en `quietStrip`, en een tooltip per stuk boog.
- `src/features/ProjectTimeline.tsx` — de rustige kop en werkbalk (`ptl-calm`), alleen onder
  Zenit op de volledige planningspagina. De dashboardversie en Cockpit blijven gelijk.
- `src/components/SearchFilterPanel.tsx` — onder Zenit de regel (`fs-calm`). Een veld telt als
  filter als het afwijkt van zijn eerste optie (de ruststand), niet als het "niet leeg" is.
  Onder Cockpit is de opmaak gelijk aan voorheen.
- `src/styles/zenit.css` — §11b (Vandaag), §11c (de timeline) en §11d (zoeken en
  filteren). De Puls hangt nu aan de container van Vandaag (`zcalm`) in plaats van de oude
  kop.

## Gecontroleerd

- `npm run typecheck`, `npm run build` en `npm test` (813 tests).
- `node scripts/check-csp-hash.mjs`: ongewijzigd en in orde.
- Een functionele ronde voor Onbewolkt in Chromium tegen de mock-backend, 58 controles, alle
  groen:
  - **Vandaag**: Je dag en Aandacht boven de vouw, geen baan onder de Dagboog, de strook
    alleen bij schuiven, de kopzin herhaalt Aandacht niet, Meer van vandaag dicht en open en
    onthouden na herladen;
  - **Timeline**: de zin, de drie lenzen met kloppende tellers, Verfijnen, een eigen keuze
    als chip en terug naar Lopend, zoeken en het kruisje, en lucht rond de titel;
  - **Facturen**: één regel van 36px, velden dicht, Verfijnen met zeven velden, een klant
    kiezen wordt een chip en een teller, de telling "1 van 6", het kruisje en Filters
    wissen;
  - **Projecten**: geen dubbele telling, wel bij zoeken;
  - **Weekplanner**: standaardwaarden tellen niet als filter;
  - **Cockpit**: dashboard, facturen en timeline ongewijzigd (telkaart, velden, vier cijfers
    en fasechips);
  - geen fouten in de console.
- De functionele ronde van Zenit (44 controles) is nog steeds helemaal groen.
- Met Chromium bekeken op 1440 × 900, 820 × 1180 en 390 × 844:
  - het dashboard met Meer van vandaag dicht en open, in Dag en Nacht;
  - de timeline met Verfijnen open en dicht, in Dag en Nacht;
  - facturen, offertes, klanten, tickets, projecten, campagnes en de weekplanner. Facturen
    (ook in Nacht) en de weekplanner ook met Verfijnen open en met filters aan.
