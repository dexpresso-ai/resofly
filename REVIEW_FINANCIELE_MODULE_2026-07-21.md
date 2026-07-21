# Kritische review — financiële module (2026-07-21)

Aanleiding: extern advies stelde dat de bankkoppeling "het grootste gat" is. Dat klopt niet —
die staat er al, in twee fasen. Deze review kijkt naar wat er wél mis is.

Scope: boekhoudkern (grootboek, journaalposten, periodesloten, jaarafsluiting), bankfeed
(import + PSD2), BTW-aangifte, facturen/creditnota's, activa en de Mollie-betaalstroom.

**Legenda:** ✅ = door mij regel-voor-regel geverifieerd in de code. ○ = uit de audit,
met file:line onderbouwd maar niet apart nageteld.

---

## 0. Eerst: wat er al staat aan bankkoppeling

Het advies noemde CAMT.053/MT940-import als fase 1 en een EU-aggregator als fase 2. Beide zijn er:

| | Waar | Commit |
|---|---|---|
| CAMT.053 / MT940 / CSV-import | `src/lib/bankImport/` | `4c295f3` (22-06) |
| Match- en boekingsengine | `20260622000004_bankfeed_core.sql` (748 r.) | `4c295f3` |
| Automatisch-boeken-regels | `bank_rules` + `auto_book` | `4c295f3` |
| BTW-betaling ↔ aangifte koppelen | `20260623000001` | `ed10705` (23-06) |
| PSD2 via **Enable Banking** (EU/Fins AISP) | `supabase/functions/bank-sync/` | `7754281` (25-06) |

Openstaand aan de koppeling zelf: redirect-URL whitelisten bij Enable Banking (flow is nooit
e2e getest, ook niet met de sandbox), betaald productiecontract + DPA + prijsmodel voor "alle
klanten", en er is geen automatische sync (geen pg_cron — handmatig per rekening).

**Belangrijk voor de context hieronder:** `main` staat nog op de initiële commit van 1 mei.
Alle 245 commits en 105 migraties zitten op `staging`. Als productie van `main` draait, staat
niets van onderstaande live — dat is het moment om het te repareren.

---

## 1. P0 — corrumpeert de administratie actief

### 1.1 ✅ `reverse_journal_entry` maakt het saldo negatief in plaats van nul

Twee onafhankelijke audits vonden dit los van elkaar; ik heb het zelf nageteld.

```sql
-- 20260618000000_bookkeeping_ledger_core.sql:580  → spiegelpost, status 'posted'
v_reversal := public.post_journal_entry(...);
-- :591  → origineel op 'reversed'
update public.journal_entries set status = 'reversed', ... where id = v_src.id;
```

Élk rapport en élke aangifte filtert op `je.status = 'posted'`:
`20260706120000:331` (W&V), `:368`/`:386` (balans), `:445`+`20260710010000:74` (BTW),
`20260706120000:623`/`:793` (boekjaren).

Het origineel valt dus wég uit de boeken **én** de spiegelpost telt mee. Netto-effect van één
klik "Tegenboeken": **−1× de oorspronkelijke post in plaats van 0.**

Factuur van €1.210 tegenboeken geeft: Debiteuren −1.210, Omzet −1.000 (negatieve omzet in de
W&V), Af te dragen BTW −210 → de volgende aangifte claimt €210 teruggaaf die niet bestaat.

Dat dit een fout is en geen keuze, blijkt uit de code zelf: `reopen_fiscal_year` zet het
afsluitboekstuk op `reversed` **zonder** tegenboeking, met de expliciete motivering "de
rapporten tellen alleen status='posted'" (`20260706120000:692-694`). Twee mechanismen voor
hetzelfde doel; `reverse_journal_entry` past ze allebei tegelijk toe.

De UI merkt het niet: de spiegelpost is zélf in balans, dus de "✓ In balans"-indicator
(`src/features/ProfitLoss.tsx:245`) blijft groen.

Raakt ook `unbook_bank_transaction` (`20260623000001:432`) — dus elke "Terugdraaien" in de
bankmodule. Dit is de enige correctieweg die het systeem biedt, en hij verergert het probleem.

**Fix:** kies één mechanisme. Óf het origineel op `posted` laten staan en de spiegelpost
optellen (netto 0), óf `reversed` zetten zónder spiegelpost. Niet allebei.

### 1.2 ✅ Creditnota's bereiken het grootboek nooit

