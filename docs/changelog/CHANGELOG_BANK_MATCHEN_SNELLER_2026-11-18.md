# Bank: matchen sneller, en de grens groeit mee — 18 november 2026

Vraag, na het vanzelf koppelen van betalingen aan inkoopfacturen
([CHANGELOG_BANK_INKOOP_AFLETTEREN_2026-11-18.md](CHANGELOG_BANK_INKOOP_AFLETTEREN_2026-11-18.md)):
"Kunnen we de 3 sec verlengen en snelheid optimaliseren?"

## Wat er was

- **Vast drie seconden automatisch boeken per ronde.** Ook voor de
  bankkoppeling, die 120 seconden heeft. Wat daarna nog zeker was, werd een
  voorstel met "nog niet geboekt"; je moest zelf nog eens op "Opnieuw matchen"
  klikken.
- **Geen grens aan het nalopen zelf.** Een achterstand van tienduizenden
  bankregels liep alsnog tegen de 8 seconden van de database aan (de grens voor
  ingelogde gebruikers, gemeten op staging), en dan ging de hele import
  verloren.
- **Een boeking kostte ~10 ms**, waarvan 5 ms in
  `ensure_default_ledger_accounts`. Die voegde twee keer per boeking het hele
  rekeningschema in met "on conflict do nothing". Ook als alles er al stond,
  liepen de triggers van `ledger_accounts` en `vat_codes` voor elke rij.
- **Nalopen kostte ~0,45 ms per bankregel**, ook als er niets kon passen:
  - per ontvangst een zoekvraag over alle verkoopfacturen;
  - per regel een zoekvraag naar bankregels, naar het IBAN en naar het bedrag;
  - twee doorlopen over de inkoopfacturen voor de naam.

## Wat er nu is

### De grens groeit mee

Een ronde loopt tot 70% van de echte tijdgrens van de aanroep
(`statement_timeout`), gemeten vanaf het begin van de aanroep, en hoogstens
25 seconden. Het inlezen zelf telt dus mee.

| Wie | Tijdgrens | Ronde stopt na |
| --- | --- | --- |
| De app (Bankpagina, Gerrie, de API) | 8 s | 5,6 s |
| De bankkoppeling (service-role) | 120 s | 25 s |

De grens geldt voor het hele nalopen, niet alleen voor het boeken.

### Rondes met een cursor

De ronde loopt de bankregels af op een vaste volgorde (boekdatum, id). Stopt
hij op de grens, dan geeft hij `next_cursor` en `remaining` terug.
`match_bank_transactions` heeft daarvoor een nieuwe parameter `p_cursor`: de
volgende ronde gaat ná die bankregel verder.

- **"Opnieuw matchen"** laat de rondes vanzelf lopen tot alles is nagelopen.
  Onderweg staat er "Bezig met matchen: 12.949 van 20.300 transacties
  nagelopen, 87 meteen afgeletterd…".
- **"Afschrift inlezen"** gaat op dezelfde manier verder als het matchen bij
  het inlezen op de grens stopte.
- **Gerrie** (`bank.rematch`) doet hetzelfde.
- Hoogstens 20 rondes per klik. Daarna, of als een ronde niet opschiet, staat
  er hoeveel er nog ligt.
- Elke ronde doet minstens één bankregel, dus elke ronde schiet op.
- "Zeker, maar nog niet geboekt" bestaat niet meer: wat niet is nagelopen,
  komt in de volgende ronde aan de beurt.
- Een tijdstempel per nagelopen bankregel is bewust niet gebruikt: dat zou
  elke ronde duizenden schrijfacties geven, en `updated_at` betekenisloos
  maken.

### Sneller

- **Het rekeningschema** wordt alleen nog ingevoegd als er een code ontbreekt:
  één telling per groep vooraf. Bestaan alle codes al, dan deed "on conflict
  do nothing" toch niets; de uitkomst is dezelfde, alleen het werk is weg. Elke
  bankboeking, verkoopfactuur, inkoopfactuur en memoriaalpost profiteert
  hiervan.
- **Eén keer per ronde, vooraf:**
  - de geboekte verkoopfacturen met een nummer;
  - of er actieve bankregels zijn;
  - de openstaande inkoopbedragen;
  - alle woorden uit de namen van leveranciers met iets openstaand.
