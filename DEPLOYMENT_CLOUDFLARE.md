# Cloudflare deployment — BrandCore / ResoFly

Dit document beschrijft de technische deployment-foundation voor BrandCore/ResoFly via GitHub, Cloudflare Pages, Cloudflare Workers, Cloudflare R2 en Supabase.

Deze toevoeging bevat géén Sprint 3-functionaliteit. De Worker-routes voor uploads, downloads en deletes zijn bewust placeholders zodat de infrastructuur nu veilig staat, zonder klantportaalfunctionaliteit te introduceren.

## A. Architectuur

- **Cloudflare Pages** host de frontend-app.
- **Cloudflare Worker `media-api`** fungeert als veilige gateway voor toekomstige private R2-bestanden.
- **Cloudflare R2** bewaart klantbestanden in private buckets.
- **Supabase** blijft verantwoordelijk voor auth, database, RLS, billing- en licentiedata.
- **GitHub** is de broncode en deployment-flow voor staging en productie.

Aanbevolen request-flow voor toekomstige mediafunctionaliteit:

1. Frontend stuurt request naar `VITE_MEDIA_API_URL`.
2. Worker valideert later de Supabase JWT uit de `Authorization` header.
3. Worker controleert organisatie-/project-/file-autorisatie via Supabase.
4. Worker leest of schrijft naar private R2 via `MEDIA_BUCKET`.
5. Frontend krijgt alleen geautoriseerde JSON-responses of private file-streams terug.

## B. Branch-structuur

- `develop` = staging
- `main` = production

Aanbevolen flow:

1. Feature branch vanaf `develop`.
2. Pull request naar `develop`.
3. Automatische of handmatige deploy naar staging.
4. Smoke-tests uitvoeren.
5. Pull request of merge van `develop` naar `main`.
6. Production deploy uitvoeren.

## C. Cloudflare Pages

Koppel de GitHub repository aan Cloudflare Pages.

Instellingen:

```text
Build command: npm run build
Output directory: dist
Production branch: main
Preview/staging branch: develop
```

Frontend environment variables:

```text
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_MEDIA_API_URL=https://brandcore-media-api.your-subdomain.workers.dev
VITE_APP_ENV=production
```

Voor staging gebruik je aparte waarden:

```text
VITE_SUPABASE_URL=https://your-staging-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-staging-anon-key
VITE_MEDIA_API_URL=https://brandcore-media-api-staging.your-subdomain.workers.dev
VITE_APP_ENV=staging
```

## D. R2 buckets

Maak twee private R2 buckets aan:

```text
brandcore-media-staging
brandcore-media-production
```

Richtlijnen:

- Houd beide buckets private.
- Gebruik geen publieke R2-bucket voor klantbestanden.
- Laat publieke downloads later altijd via een gecontroleerde Worker-route of signed access-flow lopen.
- Structureer toekomstige object keys bij voorkeur per tenant en context:

```text
organizations/{organization_id}/projects/{project_id}/files/{file_id}/{safe_filename}
```

## E. Worker deploy

Worker-map:

```text
workers/media-api
```

Lokaal starten:

```bash
cd workers/media-api
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Staging deploy:

```bash
cd workers/media-api
npm install
npm run deploy:staging
```

Productie deploy:

```bash
cd workers/media-api
npm install
npm run deploy
```

## F. Worker secrets

Deze waarden zijn secrets en mogen niet in GitHub, `wrangler.toml` of `.dev.vars.example` staan met echte waarden:

- `SUPABASE_SERVICE_ROLE_KEY`
- `MEDIA_SIGNING_SECRET`

Zet ze via Cloudflare Dashboard of Wrangler:

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
npx wrangler secret put MEDIA_SIGNING_SECRET --env staging
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env production
npx wrangler secret put MEDIA_SIGNING_SECRET --env production
```

Gebruik voor lokale development alleen tijdelijke lokale waarden in `.dev.vars`. Commit dat bestand nooit.

## G. CORS

Toegestane origins worden ingesteld via `ALLOWED_ORIGINS`, gescheiden door komma's.

Aanbevolen origins:

```text
http://localhost:5173
https://staging.brandcore.nl
https://app.brandcore.nl
```

Gedrag van de nieuwe Worker:

- Geen wildcard-CORS.
- Alleen exact toegestane origins krijgen `Access-Control-Allow-Origin`.
- Onbekende origins krijgen geen permissieve CORS-header.
- `OPTIONS` preflight requests krijgen de standaard toegestane methodes en headers.

Ondersteunde CORS headers:

```text
Access-Control-Allow-Origin
Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

## H. Supabase koppeling

Gebruik gescheiden Supabase-projecten voor staging en productie:

- **BrandCore Staging**
- **BrandCore Production**

Waarom apart houden:

- Veiliger testen zonder productiedata te raken.
- Aparte auth-configuratie en callback-URL's.
- Aparte database, RLS, billing- en webhook-testdata.
- Duidelijke rollback- en releasecontrole.

Worker-configuratie:

```toml
[env.staging.vars]
SUPABASE_URL = "https://your-staging-project.supabase.co"

[env.production.vars]
SUPABASE_URL = "https://your-production-project.supabase.co"
```

De service-role key hoort alleen als Cloudflare secret ingesteld te worden.

## I. Livegang-checklist

[ ] GitHub repo bevat de laatste `develop` en `main` branches  
[ ] Cloudflare Pages is gekoppeld aan GitHub  
[ ] `develop` deployt naar staging  
[ ] `main` deployt naar production  
[ ] Frontend build command staat op `npm run build`  
[ ] Frontend output directory staat op `dist`  
[ ] Staging frontend gebruikt staging Supabase URL en anon key  
[ ] Production frontend gebruikt production Supabase URL en anon key  
[ ] `VITE_MEDIA_API_URL` wijst per omgeving naar de juiste Worker  
[ ] R2 bucket `brandcore-media-staging` bestaat en is private  
[ ] R2 bucket `brandcore-media-production` bestaat en is private  
[ ] Worker staging gebruikt `brandcore-media-staging`  
[ ] Worker production gebruikt `brandcore-media-production`  
[ ] Worker secrets zijn gezet via Cloudflare/Wrangler  
[ ] Echte secrets staan niet in GitHub  
[ ] `.dev.vars` en `.env` bestanden worden genegeerd  
[ ] `/health` werkt lokaal, op staging en op production  
[ ] CORS staat alleen open voor bekende origins  
[ ] Supabase staging en production zijn aparte projecten  
[ ] Rollback-procedure is bekend: vorige Cloudflare Pages deployment of Worker deployment terugzetten

## Worker smoke test checklist

[ ] Worker start lokaal met `npm run dev`  
[ ] `GET /health` geeft status `ok`  
[ ] `OPTIONS` request geeft correcte CORS headers  
[ ] Onbekende origin krijgt geen wildcard toegang  
[ ] Staging Worker gebruikt staging `ALLOWED_ORIGINS`  
[ ] Production Worker gebruikt production `ALLOWED_ORIGINS`  
[ ] `MEDIA_BUCKET` binding bestaat in staging  
[ ] `MEDIA_BUCKET` binding bestaat in production  
[ ] Secrets zijn niet aanwezig in GitHub  
[ ] `.dev.vars` staat in `.gitignore`  
[ ] `.dev.vars.example` staat wel in GitHub  
[ ] Worker deploy naar staging werkt  
[ ] Worker deploy naar production werkt  
[ ] Frontend `VITE_MEDIA_API_URL` wijst naar juiste Worker URL