`20260602000000_invoice_refunds_credit_notes.sql` en `20260603000000_invoice_chargebacks_*.sql`
bevatten **nul** aanroepen van `post_journal_entry` (geteld). `credit_notes` heeft geen
`journal_entry_id`-kolom en komt in geen enkele boekhoudmigratie voor.

Factuur van €1.210 volledig crediteren → in de facturenmodule ziet het er goed uit, in het
grootboek staan de €1.000 omzet en €210 af te dragen BTW er nog gewoon. Je draagt BTW af over
omzet die je hebt gecrediteerd.

### 1.3 ✅ Bankaflettering crediteert 1300 zonder enige controle

`book_bank_transaction` (`20260710010000:317-328`) crediteert Debiteuren met het **volledige**
banktransactiebedrag. Geen controle op `v_inv.journal_entry_id`, geen controle op het
openstaande saldo, geen controle of de factuur al eerder is afgeletterd — en er is geen unique
index op `matched_invoice_id`. De UI biedt álle facturen aan, inclusief concepten
(`src/features/Bank.tsx:135` filtert alleen `cancelled`/`void`).

- Factuur nooit geboekt + wel afgeletterd → Debiteuren wordt **negatief**.
- Twee termijnbetalingen op dezelfde factuur → 1300 met 2× het volledige bedrag gecrediteerd.

### 1.4 ✅ De kerncontrole van een bankfeed ontbreekt volledig

`opening_balance_cents` / `closing_balance_cents` worden uit CAMT en MT940 gelezen, opgeslagen
in `bank_statements` en staan in `types.ts` — en worden **nergens teruggelezen** (gecontroleerd
met een repo-brede grep: alleen schrijfacties, nul vergelijkingen).

Geen `opening + Σ = closing`, geen aansluiting op het vorige afschrift, en vooral: **geen
vergelijking van het afschriftsaldo met de grootboekstand van 1100**. In `Bank.tsx` staat geen
enkel saldo op het scherm.

Dit is waarom 1.5, 1.6 en alle dubbeltellingen hieronder onzichtbaar blijven tot de
jaarrekening. Zonder deze controle is een bankfeed niet betrouwbaar te krijgen.

### 1.5 ✅ Import + PSD2 op dezelfde rekening = alles dubbel

De dedup-sleutel verschilt per bron: client-side `tx:<ref>` of `h:<hash>:<n>`
(`dedup.ts:36-45`), edge function `eb:<ref>` (`bank-sync/index.ts:314`). Uniciteit is bovendien
*per `bank_account_id`*, en `finalizeRequisition` maakt voor een PSD2-koppeling een **nieuwe**
rekeningrij die op dezelfde 1100 boekt.

Je leest juli in via CAMT, koppelt daarna de bank → 90 dagen historie komt terug onder andere
sleutels → alle juli-transacties staan dubbel en zijn beide boekbaar.

### 1.6 ✅ CSV met `volgnr`-kolom verliest stil data

`refCol` accepteert `'volgnr'` (`csv.ts:65`) en dat wordt de dedup-sleutel. Een volgnummer
loopt per dag opnieuw op → dag 2 en verder botsen op `on conflict do nothing`. Je ziet
"15 nieuw, 420 al bekend" en denkt dat het goed ging.

### 1.7 ○ Dubbele omzet via de vrije boeking — ook volautomatisch

Een ontvangst die niet aan een factuur wordt gekoppeld maar op rekening 8000 wordt geboekt,
crediteert die rekening plus 1510 (`20260710010000:331-351`). Staat de omzet al in het
grootboek via `post_sales_invoice_to_ledger`, dan staat hij er nu twee keer — inclusief dubbele
af te dragen BTW. Dit kan **zonder tussenkomst** gebeuren via een `auto_book`-regel met een
omzetrekening als doel (`20260622000004:437-449`).

Dit is niet theoretisch: een Mollie-uitbetaling komt als verzamelbedrag minus kosten binnen,
zonder factuurnummer, dus matcht nooit — en de voor de hand liggende handmatige oplossing is
precies deze dubbeltelling.

---

## 2. P1 — leidt tot een aantoonbaar onjuiste BTW-aangifte

### 2.1 ✅ Verkoopfacturen dragen geen btw-code; ICP, export en verlegd vallen allemaal in 1e

`FinanceLine` heeft alleen een percentage (`src/types.ts:398`). De grootboekrekening wordt puur
op het tarief gekozen (`20260618000000:782-786`): `≥21 → 8000`, `>0 → 8010`, `else → 8020`.
Rekening **8030 "Omzet buitenland (ICP/verlegd)"** wordt aangemaakt en door geen enkel codepad
ooit gebruikt.

