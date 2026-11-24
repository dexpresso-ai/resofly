# Weekplanner rekent met netto tijd (2026-11-24)

## Wat de PO vroeg

> Zorg ervoor dat de weekplanner echt rekening houdt met netto tijd. Ook
> meetings dienen meegeteld te worden als uren die niet meer over de week
> ingezet kunnen worden.

## Wat er mis was

De planner tegen de mock-backend (week 48, 9u30 aan afspraken, 18u15 aan
taken) zei in de kop alleen: "9u 30m afspraken · 18u 15m in 13 taken". Geen
maat, dus ook geen netto tijd. De oorzaken:

- **Zonder dagstreep geen maat.** De streep stond standaard uit, en verstopt
  onder Weergave. Zonder streep toonde de planner alleen de verhouding tussen
  afspraken en taken. Hij kon nooit zeggen dat je werk niet meer paste, hoeveel
  meetings er ook in je week stonden.
- **"Vul mijn week" plande door je meetings heen.** Zonder streep spreidde
  het voorstel tot zes en een half uur per dag, en zette het wat daar niet in
  paste alsnog in het eerste vrije gat. Weekstroken namen geen minuut in.
- **Afspraken telden verkeerd:**
  - overlappende afspraken telden dubbel: dezelfde meeting in Google én in de
    ResoFly-agenda haalde twee keer een uur af;
  - de gedeelde agenda van een collega telde mee als jouw meetings;
  - afspraken en taken in het weekend telden mee tegen een streep die het
    weekend niet kende.
- **Een filter veranderde je vrije tijd.** Met een filter op één project
  rekende de dagkop alleen met de taken van dat project, en zei hij "6u vrij"
  terwijl de rest van je werk er gewoon nog stond.
- **Een blok zonder schatting telde nul.** In het rooster staat het een uur,
  in de telling stond het op nul.
- **Een weekstrook viel helemaal in de week in beeld.** Een strook van twee
  weken met twintig uur zette alle twintig uur in de eerste week.
- **In de teamweergave** stonden jouw meetings in de dagbalk, en werd het werk
  van het hele team gemeten tegen jouw persoonlijke streep.

## Wat er nu staat

### De som

    werktijd − afspraken = netto tijd
    netto tijd − taken   = vrij (of te veel)

- **Werktijd** is wat je zelf instelt onder Weergave → Werktijd. Heb je niets
  ingesteld, dan rekent de planner met **8 uur op werkdagen** (ma – vr).
  "Dagstreep" heet nu "Werktijd". De knop "Weghalen" is "Terug naar 8 uur":
  zonder werktijd bestaat er geen netto tijd.
- **Afspraken** zijn de afspraken met een tijd in je **eigen** agenda's
  (ResoFly, Google, Microsoft, ICS). Overlap telt één keer. Afspraken buiten je
  werkuren tellen ook mee: een uur in een meeting kun je niet aan een taak
  besteden. Een hele-dag-item telt niet, net als bij je beschikbaarheid in de
  boekingslinks: een verjaardag maakt je niet bezet.
- **Taken** zijn al je open taken van die week, los van zoeken en filters:
  - een blok in het rooster telt zijn duur (zonder schatting een uur);
  - een taak met alleen een dag telt zijn schatting;
  - een weekstrook telt zijn aandeel, verdeeld over de werkdagen van de hele
    strook;
  - een gekoppelde meeting telt niet dubbel (bestond al).

### Waar je het ziet

- **De kop** toont: `9u 30m afspraken · 30u 30m netto van 40u · 18u 15m in 13
  taken · 12u 15m vrij`, of `3u te veel`. De balk is je werktijd van de week:
  violet de afspraken, goud de taken, en wat leeg blijft is vrij. Over de balk
  staat de som voluit: "Werktijd 40u (8u × 5 werkdagen, de standaard) −
  afspraken 9u 30m = 30u 30m netto voor taken. Ingepland 18u 15m, dus 12u 15m
  vrij." Werk in het weekend dat niet meetelt staat er apart bij ("+2u in het
  weekend").
- **Elke dagkop** (rooster en lijst) toont: `3 · 6u 30m netto · 2u vrij`, of
  `45m te veel` in rood, met de som in de tooltip. "Over" is "te veel"
  geworden, want "45m over" kon twee dingen betekenen. In een smalle kolom
  (7 dagen) wijkt het woord "netto" en blijft het getal staan.
