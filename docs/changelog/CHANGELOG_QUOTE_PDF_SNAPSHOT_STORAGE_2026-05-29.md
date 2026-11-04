# Offerte PDF-snapshot opslag + download (2026-05-29)

## Doel
De PDF die bij verzending naar de klant wordt gemaild, wordt nu **byte-identiek
opgeslagen** als onveranderlijke snapshot, en kan altijd vanuit de offertepagina
worden gedownload. De PDF-generatie zelf is **niet** aangepast — dezelfde bytes
die naar Resend gaan, gaan naar opslag.

Dit spiegelt exact het bestaande factuur-snapshotpatroon (`invoice_versions`
+ `/internal/invoice-snapshot`).

## Architectuur
- **Primair:** private Cloudflare R2 via de bestaande Worker. De bytes gaan
  server-to-server (Edge Function → Worker met gedeeld geheim), staan nooit
  publiek.
- **Fallback:** is R2 niet geconfigureerd, dan wordt de PDF als base64 in
  `quote_versions.pdf_data_base64` bewaard. Download blijft zo werken in
  local/dev.
- De snapshot hangt aan de `sent_to_client` offerteversie, met SHA-256,
  bestandsnaam en grootte — net als bij facturen.

## Wijzigingen

### 1. Database — `supabase/migrations/20260529_quote_pdf_snapshot_storage.sql`
- `quote_versions` uitgebreid met `pdf_data_base64`, `pdf_storage_provider`,
  `pdf_storage_key`, `is_immutable` (pariteit met `invoice_versions`).
- `begin_quote_email_send` accepteert en bewaart nu de opslagpointers op de
  queued delivery-metadata; verplicht dat er óf een R2-key óf een base64-
  fallback aanwezig is.
- `complete_quote_email_send` kopieert die pointers naar de `sent_to_client`
  versie die `create_quote_version_snapshot` aanmaakt.
- Grants opnieuw toegekend (functiesignaturen gewijzigd).

### 2. Cloudflare Worker — `cloudflare-worker/worker.ts`
- Nieuwe interne routes `POST /internal/quote-snapshot` en
  `GET /internal/quote-snapshot/:key` (auth via `INTERNAL_UPLOAD_SECRET`).
- `isPrivateQuoteSnapshotKey()` valideert het sleutelschema
  `{org}/quote-pdfs/{quoteId}/{uuid}-{naam}.pdf`.

### 3. Edge Function — `supabase/functions/quote-workflow/index.ts`
- `storeQuotePdfSnapshot()` pusht de PDF naar R2 (of signaleert database-
  fallback).
- Verzendflow slaat de PDF op vóór `begin_quote_email_send` en geeft de
  pointers door.
- Nieuwe action `downloadQuotePdf` haalt de opgeslagen snapshot op
  (R2 of database) en geeft 'm als base64 terug. Org-scoped; lezen vereist
  geen schrijfrechten.

### 4. Frontend
- `src/lib/repository.ts`: `downloadQuotePdfSnapshot()` — roept de action aan
  en triggert een browserdownload van de exacte verzonden PDF.
- `src/main.tsx`: `downloadQuotePdf` handler, doorgegeven aan `<Quotes>`.
- `src/features/Finance.tsx`: `onDownloadPdf` door de propketen
  (`Quotes` → `FinanceList` → `QuoteTable` → rij + `QuoteDetailModal` →
  `QuoteActions`). Voor verzonden offertes downloadt de knop de **opgeslagen**
  PDF; voor concepten valt 'ie terug op live-genereren (`exportFinancePDF`).
  `quoteHasStoredPdf()` bepaalt welke.

## Nog te doen in Cloudflare (configuratie)
Zie `CLOUDFLARE_QUOTE_PDF_SETUP_2026-05-29.md`. Kort:
1. Edge Function secrets zetten: `QUOTE_PDF_STORAGE_WORKER_URL` +
   `QUOTE_PDF_STORAGE_SECRET` (of laat ze leeg en hergebruik de
   `INVOICE_PDF_STORAGE_*` waarden).
2. Worker secret `INTERNAL_UPLOAD_SECRET` moet gelijk zijn aan
   `QUOTE_PDF_STORAGE_SECRET`.
3. Worker (her)deployen, `quote-workflow` Edge Function deployen, migratie
   draaien.

## Tests
- `tsc --noEmit`: schoon.
- Worker accolades gebalanceerd (143/143).
- Migratiefunctiesignaturen + grants consistent.
