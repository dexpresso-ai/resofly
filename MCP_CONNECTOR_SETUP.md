# MCP-connector — klanten koppelen hun eigen AI

Met deze koppeling laat een klant zijn eigen assistent — Claude, ChatGPT, of een
andere die MCP spreekt — meelezen in zijn ResoFly-werkruimte. Hij vraagt die AI
dan "welke facturen staan er open?" of "wat heb ik deze week op Jansen geboekt?"
en krijgt antwoord uit zijn eigen administratie.

Het model draait op **zijn** abonnement, niet op het onze. Wij leveren alleen de
gegevens. Daarmee valt het maandtegoed dat Gerrie begrenst hier weg als
beperking — en daarmee ook als kostenpost.

## Wat het wel en niet is

|  | Gerrie | Eigen AI via MCP |
|---|---|---|
| Model | Ons Claude-abonnement | Dat van de klant |
| Kosten | Ons maandtegoed | Zijn eigen |
| Lezen | Ja | Ja |
| Wijzigen / versturen | Ja, als voorstel op de beslislijst | **Nee** |
| Waar je praat | In ResoFly | In zijn eigen AI-app |

De connector is **alleen-lezen**. Dat is geen tijdelijke beperking maar de reden
dat dit veilig kan: een model dat niet van ons is, krijgt geen knop die geld
verstuurt. Wijzigen blijft lopen via Gerrie, waar een mens het voorstel op de
beslislijst goedkeurt. (Zie "Wat er hierna komt".)

## 1. Database

```bash
supabase db push
```

Of draai `supabase/migrations/20260916000000_mcp_connector.sql` in de SQL-editor.
Die maakt vier tabellen: `mcp_clients`, `mcp_grants`, `mcp_auth_codes` en
`mcp_tokens`. Veilig om meermaals te draaien.

## 2. Secrets

```bash
supabase secrets set MCP_STATE_SECRET="$(openssl rand -base64 48)"
```

`APP_PUBLIC_URL` moet al staan (daar leeft het toestemmingsscherm). Staat hij er
niet, zet hem dan nu:

```bash
supabase secrets set APP_PUBLIC_URL="https://app.jouwdomein.nl"
```

Gebruik **per omgeving een ander** `MCP_STATE_SECRET`. Een koppelverzoek dat op
staging is ondertekend hoort op productie niet te werken.

## 3. Functies uitrollen

```bash
supabase functions deploy mcp-oauth --no-verify-jwt
supabase functions deploy mcp --no-verify-jwt
```

`--no-verify-jwt` is hier noodzakelijk en staat met de reden uitgeschreven in
`supabase/config.toml`. Kort: beide functies worden aangeroepen door de AI-client
van de klant, die geen Supabase-sessie heeft. Ze authenticeren zelf — met een
geregistreerde client en PKCE (`mcp-oauth`), of met het toegangstoken uit de
koppeling (`mcp`).

## 4. Controleren dat het staat

```bash
curl -s https://<PROJECT>.supabase.co/functions/v1/mcp-oauth/.well-known/oauth-authorization-server | jq
```

Je hoort `issuer`, `authorization_endpoint`, `token_endpoint` en
`registration_endpoint` terug te krijgen, met `code_challenge_methods_supported:
["S256"]`.

En de MCP-server zelf:

```bash
curl -si -X POST https://<PROJECT>.supabase.co/functions/v1/mcp \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Dat hoort een **401** te geven met een `WWW-Authenticate`-header die naar
`/.well-known/oauth-protected-resource` wijst. Precies die header is hoe de
AI-client van de klant zelf uitvindt waar hij moet koppelen — krijg je hier een
200, dan staat er iets open dat dicht hoort te zijn.

## 5. Wat de klant invult

Eén URL:

```
https://<PROJECT>.supabase.co/functions/v1/mcp
```

De rest gaat vanzelf: de AI-client leest de `WWW-Authenticate`-header, vindt de
autorisatieserver, registreert zichzelf en stuurt de klant naar het
toestemmingsscherm.

**Claude.ai** — Instellingen → Connectors → Custom connector toevoegen → URL
plakken.
**Claude Desktop** — Instellingen → Connectors → dezelfde URL.
**ChatGPT** — Instellingen → Connectors (waar beschikbaar in het abonnement van
de klant).

Daarna logt hij in bij ResoFly, kiest hij een organisatie en geeft hij akkoord.
Loskoppelen doet hij in ResoFly onder **Instellingen → AI → AI-koppelingen**; dat
werkt meteen, want de database trekt de tokens mee in.

### Een eigen domein ervoor (optioneel)

De URL hierboven werkt, maar hij is lelijk en de discovery-adressen staan op een
Supabase-pad in plaats van op een root. Wil je
`https://mcp.jouwdomein.nl`, zet er dan een Cloudflare Worker of een
Pages-redirect voor die doorstuurt naar de twee functies, en zet:

