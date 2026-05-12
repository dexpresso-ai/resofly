# Test report - Finance navigation grouping - 2026-05-11

## Uitgevoerde checks
- `npm ci --ignore-scripts`
- `npm run typecheck`
- `npm run build`

## Functionele controle
- Sidebar toont niet langer losse hoofdmenu-items voor **Offertes** en **Facturen**.
- Sidebar toont hoofdmenu-item **Financiën**.
- Klik op **Financiën** klapt het submenu open/dicht.
- Klik op **Offertes** opent bestaande `quotes` pagina.
- Klik op **Facturen** opent bestaande `invoices` pagina.
- Wanneer **Offertes** of **Facturen** actief is, blijft **Financiën** open en actief gemarkeerd.
- Bestaande kalender-submenufunctionaliteit is ongemoeid gelaten.

## Resultaat
Build en typecheck zijn succesvol uitgevoerd. Geen databasewijzigingen nodig.

## Opmerking
Tijdens `npm run build` geeft Vite de bestaande waarschuwing dat de grootste JavaScript chunk boven 500 kB uitkomt. Dit blokkeert de build niet en is niet veroorzaakt door deze navigatiewijziging.
