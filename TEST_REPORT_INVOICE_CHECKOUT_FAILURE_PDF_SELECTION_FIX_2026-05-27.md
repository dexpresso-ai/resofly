# Test report — Invoice checkout failure + PDF selection fix — 2026-05-27

## Uitgevoerde checks

### Frontend build

```bash
npm run build
```

Resultaat: geslaagd.

Opmerking: de bestaande Vite chunk-size waarschuwing blijft zichtbaar, maar is geen blocker.

### Edge Function syntax/bundling smoke-test

```bash
npx esbuild supabase/functions/invoice-workflow/index.ts --bundle --platform=neutral --format=esm --outfile=/tmp/invoice-workflow.js --external:https://*
npx esbuild supabase/functions/invoice-public/index.ts --bundle --platform=neutral --format=esm --outfile=/tmp/invoice-public.js --external:https://*
```

Resultaat: beide geslaagd.

## Functionele testscenario's voor staging

### Scenario 1 — Mollie API key ontbreekt of is ongeldig

1. Zet `MOLLIE_ALLOW_MOCK=false`.
2. Gebruik bewust een ontbrekende/ongeldige `MOLLIE_INVOICE_API_KEY`.
3. Maak een betaallink aan.
4. Verwachting:
   - UI krijgt een nette providerfout.
   - `invoice_payment_records.status = failed`.
   - Er blijft geen actieve `creating` record hangen.
   - Nieuwe poging tot betaallink maken wordt niet geblokkeerd.
   - `finance_provider_jobs.status` staat op `retry` of `failed`.

### Scenario 2 — Mollie response fout / netwerkfout

1. Simuleer providerfout.
2. Maak betaallink aan.
3. Verwachting gelijk aan scenario 1.

### Scenario 3 — Dubbelklik betaallink

1. Klik snel twee keer op betaallink aanmaken.
2. Verwachting:
   - Geen meerdere actieve payment records.
   - Tweede poging krijgt bestaande checkout URL of een nette 409 zolang checkout wordt voorbereid.
   - Stable idempotency key voorkomt dubbele Mollie checkout intentie.

### Scenario 4 — PDF-download met latere `payment_created` snapshot zonder PDF-data

1. Verstuur factuur zodat `sent_to_client` een echte PDF-snapshot heeft.
2. Maak daarna betaallink aan zodat er een latere `payment_created` version ontstaat.
3. Open publieke factuurpagina en download PDF.
4. Verwachting:
   - Download gebruikt de echte `sent_to_client` PDF-snapshot.
   - Geen fout doordat `payment_created` alleen metadata heeft.

### Scenario 5 — R2 snapshot

1. Configureer `INVOICE_PDF_STORAGE_WORKER_URL` en `INVOICE_PDF_STORAGE_SECRET`.
2. Verstuur factuur.
3. Download PDF publiek.
4. Verwachting:
   - `invoice-public` haalt PDF uit private storage.
   - Geen storage key/provider intern zichtbaar in public response.
