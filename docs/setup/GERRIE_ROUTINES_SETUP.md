# Gerrie Routines — operator-setup (pg_cron + secrets)

De feature "Gerrie Routines" (gebruikers bouwen eigen geplande agents) draait op de
Edge Function `gerrie-agent-runner`. De **scheduling** (pg_cron + het cron-secret) staat
bewust NIET in een migratie — die bevat een project-URL + secret. Voer onderstaande
stappen per omgeving (staging én productie) uit.

Zelfde patroon als `PUSH_SETUP.md` (web-push) en `CAMPAIGNS_SCHEDULER_SETUP.md`.

## 1. Migratie

`supabase db push` (of via CI) om `20260715000000_gerrie_scheduled_agents.sql` toe te
passen: tabellen `ai_agents` + `ai_agent_runs`, de kolommen op `ai_usage` /
`ai_action_audit` / `ai_conversations`, en de RPC `claim_due_agents`.

Sinds `20261017000000_agents_for_every_member.sql` heeft **ieder teamlid dat Gerrie
mag gebruiken eigen agents**, met precies zijn eigen rechten (zie
`CHANGELOG_AGENTS_VOOR_IEDEREEN_2026-10-17.md`): nieuwe ritmes (elke werkdag, elk uur),
een plafond op voorstellen per run, delen met het team, de leesregels per eigenaar,
de beslisregel voor de eigenaar in `ai_action_decide`, claimen tot tien per tik en het
push-type `agent_run` met `ai_agent_run_push`.

## 2. Edge-function secrets

```
supabase secrets set AGENTS_CRON_SECRET="<genereer een lange willekeurige string>"
# optioneel:
supabase secrets set AGENTS_CLAIM_LIMIT="5"        # agents per minuut-tik, naast elkaar gedraaid (1-10, standaard 5)
supabase secrets set GERRIE_ROUTINES_FROM="Gerrie <gerrie@<geverifieerd-domein>>"  # e-mailbezorging (optioneel)
```

Hergebruikt bestaande secrets: `ANTHROPIC_API_KEY`, `GERRIE_MODEL` / `GERRIE_CHEAP_MODEL`,
`GERRIE_MONTHLY_USER_COST_EUR`, `GERRIE_ALLOWED_ORIGINS` / `APP_PUBLIC_URL`, en (voor
e-mailbezorging) `RESEND_API_KEY`. Zonder `RESEND_API_KEY` + `GERRIE_ROUTINES_FROM` wordt
e-mailbezorging stil overgeslagen; in-app run-historie werkt altijd.

**Model.** Zonder `GERRIE_MODEL` / `GERRIE_CHEAP_MODEL` draait alles op
`claude-sonnet-5-5`: "Grondig" (`strong`) met effort `medium`, "Snel" (`cheap`) met
effort `low`. Staat een van beide secrets nog op een ouder model, haal hem dan weg of
zet hem bewust; de request-vorm per model regelt `_shared/claudeModels.ts`.

**Pushmeldingen** (`agent_run`) gaan via de bestaande Web Push-keten
(`PUSH_SETUP.md`); er is geen extra secret voor nodig. De eigenaar kiest per agent of
hij een melding wil, en kan ze uitzetten in Instellingen → Meldingen → *Je agents*.

## 3. Deploy

```
supabase functions deploy gerrie-agent-runner
```

Na een wijziging in `_shared/gerrieCore.ts`, `claudeModels.ts`, `agentAccess.ts`,
`agentSchedule.ts` of `agentRun.ts` ook: `gerrie-agent`, `gerrie-signals`, `mcp` en
`api`. Na `claudeModels.ts`, `claudeSummary.ts` of `claudeInvoice.ts` bovendien:
`invoice-extract`, `invoice-inbox`, `mail-inbound`, `meeting-transcribe` en
`meeting-transcribe-webhook`.

Verifieer de boot (geheugen *verify-edge-function-deploys* — edge-fns zitten niet in
`npm run typecheck`):

```
# lokaal, vóór deploy:
deno check supabase/functions/gerrie-agent-runner/index.ts

# na deploy — cron-pad zonder secret moet 401 geven (bewijst dat de functie boot):
curl -s -o /dev/null -w "%{http_code}\n" "https://<PROJECT_REF>.functions.supabase.co/gerrie-agent-runner?cron=tick"
# verwacht: 401
```

## 4. pg_cron (elke minuut)

Draai in de SQL-editor (vervang `<PROJECT_REF>` en `<AGENTS_CRON_SECRET>`):

```sql
select cron.schedule(
  'gerrie-agents-tick',
  '* * * * *',
  $$
    select net.http_post(
      url     := 'https://<PROJECT_REF>.functions.supabase.co/gerrie-agent-runner?cron=tick',
      headers := jsonb_build_object('x-cron-secret', '<AGENTS_CRON_SECRET>'),
      body    := '{}'::jsonb
    );
  $$
);
```

Controleer/verwijderen:

```sql
select jobid, schedule, jobname from cron.job where jobname = 'gerrie-agents-tick';
-- select cron.unschedule('gerrie-agents-tick');
```

> Minuut-granulariteit past bij alle ritmes, ook "elk uur" en een eigen minuut. Elke tik
> claimt hooguit `AGENTS_CLAIM_LIMIT` agents (lease van 10 min, `FOR UPDATE SKIP LOCKED`;
> de database laat er nooit meer dan tien toe) en draait ze naast elkaar; de rest volgt
> de volgende minuut. `net.http_post` is fire-and-forget — observability zit
> in `ai_agent_runs.status` + de edge-logs.

## 5. Rooktest

1. Maak in de app (Gerrie → Agents) een report-agent aan met opdracht
   "Geef een overzicht van openstaande facturen" en klik **Nu draaien**.
2. Controleer de run-historie: status `succeeded` + een samenvatting.
3. Activeer de agent (dagelijks, over 1-2 minuten) en controleer dat de cron een run
   aanmaakt. Een dubbele tik mag géén tweede run voor hetzelfde slot geven
   (`unique(agent_id, occurrence_key)`).
4. Maak een propose-agent (bv. `list_due_reminders` + `propose_send_reminders`), draai
   hem, en controleer dat er een rij in `ai_action_audit` staat met status `proposed`
   (en dat er niets is verstuurd tot je in de app goedkeurt).
5. **Delen** (owner): deel een agent die facturen én taken leest met het team.
6. **Als member** (Gerrie op volledig, Financiën dicht): in de editor staan geen
   facturen tussen de gegevens. Maak onder *Gedeeld door je team* met **Gebruik deze**
   een kopie van de agent uit stap 5: de app meldt dat de facturen niet zijn
   meegenomen. Draai de kopie; wat hij klaarzet staat in *Jouw akkoord* van die member
   — niet in die van de owner (die ziet het alleen via "Toon … van collega's").
7. **Als viewer**: maak een agent. "Wat mag de agent?" staat vast op rapporteren en de
   agent zet niets klaar.
8. **Als owner**: open de agent van de member onder *Agents van je team*. Je kunt hem
   pauzeren en archiveren, niet aanzetten of bewerken.
