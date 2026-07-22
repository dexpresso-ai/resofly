# Debiteurenautomaat met NL-incassorecht — 2026-07-22

Formele aanmaning / WIK-14-dagenbrief bovenop de bestaande getrapte betalingsherinneringen.
**Human-in-the-loop**: de cron stelt een aanmaning VOOR (status `proposed`), de gebruiker
bevestigt en verstuurt. Rente + incassokosten worden berekend maar (bewust) niet in het
grootboek geboekt (v2). Runbook: `DUNNING_AUTOMAT_SETUP_2026-07-22.md`.

## Toegevoegd

### Rekenhart — `supabase/functions/_shared/dunning.ts` (nieuw, unit-getest)
- **WIK-incassokosten-staffel** (Besluit BIK): 15% eerste €2.500 · 10% volgende €2.500 ·
  5% volgende €5.000 · 1% volgende €190.000 · 0,5% daarboven; minimum €40, maximum €6.775.
- **Wettelijke rente** (art. 6:119 BW, consument) én **handelsrente** (art. 6:119a BW, B2B),
  **periode-accuraat**: enkelvoudig, actual/365, gesplitst per rentetariefperiode zodat een
  factuur die over een tariefwijziging heen loopt correct wordt berekend. Rente loopt vanaf
  de dag ná de vervaldatum.
- `calculateDunningClaim` combineert hoofdsom (factuurtotaal incl. btw) + rente + kosten
  (+ optioneel btw over de kosten). 26 ad-hoc unit-tests groen tegen bekende WIK-voorbeelden.

### Migratie — `20260722000000_debtor_dunning.sql`
- `clients.client_kind` ('business'|'consumer', default 'business') — stuurt rentesoort +
  of de WIK-14-dagenbrief verplicht is.
- `statutory_interest_rates` (nationale rentetarief-tijdlijn, geseed & geverifieerd t/m 2025;
  2026-handelsrente-regels gemarkeerd voor verificatie). RLS: leesbaar voor ingelogde users.
- `invoice_dunning_notices` (aanmaningen met bedragen-snapshot; één per factuur via unique
  index; RLS-lezen door orgleden, schrijven alleen via de RPC's).
- Dunning-kolommen op `invoice_reminder_settings` (`dunning_enabled`, `dunning_offset_days`
  default 30, `dunning_collection_costs_vat`).
- CHECK-constraints uitgebreid (volledige bestaande lijst + nieuw): `audit_logs_action_check`
  (`dunning_notice_sent`), `invoice_workflow_events_event_type_check` (dunning_proposed/sent/
  failed/cancelled), `invoice_email_deliveries_delivery_kind_check` ('dunning').
- RPC's (service_role): `find_due_dunning_candidates`, `begin_dunning_notice`,
  `cancel_dunning_notice`, `begin_dunning_send`, `complete_dunning_send`, `fail_dunning_send`.

### Edge Function — `invoice-workflow` (uitgebreid)
- Cron-tak `?cron=dunning` (zelfde gedeelde secret als de herinneringscron) → `runDunningBatch`
  stelt aanmaningen VOOR (verstuurt nooit).
- Acties `proposeDunningNotice` (handmatig voorstellen), `sendDunningNotice` (bevestig +
  verstuur — rente op verzenddatum herberekend), `cancelDunningNotice`.
- `createDunningLetterPdfAttachment`: formele brief-PDF (pdf-lib, hergebruikt de bestaande
  draw-helpers). Consument → WIK-14-dagenbrief met de wettelijk vereiste formulering ("binnen
  veertien dagen vanaf de dag nadat deze brief bij u is bezorgd") + concreet kostenbedrag +
  btw-status; zakelijk → sommatie (van rechtswege in verzuim).
- Nieuw e-mailtemplate `invoice.dunning.wik14` (`_shared/emailTemplates/invoiceDunningWik14.ts`
  + registratie in index/types).

### Frontend
- `types.ts`: `ClientKind`, `Client.client_kind`, dunning-velden op `InvoiceReminderSettings`,
  `DunningNotice`/`DunningNoticeStatus`, `AppData.dunningNotices`, delivery_kind 'dunning'.
- `repository.ts`: `selectDunningNotices` (+ in `loadAppData`), `saveInvoiceDunningSettings`,
  `loadStatutoryInterestRates`, `proposeInvoiceDunningNotice`/`sendInvoiceDunningNotice`/
  `cancelInvoiceDunningNotice`; reminder-settings-loader uitgebreid met de dunning-velden.
- `main.tsx`: `dunningNotices` in emptyData, `client_kind`-keuzeveld op het klantformulier,
  handlers `proposeDunning`/`sendDunning`/`cancelDunning`, gewired naar `<Invoices>`.
- `Finance.tsx`: `InvoiceDunningPanel` in het factuurdetail (voorstel met bedragen →
  "Bevestig & verstuur" / "Annuleer voorstel", of "Stel aanmaning op"); dunning-props door alle
  lagen gerijgd; aanmaning-prefix in de verzendhistorie.
- `SimplePages.tsx`: `DunningSettingsCard` in de tab "Online betalen" (aan/uit, offset-dagen,
  btw-over-kosten, read-only actuele rentetarieven).

## Buiten scope (bewust, v2)
- Grootboek-boeking van rente + incassokosten (voorkomt de reverse_journal_entry-landmijnen).
- Automatische her-escalatie na de 14-dagen-termijn / incassobureau-overdracht.
- Org-specifieke overschrijving van de rentetarieven (nu nationale tabel).

## Verificatie
- `npm run typecheck` + `npm run build` — groen.
- `deno check` op de edge fn — geen nieuwe fouten (alleen pre-existing Uint8Array-lib-ruis).
- Rekenhart: 26/26 unit-tests groen.
- Adversariële multi-dimensie-review (RPC-integratie, SQL, rekenhart, flow/security,
  frontend, juridische tekst) met verificatie per bevinding → **5 bevestigde defecten gefixt**:
  (1) `begin_dunning_send` weigerde de tussenstatus 'confirmed' niet → een dubbelklik/retry kon
  twee aanmaningen versturen (nu guard op alleen 'proposed'/'failed' + app-laag-check);
  (2) `create_client_with_next_code` nam `client_kind` niet mee bij CREATE → een nieuw als
  'consument' aangemaakte klant werd 'business' (RPC gerecreëerd mét client_kind);
  (3) de brief-PDF-btw-zin ("incassokosten inclusief btw") sprak de losse btw-regel tegen
  (nu "verhoogd met … btw"); (4) de consument-e-mail presenteerde de wettelijke rente
  voorwaardelijk i.p.v. reeds verschuldigd.
- REST: e2e op staging met ingelogde sessie (klant consument/zakelijk → aanmaning voorstellen
  → bevestigen → brief-PDF controleren).
