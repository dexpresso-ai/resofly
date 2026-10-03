# De kerntools zijn nu te vinden met gewone woorden

**3 oktober 2026 · volgt op [CHANGELOG_MCP_GERRIE_PARITEIT_2026-09-17.md](CHANGELOG_MCP_GERRIE_PARITEIT_2026-09-17.md)**

Sinds september biedt de MCP-connector Gerrie's kerntools aan: een factuur of offerte opstellen, reageren op een ticket, een mail aan een klant. Bereikbaar waren ze. Vindbaar niet altijd.

Een gekoppelde AI kent geen vaste toollijst. Hij zoekt met `find_actions` op de woorden van de gebruiker. Vraag je Claude "maak een factuur voor Jansen", dan zoekt hij op iets als "factuur maken". Dat leverde `propose_invoice` niet op, ook niet bij 25 resultaten. Bovenaan stonden een btw-suppletie en het koppelen van een factuur aan een project. Met "factuur opstellen", "offerte maken" en "nieuwe offerte voor een klant" ging het net zo. Alleen "conceptfactuur klaarzetten" werkte, en dat zijn precies de woorden van het label.

## Waarom

Drie dingen samen:

- Het label is één samengesteld woord: "Conceptfactuur klaarzetten", "Conceptofferte klaarzetten".
- Het zoeken vergelijkt op het begin van een woord (`hits()` in `actions/registry.ts`). "factuur" telt niet als treffer op "factuurformulier", want het is te kort ten opzichte van het hele woord. Op "conceptfactuur" telt het al helemaal niet.
- De handelingen in de registry hebben allemaal `keywords`, met de woorden die een gebruiker gebruikt. De 65 kerntools hadden er geen.

De test die dit had moeten vangen, zocht op "conceptfactuur klaarzetten". Dat zijn de woorden van het label zelf.

## Wat er nu is

`TOOL_KEYWORDS` in `gerrieCore.ts` geeft per kerntool de woorden die iemand gebruikt. `GERRIE_CORE_ACTIONS` geeft ze mee als `keywords`, zodat ze in de zoekindex even zwaar tellen als het label. Dat werkt voor `find_actions` in de MCP én in de openbare API. Gerrie's eigen `find_actions` zoekt de kerntools niet mee en merkt er dus niets van.

Bij het kiezen van de woorden gelden drie regels:

- het werkwoord dat erbij hoort ("maken", "opstellen", "sturen", "verzetten");
- het losse woord naast de samenstelling ("factuur" naast "conceptfactuur");
- een meervoud dat van de stam afwijkt. "taak" en "taken", of "afspraak" en "afspraken", delen te weinig letters om elkaar te raken.

"klaarzetten" staat er nergens in. Dat woord staat in elk label en zegt dus niets.

## Gemeten

Voor de meting zijn 180 vragen gebruikt zoals iemand ze stelt, verdeeld over alle 65 kerntools. Een vraag telt als gevonden als de juiste tool bij de twaalf resultaten zit die `find_actions` standaard teruggeeft.

| | Voor | Na |
|---|---|---|
| Gevonden | 115 van 180 | 178 van 180 |
| Op plek 1 | 45 | 128 |

Daarna volgde een tweede set van 60 andere formuleringen. Die is pas geschreven nadat de woorden gekozen waren, en leverde nog één trefwoord op ("reactie" bij offertes). Het aantal gevonden vragen ging van 36 naar 59 en het aantal op plek 1 van 12 naar 42.

In de eerste set missen er nog twee: "wie heeft er een afspraak geboekt" en "wie zitten er in het team". Woorden als "wie", "een" en "het" tellen bij het zoeken gewoon mee, waardoor handelingen met zo'n woord in hun label winnen. Dat los je niet op met trefwoorden, maar in het zoeken zelf, met een lijst stopwoorden. Die is er inmiddels: zie [CHANGELOG_ZOEKEN_STOPWOORDEN_2026-10-03.md](CHANGELOG_ZOEKEN_STOPWOORDEN_2026-10-03.md).

## De registry blijft vindbaar

Een trefwoord telt even zwaar als het label. Een kerntool met te ruime trefwoorden schuift zich dus vóór een handeling die beter past, en in de MCP zoeken beide lijsten samen. De trefwoorden zijn daarom smal gehouden. Een paar die voor de hand lagen zijn bewust weggelaten:

- "aanmaning" bij de herinneringen, want dat is `dunning.send`;
- "afletteren" bij de banktransacties, want dat is `bank_transaction.book`;
- "toevoegen" bij de inkoopfactuur, want die zou dan bij "leverancier toevoegen" winnen van `propose_supplier`;
- "deze week" bij de agenda, want die zou dan bij "uren deze week" winnen van de uren.

De 48 vragen uit `actionSearch.test.ts` vinden hun handeling met de kerntools erbij even goed als ervoor: alle 48 bij de eerste twaalf, 47 bij de eerste zes.

## Getest

`mcpParity.test.ts` telt nu acht tests:

- **Nieuw:** elke kerntool die de MCP aanbiedt heeft trefwoorden, en er staan geen trefwoorden voor tools die niet (meer) worden aangeboden.
- **Uitgebreid:** het aantal zoekvragen gaat van 6 naar 38. "conceptfactuur klaarzetten" is vervangen door "factuur maken". Met de oude `gerrieCore.ts` vinden 5 van de 38 hun tool.
- **Nieuw:** de vragen uit `actionSearch.test.ts` vinden hun handeling ook met de kerntools erbij. De test leest die vragen uit dat bestand, zodat er één lijst blijft.
- **Rechtgezet:** het label van `list_calendars` staat tussen dubbele aanhalingstekens ("Agenda's bekijken"). Dat las de test niet, waardoor hij voor die tool op de tool-naam zocht.

De volledige suite is groen. `deno check` op `mcp`, `api`, `gerrie-agent` en `gerrie-agent-runner` is schoon. Die check is lokaal gedraaid met esm.sh omgeleid naar npm, omdat esm.sh vanuit de bouwomgeving niet bereikbaar was. In CI draait hij gewoon.

## Eén ding om te weten

De trefwoorden zijn Nederlands. Een Engelse zoekvraag als "create invoice" vindt `propose_invoice` niet. "create" zit in de id van tientallen registry-handelingen, en die winnen. De MCP-instructies vragen het model om met de woorden van de gebruiker te zoeken, dus bij een Nederlandse gebruiker speelt dit niet. Wie de AI in het Engels aanspreekt, merkt het wel.
