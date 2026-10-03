# Openbare API — andere software koppelen aan ResoFly

Met de openbare API koppelt een klant andere software aan zijn werkruimte: een
webshop die klanten aanmaakt, een urenapp die uren boekt, zijn boekhouding, of
een koppelplatform als **Zapier**, **Make** of **n8n**. Gewone HTTP en JSON,
met een API-sleutel die een owner of admin aanmaakt onder **Instellingen → API &
webhooks**.

Andersom kan ResoFly zelf een seintje geven: met **webhooks** stuurt ResoFly een
ondertekend bericht naar een adres van de klant zodra er iets gebeurt — een
factuur betaald, een nieuwe klant, een ticket van het portaal.

Voor ontwikkelaars die ertegen bouwen staat de handleiding in
[`docs/API.md`](docs/API.md). Dit document gaat over uitrollen en beheren.

## Wat het is

|  | AI-koppeling (MCP) | Openbare API |
|---|---|---|
| Voor | De eigen AI van een teamlid | Andere software |
| Aanmelden | OAuth, een mens klikt op Connect | API-sleutel, aangemaakt door owner/admin |
| Namens | Het teamlid dat koppelde | Het teamlid dat de sleutel aanmaakte |
| Lezen | Ja | Ja |
| Wijzigen | Klaarzetten; rechtstreeks als de eigenaar dat aanzet | Klaarzetten; rechtstreeks als de sleutel dat mag |
| Wat hij kan | Registry + Gerrie's kerntools | Precies hetzelfde |

**Er is geen tweede weg naar de gegevens bijgekomen.** De API draait dezelfde
handelingen uit `supabase/functions/_shared/actions/` als Gerrie en de MCP,
langs dezelfde `read()`, `plan()`, `runGerrieTool` en `buildProposal`, met
dezelfde org-scoping. Een handeling die erbij komt, staat bij de volgende uitrol
vanzelf in de API — én in het OpenAPI-document, dat uit de registry wordt
gegenereerd.

### Wat een sleutel mag

Bij het aanmaken kiest de owner/admin één van vier treden:

| Toegang | Scope | Wat er gebeurt bij "zet die factuur op betaald" |
|---|---|---|
| Alleen lezen | `read` | Geweigerd (403 `insufficient_scope`). |
| Lezen en klaarzetten | `+ propose` | Een kaart in de goedkeurwachtrij (202). Er gebeurt pas iets als een mens klikt. |
| Lezen en rechtstreeks uitvoeren | `+ execute` | Het gebeurt meteen (200) — als ResoFly het op de server kan en het niet onomkeerbaar is. Anders alsnog klaargezet, met de reden erbij. |
| Alles rechtstreeks uitvoeren | `+ execute_high` | Ook post naar klanten, boekingen, aangiftes en publieke links gaan er rechtstreeks door. |

Daarnaast kan de sleutel **modules dichter zetten** dan de maker zelf heeft
(een webshop hoeft niet in de boekhouding), en een **vervaldatum** krijgen.

Na het aanmaken ligt dat vast. Vanuit de app kan een sleutel alleen nog
hernoemd en ingetrokken worden; de database dwingt dat af
(`api_keys_guard_client_update`). Wie meer wil, maakt een nieuwe sleutel en
trekt de oude in — een sleutel die al in een webshop staat, hoort niet ineens
meer te kunnen omdat iemand een knop omzet.

### Namens wie

Een sleutel werkt namens het teamlid dat hem aanmaakte, met de rol en de
modulerechten die dat teamlid **nu** heeft — vers uit `organization_members`
bij elke aanroep. Wordt de maker viewer, dan kan de sleutel alleen nog lezen;
is hij geen actief lid meer, dan werkt de sleutel niet meer (401). Een sleutel
kan nooit ruimer zijn dan zijn maker: de modulebeperking van de sleutel kan
alleen afknijpen.

Een sleutel is wel van de **organisatie**: owners en admins zien alle sleutels
en kunnen elke sleutel intrekken, ook die van een collega die uit dienst ging.

### Webhooks

Een eindpunt is een https-adres plus een lijst gebeurtenissen (`invoice.paid`,
`client.*`, of `*` voor alles; de catalogus staat in
`supabase/functions/_shared/webhooks.ts`). Er zijn twee soorten:

| | Aangemaakt in de app | Aangemaakt via de API (`POST /v1/webhooks`) |
|---|---|---|
| Door | Owner/admin, Instellingen → API & webhooks | Een koppeling met een API-sleutel (Zapier, Make, n8n) |
| Hoort bij | De organisatie | Die sleutel — verdwijnt als de sleutel wordt ingetrokken |
| Krijgt | Alle gebeurtenissen waarop hij is ingeschreven | Alleen uit modules die de sleutel **nu** mag lezen |

