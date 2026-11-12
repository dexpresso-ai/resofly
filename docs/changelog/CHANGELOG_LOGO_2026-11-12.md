# De R uit het nieuwe logo, op een oranje tegel — 12 november 2026

Vraag: *"Pas dit logo aan. Dit is het logo van resofly. Pas het aan in de app, maar ook als
icoon als de app wordt gedownload."* En daarna: *"Alleen de R logo mag je vervangen. De rest
mag je laten staan, maar wel met de juiste oranje kleur."*

## Wat er verandert

- **De R.** Het logo is een zwarte R op een oranje tegel. Het been loopt schuin tot de
  onderrand, en tussen stam en been zit een open spleet. De R is als vector nagetekend uit het
  aangeleverde bestand (6250 × 6250 pixels). Over het origineel gelegd valt 99,6% samen; het
  verschil is een haarlijn aan de buitenkant van de boog.
- **De kleur van de tegel** is het oranje van het logo, `#FFBD59`, gemeten in het bestand.
  Eerst was de tegel een goudverloop (`#FFE496` → `#F0B530`). De R is zwart, net als in het
  logo.

De R en de kleur staan op één plek: `src/components/BrandMark.tsx`. In de CSS heet de kleur
`--logo-tile`; `scripts/app-iconen.mjs` leest beide uit BrandMark.tsx.

## Wat blijft zoals het was

De vorm van de tegels (hun maat, ronde hoeken, gloed en halo), de opbouw van de app-iconen, de
manifesten en de rest van de kleuren in de app. Het goud van knoppen, de plek waar je bent en de
lichtstralen blijft goud. Alleen de tegel met de R wordt oranje.

## In de app

De R staat nu overal waar het merk van ResoFly staat, in elke look:

- de zijbalk (Baken en Cockpit) en de rail (Zenit en Stroom);
- het inlogscherm, links bij het verhaal en op de inlogkaart;
- de inrichting van een nieuwe organisatie;
- het scherm waar je een AI-app koppelt (MCP);
- de regel onderaan het klantportaal, als losse R in de tekstkleur, zoals eerst.

Cockpit, Zenit en Stroom hadden een "R" in Poppins, een andere letter dan die van het merk.
Alleen Baken had het merkteken.

Het been loopt tot de onderrand van de tegel, en de tegels hebben ronde hoeken. Het svg erft
daarom de hoek van de tegel (`border-radius: inherit` in BrandMark). Zonder die regel stak de
rechteronderhoek van het been buiten de tegel uit. Nu knipt de ronde hoek het been af, zoals
de rand dat in het logo doet.

Onderaan het klantportaal staat de R op 14 in plaats van 18 pixels. De nieuwe R vult zijn vak
tot de onderrand, de oude maar tot 80%. Op 18 pixels stond hij een kwart groter dan voorheen
naast de tekst.

## Als app-icoon

Dezelfde bestanden als eerst, opnieuw getekend:

- `icon-192.png` en `icon-512.png`: de werkruimte. Een volle oranje tegel met de nieuwe R. Het
  is nog steeds één bestand voor `any`, `maskable` en het beginscherm van iOS. Daarom staat de R
  iets kleiner dan in het logo (87%). Op de maat van het logo valt de onderhoek van de stam
  buiten de cirkel die Android uitknipt. Het been loopt door tot onder de rand. Anders hield het
  in een cirkel net vóór de rand op, en zag het er afgebroken uit.
- `badge-72.png`: de witte R in de statusbalk van Android bij een melding.
- `app-agenda-…`, `app-financien-…`, `app-communicatie-…`: dezelfde oranje tegel, met hun eigen
  teken, zodat de vier apps op een beginscherm een familie blijven.

## Wat gebruikers merken

- **In de browser** zien ze de nieuwe R meteen na de volgende uitrol.
- **Een geïnstalleerde app op Android of een computer** werkt zijn icoon zelf bij. Chrome
  controleert het manifest af en toe, en vraagt op Android soms om bevestiging.
- **Een app op het beginscherm van een iPhone** houdt het oude icoon. iOS werkt dat nooit bij.
  Wie het nieuwe icoon wil, verwijdert de app van het beginscherm en zet hem er opnieuw op.

## Bestanden

- `src/components/BrandMark.tsx`: de R en de kleur van de tegel.
- `src/components/Sidebar.tsx`, `ZenitNav.tsx`, `McpConsent.tsx`, `src/main.tsx`,
  `src/features/OrganizationSetup.tsx`, `src/features/portal/ClientPortal.tsx`: de R in plaats
  van de letter.
- `src/styles/globals.css`, `cockpit.css`, `baken.css`, `zenit.css`, `stroom.css`,
  `onboarding.css`: de tegels oranje (`--logo-tile`) met een zwarte R.
- `scripts/app-iconen.mjs`: tekent nu ook het icoon van de werkruimte en de badge.
- `public/icons/icon-192.png`, `icon-512.png`, `badge-72.png`, `app-*.png`.

## Getest

- De nagetekende R over het origineel gelegd: 99,6% overlap (IoU).
- Screenshots van de zijbalk en het inlogscherm in Baken, Cockpit, Zenit en Stroom, dag en
  nacht. Ingezoomd op de hoek: de ronde hoek knipt het been netjes af.
- De iconen bekeken met de cirkel van Android en de hoeken van iOS erover.
- `npm run typecheck`, `npm test`, `npm run test:mobile -- --theme=both` en
  `npm run test:inrichten`.
