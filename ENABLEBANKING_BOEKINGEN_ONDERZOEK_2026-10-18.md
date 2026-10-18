# Onderzoek — Boekingen via Enable Banking (2026-10-18)

> **Blok 1 en 2 gebouwd op 2026-10-18** (nog niet uitgerold): zie
> `CHANGELOG_BANK_AFLETTEREN_BETAALD_SALDO_2026-10-18.md` (blok 1 en 2.1) en
> `CHANGELOG_BANK_KOPPELING_LOOPT_VANZELF_2026-10-18.md` (2.2–2.5). Blok 3 en 4 van het
> bouwplan (§6) staan nog open.

Vraag: *hoe kunnen we Enable Banking gebruiken om boekingen te realiseren? Er stond al iets in
de code — kunnen we daarop verder bouwen, en wat moet er nog gebeuren?*

Kort antwoord: **ja, verder bouwen kan zonder iets weg te gooien.** De hele keten van bank naar
grootboek staat er al: `bank-sync` haalt via Enable Banking de transacties op, dezelfde import
als voor afschriften ontdubbelt ze, een matcher stelt een factuur of grootboekrekening voor, en
`book_bank_transaction` maakt er een sluitende journaalpost van — met btw-splitsing,
aflettergrenzen, terugdraaien en een saldo-aansluiting. De koppeling zelf werkt aantoonbaar: op
staging is op 26 juni twee keer een Rabobank (sandbox) gekoppeld en kwamen 3.620 transacties
binnen.

Maar het laatste stuk, van "transacties binnen" naar "boekingen", is nooit gelopen: **op staging
is nog geen enkele banktransactie geboekt** (alle 3.620 staan op `unmatched`, er bestaat geen
enkele bankregel). Wat er moet gebeuren, in vier blokken:

1. **De lus dichtmaken.** Afletteren boekt wel, maar zet de factuur niet op betaald: herinneringen
   en aanmaningen lopen door naar klanten die al per overboeking betaalden (Gerrie belooft het
   tegendeel). Mollie-betalingen tellen niet mee in het openstaand saldo. Pending-transacties van
   de bank komen binnen als echte.
2. **De feed laten draaien en controleerbaar maken.** Er is geen automatische sync, de toestemming
   verloopt stil (op staging sinds 24 september), en een gekoppelde rekening heeft geen saldo —
   waardoor de aansluitcontrole juist daar niet werkt. Alle gekoppelde rekeningen landen op 1100.
3. **Het handwerk omlaag.** Eén regel per boeking (een Mollie-uitbetaling is niet te splitsen in
   ontvangsten en kosten), geen "maak hier een regel van", herkenning alleen op factuurnummer.
4. **Live met echte bankdata.** Staging draait op een sandbox-app. Een productie-app met je eigen
   rekeningen is gratis (restricted mode); voor alle klanten is een contract nodig.

Blok 1 plus het saldo uit blok 2 zijn klein en leveren het meeste op; daarna kan een eerste echte
test met je eigen rekening.

Dit document is onderzoek, geen bouwopdracht: er is nog geen regel code veranderd.

---

## 1 · Wat er al ligt

Onderzocht in de huidige `staging`-stand (`48c9c0d`).

