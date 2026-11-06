# Zekerheidstest financiën — 6 november 2026

Vraag: "Doe daarna nog een zekerheid test of de financiële module echt
hufterproof is." Dus: kan iemand de boeken kapotmaken, met opzet of per
ongeluk? Niet alleen via de knoppen, ook via de API (de app praat rechtstreeks
met de database, en wie is ingelogd kan dezelfde tabellen en functies
aanroepen).

## Hoe getest

Alles op staging, in een transactie die altijd wordt teruggedraaid, tenzij
anders vermeld.

1. **Aanvalstest** (65 gevallen), als ingelogde eigenaar via tabellen en
   functies, en als buitenstaander (eigenaar van een andere organisatie):
   - knoeien met geboekte journaalposten, facturen, betalingen,
     grootboekrekeningen, creditnota's en boekjaren;
   - onzin: bedragen als tekst, halve centen, bedragen boven de grens van
     bigint, 30 februari, btw van 150% en −21%, factuurregels die geen lijst
     zijn;
   - dubbel klikken: dezelfde bankbetaling, inkoopfactuur, tegenboeking of
     btw-afsluiting twee keer;
   - randgevallen: een journaalpost die niet sluit, in een gesloten periode,
     ver in de toekomst of vóór de start van de boekhouding.
2. **Btw-slot**: kan een ingediende aangifte achteraf nog veranderen? Zeven
   pogingen: nagekomen verkoop- en inkoopfactuur, memorialen met en zonder
   btw-rekening, een bankboeking met btw, een factuur tegenboeken.
3. **Rechtenmatrix**: 827 combinaties van rol × tabel en rol × functie, plus
   aanroepen met id's van een andere organisatie.
4. **Eind-tot-eind** per rechtsvorm: eenmanszaak, vof en BV.
5. **Kruiscontrole app ↔ database ↔ grootboek**: 400 willekeurige facturen
   (totaal in het scherm tegen het totaal in de database), waarvan 120 ook
   geboekt (debiteuren, btw en omzet tegen wat het scherm toont).
6. **Fuzz- en eigenschapstests** in de app (`src/lib/financeFuzz.test.ts`,
   vaste startwaarde, draait mee in `npm test`):
   - 20.000 bedragen in vijf schrijfwijzen;
   - 20.000 rommelbedragen;
   - 15.000 bankbedragen;
   - 24.000 datums in acht schrijfwijzen;
   - 20.000 rommeldatums;
   - 3.000 factuurtotalen;
   - 1.500 bankbestanden met rommel, door de CSV- en MT940-lezer.
7. **Gelijktijdigheid**: welke geldfuncties vergrendelen vóórdat ze
   controleren of iets al geboekt is (code nagelopen; twee echte verbindingen
   tegelijk kan deze sessie niet nabootsen).
8. **plpgsql_check** over alle 486 databasefuncties.

## Wat al goed zat

- **Geboekte posten**: niet te wijzigen, niet te wissen, niet terug naar
  concept, en geen regel bij te voegen.
- **Facturen**:
  - een verstuurde factuur ligt vast (regels, nummer, datum, status);
  - wissen kan niet;
  - "betaald" kan niet zolang er geld open staat;
  - een factuurnummer kan niet twee keer.
- **Betalingen en creditnota's**: zelf invoegen of op betaald zetten kan niet
  (de rij-beveiliging weigert).
- **Systeemrekening 1300**: soort en code liggen vast; een gebruikte
  rekening wis je niet.
- **Journaalposten**:
  - debet én credit op één regel kan niet, negatieve bedragen ook niet;
  - een post zonder regels kan niet, een rekening van een andere organisatie
    ook niet;
  - bedragen boven de grens van bigint, tekst als bedrag en halve centen
    worden geweigerd.
- **Bank**:
  - dezelfde betaling twee keer boeken kan niet;
  - een tweede betaling op een al betaalde factuur kan niet;
  - een splitsing die niet optelt kan niet;
  - een factuur van een ander kan niet;
  - hetzelfde bestand nog eens importeren geeft geen dubbele regels.
- **Tegenboeken**: twee keer kan niet, de tegenboeking zelf ook niet. Een
  verkoopfactuur gaat via een creditnota.
