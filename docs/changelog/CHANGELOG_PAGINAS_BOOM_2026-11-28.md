# Pagina's: de boom in de drive, en een kruimelpad (2026-11-28)

Eerste deel van stap 1A-5 van het bouwplan (`docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §4
en §18).

## Wat er nu kan of klopt

- **Subpagina's staan onder hun pagina.** In de lijst van de drive staat een subpagina niet
  meer los in het dossier.
  - Een pagina met subpagina's toont "1 subpagina" of "3 subpagina's", en een pijltje om
    ze uit en in te klappen. Ze komen inspringend onder de pagina, ook dieper.
  - Bij zoeken staat alles los in de lijst, zodat je ook een subpagina vindt.
- **Een pagina op een andere pagina slepen** maakt er een subpagina van.
  - De lijst laat het alleen toe waar het kan: niet onder zichzelf, niet onder een eigen
    subpagina, niet als ze er al onder staat. De database bewaakt dat ook.
  - De pagina komt bij de klant en het project van haar nieuwe ouder, zonder eigen map.
- **Een subpagina naar een map of dossier slepen** maakt haar weer een losse pagina op die
  plek. Dat kan ook naar de wortel van haar eigen dossier, via "Terug" of "Verplaatsen
  naar…".
  - Wat misging: de verkenner zag de wortel als haar plek, en vond dat ze er al stond.
  - Nu heeft een subpagina geen eigen plek in de drive (`driveItemLocation`); ze hangt onder
    een pagina.
  - Wat misging: de database zette haar stil terug onder haar ouder, want een subpagina
    volgt de plek van haar ouder.
- **Het kruimelpad.** Op een subpagina staan bovenin alle bovenliggende pagina's, elk
  klikbaar. Op een telefoon is het één pijltje naar de directe ouder.

## Hoe het werkt

- `src/features/ContentLibrary.tsx`:
  - de boom komt uit `data.documents` (`parent_id`), en `withSubpages` zet de open pagina's
    met hun subpagina's in de lijst;
  - pagina-rijen zijn een sleepdoel (`pageDropProps`).

  De tegelweergave toont alleen de bovenste pagina's, met het aantal subpagina's.
- `src/lib/repository.ts`:
  - `nestPageUnder`;
  - `moveDriveItem` zet bij documenten ook `parent_id` op null;
  - `pageAncestors`, voor het kruimelpad.
- `src/features/PageEditor.tsx`: het kruimelpad vervangt de knop omhoog van 1A-4b.

## Om rekening mee te houden

- **De boom links naast een pagina** (§4, "het pagina-scherm") zit er nog niet in.
  Navigeren gaat via de subpagina-blokken en het kruimelpad.
- **De volgorde van subpagina's** is die van `position`, dan de titel. Slepen om de volgorde
  te veranderen kan nog niet.

## Getest

- **Unit tests:** `npm test` (2339 gelukt) en `npm run typecheck`.
  - Later toegevoegd in `driveDnd.test.ts`: een subpagina naar de wortel van haar dossier is
    een verplaatsing, en niet "staat er al".
- **`tests/stromen/ui.mjs documenten`:** 27 stappen, 0 fout. De nieuwe stap, met echte
  sleepacties in Chromium:
  - een pagina met een subpagina toont "1 subpagina", en de subpagina staat niet los in het
    dossier;
  - uitklappen toont de subpagina;
  - een losse pagina op de pagina slepen maakt haar een subpagina (in de database onder de
    ouder, bij klant A); de lijst toont dan "2 subpagina's";
  - in de editor noemt het kruimelpad de bovenliggende pagina;
  - een subpagina naar een map slepen: `parent_id` is leeg, en ze staat in die map.