| Bouwsteen | Waar | Wat het doet |
|---|---|---|
| PSD2-koppeling | `supabase/functions/bank-sync/index.ts` | Bankkiezer (`listInstitutions` → `GET /aspsps`), toestemming starten (`createRequisition` → `POST /auth`), afronden na de redirect (`finalizeRequisition` → `POST /sessions`, rekeningen koppelen, eerste sync), ophalen (`sync` → `GET /accounts/{uid}/transactions` met paginering). JWT RS256 met de private sleutel uit de Edge-secrets |
| Eén ingang voor bank én afschrift | `import_bank_transactions` (`supabase/migrations/20260721010000_bankfeed_reconciliation_dedup.sql:96`) | Ontdubbelt server-side op inhoud (datum, bedrag, tegenrekening, omschrijving), hergebruikt een afschrift op bestandshash, draait daarna de matcher |
| Matcher | `match_bank_transactions` (`20260721000000_finance_blok_a_fixes.sql:877`) | Per open transactie, in volgorde: verkoopfactuur op nummer (alleen geboekte), inkoopfactuur op nummer, bankregel (met `auto_book` meteen boeken), Belastingdienst → 1530, leverancier op IBAN |
| Boekingsmotor | `book_bank_transaction` (`…finance_blok_a_fixes.sql:511`) | Bank tegen 1300 (verkoopfactuur, begrensd op het openstaand saldo), tegen 1600 (inkoopfactuur), of vrije regels met btw volgens de aard van de rekening (omzet → 1510, kosten → 1500, verlegd → 1500 + 1520). Op 1530 zet hij de bijbehorende aangifte op betaald |
| Corrigeren | `unbook_bank_transaction` (`20260623000001_bankfeed_vat_payment_link.sql:408`), `set_bank_transaction_status` | Tegenboeking + transactie weer open; negeren of weer openen. Geboekte transacties zijn onveranderbaar |
| Controle | `report_bank_reconciliation` (`…reconciliation_dedup.sql:286`), `report_open_items` (`20260723200000_finance_blok_c_d.sql:1431`) | Afschriftsaldo naast grootboekstand + nog te boeken; openstaande posten per factuur |
| Scherm | `src/features/Bank.tsx` | *Af te letteren* (boeken per transactie), *Rekeningen & koppeling* (koppelen, synchroniseren, afschrift inlezen, aansluitpaneel), *Regels* |
| Gerrie en MCP | `supabase/functions/_shared/actions/bookkeeping.ts:934`, `…/actions/finance.ts:845` | Rekeningen, sync, opnieuw matchen, boeken op inkoopfactuur of grootboekrekening, afletteren op verkoopfactuur, regels — als voorstel in de goedkeurwachtrij |
| Verkoopketen | `20260724100000_finance_autobook_revenue_chain.sql` | Een factuur wordt bij versturen automatisch geboekt (1300 / omzet / 1510); een Mollie-betaling boekt 1102 Kruisposten tegen 1300 |

---

## 2 · Wat staging laat zien

Alleen-lezen gecontroleerd via de Supabase Management API op 2026-10-18 (tellingen, geen inhoud).

| | Stand |
|---|---|
| Migraties | Alle bankmigraties toegepast (`20260622000004` t/m `20260726100000`) |
| Edge Function | `bank-sync` actief (versie 44, gedeployed 17-10) |
| Secrets | `ENABLEBANKING_APP_ID` en `ENABLEBANKING_PRIVATE_KEY` staan er. De optionele (`_COUNTRY`, `_PSU_TYPE`, `_CONSENT_DAYS`) niet, dus de defaults gelden: NL, zakelijk, 90 dagen. Geen cron-secret voor de bank |
| Omgeving | **Sandbox**: de koppel-links gaan naar `tilisy-sandbox.enablebanking.com` |
| Koppelingen | 2× Rabobank gekoppeld op 26-06, 3× gestart en niet afgerond. Toestemming geldig tot **24-09** — verlopen, maar de status staat nog op `linked` |
| Rekeningen | 8 gekoppelde rekeningen in 2 organisaties; per organisatie staan er 4 op **dezelfde** grootboekrekening |
| Transacties | 3.620, boekdatum 28-03 t/m 26-06, **allemaal `unmatched`**. Synthetische testdata (18 verschillende omschrijvingen). Laatste sync: 26-06 |
| Regels / geboekt | 0 bankregels, 0 geboekte, 0 voorgestelde transacties |
| Cron | 14 jobs (herinneringen, aanmaningen, Mollie, agents, …) — geen voor de bank |

Twee conclusies. **Eén:** de review van 21-07 schreef dat de flow "nooit e2e getest" was
(`REVIEW_FINANCIELE_MODULE_2026-07-21.md:26`). De data zegt dat koppelen, rekeningen ophalen en
transacties importeren in de sandbox wél werkten. **Twee:** het boeken is nooit met PSD2-data
geoefend, en dat kán ook niet met deze sandbox-data: een nagebootste matcher-run vindt 0 facturen,
0 leveranciers en 0 keer de Belastingdienst. Voor een echte test is echte bankdata nodig (§7).

