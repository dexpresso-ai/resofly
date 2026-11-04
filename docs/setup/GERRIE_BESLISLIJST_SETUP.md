# Gerrie signaleert (beslislijst) — operator-setup (pg_cron + secrets)

De beslislijst draait op de Edge Function `gerrie-signals`. De **scheduling** (pg_cron +
het cron-secret) staat bewust NIET in een migratie — die bevat een project-URL + secret.
Voer onderstaande stappen per omgeving (staging én productie) uit.

Zelfde patroon als `GERRIE_ROUTINES_SETUP.md`, `PUSH_SETUP.md` en `CAMPAIGNS_SCHEDULER_SETUP.md`.

## 1. Migratie

`npx supabase db push --linked` om `20260914000000_gerrie_beslislijst.sql` toe te passen:
tabellen `ai_signal_settings`, `ai_signals`, `ai_decisions`, `ai_decision_mutes`, de
kolom `signal_id` op `ai_action_audit` en `ai_usage`, zeven triggers, de veegronde
(`collect_time_signals`), `ai_decisions_expire`, de claim-RPC's, `ai_decision_resolve`,
`ai_decision_mute`, `ai_decision_digest_push`, `purge_ai_signals`, en het push-type
`decision_digest` in beide CHECKs.

## 2. Edge-function secrets

```
supabase secrets set SIGNALS_CRON_SECRET="<genereer een lange willekeurige string>"
# optioneel:
supabase secrets set SIGNALS_CLAIM_LIMIT="3"   # signalen per minuut-tik (1-5, standaard 3)
```

Hergebruikt bestaande secrets: `ANTHROPIC_API_KEY`, `GERRIE_CHEAP_MODEL` (Gerrie-kaarten
draaien altijd op het zuinige model), `GERRIE_MONTHLY_USER_COST_EUR` (het maandtegoed van
de actor; op het cron-pad FAIL-CLOSED), `GERRIE_ALLOWED_ORIGINS` / `APP_PUBLIC_URL`.

## 3. Deploy

Volgorde: frontend eerst (Cloudflare Pages vanaf `staging`), dan de edge functions.

```
deno check supabase/functions/gerrie-signals/index.ts
supabase functions deploy gerrie-signals
# gerrieCore kreeg nieuwe exports (buildProposal, lineTotal): ook opnieuw deployen
supabase functions deploy gerrie-agent
supabase functions deploy gerrie-agent-runner
```

Boot-health (edge-fns zitten niet in `npm run typecheck`):

```
curl -s -o /dev/null -w "%{http_code}\n" "https://<PROJECT_REF>.functions.supabase.co/gerrie-signals?cron=tick"
# verwacht: 401 (functie boot, secret ontbreekt)
```

## 4. pg_cron (elke minuut)

Draai in de SQL-editor of via `npx supabase db query --linked "<sql>"` (vervang
`<PROJECT_REF>` en `<SIGNALS_CRON_SECRET>`):

```sql
select cron.schedule(
  'gerrie-signals-tick',
  '* * * * *',
  $$
    select net.http_post(
      url     := 'https://<PROJECT_REF>.functions.supabase.co/gerrie-signals?cron=tick',
      headers := jsonb_build_object('x-cron-secret', '<SIGNALS_CRON_SECRET>'),
      body    := '{}'::jsonb
    );
  $$
);
```

Controleer/verwijderen:

```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'gerrie-signals-tick';
select status, return_message, start_time from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'gerrie-signals-tick') order by start_time desc limit 5;
-- select cron.unschedule('gerrie-signals-tick');
```

> Zonder deze job verschijnt er stil nooit een kaart. De instellingenpagina toont dan
> "Laatste veegronde: nog nooit". Elke tik claimt hoogstens 2 veegrondes en
> `SIGNALS_CLAIM_LIMIT` signalen (lease 10 min, `FOR UPDATE SKIP LOCKED`); een Gerrie-kaart
> is één tool-loop van 10-30 s, de rest volgt de volgende minuut.

## 5. Aanzetten (in de app)

Gerrie → tab **Beslissingen** → schakelaar **Aan** (owner/admin). Wie aanzet wordt de
actor: Gerrie-kaarten draaien onder zijn maandtegoed en modulerechten. De eerste
veegronde (backfill van geopende offertes en verstuurde contracten) start binnen een
minuut; met **Nu rondkijken** hoef je niet te wachten.

## 6. Rooktest per kaartsoort

1. **Actiepunten uit notulen** (regel): neem een gesprek op bij een afspraak met een
   project, laat de notulen maken → kaart met afvinklijst → vink af → taken staan in het
   project.
2. **Favorieten** (regel): kies in een deellink of het portaal een favoriet → in
   "Wacht op rijping" verschijnt het signaal (rijpt na 6 uur) → **Nu beoordelen** →
   kaart → Akkoord → taak "Selectie nabewerken".
3. **Offerte geopend** (Gerrie): verstuur een offerte naar een testadres en open de
   mail → signaal rijpt na de wachttijd → **Nu beoordelen** → kaart met concept-opvolgmail
   → Akkoord → de mail staat in de afvinklijst en gaat pas weg na jouw vinkje.
4. **Klantmail** (Gerrie): laat een testklant terugmailen; open de mail NIET → na
   4 uur (of **Nu beoordelen**) een conceptantwoord, ticket of taak — of "geen actie".
5. **Opvangbak** (regel): mail vanaf een onbekend adres met hetzelfde domein als een
   klant → kaart "Mail koppelen aan …" → Akkoord → bericht in het klantdossier.
6. **Later / Niet meer**: "Later → morgen" haalt de kaart weg en brengt hem om 08:00
   terug; "Niet meer → alles van deze klant" sluit ook andere open kaarten van die
   klant en staat in **Gedempt**.
7. **Cross-org**: een signaal van organisatie A levert nooit een kaart in organisatie B
   (kaarten zijn alleen zichtbaar bij leesrecht op de module én op Gerrie).