- **Per bankregel** wordt alleen nog gezocht waar iets kan passen:
  - geen bankregels in de organisatie: niet zoeken;
  - geen openstaande inkoopfactuur met precies dit bedrag: niet op bedrag
    zoeken;
  - een IBAN dat bij geen leverancier hoort: niet op IBAN zoeken;
  - geen enkel woord van de tegenpartij of omschrijving in een
    leveranciersnaam: geen naamdoorloop. Elke naamtreffer deelt minstens één
    woord, dus dit verandert de uitkomst niet.
- **De naam** als tegenpartij en in de omschrijving gaat in één doorloop in
  plaats van twee, en de namen worden pas genormaliseerd als dat nodig is.

## Gemeten

Lokale database met 4.000 bankregels, 150 leveranciers en 300 openstaande
inkoopfacturen, met tabelstatistieken:

| | 20261118190000 | nu |
| --- | --- | --- |
| Een ronde zonder te boeken | 1,79 s | 0,93 s |
| Eén boeking | ~10 ms | ~5,5 ms |
| 300 betalingen boeken | 2 rondes à 3,4 s | 1 ronde, 3,0 s |
| Een ronde zonder openstaande facturen | 0,3 s | 0,08 s |

Met de echte grens van de app (`statement_timeout = 8s`, als ingelogde
gebruiker), 20.300 bankregels en 300 zekere betalingen:

| Ronde | Tijd | Nagelopen | Geboekt |
| --- | --- | --- | --- |
| 1 | 5,6 s (stopt op de grens) | 12.949 | 87 |
| 2 (met de cursor) | 3,8 s | 7.351 | 213 |
| Een volle ronde daarna | 4,0 s | 20.000 | 0 |

Geen enkele ronde komt aan de 8 seconden. Samen boeken ze alles.

## Database: `20261118200000_bank_matchen_sneller.sql`

- `ensure_default_ledger_accounts`: dezelfde inhoud als 20261118090000, met
  bestaanscontroles vooraf.
- Rijtype `bank_sales_invoice_ref`.
- `bank_purchase_match`: nieuwe parameter `p_name_tokens`, en de namen in één
  doorloop.
- `bank_match_run`: de deadline, de cursor, en de controles vooraf.
  - Voor de databasetest is er een instelling
    (`resofly.bank_match_budget_ms`) die het budget alleen korter kan maken,
    nooit langer.
  - Het opnieuw bepalen van een ingehaald voorstel slaat hij over als de tijd
    op is; een volgende ronde doet het.
- `match_bank_transactions`: parameter `p_cursor` (een kapotte cursor wordt
  geweigerd). De uitkomst heeft nu `processed`, `remaining` en `next_cursor`;
  `auto_book_pending` is weg.
- `import_bank_transactions`: ook `remaining` en `next_cursor`.

Rechten zoals voorheen: alleen `match_bank_transactions` en
`import_bank_transactions` zijn voor ingelogde gebruikers (met Financiën
schrijven), de rest alleen voor de server. Veilig om meermaals te draaien.

## Niet veranderd

- De bankkoppeling (`bank-sync`) doet één ronde per synchronisatie, met 25
  seconden. Dat is genoeg voor tienduizenden bankregels. Wat er dan nog ligt,
  doet de volgende synchronisatie of "Opnieuw matchen".
- Welke betaling bij welke factuur hoort en wanneer iets zeker is: precies
  zoals in 20261118190000.

## Getest

- **Databasetest** `tests/database/bank_inkoop_afletteren.sql`: alle eerdere
  controles, plus nieuwe voor de rondes:
  - met een budget van 0 ms doet elke ronde precies één bankregel;
  - doorgaan met de cursor loopt elke bankregel precies één keer na;
  - de drie zekere betalingen worden geboekt en de koffie blijft open;
  - zonder testbudget doet één ronde alles, zonder cursor;
  - een kapotte cursor wordt geweigerd.

  `npm run test:database`: 4 van 4.
- **Stroomtest** `bank`: 19 stappen, 0 fout. Nieuw in de stap over
  inkoopfacturen: `processed`/`remaining`/`next_cursor` via de REST-laag, een
  kapotte cursor geweigerd, en verder na een geldige cursor.
- **Browser** `ui.mjs bank`: 10 stappen, 0 fout.
- `npm test`: 2.067, waaronder `bankMatch.test.ts`: de zinnen, rondes optellen,
  doorgaan tot er geen cursor meer is, en stoppen na het maximum of zonder
  voortgang.
- `npm run typecheck`.
- **De keten vanaf nul**: `supabase db reset`, 289 migraties. Daarna deze
  migratie nog eens: schoon.
