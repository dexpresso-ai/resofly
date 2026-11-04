# Financiële module — Blok A: zes gerichte fixes (2026-07-21)

## Wat & waarom
De kritische review (`REVIEW_FINANCIELE_MODULE_2026-07-21.md`) vond zes fouten die de
administratie **actief corrumperen** — geen ontbrekende features, maar bestaande code die
verkeerde boekingen produceert. Dit is Blok A uit §6 van die review: stop de bloeding.

Alles zit in één migratie: `supabase/migrations/20260721000000_finance_blok_a_fixes.sql`.

## Fix 1 — `reverse_journal_entry` maakte het saldo negatief i.p.v. nul
**Was:** de spiegelpost werd geboekt (`posted`) én het origineel op `reversed` gezet.
Alle rapporten/aangiften tellen alleen `posted` → het origineel viel wég en de spiegel
telde mee: netto **−1×** de post. Eén klik "Tegenboeken" op een factuurboeking gaf
negatieve omzet én een niet-bestaande BTW-teruggaaf in de eerstvolgende aangifte.

**Nu:** het origineel blijft `posted` (het is echt gebeurd), de spiegelpost neutraliseert
het saldo, `reversed_by_entry_id` markeert het paar. `status='reversed'` blijft
gereserveerd voor `reopen_fiscal_year` (bewust "volledig uit de rapporten", zonder
spiegelpost) — de twee mechanismen zijn nu eindelijk consistent. Extra guards:
- dubbel tegenboeken geblokkeerd (`reversed_by_entry_id`-check, mét `for update` tegen races);
- een `year_close`-boekstuk tegenboeken geblokkeerd (→ "gebruik Boekjaar heropenen";
  voorheen omzeilde de tegenboeking daarvan zelfs het periodeslot).

**Datarepair inbegrepen:** bestaande paren (origineel `reversed` mét
`reversed_by_entry_id`) worden op `posted` teruggezet, waarmee ze weer netto nul tellen.
Reopen-boekstukken (géén `reversed_by_entry_id`) blijven onaangeroerd. Let op: in
periodes waar zo'n paar in zat veranderen de rapportcijfers hierdoor — ze worden juist.

**UI (`Bookkeeping.tsx`):** label "Tegengeboekt" komt nu van `reversed_by_entry_id`,
spiegelposten heten "Tegenboeking", reopen-boekstukken "Vervallen"; de knop verdwijnt op
al-tegengeboekte en `year_close`-boekstukken.

## Fix 2 — bankaflettering: alleen geboekte documenten, begrensd op openstaand saldo
**Was:** `book_bank_transaction` crediteerde 1300 met het volle bankbedrag tegen élke
factuur — ook concepten zonder grootboekboeking (→ negatieve debiteuren) en zonder grens
(tweemaal dezelfde factuur afletteren kon gewoon).

**Nu:**
- afletteren vereist `journal_entry_id` op de factuur/inkoopfactuur, en de boeking mag
  niet tegengeboekt zijn;
- de creditering is begrensd op het **openstaande saldo**: geboekte vordering (som
  debet−credit op subtype `accounts_receivable` van de factuurboeking) minus eerdere
  geboekte bankransacties op dezelfde factuur. Deelbetalingen blijven werken; te veel
  afletteren geeft een duidelijke fout met het openstaande bedrag. Spiegelbeeldig voor
  inkoop op `accounts_payable`. `for update` op het document voorkomt dat twee
  gelijktijdige boekingen allebei de check passeren;
- `match_bank_transactions` stelt alleen nog geboekte documenten voor (een voorstel dat
  bij boeken gegarandeerd faalt is geen voorstel);
- **UI (`Bank.tsx`):** de dropdowns tonen alleen afletterbare documenten, met een hint
  ("Boek de factuur eerst naar het grootboek") als de lijst leeg is.

