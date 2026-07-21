# Bankfeed Blok B — saldo-aansluiting, één dedup-sleutel, robuuste parsers (2026-07-21)

## Wat & waarom
Blok A repareerde wat er fóút geboekt werd. Blok B zorgt dat je het **merkt** als er
iets mis is met de bankfeed, en dicht de twee manieren waarop transacties nu stil
verdwijnen of verdubbelen. Bron: `REVIEW_FINANCIELE_MODULE_2026-07-21.md` §6 Blok B.

Migratie: `supabase/migrations/20260721010000_bankfeed_reconciliation_dedup.sql`.

## B1 — Saldo-aansluiting: de kerncontrole die volledig ontbrak
Begin- en eindsaldo werden netjes uit CAMT.053 en MT940 gelezen, opgeslagen in
`bank_statements` — en **nooit teruggelezen**. Daardoor bleef elke ontbrekende of
dubbele transactie onzichtbaar tot de jaarrekening.

Nieuw: **`report_bank_reconciliation(org)`** zet per bankrekening naast elkaar:

```
eindsaldo laatste afschrift  ==  grootboekstand 1100  +  nog te boeken  +  genegeerd
```

Beide zijden worden op **dezelfde peildatum** gemeten (het einde van dat afschrift),
anders vergelijk je appels met peren zodra er nieuwere transacties binnen zijn.
Server-side, want de journaalregels van 1100 lopen ver boven de PostgREST-rijlimiet —
client-side optellen zou stilzwijgend een verkeerd saldo geven.

De RPC meldt óók, want een verschil zonder verklaring helpt niemand:
- **gedeelde grootboekrekening** — boeken meerdere bankrekeningen op 1100, dan is de
  stand de som van allemaal en kún je niet per rekening aansluiten;
- **ontbrekende beginbalans** — begon je met saldo maar is er geen
  `opening_balance`-boekstuk, dan verklaart dat het hele verschil;
- **vermoedelijke dubbelen** — transacties die op datum, bedrag, tegenrekening én
  omschrijving identiek zijn (melden, niet automatisch opruimen: soms zijn het echt
  twee gelijke betalingen);
- **afschriften die intern niet kloppen** — beginsaldo + regels ≠ eindsaldo, dus het
  bestand mist regels.

UI: aansluitpaneel per rekening in *Rekeningen & koppeling*, groen bij sluitend en
anders het verschil met de bijpassende verklaring. Bij import wordt de
afschriftcontrole direct getoond (`balance_ok` uit de import-RPC).

## B2 — Eén dedup-sleutel voor beide ingestiewegen
De afschrift-import maakte sleutels `tx:<bankref>` of `h:<hash>:<n>`, de Enable
Banking-sync `eb:<ref>`. Dezelfde transactie via beide wegen = twee verschillende
sleutels = twee rijen. En omdat `finalizeRequisition` bovendien een **tweede**
`bank_accounts`-rij aanmaakte voor een IBAN die je al had — die op dezelfde 1100 boekt —
verdubbelde het banksaldo zonder één signaal.

Nu:
- de sleutel wordt **uitsluitend server-side** afgeleid in `import_bank_transactions`
  via `bank_canonical_key(datum, bedrag, tegenrekening, omschrijving)`, met een
  volgnummer binnen de aangeleverde batch. Bewust **niet** de bankreferentie: die
  verschilt per kanaal en is juist de oorzaak. Eén afleiding op één plek kan per
  definitie niet uiteenlopen;
- een door de client meegestuurde `dedup_key` wordt genegeerd; `ParsedBankTransaction`
  heeft het veld niet meer en `mapEbTransaction` zet het niet meer;
- **bestaande rijen zijn omgenummerd** naar hetzelfde schema, zodat een her-import van
  oude afschriften niets dubbel toevoegt (oude sleutels `tx:`/`h:`/`eb:` botsen niet met
  de nieuwe `c:`, dus de update is veilig);
- `finalizeRequisition` koppelt nu eerst op extern account-id en **daarna op IBAN** aan
  een bestaande rekening, in plaats van een tweede rij te maken.

Bijvangst: hetzelfde bestand tweemaal inlezen maakte elke keer een nieuwe
afschriftrij (`file_hash` werd opgeslagen maar nooit gebruikt). Nu wordt de bestaande
rij hergebruikt — anders zou een her-import als "afschrift zonder transacties" in de
saldocontrole verschijnen.

