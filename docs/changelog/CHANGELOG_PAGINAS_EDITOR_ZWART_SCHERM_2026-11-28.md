# Pagina's: geen zwart scherm meer als de editor traag start

28 november 2026. Gevonden met de UI-test, op de branch. Bestond al vóór vannacht en kon ook in
productie gebeuren: de oorzaak zit in hoe de editor start.

## Wat er misging

- **De UI-test `ui.mjs paginas` liep vast bij het openen van een nieuwe pagina.**
  - De hele app werd zwart.
  - De fout: `Cannot set properties of undefined (setting 'links')` in `PageEditor.tsx`.
- **De oorzaak zit in Tiptap** (`useEditor` uit `@tiptap/react`).
  - Standaard (`immediatelyRender: true`) maakt `useEditor` de editor al tijdens de eerste
    render, en plant hij meteen een `destroy()` over 1 ms.
  - Die wordt pas afgeblazen als het eerste effect van de component draait.
  - Duren de eerste render en commit langer dan dat, dan krijgen de effecten van de editor een
    editor die al weg is. Zijn `storage` is dan leeg, dus `storage.subpage.links = …` gooide
    een fout.
  - `PageLoadBoundary` vangt alleen laadfouten op, dus de fout legde de hele app stil.
- **Wanneer de start lang duurt:** de eerste keer een pagina openen (de editor laadt dan nog),
  "Nieuw → Pagina" na het wachten op de database, een trage telefoon. In de UI-test kwam het
  boven toen er twee dingen bij kwamen:
  - de boom naast de pagina;
  - een werkende `calendar-integrations` (met `ical.js`).

  Allebei maken ze de start zwaarder. Met een zes keer trager gezette processor gebeurt het
  elke keer.

## Wat er nu is

- **`immediatelyRender: false`** in beide `useEditor`-aanroepen: de editor en de voorvertoning
  van een versie. Daarmee maakt `useEditor` de editor pas in zijn effect, als de component er
  staat, en raakt de geplande `destroy()` niets meer.
- **Elk effect van de editor stopt bij een vernietigde editor** (`isDestroyed`). Dat is een
  vangnet: zonder dat vangnet slaagde de test ook.
- **De UI-test meldt bij een mislukte stap ook de JavaScript- en console-fouten van die stap**
  (`uiStap` in `tests/stromen/ui.mjs`).
  - Eerst stond er alleen de wachttijd, bij een zwart scherm.
  - Ze staan vooraan in de stack, omdat `toets.mjs` daar de eerste regels van afdrukt.
- **Een nieuwe stap in `ui.mjs paginadrive`:** "een nieuwe pagina op een trage computer".
  - De processor gaat zes keer trager (CDP `Emulation.setCPUThrottlingRate`).
  - Dan "Nieuw → Pagina", wachten op "Opgeslagen", typen, en de tekst moet in de database
    staan.
- **`ui.mjs paginas` drukt ook op "Word"** bij de pagina met drie afbeeldingen, en controleert
  dat ze alle drie in de .docx staan.

## Getest

Steeds met `ical.js` geïnstalleerd (zie de tip in het bouwplan, §18).

- **`ui.mjs paginadrive`, de nieuwe stap:**
  - zonder `immediatelyRender: false` en zonder vangnet: vastgelopen, met precies deze fout;
    de stap raakt de race dus;
  - met alleen `immediatelyRender: false`: 10 stappen, 0 fout;
  - met beide: 10 stappen, 0 fout.
- **`ui.mjs paginas`:** twee keer 18 stappen, 0 fout, met het vangnet.
- **`ui.mjs documenten`:** 10 stappen, 0 fout.
- **`npm run typecheck`.**
