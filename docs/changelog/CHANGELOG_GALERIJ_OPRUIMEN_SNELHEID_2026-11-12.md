# Changelog — Galerij: verwijderen tot in Cloudflare, en sneller — 2026-11-12

## Aanleiding

> Controleer de gallerij functionaliteit of alles goed werkt. Ook de combinatie met Cloudflare.
> Maak hem efficiënt op snelheid. Ook wanneer er albums worden verwijderd dient dit ook op
> Cloudflare te zijn. Uiteraard ook weer een check dat men alleen eigen albums mag verwijderen.

## Wat er mis was

Staging zelf was schoon. De 57 galerijbestanden in R2 hoorden allemaal bij een rij, en er
ontbrak er geen. Dat kwam alleen doordat er nog weinig verwijderd was. Het opruimen hing op de
browser, en dat ging op vier manieren mis:

1. **Een album van een verwijderd project of een verwijderde organisatie bleef in Cloudflare
   staan.** De rijen verdwenen via `on delete cascade`, en daar kwam niemand langs R2 of Stream.
2. **Tabblad dicht = bestanden blijven staan.** De browser wiste na het verwijderen bestand voor
   bestand. Wat er niet aan toe kwam, bleef staan: onzichtbaar, maar wel betaald.
3. **Traag.** Per bestand een eigen verzoek met eigen controles. Een album van 2.000 foto's gaf
   6.000 verzoeken.
4. **Wezen.** Een upload die halverwege afbrak, liet een bestand in de map van het album achter
   zonder rij. De kijkkopie-markering van een video-master (`_stream-copies/…`) werd nooit
   opgeruimd.

En bij snelheid:

- **Elk keer openen downloadde alle miniaturen opnieuw.** Het kijktoken staat in de URL en
  verliep tot op de milliseconde, dus elke keer openen gaf nieuwe URL's. De browsercache hielp
  daardoor nooit.
- **Twee R2-aanroepen per beeld.** Eerst `head()` voor de grootte, dan `get()`.
- **Vijf of zes rondes naar Supabase na elkaar bij elke upload.** Rol, modulerecht (dezelfde
  rij, apart opgevraagd), creatieve module, album en quotum. Een foto is drie uploads.

Rechten bij verwijderen waren in orde: RLS (`can_write_org`) plus de modulegate op Projecten.
Wel meldde de app niets als een verwijdering door RLS werd tegengehouden. PostgREST geeft dan
nul rijen in plaats van een fout.

## Wat er nu is

### Database: `20261112170000_galerij_opruimen.sql`

- **`gallery_purge_queue`**: wat na een verwijdering weg moet. Drie soorten:
  - `folder`: de map van een verwijderd album;
  - `object`: één sleutel van een los item of een vervangen coverbeeld;
  - `stream`: een kijkkopie.

  RLS staat aan, zonder policy. Er staat een boekhouder-hek op en anon en authenticated hebben
  geen rechten. Een check-constraint dwingt de vorm van elke regel af: een sleutel valt altijd
  onder `{organisatie}/gallery/{album}/` van de regel zelf.
- **Triggers** vullen de wachtrij. `galleries` en `gallery_items` doen dat per statement, met
  een transitietabel, zodat een project met twintig albums één insert is. Een cover-update doet
  het per rij. Een sleutel die nog in gebruik is, of buiten de map van zijn album ligt, komt er
  niet in. De browser schrijft de sleutels zelf, en zo kost een rij die naar een ander album
  wijst dat album niets.
- Wie mag verwijderen, is niet veranderd: het blijft de database.

### Media-worker (`workers/media-api`)

- **`POST /gallery/purge`** (JWT, schrijfrecht op Projecten): werkt de wachtrij af voor één
  organisatie en eventueel één album. Is het album weg, dan veegt de route ook direct de hele
  map, met de wezen erbij. De creatieve module hoeft niet aan te staan: weggooien mag altijd.
- **Geplande taak** (`scheduled`, elk kwartier, alleen staging): de rest van de wachtrij. Daar
  valt ook de **tweede ronde** onder: een uur na de eerste veegt de taak een map nog eens, voor
  een upload die net vóór het verwijderen langs de controles kwam.
- **Opruimen zelf**:
  - R2 `list` en `delete` per duizend, met de markering van een master erbij;
  - een sleutel gaat pas weg als niets hem nog gebruikt;
  - een kijkkopie gaat alleen weg als geen rij hem gebruikt en de Stream-meta geen andere
    organisatie noemt.

  Mislukt een poging, dan probeert de taak het later opnieuw, oplopend tot elke twee uur. Na
  twintig pogingen blijft de regel liggen, met `last_error`.
