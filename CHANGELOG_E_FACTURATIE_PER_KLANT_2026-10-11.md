# Changelog — E-facturatie per klant, per mail of via Mollie — 2026-10-11

> Ik wil dat je per klant moet kunnen instellen of je e facturatie wilt
> versturen! Facturen die voor die klant worden verstuurd dienen door e
> facturatie te gaan. De pdf moet ook zichtbaar zijn in de overview.

> E facturatie moet ook via Mollie!

## Wat er was

ResoFly kon een factuur als UBL-e-factuur (Peppol BIS 3.0) **downloaden**, maar
versturen ging altijd als PDF per mail. Er was geen instelling per klant, de
UBL bevatte de PDF niet, en in het factuuroverzicht zag je alleen een live
voorbeeld — niet de PDF die de klant werkelijk kreeg.

## Wat het nu is

### Per klant: e-facturatie aan of uit, en langs welke weg

In het klantformulier, onder het KVK-nummer:

- **E-facturatie** (aan/uit). Aan: elke factuur en creditfactuur aan deze klant
  gaat als e-factuur. Uit: alleen de PDF, zoals altijd.
- **Versturen via** — *E-mail (UBL met de PDF erin)* of *Mollie (via Peppol)*.
- **E-factuuradres** (optioneel), bijvoorbeeld het inkoopfacturenadres van het
  boekhoudpakket van de klant. Leeg = het gewone e-mailadres. Via Mollie gaat
  de PDF-kopie hierheen.

Het formulier zegt meteen wat er voor dat kanaal nog ontbreekt. Wat het
versturen tegenhoudt staat in rood (de server weigert dan met dezelfde reden);
wat alleen Peppol-aflevering in de weg zit in geel. Een ongeldig
e-factuuradres blokkeert *Opslaan*. Het klantdossier toont de stand
("Aan — via Mollie (Peppol), kopie naar …").

### Versturen: de server dwingt het af

`invoice-workflow` kiest het kanaal uit de klant, niet uit de browser. Kan de
e-factuur niet gemaakt worden (geen KVK-nummer, onvolledig adres, onbekend
land, …), dan gaat er **niets** de deur uit — geen betaallink, geen
PDF-snapshot, geen mail — en de foutmelding zegt wat er ontbreekt.

**Per e-mail.** De mail naar het e-factuuradres heeft twee bijlagen: de PDF, en
de UBL 2.1-e-factuur mét diezelfde PDF erin (`AdditionalDocumentReference`,
BT-122..125), zodat een boekhoudpakket de factuur inleest én de PDF toont. De
mailtekst zegt dat erbij. Zonder Peppol-ID (KVK, OIN of btw-nummer) wordt het
elektronisch adres het e-factuuradres (schema `EM`). Een Belgisch
ondernemingsnummer krijgt schema 0208.

**Creditfacturen** aan zo'n klant gaan als e-creditnota (UBL CreditNote met de
PDF erin) naar hetzelfde adres. Ging de factuur via Mollie, dan verwijst de
creditnota naar het nummer dat de klant van Mollie kreeg (PDF, mail en UBL).

### De PDF in het overzicht

- **Factuurdetail**: het voorbeeldpaneel toont nu de *verzonden* PDF — dezelfde
  die in de e-factuur zit, en bij Mollie de PDF van Mollie — met een schakelaar
  *Verzonden / Voorbeeld*. Facturen van vóór deze wijziging zonder snapshot
  houden het live voorbeeld.
- **Factuurlijst**: onder het nummer een label *e-factuur* of *via Mollie*;
  met een stippelrand als hij dat bij het versturen wordt.
- **Detail**: "Verzendwijze" (PDF per mail / E-factuur / Via Mollie), de
  statusregel, en in de verzendhistorie welk UBL-bestand meeging.

### Via Mollie (Sales Invoices API, Peppol)

Kiest een klant *Versturen via Mollie*, dan doet *Verstuur via Mollie*:

1. **Controleren** — alles wat Mollie of Peppol zou weigeren, vooraf en in
   gewone taal: alleen bedrijven in Nederland, België of Duitsland (verkoper én
   koper), een volledig adres, het KVK-/ondernemingsnummer of btw-nummer
   waarmee de klant op Peppol staat (in Duitsland verplicht het btw-nummer),
   euro, en regels met standaard- of 0%-btw.
2. **Concept bij Mollie** — met het ResoFly-nummer in de memo (staat op de PDF)
   en in de metadata. Een gebroken aantal (2,5 uur) of een prijs met meer dan
   twee decimalen wordt één regel met het regeltotaal, met aantal × prijs in de
   omschrijving: dan klopt het bedrag op de cent.