Hoe het loopt: een trigger op elf kerntabellen legt elke wijziging vast als
gebeurtenis — alleen als er in die organisatie een actief eindpunt is dat hem
wil horen, dus een organisatie zonder webhooks merkt er niets van. De functie
`webhooks` (elke minuut via pg_cron) ondertekent en verstuurt ze. Lukt het niet,
dan opnieuw na 1 min, 5 min, 30 min, 2 uur, 6 uur, 12 uur, 24 uur en 24 uur —
negen pogingen, bijna drie dagen. Een eindpunt dat een hele dag lang bij elk
bericht faalt, of `410 Gone` antwoordt, zet zichzelf uit, met de reden erbij.

## 1. Database

```bash
supabase db push
```

Dat draait `20261003000000_public_api.sql`, `20261003010000_webhooks.sql` en
`20261003020000_api_rest.sql` (alle drie veilig om te herhalen). De eerste:

| Onderdeel | Wat |
|---|---|
| `api_keys` | De sleutels zoals het scherm ze toont. RLS: owners/admins lezen en trekken in. |
| `api_key_secrets` | Selector + gesalte hash. Geen policies: alleen de API-functie komt erbij. |
| `ai_action_audit.api_key_id` | Een voorstel of uitvoering van een sleutel, herleidbaar tot die sleutel. |
| `api_request_log` | Elke aanroep, 30 dagen. RLS: owners/admins lezen. |
| `api_idempotency_keys` | Maakt herhaalde verzoeken veilig, 24 uur. |
| `api_consume_rate_limit()` | De aanroeplimiet, in één statement met een rijvergrendeling. |
| Triggers | Alleen hernoemen/intrekken vanuit de app; intrekken is definitief en annuleert openstaande voorstellen; aanmaken/hernoemen/intrekken komt in `audit_logs`. |

De tweede, voor webhooks:

| Onderdeel | Wat |
|---|---|
| `webhook_endpoints` | De eindpunten. RLS: owners/admins lezen, zetten aan/uit, wijzigen de omschrijving en verwijderen. Adres en gebeurtenissen wijzigen gaat via `api-admin` (daar wordt het adres gekeurd). |
| `webhook_endpoint_secrets` | Het ondertekengeheim, versleuteld (AES-GCM). Geen policies. |
| `webhook_events` | Wat er gebeurde, zonder geheimen (alles wat op token, hash, secret, password of pin lijkt valt eruit). 30 dagen. |
| `webhook_deliveries` | Per eindpunt een bezorging: status, pogingen, het antwoord van het eindpunt. |
| `webhook_capture()` | De trigger (`zz_webhook_capture`) op klanten, contactpersonen, projecten, taken, tickets, ticketnotities, uren, offertes, facturen, contracten en afspraken. Een fout hierin blokkeert het opslaan nooit. |
| `claim_webhook_deliveries()`, `finish_webhook_delivery()` | Claimen (`for update skip locked`, hooguit 4 tegelijk per eindpunt) en afronden. Alleen voor de service role. |
| Triggers | Eindpunten in `audit_logs`; een sleutel intrekken verwijdert de eindpunten van die sleutel. |

De derde, voor de vaste adressen (`/v1/clients`, `/v1/tasks`, …):

| Onderdeel | Wat |
|---|---|
| `api_rest_write()` | Aanmaken en wijzigen via een vast adres. Alleen voor de service role. Wisselt binnen de transactie naar het teamlid achter de sleutel (rol `authenticated`, diens id in de claims) en schrijft dan — met de RLS, triggers en het auditlog van de app. Weigert kolommen die de app zelf beheert. |

Op **staging** gebeurt dit vanzelf: de workflow *Deploy Supabase (staging)*
draait `supabase db push` en `supabase functions deploy` bij elke push naar
`staging`.

## 2. Functies uitrollen

```bash
supabase functions deploy api --no-verify-jwt
supabase functions deploy api-admin --no-verify-jwt
supabase functions deploy webhooks --no-verify-jwt
```

`--no-verify-jwt` staat met de reden in `supabase/config.toml`: `api` wordt
aangeroepen door software zonder Supabase-sessie en authenticeert zelf met de
API-sleutel; `api-admin` controleert zelf de ingelogde gebruiker, de
organisatie, de rol (owner/admin) en de origin; `webhooks` wordt aangeroepen
door pg_cron en doet niets zonder het cron-secret.

