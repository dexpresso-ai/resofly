# Bank: betalingen vanzelf koppelen aan inkoopfacturen — 18 november 2026

Vraag: "Maak een goed werkende functionaliteit waarbij bankboekingen die
worden ingelezen, ook daadwerkelijk worden gekoppeld aan inkoopfacturen, zodat
boeken en matchen automatisch gaan."

## Wat er misging

1. **Alleen op factuurnummer.** De matcher koppelde een betaling alleen aan een
   inkoopfactuur als het factuurnummer letterlijk in de omschrijving stond. Een
   incasso van KPN, een pinbetaling bij de bouwmarkt of een overboeking met
   "zie factuur" noemt dat nummer bijna nooit. Die bleven allemaal liggen, ook
   als de leverancier aan zijn IBAN te herkennen was en het bedrag tot op de cent
   klopte.
2. **Nooit vanzelf geboekt.** Een gevonden inkoopfactuur werd alleen
   voorgesteld. Wie honderd betalingen inlas, klikte honderd keer op Boeken.
3. **Een factuur na de betaling werd nooit meer gekoppeld.** De matcher keek
   alleen naar transacties met status `unmatched`. Kwam de inkoopfactuur ná de
   betaling binnen (gewoon bij een incasso of een bon), dan bleef de betaling op
   het oude voorstel staan: "leverancier herkend, boek op 4500". Wie dat volgde,
   boekte de kosten twee keer: met de inkoopfactuur én met de bank.
4. **Een bankregel won van een geboekte factuur.** Een regel "KPN → 4500" met
   automatisch boeken boekte de betaling van een geboekte KPN-factuur als
   kosten, en de factuur bleef openstaan.
5. **Terugdraaien hield niet.** Een bankregel met "automatisch boeken" boekte
   een betaling die je net had teruggedraaid bij de volgende import meteen weer.

## Wat er nu gebeurt

### Herkennen

Bij elke matchronde (afschrift inlezen, de bankkoppeling, "Opnieuw matchen",
Gerrie) zoekt ResoFly bij elke openstaande betaling naar een geboekte,
openstaande inkoopfactuur. In deze volgorde:

| Signaal | Voorbeeld | Zeker? |
| --- | --- | --- |
| Factuurnummer, intern nummer of betalingskenmerk (uit een e-factuur) in de omschrijving, en het bedrag klopt | "Factuur 2026-0815", € 968,00 | ja |
| Meerdere nummers, samen precies het bedrag (ook een factuur min een creditnota van de leverancier) | "NB-1001 min creditnota NB-CN-7" | ja |
| IBAN van de leverancier en het bedrag van één openstaande factuur | incasso KPN € 36,30 | ja |
| Naam van de tegenpartij en het bedrag | "HORNBACH BOUWMARKT 123 DEN HAAG" | ja |
| Verzamelbetaling: precies de oudste openstaande facturen van één leverancier samen | € 363 = DZ-1 + DZ-2 | ja |
| Twee facturen van dezelfde leverancier met hetzelfde bedrag (een abonnement) | Cloudly 2× € 12,10 | voorstel: de oudste |
| Nummer genoemd, bedrag lager dan openstaat | "ZT-98765 eerste deel" | voorstel: deelbetaling |
| Nummer genoemd, bedrag hoger | | voorstel: factuur + een regel voor de rest |
| Naam van de leverancier in de omschrijving | "bol.com" via een betaalprovider | voorstel |
| Alleen het bedrag past op precies één factuur | PayPal € 77,77 | voorstel |

Het IBAN van een leverancier komt uit drie bronnen: de stamgegevens, het IBAN op
zijn uitgelezen facturen, en de tegenrekening van betalingen die je eerder aan
hem afletterde. Boek je de eerste betaling aan de glazenwasser met de hand,
dan herkent ResoFly de volgende vanzelf. Hoort een IBAN bij meer dan één
leverancier (een betaalprovider), dan telt het niet; de eigen rekeningen van
de organisatie tellen nooit.

Namen worden vergeleken als hele woorden, zonder rechtsvorm en leestekens:
"KPN B.V." is "kpn", "kpn" past in "kpn mobile" maar "ns" niet in
"nsinternational". In een omschrijving pas vanaf vier tekens.

Waarschuwingen:

- Ging het geld naar het IBAN van een andere leverancier dan het factuurnummer
  of de naam zegt, dan is het een voorstel, met die reden erbij.
- Heeft een leverancier openstaande facturen maar geen met dit bedrag, dan
  blijft het voorstel "zijn kostenrekening", met de waarschuwing dat de kosten
  dan dubbel tellen.

### Boeken

