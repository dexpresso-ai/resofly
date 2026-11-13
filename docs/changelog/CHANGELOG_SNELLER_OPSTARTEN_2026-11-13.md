# Changelog: sneller opstarten (2026-11-13)

**De klacht:** elke keer dat je ResoFly opent, staat er eerst "ResoFly is aan het
laden…". Ook als je alleen de agenda opent. Op een telefoon start een
geïnstalleerde app bijna altijd opnieuw, dus dat wachten kwam elke keer terug.

## Waar de tijd zat

Gemeten op staging (`pg_stat_statements`, 13 november), en in Chromium met die
wachttijden nagebootst:

- **Vijf rondes na elkaar** voordat er iets in beeld kwam:
  `ensure_user_default_organization`, `getUser` (een vraag aan de
  auth-server), de lidmaatschappen, de rest van de organisatie, en pas dan de
  kern.
- **Twee trage vragen hielden alles op:**
  - het abonnementsoverzicht (`organization_billing_overview`): gemiddeld
    330 ms, soms bijna 5 s;
  - de telling van de af te letteren banktransacties: gemiddeld 490 ms, omdat
    de RLS de modulerechten per rij uitrekent.

  Allebei alleen nodig voor Instellingen → Abonnement en één tegel op het
  dashboard.
- **De agenda wachtte daarna nog eens** op alle uren (de groep `time`) en
  toonde zolang "Gegevens laden…".
- **De bundel van 4 MB** had geen cache-regel. De browser vroeg bij elke start
  aan de server of hij nog klopte, en wachtte op dat antwoord.

## Wat er nu anders is

### 1. Meteen de vorige stand, en op de achtergrond bijwerken

`src/lib/workspaceSnapshot.ts`. Na elke geslaagde laadronde bewaart de app op
het apparaat (IndexedDB) wat er in beeld stond:

- de organisatie, met je rol en modulerechten;
- de kern;
- de groepen die vers geladen waren.

Bij de volgende start staat dat er meteen. De app haalt intussen de nieuwe
stand op en zet die eroverheen. De groepen uit de bewaarde stand gelden als
verouderd: opent een pagina er een, dan toont hij wat er was en ververst hij
hem meteen. Dat is hetzelfde als bij een app die een uur open heeft gestaan.
Wijzigingen van collega's komen bij de eerste ronde binnen. Tot die klaar is,
staat op de knop Ververs "Laden…".

**Grenzen, en waarom:**

- **Alleen voor wie nu is ingelogd**, en alleen als het de organisatie is die
  de app gaat openen. Wat van een andere gebruiker in de browser staat, gaat
  bij de start weg.
- **Uitloggen wist alles** (`signOutOnThisDevice`). Ook als de sessie op een
  andere manier eindigt (verlopen, uitgelogd in een ander venster).
- **Een wissel van organisatie wist de bewaarde stand.** Die hoort dan bij een
  organisatie die niet meer opengaat.
- **Zijn je rechten veranderd** sinds wat er staat? Bijvoorbeeld omdat een
  beheerder Financiën voor je dichtzette. Dan gaan de groepen uit beeld en de
  bewaarde stand weg. Dit geldt nu ook bij een gewone ververs terwijl je
  werkt. Eerder bleef een geladen groep van een module die dichtging in het
  geheugen tot hij opnieuw werd opgehaald.
- **Alleen van dezelfde versie van de app** (`__RESOFLY_BUILD__`, de commit
  van Cloudflare Pages). Een nieuwe versie kan een veld verwachten dat in een
  oude stand ontbreekt. Dan zou het scherm omvallen voordat de nieuwe
  gegevens er zijn. Na een deploy duurt de eerste start dus weer even.
- **Hooguit twee weken oud.**
- **Elke groep in een eigen record.** Zo overschrijven de losse apps elkaars
  groepen niet: de agenda bewaart de uren, Financiën de boekhouding.
- **Alleen wat vers is, wordt bewaard.** Staat er nog alleen de stand van de
  vorige keer (de eerste ronde is nog niet klaar of mislukte), dan schrijft de
  app die niet terug alsof hij nieuw is. Hij behoudt zijn eigen datum.

