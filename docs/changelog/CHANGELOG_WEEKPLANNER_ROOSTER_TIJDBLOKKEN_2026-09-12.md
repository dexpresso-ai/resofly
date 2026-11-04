# Weekplanner: rooster, werkvoorraad en tijdblokken (2026-09-12)

## Wat de PO vroeg

> De takenlijst rechts is veel te klein; ik wil toch een agenda-view zoals in de
> Agenda. Er moet een duidelijk verschil zijn tussen meetings en verplichte
> taken uit projecten die ingepland moeten worden. Maak er iets mindblowings van.

## Kritische blik op de oude planner

- **De lade was een bijzaak.** 268 pixels breed, maximaal 340 pixels hoog, rechts
  onderaan. Alles wat nog een plek zocht — het werk waar de planner om draait —
  zat in het kleinste vak van het scherm.
- **Drie lay-outs voor één vraag.** Rijen, kolommen en (voor het team) een raster;
  elk met eigen scrollvakken, sleepregels en randgevallen. De kolomweergave
  probeerde een agenda te zijn zonder tijd-as.
- **Afspraken en taken zagen er hetzelfde uit.** Beide waren een chip of kaart in
  een dagkolom; alleen de kleur (violet) verried een afspraak. Wanneer een
  afspraak begon of hoe lang hij duurde, zag je niet in verhouding tot je werk.
- **Een dag was een lijst, geen dag.** Zonder tijd-as kon de planner niet
  laten zien óf je werk nog paste tussen je afspraken, alleen hoeveel uur het
  bij elkaar was.

## Wat er nu staat

**Het rooster van de agenda is de planner.** Dezelfde `TimeBlockGrid` als in de
Agenda (dagen als kolommen, uren als rijen, sticky dagkoppen, "nu"-lijn, zoom
met Ctrl+scrol of knijpen) staat nu in de weekplanner, met de **werkvoorraad
links** op volle hoogte. "Rooster" is de standaard; de rijweergave blijft
bestaan als "Lijst".

**Twee talen in één rooster.**

| | Afspraak (meeting) | Taakblok (projectwerk) |
|---|---|---|
| Vulling | vol gevuld in de kleur van de agenda | licht getint in de projectkleur, zachte arcering |
| Rand | geen | 1,5 px stippellijn |
| Tekst | wit of donker, naar de vulling | de gewone tekstkleur van het thema |
| Extra | videocall-, uren- en taakteken | vinkje linksboven, `!` bij hoge prioriteit |
| Gedrag | klik opent de agenda op die dag | slepen, oprekken, afvinken, snelmenu |

Werk dat wel een dag maar nog geen tijd heeft staat als kaart in de dagband
("Dag") boven de kolom; weekstroken lopen daar als balk over hun dagen.

**Plannen is slepen.**

- Uit de werkvoorraad (of uit de dagband) het rooster in: de taak krijgt dag én
  tijd, de schatting is de blokduur. Zonder schatting wordt het een uur — een
  blok zonder duur bestaat niet — dat je daarna aan de randen oprekt.
- Een blok naar een andere dag of tijd: het blok blijft onder de aanwijzer
  hangen waar je het greep, klikt op het kwartier.
- Een blok terug de dagband in: de tijd gaat eraf, de dag blijft.
- Een blok (of kaart) naar de werkvoorraad: uit de planning.
- Een taak op een afspraakblok loslaten koppelt de taak aan die afspraak
  (bestond al voor de chips; werkt nu ook in het rooster).
- Ongedaan maken (Ctrl/Cmd+Z of de knop) kent nu ook het tijdstip.

**Tekenen is een taak maken.** Sleep een tijdvak in het rooster en het
formulier verschijnt ín dat vak: titel typen, Enter, klaar. "Montage 2u" zet de
duur uit de titel, anders is het getekende vak de duur.

**"Vul mijn week".** Eén knop zet al het werk zonder tijd in de vrije gaten
tussen 09:00 en 17:00, om afspraken en bestaande blokken heen, eerst de
dichtstbijzijnde deadline en de hoogste prioriteit. Het is een *voorstel*:
gestippelde blokken plus een balk met "Zo inplannen" — niets verandert tot je
ja zegt. Zonder streep spreidt het voorstel het werk (zo'n zes en een half uur
per dag inclusief afspraken); mét streep is de streep de grens. Het weekend
telt alleen mee als dat bij je streep aanstaat.

**Dagkop met inhoud.** Aantal taken, uren, "nog 2u vrij" (bij een streep) en de
drukte-balk (afspraken vs. taken) staan onder de dagnaam; het plusje maakt een
taak om negen uur die je meteen kunt verschuiven.

**Overal hetzelfde.** Het taakvenster kreeg het veld "Tijd in het rooster", en
de Agenda toont dezelfde taakblokken (verschuiven kan daar ook). Ook het
startscherm en de urenlogica zien de taak gewoon op zijn dag.

## Datamodel

Migratie `supabase/migrations/20260912000000_tasks_planned_start_minute.sql`
(toegepast op staging):

- `tasks.planned_start_minute integer null` — minuten na middernacht; alleen
  mét `planned_date` en nooit met `planned_end_date` (check-constraint).
- `reorder_task_planning` wist het tijdstip van de versleepte taak (een dag
  zonder tijd is het doel); `set_task_planning_period` wist het bij een strook.

## Code

- `src/lib/planning.ts` — `hasPlannedTime`, `taskBlockMinutes`, `snapMinute`,
  `clockLabel`, `applyTimeLocally` (spiegelt de update), `mergeBusySlots`,
  `freeGaps`, `sortForAutoPlan`, `proposeTimeBlocks` (+ zachte grens). Tests in
  `planning.test.ts` (11 nieuwe).
- `src/features/CalendarPage.tsx` — `TimeBlockGrid` is een `forwardRef` met
  `hitTest(x, y)`; nieuwe props voor taakblokken, dagband in plan-modus,
  voorbeeldblokken, tekenconcept, render-props voor dagkop en bandkaart.
  Afspraakblokken dragen `data-event-key`. `CalendarPage` geeft `onMoveTask`,
  projectkleur en projectnaam door.
- `src/features/WeekPlanner.tsx` — roosterweergave, werkvoorraad links, sleep
  naar tijdstip (`DropTarget` `time`), tekenen-maakt-taak (`GridQuickAdd`),
  "Vul mijn week", snelmenu "Tijd weghalen", kaarttitel slikt de pointerdown
  niet meer (de hele kaart is weer sleepbaar; Enter opent).
- `src/main.tsx` — `planTaskAtTime` (optimistisch), `quickAddTask` met tijd,
  taakformulier "Tijd in het rooster".
- `src/styles/globals.css` — blok "WEEKPLANNER · ROOSTER + TIJDBLOKKEN"
  achteraan.

## Verificatie

De app zit achter een magic-link-login; getest via een tijdelijk harnas met de
échte component, echte stylesheet en de echte app-schil (na afloop verwijderd).
Gemeten en gezien op 1440 px (donker en licht) en 390 px: bord vult tot de
onderrand, dagkop en dagband blijven synchroon (88/82/80 px), slepen vanuit de
werkvoorraad, bandkaart en blok naar tijd/dag/band/werkvoorraad, oprekken,
tekenen-maakt-taak, voorstel maken en toepassen, snelmenu, Lijst-weergave.
`npm run typecheck`, `npm test` (129) en `npm run build` groen.

## Nog open

- E2e met echte login op staging (de gebruikelijke restpost).
- Productie-migratie.
- Gerrie kent het tijdstip nog niet (`task.quick_plan` zet alleen de dag).
