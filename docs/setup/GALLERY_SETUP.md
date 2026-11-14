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
| DB | weergave van het album (`galleries.layout`) + groot tonen (`gallery_items.featured`) | `supabase/migrations/20261104075000_gallery_layout.sql` |
| App | weergave-instellingen: standaard, herstel, stijlen | `src/lib/galleryLayout.ts` (kopie: `supabase/functions/_shared/galleryLayout.ts`) |
| App | rekenregels: rijen, waterval, raster, verhaal, afdrukken | `src/lib/galleryLayoutEngine.ts` |
| App | Instellingen → Weergave, met live voorbeeld | `src/features/GalleryLayoutSettings.tsx` |
| DB | opruimwachtrij voor R2 en Stream na verwijderen | `supabase/migrations/20261112170000_galerij_opruimen.sql` |
| Test | de echte worker: rechten, kijken, verwijderen, opruimen | `tests/stromen/werker-galerij.mjs` |

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

**Vorm van de key** (`workers/media-api/src/galleryKeys.ts`):
`{org}/gallery/{galerij}/{item}/{variant}-{uuid}/{naam}`. Een foto die op de
telefoon `yes.jpg` heet, staat dus als `…/original-{uuid}/yes.jpg`, met
`…/preview-{uuid}/preview-yes.jpg` en `…/thumb-{uuid}/thumb-yes.jpg` ernaast.
Items van vóór 14 november 2026 hebben nog `…/{item}/{variant}-{uuid}-{naam}`.
Worker en app lezen allebei de vormen. De variant komt altijd uit het deel dat
de worker schrijft, nooit uit de naam: daarop beslist de worker of een link het
origineel mag zien.

**De naam komt van de browser.** Op Android gaat die alleen mee als de
fotokiezer van Android dicht blijft: die geeft een nummer (`1000022523.jpg`).
Daarom gaan de uploadvelden van de galerij door `fileInputAccept`
(`src/lib/filePicker.ts`). Een nieuw uploadveld waarbij de naam ertoe doet,
hoort daar ook langs.

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

## Weergave van het album (2026-11-04)

Los van de opening (sjabloon + coverbeeld) kiest de beeldmaker onder Instellingen →
**Weergave** hoe het album eronder staat: een stijl, de indeling (rijen, waterval,
raster, verhaal, afdrukken), kolommen voor breed scherm en telefoon, de witruimte
(tussen de beelden, breedte van het album, tussen de hoofdstukken), de speelsheid,
de afwerking en de video's. Met **Groot tonen** wijst hij per foto aan wat een grote
plek krijgt. Details en ontwerpkeuzes: `CHANGELOG_GALERIJ_WEERGAVE_2026-11-04.md`.

- `galleries.layout = '{}'` is de standaardweergave, gelijk aan die van vóór deze
  instellingen. De trigger `galleries_layout_guard` laat alleen bekende sleutels en
  geldige waarden toe; de lijsten staan in de migratie tussen
  `layout-keuzes:begin` en `layout-keuzes:eind`, en `src/lib/galleryLayout.test.ts`
  vergelijkt ze met de app. Een nieuwe instelling = migratie, beide kopieën van
  `galleryLayout.ts` en de test, in één wijziging.
- `client-portal` en `gallery-public` geven de weergave alleen genormaliseerd mee.
- Gerrie: `gallery.update_settings` (layout_-velden) en `gallery.set_featured`.

## Verwijderen en opruimen in Cloudflare (2026-11-12)

Wat uit de database verdwijnt, verdwijnt ook uit R2 en Stream. Niet meer de
browser, maar de database legt vast wat er weg moet:

| Wat verdwijnt | Wat er in `gallery_purge_queue` komt |
| --- | --- |
| een album (ook via een verwijderd project of een verwijderde organisatie) | `folder`: de hele map `{organisatie}/gallery/{album}/` |
| een foto of video, terwijl het album blijft | `object`: zijn drie sleutels, als niets anders ze nog gebruikt |
| een ander of geen eigen coverbeeld | `object`: het oude coverbeeld |
| een video met een kijkkopie | `stream`: het id bij Cloudflare Stream |

De media-worker werkt de wachtrij af:

- **meteen**: de app roept na het verwijderen `POST /gallery/purge` aan
  (`{ organizationId, galleryId }`, JWT, schrijfrecht op Projecten). Is het album
  weg, dan veegt de worker ook direct de hele map, ook bestanden zonder rij;
- **elk kwartier**: de geplande taak van de worker (`[env.staging.triggers]` in
  `wrangler.toml`) voor wat de app niet deed: een tabblad dat dichtging, een
  verwijderd project, en de **tweede ronde** over een map een uur later (een
  upload die net vóór het verwijderen langs de controles kwam);
- zonder Stream-sleutels blijven `stream`-regels liggen tot Stream is ingericht.

Wie mag verwijderen, beslist de database (RLS + modulegate Projecten): alleen
een album van de eigen organisatie, door een eigenaar, beheerder of medewerker
met schrijfrecht op Projecten. De worker wist alleen onder de map van dat album
binnen de eigen organisatie, en een kijkkopie alleen als geen rij hem nog
gebruikt en de Stream-meta geen andere organisatie noemt.

Mislukt een poging, dan probeert de worker het later opnieuw (oplopend tot elke
twee uur). Na twintig pogingen blijft de regel liggen, met de fout in
`last_error`. Nakijken:

```sql
select kind, target, passes, attempts, last_error, purge_after
  from public.gallery_purge_queue order by created_at;
```

**Productie:** de geplande taak staat alleen bij staging. Zet hem bij productie
pas aan als die een eigen database heeft (actie 8). Anders werken twee workers
met elk een andere bucket dezelfde wachtrij af.

## Snelheid (2026-11-12)

- **Stabiele tokens.** De vervaltijd van een kijktoken rondt af op tien minuten.
  Open je een galerij binnen hetzelfde blok opnieuw, dan krijg je hetzelfde token
  en dus dezelfde URL's. De browser haalt de beelden dan uit zijn cache
  (`Cache-Control: private, max-age=<rest van het token>, immutable`). Eerst
  was elk token nieuw en downloadde de browser bij elke keer openen alles opnieuw.
- **Eén R2-aanroep per beeld.** Een gewone GET doet alleen nog `get()`; de `head()`
  vooraf bleef alleen over voor HEAD en voor een range (spoelen in een video).
- **Minder rondes naar Supabase.** Rol en modulerecht komen in één query; de
  controles op de creatieve module, het album en het opslagquotum lopen
  tegelijk. Bij een upload waren dat vijf of zes rondes na elkaar, nu twee.
  De kijksessie en de zip vragen album en items ook tegelijk op.

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
