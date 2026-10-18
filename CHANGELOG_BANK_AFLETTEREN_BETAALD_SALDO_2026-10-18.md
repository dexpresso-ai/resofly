# Bank — afletteren zet de factuur op betaald, één definitie van "betaald", en het banksaldo (2026-10-18)

## Wat & waarom
De koppeling met Enable Banking haalt transacties binnen en de boekingsmotor maakt er
sluitende journaalposten van, maar het laatste stuk liep niet rond: een factuur die per
overboeking werd betaald bleef open staan, Mollie-betalingen telden niet mee als betaald,
pending-transacties kwamen binnen als echte, en een gekoppelde rekening had geen saldo om
op aan te sluiten. Bron: `ENABLEBANKING_BOEKINGEN_ONDERZOEK_2026-10-18.md` §6, blok 1 + 2.1.

Migratie: `supabase/migrations/20261018000000_bank_afletteren_betaald_saldo.sql` (na een
tegenlezing aangevuld, zie "Na de review"; nog nergens uitgerold).

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
heeft (of geen status, zoals sommige banken doen). Wat later nog geboekt binnenkomt
(`PDNG`, `SCHD`, `HOLD`) staat als "in behandeling" in de syncmelding; geweigerd of
geannuleerd (`RJCT`, `CNCL`) telt nergens mee, daar ging geen geld over. Een status die we
niet kennen (`OTHR` of iets nieuws) komt niet binnen maar wordt wel gemeld, zodat een bank
die geboekte posten zo noemt niet stil wegvalt.

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
peildatum, of een beginsaldo (`OPBD`) als eindsaldo van de dag ervoor. Heeft een
tussensaldo geen peildatum, dan telt de dag in Nederland van de laatste wijziging (de bank
geeft UTC; vlak voor middernacht is dat anders de vorige dag). Beschikbare en
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

## Na de review
Een tegenlezer heeft de eerste versie aangevallen (met een eigen kopie van de database en
twee gelijktijdige sessies). Wat dat opleverde, en wat er nu anders is:

1. **De matcher kon een net geboekte transactie overschrijven.** Liep "Opnieuw matchen" of
   een sync terwijl iemand boekte, dan zette de matcher de rij terug op `suggested` — met
   boekstuk en al. De factuur stond dan op betaald met € 100 open, en terugdraaien én
   opnieuw boeken werden allebei geweigerd. Nu vergrendelt de matcher elke rij en slaat hij
   een rij over die intussen is geboekt of die iemand op dat moment boekt.
2. **De afletterkeuze verborg facturen die nog openstonden.** Een factuur die met de hand op
   betaald is gezet (dat boekt niets), staat in het grootboek nog volledig open — maar was
   niet meer te kiezen. De keuze kijkt nu naar het openstaande bedrag uit het grootboek
   (dezelfde berekening als de boeking zelf), niet naar de status, en toont bij een
   deelbetaling wat er nog openstaat. Lukt het ophalen niet, dan staan alle geboekte
   facturen erin, zoals vroeger.
3. **De volgorde van creditnota en betaling maakte uit.** Eerst € 30 per bank en dan € 70
   gecrediteerd liet de factuur op `overdue` staan — herinneringen en aanmaningen liepen
   door — terwijl andersom wel op betaald ging. Nu geldt in beide volgordes dezelfde regel:
   niets meer open én er is echt betaald. Een creditnota boeken werkt de status ook bij.
   Alleen gecrediteerd blijft onbetaald.
4. **De bankkoppeling op de factuur** (`paid_bank_transaction_id`) kon door de client
   worden gezet, ook naar een transactie van een andere organisatie, en bleef staan als
   iemand de status met de hand wijzigde — waarna terugdraaien die handmatige status
   overschreef. Nu zet alleen het afletteren hem, altijd binnen de eigen organisatie; wie de
   status met de hand wijzigt, neemt het over van de bank.
5. **Terugbetalingen en terugboekingen via Mollie stonden niet in het grootboek.** Zodra
   "betaald" de Mollie-betalingen meetelt, telt dat mee: een teruggeboekte betaling gold als
   voldaan (een latere overboeking van de klant werd geweigerd), en een terugbetaling met
   creditnota liet een tegoed van de klant zien. Beide worden nu geboekt als 1300 aan 1102
   (het spiegelbeeld van de betaling), automatisch bij de Mollie-melding; een teruggedraaide
   terugboeking wordt tegengeboekt. Alleen als de betaling zelf in het grootboek staat.
6. **Betaald via de bank liet minder sporen na dan via Mollie.** Nu ook een regel in de
   tijdlijn (de klant ziet "Betaald"), een auditregel, een versie en de vergrendeling. Wordt
   de bankbetaling teruggedraaid, dan komt er een interne tijdlijnregel bij en verdwijnt
   "Betaald" weer uit de tijdlijn die de klant ziet.
