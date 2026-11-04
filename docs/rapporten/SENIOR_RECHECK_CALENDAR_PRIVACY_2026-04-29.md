# BrandCore — Senior recheck calendar privacy

Datum: 2026-04-29  
Rol: Senior Software Engineer + Senior Test Engineer

## Scope

Controle van de aangeleverde codebase `brandcore-webapp-v2-calendar-privacy.zip`, met nadruk op de nieuwe agenda-privacyfunctionaliteit en regressierisico voor bestaande CRM/project/finance/attachment-functionaliteit.

## Eindoordeel

De nieuwe agenda-privacyfunctionaliteit is technisch netjes ingebouwd op drie lagen:

1. Frontend: agenda's tonen privacy-state, eigenaren kunnen per agenda delen met organisatie, en niet-eigen controles zijn disabled.
2. Supabase/RLS: `calendar_sources.visibility` staat standaard op `private`; sources/connections zijn alleen zichtbaar voor de eigenaar of via expliciet gedeelde source.
3. Edge Function: acties zoals verversen, delen, loskoppelen en beheren zijn owner-only; viewers mogen geen schrijf- of beheeracties uitvoeren.

Conclusie: **geschikt voor staging-validatie**. Voor productie blijft een echte live smoke test met Supabase + Google/Microsoft OAuth noodzakelijk.

## Door mij extra aangescherpt

### 1. OAuth callback type/robustness fix

In `supabase/functions/calendar-integrations/index.ts` werd `token.access_token` direct doorgegeven aan `fetchAccountProfile()`. Omdat de token-response als `Record<string, string | number | undefined>` getypeerd is, kan dit bij strikte Deno/TypeScript-validatie een typeprobleem opleveren. Dit is aangepast naar expliciete normalisatie + validatie:

- `const accessToken = String(token.access_token || '')`
- duidelijke foutmelding als provider geen access token teruggeeft

### 2. Extra provider-write guard bij event aanmaken

`createEvent()` controleert nu niet alleen `write_enabled = true`, maar valideert ook opnieuw of de externe providerrol daadwerkelijk schrijfbaar is via `sourceCanWrite(calendarSource)`. Daarmee voorkom je dat een oude/stale `write_enabled`-state tot onverwachte providerfouten leidt.

### 3. Kleine SQL cleanup

De dubbele `return v_org;` in `create_organization()` is verwijderd uit alle drie de baseline SQL-bestanden:

- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
- `supabase/schema.sql`
- `supabase/BRANDCORE_DATABASE_SETUP.sql`

Geen functionele wijziging, wel schoner en minder verwarrend.

## Statische controles

Uitgevoerde gerichte checks:

```text
PASS supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql visibility default private
PASS supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql no duplicate create_organization return
PASS supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql privacy source policy
PASS supabase/schema.sql visibility default private
PASS supabase/schema.sql no duplicate create_organization return
PASS supabase/schema.sql privacy source policy
PASS supabase/BRANDCORE_DATABASE_SETUP.sql visibility default private
PASS supabase/BRANDCORE_DATABASE_SETUP.sql no duplicate create_organization return
PASS supabase/BRANDCORE_DATABASE_SETUP.sql privacy source policy
PASS OAuth access token normalized before profile call
PASS createEvent revalidates provider write access
PASS listIntegrations own/shared filter
PASS updateSource owner-only
PASS disconnect owner-only
PASS Frontend share toggle
PASS Frontend owner-only source controls
PASS Main passes currentUserId
PASS Ticket converted state sanitized
RESULT 18/18 PASS
```

## Regressiecheck bestaande functies

### CRM / projecten / taken

- Bestaande `clients`, `projects`, `tasks`, `tickets`, `notes` flows blijven via dezelfde repositorylaag lopen.
- Mutaties blijven organisatie-gescopeerd via `activeOrg.id`.
- Project aanmaken respecteert nog steeds `archived`.
- Ticketstatus `converted` blijft beschermd: handmatig omzetten zonder echte projectconversie wordt gesanitized.
- Subtaken/comments blijven in de taakmodal behouden via JSON-normalisatie.

### Finance / PDF / templates

- Offertes/facturen blijven via bestaande `FinanceForm` en `exportFinancePDF()` lopen.
- De agenda-aanpassing raakt deze module niet.
- Company settings blijven admin-only via `saveCompanySettings()`.

### Attachments / R2

- Upload/download/delete-flow is niet functioneel geraakt door de agenda-aanpassing.
- Cascade-delete blijft attachments en subtask-attachments opruimen.
- Read-only users kunnen geen uploads/deletes uitvoeren vanuit de UI en Worker controleert organisatie-write-access.

### Organisaties / multi-user

- `owner`, `admin`, `member`, `viewer` blijven onderscheidend.
- `viewer` kan agenda-events lezen waar toegestaan, maar geen OAuth starten, sources verversen, privacy wijzigen, loskoppelen of events aanmaken.
- Calendar tokens blijven niet direct via RLS toegankelijk; alleen de Edge Function gebruikt service-role toegang.

## Privacybeoordeling agenda's

Voldoet aan de gewenste moderne SaaS-opzet:

- Persoonlijke agenda's staan standaard privé.
- Alleen de eigenaar kan een agenda delen met de organisatie.
- Alleen eigen agenda's en expliciet gedeelde agenda's worden opgehaald.
- Admins kunnen niet zomaar privé-agenda's openen, verversen of loskoppelen.
- Accountgegevens van gedeelde agenda's worden gemaskeerd voor andere gebruikers.
- Defensieve masking naar `Bezet` is aanwezig als private events ooit in een toekomstige availability-flow terechtkomen.

## Niet live bewezen in deze sandbox

Deze punten vereisen echte infrastructuur:

1. `npm ci && npm run typecheck && npm run build` met volledige dependency-installatie.
2. Fresh install van Supabase met `supabase/BRANDCORE_DATABASE_SETUP.sql`.
3. RLS-test met minimaal drie gebruikers: owner/admin, member, viewer.
4. Google OAuth callback + token refresh + event sync.
5. Microsoft OAuth callback + token refresh + event sync.
6. Cloudflare R2 upload/download/delete tegen echte bucket.

## Staging smoke test advies

1. Nieuwe Supabase database aanmaken.
2. Alleen `supabase/BRANDCORE_DATABASE_SETUP.sql` uitvoeren.
3. `.env.local` vullen voor Supabase en R2.
4. Supabase Edge Function `calendar-integrations` deployen met secrets.
5. Lokaal/CI draaien:
   - `npm ci`
   - `npm run typecheck`
   - `npm run build`
6. Test met drie gebruikers:
   - User A koppelt Google/Microsoft agenda, deelt niets → User B/admin ziet niets.
   - User A zet `Delen met organisatie` aan → User B/admin ziet gedeelde agenda/events, maar geen accountgegevens.
   - User B probeert A's source te verversen/loskoppelen/privacy te wijzigen → moet falen.
   - Viewer probeert OAuth/event create → moet falen.
   - Eigen private agenda + `Schrijven` aan → event create moet werken.
   - Provider-read-only agenda + `Schrijven` aanzetten → moet falen.

## Conclusie

De codebase is na deze recheck netter en veiliger. De nieuwe agenda-privacyfunctionaliteit lijkt geen bestaande kernfunctionaliteit te breken en is server-side goed afgedwongen. Mijn advies: **naar staging brengen voor live integratie- en RLS-tests; nog niet rechtstreeks naar productie zonder die smoke tests.**
