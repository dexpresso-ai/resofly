# Changelog — Finance core deep review fixes (2026-05-27)

## Scope
Deze iteratie controleert en verhardt de offerte- en factuurstroom op de 10 finance-core punten:

1. Publieke factuurlinks via een aparte `invoice_public_links` tabel.
2. Mollie redirect altijd naar `/invoice/<token>`.
3. Facturen inhoudelijk vergrendelen na verzending/betaalflow.
4. Quote → invoice baseren op de geaccepteerde/verzonden quote version snapshot.
5. Eén actieve payment flow per factuur afdwingen.
6. Provider payment id uniek afdwingen.
7. PDF-snapshot exact opslaan in private storage/R2 met databasefallback.
8. Public invoice response minimaliseren.
9. Factuurstatusmodel opschonen.
10. Outbox/retry mechanisme voor Resend/Mollie toevoegen.

## Belangrijkste wijzigingen

### Database
- Nieuwe migratie toegevoegd: `supabase/migrations/20260527_finance_core_deep_review_fixes.sql`.
- `create_invoice_public_link` schrijft nieuwe links naar `invoice_public_links`; de oude `invoices.public_token_hash` blijft alleen legacy/backward-compatible.
- `resolve_invoice_public_link` resolveert primair via `invoice_public_links` en valt alleen terug op oude invoice-tokenkolommen voor oude links.
- `convert_accepted_quote_to_invoice` gebruikt nu strikt de geaccepteerde/verzonden quote snapshot, inclusief `quote_version_items`.
- `begin_invoice_email_send` en `complete_invoice_email_send` ondersteunen nu `attachmentStorageProvider` en `attachmentStorageKey`.
- `invoice_versions` wordt gevuld met echte storage metadata voor de exacte verzonden PDF-snapshot.
- Extra outbox-functies toegevoegd:
  - `claim_finance_provider_jobs`
  - `complete_finance_provider_job`
  - `fail_finance_provider_job`
- Actieve Mollie payment flows en provider payment ids worden opnieuw strikt afgedwongen.
- Dubbele provider email ids worden gequarantained voordat de unieke index wordt gezet.

### Edge Functions
- `invoice-workflow` uploadt PDF snapshots naar private R2 via de Cloudflare Worker als `INVOICE_PDF_STORAGE_WORKER_URL` en `INVOICE_PDF_STORAGE_SECRET` staan.
- Zonder storage-config gebruikt de flow bewust een databasefallback met base64 snapshot.
- `invoice-public` heeft nu een aparte actie `getInvoicePdf`, zodat de publieke pagina de exacte opgeslagen PDF-snapshot downloadt in plaats van opnieuw client-side te genereren.
- De public invoice response lekt minder interne ids/provider metadata.

### Cloudflare Worker
- Nieuwe server-to-server endpoints toegevoegd:
  - `POST /internal/invoice-snapshot`
  - `GET /internal/invoice-snapshot/<key>`
- Deze endpoints vereisen `Authorization: Bearer <INTERNAL_UPLOAD_SECRET>`.
- Bestanden blijven private in R2 en zijn niet rechtstreeks publiek toegankelijk.

### Frontend
- Publieke factuurpagina downloadt nu de vastgelegde PDF-snapshot via `invoice-public:getInvoicePdf`.
- Publieke payment response gebruikt `checkout_url` in plaats van provider-specifieke velden.
- Handmatige factuurstatusopties bevatten geen offerte-status `accepted` meer.

## Nieuwe/gewijzigde secrets

Supabase Edge Functions:

```text
INVOICE_PDF_STORAGE_WORKER_URL=https://brandcore-media.YOUR_SUBDOMAIN.workers.dev
INVOICE_PDF_STORAGE_SECRET=long-random-shared-secret
```

Cloudflare Worker:

```text
INTERNAL_UPLOAD_SECRET=zelfde-waarde-als-INVOICE_PDF_STORAGE_SECRET
```

## Deployvolgorde

1. SQL migratie draaien:
   `supabase/migrations/20260527_finance_core_deep_review_fixes.sql`
2. Cloudflare Worker deployen als je R2 snapshots wilt gebruiken.
3. Secrets zetten in Supabase en Cloudflare.
4. Edge Functions deployen:
   - `invoice-workflow`
   - `invoice-public`
   - `resend-webhook`
5. Frontend deployen naar staging.

