# BrandCore Werkruimte — v2.1.3 Organization user licensing

BrandCore v2.1.0 is een CRM/projectapp met React, TypeScript, Supabase en Cloudflare R2. Deze versie introduceert organisatie-accounts: data hangt niet langer direct aan één losse gebruiker, maar aan een organisatie/workspace waar meerdere gebruikers lid van kunnen zijn.

## Stack

- React 18 + Vite 5 + TypeScript
- Supabase Auth + Postgres + Row-Level Security
- Organisatie-tenancy via `organizations`, `organization_members` en `organization_invitations`
- Tenant-safe relationele integriteit via Postgres triggers
- Cloudflare R2 voor bijlagen via een Cloudflare Worker met Supabase JWT-validatie
- PDF-export voor offertes en facturen met uploadbare template via `pdf-lib`
- Google Calendar en Microsoft 365 agenda-integraties via Supabase Edge Functions

## Functionaliteit

- Magic-link login via Supabase Auth
- Organisatie-accounts met meerdere users per organisatie
- Rollen: `owner`, `admin`, `member`, `viewer`
- Organisatie-switcher in de sidebar
- Teamleden uitnodigen via e-mailadres
- Gebruikerslicenties per organisatie: actieve leden en geldige openstaande uitnodigingen verbruiken elk één seat
- Openstaande uitnodigingen beheren en intrekken
- Uitnodigingen accepteren na login met hetzelfde e-mailadres
- Rollenbeheer voor owners: owner/admin/member/viewer
- Server-side audit-log basis via `audit_logs` en Postgres triggers
- Sprint 1 dashboard met onboarding-checklist en laatste activiteit
- Klanten / Projecten / Taken / Tickets / Notities / Offertes / Facturen — CRUD
- Kanban met snelle status-wissel per taak
- Weekplanner met deadlines
- Subtaken en comments op taken
- Bijlagenbeheer per entity, inclusief download en delete
- PDF-export voor offertes en facturen, inclusief bedrijfsinstellingen en eigen PDF/PNG/JPG-template
- Google en Microsoft agenda-koppelingen binnen organisatiecontext
- Ticket → project conversie via atomaire Postgres RPC
- Projectarchief met hersteloptie
- RLS per organisatie + extra tenant-safe relationele checks op gekoppelde records
- Billing/service-role RPC om aangekochte seats na betaling te synchroniseren

## Nieuwe Supabase database installeren

Gebruik één bestand:

```text
supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql
```

Alternatief staat dezelfde setup ook in:

```text
supabase/BRANDCORE_DATABASE_SETUP.sql
supabase/schema.sql
```

Stappen:

1. Maak een nieuw Supabase project of gebruik een volledig lege database.
2. Open **SQL Editor → New query**.
3. Plak de volledige inhoud van `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`.
4. Klik **Run**.
5. Zet daarna Supabase Email/Magic Link auth aan.
6. Vul je `.env.local` met de Supabase URL en anon key.

Meer details staan in `DATABASE_SETUP.md`, `MULTI_TENANT_ORGANIZATIONS_REPORT.md`, `CALENDAR_INTEGRATION_SETUP.md` en `SPRINT1_FOUNDATION_REPORT_2026-04-29.md`.

