# Klanten koppelen hun eigen AI aan hun werkruimte

**16 september 2026 · fase A (alleen lezen) · zie [MCP_CONNECTOR_SETUP.md](MCP_CONNECTOR_SETUP.md)**

Wie zelf al met Claude of ChatGPT werkt, kan die assistent vanaf nu op zijn eigen ResoFly-werkruimte laten meelezen. Hij plakt één URL in zijn AI-app, logt in, geeft akkoord — en stelt daarna vragen als "welke facturen staan er open?" of "wat heb ik deze week op Jansen geboekt?" aan de AI die hij toch al gebruikt. Het model draait op **zijn** abonnement; wij leveren alleen de gegevens. Het maandtegoed dat Gerrie begrenst, speelt hier dus geen rol.

## Geen nieuwe API-laag, maar de registry

De app kent 264 handelingen in `supabase/functions/_shared/actions/` — elk met een stabiel id, een JSON-schema voor de invoer, een omschrijving die voor een model geschreven is, en een uitvoerder die strikt org-scoped werkt. Dat ís de API-laag; er is er geen tweede bij gebouwd. De MCP-server beeldt hem af op drie tools.

Dat het er drie zijn en geen 264 is dezelfde afweging als bij Gerrie, en om dezelfde reden: een MCP-client zet de **hele** toollijst in de context van het model, bij elke beurt. Tweehonderd tooldefinities zijn tienduizenden tokens per verzoek voor een lijst die je meestal niet gebruikt, en een model dat uit tweehonderd tools kiest, kiest slechter dan een model dat er drie ziet en de rest kan opzoeken.

- `get_workspace` — welke organisatie, welke rol, welke onderdelen, welke datum vandaag.
- `find_actions` — zoek op de woorden van de gebruiker; geeft id's mét invoerschema terug.
- `run_action` — voer een leeshandeling uit.

## Koppelen: OAuth 2.1, want dit is voor klanten

Een AI-client van buiten krijgt geen Supabase-sessie. `mcp-oauth` is daarom een echte autorisatieserver: discovery-metadata, dynamische clientregistratie (RFC 7591 — verplicht, anders kan Claude.ai niet koppelen), `/authorize` met PKCE, een toestemmingsscherm in de app, `/token` met code-inruil en roterende refreshtokens, en `/revoke`.

Tussen "de client stuurt de gebruiker naar ons" en "de gebruiker geeft akkoord" zit een omweg langs login en organisatiekeuze. Wat de client meegaf reist mee als een **HMAC-ondertekend pakketje** met een kwartier houdbaarheid — hetzelfde patroon als de agenda-koppeling met Google en Microsoft. Geen tabel die volloopt met halve pogingen, en een gebruiker kan zijn eigen verzoek niet ombouwen naar een andere redirect-URI.

## Alleen lezen — en waarom dat de kern is, niet een beperking

Van de 264 handelingen zijn er 188 schrijf-handelingen. Die hebben op de server alleen een `plan()` die een *voorstel* bouwt; uitvoeren gebeurt in de browser nadat een mens akkoord gaf. Een MCP-server draait headless, dus daar kan schrijven sowieso niet rechtstreeks.

Maar ook als het kón, zou het hier niet gebeuren. Het model aan de andere kant is niet van ons. De weigering staat daarom niet als filter op de lijst maar als controle op de uitvoer: ook een id dat het model ergens anders vandaan haalt, loopt stuk op `action.kind !== 'read'`.

## Wat de grenzen bewaakt

- **Een koppeling is persoonlijk.** Eén rij in `mcp_grants` = één gebruiker, in één organisatie, voor één client. Een admin koppelt niet namens het team.
- **Rechten komen vers uit de database.** Bij elke aanroep opnieuw uit `organization_members`. Zet een owner een teamlid vandaag op viewer of doet hij Financiën dicht, dan geldt dat meteen — niet pas als het token over een uur verloopt. Wat iemand niet mag zien, komt niet eens terug uit `find_actions`.
- **Tokens staan niet leesbaar in de database.** `rsfmcp.<selector>.<verifier>`: de selector plat om de rij te vinden, van de verifier alleen een gesalte SHA-256.
- **Intrekken werkt meteen.** De knop zet `revoked_at` op de grant; een databasetrigger trekt de tokens mee in. Zou dat niet gebeuren, dan bleef een access token nog een uur werken — precies het uur waarin iemand op die knop drukt omdat er iets mis is.
- **Alles wat opgevraagd wordt, komt in `ai_action_audit`**, met de naam van de AI-client erbij. Bij Gerrie loggen we alleen wat er gebeurt; hier ook wat er gelezen wordt, want dit is een deur naar buiten.
- **Een hergebruikte autorisatiecode trekt de hele koppeling in.** Dat is óf een dubbele poging óf iemand die hem onderweg opving, en die twee zijn niet te onderscheiden.

## Wat de gebruiker ziet

- **Toestemmingsscherm** op `/mcp/authorize`: wie het vraagt, welke organisatie, en drie feiten — mag meelezen, kan niets wijzigen, altijd in te trekken. Weigeren staat er even groot naast als koppelen; een toestemmingsscherm waarop "nee" moeilijker klikt dan "ja" is er geen.
- **Instellingen → AI**: het tabblad heet niet meer "AI-gebruik" maar "AI", en staat nu voor **ieder teamlid** open met daarin zijn eigen koppelingen. Het verbruikscijfer van Gerrie eronder blijft owner/admin. Je koppelt persoonlijk, met je eigen rechten, dus je hoort ook zelf te kunnen loskoppelen.
- **De magic link komt terug op het toestemmingsscherm** in plaats van op het dashboard. Wie niet ingelogd was als zijn AI hem doorstuurde, raakte anders zijn koppelverzoek kwijt zonder uitleg.

## Wat de tests bewaken

`mcpAuth.test.ts` — 25 tests op de rekensommen waar dit op rust, elk óók van de verkeerde kant getest: een token met de verkeerde verifier of onder een andere salt, een PKCE-paar dat niet bij elkaar hoort, de challenge onversleuteld meesturen, een redirect-URI die met `../`, een query of een lookalike-domein "ongeveer" lijkt te matchen, een ondertekend verzoek waarin de redirect-URI is omgedraaid, en een verzoek dat verlopen of te lang geldig is. Plus dat fase A alleen `read` uitgeeft, ook als er `propose` gevraagd wordt.

## Wat er níét in zit

| Niet gebouwd | Waarom |
|---|---|
| Schrijven vanuit de gekoppelde AI | Fase B: als voorstel op de beslislijst, waar een mens het goedkeurt. De scope `propose` staat klaar maar wordt niet uitgegeven. |
| MCP-resources en -prompts | De server geeft er een lege lijst voor terug. Later. |
| Een eigen domein vóór de connector | Werkt met de Supabase-URL; `MCP_PUBLIC_BASE_URL` ligt klaar voor wie het netter wil. |
| Koppelingen van collega's inzien | RLS geeft alleen je eigen rijen. Een organisatiebreed overzicht is een aparte vraag. |

Nagemeten: `npm test` 169 tests groen (144 + 25 nieuwe), `npm run typecheck` groen, `npm run build` groen. De twee edge functions zijn met `tsc --noResolve` op type- en syntaxfouten gecontroleerd. *Naschrift:* `deno check` is later alsnog gedraaid (Deno 2.9.6 via npm, `@supabase/supabase-js@2.45.0` van het npm-register omdat esm.sh hier geblokkeerd is) en is groen; sindsdien bewaakt CI het.
