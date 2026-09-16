# MCP-connector — klanten koppelen hun eigen AI

Met deze koppeling laat een klant zijn eigen assistent — Claude, ChatGPT, of een
andere die MCP spreekt — meewerken in zijn ResoFly-werkruimte. Hij vraagt die AI
"welke facturen staan er open?" of "wat heb ik deze week op Jansen geboekt?" en
krijgt antwoord uit zijn eigen administratie. En hij kan hem laten
**klaarzetten**: "stuur Jansen een herinnering" belandt als voorstel in zijn
goedkeurwachtrij, waar hij het met één klik uitvoert.

Het model draait op **zijn** abonnement, niet op het onze. Wij leveren alleen de
gegevens. Daarmee valt het maandtegoed dat Gerrie begrenst hier weg als
beperking — en daarmee ook als kostenpost.

## Wat het wel en niet is

|  | Gerrie | Eigen AI via MCP |
|---|---|---|
| Model | Ons Claude-abonnement | Dat van de klant |
| Kosten | Ons maandtegoed | Zijn eigen |
| Lezen | Ja | Ja |
| Wijzigen / versturen | Als voorstel, na goedkeuring | Als voorstel, na goedkeuring |
| Zelf uitvoeren | Nooit | Nooit |
| Waar je praat | In ResoFly | In zijn eigen AI-app |

**Wat een gekoppelde AI kan, kan Gerrie ook — en omgekeerd.** Het verschil zit
niet in wat er mag, maar in wiens model het is en wie ervoor betaalt.

**Uitvoeren doet geen van beide.** Een schrijf-handeling levert een VOORSTEL op:
een kaart met wat er gaat gebeuren, in de goedkeurwachtrij. Pas als een mens daar
klikt, gebeurt het — en dan draait het in zijn browser, onder zijn eigen sessie,
met alle databasebeveiliging die daarbij hoort. Er is geen pad waarlangs een
model iets in gang zet zonder die klik. Ook niet als de gebruiker erom vraagt.

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
Op dat scherm staat één keuze: mag deze AI ook wijzigingen klaarzetten, of alleen
meelezen? Standaard mag hij klaarzetten; één vinkje uit houdt het bij meelezen.

Vraagt hij zijn AI daarna om iets te wijzigen, dan komt dat als kaart in de
**goedkeurwachtrij** op zijn startscherm — met een eigen merkteken, zodat hij ziet
dat het van zijn gekoppelde AI komt en niet van een Gerrie-agent. Klikken op
Uitvoeren doet het echt; tot dat moment is er niets gebeurd.

Loskoppelen doet hij onder **Instellingen → AI**; dat werkt meteen. De database
trekt de tokens mee in en zet alles wat die koppeling nog had klaarstaan op
geannuleerd.

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

## Standaardvragen en bronnen

Een klant die zijn AI net gekoppeld heeft, weet niet wat hij kan vragen. Daarom
staan er twee dingen klaar die hij in zijn AI-app uit een menu pakt.

**Standaardvragen** (`prompts`) — vijf opdrachten die deze koppeling goed aankan:
weekoverzicht, klant doorlichten (met de naam als invulveld), openstaande
facturen nalopen, notulen opvolgen, en je dag voorbereiden. In Claude verschijnen
ze als keuzes; de opdracht die eronder zit stuurt het model langs `find_actions`
en `run_action`, met de instructie niets te verzinnen.

**Bronnen** (`resources`) — dingen die hij aanhecht vóórdat hij iets vraagt: zijn
postvak, recente klantmail, de planning van deze week, de openstaande posten, de
recente notulen. Plus twee met een veld erin: `resofly://project/{project_id}`
en `resofly://factuur/{invoice_id}`.

Beide lopen over dezelfde rails als `run_action`: een lees-handeling uit de
registry, org-scoped, achter het modulerecht van dat teamlid. Er komt dus geen
tweede weg naar de gegevens bij — alleen een tweede manier om die ene weg aan te
roepen. Wie Financiën niet mag zien, krijgt *facturen nalopen* niet in zijn menu
én kan `resofly://openstaande-posten` niet ophalen; beide kanten controleren
hetzelfde.

Dat de catalogus blijft kloppen met de registry is een test: `mcpCatalog.test.ts`
faalt als een bron naar een handeling wijst die niet bestaat, naar een
schrijf-handeling wijst, op de verkeerde module staat, of als een URI-sjabloon een
ander veld invult dan de handeling verplicht stelt.

