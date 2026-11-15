# Weekplanner vernieuwd: een eigen kop, het bord in elke weergave heel, en een leesbaar rooster (2026-11-15)

## Wat de PO vroeg

> Kijk nog eens goed naar de weekplanner. Maak een stunning en functioneel goed
> werkende weekplanner, met een goede UI en UX.

## Wat er mis was

Eerst is de planner geopend tegen de nagebootste backend van de tests
(desktop 1440×900 in donker en licht, en telefoon 390×844). Gevonden:

- **Zoeken en filteren kon op desktop niet.** De kop was het gedeelde zoekblok
  (`SearchFilterPanel` met `is-bar`). De kaart had een vaste hoogte met
  `overflow: hidden`, en de regel met zoekveld en keuzelijsten viel daar
  búiten (gemeten: kaart tot 198px, zoekveld op 208px). Met de tab-toets kwam
  je er nog wel in, maar zien deed je het niet.
- **"2 filters actief" stond er altijd.** De telling vergeleek met een lege
  waarde, maar "Alle prioriteiten" is `all` en "Open taken" is `open`. Op de
  telefoon stond er dus altijd "2 filters actief" met een knop "Filters wissen"
  die niets wiste.
- **Lijst en Team waren op desktop kapot.** `.wp-board` had nog de indeling van
  vóór het rooster (`1fr 268px`), terwijl de werkvoorraad inmiddels als eerste in
  de DOM stond. De werkvoorraad kreeg daardoor de brede kolom en de dagen werden
  in 268px geperst. In het Team liepen de kaarten zelfs over elkaar.
- **Het rooster opende op het verkeerde uur.** Het rooster scrolde naar "nu" met
  de rijhoogte van vóór de meting. Om 11:28 stond 12:30 bovenaan en de hele
  ochtend viel buiten beeld. Zonder "vandaag" in beeld telde het de hoogte van de
  plakkende koppen nog eens mee, en verdween het begin van de werkdag onder de
  koppen.
- **Blokken waren onleesbaar.** Zeven kolommen naast een werkvoorraad van 300px
  geven ~135px per dag. Staan er twee blokken naast elkaar, dan zijn ze 60px
  breed: "We… wir…", "1… M. C…".
- **Te veel chrome boven het rooster.** Kop (106px), een oranje meeneembalk
  over de volle breedte (45px), een legenda-strook (25px) en een dagkop van
  88px. Op de telefoon begon het rooster pas op 540px.
- In de kop zeven knoppen van gelijk gewicht (Mijn week/Team, Compact/Ruim,
  Rooster/Lijst, Vul mijn week, Geen streep, ‹ Vandaag ›). De weeknavigatie
  stond achteraan.

## Wat er nu staat

### Een eigen kop

- **Links de week.** ‹ en › om te bladeren, en daartussen het weeknummer, groot,
  met erboven waar je staat ("Deze week", "Volgende week", "Over 3 weken",
  "2 weken geleden") en ernaast de datums ("9 – 15 nov 2026"). Het weeknummer
  is een **weekkiezer**: een maand met weeknummers waarin je een hele week
  aanklikt. Bladeren per week ging per klik, dus wie in januari de week van de
  jaarafsluiting wilde plannen, klikte tien keer. Daarnaast **Vandaag**.
- **Rechts het gereedschap.** Eén keuze **Rooster · Lijst · Team**. Eerst waren
  dat twee schakelaars, en de tweede deed in de teamweergave niets. Daarnaast een
  **zoekveld** dat altijd zichtbaar is, **Filters** (klant, project, prioriteit,
  status, met een teller die alleen telt wat écht filtert), **Weergave** (5 of 7
  dagen, Compact/Ruim, alles in- of uitklappen, en je dagstreep) en de gouden
  hoofdknop **Vul mijn week**.
