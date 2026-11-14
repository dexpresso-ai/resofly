# Changelog — Galerij: dubbele bestanden — 2026-11-14

## Aanleiding

> Bouw in de gallerij optie de check of er bestanden dubbel wordt geupload. Als dat zo is dient
> de gebruiker te kiezen wat er met dat bestand gedaan dient te worden. Overslaan of andere naam
> laten geven door resofly en toch uploaden.
>
> Bouw dit veilig, correct en functioneel goed in. Deployt direct naar staging als je klaar bent.

## Wat er mis was

Niets hield een dubbel bestand tegen. Wie dezelfde map nog eens uploadde, kreeg elk bestand twee
keer in het album:

- de klant zag dubbele foto's;
- de opslag telde ze dubbel;
- in de zip heetten ze ineens `IMG_0001_2.jpg`;
- een video van 20 GB stond al in Cloudflare voordat iemand iets kon zeggen.

Ook twee collega's (of twee tabbladen) die tegelijk uploadden, kwamen er allebei door.

## Wat er nu kan

Vóór het uploaden kijkt ResoFly wat er al in het album staat. Is een bestand dubbel, dan komt er
een vraag:

- **Eén dubbel bestand:** *Overslaan* of *Andere naam en uploaden*. De nieuwe naam staat er al
  bij ("Andere naam wordt `taart-2.jpg`"), zodat je weet waar je ja tegen zegt.
- **Meer dubbele bestanden:** per bestand *Overslaan* of *Andere naam*, met "Alles overslaan" en
  "Alles een andere naam" erboven. Er staat niets vooraf aangevinkt; de knop "Uploaden" werkt pas
  als elk bestand een keuze heeft ("Nog 3 te kiezen").
- **Annuleren**, het kruisje of Escape stopt de hele upload: er gaat niets naar Cloudflare.
  Klikken naast het venster doet niets; anders brak een misklik een upload van honderd foto's af.
- Bij elk bestand staat waarom het dubbel is: "even groot, waarschijnlijk hetzelfde bestand", "een
  ander bestand met deze naam", of "zit twee keer in wat je uploadt" (een gesleepte map met
  submappen).
- De andere bestanden gaan gewoon door. Daarna zegt de galerij wat er gebeurde: "1 dubbel bestand
  overgeslagen. 2 bestanden kregen een nieuwe naam."

Dat geldt voor alle manieren van uploaden: de knop Uploaden, slepen op het album, en slepen of
kiezen in het venster *Bestanden*. Daar staat de vraag bovenop het venster, en Escape sluit alleen
de vraag.

### Wat "dubbel" is

Dezelfde naam in hetzelfde album. Hoofdletters tellen niet mee (`IMG_0001.JPG` is
`img_0001.jpg`: bij uitpakken op een Mac of in Windows botsen die). Unicode wordt eerst
gelijkgetrokken: een Mac levert "é" soms als e + accent, en dan was `Café.jpg` voor de
vergelijking een ander bestand. In een ander album mag dezelfde naam gewoon.

### De nieuwe naam

`IMG_0001.jpg` wordt `IMG_0001-2.jpg`, en is die er ook al, `-3`, enzovoort. Met een streepje en
niet `(2)`: de worker maakt van haakjes en spaties een underscore, en dan stond er in de zip
`IMG_0001_2_.jpg`. Een nieuwe naam ontwijkt ook de bestanden verderop in dezelfde upload. Ook R2
en Stream krijgen de nieuwe naam.

## Hoe

### App

- `src/lib/galleryDuplicates.ts` (nieuw): herkennen, de vrije naam kiezen en het plan na de
  keuzes. Pure functies, met tests (`galleryDuplicates.test.ts`).
