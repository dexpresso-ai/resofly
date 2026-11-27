# Bouwplan: pagina's in de documentenomgeving (2026-11-27)

> **Stand op 27 november 2026: ontwerp, nog niets gebouwd.** De keuzes in §1 zijn die dag
> doorgesproken. Twee antwoorden lees ik op een bepaalde manier; die staan er apart bij, zodat
> ze te corrigeren zijn.

Vraag: *Ik wil eens met je gaan nadenken wat we kunnen doen om in onze documentenomgeving
eigenlijk een Notion variant te gaan maken. Dus niet alleen documenten via een echte docx of een
Excel, maar gewoon webpagina gebaseerde documenten met subpagina's die we dus in onze
documentenstructuur kunnen gaan aanmaken. […] Ik wil functionaliteit ook hebben dat het al wel
als een docx of pdf gemaakt kan worden. Ik wil ook tabellen kunnen maken in die pagina's.
Eigenlijk alles wat je in Notion kunt doen, maar dan net wat mooier en slimmer.*

**Kort.** Er komt een nieuw soort inhoud: de pagina. **Een pagina is een webpagina in ResoFly,
geen bestand.** Je maakt, leest en deelt hem in de browser, met een eigen adres, subpagina's en
links, zoals op een website. Word en PDF zijn alleen uitvoer: een kopie die je maakt als je op
Exporteren drukt.

1. **Pagina's vervangen de huidige tekstdocumenten.** Dat is de eenvoudige editor in de app, die
   nu ook al geen Word-bestand maakt. Een pagina bestaat uit blokken, kan subpagina's hebben en
   kent gewone tabellen. Echte Word-, Excel- en PowerPoint-bestanden blijven ernaast bestaan.
2. **Pagina's staan in de drive**: in klant- en projectdossiers, en in een eigen dossier van het
   bedrijf, met logo, voor het bedrijfshandboek.
3. **Export naar Word en PDF in de huisstijl**, langs één route: pagina → DOCX → PDF via de
   Collabora die er al staat.
4. **Delen is altijd een handeling.** De klant ziet alleen wat iemand gedeeld heeft, en van een
   pagina de versie die gedeeld is. Dat gaat ook gelden voor bestanden in een gedeelde map
   (stap 0).
5. **Fasering**: stap 0 en fase 1 leveren dit alles. Fase 2 maakt pagina's slim (vermeldingen,
   levende blokken, Gerrie per blok), fase 3 brengt samen typen en reacties van de klant. Later
   kan een pagina ook als openbare website op internet staan (§17).

## 1. Vastgelegde keuzes (27 november 2026)

| Vraag | Antwoord |
| --- | --- |
| Vervangen pagina's de tekstdocumenten, en later de notities? | "Ik volg!" |
| Gewone tabellen of databases? | "Ik bedoel nu eerst standaard tabellen met alleen content op die pagina." |
| Samen tegelijk typen vanaf dag één? | "Mag in fase 3." |
| Lezen klanten mee? | "Nee klanten mogen pas meelezen zodra document wordt gedeeld door eigenaar." Later: "Inderdaad ook klantbestanden worden pas gedeeld, wanneer de gebruiker van de app de deel functie gebruikt." |
| De PDF-export: zoals het scherm, of opgemaakt in de huisstijl? | In de huisstijl: "Inderdaad het tweede." Dit gaat alleen over de export; de pagina zelf blijft een webpagina. |
| Bedrijfshandboek in fase 1? | "Ja bedrijfshandboek nemen we mee. Eigen logo en structuur in de drive." |
| Pagina's ook als openbare website, vindbaar voor iedereen? | "Voor later in de toekomst wil ik dat wel." Zie §17. |
| Wie mag een pagina openbaar publiceren? | "alleen owner en admin mogen publishen" |

Zo lees ik twee van die antwoorden. Klopt dat niet, dan past dit plan zich aan:

- **"Gedeeld door eigenaar" en "de gebruiker van de app".** Iedereen in het team die mag delen
  (schrijfrechten op Inhoud, zoals nu), altijd als bewuste handeling. Er komt geen apart
  eigenaarschap per pagina.
- **"Ook klantbestanden".** Ook een bestand in een gedeelde map wordt pas zichtbaar als iemand
  het deelt. Dat is strenger dan het eerste voorstel ("bestanden gaan mee zoals nu"). Het wordt
  stap 0 (§7).

## 2. Wat er al was (27 november 2026)

- **Tekstdocumenten** (`documents`): HTML in `content`. De editor
  (`src/components/RichTextEditor.tsx`) werkt met `contentEditable` en `document.execCommand`:
  geen tabellen, geen blokken, geen blokken verslepen.
- **Word-modus**: is `storage_key` gezet, dan is het document een .docx in R2, bewerkt in
  Collabora via WOPI. `content` is dan een tekstspiegel voor voorvertoning en zoeken.
