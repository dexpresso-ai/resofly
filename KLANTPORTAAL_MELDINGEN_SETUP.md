# Klantmeldingen over tickets — inrichten (operator-stappen)

Klanten krijgen een e-mail als er een ticket voor hen is aangemaakt (of als ze er
zelf een indienen), als de status verandert en als er een voor de klant
zichtbaar antwoord op staat. Iedere portaalgebruiker zet dat zelf aan of uit in
het klantportaal (knop **Instellingen** rechtsboven). Een owner/admin kan het
voor de hele organisatie uitzetten in **Instellingen → E-mail → Meldingen aan
klanten**.

Wat de code al levert:

- migratie `20261004000000_portal_notifications.sql` — de tabellen, de drie
  triggers op `tickets`/`ticket_notes` en de claimfunctie (plus: een wijziging
  via de openbare API met een sleutel zonder `execute_high` mailt de klant niet);
- de edge function `portal-notify` (`verify_jwt = false`, zie `supabase/config.toml`);
- de nieuwe acties in `client-portal` en de schermen in het portaal;
- in `resend-webhook`: een harde bounce of spamklacht op een melding zet het
  adres op de suppressielijst (`email_suppressions`, bron `portal-notify`),
  zodat de volgende melding het overslaat. Dat gaat via de Resend-webhook die
  er al is (`RESEND_SETUP.md`: `email.bounced` en `email.complained`).

Wat er per omgeving (staging/productie) één keer moet: een secret en een
pg_cron-taak die de function elke minuut aanroept. Die staan bewust niet in de
migratie (project-URL + secret), net als bij `web-push` en `webhooks`.

## 1. De snelle weg: het script

```bash
SUPABASE_PROJECT_ID=<REF> SUPABASE_DB_PASSWORD='…' bash scripts/supabase-setup-webhooks.sh
```

Het script zet `PORTAL_NOTIFY_CRON_SECRET` en plant `portal-notify-drain` in,
maar alleen als die taak er nog niet is en de migratie al op de database staat.
Via GitHub doet het vinkje **setup_webhooks** van de workflow *Deploy Supabase
(staging)* hetzelfde.

## 2. Met de hand

**Secret** (een lange, willekeurige waarde; bewaar hem even):

```bash
PORTAL_NOTIFY_CRON_SECRET="$(openssl rand -base64 32)"; echo "$PORTAL_NOTIFY_CRON_SECRET"
supabase secrets set --project-ref <REF> PORTAL_NOTIFY_CRON_SECRET="$PORTAL_NOTIFY_CRON_SECRET"
```

De function gebruikt verder secrets die er al staan: `RESEND_API_KEY`,
`RESEND_FROM_EMAIL` (en optioneel `RESEND_REPLY_TO`), en `CLIENT_PORTAL_BASE_URL`
of `APP_PUBLIC_URL` voor de link naar het portaal. Ontbreekt een daarvan, dan
claimt hij niets en antwoordt hij met een 500 die zegt wat er mist; de meldingen
blijven dan gewoon wachten.

**Cron-taak** (SQL-editor; vervang `<REF>` en `<PORTAL_NOTIFY_CRON_SECRET>`):

```sql
select cron.schedule(
  'portal-notify-drain',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<REF>.functions.supabase.co/portal-notify?cron=drain',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<PORTAL_NOTIFY_CRON_SECRET>'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
```

## 3. Optionele instellingen (Edge Function secrets)

| Secret | Standaard | Wat |
|---|---|---|
| `PORTAL_NOTIFY_MIN_AGE_SECONDS` | 30 | Zo lang na de eerste wijziging op een ticket wacht de mail. Een antwoord en een statuswijziging vlak na elkaar komen zo samen in één mail. |
| `PORTAL_NOTIFY_MAX_AGE_HOURS` | 48 | Ouder dan dit wordt niet meer gemaild. Zet je de cron pas later aan, dan krijgen klanten geen stapel oude meldingen. |
| `PORTAL_NOTIFY_BATCH` | 50 | Hoeveel gebeurtenissen per minuut maximaal. |

## 4. Controleren

```bash
curl -i -X POST "https://<REF>.supabase.co/functions/v1/portal-notify?cron=drain"   # -> 401 (geen secret)
```

De rooktest na elke deploy (`scripts/supabase-smoke-test.sh`) doet dit ook, en
roept de wachtrij met het secret uit de cron-taak aan zodra die taak er is.

Wat er klaarstaat en wat er gebeurde:

```sql
select kind, notify_status, attempts, last_error, notified_emails, created_at
  from public.portal_ticket_activity
 order by created_at desc
 limit 20;
```

- `queued` / `sending` — wacht op de volgende ronde;
- `done` — verwerkt; `notified_emails` zegt wie een mail kreeg (leeg kan: niemand
  wilde deze melding, of de klant heeft geen portaaladres);
- `skipped` — bewust niet gemaild, met de reden in `last_error` (organisatie heeft
  het uitgezet, antwoord weer intern gemaakt, te oud, gewijzigd via de API met
  een sleutel zonder `execute_high`, …);
- `dead` — vijf keer mislukt; `last_error` zegt waarom.

Laatste rondes van de taak:

```sql
select status, return_message, start_time
  from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'portal-notify-drain')
 order by start_time desc
 limit 10;
```

## 5. End-to-end testen

1. Zorg dat een testklant een e-mailadres heeft waar je bij kunt, en log in op
   `/portal` met dat adres.
2. Dien in het portaal een ticket in → binnen ongeveer een minuut komt de mail
   "Ticket ontvangen".
3. Zet in de app een zichtbare notitie op dat ticket en wijzig de status → één
   mail met het antwoord en de nieuwe status. De knop in de mail opent het ticket
   direct in het portaal (ook als je eerst nog moet inloggen).
4. Zet in het portaal onder **Instellingen** "Nieuw antwoord" uit en plaats nog
   een notitie → geen mail; in het portaal staat het antwoord wel, met een stip.