`compute_vat_return` gooit vervolgens alles met `vat_rate = 0` op één hoop
(`20260710010000:64`) en de UI presenteert dat als rubriek **1e** (`VatReturns.tsx:159`).

Eén kwartaal met een ICP-levering aan een Duitse afnemer, export naar Zwitserland, verlegde
onderaanneming én vrijgestelde verhuur: alle vier staan opgeteld in 1e. Correct is 3b, 3a, 1e
en (bij vrijgesteld) helemaal niet in die rubriek.

De `vat_codes`-tabel heeft de juiste mapping wél (`sales_box`/`vat_box`), maar
`compute_vat_return` leest die kolommen nergens — dode data.

### 2.2 ✅ `vat_codes.kind` wordt genegeerd in de bankboeking

De query pakt alleen `vc.rate` (`20260710010000:345-351`). `VERL_INK` heeft in de seed **rate
21**. Betaling van €1.000 aan een verlegde leverancier → kosten €826,45 (moet €1.000) +
€173,55 voorbelasting op 1500, **zonder** de 1520-tegenboeking. Je claimt voorbelasting zonder
de bijbehorende 2a-verplichting. `book_purchase_invoice` doet dit wél correct — alleen de
bankroute niet.

### 2.3 ✅ De BTW-richting volgt het teken van de banktransactie, niet de aard van de rekening

Bij `amount_cents > 0` gaat álle BTW naar 1510, bij `< 0` altijd naar 1500
(`20260710010000:365-390`). Leverancier stort €121 terug, jij boekt op 4500 met code HOOG →
credit 4500 **én credit 1510** → je draagt BTW af over een terugbetaling.

### 2.4 ○ De helft van de aangifterubrieken bestaat niet

`compute_vat_return` levert acht getallen; de UI toont 1a, 1b, 1e, 2a, 5a, 5b, 5c
(`VatReturns.tsx:156-167`). Ontbreken: **1c, 1d, 3a, 3b, 3c, 4a, 4b**.

`book_purchase_invoice` gooit `reverse_charge_purchase`, `eu_acquisition`, `icp_goods` én
`icp_services` allemaal op 1520 (`20260618000000:658-662`) — 2a en 4a/4b zijn daarna niet meer
te scheiden. €10.000 goederen uit Duitsland hoort in 4b met grondslag; het systeem heeft geen
4b-regel en de grondslag verschijnt nergens.

### 2.5 ○ Geen ICP-opgaaf — en de gegevens ervoor ontbreken

Nul code voor een ICP-opgaaf. Erger: **`clients` heeft geen `vat_number` en geen `country`**
(`src/types.ts:221`) terwijl `suppliers` die velden wél heeft. Daarmee kan een intra-EU factuur
niet voldoen aan art. 35a Wet OB en is 3b niet te vullen. Intra-EU leveren kan met dit systeem
niet compliant — dat moet expliciet naar de gebruiker.

### 2.6 ○ Geen suppletie, geen correctie, geen memoriaalboeking

`vat_returns.supplements_return_id` bestaat maar wordt nergens geschreven. `finalize_vat_return`
weigert zodra de periode dicht staat. De enige correctieroute die de code noemt is
`reverse_journal_entry` — zie 1.1. En `postManualJournalEntry` (`repository.ts:1380`) heeft
**geen enkele UI-aanroep**, dus er is geen memoriaalboeking in de applicatie.

Ontdek je in juli dat een maart-inkoopfactuur nooit geboekt is en Q1 is gefinaliseerd: er is
geen enkele weg terug binnen de app.

### 2.7 ○ De `year_close`-uitsluiting is per ongeluk teruggedraaid

`20260706120000` voegde bewust een filter toe met de motivering dat het afsluitboekstuk anders
"als negatieve omzet in de nul-rubriek lekt" (`:404-406`). Vier dagen later herschrijft
`20260710010000` beide functies **zonder** dat filter (`:73-75`, `:162-163`). Dat is de laatste
migratie die ze aanraakt, dus de regressie staat live.

### 2.8 ○ Omzet komt alleen in het grootboek als iemand per factuur klikt

`post_sales_invoice_to_ledger` wordt op precies één plek aangeroepen: de knop "Boek naar
grootboek" (`src/main.tsx:1164`). Geen automatische boeking bij verzenden, geen bulkactie, geen
overzicht "nog niet geboekt". De Mollie-webhook raakt geen enkele grootboekrekening
(`20260528000000:121-147`).