- **Laden**: `loadCoreData` (`src/lib/repository.ts:781`) haalt bij elke start alle documenten
  op met `select('*')`, dus met alle inhoud. GlobalSearch zoekt in die inhoud, in de browser
  (`src/components/GlobalSearch.tsx:118`). `DocumentCard` en `RelatedDocuments` tonen `content`
  als HTML.
- **Export** (`src/lib/documentExport.ts`): een eigen DOCX-schrijver, en een PDF met pdf-lib en
  standaardletters. Emoji vallen weg en "€" wordt "EUR".
- **Collabora**: één container (`workers/office-server/wrangler.toml`: image `collabora/code`,
  `max_instances = 1`), met een koude start van tot een minuut. DOCX → PDF kan alleen intern
  en alleen voor contracten (`handleInternalOfficeConvertPdf` in
  `workers/media-api/src/index.ts`, sleutelsegment `contract`, sinds de review van
  6 november 2026).
- **Huisstijl**: Documentopmaak (`src/lib/documentLayout.ts`, met een spiegel in `_shared`), de
  letters in `public/fonts/pdf` (alleen .woff), en het briefpapier in `company_settings`, dat
  los geladen wordt (`src/lib/letterhead.ts`).
- **Delen** (`drive_shares`): een map, bestand, notitie of document, naar een contactpersoon, een
  teamlid of een geheime link. Een gedeelde map is live: `drive_share_items`
  (`supabase/migrations/20260823000000_drive_shares.sql:505`) leest bij elke weergave wat er
  nú in de map staat. Zet iemand er later iets in, dan ziet de klant het meteen.
- **Logboek** (`audit_row_change`): `content` komt erin als "gewijzigd", zonder de tekst. Reeksen
  van dezelfde persoon binnen 10 minuten worden samengevoegd. Welke velden met hun waarde
  meegaan, staat in `audit_field_spec` (laatste definitie in
  `20261111220000_vooruitbetaalde_kosten.sql`).
- **Gerrie**: `content.search`, `content.get`, `document.update` (tekst aanvullen, met
  `loadContentHtml` zodat intussen getypte tekst niet verdwijnt) en `drive.share`
  (`supabase/functions/_shared/actions/content.ts`).
- **De drive**: klant → project → map. Inhoud zonder klant staat onder "Geen klant".
- **Presence**: private kanalen met een regel op `realtime.messages`
  (`20261101170000_realtime_private_chat_channels.sql`). Nu gebruikt door de teamchat.

## 3. Wat een pagina is

**Een webpagina, geen bestand.**

- Een pagina leeft in de app: je opent hem in de browser of op de telefoon, en er zit geen .docx
  achter.
- Elke pagina heeft een eigen adres, dat in de adresbalk blijft staan zolang hij open is. Dat is
  anders dan bij `?chat=`, dat na het openen verdwijnt.
- Kopieer je dat adres, dan opent een collega met rechten dezelfde pagina.
- Links naar subpagina's en andere pagina's werken zoals op een website.
- In de app heet het overal "Pagina".

**Opslag: een rij in de tabel `documents` met `format = 'page'`.** `documents` is alleen de naam
van de databasetabel. Waarom geen nieuwe tabel: delen,
het portaal, het logboek, het opslagquotum, de opruimwachtrij, de organisatiegrenzen
(`20261106150000_inhoud_binnen_organisatie`) en de handelingen van Gerrie werken al op
`documents`. Een nieuwe tabel zou op al die plekken een tweede variant vragen.

Nieuwe kolommen op `documents`:

| Kolom | Wat |
| --- | --- |
| `format` | `page`, `html` (oud, tot het omzetten klaar is) of `office` |
| `body jsonb` | de pagina als ProseMirror-JSON; elk blok heeft een vast `id` (uuid) |
| `parent_id`, `position` | de boom (§4) |
| `icon`, `cover jsonb`, `full_width` | het uiterlijk |
| `excerpt` | de eerste ±200 tekens, voor tegels en het klantscherm |
| `archived_at`, `archived_by` | de prullenbak (§4) |
| `editing_by`, `editing_seen_at` | wie nu bewerkt (§5) |
| `search tsvector` | zoeken (§6) |

`content` wordt voor pagina's een platte-tekstspiegel, zoals nu al bij de Word-modus.
`edit_version` en `last_edited_by` bestaan al.

**Waarom vaste blok-id's vanaf dag één.** Daarmee kan Gerrie in fase 2 per blok iets voorstellen
zonder over intussen getypte tekst heen te schrijven. Opmerkingen kunnen aan een blok hangen. En
samen typen in fase 3 kan zonder de opslag om te gooien.

**Blokken in fase 1:** tekst, kop 1 tot 3, opsomming, nummering, takenlijst, citaat, callout,
uitklapper, scheidingslijn, gewone tabel, afbeelding, bestand uit het dossier, inhoudsopgave,
subpagina en code. Kolommen (twee of drie, op de telefoon onder elkaar) komen als laatste en
mogen naar fase 2 schuiven.

