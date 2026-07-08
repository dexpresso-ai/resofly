# Campagnes — scheduler & secrets (operator-stappen)

Fase 1 van de e-mailmarketingmodule (campagnes + tracking + afmelden). Deze stappen
zet je één keer per omgeving (staging/productie). Ze staan **bewust niet in een
migratie**: ze bevatten een project-URL + secret, en de migratie moet
deterministisch/idempotent blijven (zelfde patroon als `INVOICE_REMINDERS_SETUP_2026-06-16.md`).

## 1. Secrets zetten (Supabase Edge Function secrets)

Nodig voor de nieuwe functies:

| Secret | Waarvoor |
|---|---|
| `CAMPAIGN_CRON_SECRET` | Beveiligt de cron-ingang `campaigns?cron=dispatch` (header `x-cron-secret`). Kies een lange, willekeurige waarde. |
| `UNSUBSCRIBE_SECRET` | HMAC-sleutel voor de afmeldlinks (`email-unsubscribe`). Kies een lange, willekeurige waarde. |

Al aanwezig en hergebruikt: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`/verzenddomein, `MAIL_INBOUND_DOMAIN`,
`RESEND_WEBHOOK_SIGNING_SECRET`, `MAIL_ALLOWED_ORIGINS`.

```bash
# vervang <...> door eigen willekeurige waarden
npx supabase secrets set CAMPAIGN_CRON_SECRET='<lang-willekeurig>' --project-ref <REF>
npx supabase secrets set UNSUBSCRIBE_SECRET='<lang-willekeurig>' --project-ref <REF>
```

## 2. Migratie + functies deployen

```bash
npx supabase db push --linked                       # past 20260708000000_email_campaigns.sql toe
npx supabase functions deploy campaigns             # verify_jwt=false (config.toml)
npx supabase functions deploy email-unsubscribe     # verify_jwt=false (config.toml)
```

Boot-health-check (verwacht: OPTIONS 200, POST zonder auth 401/400):

```bash
curl -i -X OPTIONS https://<REF>.functions.supabase.co/campaigns
curl -i -X POST    https://<REF>.functions.supabase.co/campaigns   # -> 401 (geen JWT)
curl -i "https://<REF>.functions.supabase.co/email-unsubscribe?token=x"  # -> 400 (ongeldige link)
```

## 3. pg_cron-job aanmaken (Supabase SQL Editor, één keer)

Zorg dat de extensies aanstaan (meestal al):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

Plan de dispatch elke minuut. Vervang `<REF>` en `<CAMPAIGN_CRON_SECRET>`:

```sql
select cron.schedule(
  'campaigns-dispatch',
  '* * * * *',                       -- elke minuut
  $$
  select net.http_post(
    url     := 'https://<REF>.functions.supabase.co/campaigns?cron=dispatch',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CAMPAIGN_CRON_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);
```

De dispatch:
- promoveert ingeplande campagnes die 'due' zijn (materialiseert ontvangers → status `sending`);
- verstuurt per tick een batch pending ontvangers per campagne (`CAMPAIGN_DISPATCH_BATCH`, standaard 100);
- zet een campagne op `sent` zodra de wachtrij leeg is.

Controleren / verwijderen:

```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'campaigns-dispatch';
select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname='campaigns-dispatch') order by start_time desc limit 10;
-- verwijderen: select cron.unschedule('campaigns-dispatch');
```

> **Fase 2 (stromen/follow-ups):** komt er een tweede job `email-flows-tick`
> (`*/15 * * * *` → `campaigns?cron=flows`). Nog niet nodig voor fase 1.

## 4. Afmeldlink-domein

De afmeldlink wijst standaard naar `https://<REF>.functions.supabase.co/email-unsubscribe`.
Dat werkt direct. Wil je later een net domein (bijv. `resofly.com/afmelden`), zet dan een
reverse-proxy/route naar deze functie; de token-verificatie blijft gelijk.
