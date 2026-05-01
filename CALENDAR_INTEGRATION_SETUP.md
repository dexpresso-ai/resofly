# BrandCore v1.6.0 — Google & Microsoft Agenda-koppeling

Deze versie bevat een volledige per-user agenda-koppeling voor Google Calendar en Microsoft Outlook/Microsoft 365 via Supabase Edge Functions.

## 1. Database installeren — lege database

Je gaf aan dat er nog geen productiedata is. Gebruik daarom **één compleet schema**:

```sql
-- Supabase SQL Editor
-- Plak en run de volledige inhoud van:
supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql of supabase/schema.sql
```

Alternatief: `supabase/BRANDCORE_DATABASE_SETUP.sql` bevat dezelfde fresh-install basis.

Niet nodig bij een lege database:

- losse migraties één voor één draaien
- datamigratie
- backfill

## 2. Edge Function deployen

```bash
supabase functions deploy calendar-integrations
```

De frontend roept deze functie aan via `supabase.functions.invoke('calendar-integrations', ...)`.

## 3. Supabase secrets instellen

Zet deze secrets in Supabase. Deze waarden mogen nooit in de frontend of in Vite env-vars staan.

```bash
supabase secrets set \
  CALENDAR_REDIRECT_URL="https://YOUR_PROJECT.supabase.co/functions/v1/calendar-integrations" \
  CALENDAR_ALLOWED_RETURN_ORIGINS="http://localhost:5173,https://jouw-productiedomein.nl" \
  CALENDAR_OAUTH_STATE_SECRET="lange-random-string-minimaal-32-tekens" \
  CALENDAR_TOKEN_ENCRYPTION_KEY="lange-random-string-minimaal-32-tekens" \
  GOOGLE_CALENDAR_CLIENT_ID="..." \
  GOOGLE_CALENDAR_CLIENT_SECRET="..." \
  MICROSOFT_CALENDAR_CLIENT_ID="..." \
  MICROSOFT_CALENDAR_CLIENT_SECRET="..." \
  MICROSOFT_CALENDAR_TENANT_ID="common"
```

Gebruik voor productie een andere `CALENDAR_TOKEN_ENCRYPTION_KEY` en `CALENDAR_OAUTH_STATE_SECRET` dan lokaal.

## 4. Google Cloud instellen

1. Ga naar Google Cloud Console.
2. Maak/selecteer een project.
3. Enable **Google Calendar API**.
4. Configureer OAuth consent screen.
5. Maak OAuth Client ID aan van type **Web application**.
6. Voeg deze Authorized redirect URI toe:

```text
https://YOUR_PROJECT.supabase.co/functions/v1/calendar-integrations
```

7. Zet Client ID en Client Secret in Supabase secrets.

Gebruikte scopes:

```text
openid
email
profile
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/calendar.events
```

## 5. Microsoft Entra instellen

1. Ga naar Microsoft Entra Admin Center.
2. App registrations → New registration.
3. Supported account types: kies wat past:
   - Single tenant voor interne organisatie
   - Multitenant/common voor externe gebruikers
4. Redirect URI type: **Web**.
5. Redirect URI:

```text
https://YOUR_PROJECT.supabase.co/functions/v1/calendar-integrations
```

6. Maak een Client Secret aan.
7. API permissions → Microsoft Graph → Delegated permissions:

```text
User.Read
Calendars.ReadWrite
offline_access
openid
profile
email
```

8. Zet Client ID, Client Secret en Tenant ID in Supabase secrets.

## 6. Lokale frontend env

`.env.local` blijft beperkt tot browser-veilige waarden:

```bash
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
VITE_R2_WORKER_URL=https://brandcore-media.YOUR_SUBDOMAIN.workers.dev
VITE_R2_PUBLIC_BASE_URL=
```

## 7. Testflow

1. Run database schema.
2. Deploy Edge Function.
3. Zet secrets.
4. Start frontend:

```bash
npm ci
npm run dev
```

5. Log in als gebruiker.
6. Ga naar **Kalender**.
7. Klik **Google koppelen**.
8. Controleer dat je terugkomt op de kalenderpagina.
9. Klik eventueel **Agenda’s** om bronnen opnieuw op te halen.
10. Zet per agenda **Tonen** aan.
11. Zet bij één agenda **Schrijven** aan.
12. Maak een extern event aan.
13. Herhaal voor Microsoft.

## 8. Security ontwerp

- OAuth tokens worden niet opgeslagen in `localStorage`, React state of de browser.
- Refresh tokens worden AES-GCM versleuteld opgeslagen in `calendar_connection_tokens`.
- `calendar_connection_tokens` heeft RLS aan, maar bewust geen user policies.
- Alleen de Edge Function met service-role key kan tokenrijen lezen/schrijven.
- `calendar_connections` en `calendar_sources` zijn per gebruiker te lezen.
- Tenant-integriteit wordt afgedwongen via triggers op `calendar_sources` en `calendar_connection_tokens`.
- OAuth `state` is HMAC-ondertekend en verloopt na 10 minuten.
- `CALENDAR_ALLOWED_RETURN_ORIGINS` voorkomt open redirect misbruik.

## 9. Belangrijke bestanden

```text
src/features/CalendarPage.tsx
src/lib/calendar-api.ts
supabase/functions/calendar-integrations/index.ts
supabase/schema.sql
supabase/BRANDCORE_DATABASE_SETUP.sql
supabase/migrations/20260428_calendar_integrations.sql
```