Een gebruiker die op de UI vaart ziet facturen als "betaald" staan die nergens in de
boekhouding voorkomen, en dient een te lage BTW-aangifte in.

### 2.9 ○ Afronding is opgelost op het saldo, niet per rubriek

De eurocent-fix rondt alleen het eindsaldo af. De aangifte vraagt **elke rubriek** in hele
euro's, en 5c volgt uit de afgeronde rubrieken. 1a = €1.000,50 en 5b = €500,49 → app zegt
€500, Belastingdienst rekent €1.001 − €500 = €501. Je betaalt €501, 1530 bevat €500, en de
automatische aflettering vindt geen match → de aangifte blijft op "ingediend" hangen.

---

## 3. P2 — structurele gaten

### 3.1 ○ Geen Auditfile Financieel (XAF) en geen grootboek-export
Nul treffers op `xaf`/`auditfile` in de hele repo. De enige exports zijn twee CSV's (W&V en
balans). Geen journaal-export, geen grootboekkaarten, geen rekeningschema. Een accountant kan
de administratie niet inlezen en de ondernemer kan niet migreren. Voor een NL-boekhoudpakket is
dit een harde blocker.

### 3.2 ○ Geen beginbalans-invoer in de applicatie
`create_opening_balance` bestaat in de database en heeft een wrapper, maar **geen enkele
UI-aanroep**. De instellingenpagina belooft het tegenovergestelde: "die stand zit in je
beginbalans" (`SimplePages.tsx:1337`). Migreren met €40.000 debiteuren kan dus niet — de balans
start op nul en oude betalingen komen als onverklaarbare bankmutaties binnen.

### 3.3 ✅ Factuurnummering: twee mechanismen naast elkaar, geen unique constraint
Er is een correcte server-side allocator mét rij-lock (`allocate_next_invoice_number`), maar die
wordt alleen gebruikt door `convert_accepted_quote_to_invoice`. De normale "nieuwe factuur"-weg
gebruikt client-side `max+1` over de geladen lijst (`src/main.tsx:2539-2549`), met een fallback
die geen reeks is maar `Date.now().toString().slice(-4)` (`:2552`).

Er is **geen** `unique (organization_id, number)` op `invoices` — terwijl `credit_notes` die wél
heeft (`20260602000000:260`). Twee gebruikers die tegelijk factureren krijgen hetzelfde nummer
en beide inserts slagen. Art. 35a Wet OB eist doorlopend en uniek.

### 3.4 ○ Een geboekte factuur is gewoon verwijderbaar
De delete-policy is onvoorwaardelijk en de immutability-guard is een `before update`-trigger die
bij DELETE direct terugkeert (`20260602000000:311-313`). `journal_entries.source_id` heeft geen
FK, dus omzet en BTW blijven in het grootboek zonder brondocument — plus een gat in de
nummerreeks dat door 3.3 wordt hergebruikt.

### 3.5 ○ Geen openstaande-postenlijst
De enige report-RPC's zijn W&V en balans. Er is niets dat 1300 tegen de facturenlijst afzet, dus
de desync uit 1.3 en 2.8 is onzichtbaar. Bijkomend: de aanmaningscron werkt op factuurstatus,
dus na een bankbetaling blijven aanmaningen doorlopen naar een klant die al betaald heeft.

### 3.6 ○ Mollie-uitbetalingen en batch-incasso's zijn onafletterbaar
De CAMT-parser leest per `Ntry` alleen de eerste `TxDtls` (`camt053.ts:44`); alle onderliggende
deeltransacties worden weggegooid en het bedrag is het batchtotaal. Splitsen kan niet.

### 3.7 ✅ ING-CSV levert structureel nul automatische matches
`findCol` pakt de eerste header die de term *bevat* (`csv.ts:34`). ING's kolom "Naam /
Omschrijving" bevat zowel `naam` als `omschrijving`, dus beide wijzen naar diezelfde kolom — en
**"Mededelingen"**, waar het factuurnummer staat, wordt nooit gelezen. Bij Rabobank verdwijnen
"Omschrijving-2/-3" op dezelfde manier.

### 3.8 ○ Creditcardafschriften worden omgekeerd geboekt
De indicatorkolom wordt alleen bij zeven exacte varianten herkend; "Bij / Af" met spaties of
"Type" valt erbuiten → teken blijft zoals in het bestand → elke aanschaf komt binnen als
**ontvangst**, matcht tegen verkoopfacturen en crediteert de kostenrekening met BTW naar 1510.

