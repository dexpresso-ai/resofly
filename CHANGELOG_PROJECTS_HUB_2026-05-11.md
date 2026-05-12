# Changelog – Projects Hub – 2026-05-11

## Doel
Projecten zijn uit de losse zijmenu-lijst gehaald en verzameld onder één apart menu-item: **Projecten**. Projectdetails blijven beschikbaar als volledige pagina en bestaande navigatie vanuit dashboard, klantdetails, tickets en archief blijft behouden.

## Aangepast
- Nieuw menu-item **Projecten** toegevoegd aan de sidebar.
- Losse projectvermeldingen onderin de sidebar verwijderd.
- Nieuwe `ProjectsListPage` gebouwd met:
  - overzicht van actieve projecten;
  - overzicht van gearchiveerde projecten;
  - behoud van projectkleur-bolletjes;
  - projectstatistieken zoals open taken, te late taken, notities, offertes en facturen;
  - snelle toegang tot projectdetailpagina;
  - directe bewerkactie per project voor gebruikers met schrijfrechten.
- Routing uitgebreid met nieuwe `projects` pagina.
- Projectdetailpagina blijft bestaan onder `project` en wordt gemarkeerd via het menu-item **Projecten**.
- Dashboard-leegmelding aangepast zodat gebruikers naar het nieuwe Projecten-menu worden verwezen.
- Bij verwijderen van het actieve project navigeert de app nu terug naar de projecthub in plaats van naar het dashboard.

## Niet aangepast
- Geen databasewijzigingen.
- Geen Supabase RLS- of migratiewijzigingen.
- Geen wijzigingen aan facturen/offertes/klanten/tickets/notities behalve bestaande projectkoppelingen tonen in het nieuwe overzicht.
- Geen wijzigingen aan bestaande projectdetailfunctionaliteit, taken-kanban of projectnotities.
