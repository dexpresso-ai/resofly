# Openbare API — andere software koppelen aan ResoFly

Met de openbare API koppelt een klant andere software aan zijn werkruimte: een
webshop die klanten aanmaakt, een urenapp die uren boekt, zijn boekhouding, of
een koppelplatform als **Zapier**, **Make** of **n8n**. Gewone HTTP en JSON,
met een API-sleutel die een owner of admin aanmaakt onder **Instellingen → API &
webhooks**.

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

## 1. Database

```bash
supabase db push
```

Dat draait `20261003000000_public_api.sql` (veilig om te herhalen):

| Onderdeel | Wat |
|---|---|
| `api_keys` | De sleutels zoals het scherm ze toont. RLS: owners/admins lezen en trekken in. |
| `api_key_secrets` | Selector + gesalte hash. Geen policies: alleen de API-functie komt erbij. |
| `ai_action_audit.api_key_id` | Een voorstel of uitvoering van een sleutel, herleidbaar tot die sleutel. |
| `api_request_log` | Elke aanroep, 30 dagen. RLS: owners/admins lezen. |
| `api_idempotency_keys` | Maakt herhaalde verzoeken veilig, 24 uur. |
| `api_consume_rate_limit()` | De aanroeplimiet, in één statement met een rijvergrendeling. |
| Triggers | Alleen hernoemen/intrekken vanuit de app; intrekken is definitief en annuleert openstaande voorstellen; aanmaken/hernoemen/intrekken komt in `audit_logs`. |

Op **staging** gebeurt dit vanzelf: de workflow *Deploy Supabase (staging)*
draait `supabase db push` en `supabase functions deploy` bij elke push naar
`staging`.

## 2. Functies uitrollen

```bash
supabase functions deploy api --no-verify-jwt
supabase functions deploy api-admin --no-verify-jwt
```

`--no-verify-jwt` staat met de reden in `supabase/config.toml`: `api` wordt
aangeroepen door software zonder Supabase-sessie en authenticeert zelf met de
API-sleutel; `api-admin` controleert zelf de ingelogde gebruiker, de
organisatie, de rol (owner/admin) en de origin.

Beide functies lopen bij elke pull request mee in `deno check` (job
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

## 4. Controleren dat het staat

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

## 5. Een eigen domein ervoor (optioneel)

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