### 3.9 ○ Overige
- **Eén betaling ↔ één factuur.** De takken zijn wederzijds uitsluitend; verzamelbetalingen,
  betalingskorting, bankkosten en valutaverschil hebben geen mechanisme.
- **Storno's en restituties**: afletteren tegen een verkoopfactuur is hard geweigerd bij een
  negatief bedrag. 1300/1600 schoont nooit op.
- **Valuta genegeerd**: `currency` wordt geïmporteerd en nooit gebruikt. USD 1.000 → €1.000.
- **Terugdraaien in een afgesloten periode is een dead-end**: tegenboeking landt op *vandaag*,
  herboeken moet op de originele datum en wordt geweigerd.
- **Activa afstoten kan niet geboekt worden**: `disposal_date`/`disposal_proceeds_cents` bestaan,
  maar er is geen RPC. Aanschafwaarde en cumulatieve afschrijving blijven eeuwig op de balans.
- **Gebroken boekjaar**: de BTW-gate in `close_fiscal_year` vergrendelt maanden uit het vólgende
  boekjaar (`20260706120000:582-610`).
- **"Resultaat lopend boekjaar" is cumulatief** over alle niet-afgesloten jaren; er is geen
  dwang om ooit af te sluiten.
- **KOR is half af**: het grootboek boekt ex-BTW, maar niets dwingt het `vat`-veld op de factuur
  op nul. Factuur €1.210 de deur uit, grootboek boekt €1.000 → permanent creditsaldo van €210.
- **Alleen factuurstelsel**, nergens expliciet. Voor horeca/detailhandel op kasstelsel
  (art. 26 Wet OB) ongeschikt, en dat blijkt nergens.
- **Tariefgrenzen hardcoded** op `≥21` en `<21`; een buitenlands 19%/25%-tarief valt zonder
  waarschuwing in de verkeerde rubriek.

### 3.10 ✅ De 1000-rij-cap raakt de hele module
`selectOptional` (`src/lib/repository.ts:1031`) doet `.select('*')` zonder `.range()` — nul
pagineringsaanroepen in het hele bestand. PostgREST kapt stil af op ~1000 rijen. Dat raakt
`bank_transactions` (onafgeletterde transacties verdwijnen uit de inbox), `journal_lines` (het
Grootboek toont onvolledige boekstukken met een niet-sluitend totaal — ziet eruit als een fout
in de boekhouding terwijl de database klopt) en de factuurlijst waarop 3.3 zijn nummer baseert.
De rapportages zijn hier terecht immuun voor, want die zijn server-side.

---

## 4. Security

| | Bevinding |
|---|---|
| ✅ | `p_lines[].account_id` wordt **niet** tegen de organisatie gevalideerd (`20260710010000:347`), en er is geen org-integriteitstrigger op `journal_lines` zoals wel voor contracts/tickets/attachments. Dit is de follow-up die in juni is genoteerd (`task_7c598094`) en nog openstaat. |
| ○ | `p_created_by uuid default auth.uid()` is een clientparameter die PostgREST laat meesturen — precies het veld waarop je bij onveranderbare journaalposten leunt. |
| ○ | `purchase_invoices` heeft geen immutability-trigger: één PATCH zet `status` terug naar `draft` en `journal_entry_id` op null → kosten én voorbelasting nogmaals boekbaar. Verkoopfacturen zijn hier wél goed beschermd. |
| ○ | De UPDATE-policy op `vat_returns` staat élk veld toe: de bevroren rubrieken-snapshot van een ingediende aangifte is overschrijfbaar en `status` terug te zetten naar `draft`. |
| ○ | `audit_row_change` slikt elke fout (`raise warning`) — mislukt loggen laat de mutatie gewoon doorgaan. Geen hash-keten, geen append-only, en `audit_logs` cascadet weg bij het verwijderen van een organisatie. `journal_lines` heeft geen audittrigger. |

---

## 5. Wat juist goed is

Dit is geen zwak fundament — de kern is op onderdelen echt zorgvuldig.

- **Dubbel boekhouden is afgedwongen**: `post_journal_entry` weigert ongebalanceerde posten;
  `journal_entries`/`journal_lines`/`closed_periods` hebben bewust alleen een SELECT-policy,
  alles loopt via security-definer-RPC's. De balans sluit per constructie.
