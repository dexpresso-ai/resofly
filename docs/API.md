# ResoFly API — handleiding voor ontwikkelaars

Met de ResoFly API koppel je andere software aan een ResoFly-werkruimte:
gegevens ophalen, en wijzigingen klaarzetten of rechtstreeks uitvoeren. Alles
wat de app kan, kan via de API — van een klant opzoeken tot een factuur op
betaald zetten.

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
| 404 | `not_found`, `unknown_action` | Onbekend adres, onbekende handeling of een voorstel van een andere sleutel. |
| 405 | `method_not_allowed` | Zie de `Allow`-header. |
| 409 | `idempotency_in_progress` | Zie hierboven. |
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
