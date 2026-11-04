# Changelog – Calendar day/week/month refinement – 2026-05-11

## Aangepast
- De kalenderweergave is uitgebreid met expliciete tabs voor **Dag**, **Week**, **Maand** en **Lijst**.
- De bestaande weekweergave is behouden, maar technisch omgebouwd naar een flexibele time-grid die ook één dag kan tonen.
- De tijdlijn toont nu de volledige dag van **00:00 t/m 24:00** in plaats van alleen 07:00–22:00.
- Agenda-events worden in de tijdlijn groter en leesbaarder weergegeven, inclusief start-/eindtijd, titel en bronagenda.
- Overlappende events worden naast elkaar geplaatst, zodat titels minder snel over elkaar heen vallen.
- Events die over meerdere dagen lopen worden per zichtbare dag correct afgeknipt binnen de tijdlijn.
- De kalenderkaart gebruikt meer verticale ruimte van de pagina en scrollt intern voor lange dag-/weekoverzichten.
- Maandweergave toegevoegd met weekdagen, dagcellen, eventchips, taakchips en doorklik naar dagweergave.
- De navigatieknoppen passen zich aan per view: vorige/volgende dag, week of maand.

## Niet aangepast
- Geen wijzigingen aan Supabase-schema, Edge Functions, OAuth-flow of externe kalender-API's.
- Geen wijziging aan bestaande create-event functionaliteit behalve betere slotselectie binnen de nieuwe dag/weekgrid.
- Geen wijziging aan permissies of privacyregels voor gedeelde/privé agenda's.
