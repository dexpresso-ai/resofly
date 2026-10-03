# Een API waarmee je alles kunt koppelen

**3 oktober 2026 · zie [PUBLIC_API_SETUP.md](PUBLIC_API_SETUP.md) (uitrollen) en [docs/API.md](docs/API.md) (voor ontwikkelaars)**

Tot nu toe had ResoFly één deur naar buiten: de MCP-connector, voor de eigen AI
van een klant. Een webshop, een urenapp of een koppelplatform als Zapier, Make of
n8n kon nergens terecht. Nu wel: een gewone REST-API met JSON, en een
API-sleutel die een owner of admin aanmaakt onder **Instellingen → API &
webhooks**.

## Fase 1 — sleutels en handelingen

### Geen nieuwe laag, maar de registry

De API bouwt niets na. Wat hij kan, is precies wat Gerrie en de MCP kunnen: de
handelingenregistry plus Gerrie's kerntools, langs dezelfde `read()`, `plan()`,
`runGerrieTool` en `buildProposal`. Voor een owner zijn dat er nu 104 om te
lezen en 229 om te wijzigen. Een handeling die erbij komt, staat bij de volgende
uitrol vanzelf in de API — en in het OpenAPI-document, want dat wordt uit de
registry gegenereerd (`GET /v1/openapi.json`, met elke handeling als eigen pad
en eigen invoerschema).

| Adres | Wat |
|---|---|
| `GET /v1` | Wat dit is; open. |
| `GET /v1/openapi.json` | OpenAPI 3.1, gegenereerd; open. |
| `GET /v1/me` | Organisatie, sleutel, namens wie, het moduleraster. |
| `GET /v1/actions` | Wat deze sleutel kan, met zoeken in gewone woorden. |
| `POST /v1/actions/{id}` | Lezen (200), uitvoeren (200) of klaarzetten (202). |
| `GET /v1/proposals[/{id}]` | Hoe staat het met wat deze sleutel klaarzette? |

### Wat een sleutel mag

Vier treden, dezelfde als bij de AI-koppeling: alleen lezen, klaarzetten,
rechtstreeks uitvoeren, en ook het onomkeerbare. Plus een modulebeperking (een
webshop hoeft niet in de boekhouding) en een vervaldatum. Bij de AI-koppeling
staat "rechtstreeks uitvoeren" alleen in de eigen instellingen, nooit op het
toestemmingsscherm; een sleutel maakt een owner/admin met opzet aan in dat zelfde
instellingenscherm, dus daar hoort de keuze ook thuis — bij het aanmaken, en
daarna niet meer ruimer.

Rechtstreeks uitvoeren loopt langs exact dezelfde lijst server-uitvoerders als de
MCP (`apply.ts`). Wat daar niet in staat — alles met mail, PDF of bestanden, en
alles wat Gerrie zelf opstelt — wordt ook met de ruimste sleutel een voorstel in
de goedkeurwachtrij, met de reden erbij. Een koppeling ziet dat vooraf aan
`"execution": "direct"` of `"approval"` in de catalogus.

### Wat de grenzen bewaakt

- **De organisatie komt uit de sleutel.** Er is geen invoerveld voor; een id van
  een andere organisatie geeft *"niet gevonden in deze organisatie"*.
- **De rechten komen vers uit de database.** Een sleutel werkt namens zijn maker,
  met diens rol en modules van dít moment. Wordt de maker viewer, dan leest de
  sleutel alleen nog; is hij geen lid meer, dan werkt de sleutel niet meer.
- **Een sleutel kan nooit ruimer zijn dan zijn maker.** De modulebeperking knijpt
  alleen af. In Gerrie's kerntools, waar owners en admins alles mogen, draait
  een beperkte sleutel daarom als gewoon teamlid met precies zijn modules.
- **Sleutels staan niet leesbaar in de database.** `rsfapi.<selector>.<verifier>`,
  zelfde opzet als de MCP-tokens, in een tabel zonder policies.
- **Vanuit de app alleen hernoemen en intrekken.** Een databasetrigger weigert
  verruimen, de teller resetten en een ingetrokken sleutel weer aanzetten.
  Intrekken annuleert wat de sleutel nog in de wachtrij had staan.
- **Alles staat in een log.** Elke aanroep in `api_request_log` (30 dagen,
  zichtbaar voor owners/admins), elke uitvoering en elk voorstel in
  `ai_action_audit` met `api_key_id`, en aanmaken/hernoemen/intrekken in
  `audit_logs`.
- **Limieten.** 300 aanroepen per minuut per sleutel, afgeboekt in één statement
  met een rijvergrendeling; 50 openstaande voorstellen per sleutel; 1 MB invoer.
- **Veilig herhalen.** Met een `Idempotency-Key` krijgt een herhaald verzoek
  binnen 24 uur het eerste antwoord terug in plaats van een tweede uitvoering.

### Wat de gebruiker ziet

- **Instellingen → API & webhooks** (alleen owners/admins): het adres, het
  OpenAPI-adres, een nieuwe sleutel aanmaken (naam, toegang, modules, vervaldatum)
  — de sleutel is één keer te zien —, de lijst met actieve sleutels met namens
  wie, laatst gebruikt en beperkingen, en de laatste 50 aanroepen.
- **De goedkeurwachtrij** toont voorstellen van een sleutel met een eigen
  merkteken en de naam van de sleutel ("Webshop · API-koppeling").

### Wat de tests bewaken

- `publicApi.test.ts` (27) — de rekensommen: sleutels splitsen en verifiëren, een
  MCP-token is geen API-sleutel, de trap van toegangsniveaus, de modulebeperking
  (ook dat een viewer met een sleutel geen schrijver wordt), routes, statussen,
  idempotentie, en dat het OpenAPI-document elke handeling met zijn schema bevat.
  Plus dat de database precies dezelfde treden en modules kent.
- `publicApiServer.test.ts` (18) — de grenzen in de functies zelf: de organisatie
  nooit uit de invoer, eerst de sleutel controleren en dan pas de limiet
  afboeken, rechten vers uit `organization_members`, rechtstreeks uitvoeren alleen
  met een uitvoerder en het juiste risico, het auditlog met `api_key_id`, en dat
  alleen owners/admins sleutels aanmaken.

Nagemeten: `npm test` 393 groen, `npm run typecheck` en `npm run build` groen,
`deno check` op `api`, `api-admin`, `mcp`, `mcp-oauth` en `gerrie-agent` groen, de
mobiele lay-outtest op instellingen en dashboard groen. De migratie en beide
functies zijn bovendien end-to-end gedraaid tegen een lokale Postgres 16 met het
volledige schema en PostgREST 12: sleutels aanmaken als owner (en geweigerd als
member), lezen, klaarzetten, uitvoeren, de terugval naar de wachtrij, een id van
een andere organisatie, de modulebeperking, idempotentie, de aanroeplimiet,
intrekken en verlopen, en een maker die geen lid meer is.