**De gewone tabel:**

- een kopregel;
- rijen en kolommen toevoegen, verplaatsen en verwijderen;
- breedtes slepen, cellen samenvoegen, uitlijnen;
- een stuk uit Excel of Word plakken wordt een tabel.

Geen kolomtypes, formules, filters of weergaven: dat is een database, en die valt buiten dit
plan.

**Pagina-eigenschappen:** titel, icoon (lucide of emoji), cover (de merkkleur of een eigen
afbeelding), volle breedte aan of uit, en de soort (de huidige `document_type`: algemeen, beleid,
procedure, contract, overig).

## 4. De boom en de drive

- **Boom:** `parent_id` wijst naar een andere pagina. Een trigger bewaakt drie dingen: dezelfde
  organisatie, geen kringen, en hoogstens 20 diep (zoals bij mappen).
- **Waar een boom staat:** alleen de bovenste pagina heeft een `folder_id`. `client_id` en
  `project_id` gelden voor de hele boom: een trigger zet ze op alle subpagina's en houdt ze
  gelijk bij verplaatsen. Kopiëren in plaats van afleiden, omdat `drive_item_client`,
  `drive_share_items` en de controles uit `inhoud_binnen_organisatie` ze van de rij zelf lezen.
- **Het eigen dossier:** bovenaan de drive staat het bedrijf zelf, met logo en naam, met eigen
  mappen en pagina's. Dat is de plek voor het bedrijfshandboek: werkwijze, procedures, beleid en
  inwerken. Het vervangt "Geen klant". Daaronder staan de klanten.
- **Maken en ordenen:**
  - "Pagina" in het Nieuw-menu, naast Map en Word;
  - `/pagina` in een pagina maakt een subpagina;
  - sleep je een pagina op een andere, dan wordt hij een subpagina;
  - in de lijst een uitklappijltje, in de rasterweergave tegels met de cover.
- **Het pagina-scherm:** links de boom van het dossier, in het midden de pagina, rechts
  (inklapbaar) de versies. Bovenaan een kruimelpad.
- **Prullenbak:** weggooien zet `archived_at` op de pagina en al haar subpagina's. Je kunt ze 30
  dagen terugzetten; daarna zijn ze definitief weg, en gaan de bijlagen via de opruimwachtrij.
  Een pagina in de prullenbak is nergens zichtbaar, ook niet als hij gedeeld was.

## 5. Bewerken, opslaan en versies

- **Editor:** Tiptap (ProseMirror), headless, met onze eigen opmaak. De licentie per extensie
  nalopen vóór de bouw. De editor is een eigen stuk bundel en laadt pas als je een pagina opent
  (`lazyPage`, zoals pdf-lib nu).
- **Bediening:**
  - een slash-menu in het Nederlands (`/tabel`, `/kop`, `/taak`, `/pagina`);
  - markdown-sneltoetsen (`# `, `- `, `[] `, `> `);
  - een sleepgreep per blok;
  - op de telefoon een +-knop in plaats van `/`, en lang drukken om te slepen.
- **Eén tegelijk** (tot samen typen in fase 3):
  - wie gaat bewerken, claimt de pagina via de RPC `claim_page_edit`; de database beslist, niet
    de browser;
  - elke 30 seconden houdt een hartslag de claim vast;
  - de anderen lezen mee en zien "Sanne bewerkt deze pagina";
  - is de hartslag twee minuten weg, dan kun je het overnemen.
- **Opslaan:** automatisch, ongeveer anderhalve seconde na het typen. `edit_version` is de
  controle: heeft intussen iemand anders geschreven (Gerrie, de API, een overname), dan volgt
  een melding in plaats van een stille overschrijving.
- **Versies** in een nieuwe tabel `document_versions`: de body, de titel, wie, wanneer, en waarom
  (bewerksessie, vrijgave, vastgelegd, teruggezet).
  - Er komt een versie aan het eind van elke bewerksessie, en elk kwartier tijdens een lange
    sessie.
  - Terugzetten maakt een nieuwe versie, dus er gaat niets verloren.
  - Een versie die aan een klant is vrijgegeven, blijft altijd bewaard.
- **Logboek:** een nieuwe migratie geeft `documents` de nieuwe velden in `audit_field_spec`:
  - `body` als "gewijzigd" (`c`);
  - `parent_id` als verwijzing (`r`);
  - `archived_at` met waarde (`v`);
  - `position`, `excerpt`, `search`, `editing_by` en `editing_seen_at` genegeerd (`i`).

  Die migratie herdefinieert de functie vanaf de laatste versie (`20261111220000`). Doordat
  reeksen binnen 10 minuten worden samengevoegd, levert automatisch opslaan geen vloed aan
  regels.

## 6. Laden en zoeken (regel 5)

