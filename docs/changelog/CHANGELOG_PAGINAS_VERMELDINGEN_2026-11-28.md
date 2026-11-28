# Pagina's: @-vermeldingen, de basis (stap 2-1a)

28 november 2026. Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §13 en §18 (fase 2).

De eerste stap van de @-vermeldingen uit fase 2: "@-vermeldingen van klanten, projecten, taken,
facturen en collega's, als levende chips". Deze stap legt de basis:
- de database neemt een vermelding aan, en houdt bij wat een pagina noemt;
- de editor toont een vermelding;
- Word, de PDF en de klant laten haar zien.

Kiezen met @ komt in 2-1b, en "Genoemd in" bij een klant of project in 2-1c.

## Wat er nu kan

- **Een vermelding in een pagina**: een klant, project, taak, factuur of collega, midden in de
  tekst, als chip.
  - De chip toont de naam van nu, met de rechten van wie kijkt.
  - Wie de klant of de factuur niet mag zien, of als die niet meer bestaat, ziet de soort:
    "@klant", "@factuur". Die chip is gedempt.
- **Word en de PDF downloaden** zetten de naam erin als je die mag zien, en anders de soort.
- **Een kopie voor het dossier** heeft alleen de soort: de Word-kopie ("Maak er een
  Word-document van") en de vastgelegde PDF. Die kan iedereen met Inhoud openen, ook wie de
  klant of de factuur niet mag zien.
  - Om dezelfde reden staat er op hun voorblad geen klant en geen project meer. Dat deden ze
    sinds 1B-4a (Word-kopie) en 1B-5 (vastleggen), en het staat al op staging: een lek tegen
    regel 3, gevonden bij het nalezen van deze stap.
  - Een download houdt het voorblad zoals het was. Wie downloadt, ziet alleen wat hij mag zien,
    en het bestand blijft bij hem.
- **De klant** (portaal en geheime link) ziet alleen de soort, geen naam. Dat is de strenge
  standaard, zoals bij een subpagina die niet gedeeld is. Of de klant de naam wel mag zien, is
  een vraag aan de gebruiker; het rapport noemt hem.
- **Een vermelding van iets uit een andere organisatie** weigert de database, langs elke weg:
  de app, de API, de MCP en Gerrie.
- **Plakken**: een vermelding die de editor niet kent, valt bij plakken weg. Uit een andere
  organisatie zou de database haar weigeren, en dan mislukte elke opslag van de pagina.
- Er is nog geen @-kiezer. Vermeldingen komen er nu alleen in via de API, de MCP of Gerrie, of
  door ze te kopiëren uit een andere pagina.

## Waarom alleen de soort en het id

Een vermelding bewaart `kind` en `id`, nooit een naam.
- Wie Inhoud mag lezen maar Klanten of Financiën niet, leest de body van een pagina wel. Een
  opgeslagen naam kwam dan via de body, de versies, de platte tekst, het uittreksel, de
  zoekindex en Gerrie bij die persoon terecht (CLAUDE.md, regel 3).
- De naam komt pas bij het tonen:
  - in de app uit de geladen gegevens, die de database al op rechten filtert;
  - in `page-export` en de Word-export met de sessie van wie exporteert, zoals het voorblad.
- Zo hoeft ook niemand een opgeslagen naam bij te werken.
- Een naam erbij opslaan kan later nog. Hem uit versies en de zoekindex halen kan niet.

De database weigert een vermelding met iets anders dan een bekende soort en een geldig id. Ook
een naam (`label`) of inhoud wordt geweigerd.

## Hoe het werkt

- **Migratie `20261128160000_paginas_vermeldingen.sql`:**
  - `page_body_allowed()` kent `mention` en de soorten (`mention_kinds`);
    `page_body_problem()` kijkt de vorm na.
  - `documents_page_vermeldingen` weigert een nieuwe vermelding van iets dat in een andere
    organisatie bestaat. Wat nergens bestaat, mag: anders kon een oude versie met een
    verwijderde taak niet terug. Een vermelding die er al stond, blokkeert het opslaan niet,
    net als bij de verwijzingen (20261127150000).
  - `page_mentions` houdt per pagina bij wat ze noemt (trigger `documents_page_mentions_sync`).
    Lezen gaat langs de regels van `documents`: Inhoud mogen lezen, en niet in de prullenbak.
    Daarbij de modulepoort voor Inhoud. Schrijven doet alleen de trigger.
  - De platte tekst (`page_body_text`) neemt alleen tekst mee. Een vermelding staat er dus
    niet in, en ook niet in de zoekindex.
- **`_shared/pageMentions.ts`**: de soorten, het woord per soort, en de vermeldingen uit een
  body. Gedeeld door de editor, Word, de PDF en de klantweergave.
- **De editor** (`Mention` in `src/lib/pageEditorExtensions.ts`):
  - een knoop in de tekst, die de naam leest uit `editor.storage.mention.names`;
  - `PageEditor` zet daar wat `main.tsx` uit de geladen gegevens haalt;
  - een collega heet naar zijn e-mailadres zonder domein.
- **Word en PDF**: `exportMentionNames` in `_shared/pageExport.ts` vraagt per tabel de namen
  op, met een functie die de app en `page-export` elk zelf meegeven. Lukt het lezen niet, dan
  blijft de soort staan: een naam is geen reden om de export te laten mislukken.
  - Alleen bij een download: `names` in `PageWordOptions` en in het verzoek aan `page-export`.
  - Zonder die keuze komen er geen namen in. Die regel geldt ook voor de klant en het project op
    het voorblad.
- **De klant**: `pageHtml.ts` zet `<span class="rf-mention">klant</span>`, zonder id.
- **De data-export** neemt `page_mentions` niet mee: de tabel is afgeleid uit de pagina's, en
  die gaan wel mee.

## Getest

- **Database** (`tests/database/paginas_vermeldingen.sql`), en de hele databasetest (23
  bestanden). De migratie draaide twee keer.
  - De vorm: vier soorten kan; een onbekende soort, een ongeldig id, een naam, inhoud of een
    lege vermelding niet.
  - Een klant of project van een ander bureau, of iemand die alleen elders lid is: geweigerd.
    Een taak die nergens bestaat: toegestaan.
  - Een oude vermelding blokkeert het opslaan niet.
  - `page_mentions`: elke vermelding één keer, bijgewerkt bij opslaan, weg met de pagina.
  - Lezen:
    - de eigenaar en wie Inhoud mag lezen: wel;
    - Inhoud "geen", een ander bureau en een pagina in de prullenbak: niet;
    - zelf schrijven: niemand.
  - Geen naam in de platte tekst.
- **Unit:**
  - `pageMentions.test.ts`;
  - in `pageExport.test.ts`: de verwijzingen, en de namen per tabel;
  - in `pageDocx.test.ts`: de naam, anders de soort;
  - in `pageHtml.test.ts`: de klant ziet de soort, zonder id;
  - in `pageEditorExtensions.test.ts`: de knoop in het schema, en plakken;
  - in `pageSchema.test.ts`: de soorten zijn die van de database.
- **`npm run test:stromen -- documenten`: 61 stappen, 0 fout.** De nieuwe stap:
  - de pagina bewaart geen naam;
  - de PDF van de medewerker heeft de naam van de klant, en bij een taak die er niet is de soort;
  - iemand met Inhoud maar zonder Klanten krijgt de soort;
  - een klant van de buren weigert de database via de API.
- **`ui.mjs paginaexport`: 9 stappen, 0 fout.** De subpagina noemt nu de klant:
  - Word downloaden en de PDF downloaden hebben zijn naam, en de PDF vraagt `names`;
  - de Word-kopie en de vastgelegde PDF hebben "klant", en nergens zijn naam, ook niet op het
    voorblad.
- **De stroomtest** kijkt ook een PDF voor het dossier na: geen klant op het voorblad, en bij
  de vermelding de soort.
- **`ui.mjs paginas`: 20 stappen, 0 fout.** De nieuwe stap:
  - een chip met de naam van de klant, en een gedempte "@taak";
  - typen en opslaan houdt de vermeldingen;
  - iemand zonder Klanten ziet "@klant".

  De eerste run faalde bij "Nieuw → Pagina". De editor haalt nu waarden uit `@tiptap/pm/model`
  (Fragment en Slice). Vite bundelde dat pakket met een lege cache pas tijdens de run, en
  herlaadde de pagina midden in de stap. `ui.mjs` bundelt het nu vooraf, zoals fontkit. De
  testen van de CI openen de pagina-editor niet.
- **`npm test`** (2450), **`npm run typecheck`**, en `tsc` op `page-export` en de gedeelde
  modules. De CI doet `deno check` (`pageMentions.ts` staat in de stap "Deno-typecheck
  pagina's").

## Stap 2-1b: de @-kiezer, en een chip openen

### Wat er nu kan

- **Typ @ en een stuk van een naam.** Er verschijnt een lijst met klanten, projecten, taken,
  facturen en collega's: alleen wat je mag lezen, want de lijst komt uit wat de app geladen
  heeft.
  - De beste eerst: de naam begint ermee, dan een woord in de naam ("@jan" vindt "Bakkerij
    Jansen"), dan ergens in de naam, en dan waar het bij hoort (de klant van een project).
  - Een gearchiveerd project en een afgeronde taak staan er niet in.
  - Pijltjes, Enter, Tab en Escape werken zoals bij het blokmenu. Een spatie sluit de kiezer,
    zoals daar: met spaties erin bleef hij open terwijl je de zin verder typte.
  - Een @ midden in een woord, zoals in jan@bedrijf.nl, opent de kiezer niet.
  - De terugknop van de telefoon sluit de kiezer, niet de pagina. Op een telefoon past de
    lijst op het scherm.
- **Een chip openen.**
  - Bij bewerken selecteert een klik de chip; daar klik je ook om de cursor te zetten. De balk
    toont dan de soort en de naam, met "Openen".
  - Bij alleen lezen opent een klik meteen.
  - Openen sluit de pagina eerst netjes: opslaan, een versie, de claim vrij. Mislukt het
    opslaan, dan blijft de pagina open en opent er niets.
  - Een klant of project opent zijn scherm, een taak of factuur haar venster. Een collega heeft
    geen eigen scherm.
- **De voorvertoning van een versie** toont de namen, maar opent niets en heeft geen kiezer.

### Hoe het werkt

- `src/lib/pageMentionSearch.ts`: de kandidaten uit de geladen gegevens en het zoeken. Puur, en
  met een geheugen, zodat niet bij elke toets alles opnieuw wordt opgebouwd.
- `src/features/PageMentionMenu.tsx`: de plugin (Suggestion met `@`) en de lijst, in de stijl
  van het blokmenu. De plek van de lijst komt uit het blokmenu (`menuStyleAt`).
- De editor bewaart `search` en `open` in `editor.storage.mention`. `main.tsx` geeft de
  zoekfunctie en het openen mee, en opent wat de chip noemt.

### Getest

- `pageMentionSearch.test.ts` (4): de kandidaten, het zoeken, het geheugen, de collega's.
- **`ui.mjs paginas`: 21 stappen, 0 fout.** De nieuwe stap:
  - een e-mailadres opent geen kiezer;
  - @ met het begin van de naam toont de klant;
  - Escape en de terugknop sluiten alleen de kiezer;
  - op 390 pixels past de lijst;
  - kiezen met een klik maakt een chip, en die staat in de database;
  - een klik op de chip opent niets, en de balk toont "Openen";
  - "Openen" sluit de pagina en opent de klant, met de claim vrij en de tekst opgeslagen.

  Na de terugknop is de focus weg; op een telefoon gaat dan ook het toetsenbord dicht. De test
  tikt daarna eerst weer in de tekst.
- `npm test` (2454) en `npm run typecheck`.

### Uitrollen

De migratie van 2-1a moet uiterlijk samen met de kiezer naar staging. Staat de app met de
kiezer eerder live dan de migratie, dan weigert de database de vermeldingen die de kiezer maakt.

## Nog niet

- **"Genoemd in"** bij een klant of project (2-1c).
- **Een hernoemde klant** krijgt in een open pagina pas bij opnieuw openen zijn nieuwe naam. De
  chip leest de naam bij het tekenen.
