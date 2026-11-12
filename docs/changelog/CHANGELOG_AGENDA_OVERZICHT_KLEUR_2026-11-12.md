# Agenda: meer in beeld, en kleurrijker (2026-11-12)

## Aanleiding

"Zorg ervoor dat de agenda weergave een groter deel van het scherm bevat, om
meer agenda overzicht te krijgen. Vervolgens wil ik dat de kleuren wat
kleurrijker zijn van de agenda. Ze zijn nu zo mat."

## Meer overzicht

De agenda vulde de breedte al, maar de rijhoogte was zo gekozen dat precies de
werkdag (08:00–18:00) in beeld paste. Op een gewoon laptopscherm zag je dus
tien uur, en voor een vroege afspraak of een avond moest je scrollen.

| Scherm | Voor | Nu |
| --- | --- | --- |
| Laptop 1280×800 | ± 10 uur (56px per uur) | ± 13 uur (44px per uur) |
| 1440×900 | ± 10 uur (60px per uur) | ± 13 uur (52px per uur) |
| 1920×1080 | ± 13 uur | ± 14 uur |
| Telefoon (dagweergave) | ± 9 uur | ± 12 uur |

- **Het venster dat in beeld past is nu 07:00–20:00** in plaats van de werkdag.
  Het grijze vlak buiten werktijd blijft 08:00–18:00. Opent de agenda op een
  week zonder vandaag, dan begint hij om 07:00; staat vandaag in beeld, dan
  opent hij zoals altijd rond "nu".
- **Een half uur mag tot 21px zakken** (was 24px). Wie het groter wil, zoomt in
  met Ctrl/⌘ + scrollen, knijpen of +/−; die stand wordt onthouden.
- **Dagkoppen op één regel** ("MA 9", 40px in plaats van 52px), en een iets
  plattere werkbalk.
- **Telefoon, dagweergave:** de dag stond er twee keer (in de weekstrook én als
  kop "DO 12" eronder). De kop is weg; het rooster begint direct.
- **Tekst past bij de echte hoogte.** Hoeveel tekst een blok toont, hing alleen
  af van de duur. Bij compactere uren bleef een afspraak van een uur dan
  "ruim" (tijd, twee regels titel, locatie) in 52px, en werd de titel
  halverwege een regel afgeknipt. Dat gebeurde vroeger al een beetje. Nu
  telt ook de hoogte: zo'n blok toont tijd en één regel titel, die netjes op
  "…" eindigt.
- **Alleen de agenda.** De weekplanner en de boekingslinks gebruiken hetzelfde
  rooster met hun eigen koppen; die houden hun uurhoogte
  (`TimeBlockGrid.fitWindow`).

## Kleurrijker

- **Taakblokken** (taken met een tijd, gestippeld) hadden maar 14% van hun
  projectkleur. In het donker werd dat bruin en navy, in het licht bijna wit.
  Nu:
  - 30% kleur, gemengd in oklab, wat helderder blijft dan sRGB;
  - een volle kleurstreep links;
  - een rand in de volle kleur;
  - de titel in de kleur zelf.

  De stippelrand en de arcering blijven: een taak moet naast een (vol
  gevulde) afspraak als taak te herkennen zijn. Dat geldt ook in de
  weekplanner, die dezelfde blokken toont.
- **De balkjes onder "Hele dag"** (deadlines) waren altijd goud. Nu hebben ze
  de kleur van hun project.
- **De maandweergave** gaf elke taak een goud bolletje. Nu krijgt elke taak
  de kleur van zijn project, net als in het rooster.
- **Bleke agendakleuren.** Een gekoppelde Google-agenda geeft zijn kleur
  door uit Google's oude palet, en daarvan is een groot deel pastel
  (`#9fe1e7`, `#fad165`, `#c2c2c2`…). Die tonen we nu in de volle tint van
  hetzelfde kleurvak (`src/lib/calendarColors.ts`):
  - `#9fe1e7` wordt `#039BE5`;
  - `#fad165` wordt `#F6BF26`;
  - grijs wordt grafiet.

  Een andere heel bleke kleur (Microsoft geeft ook pastel door) wordt voller
  in dezelfde tint. Kleuren die al vol zijn, blijven zoals ze zijn, net als
  het merkgoud en de eigen projectkleuren.

  Dit is alleen weergave: de database houdt de kleur van de bron, zodat een
  volgende synchronisatie niets terugzet. Het geldt in de agenda, de
  weekplanner, de boekingslinks en bij de bolletjes in de agenda-instellingen.
- **Privé-afspraken** waren voor bijna de helft ontkleurd; nu een klein
  beetje, zodat ze herkenbaar blijven.

Eén ding bleek bij het testen: een vaste vertaling van álle 24 Google-kleuren
naar hun nieuwere tint maakte er zeven juist minder kleurrijk (bosbes,
lavendel, amethist…). Daarom alleen de pastels; `calendarColors.test.ts`
bewaakt dat elke vertaling voller is.

## Getest

- `src/lib/calendarColors.test.ts` (nieuw): de vertalingen zijn voller, het
  merkgoud en de projectkleuren blijven, grijs blijft grijs, en onbruikbare
  invoer valt terug.
- Screenshots vóór en na:
  - in donker en licht;
  - op 1280×800, 1440×900, 1920×1080 en de telefoon;
  - in de week-, dag- en maandweergave, en in de weekplanner.
- `npm run typecheck`, `npm test` (1654 groen), `npm run test:loading`, en
  `npm run test:mobile -- --theme=both` op de agenda (ook met een afspraak en
  een taak open), de weekplanner, de boekingslinks en het dashboard: 42
  pagina's, 0 problemen.

Niet gecontroleerd tegen een echt gekoppeld Google-account: de vertaling van
Google's oude palet volgt de kleurvakken zoals Google ze noemt, maar het
exacte resultaat naast Google Agenda zelf is hier niet te bekijken.