- **Zeker = meteen geboekt**, langs `book_bank_transaction`, dezelfde functie als
  de knop: crediteuren debet bij de leverancier, bank credit, de factuur op
  betaald. Per bankrekening uit te zetten ("Betalingen van inkoopfacturen
  meteen boeken als het zeker is", standaard aan). Uit: alleen voorstellen.
- **De factuur gaat vóór de bankregels.** Een betaling die zeker bij een
  geboekte factuur hoort, boekt nooit meer via een regel als kosten.
- **Lukt boeken niet** (afgesloten periode, andere valuta), dan blijft het een
  voorstel met de reden erbij.
- **Terugdraaien houdt.** Draai je een automatische boeking terug (inkoopfactuur
  of bankregel), dan boekt ResoFly die transactie nooit meer vanzelf; een
  voorstel krijgt hij wel.
- **Veel tegelijk.** Een ronde boekt hoogstens drie seconden lang vanzelf (de
  bankkoppeling tien). Wat daarna nog zeker is, wordt een voorstel met "nog
  niet geboekt: er kwam veel tegelijk binnen"; de volgende ronde boekt verder.
  Zonder die grens liep een eerste import met een jaar aan betalingen tegen de
  8 seconden van PostgREST aan en ging de hele import verloren.

### Een factuur ná de betaling

Boek je een inkoopfactuur, dan zoekt de database meteen de openstaande
betalingen die erbij kunnen horen (zelfde bedrag, IBAN, naam of nummer) en
laat ze opnieuw matchen, met dezelfde regels. Zo wordt de incasso van vorige
week afgeletterd op het moment dat de factuur binnenkomt. Wordt een factuur
tegengeboekt, dan krijgen voorstellen die ernaar wezen een nieuw voorstel.
Het boeken van de factuur loopt hier nooit op stuk.

Ook elke gewone ronde bepaalt bestaande voorstellen opnieuw, en een voorstel
dat in dezelfde ronde is ingehaald (een latere betaling bleek zeker bij die
factuur te horen) wordt aan het eind opnieuw bepaald.

## In het scherm

- **Bank → Af te letteren**: onder elke transactie staat waaróp ResoFly hem
  herkende ("Rekeningnummer van KPN B.V. en het bedrag van inkoopfactuur
  KPN-778899."). Een voorstel op alleen het bedrag staat in grijs.
- **Geboekt**: het label *automatisch*, met "Automatisch geboekt: …".
- **Opnieuw matchen** en **Afschrift inlezen** zeggen wat er gebeurde: "3
  betalingen meteen afgeletterd tegen een inkoopfactuur, 2 transacties hebben
  een voorstel."
- **Verzamelbetaling als voorstel**: de verdeling staat klaar met een regel per
  factuur (`suggested_allocations`), en bij een rest een regel waar je zelf de
  rekening kiest.
- **Rekeningen & koppeling**: per rekening "inkoopfacturen: zeker = meteen
  geboekt" of "alleen voorstellen"; aan- en uitzetten onder Bewerk.
- **Regels**: de uitleg zegt dat inkoopfacturen vóór de regels gaan.
- **Inkoopfacturen**: na Boeken staat er "De betaling stond al op de bank en is
  meteen afgeletterd: de factuur staat op betaald" als dat zo is.

## Gerrie, agents, de MCP-koppeling en de API

- `bank.rematch` zegt in de beschrijving en in het voorstel dat zekere
  betalingen van inkoopfacturen meteen worden geboekt, en krijgt dan de zware
  knop (risico hoog), net als bij bankregels met automatisch boeken. Het
  resultaat is dezelfde zin als op de Bankpagina.
- `purchase_invoice.book` meldt het als een betaling bij het boeken meteen is
  afgeletterd.
- `list_bank_transactions` geeft `match_reason` en `auto_booked` terug.

Alles blijft een voorstel dat een mens goedkeurt (regel 2). Het automatische
boeken is geen AI maar een vaste rekenregel in de database, zoals de bestaande
bankregels; het loopt met de rechten van wie inleest, synchroniseert of de
factuur boekt.

## Database: `20261118190000_bank_inkoop_automatisch_afletteren.sql`

- `bank_transactions`: `match_reason`, `suggested_allocations`, `auto_booked`,
  `auto_book_blocked`. `bank_accounts`: `auto_book_purchase_invoices`
  (standaard aan).
- Rijtype `bank_open_purchase_invoice` en `bank_open_purchase_invoices(org)`:
  de openstaande inkoopfacturen één keer per ronde.
- `bank_supplier_ibans(org)`: IBAN → leverancier.
- `bank_norm_iban`, `bank_name_norm`, `bank_name_matches`.
- `bank_purchase_match(...)`: één transactie tegen de openstaande facturen
  (puur rekenwerk).
- `bank_match_run(...)`: de matchronde; `match_bank_transactions` (zelfde
  handtekening als sinds 20261107110000) controleert de rechten en roept hem
  aan.
- `bank_match_for_purchase_invoice` met de trigger `purchase_invoices_bank_match`
  (na het boeken of tegenboeken van een inkoopfactuur).
- Trigger `bank_transactions_auto_book_guard`: terugdraaien zet
  `auto_book_blocked`.
- `import_bank_transactions` geeft ook terug wat de matcher deed
  (`auto_booked`, `auto_booked_purchase`, `auto_book_pending`, `suggested`,
  `merged`).
- Alle nieuwe functies zijn dicht voor anon en ingelogde gebruikers, op
  `match_bank_transactions` na (die controleert organisatie en Financiën
  schrijven). Alles filtert zelf op `organization_id`.

Veilig om meermaals te draaien.

## Snelheid

Gemeten op een lokale database met 4.000 bankregels, 150 leveranciers en 300
openstaande inkoopfacturen, met tabelstatistieken:

| | tijd |
| --- | --- |
| een ronde zonder te boeken | 1,7 s |
| een ronde die 144 betalingen boekt (budget 3 s) | 3,4 s |
| de volgende ronde (boekt de rest) | 3,0 s |
| een ronde zonder openstaande facturen | 0,3 s |

Twee dingen maakten het eerst traag. De lijst openstaande facturen werd per
bankregel opnieuw uit jsonb uitgepakt (26 s); nu is het een array van een vast
rijtype. En de planner rekende "wat staat er open" uit voor elke combinatie van
factuur en journaalpost (7,9 s voor 300 facturen); nu eerst de geboekte facturen
(materialized), dan per factuur één keer.

## Bewuste grenzen

- Een betaling voor een **concept**-inkoopfactuur wordt niet gekoppeld: boek de
  factuur eerst (dan koppelt hij vanzelf). Een concept is nog niet nagekeken.
- Verkoopfacturen matchen zoals voorheen (op nummer, als voorstel).
- Een verzamelbetaling herkent alleen de *oudste* facturen van één leverancier
  samen, geen willekeurige combinatie.
- Alleen euro's, zoals voorheen.

## Getest

- **Databasetest** `tests/database/bank_inkoop_afletteren.sql` (nieuw, 76
  controles): incasso op IBAN naast een bankregel, pin op naam,
  verzamelbetaling, abonnement, nummer en deelbetaling, alleen bedrag, een
  ingehaald voorstel, factuur min creditnota, eerst de betaling en dan de
  factuur, terugdraaien (ook van een bankregel), automatisch boeken uit, een
  geleerd IBAN via het inlezen, een tegengeboekte factuur, de
  organisatiegrens (zelfde leverancier, IBAN en bedrag in een andere
  organisatie) en wie wat mag. `npm run test:database`: 4 van 4 geslaagd.
- **Stroomtest** `tests/stromen/bank.mjs`: een nieuwe stap met echte gebruikers
  via de REST-laag (inlezen, de reden voor de lezer, met de hand boeken, de
  factuur na de betaling, terugdraaien, de instelling per rekening en wie die
  mag wijzigen, een andere organisatie). 19 stappen, 0 fout.
- **De hele stroomtest** (alle scenario's): 1.230 stappen, 0 fout. Een eerdere
  ronde, terwijl tegelijk de schermtest draaide, gaf twee fouten buiten de bank
  (een API-sleutel en een agendalink, allebei een 500); los herhaald en in deze
  ronde zonder belasting ernaast slaagden ze.
- **Browser** (`tests/stromen/ui.mjs bank`, 10 stappen, 0 fout), met een nieuwe
  stap: een betaling die bij het inlezen meteen geboekt is, met het label
  *automatisch* en de reden; automatisch boeken uit- en aanzetten in het
  bewerkvenster van de rekening; daarna "Opnieuw matchen" met de melding.
- `npm run test:mobile -- --theme=both`: 812 pagina's gemeten, één fout
  (`dark/phone/bon-concept`, het bonvenster, niet aangeraakt); los herhaald:
  de bonpagina's 18 van 18 goed. Bank en Inkoopfacturen: 12 van 12.
- `npm run test:loading`: alle controles geslaagd.
- `npm test`: 2.063 tests, waaronder `bankMatch.test.ts` (nieuw) en drie nieuwe
  in `bankAllocation.test.ts` (het voorstel over meer facturen).
- `npm run typecheck` en `deno check` op alle functies uit de CI (met een
  import map naar npm, omdat esm.sh vanuit de sessie niet bereikbaar was).
- **Migratie**: de hele keten vanaf nul (`supabase db reset`, 288 bestanden),
  daarna deze migratie nog eens: schoon. Precies één versie van elke functie.
