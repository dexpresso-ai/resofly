# Changelog — Galerij: schermafbeeldingen tegengaan op de deellink, en de download gecontroleerd — 2026-11-14

## Aanleiding

> Zorg ervoor dat er op de albums waar de deellink op staat, dat bezoekers geen printscreen kunnen
> maken.
>
> Check of de bestanden in de download wel echt de full resolutie bestanden zijn.

## Schermafbeeldingen tegengaan

Op de deellinkpagina van een album (`/gallerij/<token>`, ook op een eigen klantadres) staat nu
een bescherming. Ze gaat aan zodra de foto's in beeld zijn. Het pinscherm heeft haar niet nodig.

### Wat de bezoeker merkt

| Wat hij doet | Wat er gebeurt |
| --- | --- |
| Mac: Cmd+Shift+3, 4 of 5 | Bij Cmd+Shift zijn de foto's al weg. De opname toont de melding *Beschermde galerij*. |
| Windows: Win+Shift+S | Hetzelfde. |
| Chromebook: Ctrl+Shift | Hetzelfde. |
| Windows: Print Screen | Het beeld is anderhalve seconde weg en het klembord wordt gewist (Chrome en Edge). |
| Knipprogramma, schermafbeeldingsbalk, een ander programma of een andere app openen | Zolang het venster niet actief is, zijn de foto's weg. Terugkomen, klikken of tikken brengt ze terug. |
| Rechtsklik op een foto (*Afbeelding opslaan als*) | Geen menu. |
| Een foto naar het bureaublad slepen | Gaat niet. |
| Lang drukken op een foto (iPhone: *Bewaar afbeelding*, Android) | Geen menu. |
| Ctrl/Cmd+S (pagina opslaan) | Gebeurt niet. |
| Afdrukken of *Opslaan als pdf* | Op papier staat alleen: "Deze galerij kan niet worden afgedrukt." |

In de pincode en de naamvraag werkt rechtsklikken gewoon, zodat plakken kan. Een klik in de
videospeler verbergt niets. Die speler is een iframe van Cloudflare Stream, en ook daarbij verliest
het venster de focus.

De bescherming staat ook aan als de klant mag downloaden. Hij krijgt het origineel via de knop. Een
schermafbeelding van de webversie, zonder de fotograaf erbij, hoort daar niet bij.

### Wat een webpagina niet kan tegenhouden

Een browser kan een schermafbeelding niet verbieden. De toetsen en knoppen daarvoor horen bij het
besturingssysteem. Dit blijft dus mogelijk:

- **Telefoons.** De knoppen van een iPhone of Android-telefoon melden niets aan de pagina. Daar
  helpen alleen de blokkades op lang drukken en opslaan.
- **Print Screen op Windows.** Windows meldt de toets pas als de opname al gemaakt is. Wissen van het
  klembord lukt alleen in Chrome en Edge. In Windows 11 opent Print Screen het knipprogramma, en dat
  kan het scherm al hebben vastgelegd voor de pagina het merkt.
- Een tweede scherm, een camera, of iemand die de ontwikkelaarstools van de browser gebruikt.

Wie ook dat wil tegenhouden, heeft een **watermerk** in de foto's nodig. Dat zit er nog niet in.

### Hoe

- `src/lib/screenshotGuard.ts` (nieuw): `installScreenshotGuard` luistert naar toetsen, focus,
  rechtsklik en slepen. Het verbergen loopt via de klasse `pgal-shielded` op `<body>`, rechtstreeks
  in de handler en dus buiten React om. Zo is het scherm in de volgende frame dicht, vóór de 3 of 4
  van Cmd+Shift+3/4 valt.
- `src/features/PublicGalleryPage.tsx`: zet de bescherming aan zodra de galerij in beeld is, en
  toont de melding *Beschermde galerij*.
- `src/styles/globals.css`: de melding, het verbergen, en de regels voor lang drukken, slepen en
  afdrukken.

## De download: krijgt de klant het volledige bestand?

**Ja, als bij het album *Originele bestanden (full-res)* gekozen is.** Dat is de standaard. Wat de
klant downloadt, is byte voor byte het bestand dat geüpload is. Dezelfde resolutie, dezelfde
kwaliteit en dezelfde EXIF-gegevens.

### Nagelopen

- **Uploaden** (`ProjectGallery.tsx`, `uploadOne`): het bestand van de computer of telefoon gaat
  ongewijzigd naar R2, als variant `original`. Alleen de preview (2560 px) en de miniatuur (1200
  px) maakt de browser zelf, en die staan apart.
