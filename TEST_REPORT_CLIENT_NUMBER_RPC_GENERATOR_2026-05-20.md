# Test report — Server-side klantnummer-generator — 2026-05-20

## Uitgevoerde checks
- Codebase aangepast zodat nieuwe klanten via Supabase RPC worden aangemaakt.
- TypeScript build uitgevoerd.
- Vite production build uitgevoerd.
- Fresh install schema’s bijgewerkt met dezelfde databasefunctionaliteit als de losse migratie.
- Migratiebestand toegevoegd aan `supabase/migrations/README.md`.

## Resultaat
`npm run build` is succesvol afgerond.

## Build-opmerking
Een normale `npm install` probeerde tijdens de Supabase CLI postinstall GitHub te bereiken. Deze sandbox heeft geen externe netwerktoegang, waardoor die stap faalde. Daarna is `npm install --ignore-scripts` uitgevoerd en is de applicatie succesvol gebouwd. Dit raakt je normale GitHub/Cloudflare deployment niet; daar kan npm gewoon via het netwerk installeren.

## Functionele rooktest na Supabase-migratie
1. Voer `20260520_client_number_rpc_generator.sql` uit in Supabase.
2. Open ResoFly en maak in organisatie A een nieuwe klant aan.
3. Controleer dat het klantnummer als preview zichtbaar is en het veld read-only is.
4. Sla de klant op en controleer dat de klant een definitief `KL-xxx` nummer heeft.
5. Open twee browsers/users binnen dezelfde organisatie en maak vrijwel tegelijk een klant aan.
6. Controleer dat de nummers verschillend zijn.
7. Maak dezelfde klantgegevens aan in een andere organisatie en controleer dat dit nog steeds mag.