## B3 — `volgnr` als dedup-sleutel: stil dataverlies
`refCol` accepteerde `volgnr`, en dat werd de sleutel. Een volgnummer loopt per dag
opnieuw op, dus vanaf dag twee botste alles op `on conflict do nothing`: je zag
"15 nieuw, 420 al bekend" en dacht dat het goed ging. De kolom speelt geen rol meer in
de sleutel (die is nu inhoudsgebaseerd).

## B4 — CSV-kolomherkenning
`findCol` pakte de eerste header die de term *bevat*. ING's tweede kolom heet "Naam /
Omschrijving" en kaapte daarmee de omschrijvingsrol, waardoor **"Mededelingen" — de
kolom mét het factuurnummer — nooit werd gelezen** en automatische aflettering bij ING
structureel niets opleverde.

Nu: **exacte headermatch vóór bevat-match**, kolommen die al een rol hebben worden
overgeslagen, en de omschrijving wordt uit **álle** passende kolommen samengevoegd
(Rabobank splitst over Omschrijving-1/-2/-3, die verdwenen eerder).

Verder:
- **debet/credit-kolompaar** wordt alleen gebruikt als béide kolommen bestaan (exacte
  match, anders kaapt de term `af` woorden als "afschrijving");
- **indicatorherkenning verbreed** — headers worden genormaliseerd, dus "Af/Bij",
  "Af Bij" en "Bij / Af" vallen samen; waardepatronen uitgebreid (`d`, `db`, `dbit`,
  `cr`, `crdt`, `+`, `-`);
- **creditcard-waarschuwing**: alle bedragen positief én geen indicatorkolom herkend →
  expliciete melding, want dan komen uitgaven als ontvangst binnen en matchen ze tegen
  verkoopfacturen;
- **overgeslagen regels worden geteld en gemeld** (waren onzichtbaar);
- **`amountToCents`**: `'1.234'` werd € 1,23. Eén separator met precies drie cijfers
  erachter is nu een duizendtalscheiding — dat raakt elk uit Excel heropgeslagen
  bankbestand met hele euro's;
- **MT940 `/REMI/`** liep tot de eerstvolgende schuine streep, dus `/REMI/FACT 2026/0007`
  gaf "FACT 2026" en het factuurnummer sneuvelde. Loopt nu door tot het volgende
  subveld;
- **meerdere rekeningen in één bestand** (CAMT met meerdere `Stmt`, MT940 met meerdere
  `:25:`) geven een waarschuwing: alles komt op één bankrekening binnen en het
  begin-/eindsaldo is dat van het eerste afschrift.

## Adversariële SQL-review — verwerkt vóór de push
Drie blockers gevonden en gefixt:

1. **Tegengeboekte posten werden dubbel geteld.** Door Blok A blijft een tegengeboekt
   origineel op `posted` staan en krijgt de spiegelpost de datum van *vandaag*. Die
   spiegel viel dus buiten de peildatum terwijl het origineel erbinnen viel, én
   `unbook_bank_transaction` zet de transactie terug op `unmatched` — waardoor het
   bedrag zowel in de grootboekstand als in "nog te boeken" meetelde. Elke
   teruggedraaide bankboeking zou een verschil hebben getoond dat er niet is. Opgelost
   door tegenboekingsparen uit de grootboekstand te laten (een paar is netto nul, dus
   dat is datumonafhankelijk correct).
2. **Vals alarm bij overlappende imports.** De afschriftcontrole telde op
   `statement_id`. Importeer je eerst `jan.csv` en daarna `jan-feb.csv`, dan ketsen de
   januari-regels af op de dedup en houden ze hun oude `statement_id` — de controle zag
   dan alleen februari tegen een begin-/eindsaldo over jan+feb. Nu op **datumbereik**,
   wat sowieso de juistere vraag is: klopt alle activiteit in deze periode met de saldi.
3. **`bank_canonical_key` was `immutable` met een DateStyle-afhankelijke cast.**
   `date::text` volgt de sessie-instelling; liep die van de migratie uiteen met die van
   de PostgREST-rol, dan zou een her-import compleet nieuwe sleutels krijgen — precies
   de dubbelingen die dit moet voorkomen. De datum gaat nu als dagnummer de hash in.

