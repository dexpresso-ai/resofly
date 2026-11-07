# Bank: mutaties met de hand boeken — 7 november 2026

Vraag: "Biedt Resofly de mogelijkheid om bankmutaties handmatig te boeken?" Het
antwoord was: ja, wat via een afschrift of de bankkoppeling binnenkomt, en dan
op één factuur of één grootboekrekening. Vijf dingen konden niet. Daarna: "Bouw
stap 1 t/m 5. Zorgvuldig, functioneel sterk en veilig. Deze functies dienen
door te lopen naast het koppelen van de bank zelf."

## Wat niet kon, en wat er misging

1. **Zelf een mutatie invoeren.** Transacties kwamen alleen via een afschrift
   (CAMT.053, MT940, CSV) of de bankkoppeling. Een contante storting, een
   rekening zonder export of een betaling waar je niet op wilt wachten, kon je
   niet boeken.
2. **Eén transactie over meerdere grootboekrekeningen verdelen.** De database
   kon het half (`p_lines`), het scherm en Gerrie stuurden altijd één regel.
3. **Eén betaling tegen meerdere facturen** (een verzamelbetaling, een
   uitbetaling van een betaalprovider). Eén transactie hoorde bij precies één
   factuur.
4. **Een terugbetaling koppelen aan een creditnota.** Een betaling kon alleen
   tegen een inkoopfactuur. Een handmatige terugbetaling aan een klant
   ("Terugbetaling" bij de factuur) maakt een creditnota, maar boekt het geld
   zelf niet ("loopt via de bank en boek je daar"). Op de bank kon je die
   betaling alleen los op een grootboekrekening kwijt, zonder klant en zonder
   de creditnota: de factuur bleef dan een tegoed voor de klant tonen.
5. **Een eigen omschrijving van de boeking.** Het werd altijd
   "Bank …: tegenpartij".

En onder de motorkap: wat er op een factuur openstond, telde **alle**
debiteurenregels van een bankboeking bij de factuur in `matched_invoice_id` op.
Met één factuur per boeking ging dat goed; met een verdeling over drie facturen
zou elke factuur het hele bedrag afgeboekt krijgen. Daarom eerst dat anders.

## Wat er nu kan

### Op de Bankpagina (Af te letteren)

- **Mutatie invoeren** (knop boven de lijst, en per rekening onder
  "Rekeningen & koppeling"). Een venster met rekening, datum, ontvangst of
  betaling, bedrag, tegenpartij, IBAN en omschrijving. Staat er binnen een week
  al een mutatie met hetzelfde bedrag op die rekening, dan vraagt ResoFly eerst
  of het echt een andere is ("Toch invoeren"). De mutatie krijgt het label
  *handmatig*, en een voorstel uit de omschrijving (factuurnummer, bankregel,
  leverancier), maar wordt nooit al geboekt terwijl je kijkt.
  Bewerken en verwijderen kan zolang hij niet geboekt is. Is hij ooit geboekt
  en teruggedraaid, dan blijft hij bewaard (bewaarplicht): negeren kan dan wel.
- **Verdelen.** Elke openstaande transactie heeft een verdeling: één regel
  (zoals vroeger: het hele bedrag op één stuk of rekening) of meer regels die
  samen precies het bedrag dekken. Een regel is een verkoopfactuur, een
  terugbetaling van een creditnota, een inkoopfactuur of een
  grootboekrekening (met btw-code, en bij debiteuren of crediteuren de klant of
  leverancier). Elk stuk in de keuzelijst toont wat er volgens de database nog
  openstaat. Onder de regels: "Nog te verdelen", "Rest op de laatste regel" en
  "Precies verdeeld"; Boeken gaat pas aan als het klopt.
  Bedragen gaan mee met het geld; een negatief bedrag is de andere kant op
  (kosten die van een uitbetaling zijn afgehouden, een creditnota van een
  leverancier die met de betaling is verrekend).
- **Voorstel voor meerdere facturen.** Noemt de omschrijving twee of meer
  openstaande facturen, dan staat er een regel per factuur met zijn openstaande
  bedrag klaar, en de rest op een grootboekregel.
- **Eigen omschrijving** van de boeking (en per regel, bij een verdeling).
- **Geboekt**: de verdeling met factuurnummers en bedragen, en de omschrijving.
  Terugdraaien zet álle facturen uit de verdeling terug op verzonden of
  achterstallig, en inkoopfacturen terug op onbetaald.

### Naast de bankkoppeling

Komt een mutatie die je zelf invoerde later toch van de bank (een afschrift of
de koppeling), dan voegt ResoFly de twee samen: de bankregel krijgt de status
*samengevoegd* en verwijst naar jouw mutatie, die de boeking draagt. Het geld
staat er één keer. Dat gebeurt vóór het matchen, dus ook een bankregel met
"automatisch boeken" boekt hem niet nog eens.

