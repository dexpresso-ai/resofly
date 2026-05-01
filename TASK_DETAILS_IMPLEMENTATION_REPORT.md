# BrandCore CRM — subtaken/comments implementatie

## Doel
De bestaande JSONB-velden `tasks.subtasks` en `tasks.comments` zijn omgezet van alleen datamodel-ondersteuning naar echte UI-functionaliteit binnen de taakmodal.

## Gebouwd
- Subtaken beheren in de taakmodal:
  - subtaak toevoegen
  - label aanpassen
  - afronden/niet afronden via checkbox
  - subtaak verwijderen
  - voortgangsteller `afgerond/totaal`
- Comments beheren in de taakmodal:
  - comment toevoegen
  - timestamp automatisch vastleggen
  - comment verwijderen met confirmatie
  - lege comments worden geblokkeerd
- Data-normalisatie toegevoegd:
  - ontbrekende/legacy JSON wordt veilig naar arrays genormaliseerd
  - lege subtaken worden bij opslaan verwijderd
  - bestaande comments blijven immutable; toevoegen/verwijderen kan via UI
- Project/Kanban-kaarten tonen nu:
  - subtaakvoortgang
  - aantal comments
- Weekplanner-kaarten tonen nu:
  - subtaakvoortgang
  - aantal comments
- Nieuwe taken bewaren subtaken/comments direct vanuit de modal in plaats van deze bij insert hard naar lege arrays te forceren.

## Aangepaste bestanden
- `src/main.tsx`
- `src/features/Projects.tsx`
- `src/features/WeekPlanner.tsx`
- `src/styles/globals.css`
- `package.json`

## Testaanpak
Uitgevoerd op codeniveau/statisch:
- Controle dat `TaskDetailEditor` in de taakmodal wordt gerenderd.
- Controle dat `initialForm()` bestaande subtaken/comments inleest.
- Controle dat `cleanForm()` subtaken/comments alleen voor tasks bewaart en voor andere entiteiten verwijdert.
- Controle dat nieuwe tasks subtaken/comments niet meer overschrijven met lege arrays.
- Controle dat Kanban en Weekplanner counters gebruiken met null-safe optional chaining.
- Controle op conflict markers.

## Niet live bewezen
Geen live Supabase/R2 E2E uitgevoerd, omdat er geen staging-credentials in de codebase aanwezig zijn. De wijziging gebruikt bestaande `tasks.subtasks` en `tasks.comments` JSONB-kolommen en vereist daarom geen database-migratie.

## Aanbevolen handmatige acceptatietest
1. Maak een nieuwe taak met 2 subtaken en 1 comment.
2. Sla op en open dezelfde taak opnieuw.
3. Controleer dat subtaken/comments persistent zijn.
4. Vink één subtaak af en sla op.
5. Controleer Kanban- en Weekplanner-counter.
6. Verwijder een subtaak en comment.
7. Controleer dat lege subtaken niet worden opgeslagen.
