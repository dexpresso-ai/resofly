# Weekplanner: vrije dagen (2026-11-25)

## Wat de PO vroeg

> Bouw een vrije dag keuze ook in.

Een vervolg op de netto tijd van gisteren
(`CHANGELOG_WEEKPLANNER_NETTO_TIJD_2026-11-24.md`). Daar stond als open punt:
een vakantiedag telde nog gewoon als acht uur werktijd.

## Wat er mis was

- Op je vakantie zei de dagkop "8u vrij", en de week rekende met 40 uur
  werktijd.
- **Vul mijn week** plande werk op een dag dat je er niet bent.
- Een hele-dag-afspraak "Vakantie" hielp niet. Agenda's geven niet betrouwbaar
  door of zo'n item bezet of vrij is, en een verjaardag is ook een
  hele-dag-item.

## Wat er nu kan

Je zet zelf een dag vrij. Een vrije dag heeft geen werktijd, en dus geen
netto tijd.

### Een dag vrij zetten

- **In de dagkop**, in het rooster en in de lijst: een palmboompje naast het
  plusje. Het verschijnt bij aanwijzen; op touch staat het er altijd. Staat de
  dag vrij, dan blijft het staan (goud), en zet een klik hem terug op werkdag.
- **In het paneel Weergave**, onder Werktijd: "Vrije dagen deze week", met een
  knop per werkdag. Voor een week vakantie zijn dat vijf knoppen naast elkaar,
  in plaats van vijf dagkoppen langs.
- Alleen op dagen die meetellen. Een weekend dat niet meetelt, is al vrij.

### Wat je ziet

- De dagkop zegt **Vrije dag**. Staat er toch iets, dan staat dat erachter in
  oranje, bijvoorbeeld **Vrije dag · 2u 15m**: dat werk moet naar een andere
  dag.
- De kolom in het rooster is rustig gearceerd. Op de telefoon is de dag in de
  dagstrip doorgestreept.
- De week rekent zonder die dag. Met een vrije vrijdag:
  `8u 30m afspraken · 23u 30m netto van 32u · 17u in 13 taken · 6u 30m vrij ·
  1 vrije dag · +2u 15m buiten je werkdagen`. In de tooltip: "Werktijd 32u
  (8u × 4 werkdagen, de standaard; 1 vrije dag) − afspraken …".
- **Vul mijn week** slaat vrije dagen altijd over.
- Een **weekstrook** die over je vrije dag loopt, verdeelt zijn uren over de
  andere werkdagen.

### Wie wat ziet

Strikt persoonlijk, net als je werktijd. Een collega, ook een eigenaar, ziet
je vrije dagen niet en zet ze niet voor je. In de teamweergave tellen ze niet
mee.

De weekplanner hoort bij Projecten (harde regel 3):

| Recht op Projecten | Vrije dagen zien | Vrije dagen zetten |
| --- | --- | --- |
| geen | nee | nee |
| alleen lezen | ja, je eigen | nee |
| volledig | ja, je eigen | ja |

Een boekhouder heeft geen Projecten en ziet en zet dus geen vrije dagen.

## Datamodel

Migratie `supabase/migrations/20261125090000_planner_vrije_dagen.sql`:

- de tabel `planner_days_off` (`organization_id`, `user_id`, `day`), met één
  rij per persoon per dag (uniek);
- alleen toevoegen en weghalen, geen bijwerken;
- een trigger die controleert dat de dag bij een lid van de organisatie hoort,
  en `prevent_organization_id_change`;
- RLS: lezen alleen je eigen dagen, één keer per vraag, in de vorm van
  `20261122200000`. Toevoegen en weghalen alleen voor jezelf, met schrijfrecht
  op de organisatie;
- `apply_module_gate('planner_days_off', 'projects')`.

De planner vraagt de vrije dagen per week op die je bekijkt, niet bij het
opstarten. De kern van de werkruimte laadt dus niets extra's.

## Code

- `src/lib/netTime.ts`:
  - `isWorkday`, `workMinutesOn`, `spanShares` en `taskLoadByDay` kennen de
    vrije dagen;
  - `netDay` kreeg `dayOff`;
  - `netWeek` telt `workdays` en `daysOff`.

  Vier tests erbij in `netTime.test.ts`.
- `src/lib/repository.ts`: `selectPlannerDaysOff` (per week) en
  `savePlannerDayOff`. Zonder migratie geeft de eerste een lege lijst, met
  een hint in de console.
- `src/types.ts`: `PlannerDayOff`.
- `src/features/WeekPlanner.tsx`:
  - de vrije dagen per week laden, met `toggleDayOff`: meteen in beeld, en
    terug als opslaan mislukt;
  - het palmboompje in de dagkop en de lijst;
  - `DaysOffControl` in het paneel Weergave;
  - de arcering via `dayClassName`;
  - "Vul mijn week" met de vrije dagen in `skipDays`.
- `src/features/CalendarPage.tsx`: `TimeBlockGrid` kreeg de optionele prop
  `dayClassName`. Die zet een klasse op de kop en de kolom van een dag; de
  agenda gebruikt hem niet.
- `src/styles/weekplanner.css`: het blok "Vrije dagen".
- `src/lib/exportManifest.ts`: `planner_days_off` gaat mee in de export.
  `EXPORT_SCHEMA_VERSION` is 20261125090000.
- `tests/database/vrije_dagen.sql` (nieuw): wie wat ziet en zet, en de regels
  op de tabel.
- `tests/mobile/mock/seed.mjs`: een vrije vrijdag in de nagebootste week,
  zodat de lay-outtest de planner ook mét een vrije dag meet.

## Getest

- `npm run typecheck` schoon, `npm test` groen: 2281 tests.
  - `roles.test.ts` ving eerst dat de tabel nog geen modulepoort had. Die is
    erbij.
  - `exportManifest.test.ts` dwong de regel in de export af.
- `supabase db start`: de hele keten vanaf nul, met deze migratie. Daarna
  `npm run test:database`: alle negen bestanden geslaagd, ook de nieuwe
  `vrije_dagen.sql` (19 controles) en `rls_een_keer_per_query.sql`.
- `npm run test:mobile -- --theme=both` op de geraakte pagina's: weekplanner,
  calendar, calendar-event, calendar-task, calendar-month, calendar-workweek,
  public-booking en app-agenda. 48 pagina's, 0 problemen.
- Met de hand tegen de mock, op 1440×900 en 390×844:
  - de vrije vrijdag uit de seed: gearceerd, met "Vrije dag · 2u 15m";
  - woensdag vrij gezet en vrijdag terug, in de dagkop;
  - het paneel toont "Wo 25" aan;
  - Vul mijn week zet niets op de vrije dag;
  - in de lijst staat "Vrije dag" in de kop;
  - op de telefoon is de dag doorgestreept in de dagstrip, zonder zijwaarts
    scrollen.