- `ProjectGallery.tsx`:
  - `handleFiles` haalt eerst vers uit de database wat er in het album staat
    (`selectGalleryItemNames`), want een collega kan het net hebben gevuld. Daarna vraagt hij, en
    pas dan uploadt hij. Lukt dat ophalen niet, dan gebruikt hij wat het scherm al heeft.
  - `GalleryDuplicatesDialog` is de vraag. Gaat het album dicht terwijl de vraag openstaat, dan
    stopt de upload. Anders bleef hij eeuwig wachten en kon er geen upload meer.
  - `insertGalleryItem`: weigert de database de naam toch (iemand pakte hem tijdens een lange
    upload), dan kiest hij bij *Andere naam* een volgend nummer. Hield het bestand zijn eigen
    naam, dan stopt hij met "Niet geüpload: net kwam er een bestand met deze naam in het album",
    en ruimt de bestanden in R2 op. Dan heeft niemand gekozen wat ermee moet.
  - De knop Uploaden in het paneel filtert nu net als slepen op het formaat van de galerij, en
    meldt wat er overgeslagen is.
- **Twee fouten onderweg rechtgezet:**
  - `selectGalleryItems` haalt nu in pagina's. PostgREST kapt af op 1000 rijen; een album van
    1500 foto's toonde er stil 1000, en de andere 500 zag de controle op dubbele bestanden niet.
  - De melding van het paneel en van het venster *Bestanden* had een klok die een volgende
    melding te vroeg wiste. Na Annuleren en meteen opnieuw uploaden was de nieuwe melding zo
    weer weg. Een nieuwe melding stopt nu eerst de oude klok.

### Database: `20261114150000_galerij_dubbele_namen.sql`

- Een trigger op `gallery_items` weigert een nieuwe naam die het album al heeft:
  - errcode 23505 en hint `gallery_items_file_name_taken`, zodat de app hem herkent;
  - een index op album + `lower(normalize(file_name, NFC))`, zodat de controle niet het hele
    album leest.
- **Twee tegelijk:** de trigger neemt een advisory lock per album, tot het einde van de
  transactie. Zonder die lock zagen twee gelijktijdige inserts elkaar niet; de test hieronder
  zette er dan twee rijen in.
- **Security invoker:** de controle ziet alleen wat de aanroeper mag zien. Een buitenstaander
  krijgt dus de gewone weigering en nooit "deze naam bestaat al". Anders kon hij raden welke
  bestanden er in andermans album staan.
- **Volgorde:** de trigger heet `zzzzz_…` en draait ná de rechtenpoorten. Wie niet mag
  schrijven, krijgt eerst die melding en neemt de lock nooit.
- **Geen unieke index:** er was geen controle, dus een album op staging kan al dubbele namen
  hebben. Een unieke index faalt dan, of we moeten eerst bestanden van klanten hernoemen. Dat
  doen we niet. Oude dubbele namen blijven staan en blijven bij te werken (een rij die zijn
  eigen naam houdt, wordt niet gecontroleerd). Er komen er alleen geen nieuwe bij.
- `EXPORT_SCHEMA_VERSION` gaat naar 20261114150000. Er kwamen geen tabellen of kolommen bij.

## Getest

- `npm run typecheck`: schoon. `npm test`: 1808 tests, 0 fout (11 nieuw in
  `galleryDuplicates.test.ts`).
- `supabase start` op een lege database: de hele keten van 278 migraties, daarna de nieuwe nog een
  keer. Geen fouten.
- `npm run test:stromen -- galerij-namen` (nieuw, 17 stappen, 0 fout), als echte gebruikers via
  PostgREST met RLS:
  - dezelfde naam, in andere hoofdletters, met spaties eromheen en in de andere Unicode-vorm:
    geweigerd met de hint;
  - in een ander album: mag. Hernoemen naar een bezette naam: geweigerd;
  - een rij die zijn naam meestuurt en een oud dubbel paar: blijven bij te werken en te verwijderen;
  - de server zonder RLS krijgt ook geen dubbele naam;
  - vijf inserts tegelijk geven één rij;
  - twee transacties waarvan de eerste nog openstaat: de tweede wacht en wordt geweigerd. **Met
    de functie zonder lock faalt deze stap**: dan staan er twee rijen. Zo weten we dat de test de
    race echt raakt;
  - een kijker, een boekhouder en een buitenstaander krijgen nooit "naam bestaat al". De
    buitenstaander krijgt voor een bestaande en een verzonnen naam hetzelfde antwoord;
  - de triggerfunctie is door anon en authenticated niet aan te roepen.