7. **De eenmalige bijwerking bij de migratie** stuurde voor elke oude factuur de push
   "Factuur betaald" en de webhook `invoice.paid`. Die staan tijdens het bijwerken nu uit;
   tijdlijn en audit krijgen hun regel wel.
8. **Enable Banking**: de statussen en de saldodatum zoals bij 1.3 en 2.1 hierboven.
9. **Vergrendeling**: terugdraaien vergrendelt de factuur vóór de tegenboeking, en de
   statusfuncties lezen de factuur met een lock. De tegenboeking krijgt de datum van
   vandaag; viel die in een ander jaar dan de boeking, dan hield de boekstuk-lock (per jaar)
   die twee niet uit elkaar. Een creditnota boeken vergrendelt de factuur nu ook vóór het
   boekstuk, in dezelfde volgorde als een bankboeking.

En de matcher stelt geen factuur meer voor als de ontvangst groter is dan wat er openstaat:
die boeking mislukte altijd. Eén overboeking voor meerdere facturen vraagt om splitsen
(blok 3).

## Front-end
- `src/features/Bank.tsx`: de afletterkeuze volgt het openstaande bedrag uit het grootboek
  (zie hierboven; de huidige match blijft altijd zichtbaar); het aansluitpaneel en de
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
- **Na de review** nog 8 scenario's, ook als eigenaar via de echte RPC's: creditnota en
  bank in beide volgordes; de bankkoppeling (handmatig gaat voor, zelf aanwijzen en een
  andere organisatie geweigerd, een kopie is niet betaald); Mollie-terugboeking (geboekt,
  weer open, per bank te betalen, herhaalde melding niet dubbel, terugdraaien) en
  -terugbetaling (met creditnota open 0, niet in de open posten, 1102 netto 0); tijdlijn,
  audit, versie en vergrendeling; geen voorstel boven het openstaande saldo; de backfill
  zonder push en webhook (en met beide triggers daarna weer aan).
- **Race met twee sessies**: sessie 1 boekt en houdt de transactie 4 s open, sessie 2 draait
  de matcher. Oude versie: transactie `suggested` mét boekstuk, factuur betaald met € 100
  open. Nieuwe versie: de matcher slaat de rij over (12 ms), transactie geboekt, open € 0.
- **Snelheid** na de review: `match_bank_transactions` 3,1 s voor 1.000 open transacties
  (de lock per rij kost niets meetbaars), `report_open_items` 0,27 s.
- `npm test`: alles groen, met nieuwe tests voor `enableBanking.ts` (statussen, de dag in
  Nederland, en een controle dat `bank-sync` ze gebruikt) en voor de tijdlijn van de klant;
  `npm run typecheck` ✓; `npm run build` ✓; `bank-sync` los gecontroleerd met esbuild
  (Deno niet lokaal).
- **Scherm** na de review: de keuze toont een met de hand op betaald gezette factuur die in
  het grootboek openstaat, verbergt echt voldane facturen, toont "open € …" bij een
  deelbetaling, en valt terug op alle geboekte facturen als de open posten niet laden.
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

Bij de migratie worden bestaande afletteringen bijgewerkt en worden bestaande
Mollie-terugbetalingen en -terugboekingen alsnog geboekt (alleen waar de betaling zelf in het
grootboek staat). Push en webhook staan daarbij uit: een factuur die zo op betaald gaat,
levert geen "Factuur betaald" en geen `invoice.paid` op. Op staging gebeurt er niets: er
zijn geen geboekte banktransacties en geen geboekte Mollie-betalingen (wel 4 terugbetalingen,
maar zonder geboekte betaling).

## Bewust buiten dit blok
Uit het bouwplan nog open: automatische sync (2.2), verloop van de toestemming zichtbaar
maken (2.3), een eigen grootboekrekening per gekoppelde rekening en interne overboekingen
(2.4), foutafhandeling en de stille paginalimiet (2.5), splitsen, Mollie-uitbetalingen,
regels en betere herkenning (blok 3), ontkoppelen en live gaan (blok 4).

Ook nog open, gevonden bij de review:
- Een **handmatige terugbetaling** (via de bank, niet via Mollie) is niet tegen de factuur
  af te letteren; de bankboeking gaat via een grootboekrekening.
- Na een **Mollie-terugboeking** blijft een factuur die Mollie op betaald zette op betaald
  staan (zo was het al); in het grootboek en de open posten staat hij wel weer open. Alleen
  een factuur die de bank op betaald zette, gaat terug naar open.
- De **kosten** van een terugboeking zitten niet in deze boeking; die horen bij de
  aansluiting van de Mollie-uitbetalingen (blok 3).
