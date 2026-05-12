# Changelog — Dashboard Project Timeline (2026-05-11)

## Toegevoegd

- Dashboard uitgebreid met een visuele projecttimeline op de homepage.
- Projecten worden per week weergegeven op basis van `start_date` en `end_date`.
- Projectbalken gebruiken de bestaande projectkleur voor snelle herkenning.
- Klik op een projectbalk opent direct de bestaande projectdetailpagina.
- Fasefilters toegevoegd waarmee gebruikers projecten aan/uit kunnen zetten per fase:
  - Planning
  - Bezig
  - Review
  - Te laat
  - Afgerond
- Overlap per week toegevoegd als heatmap-achtige rij boven de projectbalken.
- Samenvattende inzichten toegevoegd:
  - aantal getoonde projecten
  - piek-overlap per week
  - projecten zonder volledige planning
- Projecten zonder volledige start/einddatum blijven zichtbaar via een veilige geschatte planning en krijgen een duidelijke melding “Planning geschat”.

## Technische keuzes

- Geen databasewijzigingen nodig.
- Projectfase wordt afgeleid uit bestaande project- en taakdata:
  - `archived` of alle taken afgerond → Afgerond
  - einddatum verstreken en niet afgerond → Te laat
  - taken in review → Review
  - taken bezig of startdatum bereikt → Bezig
  - anders → Planning
- Bestaande navigatie naar projectdetails is hergebruikt via `openProject(id)`.
- Bestaande projectkleur, klantkoppeling en taakprogressie blijven behouden.

## Gewijzigde bestanden

- `src/features/Dashboard.tsx`
- `src/styles/globals.css`
