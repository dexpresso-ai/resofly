# Changelog — Mappenstructuur per klant (content folders) — 2026-06-16

Vervolg op de gecombineerde Inhoud-weergave (deel A). Dit is deel B uit het bouwplan:
per klant een hiërarchische mappenboom waarin notities en documenten **aangemaakt**,
**ingelezen** (bestaande items koppelen én externe bestanden uploaden) en **verplaatst**
kunnen worden.

## Toegevoegd
- Nieuwe tabel `public.content_folders` (migratie `20260616000002_content_folders.sql`):
  org-scoped, `client_id` (nullable — UI werkt per klant, kolom is flexibel voor latere
  organisatiebrede mappen), zelf-referentie `parent_id` voor hiërarchie, `name`, `position`.
  - RLS: lezen/schrijven uitsluitend voor actieve organisatieleden (zelfde patroon als notes/documents).
  - Triggers: automatische `updated_at`, `prevent_organization_id_change`, audit (`content_folder`),
    en `validate_content_folder` (bovenliggende map moet bij dezelfde organisatie + klant horen;
    cyclische structuren worden geblokkeerd).
- Kolom `folder_id` op `notes` en `documents` (`on delete set null`): koppelt een item aan een map.
  Bij het verwijderen van een map blijven notities/documenten bestaan; ze worden alleen ontkoppeld.
- `attachments.entity_type`-CHECK uitgebreid met `'folder'`, zodat bestanden rechtstreeks in een map
  geüpload kunnen worden via de bestaande Cloudflare R2-opslag.
- Nieuwe tab **Mappen** in het klantdossier (`ClientFolders` in `src/features/ClientFolders.tsx`):
  - Mappenboom met breadcrumbs; submappen aanmaken, hernoemen en verwijderen.
  - **Aanmaken**: "+ Notitie" / "+ Document" openen de centrale editor met de map (en klant) als default.
  - **Inlezen**: bestaande notities/documenten van de klant in een map plaatsen, én PDF/Word/afbeeldingen
    uploaden (verschijnen als bijlage op de map).
  - **Verplaatsen**: per item een mapkeuze-dropdown; "Niet ingedeeld" toont items zonder map.
- Herbruikbare helpers in `src/lib/folders.ts` (`clientFolderOptions`, `childFolders`,
  `folderDescendantIds`, `folderPath`) en `selectFolders` / `deleteContentFolder` in de repository.

## Aangepast
- `AppData` bevat nu `folders`; `loadAppData` laadt ze mee (met nette fallback als de migratie nog niet
  is uitgevoerd, net als documents/ticketNotes).
- De notitie- en documenteditor (`EditModal`) hebben een **Map**-keuze die verschijnt zodra een klant is
  gekozen; bij wisselen van klant wordt de mapkeuze gereset.
- `EntityType` kent nu `'folder'`; de repository registreert de tabel `content_folders`.

## Beveiliging / integriteit
- Mappen zijn strikt org-scoped via RLS; de hiërarchie-trigger voorkomt mappen onder een andere klant
  of organisatie en blokkeert cykels.
- Bij het verwijderen van een map worden submappen mee verwijderd (DB-cascade) en de geüploade bestanden
  van die mappen opgeruimd in R2; notities/documenten gaan nooit verloren (folder_id valt terug naar null).

## Nog te doen bij uitrol
- Migratie `20260616000002_content_folders.sql` op de database uitvoeren. Zonder deze migratie blijft de
  Mappen-tab leeg en geven map-acties een nette foutmelding (de app blijft verder werken).

## Niet gewijzigd
- Geen nieuwe npm-dependencies.
- Bestaande notities/documenten, hun bijlagen en de koppelingen met klant/project/agenda blijven intact.
- Mappen zijn voorlopig uitsluitend per klant (geen organisatiebrede mappen in de globale Inhoud-pagina).