**Wat dit betekent voor de gegevens op het apparaat:** klanten, taken en
facturen van de laatst geopende organisatie staan nu ook ná het sluiten van de
app in de browser, tot je uitlogt. Dezelfde browser bewaart al de sessie
waarmee je bij al die gegevens kunt. Wie het apparaat kan openen, kon er dus
al bij. Op een gedeelde computer: uitloggen, zoals voorheen.

### 2. Het laden zelf: van vijf rondes naar twee

- **De gebruiker komt uit de sessie** die de browser al heeft, in plaats van
  uit `getUser`. De database controleert het token bij elke vraag toch.
- **`ensure_user_default_organization` loopt naast de lidmaatschappen.** Alleen
  wie nog geen organisatie heeft, wacht erop en kijkt daarna opnieuw.
- **De organisatie en de kern tegelijk.** De kern van de organisatie die je
  laatst open had, gaat al op weg terwijl de organisatie laadt. Opent er toch
  een andere (je bent er geen lid meer van), dan vervalt die vraag. De RLS gaf
  toch alleen wat van jou is.
- **Het abonnementsoverzicht en het logboek komen na het eerste beeld**
  (`loadOrganizationExtras`). Bij een ververs blijft de vorige stand staan tot
  de nieuwe er is. De tegel met het logboek is dus niet steeds even leeg. Bij
  een organisatie die nog wordt ingericht, wacht de app er wel op: daar
  beginnen de stappen bij het abonnement.
- **De twee tellingen voor het dashboard komen na de kern**
  (`loadAttentionCounts`). Het getal op de tegel verschijnt een tel later.

### 3. De melding pas als het wachten merkbaar is

"ResoFly is aan het laden…" verschijnt pas na 400 ms. Met de bewaarde stand
staat de werkruimte er meestal binnen een paar tientallen milliseconden na het
opstarten. Dan flitste de melding alleen even.

### 4. De bundel uit de cache

`public/_headers`: `/assets/*` krijgt `Cache-Control: public, max-age=31536000,
immutable`. Vite zet een hash van de inhoud in elke naam, dus een oude naam
verandert nooit. `index.html` haalt de browser wel elke keer op; zo komt een
nieuwe versie binnen.

## Gemeten

In Chromium tegen de nagebootste backend (`tests/mobile/mock`), met per vraag
90 ms netwerk plus de gemiddelde servertijd van staging. Agenda als open
tabblad. De dev-server zelf kost hier ~1,1–1,3 s aan JavaScript, ook zonder
netwerk.

| | werkruimte in beeld | agenda klaar | laadscherm |
| --- | --- | --- | --- |
| vóór, elke start | 2,7 s | 3,1 s | ja |
| na, eerste keer op een apparaat | 1,6 s | 2,0 s | ja |
| na, opnieuw openen | 1,1–1,6 s | gelijk met de werkruimte | nee |

Opnieuw openen kost nu even veel als zonder netwerk: er wacht niets meer op
de server.

## Bewaakt door

- `src/lib/workspaceSnapshot.test.ts`. Een stand komt alleen in beeld bij
  dezelfde gebruiker, organisatie en versie, en is niet te oud. Een kern
  waarvan de context een andere organisatie opent, telt niet. Een groep is
  heel of hij is er niet. Uitloggen wist de stand vóór de sessie weg is.
- `tests/laden`, sectie 9 (`npm run test:loading`):
  - de stand wordt bewaard;
  - opnieuw openen terwijl de server 2,5 s per vraag nodig heeft: de
    werkruimte en de agenda (met de uren) staan er voordat er één antwoord
    binnen is, zonder laadscherm, en daarna zijn de uren ververst;
  - de stand van een andere gebruiker is weg;
  - na het intrekken van Financiën is de bewaarde boekhouding weg;
  - na uitloggen is alles weg.

  Sectie 6 (een groep die nooit laadde) draait nu in een eigen browsercontext.
  Met een bewaarde stand is de groep er al, en dat is sectie 7.

## Wat nog kan

- **De bundel opsplitsen** (`import()` per pagina). 4 MB JavaScript lezen kost
  op een telefoon zelf ook tijd, vóór er iets in beeld kan.
- **De RLS van `bank_transactions`.** Die rekent `can_read_module` per rij uit.
  De telling staat nu buiten het opstartpad, maar de Bank-pagina betaalt het
  nog.
