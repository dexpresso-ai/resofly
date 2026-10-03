# ResoFly API — handleiding voor ontwikkelaars

Met de ResoFly API koppel je andere software aan een ResoFly-werkruimte:
gegevens ophalen, en wijzigingen klaarzetten of rechtstreeks uitvoeren. Alles
wat de app kan, kan via de API — van een klant opzoeken tot een factuur op
betaald zetten. En met [webhooks](#webhooks--resofly-geeft-een-seintje) hoor je
het zelf zodra er iets gebeurt, zonder steeds te hoeven vragen.

- **Adres:** `https://<project>.supabase.co/functions/v1/api` (of het eigen
  domein dat je beheerder instelde; zie Instellingen → API & webhooks).
- **Formaat:** JSON, UTF-8.
- **Aanmelden:** een API-sleutel `rsfapi.…`, aangemaakt door een owner of
  admin onder **Instellingen → API & webhooks**.
- **Beschrijving:** `GET /v1/openapi.json` — OpenAPI 3.1, gegenereerd uit
  wat de API werkelijk kan. Rechtstreeks in te lezen in Postman, Insomnia,
  Make, n8n of een codegenerator.

## Snel beginnen

```bash
export RESOFLY_API="https://<project>.supabase.co/functions/v1/api"
export RESOFLY_KEY="rsfapi.…"

# Wie ben ik, en wat mag deze sleutel?
curl -s "$RESOFLY_API/v1/me" -H "Authorization: Bearer $RESOFLY_KEY"

# Wat kan ik aanroepen? (zoeken in gewone woorden)
curl -s "$RESOFLY_API/v1/actions?q=openstaande%20facturen" -H "Authorization: Bearer $RESOFLY_KEY"

# Een handeling uitvoeren
curl -s -X POST "$RESOFLY_API/v1/actions/search_clients" \
  -H "Authorization: Bearer $RESOFLY_KEY" -H "Content-Type: application/json" \
  -d '{"query": "jansen"}'
```

## Aanmelden

Stuur de sleutel mee in elke aanroep:

```
Authorization: Bearer rsfapi.<selector>.<verifier>
```

Kan je platform de `Authorization`-header niet zelf vullen, gebruik dan
`X-Api-Key: rsfapi.…`.

Een sleutel werkt **namens het teamlid dat hem aanmaakte**, met diens rechten
van dat moment. Wordt dat teamlid viewer, dan kan de sleutel alleen nog lezen;
is hij geen lid meer, dan geeft elke aanroep 401. Bewaar een sleutel als een
wachtwoord: aan de serverkant, nooit in een website of app die anderen kunnen
inzien. Gebruik per koppeling een eigen sleutel, zodat je er één kunt intrekken
zonder de rest stil te leggen.

### Wat een sleutel mag

Bij het aanmaken kiest de beheerder een toegangsniveau. Het staat in
`GET /v1/me` onder `key.access`:

| `access` | Lezen | Wijzigen |
|---|---|---|
| `read` | ja | nee — 403 `insufficient_scope` |
| `propose` | ja | wordt **klaargezet** in de goedkeurwachtrij van ResoFly (202) |
| `execute` | ja | wordt **rechtstreeks uitgevoerd** (200) als dat kan; anders klaargezet |
| `execute_high` | ja | ook onomkeerbare handelingen (post naar klanten, boekingen) rechtstreeks |

Daarnaast kan een sleutel per module beperkt zijn (bijvoorbeeld Financiën
"alleen lezen"). `GET /v1/me` geeft onder `modules` het raster dat voor deze
sleutel écht geldt: `none`, `read` of `write` per module.

## Handelingen

De API is opgebouwd uit **handelingen**: elk met een vast id (zoals
`invoice.set_status` of `search_clients`), een omschrijving, een soort (`read`
of `write`) en een JSON-schema voor de invoer. Er zijn er een paar honderd;
welke deze sleutel mag gebruiken, vraag je op.

### Opzoeken — `GET /v1/actions`

| Parameter | |
|---|---|
| `q` | Zoeken in gewone woorden: `openstaande facturen`, `uren van vorige maand`. |
| `module` | `clients`, `projects`, `time`, `calendar`, `tickets`, `content`, `stats`, `marketing`, `finance`, `chat`, `gerrie` |
| `kind` | `read` of `write` |
| `limit`, `offset` | Pagineren (standaard 100, max 500). |

```json
{
  "data": [
    {
      "id": "invoice.set_status",
      "label": "Factuurstatus wijzigen",
      "module": "finance",
      "kind": "write",
      "risk": "normal",
      "description": "…",
      "input_schema": { "type": "object", "properties": { "invoice_id": { "type": "string" }, "status": { "type": "string" } }, "required": ["invoice_id", "status"] },
      "execution": "direct"
    }
  ],
  "total": 1,
  "has_more": false
}
```

Bij een schrijf-handeling zegt `execution` vooraf wat er met **deze** sleutel
gebeurt: `direct` (wordt uitgevoerd) of `approval` (wordt klaargezet).

`GET /v1/actions/{id}` geeft één handeling.

### Uitvoeren — `POST /v1/actions/{id}`

De body is de invoer, als JSON-object met de velden uit `input_schema`.

**Een lees-handeling** geeft meteen de gegevens:

```json
{ "action": "search_clients", "status": "ok", "data": { "count": 1, "clients": [ … ] } }
```

**Een schrijf-handeling** heeft twee mogelijke uitkomsten.

*Uitgevoerd* — HTTP 200:

```json
{
  "action": "ticket.set_client",
  "status": "executed",
  "title": "Ticket koppelen aan Jansen BV: Website ligt eruit",
  "details": "nu: geen klant · wordt: Jansen BV",
  "result": "Ticket \"Website ligt eruit\" gekoppeld aan Jansen BV",
  "audit_id": "…"
}
```

*Klaargezet* — HTTP 202, met een `Location`-header naar het voorstel:

```json
{
  "action": "propose_client",
  "status": "queued",
  "proposal": {
    "id": "69a12b67-…",
    "status": "pending",
    "title": "Nieuwe klant Nieuwe Klant BV",
    "irreversible": false,
    "created_at": "2026-10-03T07:27:10Z"
  },
  "reason": "ResoFly kan \"Nieuwe klant klaarzetten\" niet rechtstreeks uitvoeren: …"
}
```

Een klaargezette wijziging is **nog niet gebeurd**. Hij staat in de
goedkeurwachtrij op het startscherm van ResoFly, met de naam van je sleutel
erbij, en gebeurt pas als iemand op *Uitvoeren* klikt. Wil je dat altijd, ook
met een sleutel die mag uitvoeren, gebruik dan `?mode=queue`.

Waarom wordt iets met `execute` toch klaargezet? Twee redenen, en `reason` zegt
welke:

1. ResoFly kan de handeling niet op de server uitvoeren. Dat geldt voor alles
   wat een mail verstuurt, een PDF maakt of bestanden raakt, en voor de
   handelingen die Gerrie zelf opstelt (`propose_…`: een factuur, een nieuwe
   klant, een mail aan een klant).
2. De handeling is onomkeerbaar of gaat naar buiten (`risk: "high"`), en de
   sleutel heeft geen `execute_high`.

### Voorstellen opvolgen — `GET /v1/proposals`

```bash
curl -s "$RESOFLY_API/v1/proposals?status=pending" -H "Authorization: Bearer $RESOFLY_KEY"
curl -s "$RESOFLY_API/v1/proposals/69a12b67-…" -H "Authorization: Bearer $RESOFLY_KEY"
```

Je ziet alleen de voorstellen van je eigen sleutel. `status` is één van:

| `status` | Betekenis |
|---|---|
| `pending` | Wacht op een mens in ResoFly. |
| `executed` | Goedgekeurd en uitgevoerd. `result` zegt wat er gebeurde. |
| `rejected` | Afgewezen door een gebruiker. |
| `failed` | Goedgekeurd, maar het uitvoeren mislukte. `result` zegt waarom. |
| `cancelled` | Geannuleerd, bijvoorbeeld omdat de sleutel is ingetrokken. |
| `approved` | Goedgekeurd, nog niet uitgevoerd (zelden te zien). |

## Veilig herhalen — `Idempotency-Key`

Een netwerkfout halverwege? Stuur bij elke schrijf-aanroep een eigen
`Idempotency-Key` mee (1–255 tekens, bijvoorbeeld een UUID). Binnen 24 uur
krijgt dezelfde sleutel met dezelfde inhoud het **eerste antwoord** terug, met
`Idempotent-Replayed: true`, in plaats van een tweede uitvoering.

```bash
curl -s -X POST "$RESOFLY_API/v1/actions/invoice.set_status" \
  -H "Authorization: Bearer $RESOFLY_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: 3f6c2a0e-8d6b-4a77-9f0e-2c1b5d7e9a10" \
  -d '{"invoice_id": "…", "status": "paid"}'
```

- Zelfde sleutel, **andere** inhoud: 422 `idempotency_conflict`.
- De eerste poging is nog bezig: 409 `idempotency_in_progress` — probeer het zo opnieuw.
- Liep de eerste poging aan onze kant mis (5xx), dan mag een herhaling het opnieuw proberen.

## Webhooks — ResoFly geeft een seintje

In plaats van elke minuut te vragen of er een factuur betaald is, meld je een
**eindpunt** aan: een https-adres van jou. Gebeurt er iets waarop je bent
ingeschreven, dan stuurt ResoFly daar een ondertekend JSON-bericht naartoe.

### Gebeurtenissen

| Onderwerp | Module | Gebeurtenissen |
|---|---|---|
| Klanten | `clients` | `client.created`, `client.updated`, `client.deleted` |
| Contactpersonen | `clients` | `contact.created`, `contact.updated`, `contact.deleted` |
| Projecten | `projects` | `project.created`, `project.updated`, `project.deleted` |
| Taken | `projects` | `task.created`, `task.updated`, `task.completed`, `task.deleted` |
| Tickets | `tickets` | `ticket.created`, `ticket.updated`, `ticket.deleted`, `ticket_note.created` (een nieuwe reactie) |
| Uren | `time` | `time_entry.created`, `time_entry.updated`, `time_entry.deleted` |
| Offertes | `finance` | `quote.created`, `quote.updated`, `quote.sent`, `quote.accepted`, `quote.rejected`, `quote.deleted` |
| Facturen | `finance` | `invoice.created`, `invoice.updated`, `invoice.sent`, `invoice.paid`, `invoice.deleted` |
| Contracten | `finance` | `contract.created`, `contract.updated`, `contract.signed`, `contract.declined`, `contract.deleted` |
| Afspraken | `calendar` | `booking.created`, `booking.updated`, `booking.cancelled` |

Inschrijven kan op een exact type, op een heel onderwerp (`invoice.*`) of op
alles (`*`). Een statusovergang krijgt een eigen gebeurtenis **naast** de
gewone: een factuur die op betaald gaat, geeft `invoice.updated` én
`invoice.paid` — schrijf je in op wat je nodig hebt. Wijzigingen die niets
zeggen (een taak verslepen op het bord, de bezorgstatus van een mail) geven
geen gebeurtenis.

`GET /v1/events` geeft de lijst die **jouw sleutel** kan ontvangen.

### Een eindpunt aanmelden

In de app onder **Instellingen → API & webhooks**, of via de API — het
"REST hooks"-patroon van Zapier en Make. Lezen is genoeg; een webhook levert
niets af wat de sleutel niet ook zelf mag opvragen.

```bash
curl -s -X POST "$RESOFLY_API/v1/webhooks" \
  -H "Authorization: Bearer $RESOFLY_KEY" -H "Content-Type: application/json" \
  -d '{"url": "https://hooks.jouwdomein.nl/resofly", "events": ["invoice.paid", "client.*"], "description": "Boekhouding"}'
```

```json
{
  "webhook": {
    "id": "8c1d…",
    "url": "https://hooks.jouwdomein.nl/resofly",
    "description": "Boekhouding",
    "events": ["invoice.paid", "client.*"],
    "active": true,
    "disabled_reason": null,
    "consecutive_failures": 0,
    "last_success_at": null,
    "last_failure_at": null,
    "created_at": "2026-10-03T08:00:00.000000+00:00"
  },
  "secret": "whsec_…"
}
```

Het **geheim** (`whsec_…`) zie je alleen in dit antwoord. Bewaar het: je hebt
het nodig om de handtekening te controleren.

| Methode | Pad | |
|---|---|---|
| `GET` | `/v1/webhooks` | Je eindpunten. |
| `POST` | `/v1/webhooks` | Aanmelden (201, met het geheim). |
| `GET` | `/v1/webhooks/{id}` | Eén eindpunt. |
| `PATCH` | `/v1/webhooks/{id}` | `url`, `events`, `description` of `active` wijzigen. |
| `DELETE` | `/v1/webhooks/{id}` | Afmelden (204). |
| `POST` | `/v1/webhooks/{id}/test` | Stuurt nu meteen een `ping` en geeft het antwoord van je eindpunt terug. |
| `GET` | `/v1/webhooks/{id}/deliveries` | De laatste bezorgingen (`?limit=`, max 100). |

Een eindpunt dat je via de API aanmeldt, **hoort bij je sleutel**: je ziet en
beheert alleen je eigen eindpunten, je krijgt alleen gebeurtenissen uit modules
die de sleutel mag lezen (bij elke bezorging opnieuw gewogen), en het eindpunt
verdwijnt als de sleutel wordt ingetrokken. Vraag je uitdrukkelijk om een
gebeurtenis uit een module die dicht staat, dan krijg je 422.

Het adres moet `https://` zijn en vanaf internet bereikbaar: geen `localhost`,
geen intern netwerk, geen privé-IP-adres.

### Wat er binnenkomt

Een `POST` met deze headers:

| Header | |
|---|---|
| `Content-Type` | `application/json` |
| `ResoFly-Event` | Het type, bijvoorbeeld `invoice.paid`. |
| `ResoFly-Event-Id` | Het id van de gebeurtenis — gelijk aan `id` in de body. |
| `ResoFly-Delivery-Id` | Het id van de bezorging aan dit eindpunt; bij een nieuwe poging hetzelfde. |
| `ResoFly-Signature` | `t=<unix-tijd>,v1=<handtekening>` — zie hieronder. |
| `User-Agent` | `ResoFly-Webhooks/1.0 (+https://resofly.nl)` |

En deze body:

```json
{
  "id": "5d0c9a7e-…",
  "type": "invoice.paid",
  "created_at": "2026-10-03T08:00:00.123456+00:00",
  "organization_id": "0000000a-…",
  "data": {
    "object": { "id": "10000000-…", "number": "2026-0042", "status": "paid", "client_id": "…", "total_amount": 1210.00, "paid_at": "…", "…": "…" },
    "changed": ["status", "paid_at"],
    "previous": { "status": "sent", "paid_at": null }
  }
}
```

- `data.object` is de rij zoals hij **nu** is (bij `*.deleted`: zoals hij was).
- Bij een wijziging staat in `changed` welke velden er veranderden en in
  `previous` wat ze waren.
- Er gaan nooit geheimen mee: velden die op token, hash, secret, password of pin
  lijken vallen eruit, net als opslagsleutels en base64-bestanden.
- Een veld groter dan 32 kB (een lange contracttekst) valt eruit en staat in
  `data.object._omitted`; haal het zo nodig op via de API.

### De handtekening controleren

Controleer elk bericht voordat je er iets mee doet. De handtekening is een
HMAC-SHA256, in kleine hex, over `<t>.<body>` — met het **hele** geheim
(inclusief `whsec_`) als sleutel en de body **precies zoals hij binnenkwam**.
Parse de JSON pas daarna: opnieuw geserialiseerde JSON is niet meer dezelfde
tekst. Weiger ook een bericht waarvan `t` meer dan vijf minuten afwijkt; zo is
een onderschept bericht niet later opnieuw af te spelen.

**Node.js**

```js
import crypto from 'node:crypto';

function verifyResoFly(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((part) => part.trim().split('=')));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

// Express: lees de body als ruwe tekst.
app.post('/resofly', express.raw({ type: 'application/json' }), (req, res) => {
  const raw = req.body.toString('utf8');
  if (!verifyResoFly(process.env.RESOFLY_WEBHOOK_SECRET, req.get('ResoFly-Signature') ?? '', raw)) {
    return res.sendStatus(400);
  }
  const event = JSON.parse(raw);
  res.sendStatus(200);            // eerst antwoorden…
  handleLater(event);             // …dan het werk (een wachtrij, een job)
});
```

**Python**

```python
import hashlib, hmac, time

def verify_resofly(secret: str, header: str, raw_body: bytes, tolerance: int = 300) -> bool:
    parts = dict(part.strip().split("=", 1) for part in header.split(",") if "=" in part)
    try:
        t = int(parts.get("t", ""))
    except ValueError:
        return False
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))

# Flask: request.get_data() geeft de ruwe body.
```

**PHP**

```php
function verify_resofly(string $secret, string $header, string $rawBody, int $tolerance = 300): bool {
    $parts = [];
    foreach (explode(',', $header) as $part) {
        [$key, $value] = array_pad(explode('=', trim($part), 2), 2, '');
        $parts[$key] = $value;
    }
    if (!isset($parts['t']) || !ctype_digit($parts['t'])) return false;
    $t = (int) $parts['t'];
    if (abs(time() - $t) > $tolerance) return false;
    $expected = hash_hmac('sha256', $t . '.' . $rawBody, $secret);
    return hash_equals($expected, $parts['v1'] ?? '');
}

// $rawBody = file_get_contents('php://input');
// $header  = $_SERVER['HTTP_RESOFLY_SIGNATURE'] ?? '';
```

Een nieuw geheim (in de app: *Nieuw geheim*) werkt meteen; het oude niet meer.

### Antwoorden, opnieuw proberen, en dubbele berichten

- **Antwoord binnen 10 seconden met een 2xx.** Doe het zware werk daarna. Wie
  langer nodig heeft, krijgt het bericht later opnieuw.
- **Geen 2xx, of geen antwoord?** Dan opnieuw na 1 minuut, 5 minuten, 30
  minuten, 2 uur, 6 uur, 12 uur, 24 uur en 24 uur — negen pogingen, bijna drie
  dagen. Daarna geven we het op; `GET /v1/webhooks/{id}/deliveries` laat zien wat
  er misging.
- **Een doorverwijzing (3xx) volgen we niet**: dat telt als mislukt. Gebruik het
  uiteindelijke adres.
- **`410 Gone`** zet het eindpunt meteen uit: "dit adres bestaat niet meer".
- **Een hele dag niets dan fouten** (en minstens 25 keer) zet het eindpunt ook
  uit, met de reden erbij. Wat er binnenkomt terwijl een eindpunt uit staat,
  wordt niet bewaard; zet het aan met `PATCH {"active": true}` en haal wat je
  miste op via de API.
- **Een bericht kan vaker komen** ("minstens één keer"). Gebruik `id` (of
  `ResoFly-Event-Id`) om een herhaling te herkennen.
- **De volgorde is niet gegarandeerd.** Vergelijk bij twijfel
  `data.object.updated_at`, of vraag de actuele stand op via de API.

### Testen

```bash
curl -s -X POST "$RESOFLY_API/v1/webhooks/8c1d…/test" -H "Authorization: Bearer $RESOFLY_KEY"
```

```json
{ "status": "delivered", "http_status": 200, "error": null, "duration_ms": 184, "delivery_id": "…", "event_id": "…" }
```

Je eindpunt krijgt dan een bericht van het type `ping`, ondertekend zoals elk
ander:

```json
{
  "id": "…",
  "type": "ping",
  "created_at": "…",
  "organization_id": "…",
  "data": { "message": "Dit is een testbericht van ResoFly. …", "endpoint_id": "8c1d…", "sent_by": "API-sleutel \"Zapier\"" }
}
```

Een testbericht wordt niet opnieuw geprobeerd. Een eindpunt dat uit staat, kan
niet getest worden (409).

## Fouten

Elke fout heeft dezelfde vorm, met een vaste `code` voor je programma en een
`message` voor mensen (in het Nederlands):

```json
{ "error": { "code": "invalid_input", "message": "Ticket niet gevonden in deze organisatie.", "request_id": "…" } }
```

| HTTP | `code` | Wanneer |
|---|---|---|
| 400 | `invalid_request` | Geen geldige JSON, een onbekende parameter-waarde. |
| 401 | `unauthorized` | Geen, een onbekende, ingetrokken of verlopen sleutel. |
| 403 | `insufficient_scope` | De sleutel mag alleen lezen. |
| 403 | `forbidden` | De module staat dicht, of het is een handeling voor owners/admins. |
| 404 | `not_found`, `unknown_action` | Onbekend adres, onbekende handeling, of een voorstel of webhook van een andere sleutel. |
| 405 | `method_not_allowed` | Zie de `Allow`-header. |
| 409 | `idempotency_in_progress` | Zie hierboven. |
| 409 | `conflict` | Een webhook testen die uit staat, of het maximum aantal webhooks is bereikt. |
| 413 | `payload_too_large` | Invoer groter dan 1 MB. |
| 422 | `invalid_input` | De invoer klopt niet, of een id bestaat niet in deze organisatie. `message` zegt wat. |
| 422 | `idempotency_conflict` | Zie hierboven. |
| 429 | `rate_limited` | Te veel verzoeken; wacht `Retry-After` seconden. |
| 429 | `queue_full` | 50 voorstellen van deze sleutel wachten nog op goedkeuring. |
| 500 | `internal_error` | Aan onze kant misgegaan. Geef het `request_id` door. |

Elk antwoord heeft een `X-Request-Id`-header.

## Limieten

- **300 aanroepen per minuut per sleutel** (je beheerder kan dat aanpassen).
  `RateLimit-Limit` en `RateLimit-Remaining` staan in elk antwoord.
- **1 MB** invoer per verzoek.
- **50 openstaande voorstellen** per sleutel.
- **20 webhooks** per sleutel, **50** per organisatie.
- Lijsten binnen een handeling hebben hun eigen `limit`-veld; zie het schema.

## Voorbeelden

### JavaScript (Node 18+, Deno, Bun)

```js
const API = process.env.RESOFLY_API;
const KEY = process.env.RESOFLY_KEY;

async function resofly(path, { method = 'GET', body, idempotencyKey } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${data.error.code}: ${data.error.message}`);
  return { status: res.status, data };
}

