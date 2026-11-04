# Modulerechten per teamlid — 2026-07-30

Owners en admins kunnen vanaf nu per medewerker en per module instellen wat
diegene mag. Tot nu toe was toegang organisatiebreed: wie `member` was, zag
álles — klanten, projecten, uren én de volledige financiële module.

## Het model

Drie niveaus per module:

| Niveau  | Betekenis |
|---------|-----------|
| `none`  | Module is onzichtbaar. Geen enkele rij is leesbaar, ook niet via de API. |
| `read`  | Alleen lezen. |
| `write` | Volledig: lezen en wijzigen. |

Elf modules, gelijk aan de indeling van de zijbalk: **Klanten, Projecten, Uren,
Agenda, Tickets, Inhoud, Statistieken, Marketing, Financiën, Teamchat, Gerrie.**
Dashboard en Instellingen blijven altijd bereikbaar.

Opslag: `organization_members.module_access` (jsonb), bijvoorbeeld
`{"finance":"none","time":"read"}`. Een **ontbrekende sleutel betekent
"volledig"**. Daardoor houdt elk bestaand teamlid na de migratie precies de
toegang die het nu heeft, en zet de owner gericht modules dícht in plaats van
alles te moeten openzetten.

Vaste regels:

- **Owners en admins zijn nooit beperkt** — zij stellen de rechten juist in.
  Een op een admin ingestelde beperking wordt bewaard maar gaat pas gelden zodra
  die rol naar member of viewer gaat.
- **Een viewer krijgt nooit meer dan `read`**, wat er ook is ingesteld.
- Een admin mag rechten van members/viewers zetten; alleen een owner mag ook een
  admin beperken.

## Handhaving in drie lagen

De UI is nadrukkelijk **niet** de beveiliging.

