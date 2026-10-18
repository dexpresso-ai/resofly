# Bank — afletteren zet de factuur op betaald, één definitie van "betaald", en het banksaldo (2026-10-18)

## Wat & waarom
De koppeling met Enable Banking haalt transacties binnen en de boekingsmotor maakt er
sluitende journaalposten van, maar het laatste stuk liep niet rond: een factuur die per
overboeking werd betaald bleef open staan, Mollie-betalingen telden niet mee als betaald,
pending-transacties kwamen binnen als echte, en een gekoppelde rekening had geen saldo om
op aan te sluiten. Bron: `ENABLEBANKING_BOEKINGEN_ONDERZOEK_2026-10-18.md` §6, blok 1 + 2.1.

Migratie: `supabase/migrations/20261018000000_bank_afletteren_betaald_saldo.sql`.

## 1.1 — Afletteren zet de factuur op betaald
`book_bank_transaction` werkte alleen de banktransactie bij. De factuur bleef `sent` of
`overdue`, en herinneringen selecteren op `status = 'overdue'` — een klant die per
overboeking betaalde, kreeg dus gewoon de herinnering en daarna de aanmaning.

Nu:
- **Verkoop**: staat er na de bankboeking niets meer open, dan gaat de factuur op `paid`,
  met `paid_at` = boekdatum en `paid_bank_transaction_id` = de transactie. Herinneringen
  stoppen, en een klaargezette aanmaning wordt niet meer verstuurd (`begin_dunning_send`
  weigert een betaalde factuur). De push "Factuur betaald" en de webhook `invoice.paid`
  gaan mee, net als bij een Mollie-betaling.
- **Deelbetaling**: de status blijft staan tot het laatste bedrag binnen is.
- **Terugdraaien**: zette de bank de factuur op betaald en staat er weer iets open, dan gaat
  hij terug naar `sent` (of `overdue` als de vervaldatum voorbij is). Een factuur die
  handmatig of via Mollie op betaald staat, blijft ongemoeid.
- **Creditnota**: een factuur die door een creditnota op nul staat, is niet "betaald" — de
  status gaat alleen op betaald direct na een bankbetaling.
- **Inkoop**: `payment_status` (`unpaid` / `partially_paid` / `paid`) en `status`
  (`booked` / `paid`) worden uit het grootboek afgeleid. Ze stonden sinds het aanmaken
  voor altijd op `unpaid`, en omdat Gerrie daarop rekent, noemde hij elke betaalde
  inkoopfactuur onbetaald en na de vervaldatum "te laat".
- **Bestaande afletteringen** worden bij de migratie één keer bijgewerkt.

Gerrie's handeling `invoice.reconcile_bank_transaction` beloofde "de factuur gaat op
betaald" terwijl dat niet gebeurde; die belofte klopt nu (en de tekst zegt erbij dat het
bij een deelbetaling niet zo is).

## 1.2 — Eén definitie van "betaald"
Nieuw: `invoice_settlement(org, factuur, peildatum)` en `purchase_invoice_settlement(…)`.
Per factuur uit het grootboek: geboekt − betaald − gecrediteerd. Betaald telt nu ook de
**Mollie-betalingen**: `book_invoice_payment` boekt met de factuur zelf als bron, en de
oude afletter-check en de openstaande-postenlijst telden alleen betalingen via een
banktransactie.

De oude fout, concreet: een factuur van € 500 die via Mollie was betaald, stond in de
openstaande posten als € 500 open, met € −500 "niet toe te rekenen" — en een
bankontvangst met het factuurnummer werd voorgesteld en kon worden afgeletterd, waarmee
Debiteuren negatief werd.

Dezelfde functie wordt nu gebruikt door:
- `book_bank_transaction` — de begrenzing op het openstaande saldo;
- `match_bank_transactions` — geen voorstel meer voor een betaalde factuur (die boeking
  faalde gegarandeerd), en bij meerdere kandidaten gaat de factuur waarvan het
  **openstaande** bedrag klopt voor (bij een restbetaling is dat iets anders dan het
  factuurtotaal);
- `report_open_items` — uitvoer ongewijzigd.

## 1.3 — Pending-transacties overslaan
Enable Banking levert ook nog niet geboekte transacties mee (`status: "PDNG"`). Die
hebben vaak nog geen boekdatum en later een andere omschrijving, dus de geboekte versie gaf
op inhoud een tweede rij — twee keer boekbaar. Nu komt alleen binnen wat de status `BOOK`
heeft (of geen status, zoals sommige banken doen). Het aantal overgeslagen pending-posten
staat in de syncmelding.

## 1.4 — Teken zonder indicator
Zonder `credit_debit_indicator` werd elk bedrag een ontvangst. Nu volgt het teken dan het
bedrag zelf; met indicator wordt een al negatief bedrag niet dubbel omgedraaid.

## 1.5 — Afronden van een koppeling is idempotent
Werd dezelfde terugkeer-URL nog eens geopend, dan faalde de tweede code-inwisseling en ging
een werkende koppeling op `error`. Een al gekoppelde requisition wordt nu niet opnieuw
afgerond, en een mislukte poging verlaagt alleen een koppeling die nog niet af was.

De mapping staat nu in `supabase/functions/_shared/enableBanking.ts` (pure functies, met
tests); `bank-sync` gebruikt die en heeft geen eigen mapping meer.

## 2.1 — Het banksaldo bij elke synchronisatie
`report_bank_reconciliation` zoekt het laatste eindsaldo, en dat bestond alleen voor
CAMT/MT940-imports. Een gekoppelde rekening had nooit een saldo, waardoor de
aansluitcontrole juist daar niet werkte en het paneel aanraadde om toch weer afschriften
in te lezen.

