# De gekoppelde AI kan nu alles wat Gerrie kan

**17 september 2026 · volgt op [CHANGELOG_MCP_PROPOSE_2026-09-17.md](CHANGELOG_MCP_PROPOSE_2026-09-17.md)**

In de opzet van de connector stond: *wat een gekoppelde AI kan, kan Gerrie ook — en omgekeerd.* De eerste helft klopte. De tweede niet.

De app heeft twee lijsten met dingen die hij kan. De **handelingenregistry** (`_shared/actions/`) is de lange staart: galerijen publiceren, grootboekkaarten, aangiftes, 264 handelingen. Gerrie's **kerntools** (`TOOL_DEFINITIONS` in `gerrieCore.ts`) zijn de kop: een factuur opstellen, reageren op een ticket, een mail aan een klant. In de chat heeft Gerrie allebei — de tools staan in zijn toollijst, de staart zoekt hij erbij. De connector kreeg alleen de staart.

Dat was een stille fout, en je zag hem terug in de registry zelf. Bij `ticket.mark_read` staat letterlijk: *"dit markeert alleen als gelezen, het beantwoordt niets — reageren doe je met `propose_ticket_note`"*. Die tool bestond aan de MCP-kant niet. Het model zoekt ernaar, vindt niets, en vertelt de gebruiker dat het niet kan — terwijl Gerrie het in hetzelfde scherm gewoon doet. In totaal wezen de omschrijvingen **54 keer** een tool aan die via de MCP onbereikbaar was.

## Wat er nu gebeurt

`find_actions` doorzoekt beide lijsten, in één uitslag. `run_action` en `propose_action` voeren uit beide uit. Daarmee komen er **65 kerntools** bij: 27 om te lezen (`list_tickets`, `search_clients`, `list_invoices`, …) en 38 om klaar te zetten (`propose_ticket_note`, `propose_send_client_email`, `propose_invoice`, …).

De vraag waar dit mee begon — *kan mijn AI ook een ticket beantwoorden of een mail terugsturen?* — is daarmee ja. Een reactie op een ticket gaat via `propose_ticket_note`, met `is_internal: false` staat hij in het klantportaal; een vrij geformuleerde mail via `propose_send_client_email`. Allebei nog steeds als voorstel: het model schrijft de tekst, de gebruiker leest hem en klikt.

## Geen tweede weg naar de gegevens

Wat hier bijkomt is een **beschrijving**, geen implementatie. `GERRIE_CORE_ACTIONS` leidt uit `TOOL_DEFINITIONS` een lijst `ActionDef`s af — id, label, module, invoerschema — zodat de zoektool ze kan vinden. Het uitvoeren loopt langs exact dezelfde `runGerrieTool` en `buildProposal` als de chat en de geplande agents, mét de rol- en modulecontrole die daarin zit. Er is dus geen pad bijgekomen; er is een manier bijgekomen om het bestaande pad te vínden.

Dat geldt ook voor de andere kant. Een kerntool levert een voorstel op in Gerrie's eigen vorm (`ticket_note`, `send_client_email`, `invoice`) in plaats van de generieke `action`-vorm. De goedkeurwachtrij verwerkte dat al: die leest `params` uit `ai_action_audit` en voert uit via dezelfde `executeProposal` als bij een geplande agent. Aan de browserkant hoefde niets bij — geen nieuw voorsteltype, geen nieuwe kaart, geen nieuwe uitvoerder.

De drie sloten uit fase B blijven staan:

1. `organization_id` komt uit de koppeling. `buildProposal` krijgt een `GerrieContext` die hier wordt opgebouwd; het model kan er geen organisatie in meesturen.
2. Elke query is org-scoped, want het is dezelfde code die Gerrie draait.
3. Uitvoeren gebeurt in de browser, onder de sessie van wie akkoord geeft, waar RLS geldt.

En de scope van de koppeling gaat er nog steeds vóór: een koppeling die alleen mag meelezen krijgt `propose_action` niet in zijn toollijst, en de schrijfkerntools dus ook niet.

## Wat een gekoppelde AI bewust niet krijgt

