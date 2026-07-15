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

## 2. Edge-function secrets

```
supabase secrets set AGENTS_CRON_SECRET="<genereer een lange willekeurige string>"
# optioneel:
supabase secrets set AGENTS_CLAIM_LIMIT="3"        # aantal agents per minuut-tik (1-5, standaard 3)
supabase secrets set GERRIE_ROUTINES_FROM="Gerrie <gerrie@<geverifieerd-domein>>"  # e-mailbezorging (optioneel)
```

Hergebruikt bestaande secrets: `ANTHROPIC_API_KEY`, `GERRIE_MODEL` / `GERRIE_CHEAP_MODEL`,
`GERRIE_MONTHLY_USER_COST_EUR`, `GERRIE_ALLOWED_ORIGINS` / `APP_PUBLIC_URL`, en (voor
e-mailbezorging) `RESEND_API_KEY`. Zonder `RESEND_API_KEY` + `GERRIE_ROUTINES_FROM` wordt
e-mailbezorging stil overgeslagen; in-app run-historie werkt altijd.

## 3. Deploy

```
supabase functions deploy gerrie-agent-runner
```

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

> Minuut-granulariteit is ruim voldoende voor dagelijks/wekelijks/maandelijks. Elke tik
> claimt hooguit `AGENTS_CLAIM_LIMIT` agents (lease van 10 min, `FOR UPDATE SKIP LOCKED`);
> de rest volgt de volgende minuut. `net.http_post` is fire-and-forget — observability zit
> in `ai_agent_runs.status` + de edge-logs.

## 5. Rooktest

1. Maak in de app (Gerrie → Routines, owner/admin) een report-agent aan met opdracht
   "Geef een overzicht van openstaande facturen" en klik **Nu draaien**.
2. Controleer de run-historie: status `succeeded` + een samenvatting.
3. Activeer de agent (dagelijks, over 1-2 minuten) en controleer dat de cron een run
   aanmaakt. Een dubbele tik mag géén tweede run voor hetzelfde slot geven
   (`unique(agent_id, occurrence_key)`).
4. Maak een propose-agent (bv. `list_due_reminders` + `propose_send_reminders`), draai
   hem, en controleer dat er een rij in `ai_action_audit` staat met status `proposed`
   (en dat er niets is verstuurd tot je in de app goedkeurt).