- Vanzelf alleen bij één duidelijke kandidaat: zelfde rekening en bedrag,
  binnen 7 dagen, en geen ander IBAN. Twee keer € 50 aan dezelfde partij in één
  week laat ResoFly aan jou.
- Anders staat bij de bankregel: "Lijkt op je handmatige mutatie van …", met
  de knop **Samenvoegen**.
- Bij de handmatige mutatie staat *bevestigd door bank* en wat de bank erbij
  schreef, met **Losmaken**. Na losmaken voegt de matcher die bankregel niet
  meer vanzelf samen.
- Was je mutatie nog niet geboekt, dan neemt hij bij samenvoegen de datum van
  de bank over; die boek je.

### De aansluiting

Een handmatige mutatie staat op geen afschrift. Daarom:

- telt hij niet mee in de afschriftcontrole, de vermoedelijke dubbelen en
  "nog te boeken";
- telt een samengevoegd paar één keer;
- valt de handmatige boeking aan de andere kant van de peildatum dan de
  bankregel, dan staat dat er als *datumverschil handmatig/bank* (geen fout);
- een geboekte handmatige mutatie die de bank niet bevestigde en vóór de
  peildatum valt, verklaart het verschil: dat staat erbij, met wat je kunt
  nagaan.

### Gerrie, agents, de MCP-koppeling en de API

Alles blijft een voorstel; een mens keurt goed en het loopt dan langs dezelfde
weg als de knop.

- `bank_transaction.book`: nieuw `mode: split` met `allocations` (soort,
  stuk of rekening, bedrag, omschrijving) en `description`.
- Nieuw: `bank_transaction.create_manual` (weigert bij een vermoedelijke
  dubbele, tenzij de gebruiker bevestigde dat het een andere is),
  `bank_transaction.update_manual`, `bank_transaction.delete_manual`,
  `bank_transaction.merge`, `bank_transaction.unmerge`, en de leesactie
  `bank_transaction.candidates` (wat er per stuk openstaat).
- `list_bank_transactions` meldt `is_manual` en `merged_into_id`; met
  `unreconciled_only` tellen samengevoegde en genegeerde regels niet meer als
  "nog te verwerken".

## Database: `20261107100000_bank_handmatig_boeken.sql`

- `bank_transactions`: `is_manual`, `created_by`, `merged_into_id`,
  `merged_at`, `merged_by`, `auto_merge_blocked`, status `merged`. Een
  bankregel kan alleen samengaan met een handmatige mutatie van dezelfde
  rekening en met hetzelfde bedrag (constraint en trigger), en zo'n paar
  verandert niet stil van bedrag of rekening. Wie invoerde, samenvoegde of
  boekte, is wie er ingelogd was (`stamp_actor_columns`).
- `bank_transaction_allocations`: de verdeling van elke boeking (bedrag in
  bankrichting). Ligt vast: geen schrijfrecht, en een trigger weigert
  wijzigen. Lezen met Financiën (restrictive RLS). Bestaande boekingen op een
  factuur of inkoopfactuur zijn erin overgezet.
- Rekenen uit de verdeling: `invoice_open_receivable_cents`,
  `purchase_invoice_open_payable_cents`,
  `refresh_purchase_invoice_payment_status` (ook een creditnota van een
  leverancier gaat nu op betaald), `report_open_items` (met de datum van boeking
  en tegenboeking), en `reverse_journal_entry` (een betaalde inkoopfactuur boek
  je niet los tegen, ook niet bij een verzamelbetaling).
- `book_bank_transaction`: nieuwe parameters `p_allocations` en
  `p_description`. De oude manieren werken zoals voorheen. Nieuw is dat de
  regels precies op het bedrag moeten uitkomen; eerder boekte de journaalpost
  een verschil van een paar cent stil op 4900. Per regel: het stuk hoort bij
  deze organisatie, staat in het grootboek en is niet tegengeboekt; niet meer
  dan er openstaat; de kant van het geld klopt; een rekening is actief en niet
  de bankrekening zelf; een klant, leverancier of project hoort bij deze
  organisatie. De btw wordt per regel gesplitst (ook verlegd).
- `unbook_bank_transaction`: alle facturen en inkoopfacturen uit de verdeling.
- Nieuw: `create_manual_bank_transaction`, `update_manual_bank_transaction`,
  `delete_manual_bank_transaction`, `merge_bank_transactions`,
  `unmerge_bank_transaction`, `bank_allocation_candidates`, en voor intern
  gebruik `merge_manual_bank_transactions`, `bank_merge_pair`,
  `bank_manual_input_check`, `bank_parse_uuid`, `bank_eur`.
- `match_bank_transactions`: eerst samenvoegen; nieuwe parameters
  `p_transaction_id` en `p_auto_book`.
- `import_bank_transactions`: de afschriftcontrole telt alleen wat van de bank
  komt.
