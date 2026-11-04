# BrandCore v2.0.0 — organisatie-accounts en multi-user tenancy

## Samenvatting
Deze versie vervangt de oude single-user tenancy door een organisatiegericht datamodel. Een organisatie is nu de tenant/account/workspace en kan meerdere gebruikers bevatten via memberships met rollen.

## Nieuw datamodel
Nieuwe tabellen:

- `organizations` — organisatie/account/workspace.
- `organization_members` — actieve gebruikers per organisatie met rol `owner`, `admin`, `member` of `viewer`.
- `organization_invitations` — openstaande uitnodigingen op e-mailadres.

Aangepaste app-tabellen:

- `clients`
- `projects`
- `tasks`
- `tickets`
- `notes`
- `quotes`
- `invoices`
- `attachments`
- `company_settings`
- `calendar_connections`
- `calendar_connection_tokens`
- `calendar_sources`

Alle kernrecords hangen nu aan `organization_id`. `created_by` bewaart optioneel welke gebruiker het record heeft aangemaakt.

## Rollen

- `owner` — volledige rechten, inclusief owners/admins beheren.
- `admin` — organisatie beheren, bedrijfsinstellingen wijzigen, teamleden uitnodigen.
- `member` — operationeel werken met klanten/projecten/taken/tickets/financiële records/bijlagen.
- `viewer` — lezen zonder schrijven.

## Security/RLS

Het Supabase-schema bevat RLS-policies op organisatieniveau:

- Lezen: actieve leden van de organisatie.
- Schrijven: `owner`, `admin`, `member`.
- Bedrijfsinstellingen: `owner`, `admin`.
- Membershipbeheer: owners/admins via RPC’s/policies.
- Calendar tokens: geen publieke RLS-policies; alleen Edge Functions met service role.

Daarnaast bevat het schema tenant-safe integriteitstriggers. Foreign keys zoals `project.client_id`, `task.project_id`, `invoice.quote_id` en `attachment.entity_id` worden gecontroleerd op dezelfde `organization_id`.

## Frontend-aanpassingen

- De app laadt bij login automatisch een defaultorganisatie via `ensure_user_default_organization()`.
- De actieve organisatie wordt opgeslagen in `localStorage`.
- Sidebar bevat een organisatie-switcher.
- Instellingen bevat organisatiebeheer, teamoverzicht, uitnodigingen en uitnodigingen accepteren.
- Alle `load`, `insert`, `upsert` en uploadflows gebruiken `organization_id`.

## Cloudflare Worker

- Uploadkeys hebben nu vorm: `{organizationId}/{entityType}/{entityId}/{uuid}-{filename}`.
- Upload/delete vereist actieve membership met schrijfrechten.
- Download vereist actieve membership met leesrechten.
- Uploadheaders bevatten nu `x-organization-id`.

## Calendar Edge Function

Agenda-koppelingen zijn nu organisatie-gescopeerd:

- OAuth-state bevat `organizationId`.
- Connections, tokens en sources bevatten `organization_id`.
- Alle acties valideren actieve organisatie-toegang.

## Installatie

Voor een nieuwe Supabase database:

1. Open Supabase SQL Editor.
2. Plak de volledige inhoud van `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`.
3. Run het script.
4. Configureer `.env.local` op basis van `.env.example`.
5. Deploy eventueel `supabase/functions/calendar-integrations`.
6. Deploy eventueel `cloudflare-worker/worker.ts`.

## Validatie

Handmatig gecontroleerd:

- Supabase datamodel en RLS-opzet.
- Tenant-safe relationele integriteit op alle bestaande kernrelaties.
- Repositorylaag naar organisatiecontext.
- Frontend actieve organisatiecontext en settings/team UI.
- R2 upload/read/delete op organisatieprefix.
- Calendar Edge Function op organisatiecontext.

Let op: in deze omgeving kon geen volledige Vite/TypeScript-build worden afgerond omdat dependency-installatie/TypeScript-compilerprocessen bleven hangen zonder output. De code is daarom statisch en handmatig gecontroleerd en alle gevonden syntax/patch-fouten zijn gecorrigeerd.