## Lokale installatie

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Vul in `.env.local`:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
VITE_R2_WORKER_URL=https://resofly-media.YOUR_SUBDOMAIN.workers.dev
VITE_R2_PUBLIC_BASE_URL=
```

Laat `VITE_R2_PUBLIC_BASE_URL` leeg voor private CRM-documenten. Downloads gaan dan via de Worker met auth-check. Vul alleen een publieke URL in voor assets die echt publiek mogen zijn.

## Cloudflare deployment

Deze codebase bevat nu een aparte Cloudflare Worker/R2 deployment foundation in `workers/media-api`. Deze nieuwe Worker is bedoeld als veilige basis voor toekomstige private R2 uploads, downloads en deletes, maar bevat bewust nog géén Sprint 3-klantportaalfunctionaliteit.

Belangrijkste documentatie:

- `DEPLOYMENT_CLOUDFLARE.md` — volledige deploymenthandleiding voor GitHub, Cloudflare Pages, Cloudflare Workers, R2, Supabase, secrets, CORS en livegang.
- `workers/media-api/README.md` — Worker-specifieke setup, routes, scripts en benodigde secrets.

Basisflow:

```bash
cd workers/media-api
npm install
cp .dev.vars.example .dev.vars
npm run dev
npm run deploy:staging
npm run deploy
```

De Worker gebruikt private R2 buckets via de binding `MEDIA_BUCKET` en leest toegestane origins uit `ALLOWED_ORIGINS`. Echte secrets zoals `SUPABASE_SERVICE_ROLE_KEY` en `MEDIA_SIGNING_SECRET` moeten via Cloudflare secrets worden gezet en mogen niet in GitHub staan.

## Cloudflare R2 Worker

1. Maak een R2 bucket aan: `resofly-media-staging` (staging) of `resofly-media-production` (productie).
2. `cd cloudflare-worker`
3. `cp wrangler.toml.example wrangler.toml` en vul in:
   - `ALLOWED_ORIGIN` — comma-separated lijst van expliciet toegestane origins, bijvoorbeeld `http://localhost:5173` voor dev
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
4. `wrangler deploy`

De Worker valideert iedere request tegen Supabase, vereist `x-organization-id` bij uploads, genereert storage keys server-side met organisatieprefix en controleert lees-/schrijfrechten via `organization_members`.

## Supabase Edge Function voor agenda-integraties

Zie `CALENDAR_INTEGRATION_SETUP.md`. De calendar Edge Function is aangepast zodat OAuth-state, connections, tokens en sources organisatie-gescopeerd zijn.

## Scripts

```bash
npm run dev
npm run build
npm run preview
```

## Belangrijk voor productie

Deze codebase is bedoeld als nieuwe Sprint 1 baseline voor een lege Supabase database. Bij een bestaande BrandCore v2 database kun je `supabase/migrations/20260429_sprint1_workspace_foundation.sql` uitvoeren. Voor migratie van bestaande productiedata moet je een aparte migratiestrategie maken die oude `user_id`-records naar nieuwe `organization_id`-records mapt.

## Bestaande v2.1.2 database bijwerken

Als je al de vorige v2.1.2 licensing-code hebt uitgevoerd, draai dan aanvullend:

```text
supabase/migrations/20260430_organization_user_licensing_recheck.sql
```

Nieuwe/lege databases gebruiken gewoon het complete schema uit `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`.

## Sprint 2 — Billing, Mollie & licentiebeheer

Deze codebase bevat Sprint 2 voor BrandCore: organisatiebilling, SaaS-plannen, extra-seat checkoutvoorbereiding, Mollie Connect-basis, idempotente webhookverwerking en een nieuwe Billing & licenties-sectie in organisatie-instellingen.

Belangrijkste bestanden:

- `supabase/migrations/20260430_sprint2_billing_mollie_licensing.sql`
- `supabase/migrations/20260430_sprint2_mollie_connect_production_hardening.sql`
- `supabase/migrations/20260430_sprint2_mollie_connect_final_hardening.sql`
- `supabase/functions/billing/index.ts`
- `src/services/billingService.ts`
- `src/services/mollieService.ts`
- `src/services/licenseService.ts`
- `SPRINT2_BILLING_MOLLIE_LICENSING_REPORT_2026-04-30.md`
- `SPRINT2_TEST_REPORT_2026-04-30.md`
- `SPRINT2_MOLLIE_CONNECT_FINAL_HARDENING_REPORT_2026-04-30.md`

Fresh install:

1. Gebruik `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql` op een lege Supabase database.
2. Zet de Edge Function secrets uit `.env.example`.
3. Deploy `supabase/functions/billing`.

Bestaande database:

1. Draai alle eerdere migraties tot en met Sprint 1/licensing.
2. Draai daarna `20260430_sprint2_billing_mollie_licensing.sql`.
3. Draai daarna `20260430_sprint2_mollie_connect_production_hardening.sql`.
4. Draai daarna `20260430_sprint2_mollie_connect_final_hardening.sql`.
5. Deploy de billing Edge Function.

Lokale controle:

```bash
npm ci
npm run typecheck
npm run build
```
