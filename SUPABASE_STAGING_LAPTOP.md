# Supabase staging bijwerken vanaf je laptop

De frontend gaat vanzelf: een push naar de branch `staging` laat Cloudflare
Pages de app bouwen. Supabase (database en edge functions) gaat **niet**
vanzelf: de workflow *Deploy Supabase (staging)* in GitHub mislukt al maanden,
en sinds half september alleen nog op het ontbrekende secret
`SUPABASE_DB_PASSWORD`. Tot dat secret staat (zie
[stap 9](#9-daarna-voortaan-automatisch-via-github)), doe je het met deze
handleiding vanaf je laptop. Reken op 15 minuten de eerste keer, 5 daarna.

> **Liever helemaal niet vanaf de laptop?** Zet het secret in GitHub (stap 9)
> en start de workflow met het vinkje *setup_webhooks*. Dan doet één run alles
> uit deze handleiding: de database, de functies en de eenmalige stap 7.

> **Doe het kort na een push naar `staging`.** De app op staging draait dan al
> de nieuwe code, maar praat nog met de oude database en functies. Tot je
> stap 5 en 6 gedaan hebt, werken onder meer goedkeuren in Gerrie, API-sleutels
> en webhooks op staging niet goed.

| Onderdeel | Waarde |
|---|---|
| Supabase-project | `Database-staging`, ref **`enzghpduqwaojcxgwarr`** |
| Dashboard | https://supabase.com/dashboard/project/enzghpduqwaojcxgwarr |
| API en functies | `https://enzghpduqwaojcxgwarr.supabase.co/functions/v1/<naam>` |
| App | https://staging.resofly.com |
| Getest met | Supabase CLI 2.119.0, tegen een lokale database met dezelfde migraties: de proefrun, het toepassen, de foutmeldingen uit stap 4 en het terugdraaien bij een fout |

## Kort (als je het al eens gedaan hebt)

```bash
git checkout staging && git pull
supabase db push --dry-run --linked        # wat er klaarstaat
supabase db push --linked                  # toepassen (bevestig met y)
supabase functions deploy --project-ref enzghpduqwaojcxgwarr --use-api
```

Daarna [stap 8](#8-controleren-dat-alles-werkt). Nieuwe secrets of cron-taken
staan in de changelog van de release; voor deze release: [stap 7](#7-eenmalig-secrets-en-de-webhookbezorger).

---

## 1. Wat je nodig hebt

- De repository op je laptop (`git clone https://github.com/dexpresso-ai/resofly.git`).
- Toegang tot het Supabase-project hierboven met je eigen Supabase-account.
- Het **databasewachtwoord** van staging. Kwijt? Zet een nieuw:
  Dashboard → **Project Settings → Database → Reset database password**.
  De app zelf merkt daar niets van (die gebruikt eigen sleutels); alleen
  andere tools die met dit wachtwoord verbinden, moeten het nieuwe krijgen.
  Zet het daarna meteen ook in GitHub (stap 9): dan is dit de laatste keer.
- **Geen Docker.** Met `--use-api` bouwt Supabase de functies zelf.

## 2. De Supabase CLI installeren (eenmalig)

**macOS** (met [Homebrew](https://brew.sh)):

```bash
brew install supabase/tap/supabase
supabase --version          # 2.119.0 of nieuwer
```

Bijwerken later: `brew upgrade supabase`.

**Windows** (met [Scoop](https://scoop.sh), in PowerShell):

```powershell
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
supabase --version
```

Bijwerken later: `scoop update supabase`.

**Zonder installatie** (heb je Node.js): zet overal `npx supabase@latest`
neer waar hier `supabase` staat. Zo zijn eerdere deploys ook gedaan.

Is je versie ouder dan 2.100: eerst bijwerken. Oudere versies kennen niet alle
opties uit deze handleiding (zoals `--use-api`) en lopen vaker vast bij het
verbinden.

## 3. Inloggen en koppelen (eenmalig per laptop)

```bash
cd resofly
git checkout staging
git pull

supabase login
```

`supabase login` opent de browser. Gaat dat niet, maak dan een token op
https://supabase.com/dashboard/account/tokens en gebruik
`supabase login --token sbp_…`.

```bash
supabase link --project-ref enzghpduqwaojcxgwarr
```

Hij vraagt het databasewachtwoord en test meteen de verbinding. Meestal onthoudt
de CLI het wachtwoord (in de sleutelhanger van je systeem). Vraagt hij er later
toch weer om, typ het dan opnieuw. Je kunt het ook in je terminal zetten
(alleen voor die terminal):

```bash
export SUPABASE_DB_PASSWORD='…'               # macOS / Linux
```

```powershell
$env:SUPABASE_DB_PASSWORD = '…'               # Windows PowerShell
```

> **Let op: `supabase/.temp/` staat in git.** De CLI schrijft daar (onder meer
> welk project gekoppeld is). Zie je na een commando gewijzigde bestanden in
> `supabase/.temp/`, dan is dat onschuldig. Commit ze niet, maar zet ze terug
> met `git checkout -- supabase/.temp`. Koppel je ooit aan productie, kijk dan
> vóór elk commando met `cat supabase/.temp/project-ref` aan welk project je
> hangt.

## 4. Kijken wat er klaarstaat (verandert niets)

```bash
supabase migration list --linked
```

Je krijgt een tabel met drie kolommen: **Local** (in de repository), **Remote**
(al op staging) en de tijd. Een regel met een lege Remote-kolom staat nog
klaar. Voor deze release zijn dat in elk geval:

```
20261003000000  public_api
20261003010000  webhooks
20261003020000  api_rest
20261003030000  api_hardening
20261003040000  approvals_auth_limits
20261003050000  full_api_check
20261003060000  recheck_audit_and_licenses
```

Er kunnen oudere tussen staan als die nooit uitgerold zijn
(`20260926000000_security_hardening` bijvoorbeeld). Dat is goed: ze gaan op
volgorde mee.

Dan de proefrun:

```bash
supabase db push --dry-run --linked
```

Wat je terugkrijgt, en wat je dan doet:

| Melding | Betekenis | Wat je doet |
|---|---|---|
| `Would push these migrations:` met een lijst | Normaal | Door naar stap 5. |
| `Remote database is up to date.` | Er staat niets klaar | Door naar stap 6. |
| `Found local migration files to be inserted before the last migration on remote database.` | Een **oudere** migratie is ooit overgeslagen. De melding noemt welke. | Kijk welk bestand het is. Gebruik dan in stap 5 `--include-all`. |
| `Remote migration versions not found in local migrations directory.` | Op staging staat een versie die deze branch niet kent. Vaak is je checkout gewoon oud. | Eerst `git pull`. Blijft het: zie [Problemen](#problemen-oplossen). |

## 5. De database bijwerken

```bash
supabase db push --linked
```

(of `supabase db push --linked --include-all` als stap 4 dat zei)

Hij toont de lijst nog een keer en vraagt `[Y/n]`: typ `y`. Daarna zie je per
bestand `Applying migration …` en tot slot `Finished supabase db push.`

Elke migratie draait in één transactie. Gaat er één mis, dan is die helemaal
niet toegepast; wat ervóór al gelukt was, blijft staan. Je ziet welk bestand
het was (de laatste `Applying migration …`-regel) en welk statement erin
faalde (`At statement: …`). Stop dan, en stuur de foutmelding door voordat je
verdergaat.

## 6. De edge functions uitrollen

Altijd **na** stap 5: de nieuwe functies rekenen op de nieuwe tabellen.

```bash
supabase functions deploy --project-ref enzghpduqwaojcxgwarr --use-api
```

Dit rolt alle functies uit `supabase/functions/` uit (ruim dertig; een paar
minuten). Per functie neemt hij de instelling uit `supabase/config.toml` mee,
zoals `verify_jwt = false`. Daar hoef je dus niets voor op te geven.

- Gebruik **nooit** `--prune`: dat verwijdert functies die niet in deze branch
  staan.
- Eén functie apart, bijvoorbeeld na een kleine fix:
  `supabase functions deploy api --project-ref enzghpduqwaojcxgwarr --use-api`

## 7. Eenmalig: secrets en de webhookbezorger

Dit hoeft maar één keer per omgeving.

**Snelste weg: het script.** Dat doet alles uit deze stap, zet alleen wat
ontbreekt, overschrijft nooit de encryptiesleutel en laat geen waarde zien.
Het heeft `psql` nodig (macOS: `brew install libpq && brew link --force libpq`)
en draait in bash (op Windows: Git Bash of WSL):

```bash
SUPABASE_PROJECT_ID=enzghpduqwaojcxgwarr SUPABASE_DB_PASSWORD='…' bash scripts/supabase-setup-webhooks.sh
```

Meldt het dat `pg_cron` of `pg_net` ontbreekt: zet die aan onder
**Database → Extensions** en draai het opnieuw. Via GitHub doet het vinkje
*setup_webhooks* hetzelfde (stap 9).

**Met de hand**, als je het liever zelf ziet. Kijk eerst wat er al staat:

```bash
supabase secrets list --project-ref enzghpduqwaojcxgwarr
```

**Moet er staan** (bestond al voor andere functies; ontbreekt er een, dan staat
uitleg in `PUBLIC_API_SETUP.md` §3):
`CALENDAR_TOKEN_ENCRYPTION_KEY` en `APP_PUBLIC_URL` of `GERRIE_ALLOWED_ORIGINS`.

**Nieuw voor webhooks**: `WEBHOOK_SECRET_ENCRYPTION_KEY` en
`WEBHOOK_CRON_SECRET`. Zonder deze twee werkt de API wel, maar kan niemand een
webhook aanmaken.

> **Staat `WEBHOOK_SECRET_ENCRYPTION_KEY` er al? Zet hem dan nooit opnieuw.**
> Een nieuwe sleutel maakt de geheimen van bestaande webhooks onleesbaar.
> `WEBHOOK_CRON_SECRET` mag je wel vervangen (alleen de cron-taak hieronder
> gebruikt hem). Weet je de waarde niet meer, zet dan een nieuwe en plan de
> taak opnieuw in met die waarde.

Staan ze er nog niet: maak ze zo aan, en **bewaar `WEBHOOK_CRON_SECRET` even**
(je hebt hem hieronder nodig):

macOS / Linux:

```bash
WEBHOOK_CRON_SECRET="$(openssl rand -base64 32)"; echo "$WEBHOOK_CRON_SECRET"
supabase secrets set --project-ref enzghpduqwaojcxgwarr \
  WEBHOOK_SECRET_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  WEBHOOK_CRON_SECRET="$WEBHOOK_CRON_SECRET"
```

Windows PowerShell:

```powershell
function New-Secret { $b = New-Object byte[] 32; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); [Convert]::ToBase64String($b) }
$cron = New-Secret; $cron
supabase secrets set --project-ref enzghpduqwaojcxgwarr "WEBHOOK_SECRET_ENCRYPTION_KEY=$(New-Secret)" "WEBHOOK_CRON_SECRET=$cron"
```

Secrets gelden meteen, zonder nieuwe deploy. Zet **niet** `WEBHOOK_DNS_OVERRIDES`
(dat is alleen voor lokaal testen).

**De bezorger inplannen** (pg_cron). Open de SQL-editor
(https://supabase.com/dashboard/project/enzghpduqwaojcxgwarr/sql/new). Kijk eerst
wat er al loopt:

```sql
select jobname, schedule, active from cron.job order by jobname;
```

Staat `webhooks-dispatch` er nog niet, plak dit erin en vervang
`<WEBHOOK_CRON_SECRET>` door de waarde van hierboven. Opnieuw draaien kan
geen kwaad: een taak met dezelfde naam wordt bijgewerkt.

```sql
select cron.schedule(
  'webhooks-dispatch',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://enzghpduqwaojcxgwarr.functions.supabase.co/webhooks?cron=dispatch',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<WEBHOOK_CRON_SECRET>'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 90000
  );
  $$
);
```

Geeft dat `schema "cron" does not exist` of `schema "net" does not exist`, zet
dan eerst onder **Database → Extensions** `pg_cron` en `pg_net` aan en probeer
het opnieuw.

De dagelijkse opruimtaak `resofly-api-purge` plant de migratie `20261003040000`
zelf in, als pg_cron aan stond toen hij draaide. Staat hij niet in het lijstje
van hierboven, plan hem dan zo in:

```sql
select cron.schedule('resofly-api-purge', '17 3 * * *',
  'select public.api_purge_expired(); select public.webhook_purge_expired();');
```

**Klantmeldingen over tickets** (sinds 2026-10-04). Het script plant ook de
taak `portal-notify-drain` in en zet daarvoor `PORTAL_NOTIFY_CRON_SECRET`, zodra
de migratie `20261004000000` op de database staat. Met de hand gaat het precies
zoals de webhookbezorger hierboven; de stappen staan in
`KLANTPORTAAL_MELDINGEN_SETUP.md`.

## 8. Controleren dat alles werkt

De workflow doet na elke deploy zelf een rooktest (`scripts/supabase-smoke-test.sh`):
antwoordt de API, weigert hij zonder sleutel, en draait de bezorger met het
secret uit zijn cron-taak. Vanaf de laptop kan dat ook:
`SUPABASE_PROJECT_ID=enzghpduqwaojcxgwarr SUPABASE_DB_PASSWORD='…' bash scripts/supabase-smoke-test.sh`.
Daarna de controles hieronder, die een mens moet doen.

Op Windows: gebruik `curl.exe` in plaats van `curl`.

```bash
# De migraties: geen lege Remote-kolom meer
supabase migration list --linked

# De API leeft (200, met een beschrijving)
curl -s https://enzghpduqwaojcxgwarr.supabase.co/functions/v1/api/v1

# Zonder sleutel: 401 met uitleg
curl -si https://enzghpduqwaojcxgwarr.supabase.co/functions/v1/api/v1/me
```

Dan in de app (https://staging.resofly.com), als owner of admin:

1. **Instellingen → API & webhooks**: maak een sleutel *alleen lezen* aan en
   kopieer hem (`rsfapi.…`). Dan:
   ```bash
   curl -s https://enzghpduqwaojcxgwarr.supabase.co/functions/v1/api/v1/me -H "Authorization: Bearer rsfapi.…"
   curl -s -X POST https://enzghpduqwaojcxgwarr.supabase.co/functions/v1/api/v1/actions/team.license_usage -H "Authorization: Bearer rsfapi.…" -H "Content-Type: application/json" -d "{}"
   ```
   De eerste geeft je organisatie en sleutel terug. De tweede geeft het
   seat-overzicht (die gaf vóór deze release altijd een fout).
2. **Webhook**: maak een webhook aan naar een eigen adres van
   https://webhook.site, met de gebeurtenis *Nieuwe klant* (`client.created`)
   aangevinkt, en klik op **Testen**. Je hoort een 2xx terug te zien. Maak
   daarna een klant aan: binnen een minuut moet die ook op webhook.site
   staan. Dat laatste bewijst dat de bezorger (de cron-taak) loopt.
3. **Gerrie**: laat Gerrie iets klaarzetten en keur het goed in de
   wachtrij. Dat moet gewoon lukken.
4. **Agenda via een link**: voeg in de agenda een agenda via een link toe,
   bijvoorbeeld de Nederlandse feestdagen:
   `https://calendar.google.com/calendar/ical/nl.dutch%23holiday%40group.v.calendar.google.com/public/basic.ics`.
   De feestdagen horen te verschijnen. Dit ophalen gaat in deze release over
   een nieuwe, vastgepinde verbinding. Lukt het niet, kijk dan in de logs
   (hieronder) van `calendar-integrations` en stuur de melding door.
5. **Logs**: Dashboard → **Edge Functions** → een functie → **Logs**. Na het
   klikken hierboven horen `api`, `api-admin`, `webhooks`, `gerrie-agent` en
   `calendar-integrations` geen rode regels te tonen.

## 9. Daarna: voortaan automatisch via GitHub

Eén secret, en elke push naar `staging` doet stap 5 en 6 vanzelf:

1. https://github.com/dexpresso-ai/resofly/settings/secrets/actions
2. Tabblad **Secrets**, **New repository secret**.
3. Naam `SUPABASE_DB_PASSWORD`, waarde het databasewachtwoord van staging.

Niet onder *Environments* en niet op het tabblad *Variables*: daar ziet de
workflow hem niet. Daarna: **Actions → Deploy Supabase (staging) → Run
workflow** (branch `staging`). Bij handmatig starten zijn er twee vinkjes:

| Vinkje | Wanneer |
|---|---|
| *setup_webhooks* | De eerste keer: doet stap 7 met `scripts/supabase-setup-webhooks.sh`. Daarna mag hij aan blijven; hij zet alleen wat ontbreekt. |
| *include_all* | Alleen als de vorige run stopte op `Found local migration files to be inserted before the last migration…` (zie stap 4). |

Bij een gewone push naar `staging` doet de workflow stap 5 en 6, zonder de
vinkjes.

## Productie (later)

Precies dezelfde stappen, met de ref van het productieproject in plaats van
`enzghpduqwaojcxgwarr`. Koppel daarvoor expliciet
(`supabase link --project-ref <productie-ref>`), en koppel daarna terug naar
staging. Doe productie pas als staging met stap 8 helemaal groen is.

## Problemen oplossen

| Je ziet | Oorzaak | Oplossing |
|---|---|---|
| `Access token not provided` / `Unauthorized` | Niet ingelogd | `supabase login` |
| `password authentication failed` / `failed SASL auth` | Verkeerd databasewachtwoord | Opnieuw intypen, of resetten (stap 1) en `supabase link …` opnieuw |
| Time-out of `network is unreachable` bij verbinden | Oude CLI (verbindt via IPv6), of een netwerk dat poort 5432/6543 blokkeert | CLI bijwerken (stap 2); ander netwerk of hotspot proberen |
| `Found local migration files to be inserted before the last migration on remote database` | Een oudere migratie is overgeslagen | `supabase db push --linked --include-all` (bekijk eerst welk bestand) |
| `Remote migration versions not found in local migrations directory` | Staging kent een versie die jouw checkout niet heeft | Eerst `git pull` op `staging`. Blijft het: kijk wat die versie is (vraag het na). Alleen als zeker is dat hij nergens meer bij hoort: `supabase migration repair --status reverted <versie> --linked`. Dat haalt alleen de regel uit de historie en draait niets terug. |
| `Skipping migration README.md...` | Er staat een README tussen de migraties | Onschuldig |
| Een migratie faalt halverwege | Die ene migratie is teruggedraaid; de rest staat | Niet opnieuw proberen; foutmelding doorsturen |
| `Docker is not running` bij `functions deploy` | `--use-api` vergeten | Het commando uit stap 6 precies zo gebruiken |
| Een functie geeft `BOOT_ERROR` of 500 | Bijvoorbeeld een ontbrekend secret | Logs van die functie (stap 8.5); `supabase secrets list` |
| Webhook-test: "Deze omgeving kan geen vaste verbinding opzetten" | De Edge-runtime staat de vaste verbinding niet toe | Melding doorsturen (dit is in de runtime van Supabase nog niet eerder gedraaid) |
| Gewijzigde bestanden in `supabase/.temp/` | De CLI houdt daar zijn stand bij | `git checkout -- supabase/.temp` |

## Wat er in deze release op staging komt

- **Database:** de zeven migraties uit stap 4: API-sleutels, webhooks, vaste
  adressen, de veiligheidsrondes, het auditlog per module en de
  licentietelling. Alle zeven zijn veilig om te herhalen.
- **Functies:** onder andere `api`, `api-admin`, `webhooks`, `mcp`,
  `gerrie-agent`, `calendar-integrations`, `invoice-workflow` en `mail`. Stap 6
  rolt ze allemaal uit.
- **Secrets:** `WEBHOOK_SECRET_ENCRYPTION_KEY` en `WEBHOOK_CRON_SECRET` (stap 7), en
  sinds 2026-10-04 `PORTAL_NOTIFY_CRON_SECRET` voor de klantmeldingen.
- **Cron:** `webhooks-dispatch` en `portal-notify-drain` (stap 7), en
  `resofly-api-purge` (via de migratie, als pg_cron aan staat).
- **Cloudflare:** de app bouwt vanzelf. Aan de workers (`cloudflare-worker/`,
  `workers/`) is in deze release niets veranderd.

Achtergrond per onderdeel: `PUBLIC_API_SETUP.md` (API en webhooks) en
`CHANGELOG_OPENBARE_API_2026-10-03.md` (wat er per ronde veranderde).
