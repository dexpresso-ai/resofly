# Agenda's via link (iCal/ICS-abonnementen) — operator-stappen

Read-only agenda's die de gebruiker toevoegt met een iCal/ICS-URL (Google "geheime
iCal-adres", Outlook gepubliceerde `.ics`, iCloud, of een andere feed). De server
haalt de feed op, parseert 'm (ical.js) en cachet de afspraken in `calendar_events`.

De feature **werkt al zonder de onderstaande cron**: bij toevoegen wordt de feed
meteen één keer opgehaald, en er is een **"Ververs nu"**-knop per abonnement. De cron
houdt de abonnementen daarna automatisch vers.

Migratie (`20260713000000_calendar_ics_subscriptions.sql`) en de functie
(`calendar-integrations`, hergebruikt — géén nieuwe functie) zijn al gedeployed op
staging. Alleen het secret + de pg_cron-job zijn nog handmatige stappen per omgeving.

## 1. Secret zetten (Edge Function secret)

| Secret | Waarvoor |
|---|---|
| `CALENDAR_ICS_CRON_SECRET` | Beveiligt de cron-ingang `calendar-integrations?cron=ics` (header `x-cron-secret`). Kies een lange, willekeurige waarde. |

```bash
npx supabase secrets set CALENDAR_ICS_CRON_SECRET='<lang-willekeurig>' --project-ref <REF>
```

Zonder dit secret geeft de cron-ingang 401 (veilig); de refresh draait dan simpelweg niet.

## 2. Migratie + functie (al gedaan op staging)

```bash
npx supabase db push --linked                        # 20260713000000_calendar_ics_subscriptions.sql
npx supabase functions deploy calendar-integrations  # verify_jwt=false (config.toml)
```

Boot-health-check (verwacht: OPTIONS 200, cron zonder secret 401):

```bash
curl -i -X OPTIONS https://<REF>.functions.supabase.co/calendar-integrations
curl -i -X POST    "https://<REF>.functions.supabase.co/calendar-integrations?cron=ics"   # -> 401
```

## 3. pg_cron-job aanmaken (Supabase SQL Editor, één keer)

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

Plan de refresh elk kwartier. De functie ververst per tick alleen bronnen die langer
dan ~55 min niet gesynct zijn (`ICS_REFRESH_AGE_MINUTES`), met conditionele GET
(ETag/inhoud-hash) — de meeste ticks doen dus weinig werk. Vervang `<REF>` en `<CALENDAR_ICS_CRON_SECRET>`:

```sql
select cron.schedule(
  'calendar-ics-refresh',
  '*/15 * * * *',                    -- elk kwartier
  $$
  select net.http_post(
    url     := 'https://<REF>.functions.supabase.co/calendar-integrations?cron=ics',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CALENDAR_ICS_CRON_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);
```

Controleren / verwijderen:

```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'calendar-ics-refresh';
select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname='calendar-ics-refresh') order by start_time desc limit 10;
-- verwijderen: select cron.unschedule('calendar-ics-refresh');
```

## Beveiliging & grenzen (bewust)

- **Read-only**: de client kan ICS-items niet bewerken/verwijderen (RLS-write op
  `calendar_events` staat alleen `provider='native'` toe; de sync-worker schrijft via
  de service-role). ICS-bronnen hebben `write_enabled=false`.
- **SSRF-hardening** op de server-fetch: alleen `https` (webcal→https), alleen poort 443,
  privé-/loopback-/link-local-/ULA-/CGNAT-/metadata-adressen geweerd — óók in
  IPv4-mapped/NAT64/6to4-IPv6- en decimale/octale/hex-vorm — met redirect-hervalidatie,
  5 MB-limiet en 15s-timeout.
- **Bekende residu's** (acceptabel voor deze ingelogde feature; kandidaat voor latere
  hardening): DNS-rebinding TOCTOU tussen validatie en fetch, en — als de edge-runtime
  `Deno.resolveDns` niet ondersteunt — valt de hostnaam→IP-controle terug op de
  deterministische checks (IP-literals blijven wél geweerd).
- **Geheime feed-URL**: bij een org-breed gedeeld abonnement wordt de `feed_url` (vaak
  een geheim token) niet meegestuurd naar andere leden dan de eigenaar.
