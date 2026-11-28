# Pagina's: afdrukken met Ctrl+P

28 november 2026. Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §9: "Ctrl+P blijft werken,
met een nette printstijl."

## Wat er nu kan

- **Een open pagina afdrukken** (of "Opslaan als pdf" in de browser) geeft alleen de pagina:
  - de titel en de inhoud, over de hele lengte;
  - zwart op wit, ook in het donkere thema;
  - uitklappers open.
- **Wat niet op papier komt:**
  - de balk, de knoppen, de boom en het versiepaneel van de editor;
  - de app eromheen.
- **Koppen** blijven bij de tekst eronder. Tabelrijen, afbeeldingen, kaders en code breken niet
  middendoor.

## Waarom zo

- **De editor is een vast venster met een eigen schuifbalk.** Zonder deze regels zou alleen
  het stuk dat in beeld staat op papier komen, met de app eromheen.
- **Alleen CSS** (`@media print` in `globals.css`):
  - alles wat niet de editor is, of de weg ernaartoe, gaat weg (`:has()`);
  - die weg verliest zijn vaste hoogtes, zodat de pagina kan doorlopen.
- **Er is geen `@page`-regel.** Die zou voor elk scherm van de app gelden; de browser kiest
  zelf de marges.
- **De lichte kleuren staan op de editor zelf.** Het donkere thema vult zijn kleuren al op
  `:root` in, dus omschakelen naar licht kan niet vanuit de editor.

## Getest

- **`ui.mjs paginadrive`: 7 stappen, 0 fout.** De nieuwe stap opent een pagina met een dichte
  uitklapper en 80 alinea's, en schakelt naar printweergave.
  - De balk, de knoppen, de boom en de zijbalk van de app zijn weg.
  - De ingeklapte tekst en de titel staan er.
  - `page.pdf()` geeft 2 tot 6 bladen.
- **Met het oog nagekeken:** de PDF van die stap, 3 bladen.
  - Wit papier, de uitklapper open, en het laatste blad eindigt met de laatste regel.
  - Van de app zelf geen woord (`pdftotext`).