- **De polsslag eronder.** Eén balk met afspraken (violet), taken (goud) en, met
  een streep, wat er nog vrij is of hoeveel er boven je streep uitkomt. De balk
  heeft dezelfde kleuren als de dagbalken in het rooster. Rechts de meldingen
  als kleine knoppen:
  - **"14 taken van eerder open · Meenemen"** opent het meeneem-voorstel:
    wat er meegaat, naar welke dag, en de uitkomst in de knop. Was een oranje
    balk van 45px (op de telefoon ruim 300px).
  - **"1 deadline deze week zonder plek · Bekijk"** opent de deadlines in de
    werkvoorraad.
  - **"3 items in het weekend · Tonen"** verschijnt als het weekend uit beeld
    is en er wél iets staat.
- Panelen sluiten met klikken ernaast, Esc of de terugknop van de telefoon
  (`useBackStep`). Dat geldt nu ook voor het snelmenu op een taak.

### Het bord, in elke weergave

Werkvoorraad links (300px; 280px op een laptop), de week rechts: in het
Rooster, de Lijst én het Team. In de Lijst en het Team blijft de werkvoorraad
staan terwijl de pagina scrolt. Onder 1025px staat hij boven de week en klapt
hij in, net als voorheen.

### De werkvoorraad

- Tabbladen **Te plannen · Deadlines · Andere weken**. "Lade" was een woord van
  de bouwers.
- Een nieuwe kaart: titel op twee regels, daaronder project en klant met de
  projectkleur ervoor, dan de kenmerken die om een beslissing vragen (deadline,
  weekstrook, ticket, afspraak). De **deadline staat nu ook in Compact op de
  kaart**, oranje binnen drie dagen en rood als hij voorbij is. Timer en ⋯
  verschijnen bij aanwijzen; op touch staan ze er altijd.
- Lege staten die zeggen wat er aan de hand is ("Alles heeft een plek",
  "Niets binnen dit filter").
- De actiepunten onderin zijn in te klappen, en dat blijft bewaard.

### Het rooster

- **Ma – vr** is de standaard, tenzij je streep het weekend meetelt. Vijf
  kolommen zijn ruim een derde breder. Onder Weergave zet je **7 dagen** aan.
  "Vul mijn week" zet niets op een dag die niet in beeld is.
- **Opent op de werkdag**: om 08:00, of met "nu" op een derde van de hoogte als
  vandaag in beeld is. Dit is opgelost in `TimeBlockGrid` zelf, dus de Agenda
  opent nu ook op het goede uur.
- **De legenda-strook is weg.** De balk in de kop draagt dezelfde kleuren, en
  de werkvoorraad zegt wat je kunt doen. Dat scheelt een regel.
- **Dagkop van 88 naar 70px**: dag en datum op één regel, daaronder aantal,
  uren, ruimte tot je streep en de balk. Vandaag krijgt een gouden datum en een
  zachte gloed. Het plusje verschijnt bij aanwijzen (op touch altijd).
- **Blokken lezen**: titels breken af met een streepje in plaats van per regel
  afgekapt te worden ("Wire-frames afspra-ken" in plaats van "Wire… afsp…"). In
  een blok van minder dan 96px breed wijkt het vinkje voor de titel (container
  query). De twee talen blijven: een afspraak is vol gevuld, een taakblok licht
  getint met een stippelrand.

### Telefoon en tablet

- De kop is twee regels plus de balk: ‹ week › Vandaag, en daaronder de
  weergave als iconen, zoeken, filters, weergave en de toverstaf. Op de
  telefoon staan de datums naast "Deze week" in de bovenregel; naast het
  weeknummer werden ze afgekapt.
- Panelen openen als vel boven de onderbalk, en liggen dan boven de zwevende
  knoppen van Gerrie en de teamchat.
- De teamweergave krijgt dezelfde dagstrip als het rooster en toont per persoon
  één dag. Eerst stonden daar zeven dagvakken per persoon onder elkaar, zonder
  dat ergens stond welke dag welk vak was.
- De mobiele test meet de dagstrip nu op 305px (was ~480px, grens 600px).

## Twee fouten die bij het testen opdoken

