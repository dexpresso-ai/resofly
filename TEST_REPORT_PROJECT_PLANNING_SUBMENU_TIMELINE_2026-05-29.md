# Test report — Projectplanning submenu timeline (2026-05-29)

## Uitgevoerde checks
- `npm run build`
  - TypeScript build succesvol.
  - Vite production build succesvol.
- `npm run lint:sql`
  - SQL placeholder succesvol uitgevoerd.

## Gecontroleerd
- Nieuwe `ProjectTimeline` component compileert als gedeelde component.
- Dashboard gebruikt de gedeelde timeline component zonder bestaande dashboarddata te wijzigen.
- Nieuwe `ProjectsPlanningPage` opent projecten correct via dezelfde projectdetail-flow als de projectlijst.
- Sidebar accepteert de nieuwe pagina `project-planning` en toont deze alleen als submenu onder Projecten.
- Geen databasewijzigingen nodig.

## Opmerking
- Vite geeft nog steeds de bestaande waarschuwing dat de JavaScript bundle groter is dan 500 kB. Dit is geen build-blocker, maar op termijn is code-splitting verstandig.
