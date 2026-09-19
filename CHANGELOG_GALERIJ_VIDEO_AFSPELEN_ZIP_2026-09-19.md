# Galerij: video's afspelen en downloaden, ook als compleet album (2026-09-19)

## Aanleiding

Een geüploade video kon in de galerij niet worden afgespeeld zolang er geen
speelklare kijkkopie bij Cloudflare Stream was — zonder Stream-secrets, bij een
mislukte kopie of tijdens de verwerking toonde de kaart "Alleen downloaden".
Daarnaast liet de zip-download video's bewust weg: de CRC32-lus van de worker
zou bij tientallen gigabytes over de CPU-limiet lopen en een afgekapte zip
opleveren. De klant kon een album dus niet in één keer binnenhalen.

## Wat er is veranderd

### Afspelen

- **Master speelt rechtstreeks uit R2.** Zolang een video geen speelklare
  kijkkopie heeft, speelt de browser de master (originele resolutie) via een
  native `<video>` met poster en Range-ondersteuning. Zodra de kijkkopie klaar
  is, neemt de Stream-speler het over. De regel staat in
  `videoPlaybackSource` (`src/lib/galleryMedia.ts`): kijkkopie → `stream`;
  anders `source` of `master` uit R2 → `file`; anders niet afspeelbaar.
- **Browsercontainer als voorwaarde.** mp4/m4v/mov/webm/mkv gaan naar de
  speler; wat de browser niet decodeert (ProRes, HEVC op Windows-Chrome)
  krijgt in de speler één melding met de downloadknop erbij, geen zwart vlak.
- **Badges op de kaart.** Speelt de master terwijl Stream nog werkt, dan staat
  "Kijkkopie wordt gemaakt…" in de hoek in plaats van over de afspeelknop.
  "Verwerkingsfout" en "Alleen downloaden" verschijnen alleen als er écht
  niets af te spelen valt.
- **Worker bewaakt het downloadrecht.** Met een kijk-token (downloads uit) is
  de master alleen inline op te halen als het item geen klare kijkkopie heeft
  (`masterWatchableInline`: één lookup op `gallery_items` per key, twee
  minuten gecachet). Met kijkkopie blijft de master achter het downloadrecht,
  zodat "downloaden uit" voor video betekenis houdt. `dl=1` vereist altijd een
  download-token, zoals voorheen.

### Downloaden

- **Per stuk** werkte al (knop op de video, origineel uit R2 of de
  MP4-rendition van Stream) en blijft zo.
- **Als album.** Video-masters zitten nu in de zip, in originele resolutie.
  Het menu rechtsboven biedt "Alles als zip", "Alleen de foto's" en "Alleen de
  video's" (`?media=photos|videos`), elk met aantal en grootte. De zip heet dan
  `<titel>.zip`, `<titel>-fotos.zip` of `<titel>-videos.zip`.
- **Grens.** Boven 150 GiB (`GALLERY_ZIP_MAX_BYTES`, in worker én frontend)
  weigert de worker met een 413 en staat de keuze in het menu uitgeschakeld.
  Video's die uitsluitend bij Stream staan (oude directe Stream-upload) blijven
  buiten de zip; het menu meldt hoeveel.

### Onder de motorkap

- **CRC32 vijf keer sneller.** Slicing-by-16 met 32-bits reads over het
  uitgelijnde deel van elke chunk: ~1,6 GB/s in plaats van ~330 MB/s (gemeten
  op 256 MB willekeurige data, node 22). Op een big-endian host valt de lus
  terug op byte-voor-byte.
- **CPU-plafond.** `limits.cpu_ms = 300000` in `workers/media-api/wrangler.toml`
  (top-level, staging en production) — het maximum op Workers Paid; standaard
  was 30 s.
- **Payload.** `client-portal` en `gallery-public` geven per item nu ook
  `content_type` en `size_bytes` mee. De viewer werkt ook zonder (oudere
  edge function): dan geen grootte in het menu en de extensie als aanwijzing
  voor afspeelbaarheid.
- **Pure helpers.** Afspeel- en zipregels staan in `src/lib/galleryMedia.ts`
  (geen React, geen env) met tests in `galleryMedia.test.ts`; de viewer
  re-exporteert `keyVariant` voor bestaande importeurs.

## Bestanden

| Laag | Bestand |
| --- | --- |
| Worker | `workers/media-api/src/index.ts` (handleGalleryFile, masterWatchableInline, crc32Update, handleGalleryZip), `workers/media-api/wrangler.toml` |
| Edge | `supabase/functions/client-portal/index.ts`, `supabase/functions/gallery-public/index.ts` (sanitizeGalleryItem) |
| App | `src/lib/galleryMedia.ts` (+ test), `src/lib/gallery.ts`, `src/features/GalleryViewer.tsx`, `src/features/ProjectGallery.tsx`, `src/features/portal/ClientPortal.tsx`, `src/features/PublicGalleryPage.tsx`, `src/lib/portalApi.ts`, `src/styles/globals.css` |
| Test | `tests/mobile/mock/publicdata.mjs` (video-master in de publieke galerij) |
| Docs | `GALLERY_SETUP.md` |

## Uitrollen

```bash
cd workers/media-api && npx wrangler deploy --env staging   # CPU-plafond + routes
npx supabase functions deploy client-portal gallery-public   # content_type + size_bytes
```

Daarna git push naar staging → Cloudflare Pages bouwt de frontend. Geen
migratie, geen nieuwe secrets, geen CSP-wijziging (`media-src` stond al toe
dat `<video>` uit `*.workers.dev` laadt).

## Verificatie

- `npm run typecheck`, `npm test` (incl. de nieuwe `galleryMedia.test.ts`),
  `npm run test:mobile -- --pages=public-gallery,project,portal`.
- Worker: `npx tsc --noEmit` en `npx wrangler deploy --dry-run --env staging`.
- Zip-schrijver: harnas dat dezelfde pomp als `handleGalleryZip` naar een
  bestand schrijft (vijf entries, waaronder een lege, een geforceerde
  zip64-entry en een niet-ASCII-naam, in onregelmatige chunks) en de uitkomst
  laat controleren door `zlib.crc32`, Python `zipfile.testzip()` en `unzip -t`.

## Rooktest op staging

1. Video uploaden zonder Stream-secrets → kaart met afspeelknop → speelt in de
   native speler, spoelen werkt.
2. Met Stream-secrets: "Kijkkopie wordt gemaakt…" in de hoek, master speelt
   intussen; na verwerking schakelt de kaart over op de Stream-speler.
3. Deellink met downloads **uit**: master speelt (geen kijkkopie) maar `dl=1`
   geeft 403; met een klare kijkkopie geeft ook de inline master 403.
4. Menu → "Alles als zip" met foto's én video's; `unzip -t` op de download.
5. "Alleen de foto's" / "Alleen de video's" → bestandsnaam met achtervoegsel.
