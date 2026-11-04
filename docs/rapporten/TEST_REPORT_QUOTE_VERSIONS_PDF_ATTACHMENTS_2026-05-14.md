# Test report — Quote versions + PDF attachments

## Uitgevoerd

- `npm install --ignore-scripts`
  - Nodig omdat de Supabase CLI postinstall in deze omgeving niet naar GitHub kon downloaden.
- `npm run typecheck`
  - Geslaagd.
- `npm run build`
  - Geslaagd.

## Buildresultaat

- Vite productiebuild is succesvol afgerond.
- Er is alleen een bestaande Vite chunk-size waarschuwing zichtbaar omdat de frontend bundle groter is dan 500 kB.
- Geen TypeScript errors in de frontend.

## Handmatige controle

- Nieuwe migratie bevat tabellen, RLS read policies, server-only RPC's en workflow guards.
- `quote-workflow` genereert de PDF server-side en stuurt deze als Resend attachment mee.
- PDF-hash en attachmentmetadata worden in de database vastgelegd.
- Offerteversies worden in de UI geladen en getoond.

## Niet lokaal uitvoerbaar in deze omgeving

- Supabase SQL-migratie daadwerkelijk uitvoeren tegen een database.
- Supabase Edge Function met Deno typechecken, omdat `deno` niet beschikbaar is in de container.
- Resend live-send testen zonder echte secrets.
