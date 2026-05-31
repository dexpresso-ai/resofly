# Cloudflare-configuratie — Offerte PDF-snapshot opslag (2026-05-29)

Alle code is klaar. Dit zijn de enige stappen die nog handmatig in
Cloudflare + Supabase moeten gebeuren om de offerte-PDF-opslag live te zetten.

Goede nieuws: als je de factuur-snapshot al draait, hergebruik je dezelfde
Worker, dezelfde R2-bucket en hetzelfde geheim. Dan hoef je alleen de migratie
te draaien en de functie te deployen — geen nieuwe Cloudflare-config.

---

## 0. Voorwaarde
De bestaande media-Worker (`cloudflare-worker/worker.ts`) draait al met:
- R2-bucket binding `MEDIA_BUCKET`
- Worker secret `INTERNAL_UPLOAD_SECRET`

De offerte-snapshot gebruikt exact die binding en dat geheim.

---

## 1. Worker (her)deployen
De Worker heeft twee nieuwe interne routes (`/internal/quote-snapshot`).
Deploy de bijgewerkte Worker:

```bash
cd cloudflare-worker
wrangler deploy
```

Geen nieuwe binding of secret nodig als `INTERNAL_UPLOAD_SECRET` al bestaat.
Controleer dat het geheim gezet is:

```bash
wrangler secret list
# verwacht: INTERNAL_UPLOAD_SECRET
```

Zo niet:

```bash
wrangler secret put INTERNAL_UPLOAD_SECRET
# plak een lang willekeurig geheim (>= 32 tekens)
```

---

## 2. Supabase Edge Function secrets
De `quote-workflow` functie moet weten waar de Worker zit en welk geheim hij
gebruikt. Twee opties:

### Optie A — hergebruik factuur-config (aanbevolen)
Doe niets. Als `INVOICE_PDF_STORAGE_WORKER_URL` en `INVOICE_PDF_STORAGE_SECRET`
al gezet zijn, valt de offerteflow daar automatisch op terug.

### Optie B — aparte offerte-config
```bash
supabase secrets set \
  QUOTE_PDF_STORAGE_WORKER_URL="https://brandcore-media.JOUW_SUBDOMAIN.workers.dev" \
  QUOTE_PDF_STORAGE_SECRET="ZELFDE-waarde-als-INTERNAL_UPLOAD_SECRET"
```

> Belangrijk: `QUOTE_PDF_STORAGE_SECRET` (of `INVOICE_PDF_STORAGE_SECRET`) moet
> exact gelijk zijn aan de Worker-secret `INTERNAL_UPLOAD_SECRET`, anders weigert
> de Worker met 401.

---

## 3. Migratie draaien
```bash
supabase db push
# of, als je per bestand werkt:
# psql "$DATABASE_URL" -f supabase/migrations/20260529_quote_pdf_snapshot_storage.sql
```

---

## 4. Edge Function deployen
```bash
supabase functions deploy quote-workflow
```

---

## 5. Verifiëren
1. Keur een offerte intern goed en verstuur 'm via Resend.
2. In de offertepagina (detail of rijactie) verschijnt nu **Download verzonden
   PDF**. Klik → je krijgt exact de PDF die de klant per mail kreeg.
3. Controle in de DB:
   ```sql
   select version_number, snapshot_reason, pdf_storage_provider, pdf_storage_key,
          pdf_size_bytes, pdf_sha256
   from quote_versions
   where snapshot_reason = 'sent_to_client'
   order by created_at desc limit 5;
   ```
   `pdf_storage_provider` moet `r2` zijn (of `database` bij fallback), met een
   ingevulde key/sha256.

---

## Terugvalgedrag
- **Geen storage-config:** PDF wordt als base64 in `quote_versions` bewaard;
  download werkt nog steeds. Prima voor local/dev, minder ideaal voor productie
  (grotere DB-rijen).
- **Wel R2:** alleen de pointer staat in de DB, de bytes in private R2. Dit is
  de productie-route.
