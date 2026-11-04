# Changelog — Gecombineerde Inhoud-weergave met notitie/document-filter — 2026-06-16

## Toegevoegd
- Nieuwe component `ContentLibrary` (`src/features/ContentLibrary.tsx`): notities en documenten staan nu samen in één **Inhoud**-overzicht.
  - Filter om elk type **snel aan/uit** te zetten (Notities ↔ Documenten) met een oog-/oog-uit-schakelaar in de zijbalk.
  - Gecombineerde, chronologisch gesorteerde lijst (nieuwste eerst) in zowel de zijbalk-lijst als het kaartenraster.
  - Hergebruikt de bestaande `NoteCard` en `DocumentCard`, dus uniforme kaartopmaak.
  - "+ Notitie" en "+ Document" direct vanuit het overzicht.

## Aangepast
- Nieuwe pagina-route `content` ("Inhoud"). De sidebar-ingang **Inhoud** opent dit overzicht; de subingangen **Overzicht / Notities / Documenten** deeplinken naar dezelfde pagina met de juiste filter voorgeselecteerd (via `initialView`, met `key={page}` zodat de filter per ingang vers is).
- `Sidebar` (`src/components/Sidebar.tsx`): "Inhoud" gedraagt zich nu als de kalender-ingang — een gewone navigatie-knop met een contextueel submenu wanneer je op een inhoudspagina staat (niet langer een puur uitklapbaar item).
- De losse paginacomponenten `Notes` en `Documents` zijn verwijderd; hun herbruikbare delen (`NoteCard`, `DocumentCard`, `RelatedNotes`, `RelatedDocuments`, labelhelpers) blijven behouden en worden hergebruikt.
- CSS uitgebreid met `.content-toggle` (oog-schakelaar) en `.content-actions`.

## Niet gewijzigd
- Geen database- of datamodelwijziging; `notes` en `documents` blijven losse tabellen.
- Geen nieuwe npm-dependencies.
- De note/document-editor (`EditModal`), bijlagen en koppelingen met klant/project/agenda blijven intact.
- `RelatedNotes`/`RelatedDocuments` in het klant- en projectdossier blijven ongewijzigd.

## Aandachtspunt
- De categoriefilter op `document_type` (oude Documenten-pagina) is vervangen door de type-schakelaar Notities/Documenten. Een subfilter per categorie kan later terugkomen als dat gewenst is — dit was onderdeel van het bredere plan (deel B: mappenstructuren per klant), dat nog openstaat.
