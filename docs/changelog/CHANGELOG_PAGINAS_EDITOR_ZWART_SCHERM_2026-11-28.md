# Pagina's: geen zwart scherm meer als de editor opnieuw begint

28 november 2026. Gevonden met de UI-test, op de branch; nooit op staging geweest.

## Wat er misging

- **De UI-test `ui.mjs paginas` liep vast bij de stap met het blokmenu.**
  - Bij het openen van een nieuwe pagina werd de hele app zwart.
  - De fout: `Cannot set properties of undefined (setting 'links')` in `PageEditor.tsx`.
- **Het gebeurde alleen met twee dingen tegelijk:**
  - de boom naast de pagina (stap 1A-5e);
  - een werkende `calendar-integrations` in de test, dus met het pakket `ical.js`. Daarzonder
    laadde die functie niet, en kwam de fout niet boven.

  Met de boom uit, of zonder `ical.js`, slaagde dezelfde test.
- **Waarom het zwart werd:**
  - Tiptap ruimt een editor 1 ms na het opruimen van zijn effect op, tenzij het effect er
    dan al weer is.
  - Draaiden de effecten van de editor later opnieuw met dezelfde staat, dan kregen ze een
    editor die al vernietigd was. Zijn `storage` is dan leeg, dus `storage.subpage.links = …`
    gooide een fout.
  - `PageLoadBoundary` vangt alleen laadfouten op, dus de fout legde de hele app stil.
  - Met een diagnose erin liep hetzelfde effect drie keer met dezelfde editor. Waarom React de
    effecten precies opnieuw liet lopen, is niet vastgesteld: de fout trad niet elke keer op.

## Wat er nu is

- **Elk effect in de editor dat de editor gebruikt, stopt bij `editor.isDestroyed`.** Het gaat
  om laden en claimen, subpagina's, afbeeldingen en bestanden, en de voorvertoning van een
  versie.
  - `useEditor` maakt daarna zelf een nieuwe editor, en de effecten lopen met die editor
    opnieuw.
  - Er staat uitleg bij het eerste effect in `PageEditor.tsx`.
- **De UI-test meldt bij een mislukte stap ook de JavaScript- en console-fouten van die stap**
  (`uiStap` in `tests/stromen/ui.mjs`).
  - Eerst stond er alleen de wachttijd, bij een zwart scherm.
  - Die fouten staan vooraan in de stack, omdat `toets.mjs` daar de eerste regels van afdrukt.
- **`ui.mjs paginas` drukt ook op "Word" bij de pagina met drie afbeeldingen.** De test
  controleert dat ze alle drie als bestand in de .docx staan.

## Getest

- **Met `ical.js` geïnstalleerd** (zoals het hoort; zie de tip in het bouwplan, §18):
  - `ui.mjs paginas`: twee keer achter elkaar 18 stappen, 0 fout;
  - `ui.mjs documenten`: 10 stappen, 0 fout.
- **Ter vergelijking, vóór de reparatie:**
  - met de boom én `ical.js`: twee keer vastgelopen;
  - zonder `ical.js`: 18 van 18;
  - met de boom tijdelijk uit: 18 van 18.
- **`npm run typecheck`.**
