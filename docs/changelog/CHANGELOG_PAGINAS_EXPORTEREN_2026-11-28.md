# Pagina's exporteren: het exportvenster en de Word-kopie (stap 1B-3)

28 november 2026. Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §9 en §18.

Gebouwd na de merge naar staging van die ochtend (`59fab7e`). Op verzoek van de gebruiker met
1B-4a tot en met 1B-4c op staging gezet, op 28 november om 11:46 UTC (`3be4452`). De uitrol is
geslaagd, met de rooktest; er zijn geen migraties.

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

## Later die dag: de opties voor Word (1B-4a)

### Wat er nu kan

- **In het exportvenster drie keuzes, bij de twee Word-knoppen.** Ze gelden voor Word downloaden
  en voor "Maak er een Word-document van". Afdrukken toont de pagina zoals op het scherm, en
  kent ze niet. De keuzes blijven bewaard in je browser.
  - **Voorblad:**
    - het logo, of de naam van je bedrijf als er geen logo is;
    - de titel van de pagina;
    - de klant en het project, als je die mag zien;
    - de datum van vandaag.

    Het voorblad heeft geen paginanummer, en de titel staat niet nog eens boven de tekst.
  - **Inhoudsopgave vooraan:** van het hele bestand, met de hoofdstukken erin. Een
    inhoudsopgave-blok in de pagina valt dan weg.
  - **Subpagina's als hoofdstukken**, met het aantal erbij. De optie staat er alleen als er
    subpagina's zijn.
    - De volgorde is die van de boom.
    - Een directe subpagina begint op een nieuwe bladzijde, met haar titel als kop 1. Haar
      eigen koppen schuiven een niveau op.
    - Een subpagina daaronder loopt door, als kop 2.
- **Zonder opties is het bestand byte voor byte dat van 1B-3.** Nagelopen met de module van 1B-3,
  met en zonder huisstijl.

### Keuzes

- **De nummering loopt door na het voorblad:** de eerste bladzijde tekst is "Pagina 2 van 5".
  - Opnieuw bij 1 beginnen kan in Word, maar LibreOffice (en dus Collabora, de Word-kopie en
    straks de PDF) telt het totaal dan verkeerd.
  - In een proef kwam er "Pagina 1 van 1" en "totaal 5" bij vier bladen, ook na opnieuw
    opslaan. Het aantal bladzijden van een sectie (SECTIONPAGES) kent LibreOffice niet.
  - Doorlopend klopt het totaal, ook na opnieuw opslaan.
- **Eén inhoudsopgave per bestand.** Een inhoudsopgave in Word somt na bijwerken altijd het
  hele document op. Twee zouden dus dezelfde lijst tonen.
  - Met "Inhoudsopgave vooraan" vallen de blokken in de pagina's weg.
  - Zonder die optie blijft het blok in de pagina zelf, nu met de hoofdstukken erin. Een blok
    in een hoofdstuk valt weg.
- **Een hoofdstuk dat niet laadt, laat de export mislukken**, met de naam van de subpagina in de
  melding. Een bestand waar stil een hoofdstuk uit ontbreekt, valt pas op als het bij de klant
  ligt.
  - Een subpagina die je niet mag zien, of die in de prullenbak ligt, telt niet mee. Die
    geeft de database niet.
- **Hoogstens 200 subpagina's.** Staan er meer onder de pagina, dan zegt het venster dat, en
  kan de optie niet aan.
- **Kop 4 tot en met 6** staan alleen in het bestand als er hoofdstukken zijn. Dieper dan kop 6
  gaat het niet: daaronder wordt alles kop 6.
- **Het logo als png, jpeg of gif.** Een svg of webp kan Word niet tonen; dan staat de naam van
  het bedrijf er, zoals bij de PDF van een factuur.
- **Nog niet: briefpapier (1B-4b).** Een briefpapier is in ResoFly een PDF of een afbeelding. In
  een .docx kan alleen een afbeelding.

### Getest (1B-4a)

