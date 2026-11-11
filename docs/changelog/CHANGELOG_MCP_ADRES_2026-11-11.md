# De AI-koppeling heeft een eigen adres: mcp.resofly.com

**11 november 2026 · zie [MCP_CONNECTOR_SETUP.md](../setup/MCP_CONNECTOR_SETUP.md), "Het eigen adres"**

Wie zijn eigen AI aan ResoFly koppelde, plakte tot vandaag dit adres in zijn
AI-app:

```
https://enzghpduqwaojcxgwarr.supabase.co/functions/v1/mcp
```

Dat werkte. Maar het was het adres van onze leverancier, met een projectcode
erin. Het zou ook veranderen zodra we van Supabase-project wisselen. Nu is het:

```
https://mcp.resofly.com/mcp
```

De opdracht voor Gemini CLI wordt daarmee
`gemini mcp add --transport http resofly https://mcp.resofly.com/mcp`, en voor
Claude Code hetzelfde met `claude`. Instellingen → AI toont het nieuwe adres na
de eerstvolgende build van staging.

## Hoe

Op `mcp.resofly.com` staat een Cloudflare Worker (`workers/mcp`). Die stuurt door
naar dezelfde twee edge functions als altijd, `mcp` en `mcp-oauth`. Er draait
geen tweede server en er is geen tweede weg naar de gegevens. De Worker kent een
vaste tabel met paden: wat een AI-client nodig heeft, en verder niets. Andere
edge functions zijn via dit adres niet te bereiken.

De functies zelf hoefden niet te veranderen. Ze kregen hun nieuwe adres via de
secrets `MCP_RESOURCE_URL` en `MCP_PUBLIC_BASE_URL`, die al voor dit doel
klaarlagen.

Twee dingen gaan op het eigen adres beter dan op supabase.co:

- **Een client vindt de autorisatieserver bij de eerste poging.** De issuer is
  nu de root van het domein. Op supabase.co was die root niet van ons, en
  moest een client via een omweg (de OpenID-vorm) bij de metadata komen.
- **Oudere clients (MCP 2025-03-26) komen er ook doorheen.** Die zoeken de
  autorisatieserver op de root van het adres van de MCP-server. Op supabase.co
  liep dat dood.

Wie het adres in een browser opent, krijgt een korte uitleg in plaats van
"Method not allowed".

## De rem op registraties telt per client

`mcp-oauth` remt registraties van AI-clients: zestig per uur per IP-adres. Een
verzoek dat via een Worker bij Supabase aankomt, komt van een adres van
Cloudflare zelf. Zonder maatregel hadden alle klanten achter mcp.resofly.com
samen één teller gedeeld. Koppelen had dan voor iedereen stilgelegen zodra er
in een uur zestig AI-apps bij kwamen.

De Worker geeft daarom het echte adres van de client mee, met een geheim
(`MCP_PROXY_SECRET`, in de Worker en in Supabase hetzelfde). `mcp-oauth` gelooft
dat adres alleen met dat geheim erbij (`senderAddress` in
`_shared/mcpAuth.ts`). Stuurt een client die headers zelf mee, dan haalt de
Worker ze weg. Ontbreekt het geheim of klopt het niet, dan telt het gewone
adres: strenger, nooit ruimer.

## Wat er op staging is ingesteld

| Waar | Wat |
|---|---|
| Cloudflare Workers | `resofly-mcp-staging`, route `mcp.resofly.com/*`, secret `MCP_PROXY_SECRET` |
| Cloudflare DNS (`resofly.com`) | `AAAA mcp 100::`, proxied |
| Supabase-secrets (staging) | `MCP_RESOURCE_URL=https://mcp.resofly.com/mcp`, `MCP_PUBLIC_BASE_URL=https://mcp.resofly.com`, `MCP_PROXY_SECRET` |
| Cloudflare Pages (`resofly`, preview) | `VITE_MCP_SERVER_URL=https://mcp.resofly.com/mcp` |

De productie-omgeving van Pages en het productieproject in Supabase zijn niet
aangeraakt. Het adres hoort nu bij staging, omdat er nog geen productie is.
Hoe productie het overneemt, staat in de handleiding.

## Wat je zelf moet doen

**Een bestaande koppeling blijft werken.** Een token is niet aan het adres
gebonden, en het oude adres blijft antwoorden, ook bij het vernieuwen van een
token. Dat is na de overstap gecontroleerd met de Claude-koppeling van deze
werkruimte. Maar haalt je AI-app later opnieuw de koppelgegevens op, dan noemt
de server het nieuwe adres. Claude weigert dan, omdat de connector nog op het
oude adres staat. Verwijder de connector daarom nu en voeg hem opnieuw toe met
`https://mcp.resofly.com/mcp`.

## Bewaakt

- `workers/mcp/src/logic.test.ts`: elk pad van een AI-client komt op de juiste
  functie uit, en verder kan er niets door (ook niet met `/../` of
  `%2e%2e`). Wat een client zelf als adres of geheim meestuurt, gaat nooit door.
  De Worker en `mcp-oauth` gebruiken dezelfde headernamen.
- `workers/mcp/src/index.test.ts`: is Supabase onbereikbaar, dan een 502 en geen
  401. Een 401 had de AI-app opnieuw laten koppelen.
- `workers/mcp/test/worker.mjs`: de Worker in workerd. Methode, headers en inhoud
  komen ongeschonden aan, de 302 van `/authorize` gaat naar de browser, en de
  sessie-header komt terug.
- `mcpAuth.test.ts`: het adres van de Worker telt alleen met het juiste geheim, en
  alleen als het op een IP-adres lijkt.
- De rooktest na elke uitrol loopt het eigen adres af zoals een AI-client dat
  doet. Hij leest daarvoor de `resource` uit het resource-document. Noemt de
  server een adres waar de Worker niet staat, dan wordt de rooktest rood.

## Getest

- `npm test`, `npm run typecheck`, de typecheck van de Worker, en
  `node test/worker.mjs` in `workers/mcp`.
- `deno check` op `mcp` en `mcp-oauth`.
- Het nieuwe deel van de rooktest tegen een nagebootste server: een goede
  instelling, geen eigen adres (overgeslagen) en een adres met een slash te veel
  (rood).
