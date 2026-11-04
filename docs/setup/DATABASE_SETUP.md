# Database

## Installeren

Een nieuwe database bouw je op uit de migraties, met `supabase db push` (een
Supabase-project) of `supabase db start` (lokaal). Hoe, en wat daarna per
project nog aan moet: `supabase/migrations/README.md`.

Tot november 2026 stond hier dat je `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
in de SQL-editor plakt. Dat bestand was blijven staan op versie 2.2.1 (april) en
miste het grootste deel van het schema. Het bestaat niet meer.

## Het datamodel in het kort

- Alle gegevens hangen aan een organisatie (`organization_id`), niet aan één
  gebruiker. Toegang loopt via `organization_members`.
- Rollen:
  - `owner` en `admin` beheren de organisatie;
  - `member` werkt mee;
  - `viewer` leest alleen;
  - `accountant` is een gratis gastaccount voor de boekhouder: alleen
    Financiën, alleen lezen.
- Per teamlid kan elke module dicht, op lezen of op volledig staan. De database
  dwingt dat af met RLS en schrijf-triggers. De app volgt dezelfde regels:
  `src/lib/permissions.ts` en `supabase/functions/_shared/roles.ts`.
- Triggers bewaken dat gekoppelde rijen bij dezelfde organisatie horen.