- `loadCoreData` haalt `documents` op met een kolomlijst, zonder `body` en zonder `content`.
- De inhoud van één pagina laadt bij het openen.
- **Zoeken op de server:**
  - Postgres full-text (`dutch`) op titel en `content`, met een GIN-index;
  - via een RPC onder RLS, zodat de modulerechten gelden;
  - GlobalSearch zoekt titels in de browser en de inhoud via die RPC;
  - de `content.search` van Gerrie gebruikt dezelfde index.
- **Dit moet in dezelfde stap als het weghalen van de inhoud uit de kern.** Anders vindt zoeken
  ineens niets meer.
- `DocumentCard`, `RelatedDocuments` en de andere plekken die `content` van een document als HTML
  tonen, tonen voortaan `excerpt`.
- `test:loading` controleert dat `body` en `content` niet in de kern zitten.

## 7. Delen: alleen wat iemand deelt

**De regel:** de klant ziet alleen wat iemand in het team met Delen heeft gedeeld, en van een
pagina de versie die gedeeld is. Twee dingen blijven zoals nu: delen vraagt schrijfrechten op
Inhoud, en een klantdocument gaat alleen naar het portaal van die klant en nooit via een losse
link.

### Stap 0: gedeelde mappen vullen zich niet meer vanzelf

Dit staat los van pagina's en verandert bestaand gedrag. Daarom krijgt het een eigen stap en een
eigen changelog.

- Een nieuwe tabel `drive_share_entries` (deling, soort, item, wie, wanneer). Deel je een map,
  dan komt daarin wat er op dat moment in staat. `drive_share_items` leest voortaan die lijst
  (met de klantcontrole die er al is) en niet meer de map zelf.
- Zet je iets in een gedeelde map, dan krijgt het in de drive het label "Niet gedeeld".
- Bovenaan de map staat dan een balk ("2 bestanden in deze gedeelde map zijn nog niet gedeeld met
  …"), met de knop "Ook delen".
- Een balk in plaats van een vraag na elke upload. Hij vangt elke weg waarlangs iets in de map komt
  (uploaden, een nieuw Word-bestand, verplaatsen, een notitie), en hij zit niet in de weg.
- Bestaande mapdelingen (alleen op staging; er is nog geen productie) krijgen één keer hun
  huidige inhoud in `drive_share_entries`. Zo verdwijnt er bij de klant niets.
- Een bestandsoverdracht (`drive_folder_leaves`) blijft zoals hij is: verzenden is al een
  handeling op één moment.

### Fase 1: pagina's delen

- **Delen is vrijgeven.** `drive_shares` krijgt `document_version_id`: de versie die de klant
  ziet. Wijzig je de pagina daarna, dan staat er "De klant ziet een oudere versie", met de knop
  "Bijwerken bij klant". Dat maakt een nieuwe versie en een nieuwe vrijgave, en het komt in het
  logboek. Zo weet je altijd welke versie de klant op welke dag zag.
- **Subpagina's:** het deelvenster toont de boom, en je vinkt aan welke meegaan (elk een eigen
  deling). Een subpagina die er later bij komt, is niet gedeeld.
- **Weergave in het portaal en bij een geheime link:** de klant leest een webpagina, geen PDF.
  - Het is de vrijgegeven versie, op de server omgezet naar HTML en gesaneerd.
  - Dat doet één module (`renderPageHtml`), die ook de app en het exportvoorbeeld gebruiken.
  - Die module heeft geen browser nodig. Zo draait hij ook in een edge function, en later in de
    Worker van de klantadressen (§17).
  - Een afbeelding wordt alleen geserveerd als hij in die versie staat.

## 8. Afbeeldingen en bestanden in een pagina

- Een geplakte of geüploade afbeelding wordt een bijlage (`attachments`, met
  `entity_type = 'document'` en als `entity_id` de pagina). Zo telt hij mee in het quotum, gaat
  hij mee in de opruimwachtrij als de pagina definitief weg is, en geldt de organisatiegrens.
- Een bestandsblok verwijst naar een bestand in hetzelfde dossier, met een voorvertoning. Een
  bestand van een andere organisatie of klant kan er niet in; dat dwingt de database af.

## 9. Export naar Word en PDF

Export is uitvoer. De pagina blijft de webpagina; de export is een kopie van dat moment, voor wie
een bestand nodig heeft: een bijlage, de printer, het archief.

**Eén route: pagina → DOCX → PDF via Collabora.** Daardoor zien Word en PDF er hetzelfde uit. Een
tweede tekenroute (bijvoorbeeld headless Chrome) zou uit elkaar gaan lopen, zoals bij offertes
en facturen gebeurde vóór Documentopmaak.

