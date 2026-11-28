# Pagina's: actiepunten worden taken (stap 2-2a)

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
  - Gerrie, de MCP en de API maken in deze stap geen taken uit een pagina.

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
- **De API** toont ze (nog) niet: die heeft een vaste lijst velden per taak.

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
  - met Projecten lezen: het label, geen knop. Zonder Projecten: geen label.

  De eerste run faalde bij "Nieuw → Pagina". De editor haalt nu ook `@tiptap/pm/view` binnen, en
  Vite bundelde dat pas tijdens de run (zoals eerder `@tiptap/pm/model`). `ui.mjs` bundelt het nu
  vooraf.

  Daarna: 23 stappen, 0 fout.
- `npm run test:terugknop` (18 gelukt, 0 mislukt): het taakvenster kan nu naar een pagina.
- `npm run test:mobile -- --pages=project,weekplanner --theme=both`: 12 metingen, 0 problemen.
  De nagebootste backend heeft geen taken uit een pagina; het label en "Uit pagina" toetst de
  schermtest hierboven.

## Uitrollen

Migratie `20261128170000` moet samen met of vóór de app naar staging. Zonder de kolommen
mislukt "Maak er een taak van" met een fout.

## Nog niet

- **Het vinkje en de taak samen (2-2b).** Nu staan ze los: aanvinken in de pagina verandert de
  taak niet. Het label laat zien hoe de taak ervoor staat.
- **Een taak die elders verandert**, krijgt pas een nieuw label als de app ververst (bijvoorbeeld
  na het sluiten van een taak of de pagina).
- **Meer regels tegelijk** ("Maak taken van alle open punten").
