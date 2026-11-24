# Dashboard: blokken in- en uitklappen en in je eigen volgorde (2026-11-24)

## Wat de PO vroeg

> Maak de blokken op het dashboard in- en uitklapbaar, en zorg dat je de
> volgorde kunt aanpassen.

## Wat er nu kan

Dit geldt voor de standaardlook **Baken** en voor **Cockpit**. Zenit en Stroom
hebben een eigen, rustiger opbouw: de rest staat daar al achter "Meer van
vandaag". Die blijven zoals ze zijn.

### Inklappen

- Elk blok heeft rechtsboven in zijn kop een pijltje. Klik erop en het blok
  wordt één balk met zijn naam en een korte samenvatting, bijvoorbeeld
  "Vandaag · 7 acties · 2 afspraken", "Vereist je aandacht · 4 punten" of
  "Stand van zaken · Ontvangen november € 6.909,10 · € 3.690,50 openstaand".
  Klik op de balk en het blok gaat weer open.
- Het pijltje staat óver de kop en niet op een eigen regel. Op de telefoon
  stond de eerste taak al op 273 van de 280 pixels die de lay-outtest toestaat;
  een regel extra per blok paste daar niet. De eerste taak staat nog steeds op
  273px.
- Op de telefoon en de tablet is de groet van de cockpit verborgen, en ligt
  het pijltje op de hoek van een tegel. Daar krijgt het een eigen donker
  schijfje, zodat het niet leest als iets van die tegel.

### Volgorde

- **Blokken indelen** staat in de cockpit, naast Weekplanner, en onderaan het
  dashboard (op de telefoon en de tablet is de groet weg, en kan de cockpit
  zelf ingeklapt zijn).
- Elk blok wordt dan een balk met:
  - een handvat om te slepen;
  - Open of Ingeklapt;
  - pijltjes omhoog en omlaag.

  Met het toetsenbord gaat het met ↑ en ↓ op het handvat. Een schermlezer hoort
  "Vandaag staat nu op plek 2 van 9". **Standaard** zet alles terug, Klaar,
  Esc of de terugknop van de telefoon sluit het indelen.
- Je verplaatst blokken in een lijst van balken, niet in het dashboard zelf:
  slepen met een blok van duizend pixels hoog, zoals de projectplanning, ging
  nergens heen.

### Welke blokken

| Blok | Breedte |
| --- | --- |
| Stand van zaken (de cockpit: groet, kerncijfers, spoor) | vol |
| Te beslissen (beslislijst van Gerrie) | vol |
| Jouw akkoord (wachtrij van je agents) | vol |
| Vandaag | breed |
| Vereist je aandacht | smal |
| Weekacties | vol |
| Projectplanning | vol |
| Mijn rapportages | breed |
| Inrichting | smal |
| Logboek | smal |

Een breed blok neemt de smalle blokken die er direct op volgen naast zich. Zet
je smalle blokken direct vóór een breed blok, dan staan ze er links naast.
Staat een blok alleen, dan krijgt het de volle breedte. De standaardvolgorde
geeft daardoor precies het dashboard van vóór deze ronde: Vandaag met Aandacht
ernaast, de rapportages met de inrichting en het logboek. Onder 1100px staat
alles onder elkaar, in jouw volgorde.

"Te beslissen" en "Jouw akkoord" verschijnen alleen als er iets klaarstaat.
Dat blijft zo, ook als ze ingeklapt zijn. In het indelen staan ze er altijd,
zodat je ze een plek kunt geven.

### Waar het bewaard wordt

De indeling wordt in de browser bewaard, per organisatie en per persoon
(`resofly.dashboard.blocks.<organisatie>.<gebruiker>`), net als de keuzes Mijn
of Team en Geld of Week die er al stonden. Een blok dat er later bij komt,
verschijnt op zijn standaardplek, ook bij wie een eigen volgorde heeft.

## Code

- `src/lib/dashboardLayout.ts` (nieuw, zonder imports):
  - de blokken en hun breedte;
  - `parseDashLayout` (een kapotte of oude opslag valt terug, nieuwe blokken
    komen op hun plek);
  - `moveDashBlock` en `stepDashBlock`: alleen tussen de blokken in beeld.
    Blokken die je niet ziet houden hun plek;
  - `toggleDashBlock`;
  - `dashRows` (van volgorde naar rijen).

  Tests in `dashboardLayout.test.ts` (9).
- `src/features/DashboardBlocks.tsx` (nieuw): `DashBlocks` (de rijen, de knop
  onderaan, de terugknop via `useBackStep`), `DashBlock` (pijltje, balk,
  focus terug op de knop) en `DashArrange` (handvat, pijltjes, slepen met
  pointer events, live-melding voor de schermlezer).
- `src/features/Dashboard.tsx`: de cockpit, Vandaag, Aandacht en Weekacties
  staan als losse stukken en gaan als blokken naar `DashBlocks`. Zenit en
  Stroom houden hun eigen stapel. De cockpit kreeg de knop **Indelen**.
- `src/styles/dashboard-blocks.css` (nieuw, geladen in `main.tsx`).
- `tests/mobile/run.mjs`: nieuwe meting `dashboard-indelen`.
- `tests/terugknop/run.mjs`: nieuw geval "terug sluit Blokken indelen; Klaar
  haalt zijn stap weg".

Geen migratie, geen edge function.

## Getest

- `npm run typecheck` schoon, `npm test` groen: 2277 tests, waarvan 9 nieuw.
- Met de hand tegen de mock, op 1440×900 in donker en licht, en op 390×844:
  - inklappen van de cockpit en Aandacht, herladen: de keuze blijft;
  - indelen: Logboek naar plek 4 gesleept, Aandacht met de pijl omhoog. De
    focus blijft op de pijl, de schermlezer meldt de nieuwe plek;
  - na Klaar staat Logboek links naast Vandaag en Aandacht op de volle
    breedte, en gaat de focus terug naar de knop;
  - op de telefoon past het indelen zonder zijwaarts scrollen;
  - de eerste taak staat op 273px, net als voorheen.
- `npm run test:terugknop`: 17 gelukt, 0 mislukt.
- `npm run test:mobile -- --theme=both`: 920 pagina's gemeten, 0 met
  problemen. Daarin ook `dashboard-indelen` op telefoon, tablet en liggend,
  in licht en donker. Het dashboard op de telefoon staat op 273px (max 280).
- `npm run test:loading`: alle controles geslaagd.
- `npm run build` slaagt.

## Nog open

- De indeling staat in de browser, net als Mijn/Team en Geld/Week. Op een
  ander apparaat begin je opnieuw met de standaard. Moet hij meereizen, dan
  is daar een tabel met persoonlijke voorkeuren voor nodig.
- Op de telefoon scrolt de lijst niet vanzelf mee als je een balk naar de
  rand sleept. De lijst is kort (hooguit tien balken), en de pijltjes werken
  altijd.
- E2e met echte login op staging (de gebruikelijke restpost).
