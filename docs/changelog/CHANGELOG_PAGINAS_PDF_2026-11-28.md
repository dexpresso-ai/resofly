# Pagina's exporteren: de PDF, en vastleggen in het dossier (stap 1B-5)

28 november 2026. Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §9 en §18.

Gebouwd na de merge naar staging van 11:46 UTC (`3be4452`), op de branch. Op die merge zei de
gebruiker "ga door met het plan". Dat is de weg van §9: de server bouwt de Word-file
(`page-export`), en Collabora maakt er via de media-worker een PDF van. Die worker rolt de
gebruiker met de hand uit; zie `docs/setup/PAGINA_PDF_SETUP.md`.

## Wat er nu kan

- **"PDF downloaden"** in het exportvenster, met dezelfde opties als Word:
  - voorblad, inhoudsopgave, subpagina's als hoofdstukken en briefpapier;
  - de kop en voet in de huisstijl.

  De PDF komt uit dezelfde Word-file, dus Word en PDF zien er hetzelfde uit.
- **"Vastleggen in het dossier"**: de PDF als vast bestand in de map van de bovenste pagina, met
  de datum in de naam ("Handboek (28-11-2026).pdf").
  - Wat je later aan de pagina wijzigt, verandert die PDF niet.
  - Staat de pagina niet in een map, dan zegt het venster dat. De drive toont alleen bestanden
    in een map, dus daarbuiten zou de PDF zoekraken.
  - Alleen voor wie Inhoud mag schrijven. Downloaden mag ook wie alleen mag lezen.
- **Kent de media-worker het nieuwe pad nog niet**, dan zegt het venster: "De PDF kan nog niet:
  de media-worker moet eerst worden bijgewerkt. Word downloaden kan wel." Staat `page-export`
  zelf nog niet op de omgeving, dan zegt het dat ook.
- **De eerste PDF na een pauze kan tot een minuut duren** (Collabora start koud); dat staat in
  het venster terwijl je wacht. Het venster wekt Collabora al bij het openen.

## Hoe het werkt

- **`page-export`** (nieuwe edge function) leest alles met de sessie van wie exporteert
  (`createUserClient` in `_shared/edgeAuth.ts`, RLS):
  - de pagina en haar subpagina's (wat in de prullenbak ligt of wat je niet mag zien, komt er
    niet in);
  - titels, bestandsnamen en de bijlagen van afbeeldingen;
  - de bedrijfsinstellingen, en de namen voor het voorblad.

  De organisatie komt uit de pagina die je mocht lezen, nooit uit de invoer. Alleen de bytes van
  een afbeelding komen langs de interne weg, en alleen voor bijlagen die je mocht lezen. De
  letters komen uit `_shared/pdfFonts.ts`, dezelfde als bij facturen.
- **Eén samensteller** (`_shared/pageExport.ts`) voor de app en de server. Het ophalen
  verschilt; wat er daarna gebeurt, staat één keer in de code:
  - de verwijzingen, het logo, de kop en voet en het voorblad;
  - de marges van het briefpapier;
  - de subpagina's per laag.

  De app gebruikt hem sinds deze stap ook voor Word. De volgorde van de boom staat in
  `_shared/pageTreeOrder.ts`.
- **De media-worker**, `/internal/office/convert-page`:
  - alleen met het interne geheim, een geldige organisatie en een echte .docx;
  - zet om via Collabora, en geeft alleen een echte PDF terug.

  Het contractpad blijft alleen contracten omzetten. De aanroep van Collabora delen ze.
- **Vastleggen** loopt langs de gewone upload van de drive (`uploadToR2`, map), met de rechten
  van wie het doet.
