# Changelog — Klantdossier "Bestanden" als cloud-drive — 2026-06-20

Het klantdossier had drie losse tabbladen voor inhoud — **Notities**, **Documenten**
en **Mappen** — wat versnipperd en onoverzichtelijk aanvoelde. De Mappen-tab zelf was
bovendien een stapel losse secties met een rij knoppen. Op verzoek is dit herontworpen
tot één samenhangende **cloud-drive** ("Bestanden") die aanvoelt als Google Drive /
OneDrive: mappen én bestanden in één navigeerbare ruimte.

## Toegevoegd / gewijzigd
- **Eén "Bestanden"-tab** vervangt de tabbladen Notities, Documenten en Mappen in het
  klantdossier (`src/features/Clients.tsx`). De `ClientTab`-union, de tab-lijst en de
  zoekbalk-conditie zijn daarop aangepast; ongebruikte `filteredNotes`/`filteredDocuments`-
  memo's en de `noteMatchesQuery`/`documentMatchesQuery`-helpers zijn verwijderd.
- **`ClientFolders` herbouwd tot een cloud-drive** (`src/features/ClientFolders.tsx`):
  - **Padbalk** (Klant › Map › Submap) met klikbare niveaus.
  - **Eén "+ Nieuw"-menu**: nieuwe map/submap, notitie, document, bestand uploaden en
    (binnen een map) bestaande inhoud koppelen — i.p.v. vijf losse knoppen.
  - **Mappen én bestanden in één raster**, netjes gegroepeerd ("Mappen" + "Bestanden" /
    "Niet ingedeeld"), met type-gekleurde iconen (map, notitie, document, PDF, afbeelding).
  - **Grid- én lijstweergave** met een toggle; de keuze wordt onthouden in `localStorage`
    (`resofly:driveView`).
  - **Rustig ⋮-menu per item** (openen, verplaatsen-naar met mappenlijst, hernoemen,
    downloaden, verwijderen) i.p.v. altijd-zichtbare icoontjes.
  - **Slepen-om-te-uploaden** binnen een map, met een drop-zone-hint en zoeken binnen de map.
  - Vriendelijke **lege staat** met cloud-icoon en uitleg.
- **CSS** uitgebreid met een `.drive-*`-blok in `src/styles/globals.css` (refreshed tokens:
  `--accent`, `--accent-soft`, `--panel-strong`, `--border-strong`, `--shadow`).

## Doorgetrokken naar de globale Inhoud-pagina
- `ContentLibrary` (`src/features/ContentLibrary.tsx`) gebruikt nu dezelfde cloud-drive-taal:
  `.drive-bar` met **padbalk + zoeken + grid/lijst-toggle**, mappen (klant/project) en items
  (notitie/document) als `.drive-card`/`.drive-row` met type-gekleurde iconen, en `.drive-group`-
  secties. De grid/lijst-voorkeur deelt dezelfde `localStorage`-key (`resofly:driveView`) als de
  klantdossier-drive, zodat de weergave consistent is.
- De zoekbalk verhuisde van de zijbalk naar de drive-bar (rechtsboven); de zijbalk houdt de
  klantnavigator + de Notities/Documenten-schakelaars. `NoteCard`/`DocumentCard` worden hier niet
  meer gebruikt (compacte drive-kaarten i.p.v. voorbeeldkaarten); de afgeleide klant→project→item-
  boom, breadcrumbs, deeplinks (`initialView`) en `ContentCreateTarget`-wiring blijven ongewijzigd.

## Niet gewijzigd
- Geen database-, datamodel- of migratiewijziging: de drive leidt alles af uit de bestaande
  `notes`/`documents` (`client_id`/`project_id`/`folder_id`), `content_folders` en
  `attachments` (entity_type `folder`).
- De aanmaak-/bewerk-editor (`EditModal`) en de wiring van `onNewNote`/`onNewDocument`
  (client- + folder-default) zijn ongewijzigd hergebruikt.
- `RelatedNotes`/`RelatedDocuments` blijven bestaan en in gebruik op andere plekken
  (projectpagina, globale Notities/Documenten); alleen de client-dossier-tabs gebruiken ze
  niet meer.
- De bestaande `.folder-*`-CSS blijft staan (niet langer gebruikt door `ClientFolders`/
  `ContentLibrary`, maar ongemoeid gelaten om risico te beperken).

## Verificatie
- `tsc --noEmit` en `npm run build` (vite, 1805 modules) slagen zonder fouten.
- De ingelogde pagina is niet live gerenderd: inloggen vereist een magic-link, dus de drive
  is geverifieerd via typecheck/build en code-review, conform eerdere changelogs.
