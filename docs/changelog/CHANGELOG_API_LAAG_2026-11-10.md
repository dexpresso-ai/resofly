# Changelog: controle van de API-laag — 10 november 2026

Het rapport, met de bevindingen, de open punten en de lijst voor externe koppelingen, staat in
`docs/rapporten/CONTROLE_API_LAAG_2026-11-10.md`. Hier staat wat er veranderd is.

## Database

Migratie `20261110140000_api_laag_controle.sql`, veilig om meermaals te draaien:

1. **`edge_note_attempt`.** Een algemene teller per emmer, per afzender en voor iedereen samen.
   Hij gebruikt de tabel en de opruiming van de teller voor mislukte API-sleutels. De eerste
   gebruiker is `mcp-oauth /register`.
2. **`drive_share_attachment_in_content`.** Een trigger op `drive_shares`: delen kan alleen
   met een bestand in een map van Inhoud.
3. **`storage_purge_queue_guard`.** In de opruimwachtrij komt alleen een sleutel die bij de
   bron past:
   - document of map: `document`/`folder`;
   - contract: `contract`;
   - zending: `transfer`.

   Een bewijsstuk (`invoice-pdfs`, `quote-pdfs`, `contract-pdfs`, `annual-account-pdfs`) en een
   origineel uit de factuur-inbox komen er nooit in.
4. **`portal_client_message_overview`.** Geeft elk inkomend bericht van de klant mee. Van wat
   niet van een portaalgebruiker zelf komt, alleen tijd en gesprek.
5. **Databasefuncties voor elke ingelogde gebruiker:**
   - `post_journal_entry`: een andere soort dan `manual` alleen vanuit de bijbehorende
     functie;
   - `organization_reserved_license_count`: SECURITY INVOKER;
   - `org_has_creative`: alleen voor wie erbij hoort;
   - `preview_next_client_code`: vraagt schrijfrecht op Klanten.
6. **Indexen** op `inbound_messages` voor de rem op inkomende mail.
7. **Webhook-geheim van Mollie.** `webhookUrl`, met het geheim erin, gaat uit
   `organization_payment_records.raw_payload` en `organization_billing_events.payload`.
8. **`disable_org_webhooks_on_demotion`.** Een webhook van de organisatie gaat uit als zijn
   maker geen owner of admin meer is.

## Edge functions

| Functie | Wat |
|---|---|
| `mcp-oauth` | `/register` per afzender 60 en voor iedereen samen 1000 per uur (`MCP_REGISTER_LIMIT_PER_HOUR`, `MCP_REGISTER_GLOBAL_LIMIT_PER_HOUR`), daarboven 429. Een 500 zonder databasetekst. |
| `file-share` | Een bijlage delen alleen als hij in een map van Inhoud staat (403 met uitleg). |
| `mail-inbound` | Per gesprek 30 en per organisatie 300 berichten per uur (`MAIL_INBOUND_THREAD_LIMIT_PER_HOUR`, `MAIL_INBOUND_ORG_LIMIT_PER_HOUR`); daarboven geparkeerd als `rate_limited`. Een agenda-antwoord telt alleen voor de afzender zelf. |
| `billing` | Geen nieuw abonnement naast een lopend abonnement of op een inactief plan. Opzeggen wist het abonnements-id. Na een eerste betaling wordt alleen een abonnement hergebruikt dat bij Mollie nog loopt, met het nieuwe bedrag. Het Mollie-antwoord wordt zonder webhookUrl bewaard. |
| `meeting-transcribe` | Met de hand nieuwe notulen gaan op het tegoed van wie erom vraagt; er loopt er één tegelijk. |
| `gerrie-signals` | De budgetcontrole telt ook het tegoed van de organisatie. |
| `invoice-public`, `quote-public`, `contract-public`, `file-share-public`, `file-transfer-public`, `gallery-public`, `meeting-booking-public`, `portal-login` | Een body die geen JSON-object is, geeft 400 in plaats van 500. `gallery-public` noemt geen namen van secrets meer. |
| `_shared/fileTransferServer.ts` | `deleteStorageObject` weigert bewijsstukken en inbox-originelen. |
| `email-unsubscribe` | Een browser (`Accept: text/html`) gaat met 303 door naar `APP_PUBLIC_URL/afmelden?token=…`. Nieuw: een POST met JSON (`info`, `unsubscribe`) voor die pagina, open voor elke herkomst (het token is het bewijs). De one-click POST en de oude pagina voor verzoeken zonder browser blijven. |

