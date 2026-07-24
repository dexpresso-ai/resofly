# Financiële module — Blok C + D (2026-07-23)

Bron: `REVIEW_FINANCIELE_MODULE_2026-07-21.md` §6, punten 11–16.
Migratie: `supabase/migrations/20260723200000_finance_blok_c_d.sql`.

## Blok C — de aangifte kloppend

### C11 · Btw-code stuurt de boeking (review 2.1)
- `post_sales_invoice_to_ledger` leest nu `vat_code` van de factuurregel (de select
  die er sinds de UBL-commit al was), groepeert per (code, tarief), kiest **8030
  Omzet buitenland** voor ICP/export/verlegd-verkoop en schrijft de code op de
  journaalregel. Regels zonder code vallen terug op het oude tariefgedrag.
- `book_purchase_invoice` bewaart de code nu ook op de kostenregels (was hard
  `null`) en behandelt de nieuwe soort `import_non_eu` als verlegging.
- Nieuwe seed-codes: **EXPORT** (rubriek 3a) en **IMPORT** (rubriek 4a, art. 23);
  bestaande organisaties krijgen ze via een backfill + `ensure_default_ledger_accounts`.

### C12 · Alle rubrieken + per-rubriek-afronding (review 2.4 + 2.9)
- Nieuw hart: `compute_vat_boxes()` — levert **1a/1b/1c/1d/1e, 2a, 3a/3b/3c,
  4a/4b, 5a/5b/5c** op basis van `vat_codes.sales_box`/`vat_box` (eindelijk
  gelezen), met grootboek-subtypes als gezaghebbende totalen.
- `form`-blok: alle rubrieken in **hele euro's zoals op het aangifteformulier**;
  `saldo_afgerond` volgt nu 5c-uit-afgeronde-rubrieken (fix van 2.9: de app, de
  1530-doorboeking en de bankbetaling zien hetzelfde bedrag). Sluit de
  regel-metadata niet op ±€1 aan op het grootboek (bv. handmatig op 1510 geboekt
  zonder code), dan valt de afronding terug op het oude totaalgedrag en toont de
  UI een waarschuwing (`boxes_consistent`).
- Bevroren snapshots/bankmatching: alle oude sleutels blijven bestaan.

### C13 · Creditnota's naar het grootboek (review 1.2)
- `credit_notes.journal_entry_id` + `post_credit_note_to_ledger()`: debet omzet
  (met negatieve rubriek-metadata), debet 1510, credit 1300 — cent-exact
  aangesloten op het creditnota-document; restcent uit pro-rata-tarieven wordt in
  de grootste groep rechtgetrokken (tolerantie schaalt met het bedrag).
- UI: knop **“Boek naar grootboek”** + pill “In grootboek” op de creditnota-kaart
  in het factuurdetail. Nieuw brontype `credit_note` (telt in het Verkoopboek van
  de XAF).

### C14 · Memoriaal + suppletie (review 2.6)
- **Memoriaalboeking**: modal in Grootboek → Journaal (`post_journal_entry` had
  nooit een UI). Regels met rekening/omschrijving/btw-code/debet/credit, live
  balansindicator, automatische rubriek-metadata bij een btw-code.
- **Nagekomen documenten**: `first_open_booking_date()` — een factuur/creditnota/
  inkoopfactuur gedateerd in een al ingediende periode wordt voortaan geboekt op
  de eerstvolgende open datum (met notitie in de omschrijving) in plaats van hard
  geweigerd. De maart-inkoopfactuur uit het reviewvoorbeeld kan dus gewoon het
  grootboek in.
- **Suppletie**: `create_vat_supplement()` + UI op de BTW-pagina. Kies de
  geboekte correctieboekstukken → delta per rubriek (voorvertoning via
  `compute_vat_supplement_delta`) → doorboeking 1510/1520/1500 → 1530 → extra
  `vat_returns`-rij met `supplements_return_id`. Verrekende boekstukken staan in
  `vat_supplement_entries` en tellen **niet** meer mee in de reguliere aangifte
  (anders dubbel geclaimd); `reverse_journal_entry` weigert ze daarom ook.
  De unieke periode-index op `vat_returns` is een partial index geworden (alleen
  primaire aangiftes), inclusief aangepaste ON CONFLICT-arbiter in
  `finalize_vat_return`. Suppletie-betalingen liften mee op de bestaande
  automatische bankaflettering op `saldo_afgerond`.
- Kleine correcties kunnen ook gewoon in de eerstvolgende aangifte meelopen
  (boekdatum vandaag) — de pagina legt beide routes uit.

### C15 · ICP-opgaaf (review 2.5)
- `compute_icp_declaration()`: intracommunautaire leveringen/diensten per
  afnemer uit de omzetregels met een ICP-code, met btw-nummer/land van de klant
  (kolommen bestaan sinds de UBL-migratie). UI-sectie op de BTW-pagina (laadt
  automatisch zodra 3b gevuld is) met waarschuwingen voor ontbrekende
  btw-nummers/niet-gekoppelde omzet + CSV-export.

## Blok D — voordat er een echte klant op gaat

### D16 · XAF-auditfile (review 3.1)
- `src/lib/xaf.ts`: XML Auditfile Financieel **3.2** — header, bedrijf, klanten/
  leveranciers, rekeningschema, btw-codes, perioden, beginbalans (met synthetische
  resultaatregel zodat hij per constructie sluit) en alle geboekte transacties per
  dagboek (Verkoop/Inkoop/Bank/Memoriaal/Opening). Knop op de Grootboek-pagina
  met boekjaarkeuze (gebroken boekjaren ondersteund).

### D16 · Beginbalans-UI (review 3.2)
- Tab **Beginbalans** in Grootboek: bestaat er al één, dan worden de regels
  getoond; anders een editor (alleen balansrekeningen) met live
  sluitpost-voorbeeld op 0500. `create_opening_balance` kreeg een
  duplicaat-guard (één actieve beginbalans; tegenboeken vereist voor een nieuwe).

### D16 · Openstaande-postenlijst (review 3.5)
- `report_open_items()`: per verkoop-/inkoopfactuur **geboekt − betaald −
  gecrediteerd uit het grootboek** (tegenboekingen vallen automatisch weg door
  per bron over origineel + spiegel te sommeren; betalingen via
  `bank_transactions.matched_*`). Inclusief de aansluitcontrole die 3.5 vroeg:
  grootboeksaldo 1300/1600 = openstaand + “niet aan factuur gekoppeld”.
- UI: derde weergave **Openstaand** op de W&V-pagina, met vervaldatum-markering
  en CSV-export.

### D16 · Paginering (review 3.10)
- `select()` en `selectOptional()` in `repository.ts` halen nu **alle** rijen op
  in pagina's van 1000 (`.range()`-lus, stabiele secundaire sortering op `id`).
  Daarmee zijn journaal, bankinbox en factuurlijst weer volledig boven de
  PostgREST-cap — en heeft de XAF-export gegarandeerd het hele boekjaar.

## Niet in dit blok
- Peppol-verzending (stap 2, access point), kasstelsel, valuta, Mollie-batch
  splitsen (3.6), de §4-securitypunten die niet door Blok C werden geraakt
  (o.a. `purchase_invoices`-immutability, `vat_returns`-update-policy op de
  bevroren snapshot) en de overige 3.9-punten.
