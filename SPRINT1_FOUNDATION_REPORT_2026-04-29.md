# BrandCore Sprint 1 Foundation Report — 2026-04-29

## Doel
Sprint 1 is uitgewerkt als productiebasis voor een multi-user organisatie-SaaS. De focus ligt op organisatie-onboarding, gebruikers uitnodigen, rollenbeheer, audit-log basis en een duidelijker dashboard.

## Toegevoegd

### 1. Organisatie-onboarding
- Dashboard toont nu de actieve organisatie als workspace-cockpit.
- Sprint 1 setup-checklist toegevoegd:
  - organisatie aangemaakt
  - bedrijfsgegevens ingevuld
  - teamrol actief
  - eerste klant toegevoegd
  - eerste project ingericht
- Instellingenpagina hernoemd/uitgebreid naar centrale organisatie- en instellingenhub.

### 2. Gebruikers uitnodigen
- Owner/admin kan teamleden uitnodigen met rol `admin`, `member` of `viewer`.
- Openstaande uitnodigingen binnen de organisatie worden zichtbaar.
- Uitnodigingen kunnen worden ingetrokken.
- Ingelogde gebruikers zien uitnodigingen voor hun eigen e-mailadres en kunnen deze accepteren.

### 3. Rollenbeheer
- Rollenbeheer zichtbaar in instellingen.
- Owner kan rollen wijzigen tussen `owner`, `admin`, `member` en `viewer`.
- Owner kan teamleden uitschakelen.
- Eigen account is beschermd tegen zelf-degradatie/uitschakelen vanuit de UI.
- Database bewaakt dat minimaal één actieve owner overblijft.

### 4. Audit-log basis
- Nieuwe tabel `audit_logs` toegevoegd.
- Database-trigger `audit_row_change()` logt wijzigingen server-side.
- Audit events voor:
  - organisaties
  - memberships
  - uitnodigingen
  - klanten
  - projecten
  - taken
  - tickets
  - notities
  - bedrijfsinstellingen
  - offertes
  - facturen
  - bijlagen
  - agenda-koppelingen en agenda-bronnen
- Audit-log is alleen-lezen voor organisatieleden.
- Geen client-side insert/update/delete policies op audit-log.
- Audit-log faalt bewust non-blocking: een logging-waarschuwing mag de zakelijke mutatie niet blokkeren.

### 5. Dashboard basis
- Dashboard toont nu:
  - actieve organisatie
  - huidige rol
  - aantal teamleden
  - actieve klanten
  - projecten
  - open taken
  - te late taken
  - betaalde omzet
  - laatste audit-activiteit
- Projecten blijven snel open te klikken vanuit het dashboard.

## Databasebestanden
Voor een nieuwe lege database:
- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
- `supabase/schema.sql`
- `supabase/BRANDCORE_DATABASE_SETUP.sql`

Voor bestaande database:
- `supabase/migrations/20260429_sprint1_workspace_foundation.sql`

## Regressiecheck
Gecontroleerd op syntax via TypeScript `transpileModule` voor de gewijzigde bestanden:
- `src/main.tsx`
- `src/features/Dashboard.tsx`
- `src/features/SimplePages.tsx`
- `src/lib/repository.ts`
- `src/types.ts`

Volledige `npm run build` kon in deze sandbox niet worden afgerond omdat dependencies/node_modules niet beschikbaar waren en `npm ci`/`tsc` time-outs gaven. De codebase bevat wel `package-lock.json`; lokaal of in CI kan `npm ci && npm run build` worden uitgevoerd.

## Belangrijk voor staging
1. Run bij een nieuwe Supabase database de volledige fresh install SQL.
2. Run bij een bestaande database de nieuwe Sprint 1 migratie.
3. Start daarna de app opnieuw, zodat de audit-log en organization invitations geladen worden.
4. Test minimaal met twee accounts:
   - owner nodigt viewer/member/admin uit
   - invitee accepteert uitnodiging
   - owner wijzigt rol
   - viewer ziet read-only gedrag
   - audit-log vult na mutaties