- **Btw-slot**:
  - nagekomen facturen gaan naar de eerste open dag (1 april);
  - memorialen en bankboekingen met btw in de gesloten periode worden
    geweigerd;
  - de cijfers van de afgesloten periode blijven precies gelijk;
  - afsluiten en boeken kan niet door elkaar heen: afsluiten neemt een
    exclusieve grendel.
- **Boekjaren**: overlappen kan niet, einde vóór begin ook niet.
- **Buitenstaander**: ziet niets, wijzigt niets, boekt niets, ook niet met
  een bekend id. Een rekening van een andere organisatie in de eigen boeking
  wordt ook geweigerd.
- **Kruiscontrole**: 400 van de 400 totalen gelijk, 120 van de 120 boekingen
  gelijk (debiteuren, btw en omzet), op de cent.
- **Rechtenmatrix**: 0 verschillen met de vorige meting.

## Wat niet goed zat, en nu wel

| Gat | Was | Nu |
| --- | --- | --- |
| Btw-tarief op een factuurregel | 150% en −21% werden geboekt, en kwamen in 1510 en de aangifte | tussen 0 en 30% (het hoogste tarief in de EU is 27%), met een melding per regel |
| Btw-tarief op een inkoopregel | 150% gaf 150% voorbelasting terug (het tarief van de regel gaat vóór dat van de code) | tussen 0 en 30% |
| Eigen btw-code | elk tarief mocht | tussen 0 en 30% (check op `vat_codes.rate`) |
| Inkoopregel met 100,5 cent of tekst als bedrag | opgeslagen; liep pas bij het boeken vast | meteen een melding |
| Boekjaar van vijf jaar | kon | hooguit 36 maanden: meer verwerkt de auditfile-export niet |
| Handmatige journaalpost op 31-12-9999 (tikfout) | kon, en verdween uit elk overzicht | geweigerd: hooguit een jaar vooruit |
| Handmatige journaalpost vóór de start van de boekhouding | kon, en schoof onder de beginbalans door | geweigerd, met de startdatum erbij. Automatische boekingen en de server mogen wel. |
| Journaalpost zonder datum | technische fout | een duidelijke melding |
| Twee keer tegelijk "beginbalans vastleggen" | controleren en boeken zonder grendel: twee beginbalansen mogelijk | eerst een grendel per organisatie |
| Twee boekjaren tegelijk openen | twee overlappende boekjaren mogelijk (dezelfde startdatum hield de database al tegen) | eerst een grendel per organisatie |
| Datum uit een bankbestand | de soepele datumlezer van de browser maakte van rommel als `c)103(` het jaar 103 (gevonden door de fuzztest) | alleen jaren 1900–2100; maandnamen in het Nederlands en Engels ("5 mei 2026", "05-okt-2026") |
| Lege factuur versturen | met "Versturen" ging een conceptfactuur zonder regels (of met alleen een lege regel) als factuur van € 0 naar de klant, en het nummer was op; via de API kon een lege factuur ook rechtstreeks op "verstuurd" | de server weigert vóór het mailen, en de database weigert het uitgeven (`20261106120000_factuur_zonder_inhoud.sql`). Een gratis regel mét omschrijving mag wel; een leeg concept bewaren of annuleren ook. |

De grenzen raken geen bestaande gegevens op staging (btw 0, 9, 20,99 en 21;
boekjaren van 12 maanden; geen boekingen vóór de start of ver vooruit).

## Wat bewust zo blijft

- **Afrondingsverschil**: een verschil van een paar cent in een journaalpost
  wordt als afrondingsverschil op 4900 geboekt. De boeken blijven sluiten.
- **Creditnota van een leverancier**: een inkoopregel met een negatief bedrag
  is een creditnota en komt netjes aan de creditkant (kosten, voorbelasting
  en crediteuren).
- **Gesloten btw-periode**: een memoriaal zónder btw (bijvoorbeeld een
  afschrijving) mag op zijn eigen datum. Hij komt in geen rubriek, en de
  test laat zien dat de cijfers van de aangifte gelijk blijven.

## Grenzen van deze test