NB: na 26-06 is er geen geslaagde sync meer geweest. De huidige `bank-sync` — met de
ontdubbeling van Blok B (21-07) — is dus nog niet tegen Enable Banking gedraaid.

---

## 3 · Hoe een banktransactie nu een boeking wordt

```
Koppel bank ──► POST /auth ──► bank (SCA) ──► ?code&state ──► POST /sessions
            ──► rekeningen aanmaken (allemaal op 1100) ──► eerste sync (90 dagen)

Synchroniseer (handmatig) ──► GET /transactions (+ continuation_key) ──► mapEbTransaction
            ──► import_bank_transactions (ontdubbelen op inhoud)
            ──► match_bank_transactions ──► voorstel, of een auto_book-regel boekt direct

Boeken (scherm of Gerrie) ──► book_bank_transaction ──► journaalpost (source_type 'payment')
            ──► W&V, balans en btw-aangifte werken bij
```

Wat er dan in het grootboek komt:

| Transactie | Boeking |
|---|---|
| Klant betaalt factuur (€ 1.210) | 1100 Bank D 1.210 · 1300 Debiteuren C 1.210 |
| Inkoopfactuur betaald (€ 605) | 1600 Crediteuren D 605 · 1100 Bank C 605 |
| Abonnement € 121 incl. 21% via een regel | 4500 D 100 · 1500 Voorbelasting D 21 · 1100 C 121 |
| Btw-afdracht aan de Belastingdienst | 1530 D … · 1100 C … → de aangifte gaat op "betaald" |
| **Ontbreekt:** Mollie-uitbetaling € 968 voor € 1.000 aan betalingen | 1100 D 968 · 4130 Betaalproviderkosten D 32 · 1102 Kruisposten C 1.000 |

---

## 4 · Wat er mis gaat of ontbreekt

### 4.1 · De lus is niet dicht (fout resultaat)

1. **Afletteren zet de factuur niet op betaald.** `book_bank_transaction` werkt alleen de
   banktransactie bij (`…finance_blok_a_fixes.sql:826-834`); `invoices.status`/`paid_at` en
   `purchase_invoices.payment_status`/`paid_at` worden door de bank nergens geraakt. Herinneringen
   en aanmaningen selecteren op `status = 'overdue'`
   (`20260617000000_invoice_payment_reminders.sql:184`, `20260722000000_debtor_dunning.sql:249`),
   dus een klant die per overboeking betaalt krijgt gewoon de herinnering en daarna de aanmaning.
   Gerrie belooft het tegendeel — "de factuur gaat op betaald"
   (`supabase/functions/_shared/actions/finance.ts:851`, `:889`) — maar de uitvoering roept alleen
   `bookBankTransaction` aan (`src/lib/actions/finance.ts:182-189`). Bij inkoop blijft
   `payment_status` voor altijd `unpaid` — en omdat Gerrie daarop telt, noemt hij elke betaalde
   inkoopfactuur onbetaald en na de vervaldatum "te laat" (`supabase/functions/_shared/gerrieCore.ts:4637-4659`).

2. **Mollie-betalingen tellen niet mee als betaald.** `book_invoice_payment` boekt 1102 tegen 1300
   met als `source_id` de factuur (`20260724100000_finance_autobook_revenue_chain.sql:345-347`).
   Zowel de afletter-check in `book_bank_transaction` (`…finance_blok_a_fixes.sql:621-629`) als
   `report_open_items` (`20260723200000_finance_blok_c_d.sql:1477-1485`) tellen alleen betalingen
   die via een banktransactie liepen. Gevolg: elke via Mollie betaalde factuur staat in de
   openstaande-postenlijst als open, het "niet toe te rekenen"-bedrag wordt negatief met het
   Mollie-totaal, en de bank kan zo'n factuur nog een keer afletteren. Op staging nog niet
   zichtbaar, want daar is nog niets via Mollie geboekt. Bijvangst: de 1300-regel van die boeking
   mist `client_id` (`…autobook_revenue_chain.sql:339-342`).

