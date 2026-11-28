# Pagina's exporteren: het exportvenster en de Word-kopie (stap 1B-3)

28 november 2026. Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §9 en §18.

Gebouwd na de merge naar staging van die ochtend (`59fab7e`). Het staat op de branch, en gaat
pas naar staging als de gebruiker het zegt.

## Wat er nu kan

- **"Exporteren" in de balk van de pagina-editor**, in plaats van de knop "Word". Het opent een
  venster met drie keuzes.
  - **Word downloaden:** wat de knop "Word" deed. De pagina als .docx, in de letters van de
    huisstijl.
  - **Maak er een Word-document van:** de pagina als Word-document naast de pagina, voor de
    laatste puntjes. Het document heet "\<titel van de pagina\> (Word)".
    - Het komt bij dezelfde klant en hetzelfde project, in de map van de bovenste pagina van de
      boom.
    - Eerst slaat de editor op wat er nog stond. Dan gaat hij netjes dicht: een versie, en de
      pagina weer vrij voor anderen. Daarna opent het document in de Word-editor (Collabora).
    - De pagina blijft de bron. Wat je in het Word-document wijzigt, komt niet terug in de
      pagina.
  - **Afdrukken:** de printweergave van Ctrl+P (alleen de pagina, zwart op wit), nu ook met een
    knop, dus ook op een telefoon. In het afdrukvenster van de browser kun je de pagina als PDF
    bewaren.
- **Alleen wie Inhoud mag schrijven, ziet "Maak er een Word-document van".** Wie alleen mag
  lezen, kan downloaden en afdrukken.
- **Het venster wekt Collabora alvast.** Die start koud, tot een minuut; zo loopt het opstarten
  al terwijl je kiest.
- **Terug, Escape en een klik naast het venster sluiten het venster**, niet de pagina. Op een
  telefoon komt het van onderen.

## Keuzes

- **Een venster in plaats van een knop per uitvoer.** §9 vraagt om een exportvenster, met
  straks de opties (voorblad, inhoudsopgave, subpagina's, briefpapier). Een knop per uitvoer
  paste ook niet in de balk op een telefoon.
- **De map van de bovenste pagina.** Een subpagina heeft zelf geen map; de database haalt die
  weg. Met de map van de subpagina zelf belandde de kopie los in het dossier
  (`pageTreePlace` in `src/lib/repository.ts`).
- **Hetzelfde pad als een geüpload Word-bestand.**
  - De media-worker zet het bestand in R2 (`/office/document-upload`, met dezelfde controle op
    schrijfrechten en Inhoud).
  - Daarna komt de rij erbij, met de rechten van wie exporteert (RLS).
  - Lukt de rij niet, dan gaat het bestand weer weg. Anders bleef het als wees in R2 staan.
- **De fout staat in het venster, en de pagina blijft open.** Pas als het document er is, gaat
  de editor dicht. Gaat dat sluiten mis (opslaan lukt niet), dan staat het document er wel. Een
  tweede klik opent dat document, zolang je niets wijzigde, en maakt er geen tweede bij.
- **Geen tekst in de rij** (`content` leeg), zoals bij elk Word-document. De tekst staat in het
  bestand; een kopie in de rij zou verouderen zodra iemand het document in Word bijwerkt
  (dat ging eerder mis bij het omzetten van een tekstdocument naar Word). Zoeken en Gerrie
  vinden de tekst van het document dus niet, net als bij andere Word-documenten.
- **Nog geen PDF in je huisstijl.** Die komt via Collabora, zodat Word en PDF er hetzelfde
  uitzien (§9). Tot dan is er afdrukken, met "Opslaan als PDF" in de browser.

## Wat de tests niet laten zien

- **De UI-test bootst de media-worker en Collabora na.** Hij toetst de rij, de upload en dat
  Word opent, maar niet of Collabora dit bestand goed bewerkt en terugschrijft.
- **Daarom een proef met LibreOffice 24.2**, dezelfde motor als Collabora.
  - Een proefpagina met een ingesloten huisstijlletter, een inhoudsopgave, een tabel met
    samengevoegde cellen, een kader en een afbeelding is opnieuw opgeslagen als .docx.
  - Ook daarna voldoet het bestand aan het schema (ECMA-376).
  - Als PDF klopt het nog: de huisstijlletters, de inhoudsopgave, de tabel, het kader, de
    afbeelding en de paginanummers.
- **Na de eerste keer opslaan in Collabora wordt het bestand veel groter.** In de proef ging
  het van 107 kB naar 2 MB.
  - De kopie heeft "letters insluiten" aan, voor de huisstijlletter. LibreOffice sluit dan
    alle letters in die het gebruikt, en in hun geheel: ook Liberation, DejaVu en OpenSymbol.
  - Niets gaat kapot, maar het kost opslag. Een oplossing (bijvoorbeeld de huisstijlletters
    in de Collabora-container) hoort bij de proef op de container (1B-1).
- **Op staging na te lopen:** maak één Word-document van een pagina, en bewerk en bewaar het in
  Word (Collabora). Collabora is vanuit een cloudsessie niet bereikbaar.

## Getest

- **Een nieuw UI-scenario `paginaexport` (`tests/stromen/ui.mjs`), 4 stappen plus de
  voorbereiding, 0 fout:**
  - het venster ligt vóór de editor;
  - terug en Escape sluiten het venster en niet de pagina;
  - Word downloaden bevat wat je net typte;
  - afdrukken roept de printweergave op;
  - op 390px past de balk en staat het venster helemaal in beeld;
  - een Word-document van een subpagina:
    - komt in de map van de bovenste pagina, bij de klant, met de juiste naam;
    - bevat wat je net typte, want de pagina is eerst opgeslagen;
    - wordt geopend in de (nagebootste) Word-editor;
    - daarna is de pagina weer vrij, en staat het document in de map;
  - een mislukte upload: de melding in het venster, de pagina blijft open, en er komt geen
    document;
  - een geweigerde rij: de melding van de database in het venster, en het bestand wordt weer
    opgeruimd;
  - de kijker (alleen lezen): downloaden en afdrukken wel, een Word-document maken niet.
- **Gevonden met die test:** een fout van de database is geen `Error` maar een object met een
  `message`. Het venster toonde dan alleen "kon niet worden gemaakt", zonder waarom. Nu staat de
  melding van de database erin.
- **De Word-stappen in `ui.mjs paginas` en `paginadrive`** gaan nu via Exporteren. Beide
  scenario's opnieuw gedraaid: 16 en 8 stappen plus de voorbereiding, 0 fout.
- **Schermafdrukken nagekeken:** het venster licht en donker, op een breed scherm en op de
  telefoon, en de geopende Word-editor.
- **`npm test`** (2410), **`npm run typecheck`** en **`npm run test:terugknop`** (18 gelukt).
