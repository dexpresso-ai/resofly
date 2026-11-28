# Pagina's: actiepunten worden taken (stap 2-2a tot en met 2-2c)

28 november 2026. Zie `docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §13 en §18 (fase 2, met de
keuzes voor 2-2).

Uit fase 2: "actiepunten worden taken". Een regel in een takenlijst wordt met één klik een taak,
met een link terug naar de pagina. Het vinkje en de taak samen volgen in 2-2b.

## Wat er nu kan

- **"Maak er een taak van".** Zet de cursor in een regel van een takenlijst. De balk onder de
  werkbalk toont dan "Actiepunt", met de knop.
  - De taak komt in het project van de pagina. Staat de pagina bij een klant zonder project, dan
    wordt het een taak bij die klant. In het eigen dossier wordt het een losse taak.
  - Zonder datum. De taak staat bij het project onder Te doen, en in de weekplanner bij de
    ongeplande taken.
  - De tekst van de regel wordt de titel. Een vermelding gaat mee met de naam die jij ziet, of
    anders de soort. Lijsten onder de regel gaan niet mee.
  - Een lege regel wordt geen taak. De balk zegt dan: "Typ eerst wat er moet gebeuren".
  - Eén taak per regel. Klikt een collega tegelijk, dan zegt de editor dat de taak er al is.
- **Een label achter de regel**: "Taak · Te doen", "Bezig", "Review" of "Klaar", uit de geladen
  taken.
  - Bij bewerken zet een klik op het label de cursor in de regel. De balk toont dan de taak, met
    "Openen". Zo opent een klik om de cursor te zetten niets, net als bij een chip.
  - Bij alleen lezen opent een klik de taak.
  - Openen sluit de pagina eerst netjes: opslaan, een versie, de claim vrij.
- **"Uit pagina" in het taakvenster**, met de titel van de pagina. Een klik sluit het venster en
  opent de pagina.
- **De pagina zelf verandert niet.** De link staat bij de taak.
  - Wie Projecten niet mag lezen, ziet een gewone takenlijst, zonder label (regel 3).
  - De klant en de export zien de regel, niet de taak.
- **Rechten**: wie klikt, met de eigen rechten.
  - Inhoud schrijven en Projecten schrijven: de knop.
  - Projecten alleen lezen: het label, maar geen knop.
  - Mag je de klant van de pagina niet zien (geen Klanten), dan wordt het een losse taak. De
    database controleert de klant van een taak met jouw rechten, en gaf anders een kale fout.
  - Gerrie, de MCP en de API maken in deze stap geen taken uit een pagina.
- **Een regel bewerken** houdt de link, of de link raakt kwijt; hij komt nooit bij een andere
  regel. Nagelopen in de editor:
  - Enter aan het begin zet een lege regel erboven; het label blijft bij de tekst. Dat moest
    anders: gewoon splitsen gaf beide helften hetzelfde id, en dan gaf UniqueID ze allebei een
    nieuw. Het label raakte kwijt en de knop kwam terug.
  - Enter midden in de regel: het label blijft bij het eerste deel.
  - Backspace aan het begin van de regel eronder: het label blijft.
  - Kwijt bij Backspace aan het begin van de regel zelf (de tekst gaat naar de regel erboven) en
    bij het wissen van een selectie over twee regels. De knop komt dan terug, dus een tweede taak
    is mogelijk; de eerste blijft gewoon bestaan.
  - De tekst knippen laat de regel leeg achter, met het label. Plakken maakt een nieuwe regel,
    zonder label: UniqueID geeft geplakte blokken een nieuw id.

## Waarom de link bij de taak staat, en zonder foreign key

- Een taak-id in de body zou de body laten weten wat alleen Projecten mag weten. Bovendien moesten
  `page_body_problem`, de export en de klantweergave dan een nieuwe soort inhoud kennen. Elke regel
  heeft al een id (UniqueID), dus de taak onthoudt `page_id` en `page_block_id`.
- **Geen foreign key naar `documents`.** Met `on delete set null` wijzigt het definitief wissen
  van een pagina ook de taak. Dan houdt de schrijfpoort van Projecten (`zzz_module_write_gate`)
  dat tegen voor wie alleen Inhoud mag schrijven. Nagespeeld met zo'n foreign key in een
  teruggedraaide transactie: `delete_page_forever` faalde met "Geen toegang tot de module projects
  in deze organisatie".
  - De database controleert de link nu bij het schrijven: een pagina van dezelfde organisatie, die
    wie de taak opslaat mag lezen (`tasks_page_link`, geen security definer). Zo werkt het ook
    voor de klant, het project en het ticket van een taak (`assert_same_org_reference`).
  - Die controle loopt alleen als de pagina van de taak verandert. Bij elke wijziging opnieuw
    controleren liet wie Inhoud niet mag lezen zo'n taak niet meer verplaatsen, afvinken of
    hernoemen.
  - Na definitief wissen blijft er een id staan dat nergens meer heen wijst. Het taakvenster toont
    dan geen "Uit pagina".
- **Gevonden bij het nalezen:** `tasks.ticket_id` heeft wel zo'n foreign key
  (`20260822020000`). Een ticket wissen waar een taak aan hangt, mislukt dus voor wie Projecten niet
  mag schrijven. Dat staat los van deze stap; het rapport noemt het.

## Hoe het werkt

- **Migratie `20261128170000_paginas_taken.sql`:**
  - `tasks.page_id` en `tasks.page_block_id` (uuid). Een regel zonder pagina mag niet
    (`tasks_page_block_needs_page`).
  - Eén taak per regel (`tasks_page_block_unique`), en een index voor de taken van een pagina.
  - De trigger `tasks_page_link`.
- **`src/lib/pageTasks.ts`**: de taken van een pagina per regel (`pageTaskLinks`), de titel uit de
  regel (`taskTitleFromItem`), en de woorden voor de stand.
- **De editor** (`PageTaskLinks` in `src/lib/pageEditorExtensions.ts`): het label is een
  decoratie, geen inhoud. De pagina verandert er niet door, en versies en export zien het niet.
  PageEditor zet de taken in `editor.storage.pageTaskLinks`. Een lege transactie tekent de labels
  opnieuw, zonder op te slaan.
- **De balk** (`currentActionItem` in `PageEditor.tsx`): de binnenste regel waar de cursor staat.
- **`main.tsx`** maakt de taak langs dezelfde weg als "+ Taak" (`insertRow`, onder de RLS).
  `EditModal` toont "Uit pagina" als de pagina in de geladen gegevens staat.
- **De data-export** neemt de twee kolommen mee met de taken (`EXPORT_SCHEMA_VERSION`
  `20261128170000`).
- **De API** toont ze (nog) niet: die heeft een vaste lijst velden per taak. Webhooks ook niet:
  die sturen alleen `webhook_payload_columns`.

## Getest

- **Database** (`tests/database/paginas_taken.sql`, 13 controles), en de hele databasetest (24
  bestanden). De migratie draaide twee keer.
  - Een taak bij een regel, één per regel; een regel zonder pagina wordt geweigerd.
  - Geweigerd: een document dat geen pagina is, een pagina van een ander bureau (ook via de
    service-role), een pagina in de prullenbak, en een pagina die je niet mag lezen.
  - Wie Inhoud niet mag lezen, verplaatst, vinkt af en hernoemt zo'n taak gewoon. Een andere
    pagina eraan hangen kan die niet.
  - Wie alleen Inhoud mag schrijven, gooit de pagina weg en wist haar definitief. De taak blijft.
- **Unit**: `pageTasks.test.ts` (2), de taken per regel en de titel. `npm test` (2460) en
  `npm run typecheck`.
- **`ui.mjs paginas`**, de nieuwe stap tegen de echte database:
  - met de cursor in de regel en "Maak er een taak van" komt er een taak in het project, met de
    naam van de klant in de titel, en met de pagina en de regel;
  - het label "Taak · Te doen", en de balk toont de taak;
  - het id van de taak staat niet in de pagina;
  - een lege regel geeft geen knop, wel de uitleg;
  - "Taak openen" sluit de pagina (de claim vrij) en opent het taakvenster. "Uit pagina" opent de
    pagina weer, met het label;
  - met Projecten lezen: het label, geen knop. Zonder Projecten: geen label;
  - met Projecten en Inhoud maar zonder Klanten, op een klantpagina zonder project: een losse
    taak, met het label.
- **`ui.mjs paginas`, een tweede stap**: na elke bewerking hierboven staat het label bij tekst
  uit de gekoppelde regel, op die regel zelf als je zijn tekst knipte, of nergens. De eerste
  versie van die stap vond de fout bij Enter aan het begin.
- `ui.mjs` kent nu `--stap=<tekst>`: alleen de stappen met die tekst in hun naam, om één stap te
  herhalen zonder het hele scenario.

  De eerste run faalde bij "Nieuw → Pagina". De editor haalt nu ook `@tiptap/pm/view` binnen, en
  Vite bundelde dat pas tijdens de run (zoals eerder `@tiptap/pm/model`). `ui.mjs` bundelt het nu
  vooraf.

  Daarna: 23 stappen, 0 fout. Met de stap voor het bewerken van een regel, en Enter aan het
  begin: 24 stappen, 0 fout.
- `npm run test:terugknop` (18 gelukt, 0 mislukt): het taakvenster kan nu naar een pagina.
- `npm run test:mobile -- --pages=project,weekplanner --theme=both`: 12 metingen, 0 problemen.
  De nagebootste backend heeft geen taken uit een pagina; het label en "Uit pagina" toetst de
  schermtest hierboven.

## Uitrollen

Migratie `20261128170000` moet samen met of vóór de app naar staging. Zonder de kolommen
mislukt "Maak er een taak van" met een fout. Op 28 november om 16:48 samen met 2-0 tot en met
2-1c naar staging gezet (`7250aff`); het deploylog noemt de migratie.

## Stap 2-2b: het vinkje en de taak samen

### Wat er nu kan

- **Aanvinken zet de taak op Klaar.** Vink je een regel met een taak aan, dan gaat de taak op
  Klaar. Uitvinken zet haar terug op Te doen.
  - Een melding boven de pagina noemt de taak: "De taak "Offerte sturen" staat op Klaar." Een
    regel kan zijn tekst kwijt zijn (knippen) en toch zijn taak houden; zo zie je welke er klaar
    ging.
  - "Ongedaan maken" in die melding zet de taak terug, en het vinkje in de pagina ook. De
    melding verdwijnt na twaalf seconden vanzelf.
  - Het label achter de regel volgt meteen: "Taak · Klaar".
- **Alleen een klik telt.** Ongedaan maken in de editor (Ctrl+Z), een oude versie terugzetten of
  opnieuw laden zet het vinkje in de pagina om, maar niet de taak.
- **Een regel zonder taak** blijft een gewoon vinkje.
- **Projecten alleen lezen**: het vinkje zet alleen de regel om. De melding zegt dat de taak
  niet meegaat, zonder "Ongedaan maken".
- **Al klaar**: stond de taak al op Klaar (elders afgevinkt) en vink je de regel aan, dan
  verandert er aan de taak niets en komt er geen melding.
- **Snel achter elkaar klikken** zet de taak waar het vinkje eindigt. De verzoeken per taak gaan
  achter elkaar, en een klik vergelijkt met de laatst gevraagde stand. Eerst vergeleek de tweede
  klik met een stand die nog niet was bijgewerkt: die deed dan niets, en de taak bleef op Klaar
  met het vinkje uit (gevonden bij het nalezen; de test faalt op de oude code).

### Hoe het werkt

- `PageTaskLinks` luistert naar het `change`-event van een vinkje, op de editor zelf. Dat event
  komt alleen van een klik; TaskItem zet de pagina zelf al om, en daarna zet `PageEditor` de
  taak (`onSetTaskStatus`).
- `main.tsx` zet de stand langs dezelfde weg als het kanbanbord (`updateRow`, onder de RLS),
  met de rechten van wie klikt. Zonder Projecten schrijven krijgt de editor die functie niet.
- "Ongedaan maken" zet het vinkje terug met een transactie, niet met een klik. Zo zet dat de
  taak niet opnieuw om.

### Getest

- **`ui.mjs paginas`: 25 stappen, 0 fout.** De nieuwe stap:
  - aanvinken: de taak op Klaar, de melding noemt haar, het label "Taak · Klaar";
  - "Ongedaan maken": de taak op Te doen, het vinkje uit, ook in de opgeslagen pagina;
  - aan en weer uit: de taak op Te doen, met een melding;
  - twee snelle klikken (aan en meteen uit): het vinkje uit, de taak op Te doen;
  - Ctrl+Z na aanvinken: het vinkje uit, de taak blijft Klaar;
  - daarna weer aanvinken, met de taak al op Klaar: geen melding, de taak blijft Klaar;
  - een regel zonder taak: geen melding, de taak verandert niet;
  - met Projecten alleen lezen: "Alleen de regel is afgevinkt", geen "Ongedaan maken", de taak
    verandert niet.
- `npm test` (2460) en `npm run typecheck`.

## Stap 2-2c: bij delen en export volgt het vinkje de taak

### Wat er nu kan

- **Een download** (Word downloaden, PDF downloaden) heeft bij een regel met een taak het vinkje
  van de taak: aangevinkt als ze Klaar is, anders niet. Dat geldt ook als het vinkje in de pagina
  nog anders staat, en per hoofdstuk (subpagina) apart.
  - De taken komen met de rechten van wie downloadt. Wie Projecten niet mag lezen, krijgt de
    vinkjes zoals ze in de pagina staan.
  - De pagina zelf verandert er niet door.
- **Een kopie voor het dossier** (de Word-kopie, de vastgelegde PDF) heeft de vinkjes zoals ze in
  de pagina staan. Die kan iedereen met Inhoud openen, en de stand van een taak is van
  Projecten. Dat is dezelfde regel als bij de namen (2-1a).
- **In de editor een balk** als vinkjes achterlopen op hun taak: "2 vinkjes lopen achter op hun
  taak: 1 gaat aan, 1 gaat uit", met "Bijwerken" en "Laat zo".
  - "Bijwerken" zet ze gelijk, als transactie. Geen taak gaat om (2-2b), en de pagina slaat
    gewoon op.
  - "Laat zo" verbergt de balk voor precies die regels. Loopt er een andere regel achter, of
    een regel de andere kant op, dan komt hij terug.
  - Openen verandert niets: de balk vraagt het, de pagina doet niets vanzelf.
  - Delen schrijft ook niets vanzelf. De klant leest de opgeslagen pagina; met "Bijwerken"
    voor het delen ziet hij de vinkjes van de taken.
  - Vinkt iemand met alleen Projecten lezen een regel bewust af, dan telt die regel niet als
    achter: anders stelde de balk meteen voor om het terug te zetten.
- **Geen flits na een klik.** De luisteraar op het vinkje loopt nu in de capture-fase, vóór
  TaskItem. Daardoor staat de gevraagde stand al klaar als de pagina verandert. "Ongedaan maken"
  zet om dezelfde reden eerst de taak in de rij, en dan pas het vinkje.
- **Afdrukken** (alleen CSS): het label van een taak komt niet op papier, de vinkjes wel, zoals
  op het scherm. Dat gold al sinds 2-2a op staging: daar staat het label nog wel op papier.

### Hoe het werkt

- `supabase/functions/_shared/pageTaskChecks.ts`: `taskChecksFor` (per pagina en per regel) en
  `withTaskChecks` (de body met de vinkjes van de taken, met hoeveel er aan en uit gaan). Een
  gekopieerde pagina heeft dezelfde id's per regel als het origineel; daarom telt de pagina mee.
  Gedeeld door de app en `page-export`; de CI doet er `deno check` op.
- **Word** (`src/lib/pageWordExport.ts`) en **PDF** (`page-export`) lezen bij een download de
  taken van de pagina en haar hoofdstukken. `page-export` doet dat met de JWT van wie exporteert,
  nooit met de service-role. Lukt het lezen niet, dan de vinkjes van de pagina.
- **De editor**: `taskCheckDrift` en `syncTaskChecks` in `pageEditorExtensions.ts`. De balk telt
  met de standen die een klik al vroeg (2-2b), zodat hij niet even opflitst.

### Getest

- `pageTaskChecks.test.ts` (3):
  - twee pagina's met dezelfde regel-id, elk met de eigen taak;
  - aan en uit, ook genest; een regel zonder taak blijft zoals hij is;
  - dezelfde body als er niets verandert.
- **`npm run test:stromen -- documenten`: 62 stappen, 0 fout.** De nieuwe stap:
  - de PDF-download heeft `☒` bij een taak die Klaar is, al staat het vinkje in de pagina uit;
  - een PDF voor het dossier heeft `☐`;
  - wie Projecten niet mag lezen, krijgt `☐`;
  - de pagina is daarna niet veranderd.
- **`ui.mjs paginas`: 26 stappen, 0 fout.** De nieuwe stap:
  - de balk "2 vinkjes lopen achter op hun taak: 1 gaat aan, 1 gaat uit";
  - Word downloaden met de vinkjes van de taken, en de pagina onveranderd;
  - "Bijwerken": de vinkjes gelijk in de editor en in de opgeslagen pagina, en geen taak om;
  - een taak die weer open is: "1 gaat uit", en "Laat zo" laat het vinkje staan;
  - afdrukken (`emulateMedia print`): geen label, wel het vinkje.
- In de stap van 2-2b: na een bewuste klik met alleen Projecten lezen geen balk "loopt
  achter".
- De stap van 2-2b opnieuw, met de luisteraar in de capture-fase.
- `npm test` (2463), `npm run typecheck`, en `tsc` op `page-export` en de gedeelde modules.

### Uitrollen

`page-export` leest nu ook `tasks` (met de rechten van wie exporteert). Dat werkt op staging pas
na een merge en de uitrol van de edge functions. Geen migratie.

## Nog niet

- **Een taak die elders verandert**, krijgt pas een nieuw label als de app ververst (bijvoorbeeld
  na het sluiten van een taak of de pagina).
- **Meer regels tegelijk** ("Maak taken van alle open punten").
