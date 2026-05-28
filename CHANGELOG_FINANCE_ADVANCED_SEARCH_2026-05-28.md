# Changelog — Finance Advanced Search (2026-05-28)

## Samenvatting
Er is een uitgebreide zoek- en filterlaag toegevoegd aan zowel de Offertes-pagina als de Facturen-pagina. De bestaande workflow, detailmodals, PDF-export en tabelstructuur zijn behouden.

## Toegevoegd
- Herbruikbare `FinanceSearchPanel` voor offertes en facturen.
- Vrije zoekbalk die zoekt op onder andere:
  - offerte-/factuurnummer;
  - klantnaam, klantcode, contactpersoon en e-mail;
  - projectnaam en projectomschrijving;
  - gekoppeld offertenummer bij facturen;
  - statuslabels;
  - datums;
  - regelomschrijvingen, aantallen, prijzen en btw;
  - subtotalen, btw-bedragen en totaalbedragen;
  - e-mailstatussen en ontvangers;
  - Mollie-betaalstatussen en payment IDs bij facturen.
- Filters voor:
  - klant;
  - project;
  - status;
  - datum vanaf/tot;
  - bedrag vanaf/tot.
- Resultaatkaart met:
  - aantal zichtbare documenten;
  - totaal aantal documenten;
  - totaalbedrag van de gefilterde selectie.
- Actieve-filterindicator met resetknop.
- Zoekresultaat-empty-state met snelle reset.
- Responsive styling voor desktop, tablet en mobiel.

## Technische keuzes
- Client-side filtering op bestaande geladen `AppData`, zodat er geen backend- of migratie-impact is.
- Eén generieke filterimplementatie voor `Quote` en `Invoice`, zodat de feature consistent blijft en later eenvoudig uit te breiden is.
- Bedragfilters ondersteunen Nederlandse invoer zoals `1.250,50`, maar ook invoer met puntdecimalen zoals `1250.50`.
- Zoeken is case-insensitive en accent-insensitive.

## Aangepaste bestanden
- `src/features/Finance.tsx`
- `src/styles/globals.css`
- `dist/` opnieuw gebouwd via Vite production build.
