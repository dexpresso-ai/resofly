# Pagina's laden pas als je ze opent — 19 november 2026

Vervolg op [CHANGELOG_OPSTARTEN_SNELLER_2026-11-19.md](CHANGELOG_OPSTARTEN_SNELLER_2026-11-19.md).
Daar bleef de hoofdbundel 3.721 KB (1.060 KB gzip), en ruim de helft daarvan was
code van pagina's die je bij het openen van de app niet nodig hebt.

## Wat er was

Elke pagina van de werkruimte zat in de bundel die bij elke start werd geladen
en geparsed: Agenda (277 KB onverkleind), Instellingen (221 KB), Weekplanner,
Boekhouding, Gerrie, de galerij, de prognose, de jaarrekening… Op een telefoon
kost alleen het parsen daarvan al seconden, ook als je die dag maar één pagina
opent.

Vier imports trokken pagina's de hoofdbundel in, ook als `main.tsx` ze los
zou laden:

- `components/Sidebar.tsx` haalde `settingsMenuGroups` uit
  `features/SimplePages.tsx`. Zo kwam de hele instellingenpagina mee, met de
  documentopmaak-editor;
- `lib/actions/bookkeeping.ts` (de handelingen van Gerrie) haalde
  `purchaseTotals` uit `features/Bookkeeping.tsx`;
- `main.tsx` haalde `nextPurchaseNumber` en `purchaseTotals` uit Bookkeeping;
- `main.tsx` haalde `resolveRateCents` en `defaultBillableForProject` uit
  `features/TimeTracking.tsx`.

## Wat er nu is

- **39 pagina's laden los** (`lazyPage` in `main.tsx`), ook Klanten, Projecten
  en Tickets. Het dashboard blijft in de hoofdbundel: dat is de startpagina.
- **De hulpfuncties staan in `src/lib`:** `lib/timeRates.ts`,
  `lib/purchaseInvoiceNumbers.ts` en `components/settingsMenuItems.ts` (naam,
  icoon en uitleg van de instellingen). De test `settingsMenu.test.ts` leest dat
  laatste bestand nu.
- **Per tabblad een `Suspense`** met "Laden…" zolang de pagina binnenkomt. Meestal
  is dat een fractie van een seconde, en alleen de eerste keer.
- **`components/LazyPage.tsx`:** na een nieuwe deploy bestaan de oude bestanden
  niet meer op Cloudflare Pages. Een venster dat al openstond, kan een pagina die
  het nog niet had geladen dan niet meer ophalen. Zonder grens werd de hele app
  wit. `PageLoadBoundary` toont in dat geval "Deze pagina kon niet worden
  geladen" met een knop Herladen. Elke andere fout geeft de grens door zoals
  voorheen. De grens begint opnieuw zodra je in dat tabblad naar een andere
  pagina gaat. `lib/chunkReload.ts` vraagt daarnaast zelf om te herladen als er
  een nieuwe versie staat.
- De pagina's achter een deellink, het klantportaal en de inrichting gebruiken
  hetzelfde `lazyPage`, met dezelfde grens.

## Gemeten

`npx vite build`, de bundel die bij elke start laadt:

| | onverkleind | gzip |
| --- | --- | --- |
| vóór 19 november | 4.409 KB | 1.308 KB |
| na opstarten sneller | 3.721 KB | 1.060 KB |
| **nu** | **1.797 KB** | **526 KB** |

Wat er nog in zit, is de schil zelf: de Supabase-client, React, `main.tsx`,
`repository.ts`, de teamchat, Gerrie en het dashboard. De CSS (1,45 MB, 232 KB
gzip) is één bestand gebleven.

## Getest

- `npm run typecheck`: schoon.
- `npm test`: 2.055 geslaagd, 12 mislukt; dezelfde 12 als vóór deze wijziging
  (tests die op `\n` matchen in een Windows-werkkopie met CRLF).
- `npm run build`: geen melding dat een pagina zowel los als gewoon wordt
  geïmporteerd.
- `npm run test:loading`: 119 controles geslaagd.
- `npm run test:terugknop`: 15 gelukt, 0 mislukt.
- `npm run test:inrichten`: 157 controles geslaagd.
- `npm run test:mobile -- --theme=both`: 812 pagina's, 5 met een probleem. Vier
  daarvan bestonden al: het dashboard op de telefoon, met het eerste item op
  287 px (max 280). De vijfde was `light/tablet/forecast-cashflow`: de app-schil
  stond er niet binnen 20 seconden, dus vóór de pagina zelf laadde. Apart
  slaagde die pagina drie keer op drie (24 metingen).

## Samengevoegd met staging (20 november)

Staging had intussen `purchaseTotals` de btw-soorten en de KOR meegegeven
(financiën: herstelwegen). Git voegde dat zonder melding samen tot een oude
`purchaseTotals` in `lib/purchaseInvoiceNumbers.ts` naast de nieuwe in
`features/Bookkeeping.tsx`. Nu staat de versie van staging, letterlijk, in
`lib/purchaseInvoiceNumbers.ts`; Bookkeeping, `main.tsx` en de handelingen
van Gerrie halen hem daar. `Invoices` en `Quotes` blijven los geladen, met de
nieuwe imports van het factuurherstel in `main.tsx`.
