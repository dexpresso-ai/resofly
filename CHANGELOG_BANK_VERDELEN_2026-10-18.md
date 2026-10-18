# Bank — één overboeking verdelen over meerdere facturen (2026-10-18)

## Wat & waarom
Een klant die drie facturen in één keer betaalt, een batchbetaling aan een leverancier, een
ontvangst die deels een factuur is en deels iets anders: een banktransactie kon maar op één
factuur, of op grootboekregels. Punt 1 uit `BANK_VERVOLG_2026-10-18.md`.

Migratie: `supabase/migrations/20261018020000_bank_verdelen.sql` (bouwt voort op
`20261018000000` en `20261018010000`; alle drie nog nergens uitgerold).

## Hoe het werkt
- In "Af te letteren" staat naast Verkoopfactuur (of Inkoopfactuur) en Grootboekrekening nu
  **Verdelen**. Per regel een verkoopfactuur, een inkoopfactuur of een grootboekrekening (met
  btw), en een bedrag. Onderaan staat "Nog te verdelen: € …" tot het precies klopt; pas dan kan
  Boeken. "+ Regel" vult de rest al in, en een gekozen factuur krijgt wat er openstaat.
- Per factuur niet meer dan er openstaat; de keuzelijst toont per factuur wat er open staat (of
  het tegoed). Een melding staat bij de regel zelf.
- In de richting van het geld: een ontvangst op verkoopfacturen met iets open, een betaling op
  inkoopfacturen met iets open. En terugbetalen: een betaling op een verkoopfactuur waar de klant
  tegoed heeft, een ontvangst op een inkoopfactuur waar jij tegoed hebt.
- Het blijft één boekstuk: de bank tegen één debiteuren- of crediteurenregel per factuur (met de
  klant of leverancier erop), plus de grootboekregels met btw zoals bij een vrije boeking.
- Elke factuur volgt zijn eigen deel: voldaan is betaald (met tijdlijnregel, audit, versie en
  vergrendeling, zoals bij één factuur), anders deels betaald.
- Terugdraaien zet alle facturen van de verdeling terug. De verdeling blijft als geschiedenis
  staan; de tegenboeking telt haar terug.
- Na het boeken staat bij de transactie waarover hij verdeeld is, bijvoorbeeld "Verdeeld:
  2026-038 € 60,00 · 2026-037 € 40,00 · grootboek € 20,00".

## De matcher stelt een verdeling voor
- Noemt de omschrijving meerdere factuurnummers en zijn hun openstaande bedragen samen precies
  het bedrag, dan zet de matcher een verdeling klaar (`bank_transactions.suggested_allocations`,
  `match_confidence` `invoices` of `purchase_invoices`). Het scherm opent dan in Verdelen, met
  een uitleg. Ook voor een batch aan een leverancier.
- Alleen bij een exacte som: bij minder valt niet te zeggen welke factuur (deels) betaald is.
- Een nummer dat binnen een ander genoemd nummer valt ("2026-1" in "2026-10") telt niet mee —
  nu ook niet bij het voorstel van één factuur.
- Eén zoekronde voor beide voorstellen: anders zocht de matcher de facturen twee keer op.

## In de database
1. **`bank_transaction_allocations`**: welk deel van een geboekte transactie op welke factuur
   ging, met het boekstuk erbij. Alleen `book_bank_transaction` schrijft; lezen per organisatie
   en alleen met toegang tot Financiën (module gate, ook voor de boekhouder).
2. **`invoice_settlement` en `purchase_invoice_settlement`** tellen de delen mee zolang het
   boekstuk staat; de tegenboeking telt het deel terug op haar eigen datum. Een eerdere verdeling
   van een transactie die nu op één factuur staat, telt alleen via haar delen. Zo sluiten de
   openstaande posten op elke peildatum aan op 1300 en 1600.
3. **`book_bank_transaction(…, p_allocations)`**. Geweigerd, met een melding: een totaal dat niet
   precies klopt ("nog € … te verdelen"), meer dan er openstaat, dezelfde factuur twee keer, een
   regel zonder of met twee facturen, een bedrag dat geen hele centen boven nul is, een
   verdeling samen met "één factuur", een losse regel op Debiteuren of Crediteuren (die horen
   bij een factuur), een factuur die niet bestaat of niet in het grootboek staat, en de verkeerde
   richting (een betaling op een factuur zonder tegoed). Eerst de vorm van alle regels, dan per
   factuur: dezelfde invoer geeft altijd dezelfde melding. Meer dan één grootboekregel zonder
   factuur moet ook precies kloppen; één regel blijft zoals hij was.
   De facturen worden in een vaste volgorde vergrendeld: twee verdelingen over dezelfde facturen
   wachten op elkaar, en de tweede ziet wat de eerste boekte.
   De oude versie met zes parameters gaat weg: twee versies naast elkaar maken een aanroep
   dubbelzinnig voor PostgREST. Bestaande aanroepen (het scherm, Gerrie, automatisch boeken met
   een regel) blijven werken.