- **`pageDocx.test.ts`, vijf nieuwe tests:**
  - zonder opties gelijk;
  - het voorblad (eigen sectie zonder voet, het logo op maat, een svg-logo wordt de naam);
  - de inhoudsopgave (één veld, de juiste niveaus);
  - de hoofdstukken (diepte, opgeschoven koppen, nieuwe bladzijde, kop 6 als plafond, een
    kapotte inhoud);
  - alles tegelijk.

  Elke stijl die het bestand gebruikt, bestaat in `styles.xml`; dat ziet de XSD niet.
- **Een proefbestand met alles aan:** de proefpagina van 1B-2 met drie hoofdstukken, een
  voorblad met logo, en de huisstijlletters.
  - Het voldoet aan het schema (ECMA-376). Na opnieuw opslaan in LibreOffice eerst niet; dat
    las ik bij deze stap verkeerd. Zie "Gevonden en gerepareerd" bij 1B-4b hieronder.
  - Als PDF, vóór en na opnieuw opslaan, nagekeken:
    - het voorblad zonder paginanummer;
    - de inhoudsopgave met de hoofdstukken op hun niveau;
    - elk hoofdstuk op een nieuwe bladzijde;
    - "Pagina 3 van 5" klopt.
  - Het bestand staat naast het rapport: `docs/rapporten/PROEF_WORD_OPTIES_2026-11-28.docx`.
- **`ui.mjs paginaexport`, een nieuwe stap:**
  - alle drie de opties aan bij een pagina met een kind en een kleinkind;
  - in de download staan:
    - het voorblad in een eigen sectie, met de klant en het jaar;
    - de titel één keer;
    - één inhoudsopgave, met beide subpagina's;
    - het kind als hoofdstuk op een nieuwe bladzijde, en het kleinkind eronder;
    - de koppen opgeschoven, en de volgorde goed;
  - elke stijl bestaat;
  - de keuzes zijn er nog als je het venster weer opent.

  Het scenario: 5 stappen plus de voorbereiding, 0 fout.
- **Schermafdrukken nagekeken:** het venster met de opties, licht en donker, en op de telefoon.
- **`ui.mjs paginas` (16 stappen) en `paginadrive` (8), elk plus de voorbereiding:** 0 fout, ook
  de Word-stappen met afbeeldingen, de huisstijlletter en de subpagina.
- **`npm test`** (2415) en **`npm run typecheck`**.

## Later die dag: het briefpapier (1B-4b), en een reparatie aan het voorblad

### Wat er nu kan

- **"Briefpapier, achter elke bladzijde"** in het exportvenster, als je bij Instellingen →
  Documentopmaak een briefpapier hebt ingesteld dat een afbeelding is (PNG of JPG).
  - De afbeelding staat over de hele bladzijde, achter de tekst, op elke bladzijde, ook op
    het voorblad. Ze staat in de kop van het bestand, zoals het briefpapier onder elke
    bladzijde van een factuur.
  - De marges komen uit Documentopmaak, zoals op de vervolgbladzijden van een factuur:
    - boven: waar de inhoud begint;
    - onder: waar de voet begint.
    - Met het sjabloon "Voor briefpapier" blijven de kop en voet van het briefpapier zo vrij.
    - Nooit minder dan de gewone marge.
  - Het paginanummer staat net onder de tekst, boven de voet van het briefpapier.
- **Een briefpapier als PDF kan niet in een Word-bestand.**
  - De optie staat er dan wel, maar uit. Het venster zegt waarom, en wat wel kan: een
    afbeelding als briefpapier.
  - Een bewaarde keuze telt dan niet. Een PDF-briefpapier hoort bij de PDF van een pagina
    (1B-5): met pdf-lib, zoals bij facturen.
- **Nooit stil zonder briefpapier.** De app laadt het briefpapier niet bij het opstarten
  (`letterhead.ts`); de export haalt het op. Lukt dat niet, of is het niet te lezen, dan komt
  er geen bestand, met een melding. `letterhead.test.ts` bewaakt dat nu ook voor de Word-export.

### Gevonden en gerepareerd

