# Changelog — Stromentest contracten, offertes, facturen en herinneringen — 2026-11-06

## Aanleiding

> Doe nog eens een hele goede test of de contract, offerte, factuur, herinneringen allemaal goed
> werkt..check de functionaliteit, de beveiliging werking.

Een nieuwe test (`tests/stromen/`) draait de echte edge functions tegen een database met alle
migraties, met echte gebruikers en rechten, en met nagebootste Resend, Mollie en R2. Hij vond 39
fouten; alle zijn opgelost. Het volledige verslag, per fout met oorzaak en oplossing, staat in
`docs/rapporten/STROMENTEST_CONTRACT_OFFERTE_FACTUUR_2026-11-06.md`.

## Wat je merkt in de app

### Facturen en herinneringen

- **Zonder gekoppelde Mollie** maakt een herinnering of aanmaning geen betaallink meer, en meldt
  hij ook niet dat de betaallink mislukte. Eerder bleef er dan een "betaling in voorbereiding"
  hangen en verdween de knop **Crediteren** voorgoed.
- **Crediteren** kan weer zodra een betaallink verlopen is.
- Een herinnering kan pas **na de vervaldatum**, en de automatische herinneringen sturen hooguit
  één per factuur per dag (ook niet als je dezelfde dag al met de hand herinnerde).
- Twee collega's die tegelijk een herinnering of aanmaning versturen of voorstellen: één gaat door,
  de ander krijgt een nette melding.
- Een **aanmaning** na een deelbetaling toont in de app hetzelfde bedrag als in de brief.
- Mislukt het versturen van een **concept met betaallink**, dan kun je het concept daarna gewoon
  aanpassen. De oude betaallink vervalt; bij opnieuw versturen komt er een voor het nieuwe bedrag.
- Een **betaalde** factuur annuleer je niet meer via de status (ook niet via Gerrie): dat gaat met
  een terugbetaling en creditnota.
- Na een terugboeking en een nieuwe betaling blijft de factuur **betaald**, ook als Mollie later
  nog iets over de oude betaling meldt.

### Offertes

- Onder de **KOR** kun je een offerte met btw niet indienen of versturen: de factuur die eruit komt
  zou je niet kunnen versturen.
- Een geaccepteerde offerte heet **"Geaccepteerd"** (was "Openstaand"), een ingetrokken offerte
  **"Ingetrokken"** (was "Geannuleerd").
- De klant ziet bij een ingetrokken of verlopen offerte geen akkoordformulier meer, in het portaal
  geen knoppen. "Verlopen" telt op de Nederlandse kalenderdag, ook tussen middernacht en 02:00.
- Een offertenummer met een tab of harde spatie erachter (geplakt uit een PDF) telt als hetzelfde
  nummer.
- Dubbelklikken op Versturen geeft "er loopt al een verzending" in plaats van een serverfout.

### Contracten

- Twee keer tegelijk versturen kan niet meer; de tweede hoort dat er al een verzending loopt. De
  link in de verstuurde mail blijft werken.