3. **Totaal vergelijken** — rekent Mollie ook maar één cent anders dan ResoFly,
   dan wordt het concept weggegooid en gaat er niets weg. Het bedrag dat de
   klant betaalt is altijd het bedrag dat ResoFly boekt.
4. **Uitgeven** — Mollie verstuurt hem over Peppol en mailt een PDF-kopie
   (met het onderwerp uit het verzendvenster).
5. **Vastleggen** — verzonden en vergrendeld zoals elke factuur, met de PDF van
   Mollie als snapshot. Factuurdatum en vervaldatum in ResoFly worden gelijk
   aan die van Mollie: Mollie dateert vandaag en kent alleen vaste termijnen
   (7, 14, 30, 45, 60, 90 of 120 dagen); ResoFly kiest de kortste die minstens
   zo lang is als afgesproken, en meldt het als dat afwijkt.
6. **Betalen** loopt via de betaallink van Mollie. ResoFly maakt er geen eigen
   betaallink naast — niet bij de herinnering, niet op de publieke
   factuurpagina, niet in het klantportaal — zodat de klant nooit twee keer kan
   betalen.

Daarna houdt ResoFly de stand bij: het Mollie-nummer, de Peppol-aflevering
(*wordt afgeleverd / afgeleverd / mislukt* — bij mislukt probeert Mollie het
zelf opnieuw) en of hij betaald is. Betaald bij Mollie = betaald in ResoFly,
geboekt op 1102 *Ontvangst via Mollie (onderweg)*. Dat gebeurt:

- stil bij het openen van de factuur (hooguit eens per tien minuten),
- met de knop **Ververs bij Mollie** in het Mollie-blok bij de factuur,
- in de dagelijkse herinneringsronde, vóór de herinneringen (een bij Mollie
  betaalde factuur krijgt geen herinnering),
- en, als je dat inplant, elk uur (zie *Uitrollen*).

**Nooit twee keer uitgeven.** De verzendpoging staat vast voordat Mollie iets
doet, en een Mollie-factuur hoort bij precies één poging. Een dubbelklik levert
één concept op. Valt de verbinding weg tijdens het uitgeven, dan zegt ResoFly
dat eerlijk en maakt *Ververs bij Mollie* het af: uitgegeven → alsnog
vastleggen; nooit uitgegeven → concept opruimen, opnieuw versturen kan. Een
factuur die al verstuurd is (per mail of via Mollie) gaat niet nog eens via
Mollie: dat zou een tweede factuur met een ander nummer zijn.

**Waar je op moet letten**

- Mollie geeft een **eigen factuurnummer** (INV-…). Het ResoFly-nummer staat in
  de memo op de PDF; bij de factuur in ResoFly zie je beide.
- Verlegde, vrijgestelde, ICP- en exportbtw, kortingsregels (negatief bedrag)
  en consumenten gaan niet via Mollie — de melding zegt dat, met "verstuur deze
  factuur per e-mail" erbij.
- Creditfacturen gaan niet via Mollie maar als e-creditnota per mail (zie
  boven). Terugbetalen van een Mollie-factuur: in het Mollie-dashboard, of
  handmatig in ResoFly.
- Betaalt de klant buiten Mollie om (overboeking), zet de factuur dan ook in
  Mollie op betaald; anders blijft Mollie hem als openstaand zien.
- Stuurt Mollie zelf ook herinneringen, zet die dan in Mollie of in ResoFly
  uit, anders krijgt de klant er twee.

**Inrichten (door de gebruiker)**

1. Instellingen → Facturatie: het eigen Mollie-account koppelen (API-sleutel) —
   dezelfde koppeling als voor betaallinks.
2. In het Mollie-dashboard e-facturatie aanzetten (organisatie-instellingen).
3. Bij de klant: E-facturatie aan, *Versturen via: Mollie*, en het KVK-/btw-
   nummer precies zoals de klant op Peppol staat.

### Gerrie, MCP en de openbare API

- `client.update_details` (Gerrie en MCP) kent `e_invoicing_enabled`,
  `e_invoice_email` en `e_invoice_channel`.
- Gerrie's verzendvoorstellen gebruiken het e-factuuradres, zoals de server, en
  zetten een al verstuurde factuur voor een Mollie-klant niet opnieuw klaar
  (in een reeks schuift hij naar *overgeslagen*, mét reden).
- Openbare API: de drie klantvelden staan in de klantresource (met filter
  `e_invoicing_enabled`), en de webhook-payload voor klanten bevat ze ook.

