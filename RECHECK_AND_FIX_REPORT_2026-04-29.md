# BrandCore v2.0.0 — Recheck + fixes

Datum: 2026-04-29  
Rol: Senior Software Engineer + Senior Test Engineer

## Eindoordeel

De aangeleverde zip was niet staging-ready. De auditdocumenten beschreven dat de belangrijkste fixes aanwezig waren, maar in de daadwerkelijke codebase zaten die fixes nog niet volledig verwerkt. Daarnaast faalde de echte build-check door TypeScript strict-nullability errors.

Deze aangepaste codebase bevat fixes voor de gevonden blockers en is daarna succesvol gecontroleerd met:

- `npm ci --ignore-scripts --no-audit --no-fund`
- `npm run typecheck`
- `npm run build`
- syntactische transpilecontrole van alle `.ts`/`.tsx` bronbestanden buiten `node_modules` en `dist`
- statische SQL-checks op de drie fresh/baseline schema’s

## Gevonden blockers in aangeleverde zip

### 1. Production build faalde

`npm run typecheck` en `npm run build` faalden op `src/main.tsx` omdat TypeScript `activeOrganization` als mogelijk `null` bleef zien binnen nested handlers.

Fix:

- Na de runtime guard wordt nu een non-null `activeOrg` constant gebruikt.
- Alle mutatiehandlers gebruiken `activeOrg.id`.

### 2. SQL fresh install was nog steeds kapot

In de daadwerkelijke schema’s stond `convert_ticket_to_project` nog met:

```sql
as $
...
$$;
```

Dat breekt een lege Supabase install.

Fix:

- `as $` is vervangen door `as $$` in:
  - `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
  - `supabase/schema.sql`
  - `supabase/BRANDCORE_DATABASE_SETUP.sql`
- De drie baselinebestanden zijn inhoudelijk identiek gehouden.

### 3. Organisatiecontext gebruikte nog geen gescheiden teamMembers

`OrganizationContext` had nog geen `teamMembers`, en `loadOrganizationContext()` haalde memberships niet expliciet alleen voor de huidige user op.

Fix:

- `OrganizationContext.teamMembers` toegevoegd.
- `loadOrganizationContext()` haalt nu eerst alleen memberships van de ingelogde user op.
- Actieve rol/schrijfrechten worden afgeleid uit de eigen membership.
- Teamleden worden apart opgehaald voor de actieve organisatie.
- Settings toont teamleden via `organizationContext.teamMembers`.

### 4. Frontend mutation hardening ontbrak nog

`insertRow()` en `updateRow()` stripten beschermde velden nog niet uit inkomende values.

Fix:

- `sanitizeMutationValues()` toegevoegd.
- Beschermde velden worden gestript:
  - `id`
  - `organization_id`
  - `created_by`
  - `created_at`
  - `updated_at`
- Toegepast op `insertRow()`, `updateRow()` en `upsertCompanySettings()`.

### 5. Immutable organization_id hardening ontbrak nog

De schema’s bevatten nog geen `prevent_organization_id_change()` hardening.

Fix:

- `prevent_organization_id_change()` toegevoegd.
- Triggers toegevoegd op app-data en calendar-tabellen.
- Extra migratie toegevoegd:
  - `supabase/migrations/20260429_recheck_hardening.sql`

### 6. Team member RLS was nog niet geschikt voor normale teamweergave

De policy was nog `members read by self or admins`, waardoor normale members/viewers niet het teamoverzicht konden zien.

Fix:

- Policy aangepast naar:
  - `members read by org members`
  - `using (public.can_read_org(organization_id))`
- Schrijven blijft beperkt via bestaande owner/admin/write policies.

## Testresultaten na fixes

```text
PASS npm ci
PASS npm run typecheck
PASS npm run build
PASS TS/TSX syntax/transpile check
PASS SQL baseline files identical
PASS SQL no lone as $ delimiter
PASS SQL convert_ticket_to_project uses as $$
PASS SQL prevent_organization_id_change present
PASS SQL immutable organization_id triggers present
PASS SQL organization_members team read policy present
PASS OrganizationContext includes teamMembers
PASS loadOrganizationContext filters own memberships by current user
PASS Settings uses teamMembers for team list
PASS insert/update/upsert sanitize protected fields
```

## Build-output

`npm run build` is succesvol afgerond. Vite geeft alleen een chunk-size waarschuwing door de bundelgrootte:

- JS bundle: circa 862 kB minified / 301 kB gzip

Dit is geen blocker voor staging, maar later wel een optimalisatiepunt via code-splitting.

## Niet live getest in deze sandbox

- Echte Supabase fresh install in een lege database.
- Echte RLS-tests met meerdere auth-users.
- Magic-link loginflow in browser.
- Cloudflare R2 upload/download/delete tegen echte bucket.
- Google/Microsoft OAuth callback en tokenrefresh met echte secrets.

## Advies

Deze aangepaste codebase is nu staging-ready voor infrastructuurtests. Productie-go pas geven na echte Supabase/RLS-, R2- en Calendar OAuth-smoke tests.
