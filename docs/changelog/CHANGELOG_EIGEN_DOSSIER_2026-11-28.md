# Inhoud: het eigen dossier in plaats van "Geen klant" (2026-11-28)

Derde deel van stap 1A-5 van het bouwplan (`docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §4
en §18).

## Wat er nu kan of klopt

- **Bovenaan de drive staat het eigen dossier**, met de naam en het logo van het bedrijf
  (uit Instellingen, de huisstijl).
  - Het staat er altijd, ook als het leeg is, en los van het sorteren.
  - Het vervangt "Geen klant": alles wat bij geen klant hoort, staat hier.
- **Het eigen dossier heeft mappen**, net als een klant. Daar hoort bijvoorbeeld het
  bedrijfshandboek: werkwijze, procedures, beleid en inwerken.
  - Wat er was: "Geen klant" had geen mappen. Alles stond daar los, ook wat in een map hoorde.
  - Nu kun je mappen maken en openen, en daarin notities, documenten, pagina's en bestanden
    zetten.
- **Verplaatsen naar…** biedt het eigen dossier bovenaan aan, met zijn mappen, ook voor
  mappen. Slepen naar het eigen dossier kan ook.

## Hoe het werkt

- `src/features/ContentLibrary.tsx`:
  - `ownDossier` en `hasFolders`: de mappenboom geldt nu ook zonder klant, met
    `content_folders` zonder klant en zonder project;
  - het eigen dossier is een vaste rij bovenaan (`topRows`);
  - nieuwe items in een map van het eigen dossier krijgen die map (`createTarget`).
- `src/lib/driveDnd.ts`: een map mag naar het eigen dossier. Vroeger blokkeerde dat:
  "moet bij een klant blijven".
- `src/components/MoveDialog.tsx`: het eigen dossier bovenaan, met zijn mappen.
- **De database hoefde niet te veranderen.** `content_folders.client_id` mocht al leeg zijn,
  en de dossierregel van de pagina's (migratie 20261127150000) telt "geen klant" als één
  dossier.

## Later die nacht: de vensters van notities en documenten

- **In het venster van een notitie of document heet de lege klantkeuze nu "Eigen dossier"**,
  in plaats van "Geen klant". Ook op de kaart van een document staat "Eigen dossier".
- **Met een project van een klant, maar zonder klant, staat het bij die klant**, zoals in de
  drive. Het venster noemt de lege keuze dan "Bakkerij Jansen (via het project)" en biedt de
  mappen van dat project aan, en de kaart zegt "Klant: Bakkerij Jansen". In een eerdere versie
  van deze nacht stond daar nog "Eigen dossier" (gevonden bij het nalopen; `contentPlace` in
  `src/lib/folders.ts`, met tests in `folders.test.ts`).
- **Het veld "Map" verschijnt ook zonder klant**, zodra het eigen dossier mappen heeft, of
  als er al een map gekozen is.
  - Eerst stond het er alleen bij een gekozen klant.
  - Een notitie die je in een map van het eigen dossier maakte, kreeg die map wel mee, maar
    je zag hem in het venster niet en kon hem niet wijzigen.
- **Waar "Geen klant" blijft, en waarom:**
  - Bij tickets, projecten, offertes, facturen, de agenda, uren, gesprekken en
    boekingslinks betekent het "aan geen klant gekoppeld", geen plek in de drive.
  - Bij versturen gaat "Geen klant — naar een los e-mailadres" over de ontvanger.
  - In de zoekresultaten stond het niet: inhoud zonder klant toont daar "Document" of het
    project. Wat hier eerder stond ("en in zoekresultaten"), klopte niet.
- **Getest:**
  - `ui.mjs paginadrive`, 6 stappen, 0 fout. De stap van het eigen dossier maakt nu ook een
    notitie in de eigen map: het venster toont "Eigen dossier" en de map, en in de database
    staat de notitie in die map zonder klant.
  - `ui.mjs documenten`: 10 stappen, 0 fout.
  - `npm test` en typecheck.

## Getest

- **Unit tests:** `npm test` (2339 gelukt) en `npm run typecheck`. `driveDnd.test.ts`: een map
  mag naar het eigen dossier (de oude test zei dat dat niet mocht).
- **`ui.mjs paginadrive`:** 5 stappen, 0 fout. De nieuwe stap:
  - de eerste rij van de drive is het eigen dossier, en "Geen klant" staat er niet meer;
  - "Nieuwe map" in het eigen dossier geeft een map zonder klant en project;
  - een pagina in die map staat daar in de database, zonder klant, en in de lijst.
- **Docker:** begrensd, in één opdracht.