3. **Pending-transacties komen binnen als echte.** Enable Banking levert ook nog niet geboekte
   transacties mee (`status: "PDNG"`). `mapEbTransaction` valt dan terug op `value_date` en
   importeert ze (`bank-sync/index.ts:337`, filter op `:301`). De changelog noemt "alleen booked"
   (`CHANGELOG_BANKFEED_ENABLEBANKING_2026-06-25.md:61`), maar dat wordt niet afgedwongen. Komt
   dezelfde betaling later als geboekt binnen met een andere datum of omschrijving, dan levert de
   inhoudssleutel een tweede rij op — twee keer boekbaar.

4. **Teken zonder indicator.** Zonder `credit_debit_indicator` wordt elk bedrag positief
   (`bank-sync/index.ts:335`): een afschrijving van een bank die het teken in het bedrag zet, komt
   binnen als ontvangst.

### 4.2 · De feed draait niet vanzelf en is niet te controleren

5. **Geen automatische sync.** Er is geen cron en geen cron-ingang in `bank-sync`; de origin-check
   (`bank-sync/index.ts:50`) zou een cron-aanroep ook weigeren. Wie niet op "Synchroniseer" klikt,
   ziet niets — op staging sinds 26-06.

6. **Verlopen toestemming is onzichtbaar.** `expires_at` wordt opgeslagen maar nergens gelezen. De
   rekeningkaart waarschuwt pas als de status `expired` is (`Bank.tsx:447`), en die status wordt
   alleen gezet na een mislukte sync (`bank-sync/index.ts:319-323`). Er is geen "opnieuw koppelen"
   op de kaart en geen melding vooraf. De duur is vast 90 dagen (`:152`); de maximale duur per bank
   (`maximum_consent_validity`, in seconden) wordt wel opgehaald, maar weggezet als het ongebruikte
   veld `transaction_total_days` (`:140`, `src/types.ts:2848`). Sinds juli 2023 staat de PSD2-RTS
   180 dagen tussen twee bankauthenticaties toe; hoe lang een bank via Enable Banking toestaat,
   staat per bank in dat veld.

7. **Een gekoppelde rekening heeft geen saldo.** De sync legt een afschrift vast zonder begin- of
   eindsaldo (`bank-sync/index.ts:303-307`), terwijl `report_bank_reconciliation` juist het laatste
   eindsaldo zoekt (`…reconciliation_dedup.sql:345-351`). Het aansluitpaneel zegt daarom "lees eens
   per periode een CAMT.053-afschrift in" (`Bank.tsx:296-298`) — handwerk dat de koppeling juist
   moet wegnemen. Enable Banking heeft hiervoor `GET /accounts/{uid}/balances`.

8. **Alle gekoppelde rekeningen op 1100.** `finalizeRequisition` hangt elke nieuwe rekening aan de
   standaard-bankrekening (`bank-sync/index.ts:204`, `:252-258`). Op staging staan per organisatie
   4 rekeningen op één grootboekrekening: per rekening aansluiten kan dan niet (het paneel zegt dat
   ook), een spaarrekening of creditcard komt zo ook op "Bank", en een overboeking tussen eigen
   rekeningen wordt nergens herkend.

9. **Foutafhandeling.** Een 429 (de bank staat even geen ophalen toe) of een sessie-verlopen-code
   anders dan 401/403 geeft een algemene fout in plaats van "koppel opnieuw". De paginering stopt
   stil na 25 pagina's en zet `last_synced_at` toch vooruit (`:299`, `:316`); valt de afgekapte
   rest buiten het venster van de volgende sync (laatste sync − 7 dagen), dan komt die nooit meer
   binnen. Wordt dezelfde terugkeer-URL nog eens geopend, dan zet de mislukte code-inwisseling een
   al gekoppelde requisition op `error` (`:190-195`).

### 4.3 · Te veel handwerk