- **Snelheid**:
  - **Stabiele tokens.** De vervaltijd rondt af op tien minuten. Opnieuw openen binnen
    hetzelfde blok geeft hetzelfde token en dus dezelfde URL's.
  - **Cache.** Een beeld krijgt `private, max-age=<rest van het token>, immutable`, nooit
    langer dan het token geldt.
  - **Eén R2-aanroep per gewone GET.** `head()` alleen nog bij HEAD en bij een range.
  - **Eén query voor rol en modulerecht** (`galleryMemberAccess`). Creatieve module, album en
    quotum lopen tegelijk (`Promise.allSettled`). De uitkomsten worden in de oude volgorde
    getoetst, dus een buitenstaander krijgt dezelfde melding als altijd en nooit iets over een
    album dat hij niet mag zien.
  - **Ook tegelijk:** kijksessie, interne tokens en zip vragen album en items tegelijk op.
    Stream-tokens worden tegelijk getekend.

### App

- `deleteGalleryRecord` (`src/lib/repository.ts`): verwijdert een album of item en meldt het
  als er niets is verwijderd. Tekst: "Dit album is niet verwijderd. Het bestaat niet meer, of je
  mag het niet verwijderen."
- `ProjectGallery.tsx` roept na verwijderen van een album, item of coverbeeld
  `purgeGalleryStorage` aan, en wacht niet op het antwoord. Een worker zonder de nieuwe route
  (404 "Route not found") valt terug op de oude manier, met de sleutels die de app heeft. Een
  album dat dicht staat, wordt niet meer helemaal ingeladen alleen om het te verwijderen.

## Getest

- **`tests/stromen/werker-galerij.mjs` (nieuw, 31 stappen, 0 fout).** De echte worker in
  wrangler dev tegen de lokale stack met alle migraties. Getoetst:
  - uploaden en kijken per rol, en niet bij de buren;
  - hetzelfde token bij twee keer openen, en de cache-instelling;
  - range, HEAD en 416, en de zip;
  - verwijderen door buren, kijker, boekhouder en wie Projecten alleen leest of niet heeft:
    er verandert niets;
  - opruimen door de buren, ook met hun eigen organisatie en via `/file`: er verdwijnt niets
    van ons;
  - een foto, een coverbeeld en een album verwijderen: alles weg uit R2, ook de wees;
  - de tweede ronde met een bestand dat pas na het verwijderen landde;
  - een verwijderd project via de geplande taak;
  - een rij die naar het bestand van een ander album wijst;
  - een kijkkopie zonder Stream-sleutels.
- **`tests/stromen/werker-documenten.mjs`:** 16 stappen, 0 fout. Met `COLLABORA_URL` in de
  lokale config. Zonder die waarde faalt één stap, ook op de code van vóór deze wijziging; dat
  staat nu in de README.
- **In de browser:** de app tegen de lokale stack en de lokale worker:
  - een kijker ziet geen Instellingen en geen Verwijderen;
  - een medewerker verwijdert een album met de knop: rij weg, `/gallery/purge` 200, 0 van 6
    bestanden nog in R2, geen fouten in de pagina;
  - de beelden laden met de nieuwe cache-instelling.
- `npm test`: 1689, 0 fout. `npm run typecheck` en `tsc` in `workers/media-api`: schoon.
- `npm run test:mobile -- --theme=both --pages=project,public-gallery,projects`: 18 metingen,
  0 met problemen.
- `supabase start` met de hele keten op een lege database (Postgres 17.11.0.018), daarna de
  migratie nog een keer: geen fout. `accountant_fence_gaps()` is leeg.

## Uitrol

- Database en app: via `staging` (de workflow *Deploy Supabase (staging)* en Cloudflare Pages).
- Media-worker: `npx wrangler deploy --env staging` vanuit `workers/media-api`. Daarmee komt ook
  de geplande taak. De nieuwe worker werkt met de oude app en de oude app met de nieuwe worker:
  de volgorde van uitrollen maakt niet uit.
- **Productie:** zet de geplande taak pas aan als productie een eigen database heeft (actie 8).
  Zie `docs/setup/GALLERY_SETUP.md`.

### Uitgerold op 12 november (alleen staging)

- **`resofly-media-api-staging`, versie `adb41650`**, vanaf `staging` op `87fb348`. De geplande
  taak `*/15 * * * *` staat erbij, volgens de Cloudflare-API. De secrets van de worker waren
  er al; alleen de namen bekeken. Van Stream staat er nog steeds alleen `STREAM_ACCOUNT_ID`,
  dus video loopt op staging via R2 en `stream`-regels blijven liggen tot Stream is ingericht.
- **Database:** *Deploy Supabase (staging)* run 228 geslaagd, met de rooktest. De migratie
  `20261112170000` staat erop, de drie triggers ook, en de wachtrij is leeg. Opgevraagd via
  de Management API, alleen lezen.
- **App:** Cloudflare Pages heeft `87fb348` gebouwd en uitgerold.
- **Vooraf:** R2 (`resofly-media-staging`) naast de database gelegd. 57 galerijbestanden,
  alle 57 met een rij, geen wezen. Er viel op staging dus niets in te halen.
- Niet gedaan: de worker live aanroepen. De proxy van de cloudsessie laat `*.workers.dev`
  niet door. Probeer daarom in de app een testalbum te verwijderen; daarna moeten de
  bestanden binnen een kwartier ook uit `resofly-media-staging` weg zijn.