## Fix 3 — BTW in de vrije bankboeking: `kind` gerespecteerd, richting op rekeningtype
**Was:** ontvangst → alle BTW naar 1510, betaling → alles naar 1500, ongeacht de
rekening; `vat_codes.kind` werd genegeerd (VERL_INK rate 21 → inclusieve split zonder
1520-tegenboeking → voorbelasting geclaimd zonder 2a-verplichting).

**Nu:**
- BTW-kant volgt de **aard van de rekening**: omzet → 1510 (een terugbetaling aan een
  klant debiteert 1510 = minder af te dragen), kosten/activa → 1500 (een terugstorting
  van een leverancier crediteert 1500 = voorbelasting terugnemen). Balansrekeningen
  houden het oude gedrag;
- `kind in ('reverse_charge_purchase','eu_acquisition')` → volle bankbedrag als
  grondslag, BTW als 1500 + 1520 tegen elkaar in — identiek aan `book_purchase_invoice`;
- op omzetregels krijgen `vat_base_cents`/`vat_amount_cents` een teken dat meeloopt met
  de richting, zodat de rubrieken 1a/1b in `compute_vat_return` kloppen bij correcties.
- Balanscontrole per scenario nagelopen (ontvangst/terugbetaling omzet, betaling/
  terugstorting kosten, verlegd beide kanten, 1530): debet=credit exact, geen lek naar 4900.

## Fix 4 — `year_close`-filter terug in `compute_vat_return` + `finalize_vat_return`
Migratie 20260710010000 herschreef beide functies zónder het filter dat 20260706120000
vier dagen eerder bewust toevoegde. Regressie hersteld: `je.source_type <> 'year_close'`
staat weer in beide WHERE-clauses (het afsluitboekstuk lekte anders als negatieve omzet
in rubriek 1e zodra een aangifteperiode na de jaarafsluiting nog open stond).

## Fix 5 — factuurnummers uniek + verwijderblokkade
- **`unique index invoices_org_number_key (organization_id, number)`** — art. 35a Wet OB.
  Bestaande duplicaten worden éérst hernoemd (oudste behoudt het nummer; latere krijgen
  `-DUP-<id4>` als suffix) zodat de index kan bestaan. Controleer na de push of er
  hernoemd is: `select number from invoices where number like '%-DUP-%'`.
- **`before delete`-trigger `invoices_block_delete`**: verwijderen geblokkeerd zodra
  `journal_entry_id` gevuld is óf de status voorbij `draft` is (bewaarplicht; anders
  blijft een journaalpost zonder brondocument achter en wordt het nummer hergebruikt
  door de client-side `max+1`-generator). Zelfde patroon als
  `bank_account_block_delete_with_bookings`.
- **UI (`main.tsx`):** duidelijke uitleg vóór de confirm (i.p.v. een kale
  Postgres-fout), en de unique-violation bij opslaan wordt vertaald naar "Dit
  factuurnummer bestaat al…".
- Bekend gevolg (zelfde als bij de bankrekening-trigger): een cascade-delete van een
  hele organisatie faalt zolang er geboekte/verstuurde facturen zijn.

## Fix 6 — org-validatie op `p_lines[].account_id` (open follow-up task_7c598094)
`post_journal_entry` weigert nu elke regel waarvan het `account_id` bij een andere
organisatie hoort ("Grootboekrekening % hoort niet bij deze organisatie"). Omdat élke
boekingsweg (bankfeed, inkoop, verkoop, beginbalans, memoriaal, activa) door deze ene
functie loopt, erft alles de check. De 4900-afrondingsregel wordt via het org-gebonden
`bookkeeping_account_id` opgezocht en zit dus per constructie goed.

## Bijvangst
- `JournalSourceType` in `types.ts` miste `'year_close'` (bestond al sinds 20260706120000
  in de DB) — typecheck ving dit tijdens de bouw.
- Misleidende teksten gecorrigeerd die beloofden dat geweigerde boekingen "in de
  eerstvolgende open aangifte vallen" (die logica bestaat niet): foutmelding in
  `post_journal_entry` + uitlegregel in `VatReturns.tsx`.