const { data: me } = await resofly('/v1/me');
console.log(`Gekoppeld aan ${me.organization.name} als ${me.key.access}`);

const { data: found } = await resofly('/v1/actions/search_clients', { method: 'POST', body: { query: 'jansen' } });
console.log(found.data.clients);

const { status, data } = await resofly('/v1/actions/ticket.set_client', {
  method: 'POST',
  body: { ticket_id: '…', client_id: '…' },
  idempotencyKey: crypto.randomUUID(),
});
console.log(status === 202 ? `Klaargezet: ${data.proposal.id}` : data.result);
```

### Python

```python
import os, uuid, requests

API = os.environ["RESOFLY_API"]
session = requests.Session()
session.headers["Authorization"] = f"Bearer {os.environ['RESOFLY_KEY']}"

me = session.get(f"{API}/v1/me").json()
print(me["organization"]["name"], me["key"]["access"])

res = session.post(
    f"{API}/v1/actions/invoice.set_status",
    json={"invoice_id": "…", "status": "paid"},
    headers={"Idempotency-Key": str(uuid.uuid4())},
)
body = res.json()
if res.status_code == 202:
    print("Klaargezet, wacht op goedkeuring:", body["proposal"]["id"])
elif res.ok:
    print(body["result"])
else:
    print(body["error"]["code"], body["error"]["message"])
```

### Koppelplatforms (Zapier, Make, n8n)

Gebruik een HTTP-module met:

- URL: `https://<project>.supabase.co/functions/v1/api/v1/actions/<id>`
- Methode: `POST`, body: JSON met de velden uit het schema
- Header: `Authorization: Bearer rsfapi.…`

Of lees het OpenAPI-document in (`/v1/openapi.json`): dan staat elke handeling
als eigen operatie klaar, met zijn invoervelden.

Voor een **trigger** ("als er een factuur betaald is, dan …") gebruik je
webhooks met het REST hooks-patroon:

- *Subscribe*: `POST /v1/webhooks` met `{"url": "<het adres dat het platform je geeft>", "events": ["invoice.paid"]}`. Bewaar het `id` uit het antwoord.
- *Unsubscribe*: `DELETE /v1/webhooks/{id}`.
- *Perform list* (voorbeeldgegevens): een lees-handeling, bijvoorbeeld `POST /v1/actions/list_invoices` met `{"status": "paid", "limit": 3}`.
