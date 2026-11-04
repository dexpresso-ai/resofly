# Smoke-test rapport — Cloudflare Media API deployment foundation — 2026-04-30

Deze smoke-test dekt uitsluitend de nieuwe Cloudflare Worker/R2 deployment foundation. Dit is geen Sprint 3-functionaliteit.

## Uitgevoerde controles

| Controle | Status | Opmerking |
| --- | --- | --- |
| Nieuwe map `/workers/media-api` aanwezig | Geslaagd | Structuur met `src`, config, package en README toegevoegd. |
| `GET /health` route aanwezig | Geslaagd | Retourneert JSON met `status: ok`, service en environment. |
| `OPTIONS` preflight aanwezig | Geslaagd | Geeft `204` met CORS headers. |
| Upload-route is placeholder | Geslaagd | `POST /upload/request` geeft bewust `501 Not Implemented`. |
| Download-route is placeholder | Geslaagd | `GET /files/:fileId` geeft bewust `501 Not Implemented`. |
| Delete-route is placeholder | Geslaagd | `DELETE /files/:fileId` geeft bewust `501 Not Implemented`. |
| R2 binding heet `MEDIA_BUCKET` | Geslaagd | Vastgelegd in `wrangler.toml` en `Env` interface. |
| Geen echte secrets in `wrangler.toml` | Geslaagd | Alleen voorbeeldwaarden aanwezig. |
| Geen echte secrets in `.dev.vars.example` | Geslaagd | Alleen placeholderwaarden aanwezig. |
| `.gitignore` beschermt `.env` en `.dev.vars` | Geslaagd | `.env.example` en `.dev.vars.example` blijven toegestaan. |
| CORS gebruikt geen wildcard | Geslaagd | Alleen exact toegestane origins krijgen `Access-Control-Allow-Origin`. |
| Root-documentatie toegevoegd | Geslaagd | `DEPLOYMENT_CLOUDFLARE.md` aanwezig en README verwijst ernaar. |

## Lokale typecheck

Niet volledig uitgevoerd in deze container, omdat de Worker-devdependencies (`wrangler`, `@cloudflare/workers-types`) niet geïnstalleerd zijn in de aangeleverde zip en er geen package-install is uitgevoerd. De Worker is wel statisch gecontroleerd op TypeScript-structuur, imports, exports, route-afhandeling en configuratieconsistentie.

Aanbevolen lokale verificatie na uitpakken:

```bash
cd workers/media-api
npm install
npm run typecheck
npm run dev
curl http://localhost:8787/health
```

## Te verifiëren in Cloudflare

[ ] R2 bucket `resofly-media-staging` bestaat  
[ ] R2 bucket `resofly-media-production` bestaat  
[ ] Worker secret `SUPABASE_SERVICE_ROLE_KEY` staat in staging  
[ ] Worker secret `MEDIA_SIGNING_SECRET` staat in staging  
[ ] Worker secret `SUPABASE_SERVICE_ROLE_KEY` staat in production  
[ ] Worker secret `MEDIA_SIGNING_SECRET` staat in production  
[ ] Staging deploy werkt met `npm run deploy:staging`  
[ ] Production deploy werkt met `npm run deploy`  
[ ] Frontend `VITE_MEDIA_API_URL` wijst naar de juiste Worker URL