- **Het voorblad van 1B-4a overleefde opnieuw opslaan in LibreOffice niet goed.**
  - Het voorblad stond in een eigen sectie. Ons bestand was geldig.
  - Na opnieuw opslaan in LibreOffice 24.2 voldeed het niet meer aan het schema.
    LibreOffice zet de sectiegrens dan vóór de opmaak van de alinea (`w:sectPr` vóór
    `w:pStyle`). Dat doet het bij elk bestand met meer dan één sectie, ook met een alinea
    zonder stijl.
  - Collabora is LibreOffice. Een Word-kopie met voorblad zou na de eerste keer bewaren dus
    zo'n bestand worden. Of echte Word dat opent, kon ik niet nagaan.
  - Bij 1B-4a las ik de uitvoer van de controle verkeerd: er stond geen "PASSED", en ik
    schreef dat het klopte.
  - Nu: één sectie, met een eigen eerste bladzijde zonder voet (`w:titlePg`), en daarna een
    paginagrens. Zo maakt Word zelf een voorblad.
  - Het briefpapier staat ook op die eerste bladzijde (de kop "first").
  - Vóór en na opnieuw opslaan geldig, en de nummering klopt nog: "Pagina 2 van 4".

### Getest (1B-4b)

- **`pageDocx.test.ts`, twee nieuwe tests:**
  - het briefpapier:
    - in de kop, achter de tekst, zo groot als A4;
    - de onderdelen en relaties;
    - de marges en de plek van het paginanummer;
    - met een voorblad ook daar, zonder voet;
    - een marge kleiner dan de gewone, of geen getal, wordt de gewone;
  - een briefpapier dat Word niet kan tonen (pdf, svg, webp): geen kop, en het bestand zoals
    zonder briefpapier.

  De voorbladtest kijkt nu naar één sectie met `w:titlePg`.
- **Zonder opties nog steeds byte voor byte het bestand van 1B-3.**
- **Twee proefbestanden, vóór en na opnieuw opslaan in LibreOffice:**
  - `docs/rapporten/PROEF_WORD_OPTIES_2026-11-28.docx`, opnieuw gemaakt: voorblad,
    inhoudsopgave en hoofdstukken;
  - `docs/rapporten/PROEF_WORD_BRIEFPAPIER_2026-11-28.docx`: een briefpapier met een kop- en
    voetband, de marges van "Voor briefpapier", een voorblad, en 40 alinea's tekst.

  Beide voldoen aan het schema (ECMA-376), ook na opnieuw opslaan. Als PDF nagekeken:
  - het briefpapier staat op elke bladzijde;
  - de tekst blijft tussen de banden;
  - het paginanummer staat boven de voetband;
  - de nummering klopt.
- **`ui.mjs paginaexport`, een nieuwe stap:**
  - een briefpapier als afbeelding in de instellingen, door de export opgehaald;
  - in het bestand:
    - de kop met de afbeelding achter de tekst;
    - de afbeelding is precies die van de instellingen;
    - de marges van de standaardopmaak;
  - een briefpapier als PDF: de optie staat uit, het venster legt het uit, en een bewaarde
    keuze geeft geen kop.

  Het scenario: 6 stappen plus de voorbereiding, 0 fout.
- **`letterhead.test.ts`:** de Word-export staat in de lijst van plekken die het briefpapier
  gebruiken. De test eist dat ze het eerst ophaalt, en mislukt als dat niet lukt.
- **`npm test`** (2417) en **`npm run typecheck`**.

## Later die dag: kop en voet in de huisstijl (1B-4c)

§9 vraagt om "een kop en voet met logo, briefpapier en merkkleur". Tot nu stond in de voet alleen
het paginanummer, en het logo alleen op het voorblad.

### Wat er nu is

- **Een kop in de huisstijl op elke bladzijde:**
  - het logo rechts, hoogstens 4,5 bij 1,1 cm (png, jpeg of gif);
  - een lijn in de merkkleur eronder.

  De tekst begint dan op 3 cm, en de kop staat op 1 cm van de rand. Met de gewone marge stond
  de lijn tegen de eerste regel aan.
