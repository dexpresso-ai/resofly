# Volledige werkruimte opent de ResoFly-app

**16 november 2026**

Onderaan het menu van Agenda, Financiën en Communicatie staat *Volledige
werkruimte*. Draait zo'n app als geïnstalleerde app, dan opent die knop nu de
geïnstalleerde ResoFly-app, en niet meer het adres in een browservenster. Staat
ResoFly niet op je apparaat, dan zegt de knop eerst dat je hem moet installeren.

## Wat er misging

De knop deed `window.open('/app/werkruimte/', '_blank', 'noopener')`. Met dat
derde argument maakt een browser er een pop-upvenster van. Chrome en Edge sturen
een pop-up nooit door naar een geïnstalleerde app, dus je kreeg een kaal
browservenster met het adres. Ook op Android opende de knop niet in de
ResoFly-app, al zei de changelog van 12 november van wel: Chrome op Android
liet zo'n link tot versie 158 in de browser.

Een klik op een gewone link met `target="_blank"` stuurt Chrome wél door naar de
app die bij het adres hoort. Op Windows, Mac en Linux kan dat sinds Chrome 139,
op Android sinds Chrome 158 (nu de gangbare versie). De knop klikt nu zo'n link
aan.

## Wat er nu gebeurt

| Apparaat | ResoFly staat erop | ResoFly staat er niet op |
| --- | --- | --- |
| Windows, Mac, Linux (Chrome, Edge) | De ResoFly-app opent. Staat hij al open, dan komt dat venster naar voren. | Melding *Installeer eerst de ResoFly-app* |
| Android (Chrome) | De ResoFly-app opent. Met een Chrome ouder dan 158 opent hij in Chrome. | Melding *Installeer eerst de ResoFly-app* |
| iPhone, iPad | Melding *Open ResoFly vanaf je beginscherm*. Daar kan de ene app de andere niet openen. | Dezelfde melding, met hoe je hem installeert |
| Safari op de Mac (in het Dock) | macOS opent de ResoFly-app. | Safari opent ResoFly, met de kaart om hem in het Dock te zetten. |

In de melding *Installeer eerst de ResoFly-app*:

- **ResoFly installeren** opent ResoFly in de browser. Onderin staat dan de
  kaart *Installeer ResoFly*, ook als je die ooit wegklikte.
- **In de browser openen** is voor wie nu niet wil installeren.

Op de iPhone kopieert **Link kopiëren** het adres om in Safari te openen en op
het beginscherm te zetten.

In een gewoon browsertabblad verandert er niets: de knop gaat naar de
werkruimte, in hetzelfde tabblad.

## Hoe de app weet of ResoFly erop staat

- De ResoFly-app (`/app/werkruimte/`) zet bij elke start een vlag in de opslag
  van de browser (`resofly.app-geinstalleerd.werkruimte`). Chrome en Edge delen
  die opslag tussen de apps van één site, dus de losse apps zien hem.
- Op Android vraagt de losse app het daarnaast aan Chrome
  (`getInstalledRelatedApps`). Daarvoor staat ResoFly in `related_applications`
  van het manifest van elke losse app. Chrome geeft alleen antwoord als
  `/.well-known/assetlinks.json` dat toestaat. Opent de werkruimte op Android in
  de browser, dan vraagt hij het ook: zo vergeten we een app die verwijderd is.
- Op de computer kan een andere app het niet aan Chrome vragen; Chrome kijkt
  alleen binnen de eigen scope. Daar telt alleen de vlag.
- iPhone, iPad en Safari op de Mac: elke app heeft daar zijn eigen opslag, en
  er is niets om het aan te vragen.

De regels staan in `src/lib/openWorkspaceApp.ts`, de melding in
`src/components/StandaloneApps.tsx` (`useOpenWorkspace`).

## Gevolgen

- **Staat ResoFly al op je apparaat, maar heb je hem sinds deze versie nog niet
  geopend?** Dan zie je één keer de melding. Kies dan **ResoFly installeren**:
  dat is een link naar de app, en die opent dan gewoon. Daarna weet de knop het.
- **ResoFly verwijderd op de computer?** Dan opent de knop de werkruimte in een
  browsertabblad, met de kaart om hem opnieuw te installeren.
- **De ResoFly-app heeft nu `launch_handler: focus-existing`.** Open je hem terwijl
  hij al openstaat (via de knop, of vanuit de taakbalk of het Dock), dan komt
  dat venster naar voren, in plaats van dat er een tweede bij komt.
- **`assetlinks.json` noemt staging.resofly.com, staging.resofly.pages.dev en
  app.resofly.nl.** Komt er een domein bij, zet het er dan in.
  `openWorkspaceApp.test.ts` controleert dat elk domein alle drie de losse apps
  heeft. Op een domein dat er niet in staat, werkt op Android alleen de vlag.

## Getest

- `npm run typecheck` en `npm test`. Nieuw: `src/lib/openWorkspaceApp.test.ts`
  (11 tests):
  - wat de knop doet per apparaat en per stand;
  - de vlag, ook zonder opslag;
  - het antwoord van de browser;
  - openen is een link met `target="_blank"` en geen pop-up;
  - `?installeren` in het adres;
  - de manifesten en `assetlinks.json` passen bij elkaar.
- In Chromium tegen de nagebootste backend, met de app Agenda nagebootst als
  geïnstalleerde app. Daarbij 32 controles, alle in orde:
  - Windows zonder en met ResoFly;
  - Android met en zonder ResoFly (`getInstalledRelatedApps` nagebootst);
  - iPhone, met Link kopiëren;
  - een gewoon browsertabblad;
  - de vlag in de werkruimte-app;
  - `?installeren` in Safari op de Mac, met de weggeklikte kaart die toch
    terugkomt.

  Nergens nog `window.open`, nergens een fout in de pagina, en de terugknop
  sluit de melding.
- `npm run test:mobile -- --theme=both` en `npm run test:terugknop`.
- Niet getest op een echte telefoon of computer met geïnstalleerde apps; dat
  kan hier niet. Dat Chrome een link doorstuurt en een pop-up niet, volgt uit
  de broncode van Chrome 158. Op de computer staat dat in
  `navigation_capturing_process.cc`. Op Android staat het in
  `ExternalNavigationHandler.java`, met de functie
  `WebApkSelfOwnedRendererNavLaunch`, die in 158 aanstaat.