Nu haalt `bank-sync` bij elke synchronisatie `GET /accounts/{uid}/balances` op en kiest een
**geboekt** saldo: het eindsaldo (`CLBD`/`PRCD`) of tussensaldo (`ITBD`) met zijn
peildatum, of een beginsaldo (`OPBD`) als eindsaldo van de dag ervoor. Beschikbare en
verwachte saldi (`CLAV`/`ITAV`/`XPCD`) tellen niet: die nemen de kredietlimiet of de
pending-posten mee en sluiten dus nooit aan op geboekte transacties. Het saldo wordt
vastgelegd met de nieuwe RPC **`record_bank_balance`**: één rij per rekening per peildatum,
bijgewerkt bij herhaald synchroniseren. Levert de bank geen geboekt saldo, dan blijft de
sync gewoon geslaagd.

In het scherm heet het voor een gekoppelde rekening "Saldo volgens de bank", en de
syncmelding noemt het saldo met zijn datum.

Let op: delen meerdere bankrekeningen dezelfde grootboekrekening (op staging staan er per
organisatie vier op 1100), dan kan het paneel ook met saldo niet per rekening aansluiten
en legt het uit waarom. Een eigen grootboekrekening per gekoppelde rekening is blok 2.4.

## Front-end
- `src/features/Bank.tsx`: de afletterkeuze biedt geen betaalde facturen meer aan (de
  server weigert die nu; de huidige match blijft wel zichtbaar); het aansluitpaneel en de
  syncmelding zoals hierboven; "Deze koppeling was al afgerond."
- `src/types.ts` (`paid_bank_transaction_id`), `src/lib/repository.ts` (`BankSyncResult`).
- Gerrie: de teksten van `invoice.reconcile_bank_transaction`, `bank_transaction.book` en
  `bank_account.sync` zeggen nu wat er gebeurt.

## Verificatie
- **Lokale kopie van de database**: Postgres 16 met een nagebootst Supabase-auth-schema,
  het basisschema en alle 192 migraties daarna. De 18 functies waar dit op leunt zijn gelijk
  aan staging (hash van de definitie, alleen-lezen vergeleken).
- **13 SQL-scenario's groen**, als eigenaar van een testorganisatie via de echte RPC's:
  volledige betaling → betaald → terugdraaien → opnieuw boeken; deelbetalingen, te hoge
  betaling en een eerdere termijn terugdraaien; Mollie (open 0, geen voorstel, geen dubbele
  aflettering, niet in de open posten); creditnota (rest betaald → betaald, volledig
  gecrediteerd blijft onbetaald); handmatig betaald blijft staan; inkoop deels/volledig/
  terugdraaien; vrije boeking ongewijzigd; saldo vastleggen, bijwerken en aansluiten;
  rechten (andere organisatie geweigerd, sync-functies niet rechtstreeks aanroepbaar, RLS
  op de settlement-functie); backfill; matchervolgorde (openstaand bedrag gaat voor
  totaal).
- **Regressie** `report_open_items`: oude en nieuwe versie geven op dezelfde data dezelfde
  rijen, op de via Mollie betaalde factuur na (de fout).
- **Snelheid** (3.000 facturen, 2.000 betalingen, 1.000 open transacties):
  `report_open_items` 251 ms (was 511 ms), `match_bank_transactions` 3,1 s (was 2,4 s),
  één factuur doorrekenen ± 1 ms.
- Migratie twee keer toepassen slaagt.
- **Scherm**: de Bankpagina gerenderd tegen de mock uit `tests/mobile` (aangevuld met
  grootboek-, bank- en factuurdata), op desktop en telefoon: betaalde facturen niet in de
  keuze, de huidige match wel, aansluitpaneel met "Saldo volgens de bank", syncmelding met
  saldo en pending, geen JS-fouten, geen horizontale overloop.
- `npm test`: 821/821 groen, waarvan 14 nieuw voor `enableBanking.ts` (incl. een controle
  dat `bank-sync` ze gebruikt); `npm run typecheck` ✓; `npm run build` ✓; `bank-sync` los
  gecontroleerd met esbuild (Deno niet lokaal).
- **Niet getest**: de echte Enable Banking-API — die is vanuit de bouwomgeving niet
  bereikbaar. De `/balances`-respons van de sandbox dus bij de uitrol controleren.

## Deploy (staging)
1. `supabase db push --linked` — migratie `20261018000000`. **Eerst**, want de nieuwe
   `bank-sync` roept `record_bank_balance` aan. Andersom gaat er niets stuk: dan faalt
   alleen het vastleggen van het saldo (gelogd), de sync zelf werkt.
2. `supabase functions deploy bank-sync --project-ref enzghpduqwaojcxgwarr`.
3. Branch naar `staging` → Cloudflare Pages bouwt de front-end.
4. Rooktest: de sandbox-toestemming van 26-06 is op 24-09 verlopen, dus eerst opnieuw
   koppelen; dan synchroniseren → de melding noemt het saldo, het aansluitpaneel toont het.

Bij de migratie worden bestaande afletteringen bijgewerkt. Gaat daardoor een factuur op
betaald, dan krijgen teamleden de push "Factuur betaald" en gaat de webhook `invoice.paid`
uit. Op staging zijn er geen geboekte banktransacties, dus daar gebeurt niets.

## Bewust buiten dit blok
Uit het bouwplan nog open: automatische sync (2.2), verloop van de toestemming zichtbaar
maken (2.3), een eigen grootboekrekening per gekoppelde rekening en interne overboekingen
(2.4), foutafhandeling en de stille paginalimiet (2.5), splitsen, Mollie-uitbetalingen,
regels en betere herkenning (blok 3), ontkoppelen en live gaan (blok 4).
