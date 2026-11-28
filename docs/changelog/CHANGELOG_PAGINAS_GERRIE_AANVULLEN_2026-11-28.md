# Pagina's: Gerrie vult een pagina aan (§12)

28 november 2026. Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §12: "`document.update`
(aanvullen) zet alinea's onderaan".

## Wat er nu kan

- **Gerrie, een gekoppelde AI (MCP), een agent of de API kan voorstellen een pagina aan te
  vullen.** Na het akkoord ("Uitvoeren") komt elke regel van de tekst als alinea onderaan de
  pagina.
  - De kaart heet "Pagina "…" aanvullen".
  - De lege laatste regel van de pagina gaat eerst weg, zodat er geen lege regel tussen staat.
  - Na het aanvullen is er een versie, dus het staat in het versiepaneel.
- **Vervangen kan niet bij een pagina.** De server weigert het voorstel, met de reden voor de
  AI: "geef content_mode "append" mee". Vervangen zou tabellen, afbeeldingen en subpagina's
  weghalen.
- **Alleen tekst.** Koppen, lijsten en opmaak worden gewone alinea's ("• een" voor een
  lijstpunt). Voorstellen per blok komen in fase 2.
- **Wie de pagina op dat moment open heeft,** krijgt bij zijn volgende opslag de bekende
  melding dat iemand anders schreef, met "Opnieuw laden". Dat is dezelfde bescherming als bij
  twee collega's (`edit_version`).

## Hoe

- **Op de server** (`_shared/actions/content.ts`):
  - `planContentUpdate` zet bij een pagina `page_paragraphs` in het voorstel.
  - `pageParagraphs()` maakt die regels uit de tekst (via `plainText`): lege regels eruit,
    hoogstens 200.
- **De tekst blijft ook in het patch.** Een app van vóór deze versie stuit dan op de weigering
  van de database ("Een pagina wijzig je via de blokken"). Zonder die tekst zou zo'n app
  "bijgewerkt" melden zonder dat er iets bij kwam. De database weigert die wijziging ook als
  de titel tegelijk verandert.
- **In de app** zet de uitvoerder (`src/lib/actions/content.ts`) de regels onder wat er nu
  staat (`appendParagraphsToPage`).
  - Dat gaat met `edit_version`, net als de editor.
  - Schreef iemand er net in, dan probeert hij het één keer opnieuw, en anders volgt een
    melding.
  - Daarna legt hij een versie vast.
- **Alleen de app voert dit uit.** Gerrie, de MCP, de API en de agents zetten alleen klaar,
  via de goedkeurwachtrij (regel 2 in `CLAUDE.md`).

## Getest

- **`actionAllTasks.test.ts`** (twee nieuwe tests):
  - vervangen wordt geweigerd;
  - aanvullen geeft de alinea's, met het entiteitteken goed;
  - een lege tekst wordt geweigerd;
  - de titel kan zonder tekst;
  - `pageParagraphs` werkt per regel, met lijsten en `<br>`, en houdt het op 200.
- **`npm test`** (2381) en typecheck.
- **`ui.mjs paginadrive`, 9 stappen, 0 fout.** De nieuwe stap gaat de echte weg:
  - een MCP-koppeling;
  - `propose_action` via de MCP-functie, waarbij vervangen geweigerd wordt;
  - het voorstel in de wachtrij;
  - de beheerder drukt op het startscherm op "Uitvoeren";
  - daarna: de twee alinea's onderaan zonder lege regel, `edit_version` één hoger, één versie
    erbij, en het voorstel uit de wachtrij.
