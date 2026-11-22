# Bank: afschriften inlezen en de bankkoppeling — 22 november 2026

Aanleiding: de controle bank van 22 november 2026. Kan een zzp'er met een
eenmanszaak zijn bank in ResoFly bijhouden met de afschriften van zijn eigen
bank en met de bankkoppeling, zonder dat er stil iets verkeerd binnenkomt?
Dit zijn de eenvoudige bevindingen. Bevinding 2 (een verkeerd ingelezen regel
weghalen) en 8 (CSV zonder kopregel) zijn apart.

Waar het formaat van een bank niet zeker is (Revolut, Knab, de tekencodering),
is de lezer ruimer gemaakt: hij neemt de varianten aan en weigert niets wat hij
eerst wel las.

## Wat er misging, en wat er nu gebeurt

| # | Wat er misging | Nu |
| --- | --- | --- |
| 1 | Een afschrift van een andere rekening, of een bestand met twee rekeningen (Rabobank-CSV met de spaarrekening, ING-CSV, CAMT, MT940), ging zonder vraag de gekozen rekening in. De spaarregel van + € 5.000 met de eigen naam leek een privéstorting. | De lezers geven per regel de eigen rekening mee (ING "Rekening", Rabobank "IBAN/BBAN", Knab "Rekeningnummer", bunq "Account", MT940 `:25:`, CAMT `Stmt/Acct`). Vóór het inlezen legt het scherm die naast het IBAN van de gekozen rekening. Eén andere rekening: eerst een vraag. Meer rekeningen: alleen de eigen regels, met het saldo van die rekening, en het aantal overgeslagen regels. Meer rekeningen en geen IBAN bij de gekozen rekening: geweigerd, met de vraag het IBAN in te vullen. |
| 3 | Na maanden opnieuw koppelen gaf de bank maar ~90 dagen terug; de sync vroeg opnieuw met "longest" en meldde "geslaagd". Een premie van € 99,99 kwam nooit binnen, en niemand zag het. | `bank-sync` legt de periode vast (`bank_accounts.sync_gap_from/to`) en meldt hem in het resultaat van Koppelen en Synchroniseren. De Bankpagina toont hem bij de rekening tot je op "Gezien" klikt of een afschrift over die periode inleest. Het saldo ophalen is niet gedaan (moeilijk: welk saldotype per bank). |
| 4 | Revolut Business: een post in behandeling en een teruggedraaide betaling telden mee, de kosten ontbraken, het kenmerk F2026-0012 viel weg, en een pinbetaling van 00:30 stond op de UTC-datum. € 308,17 te weinig. | Alleen voltooide regels (met een waarschuwing over de rest), "Total amount" (of Amount min Fee), "Reference" in de omschrijving, "Payer" (of de omschrijving) als naam, "Date completed" omgerekend naar Nederlandse tijd, de valuta uit "Payment currency". Ook de privé-export (Started/Completed Date, Amount, Fee). |
| 5 | MT940: de periode begon op de datum van `:60F:`, het vorige eindsaldo. De afschriftcontrole telde de vorige dag mee en elk volgend ING-afschrift gaf vals alarm. | De periode begint de dag ná `:60F:`, of eerder als het afschrift een mutatie van eerder bevat (een bank die op `:60F:` de eerste dag zelf zet). |
| 6 | ING breekt `:86:` af op 65 tekens. Met een spatie ertussen bestond `/CNTP/` niet meer (naam en IBAN leeg), en werd "Jan de Vries" "Jan de V ries", die niet meer matchte. Omschrijving en end-to-end-id eindigden op "/". | Een gestructureerd `:86:` (met `/TAG/`) gaat zonder scheiding aan elkaar; vrije tekst houdt de spatie. Het slot-"/" gaat eraf. |
| 7 | Knab: de regel "KNAB EXPORT" boven de kop gaf "kon de datum- of bedragkolom niet herkennen"; zonder die regel geen naam en de transactiedatum. | De kopregel is de eerste van de eerste tien regels met een datum- én een bedragkolom. "Tegenrekeninghouder" is de naam. De boekdatum gaat vóór de transactiedatum, net als bij CAMT en de koppeling. |
| 9 | Eén 403 voor één rekening zette de hele koppeling op "verlopen"; de nachtelijke sync sloeg daarna ook de betaalrekening over. | Alleen een 401 of een code over de sessie (EXPIRED/CLOSED/REVOKED, niet over een rekening) is verlopen toestemming. Een 403 of 404 is een fout van die rekening, met een tekst die zegt wat je kunt doen. |
| 10 | Storno van een incasso (CAMT, `RvslInd`): de tegenpartij was de zzp'er zelf. | Bij een storno de andere kant, en nooit de eigen rekening als tegenpartij. Ook in de koppeling (`mapEbTransaction` met het eigen IBAN). |
| 11 | De saldomelding zei altijd "er ontbreken transacties", ook als er een betaling dubbel stond. | De melding zegt welke kant het op wijst (er staat iets dubbel, of er ontbreekt iets) en verwijst naar "Dubbele verwijderen". Ook in de aansluiting. |
| 13 | bunq: het IBAN van de tegenpartij (kolom "Counterparty") werd niet gelezen. | "Counterparty" telt als tegenrekening als de waarden IBAN's zijn. |
| 14 | Elk bestand werd als UTF-8 gelezen: "Caf� H� Zuid". | Geen geldige UTF-8: dan Windows-1252 (omvat ISO-8859-1). |
| 15 | CAMT met beginsaldo `PRCD` in plaats van `OPBD`: geen afschriftcontrole. Rabobank-MT940: het IBAN op de tweede regel van `:61:` werd niet gelezen. | `PRCD` als terugval voor `OPBD`. Een IBAN op een vervolgregel van `:61:` is de tegenrekening als `:86:` er geen noemt. |

