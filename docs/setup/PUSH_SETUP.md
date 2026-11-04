# Web Push (OS-/device-meldingen) — scheduler & secrets (operator-stappen)

OS-meldingen op je apparaat (Windows/macOS/Android) zodra er een nieuw ticket,
chatbericht, klant-e-mail of boeking binnenkomt — ook als ResoFly geminimaliseerd
of gesloten is. Zet deze stappen één keer per omgeving (staging/productie). Ze staan
**bewust niet in een migratie** (project-URL + secret; de migratie blijft
deterministisch/idempotent — zelfde patroon als `CAMPAIGNS_SCHEDULER_SETUP.md`).

Onderdelen die de code al levert: de tabellen + triggers + outbox (migratie
`20260710000000_web_push.sql`), de edge function `web-push` (cron-drain + `getVapidKey`
+ `test`), de service worker `public/sw.js`, het manifest en de UI in
**Instellingen → Meldingen**.

## 1. VAPID-sleutelpaar genereren

Web Push ondertekent elke melding met een VAPID-sleutelpaar (P-256). De **publieke**
sleutel is niet geheim (die haalt de browser op om te abonneren); de **private**
sleutel is dat wél. Genereer één paar per project (mag gedeeld staging/prod):

```bash
node -e "(async()=>{const kp=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const jwk=await crypto.subtle.exportKey('jwk',kp.privateKey);const raw=new Uint8Array(await crypto.subtle.exportKey('raw',kp.publicKey));const b=(x)=>Buffer.from(x).toString('base64url');console.log('VAPID_PUBLIC_KEY =',b(raw));console.log('VAPID_PRIVATE_KEY=',jwk.d);})()"
```

`VAPID_PUBLIC_KEY` is base64url van de 65-byte publieke sleutel; `VAPID_PRIVATE_KEY`
is de base64url `d` (32-byte privéscalar). Precies wat `_shared/webPush.ts` verwacht.

## 2. Secrets zetten (Supabase Edge Function secrets)

| Secret | Waarvoor |
|---|---|
| `VAPID_PUBLIC_KEY` | Publieke VAPID-sleutel (uit stap 1). De frontend haalt deze op via `web-push` (`getVapidKey`). |
| `VAPID_PRIVATE_KEY` | Private VAPID-sleutel (uit stap 1). **Geheim.** |
| `VAPID_SUBJECT` | Contact-URI in het VAPID-JWT. Bijv. `mailto:info@resofly.nl`. |
| `PUSH_CRON_SECRET` | Beveiligt de cron-ingang `web-push?cron=drain` (header `x-cron-secret`). Kies een lange, willekeurige waarde. |
| `PUSH_ALLOWED_ORIGINS` | Toegestane app-origins voor de browser-acties, komma-gescheiden. Optioneel: valt anders terug op `MAIL_ALLOWED_ORIGINS`/`QUOTE_ALLOWED_ORIGINS`. |

```bash
npx supabase secrets set VAPID_PUBLIC_KEY='<uit-stap-1>' --project-ref <REF>
npx supabase secrets set VAPID_PRIVATE_KEY='<uit-stap-1>' --project-ref <REF>
npx supabase secrets set VAPID_SUBJECT='mailto:info@resofly.nl' --project-ref <REF>
npx supabase secrets set PUSH_CRON_SECRET='<lang-willekeurig>' --project-ref <REF>
npx supabase secrets set PUSH_ALLOWED_ORIGINS='https://staging.resofly.com,https://app.resofly.nl' --project-ref <REF>
```

> De frontend heeft **geen** build-time env-var nodig: de publieke VAPID-sleutel wordt
> tijdens het abonneren opgehaald bij de edge function. Alleen bovenstaande secrets zetten.

## 3. Migratie + functie deployen

Gebeurt automatisch bij een push naar `staging`/`main` (GitHub Action + Cloudflare
Pages). Handmatig kan ook:

```bash
npx supabase db push --linked                 # past 20260710000000_web_push.sql toe
npx supabase functions deploy web-push        # verify_jwt=false (config.toml)
```

Boot-health-check (verwacht: OPTIONS 200, POST zonder auth 401):

```bash
curl -i -X OPTIONS https://<REF>.functions.supabase.co/web-push
curl -i -X POST    https://<REF>.functions.supabase.co/web-push   # -> 401 (geen JWT)
```

## 4. pg_cron-job aanmaken (Supabase SQL Editor, één keer)

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

Plan de drain elke minuut. Vervang `<REF>` en `<PUSH_CRON_SECRET>`:

```sql
select cron.schedule(
  'web-push-drain',
  '* * * * *',                       -- elke minuut
  $$
  select net.http_post(
    url     := 'https://<REF>.functions.supabase.co/web-push?cron=drain',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<PUSH_CRON_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);
```

De drain:
- claimt een batch te-versturen meldingen uit `notification_outbox`
  (`claim_push_outbox`, `for update skip locked`, batch = `PUSH_DRAIN_BATCH`, standaard 50);
- verstuurt elke melding versleuteld naar alle apparaten van de ontvanger;
- ruimt dode abonnementen op (404/410) en markeert de rij `sent`/opnieuw-`queued`;
- geeft rijen na 5 mislukte pogingen op (`dead`).

Controleren / verwijderen:

```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'web-push-drain';
select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname='web-push-drain') order by start_time desc limit 10;
-- verwijderen: select cron.unschedule('web-push-drain');
```

## 5. Testen (end-to-end)

1. Open de app op `https://staging.resofly.com`, log in.
2. Ga naar **Instellingen → Meldingen** → **Meldingen aanzetten** (browser vraagt toestemming → Toestaan).
3. Klik **Stuur testmelding** → binnen ~1 minuut verschijnt een OS-melding.
4. Laat een collega (of jezelf via het klantportaal) een ticket/chatbericht sturen
   en controleer of de melding binnenkomt terwijl de app-tab op de achtergrond staat.

> **Per exacte origin.** Web Push-abonnementen horen bij één origin. Abonneer je op
> staging (`staging.resofly.com`), dan geldt dat niet automatisch op productie
> (`app.resofly.nl`) — daar moet je opnieuw op **Meldingen aanzetten** klikken. Eén
> VAPID-sleutelpaar mag beide origins bedienen.