- **Gelijktijdigheid** is in de code nagelopen, niet met twee echte
  verbindingen nagespeeld. De boekfuncties vergrendelen de rij vóór de
  controle "al geboekt"; btw-afsluiting en jaarafsluiting nemen een
  exclusieve grendel; nummering een grendel per jaar.
- **camt.053** leest XML met de DOMParser van de browser. In de fuzztest
  (Node) loopt alleen CSV en MT940 mee.
- **De API van Mollie** is niet echt aangeroepen. Er zijn geen
  testbetalingen of -facturen vanuit deze sessie gemaakt; het gedrag komt
  uit de SDK en is met nagebootste antwoorden getest.

## Wijzigingen

- `supabase/migrations/20261106110000_financien_zekerheidstest.sql`:
  - `enforce_invoice_lines_numeric` (btw 0–30%);
  - nieuw `enforce_purchase_invoice_lines` met trigger
    `purchase_invoices_lines_valid`;
  - check `vat_codes_rate_range`;
  - `open_fiscal_year` (36 maanden, grendel);
  - `post_journal_entry` (datum);
  - `create_opening_balance` (grendel);
  - rechten expliciet dicht voor anon.
- `src/lib/bankImport/dedup.ts`: `normalizeDate` strenger, met maandnamen.
- `src/lib/bankImport/camt053.ts`: import met `.ts`, zodat de tests hem
  kunnen laden.
- `src/lib/financeFuzz.test.ts`: de fuzz- en eigenschapstests.
- `supabase/migrations/20261106120000_factuur_zonder_inhoud.sql`:
  `enforce_invoice_has_content` met trigger `invoices_lines_present`; en in
  `invoice-workflow` dezelfde controle vóór het mailen (`invoiceHasContent`).

## Getest

- **Grenzen**, net wel en net niet, als eigenaar (de migratie twee keer achter
  elkaar):
  - btw 30 mag, 30,01 niet;
  - een boekjaar van 36 maanden mag, één dag langer niet;
  - een handmatige post over 11 maanden mag, over 13 niet;
  - de startdag mag, de dag ervoor niet, maar de server mag wel;
  - een creditnota van een leverancier boekt nog steeds goed.
- **Aanvalstest opnieuw**: van de 65 gevallen gaan alleen de drie bewuste
  hierboven door. De boeken sluiten (debet = credit).
- **Lege factuur**:
  - geen regels, of één lege regel: geweigerd;
  - alleen een omschrijving (gratis) of alleen een bedrag: mag;
  - rommel in het aantal geeft nog steeds de bestaande melding;
  - een leeg concept bewaren en annuleren mag, versturen niet;
  - een verstuurde factuur kan nog "te laat" worden.
- **Btw-slot opnieuw**: de cijfers van de afgesloten periode blijven gelijk.
- **Mollie-scenario's** van de vorige stap: ongewijzigd.
- **Regressie**:
  - eind-tot-eind eenmanszaak, vof en BV: exact gelijk aan vóór de
    wijzigingen;
  - rechtenmatrix: 827 rijen, 0 verschillen;
  - plpgsql_check: geen fouten in de gewijzigde functies.
- **Overige controles**:
  - `npm run typecheck`;
  - `npm test` (1103 tests, waarvan 7 nieuwe fuzz- en eigenschapstests);
  - `supabase db start` vanaf nul.

## Uitrol op staging

- Deploy-run 180: migratie `20261106110000` doorgevoerd, de rooktest groen.
- Nacontrole op de live database:
  - de check `vat_codes_rate_range` staat erop, en de trigger
    `purchase_invoices_lines_valid`;
  - de datumcontrole in `post_journal_entry` werkt;
  - de grendels in `create_opening_balance` en `open_fiscal_year` staan erin;
  - `anon` kan geen van deze functies aanroepen; `authenticated` alleen
    `open_fiscal_year`, `post_journal_entry` en `create_opening_balance`,
    zoals voorheen.
- Live tests, zonder migratie in de testtransactie, met dezelfde uitkomst als
  de proef:
  - de grenzen;
  - de aanvalstest (65 gevallen);
  - het btw-slot;
  - eind-tot-eind eenmanszaak, vof en BV;
  - de rechtenmatrix (827 rijen, 0 verschillen).
- `20261106120000_factuur_zonder_inhoud.sql` gaat met de volgende uitrol mee.