- `ui.mjs galerij` (nieuw, 6 stappen, 0 fout): de echte app in Chromium tegen de lokale stack,
  met de media-worker nagebootst in de browser:
  - één dubbel bestand: de vraag noemt de nieuwe naam, en er is niets geüpload vóór de keuze.
    *Andere naam* zet `taart-2.png` in het album, en R2 kreeg ook die naam;
  - *Overslaan*: alleen het nieuwe bestand komt erbij;
  - drie dubbel: uploaden kan pas na een keuze. Escape stopt alles: geen rij en geen upload erbij;
  - alles een andere naam en één overgeslagen: `taart-3.png` en `TAART-4.PNG`, met de juiste
    melding;
  - vanuit het venster *Bestanden*: de vraag ligt erbovenop, en Escape sluit de vraag maar niet
    het venster.
- Schermafdrukken bekeken in donker en licht, op desktop en op een telefoon van 390 px breed. Op de
  telefoon stonden de drie knoppen van de vraag scheef over twee regels. Nu staan ze onder
  elkaar, even breed, met de hoofdknop bovenaan.
- `npm run test:mobile -- --theme=both --pages=project,public-gallery,projects`: 18 metingen, 0
  met problemen. De volledige ronde (alle pagina's) liep in de cloudsessie langer dan 25 minuten
  en is daar afgebroken; niet gedraaid dus. De vraag zelf verschijnt pas bij een upload en is
  hierboven in de UI-test en op schermafdrukken bekeken.
- `npm run test:loading`: alle controles geslaagd.
- Na het samenvoegen met `staging` (de wijziging "een foto houdt de naam van de telefoon", die
  dezelfde uploadregels raakte): preview en thumb heten nu `derivedFileName(…, nieuwe naam)`.
  Daarna opnieuw typecheck, `npm test` (1815 geslaagd), `galerij-namen` en `ui.mjs galerij`: groen.

## Uitrol

Via `staging`: Cloudflare Pages bouwt de app, en de workflow *Deploy Supabase (staging)* zet de
migratie. De media-worker verandert niet. Volgorde maakt niet uit:

- de oude app met de nieuwe database: een dubbele upload faalt met de melding uit de database, in
  plaats van stil een tweede bestand te maken;
- de nieuwe app met de oude database: de vraag werkt, alleen de bewaking bij twee tegelijk
  ontbreekt nog.

### Uitgerold op 14 november (alleen staging)

- `staging` op `b4220e9`.
- **Database:** *Deploy Supabase (staging)* run 236 geslaagd: migraties gezet, edge functions
  uitgerold, rooktest geslaagd (ook "anon heeft geen rechten in public" en het boekhouder-hek).
- **Frontend checks** run 231 geslaagd, met wat in de cloudsessie niet lukte: de volledige mobiele
  lay-outtest in donker en licht. Verder typecheck, unit tests, laden per module,
  inrichtingsstappen, Deno-typecheck, en de migraties vanaf nul met "elk migratiebestand is
  toegepast".
- **App:** Cloudflare Pages bouwt `staging` zelf. De cloudsessie kan Cloudflare niet bereiken;
  niet nagekeken dat die build klaar is.
- Niet gedaan: op staging zelf kijken of er al dubbele namen in albums staan. De Management API
  was vanuit de sessie niet bereikbaar. Dat hoeft ook niet: oude dubbele namen blijven staan en
  hinderen de nieuwe regel niet.
