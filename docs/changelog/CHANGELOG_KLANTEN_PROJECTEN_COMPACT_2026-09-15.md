# Changelog — Klanten en projecten: meer rijen per telefoonscherm — 2026-09-15

> De klantenpagina en de actieve projecten pagina mogen compacter, zodat er meer
> ruimte overblijft voor meer projecten en klanten op een pagina. Filtersessie
> mag een stuk kleiner bij allebei.

## Wat het was

Gemeten in tabelweergave op 390×844. Onder de werktabs en boven de onderbalk is
744 px te verdelen; daarvan ging een derde op aan chrome:

| | Eerste rij begon op | Rijhoogte | Rijen in beeld |
| --- | --- | --- | --- |
| Klanten | 291 px | 59 px | ±8 |
| Projecten | 351 px | 69 px | ±6 |

## Wat het nu is

| | Eerste rij | Rijhoogte | Rijen in beeld |
| --- | --- | --- | --- |
| Klanten | **239 px** | **51 px** | **±11** |
| Projecten | **258 px** | **61 px** | **±8** |

Dat is ruim een derde meer klanten en veertig procent meer projecten per scherm,
zonder dat er een kolom of een knop verdwijnt.

### a · Het zoek- en filterblok

De opbouw blijft precies zoals hij was — knoppenrij, zoekveld met filterknop,
chips als veegrij — maar alles krijgt telefoonmaat in plaats van bureaubladmaat:
kaartpadding 10 → 7 px, tussenruimtes 8 → 6 px, zoekveld 40 → 36 px, filterknop
40 → 36 px, chips 32 → 28 px. Samen ±16 px op Klanten en ±21 px op Projecten.

Dit is het gedéélde blok, dus tickets, offertes, facturen, campagnes en de
weekplanner krimpen mee. Dat is bewust: het blok bestaat juist zodat "zoeken" op
elke tabel hetzelfde doet, en het zou raar staan als het op twee pagina's kleiner
was dan op de rest. Alle vijf zijn nagemeten.

### b · Projecten: één kaart in plaats van twee

Rond de projectentabel zat nóg een kaart, met eigen rand, 14 px padding en een
kop "Actieve projecten" plus de zin *"Open een project voor taken, notities en
projectdetails."* Twee geneste randen om dezelfde tabel is er één te veel.

- De omringende kaart is op de telefoon weg (rand, achtergrond en padding).
- De kop blijft — hij scheidt actief van archief — maar wordt één regel van
  14 px met de teller ernaast.
- De uitlegzin verdwijnt: die lees je één keer. Hetzelfde als bij de agent-kop
  en de dashboard-hero, die daar al zo werken.

Samen ±60 px.

### c · Rijen en kolomkoppen

14 px padding boven en onder is muismaat. Op een telefoon leest 10 px net zo
goed, en de rij blijft ruim boven de 44 px die een duim nodig heeft. De
kolomkoppen gaan van 14 naar 8 px. Scheelt 8 px per rij — bij acht rijen in beeld
is dat een hele rij extra.

Verder gaat de tussenruimte tussen de blokken op beide pagina's van 16 naar
10 px, en de Kaarten/Tabel-schakelaar van 39 naar 33 px hoog.

Vanaf 761 px verandert er niets.

## Code

- `src/styles/globals.css` — blok **26** in het mobiele deel. Staat helemaal
  achteraan het bestand, want het zoek-/filterblok wordt op regel ~9234 in een
  `@media(max-width:1024px)` gezet; met dezelfde specificiteit beslist de
  volgorde. (Eerst stond het blok halverwege en deed het niets — die les zit nu
  in het commentaar.)
- `tests/mobile/run.mjs` — een pagina in de test mag eigen `localStorage`
  meegeven. Daarmee zijn `clients-table` en `projects-table` toegevoegd: de
  tabelweergave werd tot nu toe nergens gemeten, terwijl de test juist bestaat
  om te bewaken dat koppen en knoppenrijen het scherm niet opeten. De grenzen
  voor klanten en projecten zijn meegezakt naar ±20 % boven de nieuwe meting,
  zoals de rest van die tabel.

## Getest

`npm run test:mobile -- --theme=both` (zoals CI) draait schoon, nu inclusief de
twee tabelweergaven. Los nagemeten op 390 px in donker en licht: klanten en
projecten in beide weergaven, plus **tickets, offertes, facturen, campagnes,
weekplanner en archief** — die delen het filterblok of de sectiekaart en zijn
alleen krapper geworden, niet stuk. `tsc` en `npm test` zijn groen.