- **Een edge function `page-export`:**
  - werkt met de sessie: RLS bepaalt wat je mag lezen, en `organization_id` komt uit de sessie;
  - bouwt de DOCX met een module in `_shared`. Dat is de DOCX-schrijver uit
    `documentExport.ts`, uitgebreid met:
    - tabellen en afbeeldingen;
    - callouts (als gearceerde tabel), uitklappers (open) en kolommen (als tabel zonder randen);
    - een inhoudsopgave-veld en paginanummers;
    - een kop en voet met logo, briefpapier en merkkleur;
  - zet de DOCX in R2 onder een eigen sleutelsegment (`page-export`);
  - vraagt de media-worker om de PDF, via een nieuw intern pad dat alleen dat segment van de
    eigen organisatie aanneemt. Het contractpad blijft alleen contracten omzetten.
- **Het exportvenster:** een voorblad (titel, klant, project, datum, logo), een inhoudsopgave,
  subpagina's meenemen (als hoofdstukken), en briefpapier aan of uit.
- **Wat je ermee doet:**
  - downloaden als Word of PDF;
  - "Vastleggen in dossier": de PDF als vast bestand in de map;
  - "Maak er een Word-document van": een kopie in Office-modus voor de laatste puntjes. De
    pagina blijft de bron.
- **Collabora start koud.** Het exportvenster wekt hem al bij het openen. De PDF komt met een
  melding ("staat klaar in de map"), zodat je niet hoeft te wachten. Er draait één instance; bij
  meer gebruik gaat `max_instances` omhoog, en dat kost geld.
- **Eerst een proef: letters en emoji.**
  - De container is de standaard `collabora/code` en kent onze huisstijlletters niet.
  - In `public/fonts/pdf` staan alleen .woff-bestanden. De proef zoekt uit of LibreOffice die
    oppakt, of dat het TTF of OTF nodig heeft.
  - Twee wegen om te proberen: een eigen image met de letters en een emoji-letter, of de letters
    insluiten in de DOCX.

  Tot die proef slaagt, is alleen "€" zeker; huisstijlletters en emoji zijn dat niet.
- **Ctrl+P** blijft werken, met een nette printstijl.

## 10. De bestaande tekstdocumenten omzetten

- Er is nog geen productie, dus het gaat om de gegevens op staging. Dat houden we licht.
- HTML omzetten naar JSON kan niet in SQL. Daarom:
  - de editor zet een HTML-document om zodra je het opent (Tiptap leest HTML, en een
    `rf-task-list` wordt een takenlijst);
  - een eenmalig script zet de rest om op staging.
- Tot dat script gedraaid heeft, tonen het portaal, de export en het zoeken een HTML-document via
  de oude weg. Daarna, vóór de eerste klant, gaat die weg eruit en bestaat `format = 'html'` niet
  meer.
- Een bestaande deling van een document wordt een vrijgave van de omgezette versie.
- Notities blijven tot fase 2 zoals ze zijn.

## 11. Rechten, organisaties en invoer

- **Module Inhoud (`content`):** de rollen en de restrictive RLS gelden zonder wijziging. Wie
  alleen mag lezen, leest mee en kan geen pagina claimen.
- **De database dwingt af:**
  - de ouder hoort bij dezelfde organisatie, en kringen kunnen niet;
  - klant en project zijn gelijk aan die van de bovenste pagina;
  - een afbeelding of bestand van een andere organisatie of klant kan niet in een pagina.
- **`body` wordt gecontroleerd, langs elke weg waarlangs geschreven wordt** (app, Gerrie, MCP,
  API). Een trigger keurt onbekende bloktypes en onveilige links af; alleen `https:`, `mailto:`
  en `tel:` mogen. `renderPageHtml` saneert daarnaast bij het tonen.
- **Handelingen:** `actionTenancy.test.ts` krijgt elke nieuwe of gewijzigde handeling.

## 12. Gerrie in fase 1

- De bestaande handelingen blijven werken:
  - `content.get` geeft de pagina als tekst;
  - `content.search` zoekt via de index;
  - `document.update` (aanvullen) zet alinea's onderaan;
  - `drive.share` deelt de huidige versie.
- Tekst uit een pagina is gegevens, nooit een opdracht (regel 2).
- Voorstellen per blok komen in fase 2.

## 13. Fasering

**Stap 0, gedeelde mappen:** zie §7. Klein, los, en als eerste.

**Fase 1A, pagina's:**

- het datamodel en de migraties;
- laden, en zoeken op de server;
- de editor met de blokken en de gewone tabel;
- de boom in de drive, het eigen dossier met logo, en een eigen adres per pagina;
- de prullenbak, één tegelijk bewerken, en de versies;
- de tekstdocumenten omzetten.

**Fase 1B, export:** eerst de proef met letters en emoji. Daarna Word en PDF in de huisstijl,
vastleggen in het dossier, en de Word-kopie.

**Fase 1C, pagina's delen:** vrijgeven, "Bijwerken bij klant", subpagina's, en de weergave in het
portaal en bij een geheime link.

**Fase 2, slim:**

- @-vermeldingen van klanten, projecten, taken, facturen en collega's, als levende chips, met
  "Genoemd in" op het scherm van de klant of het project;