10. **Eén regel per boeking.** Het scherm stuurt precies één regel (`Bank.tsx:159`); de database
    kan er meer (`…finance_blok_a_fixes.sql:713-790`). Daardoor is een Mollie-uitbetaling niet
    goed te boeken: het bedrag is ontvangsten min kosten, dus 1102 én 4130 in één post. Hetzelfde
    geldt voor rente + aflossing, een privé-deel, of salaris + loonheffing.

11. **Mollie-uitbetalingen worden niet herkend.** De matcher kent de Belastingdienst
    (`…finance_blok_a_fixes.sql:1012-1026`) maar niet Mollie → 1102. Zonder dat loopt
    1102 Kruisposten alleen maar op.

12. **Regels moet je zelf verzinnen.** Regels zijn de enige weg naar automatisch boeken, maar na
    een handmatige boeking is er geen "maak hier een regel van". Op staging: 0 regels.

13. **Herkenning alleen op factuurnummer.** Een klant die zonder factuurnummer betaalt, wordt niet
    herkend — ook niet op bedrag + naam, en op IBAN kan niet omdat klanten geen IBAN-veld hebben.
    Het gestructureerde betalingskenmerk wordt niet overgenomen (`structured_reference: null`,
    `bank-sync/index.ts:351`). En de matcher stelt ook al volledig betaalde facturen voor; die
    boeking faalt dan op "al volledig afgeletterd".

14. **Geen bulk en geen Gerrie-kaart.** Elk voorstel kost een klik. De bankkaart
    `bank_match_suggested` voor de beslislijst staat in het plan "zodra matchen automatisch loopt
    na een sync" (`GERRIE_BESLISLIJST_PLAN.md:322`) — die voorwaarde is na blok 2 vervuld.

---

## 5 · De Enable Banking-API: wat klopt en wat niet

De officiële documentatie is vanuit de bouwomgeving niet bereikbaar (netwerkbeleid). Gecontroleerd
tegen de officiële voorbeeldcode van Enable Banking en de open-source integratie in Actual Budget
(zie Bronnen).