- **`post_sales_invoice_to_ledger` is echt idempotent** — `select ... for update` op de
  factuurrij plus de guard op `journal_entry_id`. Idem `book_purchase_invoice` en
  `book_asset_acquisition`. Gelijktijdig dubbel boeken is onmogelijk.
- **Het periodeslot zit op één centrale plek** en werkt op datumbereik, dus alle boekingswegen
  erven het automatisch. De `year_close`-uitzondering is bewust en gedocumenteerd.
- **De jaarafsluiting is doordacht**: anti-dubbeltelling, de virtuele resultaatregel houdt
  rekening met de peildatum t.o.v. `period_end`, sequentiële volgorde afgedwongen, heropenen
  alleen in omgekeerde volgorde en alleen door owner/admin, advisory lock tegen dubbele
  resultaatbestemming.
- **Boekstuknummering is concurrency-veilig** (advisory lock vóór de telling) en een rollback
  laat geen gat achter.
- **Bankimport is idempotent binnen één bron** en een bankrekening met geboekte transacties kan
  niet verwijderd worden — met een expliciete motivering die het dubbelboek-risico benoemt.
- **De BTW-split is centneutraal**: `net + btw = bruto` altijd, geen afrondingslek.
- **Mollie-webhooks zijn hard gemaakt** tegen out-of-order en at-least-once levering, met een
  statusprioriteit waarin `paid` niet gedegradeerd kan worden.
- **Rapportages aggregeren server-side**, met expliciete motivering waarom niet in de browser.
- **PSD2-kant**: origin-allowlist op de redirect, alleen-lezen policy op `bank_requisitions`,
  JWT/RS256-signing bewezen met tests.

---

## 6. Voorgestelde volgorde

**Blok A — stop de bloeding (klein, hoge impact).** Alles hier is een gerichte fix, geen
herontwerp. **STATUS: GEBOUWD (2026-07-21) — migratie `20260721000000_finance_blok_a_fixes.sql`,
zie `CHANGELOG_FINANCE_BLOK_A_FIXES_2026-07-21.md`.**
1. `reverse_journal_entry` (1.1) — raakt élke correctie én de hele bankfeed.
2. `book_bank_transaction`: weiger afletteren zonder `journal_entry_id`, begrens op het
   openstaande saldo (1.3).
3. `vat_codes.kind` respecteren + BTW-richting op rekeningtype baseren (2.2, 2.3).
4. `year_close`-filter terugzetten (2.7).
5. `unique (organization_id, number)` op `invoices` + DELETE blokkeren zodra geboekt (3.3, 3.4).
6. Org-validatie op `p_lines[].account_id` (§4) — stond al open sinds juni.

**Blok B — maak de bankfeed betrouwbaar.**
7. Saldo-aansluiting: afschriftsaldo vs. grootboekstand 1100, zichtbaar per rekening (1.4).
   Zonder dit blijft al het andere onzichtbaar.
8. Dedup uniformeren over import en PSD2, en IBAN-matching bij het koppelen (1.5).
9. `volgnr` uit `refCol` halen; dedup-sleutel altijd datum+bedrag+tegenpartij (1.6).
10. CSV-kolomherkenning: exacte match vóór substring, `descCol` los van `nameCol` (3.7, 3.8).

**Blok C — maak de aangifte kloppend.**
11. `vat_code` op factuurregels i.p.v. alleen een percentage; 8030 gebruiken (2.1).
12. Ontbrekende rubrieken + `vat_codes.sales_box`/`vat_box` daadwerkelijk lezen (2.4).
13. Creditnota's naar het grootboek (1.2).
14. Suppletie + memoriaalboeking in de UI (2.6).
15. `clients.vat_number`/`country` + ICP-opgaaf (2.5) — of expliciet communiceren dat intra-EU
    niet ondersteund wordt.

**Blok D — voordat er een echte klant op gaat.**
16. XAF-export (3.1), beginbalans-UI (3.2), openstaande-postenlijst (3.5), paginering (3.10).

---

## 7. Over het externe advies

Het advies stelde dat de bankkoppeling het grootste gat was en raadde CAMT.053-import plus een
EU-aggregator aan. Beide staan er al sinds juni, en de gekozen aggregator (Enable Banking) is
precies degene die het noemde. Het advies was geschreven zonder toegang tot deze repo.

Het werkelijke gat zit niet in de ingestie maar in de **verwerking**: de correctieweg, de
aansluitcontrole en de fiscale bovenbouw.
