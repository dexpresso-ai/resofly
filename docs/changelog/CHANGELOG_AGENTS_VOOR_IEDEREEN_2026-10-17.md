# Agents voor iedereen, met precies je eigen rechten — en Claude Sonnet 5.5 — 2026-10-17

Geplande Gerrie-agents waren een owner/admin-functie. Een teamlid dat Gerrie in de
chat vroeg "doe dit elke maandag", kreeg een agentkaart die bij het aanmaken
vastliep op *"Alleen owners en admins kunnen Routines beheren"*.

Vanaf nu kan **iedereen die Gerrie mag gebruiken eigen agents maken en gebruiken**.
De regel waar alles om draait: **een agent kan nooit meer dan degene namens wie
hij draait.** En alle AI in ResoFly — de chat, de agents, de beslislijst, de
notulen en de factuurherkenning — draait standaard op **Claude Sonnet 5.5**.

## Wie mag wat

| Wie | Eigen agents | Wat zijn agent mag |
|---|---|---|
| Owner, admin | ja | lezen en klaarzetten; plus **toezicht** op de agents van het team |
| Member, Gerrie op "volledig" | ja | lezen en klaarzetten, binnen zijn eigen modulerechten |
| Member met Gerrie op "lezen", viewer | ja | **alleen meekijken** (rapporteren) |
| Member met Gerrie op "geen", boekhouder | nee | — |