4. **`unbook_bank_transaction`** zet alle facturen van de verdeling terug.
5. **`match_bank_transactions`** zoals hierboven. "Weer openen" (`set_bank_transaction_status`)
   en boeken vergeten het verdeelvoorstel.

## Front-end
- `src/features/Bank.tsx`: Verdelen, de uitleg bij een voorstel, en de verdeling bij een geboekte
  transactie (alleen die van het huidige boekstuk).
- `src/lib/bankSplit.ts` (met tests): bedragen zoals je ze typt ("1.234,56", "120,5"), wat er nog
  te verdelen is, de meldingen per regel en wat er naar de server gaat.
- `src/lib/repository.ts`: `bookBankTransaction(…, { allocations })` stuurt `p_allocations` alleen
  mee bij een verdeling (zo blijft gewoon boeken werken op een database zonder deze migratie);
  `selectBankTransactionAllocations`.
- `src/types.ts`; `src/styles/globals.css`, ook voor de telefoon: soort, bedrag en weghalen naast
  elkaar, de factuur eronder.

## Verificatie
- **SQL** (lokale Postgres 16 met alle 194 migraties): alle eerdere scenario's (blok 1, blok 2 en
  beide reviews) slagen ook met deze migratie erbovenop. Nieuw (V1–V17), als eigenaar via de
  echte RPC's:
  - één ontvangst voor twee facturen: beide betaald, met de transactie als koppeling, twee
    tijdlijnregels, uit de openstaande posten; deels: de ene betaald, de andere deels;
  - een factuur plus een grootboekregel met btw in één boekstuk;
  - alle weigeringen hierboven, en daarna is er niets geboekt;
  - meer grootboekregels zonder factuur: precies; één regel ongewijzigd (een cent verschil gaat
    zoals altijd naar 4900);
  - een batch aan een leverancier; een tegoed terugbetalen aan een klant;
  - terugdraaien: alle facturen weer open (te laat of niet), de tijdlijn, de geschiedenis, de
    stand op een peildatum ervóór, en daarna opnieuw verdelen;
  - verdelen, terugdraaien en dan op één factuur boeken: de openstaande posten sluiten op elke
    dag aan op 1300;
  - de matcher: een verdeling bij een exacte som, "2026-1" telt niet mee naast "2026-10" en
    "2026-12", geen verdeling bij een andere som, één nummer blijft één factuur; ook bij inkoop;
  - rechten als de rol `authenticated`: een andere organisatie ziet niets, zelf schrijven of
    verwijderen kan niet.
- **Twee gelijktijdige verdelingen** over dezelfde facturen, in omgekeerde volgorde: de tweede
  wacht op de eerste en wordt geweigerd ("al volledig betaald"); geen deadlock.
- **Snelheid** (3.000 facturen, 1.000 openstaande transacties): openstaande posten 437 → 458 ms;
  de matcher 3,3 → 4,7 s, door de zwaardere saldoberekening. Bij een gewone sync gaat het om een
  handvol transacties.
- `npm test` ✓ (844; nieuw: het verdelen, en de controle dat elke nieuwe tabel een module gate
  heeft); `npm run typecheck` ✓; `npm run build` ✓; de mobiele layout-suite ✓ (144 pagina's).
- **Scherm** (mock uit `tests/mobile`, desktop en telefoon): het voorstel opent in Verdelen met
  twee regels en "Precies verdeeld"; minder invullen geeft "Nog te verdelen" en zet Boeken uit;
  te veel op een factuur geeft de melding bij die regel; "+ Regel" vult de rest in; Debiteuren
  staat niet in de keuze; wat er naar de server gaat (twee delen en een grootboekregel); de
  verdeling na het boeken (zonder een teruggedraaide); geen horizontale overloop en geen
  JS-fouten. De eerdere schermcontroles van de bank slagen ook nog.

## Deploy (staging)
Na `20261018000000` en `20261018010000`: `supabase db push --linked`, daarna de front-end. Komt de
front-end eerst, dan werkt boeken gewoon; alleen verdelen meldt dat de migratie ontbreekt.

## Bewust buiten deze stap
- Gerrie kan (nog) niet verdelen; wel één factuur of één grootboekrekening, zoals voorheen.
- Verrekenen — een klant die ook leverancier is en het verschil betaalt — vraagt een deel in de
  andere richting; dat kan niet.
- Een voorstel als de som niet precies klopt (welke facturen dan wel?).
