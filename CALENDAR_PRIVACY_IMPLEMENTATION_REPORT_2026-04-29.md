# BrandCore — Calendar privacy implementation

Datum: 2026-04-29  
Rol: Senior Software Engineer + Senior Test Engineer

## Doel

De agenda-integratie is aangepast naar een modern SaaS-privacy model:

- Persoonlijke agenda's staan standaard privé.
- De gebruiker die een agenda koppelt kan per agenda kiezen voor `Delen met organisatie`.
- Alleen gedeelde agenda's worden zichtbaar voor andere organisatieleden en komen in de teamplanning.
- Privé-agenda's van andere gebruikers worden niet via de teamplanning opgehaald.
- Als een private event ooit via een toekomstige availability-flow wordt gerenderd, wordt deze server-side gemaskeerd naar `Bezet` zonder titel, omschrijving, locatie of link.
- Admins/owners kunnen niet zomaar persoonlijke agenda's van teamleden openen, verversen, loskoppelen of delen.

## Aangepaste bestanden

### Frontend

- `src/types.ts`
  - `CalendarVisibility = 'private' | 'organization'` toegevoegd.
  - `CalendarSource.visibility` toegevoegd.
  - `CalendarExternalEvent.visibility` en `is_private_masked` toegevoegd.

- `src/lib/calendar-api.ts`
  - `updateCalendarSource()` accepteert nu ook `visibility`.

- `src/main.tsx`
  - Huidige Supabase user-id wordt opgeslagen als `currentUserId`.
  - `CalendarPage` ontvangt `currentUserId`, zodat de UI onderscheid kan maken tussen eigen agenda's en gedeelde teamagenda's.

- `src/features/CalendarPage.tsx`
  - Nieuwe privacy-copy in de hero.
  - Agenda's tonen nu een privacybadge: `Privé` of `Gedeeld met organisatie`.
  - Nieuwe toggle: `Delen met organisatie`.
  - Alleen de eigenaar van de agenda kan `Tonen`, `Delen met organisatie`, `Schrijven`, `Agenda's verversen` en `Loskoppelen` aanpassen.
  - Teamleden zien gedeelde agenda's, maar accountgegevens van de eigenaar worden afgeschermd.
  - Schrijfbare agenda-selectie bevat alleen eigen schrijfbare agenda's of gedeelde schrijfbare agenda's.

- `src/styles/globals.css`
  - Styling toegevoegd voor privacybadges, gedeelde/private status en mobiele layout.

### Supabase SQL

- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
- `supabase/schema.sql`
- `supabase/BRANDCORE_DATABASE_SETUP.sql`

Aanpassingen:

- `calendar_sources.visibility text not null default 'private' check (visibility in ('private','organization'))` toegevoegd.
- Index toegevoegd: `idx_calendar_sources_org_visibility`.
- Brede calendar RLS-policies vervangen door privacy-aware policies:
  - Connections zijn leesbaar voor de eigenaar of wanneer er een gedeelde source onder zit.
  - Sources zijn leesbaar voor de eigenaar of wanneer `visibility = 'organization'` én de gebruiker lid is van de organisatie.
  - Insert/update/delete van calendar connections/sources mag alleen door de eigenaar van de koppeling/source.

### Supabase migration

- `supabase/migrations/20260429_calendar_privacy_visibility.sql`

Deze migratie voegt de privacykolom toe aan bestaande databases en vervangt de brede calendar policies.

### Supabase Edge Function

- `supabase/functions/calendar-integrations/index.ts`

Aanpassingen:

- `listIntegrations()` filtert nu op eigen agenda's + expliciet gedeelde agenda's.
- Niet-eigen gedeelde connection metadata wordt gemaskeerd.
- `refreshSources()` mag alleen door de eigenaar van de connection.
- `updateSource()` mag alleen door de eigenaar van de source.
- `disconnectConnection()` mag alleen door de eigenaar van de connection.
- `listEvents()` haalt alleen events op uit eigen sources en organisatie-gedeelde sources.
- Private events van anderen worden defensief gemaskeerd naar `Bezet` als ze ooit in een toekomstige flow terechtkomen.
- `createEvent()` blokkeert schrijven naar niet-gedeelde privé-agenda's van andere gebruikers.

## Testresultaten in deze sandbox

Statische checks uitgevoerd:

```text
PASS SQL baselines identical
PASS calendar_sources visibility default private in fresh schema
PASS calendar source visibility index in fresh schema
PASS broad calendar source read policy absent
PASS privacy-aware source read policy present
PASS calendar source update own policy present
PASS privacy migration present
PASS migration drops old broad calendar policies
PASS CalendarSource type has visibility
PASS CalendarExternalEvent type has visibility
PASS calendar API update supports visibility
PASS CalendarPage receives currentUserId
PASS CalendarPage has share toggle
PASS Edge listIntegrations filters visible sources
PASS Edge updateSource owner-only
PASS Edge disconnect owner-only
PASS Edge event creation blocks unshared private sources
PASS Edge event returns visibility
RESULT 18/18 PASS
```

## Niet live getest in deze sandbox

- Echte Supabase migration/fresh install op een lege database.
- Echte RLS-test met meerdere auth-users.
- Echte Google OAuth-callback.
- Echte Microsoft OAuth-callback.
- Echte provider event sync met live tokens.
- Volledige `npm ci && npm run typecheck && npm run build`; dependency-installatie kon in deze sandbox niet betrouwbaar worden afgerond.

## Verplichte staging smoke tests

1. Voer de nieuwe migratie uit of gebruik het volledige fresh schema op een lege Supabase database.
2. Maak minimaal drie gebruikers aan binnen dezelfde organisatie:
   - owner/admin
   - member
   - viewer
3. Laat gebruiker A Google koppelen en niets delen.
   - Gebruiker B/admin mag de agenda/source/events niet zien.
4. Laat gebruiker A dezelfde agenda delen met organisatie.
   - Gebruiker B/admin mag de gedeelde source en events zien.
   - Accountgegevens van gebruiker A blijven afgeschermd in de UI.
5. Laat gebruiker B proberen de agenda van A te verversen, los te koppelen of privacy te wijzigen.
   - Moet falen.
6. Test schrijven:
   - Eigen private agenda: toegestaan als `Schrijven` aanstaat.
   - Gedeelde agenda: toegestaan als `Schrijven` aanstaat.
   - Niet-gedeelde agenda van andere gebruiker: moet falen.
7. Viewer mag niets koppelen, delen, loskoppelen of schrijven.

## Oordeel

De privacy-eisen zijn netjes ingebouwd op database-, Edge Function- en frontendniveau. De codebase is klaar voor staging-validatie van deze agenda-privacyflow.