- **Op de telefoon** kleurt het stipje van een overvolle dag in de dagstrip
  rood.
- **"Vul mijn week"** plant nooit meer dan je netto tijd per dag. Daarbij telt
  ook werk dat een filter verbergt, en het aandeel van weekstroken. Wat niet
  past blijft liggen, met de melding "2 passen niet meer in je netto tijd". Het
  venster loopt van 09:00 tot 09:00 plus je werktijd, en minstens tot 17:00.
- **De teamweergave** toont alleen de taakuren van het team, zonder jouw
  afspraken en zonder jouw werktijd.

### Wat je ziet in "Mijn week"

Het rooster van "Mijn week" toont alleen afspraken uit je eigen agenda's:
dezelfde afspraken die van je tijd afgaan. De gedeelde agenda van een collega
zie je in de Agenda. Twee uitzonderingen, allebei omdat de planner het dan niet
beter weet:

- heb je geen eigen agenda die getoond wordt, alleen een gedeelde, dan telt
  die als de jouwe;
- zijn de agenda's nog niet geladen, dan telt alles.

## Code

- `src/lib/netTime.ts` (nieuw): de netto rekenmodule.
  - `workdayFrom` (standaard 8 uur), `isWorkday`, `ownCalendarEvents`;
  - `dayTaskMinutes`, `spanShares`, `taskLoadByDay`;
  - `netDay`, `netWeek`, `autoPlanWindowEnd`;
  - `hasEstimate` en `taskEstimateMinutes` (verhuisd uit `WeekPlanner.tsx`).

  Tests in `netTime.test.ts` (11).
- `src/lib/planning.ts`: `groupEventMinutesByDay` telt overlap één keer (test
  erbij in `planning.test.ts`). `mergeBusySlots` kent een dageinde, voor de
  dag van 25 uur aan het eind van de zomertijd.
- `src/features/WeekPlanner.tsx`:
  - eigen agenda's (`calendarSources`, `myEvents`);
  - de netto tijd per dag en per week (`myOpenTasks`, `myLoad`, `netByDay`,
    `net`), en `dayFigures` voor de dagkoppen;
  - de kop, de dagkoppen, de lijst, de dagstrip en het team;
  - `proposeWeek` met een strikte netto grens;
  - `CapacityControl` is het paneel Werktijd.
- `src/styles/weekplanner.css`: `.wp-stat.is-net`, `.wp-day-net`, de rode
  balk bij te veel, een container query op de dagkop en het rode stipje in de
  dagstrip.
- Gerrie: de handeling `planner.set_day_capacity` heet "Mijn werktijd per dag
  in de weekplanner instellen" en legt de netto tijd uit
  (`supabase/functions/_shared/actions/work.ts`, `src/lib/actions/work.ts`).

Geen migratie. Een rij met 0 minuten in `planner_day_capacity` betekende
"geen streep" en betekent nu "de standaard van 8 uur".

## Getest

- `npm run typecheck` schoon, `npm test` groen: 2268 tests, waarvan 12 nieuw.
- Schermafdrukken tegen de mock op 1440×900 en 390×844:
  - rooster, lijst en team;
  - het paneel Werktijd en "Vul mijn week" (6 taken, 4u45, binnen de netto
    tijd van wo – vr).

  De getallen kloppen met de hand nagerekend: maandag 8u − 1u30 = 6u30
  netto, 4u30 taken, 2u vrij; dinsdag 8u − 3u = 5u netto, 5u45 taken, 45m te
  veel; de week 40u − 9u30 = 30u30 netto, 18u15 taken, 12u15 vrij.
- `deno check` kon niet in de cloudsessie draaien: esm.sh is daar niet
  bereikbaar. De wijziging in de edge function is alleen tekst. De workflow op
  GitHub draait de check.

## Nog open

- **Een vrije dag.** Een vakantiedag als hele-dag-item in je agenda zet je
  werktijd van die dag nog niet op nul. Agenda's geven niet betrouwbaar door of
  een hele-dag-item "bezet" of "vrij" is. Daarvoor is een eigen keuze nodig,
  bijvoorbeeld "vrije dag" per dag in de planner.
- **Een meeting waar je voor bent uitgenodigd** in de ResoFly-agenda van een
  collega telt niet als de jouwe, tenzij hij ook in je eigen agenda staat (via
  de uitnodiging in Google of Outlook).
- E2e met echte login op staging (de gebruikelijke restpost).
