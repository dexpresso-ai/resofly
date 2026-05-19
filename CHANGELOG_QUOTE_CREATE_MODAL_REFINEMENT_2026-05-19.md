# Changelog — Quote create modal refinement (2026-05-19)

## Doel
De aanmaakmodal voor offertes is verbreed en opnieuw opgebouwd zodat het formulier rustiger, duidelijker en beter schaalbaar is.

## Aangepast
- De offerte/factuur-editor gebruikt nu een brede finance modal (`modal-finance-editor`).
- Nieuwe offerte krijgt direct een zichtbaar automatisch offertenummer op basis van bestaande nummers in het actieve jaar.
- Offertenummer blijft vóór opslaan handmatig aanpasbaar.
- Datum en verloopdatum staan expliciet gelabeld naast elkaar in een aparte datumsectie.
- Offerteregels zijn opnieuw opgebouwd met duidelijke kolommen:
  - Regelomschrijving
  - Aantal
  - Prijs ex. btw
  - BTW %
  - Regeltotaal
- Totaalblok bovenin toegevoegd met bedrag exclusief btw, btw en totaalbedrag.
- Regels zijn responsive gemaakt voor tablet en mobiel.
- Projectselectie filtert mee op geselecteerde klant, met behoud van het reeds gekozen project.

## Technisch
- `initialForm` ontvangt nu `AppData`, zodat nummergeneratie rekening houdt met bestaande offertes/facturen.
- Nieuwe helpers toegevoegd:
  - `createNextFinanceNumber`
  - `createFallbackFinanceNumber`
  - `FinanceTotal`
  - `Field`
- Build succesvol getest met `npm run build`.
