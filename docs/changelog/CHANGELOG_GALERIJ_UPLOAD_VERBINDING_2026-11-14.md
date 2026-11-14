# Changelog — Galerij: uploaden overleeft een haperende verbinding — 2026-11-14

## Aanleiding

> Ik krijg regelmatig bijgevoegde melding. Zoek de foutmelding en maak hem beter, zodat dit niet
> voor meer hoeft te komen.

Op een Android-telefoon, in *Galerij-instellingen → Bestanden*, een upload van 51 foto's. De
eerste foto's werden *Klaar*. Daarna kreeg één foto *Niet ingelogd.*, en alle foto's erna kregen
*Failed to fetch*.

## Wat er mis was

Beide meldingen betekenen hetzelfde: de verbinding viel even weg. Het scherm ging uit, of de
telefoon wisselde van wifi naar 4G. Chrome breekt lopende verzoeken dan af.

- **"Failed to fetch"** is de kale tekst van de browser bij een verbroken verbinding. De app gaf die
  letterlijk door.
- **"Niet ingelogd."** kwam uit `currentUserId()` in `src/lib/repository.ts`. Bij het opslaan van
  elke foto vroeg de app aan Supabase wie er was ingelogd (`getUser`, een netwerkverzoek). Mislukte
  dat verzoek door het netwerk, dan kwam er geen gebruiker terug. De app concludeerde dan dat je
  niet was ingelogd, maar je was gewoon ingelogd.
- Niets werd opnieuw geprobeerd, behalve de delen van een grote video. De wachtrij liep dus in een
  paar tellen leeg, met bij elk bestand dezelfde fout.
- Daarna moest je de foto's opnieuw kiezen. Op een telefoon betekent dat zoeken welke het wél
  haalden.

## Wat er nu klopt

### Het gebeurt niet meer zomaar

- **Opnieuw proberen.** Elk verzoek van een upload probeert het zelf opnieuw bij een
  verbindingsfout of een tijdelijke serverfout. Dat geldt voor de bestanden naar Cloudflare, het
  opslaan in het album en het verversen van de inlog. Zes pogingen, samen ruim een minuut. Dat is
  genoeg voor een wissel van wifi naar 4G of een dode zone. Fouten die niet vanzelf overgaan, zoals
  geen toegang of een te groot bestand, komen meteen door.
- **Wachten tot je terug bent.** Een poging zonder netwerk, of met het scherm uit, telt niet mee.
  De upload wacht dan tot de verbinding terug is en het scherm weer aan staat, en gaat daarna
  verder. In de wachtrij staat dan *wacht op verbinding…*.
- **Het scherm blijft aan** zolang de upload loopt (Screen Wake Lock). Dit voorkomt de
  onderbreking zelf. Kan de browser dit niet (Firefox, oudere Safari), dan gaat de upload gewoon
  door zonder.
- Boven de wachtrij staat *Laat dit scherm open tot alles klaar is.* Ga je op een telefoon naar
  een andere app, dan stopt Android het netwerk van de browser alsnog. De upload gaat daarna wel
  verder als je terugkomt.
- **Geen "Niet ingelogd." meer bij een haperend netwerk.** `currentUserId()` leest de gebruiker uit
  de sessie die de browser al heeft. Wie je bent, controleert de database bij elk verzoek toch al
  aan het token. Dat scheelt ook een netwerkverzoek per foto. Mislukt het verversen van een
  verlopen token door het netwerk, dan meldt de app een verbindingsfout. *Je bent niet meer
  ingelogd* verschijnt alleen als de sessie echt weg is.

### Als het toch misgaat, zie je wat je kunt doen

- **In gewone woorden:** *Geen verbinding. Controleer je internet en probeer het opnieuw.* Dit
  vervangt *Failed to fetch* (Chrome), *Load failed* (Safari) en *NetworkError…* (Firefox). Een
  foutpagina van Cloudflare (HTML) wordt *De server is even niet bereikbaar (fout 502)…*.
- **De rest stopt netjes.** Haalt een bestand na al zijn pogingen nog steeds geen verbinding, dan
  beginnen de bestanden die nog wachten er niet meer aan. Bij die bestanden staat *Niet
  geprobeerd: geen verbinding.* Eerst deed elk bestand dezelfde vergeefse poging.
- **Knop "Opnieuw proberen"** onder de wachtrij: *6 bestanden niet geüpload. [Opnieuw proberen]*.
  Hij stuurt alleen wat mislukte, naar dezelfde categorie. Je hoeft niets opnieuw te kiezen. De
  knop staat in het paneel én in het venster *Bestanden*.
- Een lange foutmelding loopt in de wachtrij terug op twee regels. Eerst drukte hij de
  bestandsnaam weg.

### Geen dubbele of kapotte foto's door een nieuwe poging

Het opslaan kan gelukt zijn terwijl het antwoord onderweg kwijtraakte. Een tweede poging kijkt
daarom eerst of de rij er al staat (`findGalleryItemByStorageKey`). Anders ging het zo mis:

