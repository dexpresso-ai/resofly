# MCP-connector — klanten koppelen hun eigen AI

Met deze koppeling laat een klant zijn eigen assistent — Claude, ChatGPT, of een
andere die MCP spreekt — meewerken in zijn ResoFly-werkruimte. Hij vraagt die AI
"welke facturen staan er open?" of "wat heb ik deze week op Jansen geboekt?" en
krijgt antwoord uit zijn eigen administratie. En hij kan hem laten
**klaarzetten**: "stuur Jansen een herinnering" belandt als voorstel in zijn
goedkeurwachtrij, waar hij het met één klik uitvoert. Wil hij die klik niet, dan
zet hij per koppeling **rechtstreeks uitvoeren** aan onder Instellingen → AI.

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
| Zelf uitvoeren | Nooit | Alleen als de gebruiker het zelf aanzet |
| Waar je praat | In ResoFly | In zijn eigen AI-app |

**Wat een gekoppelde AI kan, kan Gerrie ook — en omgekeerd.** Het verschil zit
niet in wat er mag, maar in wiens model het is en wie ervoor betaalt. Op één punt
kan de gekoppelde AI méér: rechtstreeks uitvoeren. Dat is geen ruimere
bevoegdheid maar een andere plek voor de klik — en het is aan de gebruiker, niet
aan ons.

Dat eerste klopte een tijd lang maar half. De connector bood alleen de
*handelingenregistry* aan (`_shared/actions/`, de lange staart: galerijen,
grootboek, aangiftes), terwijl Gerrie daarnáást zijn eigen *kerntools* heeft — een
factuur opstellen, reageren op een ticket, een mail aan een klant. Die ontbraken,
en je zag het terug in de registry zelf: daar staat bij een ticket "reageren doe je
met `propose_ticket_note`", een tool die aan de MCP-kant niet bestond. Wat de klant
ervan merkte, was dat zijn eigen AI zei dat iets niet kon terwijl Gerrie het in
hetzelfde scherm gewoon deed.

Sinds september 2026 doorzoekt `find_actions` beide lijsten en voert
`run_action` / `propose_action` uit beide uit. Er is geen tweede weg naar de
gegevens bijgekomen: een kerntool loopt langs exact dezelfde `runGerrieTool` en
`buildProposal` als de chat, met dezelfde rol- en modulecontrole. Er is alleen een
tweede manier bijgekomen om die ene weg te vínden.

Twee dingen krijgt een gekoppelde AI bewust niet:

- **`propose_create_agent`** — een agent bouwen die daarna vanzelf draait en zelf
  dingen mag klaarzetten. Een geplande agent mag dat van zichzelf ook niet
  (`AGENT_FORBIDDEN_TOOLS`), en een koppeling van buiten hoort niet ruimer te zijn
  dan iets wat binnen draait.
- **`ask_user`, `emit_plan`, `emit_agent`** — die horen bij de chatstroom op het
  scherm en betekenen niets aan de andere kant van een JSON-RPC-verbinding.

`mcpParity.test.ts` bewaakt allebei, en bewaakt ook dat elke tool waar een
omschrijving naar verwijst via de MCP te bereiken is.

### De drie standen

Standaard staat een koppeling op **klaarzetten**. De gebruiker schuift hem zelf
op onder **Instellingen → AI**, per koppeling, met twee losse schakelaars:

| Stand | Scope | Wat er gebeurt bij "zet die factuur op betaald" |
|---|---|---|
| Klaarzetten *(standaard)* | `read propose` | Een kaart in de goedkeurwachtrij. Er gebeurt pas iets als een mens klikt. |
| Rechtstreeks uitvoeren | `+ execute` | Het gebeurt meteen. Handelingen die ResoFly niet server-side kan, en alles wat `risk: 'high'` is, worden alsnog klaargezet. |
| Ook het onomkeerbare | `+ execute_high` | Ook post naar klanten, aangiftes, boekingen en publieke links gaan er rechtstreeks door. |

Die tweede schakelaar staat apart omdat het risico apart staat: een projectstatus
zet je terug, een verstuurde aanmaning niet. Zaten ze in één knop, dan koos de
gebruiker tussen "mijn AI mag niets doen" en "mijn AI mag mailen naar klanten".

