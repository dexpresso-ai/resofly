# Changelog — Calendar settings relocation (2026-05-19)

## Doel
De kalenderpagina had bovenaan te veel ruimteverlies door agenda-koppelacties. Deze acties zijn verplaatst naar een aparte agenda-instellingenweergave, zodat de kalender direct met de agendaweergave start.

## Wijzigingen
- Nieuwe interne pagina `calendar-settings` toegevoegd.
- Sidebar-submenu onder **Kalender** uitgebreid met:
  - Agendaweergave
  - Gekoppelde accounts
  - Agenda-instellingen
- Google/Microsoft koppelen verplaatst naar **Agenda-instellingen**.
- Gekoppelde accounts en agenda-broninstellingen staan nu op de instellingenweergave.
- De kalenderpagina toont geen grote koppel-hero meer en start direct met de agenda-card.
- De handige **Ververs**-knop is behouden in de kalender-toolbar.
- Agendaweergave gebruikt meer verticale ruimte doordat de oude koppelbalk is verwijderd.
- CSS toegevoegd voor de nieuwe agenda-instellingenpagina en compactere kalenderhoogte.

## Technische impact
- Geen database- of Supabase-migratie nodig.
- Geen wijzigingen aan OAuth Edge Functions.
- Bestaande koppelingen, privacy-instellingen en schrijf-/deel-toggles blijven dezelfde API's gebruiken.
