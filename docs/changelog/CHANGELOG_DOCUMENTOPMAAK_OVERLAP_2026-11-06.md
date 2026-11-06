# Changelog — Documentopmaak: de velden schuiven niet meer over de instellingen — 2026-11-06

## Aanleiding

> De instellingen van de eigen opmaak lopen over de pagina heen, waardoor gebruikers niet alles
> kunnen doen.

Met een schermafdruk van Instellingen → Documentopmaak op een laptop: de lijst met velden
("Sleep een veld naar de pagina…") lag over de instellingen van het gekozen blok heen. Daaronder
verdwenen de kleurknoppen (Tekst, Gedempt, Merkkleur), Dupliceren en Verwijderen, en de linkerhelft
van Links en Breedte. Zonder gekozen blok lag de lijst over de linkerkant van de kaarten Sjabloon,
Stijl en Pagina, met onder meer *Kiezen* bij Briefpapier en *De kop op elke pagina herhalen*.

## Wat er misging

De editor heeft drie standen, afhankelijk van zijn eigen breedte:

| editor | stand |
|---|---|
| smaller dan 760px | alles onder elkaar: het blad, de velden, de instellingen |
| 760 tot 1180px | de velden links, het blad rechts, **de instellingen op een eigen rij eronder, over de volle breedte** |
| 1180px en breder | de velden, het blad en de instellingen naast elkaar |

De middelste stand krijg je op de meeste laptops: een scherm van 1280px met de zijbalk ingeklapt,
of 1440px met de zijbalk vastgezet. In die stand plakt de lijst met velden (`position: sticky`),
zodat hij in beeld blijft terwijl je langs het blad scrolt. Maar een plakkend element blijft plakken
binnen het hele raster, niet alleen naast het blad. Scrolde je door naar de instellingen, dan schoof
de lijst mee naar beneden en lag hij over de linkerkant ervan, ook helemaal onderaan. Daar was
dus niet meer bij te komen.

## Wat er is veranderd

- **In de middelste stand staan de instellingen in de rechterkolom, onder het blad.** De velden
  hebben de linkerkolom van boven tot onder voor zich alleen. Ze blijven in beeld naast het blad
  én naast de instellingen, zonder ergens overheen te liggen. Zit je in de instellingen, dan voeg
  je met een klik nog steeds een veld toe.
- **Het raster heeft benoemde vlakken** (`grid-template` met `palette`, `stage` en `panel`) in
  plaats van `order` en `grid-column`. Per breedte staat nu in één regel wat waar staat.
- **Een heel hoog venster:** is de lijst met velden langer dan het blad en de instellingen samen,
  dan komt de extra ruimte onderaan. Met een gewone tweede rij kwam die tussen het blad en de
  instellingen (gemeten: 37px in plaats van 14px bij 1000×2200).
- De smalle en de brede stand zien er precies hetzelfde uit als voorheen.

Nagemeten in Chromium, licht en donker. Per breedte is gekeken of de velden ergens tijdens het
scrollen over de instellingen liggen, en welke knoppen van de instellingen dan meestal onder iets
anders liggen:

| venster | editor | stand | vóór | na |
|---|---|---|---|---|
| 390×844 | 366px | smal | in orde | in orde |
| 820×1180 | 712px | smal | in orde | in orde |
| 900×800 | 792px | midden | velden over de instellingen | in orde |
| 1024×800 | 916px | midden | velden over de instellingen | in orde |
| 1250×800 | 1114px | midden | velden over de instellingen; Tekst, Gedempt, Merkkleur, Dupliceren en Verwijderen meestal bedekt | in orde |
| 1440×800 | 1304px | breed | in orde | in orde |

## Waarom de test dit niet zag, en nu wel

`npm run test:mobile` mat telefoon (390px), tablet (820px) en liggend (740px). Daar is de editor
smal en staat alles onder elkaar. Desktop (1440px, alleen op verzoek) geeft de brede stand. De
middelste stand werd dus nooit gemeten. Er was ook geen meting die keek of twee delen over elkaar
heen liggen.

- **Een laptopformaat** (1280×800) in de standaardronde, alleen voor de pagina's die er een eigen
  stand hebben (`only` bij dat formaat). Voor nu is dat Documentopmaak. De ronde wordt er per thema
  één pagina langer van, niet een hele ronde.
- **Een nieuwe controle, `apart`:** twee delen die naast elkaar horen, gemeten op elf standen van
  boven tot onder. Een plakkend deel schuift pas ergens overheen als je scrolt; bovenaan, waar de
  andere metingen kijken, is er dan niets aan de hand. Voor Documentopmaak: `.dle-palette` en
  `.dle-panel`.
- Nagemeten dat de controle het ziet. Met de CSS van vóór deze fix meldt de test
  `dark/laptop/settings-documenten ← .dle-palette schuift over .dle-panel (138600px²)`. Met de
  fix is het in orde, op alle vier de formaten en in beide thema's.

## Wat níét verandert

Alleen de opmaak (`src/styles/document-layout.css`) en de test (`tests/mobile/run.mjs`, de
README ernaast). Geen gedrag, geen gegevens, geen database en geen edge functions.