## App

- **Nieuwe pagina `/afmelden?token=…`** (`src/features/PublicUnsubscribePage.tsx`). Wie in een
  campagnemail op "Afmelden" klikte, zag HTML-code: Supabase serveert een GET met `text/html` op
  `*.supabase.co` als platte tekst.
- **Zo werkt de pagina:** eerst ziet de ontvanger van wie de mail komt en op welk adres, en pas
  na de knop is hij afgemeld. Mailprogramma's en scanners openen links vooraf; zo meldt dat
  niemand per ongeluk af.
- **Test:** de pagina staat in de mobiele opmaaktest (`public-unsubscribe`).

## Workers

De onderstaande workers zijn op 10 november uitgerold naar staging, met
`npx wrangler deploy --env staging`. Bindings en secrets zijn ongewijzigd.

- **`resofly-media-api-staging`, versie `9896b7a9`:**
  - de interne DELETE weigert bewijsstukken;
  - de route `/internal/annual-account-snapshot` is nieuw;
  - een token voor één bestand opent de zip van de galerij niet meer.
- **`resofly-client-domains-staging`:** een GET op `/afmelden` krijgt de afmeldpagina van de
  app, in de huisstijl van het adres. De POST gaat zoals altijd naar `email-unsubscribe`.
- **`resofly-caldav-staging`, versie `bf5ff3e8`:**
  - een teruggezette afspraak komt terug in plaats van een 500 te geven;
  - alleen de eigenaar hernoemt of herkleurt een agenda.

## Tests

- **`tests/stromen/api.mjs` (nieuw, 57 stappen).** Dekt:
  - API-sleutels: aanmaken, aanmelden, lezen en schrijven per organisatie en module,
    klaarzetten tegenover uitvoeren, idempotentie, webhooks naar interne adressen, verlopen,
    intrekken en vertrekken;
  - de nieuwe sloten in de database;
  - de rem op inkomende mail;
  - de hele OAuth-route van de MCP-koppeling.

  Draaien met `npm run test:stromen -- api`.
- **`tests/stromen/omgeving.mjs`:**
  - `WEBHOOK_SECRET_ENCRYPTION_KEY` en `MCP_STATE_SECRET` voor de API- en MCP-functies;
  - `MAIL_INBOUND_WEBHOOK_SECRET` en `MAIL_INBOUND_THREAD_LIMIT_PER_HOUR` voor de inkomende
    mail.
- **`scripts/supabase-smoke-test.sh`:** na elke uitrol ook het OpenAPI-document, `mcp` en
  `mcp-oauth` zonder bewijs, `mail-inbound` zonder geheim, en dat een browser van de afmeldlink
  naar `/afmelden` gaat.
- **`supabase/functions/_shared/portalMessages.test.ts`:** doorgestuurde post en post van een
  derde tussen vraag en antwoord.
- **Lokaal getest:**
  - `npm test`: 1486, 0 fout;
  - `npm run typecheck`;
  - `tsc` in `workers/media-api` en `workers/caldav`;
  - `deno check` van alle functies uit `.github/workflows/frontend-checks.yml`. Lokaal kan dat
    met een import map die esm.sh naar `npm:` laat wijzen, en `--node-modules-dir=none`;
  - `npm run test:stromen`, alle scenario's;
  - de migratie twee keer achter elkaar op een database met alle migraties.

## Voor de eigenaar

Zie het rapport, open punten O1 tot en met O4:
- **O1:** de PDF-opslag op staging van de oude naar de nieuwe media-worker, daarna de oude
  uitzetten;
- **O2:** het webhook-geheim van Mollie vernieuwen;
- **O3:** de facturering een keer met de testsleutel van Mollie doorlopen;
- **O4:** de afmeldpagina is hersteld; klik hem één keer aan vanuit een testcampagne.
