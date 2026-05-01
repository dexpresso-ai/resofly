# BrandCore v2.0.0 — Final codebase recheck

Datum: 2026-04-29  
Rol: Senior Software Engineer + Senior Test Engineer

## Eindoordeel

De aangeleverde zip `brandcore-webapp-v2-organizations-rechecked-fixed.zip` is door mij opnieuw gecontroleerd op de belangrijkste productie- en stagingrisico’s: organisatieaccounts, multi-user rechten, tenant-isolatie, Supabase SQL-schema, RLS, frontend-mutaties, R2-bijlagen, calendar-integraties en package/build-scripts.

Mijn oordeel: **staging-ready voor infrastructuurtests**.  
Mijn productieoordeel: **nog geen productie-go zonder echte Supabase/RLS-, R2- en Calendar OAuth-smoke tests**.

## Belangrijkste conclusie

De eerdere blockers zijn in de huidige zip daadwerkelijk verwerkt:

- `convert_ticket_to_project` gebruikt in de drie baseline SQL-bestanden correcte `as $$` delimiters.
- `OrganizationContext.memberships` bevat alleen memberships van de ingelogde gebruiker.
- `teamMembers` is apart beschikbaar voor teamweergave.
- `organization_id` is immutabel gemaakt via triggers.
- Frontend-mutaties strippen beschermde velden.
- Team member RLS past bij normale SaaS-teamlogica.

## Eigen statische hercontrole

Uitgevoerde statische checks: **76 / 76 PASS**.

### SQL / Supabase

- PASS SQL baselinebestanden inhoudelijk identiek
- PASS Geen losse `as $` delimiter
- PASS `convert_ticket_to_project` gebruikt `as $$`
- PASS `prevent_organization_id_change` aanwezig
- PASS Immutable `organization_id` triggers aanwezig voor app-data en calendar-tabellen
- PASS Tenant-integrity functies aanwezig voor project/client, task/project, tickets, notes, quotes, invoices, attachments en calendar token/source-relaties
- PASS RLS enabled op organizations, members, invitations, CRM-tabellen, finance-tabellen, attachments en calendar-tabellen
- PASS Teamleden leesbaar voor org-members
- PASS Viewer write uitgesloten via `can_write_org`
- PASS Laatste owner beschermd via `prevent_last_owner_change`
- PASS Calendar tokens bewust zonder directe policies; service-role Edge Function only

### Organisatieaccounts / multi-user

- PASS `OrganizationContext` heeft `teamMembers`
- PASS `loadOrganizationContext` filtert memberships op huidige user
- PASS Teamleden worden los geladen voor actieve organisatie
- PASS Settings gebruikt `organizationContext.teamMembers`
- PASS `canWrite` is logisch beperkt tot owner/admin/member
- PASS `canAdmin` is logisch beperkt tot owner/admin

### Frontend-mutaties en tenant-hardening

- PASS Protected mutation fields worden gestript
- PASS `insertRow` forceert `organization_id` en `created_by`
- PASS `updateRow` scopet optioneel op `organization_id`
- PASS `upsertCompanySettings` gebruikt sanitize-logica
- PASS `saveEdit` gebruikt een non-null `activeOrg.id`
- PASS Project aanmaken respecteert archiefkeuze
- PASS Handmatige ticketstatus `converted` wordt gesanitized
- PASS Attachment cascade ondersteunt subtasks

### R2 / attachments

- PASS Worker valideert Supabase JWT
- PASS Worker vereist organization/entity headers
- PASS Worker controleert org-write-access bij upload
- PASS Worker controleert entity ownership
- PASS Uploadlimiet en streamlimiet aanwezig
- PASS Private download/delete verloopt via Worker wanneer `VITE_R2_PUBLIC_BASE_URL` leeg blijft

### Calendar-integraties

- PASS Edge Function controleert organization membership
- PASS OAuth-state is signed en heeft expiry
- PASS Tokens worden versleuteld met AES-GCM
- PASS Write-role wordt server-side gevalideerd
- PASS Calendar-tabellen zijn organisatie-gescopeerd

### Package / structuur

- PASS `package.json` en `package-lock.json` aanwezig
- PASS `typecheck` script aanwezig
- PASS `build` script gebruikt `tsc` en `vite build`
- PASS Relatieve imports resolven statisch

## Buildstatus

De meegeleverde `RECHECK_AND_FIX_REPORT_2026-04-29.md` vermeldt dat de aangepaste codebase succesvol gecontroleerd is met:

- `npm ci --ignore-scripts --no-audit --no-fund`
- `npm run typecheck`
- `npm run build`
- syntactische transpilecontrole
- statische SQL-checks

In mijn huidige sandbox kon ik `npm ci` niet betrouwbaar opnieuw afronden, omdat dependency-installatie bleef hangen zonder bruikbare output. Daarom baseer ik mijn eigen aanvullende conclusie op statische broncode-, SQL-, RLS- en importcontroles, plus de meegeleverde buildrapportage.

## Wat is nog niet bewezen in deze sandbox

Deze punten vereisen echte infrastructuur:

1. Fresh install in een lege Supabase database.
2. Echte RLS-tests met minimaal drie gebruikers: owner, member, viewer.
3. Cross-organization negatieve tests.
4. Magic-link loginflow in browser.
5. Cloudflare R2 upload/download/delete tegen echte bucket.
6. Google/Microsoft OAuth callback, tokenrefresh en calendar event-write met echte secrets.

## Verplichte smoke tests voor staging

1. Voer `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql` uit op een lege Supabase database.
2. Draai lokaal of in CI:
   - `npm ci`
   - `npm run typecheck`
   - `npm run build`
3. Maak drie gebruikers aan:
   - owner
   - member
   - viewer
4. Test negatieve tenant-cases:
   - project met client uit andere organisatie moet falen
   - task met project uit andere organisatie moet falen
   - invoice met quote uit andere organisatie moet falen
   - attachment upload op entity uit andere organisatie moet falen
   - update van `organization_id` moet falen
5. Test R2 Worker private upload/download/delete.
6. Test Google/Microsoft Calendar OAuth met echte secrets.

## Advies

Breng deze codebase naar staging voor echte infrastructuurtests. De organisatie- en tenantlaag is modern en logisch opgezet: rollen, RLS, relationele tenant-integriteit en frontend-hardening werken samen. Productie pas vrijgeven nadat de live RLS- en integratietests aantoonbaar groen zijn.
