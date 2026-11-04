# Galerij-oplevering — setup & deploy-runbook (2026-08-03)

Foto/video-oplevering per project: full-res in R2, snelle low-res weergave,
Netflix-achtige videorijen (Cloudflare Stream), klanttoegang via het portaal én
een publieke deellink met optionele pincode, favorieten, zip-download en
accountbrede opslagbundels (GB per abonnement, bijkopen via Mollie).

## Onderdelen

| Laag | Wat | Bestand |
| --- | --- | --- |
| DB | galleries / gallery_items / gallery_favorites + opslagquota-RPC's + opslagbundels | `supabase/migrations/20260803010000_gallery_module.sql` |
| Worker | upload/serve/zip/Stream/quota-routes | `workers/media-api/src/index.ts` |
| Edge | portaal-acties (getGalleryDetail, toggleGalleryFavorite) | `supabase/functions/client-portal` |
| Edge | publieke deellink (verify_jwt=false) | `supabase/functions/gallery-public` |
| Edge | opslagbundel bijkopen (createStorageAddonCheckout) | `supabase/functions/billing` |
| App | projecttab Galerij + beheer + upload | `src/features/ProjectGallery.tsx` |
| App | gedeelde viewer (app/portaal/deellink) | `src/features/GalleryViewer.tsx` |
| App | publieke pagina `/gallerij/<token>` | `src/features/PublicGalleryPage.tsx` |

## Secrets & env

### Media-api worker (per env: `--env staging` / `--env production`)

Bestaand (al gezet): `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_UPLOAD_SECRET`,
`MEDIA_SIGNING_SECRET` (wordt nu óók voor galerij-tokens gebruikt).