## De klantgrens — waarom een AI nooit bij een andere klant komt

Dit is de vraag die ertoe doet in een pakket waar meerdere bedrijven in dezelfde
database zitten. Het antwoord bestaat uit drie sloten die onafhankelijk van
elkaar werken; er hoeft er maar één te houden.

**1. De organisatie komt uit de koppeling, nooit uit het model.** Een token
verwijst naar precies één rij in `mcp_grants`: één gebruiker, één organisatie.
Die `organization_id` gaat als `ActionCtx.organizationId` de handeling in. Het
model kan hem niet meesturen, niet overschrijven en niet raden — er is geen
invoerveld voor.

**2. Elke query in de registry filtert erop.** De 264 handelingen draaien op de
service-role, die RLS overslaat; dat filter is daar dus de enige grens. Alle
toegang loopt via `orgQuery()` of `row()`, of filtert zelf op
`organization_id`, en elke RPC krijgt `p_organization_id` uit de sessie mee.
Geeft het model een id van een andere organisatie mee, dan komt `row()` terug
met *"niet gevonden in deze organisatie"* — niet met de rij.

Dat is geen belofte maar een test: `actionTenancy.test.ts` leest de hele registry
na en faalt op een query zonder org-filter, een RPC zonder organisatie, en op elke
poging om een organisatie-id uit de invoer te lezen. Een nieuwe handeling die het
vergeet, komt de CI niet door.

**3. Uitvoeren gebeurt onder de sessie van een mens.** Een goedgekeurd voorstel
draait in de browser van degene die klikt — met RLS, met de modulepoorten en met
de tenant-triggers die controleren of gekoppelde records bij elkaar horen. Zelfs
als er onverhoopt een vreemd id in een payload zat, weigert de database het daar
alsnog.

Binnen de eigen organisatie geldt vervolgens gewoon het rechtenraster: de AI ziet
en doet precies wat zijn eigen teamlid ziet en doet, niet meer.

## Hoe de beveiliging verder in elkaar zit

**Een koppeling is persoonlijk.** Eén rij in `mcp_grants` is één gebruiker, in
één organisatie, voor één AI-client. Een admin koppelt niet namens het team.

**De rechten komen vers uit de database.** Bij elke aanroep leest de connector
rol en modulerechten opnieuw uit `organization_members`. Zet een owner een
teamlid vandaag op viewer of doet hij Financiën dicht, dan geldt dat meteen —
niet pas als het token verloopt. Wat een teamlid niet mag zien, bestaat voor zijn
AI niet: het komt niet eens terug uit `find_actions`.

**Klaarzetten vraagt schrijfrecht, net als in het scherm.** Een member met
Financiën op "lezen" kan via zijn AI geen factuur klaarzetten — hetzelfde
antwoord als hij in de app zou krijgen. En een koppeling waarbij de gebruiker
alleen meelezen toestond, krijgt `propose_action` niet eens aangeboden.

**Het voorstel schrijven wij, niet het model.** Wat er op de goedkeurkaart staat,
komt uit `plan()`: echte rijen uit de eigen administratie. Een model dat
"herinnering aan Jansen" zegt terwijl de payload iets anders doet, komt daar niet
mee weg — de kaart toont wat er werkelijk gaat gebeuren.

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

**"Er staan al 25 voorstellen te wachten."** Een plafond op wat één koppeling
onafgehandeld mag laten staan. Het is er niet tegen misbruik maar tegen een
onbruikbare wachtrij: een lijst waar niemand doorheen komt, is een lijst waarin
iemand op Uitvoeren klikt zonder te lezen. Afhandelen in ResoFly geeft meteen
weer ruimte.

**429 bij intensief gebruik.** Honderdtwintig aanroepen per minuut per koppeling.
Dat is ruim voor een gesprek; loopt een klant er structureel tegenaan, dan is er
waarschijnlijk een agent aan het doorslaan.

## Wat er hierna komt

**Een melding bij een nieuw voorstel.** Zet de AI van een klant iets klaar terwijl
hij niet in ResoFly kijkt, dan ziet hij dat pas als hij de app opent. De
push-infrastructuur ligt er (`decision_digest`); een variant voor
AI-voorstellen is een kleine toevoeging.

**Bronnen per klant.** Nu zijn er sjablonen voor een project en een factuur. Een
klantdossier als bron zou logisch zijn, maar daar is nog geen lees-handeling voor
die het hele dossier in één keer geeft.