| Onderdeel | ResoFly | Oordeel |
|---|---|---|
| JWT: RS256, `kid` = app-id, `iss` `enablebanking.com`, `aud` `api.enablebanking.com`, `exp` 1 uur | `ebJwt` (`bank-sync/index.ts:93-113`) | ✓ identiek aan de voorbeeldcode |
| `GET /aspsps` → `{ aspsps: [...] }` | `listInstitutions` | ✓ |
| `POST /auth` met `access.valid_until`, `aspsp`, `state`, `redirect_url`, `psu_type` | `createRequisition` | ✓ vorm. ✗ duur vast 90 dagen; `psu_type` app-breed |
| `POST /sessions` → `session_id`, `accounts[].uid` | `finalizeRequisition` | ✓ |
| `GET /accounts/{uid}/transactions` met `date_from` + `continuation_key`, ook doorgaan na een lege pagina | `syncAccounts` | ✓ (de stille cap van 25 pagina's ✗) |
| Pending (`status: "PDNG"`) | niet gefilterd | ✗ — §4.1 punt 3 |
| `GET /accounts/{uid}/balances` | niet gebruikt | ✗ — §4.2 punt 7 |
| PSU-headers (`Psu-Ip-Address`, `Psu-User-Agent`) als de gebruiker zelf synchroniseert | niet meegestuurd | ✗ — zonder telt een klik mee voor de grens van 4× per 24 uur die banken voor ophalen op de achtergrond hanteren |
| Sessie beëindigen bij ontkoppelen | er is geen ontkoppelen | ✗ — `DELETE /sessions/{id}`; te verifiëren in de sandbox |
| `GET /application` (app-gegevens, `redirect_urls`) | niet gebruikt | Handig als instellingencheck |

---

## 6 · Bouwplan

Grootte: **S** = één migratie of één functie aanpassen, **M** = een handvol bestanden,
**L** = een nieuw onderdeel.

### Blok 1 · De lus dichtmaken (correctheid)

| # | Wat | Hoe | Grootte |
|---|---|---|---|
| 1.1 | Afletteren zet de factuur op betaald | In `book_bank_transaction`: is het openstaand saldo na deze boeking 0, dan `invoices.status = 'paid'` en `paid_at` = boekdatum; bij inkoop `payment_status` `paid`/`partially_paid` + `paid_at`. Een kolom `paid_bank_transaction_id` (zoals `vat_returns` al heeft) laat `unbook_bank_transaction` het netjes terugzetten. Herinneringen en aanmaningen stoppen dan vanzelf, en wat Gerrie belooft klopt | S |
| 1.2 | Eén definitie van "betaald" | Eén SQL-functie die per factuur geboekt − betaald − gecrediteerd uit het grootboek haalt, mét de Mollie-betalingen (`invoice_payment_records.journal_entry_id`). Gebruiken in `book_bank_transaction`, `match_bank_transactions` (geen voorstel meer voor een betaalde factuur) en `report_open_items` | M |
| 1.3 | Pending overslaan | `status === 'PDNG'` niet importeren | S |
| 1.4 | Teken | Zonder indicator het teken van het bedrag volgen | S |
| 1.5 | Afronden idempotent | Een al gekoppelde requisition niet opnieuw afronden of op `error` zetten | S |

### Blok 2 · Automatisch en controleerbaar

| # | Wat | Hoe | Grootte |
|---|---|---|---|
| 2.1 | Saldo bij elke sync | `GET /balances`; een **geboekt** saldo kiezen (CLBD, anders ITBD — niet CLAV/ITAV/XPCD, die tellen kredietlimiet of pending mee) en vastleggen als afschriftsaldo op de peildatum (`reference_date`). Het aansluitpaneel werkt dan zonder CAMT-import. Let op: `import_bank_transactions` weigert een lege lijst (`…reconciliation_dedup.sql:127-129`), dus een saldo zonder nieuwe transacties heeft een eigen ingang nodig | S–M |
| 2.2 | Dagelijkse sync | `?cron=sync` in `bank-sync`, vóór de origin-check, met `BANK_SYNC_CRON_SECRET` en `x-cron-secret` — hetzelfde patroon als `invoice-workflow` (`supabase/functions/invoice-workflow/index.ts:108-123`, `DUNNING_AUTOMAT_SETUP_2026-07-22.md:44`). Eerst de langst niet gesynchroniseerde rekeningen, binnen een tijdsbudget per aanroep. Handmatige sync mét PSU-headers. De matcher draait al mee zodra er iets nieuws binnenkomt | M |
| 2.3 | Toestemming | "Geldig tot …" op de rekeningkaart, waarschuwing 14 dagen vooraf, "Opnieuw koppelen" met dezelfde bank; verlopen afleiden uit `expires_at`; signaal naar Gerrie en push. Duur tot het maximum van de bank | M |
| 2.4 | Eigen grootboekrekening per rekening | Bij het koppelen elke rekening een eigen 11xx-rekening geven (of laten kiezen), met het rekeningtype als hint. Een overboeking tussen eigen rekeningen herkennen (tegen-IBAN is een eigen rekening) → voorstel op een kruispostenrekening, zodat beide kanten samen op nul uitkomen | M |
| 2.5 | Foutafhandeling | 429 → "probeer het later", sessie-verlopen-codes → opnieuw koppelen, paginering niet stil afkappen | S |

### Blok 3 · Minder handwerk

| # | Wat | Hoe | Grootte |
|---|---|---|---|
| 3.1 | Splitsen | Meerdere regels per transactie in het scherm (de database kan het al), met "nog te verdelen" | M |
| 3.2 | Mollie-uitbetaling | Herkennen → voorstel 1102, met het verschil op 4130. Exact uitsplitsen per uitbetaling kan later via de Mollie Settlements-API | S (herkennen) / L (exact) |
| 3.3 | Regel uit een boeking | Na handmatig boeken: "Voortaan altijd zo boeken?" met IBAN en naam voorgevuld; Gerrie kan het ook voorstellen | S–M |
| 3.4 | Betere herkenning | Betalingskenmerk overnemen; bedrag = openstaand bedrag + naam; IBAN van de betaler na de eerste aflettering bij de klant onthouden | M |
| 3.5 | Bulk | "Boek alle voorstellen waarvan het bedrag exact klopt" | S |
| 3.6 | Gerrie-kaart | `bank_match_suggested` na elke automatische sync in de beslislijst | M |

### Blok 4 · Live (de code-kant)

| # | Wat | Hoe | Grootte |
|---|---|---|---|
| 4.1 | Ontkoppelen | Knop + sessie bij Enable Banking beëindigen (stopt toegang én kosten), status `revoked` (check-constraint in `20260625000005_bankfeed_direct_link.sql:47`) | S–M |
| 4.2 | Instellingencheck | `GET /application`: omgeving (sandbox of productie) en of de app-URL bij de toegestane redirect-URL's staat | S |
| 4.3 | Zakelijk of privé per koppeling | Keuze in de bankkiezer op basis van de `psu_types` van de bank, in plaats van één app-brede `ENABLEBANKING_PSU_TYPE` | S |
| 4.4 | Prijs en gating | Bankkoppeling als betaalde optie (Enable Banking rekent per rekening per maand) | M |

---

## 7 · Buiten de code

1. **Productie-app bij Enable Banking.** Registreren en je eigen rekening(en) koppelen via het
   Control Panel; de app staat dan actief in *restricted mode*: gratis, maar alleen voor die
   gekoppelde rekeningen. Ideaal om op staging met echte data te testen — de sandbox-data kan nooit
   matchen. Daarna `ENABLEBANKING_APP_ID` en `ENABLEBANKING_PRIVATE_KEY` op staging vervangen.
2. **Redirect-URL's** van staging én productie whitelisten in die app.
3. **Sandbox-rekeningen opruimen** op staging. Er zijn geen geboekte transacties, dus verwijderen
   mag; anders blijven 3.620 testtransacties in de inbox staan.
4. **Voor alle klanten:** contract en KYB bij Enable Banking. De prijs is volumegebonden
   (rekeningen per maand, met een minimumfactuur) en alleen via sales op te vragen. Daarnaast de
   verwerkersovereenkomst en de privacyverklaring bijwerken.
5. **PSD2-grens:** zonder dat de gebruiker erbij is, mag een rekeninginformatiedienst maximaal
   4× per 24 uur ophalen; een dagelijkse cron past ruim, en een klik van de gebruiker zelf telt
   niet mee.

---

## 8 · Aanbevolen volgorde

1. **Blok 1 + 2.1** in één wijziging — klein, geen schermontwerp nodig.
2. **Echte test:** productie-app in restricted mode met je eigen Rabobank-rekening. Koppelen,
   synchroniseren, en één ronde echt boeken: staat de factuur op betaald, stopt de herinnering,
   sluit de bank aan?
3. **Blok 2.2–2.5:** dagelijkse sync en toestemming.
4. **Blok 3**, te beginnen met splitsen (3.1) en Mollie (3.2) — daar zit het meeste handwerk.
5. **Blok 4** en het contract zodra het voor klanten open moet.

---

## Bronnen

- Enable Banking, officiële voorbeeldcode:
  [`enablebanking-api-samples` → `python_example/account_information.py`](https://github.com/enablebanking/enablebanking-api-samples)
  (JWT, `/application`, `/aspsps`, `/auth`, `/sessions`, `/balances`, `/transactions`).
- Actual Budget, open-source Enable Banking-integratie:
  [`packages/sync-server/src/app-enablebanking/`](https://github.com/actualbudget/actual/tree/master/packages/sync-server/src/app-enablebanking)
  (pending vs. geboekt, `/balances`, PSU-headers, `maximum_consent_validity` in seconden, foutcodes).
- [Enable Banking — Linked accounts (restricted mode)](https://enablebanking.com/docs/api/linked-accounts/)
- [Enable Banking — FAQ (prijs, productie)](https://enablebanking.com/docs/faq)
- [Enable Banking — changelog februari 2024 (`strategy`, `continuation_key`)](https://enablebanking.com/blog/2024/03/11/changelog-february-2024)
- [EBA Q&A 2018_4172 (actieve aanvraag vs. 4× per 24 uur)](https://www.eba.europa.eu/single-rule-book-qa/qna/view/publicId/2018_4172)
