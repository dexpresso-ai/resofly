# Pagina's: afbeeldingen (2026-11-27)

Tweede deel van stap 1A-4b van het bouwplan (`docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`,
§8 en §18). Het bestandsblok volgt in het laatste deel.

## Wat er nu kan of klopt

- **Een afbeelding toevoegen.** Typ `/afbeelding` of kies Afbeelding onder de +-knop, en
  kies een of meer plaatjes van je computer. Plakken en slepen kan ook.
  - Het plaatje wordt een bijlage van de pagina. Het telt mee in de opslag van je
    organisatie (hooguit 25 MB per bestand), en de organisatiegrens geldt.
  - Toegestaan zijn PNG, JPEG, GIF, WebP en AVIF. SVG bewust niet, want daar kan code in
    staan.
- **Een plaatje van buiten wordt niets.** Plak je tekst van een website met een
  `<img src="https://…">` erin, dan komt de tekst mee en het plaatje niet.
  - Wat het zou betekenen: een adres van buiten is in een klantpagina een volgpixel. De
    database weigert `src` (sinds 1A-1), en een blok zonder bestand zou elke volgende
    opslag laten mislukken.
- **Na het invoegen staat de cursor onder de afbeelding.**
  - Wat misging: de afbeelding bleef geselecteerd, en de volgende toets of het volgende
    geplakte plaatje verving hem.
- **Een verdwenen afbeelding**, of een die je niet mag zien, toont "Afbeelding niet
  gevonden". Dat geldt ook in de voorvertoning van een oude versie.
- **De voorvertoning van een versie** toont afbeeldingen en de titels van subpagina's.
  Openen en uploaden kan daar niet.

## Hoe het werkt

- `src/lib/pageEditorExtensions.ts`: het blok `image`, met alleen `attachmentId` (en `alt`),
  nooit een adres.
  - Het adres om te tonen is een blob-URL. De worker wil een Bearer-token, en dat kan een
    `<img>` niet sturen. Die blob-URL leeft alleen in de weergave. Zat hij in body, dan zou
    elke opening de pagina wijzigen en opslaan.
  - Plakken en slepen van plaatjes doet een eigen ProseMirror-plugin.
  - `cursorOnText` staat nu hier, zodat menu en afbeeldingen dezelfde regel volgen.
- `src/features/PageEditor.tsx` vult `editor.storage.image.media`:
  - uploaden via `uploadToR2` (entity_type `document`, de pagina als entity_id);
  - tonen via `attachmentStorageKey` en `fetchStoredFileBlob`.

  De blob-URL's gaan weg als de editor sluit.
- `src/lib/repository.ts`: `attachmentStorageKey`. Die geeft gewoon null bij een verdwenen
  bijlage, zonder foutmelding van de server; `loadAttachmentRef` gaf daar een 406.
- `src/features/PageBlockMenu.tsx`: `/afbeelding` opent een bestandskiezer.
  - Wat misging: het invoerveld hing los, en dat kon de browser opruimen voordat de keuze
    binnen was.
  - Nu hangt het in de pagina zolang je kiest.

## Om rekening mee te houden

- **De controle bij opslaan** (migratie 20261127150000) laat een afbeelding uit een ander
  dossier niet toe. Een afbeelding van deze pagina mag altijd.
- **Bijschrift en breedte** zitten er nog niet in. `alt` staat al in het blok, maar is nog
  niet te bewerken.
- **Verwijder je de pagina, dan ruimt de app haar bijlagen op**, zoals bij elk document. Bij
  subpagina's die mee verdwijnen gebeurt dat nog niet (zie 1A-5).

## Getest

- **Unit tests:** `npm test` (2338 gelukt) en `npm run typecheck`.
- **`tests/stromen/ui.mjs documenten`**, met een nep-worker voor uploaden en ophalen:
  25 stappen, 0 fout. De nieuwe stap:
  - `/afbeelding` met de bestandskiezer: de afbeelding staat in beeld. In de database is
    het een bijlage van de pagina, het blok wijst ernaar, en er staat geen adres in body.
  - Daarna typen komt onder de afbeelding.
  - Een plaatje als bestand plakken geeft een tweede afbeelding. HTML met een plaatje van
    buiten geeft alleen de tekst, en het adres staat niet in body.
  - Opnieuw openen: beide afbeeldingen komen terug, en `edit_version` en "laatst gewijzigd"
    blijven gelijk.
  - Na het verwijderen van de bijlage staat er "Afbeelding niet gevonden".