- **De media-worker** (`/gallery/upload`, `/gallery/multipart/*`): zet de bytes zoals ze binnenkomen
  in R2. Er zit niets tussen dat schaalt of comprimeert.
- **Eén bestand downloaden** (`PublicGalleryPage.tsx`, `downloadItem`): bij originele kwaliteit de
  `storage_key`, dus het origineel. Bij webkwaliteit de preview van 2560 px.
- **De zip** (`handleGalleryZip`): zonder compressie (*store*). Elk bestand gaat er ongewijzigd
  in: foto's als origineel (of als preview bij webkwaliteit), video's altijd als master.
- **Rechten**: het token voor een deellink krijgt downloadrecht en kwaliteit uit het album zelf. Bij
  *webkwaliteit* of *downloaden uit* weigert de worker het origineel, ook als iemand de sleutel kent.

### De albums in de werkruimte

| Album | Foto's/video's | Formaat bij uploaden |
| --- | --- | --- |
| Test (AI Value Engine) | 4 foto's | 5131×3421 tot 6011×4007, 8–10 MB |
| Gerjan (Nieuwe video) | 3 foto's | 5472×3648, 6–8 MB |
| Test (Nieuwe app) | 2 video's | 2160×3840 (4K), 84–216 MB |
| **Test 3** (Ankie & Berry) | 6 foto's | **lange kant 1699 tot 2048 px (zoals 1168×1752), 129–295 KB** |

De maten zijn gemeten op het bestand dat bij het uploaden binnenkwam, en de grootte is die van het
origineel in R2. De foto's in **Test 3** waren dus al zo klein toen ze geüpload werden, bijvoorbeeld
als webexport of nadat ze via WhatsApp waren gestuurd. ResoFly heeft ze niet verkleind. Wil je ze in
volle resolutie leveren, upload dan de originelen van de camera of de bewerkingssoftware opnieuw.

Twee uitzonderingen staan los van deze controle:

- Een album op *Webkwaliteit* levert bewust de preview van 2560 px.
- Video's uit de oude, directe upload naar Cloudflare Stream, zonder master in R2. Daar is de
  download de MP4 van Stream, want Stream geeft het bronbestand niet terug.

## Getest

- `npm test`: alle 1875 tests geslaagd. Nieuw:
  - `workers/media-api/src/galleryDownload.test.ts` draait de echte worker met een nagebootste R2 en
    Supabase. De tokens komen langs dezelfde weg als op de deellinkpagina. Gecontroleerd:
    - de downloadknop en de zip leveren byte voor byte het origineel en de video-master, met
      kloppende CRC;
    - bij webkwaliteit bevat de zip de preview en blijft het origineel dicht;
    - met downloaden uit is er geen origineel en geen zip.
  - `src/lib/screenshotGuard.test.ts`: de toetsen, het loslaten, Print Screen met het klembord,
    blur en focus, een tik zonder focus-event, het iframe van de videospeler, rechtsklik in en
    buiten een veld, en het opruimen.
- `npm run typecheck`: schoon.
- De echte app in Chromium met de nagebootste backend, op `/gallerij/demo-token`. Echte
  toetsaanslagen via Playwright, 19 controles geslaagd:
  - Cmd+Shift en Ctrl+Shift zetten het scherm dicht, en het gaat weer open na het loslaten;
  - Print Screen zet het scherm even dicht;
  - blur en focus;
  - rechtsklik, slepen en Ctrl+P geblokkeerd;
  - bij afdrukken geen foto's;
  - een klik in een iframe laat het beeld open;
  - geen JavaScript-fouten.
- `npm run test:mobile -- --theme=both --pages=public-gallery`: 6 metingen (telefoon, tablet en
  liggend, licht en donker), 0 problemen. De ronde over alle pagina's liep tegen de tijdslimiet van
  de cloudsessie (30 minuten) en is afgebroken. Alleen de deellinkpagina is veranderd.
- **Niet getest:** een echte Mac, Windows-pc en telefoon. Probeer op staging een schermafbeelding
  met Cmd+Shift+4 en met Win+Shift+S, en lang drukken op een foto op een iPhone.

## Uitrollen

Via `staging`: Cloudflare Pages bouwt de app. Geen migratie en geen edge function. De media-worker
is niet veranderd, alleen de test erbij.