**1. Restrictive RLS-policies** (`migratie 20260730100000`) op ~90 moduletabellen.
Restrictive policies worden ge-AND met de bestaande permissive policies, dus geen
enkele bestaande policy hoefde herschreven te worden. Ze staan op
`to authenticated`, zodat de publieke portaal- en anon-paden (die via
`security definer`-RPC's lopen) ongemoeid blijven. De generator
`public.apply_module_gate(tabel, module, schrijfniveau)` zet per tabel vier
policies (select/insert/update/delete) plus de trigger uit laag 2.

De migratie **faalt bewust hard** als een genoemde tabel niet bestaat, geen
`organization_id` heeft, of row level security uit heeft staan — een stille
overslag zou schijnveiligheid opleveren.

**2. Een BEFORE-trigger** (`zzz_module_write_gate`) op diezelfde tabellen. RLS
wordt namelijk omzeild door `security definer`-RPC's; een trigger niet. Draait
`auth.uid()` leeg — service_role, pg_cron, de CalDAV- en media-workers — dan
laat de trigger door: die paden hebben hun eigen autorisatie.

**3. Modulecontrole in de edge functions.** Die draaien op de service-role en
omzeilen daarmee zowel RLS als de triggers. Toegevoegd:

| Edge function | Module | Niveau |
|---|---|---|
| `gerrie-agent` / `gerrie-agent-runner` (via `_shared/gerrieCore.ts`) | per tool | lees-tools `read`, `propose_*` `write` |
| `invoice-workflow` | finance | `read` voor PDF/UBL-downloads, `write` voor de rest |
| `quote-workflow` | finance | idem |
| `contract-workflow` | finance | `read` voor PDF-preview/download, `write` voor versturen |
| `bank-sync` | finance | `write` |
| `invoice-extract` | finance | `write` |
| `campaigns` | marketing | `read` voor `previewAudience`, `write` voor de rest |
| `calendar-integrations` | calendar | `read`, `write` op elke schrijfactie |
| `meeting-booking` | calendar | `write` |
| `meeting-transcribe` | calendar | `read` (acties checken zelf de schrijfrol) |
| `mail` → `sendClientEmail`, `sendClientPortalWelcome` | clients | `write` |

Gerrie biedt tools van dichtgezette modules niet eens meer aan het model aan
(`allowedToolNamesFor`), met een tweede controle bij het uitvoeren.

**Bijlagen** volgen het type entiteit (`public.attachment_module`): een factuur-
bijlage valt onder Financiën, een notitiebijlage onder Inhoud, enzovoort. Een
**onbekend** `entity_type` geeft bewust `null` = niet afgeschermd — een nieuw
entity_type mag nooit stilletjes alle uploads breken (dat is eerder misgegaan bij
de org-integriteitstrigger).

**Persoonlijke "gelezen"-markeringen** (`ticket_reads`, `client_email_reads`,
`chat_participants`) mogen ook door lezers geschreven worden. Anders krijgt een
lees-only teamlid een foutmelding zodra het een ticket of chatbericht opent.

## Wat er in de app verandert

- **Zijbalk en mobiele onderbalk** tonen alleen modules met leesrecht.
- **Pagina's** van een dichte module tonen een uitleg met een knop naar een
  pagina die wél open is — ook via een onthouden tabblad of een gedeelde link.
- **Wijzigknoppen** volgen het niveau: bij `read` staat de pagina in
  "Alleen lezen", net als bij de viewer-rol.
- **Bewerkvensters** volgen de module van het record zelf: een factuur blijft
  financieel, ook als je hem vanuit een project opent.
- **Dashboard** verbergt kaarten van dichte modules. Zonder Financiën verschijnt
  er dus géén "€ 0 omzet" — dat zou suggereren dat er niets ís, terwijl je het
  alleen niet mág zien.
- **Instellingen → Organisatie & team**: per teamlid een knop **Rechten** met een
  raster van de elf modules, plus "Alles openzetten"/"Alles dichtzetten". Bij het
  uitnodigen kun je de rechten meteen meegeven; die worden bij het accepteren
  overgenomen.

## Bestanden

| Bestand | Wat |
|---|---|
| `supabase/migrations/20260730100000_module_permissions.sql` | Kolommen, helpers, policies, triggers, RPC's |
| `src/lib/permissions.ts` | Modules, niveaus, pagina→module, `buildPermissions` |
| `src/main.tsx` | Rechten berekenen, paginabewaking, module-bewuste `canWrite` |
| `src/components/Sidebar.tsx`, `BottomNav.tsx` | Navigatie filteren |
| `src/features/SimplePages.tsx` | Rechtenraster + uitnodigen met rechten |
| `src/features/Dashboard.tsx` | Kaarten per module tonen/verbergen |
| `src/lib/repository.ts`, `src/types.ts` | `setMemberModuleAccess`, `module_access` |
| `supabase/functions/_shared/edgeAuth.ts` | `getModuleLevel` / `assertModuleAccess` |

## Nieuwe database-objecten

- `organization_members.module_access`, `organization_invitations.module_access`
- `public.module_keys()`, `public.validate_module_access()`
- `public.org_module_level(uuid, text)`, `public.can_read_module`, `public.can_write_module`
- `public.my_module_access(uuid)` — alle niveaus van de ingelogde gebruiker in één call
- `public.enforce_module_write_access()`, `public.enforce_attachment_module_write_access()`
- `public.apply_module_gate(text, text, text)` — alleen voor de eigenaar/postgres
- `public.attachment_module(text)`
- `public.set_member_module_access(uuid, jsonb)`
- `public.invite_organization_member(uuid, citext, text, jsonb)` — de 3-argument-versie is gedropt

## Bewust buiten scope

- **CalDAV-worker** (`caldav_lookup_app_passwords`): synchroniseert agenda's naar
  de telefoon op de service-role en kijkt alleen naar de organisatierol, niet naar
  de Agenda-module. Wie de agenda al gekoppeld had, blijft syncen.
- **media-api / Collabora (Office-bewerken)**: draait op de service-role met een
  eigen WOPI-autorisatie; documenten zijn wel via `documents`/`content_folders`
  afgeschermd, maar een reeds uitgedeelde WOPI-sessie kent de module niet.
- **`company_settings`, `email_templates`, `audit_logs`, billing- en licentie-
  tabellen** blijven leesbaar voor elk lid: ze worden door meerdere modules
  gebruikt en bevatten geen module-inhoud.
- **Notities en documenten** kunnen aan een klant hangen. Een teamlid met Inhoud
  maar zonder Klanten ziet die notities dus wel; de klantenkaart zelf niet.

## Nog te doen

- Migratie toepassen op staging (`npx supabase db push`) en daarna op productie.
- De aangepaste edge functions opnieuw deployen: `gerrie-agent`,
  `gerrie-agent-runner`, `invoice-workflow`, `quote-workflow`,
  `contract-workflow`, `bank-sync`, `invoice-extract`, `campaigns`,
  `calendar-integrations`, `meeting-booking`, `meeting-transcribe`, `mail`.
- End-to-end test met een ingelogd testaccount: member met `finance: none` moet
  Financiën nergens zien, en de factuur-endpoints moeten 403 geven.