- **Filterkeuze ging verloren.** De keuzelijst (`Select`) zet zijn menu via een
  portal onder `<body>`. Een klik op een keuze telde voor het paneel als "klik
  ernaast", en het paneel sloot bij het indrukken. De keuze telde dan niet.
  `PlannerPopover` negeert nu kliks in `.select-menu`, en Esc sluit eerst de
  keuzelijst en pas daarna het paneel.
- **Een klik op Filters of Weergave deed soms niets.** Het zoekveld werd breder
  bij focus. Klikte je met de focus in het zoekveld op een andere knop, dan
  kromp het veld bij het indrukken, verschoof de werkbalk, en viel het loslaten
  op een andere plek. Het zoekveld heeft nu een vaste breedte.

## Code

- `src/lib/weekView.ts` (+ `weekView.test.ts`, 7 tests): `relativeWeekLabel`,
  `weekRangeLabel`, `pickerWeeks`, `weekMeter`, `countActiveFilters`. Zonder
  imports, dus rechtstreeks onder `npm test`.
- `src/features/WeekPlannerParts.tsx`: `PlannerPopover` (knop + paneel, met
  `useBackStep`), `WeekPicker`, `Segmented`.
- `src/features/WeekPlanner.tsx`: de kop in plaats van `SearchFilterPanel`;
  `PlannerView`, `DayMode` (bewaard in de voorkeuren), het tabblad van de
  werkvoorraad naar boven getild (`trayTab`); `CarryOverPanel` is
  `CarryOverNudge` geworden, `CapacityControl` staat in het paneel Weergave;
  kaart met `--task-color`, `wp-task-where` en `wp-task-tags`; actiepunten
  inklapbaar; "de lade" heet in meldingen "de werkvoorraad".
- `src/features/CalendarPage.tsx`: beginscroll wacht op de gemeten rijhoogte en
  telt de plakkende koppen niet dubbel.
- `src/styles/weekplanner.css`: nieuw, als laatste geladen (`main.tsx`). Alle
  regels onder `.week-planner`, alleen tokens van de looks. De oudere
  `.wp-*`-lagen in `globals.css` blijven staan; dit bestand wint.

Geen migratie, geen edge function: alleen de app.

## Getest

- `npm run typecheck` schoon, `npm test` 1913 groen (7 nieuw).
- Interactietest met Playwright tegen de mock-backend, met een eigen
  geheugenopslag voor taken zodat schrijven en teruglezen echt werkt. 30 van
  de 30 stappen goed: rooster opent op 08:00; geen filtermelding zonder
  filter; slepen uit de werkvoorraad naar wo 14:00 (dag én tijd); ongedaan
  maken; blok verschuiven naar do; tekenen maakt een taak op di 16:00; snelmenu
  "Naar de werkvoorraad"; bladeren naar "Volgende week"; Vul mijn week (voorstel
  van 3 blokken, toegepast); weekkiezer; Vandaag; filter Hoog (teller 1, alleen
  hoge prioriteit); zoeken; 7 dagen; Lijst en Team op 972px breed; het
  meeneempaneel. Geen JavaScript-fouten.
- Schermafdrukken op 1440×900, 1280×800, tablet 820×1180 en telefoon 390×844,
  in donker en licht, van het rooster, de lijst, het team en alle panelen.
- Terugknop met de hand (telefoon, `page.goBack`): een open filtervel en de
  weekkiezer gaan dicht, de planner blijft staan.
- `npm run test:mobile -- --theme=both --pages=weekplanner,calendar,calendar-event,calendar-task,calendar-month`:
  30 pagina's, 0 problemen. Ook `meeting-booking`, `public-booking` en
  `dashboard` (die delen het rooster of de kop): 18 pagina's, 0 problemen.
- `npm run test:loading`: alle controles geslaagd.
- `npm run test:terugknop`: 12 gelukt, 0 mislukt.
- `npm run build` slaagt.

## Nog open

- E2e met echte login op staging (de gebruikelijke restpost).
- Op een tablet (≤ 900px) toont het rooster nog één dag tegelijk, zoals
  voorheen. Daar passen er drie.
