# Pagina's: de editor (2026-11-27)

Stap 1A-3a van het bouwplan voor pagina's (`docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`,
§5 en §18). Je kunt nu een pagina maken en bewerken: een webpagina in ResoFly, geen bestand.

## Wat er nu kan of klopt

- **Nieuw → Pagina** in de verkenner en in het klantdossier maakt een lege pagina op die
  plek, en opent hem meteen. In de lijst heet hij "Pagina".
- **De editor** (Tiptap) vult het hele scherm, met een rustige leeskolom:
  - titel bovenaan;
  - tekst, kop 1 tot 3, vet, cursief, onderstrepen en doorhalen;
  - links (alleen naar `https:`, `http:`, `mailto:` en `tel:`);
  - opsomming, nummering, takenlijst met vinkjes, citaat, code en scheidingslijn;
  - ongedaan maken en opnieuw.

  Sneltoetsen zoals `# ` voor een kop, `- ` voor een lijst en `[] ` voor een taak werken
  ook. Op een telefoon schuift de werkbalk opzij.
- **Opslaan gaat vanzelf**, anderhalve seconde na het typen. Bovenin staat "Opslaan…",
  "Niet opgeslagen" of "Opgeslagen".
  - Er gaat er één tegelijk, zodat er nooit een vals conflict ontstaat.
  - Openen zonder te typen verandert niets: geen nieuw "laatst gewijzigd" en geen regel in
    het logboek.
- **Eén tegelijk bewerken.**
  - Wie een pagina opent, bewerkt hem. Een collega die hem intussen opent, ziet "… bewerkt
    deze pagina", kan meelezen, en kan niet typen.
  - Komt de pagina vrij, dan laadt de editor van die collega hem vers en mag die verder.
  - Een collega neemt het pas over als de vorige twee minuten niets meer liet horen.
  - Opslaan kan alleen met een verse claim. Een laptop die na een uur slapen wakker wordt,
    schrijft dus niet over het werk van een ander heen.
- **Conflicten.** Schreef iemand anders er intussen in (Gerrie, de API, een overname), dan
  overschrijft de editor niets. Hij zegt het, en biedt "Opnieuw laden" aan. Mag je niet
  (meer) schrijven, dan zegt hij dat.
- **Sluiten** slaat eerst de laatste wijziging op. Daarna legt het een versie vast (alleen als
  er deze keer iets is opgeslagen) en laat het de pagina los. Mislukt dat opslaan, dan blijft
  de editor open, met "Toch sluiten". De terugknop van de telefoon sluit de editor ook. Wie
  het tabblad sluit met wijzigingen die nog niet zijn opgeslagen, krijgt een waarschuwing.
- **Een pagina delen of versturen kan nog niet**:
  - in het menu van een pagina staan Delen en Versturen niet;
  - de database weigert een deling;
  - een gedeelde map en een zending slaan pagina's over.

  Dat komt met de export (1B) en de vrijgave (1C). Anders ging de levende tekst naar buiten.
- **Gerrie vult geen tekst aan in een pagina.** De app biedt een pagina niet als doel aan, en
  Gerrie zegt bij een voorstel dat het nog niet kan. De titel aanpassen kan wel.

## Hoe het werkt

- `src/features/PageEditor.tsx` is een eigen stuk bundel. `main.tsx` laadt het pas als je een
  pagina opent (`lazyPage`). Bij de build staat Tiptap en ProseMirror alleen in
  `PageEditor-….js` (ongeveer 430 kB), niet in de bundel die bij elke start laadt.
- `src/lib/pageEditorExtensions.ts` bevat de extensies, zonder React. Tiptap 3.35.1 is MIT,
  en alle pakketten zijn nagekeken. Elk blok krijgt een vast id (UniqueID).
- `pageEditorExtensions.test.ts` bouwt in Node het schema van de editor, en controleert dat
  elk blok en elke opmaak in de lijst van de database staat (`pageSchema.ts`). Kan de editor
  iets maken wat de database weigert, dan faalt de test.
- `src/lib/repository.ts`: `loadPage`, `savePage` (alleen met de bekende `edit_version`),
  `claimPageEdit`, `releasePageEdit`, `savePageVersion` en `createPage`.
- De migratie `20261127130000` (nog niet op staging) is aangevuld: `drive_folder_leaves`, de
  map die je verstuurt, slaat pagina's over. De verzenddienst (`file-transfer`) slaat ook een
  losse pagina over, met een uitleg.

## Getest

- `tests/stromen/ui.mjs documenten`, 14 stappen, waarvan 4 nieuw:
  - Nieuw → Pagina, typen, en het staat als pagina in de database: de tekst in `content`,
    de opsomming als blok in `body`, een versie bij sluiten, en de claim los;
  - opnieuw openen toont de tekst. Openen zonder te typen laat `edit_version` en "laatst
    gewijzigd" staan;
  - een tweede collega ziet wie bewerkt, kan niet typen en krijgt geen werkbalk;
  - geen Delen of Versturen in het menu van een pagina. Op 390 pixels breed past de
    werkbalk en schuift hij opzij, en de status is direct na het openen "Opgeslagen".
- `pageEditorExtensions.test.ts`: het schema van de editor tegen de lijst van de database.
- `tests/database/paginas_datamodel.sql`: ook versturen neemt geen pagina mee.
- `npm test` (2321), `npm run typecheck`, `npm run test:database` (na de keten vanaf nul),
  `tests/stromen/documenten.mjs` (48), `npm run test:loading`, en `npm run test:mobile` voor
  de Inhoud-pagina's.
- `vite build`: de editor staat in een eigen stuk bundel.
- Gevonden en hersteld tijdens het testen: direct na het openen stond er "Niet opgeslagen".
  Tiptap meldt bij `setEditable` een update; de editor vergelijkt nu eerst met wat is
  opgeslagen.

## Om rekening mee te houden

- **Het slash-menu, de +-knop, tabellen, afbeeldingen, callouts en uitklappers** komen in
  1A-4.
- **Het versiepaneel en een eigen adres per pagina** komen in 1A-3b.