- Het tijdstip op het **ondertekenbewijs** en in de bevestigingsmails is Nederlandse tijd.
- Is de opslag van een Word-contract even onbereikbaar, dan wordt er niet getekend ("probeer het zo
  opnieuw") in plaats van een opnieuw omgezet document vast te leggen.
- **Ververs** laadt ook de contractenlijst opnieuw.

### Klantportaal en rechten

- Een teamlid kan in zijn eigen organisatie geen portaalklant zijn.
- **Portaaltoegang geven**, of het e-mailadres van een klant met facturen, offertes of contracten
  wijzigen, kan alleen wie in Financiën mag schrijven. Andere klantgegevens wijzigen blijft gewoon
  kunnen.

## Wat er onder de motorkap is veranderd

### Database (`20261106130000_stromentest_herstel.sql`)

- Auditlog: `invoice_email_send_failed` en `invoice_payment_checkout_failed` toegestaan.
- `create_quote_version_snapshot`: alleen documentvelden van klant, project en bedrijf; bestaande
  versies opgeschoond (`jsonb_pick`, `document_snapshot_keys`).
- `enforce_finance_number_unique`: alle witruimte en onzichtbare tekens genormaliseerd
  (`finance_number_key`, `finance_number_clean`).
- `approve_quote_internal`, `mark_invoices_overdue`, `find_due_invoice_reminders`,
  `recompute_invoice_chargeback_state`: Nederlandse kalenderdag.
- Nieuwe trigger `quotes_kor_no_vat`.
- `recompute_invoice_chargeback_state`: een goedgemaakte terugboeking zet de factuur niet terug.
- `enforce_invoice_cancel_after_credit`: geboekt én (deels) betaald → alleen met volledige
  creditnota.
- `enforce_invoice_immutability`: een concept met alleen een ongebruikte betaallink blijft
  bewerkbaar.
- `begin_invoice_reminder_send`: niet vóór de vervaldatum, niet tegelijk, niet twee keer hetzelfde
  niveau binnen tien minuten. `find_due_invoice_reminders`: één per dag.
- `begin_dunning_send`: drie nieuwe parameters (hoofdsom, soort klant, soort rente); de oude vorm is
  vervallen.
- `portal_clients_for_email`: actieve teamleden uitgesloten (`portal_email_is_member`); nieuwe
  triggers `client_contacts_portal_access_finance` en `clients_portal_email_finance`
  (`enforce_portal_access_finance_write`, `client_has_portal_documents`).
- `snapshot_contract_version`: onder slot. `begin_contract_signature_send`: één verzending
  tegelijk, vorige link in de verzendregel. `sign_contract_public`: "je".

### Edge functions

- Nieuw: `_shared/nlDate.ts` (vandaag in Nederland) en `_shared/dbError.ts` (databasefout → 4xx met
  de eigen melding; NUL-tekens vooraf weigeren), met unittests.
- `quote-workflow`, `quote-public`, `contract-workflow`, `contract-public`, `client-portal`,
  `invoice-workflow`: nette 4xx bij weigeringen van de database, Nederlandse datum, NUL-tekens.
- `invoice-workflow`: betaallink alleen met eigen Mollie (gecontroleerd vóór de betaalrij),
  concept- en KOR-controle, verlopen links tellen niet bij crediteren, aanmaning legt de hoofdsom
  vast, geen publieke factuurlink naar de browser.
- `contract-workflow`: terugdraaien met de link die onder het slot is vastgelegd.
- `contract-public`: geen nieuwe omzetting als de verstuurde PDF even onbereikbaar is.
- `client-portal`: teamleden uitgesloten op gebruikers-id; contract-PDF's met de contractopslag.
- Contract-PDF en bevestigingsmails: tijdzone Europe/Amsterdam.
- Gerrie (`invoice.set_status`): een betaalde, geboekte factuur niet via de status annuleren.

### App

- Nieuw `src/lib/financeRules.ts`, de spiegel van de serverregels: `quoteDecision` (kan de klant
  nog beslissen?), `paymentBlocksCredit`/`paymentsBlockCredit` (houdt een betaling crediteren
  tegen?) en `invoiceContentLocked` (ligt de inhoud van een factuur vast?), met tests in
  `financeControl.test.ts`. `src/lib/dates.ts`: `amsterdamTodayIso`.
- `Finance.tsx`: Crediteren kijkt naar alle betalingen en negeert verlopen links; Bewerken volgt
  `invoiceContentLocked`; "Geaccepteerd"/"Ingetrokken"; het snelfilter "Openstaand" toont bij
  offertes alleen verstuurde offertes zonder beslissing.
- Herinnering (knop, Gerrie-reeks en de handeling `invoice.send_reminder`): eerst de Mollie-status
  en de instelling "Betaallink meesturen" (`reminderPaymentLinkWanted`), dan pas een link.
- `PublicQuotePage.tsx` en het klantportaal: geen formulier of knoppen bij een ingetrokken of
  verlopen offerte, wel uitleg.
- `Contracts.tsx` en het tabblad Contracten van een project: verversen met de knop Ververs
  (`refreshRound` in `main.tsx`).
- Het abonnementsoverzicht wordt alleen opgevraagd voor eigenaar en beheerder (`isAdminRole`).
- Het snelfilter "Over de datum" rekent met de Nederlandse kalenderdag (`amsterdamTodayIso`).

### Tests

- `tests/stromen/`: het harnas en zeven scenario's (`npm run test:stromen`), plus de UI-test in
  Chromium (`tests/stromen/ui.mjs`). Zie `tests/stromen/README.md`.

## Getest

- `npm run test:stromen`: **502 stappen, 0 fout**, twee runs na elkaar; de tweede op een database
  die met `supabase db reset` vanaf nul is opgebouwd (alle migraties, ook die van staging van
  vandaag). Vóór de herstelronde: 497 stappen, 35 fout.
- UI-test in Chromium (`tests/stromen/ui.mjs`): **35 stappen, 0 fout** (was 5 fout).
- `npm test`: 1115 tests, 0 fout (met de nieuwe tests voor `dbError`, `nlDate` en
  `financeRules`, en `migrationGrants.test.ts` over de nieuwe migratie).
- `npm run typecheck`: schoon.
- `npm run test:mobile -- --theme=both`: 330 pagina's, licht en donker, 0 problemen.
- `npm run test:loading`: alle controles geslaagd.
- Edge functions met `tsc` (dezelfde lijst als de `deno check` in CI, plus `invoice-workflow`,
  `quote-workflow`, `client-portal` en `invoice-public`): geen nieuwe meldingen.
- De migratie twee keer achter elkaar toegepast: de tweede keer verandert er niets.

## Uitrol

Nog niet uitgerold: de merge naar `staging` wacht op een akkoord. Daarna zet de workflow
*Deploy Supabase (staging)* de migratie `20261106130000` en de edge functions, en bouwt Cloudflare
Pages de app.

Te doen op staging (kan niet vanuit deze sessie): controleer bij **Authentication → Sign In /
Providers** dat **Confirm email** aan staat, en bij E-mail **Secure email change**. Het
klantportaal vertrouwt het e-mailadres van de sessie.
