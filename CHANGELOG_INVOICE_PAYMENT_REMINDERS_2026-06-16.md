# Automatische betalingsherinneringen — 2026-06-16

## Doel
Te late facturen automatisch opvolgen met getrapte betalingsherinneringen (3 niveaus) via Resend,
plus een handmatige "Stuur herinnering"-knop per factuur. Onbetaalde `sent`-facturen worden na de
vervaldatum automatisch op `overdue` gezet. Maximaal hergebruik van de bestaande factuur-verzendflow
(Resend, PDF-snapshot, publieke link, optionele Mollie-betaallink, delivery-tracking).

## Toegevoegd

### Migratie: `20260617000000_invoice_payment_reminders.sql`
- `invoices`: kolommen `reminder_level` (0–3), `last_reminder_at`, `reminders_paused` + partiële index voor de cron-zoekopdracht.
- `invoice_email_deliveries`: kolommen `delivery_kind` (`invoice` | `reminder`) en `reminder_level`, zodat herinneringen los van de oorspronkelijke verzending traceerbaar zijn.
- `invoice_workflow_events`-constraint uitgebreid met `marked_overdue`, `reminder_sent`, `reminder_failed`.
- Nieuwe tabel `invoice_reminder_settings` (per organisatie, RLS via `can_read_org`/`can_write_org`): `auto_reminders_enabled` (default uit), `level1/2/3_offset_days` (default 3/10/17), `include_payment_link` (default aan), met niet-negatieve en oplopende offset-constraints.
- RPC's (security definer, alleen `service_role`):
  - `mark_invoices_overdue(organization_id?)` — zet onbetaalde `sent`-facturen na de vervaldatum op `overdue` (+ `marked_overdue` event).
  - `find_due_invoice_reminders(now, limit)` — levert facturen op die nu het eerstvolgende niveau nodig hebben (één niveau per run, nooit overslaan).
  - `begin/complete/fail_invoice_reminder_send(...)` — spiegelen de e-mail-RPC's, maar verzetten de factuurstatus niet, bumpen `reminder_level`/`last_reminder_at` en loggen `reminder_sent`/`reminder_failed` + audit.

### Edge Function: `invoice-workflow`
- Nieuw secret `INVOICE_REMINDER_CRON_SECRET` (+ optioneel `INVOICE_REMINDER_BATCH_LIMIT`).
- Machine-to-machine ingang `?cron=reminders` met gedeeld secret (constant-time check), naast de bestaande Mollie-webhooktak — vóór `assertAllowedOrigin`/`requireUser`.
- `runInvoiceReminderBatch()` markeert te-late facturen, zoekt kandidaten en verstuurt per factuur het volgende niveau; geeft een samenvatting `{ markedOverdue, candidates, sent, failed, errors }` terug. Eén factuurfout stopt de batch niet.
- Gedeelde `deliverInvoiceReminder()` (cron + handmatig): rendert `invoice.reminder`, ververst de publieke token, hergebruikt de PDF-snapshot (valt terug op verse render), voegt best-effort een Mollie-betaallink toe en verstuurt via Resend met idempotency-key `reminder-<invoiceId>-L<level>-<deliveryId>`.
- Nieuwe handmatige actie `sendInvoiceReminderEmail` (rol owner/admin/member): één factuur, niveau expliciet of automatisch `reminder_level + 1`.

### Gedeelde e-mailtemplate: `invoice.reminder`
- `_shared/emailTemplates/invoiceReminder.ts` met drie oplopende tonen (vriendelijke herinnering → tweede herinnering → aanmaning), inclusief "dagen verstreken", bedrag, vervaldatum en CTA (betaal-/bekijklink). Geregistreerd in `types.ts` en `index.ts`.

### Frontend
- `repository.ts`: `sendInvoiceReminderEmail`, `loadInvoiceReminderSettings`, `saveInvoiceReminderSettings`, `setInvoiceRemindersPaused`.
- `types.ts`: `Invoice` (reminder-velden), `InvoiceEmailDelivery` (`delivery_kind`, `reminder_level`), nieuw `InvoiceReminderSettings`.
- `Finance.tsx`: "Stuur herinnering (niveau N)"-knop voor te-late, onbetaalde facturen; herinneringssectie in het factuurdetail met niveau, laatste moment, pauze-toggle en herinneringshistorie; herinnering-badge (HN / ⏸) in de factuurlijst.
- `SimplePages.tsx`: instellingenkaart **Automatische betalingsherinneringen** in de tab "Online betalen" (aan/uit, offset-dagen per niveau, betaallink meesturen).
- `main.tsx`: handlers `sendInvoiceReminder` (bevestiging + Resend + refresh) en `toggleInvoiceRemindersPaused`.

### Documentatie
- `INVOICE_REMINDERS_SETUP_2026-06-16.md`: secrets, migratie, `cron.schedule`-SQL (pg_cron + pg_net), curl-test en gedragsregels.
- `.env.example`: `INVOICE_REMINDER_CRON_SECRET` + `INVOICE_REMINDER_BATCH_LIMIT`.

## Bediening / impact
- Automatische herinneringen staan per organisatie **standaard uit**; de handmatige knop werkt direct.
- De cron (dagelijks) moet eenmalig worden ingericht met de projectspecifieke URL + secret (zie setup-doc). Zonder cron blijft alleen de handmatige knop actief.
- Secrets staan nooit in de migratie/git.

## Verificatie
- `npm run typecheck` — groen.
- SQL: seed een onbetaalde factuur met `due_date` in het verleden → `mark_invoices_overdue` → `find_due_invoice_reminders` → `begin/complete_invoice_reminder_send`.
- Edge Function: `POST …?cron=reminders` met geldig/ongeldig secret (200 met samenvatting / 401).
- UI: te-late factuur → "Stuur herinnering" → delivery in historie + niveau opgehoogd; pauze-toggle; instellingenkaart bewaart offsets.
