# Changelog — Afspraak ↔ taak, en weektaken als volwaardige kaart — 2026-09-07

Twee ingrepen in de weekplanner, op verzoek van de PO:

1. **Een afspraak in de agenda koppel je aan een projecttaak — en andersom.**
2. **Weektaken** (werk over meerdere dagen) staan niet meer als een balkje van
   26 px boven de dagen, maar als een volwaardige kaart in een eigen blok.

Voorstel + mockup: https://claude.ai/code/artifact/4b33bec6-ce80-44d3-9846-edb578f5c89b
(alle drie de beslispunten door de PO bevestigd: weektaken = weekstroken,
kolomweergave = kaart óver de dagen heen, slepen op een afspraak = koppelen én
op die dag zetten).

## Database — migratie `20260907000000_calendar_event_links_task.sql` (TOEGEPAST op staging)

- `calendar_event_links.task_id` (optioneel, `on delete set null`) + partiële index.
- `validate_calendar_event_link()` uitgebreid: de taak moet van dezelfde
  organisatie zijn en is **leidend** voor project en klant (zelfde regel als
  `validate_time_entry`). Een losse taak zonder project/klant laat de eigen keuze staan.
- `sync_time_entry_from_link()` (versie uit 20260629000001) geeft `task_id` door
  aan de afgeleide urenpost en telt nu ook een koppeling met **alléén** een taak mee.
  Zo landen meeting-uren als "gewerkt van geschat" op de kaart.

Geen edge-function-deploy: de koppeling loopt via de database, de afspraak zelf
in Google/Microsoft/native verandert niet.

## Gedeeld rekenwerk — `src/lib/calendar-links.ts` (+ 7 tests)

`calendarEventLinkMatchesEvent` (was drie keer gekopieerd: main, agenda, planner),
`calendarEventKey`/`calendarLinkKey`, `groupLinksByTask`, `linkedMinutesOnDay`,
`remainingEstimateOnDay`, `formatLinkShort` ("di 10:00–11:30"), `formatLinkWhen`
("di 8 sep · 10:00–11:30"), `linkMinutes`, `localDayKey`. Zonder imports, dus
rechtstreeks onder `npm test`.

## Agenda (`CalendarPage.tsx`)

- `ClientProjectPicker` kent een derde veld **Taak** (open taken, gefilterd op
  project/klant; de gekoppelde taak blijft altijd zichtbaar). Kies je een taak
  mét project, dan volgen project en klant en gaan die twee op slot.
- Afspraakdetail: sectie *Klant, project & taak*, een taak-chip met **Open taak →**,
  en "Telt mee voor urenregistratie — op de taak".
- Aanmaak-/bewerkformulier (zwevend paneel én lijstweergave) hebben het veld ook;
  bij opslaan gaat `taskId` mee in de koppeling.
- Verplaatsen/herschalen van een afspraak neemt de taak mee naar de nieuwe
  starttijd (de koppeling zit op de starttijd in de unieke sleutel).
- Taakteken (vinkje-icoon) rechtsonder op een blok in het rooster; verborgen op
  blokken van minder dan drie kwartier.
- Nieuw: `initialDraft` + `onDraftConsumed` — **Tijd reserveren** vanuit een taak
  opent de agenda op de plandatum met het aanmaakpaneel voorgevuld (titel, klant,
  project, taak, resterende schatting als duur; 09:00 of het eerstvolgende hele
  uur als het vandaag is).

## Weekplanner (`WeekPlanner.tsx`)

- **Afspraak-chip draagt de taak** (`.wp-agenda-task`, met projectstipje) en is
  tijdens het slepen een **dropzone** (`DropTarget` kent `type: 'event'`; de
  chips gaan vóór de dagzones in `resolveTarget`). Loslaten = koppelen én op die
  dag zetten; ongedaan maken zet alleen de plek terug.
- **Agendapil op de kaart** (`.wp-task-agenda`): "di 10:00–11:30" of "2 afspraken",
  klik opent de agenda op die dag.
- **Snelmenu**, groep *Agenda*: *Tijd reserveren in agenda…*, *Koppel aan afspraak ▸*
  (de afspraken van deze week, dichtstbijzijnde bij de plandatum eerst, max 8) en
  *Ontkoppel van «…»*.
- **Geen dubbeltelling**: een taak telt op de dag van zijn gekoppelde afspraak
  alleen het deel van de schatting dat niet al in de afspraak zit (dagtaken én
  weekstroken). 4u taak + 1u30 meeting = 1u30 agenda + 2u30 taak, niet 5u30.
- **Weektaken als kaart.** `taskCard()` accepteert nu `bar`, `className`, `style`,
  `onPointerDown`, `grips`; `TaskCard` kreeg `period`, `agendaLinks`, `children`.
  - Rijweergave: blok `.wp-weektasks` ("Weektaken · n · ±Xu verdeeld over de
    dagen") met volle kaarten; slepen in een dag maakt er een dagtaak van
    (bestaande semantiek van `reorder_task_planning`).
  - Kolomweergave: dezelfde kaart óver zijn dagen (`.wp-task-bar`, rijhoogte
    `auto` i.p.v. 26 px) met de sleepranden; verschuiven/herschalen ongewijzigd.
  - Pijltjestoetsen op een weektaak-kaart verzetten de periode (zoals op de balk).
- Nieuwe props: `onLinkTaskToEvent`, `onUnlinkTaskEvent`, `onReserveTime`.

## Taakvenster — `src/components/TaskAgenda.tsx`

Sectie **Agenda** bij een bestaande taak: gekoppelde afspraken (datum/tijd, titel,
duur, "telt niet" als `track_time` uit staat), *Ontkoppelen* (alleen de taak van de
koppeling; klant/project blijven), **Tijd reserveren** en **Koppel bestaande
afspraak** (haalt een week terug t/m drie weken vooruit rond de plandatum op;
privé- en hele-dag-items blijven buiten de lijst).

## main.tsx

- `setCalendarEventLink(event, clientId, projectId, trackTime, taskId?)` —
  `taskId` weglaten laat de bestaande taak staan, `null` wist hem; alleen als
  klant, project én taak leeg zijn verdwijnt de koppeling.
- `linkTaskToEvent`, `unlinkTaskEvent` (`setCalendarEventLinkTask` in de
  repository), `reserveTimeForTask` (+ `calendarDraft`-state).
- Privé-afspraken zijn niet aan een taak te koppelen (koppeltabel is org-breed leesbaar).

## CSS

Autoritatief blok achteraan `globals.css` ("AFSPRAAK ↔ TAAK + WEEKTAKEN ALS KAART").
Geen gekleurde randbalkjes; de weektaak-kaart in de kolomweergave krijgt zijn
projectkleur als vulling via `color-mix`.

## Verificatie

- `npm run typecheck` schoon; `npm test` 118 groen (7 nieuw).
- Tijdelijk harnas (`wp-harness.html` + `src/__wp_harness.tsx`, weggegooid) met
  fixtures en een gemockte `functions.invoke` op het prototype: Weektaken-blok,
  periode-pillen, chip met taaknaam, agendapil "1u 30m / 4u", dagbalk zonder
  dubbeltelling (di: 3u afspraken + 4u taken i.p.v. 5u30), snelmenu met
  weeklijst, koppelen uit het menu, slepen op een chip (`is-drop`, koppelt,
  verplaatst naar ma, undo-label), kolomweergave (kaart 43 px hoog op
  `3 / span 4`, 2 grepen, verschuiven naar do werkt, titel opent de taak),
  sectie Agenda met kandidatenlijst en koppelen.
- Niet gedaan: e2e met echte login (magic link) en productie.