Nieuw voor **video via Cloudflare Stream** (optioneel — zonder deze vier valt
video automatisch terug op R2-afspelen, foto's werken sowieso):

```bash
cd workers/media-api
npx wrangler secret put STREAM_ACCOUNT_ID --env staging
npx wrangler secret put STREAM_API_TOKEN --env staging
npx wrangler secret put STREAM_SIGNING_KEY_ID --env staging
npx wrangler secret put STREAM_SIGNING_KEY_JWK --env staging
```

- `STREAM_ACCOUNT_ID`: Cloudflare-account-id (dashboard, rechtsonder op de Workers-overzichtspagina).
- `STREAM_API_TOKEN`: API-token met permissie **Stream: Edit** (My Profile → API Tokens → Create Token).
- Signing key aanmaken (eenmalig, antwoord verschijnt maar één keer):

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/stream/keys" -H "Authorization: Bearer <STREAM_API_TOKEN>"
```

  → `result.id` = `STREAM_SIGNING_KEY_ID`, `result.jwk` (base64) = `STREAM_SIGNING_KEY_JWK`
  (base64 direct plakken is prima; de worker decodeert zelf).

> Kanttekening (zie memory r2-eu-jurisdiction): Stream heeft net als R2 geen
> harde EU-opslaggarantie. Zelfde afweging als bij de rest van de media.

### Supabase edge functions (Dashboard → Edge Functions → Secrets)

- `MEDIA_WORKER_URL` — bestaat al voor meeting-transcribe; moet naar de
  media-api-worker wijzen (staging: `https://resofly-media-api-staging.gerjan.workers.dev`).
- `INTERNAL_UPLOAD_SECRET` — zelfde waarde als het worker-secret (bestaat al
  als de meeting-transcriptie werkt; valt anders terug op de PDF-storage-secrets).
- Origin-allowlist: `CLIENT_PORTAL_ALLOWED_ORIGINS`/`APP_PUBLIC_URL` dekken ook
  gallery-public; optioneel apart via `GALLERY_PUBLIC_ALLOWED_ORIGINS`.

### Frontend

Geen nieuwe envs; gebruikt bestaand `VITE_R2_WORKER_URL`.

## Deploy (staging)

```bash
npx supabase db push --yes
npx supabase functions deploy client-portal gallery-public billing
cd workers/media-api && npx wrangler deploy --env staging
```

Daarna: git push naar staging → Cloudflare Pages bouwt de frontend. De
CSP-wijziging in `public/_headers` gaat mee en is nodig voor drie dingen:
`media-src` (video uit R2), `frame-src` (Stream-speler) en `connect-src`
(`upload.videodelivery.net` + `*.cloudflarestream.com` — de browser uploadt
video's rechtstreeks naar Stream). Let op: `_headers` geldt alleen op Pages,
dus CSP-problemen zie je nooit lokaal — altijd op staging natesten.

## Rooktests

1. `curl https://resofly-media-api-staging.gerjan.workers.dev/health` → ok.
2. Edge-fn boot-health: POST zonder auth naar client-portal/billing → 401;
   gallery-public met onzin-token → nette 404-JSON (geen BOOT_ERROR).
3. In de app: project → tab Galerij → galerij aanmaken → foto's uploaden
   (previews verschijnen direct) → publiceren.
4. Deellink maken (met pincode) → incognito openen → pincode → favoriet
   markeren → hartje verschijnt live in de app (realtime).
5. Portaal: inloggen als contactpersoon → tab Galerijen → bekijken/downloaden.
6. Video uploaden: de master speelt meteen af uit R2 (native speler); met
   Stream-secrets verschijnt "Kijkkopie wordt gemaakt…" in de hoek en schakelt
   de kaart daarna over op de Stream-speler.
7. Zip-download: menu rechtsboven → "Alles als zip" (foto's én video's),
   "Alleen de foto's", "Alleen de video's"; opslagmeter in Instellingen →
   Abonnement.

## Grote video's: master in R2, kijkkopie in Stream (2026-08-03)

De klant **kijkt** via Cloudflare Stream en **downloadt** het origineel uit R2.
Dat onderscheid is nodig omdat Stream het bronbestand nooit teruggeeft ("You
cannot download the *exact* input file that you uploaded") en tot 1080p codeert
— voor een 4K-master is Stream dus alleen een kijkkopie.

**Eén upload, twee producten.** De browser zet de master in R2; daarna haalt
Stream hem daar zélf op via `POST /stream/copy`. De gebruiker uploadt dus niet
twee keer.

| Stap | Route | Wat |
| --- | --- | --- |
| 1 | `POST /gallery/multipart/create` | start multipart, geeft key + uploadId + partSize (64 MiB) |
| 2 | `PUT /gallery/multipart/part` | één part per request (auth + eigendomscheck per part) |
| 3 | `POST /gallery/multipart/complete` | sluit af, controleert de wérkelijke omvang |
| — | `POST /gallery/multipart/abort` | opruimen bij een fout; R2 ruimt zelf na 7 dagen op |
| 4 | `POST /gallery/stream-copy` | Stream haalt de master op met een key-gebonden token |

**Waarom 64 MiB parts:** een Cloudflare Worker accepteert maximaal ~100 MB
request body. De oude route `/gallery/upload` beloofde 4 GB maar liep in de
praktijk al bij ~100 MB tegen een Cloudflare-foutpagina aan; die route is nu
eerlijk gecapt op 64 MB en alles daarboven gaat via multipart. R2 eist verder
dat alle parts behalve de laatste even groot zijn, minimaal 5 MiB, maximaal
10.000 parts — 30 GB / 64 MiB = 480 parts.

**Grenzen:** video max **30 GB** (het plafond dat Stream standaard accepteert;
hoger kan via Cloudflare-support worden aangevraagd), foto max 4 GB.

**R2-varianten:** `master` = het originele videobestand (download én, zolang
er geen kijkkopie is, rechtstreeks afspelen), `source` = oude R2-fallbackvideo
(speelt direct af), `original` = full-res foto, `preview`/`thumb` =
weergavebestanden. De viewer leidt de variant af uit de key om te bepalen of
er een afspeelknop hoort te staan (`videoPlaybackSource` in
`src/lib/galleryMedia.ts`).

**Downloadkwaliteit** geldt alleen voor foto's. Een `master` is bereikbaar met
elk token dat downloaden toestaat — video's worden altijd in de originele
resolutie geleverd.

## Afspelen en downloaden zonder (klare) kijkkopie (2026-09-19)

**Afspelen.** Een geüploade video speelt meteen: zolang er geen speelklare
kijkkopie bij Stream is — Stream niet ingericht, de kopie mislukt, of nog in
verwerking — speelt de browser de master rechtstreeks uit R2 via een native
`<video>` (de worker ondersteunt Range-requests, dus spoelen werkt). Zodra de
kijkkopie klaar is, neemt de Stream-speler het over. Voorwaarde is een
container die browsers aankunnen (mp4/m4v/mov/webm/mkv); een codec die de
browser niet decodeert (ProRes, HEVC op Windows-Chrome) strandt in de speler
met een nette melding plus downloadknop.

De worker bewaakt het downloadrecht daarbij: met een **kijk-token** (downloads
uit) mag de master alléén inline worden opgehaald als het item geen klare
kijkkopie heeft (`masterWatchableInline`, één PostgREST-lookup per key, twee
minuten gecachet). Staat de kijkkopie er wél, dan blijft de master achter het
downloadrecht — anders was het kennen van de `storage_key` genoeg om het
origineel te halen. `dl=1` vereist altijd een download-token.

**Zip.** Video-masters zitten nu **wél** in de zip, in originele resolutie.
Het downloadmenu biedt "Alles als zip", "Alleen de foto's" en "Alleen de
video's" (`?media=photos|videos` op `/gallery/zip/<id>`), met de grootte erbij
zodra de payload `size_bytes` meegeeft (edge functions client-portal en
gallery-public sinds deze datum). Twee dingen maken dit mogelijk:

- de CRC32-lus in de worker is slicing-by-16 met 32-bits reads geworden
  (~1,6 GB/s in plaats van ~330 MB/s, gemeten op 256 MB);
- `limits.cpu_ms = 300000` in `wrangler.toml` (het maximum op Workers Paid;
  standaard was 30 s).

Boven `GALLERY_ZIP_MAX_BYTES` (150 GiB, in worker én `src/lib/galleryMedia.ts`)
weigert de worker met een 413 en staat de keuze in het menu uitgeschakeld;
daarboven download je per stuk. Alleen video's die uitsluitend bij Stream staan
(oude directe Stream-upload zonder master in R2) blijven buiten de zip; het
menu meldt dat.

**Kosten:** Stream rekent per **minuut** speelduur (bestandsgrootte telt niet
mee), R2 per **GB-maand**. Een master van 20 GB kost in Stream evenveel als een
webversie van 300 MB van dezelfde lengte; de GB's betaal je in R2.

## Beveiliging in het kort

- **Media-tokens** zijn HMAC-getekend, geldig voor precies één galerij en één
  uur; alle drie de weergaven vernieuwen automatisch. Ze dragen het
  downloadrecht én de downloadkwaliteit, en de worker dwingt dat af: met een
  kijk-token of webkwaliteit-token krijg je het full-res origineel niet, ook
  niet als je de storage_key kent.
- **Deellink**: 32 bytes entropie, alleen de SHA-256-hash staat in de database.
  De optionele pincode (6–8 cijfers) wordt gehasht met het token als zout en
  gecontroleerd via de RPC `gallery_verify_share_pin`, die de rij vergrendelt —
  8 foute pogingen zetten de link een kwartier op slot, ook bij een parallelle
  aanval.
- **Modulerechten**: de galerij-routes in de worker controleren naast
  lidmaatschap ook `module_access.projects`, zodat de service-role dezelfde
  grens respecteert als de RLS-modulegate.

## Opslagbundels

- Limiet per plan in `billing_plans.limits`: starter 50 GB / team 250 GB /
  pro 1000 GB, bundel = 100 GB (`storage_addon_gb`). Custom = geen limiet.
- Bundelprijs geseed op €5,00/maand en €50,00/jaar per 100 GB
  (`storage_addon_price_cents` / `storage_addon_yearly_price_cents`) —
  **pas gerust aan in de DB**; de migratie overschrijft bestaande prijzen niet.
- Handhaving: de worker weigert uploads (413, NL-melding) zodra
  gebruikt + upload > limiet; de meter waarschuwt vanaf 90%. Alles telt mee:
  bijlagen + documenten + meeting-opnames + galerij-items (incl. Stream-video's).
- Vrijgestelde organisaties (`billing_exempt`) hebben geen limiet.