**Het toestemmingsscherm deelt geen uitvoerrecht uit.** Daar kiest de gebruiker
alleen tussen meelezen en klaarzetten. Rechtstreeks uitvoeren staat alleen in
zijn eigen instellingen — een scherm dat je bereikt door in je AI-app op *Connect*
te klikken, is niet de plek om af te spreken dat die AI voortaan ongevraagd mag
boeken. Koppelt hij dezelfde AI opnieuw, dan begint die keuze weer bij uit.

### Wat "rechtstreeks" wél en niet kan

De 188 schrijf-handelingen hebben hun uitvoerder in de **browser**
(`src/lib/actions/`), bovenop `repository.ts`: dezelfde weg als de knop in het
scherm, met dezelfde normalisatie en foutafhandeling. Die allemaal naar de server
kopiëren levert een tweede implementatie op die uit de pas gaat lopen — juist bij
de handelingen waar dat het duurst is (mail, PDF, bestandsopslag).

Daarom heeft `supabase/functions/_shared/actions/apply.ts` alleen uitvoerders
voor handelingen waarvan de serverkant **aantoonbaar dezelfde** is: één
org-scoped insert of update, zonder mail, zonder PDF, zonder afgeleide rijen.
Klantgegevens, klantvelden, mappen, inhoud verplaatsen, tickets, uren,
projectinstellingen, factuurstatus, grootboek- en bankstamgegevens, rapportages,
galerijen.

**Wat de browser-uitvoering afdwong en de serverkant zelf moet doen.** Uitvoeren
in de browser gebeurde onder de sessie van het teamlid, dus met RLS erbovenop;
`apply.ts` draait op de service-role en slaat RLS over. Van de 20 tabellen die de
uitvoerders aanraken, trekt de RLS-regel bij 19 dezelfde grens die de code al
trekt (dezelfde organisatie, plus de modulepoort die de MCP-server toetst). Alleen
`planner_notes` is smaller — weekplanner-actiepunten zijn persoonlijk — en die
uitvoerder gaat daarom langs `updateOwn()`, dat ook op `user_id` filtert.
`mcpExecute.test.ts` bewaakt die lijst.

Alles daarbuiten valt terug op een voorstel — `execute_action` geeft dan
`status: "klaargezet_voor_goedkeuring"` met een `reason` erbij, en de AI hoort dat
zo tegen de gebruiker te zeggen. In `find_actions` ziet het model het vooraf aan
`direct: true` of `direct: false`. De dekking groeit door er uitvoerders bij te
zetten; `mcpExecute.test.ts` bewaakt dat elke uitvoerder bij een bestaande
schrijf-handeling hoort én dat een mens hem in de app ook kan goedkeuren.

**Gerrie's kerntools vallen daar altijd onder.** Een factuur opstellen, een mail
aan een klant of een reactie op een ticket heeft geen uitvoerder op de server.
`execute_action` zet zo'n kerntool dus altijd klaar, ook met beide schakelaars
aan, en `find_actions` toont hem met `direct: false`. Uitvoeren gebeurt daarna in
de browser, via dezelfde `executeProposal` als een voorstel van een geplande agent.

## 1. Database

```bash
supabase db push
```

Dat draait zes migraties, in volgorde en veilig om te herhalen:

| Migratie | Wat |
|---|---|
| `20260916000000_mcp_connector.sql` | De tabellen: `mcp_clients`, `mcp_grants`, `mcp_auth_codes`, `mcp_tokens` |
| `20260917000000_mcp_propose.sql` | `ai_action_audit.mcp_grant_id`; intrekken annuleert klaarstaande voorstellen |
| `20260917010000_mcp_proposal_push.sql` | Push-type `mcp_proposal` en de trigger die de melding stuurt |
| `20260917020000_mcp_grants_admin_overview.sql` | Owners/admins zien en stoppen alle koppelingen; wijzigingsguard |
| `20260917040000_mcp_proposal_push_core_tools.sql` | De melding noemt ook bij een kerntool-voorstel wat er klaarstaat (`result->>'title'`) |
| `20260917050000_mcp_execute.sql` | `mcp_grants.scope_ceiling`; de eigenaar mag zijn eigen scope wijzigen; melding ook bij een uitvoering |

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

