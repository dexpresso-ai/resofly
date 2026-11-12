# Agenda: kleinere letters, en een maandoverzicht in kleur met bezetting (2026-11-12)

## Aanleiding

"Zorg ervoor dat het lettertype van de agenda een stukje kleiner is, zodat het
wat overzichtelijker is. Zorg er daarnaast voor dat zodra ik het maandoverzicht
open, dat het overzicht exact hetzelfde is als een Google Calendar, waarbij ik
alle activiteiten en de bezetting en de kleurtjes van de agenda zie."
En daarna: "Gaat met name voor het overzicht bij de mobiele telefoon."

## Wat er misging

- De letters van de agenda waren te groot voor een overzicht. In de maand
  pasten op een laptopscherm maar drie afspraken per dag voordat "+N meer"
  verscheen.
- Op de telefoon was het maandoverzicht vooral een rij getallen. De maand
  opende met het lijstje van vandaag eronder, en dat nam 40% van het scherm.
  Per weekrij bleef er plek voor één regel, dus stond er bij bijna elke dag
  alleen "+4"; afspraken zelf zag je nauwelijks.
- In de maand was een afspraak met een tijd een stipje van 8px voor zwarte
  tekst. De maand las als een grijze lijst: welke agenda waar zat, zag je
  niet. Alleen afspraken van een hele dag hadden kleur.
- Hoe vol een dag was, zag je niet. Vier korte belletjes en drie werksessies
  van drie uur leken even druk, en wat achter "+N meer" zat telde niet mee.
- "+2 meer" stond er als "+2meer": de spatie viel weg in de flex-opmaak.

## Wat er nu klopt

**Kleinere letters in de hele agenda** (dag, 3 dagen, week, maand, lijst), op
de telefoon en op de computer. Alle lettergroottes van de agenda schalen nu
met één knop, `--cal-fs` op `.calendar-agenda-page`. Die staat op 0,92: een
stap kleiner, zo'n 1px op de meeste teksten.

**Het maandoverzicht op de telefoon, zoals Google Agenda:**

- Het rooster krijgt het hele scherm. Het lijstje van een dag komt pas als je
  die dag aantikt, met een kruisje om het te sluiten (of tik de dag nog eens
  aan). "Vandaag" en een andere maand openen het niet vanzelf.
- Kleinere regels (15px, datumrij 24px): op een telefoon van 844px hoog
  passen er per dag vier regels in plaats van één.
- De blokjes vullen bijna de hele dagkolom, met alleen de titel; de tijd past
  er in een kolom van 54px niet bij (zo was het al).

**Het maandoverzicht, op elk scherm:**

- Elke afspraak is een gevuld blokje in de kleur van zijn agenda, met de
  begintijd ervoor ("09:00 Overleg Joost"). De tekst is donker op een lichte
  kleur en wit op een donkere, net als de blokken in de week.
- Een afspraak van meerdere dagen of een hele dag blijft één doorlopende balk.
- Een taak is, net als in de week, licht getint met een stippelrand in de
  kleur van zijn project. Het woord "Taak" ervoor is weg; de rand zegt het al,
  en de tooltip noemt het nog.
- Op de computer passen er meer regels per dag: vijf in plaats van vier op
  een scherm van 900px hoog (regels van 17px in plaats van 20px).

**Bezetting per dag.** Boven elk dagnummer staat een dun balkje. Vol is je
werkdag: je dagstreep uit de Planner, anders 8 uur. De stukjes hebben de
kleur van de agenda waar de uren vandaan komen. Wijs je de datum aan, dan
staat er hoeveel: "woensdag 11 november 2026 · 5u 30m bezet van 8u".

- Alleen afspraken met een tijd tellen. Een verjaardag of "hele dag" maakt je
  niet bezet (Google telt die ook als vrij).
- Overlap telt één keer: twee gesprekken tegelijk van een uur is één uur.
- Een afspraak over middernacht telt alleen het deel op die dag.
- Taken tellen niet mee; die hebben in de maand geen tijd.

De berekening staat los van het scherm in `src/lib/calendarOccupancy.ts`.

## Getest

- `npm run typecheck`, `npm test` (1730 tests).
- Nieuw: `src/lib/calendarOccupancy.test.ts` — de bezetting (per kleur,
  overlap, hele dag, middernacht, kapotte tijden) en een struikeldraad: elke
  `font-size` in de agendaregels van `globals.css` moet als
  `calc(<n>px * var(--cal-fs,1))` staan, anders schaalt hij niet mee.
- `npm run test:mobile -- --theme=both`.
- Met de hand, met een volle maand (twee agenda's, hele dagen, meerdaags,
  taken), licht en donker, op 1440×900 en op telefoonformaat: maand, week,
  dag en lijst, en op de telefoon (390×844) de maand met en zonder het
  lijstje van een dag.