- levende blokken (open taken, uren tegen budget, openstaande facturen), met de rechten van wie
  kijkt; bij delen en export worden ze een momentopname;
- actiepunten worden taken;
- Gerrie stelt per blok voor, en gebruikt pagina's als kennis;
- sjablonen met `mergeTokens`, en projectsjablonen die een paginaboom aanmaken;
- opmerkingen;
- notities worden pagina's (handschrift als blok, labels, de koppeling met de agenda);
- privé-pagina's, als daartoe besloten wordt.

**Fase 3, samen en naar buiten:**

- samen typen: Yjs, met per pagina een Durable Object dat de JSON terugschrijft, zodat de opslag
  niet verandert;
- vaststellen, en "gelezen en begrepen";
- reageren en akkoord geven in het portaal;
- een presentatiemodus;
- importeren uit Word en Notion;
- ingesloten video's en ontwerpen: een vaste lijst domeinen, in een sandbox, met de CSP erop
  aangepast.

**Later, openbaar publiceren:** pagina's als website op internet (§17).

## 14. Tests

- **Unit** (`npm test`):
  - HTML → pagina, met `rf-task-list`;
  - pagina → DOCX (tabellen, kop en voet);
  - `renderPageHtml`: geen script, geen onveilige links;
  - de hulpjes voor de boom.
- **Database** (`tests/database`):
  - organisatie- en klantgrenzen, kringen, en overerving bij verplaatsen;
  - de prullenbak, claimen en overnemen, en de controle op `body`;
  - vrijgave en versies;
  - `drive_share_entries`: een later toegevoegd bestand lekt niet.
- **Stromen** (`tests/stromen/documenten.mjs` en `ui.mjs`):
  - een pagina, een subpagina en een tabel maken;
  - delen met de klant, waarna het portaal de vrijgegeven versie toont;
  - een wijziging is pas na "Bijwerken bij klant" zichtbaar;
  - een nieuwe subpagina en een nieuw bestand in een gedeelde map zijn niet zichtbaar.
- **Worker** (`tests/stromen/werker-documenten.mjs`): het exportpad neemt alleen
  `page-export`-sleutels van de eigen organisatie aan, en het contractpad is ongewijzigd.
- **Verder:**
  - `test:loading`;
  - `test:mobile -- --theme=both` (editor, +-knop, tabel);
  - `test:terugknop` (van een subpagina terug naar de vorige pagina, en het exportvenster sluiten
    met terug);
  - `dataGroups.test.ts` en `actionTenancy.test.ts`;
  - `deno check` voor `page-export`.

## 15. Risico's

1. **Letters en emoji in de PDF** hangen af van de Collabora-container. Daarom eerst de proef in
   fase 1B.
2. **Zoeken breekt** als de inhoud uit de kern gaat zonder dat het zoeken op de server klaarstaat.
   Daarom gaan die twee in dezelfde stap.
3. **Stap 0 verandert gedrag dat gebruikers kennen**: een gedeelde map vult zich niet meer
   vanzelf. Dat moet uitgelegd worden, in de app en in de changelog.
4. **Collabora** heeft één instance en een koude start. Daarom gebeurt exporteren op de
   achtergrond, met een melding.
5. **De editor op de telefoon** (het toetsenbord van iOS, selecteren in tabellen). Vroeg testen.
6. **De licenties** van de Tiptap-extensies.

## 16. Open punten

- **Privé-pagina's** (alleen voor jou): wel of niet? En zien Owner en Admin ze?
- **Kolommen:** in fase 1 of in fase 2?
- **Tussenversies:** hoe lang bewaren we die? Vrijgegeven versies blijven altijd.
- **Collabora:** hoeveel instances bij meer gebruik?

## 17. Later: pagina's als openbare website

Vastgelegd op 27 november 2026: "Voor later in de toekomst wil ik dat wel." Het is nog niet
ingepland. Dit is de richting, zodat fase 1 de deur openhoudt.

**Wat:** een pagina, met de subpagina's die je kiest, als website die iedereen kan lezen en vinden.
Denk aan een kennisbank, veelgestelde vragen, je werkwijze of vacatures.

**Waar:** op het eigen adres van de organisatie, in haar huisstijl. Dat is `<naam>.resofly.com` of
een eigen domein via Cloudflare for SaaS (zie `EIGEN_SUBDOMEIN_PLAN_2026-11-08.md`). De Worker van
de klantadressen (`workers/client-domains`) serveert dan ook deze pagina's.

**Regels:**

- **Publiceren is vrijgeven,** net als bij een klant. Het internet ziet alleen de vrijgegeven
  versie; wat je daarna wijzigt, staat pas online na "Bijwerken op website".
- **Alleen pagina's uit het eigen dossier.** Een pagina uit een klant- of projectdossier kan nooit
  openbaar. Dat is de AVG, en dezelfde gedachte als "een klantdocument kan niet via een losse
  link".
