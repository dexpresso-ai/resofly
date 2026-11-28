# Pagina's: subpagina's, en verwijzingen die bij de pagina horen (2026-11-27)

Eerste deel van stap 1A-4b van het bouwplan (`docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`,
§4, §8 en §18). Afbeelding en bestand volgen in het tweede deel.

## Wat er nu kan of klopt

- **Een subpagina maken.** Typ `/pagina` (of kies Subpagina onder de +-knop). Er komt een
  nieuwe pagina onder deze, en in de tekst een regel met haar titel.
  - De subpagina hoort automatisch bij dezelfde klant en hetzelfde project, zonder eigen
    map (de database regelt dat, §4).
  - Hernoem je de subpagina, dan toont de regel de nieuwe titel.
- **Een subpagina openen.** Een klik op de regel opent haar. De pagina die je verlaat, wordt
  eerst opgeslagen en krijgt een versie, en de claim gaat los. Het adres in de adresbalk
  verandert mee.
- **Omhoog.** Op een subpagina staat links in de balk een knop met de titel van de
  bovenliggende pagina. Op een telefoon is dat alleen een pijltje.
- **De terugknop volgt de weg die je ging.** Van pagina naar subpagina en weer omhoog: terug
  brengt je stap voor stap terug, en pas aan het begin gaat de pagina dicht.
- **Bestaat de subpagina niet meer, of mag je haar niet zien?** Dan staat er "Pagina niet
  gevonden", en klikken doet niets.
- **Verwijzingen horen bij de pagina.**
  - Wat misging: een pagina verwijst met een id naar een afbeelding, een bestand of een
    subpagina, en de database keek alleen of dat op een id leek. Via de API, Gerrie of een
    geplakt blok kon zo een id uit een andere organisatie of een ander dossier erin komen,
    en de editor liet dan de naam zien.
  - Nu weigert de database:
    - een afbeelding of bestand uit een andere organisatie of een ander dossier;
    - als subpagina: een pagina van een andere organisatie, een tekstdocument, of de pagina
      zelf.
  - Alleen nieuwe verwijzingen worden nagekeken. Verhuist of verdwijnt een bestand later,
    dan kun je de pagina gewoon verder bewerken.
  - Een verwijzing naar iets dat niet meer bestaat, mag. Zo kun je een oude versie
    terugzetten waarin een inmiddels verwijderde afbeelding stond.

## Hoe het werkt

- Migratie `20261127150000_paginas_verwijzingen.sql`:
  - `page_body_refs()` haalt de verwijzingen uit een body;
  - `page_attachment_dossier()` zoekt het dossier van een bijlage, met dezelfde regel als
    `drive_item_client`: de klant van het project gaat voor;
  - de trigger `documents_page_verwijzingen` kijkt de nieuwe verwijzingen na. Hij heet zo
    zodat hij na `documents_page_tree` draait: een nieuwe subpagina heeft dan al de klant
    van haar ouder.
- `src/lib/pageEditorExtensions.ts`: het blok `subpage`.
  - De titel staat niet in body. Het blok haalt hem op via `editor.storage.subpage.links`,
    dat de editor vult. Zo blijft dit bestand vrij van de database en in Node te toetsen.
  - Een geplakt subpagina-blok zonder geldig id wordt niet overgenomen. Anders weigerde de
    database elke volgende opslag.
- `src/lib/repository.ts`: `createPage` met `parent_id`, en `pageTitle`.
- `src/features/PageEditor.tsx`:
  - `close()` kan nu naar een volgende pagina;
  - de knop omhoog;
  - de terugknop met `backTo`.
- `src/main.tsx`:
  - de weg langs pagina's (`pageTrail`);
  - `key` op de editor: een andere pagina is een verse editor, zonder claim of
    geschiedenis van de vorige.

## Om rekening mee te houden

- **De boom zie je nog niet in de drive.** Een subpagina staat tot stap 1A-5 als losse
  pagina in het dossier.
- **Haal je het blok weg, dan blijft de subpagina bestaan.** De prullenbak, met
  subpagina's, komt in 1A-5.
- **Verwijder je een pagina met subpagina's, dan verdwijnen die ook** (de database doet dat
  al sinds 1A-1). Hun bijlagen ruimt de app dan nog niet op: dat hoort bij de prullenbak
  en de opruimwachtrij in 1A-5.

## Getest

- **Unit tests:** `npm test` (2338 gelukt), `npm run typecheck`, en `pageBlocks.test.ts`:
  `/pagina` en `/sub` geven de subpagina.
- **Database:** de migratie twee keer achter elkaar toegepast, en `npm run test:database`
  met het nieuwe `paginas_verwijzingen.sql` (12 controles):
  - toegelaten: een afbeelding van de pagina zelf, een bestand uit hetzelfde dossier, een
    subpagina, en een verwijzing naar iets dat niet meer bestaat;
  - geweigerd: een ander dossier, een andere organisatie, een tekstdocument of de pagina
    zelf als subpagina, en een bestand van een klant in een pagina zonder klant, ook bij
    een nieuwe pagina;
  - een bestaande verwijzing houdt verder bewerken niet tegen.
- **`tests/stromen/ui.mjs documenten`:** 24 stappen, 0 fout. De nieuwe stap:
  - `/pagina` maakt de subpagina, onder klant A en zonder map, en het blok wijst ernaar;
  - openen: de claim op de bovenliggende pagina is los, en het adres volgt;
  - een titel en tekst typen, en omhoog: het blok toont de nieuwe titel;
  - terug, terug, terug: subpagina, bovenliggende pagina, dicht;
  - na het verwijderen van de subpagina staat er "Pagina niet gevonden", en klikken doet
    niets.
- **Terugknop:** `npm run test:terugknop`, 18 gelukt.
