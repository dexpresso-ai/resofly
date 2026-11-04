# Changelog - Finance navigation grouping - 2026-05-11

## Samenvatting
Facturen en offertes zijn uit de hoofdmenulijst gehaald en gegroepeerd onder een nieuw hoofdmenu-item **Financiën**.

## Aangepast
- `src/components/Sidebar.tsx`
  - Nieuw hoofdmenu-item **Financiën** toegevoegd.
  - **Offertes** en **Facturen** als submenu-items onder **Financiën** geplaatst.
  - Financiën blijft automatisch open wanneer de gebruiker zich op Offertes of Facturen bevindt.
  - Actieve submenu-state toegevoegd voor betere visuele herkenning.
  - Bestaande routes `quotes` en `invoices` behouden; er is geen backend- of databasemigratie nodig.

## Niet aangepast
- Geen wijzigingen aan database, Supabase policies, finance-datamodel of CRUD-functionaliteit.
- Geen wijzigingen aan factuur/offerte schermen zelf.
- Geen wijzigingen aan overige menu-items of bestaande routes.
