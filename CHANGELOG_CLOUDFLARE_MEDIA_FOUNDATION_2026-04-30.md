# Changelog — Cloudflare Media API deployment foundation — 2026-04-30

Deze wijziging voegt alleen een Cloudflare Worker/R2 deployment foundation toe. Er is géén Sprint 3-klantportaalfunctionaliteit toegevoegd.

## Toegevoegd

- `workers/media-api/src/index.ts`
  - TypeScript Cloudflare Worker entrypoint.
  - `GET /health` endpoint.
  - Veilige `OPTIONS` preflight-afhandeling.
  - Placeholder-routes voor toekomstige private upload/download/delete flows.
  - Helperfuncties voor JSON responses, error responses, CORS, origin-validatie en routing.

- `workers/media-api/wrangler.toml`
  - Worker naam `brandcore-media-api`.
  - `MEDIA_BUCKET` R2 binding.
  - Staging- en production-configuratie.
  - Alleen voorbeeldwaarden, geen secrets.

- `workers/media-api/package.json`
  - Scripts voor local dev, staging deploy, production deploy en typecheck.

- `workers/media-api/tsconfig.json`
  - Strict TypeScript-configuratie voor Cloudflare Workers.

- `workers/media-api/.dev.vars.example`
  - Lokale voorbeeldvariabelen zonder echte secrets.

- `workers/media-api/README.md`
  - Korte Worker-specifieke uitleg en commando's.

- `DEPLOYMENT_CLOUDFLARE.md`
  - Deploymenthandleiding voor GitHub, Cloudflare Pages, Worker, R2, Supabase, CORS, secrets en livegang.

- `.gitignore`
  - Bescherming voor `.env`, `.env.*`, `.dev.vars` en `.dev.vars.*`.

## Aangepast

- `README.md`
  - Sectie toegevoegd met verwijzing naar de nieuwe Cloudflare deploymentdocumentatie en `/workers/media-api` Worker.

## Niet aangepast

- Geen bestaande frontendfunctionaliteit gewijzigd.
- Geen Supabase schema's of migraties gewijzigd.
- Geen billing/Mollie/licentiecode gewijzigd.
- Geen klantportaalfunctionaliteit toegevoegd.