Verder verwerkt: `difference_cents` is nu `null` bij een gedeelde grootboekrekening
(liever geen getal dan een fout getal, met uitleg in de UI), `nulls last` bij het
sorteren van afschriften, index op `bank_transactions(statement_id)`, `match_bank_transactions`
alleen nog als er echt iets is ingevoegd, en het `skipped`-getal is uitgesplitst naar
duplicaat / geen datum / bedrag € 0,00 — dat was één ondoorzichtig getal geworden.

Bewust geaccepteerd en gedocumenteerd: bestaande dubbelen worden **niet** automatisch
opgeruimd (ze worden omgenummerd en blijven bestaan; `duplicate_suspects` meldt ze), en
genegeerde transacties tellen mee in de aansluiting omdat ze wél op het afschrift staan
— de UI legt dat nu uit.

## Deploy-readiness-review — na de eerste push nog twee fixes (commit 00e9d69)
Een tweede, onafhankelijke controle op deploy-volgorde, contract-consumenten en
rollback vond nog twee echte problemen:

1. **Het aansluitpaneel gaf een instructie die de UI onmogelijk maakte.** Voor een
   gekoppelde rekening levert de PSD2-sync geen begin-/eindsaldo, dus toont het paneel
   "lees eens per periode een CAMT.053-afschrift in" — maar de UI verving de knop
   "Afschrift inlezen" door "Synchroniseer" zodra `source !== 'import'`. Voor precies
   de rekeningen die een afschrift nodig hebben was importeren dus onmogelijk. Beide
   knoppen zijn nu beschikbaar; ontdubbeling gebeurt op inhoud en wat er tóch
   doorheen glipt wordt zichtbaar in ditzelfde paneel.
2. **De IBAN-fallback verschoof de dubbeltelling in plaats van hem op te lossen.** De
   fallback sloeg rijen mét een `external_account_id` over. Bij herkoppelen na een
   verlopen toestemming geeft Enable Banking vaak een nieuw account-uid uit: de
   lookup op uid mist dan, de IBAN-match weigerde vanwege het oude uid, en er kwam een
   tweede rij met dezelfde IBAN die óók op 1100 boekt. Nu wint de IBAN (wereldwijd
   uniek), met voorrang voor een nog niet gekoppelde rij.

Bevestigd niet-relevant: de deploy-volgorde-blocker (migratie is als eerste toegepast)
en de vrees dat de backfill op de unique index zou klappen (`db push` slaagde schoon).
Contract-consumenten geverifieerd: exact twee (`src/lib/repository.ts` en
`supabase/functions/bank-sync/index.ts`), beide meegewijzigd.

## Verificatie
- **Parsertests: 44 asserts groen** (esbuild → node), met realistische ING-, Rabobank-,
  ABN-paar-, creditcard- en MT940-bestanden. Expliciet gedekt: ING-omschrijving uit
  Mededelingen, Rabobank Omschrijving-1/-2/-3 samengevoegd, duizendtalscheiding,
  MT940-factuurnummer over de schuine streep, en `begin + regels = eind`.
- `npm run typecheck` ✓ en `npm run build` ✓.
- `bank-sync` los gecontroleerd (esbuild TS-transform) — die zit niet in
  `npm run typecheck`.
- Migratie adversarieel gereviewd vóór de push.

## Deploy
1. `supabase db push --linked` — migratie `20260721010000`.
2. `supabase functions deploy bank-sync --project-ref enzghpduqwaojcxgwarr`
   (de edge function stuurt geen eigen dedup-sleutels meer — **moet mee**, anders
   blijven PSD2-syncs `eb:`-sleutels gebruiken en werkt de ontdubbeling niet).
3. Branch `staging` pushen → Cloudflare Pages bouwt.

## Nog open (Blok C/D uit de review)
vat_code op verkoopfactuurregels, ontbrekende BTW-rubrieken, creditnota's → grootboek,
suppletie, ICP-opgaaf, XAF-export, beginbalans-UI, openstaande-postenlijst, paginering.

Ook bewust níét in dit blok: **batch-/verzamelbetalingen splitsen** (een Mollie-payout
blijft één onafletterbare regel — de CAMT-parser leest per `Ntry` nog steeds alleen de
eerste `TxDtls`) en **valuta-omrekening**. Beide zijn eigen features, geen fixes.