Beide functies worden bij elke push naar `staging` en elke pull request al
door CI met `deno check` getypecheckt (job *edge-functions* in
`frontend-checks.yml`); het uitrollen doet dezelfde check nog eens.

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

Groene curls bewijzen nog niet dat een AI-client erdoor komt: de officiële
MCP-SDK keurde het discovery-document hier eerst af terwijl elke curl 200 gaf.
Zie *Discovery op supabase.co* hieronder.

## 5. Wat de klant invult

Eén URL, letterlijk zo — zonder slash erachter, want Claude vergelijkt hem met de
`resource` uit het discovery-document:

```
https://<PROJECT>.supabase.co/functions/v1/mcp
```

Die staat met een kopieerknop en de stappen per AI-app in **Instellingen → AI**
(`MCP_SERVER_URL` in `src/lib/mcp-api.ts`). De rest gaat vanzelf: de AI-client
leest de `WWW-Authenticate`-header, vindt de autorisatieserver, registreert
zichzelf en stuurt de klant naar het toestemmingsscherm.

**Claude** (web, desktop, telefoon) — Customize → Connectors → + → Add custom
connector → URL plakken → Add → Connect. Bij Claude Team/Enterprise zet een owner
hem eerst klaar onder Organization settings → Connectors.
**Claude Code** — `claude mcp add --transport http resofly <URL>`, daarna `/mcp`
→ resofly → Authenticate.
**ChatGPT** — Developer mode aan, nieuwe app met de URL, OAuth als aanmelding.

### Discovery op supabase.co: waarom er een OpenID-vorm is

Een client zoekt de metadata van een issuer mét pad eerst op de root van het
domein (`/.well-known/oauth-authorization-server/functions/v1/mcp-oauth`). Die
root is op supabase.co niet van ons; Supabase geeft daar een 401. Het enige
adres dat hij daarna nog probeert en dat wij beantwoorden, is
`…/mcp-oauth/.well-known/openid-configuration` — en dat leest hij als
OpenID-document. Zonder `jwks_uri`, `subject_types_supported` en
`id_token_signing_alg_values_supported` keurt de officiële SDK het af en stopt
het koppelen vóór het inloggen. Die velden staan er daarom in (de sleutelset is
leeg; we geven geen ID-tokens uit). `mcpAuth.test.ts` bewaakt dat.

**Scopes.** Noemt de 401 geen scope, dan vraagt Claude precies de
`scopes_supported` uit het resource-document. Staat `propose` daar niet in, dan
kan niemand via zijn AI iets klaarzetten — ook dat staat in een test.

**Claude Code** kiest per koppeling een nieuwe vrije poort op 127.0.0.1. Bij een
loopback-adres mag daarom alleen de poort afwijken van de registratie (RFC 8252
§7.3); pad, query en host blijven een exacte vergelijking.

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

## Toezicht: wie heeft wat gekoppeld

Een koppeling is persoonlijk, maar de organisatie is van de owner. Onder
**Instellingen → AI** ziet een owner of admin daarom twee lijsten: *mijn
koppelingen* en *koppelingen van het team* — alles wat collega's aan deze
organisatie hebben gehangen, met wie het is en of het meeleest of ook klaarzet.
Elke koppeling is daar te stoppen, ook die van iemand die uit dienst is.

Stoppen is definitief en werkt meteen: de tokens gaan mee, en wat die koppeling
nog had klaarstaan wordt geannuleerd. Een databasetrigger houdt de rest dicht —
vanuit de app is aan een koppeling van een ander niets te veranderen dan
intrekken en hernoemen, ook niet door een admin.

**Verruimen kan alleen de eigenaar zelf.** De schakelaars voor rechtstreeks
uitvoeren staan daarom alleen bij *mijn koppelingen*. Een owner die de koppeling
van een collega ziet, kan hem stoppen — dat is toezicht — maar hem niet méér laten
doen: dat zou namens die collega een keuze maken die diens rechten gebruikt. De
trigger weigert het ook als iemand het buiten het scherm om probeert, en toetst
daarbij drie dingen: alleen de eigenaar, binnen `scope_ceiling` (wat de AI-client
bij het koppelen vroeg), en geen losse treden — `execute_high` bestaat niet zonder
`execute`, en niets bestaat zonder `read`.

