# Pagina's: tabel, callout, uitklapper, inhoudsopgave en het blokmenu (2026-11-27)

Stap 1A-4a van het bouwplan voor pagina's (`docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §3
en §18). Afbeelding, bestand en subpagina volgen in 1A-4b.

## Wat er nu kan of klopt

- **Het blokmenu.**
  - Typ `/` in de tekst en het menu gaat open. Wat je erna typt, filtert, ook op andere
    woorden: `/tab`, `/kop2`, `/h2`, `/toggle`, `/let op`.
  - Pijltjes kiezen, Enter voegt in, Escape sluit het menu (niet de pagina).
  - Vooraan in de werkbalk staat een **+-knop** met hetzelfde menu. Op een telefoon komt
    het als paneel van onderen, en de terugknop sluit eerst het menu.
  - Het menu toont alleen wat op die plek kan: geen tabel in een tabel, geen kop in een
    callout.
- **De gewone tabel.** Een tabel begint met een kopregel en drie kolommen. Staat de cursor
  erin, dan komt er een tweede balk:
  - rijen en kolommen erbij, verplaatsen en weghalen;
  - de kopregel aan of uit;
  - cellen samenvoegen en splitsen;
  - links, midden of rechts uitlijnen.

  Een kolom maak je breder door de rand te slepen. Plak je een stuk uit Excel of Word, dan
  wordt dat een tabel. De stijl van buiten gaat niet mee; alleen het uitlijnen.
  Op een telefoon schuift een brede tabel binnen de pagina, ook als je alleen leest.
- **De callout**, een gekleurd kader met een icoon, in vier soorten: info, tip, let op en
  waarschuwing. De soort kies je in de balk die verschijnt als de cursor erin staat.
- **De uitklapper.** Een kopregel met tekst die je in- en uitklapt. Een nieuwe uitklapper
  staat open, zodat je meteen verder typt.
- **De inhoudsopgave** tekent zichzelf uit de koppen van de pagina en loopt bij terwijl je
  typt. Een klik springt naar de kop.
- **Een pagina met een blok dat de app niet kent, gaat niet open om te bewerken.**
  - Wat misging: Tiptap maakt van zo'n pagina stilletjes een lege pagina. De eerste toets
    schreef die lege pagina dan over de echte heen.
  - Nu zie je de melding "Ververs de app" met een knop. De pagina blijft alleen-lezen,
    zonder claim, en er wordt niets opgeslagen.
  - Is de inhoud kapot, dan helpt verversen niet. Dan zegt de app dat de inhoud niet klopt,
    zonder knop.
  - Hetzelfde geldt voor vers laden en terugzetten, en voor de voorvertoning van een versie.
- **Na een scheidingslijn of inhoudsopgave staat de cursor op een tekstregel.**
  - Wat misging: Tiptap zette de selectie op het blok erna. Onder een lijn boven een tabel
    werd de hele tabel geselecteerd, en de volgende toets overschreef hem.
  - Dat gold ook voor de knop Scheidingslijn in de werkbalk (sinds 1A-3a, boven een lijst
    of citaat). Die gaat nu dezelfde weg als het menu.
  - `---` aan het begin van een regel deed het al goed.

## Hoe het werkt

- `src/lib/pageEditorExtensions.ts`:
  - TableKit, de drie delen van Details, en twee eigen blokken: `callout` en
    `tableOfContents`.
  - Kolombreedtes slepen zet `PageColumnResizing` aan. Tiptap deed dat alleen als de editor
    bij het maken al bewerkbaar was; de onze wordt dat pas na de claim.
  - Alle pakketten zijn MIT (Tiptap 3.35.1). `extension-text-style` is alleen een peer van
    Details en wordt niet geregistreerd.
- `src/lib/pageBodyCheck.ts`: past de opgeslagen pagina in de editor? De editor kijkt dat na
  vóór hij iets laadt.
- `src/lib/pageBlocks.ts`: de lijst van het menu en het zoeken erin. Zonder Tiptap, getoetst
  in Node.
- `src/features/PageBlockMenu.tsx`: wat elk blok doet, de `/`-ingang (Tiptap Suggestion) en
  het menu zelf.
- `src/features/PageEditor.tsx`: de +-knop, de balken voor tabel, callout en uitklapper, en de
  grendel.
- Migratie `20261127140000_paginas_blokken.sql`. De database kijkt nu ook na wat er in de
  blokken staat:
  - de maten van een tabelcel alleen als hele getallen;
  - uitlijnen alleen links, midden of rechts;
  - de soort callout alleen uit de lijst.

  Waarom: Tiptap zet `colwidth` zonder controle in een style-attribuut (`createColGroup`). De
  CSP laat plaatjes van elk https-adres toe, dus met tekst als breedte kon er een volgpixel
  in de pagina komen. De lijsten staan in `page_body_allowed()`, met de spiegel in
  `pageSchema.ts`.

