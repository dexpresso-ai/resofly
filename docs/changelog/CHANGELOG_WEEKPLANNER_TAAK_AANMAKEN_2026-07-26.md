# Weekplanner: taken aanmaken op de dag zelf, pas later koppelen

**Datum:** 2026-07-26
**Migratie:** `20260726000000_tasks_optional_project_client.sql` (toegepast op staging)

## Aanleiding

In de weekplanner kon je taken alleen slepen, niet aanmaken. En omdat
`tasks.project_id` **NOT NULL** was, kon een taak überhaupt niet bestaan zonder project:
je moest eerst een project kiezen voordat je iets kon inplannen. Dat staat haaks op hoe
je een week plant — je wilt eerst kwijt *dát* iets moet gebeuren, en pas daarna bepalen
bij welke klant of welk project het hoort.

## Wat er verandert

### Database

- `tasks.project_id` is niet langer verplicht.
- Nieuwe kolom `tasks.client_id` (nullable, `on delete set null`) + index
  `idx_tasks_org_client`. Een taak kan dus aan alleen een klant hangen, alleen een
  project, allebei, of niets.
- Bestaande taken zijn gebackfild met de klant van hun project.
- `enforce_tasks_org_integrity()` controleert nu ook dat de klant in dezelfde
  organisatie zit, en houdt project en klant sluitend: **zolang er een project mét klant
  aan hangt, is dat project leidend** en wordt `client_id` daaruit overgenomen. Bij een
  project zónder klant (intern project) blijft je eigen klantkeuze staan.
- De trigger vuurt nu ook op `client_id`.

`FRESH_INSTALL_COMPLETE_SCHEMA.sql` is in lijn gebracht.

### Weekplanner

- **Plusknop per dagkolom.** Klik → invoerregel in die dag, titel typen, **Enter** en de
  taak staat er. Het veld blijft open en leeg zodat je meteen door kunt typen; **Esc**
  sluit. De taak wordt bewust zonder project en klant aangemaakt.
- Kaarten tonen `Geen project` (cursief, gedempt) als er nog geen project hangt, en
  vallen terug op de klantnaam en -kleur als die er wel is.
- Filters `Zonder klant` en `Zonder project` om losse taken terug te vinden.

### Taakvenster

- Nieuwe velden **Klant** en **Project**, allebei optioneel. Kies je een project, dan
  wordt de klant automatisch overgenomen en op slot gezet (de hint legt uit waarom).
  Kies je een klant, dan filtert de projectlijst mee en valt een project van een andere
  klant weg. Gearchiveerde projecten staan niet in de lijst.
- **Toegewezen aan** werkt nu ook zonder project: dan kun je iedereen uit de organisatie
  kiezen in plaats van alleen het projectteam (dat is ook wat de database toestaat).

### Overige plekken die een project aannamen

- Dashboard "Deze week": een taak zonder project opent nu de weekplanner in plaats van
  een niet-bestaande projectpagina; toont klantnaam of `Geen project`.
- Globaal zoeken: valt terug op de klantnaam.
- Gerrie: `edit_task`-voorstel geeft `project_id: null` bij een losse taak in plaats van
  de string `"null"`.

## Verificatie

- `npm run typecheck` en `npm run build` groen.
- Migratie toegepast op staging; `supabase migration list` toont hem lokaal én remote.
- Kolom live bevestigd via PostgREST: `select=id,project_id,client_id` geeft 200, terwijl
  een verzonnen kolom 400 `42703` geeft (negatieve controle).
- Weekplanner geïsoleerd gerenderd met testdata: plusknop per dag met correcte
  toegankelijke naam, paneel opent in de juiste dagkolom met directe focus, Enter roept
  `onQuickAddTask` aan met de juiste datum en titel, veld wordt leeggemaakt, Esc sluit en
  de lege staat komt terug. Kaarten tonen project+klant, alleen-klant, en `Geen project`.
- De planning-RPC (`reorder_task_planning`) raakt `project_id` niet — slepen van losse
  taken werkt ongewijzigd.

## Nog open

- E2E met echte login (magic link) is niet gedaan.
- Productie: migratie nog niet toegepast.
- `gerrieCore.ts` is aangepast maar de edge function is niet opnieuw gedeployed. Niet
  urgent: het oude gedrag (`"null"`) wordt nergens getoond of gebruikt.
- Gerrie kan zelf nog geen losse taak voorstellen (`propose_task` eist een project).
