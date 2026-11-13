# Changelog — Agenda: de maand op de telefoon zoals Google Calendar — 2026-11-13

## Aanleiding

> Ik wil dat het agenda maandoverzicht er zo uit komt te zien, zonder meteen onderaan dag
> afspraken. Ik wil de dag apart kunnen openen. Ook weeknummers moeten erbij.

Met een schermafbeelding van het maandoverzicht van Google Calendar op Android.

## Wat er mis was

Op de telefoon (tot 768px breed) deed de maand drie dingen anders dan gevraagd:

1. **Een daglijst onder het rooster.** Bij het openen van de maand stond vandaag al gekozen,
   met de afspraken van die dag in een paneel eronder. Dat paneel nam tot 40% van de hoogte.
   De weekrijen werden daardoor zo laag dat er per dag één regel overbleef. De rest verdween
   achter "+2".
2. **Geen weeknummers.** Onder 620px vielen ze weg, "alle breedte naar de zeven dagen".
3. **Stipjes in plaats van balken.** Elk item was een stip met een titel van drie letters
   ("Ove…"). De kleur van de agenda zag je alleen aan een stip van 6px.

Liggend (740×360) was het rooster maar ~117px hoog. Gedeeld door zes weken gaf dat 19px per
week, en dan vielen de dagnummers half weg.

## Wat er nu is

Alleen op de telefoon; tablet en bureaublad blijven zoals ze waren.

- **Tegels en weeknummers.** Elke dag is een eigen tegel met afgeronde hoeken. Elke week begint
  met een pil met het weeknummer (ISO, zoals overal in de agenda).
- **Gekleurde balken.** Elke afspraak is een volle balk in de kleur van zijn agenda, met de titel.
  Er staat geen stip en geen tijd bij: in een kolom van ~50px is dat de ruimte voor de titel.
  Een meerdaagse afspraak blijft één balk over de dagen heen. Een taak heeft dezelfde kleur,
  maar als tint met een rand, zodat je ziet wat werk is en wat vastligt.
- **Drie puntjes.** Past een dag niet, dan staat er `•••` in plaats van "+2".
- **Een tik opent de dag.** Ergens in een dag tikken, ook bovenop een afspraak, opent de
  dagweergave van die dag. De balken geven hun tik door aan de tegel eronder. Een balk van 50px
  breed raak je toch niet precies. Het dagnummer is de knop voor schermlezers en zegt hoeveel
  er die dag staat.
- **Geen daglijst meer.** Het rooster vult het scherm. Daardoor passen er nu vier items per dag
  in plaats van één.
- **Laag scherm.** Een weekrij is minstens 64px (dagnummer plus twee items). Past de maand
  daarmee niet, dan scrolt het rooster verticaal en opent hij bij de week van vandaag.
  Zijwaarts vegen blijft bladeren.

Hoeveel items er per dag passen, meet de maand nu aan de weekrij zelf, niet als rooster ÷
aantal weken. Die deling klopte niet meer met ruimte tussen de tegels, of met een rooster dat
scrolt.

## Bestanden

- `src/features/CalendarPage.tsx`: `CalendarMonthView` krijgt `is-phone`, eigen lane-maten
  voor de telefoon (`MONTH_METRICS_PHONE`) en de nieuwe tikwerking. `selectedDay`,
  `onSelectDay` en de stand `monthDay` in de pagina zijn weg.
- `src/styles/globals.css`: blok 6 bij het maandrooster (`.cm-view.is-phone`). De oude regels
  voor ≤620px, de daglijst en de gekozen dag zijn weg.
- `tests/mobile/run.mjs`: nieuwe pagina `calendar-month`, de maand op elk formaat.

## Getest

- `npm run typecheck`, `npm test` (1733 groen).
- `npm run test:mobile -- --theme=both`, met de nieuwe pagina `calendar-month`.
- Met de hand in Playwright op 390×844: drie tikken (op een afspraak, op een lege plek, op het
  dagnummer). Alle drie openen de dagweergave van de juiste dag. Er staat geen daglijst en er
  zijn zes weeknummers zichtbaar.
- Schermafbeeldingen in donker en licht, op telefoon, liggend en tablet.
