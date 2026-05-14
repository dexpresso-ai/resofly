# Changelog — Quote versions + PDF attachments

## Toegevoegd

- Server-side PDF-generatie in `supabase/functions/quote-workflow/index.ts`.
- Resend quote-mails krijgen nu automatisch een PDF-bijlage van de offerte.
- Nieuwe Supabase-migratie: `supabase/migrations/20260517_quote_versions_pdf_attachments.sql`.
- Nieuwe tabellen:
  - `quote_versions`
  - `quote_version_items`
- Nieuwe quote snapshot-momenten:
  - interne goedkeuring
  - verzending naar klant
  - klantacceptatie
- PDF-metadata wordt vastgelegd op:
  - `quote_versions`
  - `quote_email_deliveries`
  - `quotes`
- Vastgelegde PDF-metadata:
  - bestandsnaam
  - MIME-type
  - bestandsgrootte
  - SHA-256 hash
- UI toont offerteversies en PDF-snapshotinformatie bij offertes en projectoffertes.

## Architectuurkeuzes

- PDF-generatie gebeurt bewust server-side in de Edge Function, niet vanuit de browser.
- De PDF bytes worden als Resend attachment meegestuurd.
- De database bewaart de PDF-hash/metadata en snapshotdata, niet de volledige PDF-binary.
- `quote_version_pdf_url` is alvast opgenomen voor een latere storagekoppeling, bijvoorbeeld R2 of Supabase Storage.
- Browserclients kunnen quote snapshots alleen lezen; aanmaken en muteren loopt via workflow-RPC's/Edge Functions.

## Gewijzigd

- `begin_quote_email_send` accepteert nu PDF-attachment metadata.
- `complete_quote_email_send` maakt de verzonden quoteversie aan en koppelt die aan de delivery.
- `approve_quote_internal` maakt direct een goedgekeurde versie-snapshot aan.
- `accept_quote_public` maakt direct een geaccepteerde versie-snapshot aan.
- Quote workflow events en audit events ondersteunen nu:
  - `quote_version_created`
  - `quote_pdf_attached`