Alle drie lopen bij elke pull request mee in `deno check` (job
*edge-functions* in `frontend-checks.yml`).

## 3. Instellingen (Edge Function secrets)

Niets is verplicht. De API leunt op wat er al staat:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — standaard aanwezig.
- `CALENDAR_TOKEN_ENCRYPTION_KEY` — de registry laadt de agenda-handelingen, en
  die lezen dit bij het opstarten. Staat er al voor de agenda en de MCP.
- `APP_PUBLIC_URL` of `GERRIE_ALLOWED_ORIGINS` — de origins waarvandaan
  `api-admin` aangeroepen mag worden. Staan er al voor de andere app-functies.

Optioneel:

| Secret | Waarvoor | Standaard |
|---|---|---|
| `API_PUBLIC_URL` | Het adres achter een eigen domein (zie hieronder). Komt in het OpenAPI-document en in `Location`-headers. | `<SUPABASE_URL>/functions/v1/api` |
| `API_DOCS_URL` | Link naar de handleiding in het OpenAPI-document. | — |
| `API_RATE_LIMIT_PER_MINUTE` | Aanroepen per minuut per sleutel (10–6000). | `300` |
| `API_ADMIN_ALLOWED_ORIGINS` | Extra origins voor `api-admin`, kommagescheiden. | — |

Voor **webhooks** zijn twee secrets nodig. Zonder deze twee werkt de API
gewoon, maar kan niemand een webhook aanmaken (het scherm zegt dat ook):

| Secret | Waarvoor |
|---|---|
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | Versleutelt de ondertekengeheimen van de eindpunten. Nodig in `api`, `api-admin` en `webhooks`. Lang en willekeurig: `openssl rand -base64 32`. |
| `WEBHOOK_CRON_SECRET` | De deur van de bezorger (header `x-cron-secret`). Zelfde soort waarde. |

```bash
supabase secrets set WEBHOOK_SECRET_ENCRYPTION_KEY="$(openssl rand -base64 32)"
supabase secrets set WEBHOOK_CRON_SECRET="$(openssl rand -base64 32)"
```

**Bewaar `WEBHOOK_SECRET_ENCRYPTION_KEY` goed en verander hem niet zomaar.**
Raakt hij kwijt of verandert hij, dan zijn de bestaande geheimen niet meer te
ontsleutelen: elke bezorging mislukt dan, tot er per eindpunt een nieuw geheim is
aangemaakt (knop *Nieuw geheim*) en de ontvanger dat heeft overgenomen.

## 4. De bezorger inplannen (pg_cron)

Eenmalig in de SQL-editor, met `pg_cron` en `pg_net` aan
(`create extension if not exists pg_cron; create extension if not exists pg_net;`).
Vervang `<REF>` en `<WEBHOOK_CRON_SECRET>`:

```sql
select cron.schedule(
  'webhooks-dispatch',
  '* * * * *',                       -- elke minuut
  $$
  select net.http_post(
    url     := 'https://<REF>.functions.supabase.co/webhooks?cron=dispatch',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<WEBHOOK_CRON_SECRET>'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 90000    -- een ronde mag tot een minuut duren
  );
  $$
);
```

Een ronde bezorgt tot er niets meer klaarstaat of 40 seconden voorbij zijn, met
8 bezorgingen tegelijk en hooguit 4 per eindpunt — zodat één eindpunt dat niet
antwoordt, de webhooks van andere organisaties niet ophoudt. Twee rondes die
elkaar overlappen, pakken nooit dezelfde bezorging.

Controleren / verwijderen:

```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'webhooks-dispatch';
select status, return_message, start_time from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'webhooks-dispatch')
 order by start_time desc limit 10;
-- verwijderen: select cron.unschedule('webhooks-dispatch');
```

## 5. Controleren dat het staat

```bash
# Open: wat de API is (200)
curl -s https://<PROJECT>.supabase.co/functions/v1/api/v1 | jq

# Zonder sleutel: 401 met een uitleg
curl -si https://<PROJECT>.supabase.co/functions/v1/api/v1/me

# Het OpenAPI-document (groot: elke handeling is een eigen pad)
curl -s https://<PROJECT>.supabase.co/functions/v1/api/v1/openapi.json | jq '.paths | length'
```

Maak daarna in de app onder **Instellingen → API & webhooks** een sleutel aan
(alleen lezen is genoeg) en:

```bash
curl -s https://<PROJECT>.supabase.co/functions/v1/api/v1/me \
  -H "Authorization: Bearer rsfapi.…" | jq
```

Je hoort de organisatie, de sleutel, het teamlid en het raster met modules
terug te krijgen.

De bezorger:

