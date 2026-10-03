# Vulwoorden tellen niet meer mee bij het zoeken

**3 oktober 2026 · volgt op [CHANGELOG_MCP_TREFWOORDEN_2026-10-03.md](CHANGELOG_MCP_TREFWOORDEN_2026-10-03.md)**

`searchActions` telde elk woord uit de vraag, ook "een", "van" en "heeft". Dat zou niet uitmaken als die woorden nergens in stonden. Ze staan alleen overal in. "een" komt voor in 76 labels ("Reageren op een ticket"), "van" in 61 en "met" in 14. Handelingen met zo'n woord in hun label kregen daardoor een voorsprong die nergens op sloeg. Bij "notitie opslaan bij een project" stond `propose_note` op plek 11. Bij "wie heeft er een afspraak geboekt" stond `list_bookings` op plek 20.

Het model zoekt bovendien met de woorden van de gebruiker, zo vragen de MCP-instructies het, en daar zitten vulwoorden tussen. Om de 48 vaste zoekvragen van de registry zijn daarom twee vulzinnen gezet: "kun je … voor mij" en "ik wil graag dat je … als het kan". Van die 96 uitslagen verschoven er 89. Drie keer viel de juiste handeling daarbij uit de top 6.

## Wat er nu is

`STOPWORDS` in `actions/registry.ts` bevat lidwoorden, voorzetsels, voornaamwoorden, hulpwerkwoorden en vulwoorden. Een woord uit die lijst telt in een zoekvraag niet mee. Woorden korter dan drie tekens vielen al weg. Bestaat een vraag alleen uit stopwoorden, dan wordt er toch op die woorden gezocht. Anders blijft er geen zoekwoord over en komt er een willekeurige lijst terug. "wat zit erin" vindt zo nog steeds de inhoud van een galerij.

Dit geldt voor elke zoekopdracht: `find_actions` in de MCP, in de openbare API en bij Gerrie zelf.

## Bewust niet in de lijst

Een paar gewone woorden kiezen wélke handeling het is, en staan daarom met opzet in de trefwoorden:

- "niet", "geen" en "zonder". 'niet akkoord' betekent afwijzen. Met "niet" in de lijst zou "offerte niet akkoord" uitkomen bij goedkeuren.
- "uit". 'automatisch boeken uit' betekent een bankregel aanpassen. Met "uit" in de lijst zou die vraag een nieuwe bankregel opleveren.
- "nog" ('nog te betalen'), "weer" ('weer openen'), "alle" (alles in één keer) en "mijn" (de eigen afzender, het eigen lijstje).
- "wie", "hoeveel" en "wanneer", omdat ze vragen naar personen, aantallen of tijd. Ook "zelf" en "toch" blijven staan.

De eerste twee voorbeelden staan als test vast. Wie zo'n woord later aan de lijst toevoegt, ziet het meteen.

## Twee trefwoorden die moesten volgen

Zonder de vulwoorden bleef bij "welke facturen zijn nog niet betaald" voor `list_invoices` alleen "facturen" over. Dat woord raakt veel handelingen. De vraag zakte daardoor van plek 4 naar plek 12. `list_invoices` krijgt daarom het trefwoord "betaald".

Daarmee schoof `list_invoices` bij "factuur op betaald zetten" voor `invoice.set_status`. Het label daarvan begint met de samenstelling "Factuurstatus", hetzelfde probleem als bij de kerntools. Die handeling krijgt daarom 'factuur' en 'op betaald zetten'. Ze staat nu bovenaan.

## Gemeten

Gemeten zoals de MCP zoekt: registry en kerntools samen. Een vraag telt als gevonden als de juiste handeling bij de twaalf resultaten zit die `find_actions` teruggeeft.

| | Voor | Na |
|---|---|---|
| 180 vragen naar de kerntools, gevonden | 178 | 180 |
| … op plek 1 | 128 | 131 |
| Dezelfde vragen in een vulzin (540), gevonden | 525 | 538 |
| … op plek 1 | 349 | 382 |
| 60 andere formuleringen, op plek 1 | 42 | 45 |
| 48 registry-vragen, gevonden / op plek 1 | 48 / 37 | 48 / 37 |

## Getest

- `actionSearch.test.ts`, drie nieuwe tests:
  - Een vulzin van alleen stopwoorden ("kun je … voor mij", "ik wil graag dat je … als het kan") geeft precies dezelfde uitslag als de kale vraag. Zonder de lijst faalt dit bij 89 van de 96.
  - Een vraag van alleen stopwoorden zoekt toch.
  - "niet" en "uit" kiezen nog steeds de handeling.
- `mcpParity.test.ts`: twee zoekvragen erbij, "welke facturen zijn nog niet betaald" en "wie heeft er een afspraak geboekt".

De volledige suite is groen. `deno check` op `mcp`, `api`, `gerrie-agent` en `gerrie-agent-runner` is schoon. Die check is lokaal gedraaid met esm.sh omgeleid naar npm.

## Wat nog openstaat

De gebiedende wijs raakt het hele werkwoord niet. "maak" deelt te weinig letters met "maken", "stuur" met "sturen" en "plan" met "plannen". "maak een factuur voor jansen" vindt `propose_invoice` daardoor op plek 10, alleen via "factuur". Dat is geen stopwoordenkwestie. Het vraagt om het zoeken naar werkwoordsvormen, of om die vormen als trefwoord.

## Uitrollen

Deze wijziging zit in de edge functions `mcp`, `api`, `gerrie-agent`, `gerrie-agent-runner` en `gerrie-signals`. Er zijn geen migraties, secrets of cron-taken bij. Ze gaat mee met de gewone uitrol van staging, zie [SUPABASE_STAGING_LAPTOP.md](SUPABASE_STAGING_LAPTOP.md). Hoe je controleert dat het werkt, staat in [ZOEKEN_SETUP_2026-10-03.md](ZOEKEN_SETUP_2026-10-03.md).
