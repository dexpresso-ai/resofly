# Testrapport – Projects Hub – 2026-05-11

## Uitgevoerde checks

### TypeScript
- Commando: `npm run typecheck`
- Resultaat: geslaagd.

### Productie-build
- Commando: `npm run build`
- Resultaat: geslaagd.
- Opmerking: Vite geeft een bestaande waarschuwing dat de JavaScript bundle groter is dan 500 kB na minification. Dit blokkeert de build niet.

## Functionele rooktest op codeniveau
- Sidebar toont één menu-item **Projecten** in plaats van losse projectregels.
- Klik op **Projecten** opent de nieuwe projecthub.
- Projecthub toont actieve projecten met kleurbolletje, klantnaam, voortgang, taakstatussen en gekoppelde aantallen.
- Gearchiveerde projecten blijven zichtbaar onder een aparte sectie zodra ze bestaan.
- Klik op een projectkaart opent de bestaande projectdetailpagina.
- Projectdetailpagina gebruikt nog steeds dezelfde `ProjectPage`, taken-kanban en projectnotities.
- Projecten openen vanuit Dashboard, Klantdetails en Archief blijft via bestaande callbacks werken.
- Projecten aanmaken/bewerken blijft via bestaande modal en repositorylaag verlopen.

## Installatie-opmerking
Voor lokale validatie is `npm install --ignore-scripts` gebruikt, omdat de Supabase CLI postinstall in deze omgeving geen externe GitHub-download kon uitvoeren. Dit raakt de applicatiecode niet; de uiteindelijke `npm run typecheck` en `npm run build` zijn daarna succesvol uitgevoerd.