## Om rekening mee te houden

- **Ververs open tabbladen na de merge naar staging.** Een tabblad dat de editor al geladen
  had, draait de oude editor nog. Die kent de nieuwe blokken niet en heeft de grendel nog
  niet: opent hij een pagina met een tabel, dan ziet hij een lege pagina, en typen schrijft
  die weg. Vanaf deze versie houdt de grendel dat tegen voor elk blok dat later nog komt.
- **Open of dicht van een uitklapper wordt niet bewaard.** Anders zou alleen al uitklappen de
  pagina wijzigen en opslaan. Na het openen van de pagina staat elke uitklapper dicht. Enter
  in de kopregel van een dichte uitklapper maakt een nieuwe regel eronder, zoals in Notion.
- **Een callout bevat tekst en lijsten.** Geen koppen, tabellen of andere callouts.
- **Kolommen** (twee of drie naast elkaar) zitten er nog niet in. Ze mogen naar fase 2 (§3).
- **Het stuk bundel van de editor is groter**: 546 kB, was ongeveer 430 kB. Het laadt nog
  steeds pas als je een pagina opent.

## Getest

- **Unit tests:** `npm test` (2337 gelukt) en `npm run typecheck`.
- **Nieuwe unit tests:**
  - `pageBodyCheck.test.ts`: onbekende blokken en opmaak, een blok op de verkeerde plek, en
    tabelcellen met tekst of een stijl als maat;
  - `pageBlocks.test.ts`: zoeken in het menu;
  - `pageEditorExtensions.test.ts`: elk nieuw blok past;
  - `pageSchema.test.ts`: de soorten callout en het uitlijnen zijn die van de database.
- **Database:** `npm run test:database`, met het nieuwe `paginas_blokken.sql`:
  - een pagina met elk nieuw blok;
  - de platte tekst in leesvolgorde;
  - een breedte met een stijl erin, tekst als colspan, een halve rij, uitvullen, en een
    onbekende soort callout worden geweigerd.

  De migratie is twee keer achter elkaar toegepast.
- **`tests/stromen/ui.mjs documenten`**, in Chromium: 23 stappen, waarvan 7 nieuw.
  1. `/tab` maakt een tabel met kopregel. Daarna typen, een rij erbij, rechts uitlijnen en
     een kolom breder slepen; alles staat zo in `body`.
  2. Callout (als waarschuwing), uitklapper en inhoudsopgave via het menu.
     - In een callout vindt `/kop` niets, en Escape sluit het menu en niet de pagina.
     - De uitleg staat ín de uitklapper, en in- en uitklappen slaat niets op.
     - Na de inhoudsopgave typ je gewoon verder.
  3. Plakken uit Excel wordt een tabel, zonder het adres uit de stijl van de cel.
  4. Opnieuw openen met elk blok verandert `edit_version` en "laatst gewijzigd" niet, en
     "Ongedaan maken" staat uit.
  5. Een pagina met `columns` (via SQL) gaat open met "Ververs de app": alleen lezen,
     geen claim, geen versie, en de rij blijft gelijk.
  6. Op 390 pixels breed:
     - de +-knop opent het paneel, en terug sluit het menu;
     - een lijn boven de tabel geeft een eigen regel, en de tabel blijft heel;
     - de brede tabel schuift binnen de pagina, ook voor de kijker die alleen leest.
  7. Een lijn via de werkbalk en met `---` boven een tabel: typen komt op een eigen regel,
     en de tabel blijft heel. Daarna schermafdrukken in het lichte thema.
- **Terugknop:** `npm run test:terugknop`, 18 gelukt.
- **Build:** de tabel- en uitklapcode zit alleen in het stuk bundel `PageEditor`.
- **Niet lokaal gedraaid:**
  - `npm run test:mobile` (de lay-out van de pagina's buiten de editor is niet veranderd);
  - `deno check` (geen edge function gewijzigd).

  De workflow Frontend checks draait niet vanzelf op een branch, alleen bij een push naar
  staging of een pull request. Daarom is hij op de branch met de hand gestart.
  - Run 301, op commit 85e0625 (deze stap plus het eerste deel van 1A-4b), was helemaal
    groen:
    - typecheck en unit tests;
    - de mobiele lay-outtest in donker en licht;
    - laden per module, inrichting en terugknop;
    - `deno check`;
    - de migraties vanaf nul, met de databasetests.
  - Een eerdere run op ff9f1d4 is afgebroken: die was ingehaald door 301.
