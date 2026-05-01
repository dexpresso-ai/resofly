# BrandCore database setup

Deze codebase is versie `2.0.0` en gebruikt organisatie-accounts als tenantlaag.

## Nieuwe / lege Supabase database

Gebruik dit bestand:

```text
supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql
```

Stappen:

1. Maak een nieuw Supabase project aan of gebruik een volledig lege database.
2. Open **SQL Editor**.
3. Plak de volledige inhoud van `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`.
4. Klik **Run**.
5. Zet de waarden uit `.env.example` in `.env.local`.
6. Start de app lokaal met `npm install` en daarna `npm run dev`.

## Belangrijkste datamodelwijziging

Alle applicatiedata hangt nu aan `organization_id` in plaats van direct aan één losse gebruiker. Gebruikers krijgen toegang via `organization_members`.

Nieuwe tabellen:

- `organizations`
- `organization_members`
- `organization_invitations`

Bestaande kernobjecten zoals klanten, projecten, taken, tickets, notities, offertes, facturen, bijlagen, bedrijfsinstellingen en agenda-koppelingen zijn organisatie-gescopeerd.

## RLS

Het schema activeert Row Level Security voor alle relevante tabellen. De policies gebruiken actieve organisatie-memberships:

- `owner`, `admin`, `member`: lezen en operationeel schrijven.
- `viewer`: alleen lezen.
- `owner`, `admin`: organisatiebeheer en bedrijfsinstellingen.

Daarnaast controleren database-triggers dat gekoppelde records binnen dezelfde organisatie vallen.
