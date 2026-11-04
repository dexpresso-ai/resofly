# Changelog - Weekplanner Pro Planning (2026-05-28)

## Gebouwd

- Weekplanner gebruikt nu `planned_date` in plaats van `end_date`.
  - `end_date` blijft daardoor de inhoudelijke deadline.
  - bestaande taken worden in de migratie eenmalig gebackfilled: `planned_date = end_date` wanneer `planned_date` nog leeg is.
- Nieuwe databasevelden op `tasks`:
  - `planned_date date`
  - `planned_order integer`
  - `estimated_minutes integer not null default 60`
- Nieuwe RPC `reorder_task_planning(...)`.
  - Controleert `can_write_org` server-side.
  - Verifieert dat bron- en doeltaak binnen dezelfde organisatie vallen.
  - Herbouwt de volgorde per dag atomair met ruime order-stappen.
  - Compact oude en nieuwe dagvolgordes na verplaatsing.
- Taken kunnen nu binnen een dag op volgorde worden gezet door ze boven een andere taak te droppen.
- Taken kunnen naar onderaan een dag worden gesleept.
- Taken kunnen terug naar `Niet ingepland`, waarbij `planned_date` en `planned_order` leeg worden gemaakt.
- Sectie `Buiten deze week` toegevoegd met zichtbare taken buiten de gekozen week.
- Filters toegevoegd:
  - zoeken op taak/project/klant/tag
  - klant
  - project
  - prioriteit
  - status
- Weekcapaciteit toegevoegd:
  - weektotaal in taken en geschatte duur
  - dagtotaal in taken en geschatte duur
  - bezettingspercentage per dag op basis van 8 uur per werkdag
- Taakmodal uitgebreid met:
  - duidelijke `Deadline`
  - aparte `Plandatum`
  - `Geschatte duur` in minuten

## Aangepaste bestanden

- `src/features/WeekPlanner.tsx`
- `src/main.tsx`
- `src/lib/repository.ts`
- `src/types.ts`
- `src/styles/globals.css`
- `supabase/migrations/20260528_weekplanner_planning_fields.sql`
- `supabase/BRANDCORE_DATABASE_SETUP.sql`
- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`

## Belangrijk bij deploy

Voer vóór of direct tijdens de deployment de nieuwe Supabase-migratie uit:

```sql
supabase/migrations/20260528_weekplanner_planning_fields.sql
```

Zonder deze migratie mist de database de nieuwe velden en RPC voor de planner.
