# Changelog - Client detail finance overview (2026-05-11)

## Gewijzigd
- Klanten openen vanuit het klantenoverzicht nu in een volledige detailpagina in plaats van direct in een edit-popup.
- Nieuwe klantdetailpagina toegevoegd met:
  - klantgegevens en tags;
  - gekoppelde projecten;
  - gekoppelde notities;
  - overzicht van offertes;
  - overzicht van facturen;
  - KPI-kaarten voor totaal offertes, totaal facturen, openstaande facturen, vervallen facturen en betaalde facturen.
- Klantkaarten tonen nu direct het aantal offertes en facturen.
- Klantkaarten tonen een visuele waarschuwing wanneer er openstaande of vervallen facturen zijn.
- Facturen worden op klantniveau ook meegenomen wanneer ze via een gekoppeld project aan de klant verbonden zijn.
- Offertes en notities worden op klantniveau eveneens meegenomen via directe klantkoppeling én via gekoppelde projecten.
- Vanuit klantdetail kun je direct:
  - de klant bewerken;
  - een offerte voor de klant aanmaken;
  - een factuur voor de klant aanmaken;
  - bestaande offertes/facturen openen;
  - gekoppelde projecten openen;
  - klantnotities toevoegen of bewerken.

## Technisch
- `src/features/Clients.tsx` uitgebreid met `ClientDetailPage` en finance helperfuncties.
- `src/main.tsx` uitgebreid met client-detail routing state (`page === 'client'`) en `clientId` selectie.
- `src/components/Sidebar.tsx` type-safe gemaakt voor de nieuwe interne `client` pagina.
- `src/styles/globals.css` uitgebreid met responsive styling voor klantdetail, finance-KPI's en waarschuwingen.

## Database
- Geen databasewijzigingen nodig. De aanpassing gebruikt bestaande velden uit `clients`, `projects`, `quotes`, `invoices` en `notes`.