- **Geen levende blokken en geen vermeldingen** van klanten of contactpersonen (fase 2) op een
  openbare pagina.
- **Vindbaar maken:**
  - echte HTML van de server, niet de app;
  - een titel en een beschrijving;
  - de cover als voorbeeldplaatje als iemand de link deelt;
  - een sitemap en leesbare adressen (`/werkwijze/oplevering`);
  - een keuze "niet vindbaar voor zoekmachines".
- **Offline halen:** Cloudflare bewaart de pagina's in een cache. Haal je een pagina offline, dan
  verdwijnt hij van de site en uit die cache. Wat eenmaal openbaar was, kan wel al gekopieerd
  zijn; de app zegt dat bij het publiceren.
- **Misbruik:** een openbare pagina op een adres van ResoFly kan voor phishing gebruikt worden.
  Daarom:
  - geen formulieren en geen scripts in pagina's (de controle op `body` laat ze al niet toe);
  - een knop om een pagina te melden;
  - een regel in de voorwaarden om een pagina offline te halen.

**Wat fase 1 er nu al voor doet:**

- `renderPageHtml` heeft geen browser nodig (§7), dus de Worker kan hem later gebruiken.
- Een vrijgave is "deze versie voor deze ontvanger". Openbaar wordt later één soort ontvanger
  erbij, geen nieuw model.

**Wie mag publiceren:** alleen Owner en Admin. Dat is vastgelegd op 27 november 2026: "alleen
owner en admin mogen publishen". Openbaar reikt verder dan delen met één klant.

- **De database dwingt het af, niet alleen het scherm.** Publiceren, "Bijwerken op website" en
  offline halen lopen via een RPC die de rol controleert.
- **Gerrie en de agents kunnen publiceren hoogstens voorstellen.** Een voorstel loopt met de rechten
  van wie het goedkeurt (regel 2), dus alleen een Owner of Admin kan het laten gebeuren.
- **Een gewoon teamlid** ziet wel dat een pagina openbaar staat, maar kan dat niet veranderen.
- **Test:** een Member en een Viewer kunnen niet publiceren of bijwerken, ook niet rechtstreeks
  tegen de database.

## 18. Bouwvolgorde in tussenstappen

Vastgelegd op 27 november 2026: "Bouw deze functionaliteiten in, conform plan. En zorg ervoor dat
je alles keurig goed de fases opdeelt".

Elke stap is klein genoeg voor één werksessie, en wordt los opgeleverd: code, tests, changelog,
gepusht. Pas daarna begint de volgende, het liefst in een nieuw gesprek, met dit plan en de
changelog als overdracht. Een stap gaat naar staging zodra de tests groen zijn en de gebruiker
akkoord is.

| Stap | Wat | Status |
| --- | --- | --- |
| 0 | Gedeelde mappen vullen zich niet meer vanzelf (§7). | gebouwd en op staging gezet op 27 november; zie `docs/changelog/CHANGELOG_GEDEELDE_MAPPEN_2026-11-27.md` |
| 1A-1 | Datamodel en migraties: de kolommen op `documents`, `document_versions`, de triggers (boom, overerving, organisatie, controle op `body`), `claim_page_edit`, de zoekindex met zoek-RPC, de logboekvelden. Met databasetests, nog zonder scherm. | gebouwd en op staging gezet op 27 november; zie `docs/changelog/CHANGELOG_PAGINAS_DATAMODEL_2026-11-27.md` |
| 1A-2 | Laden en zoeken: de kolomlijst in `loadCoreData`, `excerpt` in de kaarten, GlobalSearch en `content.search` via de zoek-RPC. In één stap, anders breekt zoeken (§6). | gebouwd en op staging gezet op 27 november; zie `docs/changelog/CHANGELOG_PAGINAS_LADEN_ZOEKEN_2026-11-27.md`. Gerrie zoekt bewust nog zoals voorheen (zie daar) |
| 1A-3a | De editor: Tiptap als eigen stuk bundel, het pagina-scherm, de basisblokken, opslaan met `edit_version`, één tegelijk bewerken. | gebouwd en op staging gezet op 27 november; zie `docs/changelog/CHANGELOG_PAGINAS_EDITOR_2026-11-27.md` |
| 1A-3b | Het versiepaneel (bekijken en terugzetten) en een eigen adres per pagina. | gebouwd en op staging gezet op 27 november; zie `docs/changelog/CHANGELOG_PAGINAS_VERSIES_ADRES_2026-11-27.md` |
| 1A-4a | Eerst een grendel: een pagina met een blok dat de editor niet kent, gaat niet open om te bewerken. Dan de blokken zonder opslag: gewone tabel, callout, uitklapper, inhoudsopgave. Het blokmenu: `/` in de tekst en de +-knop, ook op de telefoon. Een migratie die de maten van tabelcellen en de soort callout nakijkt. | in aanbouw |
| 1A-4b | De blokken met opslag en verwijzingen: afbeelding, bestand uit het dossier, subpagina (§8). Met een migratie die afdwingt dat een bijlage van dezelfde organisatie en hetzelfde dossier is. | gepland |
| 1A-5 | De drive: de boom, het eigen dossier met logo, "Pagina" in het Nieuw-menu, slepen, de prullenbak. De tekstdocumenten omzetten. | gepland |
| 1B-1 | Proef: huisstijlletters en emoji in een PDF via Collabora (§9). | gepland |
| 1B-2 | Export: `page-export`, de DOCX-module, het interne PDF-pad, het exportvenster, vastleggen in het dossier, de Word-kopie. | gepland |
| 1C | Pagina's delen: vrijgeven, "Bijwerken bij klant", subpagina's, de weergave in het portaal en bij een geheime link. | gepland |

