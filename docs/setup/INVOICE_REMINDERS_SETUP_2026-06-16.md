# Automatische betalingsherinneringen — setup & bediening

_Datum: 2026-06-16 · betreft migratie `20260617000000_invoice_payment_reminders.sql` + `invoice-workflow` Edge Function._

Getrapte betalingsherinneringen (3 niveaus) voor te late facturen, verstuurd via Resend —
automatisch via een dagelijkse cron én handmatig per factuur. Deze flow hergebruikt de
bestaande factuur-verzendinfrastructuur (Resend, PDF-snapshot, publieke link, Mollie-betaallink).

## Wat doet de flow?

1. **Te laat markeren** — onbetaalde `sent`-facturen waarvan de vervaldatum is verstreken
   worden automatisch op status `overdue` ("Te laat") gezet.
2. **Getrapte herinneringen** — per factuur wordt het eerstvolgende niveau verstuurd zodra
   het aantal dagen ná de vervaldatum de ingestelde offset bereikt:
   - **Niveau 1** — vriendelijke herinnering (standaard vanaf +3 dagen)
   - **Niveau 2** — tweede herinnering (standaard vanaf +10 dagen)
   - **Niveau 3** — aanmaning / laatste betalingsherinnering (standaard vanaf +17 dagen)
   Eén niveau per factuur per run; niveaus worden nooit overgeslagen. Na niveau 3 stopt het.
3. **Handmatig** — vanuit een te-late factuur kan een gebruiker direct het volgende niveau
   sturen met de knop **"Stuur herinnering"** (werkt ook als automatische herinneringen uit staan).

Standaard staan **automatische** herinneringen per organisatie **uit**. Zet ze aan onder
**Instellingen → Online betalen → Automatische betalingsherinneringen** en stel daar de
offset-dagen en "betaallink meesturen" in. Per factuur kun je herinneringen pauzeren in het
factuurdetail.

## 1. Edge Function secrets

De `invoice-workflow` function heeft één nieuw secret nodig (de overige — `RESEND_API_KEY`,
`RESEND_FROM_EMAIL`, `INVOICE_PUBLIC_BASE_URL`/`APP_PUBLIC_URL`, en eventueel de Mollie-/PDF-storage
secrets — gebruikt hij al voor de gewone factuurverzending):

```bash
supabase secrets set INVOICE_REMINDER_CRON_SECRET="<lang-willekeurig-secret>"
# optioneel, default 200:
supabase secrets set INVOICE_REMINDER_BATCH_LIMIT="200"
```

Deploy daarna de function opnieuw:

```bash
supabase functions deploy invoice-workflow
```

## 2. Migratie toepassen

```bash
supabase db push        # of: supabase migration up
```

Dit voegt de reminder-kolommen, de `invoice_reminder_settings`-tabel en de RPC's
(`mark_invoices_overdue`, `find_due_invoice_reminders`, `begin/complete/fail_invoice_reminder_send`) toe.
De migratie bevat **geen** secrets en **schedulet geen cron** — dat doe je hieronder eenmalig.

## 3. Dagelijkse cron inrichten (pg_cron + pg_net)

Voer dit éénmalig uit in de Supabase **SQL Editor** (of via `psql`). Vervang `<PROJECT_REF>` en
`<INVOICE_REMINDER_CRON_SECRET>` door je eigen waarden. Het secret moet exact gelijk zijn aan het
Edge Function secret uit stap 1.

```sql
-- Extensies aanzetten (eenmalig; kan ook via Dashboard → Database → Extensions).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Dagelijks om 08:00 UTC de herinneringsbatch triggeren.
select cron.schedule(
  'invoice-payment-reminders-daily',
  '0 8 * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/invoice-workflow?cron=reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<INVOICE_REMINDER_CRON_SECRET>'
    ),
    body    := '{}'::jsonb
  );
  $$
);
```

Cron aanpassen of verwijderen:

```sql
select cron.unschedule('invoice-payment-reminders-daily');
-- lopende jobs bekijken:
select * from cron.job;
select * from cron.job_run_details order by start_time desc limit 20;
```

> **Secret-hygiëne:** commit het echte secret nooit in een migratie of in git. Het staat alleen
> in de Edge Function secrets en in de (handmatig uitgevoerde) `cron.schedule`-aanroep hierboven.

## 4. Handmatig testen

De cron-ingang is een gewone POST met het secret — direct te testen met curl:

```bash
curl -i -X POST \
  "https://<PROJECT_REF>.supabase.co/functions/v1/invoice-workflow?cron=reminders" \
  -H "x-cron-secret: <INVOICE_REMINDER_CRON_SECRET>" \
  -H "Content-Type: application/json" -d '{}'
```

Verwachte respons (voorbeeld):

```json
{ "ok": true, "markedOverdue": 2, "candidates": 1, "sent": 1, "failed": 0, "errors": [] }
```

- Een **leeg of onjuist** secret geeft `401 { "ok": false, "error": "Invalid cron secret" }`.
- `markedOverdue` = aantal facturen dat in deze run op `overdue` is gezet.
- `candidates` = aantal facturen dat een herinnering nodig had; `sent`/`failed` spreken voor zich.

Handmatig per factuur testen kan via de UI ("Stuur herinnering") of via de bestaande
`supabase.functions.invoke('invoice-workflow', { action: 'sendInvoiceReminderEmail', organizationId, invoiceId })`.

## Gedrag & randvoorwaarden

- Herinneringen gaan **nooit** uit voor facturen met status `paid`, `cancelled`, `void`,
  `written_off` of `refunded`.
- Een factuur moet een klant met geldig e-mailadres hebben.
- De **betaallink** wordt automatisch meegestuurd wanneer de organisatie Mollie gekoppeld heeft
  én "betaallink meesturen" aanstaat. Lukt het aanmaken niet, dan gaat de herinnering gewoon uit
  met alleen de PDF + publieke link (de fout wordt geregistreerd, niet fataal).
- Een **mislukte** verzending verhoogt het niveau niet; de volgende cron-run probeert hetzelfde
  niveau opnieuw (de dagelijkse cadans throttelt de retries).
- De cadans is dagelijks: een factuur die meerdere niveaus "achterloopt" schuift elke run één
  niveau op, totdat niveau 3 is bereikt.
