# ResoFly

ResoFly is een werkruimte voor kleine (creatieve) bedrijven: klanten, projecten,
planning, agenda, tickets, offertes en facturen, boekhouding en btw, bank,
marketing, een klantportaal en Gerrie, de ingebouwde AI-assistent. Er is ook een
MCP-koppeling en een openbare API. Alles is per organisatie gescheiden (tenant)
en per teamlid per module af te schermen.

## Stack

- **App:** React 18, Vite 5, TypeScript. Draait op Cloudflare Pages.
- **Database en backend:** Supabase. Auth, Postgres met Row-Level Security, en
  39 edge functions (Deno) in `supabase/functions`.
- **Cloudflare Workers** in `workers/`:
  - `media-api`: bestanden op R2;
  - `email-inbound`: inkomende mail;
  - `caldav`: de agendaserver: agenda op de telefoon, en deellinks voor wie geen ResoFly heeft (`docs/setup/AGENDASERVER_SETUP.md`);
  - `office-server`: Word/Excel/PowerPoint in de browser.
- **AI:** Gerrie, de agents en de factuurherkenning praten met de Claude
  Messages API. Welk model: `supabase/functions/_shared/claudeModels.ts`.

## Lokaal draaien

```bash
npm ci
cp .env.example .env.local     # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, …
npm run dev
```

Een eigen database (Docker nodig): `supabase db start` bouwt een lege database op
uit alle migraties. Zie `supabase/migrations/README.md`.

## Een nieuwe omgeving

De database bouw je op uit de migraties. Er is geen los installatiebestand meer.

```bash
supabase link --project-ref <project-ref>
supabase db push
```

Daarna zet je per project eenmalig het volgende aan:

- `pg_cron` en `pg_net`;
- de edge functions;
- de secrets;
- `scripts/supabase-setup-webhooks.sh`.

Stap voor stap: `supabase/migrations/README.md`.

## Staging

- Een push naar `staging` bouwt de app op Cloudflare Pages.
- De workflow **Deploy Supabase (staging)** zet dan de migraties en de edge
  functions op het Supabase-project, en draait een rooktest.
- Met de hand vanaf een laptop: `docs/setup/SUPABASE_STAGING_LAPTOP.md`.
- Cloudflare (Pages, Workers, R2, secrets): `docs/setup/DEPLOYMENT_CLOUDFLARE.md`
  en `workers/media-api/README.md`.

> **Niet meer uitrollen: `cloudflare-worker/`.** Dat is de eerste versie van de
> bestandsworker, en hij mist de bewaking van `workers/media-api`:
> - een verwijderd teamlid houdt toegang;
> - een viewer leest bestanden van elke module;
> - vastgelegde PDF's zijn te verwijderen;
> - hij heeft geen `nosniff` en geen CSP-sandbox.
>
> Draait er nog een Worker `resofly-media` of `resofly-media-staging` uit die
> map? Verwijder hem dan. Laat `VITE_R2_WORKER_URL`, `MEDIA_WORKER_URL` en de
> `*_PDF_STORAGE_WORKER_URL`-secrets naar `resofly-media-api(-staging)` wijzen.
> Zie `docs/changelog/CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md`.

## Controles

Dit draait CI (`.github/workflows/frontend-checks.yml`) op elke pull request en
op `staging`:

| Opdracht | Wat |
| --- | --- |
| `npm run typecheck` | TypeScript van de app |
| `npm test` | unit-tests van de app en de edge functions (`*.test.ts`) |
| `npm run test:mobile -- --theme=both` | elke pagina op telefoon en tablet, tegen een nagebootste backend |
| `npm run test:loading` | laden per module: per pagina de juiste gegevens, bewaren, verversen |
| `npm run test:inrichten` | de inrichtingsstappen van een nieuwe organisatie, helemaal doorgeklikt |
| `deno check …` | de edge functions |
| `supabase db start` | alle migraties op een lege database |

## Hoe de app zijn gegevens laadt

Bij het opstarten komt alleen de kern binnen: klanten, projecten, taken,
offertes, facturen, en wat zoeken, de tabbladen en Gerrie gebruiken.

Vijf groepen tabellen die hard groeien, laden pas als een pagina ze nodig heeft:

- uren;
- communicatie;
- het verloop van offertes en facturen;
- boekhouding;
- bank.

Na een wijziging ververst de app de kern plus wat de open pagina gebruikt. Zie
`src/lib/dataGroups.ts`. Wie een nieuw scherm bouwt dat zo'n groep leest, zet
het daar in. Een test bewaakt dat.

## Documentatie

| Waar | Wat |
| --- | --- |
| `supabase/migrations/README.md` | de database: een nieuwe omgeving, nieuwe migraties |
| `docs/setup/` | inrichten per onderdeel (mail, betalen, bank, agenda, push, API, MCP, …) |
| `docs/changelog/` | wat er per wijziging veranderde, met de afwegingen |
| `docs/plannen/` | ontwerpvoorstellen, plannen en onderzoek |
| `docs/rapporten/` | test- en controlerapporten |
| `docs/API.md` | de openbare API, voor ontwikkelaars |
| `CLAUDE.md` | afspraken voor wie hier code schrijft, mens of AI |

Documenten zijn in november 2026 uit de root naar `docs/` verhuisd. Ze heten nog
precies hetzelfde, dus een verwijzing als "zie PUBLIC_API_SETUP.md" in de code
vind je op naam terug.