## Bewust NIET in dit blok (zie review §6, Blok B/C/D)
Saldo-aansluiting bankfeed, dedup-unificatie import↔PSD2, `volgnr`-dedup-sleutel,
CSV-kolomherkenning, vat_code op verkoopfactuurregels, ontbrekende rubrieken, ICP-opgaaf,
creditnota's → grootboek, suppletie, XAF, beginbalans-UI, paginering.

## Deploy
1. `supabase db push --linked` (staging `enzghpduqwaojcxgwarr`) — migratie
   `20260721000000_finance_blok_a_fixes.sql`.
2. Branch `staging` pushen → Cloudflare Pages bouwt.
3. Geen edge-function-wijzigingen; geen nieuwe secrets.

## Adversariële SQL-review (aparte reviewer-pass) — verwerkt
De migratie is vóór de push regel-voor-regel gereviewd tegen alle actieve definities
(signatuurgelijkheid, acht balans-scenario's doorgerekend, race-gedrag, datarepair-scope,
lock-volgorde). Uitkomst: één blocker + kanttekeningen, allemaal verwerkt:
- **Blocker (gefixt):** een vrij geboekte transactie met een achtergebleven
  matcher-suggestie hield via `coalesce` haar `matched_invoice_id` — en zou in de nieuwe
  openstaand-berekening als aflettering meetellen zonder dat 1300 ooit geraakt was,
  waarna de échte betaling werd geweigerd. Twee kanten gefixt: (1) de matchvelden op een
  geboekte rij beschrijven nu exact wat de boeking deed (vrije boeking → leeg), en
  (2) `v_already` telt uit de **journaalregels** (credit 1300 / debet 1600 van de
  gekoppelde, niet-tegengeboekte boekingen) i.p.v. uit het matchveld — dat neutraliseert
  ook historisch vervuilde rijen én direct tegengeboekte betaal-boekingen.
- Overbetalings-foutmelding herschreven: het eerdere advies ("letter het openstaande
  deel af en boek de rest apart") kan met deze API niet — één banktransactie is niet
  splitsbaar. De melding verwijst nu naar de vrije boeking.
- DUP-suffix bij de duplicaat-hernoeming verlengd naar 8 id-tekens (botsingsbestendig).
- Delete-melding voor geannuleerde facturen apart geformuleerd (geen "annuleer deze"
  -advies op een al geannuleerde factuur), in trigger én UI.

Geaccepteerde kanttekeningen (bewust, gedocumenteerd):
- **KOR:** boekt een KOR-organisatie tóch BTW op de factuur, dan is de bankontvangst
  hoger dan de (ex-BTW) vordering en weigert de aflettering — de desync wordt nu
  zichtbaar gemaakt i.p.v. stil 1300 negatief te draaien. Echte fix (BTW-veld op nul
  dwingen bij KOR) staat in de review als Blok C.
- Cascade-delete van een hele organisatie faalt zolang er geboekte/verstuurde facturen
  zijn (zelfde patroon als de bankrekening-trigger).
- Een betaal-journaalpost rechtstreeks tegenboeken (buiten "Terugdraaien" om) laat de
  banktransactie op 'booked' staan — vooraf bestaand gat, telt door de journaalregel-som
  niet meer mee in het openstaand saldo; nette ontkoppeling is Blok B.

## Verificatie
- `npm run typecheck` ✓ en `npm run build` ✓ (na verwerking review opnieuw).
- E2E op staging (na db push): factuur boeken → tegenboeken → W&V/balans/aangifte tonen
  nul i.p.v. −1×; concept-factuur afletteren wordt geweigerd; tweemaal afletteren wordt
  geweigerd; VERL_INK-bankboeking toont 1500+1520; geboekte factuur verwijderen wordt
  geblokkeerd. Vereist ingelogde sessie — handmatige stap.
