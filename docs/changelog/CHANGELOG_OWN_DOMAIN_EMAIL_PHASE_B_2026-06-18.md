# Eigen-domein e-mail — fase 1, onderdeel B (vrije klant-mail + loggen)

Datum: 2026-06-18 · branch `feat/klant-mail-versturen`

## Wat
Gebruikers kunnen nu een vrije e-mail naar een klant opstellen en versturen
vanaf het geverifieerde eigen domein (uit onderdeel A), met logging onder een
nieuwe **"Communicatie"-tab** op de klant. Statusupdates (afgeleverd/geopend/
gebounced) komen via de bestaande Resend-webhook binnen. Het datamodel is meteen
tweerichtings-klaar voor fase C (antwoorden opvangen).

Daarnaast gaan álle bestaande mails (offerte, factuur, herinnering, creditnota,
testmail, portaalwelkom) nu vanaf het geverifieerde domein zodra dat gekoppeld
is — via een gedeelde `resolveSenderIdentity`-helper met veilige fallback naar
het globale `RESEND_FROM_EMAIL`.

## Bestanden
- `supabase/migrations/20260620000003_client_emails.sql`: `client_email_threads`,
  `client_emails` (direction outbound/inbound + statuskolommen), `client_email_events`;
  indexes, RLS (`can_read_org`), `set_updated_at`-triggers.
- `supabase/functions/_shared/sendingDomain.ts`: `resolveSenderIdentity(...)` —
  kiest het geverifieerde verzenddomein van een org, valt stil terug op de
  globale afzender (gooit nooit).
- `supabase/functions/mail/index.ts`: actie `sendClientEmail` (thread + bericht
  aanmaken, versturen, loggen, status bijwerken); resolver ingehaakt in test-
  en portaalwelkomstmail; const `MAIL_INBOUND_DOMAIN` voor fase-C Reply-To.
- `supabase/functions/resend-webhook/index.ts`: matcht nu ook `client_emails`
  op `provider_email_id` en werkt status + `client_email_events` bij.
- `supabase/functions/quote-workflow/index.ts` + `invoice-workflow/index.ts`:
  alle vier verzendplekken gebruiken nu `resolveSenderIdentity` i.p.v. de
  hardgecodeerde globale afzender (gedrag ongewijzigd zonder eigen domein).
- `src/types.ts`: `ClientEmail`, `ClientEmailThread`, status/direction-types.
- `src/lib/repository.ts`: `loadClientEmailThreads`, `loadClientEmails`.
- `src/services/mailService.ts`: `sendClientEmail`.
- `src/features/Clients.tsx`: tab **Communicatie** met opstelvenster
  (RichTextEditor) + thread-/berichtenlijst met statusbadges.
- `src/styles/globals.css`: styling voor de communicatie-tab.
- `.env.example`: `MAIL_INBOUND_DOMAIN` (leeg tot fase C).

## Secrets / migratie / deploy
- Migratie `20260620000003` nog toepassen.
- Edge Functions opnieuw deployen: `mail`, `resend-webhook`, `quote-workflow`,
  `invoice-workflow` (alle vier gewijzigd).
- `MAIL_INBOUND_DOMAIN` voorlopig leeg laten (wordt gezet in fase C).

## Verificatie
- `npm run typecheck` — groen (hele project).
- Dev-server bouwt zonder feature-fouten (alleen bekende React HMR-warning).
- UI-doorklik (Klant → Communicatie) niet getest: achter login + actieve
  organisatie. Te testen na deploy: klant met e-mailadres → tab Communicatie →
  onderwerp + bericht → "Verstuur e-mail" → bericht verschijnt met status
  "Verzonden" en loopt via de webhook door naar "Afgeleverd".

## Nog open
- Fase C: antwoorden opvangen via Cloudflare Email Routing → nieuwe
  `mail-inbound`-functie; `MAIL_INBOUND_DOMAIN` zetten zodat replies als
  `reply+<id>@inbound...` terugkomen en aan de thread/klant worden gekoppeld.