- **Wat een agent mag zien en klaarzetten volgt de toolcatalogus van zijn
  eigenaar**, die al gefilterd is op diens modulerechten. Staat Financiën voor
  een teamlid dicht, dan krijgt zijn agent geen facturen. Wat er bij het opslaan
  afvalt, zegt de app hardop ("Niet meegenomen, want daar heb jij geen rechten
  op: …") in plaats van het stil weg te laten.
- **De rechten van vandaag tellen, niet die van toen.** Bij elke run worden ze
  opnieuw bepaald. Gerrie dicht → de agent gaat op pauze. Niet meer mogen
  wijzigen → hij draait als meekijker, en dat staat in zijn logboek.
- **Aanpassen, starten, aanzetten, delen en antwoorden doet alleen de eigenaar.**
  Een owner of admin kan de agent van een collega **pauzeren, archiveren en
  terugzetten** (toezicht), maar niet aanzetten of starten: dan zou hij gaan
  draaien namens iemand die daar niet om vroeg, met diens tegoed.
- **Over de voorstellen van een agent beslist zijn eigenaar** (en een owner/admin
  als toezicht). Uitvoeren gebeurt zoals altijd in de browser, onder de sessie
  van wie op Akkoord klikt — met RLS en modulepoorten. Er is geen pad bij
  gekomen waarlangs iets zonder menselijke klik gebeurt.
- **Hoogstens 25 agents per persoon** (gearchiveerde tellen niet mee).

Eén regel voor de runner, de tests en de app: `supabase/functions/_shared/agentAccess.ts`.
`src/lib/agents.test.ts` legt de knoppen in de app ernaast, voor elke rol.

## Wat agents nu meer kunnen

- **Nieuwe ritmes**: *elke werkdag* (ma–vr) en *elk uur op werkdagen* (van–tot),
  en overal een eigen **minuut** ("08:30"). Maandelijks op de 29e–31e valt in een
  korte maand op de laatste dag. DST-bewust, in de wandklok van de agent
  (`_shared/agentSchedule.ts`).
- **Geheugen**: elke run krijgt mee wat hij de vorige drie keren vond en wat er
  met zijn voorstellen gebeurde (goedgekeurd, afgewezen, nog open). Zo zet hij
  niet elke week hetzelfde klaar en leert hij van wat je afwijst. Het geheugen
  staat gemarkeerd als gegevens uit eerdere runs, niet als opdracht.
- **Meer voorstellen per run**: instelbaar van 1 tot 10 (standaard 3), elk apart
  in de goedkeurwachtrij. Dubbele voorstellen binnen één run vallen weg.
- **Stil als er niets te melden is**: vindt hij niets, dan antwoordt hij
  `NIETS TE MELDEN` en gaat er geen mail of pushmelding uit; de run staat wel in
  de app ("niets te melden"). Bedoeld voor agents die vaak kijken.
- **Pushmelding** naar de eigenaar als zijn agent iets klaarzette of een overzicht
  klaar heeft (`agent_run`). Uit te zetten in Instellingen → Meldingen → *Je
  agents*, of door het Gerrie te vragen. Een tik op de melding opent de agent
  (`/?agent=<id>`).
- **Delen met het team**: een agent kan als startpunt gedeeld worden. Collega's
  zien zijn instellingen onder *Gedeeld door je team* en maken er met **Gebruik
  deze** een eigen kopie van — die draait met hún rechten. Runs, logboek en
  voorstellen blijven van de eigenaar. Ook je eigen agent kun je kopiëren.
- **Deze maand** per agent: runs, runs zonder nieuws, voorstellen, hoeveel je er
  goedkeurde of afwees, en de kosten. Wijs je meer af dan je goedkeurt, dan zegt
  hij dat de opdracht te ruim is.
- **Proefdraaien in de editor** (alleen kijken, niets klaarzetten) en **Opslaan
  en aanzetten** in één keer.
- **Nieuwe startpunten**: *Ochtendbriefing* (elke werkdag: agenda, taken,
  tickets), *Ticketwacht* (elk werkuur, stil als er niets is) en *Urencheck op
  vrijdag*. Je ziet alleen startpunten die met jouw rechten werken.
- **Jouw akkoord** toont wat op JOU wacht. Een owner/admin kan er de voorstellen
  van de agents van collega's bij halen ("Toon 3 van collega's"); die wachten op
  de collega en tellen niet mee in je badge.
- **Meer agents tegelijk**: de runner claimt tot tien agents per minuut-tik
  (`AGENTS_CLAIM_LIMIT`, 1–10, standaard 5) en draait ze naast elkaar.

## Claude Sonnet 5.5

- `claude-sonnet-5-5` is het standaardmodel van Gerrie (chat, agents, de
  agentbouwer, de beslislijst), de notulen en de factuurherkenning. Een ander
  model kies je met de secrets `GERRIE_MODEL`, `GERRIE_CHEAP_MODEL` en
  `INVOICE_EXTRACT_MODEL` — zonder codewijziging.
- Een agent kiest tussen **Grondig** (`strong`, effort `medium`) en **Snel**
  (`cheap`, effort `low`): hetzelfde model, alleen hoe lang hij nadenkt. Nieuwe
  agents staan op Grondig; *Ticketwacht* op Snel.
- Wat Sonnet 5.5 anders vraagt, staat op één plek (`_shared/claudeModels.ts`):
  - **geen geforceerde `tool_choice`** (`any`/`tool` geeft een 400): de bouwer,
    de planner en de factuurherkenning vragen nu met `auto` (en
    `disable_parallel_tool_use`) om precies één tool-aanroep. Komt er toch tekst
    terug, dan proberen de planner en de factuurherkenning het één keer opnieuw;
    de bouwer stelt die tekst gewoon als volgende vraag;
  - **adaptive thinking + `output_config.effort`**; `max_tokens` omhoog (16k
    voor gestreamde beurten), want het nadenken telt daarin mee;
  - **weigeringen**: `stop_reason: "refusal"` wordt netjes afgehandeld (een
    Nederlandse melding; een geplande run eindigt als *deels*), met de
    server-side fallback (`fallbacks: "default"`) die in dezelfde aanroep een
    vangnetmodel laat overnemen. Van de poging die weigerde gaat alleen de tekst
    mee terug de geschiedenis in — zijn denkstappen en tool-aanroepen niet;
  - de **laatste samenvattende beurt houdt de tools** (met `tool_choice: none`)
    in plaats van ze weg te laten, zodat het nadenken van de vorige beurten
    geldig blijft;
  - **kosten per poging**: verbruik en tegoed rekenen elke poging tegen het
    tarief van het model dat hem deed — de geweigerde poging tegen het gevraagde
    model, de overname tegen het vangnetmodel — uit één prijstabel.
- Tests: `claudeModels.test.ts` bewaakt onder meer dat er nergens meer een
  geforceerde `tool_choice` naar Sonnet 5.5 gaat.

## Database — `20261017000000_agents_for_every_member.sql`

- `ai_agents`: `minute`, `end_hour`, `max_proposals_per_run` (1–10),
  `visibility` (`private`/`team`), `copied_from` (met org-integriteitstrigger),
  de nieuwe ritmes in de `schedule_kind`-check, en twee indexen.
- **Lezen (RLS)**: een teamlid ziet zijn eigen agents, runs, logboek en
  voorstellen; owners/admins alles. Een gedeelde agent is zichtbaar voor members
  en viewers (niet voor de boekhouder) — zijn runs en logboek niet. Het logboek
  krijgt de Gerrie-modulepoort in de policy zelf.
- **Beslissen**: `ai_action_decide` laat de eigenaar van een agent over diens
  voorstellen beslissen (Gerrie op "volledig" vereist). Gekoppelde AI,
  API-sleutels en signalen blijven bij owners/admins.
- **Claimen**: `claim_due_agents` tot tien per tik.
- **Push**: `agent_run` in beide CHECKs, plus `ai_agent_run_push(run_id)` —
  alleen de service-role; de ontvanger komt uit de agent, niet van de aanroeper.
- Er komen bewust **geen schrijf-policies** bij: alles wat een agent wijzigt,
  loopt via `gerrie-agent-runner` (service-role) en diens rechtencontrole.

## Uitrollen

1. Migratie toepassen (`supabase db push`).
2. Functies deployen die de gewijzigde gedeelde modules gebruiken:
   `gerrie-agent-runner`, `gerrie-agent`, `gerrie-signals`, `mcp`, `api`,
   `invoice-extract`, `invoice-inbox`, `mail-inbound`, `meeting-transcribe`,
   `meeting-transcribe-webhook`.
3. Secrets nalopen: staat `GERRIE_MODEL`, `GERRIE_CHEAP_MODEL` of
   `INVOICE_EXTRACT_MODEL` nog op een ouder model, haal hem weg (dan geldt
   `claude-sonnet-5-5`) of zet hem bewust. `AGENTS_CLAIM_LIMIT` mag nu tot 10.
4. Rooktest: zie `GERRIE_ROUTINES_SETUP.md` §5 (nu ook als member en als viewer).

## Getest

- `npm test` (807 tests), `npm run typecheck`, `npm run build`.
- `deno check` op alle functies die de gewijzigde modules gebruiken.
- `npm run test:mobile` op Gerrie en het dashboard (telefoon, tablet, desktop),
  en de agentspagina met voorbeeldagents als owner én als member (eigen, gedeeld,
  van het team, het paneel, de editor en de wachtrij): geen fouten, geen
  horizontale overloop.

## Uitgerold op staging — 2026-10-17

Op `Resofly-staging` (`enzghpduqwaojcxgwarr`), vanaf branch `ccr-01e0d48b-cd8y32`:

1. **Migratie** toegepast. Bewust nog níet in `supabase_migrations.schema_migrations`
   gezet: zolang de branch niet in `staging` zit, zou de CI anders falen op een
   migratie die hij lokaal niet kent. Na de merge past `db push` hem opnieuw toe;
   dat hij idempotent is, is op staging gecontroleerd (twee keer gedraaid, niets
   dubbel).
2. **Functies** gedeployd met `supabase functions deploy --use-api` (zoals de CI),
   `verify_jwt` ongewijzigd uit `config.toml`. De runner, `gerrie-signals` en
   `invoice-inbox` antwoorden hun cron-aanroepen daarna met 200.
3. **Secrets**: `GERRIE_MODEL`, `GERRIE_CHEAP_MODEL` en `INVOICE_EXTRACT_MODEL`
   stonden niet; alles draait dus op Claude Sonnet 5.5. `AGENTS_CLAIM_LIMIT` = 3
   (geldig, gelaten).
4. **Rooktest**:
   - rechten per rol in de database (in een transactie die wordt teruggedraaid):
     member, owner, viewer en "Gerrie uit" zien precies wat ze horen te zien;
     de beslisregel en de pushmelding doen wat ze moeten doen;
   - echte runs via de cron, op Claude Sonnet 5.5: een rapport-agent ("elke
     werkdag" — op zaterdag doorgeschoven naar maandag 08:30), een agent die een
     taak klaarzet (in de wachtrij op naam van de eigenaar, daarna afgewezen via
     `ai_action_decide`), het geheugen (de volgende run wist dat de vorige taak
     was afgewezen) en "stil als er niets te melden is". Vijf runs, samen ± $ 0,14.
     De twee testagents ("Rooktest — … (mag weg)") staan gearchiveerd.
   - De rooktest vond twee fouten, beide opgelost en opnieuw getest: een agent met
     één voorstel per run sloeg zijn afsluitende samenvatting over (hij gedroeg zich
     als de chat), en "niets te melden" werd gemist als de agent eerst een
     aanloopzin schreef.
   - Niet getest vanaf hier: de functies rechtstreeks aanroepen (de proxy van deze
     sessie laat alleen `api.supabase.com` door; `scripts/supabase-smoke-test.sh`
     draait in de CI) en de nieuwe schermen, die pas na een merge op staging staan.
