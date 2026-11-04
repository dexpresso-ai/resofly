# BrandCore v1.6.0 — Calendar Integrations Implementation Report

## Doel

Volledige agenda-koppeling voor elke unieke BrandCore-gebruiker, met ondersteuning voor:

- Google Calendar
- Microsoft Outlook / Microsoft 365 Calendar via Microsoft Graph
- meerdere gekoppelde accounts per gebruiker
- meerdere agenda’s per gekoppeld account
- per agenda tonen/uitzetten
- per agenda schrijven aan/uit
- externe events ophalen in de kalenderweergave
- externe events aanmaken vanuit BrandCore

## Gebouwde onderdelen

### Frontend

Nieuw:

```text
src/features/CalendarPage.tsx
src/lib/calendar-api.ts
```

Aangepast:

```text
src/main.tsx
src/types.ts
src/styles/globals.css
.env.example
package.json
```

### Database

Compleet fresh-install schema uitgebreid met:

```text
calendar_connections
calendar_connection_tokens
calendar_sources
```

Inclusief:

- indexes
- updated_at triggers
- tenant-integrity triggers
- RLS
- token-table zonder user policy

Bestanden:

```text
supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql
supabase/schema.sql
supabase/BRANDCORE_DATABASE_SETUP.sql
supabase/migrations/20260428_calendar_integrations.sql
```

### Supabase Edge Function

Nieuw:

```text
supabase/functions/calendar-integrations/index.ts
```

Acties:

```text
oauthStart
OAuth callback via GET
listIntegrations
refreshSources
updateSource
disconnectConnection
listEvents
createEvent
```

## Belangrijke engineering-keuzes

### 1. Geen tokens in de frontend

De frontend krijgt nooit Google/Microsoft access tokens of refresh tokens terug. OAuth en tokenbeheer lopen volledig via Supabase Edge Function.

### 2. Versleutelde refresh tokens

Tokens worden AES-GCM versleuteld opgeslagen in `calendar_connection_tokens`.

### 3. Tenant-safe datamodel

`calendar_sources` en `calendar_connection_tokens` bevatten beide `user_id`, maar worden ook via triggers gecontroleerd tegen de eigenaar van `calendar_connections`.

### 4. Per-user integraties

Elke gebruiker kan zelf Google en/of Microsoft koppelen. De koppeling is dus niet globaal voor de hele app.

### 5. Calendar sources los van connections

Een account kan meerdere agenda’s hebben. Daarom is er een aparte `calendar_sources` tabel waarin per agenda `sync_enabled` en `write_enabled` beheerd worden.

## Verwachte testcases

### Database

- Fresh schema draait op lege Supabase database.
- RLS voorkomt dat gebruikers elkaars connections/sources zien.
- Tokenrijen zijn niet uitleesbaar via anon/authenticated client.
- Source met connection van andere user faalt door trigger.
- Token met connection van andere user faalt door trigger.

### Google

- OAuth start vanaf Kalenderpagina.
- Callback slaat connection + tokens op.
- CalendarList wordt opgehaald.
- Events worden opgehaald.
- Event wordt aangemaakt op write-enabled agenda.
- Disconnect verwijdert lokale connection, tokens en sources.

### Microsoft

- OAuth start vanaf Kalenderpagina.
- Callback slaat connection + tokens op.
- Microsoft calendars worden opgehaald.
- CalendarView haalt events in weekrange op.
- Event wordt aangemaakt op write-enabled agenda.
- Disconnect verwijdert lokale connection, tokens en sources.

## Buildcontrole

Deze codebase is zo opgebouwd dat de browserbundel geen extra dependencies nodig heeft. De Edge Function gebruikt Deno imports en valt buiten de Vite build.

Aanbevolen lokale controle:

```bash
npm ci
npm run typecheck
npm run build
supabase functions deploy calendar-integrations
```

## Productiechecklist

- [ ] Supabase schema draaien op lege database.
- [ ] Supabase auth URL/site URL goed zetten.
- [ ] Edge Function deployen.
- [ ] Supabase secrets instellen.
- [ ] Google Calendar API enabled.
- [ ] Google OAuth redirect URI toegevoegd.
- [ ] Microsoft Entra App Registration aangemaakt.
- [ ] Microsoft Graph delegated permissions toegevoegd.
- [ ] `CALENDAR_ALLOWED_RETURN_ORIGINS` bevat productie-URL.
- [ ] E2E Google koppeling getest.
- [ ] E2E Microsoft koppeling getest.
