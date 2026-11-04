# BrandCore Sprint 1 Acceptance Recheck — 2026-04-29

## Scope
Senior software-engineering en test-engineering recheck van de volledige Sprint 1-codebase, inclusief bestaande functies en regressierisico's.

Geteste scope:
- Organisatie-onboarding
- Gebruikers uitnodigen en uitnodigingen accepteren/intrekken
- Rollenbeheer: owner/admin/member/viewer
- Audit-log basis
- Dashboard basis
- Bestaande CRM/project/ticket/note/quote/invoice/attachment functies
- Tenant-isolatie en relationele integriteit
- Calendar privacy-baseline uit de bestaande code
- SQL fresh-install en bestaande database-migraties

## Uitgevoerde checks

### Frontend / TypeScript
- `npm ci --ignore-scripts --no-audit --no-fund`
- `npm rebuild esbuild --no-audit --no-fund`
- `npm run typecheck`
- `npm run build`

Resultaat:
- TypeScript typecheck: geslaagd.
- Productiebuild: geslaagd.
- Build-output: `dist/index.html`, CSS en JS bundle aangemaakt.
- Vite waarschuwing: JS bundle is groter dan 500 kB. Dit is geen blokkerende fout, maar code-splitting is aanbevolen in een latere optimalisatiesprint.

### SQL / schema consistency
- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`, `supabase/schema.sql` en `supabase/BRANDCORE_DATABASE_SETUP.sql` zijn gelijkgetrokken.
- SQL dollar-quote delimiter-check uitgevoerd.
- Sprint 1 migraties gecontroleerd op idempotente `drop trigger if exists` / `create trigger` patronen.

### Regressiecontrole bestaande functies
Gecontroleerd op behoud van:
- Klanten CRUD
- Projecten CRUD, inclusief archiveren/herstellen
- Taken CRUD, statuswijzigingen, subtaken en comments
- Tickets CRUD en veilige ticket-naar-project conversie
- Notities CRUD
- Offertes/facturen CRUD en PDF-export
- Bijlagen upload/download/delete en cascade-cleanup
- Weekplanner drag/drop
- Kalenderkoppeling privacy-baseline

## Aanvullende fixes/hardening in deze recheck

### 1. Uitnodiging accepteren activeert nu de juiste organisatie
Voorheen bleef de actieve workspace na acceptatie op de eerder geselecteerde organisatie staan. Nu schakelt de app direct naar de organisatie van de geaccepteerde uitnodiging.

Aangepast:
- `src/main.tsx`

### 2. Verlopen uitnodigingen worden niet meer als openstaande uitnodiging getoond
Openstaande uitnodigingen worden nu gefilterd op `expires_at is null` of `expires_at > now`.

Aangepast:
- `src/lib/repository.ts`

### 3. E-mailadresvalidatie vóór uitnodigen
De app valideert e-mailadressen client-side voordat de RPC wordt aangeroepen.

Aangepast:
- `src/lib/repository.ts`

### 4. Laatste owner extra beschermd in de UI
De laatste actieve owner kan in de UI niet worden gedegradeerd of uitgeschakeld. De database had hiervoor al bescherming; de UI is nu consistenter met die regel.

Aangepast:
- `src/features/SimplePages.tsx`

### 5. Organization member identity hardening
Owners konden via gemanipuleerde API-calls theoretisch identity-velden van `organization_members` proberen te wijzigen. Nieuwe triggers blokkeren mutaties van:
- `organization_members.organization_id`
- `organization_members.user_id`

Toegevoegd aan:
- Fresh install SQL
- Schema SQL
- Database setup SQL
- Nieuwe migratie `supabase/migrations/20260429_sprint1_acceptance_hardening.sql`

### 6. Invitation identity hardening
Uitnodigingsregels zijn gehard zodat `organization_id` en `email` niet stilletjes kunnen worden aangepast na aanmaak.

Toegevoegd aan:
- Fresh install SQL
- Schema SQL
- Database setup SQL
- Nieuwe migratie `supabase/migrations/20260429_sprint1_acceptance_hardening.sql`

### 7. Direct REST invite spoofing verkleind
De insert-policy voor `organization_invitations` vereist nu `invited_by = auth.uid()` bij directe inserts. De bestaande RPC werkte al correct, maar dit verkleint misbruik via handmatige API-calls.

Toegevoegd aan:
- Fresh install SQL
- Schema SQL
- Database setup SQL
- Nieuwe migratie `supabase/migrations/20260429_sprint1_acceptance_hardening.sql`

## Acceptatie-oordeel
Sprint 1 is na deze recheck:

**Code-complete en build-verified.**

Professioneel advies:
- Klaar voor staging.
- Productie-release pas na een echte Supabase staging-run met minimaal twee testaccounts.

## Aanbevolen staging acceptance tests

1. Fresh install SQL uitvoeren op lege Supabase database.
2. App starten met `.env.local`.
3. Account A inloggen en default organisatie laten aanmaken.
4. Account A maakt een klant, project, taak, ticket, offerte en factuur.
5. Account A nodigt Account B uit als viewer.
6. Account B accepteert uitnodiging en komt direct in de juiste organisatie.
7. Account B kan lezen maar geen records wijzigen.
8. Account A wijzigt Account B naar member.
9. Account B kan nu klant/project/taak maken.
10. Account A trekt een openstaande uitnodiging in.
11. Account A probeert laatste owner uit te schakelen: UI blokkeert, database beschermt.
12. Audit-log vult bij create/update/delete/invite/accept/revoke/role-change/disable events.
13. Bestaande functies: PDF-export, attachments, weekplanner en ticket-conversie opnieuw controleren.

## Open optimalisatiepunt
De productiebuild geeft een bundle-size waarschuwing van circa 874 kB JS / 304 kB gzip. Dit blokkeert staging niet. Later optimaliseren met route-based code-splitting of lazy-loading van PDF/kalender-functionaliteit.
