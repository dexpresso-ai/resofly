# BrandCore v2 Organizations — Senior Engineering Audit

Datum: 2026-04-29
Scope: volledige broncode-inspectie van de aangeleverde zip, met nadruk op stabiliteit, bestaande functionaliteiten en meerdere gebruikers per organisatie.

## Samenvattend oordeel

De app heeft een goede basis voor organisatieaccounts en meerdere gebruikers per organisatie. De database is grotendeels correct gemodelleerd rond `organization_id`, met RLS policies, rollen en relationele tenant-integriteit via triggers.

Voor staging was de oorspronkelijke versie echter nog niet strak genoeg. Vooral de agenda-integratie had een server-side permissierisico: elke actieve organisatiegebruiker kon via de Edge Function schrijfacties starten, ook wanneer die gebruiker functioneel read-only/viewer was. Dit is aangepast.

## Uitgevoerde checks

- Projectstructuur en stack gecontroleerd: React/Vite/TypeScript, Supabase, Cloudflare Worker, Supabase Edge Function.
- Supabase SQL-schema gecontroleerd op organisaties, leden, rollen, uitnodigingen, RLS en integriteitstriggers.
- Frontend CRUD-flows gecontroleerd voor klanten, projecten, taken, tickets, notities, offertes, facturen, archief, settings en agenda.
- Upload/download/delete flow via R2 Worker gecontroleerd.
- Agenda-integratie gecontroleerd op OAuth, bronnen, events, tokens en rollen.
- Data-laag gecontroleerd op organisatie-afbakening.
- TypeScript-check geprobeerd. In deze sandbox ontbreken npm dependencies; daardoor faalt typechecking op ontbrekende modules/types, niet op aantoonbare syntaxisfouten.

## Aangepaste punten

### 1. Read-only rol correcter afgedwongen in de UI

- `viewer` ziet nu een duidelijke alleen-lezen status.
- Nieuwe items, opslaan, verwijderen, uploads en snelle statusacties zijn geblokkeerd voor read-only gebruikers.
- Attachment delete-knoppen worden verborgen voor read-only gebruikers.
- Project/taken-acties en weekplanner-drag/drop zijn beter gekoppeld aan `canWrite`.

Belangrijkste bestanden:
- `src/main.tsx`
- `src/components/AttachmentList.tsx`
- `src/features/Projects.tsx`
- `src/features/WeekPlanner.tsx`
- `src/styles/globals.css`

### 2. Organisatie-instellingen alleen voor owner/admin

- Bedrijfsinstellingen opslaan is nu ook frontendmatig geblokkeerd voor members/viewers.
- De knop wordt disabled en toont duidelijke feedback.

Belangrijkste bestand:
- `src/features/SimplePages.tsx`

### 3. Agenda Edge Function server-side beveiligd op rollen

- `listIntegrations` en `listEvents` blijven leesbaar voor actieve leden.
- `oauthStart`, `refreshSources`, `updateSource`, `disconnectConnection` en `createEvent` vereisen nu owner/admin/member.
- `viewer` kan dus niet meer via een gemanipuleerde request agenda’s koppelen, loskoppelen of events aanmaken.
- Schrijven kan niet meer worden aangezet op externe agenda’s die volgens Google/Microsoft alleen-lezen zijn.

Belangrijkste bestand:
- `supabase/functions/calendar-integrations/index.ts`

### 4. Actieve organisatie sterker meegenomen in data-mutaties

- `updateRow`, `deleteRow` en cascade-delete ondersteunen nu optioneel `organizationId`.
- Frontend-mutaties geven de actieve organisatie mee.
- De ticket-naar-project RPC gebruikt nu ook expliciet de actieve organisatie.
- Dit voorkomt dat een gebruiker via een gemanipuleerde frontend-call per ongeluk of expres records uit een andere organisatie waar hij ook toegang tot heeft muteert.

Belangrijkste bestanden:
- `src/lib/repository.ts`
- `src/main.tsx`
- `supabase/BRANDCORE_DATABASE_SETUP.sql` / `supabase/schema.sql` / `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`

### 5. Kleine codefixes

- Dubbele subtask-attachment filterregel verwijderd.
- Supabase user adapter uitgebreid met optionele `email`, omdat de repository die gebruikt voor pending invitations.
- Migratie-README aangescherpt: bij een nieuwe database moet het volledige v2 schema gebruikt worden; oude user-based migraties niet blind toepassen.

Belangrijkste bestanden:
- `src/lib/repository.ts`
- `src/lib/supabase.ts`
- `supabase/migrations/README.md`

## Multi-user / organisatiebeoordeling

Sterk:
- `organizations` en `organization_members` vormen een duidelijke tenant-basis.
- Domeintabellen hangen aan `organization_id`.
- RLS splitst lezen, schrijven en admin-acties.
- Relationele integriteit is tenant-safe: gekoppelde records moeten binnen dezelfde organisatie vallen.
- Owner/admin/member/viewer rollen zijn functioneel bruikbaar.
- Uitnodigingen en acceptatie zijn aanwezig.

Aandachtspunten voor productie:
- Er is nog geen volledige beheer-UI voor rollen wijzigen, leden uitschakelen en uitnodigingen intrekken, hoewel repository-functies deels bestaan.
- Agenda’s zijn organisatiebreed zichtbaar. Dat kan bewust zijn, maar leg dit productmatig vast omdat gekoppelde externe agenda’s gevoelige metadata kunnen bevatten.
- R2 GET/DELETE valideert nu toegang via organisatie en random storage key. Dit is praktisch bruikbaar, maar voor maximale hardening zou je ook kunnen controleren of de `storage_key` in de `attachments` tabel bestaat.
- De oude migratiebestanden zijn historisch en kunnen verwarring geven. Voor een lege database is `supabase/BRANDCORE_DATABASE_SETUP.sql` de juiste bron.

## Teststatus

Wat in deze omgeving is gedaan:
- Statische broncode-inspectie.
- Datamodel/RLS-review.
- Gerichte codepatches.
- TypeScript-check geprobeerd.

Niet volledig afgerond in deze sandbox:
- `npm ci`/dependency-installatie: niet mogelijk door ontbrekende npm-cache/registry-toegang.
- Volledige `npm run build`: daardoor niet betrouwbaar uitvoerbaar.
- Runtime E2E-test tegen echte Supabase/Cloudflare omgeving.

Aanbevolen staging-test:
1. Nieuwe Supabase database aanmaken.
2. Alleen `supabase/BRANDCORE_DATABASE_SETUP.sql` uitvoeren.
3. `.env.local` vullen.
4. `npm ci` uitvoeren.
5. `npm run typecheck` en `npm run build` uitvoeren.
6. Testen met minimaal drie accounts:
   - owner
   - member
   - viewer
7. Testcases:
   - owner maakt organisatie en nodigt leden uit.
   - member kan klanten/projecten/taken aanmaken.
   - viewer kan lezen maar niets wijzigen, verwijderen, uploaden of agenda-koppelingen aanpassen.
   - poging tot cross-organization update faalt of raakt geen rij.
   - agenda-koppeling: viewer kan events zien, maar geen OAuth/start/create/update/disconnect.
   - R2 upload/download/delete voor member; delete geblokkeerd voor viewer.

## Conclusie

Met de aangebrachte patches is de app technisch een stuk veiliger en consistenter voor organisaties met meerdere gebruikers. Mijn advies is: geschikt om naar staging te brengen, mits je daar nog de echte dependency build, Supabase RLS-tests en Cloudflare Worker/Edge Function tests uitvoert.