- **De voet:** links de voettekst van de huisstijl (of anders de naam van het bedrijf), rechts
  "Pagina 2 van 5".
- **Met briefpapier niet.** Dat heeft zijn eigen kop en voet, en een logo of lijn kwam er dan
  overheen. In de voet staat dan alleen het paginanummer, zoals de factuur de gekleurde balk
  weglaat bij briefpapier.
- **Het voorblad blijft kaal:** geen kop, geen voet. Alleen het briefpapier, als dat aan staat.
- **Bij elke export, geen optie.** Een Word-bestand "in je huisstijl" heeft die kop en voet.
  Zonder huisstijl (geen logo en geen geldige merkkleur) blijft het bestand dat van 1B-3.
  Nagelopen met de module van 1B-3.
- **Een lege bladzijde minder:** bij een lege bovenste pagina met subpagina's als hoofdstukken
  (een handboek met alleen subpagina's) begint het eerste hoofdstuk direct. Eerst kwam er na
  het voorblad een lege bladzijde.

### De controle met LibreOffice, nu als script

- **`scripts/proef-word-export.mjs`** maakt vier proefbestanden:
  - zonder huisstijl;
  - met huisstijl;
  - met alle opties;
  - met briefpapier.
- **`scripts/proef-word-rondgang.sh <map>`** houdt ze tegen de XSD's van ECMA-376, laat
  LibreOffice ze opnieuw opslaan, en houdt ze dan nog eens tegen het schema. Het faalt als één
  controle niet slaagt, of als het aantal bladen verandert.
  - Tegen het oude bestand met twee secties zegt het "ONGELDIG", zoals bedoeld.
  - Eerst gebeurde dit met de hand, en een uitkomst werd verkeerd gelezen (zie 1B-4b).
- **De vier proefbestanden naast het rapport komen nu uit dat script:**
  - `PROEF_WORD_ZONDER_HUISSTIJL_2026-11-28.docx`;
  - `PROEF_WORD_HUISSTIJL_PLAYFAIR_DMSANS_2026-11-28.docx`, nu met de kop en voet;
  - `PROEF_WORD_OPTIES_2026-11-28.docx`;
  - `PROEF_WORD_BRIEFPAPIER_2026-11-28.docx`.

### Getest (1B-4c)

- **`pageDocx.test.ts`, twee nieuwe tests:**
  - de kop en voet:
    - het logo op maat, rechts, als relatie van de kop;
    - de lijn in de merkkleur (ook `#RGB`);
    - de voet met de tekst en een tab naar rechts;
    - alleen een kleur geeft een kop zonder logo;
    - geen geldige kleur en geen logo geeft geen kop en de voet van 1B-3;
    - met voorblad blijft de eerste bladzijde kaal;
    - met briefpapier geen logo, lijn of voettekst;
  - de lege bovenste pagina: zonder en met voorblad begint het eerste hoofdstuk direct, met
    een inhoudsopgave op een nieuwe bladzijde.
- **`scripts/proef-word-rondgang.sh`:** alle vier geldig, vóór en na opnieuw opslaan.
  - Hetzelfde aantal bladen.
  - "Pagina 2 van 5" klopt.
  - Als PDF nagekeken: het logo en de lijn in de kop, de voettekst en het nummer in de voet,
    het voorblad kaal, en bij briefpapier niets eroverheen.
- **`ui.mjs paginaexport`:** de download heeft een lijn in de merkkleur van de organisatie, en
  de voet noemt de voettekst of de bedrijfsnaam. Bij een PDF-briefpapier staat er geen
  briefpapier in het bestand, wel de kop in de huisstijl. 6 stappen plus de voorbereiding,
  0 fout.
- **`ui.mjs paginas` (16) en `paginadrive` (8):** 0 fout, met de kop in hun Word-bestanden.
- **De gedeelde modules van pagina's** met `tsc` in strikte modus, zoals de stap "Deno-typecheck
  pagina's" in de CI ze controleert. Deno zelf draait hier niet.
- **`npm test`** (2419) en **`npm run typecheck`**.
