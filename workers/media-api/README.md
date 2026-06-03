# BrandCore Media API Worker

Deze Cloudflare Worker is de veilige basislaag voor toekomstige private media- en documentbestanden in Cloudflare R2.

Dit is nadrukkelijk nog geen Sprint 3-klantportaalfunctionaliteit. De Worker bevat alleen de technische foundation voor deployment, CORS, R2-binding en uitbreidbare route-structuur.

## Wat deze Worker doet

- Biedt een `/health` endpoint voor deployment- en smoke-tests.
- Handelt `OPTIONS` preflight requests veilig af (geen wildcard-CORS; origins uit `ALLOWED_ORIGINS`).
- Slaat gebruikersuploads privé op in de `MEDIA_BUCKET` R2-bucket.
- Valideert de Supabase user-JWT via `/auth/v1/user` en autoriseert per organisatie­lidmaatschap (`organization_members`).
- Levert downloads geauthenticeerd terug (privé, `no-store`); deletes verwijderen het R2-object.
- Ondersteunt een intern, met een gedeeld secret beveiligd pad voor server-side factuur/offerte-PDF-snapshots.

## Routes

| Methode | Route | Auth | Omschrijving |
| --- | --- | --- | --- |
| `GET` | `/health` | — | Smoke-test |
| `OPTIONS` | `*` | — | CORS preflight |
| `POST` | `/upload` | Supabase JWT | Upload bijlage. Headers: `X-Organization-Id`, `X-Entity-Type`, `X-Entity-Id`, `X-File-Name`, `X-File-Type`, optioneel `X-Parent-Task-Id`. Body = bestand. Antwoord: `{ ok: true, key }` |
| `GET` | `/file/:key` | Supabase JWT | Download bijlage (key mag slashes bevatten) |
| `DELETE` | `/file/:key` | Supabase JWT | Verwijder R2-object |
| `POST` | `/internal/invoice-snapshot` | `INTERNAL_UPLOAD_SECRET` | Server-side PDF-opslag. Header `X-Storage-Key`, body = bytes |
| `GET` | `/internal/invoice-snapshot/:key` | `INTERNAL_UPLOAD_SECRET` | Server-side PDF-ophaal |

Toegangscontrole: de `:key` begint met `{organization_id}/…`; de Worker controleert dat de ingelogde gebruiker lid is van die organisatie voordat hij leest/verwijdert. Maximale uploadgrootte is 25 MB (in sync met `MAX_UPLOAD_BYTES` in `src/lib/r2.ts`).

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
# Vereist: validatie van de user-JWT + lidmaatschapscheck via Supabase REST.
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env production

# Vereist voor het interne PDF-snapshot-pad. Moet exact gelijk zijn aan de
# Supabase Edge Function secret INVOICE_PDF_STORAGE_SECRET (zie .env.example).
npx wrangler secret put INTERNAL_UPLOAD_SECRET --env staging
npx wrangler secret put INTERNAL_UPLOAD_SECRET --env production
```

Werk daarnaast in `wrangler.toml` de placeholder `SUPABASE_URL` per environment bij naar de echte projecturl, en zorg dat de R2-buckets (`resofly-media-staging` / `resofly-media-production`) bestaan. Stel in de frontend `VITE_R2_WORKER_URL` in op de gedeployde Worker-URL.

## R2 binding

De Worker verwacht deze binding:

```toml
[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "resofly-media-production"
```

Voor staging wordt `resofly-media-staging` gebruikt.

## CORS

Configureer toegestane origins via `ALLOWED_ORIGINS`, gescheiden door komma's.

Voorbeelden:

```text
http://localhost:5173
https://staging.brandcore.nl
https://app.brandcore.nl
```

Onbekende origins krijgen geen `Access-Control-Allow-Origin` header.