- `report_bank_reconciliation`: zie "De aansluiting".
- Auditlog: soort `bank_transaction` (invoeren, bewerken, verwijderen,
  samenvoegen, losmaken), ingedeeld bij Financiën (`audit_entity_module` en
  `AUDIT_ENTITY_MODULE`).
- Elke functie dicht voor anon; wat de app aanroept voor ingelogde gebruikers,
  de interne hulpjes alleen voor de server. Elke openbare functie controleert
  zelf de organisatie en het modulerecht (Financiën schrijven, of lezen voor de
  kandidaten).

Veilig om meermaals te draaien.

## Bewuste grenzen

- Samenvoegen vraagt hetzelfde bedrag en dezelfde rekening. Klopt het bedrag
  van je mutatie niet, pas hem dan eerst aan.
- Een verkoopfactuur hoort bij geld dat binnenkomt, een creditnota bij geld dat
  weggaat. Een terugbetaling van een te veel betaald bedrag zonder creditnota
  boek je op debiteuren met de klant erbij.
- Een creditnota terugbetalen kan tot wat de klant op die factuur tegoed heeft:
  is de creditnota verrekend met wat er nog openstond, dan valt er niets terug
  te betalen.
- Alleen euro's, zoals voorheen.
- Boekingen van vóór deze migratie op een grootboekrekening krijgen geen
  verdeling; het scherm toont hun journaalregels.
- De matcher stelt per transactie één factuur voor; meerdere facturen vult het
  verdeelscherm aan uit de omschrijving.

## Getest

- **Stroomtest** `tests/stromen/bank.mjs` (nieuw, 18 stappen) tegen een lokale
  stack met echte gebruikers en rechten: invoeren en de vraag bij een dubbele;
  wie niet mag (lezer, kijker, zonder Financiën, een andere organisatie, de
  bankrekening van een ander); kapotte invoer; bewerken en verwijderen (en dat
  een bankregel dat niet kan); een verdeling die niet klopt, te veel op een
  factuur, twee keer dezelfde factuur; een verzamelbetaling over twee facturen
  plus omzet met btw en een eigen omschrijving (journaal, debiteuren met klant,
  facturen betaald, openstaande posten); terugdraaien en opnieuw boeken;
  dezelfde mutatie van de bank met een automatisch boekende bankregel erbij
  (samengevoegd, niets dubbel op 1100); losmaken, niet opnieuw vanzelf
  samengevoegd, met de hand weer samen; een terugbetaling via
  "Terugbetaling" bij de factuur (creditnota) en de bankbetaling ertegen;
  een betaling over twee inkoopfacturen min een creditnota van de leverancier
  (betaalstatus, tegenboeken geweigerd, terugdraaien); een uitbetaling met een
  negatieve kostenregel; de rechten op de verdeling en de kandidaten; de
  aansluiting met een afschrift.
- **De hele stroomtest** (alle scenario's): 638 stappen, 0 fout. Daarin ook
  facturen, herinneringen, Mollie en beveiliging, die de oude manier van
  afletteren gebruiken.
- **Browser** (`tests/stromen/ui.mjs bank`, nieuw): de knop Mutatie invoeren,
  de voorgestelde verdeling over twee facturen aanvullen en boeken met een
  eigen omschrijving, de geboekte weergave, terugdraaien, de vraag bij een
  dubbele, samengevoegd/losmaken/samenvoegen, en de verdeling op telefoon,
  liggende telefoon en tablet in licht en donker zonder zijwaarts scrollen.
- `npm test`: 1191 tests, waaronder `src/lib/bankAllocation.test.ts` (nieuw,
  13): voorstellen, optellen, tekens, regels toevoegen en weghalen, de
  kandidaten voor samenvoegen. Ook de bewaking van de registry (uitvoerder per
  handeling, organisatiegrens, kolommen, zoeken met acht nieuwe vragen), de
  auditindeling en de rechten in de migraties.
- `npm run typecheck`, `npm run build`, `npm run test:loading` (alle controles
  geslaagd; de groep bank heeft nu zes tabellen) en `deno check` op de 34
  functies uit de CI (met een import map naar npm, omdat esm.sh vanuit de
  sessie niet bereikbaar was).
- **Migratie**: twee keer na elkaar op de lokale database (veilig opnieuw te
  draaien); de hele keten vanaf nul met `supabase db reset` (251 van 251
  bestanden toegepast). Elke vervangen functie naast zijn vorige versie
  gelegd: alleen de bedoelde verschillen. Dezelfde controle als de rooktest:
  anon heeft in public nergens rechten. Staging stond op 20261106173000, met
  3.620 open en geen geboekte banktransacties: de overzetting van bestaande
  boekingen doet daar niets.
- `npm run test:mobile -- --theme=both`: 344 pagina's gemeten, 0 met
  problemen. De nagebootste backend van die test heeft geen rekeningschema, dus
  de Bankpagina toont daar de lege stand; het verdeelscherm zelf zit in de
  browsertest hierboven (drie formaten, licht en donker).
