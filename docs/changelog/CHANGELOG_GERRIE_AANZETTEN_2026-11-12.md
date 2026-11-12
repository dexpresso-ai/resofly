# Gerrie aanzetten: eerst akkoord, dan pas AI (2026-11-12)

De vraag was: laat gebruikers de AI zelf aanzetten, en pas daarna kunnen ze Gerrie gebruiken.
Bij het aanzetten gaan ze akkoord met drie dingen: de AI leest de gegevens en stelt op basis
daarvan handelingen voor, de AI kan fouten maken, en de AI beslist niets zelf zonder
toestemming.

Tot nu toe stond Gerrie voor iedereen aan zodra de module Gerrie openstond. Niemand had gelezen
of bevestigd wat dat betekent.

## Wat er nu kan

### Gerrie staat uit tot je hem zelf aanzet

Per gebruiker en per organisatie. Wie in twee organisaties werkt, zet Gerrie in elk daarvan apart
aan: het akkoord gaat over de gegevens van die organisatie.

Zolang Gerrie uit staat:

- is er geen chat rechtsonder, geen "Vraag Gerrie" in de zoekbalk en op het dashboard, geen
  beslislijst en geen rapportages met Gerrie;
- staat Gerrie nog wel in het menu. Die pagina toont dan **Zet Gerrie aan**.

### Het scherm "Zet Gerrie aan"

Drie punten, elk met een korte uitleg en een vinkje:

1. **Gerrie leest je gegevens.** Hij leest wat jij zelf mag zien, beantwoordt op basis daarvan je
   vragen en stelt handelingen voor. Om te antwoorden gaan die gegevens naar het AI-model van onze
   AI-leveranciers. Welk model of welke leverancier noemen we bewust niet
   (zie CHANGELOG_AI_MODEL_VERBORGEN_2026-11-11).
2. **Gerrie kan zich vergissen.** Kijk na wat hij zegt en voorstelt, zeker bij bedragen, datums
   en alles wat naar een klant gaat.
3. **Gerrie beslist niets zelf.** Hij zet klaar; pas als iemand op Uitvoeren klikt, gebeurt het.
   Je agents zetten ook alleen klaar. Een eigen gekoppelde AI voert alleen zelf iets uit als je
   dat per koppeling aanzet (dat kon al sinds CHANGELOG_MCP_UITVOEREN_2026-09-17; de uitleg zegt
   het nu eerlijk, in plaats van "alles wordt alleen klaargezet").

De knop **Gerrie aanzetten** werkt pas als alle drie zijn aangevinkt. Daarna verschijnen het
commandocentrum en de chat meteen, zonder de pagina te verversen.

### Instellingen → AI

Bovenaan een nieuwe kaart **Gerrie (AI)**:

- staat hij aan: sinds wanneer, waarmee je akkoord ging, en de knop **Gerrie uitzetten**. Eerst
  komt een vraag die zegt wat er gebeurt: Gerrie verdwijnt uit je scherm, je agents gaan op
  pauze, een eigen gekoppelde AI werkt niet meer, en je gesprekken en rapportages blijven bewaard;
- staat hij uit: dezelfde drie punten als op de pagina Gerrie;
- staat de module Gerrie voor je dicht: dat je de eigenaar of een beheerder moet vragen;
- voor owners en admins: **In je team**, per teamlid of Gerrie aanstaat. Aanzetten voor een
  ander kan niet; dat is ieders eigen akkoord.

### Het logboek

"anne zette Gerrie (AI) aan en ging akkoord met de uitleg" en "anne zette Gerrie (AI) uit;
2 agents gingen op pauze". Zoals het hele logboek alleen voor owners en admins.

## Waar het wordt afgedwongen

Het scherm is de beleving; de deuren naar de AI wegen het akkoord zelf. Ze draaien met de
service-role en komen niet langs RLS, dus elk doet het apart (`_shared/aiConsent.ts`):

| Deur | Wat er gebeurt zonder akkoord |
| --- | --- |
| `gerrie-agent` (chat, missies, agentbouwer, rapportages, verbruik, gesprekken) | 403 met de zin waar je Gerrie aanzet, vóór elke handeling, ook die zonder model |
| `gerrie-agent-runner`, app-pad (agents maken, starten, beheren) | 403 |
| `gerrie-agent-runner`, elke geplande of door een gebeurtenis gestarte run | de run breekt af vóór het budget en het model; de agent gaat op pauze |
| `gerrie-signals` (kaarten die Gerrie beoordeelt) | de kaart wordt overgeslagen als de actor van de beslislijst Gerrie uit heeft; regelkaarten (zonder model) gaan door |
| `mcp-oauth` (een eigen AI koppelen) | koppelen weigert, met uitleg |
| `mcp` (elke aanroep van een gekoppelde AI) | geweigerd; zet je Gerrie weer aan, dan werkt de koppeling weer |

Een akkoord onder een oudere versie van de uitleg telt niet. Verandert de tekst wezenlijk, dan
hoog je de versie op (op drie plekken, die een test gelijk houdt) en lees je hem als gebruiker
eerst opnieuw.

Niet onder dit akkoord vallen het uitlezen van inkoopfacturen (die heeft al een eigen
schakelaar voor de organisatie, onder Instellingen → E-mail) en de notulen bij een opname. Dat zijn geen
Gerrie, en je zet ze per keer zelf in gang.

## Database

Migratie `20261112190000_gerrie_aanzetten.sql`:

1. `ai_consents`: per organisatie en gebruiker `enabled`, `terms_version`, `acknowledged`,
   `accepted_at` en `disabled_at`. Lezen: je eigen rij, of als owner/admin die van het team. De
   boekhouder leest niets (het hek). Niemand schrijft zelf.
