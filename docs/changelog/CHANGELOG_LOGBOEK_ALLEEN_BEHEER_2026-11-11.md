# Logboek: alleen voor de eigenaar en de beheerders — 11 november 2026

Vraag: "Het logboek waar alle acties zichtbaar zijn mag alleen maar voor de
eigenaar en de beheerder beschikbaar zijn, niet voor de teamleden."

## Wat er was

Het logboek (Instellingen → Logboek, en het blok **Logboek** op het
dashboard) stond voor iedereen in de organisatie open. De database liet per
module zien wat je mocht lezen (RLS uit `20261003060000`):

- een teamlid met alle modules zag zo vrijwel het hele logboek: wie wanneer
  wat deed, met het e-mailadres van elke collega, per veld van oud naar nieuw,
  en wie de rol of de modulerechten van wie aanpaste;
- een kijker las mee, een boekhouder zag alle regels over Financiën;
- Gerrie, de agents, MCP en de API gaven hetzelfde via `audit.list`.

## Wat het nu is

Alleen een **owner** of **admin** van de organisatie ziet het logboek. Voor
een teamlid (member), een kijker (viewer) en de boekhouder:

- staat het tabblad **Logboek** niet meer in Instellingen en niet in het
  accountmenu (ook niet als je er met een oude link of vanaf het dashboard
  naartoe wilt);
- staat het blok **Logboek** niet meer op het dashboard. De staartrij geeft de
  rapportages dan de volle breedte, in plaats van een lege kolom ernaast;
- vraagt de app het logboek bij het opstarten niet meer op;
- geeft de database **geen enkele regel** terug, ook niet rechtstreeks via
  PostgREST;
- kan Gerrie het niet opzoeken, en ziet een agent, MCP-koppeling of
  API-sleutel `audit.list` niet eens bestaan (`adminOnly`).

Wat zij doen, wordt nog steeds gelogd: alleen wie het mag lezen is veranderd.

In het logboek zelf zegt de uitleg bovenaan nu: *"Alleen owners en admins zien
het logboek. Niemand kan het aanpassen of wissen."*, met in de uitklap dat
teamleden, kijkers en de boekhouder het niet zien, ook niet via Gerrie of de
API.

## Database — `20261111090000_logboek_alleen_beheer.sql`

- De leesregel `audit logs read by org members` (per module) is vervangen door
  `audit logs read by owners and admins`: `can_admin_org(organization_id)`.
- Het hek van de boekhouder (restrictive, alleen Financiën) blijft staan. Het
  doet nu niets extra, maar houdt hem dicht als de leesregel ooit weer
  verruimd wordt.
- `audit_entity_module()` blijft: de app gebruikt de indeling voor de soorten
  in het filter, en `audit.list` voor een sleutel van een owner of admin die
  tot een paar modules beperkt is.

Veilig opnieuw te draaien.

## Code

- `src/features/SimplePages.tsx`: `settingsTabRoleRule` geeft het tabblad
  `logboek` alleen aan owners en admins; de boekhouder heeft het niet meer in
  `ACCOUNTANT_SETTINGS_TABS`. Het paneel rendert ook zelf alleen voor hen.
- `src/features/Dashboard.tsx`: het blok alleen voor owners en admins; zonder
  zijkolom krijgt de staartrij één kolom.
- `src/features/AuditLog.tsx`: `isAdmin` is weg (wie kijkt, is altijd owner of
  admin); de uitleg bovenaan is aangepast.
- `src/lib/repository.ts`: `loadOrganizationContext` vraagt het logboek alleen
  op voor owners en admins.
- `supabase/functions/_shared/actions/admin.ts`: `audit.list` is `adminOnly`
  en weigert een andere rol ook zelf (hij leest met de service-role);
  `visibleAuditEntityTypes` geeft een teamlid, kijker of boekhouder een lege
  lijst.

## Getest

- `npm run typecheck` en `npm test` (1.511 tests), met in
  `supabase/functions/_shared/auditVisibility.test.ts`:
  - na de hele migratieketen staat er precies één leesregel op `audit_logs`,
    en die is `can_admin_org(organization_id)`;
  - `audit.list` is `adminOnly` en weigert een teamlid, kijker en boekhouder,
    zonder query naar de database;
  - een beperkte sleutel van een admin ziet alleen zijn modules.
- `supabase start`: de keten vanaf nul (Postgres 17.11.0.018), en de nieuwe
  migratie nog een keer erachteraan. Op de verse database staat alleen de
  nieuwe leesregel, plus het hek van de boekhouder.
- `npm run test:stromen -- beveiliging`: 161 stappen, 0 fout. De nieuwe stap
  *"het logboek: eigenaar en beheerder lezen het; lid, lezer, kijker en
  boekhouder krijgen 0 regels"* loopt tegen de echte RLS.
- Tegenproef op die database, in een transactie die is teruggedraaid. Een
  teamlid met alle modules las met de oude regel 155 van de 158 regels van
  zijn organisatie, met de nieuwe 0.
- `npm run test:mobile -- --theme=both`: 488 pagina's, 0 met problemen.
- `npm run test:loading`: alle controles geslaagd.
- Eenmalig in de browser, met de nagebootste backend, als owner en als member.
  De owner ziet het blok en het tabblad. De member ziet ze niet, de app vraagt
  `audit_logs` voor hem niet op, en er is geen JavaScript-fout.
- `deno check` kon hier niet: deno is in de cloudsessie niet beschikbaar. Dat
  doet CI na de push.
