# Pagina's: bestanden in een pagina (2026-11-28)

Laatste deel van stap 1A-4b van het bouwplan (`docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`,
§8 en §18). Daarmee is stap 1A-4 klaar.

## Wat er nu kan of klopt

- **Een bestand invoegen.** Typ `/bestand` (of kies Bestand onder de +-knop). Er gaat een
  kiezer open:
  - **uit dit dossier**, met zoeken. De kiezer toont alleen bestanden uit het dossier van de
    pagina. Dat is precies wat de database bij opslaan aanneemt; anders kon je iets kiezen
    waarna de pagina niet meer opsloeg;
  - **van je computer**. Het bestand wordt een bijlage van de pagina zelf.
- **Een bestand slepen of plakken** uit een verkenner wordt een bestandsblok.
  - Wat misging: de browser opende de PDF, en je verliet de app.
  - Plaatjes worden nog steeds een afbeelding.
- **Het blok** toont de naam en de grootte. Een klik slaat het bestand op je computer op.
  - Het opent nooit in de app. Een blob-URL draait in de herkomst van de app, zonder de
    sandbox die de worker meestuurt; een geüpload HTML-bestand zou dan als de app draaien.
- **Een verdwenen bestand**, of een dat je niet mag zien, toont "Bestand niet gevonden", en
  klikken doet niets. Dat geldt ook in de voorvertoning van een oude versie.
- **Knoppen in een blok laten de cursor in de tekst staan**: bestand, subpagina en de koppen
  in de inhoudsopgave.
  - Wat misging: een klik zette de focus op de knop, en wat je daarna typte ging verloren.

## Hoe het werkt

- `src/lib/pageEditorExtensions.ts`:
  - het blok `fileBlock`, met alleen `attachmentId`. Naam en grootte haalt het blok op, want
    die kunnen veranderen;
  - `insertFiles` kijkt eerst of er hier een bestand mag staan, en uploadt pas daarna;
  - plakken en slepen sturen plaatjes naar een afbeelding en de rest naar een bestandsblok.
- `src/features/PageFilePicker.tsx`: de kiezer. Escape en de terugknop sluiten hem. Op een
  telefoon komt hij als paneel van onderen.
- `src/features/PageEditor.tsx` vult in `editor.storage.image.media` ook `fileInfo`,
  `download` en `chooseFile`.
- `src/lib/repository.ts`:
  - `attachmentInfo` (maybeSingle, dus geen fout bij een verdwenen bestand);
  - `listDossierFiles`, met de dossierregel van migratie 20261127150000: de klant van het
    project gaat voor.

## Om rekening mee te houden

- **Haal je een bestandsblok weg, dan blijft het bestand bestaan.** Een bestand uit het
  dossier blijft daar staan. Een geüpload bestand blijft een bijlage van de pagina, tot de
  pagina weg is (opruimen: 1A-5).
- **Een voorvertoning in de pagina** (een PDF tonen) zit er niet in. Opslaan en dan openen
  kan wel.

## Getest

- **Unit tests:** `npm test` (2339 gelukt) en `npm run typecheck`. `pageBlocks.test.ts`:
  `/bestand` en `/pdf` geven het bestand, `/afb` en `/foto` de afbeelding.
- **`tests/stromen/ui.mjs documenten`:** 26 stappen, 0 fout. De nieuwe stap:
  - de kiezer toont het bestand uit het dossier van klant A, en niet dat van klant B;
  - kiezen geeft een blok met naam en grootte, en daarna typen komt onder het blok;
  - in body wijst het blok naar het dossierbestand;
  - een klik geeft een download met de juiste naam, en de app opent niets;
  - van de computer: via de bestandskiezer, als bijlage van de pagina;
  - een gesleepte PDF wordt een bestandsblok en een bijlage van de pagina;
  - na het verwijderen van het dossierbestand staat er "Bestand niet gevonden".
