# Bank — vervolg na stap 2 (afgesproken 2026-10-18)

Wat na blok 1 en 2 nog niet kan, in deze volgorde. Achtergrond:
`ENABLEBANKING_BOEKINGEN_ONDERZOEK_2026-10-18.md` §6 (blok 3 en 4).

| # | Wat | Status |
|---|---|---|
| 1 | Eén overboeking verdelen over meerdere facturen | gebouwd, nog niet uitgerold (`CHANGELOG_BANK_VERDELEN_2026-10-18.md`) |
| 2 | Mollie-uitbetalingen automatisch aansluiten | open |
| 3 | Een koppeling verbreken | open |
| 4 | De koppeling openzetten voor al je klanten | open |

## 1 · Eén overboeking verdelen over meerdere facturen
Een klant die drie facturen in één keer betaalt, een batchbetaling aan een leverancier, of een
ontvangst die deels een factuur is en deels iets anders: nu kan een banktransactie maar op
één factuur of op grootboekregels.
- Een transactie verdelen over verkoopfacturen, inkoopfacturen en grootboekregels (met btw),
  met "nog te verdelen" tot het precies klopt. Elke factuur volgt zijn eigen deel (betaald of
  deels betaald), en terugdraaien zet alles terug.
- De matcher stelt een verdeling voor als er meerdere factuurnummers in de omschrijving staan
  waarvan de openstaande bedragen samen precies het bedrag van de transactie zijn.

## 2 · Mollie-uitbetalingen automatisch aansluiten
Mollie maakt uit wat klanten betalen periodiek een uitbetaling over: ontvangsten min kosten
(en min terugbetalingen en terugboekingen). Zonder aansluiting loopt 1102 Kruisposten
Mollie/PSP alleen maar op.
- Herkennen (tegenpartij of omschrijving Mollie) en voorstellen: 1102 voor het bedrag, het
  verschil met wat er volgens 1102 openstaat op 4130 Betaalproviderkosten.
- Exact per uitbetaling (welke betalingen, welke kosten) later via de Mollie Settlements-API.

## 3 · Een koppeling verbreken
Nu kan een koppeling alleen verlopen. Een knop "Ontkoppelen" beëindigt de sessie bij Enable
Banking (stopt de toegang én de kosten per rekening), zet de toestemming op een eigen status
en laat de rekening met zijn transacties en boekingen staan.

## 4 · De koppeling openzetten voor al je klanten
De gratis "restricted production"-modus van Enable Banking werkt alleen voor je eigen,
vooraf opgegeven rekeningen.
- Buiten de code (jij): een betaald productiecontract bij Enable Banking en een
  verwerkersovereenkomst (DPA).
- In de code: de bankkoppeling als betaalde optie (Enable Banking rekent per rekening per
  maand), een instellingencheck (`GET /application`: sandbox of productie, staan de
  redirect-URL's goed) en zakelijk of privé per koppeling in plaats van één instelling voor
  de hele app.
