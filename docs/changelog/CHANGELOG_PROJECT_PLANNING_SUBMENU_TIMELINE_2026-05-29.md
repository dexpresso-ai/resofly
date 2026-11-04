# Changelog — Projectplanning submenu timeline (2026-05-29)

## Toegevoegd
- Nieuwe submenu-view onder **Projecten**: **Planningstimeline**.
- Nieuwe gedeelde `ProjectTimeline` component, zodat dashboard en projectplanning dezelfde basislogica gebruiken.
- Ruimere full-page planningweergave met:
  - fasefilters;
  - zoekveld op project, klant, taak en tags;
  - klantfilter;
  - toggle voor actieve projecten versus inclusief archief;
  - duidelijkere KPI’s voor getoonde projecten, piek-overlap en open taken.

## Verbeterd
- Leesbaarheid van de timeline is aangescherpt:
  - bredere weekkolommen in de full-page view;
  - vaste, bredere projectkolom;
  - start/einddatum, fase en open taken direct zichtbaar in de projectlabelkolom;
  - duidelijkere balkhoogte en typography;
  - huidige week krijgt subtiele visuele nadruk;
  - overbodige rechter datumkolom verwijderd uit de timeline-rijen, zodat de planning minder snel onnodig breed en rommelig wordt.

## Navigatie
- **Projecten** is nu een menu-parent met submenu-items:
  - Projectoverzicht
  - Planningstimeline
- Projectdetailpagina blijft logisch actief onder Projectoverzicht.

## Database
- Geen Supabase-migratie nodig. Dit is een frontend/navigation/UI-aanpassing.
