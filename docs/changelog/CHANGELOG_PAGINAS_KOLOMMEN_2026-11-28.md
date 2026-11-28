# Pagina's: kolommen (stap 2-0)

28 november 2026. Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §3, §16 en §18.

Het laatste blok uit §3. "Kolommen komen als laatste en mogen naar fase 2 schuiven", en §16
liet open of dat fase 1 of 2 werd. De database, de klantweergave (`pageHtml.ts`) en de export
(`pageDocx.ts`) kenden kolommen al sinds 1A-1; alleen de editor kon ze nog niet maken. Gebouwd
na "Merge naar staging en houw verder", als eerste stap van fase 2. Er was geen besluit voor
nodig.

## Wat er nu kan

- **"2 kolommen" en "3 kolommen" in het blokmenu**, met `/` (ook `/2`, `/3` of `/kol`) of de
  +-knop.
  - Op een lege regel worden het de kolommen. In een regel met tekst komen ze eronder.
  - De cursor staat daarna in de eerste kolom.
  - Staan de kolommen onderaan, dan komt er een lege regel onder, zodat je daaronder verder
    kunt typen.
- **Even breed naast elkaar, op een telefoon onder elkaar.** Tijdens het bewerken staat er een
  stippellijn om elke kolom, zodat je ziet waar de ene ophoudt.
- **In een kolom:** tekst, koppen, lijsten, takenlijsten, citaten, code, een lijn, een callout,
  een afbeelding en een bestand.
  - Geen tabel, kolommen, uitklapper, inhoudsopgave of subpagina: die passen niet in een smalle
    kolom.
  - Het menu toont ze in een kolom dan ook niet.
- **Backspace aan het begin van een kolom** gaat naar het eind van de kolom ervoor. In de eerste
  kolom, terwijl alle kolommen leeg zijn, gaan de kolommen weg. Anders kwam je er niet meer
  uit: een kolom laat Backspace niet over zijn rand, zodat tekst niet van de ene kolom in de
  andere schuift.
- **Alleen op het hoogste niveau** van de pagina: niet in een lijst, citaat, callout of tabel.
- **De klant, Word en PDF** tonen kolommen zoals al sinds 1A-1. De klant ziet ze naast elkaar.
  In Word en PDF worden ze een tabel zonder randen.

## Hoe het werkt

- `Columns` en `Column` in `src/lib/pageEditorExtensions.ts`.
  - `columns` heeft twee of drie `column`-knopen.
  - Wat in een kolom mag, staat in `COLUMN_CONTENT`.
  - Beide zijn isolating: Enter en Backspace blijven binnen de kolom.
  - `columns` krijgt een vast id, net als de andere blokken.
- `insertColumns(2 | 3)` maakt de kolommen. De sleutels in het blokmenu zijn `kolommen2` en
  `kolommen3` (`pageBlocks.ts`, `PageBlockMenu.tsx`).
- De stijl staat in `globals.css`: een grid met even brede kolommen, en onder 640 pixels onder
  elkaar.
- Geen migratie: de database nam `columns` en `column` al aan.

## Getest

- **Unit:**
  - `pageEditorExtensions.test.ts`:
    - twee of drie kolommen met gewone blokken kan;
    - één of vier kolommen, een tabel of kolommen in een kolom kan niet;
    - invoegen op een lege regel, in een regel met tekst, en niet in een lijst.
  - `pageBlocks.test.ts`: `/kol`, `/2` en `/3` vinden de kolommen.
  - `pageBodyCheck.test.ts`: kolommen passen, één kolom niet. De test voor "een blok dat deze
    editor niet kent" gebruikte kolommen; dat is nu een verzonnen blok uit de toekomst.
  - De klantweergave en Word hadden al een test (`pageHtml.test.ts`, `pageDocx.test.ts`).
- **`ui.mjs paginas`**, een nieuwe stap in de echte editor:
  - `/2` maakt twee kolommen, en typen in elke kolom komt in de database;
  - Backspace aan het begin van de tweede kolom gaat naar de eerste;
  - drie lege kolommen gaan met Backspace weer weg;
  - op een telefoon (390 pixels) staan ze onder elkaar.

  De stap "een pagina met een blok dat deze app niet kent" gebruikte ook kolommen. Sinds deze
  stap kent de editor elk blok dat de database aanneemt. De test bootst een blok uit de toekomst
  nu na met een insert zonder triggers (`session_replication_role = replica`). Er is een geval
  bij: één kolom, die de database wel aanneemt, opent alleen om te lezen, met de melding dat de
  inhoud niet klopt. `ui.mjs paginas`: 19 stappen, 0 fout.
- **`npm test`** (2442) en **`npm run typecheck`**.
- **De CI** (run 318, c07b98f): helemaal groen, ook de mobiele lay-outtest (36 minuten).
