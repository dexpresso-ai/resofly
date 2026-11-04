# Test report - Client detail finance overview (2026-05-11)

## Checks uitgevoerd
- `npm ci --ignore-scripts` uitgevoerd om dependencies lokaal te installeren zonder Supabase CLI postinstall-download.
- `npm run typecheck` succesvol uitgevoerd.
- `npm run build` succesvol uitgevoerd.

## Resultaat
- TypeScript compileert zonder errors.
- Productiebuild is succesvol gegenereerd in `dist/`.
- Vite geeft alleen de bestaande chunk-size waarschuwing voor de grote applicatiebundle. Dit blokkeert deployment niet.

## Functionele smoke-test checklist
- Open de app en log in.
- Ga naar `Klanten`.
- Klik op een klantkaart.
- Controleer dat de klant opent als volledige pagina, niet als popup.
- Controleer dat de KPI-kaarten zichtbaar zijn: offertes, facturen, openstaand, vervallen, betaald.
- Controleer dat facturen met status `overdue` of een verlopen `due_date` als vervallen worden getoond.
- Controleer dat openstaande facturen zichtbaar zijn wanneer status niet `paid`, `cancelled` of `draft` is.
- Controleer dat gekoppelde projectfacturen/offertes ook meetellen bij de klant.
- Controleer dat `Klant bewerken` nog steeds het bestaande bewerkformulier opent.
- Controleer dat `+ Offerte` en `+ Factuur` de klant alvast invullen.
- Controleer dat bestaande offertes en facturen vanuit klantdetail te openen zijn.
- Controleer dat gekoppelde projecten vanuit klantdetail openen.

## Opmerking
- Een normale `npm ci` probeerde de Supabase CLI via GitHub te downloaden en faalde in deze sandbox door netwerk/DNS-beperkingen. Daarom is lokaal getest met `npm ci --ignore-scripts`. In Cloudflare Pages/GitHub met internettoegang kan `npm ci` normaal draaien.
