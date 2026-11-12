# Het nieuwe logo van ResoFly, in de app en als app-icoon — 12 november 2026

Vraag: *"Pas dit logo aan. Dit is het logo van resofly. Pas het aan in de app, maar ook als
icoon als de app wordt gedownload."*

## Het logo

Een zwarte R op een amberkleurige tegel (`#FFBD59`) met kleine ronde hoeken. Het been van de
R loopt schuin tot de onderrand en wordt daar door de tegel afgesneden. Tussen stam en been
zit een open spleet.

De R is als vector nagetekend uit het aangeleverde bestand (6250 × 6250 pixels), op een raster
van 512. Over het origineel gelegd valt 99,6% samen. Het verschil is een haarlijn aan de
buitenkant van de boog, minder dan een kwart procent van de maat.

Het logo staat op één plek: `src/components/BrandMark.tsx`. Daar staan de kleur van de tegel,
de kleur van de R, de hoek van de tegel en de R zelf. De app tekent het logo daaruit, en
`scripts/app-iconen.mjs` tekent er alle iconen uit. Het logo als los bestand staat in
`public/icons/resofly-logo.svg` (ook bereikbaar op `/icons/resofly-logo.svg`).

## In de app

Het logo staat nu overal waar het merk van ResoFly staat, in elke look:

- de zijbalk (Baken en Cockpit) en de rail (Zenit en Stroom);
- het inlogscherm, links bij het verhaal en op de inlogkaart;
- de inrichting van een nieuwe organisatie;
- het scherm waar je een AI-app koppelt (MCP);
- de regel onderaan het klantportaal ("Dit platform wordt beschikbaar gesteld door ResoFly"),
  nu als klein tegeltje in de eigen kleuren in plaats van een losse R in de tekstkleur.

Wat er anders is dan eerst:

- **Cockpit, Zenit en Stroom hadden een "R" in Poppins**, een andere letter dan die van het
  merk. Alleen Baken had het merkteken. Wie van look wisselde, zag het logo veranderen.
- **Het logo tekent zijn eigen tegel.** Voorheen kleurde de CSS de tegel (een goudverloop) en
  stond de R erin. Maar het been van de nieuwe R loopt tot de onderrand, en de tegels in de
  looks hadden veel rondere hoeken (13 tot 15 pixels op 40). Die ronde hoek sneed een stuk van
  het been af. Nu tekent het svg de tegel en de R samen. De tegel eromheen geeft alleen nog de
  maat en de gloed.
- **De hoek van die tegels is die van het logo** (8,2% van de maat). Met de oude hoek lagen de
  ring en de gloed als een rondere tweede tegel om het logo heen.

## Als app-icoon

| Bestand | Waarvoor |
| --- | --- |
| `icon-192.png`, `icon-512.png` | `any`: het logo zoals het is, buiten de hoeken doorzichtig. Computers (Windows, macOS), het tabblad, de meldingen. |
| `icon-maskable-192.png`, `icon-maskable-512.png` | `maskable`: een volle tegel. Android knipt er zelf een cirkel of druppel uit. |
| `apple-touch-icon.png` (180) | Het beginscherm van een iPhone of iPad. |
| `badge-72.png` | De witte R in de statusbalk van Android bij een melding. |
| `app-<id>-…` | Agenda, Financiën en Communicatie: dezelfde tegel, met hun eigen teken. |

Eerst was er één bestand voor alles: een volle vierkante tegel. Nu zijn het er drie soorten:

- **`any` is het logo zoals het is.** Op een computer stond ResoFly als enige app als hoekig
  blok tussen de rest.
- **`maskable` heeft de R kleiner.** Android houdt alleen de cirkel van 80% zeker over (de
  veilige zone). Op de maat van het logo valt de onderhoek van de stam daarbuiten. Het been
  loopt in het icoon door tot onder de rand. Anders hield het in een cirkel net vóór de rand op,
  en zag het er afgebroken uit.
- **iOS krijgt een eigen volle tegel.** Safari leest het manifest niet, rondt zelf de hoeken af
  en maakt een doorzichtige hoek zwart. Daarom wijst `apple-touch-icon` niet meer naar
  `icon-192.png`. `InstallableApp` heeft een eigen veld `touchIcon` gekregen; de losse apps
  gebruiken daarvoor hun maskable icoon.

De iconen van Agenda, Financiën en Communicatie hebben de kleur van het nieuwe logo gekregen
(tegel `#FFBD59`, teken zwart), zodat de vier apps op een beginscherm een familie blijven.

## Wat gebruikers merken

- **In de browser** zien ze het nieuwe logo meteen na de volgende uitrol.
- **Een geïnstalleerde app op Android of een computer** werkt zijn icoon zelf bij. Chrome
  controleert het manifest af en toe, en vraagt op Android soms om bevestiging.
- **Een app op het beginscherm van een iPhone** houdt het oude icoon. iOS werkt dat nooit bij.
  Wie het nieuwe icoon wil, verwijdert de app van het beginscherm en zet hem er opnieuw op.

## Bestanden

- `src/components/BrandMark.tsx`: het logo (tegel en R), en de waarden die het script gebruikt.
- `src/components/Sidebar.tsx`, `ZenitNav.tsx`, `McpConsent.tsx`, `src/main.tsx`,
  `src/features/OrganizationSetup.tsx`, `src/features/portal/ClientPortal.tsx`: het logo in
  plaats van de letter.
- `src/styles/globals.css`, `cockpit.css`, `baken.css`, `zenit.css`, `onboarding.css`: de hoek
  van de tegels; de portaalvoet.
- `scripts/app-iconen.mjs`: tekent nu ook het logo en de iconen van de werkruimte.
- `public/icons/`, `public/manifest.webmanifest`, `public/apps/*.webmanifest`, `index.html`.
- `src/lib/standaloneApps.ts`: `touchIcon` voor `apple-touch-icon`.

## Getest

- Het nagetekende logo over het origineel gelegd: 99,6% overlap (IoU), verschil alleen een
  haarlijn aan de boog.
- Screenshots van de zijbalk en het inlogscherm in Baken, Cockpit, Zenit en Stroom, dag en
  nacht.
- De iconen bekeken met de cirkel van Android en de hoeken van iOS erover.
- `npm run typecheck`, `npm test` (met een nieuwe test: iOS krijgt een volle tegel),
  `npm run test:mobile -- --theme=both`, `npm run test:inrichten`.