- **De rooktest na de uitrol** (`scripts/supabase-smoke-test.sh`) kijkt nu ook of `page-export`
  er staat. Hij stuurt origin "null", en dat weigert de functie altijd (403, "zonder herkomst"),
  wat de omgeving ook toestaat. Zonder de functie antwoordt Supabase zelf met 404.
  - Eerst stuurde hij geen Origin en verwachtte hij 401 ("Niet ingelogd"). Op staging was dat
    403 geweest: zonder Origin mag alleen lokaal (`ALLOW_LOCAL_DEV`). De uitrol was dan rood
    geworden. Gevonden vóór een merge, bij het nalezen.
  - De stroomtest stuurt nu precies het verzoek van de rooktest.

## Afwijkingen van §9

- **Geen tijdelijke Word-file in R2.** §9 zet de DOCX in R2 onder `page-export`. Hier gaat hij
  in het verzoek naar de worker mee, en komt er niets in R2.
  - Reden: een map die de worker niet kent, mag elk lid via `/file/<sleutel>` lezen. Een
    tijdelijk bestand daar zou dus leesbaar zijn zolang het bestond.
  - Bovendien hoeft wat er niet is, ook niet opgeruimd te worden.
- **Word blijft uit de app komen** (afwijking van 1B-2). Dezelfde samensteller zorgt dat Word
  en PDF niet uit elkaar lopen.

## Nog niet

- **Een briefpapier als PDF onder de PDF.** Een briefpapier dat een afbeelding is, kan wel (via
  de Word-file). Voor een PDF als briefpapier zegt het venster dat het nog niet kan. Dat kan
  later met pdf-lib, zoals bij facturen.
- **Gerrie, de API en de MCP** exporteren nog niet. De server kan het nu zonder browser, maar een
  handeling is een eigen stap.

## Getest

- **Unit:**
  - `_shared/pageExport.test.ts` (8): de verwijzingen, de subpagina's per laag (volgorde,
    kring, grens, 20 lagen), het logo, de kop en voet, het voorblad, de marges en de context;
  - `workers/media-api/src/pageConvert.test.ts` (5): de echte worker met een nagebootste
    Collabora:
    - het geheim, de organisatie, het type en de zip-kop;
    - wat geen PDF is, of een fout van Collabora, geeft 502;
    - er komt niets in R2;
    - het contractpad blijft ongewijzigd.
- **De worker typecheckt** (`tsc` in `workers/media-api`; eerst gaven twee nieuwe regels een
  typefout met de nieuwere TypeScript, nu niet meer).
- **`npm run test:stromen -- documenten`: 60 stappen, 0 fout**, waarvan 5 nieuw:
  - de PDF met hoofdstuk, voorblad, inhoudsopgave en afbeelding, zonder de prullenbak;
  - de kijker wel; Inhoud "geen", de buren en zonder sessie niet;
  - een pagina in de prullenbak niet;
  - de ontbrekende route geeft een eigen code;
  - het briefpapier: geen, of een PDF.

  De nagebootste worker zet de Word-file met LibreOffice (de motor van Collabora) echt om, en de
  tekst staat in de PDF (`pdftotext`).
- **`ui.mjs paginaexport`: 7 stappen plus de voorbereiding, 0 fout**, waarvan 1 nieuw:
  - PDF downloaden met een voorblad;
  - vastleggen in de map, met de upload en de rij;
  - een worker zonder het pad: het venster zegt het.
- **De app-kant van Word na de ombouw:** dezelfde UI-stappen voor Word slagen.
- **`tsc` op `page-export`** en de functies ernaast, tegen de typen van supabase-js. Deno draait
  hier niet; de CI doet `deno check` (de stap "Deno-typecheck pagina's" neemt `page-export` nu
  mee).
- **`npm test`** (2432) en **`npm run typecheck`**.

## Wat hier niet te testen is

- **Collabora zelf, en de uitgerolde worker.** In de proef met LibreOffice 24.2 werd de Word-file
  van de server een goede PDF.
- **Op staging na te lopen**, nadat de worker is uitgerold: één PDF downloaden, en één
  vastleggen. Zie `docs/setup/PAGINA_PDF_SETUP.md`.
