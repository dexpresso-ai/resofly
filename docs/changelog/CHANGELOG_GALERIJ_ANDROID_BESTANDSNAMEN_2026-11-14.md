# Changelog — Galerij: op Android de echte bestandsnaam — 2026-11-14

## Aanleiding

> Het uploaden van dubbele bestanden gaat nog steeds niet goed. Kijk naar de melding die ik bij
> heb gevoegd in de bijlage. Daarin zie je dus echt twee verschillende namen staan. En die namen,
> dat zijn niet de namen, hoe de bestanden heten van het apparaat waarin ik ze van heb geüpload.
> Dus in ResoFly moeten de bestandsnamen overeenkomen met hoe ze zijn genoemd op het originele
> device.

De vraag over dubbele bestanden op een Android-telefoon noemde `1000022523.jpg` en
`1000022522.jpg`. Op de telefoon hebben die foto's een andere naam.

## Wat er mis was

De app kreeg die namen al zo binnen. Het ging mis vóór ResoFly iets met het bestand deed:

- Het uploadveld van een fotogalerij vraagt `image/jpeg,image/png,image/webp`, een videogalerij
  `video/*`.
- Noemt het uploadveld alleen foto- en videotypes, dan opent Chrome op Android de fotokiezer van
  Android. Die geeft de echte naam niet door, maar een nummer: het id van de foto op de telefoon.
  Chrome beslist dit in `SelectFileDialog.java` (`isSupportedPhotoPickerTypes`).
- Het nummer kwam overal terecht: in het album, in R2, in de zip en in de vraag over dubbele
  bestanden.

De vorige aanpassing ("een foto houdt de naam van de telefoon", eerder vandaag) bewaart de naam
die de browser geeft. Op Android was dat dus al dat nummer.

## Wat er nu klopt

- Op Android opent de knop *Uploaden* de gewone bestandenkiezer van Android. Die geeft de echte
  naam door, bijvoorbeeld `20260512_101500.jpg`.
- De kiezer toont nog steeds alleen wat de galerij aanneemt (JPEG, PNG en WebP, of video).
- Dat geldt voor de drie uploadvelden van de galerij: het paneel, het venster *Bestanden* en het
  eigen coverbeeld. Het coverbeeld heet daarna `preview-<naam>.jpg`.
- Op de computer en op de iPhone verandert er niets. Daar ging de echte naam al mee.

### Hoe

`src/lib/filePicker.ts` (nieuw) voegt op Android één type toe aan het accept-attribuut:
`application/x-resofly-echte-bestandsnaam`. Geen enkel bestand heeft dat type.

- Het type is geen `image/` of `video/`. Chrome kiest dan niet voor de fotokiezer.
- Chrome geeft de lijst met types gewoon door aan de bestandenkiezer. Die toont dus alleen foto's
  van de goede soort.
- `application/octet-stream` werkt ook tegen de fotokiezer, maar daarmee filtert Chrome niets meer.
  Dan zie je in de kiezer ook pdf's en downloads.

### Wat je merkt op de telefoon

- In plaats van het fotoraster van Android krijg je de bestandenkiezer. Soms vraagt Android eerst
  met welke app je kiest. Hoe dat eruitziet, verschilt per telefoon.
- Meer foto's tegelijk kiezen kan ook in de bestandenkiezer: houd een foto lang ingedrukt, en tik
  dan de rest aan.

## Wat er niet verandert

- Foto's die al in een album staan, houden hun nummer als naam. Upload je dezelfde foto nu
  opnieuw, dan heet hij anders (de echte naam). De controle op dubbele bestanden kijkt naar de
  naam, en ziet hem dan niet als dubbel. Haal de oude met een nummer dus eerst weg.
- De logo-velden (Huisstijl, Inrichten) blijven zoals ze waren. Een logo wordt een afbeelding in
  de instellingen, en daar speelt de bestandsnaam geen rol.

## Getest

- `npm test`: 1861 geslaagd, 0 fout. Daarbij de nieuwe tests in `filePicker.test.ts`:
  - Chrome en Samsung Internet op Android: alleen foto- of videotypes krijgen het extra type;
  - het extra type is geen foto of video, en ook niet `application/octet-stream`;
  - een accept met al een ander type, of zonder accept, blijft gelijk;
  - de computer en de iPhone: niets verandert.
- `npm run typecheck`: schoon.
- De echte app in Chromium, met de nagebootste backend en een fotogalerij open. Het uploadveld in
  het paneel:
  - Android (Galaxy S9+): `image/jpeg,image/png,image/webp,application/x-resofly-echte-bestandsnaam`;
  - iPhone 13 en de computer: `image/jpeg,image/png,image/webp`.
- **Niet getest:** een echte Android-telefoon. Wat Chrome met het accept-attribuut doet, komt uit
  de broncode van Chrome (`SelectFileDialog.java`). Probeer het op staging met een paar foto's uit
  de camera.
- `npm run test:mobile` en `npm run test:loading`: niet gedraaid. Het scherm en het laden zijn
  niet veranderd, alleen het attribuut van een verborgen uploadveld.

## Uitrollen

Via `staging`: Cloudflare Pages bouwt de app. Geen migratie, geen edge function en geen worker.
