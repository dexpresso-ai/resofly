# Changelog — Selecteren met de muis, zoals in de Verkenner — 2026-09-03

Aanvinken, Ctrl-klik en Shift-klik bestonden al. Wat ontbrak was wat je in de Verkenner
van Windows als eerste doet: op een lege plek drukken, slepen, en alles wat het kader raakt
is geselecteerd. Dat kan nu in beide verkenners (Inhoud én klantdossier > Bestanden), in de
lijst- én de tegelweergave.

## Wat je nu kunt

- **Slepen op lege ruimte tekent een selectiekader.** Alles wat het kader raakt, in welke
  richting je ook sleept, wordt geselecteerd. De selectiebalk telt mee.
- **Shift voegt toe** aan wat er al aanstond; **Ctrl (⌘ op een Mac) schakelt om**: wat aan
  stond gaat uit, wat uit stond gaat aan. Beide worden vanuit de selectie bij het begin van
  de sleep berekend, dus een rij die het kader in- en weer uitloopt valt netjes terug op
  zijn oude stand.
- **Klikken op lege ruimte wist de selectie** (zonder Ctrl of Shift), net als in de Verkenner.
- **Escape** midden in een sleep breekt af en zet de selectie terug.
- **Ctrl+A** selecteert alles in de open map zodra de lijst de focus heeft — die krijgt hij
  vanzelf bij een druk op lege ruimte.
- **Sleep je tegen de rand aan, dan scrolt de lijst mee** (of de pagina, in het klantdossier),
  sneller naarmate je verder voorbij de rand zit.

## Wat bewust niet meedoet

- **Klant- en projectmappen** zijn navigatie, geen inhoud: het kader slaat ze over, net als
  het vinkje dat al deed.
- **Kolomkoppen, de selectiebalk, knoppen, invoervelden en menu's** zijn geen lege ruimte;
  daar begint geen kader. De schuifbalk ook niet.
- **Alleen met de muis.** Met een vinger is slepen scrollen; dat blijft zo.
- **Slepen vanaf een rij blijft verplaatsen** (HTML5-drag), precies zoals gisteren gebouwd.
- **Enkele klik blijft openen.** De Verkenner selecteert op enkele klik en opent op dubbele;
  dat omgooien zou iedereen die de drive al gebruikt tegen de schenen schoppen.

## Code

- `src/lib/marquee.ts` (nieuw) — de rekenregels zonder DOM: `marqueeBox`, `boxesIntersect`,
  `hitKeys`, `marqueeMode` (Ctrl/⌘ → omschakelen, Shift → toevoegen, anders vervangen),
  `combineMarquee`, `passedThreshold` (4 px), `edgeScrollSpeed` en `clampPoint`. Tests in
  `marquee.test.ts` (10) draaien mee in `npm test`.
- `src/lib/useMarqueeSelection.ts` (nieuw) — de muisafhandeling: `mousedown` op de
  scrollende lijst (`.odrv-scroll`), `mousemove`/`mouseup` op `window` zodat de sleep
  doorloopt buiten de lijst, `requestAnimationFrame`-lus voor het meescrollen. Het kader
  leeft in de inhoudscoördinaten van de lijst en scrolt dus gewoon mee; rijen en tegels
  melden zich aan met `data-selkey`. Een openstaand naamveld wordt eerst netjes
  afgesloten (blur → bevestigen) voordat het kader begint.
- `src/lib/useDriveSelection.ts` — `snapshot()` (de selectie op het moment van de
  muisdruk, via een ref) en `replace(set)` (de hele selectie in één keer, gesnoeid op wat
  selecteerbaar is).
- `src/features/ContentLibrary.tsx` en `src/features/ClientFolders.tsx` — de lijst krijgt
  `ref`, `tabIndex={-1}` en `onMouseDown`; rijen en tegels `data-selkey`; het kader zelf
  als `.odrv-marquee`; Ctrl+A op de wortel van de verkenner.
- `src/styles/globals.css` — `.odrv-scroll{position:relative}` (referentievlak van het
  kader), `.is-marquee` (geen tekstselectie, rijen tijdelijk zonder hover) en `.odrv-marquee`
  (goudkleurige vulling met dunne rand).

## Verificatie

- `tsc --noEmit`, `npm run build` en `npm test` (111 tests, waarvan 10 nieuw) slagen.
- **In een echte browser gecontroleerd** via een tijdelijke proefpagina met verzonnen data
  (daarna verwijderd) met synthetische muisgebeurtenissen:
  - kader vanaf de lege ruimte onder de lijst omhoog over drie rijen: kader zichtbaar, de
    drie rijen aangevinkt, klant- en projectmap overgeslagen, “3 items geselecteerd”;
  - loslaten: kader weg, selectie blijft; Ctrl-slepen over één rij zet die uit; Shift-slepen
    zet een rij erbij; Escape midden in de sleep zet het kader weg en de selectie terug;
  - klik op lege ruimte wist de selectie; Ctrl+A pakt alle vier selecteerbare rijen;
  - een open ⋮-menu sluit bij een druk op lege ruimte (de bestaande `mousedown`-luisteraar
    blijft werken); een druk op de selectiebalk start géén kader;
  - tegelweergave: kader over de eerste tegel selecteert precies die ene.