## Database — `20261010000000_client_e_invoicing.sql`

- `clients`: `e_invoicing_enabled` (standaard uit), `e_invoice_email` (met
  formaatcontrole), `e_invoice_channel` (`email` | `mollie`, standaard `email`).
- `invoice_email_deliveries`: `delivery_channel` (`email` | `e_invoice_email` |
  `e_invoice_mollie`), het meegestuurde UBL-bestand (`e_invoice_file_name`,
  `…_size_bytes`, `…_sha256`) en wat Mollie zegt (`e_invoice_status`,
  `external_invoice_number`, `external_status`, `external_pdf_url`,
  `external_payment_url`, `external_synced_at`), plus een index voor de
  Mollie-verzendingen.
- Tijdlijn: event-types `e_invoice_sent`, `e_invoice_delivered`,
  `e_invoice_failed`.
- `create_client_with_next_code` neemt de drie velden over (onbekend kanaal →
  fout); `webhook_payload_columns('client')` gelijk aan de API-velden.

Idempotent; getest door hem twee keer na elkaar op PostgreSQL 16 te draaien.

## Uitrollen

1. **Migratie** (`supabase db push`, of de CI-deploy op `staging`).
2. **Edge functions** — vooral `invoice-workflow` en `client-portal`. Via de
   gedeelde code (`_shared/`) veranderen ook `gerrie-agent`,
   `gerrie-agent-runner`, `gerrie-signals`, `mcp`, `api`, `api-admin`,
   `webhooks`, `calendar-integrations`, `invoice-extract`, `invoice-inbox`,
   `mail-inbound` en de functies die de mailsjablonen gebruiken. De CI-deploy
   op `staging` zet ze allemaal neer. Optioneel:
   `MOLLIE_SALES_INVOICE_SYNC_LIMIT` (facturen per statusronde, standaard 50).
3. **Frontend** (Cloudflare Pages).
4. **Optioneel: elk uur de stand bij Mollie** — zonder dit gebeurt het bij het
   openen van een factuur en in de dagelijkse ronde. Deze SQL neemt de
   bestaande herinneringstaak als voorbeeld, dus het cron-secret hoeft nergens
   opnieuw getypt te worden:

   ```sql
   select cron.schedule(
     'invoice-mollie-sales-invoices-hourly',
     '7 * * * *',
     replace(
       (select command from cron.job where jobname = 'invoice-payment-reminders-daily'),
       '?cron=reminders', '?cron=mollie-sales-invoices'
     )
   );
   ```

## Getest

- Unit tests (`npm test`): UBL met ingesloten PDF en Peppol-adres
  (`ubl.test.ts`), de kanaalregels (`eInvoicing.test.ts`, server en browser),
  de Mollie-vertaling (`mollieSalesInvoice.test.ts`: velden, afronding,
  termijnen, landen, btw-soorten, datums op Nederlandse tijd, statussen,
  idempotency-sleutel, mailtekst).
- `npm run typecheck`; `deno check` op `invoice-workflow`, `client-portal`,
  `gerrie-agent`, `gerrie-agent-runner`, `mcp` en `api` — geen nieuwe fouten
  (de twaalf in `invoice-workflow` en die in `client-portal` waren er al: zie
  `frontend-checks.yml`).
- Migratie twee keer op PostgreSQL 16 met een nagebootst Supabase-schema:
  normalisatie, checks, anon geweigerd, kanaal, event-types, webhookvelden.
- Schermen met Playwright (desktop 1440px en telefoon 390px): klantformulier
  met kanaalkeuze en de eisen per kanaal, factuurlijst (geen extra breedte),
  factuurdetail met het Mollie-blok en de PDF van Mollie, klantdossier; plus de
  mobiele lay-outtest (donker en licht).

## Bronnen (Mollie)

- [Sales Invoices API — create sales invoice](https://docs.mollie.com/reference/create-sales-invoice)
- [Sales Invoices API guide](https://docs.mollie.com/docs/sales-invoices-api-guide)
- [E-invoicing is now supported by Sales Invoices API](https://docs.mollie.com/changelog/e-invoicing-is-now-supported-by-sales-invoices-api)
- [How can I send an e-invoice with Mollie Invoicing?](https://help.mollie.com/hc/en-us/articles/29174954797842-How-can-I-send-an-e-invoice-with-Mollie-Invoicing)
- Veldnamen en waarden zijn nagelopen in de officiële TypeScript-SDK
  (`mollie-api-typescript` 1.12.41: `SalesInvoiceRequest`, `UpdateSalesInvoice`,
  `SalesInvoiceResponse`).
