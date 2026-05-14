# Review — Quote versions + PDF attachments hardening

## Scope
Senior test/engineering review op de nieuwe quote-versies en server-side PDF-bijlage functionaliteit.

## Verbeteringen

1. **PDF-metadata alleen bij echte PDF-snapshots**
   - Interne goedkeuringssnapshots vullen niet langer onterecht `last_pdf_mime_type = application/pdf`.
   - PDF-events worden alleen geschreven wanneer er daadwerkelijk PDF-metadata en een SHA-256 hash aanwezig zijn.

2. **Strengere server-side PDF-validatie**
   - De Edge Function valideert bestandsnaam, MIME-type, grootte en SHA-256 hash voordat Resend wordt aangeroepen.
   - Nieuwe optionele secret/env: `QUOTE_PDF_MAX_ATTACHMENT_BYTES` met fallback naar 8 MB.
   - Resend attachment payload gebruikt `contentType` conform de API-specificatie.

3. **Database hardening**
   - Nieuwe migratie: `20260518_quote_versions_pdf_review_hardening.sql`.
   - Positieve bestandsgrootte-checks voor PDF-metadata.
   - SHA-256 format-checks voor PDF-hashes.
   - Scope-consistentie tussen `quote_versions` en `quote_version_items` via samengestelde foreign key.
   - `sent_to_client` snapshot vereist nu een echte PDF-bijlage met bestandsnaam, grootte en SHA-256 hash.

4. **Correctere RPC-returnwaarden**
   - `approve_quote_internal`, `complete_quote_email_send` en `accept_quote_public` halen de quote opnieuw op nadat snapshot pointers zijn bijgewerkt.
   - Hierdoor krijgen callers de actuele `latest_version_id`, `internal_approved_version_id`, `sent_version_id` en `accepted_version_id` terug.

5. **PDF-rendering robuuster**
   - Lange woorden/URL’s worden nu gesplitst zodat publieke quote-links niet buiten de PDF-pagina lopen.

## Checks

- `npm install --ignore-scripts` ✅
- TypeScript transpile-check Edge Functions via TypeScript API ✅
- `npm run typecheck` ✅
- `npm run build` ✅

## Niet lokaal verifieerbaar in deze omgeving

- Live Supabase SQL execution tegen jouw projectdatabase.
- Live Resend-send zonder production/test secrets.
- Deno-native Edge Function typecheck, omdat `deno` in deze omgeving niet beschikbaar is.