```bash
supabase secrets set MCP_PUBLIC_BASE_URL="https://mcp.jouwdomein.nl/oauth"
supabase secrets set MCP_RESOURCE_URL="https://mcp.jouwdomein.nl"
```

De functies vergelijken op de staart van het pad, dus ze werken in beide
opstellingen zonder codewijziging.

## Hoe de beveiliging in elkaar zit

**Een koppeling is persoonlijk.** Eén rij in `mcp_grants` is één gebruiker, in
één organisatie, voor één AI-client. Een admin koppelt niet namens het team.

**De rechten komen vers uit de database.** Bij elke aanroep leest de connector
rol en modulerechten opnieuw uit `organization_members`. Zet een owner een
teamlid vandaag op viewer of doet hij Financiën dicht, dan geldt dat meteen —
niet pas als het token verloopt. Wat een teamlid niet mag zien, bestaat voor zijn
AI niet: het komt niet eens terug uit `find_actions`.

**Tokens staan niet leesbaar in de database.** Een token is
`rsfmcp.<selector>.<verifier>`; we bewaren de selector plat (om de rij te vinden)
en van de verifier alleen een gesalte SHA-256. Wie de tabel leest, heeft niets.

**PKCE is verplicht, `plain` bestaat niet.** Redirect-URI's worden exact
vergeleken met wat er bij de registratie stond — geen voorvoegsel, geen joker.
Een gebruikte autorisatiecode die nog eens langskomt, trekt uit voorzorg alle
tokens van die koppeling in: dat is óf een dubbele poging óf iemand die hem
onderweg opving, en die twee zijn niet te onderscheiden.

**Alles wat opgevraagd wordt, komt in `ai_action_audit`.** Bij Gerrie loggen we
alleen wat er gebeurt; hier ook wat er gelezen wordt, inclusief welke AI-client
het deed. Dit is een deur naar buiten, dus een organisatie hoort te kunnen
terugzien wat eruit ging.

**Registreren geeft geen toegang.** Dynamische clientregistratie staat open —
dat moet, anders kan Claude.ai niet koppelen — maar een registratie is een
naamplaatje. Gegevens komen er pas uit als een ingelogd mens akkoord geeft.

## Als het niet werkt

**"Onbekende AI-client" in de browser.** De client registreerde zich bij een
andere omgeving dan waar hij nu naartoe stuurt (staging versus productie).
Verwijder de connector in de AI-app en voeg hem opnieuw toe.

**"Ongeldig terugkeeradres".** De AI-app vraagt een redirect-URI die niet in zijn
registratie staat. Opnieuw toevoegen lost dit op; komt het terug, kijk dan in
`mcp_clients.redirect_uris` wat hij geregistreerd heeft.

**"Het autorisatieverzoek is verlopen".** Een koppelverzoek is een kwartier
geldig. Begin opnieuw vanuit de AI-app.

**De klant logt in en komt op zijn dashboard in plaats van op het
toestemmingsscherm.** Dan ging de magic link naar de startpagina. De app stuurt
de link terug naar `/mcp/authorize` zolang dat verzoek in de URL staat; is dat
niet zo, controleer dan of `APP_PUBLIC_URL` klopt voor deze omgeving.

**Het toestemmingsscherm geeft een 404.** Dan serveert de hosting `/mcp/authorize`
niet als app-route. Dat is dezelfde SPA-fallback waar `/portal`, `/quote/<token>`
en `/gedeeld/<token>` op leunen; werken die wel en deze niet, dan staat er een
regel in de Cloudflare Pages-routering die dit pad afvangt.

**429 bij intensief gebruik.** Honderdtwintig aanroepen per minuut per koppeling.
Dat is ruim voor een gesprek; loopt een klant er structureel tegenaan, dan is er
waarschijnlijk een agent aan het doorslaan.

## Wat er hierna komt

**Fase B — handelingen klaarzetten.** De registry kent 188 schrijf-handelingen.
Die hebben op de server alleen een `plan()` die een *voorstel* bouwt; uitvoeren
gebeurt in de browser nadat een mens akkoord gaf. Een MCP-server draait headless,
dus schrijven kan daar niet rechtstreeks — en dat hoeft ook niet: de AI van de
klant kan het voorstel op zijn **beslislijst** zetten, waar hij het in ResoFly
goedkeurt. Dan blijft de invariant staan dat een mens elke wijziging ziet voordat
hij gebeurt. De scope `propose` staat al in de code klaar; hij wordt vandaag
alleen niet uitgegeven.

**Fase C — meer dan tekst.** MCP kent ook resources (documenten) en prompts
(kant-en-klare vragen). De server antwoordt daar nu met een lege lijst.
