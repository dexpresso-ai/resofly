# Changelog — Selecteren en slepen in de verkenner — 2026-09-02

De Inhoud-pagina zag eruit als de Verkenner, maar gedroeg zich er niet naar: je kon
niets aanvinken en niets verslepen. Verplaatsen ging alleen via ⋮ → “Verplaatsen naar…”,
één item tegelijk, en uploaden kon je alleen als je al ín de map stond. Vanaf nu pak je
gewoon vast wat je nodig hebt en laat je het vallen waar het hoort.

## Selecteren

- **Vinkje links van het icoon**, dat verschijnt zodra je over een rij gaat — zoals in
  OneDrive. Een rustige lijst blijft rustig, selecteren is één klik ver.
- **Ctrl/⌘-klik** zet er eentje bij of af, **Shift-klik** pakt alles tussen je vorige
  keuze en deze rij. Gewoon klikken blijft openen; had je nog iets aanstaan, dan wordt
  dat eerst opgeruimd, zodat je nooit iets opent terwijl er ongemerkt vijf dingen
  geselecteerd zijn.
- **Klant- en projectmappen kun je niet aanvinken.** Dat is navigatie, geen inhoud.
- Een **selectiebalk** boven de lijst met wat je ermee kunt: Verplaatsen naar…,
  Downloaden (alleen de echte bestanden erin, met het aantal erbij) en Verwijderen.
  Verwijderen verschijnt alleen als je selectie uit bestanden en mappen bestaat —
  notities en documenten verwijder je in de editor, net als elders in de app.
- Van map wisselen wist de selectie; wat uit beeld raakt (verplaatst, verwijderd,
  weggefilterd) valt er vanzelf uit. Een onzichtbare selectie kan nooit stilletjes
  meegaan met de volgende actie.

## Slepen

- **Sleep naar een map** om te verplaatsen. Zit wat je vastpakt in de selectie, dan gaat
  de hele selectie mee; anders alleen die ene rij.
- **Broodkruimels en “Terug” zijn ook doelen**, dus omhoog verplaatsen kan net zo goed.
- **Bestanden van je eigen computer op een maprij laten vallen** uploadt ze in die map —
  je hoeft er niet eerst in te gaan staan. Het grote uploadvlak onderin blijft doen wat
  het deed, maar reageert nu alleen nog op echte bestanden en niet meer op een sleep
  binnen de verkenner zelf.
- Waar iets kan landen licht op; waar het niet kan, kun je niet loslaten.

## De regels die vastliggen

In `src/lib/driveDnd.ts`, met tests (`driveDnd.test.ts`) — dit is precies het soort regel
dat je niet in een klikproef wilt ontdekken:

- **Een map kan niet in zichzelf**, en ook niet in een van zijn eigen submappen. Dat zou
  een lus in de mappenboom maken waar de verkenner nooit meer uitkomt.
- **Een geüpload bestand moet in een map blijven staan.** Het hangt aan zijn map via
  `attachments.entity_id`; buiten een map is er niets om het aan vast te maken. Notities
  en documenten mogen wél naar het niveau erboven.
- **Iets loslaten waar het al ligt is geen fout, maar ook geen actie.**
- Een gemengde selectie splitst zich netjes: wat kan gaat mee, wat niet kan wordt gemeld
  ná afloop — zodat je niet het verplaatsen kwijtraakt door één weigering.

## Toegevoegd / gewijzigd

- `src/lib/driveDnd.ts` (nieuw) — sleeplading + `planDriveMove`, de pure regels hierboven.
- `src/lib/useDriveSelection.ts` (nieuw) — selecteren met Ctrl/Shift, opschonen op wat
  zichtbaar is, en bepalen wat er meegaat als je gaat slepen.
- `src/lib/repository.ts` — `moveAttachmentToFolder`: zet `entity_id` om en laat de
  `storage_key` staan, zodat bestaande links, deellinks en openstaande Office-sessies
  blijven werken. Bypasst `updateRow` op dezelfde grond als `renameAttachment`
  (`attachments` heeft geen `updated_at`).
- `src/features/ContentLibrary.tsx` en `src/features/ClientFolders.tsx` — vinkjes,
  slepen, mappen en broodkruimels als doel, en de selectiebalk. Beide verkenners
  gedragen zich gelijk; het zou raar zijn als het in het klantdossier ánders werkte.
- `src/styles/globals.css` — `.odrv-check`, `.is-picked`, `.is-drop-target`,
  `.odrv-crumb-drop` en `.odrv-selbar`.

## Bewust niet

- **Geen dubbelklik-om-te-openen.** De Verkenner doet dat, deze app niet; dat omgooien
  zou iedereen die de drive al gebruikt tegen de schenen schoppen voor niets.
- **Slepen tussen klanten of projecten kan niet.** Een doel dat buiten de huidige scope
  ligt is geen doel: een item naar een andere klant slepen is een besluit, geen
  handbeweging.
- **Geen kopiëren met Ctrl-slepen.** Verplaatsen is wat hier ontbrak.

## Verificatie

- `tsc --noEmit`, `npm run build` (vite, 1907 modules) en `npm test` (94 tests, waarvan
  7 nieuw voor de sleepregels) slagen.
- **In een echte browser gecontroleerd** via een tijdelijke proefpagina met verzonnen
  data (daarna verwijderd), omdat de Inhoud-pagina achter een magic-link-login zit:
  - Ctrl-klik en Shift-klik selecteren zoals bedoeld; de selectiebalk telt goed
    (“3 items geselecteerd”, “Downloaden (1)” bij één bestand in een gemengde selectie)
    en verbergt Verwijderen zodra er een notitie bij zit.
  - `dragstart` op een bestandsrij zet de juiste lading klaar; de maprij accepteert de
    drop en licht op; `drop` loopt door tot de databaseaanroep.
  - Een map op zichzelf laten vallen wordt geweigerd — de rij accepteert de drop niet.
  - Een broodkruimel accepteert een notitie en weigert een bestand, precies zoals de
    regel voorschrijft.
  - Bestanden van de computer op een maprij worden geaccepteerd en gaan de uploadroute in.
- Geen database- of edge-functionwijziging: verplaatsen loopt via de bestaande
  RLS-gedekte updates op `notes`, `documents`, `content_folders` en `attachments`.