## De melding

Zet een gekoppelde AI iets klaar, dan krijgt de eigenaar van die koppeling een
push: *"Claude op mijn laptop heeft iets klaargezet — herinnering aan Jansen"*.
Eén tik en hij staat op zijn wachtrij. Uit te zetten onder **Instellingen →
Meldingen** (*Je gekoppelde AI zet iets klaar*).

Voert die AI iets **rechtstreeks** uit, dan komt diezelfde melding — met "heeft
iets uitgevoerd" erin. Daar valt niets meer te keuren, en dat is precies waarom
hij er hoort te zijn: het is het enige moment waarop de gebruiker ziet dat er iets
in zijn administratie is gewijzigd terwijl hij ergens anders mee bezig was.

Alleen de eigenaar, niet het team. De andere meldingen (nieuw ticket, klantmail)
gaan wél naar iedereen, maar die gaan over iets wat van buiten komt. Dit gaat
over iets wat de gebruiker zelf net in gang zette; zou het hele team een ping
krijgen bij elke vraag die iemand aan zijn AI stelt, dan zet iedereen het na een
week uit. De wachtrij op het startscherm blijft van het team.

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

**Het toestemmingsscherm zegt "Koppelen lukt niet — Failed to fetch".** Dat is
geen antwoord van ons: de browser heeft het verzoek nooit verstuurd. Twee
oorzaken, en ze zijn uit elkaar te houden met het netwerktabblad van de browser
(zie je daar een `OPTIONS` met een rode `consent` of `approve` eronder, dan is
het de tweede).

1. *De edge functions staan er nog niet.* De frontend gaat via Cloudflare Pages
   sneller live dan `supabase functions deploy`. Rol `mcp-oauth` uit en probeer
   opnieuw.
2. *De origin van de app staat niet op de lijst.* Alleen `/approve` heeft een
   origin-controle — de open paden niet. Zet in de secrets van deze omgeving
   `APP_PUBLIC_URL` (of `GERRIE_ALLOWED_ORIGINS`) op **exact** de origin waarmee
   de klant de app opent, zonder slash aan het eind:

   ```bash
   supabase secrets set APP_PUBLIC_URL="https://staging.resofly.com"
   # of, staan er meer:
   supabase secrets set GERRIE_ALLOWED_ORIGINS="https://staging.resofly.com,https://app.resofly.nl"
   ```

   Opent de klant de app op `www.` of op het `*.pages.dev`-adres, dan is dat een
   ándere origin en hoort hij er los bij. Klopt dit niet, dan blijft het
   toestemmingsscherm gewoon staan en gaat pas de knop **Koppelen** stuk.

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

**Meer rechtstreekse uitvoerders.** Er zijn er nu 36 van de 188
schrijf-handelingen. Elke handeling waarvan de browser-uitvoerder één org-scoped
insert of update is, kan erbij in `apply.ts`; wat mail verstuurt, een PDF rendert
of bestanden aanraakt hoort er bewust niet bij te komen.

**Bronnen per klant.** Nu zijn er sjablonen voor een project en een factuur. Een
klantdossier als bron zou logisch zijn, maar daar is nog geen lees-handeling voor
die het hele dossier in één keer geeft.

**gerrieCore in de CI-typecheck.** Sinds de connector Gerrie's kerntools aanbiedt,
importeert `supabase/functions/mcp/index.ts` ook `_shared/gerrieCore.ts` — en
daarmee loopt dat bestand voor het eerst mee in `deno check`. Dat is winst (het
werd nergens getypecheckt), maar het betekent ook dat een typefout in gerrieCore nu
de MCP-check rood maakt in plaats van de gerrie-agent-deploy. Overweeg
`supabase/functions/gerrie-agent/index.ts` aan dezelfde CI-stap toe te voegen, dan
staat die dekking er expliciet in plaats van als bijvangst.
