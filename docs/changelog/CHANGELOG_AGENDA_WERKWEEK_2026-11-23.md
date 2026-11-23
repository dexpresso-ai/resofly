# Agenda: werkweek als weergave (2026-11-23)

## Wat er nu kan

In de agenda staat naast Dag, 3 dagen, Week, Maand en Lijst nu ook
**Werkweek**: maandag tot en met vrijdag, zonder het weekend.

- Bladeren met de pijlen gaat per week, net als in de weekweergave.
- Sneltoets: `5`. Met ↑/↓ zoom je langs dag → 3 dagen → werkweek → week → maand.
- Het weeknummer staat naast de titel, net als bij de week.
- Op een telefoon schakelt de werkweek, net als de week, naar de dagweergave
  zodra het scherm smal wordt.

## Waarom

Wie in het weekend niet werkt, kreeg in de weekweergave twee lege kolommen die
de werkdagen smaller maakten.

## Getest

- `npm run typecheck`, `npm test`
- `npm run test:mobile -- --theme=both` voor de agendapagina's, met een nieuwe
  meting `calendar-workweek`.