```bash
# Zonder of met een verkeerd secret: 401
curl -si -X POST "https://<REF>.functions.supabase.co/webhooks?cron=dispatch" -H "x-cron-secret: fout"

# Met het goede secret: een telling van deze ronde
curl -s -X POST "https://<REF>.functions.supabase.co/webhooks?cron=dispatch" \
  -H "x-cron-secret: <WEBHOOK_CRON_SECRET>"
# {"ok":true,"delivered":0,"retrying":0,"failed":0,"skipped":0,"ms":41}
```

En in de app: maak onder **Instellingen → API & webhooks** een webhook aan naar
een testadres (bijvoorbeeld een eigen
[webhook.site](https://webhook.site)-adres) en klik op **Testen**. Je ziet
meteen wat het eindpunt antwoordde; onder **Bezorgingen** staat elke poging.

## 6. Een eigen domein ervoor (optioneel)

De Supabase-URL werkt, maar `https://api.jouwdomein.nl` leest prettiger. Zet er
een Cloudflare Worker of route voor die alles doorstuurt naar
`https://<PROJECT>.supabase.co/functions/v1/api`, en zet:

```bash
supabase secrets set API_PUBLIC_URL="https://api.jouwdomein.nl"
```

En in de frontend (Vite) dezelfde waarde, zodat het instellingenscherm het
goede adres toont:

```
VITE_API_PUBLIC_URL=https://api.jouwdomein.nl
```

De functie vergelijkt op de staart van het pad (`/v1/...`), dus hij werkt in
beide opstellingen zonder codewijziging.

## De grenzen, en wat ze bewaakt

**De organisatie komt uit de sleutel, nooit uit het verzoek.** Er bestaat geen
invoerveld voor. Elke query in de registry filtert erop (`actionTenancy.test.ts`
bewaakt dat); een id van een andere organisatie geeft *"niet gevonden in deze
organisatie"* en geen rij.

**Rechtstreeks uitvoeren alleen met een server-uitvoerder.** Precies dezelfde
lijst als bij de MCP (`_shared/actions/apply.ts`): enkelvoudige org-scoped
inserts en updates, zonder mail, PDF of bestandsopslag. Al het andere wordt een
voorstel — ook met de ruimste sleutel. Gerrie's kerntools (een factuur
opstellen, een mail aan een klant, een nieuwe klant) hebben geen uitvoerder op
de server en worden dus altijd klaargezet.

**Het voorstel schrijven wij.** Wat er op de goedkeurkaart staat, komt uit
`plan()` of `buildProposal`: echte rijen uit de eigen administratie. De
aanroeper levert invoer, niet de payload.

**Sleutels staan niet leesbaar in de database.** `rsfapi.<selector>.<verifier>`:
de selector plat, van de verifier alleen een gesalte SHA-256, in een tabel
zonder policies. De platte sleutel ziet de owner/admin één keer, bij het
aanmaken.

**Alles staat in een log.** Elke aanroep met een geldige sleutel in
`api_request_log` (wanneer, welk pad, welke handeling, welke uitkomst — niet de
invoer); elke uitvoering en elk voorstel in `ai_action_audit`, met
`api_key_id`. Owners en admins zien de laatste aanroepen onder Instellingen →
API & webhooks.

**Een aanroeplimiet en een plafond op de wachtrij.** 300 aanroepen per minuut
per sleutel (instelbaar), afgeboekt in de database zodat parallelle verzoeken
niet allemaal dezelfde lege teller lezen. En hooguit 50 openstaande voorstellen
per sleutel: een wachtrij waar niemand meer doorheen komt, is een wachtrij
waarin iemand op Uitvoeren klikt zonder te lezen.

**Vaste adressen schrijven als het teamlid, niet als de server.** Lezen gaat
met de service-role en het org-filter (wat RLS voor deze tabellen ook vraagt).
Aanmaken en wijzigen loopt via `api_rest_write`, dat in de database wisselt naar
het teamlid achter de sleutel. Daardoor gelden de regels van de app zelf en niet
een nagebouwde versie: de module-poort (`enforce_module_write_access`, die bij de
service-role niets doet), de controle op dubbele klanten en contactpersonen, de
verwijzingscontroles, en `audit_logs` op naam van het teamlid. Klantnummers komen
uit `create_client_with_next_code`, precies als bij aanmaken in het scherm.
Daarbovenop vraagt de functie `api` toegangsniveau `execute` en schrijfrecht in
de module, voor de sleutel én voor het teamlid.

**Webhooks gaan alleen naar buiten.** Alleen `https`, geen gebruikersnaam of
wachtwoord in het adres, en niets in een intern netwerk: geen `localhost` of
namen op `.local`, `.internal`, `.lan` en dergelijke, en geen privé- of
gereserveerde IP-adressen (10.x, 192.168.x, 169.254.x, fc00::/7 en verwanten —
ook verpakt in IPv6). Bij elke bezorging opnieuw gekeurd, inclusief waar de naam
op dat moment naartoe wijst; een doorverwijzing wordt niet gevolgd, en na 10
seconden zonder antwoord geven we op.

**Ondertekend, met de tijd erin.** Elk bericht draagt
`ResoFly-Signature: t=<unix-tijd>,v1=<HMAC-SHA256>` over `<t>.<body>`, met het
geheim van het eindpunt. Dat geheim ziet de owner/admin (of de koppeling) één
keer, bij het aanmaken of vernieuwen; in de database staat het versleuteld,
in een tabel zonder policies.

**Een eindpunt van een sleutel krijgt niet meer dan die sleutel.** Bij elke
bezorging opnieuw gewogen: is de sleutel niet ingetrokken of verlopen, is de
maker nog actief lid, en mag die combinatie de module van de gebeurtenis lezen?
Zo niet, dan wordt de bezorging overgeslagen, met de reden erbij.

**Geen geheimen in een bericht.** Kolommen die op token, hash, secret, password
of pin lijken, opslagsleutels en base64-bestanden gaan nooit mee — een patroon,
geen lijst, zodat een nieuwe kolom `share_token` er vanzelf buiten blijft.
Velden boven de 32 kB vallen eruit en staan in `_omitted`.

## Als het niet werkt

**401 "Deze API-sleutel is niet bekend"** — de sleutel is verkeerd gekopieerd
(hij begint met `rsfapi.` en bevat precies twee punten), of hij is van een
andere omgeving (staging versus productie).

**401 "Het teamlid namens wie deze sleutel werkt, is geen actief lid meer"** —
de maker is uit de organisatie gezet of uitgeschakeld. Laat een owner of admin
een nieuwe sleutel aanmaken.

**403 `insufficient_scope`** — de sleutel mag alleen lezen. Maak een sleutel aan
die mag klaarzetten of uitvoeren.

**403 `forbidden`** — de module staat dicht voor deze sleutel of voor zijn
maker, of het is een handeling voor owners/admins.

**202 terwijl je 200 verwachtte** — de sleutel mag uitvoeren, maar deze
handeling niet rechtstreeks: geen server-uitvoerder, of onomkeerbaar zonder
`execute_high`. Het veld `reason` zegt welke van de twee. Vooraf te zien in
`GET /v1/actions`: `"execution": "direct"` of `"approval"`.

**429 `queue_full`** — er staan 50 voorstellen van deze sleutel open. Handel de
wachtrij in ResoFly af.

**"Nog niet beschikbaar in deze omgeving" op het instellingenscherm** — de
frontend staat er al, de migratie nog niet. Draai `supabase db push`.

**403 op een vast adres terwijl de sleutel `execute` heeft** — het teamlid
achter de sleutel mag niet schrijven in die module (rol of modulerechten in
ResoFly), of de sleutel zelf zet de module op alleen lezen. De melding zegt
welke van de twee.

**"Webhooks staan in deze omgeving nog niet aan"** — `WEBHOOK_SECRET_ENCRYPTION_KEY`
ontbreekt in de Edge Function secrets (zie stap 3).

**Er komt niets aan, en Bezorgingen blijft op "staat klaar"** — de bezorger draait
niet. Kijk in `cron.job_run_details` (stap 4) en roep hem met de hand aan (stap
5). Een 401 daar: het secret in de cron-job en `WEBHOOK_CRON_SECRET` verschillen.

**Elke bezorging mislukt met "Bezorgen mislukte aan onze kant"** — vaak een
`WEBHOOK_SECRET_ENCRYPTION_KEY` die veranderd is sinds het geheim werd gemaakt.
Maak per eindpunt een nieuw geheim aan en geef het aan de ontvanger.

**"Automatisch uitgezet"** — het eindpunt faalde een dag lang bij elk bericht,
of antwoordde `410 Gone`. De reden staat bij het eindpunt. Herstel het eindpunt
en zet het weer aan; de foutteller begint dan opnieuw. Wat er klaarstond terwijl
het uit stond, is overgeslagen — haal dat zo nodig op via de API.

**"Overgeslagen: de API-sleutel van dit eindpunt mag de module … niet lezen"** —
de sleutel achter dit eindpunt (of zijn maker) mag die module niet (meer) zien.
Dat is de grens die het hoort te zijn.
