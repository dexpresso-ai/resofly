# Changelog — Inhoud als klant→project mappenboom — 2026-06-17

De globale **Inhoud**-pagina was een platte, chronologische lijst van notities en
documenten. Op verzoek is dit een hiërarchische mappenboom geworden waarin **elke
klant een hoofdmap** is, **elk gekoppeld project een submap** binnen die klant, met
daaronder de bijbehorende notities en documenten. Doel: per klant snel overzicht
houden én gericht inhoud aanmaken.

## Toegevoegd
- `ContentLibrary` (`src/features/ContentLibrary.tsx`) is herbouwd tot een navigator met
  drie niveaus:
  1. **Wortel — Klanten:** elke klant is een mapkaart (met item- en projecttelling),
     plus een "Geen klant"-map voor inhoud zonder klant. Elke klant is zichtbaar — ook
     zonder inhoud — zodat je overal direct kunt beginnen.
  2. **Klant:** submappen voor de gekoppelde projecten (alle niet-gearchiveerde projecten
     van de klant + projecten met inhoud), plus een sectie **Losse inhoud** voor items die
     wél bij de klant maar niet bij een project horen.
  3. **Project:** de notities en documenten binnen dat project.
- **Breadcrumbs** (Alle klanten › Klant › Project) en een **klantnavigator + zoekbalk** in
  de zijbalk om snel tussen klanten te springen en binnen de huidige map te filteren.
- **Contextueel aanmaken:** "+ Notitie" / "+ Document" vullen automatisch de klant (en op
  projectniveau ook het project) van de open map voor in de editor.

## Aangepast
- De structuur wordt **rechtstreeks afgeleid** uit de bestaande `client_id`/`project_id`-
  koppeling op `notes` en `documents` — een item met een project hoort bij de klant van dat
  project. Geen database- of datamodelwijziging, geen migratie.
- De type-schakelaar **Notities/Documenten** en de deeplinks Overzicht/Notities/Documenten
  (`initialView`) blijven werken.
- `ContentLibrary`-props `onNewNote`/`onNewDocument` accepteren nu een optionele
  `ContentCreateTarget` (`{ client_id, project_id }`); de wiring in `main.tsx` geeft die door
  als defaults aan de editor.
- CSS uitgebreid met `.content-search` en `.content-nav` / `.content-nav-row`; de bestaande
  mappen-CSS (`.folder-grid`, `.folder-card`, `.folders-crumbs`, `.folder-section`) wordt
  hergebruikt.

## Niet gewijzigd
- Geen nieuwe npm-dependencies.
- De per-klant **Mappen**-tab (`ClientFolders`, `content_folders`-tabel, `folder_id`) blijft
  intact en ongemoeid; dit is een aanvullende, automatische ordening op de globale pagina.
- `NoteCard`/`DocumentCard` en de editor (`EditModal`) zijn ongewijzigd hergebruikt.

## Verificatie
- `tsc --noEmit` en `npm run build` (vite, 1800 modules) slagen zonder fouten; de app boot
  foutloos. De ingelogde pagina is niet live gerenderd omdat login een magic-link vereist.
