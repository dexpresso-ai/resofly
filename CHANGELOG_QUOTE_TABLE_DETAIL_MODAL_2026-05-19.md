# Changelog – Offertes tabel + detailmodal

Datum: 2026-05-19

## Aangepast

- De offerte-overzichtspagina toont offertes nu als compacte tabel in plaats van grote workflow-kaarten.
- Nieuwe tabelkolommen toegevoegd:
  - Offertenummer
  - Klantnaam
  - Projectnaam
  - Datum
  - Verloopdatum
  - Bedrag exclusief btw
  - Btw-bedrag
  - Totaalbedrag
  - Status
- Klikken op een offerte opent een brede detailmodal in plaats van direct de bewerkflow.
- De detailmodal bevat:
  - offerte-overzicht
  - bedragensamenvatting
  - workflow-progressie
  - e-mailstatus
  - workflowacties
  - offerteversies
  - offerteregels
  - volledige tijdlijn
- Bewerkactie is bewust verplaatst naar de detailmodal, zodat de tabel compact en scanbaar blijft.
- PDF-download is beschikbaar gebleven vanuit de tabelrij.
- Toetsenbordtoegang toegevoegd: een offerte kan met Enter of spatie worden geopend.
- Responsive styling toegevoegd: op mobiel valt de tabel netjes terug naar compacte kaartregels.

## Technisch

- `src/features/Finance.tsx` opgesplitst met duidelijke componenten:
  - `QuoteTable`
  - `QuoteDetailModal`
  - `QuoteMetric`
  - `QuoteLineTable`
- Facturen behouden de bestaande compacte lijstweergave.
- Offerteworkflow-componenten worden hergebruikt in de modal, zodat logica niet dubbel wordt onderhouden.
- Nieuwe CSS toegevoegd in `src/styles/globals.css` voor tabel, brede modal en responsive states.