**Afwijkingen van §3 en §5, vastgelegd bij de bouw van 1A-1 (27 november):**

- **Wie bewerkt, staat in een eigen tabel** (`document_edit_claims`), niet in `editing_by` en
  `editing_seen_at` op `documents`. Een trigger zet `updated_at` bij elke wijziging van een
  document. Een hartslag elke 30 seconden zou "laatst gewijzigd" dan steeds laten verspringen
  en het logboek vullen.
- **De zoekindex is een expressie-index**, geen kolom `search`. Een kolom zou tot stap 1A-2 bij
  elke start meeladen (`select('*')`), en hij zou mee moeten in het logboek en de export.
- **`content` en `excerpt` houdt de database bij.** Bij een pagina maakt een trigger de
  platte tekst uit `body`, en bij elk document de korte tekst voor de tegels. Zo kloppen ze
  ook als Gerrie, de API of de Word-editor schrijft.

**Voorwaarden voor 1A-3, vastgelegd bij de oplevering van 1A-2 (27 november):**

- **Tekst aanvullen door Gerrie bij een pagina.** De database weigert bij een pagina een
  wijziging van alleen `content`. Zodra er pagina's zijn, mislukken daar
  `appendToContent`, het toepassen van `document.update` in de app en `planContentUpdate`
  op de server. Kies één van twee: aanvullen als alinea's in `body`, of pagina's
  weglaten uit `contentTargetsFrom` en uit wat Gerrie als doel kan kiezen.
- **Delen bij een pagina** verbergen of uitzetten in het menu van de drive en in het
  deelvenster, met een uitleg. De database weigert het tot 1C, anders krijgt de
  gebruiker een kale foutmelding.
- **De editor:** de licentie per Tiptap-extensie nakijken. De namen van de blokken moeten
  precies die van `src/lib/pageSchema.ts` zijn. De editor blijft een eigen stuk bundel,
  dat pas laadt als je een pagina opent.

**Stand op 27 november 2026, einde van de eerste bouwsessie (overdracht):**

- **Op staging sinds 27 november:** stap 0, 1A-1, 1A-2, 1A-3a en 1A-3b, gemerged op
  verzoek van de gebruiker (merge `416b997`). Verder bouwen gebeurt op de branch
  `claude/affectionate-meitner-arfqck`; mergen pas als de gebruiker het zegt.
  - Frontend checks op de branch: groen, met typecheck, unit tests, de schermtests, `deno
    check` en de migraties vanaf nul met de databasetests.
  - Deploy Supabase (staging): groen. Beide migraties zijn toegepast, de edge functions
    staan erop en de rooktest is geslaagd.
  - De browsercontrole van "ongedaan maken" is daarna gedraaid: `tests/stromen/ui.mjs
    documenten`, 16 stappen, 0 fout. Laden telt niet mee in de geschiedenis
    (`addToHistory: false`); zonder die regel maakte Ctrl+Z direct na het openen de pagina
    leeg.
- **Volgende stap: 1A-4**, de overige blokken: tabel, afbeelding, bestand, callout,
  uitklapper, inhoudsopgave en subpagina, plus het slash-menu en de +-knop.
- **Nog open:** hoeveel bestaande mapdelingen de datastap van `20261127120000` omzette.
  `supabase db push` toont geen aantallen, en een cloudsessie kan staging niet lezen. In
  de werkruimte van de ResoFly-koppeling liepen geen delingen. Voor de andere organisaties:
  nakijken in de app, zie "Nakijken op staging" in
  `docs/changelog/CHANGELOG_GEDEELDE_MAPPEN_2026-11-27.md`.
- **Tip voor de volgende sessie:**
  - Start `dockerd` pas vlak voor de database- en UI-tests: een achtergrondtaak stopt na
    twee uur.
  - Docker Hub kan downloads weigeren (429). Images die al lokaal staan, starten dan nog
    wel.
  - Na een `npm install` de testpakketten opnieuw zetten:
    `npm install --no-save xss@1.0.15 fast-xml-parser@4.5.0`.