- **`propose_create_agent`** — een agent bouwen die daarna vanzelf draait en zelf dingen mag klaarzetten. Een geplande agent mag dat van zichzelf ook niet (`AGENT_FORBIDDEN_TOOLS`); een koppeling van buiten hoort niet ruimer te zijn dan iets wat binnen draait.
- **`ask_user`, `emit_plan`, `emit_agent`** — die horen bij de chatstroom op het scherm en betekenen niets aan de andere kant van een JSON-RPC-verbinding.
- **`find_actions`, `run_action`, `propose_action`** — dat zijn de MCP-tools zelf; als handeling aanbieden zou het model zichzelf laten aanroepen.

## De pushmelding zei niet meer waarvoor je kwam

`push_on_mcp_proposal` haalt de tekst van de melding uit `params->>'title'`. Dat veld hoort bij de registry-vorm `{type:'action', title, sub, payload}`. Een voorstel in Gerrie's eigen vorm heeft het niet — de goedkeurwachtrij maakt die kaart zelf uit de velden die er wél zijn.

Zonder ingreep viel de melding dus terug op *"Een voorstel wacht op je akkoord"*, en juist bij de voorstellen die het meest naar buiten gericht zijn: een mail aan een klant, een reactie in het klantportaal. Je zag niet meer waarvoor je je telefoon uit je zak haalde.

De edge function schrijft die ene regel nu mee in `result->>'title'` en de trigger valt daarop terug (migratie `20260917030000`). Bewust in `result` en niet in `params`: `params` **is** het voorstel dat de browser straks uitvoert, en een extra sleutel daarin zou een veld zijn dat nergens bij hoort. `result` gaat over de rij — de naam van de koppeling en de client-id staan er al in.

## Zoeken over twee lijsten

`searchActions` weegt een zoekwoord naar hoe zeldzaam het is: hoe minder handelingen een woord raakt, hoe zwaarder het telt. Dat gewicht is alleen te bepalen bínnen één verzameling, dus twee keer los zoeken en de uitslagen aan elkaar plakken kan niet — scores uit de ene lijst zijn dan niet te vergelijken met die uit de andere. De kerntools gaan daarom als `extra` mee de pool in vóórdat er gewogen wordt.

Gerrie's eigen `find_actions` geeft die `extra` **niet** mee. Daar zijn de kerntools al gewone tools; ze er ook nog eens in laten opduiken zou het model tussen twee wegen naar hetzelfde laten kiezen. Een test bewaakt dat.

## Getest

`mcpParity.test.ts`, zes tests:

- **Elke tool waar een omschrijving naar verwijst, is via de MCP te bereiken.** 158 verwijzingen tussen backticks, nu allemaal raak. Dit is de regressietest op de fout hierboven: wie een nieuwe kerntool op de verbergenlijst zet terwijl de registry ernaar verwijst, loopt erop stuk.
- De kerntools die het meest gemist werden (`propose_ticket_note`, `propose_send_client_email`, `list_tickets`, `search_clients`) zijn bereikbaar.
- Wat een geplande agent niet krijgt, krijgt een koppeling ook niet.
- Elke aangeboden kerntool hangt aan een module, zodat modulerechten hem kunnen afschermen.
- Zes vragen zoals iemand ze stelt ("reageren op een ticket", "mailtje sturen naar een klant") vinden hun tool.
- Zonder `extra` komt er alleen registry terug.

Volledige suite: 224 tests groen. `deno check` op `mcp`, `mcp-oauth`, `gerrie-agent`, `gerrie-agent-runner` en `gerrie-signals` schoon.

## Eén ding om te weten

`supabase/functions/mcp/index.ts` importeert nu `_shared/gerrieCore.ts`. Daarmee loopt dat bestand voor het eerst mee in de CI-stap `deno check supabase/functions/mcp/index.ts` — het werd tot nu toe nergens getypecheckt, want de gerrie-functies staan niet in die stap. Dat is winst, maar het betekent ook dat een typefout in gerrieCore voortaan de MCP-check rood maakt. Overweeg `gerrie-agent/index.ts` aan diezelfde stap toe te voegen, dan staat die dekking er expliciet in plaats van als bijvangst.
