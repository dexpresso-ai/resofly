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

## Om rekening mee te houden

- **Elders in de app heet het nog "Geen klant"**, bijvoorbeeld bij versturen en in
  zoekresultaten. Dat volgt later.

## Getest

- **Unit tests:** `npm test` (2339 gelukt) en `npm run typecheck`. `driveDnd.test.ts`: een map
  mag naar het eigen dossier (de oude test zei dat dat niet mocht).
- **`ui.mjs paginadrive`:** 5 stappen, 0 fout. De nieuwe stap:
  - de eerste rij van de drive is het eigen dossier, en "Geen klant" staat er niet meer;
  - "Nieuwe map" in het eigen dossier geeft een map zonder klant en project;
  - een pagina in die map staat daar in de database, zonder klant, en in de lijst.
- **Docker:** begrensd, in één opdracht.