Uit de UI-controle van dezelfde dag (bevinding 13): de reden bij een
inkoopvoorstel noemde het eigen nummer ("Factuurnummer INK-2026-0001 staat in
de omschrijving") terwijl de omschrijving het nummer van de leverancier had.
Nu: "Factuurnummer TIP-2026-883421 (inkoopfactuur INK-2026-0001) staat in de
omschrijving", en "Betalingskenmerk …" bij het kenmerk uit een e-factuur.

Niet gedaan: bevinding 12 (twee gekoppelde rekeningen op 1100). Een eigen
grootboekrekening per gekoppelde rekening is een keuze in het rekeningschema
(welke code, of de app die zelf aanmaakt); het scherm legt het nu al uit.

## Migratie

`20261122100000_bank_inlezen.sql`: de kolommen `sync_gap_from` en
`sync_gap_to` op `bank_accounts` (`add column if not exists`), en
`bank_purchase_match` opnieuw (basis 20261119180000, alleen het blok "het
nummer in de omschrijving"). Zonder de migratie werkt `bank-sync` gewoon; het
gat staat dan alleen in het resultaat.

## Let op bij de overgang

De ontdubbeling werkt op datum, bedrag, tegenrekening en omschrijving. Waar de
lezer nu iets anders leest dan eerst (Knab: de boekdatum; ING-MT940: een hele
naam en omschrijving; bunq: het IBAN; een storno: de tegenpartij; een bestand
in Windows-1252), komt een regel die vóór deze wijziging al was ingelezen bij
een overlappend afschrift nog één keer binnen. Op dezelfde datum en met
hetzelfde bedrag krijgt hij de knop "Dubbele verwijderen"; de afschriftcontrole
meldt het verschil.

## Getest

- `npm test`: nieuwe tests naast de lezers (`src/lib/bankImport/*.test.ts`,
  nu ook in `npm test`), en `bankSync.test.ts`. Elk faalde op de code van vóór
  deze wijziging. De CAMT-tests draaien in Node met een kleine DOMParser
  (`testDom.ts`).
- De testbestanden van de controle in Chromium gelezen (`parseBankFile` met een
  `File`, zoals het scherm), en met de naspeelscripts tegen de lokale stack:
  MT940 oktober → november klopt; Revolut € 1.106,78; storno KPN; de
  koppeling meldt het gat (8-7 t/m 22-9) en een 403 op de spaarrekening laat
  de betaalrekening syncen.
- `npm run test:stromen -- bank herstelwegen`, met een nieuwe stap voor de
  reden bij een inkoopvoorstel.
- `npm run test:mobile -- --theme=both` voor de Bankpagina, met een nieuwe
  pagina `bank-rekeningen` (de melding over het gat).
- `deno check` op `bank-sync`: alleen de bekende `Uint8Array`-fout waarom de
  functie buiten de CI-lijst staat.