1. de database weigerde de naam (*net kwam er een bestand met deze naam*);
2. daarna wiste het opruimen de bestanden in R2;
3. die bestanden hoorden bij een rij die wél bestond.

Blijft de verbinding helemaal weg, dan gooit de app niets weg in R2. Liever een los bestand, dat
weggaat met het album, dan een foto in het album zonder bestand.

### Ook verbeterd

- Na de upload ververst de galerij de kijk-tokens zonder daarop te wachten. Zonder verbinding bleef
  de upload anders *bezig*, en verscheen *Opnieuw proberen* niet.
- Bij het openen van een galerij laden de kijk-tokens los van de lijst. Die tokens proberen het nu
  opnieuw, en een storing bij de media-worker hield anders de hele galerij op *laden*. De bundel
  van de vorige galerij gaat eerst weg: tokens gelden per galerij.
- Grote video's in delen gebruiken dezelfde aanpak. Eerst probeerde een deel het vier keer, ook
  bij *geen toegang*. Nu probeert het alleen bij een verbindingsfout of serverstoring, en wacht het
  als het scherm uit is.
- Niet opnieuw geprobeerd: het aanvragen van een kijkkopie bij Cloudflare Stream. Kwam het eerste
  verzoek aan maar het antwoord niet, dan maakt een tweede een tweede kijkkopie, en die kost geld.

## Waar

| Bestand | Wat |
| --- | --- |
| `src/lib/networkRetry.ts` (nieuw) | verbindingsfouten herkennen, meldingen in gewone woorden, `withRetry`, wachten op verbinding |
| `src/lib/screenWakeLock.ts` (nieuw) | het scherm aanhouden tijdens een upload |
| `src/lib/gallery.ts` | elk verzoek naar de media-worker probeert het opnieuw (behalve de kijkkopie) |
| `src/lib/r2-api.ts`, `src/lib/repository.ts` | `getAccessToken` en `currentUserId` maken geen uitlog meer van een netwerkfout; `findGalleryItemByStorageKey` |
| `src/features/ProjectGallery.tsx` | de wachtrij: pogingen, stoppen, *Opnieuw proberen*, scherm aan |
| `src/styles/globals.css` | wachtrij met tip, teruglopende fout en knop |

`currentUserId()` wordt ook buiten de galerij gebruikt (opslaan van rijen via `insertRow`, uren,
instellingen, campagnes). Overal geldt nu hetzelfde: geen netwerkverzoek meer om te weten wie je
bent, en geen *Niet ingelogd.* bij een haperende verbinding.

## Getest

- `npm test`: 1875 geslaagd, 0 fout. Daarbij 14 nieuwe tests in `networkRetry.test.ts`:
  - Chrome, Safari, Firefox en supabase-js: hun verbindingsfouten worden herkend;
  - *geen toegang* en een dubbele sleutel zijn geen verbindingsfout;
  - opnieuw proberen alleen bij 408, 429, 5xx en de Cloudflare-fouten 520–524;
  - een poging met het scherm uit of zonder netwerk telt niet mee, en de upload gaat verder als
    je terug bent;
  - wachten op verbinding stopt na het maximum en ruimt zijn luisteraar op.
- `npm run typecheck`: schoon.
- De echte app in Chromium, op telefoonformaat (390×844), tegen de nagebootste backend van
  `tests/mobile`. Galerijtabellen en media-worker kwamen erbij in een los script.
  - **Verbinding weg midden in de upload** (8 foto's, offline bij het 7e verzoek):
    - de wachtrij toont *wacht op verbinding…*, geen enkel bestand mislukt;
    - na terugkomst zijn alle 8 klaar;
    - `/auth/v1/user` stond de hele tijd uit en werd tijdens de upload 0 keer gevraagd.
  - **Verbinding blijft dood** (6 foto's, de browser denkt dat hij online is):
    - na 67 seconden hebben 3 foto's *Geen verbinding. Controleer je internet…*;
    - de andere 3 hebben *Niet geprobeerd: geen verbinding.*;
    - *Opnieuw proberen* uploadt daarna alle 6.
  - **Opgeslagen, antwoord kwijt:** precies één rij, geen melding over een dubbele naam.
  - **Venster *Bestanden*, donker thema:** de knop staat er, en *Opnieuw proberen* uploadt beide
    foto's.
  - **Een galerij openen** met 8 foto's: de tegels laden met het token van die galerij. De eerste
    tegel laadt in deze nagebootste omgeving niet, ook zonder deze wijziging.
- `npm run test:mobile -- --theme=both`: zie de commit.
- **Niet getest:** een echte Android-telefoon met het scherm uit. Dat Chrome lopende verzoeken
  afbreekt als het scherm uitgaat (`ERR_NETWORK_IO_SUSPENDED`), komt uit Chrome zelf. Probeer het
  op staging met een album van een paar dozijn foto's, en zet halverwege wifi uit.

## Uitrollen

Via `staging`: Cloudflare Pages bouwt de app. Er is geen migratie, geen edge function en geen
worker.
