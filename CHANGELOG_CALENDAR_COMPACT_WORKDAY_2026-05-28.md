# Changelog — Calendar compact workday view — 2026-05-28

## Doel
De gekoppelde kalenderweergave compacter en duidelijker maken, zodat de werkdag van 08:00 tot 18:00 direct zichtbaar is zonder door een 24-uurs grid te hoeven scrollen.

## Aangepast
- Dag- en weekweergave tonen nu standaard het werkdagvenster van 08:00 tot 18:00.
- De tijd-grid is teruggebracht van 48 halfuurslots naar 20 halfuurslots.
- De verticale slothoogte is responsive gemaakt met een compacte clamp, zodat de werkdag op normale desktop/laptophoogtes in beeld blijft.
- Agenda-events worden nu gepositioneerd ten opzichte van het zichtbare werkdagvenster in plaats van een volledige 24-uurs dag.
- De huidige-tijd-indicator wordt alleen getoond wanneer het huidige tijdstip binnen 08:00–18:00 valt.
- Vroege en late afspraken verdwijnen niet: afspraken buiten werktijd worden boven de tijd-grid getoond in een compacte rij “Buiten werktijd”.
- Eventcards tonen duidelijker: tijd, titel, agenda/provider en locatie wanneer beschikbaar.
- Compacte event-dichtheidsklassen toegevoegd voor korte meetings, zodat de meetingtitel leesbaar blijft zonder visuele ruis.
- De premium donkere look & feel, kleuraccenten en agenda-bronkleuren blijven behouden.

## Bestanden
- `src/features/CalendarPage.tsx`
- `src/styles/globals.css`
