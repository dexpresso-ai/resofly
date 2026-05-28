# Calendar full-day scrollable workday refinement — 2026-05-28

## Doel
De kalender compact houden rond de werkdag, maar afspraken vóór 08:00 en na 18:00 niet langer in een aparte rij tonen. De volledige dag blijft nu op de echte tijdlijn beschikbaar via verticale scroll.

## Aangepast
- Dag/week time grid uitgebreid van 08:00–18:00 naar 00:00–24:00.
- Agenda scrolt automatisch naar 08:00 bij het openen/wisselen van dag of week.
- 08:00–18:00 blijft visueel herkenbaar met een subtiele werkdag-highlight.
- Afspraken vóór 08:00 en na 18:00 verschijnen weer op hun echte tijdslot.
- De eerdere compacte “Buiten werktijd”-rij is verwijderd/uitgeschakeld.
- Sticky dagheaders en hele-dagrij blijven behouden tijdens scrollen.
- Compacte meeting styling en agenda-kleuren blijven intact.

## Bestanden
- `src/features/CalendarPage.tsx`
- `src/styles/globals.css`
