# Bankfeed fase 1 — afschriften inlezen + automatisch journaliseren (2026-06-22)

## Wat & waarom
De boekhouding boekte verkoopfacturen naar **Debiteuren (1300)** en inkoopfacturen
naar **Crediteuren (1600)**, maar bij betaling werd de **Bank (1100)** nooit geraakt —
open posten bleven dus eeuwig openstaan. Deze fase legt de bankzijde: banktransacties
inlezen, afletteren tegen openstaande facturen en boeken. Omdat
`report_profit_and_loss` en `report_balance_sheet` rechtstreeks uit geboekte
journaalposten aggregeren, werken **W&V, balans en rekeningschema automatisch bij**
zodra een transactie geboekt is.

Eén gedeeld datamodel voor beide ingestiewegen: afschrift-import (deze fase) en de
directe PSD2-koppeling via GoCardless (fase 2) gebruiken dezelfde tabellen, match- en
boekingslaag. Alleen de manier waarop transacties binnenkomen verschilt.

## Database — `supabase/migrations/20260622000004_bankfeed_core.sql`
Nieuwe tabellen:
- **`bank_accounts`** — bankrekening gekoppeld aan een grootboekrekening (meestal 1100).
  `source` onderscheidt `import` van `gocardless`.
- **`bank_statements`** — per geïmporteerd bestand/sync-batch (formaat, periode, begin/
  eindsaldo, bestands-hash).
- **`bank_transactions`** — de regels; `amount_cents` is *signed* (+ ontvangen, − betaald).
  `unique(bank_account_id, dedup_key)` maakt her-import/sync idempotent.
- **`bank_rules`** — automatisch-boeken-regels (match op IBAN / naam / omschrijving /
  bedrag → grootboekrekening + BTW-code, met optioneel `auto_book`).

Security definer RPC's (boeken loopt uitsluitend hierlangs; geboekte transacties zijn
onveranderbaar):
- `import_bank_transactions(org, bank_account, statement, transactions)` — idempotente
  insert + draait direct het matchen.
- `match_bank_transactions(org, bank_account?)` — stelt per open transactie een match
  voor (verkoop-/inkoopfactuur op nummer, leverancier op IBAN, of een regel) en boekt
  `auto_book`-regels meteen. Een mislukte auto-boeking (bv. afgesloten periode) zet de
  transactie als voorstel klaar i.p.v. de hele import terug te draaien.
- `book_bank_transaction(org, txn, lines?, invoice?, purchase_invoice?)` — bouwt een
  sluitende journaalpost (`source_type = 'payment'`): bankregel + tegenzijde. Afletteren
  tegen een factuur verplaatst Debiteuren/Crediteuren → Bank; vrije regels splitsen
  bruto → net + voorbelasting/af te dragen BTW.
- `unbook_bank_transaction(org, txn)` — tegenboeking + transactie terug op `unmatched`.
- `set_bank_transaction_status(org, txn, status)` — negeren / weer openen.

RLS: stamdata (`bank_accounts`, `bank_rules`) volledige CRUD voor `can_write_org`;
`bank_transactions` + `bank_statements` alleen-lezen (mutaties via de RPC's).

## Afschrift-parsers — `src/lib/bankImport/`
- `camt053.ts` — CAMT.053 (ISO 20022, élke NL-bank levert dit; aanbevolen).
- `mt940.ts` — klassiek SWIFT-afschrift incl. SEPA-`:86:`-subvelden.
- `csv.ts` — generieke CSV met automatische kolomherkenning (Rabobank/ING/ABN/bunq/Knab);
  best-effort.
- `dedup.ts` — stabiele dedup-sleutel, bedrag→centen en datumnormalisatie.
- `index.ts` — `parseBankFile()` detecteert het formaat aan inhoud + bestandsnaam.

## Front-end
- **`src/features/Bank.tsx`** — nieuwe pagina met drie tabs:
  - *Af te letteren*: inbox met voorgestelde boeking per transactie (factuur of grootboek-
    rekening), boeken/negeren, terugdraaien, en “Opnieuw matchen”.
  - *Rekeningen & koppeling*: bankrekeningen beheren, afschrift inlezen, en een placeholder
    voor de GoCardless-koppeling (fase 2).
  - *Regels*: automatisch-boeken-regels beheren.
- Data-laag (`src/lib/repository.ts`): laden van de vier collecties + RPC-wrappers
  (`importBankTransactions`, `matchBankTransactions`, `bookBankTransaction`,
  `unbookBankTransaction`, `setBankTransactionStatus`).
- Types (`src/types.ts`): `BankAccount`, `BankStatement`, `BankTransaction`, `BankRule`,
  `ParsedBankStatement` + uitbreiding `AppData`.
- Navigatie: nieuw menu-item **Bank** onder Financiën (`Sidebar.tsx`, `main.tsx`).
- Stijl: bank-klassen toegevoegd aan `globals.css`.

## Bewust buiten scope (fase 1)
- Afletteren tegen een factuur verplaatst alleen de grootboekstand; de betaalstatus van
  de factuur zelf en de Mollie-betaalstroom blijven ongemoeid om dubbeltellen te voorkomen
  (`matched_invoice_id` legt wel de koppeling vast).
- Vrije boeking ondersteunt één regel per transactie (bruto + BTW). Multi-line splitsing
  kan later.

## Deploy
1. Voer `supabase/migrations/20260622000004_bankfeed_core.sql` uit op staging/productie.
2. `npm run build` — getest, slaagt.

## Verificatie
- `npm run typecheck` ✓ en `npm run build` ✓.
- Migratie sluit aan op de bestaande boekhoudkern (`post_journal_entry`,
  `reverse_journal_entry`, `bookkeeping_account_id`, systeemrekeningen 1100/1300/1500/1510/1600).
- **Parsertests** (tijdelijke harnas, esbuild→node): 37 asserts MT940/CSV/helpers + 15 asserts
  CAMT.053, allemaal groen. Realistische ING- én Rabobank-CSV, MT940 met SEPA-`:86:` en
  funds-code, CAMT met CRDT/DBIT-tekens en debiteur/crediteur-tegenpartij.

## Test- & hardeningsronde (zelfde dag)
Adversariële review als testengineer; direct gefixt:
1. **Dubbelboek-risico bij verwijderen bankrekening** — cascade verwijderde óók geboekte
   transacties terwijl de journaalposten bleven; her-import → opnieuw boekbaar. Nu blokkeert
   een `before delete`-trigger het verwijderen zolang er geboekte transacties hangen.
2. **MT940 `:61:`-regex** — optionele funds-code-letter tussen debet/credit-markering en bedrag
   brak het parsen; regex nu tolerant (bedrag moet met cijfer beginnen).
3. **CAMT namespace-robuustheid** — `getElementsByTagNameNS('*', naam)` i.p.v. wildcard +
   localName-filter, zodat ook CAMT mét namespace-prefix (`<ns2:Ntry>`) werkt.
4. **Match-kwaliteit** — geannuleerde/vervallen (`cancelled`/`void`) facturen worden niet meer
   als match voorgesteld.
5. **UI** — `busy`-state werd niet gereset na een geslaagde boeking (zelfde component-instance
   via React-key) → "Terugdraaien" bleef disabled; nu `finally`-reset + validatie vóór `setBusy`.
