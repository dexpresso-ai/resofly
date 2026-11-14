# Changelog — Galerij: een foto houdt de naam van de telefoon — 2026-11-14

## Aanleiding

> Ik wil dat wanneer gebruiker een foto als (yes.jpg) op de telefoon heeft staan, deze ook
> wordt getoond als yes.jpg als original en preview-yes.jpg bijvoorbeeld.

Een foto `yes.jpg` werd in R2:

- origineel: `…/{item}/original-3f2a…-yes.jpg`;
- preview: `…/{item}/preview-91c0…-preview-yes.jpg.jpg`;
- thumb: `…/{item}/thumb-b7e4…-thumb-yes.jpg.jpg`.

Die namen zag je ook buiten R2:

- Wie een foto opende en bewaarde, of lang drukte op de telefoon, kreeg het laatste deel van de
  sleutel als bestandsnaam.
- Een klant die in webkwaliteit downloadde, kreeg `preview-yes.jpg.jpg`. De app plakte `.jpg`
  achter de hele naam.
- Een naam met spaties kwam opgeschoond terug: `IMG 0001.jpg` werd `IMG_0001.jpg`.

## Wat er nu klopt

| | Sleutel in R2 | Naam bij bewaren of downloaden |
| --- | --- | --- |
| origineel | `…/{item}/original-{uuid}/yes.jpg` | `yes.jpg` |
| preview | `…/{item}/preview-{uuid}/preview-yes.jpg` | `preview-yes.jpg` |
| thumb | `…/{item}/thumb-{uuid}/thumb-yes.jpg` | `thumb-yes.jpg` |
| video | `…/{item}/master-{uuid}/clip.mp4` | `clip.mp4` |

- Preview en thumb zijn altijd JPEG. Daarom krijgt `yes.heic` ook `preview-yes.jpg`
  (`derivedFileName` in `src/lib/galleryMedia.ts`). Dat geldt ook voor het coverbeeld.
- De naam voor bewaren en downloaden is de echte naam, met spaties en accenten. Alleen in de
  sleutel staat de opgeschoonde versie (`displayFileName` en `sanitizeFileName` in de worker).
- Ook bij inline weergave geeft de worker de naam mee (`Content-Disposition: inline;
  filename*=…`). Dat helpt ook de foto's van vóór vandaag: hun origineel bewaart nu als
  `yes.jpg`. Een oude preview heet nog `preview-yes.jpg.jpg`, zo staat hij opgeslagen.

## Waarom de variant en de uuid in de sleutel blijven

- **De variant** beslist wie het bestand krijgt. Een kijk-token of een link met webkwaliteit
  krijgt geen `original` (`handleGalleryFile`). De variant komt daarom uit een deel dat alleen de
  worker schrijft. Kwam hij uit de bestandsnaam, dan was een origineel dat `preview-x.jpg` heet
  voor iedereen met de link te downloaden, ook met "downloaden uit".
- **De uuid** houdt elke sleutel uniek, wat de app ook meestuurt. De browser mag een
  galerijbestand daardoor bewaren zonder het opnieuw te vragen (`immutable`). Zonder uuid hing dat
  af van een nieuwe item-id per upload, en die kiest de browser zelf. Kwam een bestand onder een
  bestaande sleutel, dan bleef het oude beeld in beeld.

Bestaande sleutels veranderen niet. `galleryVariantFromKey` (worker) en `keyVariant` (app) lezen
beide vormen: zes delen is nieuw, vijf delen is oud. Een bestandsnaam bevat nooit een schuine
streep, dus het aantal delen zegt welke vorm het is.

## Bestanden

- `workers/media-api/src/galleryKeys.ts`: nieuw. De vorm van de sleutel en het lezen van de variant.
- `workers/media-api/src/galleryKeys.test.ts`: nieuw. Draait mee in `npm test`.
- `workers/media-api/src/index.ts`: de upload (gewoon en in delen) gebruikt `galleryObjectKey` en
  bewaart de echte naam. `transferDisplayName` heet nu `displayFileName`, omdat de galerij hem ook
  gebruikt. De naam gaat nu ook mee bij inline weergave.
- `workers/media-api/tsconfig.json`: imports met `.ts` toegestaan, tests uitgesloten (zoals bij caldav).
- `src/lib/galleryMedia.ts`: `keyVariant` leest beide vormen. Nieuw: `derivedFileName`.
- `src/features/ProjectGallery.tsx`: foto, video-thumb en cover gebruiken `derivedFileName`.
- `docs/setup/GALLERY_SETUP.md`: de vorm van de sleutel.

## Getest

- `npm test`: 1804 geslaagd. Daarbij de nieuwe tests voor de sleutel:
  - een origineel dat `preview-yes.jpg` heet, blijft `original`;
  - oude sleutels lezen zoals voorheen;
  - een video met een nieuwe sleutel speelt zonder kijkkopie uit R2 af.
- `npm run typecheck`: schoon.
- `npx tsc --noEmit` in `workers/media-api`: schoon.
- `npm run test:mobile` niet gedraaid. Het scherm is niet veranderd, alleen de namen die de app
  meestuurt.

## Uitrollen

CI rolt de workers niet uit. Na de push naar `staging` bouwt Cloudflare Pages de app. Vanaf dan
heet de preview `preview-yes.jpg`. Pas als de media-worker uitgerold is, verandert de sleutel en
eindigt de URL op `yes.jpg`:

```bash
cd workers/media-api && npx wrangler deploy --env staging
```

Rol de worker pas uit als de app op staging staat. Andersom kan een app die nog in de browser
openstaat, de variant van een nieuwe video-sleutel niet lezen. Hij toont dan geen afspeelknop,
tot de pagina ververst.