2. `ai_terms_version()`: de versie van de uitleg, nu `2026-11-12`.
3. `set_ai_consent(organisatie, aan, versie, vinkjes)`: de enige weg. Altijd voor de ingelogde
   gebruiker zelf. Aanzetten eist een actief lidmaatschap, de module Gerrie open, de huidige
   versie en alle drie de vinkjes. Uitzetten kan altijd en zet je eigen actieve agents in die
   organisatie op pauze. Twee keer aanzetten geeft geen tweede regel in het logboek.
4. `ai_enabled` en `ai_disabled` in `audit_logs_action_check`, op dezelfde manier aangevuld als
   bij `data_export`.

Bewust geen module gate op `ai_consents`: die zet ook een schrijftrigger op de tabel, en dan kon
wie de module Gerrie dicht kreeg, hem niet meer uitzetten.

**Na de uitrol staat Gerrie voor iedereen op staging uit**, ook voor wie hem al gebruikte. Dat is
de bedoeling: iedereen leest eerst wat het betekent. Agents draaien pas weer als hun eigenaar
Gerrie aanzet; ze breken tot die tijd af en gaan op pauze, en moeten daarna met de hand weer aan.
Een gekoppelde eigen AI werkt weer zodra zijn eigenaar Gerrie aanzet.

## Bestanden

| Bestand | Wat |
| --- | --- |
| `supabase/migrations/20261112190000_gerrie_aanzetten.sql` | tabel, versie, `set_ai_consent`, logboek |
| `supabase/functions/_shared/aiConsent.ts` | `hasAiConsent`, de versie, de weigering |
| `supabase/functions/gerrie-agent`, `gerrie-agent-runner`, `gerrie-signals`, `mcp`, `mcp-oauth` | de controle |
| `src/lib/aiConsent.ts` | de drie punten, de versie, aan/uit |
| `src/lib/permissions.ts` | zonder akkoord is de module Gerrie dicht, behalve de pagina; `gerrieNeedsConsent` |
| `src/lib/repository.ts` | het akkoord laden met het lidmaatschap; `setAiConsent` |
| `src/components/GerrieAanzetten.tsx` | het scherm, de kaart in Instellingen → AI |
| `src/main.tsx`, `src/features/SimplePages.tsx` | de pagina Gerrie en Instellingen → AI |
| `src/lib/auditLog.ts` | de zinnen in het logboek |
| `src/lib/exportManifest.ts` | `ai_consents` gaat mee in de export |
| `src/styles/gerrie-aanzetten.css` | de opmaak (`gaz-*`) |

## Getest

- `npm run typecheck` en `npm test`. Nieuw:
  - `supabase/functions/_shared/aiConsent.test.ts`: de regel, `hasAiConsent` met een nep-client
    (ook een fout van de database = nee), dezelfde versie en vinkjes in database, edge functions
    en app, de rechten in `set_ai_consent`, en per deur dat de controle er staat en vóór het
    werk komt. Een nieuwe functie die het model van Gerrie aanroept zonder `hasAiConsent`, laat
    de test falen.
  - `src/lib/aiConsent.test.ts`: de teksten (ook: geen modelnaam), de vinkjes, en de rechten. Met
    Gerrie uit is de module dicht maar de pagina open; met de module dicht is er geen
    aanzetscherm; het akkoord verruimt niets.
  - `src/lib/auditLog.test.ts`: de zinnen.
- `npm run test:mobile -- --theme=both`, met drie nieuwe pagina's: `gerrie-aanzetten`,
  `settings-ai` (aan) en `settings-ai-uit`. Op de telefoon staat het icoon naast de kop. Van de
  584 metingen gaven er drie (dashboard, agenda en de publieke galerij, donker op de telefoon)
  "niet gerenderd": die liepen terwijl tegelijk de stromen-test draaide. Opnieuw gedraaid,
  zonder die belasting, waren ze groen.
- Met de hand in Chromium op de mock: de knop is dicht tot alle drie zijn aangevinkt; vóór
  aanzetten geen chat, daarna het commandocentrum, "Vraag Gerrie" en de chat, zonder fouten.
- `supabase db start`: de keten vanaf nul. Daarna in die database, als verschillende gebruikers:
  te weinig vinkjes, een oude versie en een andere organisatie geweigerd; een teamlid ziet alleen
  zijn eigen rij en kan niet zelf schrijven; met de module dicht weigert aanzetten en mag
  uitzetten; de boekhouder kan niet aanzetten en ziet niets; de eigenaar ziet het team, een andere
  organisatie niets; uitzetten pauzeert alleen de eigen actieve agent; het logboek klopt; twee
  keer aanzetten geeft één regel; anon mag niets; `accountant_fence_gaps()` is leeg; de migratie
  nog eens draaien gaat goed.
- `deno check` op de vijf functies, met supabase-js via npm (esm.sh is in de cloudsessie niet
  bereikbaar).
- `tests/stromen`: elke testgebruiker zet Gerrie aan via `set_ai_consent`, zoals in de app, en
  `agents.mjs` heeft een groep *Gerrie uitzetten*: agents op pauze en in het logboek, chat en
  runner weigeren, een al geclaimde run breekt af zonder het model, weer aanzetten alleen met
  alle vinkjes, en wie welk akkoord leest. `omgeving.mjs` zet daarvoor `AGENTS_CRON_SECRET`.
  Gedraaid op de lokale stack: `agents` (9 stappen), `rapportages` (19), `videovergadering`
  (51, met een echte MCP-koppeling), `beveiliging` (161) en `api` (59), en in de browser
  `ui.mjs rapportage rollen` (14). Alles groen.
