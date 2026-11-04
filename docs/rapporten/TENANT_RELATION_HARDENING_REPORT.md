# BrandCore tenant-safe relation hardening

Datum: 26 april 2026

## Wat is aangepast

De row-level security was al goed opgezet per `user_id`, maar relationele verwijzingen konden nog theoretisch cross-tenant wijzen wanneer iemand de normale UI zou omzeilen en rechtstreeks gemanipuleerde API-calls naar PostgREST zou sturen.

Daarom is de integriteit nu ook **op databaseniveau** afgedwongen.

### 1. Nieuwe tenant-integrity helper
In `supabase/schema.sql` en in de migratie is een generieke functie toegevoegd:

- `public.assert_same_tenant_reference(...)`

Deze controleert of een referenced record:
- bestaat
- én dezelfde `user_id` heeft als het child-record dat wordt opgeslagen

### 2. Nieuwe BEFORE INSERT/UPDATE triggers
Per relevante tabel zijn tenant-integrity triggers toegevoegd:

- `projects.client_id -> clients`
- `tasks.project_id -> projects`
- `tickets.client_id -> clients`
- `tickets.converted_to_project_id -> projects`
- `notes.client_id -> clients`
- `notes.project_id -> projects`
- `quotes.client_id -> clients`
- `quotes.project_id -> projects`
- `invoices.client_id -> clients`
- `invoices.project_id -> projects`
- `invoices.quote_id -> quotes`
- `attachments.parent_task_id -> tasks`
- `attachments.entity_type/entity_id -> juiste parent tabel`

Hierdoor wordt een insert/update nu direct afgewezen wanneer een foreign reference buiten de tenant valt.

### 3. Attachments ook tenant-safe gemaakt
Omdat `attachments.entity_id` polymorf is en geen gewone foreign key heeft, is daar expliciete trigger-validatie voor toegevoegd.

Extra hardening:
- `subtask` attachments vereisen nu een geldige `parent_task_id`
- die parent task moet ook van dezelfde gebruiker zijn

### 4. Bestaande omgevingen krijgen een losse migratie
Toegevoegd bestand:

- `supabase/migrations/20260426_harden_tenant_safe_relations.sql`

Deze migratie doet eerst een **preflight audit** op bestaande data en stopt bewust wanneer er al cross-tenant vervuiling aanwezig is. Zo gaat productie niet stilzwijgend verder op inconsistente data.

## Waarom dit production-safe is

- RLS blijft de eerste verdedigingslaag.
- De triggers vormen nu een tweede, relationele verdedigingslaag.
- Ook bij handmatige of gemanipuleerde API-calls kan een record niet meer naar een parent van een andere tenant wijzen.
- Bestaand UI-gedrag blijft intact, omdat normale selecties al binnen de eigen tenant plaatsvinden.
- `ON DELETE CASCADE` en `ON DELETE SET NULL` van de bestaande foreign keys blijven gewoon werken.

## Bestanden aangepast

- `supabase/schema.sql`
- `supabase/migrations/20260426_harden_tenant_safe_relations.sql`

## Advies voor uitrol

1. Draai eerst de nieuwe migratie op staging.
2. Controleer of de preflight audit schoon doorloopt.
3. Test daarna gericht:
   - project aanmaken met eigen client
   - task aanmaken met eigen project
   - note/quote/invoice koppelingen opslaan
   - attachment upload op eigen entity
   - negatieve test met gemanipuleerde request naar andermans entity-id
4. Pas daarna doorzetten naar productie.

## Checks in deze container

- SQL-aanpassingen doorgevoerd in schema en losse migratie.
- Codebase-structuur gecontroleerd zodat geen frontend-flow aangepast hoefde te worden.
- Frontend build niet opnieuw volledig bewezen in deze container, omdat `node_modules` in de geüploade codebase ontbraken en er hier geen dependency-install is uitgevoerd. Er zijn geen TypeScript-bronbestanden aangepast voor deze change; de wijziging zit volledig in de Supabase datalaag.
