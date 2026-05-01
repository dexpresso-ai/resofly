# BrandCore Media API Worker

Deze Cloudflare Worker is de veilige basislaag voor toekomstige private media- en documentbestanden in Cloudflare R2.

Dit is nadrukkelijk nog geen Sprint 3-klantportaalfunctionaliteit. De Worker bevat alleen de technische foundation voor deployment, CORS, R2-binding en uitbreidbare route-structuur.

## Wat deze Worker doet

- Biedt een `/health` endpoint voor deployment- en smoke-tests.
- Handelt `OPTIONS` preflight requests veilig af.
- Leest toegestane origins uit `ALLOWED_ORIGINS`.
- Gebruikt geen wildcard-CORS.
- Definieert de `MEDIA_BUCKET` R2-binding.
- Bereidt Supabase JWT-validatie, private uploads, downloads en deletes voor.

## Routes

| Methode | Route | Status |
| --- | --- | --- |
| `GET` | `/health` | Actief |
| `OPTIONS` | `*` | Actief |
| `POST` | `/upload/request` | Placeholder, geeft `501 Not Implemented` |
| `GET` | `/files/:fileId` | Placeholder, geeft `501 Not Implemented` |
| `DELETE` | `/files/:fileId` | Placeholder, geeft `501 Not Implemented` |

## Lokaal draaien

```bash
cd workers/media-api
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Controleer daarna:

```bash
curl http://localhost:8787/health
```

## Staging deployen

```bash
cd workers/media-api
npm install
npm run deploy:staging
```

## Productie deployen

```bash
cd workers/media-api
npm install
npm run deploy
```

## Benodigde secrets

Zet echte secrets nooit in GitHub, `wrangler.toml` of `.dev.vars.example`.

Benodigd via Cloudflare Dashboard of Wrangler secrets:

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
npx wrangler secret put MEDIA_SIGNING_SECRET --env staging
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env production
npx wrangler secret put MEDIA_SIGNING_SECRET --env production
```

## R2 binding

De Worker verwacht deze binding:

```toml
[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "brandcore-media-production"
```

Voor staging wordt `brandcore-media-staging` gebruikt.

## CORS

Configureer toegestane origins via `ALLOWED_ORIGINS`, gescheiden door komma's.

Voorbeelden:

```text
http://localhost:5173
https://staging.brandcore.nl
https://app.brandcore.nl
```

Onbekende origins krijgen geen `Access-Control-Allow-Origin` header.
