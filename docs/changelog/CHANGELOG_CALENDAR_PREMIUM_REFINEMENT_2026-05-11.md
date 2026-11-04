# Changelog — Calendar Premium Refinement — 2026-05-11

## Doel
De agendaweergave onder Kalender verfijnen naar een volwaardige, premium planningservaring zonder bestaande kalenderkoppelingen, OAuth-flows, Supabase-structuur of event-aanmaakflow te wijzigen.

## Aangepast

### 1. Visuele hiërarchie
- Eventblokken in dag/week hebben meer contrast, betere borders, subtiele schaduw en duidelijkere titel/tijd/bron-opbouw.
- Hele-dag-events en maandchips gebruiken nu dezelfde agenda-kleur als visuele basis.
- Maandweergave heeft hover states, duidelijkere dagcellen en betere visuele focus op vandaag.

### 2. Sticky headers en tijdkolom
- Dagheaders, hele-dag-rij en tijdlijn zijn samengebracht in één scrollbare kalender-canvas.
- De dagheader blijft sticky bovenin tijdens verticaal scrollen.
- De hele-dag-rij blijft sticky onder de dagheader.
- De tijdkolom blijft sticky links tijdens horizontaal scrollen.
- Weekweergave blijft horizontaal bruikbaar op kleinere schermen zonder header-uitlijning te verliezen.

### 3. Vandaag- en nu-indicator
- Vandaag krijgt een duidelijkere header-highlight en label.
- De actuele tijdlijn is versterkt met een rode lijn, glow, punt en tijdlabel.

### 4. Mobiele optimalisatie
- Dag/week gebruiken op mobiel een horizontaal scrollbare canvas.
- Dagweergave blijft single-column en gebruikt de beschikbare breedte maximaal.
- Maandweergave klapt op mobiel naar een verticale lijst van dagen.
- Event-detailpaneel wordt op mobiel een bottom-sheet achtige layout.

### 5. Event-detail sidepanel
- Klikken op externe agenda-events opent nu een detailpaneel in de app in plaats van direct weg te navigeren.
- Het detailpaneel toont titel, provider, bronagenda, datum/tijd, privacy-status, locatie en omschrijving.
- Vanuit het detailpaneel kan de gebruiker alsnog doorklikken naar de originele Google/Microsoft-agenda via “Open in agenda”.

## Niet aangepast
- Geen databasewijzigingen.
- Geen Supabase Edge Function-wijzigingen.
- Geen OAuth- of secrets-wijzigingen.
- Geen wijzigingen aan kalenderintegratie-contracten.
- Geen functionele wijzigingen aan taken, projecten of klantmodules.
