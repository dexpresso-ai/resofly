# Rapportages met Gerrie: elke vraag een eigen, actuele pagina (2026-11-09)

De business intelligence van ResoFly was een vaste rapportbouwer: één bron, één meetwaarde,
één grafiek. Nu vraag je Gerrie in gewone taal om een overzicht ("omzet per maand dit jaar,
naast vorig jaar, met de vijf grootste klanten"), en wordt elke vraag een eigen pagina in de
stijl van ResoFly. Alleen jij ziet je rapportages. Aanpassen gaat via de chat; verwijderen met
één knop. De pagina haalt bij elke keer openen de actuele cijfers op. Dat kost geen AI-tegoed;
een vraag of aanpassing aan Gerrie wel, en dat staat er per beurt bij.

## Wat er nu kan

- **Rapportages** (menu: Kennis & inzicht → Rapportages, voorheen Statistieken). Bovenaan een
  vraagveld met voorbeeldvragen en de tegoed-balk; daaronder je eigen rapportages. De
  rapportbouwer van voorheen staat op het tweede tabblad: vastgezette dashboardrapporten en de
  rapportages die Gerrie in de gewone chat klaarzet, openen daar zoals altijd.
- **Een vraag wordt een pagina.** Gerrie kijkt welke gegevens nodig zijn, haalt ze op en schrijft
  een HTML-pagina met kerncijfers, grafieken (lijn, staaf, liggende staaf, donut), tabellen,
  voortgangsbalken en tabbladen. De pagina opent meteen: je ziet waar Gerrie mee bezig is en kunt
  intussen verder werken.
- **Elke rapportage is een eigen pagina** met een eigen tabblad, kruimelpad en een plek in het
  menu onder Rapportages (de zes nieuwste).
- **Aanpassen via de chat** naast de pagina ("zet er vorig jaar naast", "alleen de top 10"). Op
  telefoon en tablet opent de chat als paneel (knop Gerrie). Kleine wijzigingen stuurt Gerrie als
  zoek/vervang in plaats van de hele pagina opnieuw: dat scheelt tegoed.
- **Versies.** Elke wijziging is een nieuwe versie. Je kunt een oude versie bekijken en
  terugzetten; dat wordt dan de nieuwste versie, zodat ook de weggezette bewaard blijft. De laatste
  vijftig per rapportage blijven bewaard.
- **Verversen, hernoemen, verwijderen** met de knoppen bovenaan. Bij "Bronnen" staat waar elk
  cijfer vandaan komt, hoeveel regels het waren, of er iets is afgekapt, en een CSV per bron.
- **Dynamisch.** De pagina bewaart geen cijfers, maar de vragen (datasets) die hij nodig heeft.
  Periodes lopen mee: Gerrie schrijft `{{begin_jaar}}` of `{{maanden_terug:11}}` in plaats van een
  vaste datum, dus "dit jaar" is in januari het nieuwe jaar.
- **AI-tegoed.** Vragen en aanpassen gaan via het maandtegoed (`ai_usage`, dezelfde regel als
  Gerrie, agents en notulen). Per antwoord staat erbij wat het kostte ("≈ 0,6% van je
  AI-tegoed"). Is het tegoed op, dan wordt er geen rapportage aangemaakt en Claude niet
  aangeroepen; openen en verversen blijven werken. Verwijderen maakt geen tegoed vrij.
- **De gewone Gerrie-chat** wijst op Rapportages als iemand meer wil dan één grafiek.

## Gerrie kan bij elk lees-endpoint

- **`query_records`** (nieuw, `_shared/reportRecords.ts`): de bron voor cijfers. Facturen,
  creditnota's, offertes, inkoopfacturen, klanten, projecten, taken, tickets, urenregistraties,
  boekingsregels, banktransacties, contracten en leveranciers. Groeperen (ook per dag, week,
  maand, kwartaal of jaar), optellen, gemiddelden, filters en lege perioden opvullen gebeurt op
  de server, in centen, met dezelfde bedragen als Financiën (`financeTotals`).
- **Alle lees-tools van Gerrie** (facturen, offertes, uren, agenda, contracten, bank, btw…) en
  **alle 81 lees-handelingen** uit de registry (winst en verlies, balans, proefbalans,
  grootboekkaart, openstaande posten, btw-aangifte, projectdashboard, DGA…).
- **Volledig.** Elke databasevraag geeft op staging hooguit duizend regels (PostgREST `max_rows`),
  en de lees-tools van de chat hooguit honderd. Een rapportage "omzet per maand" die daarop
  rekent, toont bij de 101e factuur stil een fout getal. `query_records` haalt in pagina's van
  duizend tot 20.000 regels op. In een rapportage geven de lijst-tools tot 1000 regels
  (`GerrieContext.maxRows`; de gewone chat blijft op 100). Wat er niet in past, heet in de
  gegevens `truncated` en staat bij Bronnen. Het wordt nooit stil weggelaten.

## Waarom zo, en wat het veilig houdt

- **Alleen van de maker.** Drie eigen tabellen (`ai_reports`, `ai_report_versions`,
  `ai_report_messages`) en niet de gesprekken van Gerrie: die mogen owners en admins lezen
  (toezicht). RLS: alleen `created_by = auth.uid()` met lidmaatschap, plus de module-poort van
  Statistieken. Een beheerder ziet andermans rapportages niet, ook niet via Gerrie: de functie
  controleert dat zelf ook.
- **De gebruiker mag weinig.** Hernoemen, een versie terugzetten en verwijderen gaan met de eigen
  sessie, op precies die kolommen (`grant update (title, summary, html, datasets,
  last_request)`). Het versienummer zet de database (trigger), niet de schrijver.
- **De AI voert niets uit.** In de rapportage-chat krijgt Gerrie alleen lees-endpoints. Een
  dataset die schrijft of verstuurt wordt geweigerd. Bij elke keer draaien worden de datasets
  opnieuw gecontroleerd met de rechten van wie de pagina opent: wie inmiddels minder mag, krijgt
  minder (getest: Financiën dicht → de omzetdatasets geven niets meer).
- **De pagina draait in een afgeschermd kader** (`public/rapport-weergave.html`):
  - `<iframe sandbox="allow-scripts">` zonder `allow-same-origin`, dus geen toegang tot de
    sessie, de opslag of de pagina eromheen. De test laat zien dat zelfs `localStorage`
    weigert;
  - een eigen CSP zonder netwerk (`default-src 'none'`, `connect-src 'none'`, alleen de
    lettertypen van ResoFly), en alleen de eigen app mag het inlijsten;
  - daarbovenop weigert de server HTML met externe scripts, afbeeldingen, links, fetch,
    opslag of navigatie, met een zin waarmee Gerrie het zelf herstelt.

  Zo kan ook een instructie die iemand in een klantnaam verstopt geen gegevens naar buiten krijgen.
- **Waarom een eigen pagina en geen `srcdoc`:** een srcdoc-kader erft de CSP van de app, en die
  staat geen inline scripts toe. Zonder script kan een pagina zijn cijfers niet zelf uitrekenen,
  en dan zou elke nieuwe factuur een herschrijving door Gerrie (tegoed) vragen. Het kader heeft
  daarom een eigen regel in `public/_headers` met `'unsafe-inline'` en zónder de hash van het
  thema-script (een hash schakelt `'unsafe-inline'` uit). `scripts/check-csp-hash.mjs` slaat die
  regel over voor de hash, en controleert juist dat het netwerk dicht is.
- **De look van ResoFly:** de app geeft zijn eigen kleurvariabelen en Dag/Nacht mee aan het kader,
  dus elke stijl (Baken, Cockpit, Zenit, Stroom) klopt vanzelf. De grafiekkleuren zijn
  gevalideerd op kleurenblindheid en contrast in licht en donker (ResoFly-goud voorop).

## Gevonden en opgelost tijdens het testen

1. **Datum-tokens werkten alleen in opgeslagen datasets.** Gerrie probeert bij het rondkijken
   precies de invoer die hij straks opslaat, met `{{begin_jaar}}`. Hij kreeg "from moet een datum
   zijn" terug op goede invoer. Nu worden de tokens ook bij het rondkijken ingevuld.
2. **Dubbel ophalen na het bouwen.** Gerrie geeft de gegevens mee met zijn antwoord, maar de pagina
   haalde ze daarna nog eens op als de chatsessie al was opgeruimd. Nu onthoudt de pagina dat ze
   er al zijn.
3. **Het submenu Rapportages klapte niet open** op een rapportage. Nu wel, met de actieve
   rapportage gemarkeerd.
4. **Een lijngrafiek met meer waarden dan labels** (vorig jaar twaalf maanden, dit jaar elf)
   tekende punten buiten de grafiek. Reeksen worden nu afgekapt op het aantal labels.

## Bestanden

| Bestand | Wat |
| --- | --- |
| `supabase/migrations/20261109230000_rapportages_gerrie.sql` | de drie tabellen, RLS (alleen de maker), module-poort Statistieken, versie-triggers, kolomrechten |
| `supabase/functions/_shared/reportRecords.ts` | `query_records`: dertien bronnen, paginering, groeperen en rekenen in centen |
| `supabase/functions/_shared/reportDatasets.ts` | datasets, meelopende datum-tokens, inkorten voor het model, plafond op de omvang |
| `supabase/functions/_shared/reportHtml.ts` | zoek/vervang-wijzigingen en de controle op externe bronnen |
| `supabase/functions/_shared/gerrieReports.ts` | de rapportage-chat (prompt, tools, opslaan, tegoed) en het ophalen zonder AI |
| `supabase/functions/gerrie-agent/index.ts` | acties `report_chat` (SSE) en `report_data`, achter Gerrie én Statistieken |
| `supabase/functions/_shared/gerrieCore.ts` | `maxRows` voor rapportages, `callAnthropicStream` met een hoger tokenplafond en voortgang, exports, één regel in de prompt |
| `public/rapport-weergave.html` | het kader: CSP, de bouwstenen (`window.RF`), opmaak in de stijl van ResoFly |
| `public/_headers`, `scripts/check-csp-hash.mjs` | de CSP van het kader en de controle erop |
| `src/features/Reports.tsx`, `src/features/AiReportPage.tsx` | het overzicht en de pagina per rapportage |
| `src/components/ReportFrame.tsx` | het kader in de app: thema, hoogte, alleen berichten van het eigen kader |
| `src/lib/aiReports.ts`, `src/lib/aiReportTitles.ts` | database, chat-sessies (lopen door bij navigeren), lijst voor menu en tabbladen |
| `src/styles/rapportages.css` | opmaak (`aire-*`) op de gedeelde variabelen |
| `src/main.tsx`, `Sidebar`, `ZenitNav`, `TabBar`, `BottomNav`, `breadcrumbs`, `permissions`, `workspaceTabs` | pagina `report` (module `stats`), menu, titels |

## Getest

- `npm run typecheck`, `npm run build` en `node scripts/check-csp-hash.mjs`: in orde. De
  CSP-controle meldt nu ook dat het kader geen netwerk heeft en alleen door de eigen app wordt
  ingelijst.
- `npm test`: 1399 tests, waarvan 22 nieuw:
  - `reportRecords.test.ts`: exacte omzet in centen, alleen de eigen organisatie, pagineren tot
    alles binnen is, melden als het plafond bereikt is, Financiën dicht, de Nederlandse
    kalenderdag, boekingsregels via de boeking, het nakijken van de vraag;
  - `reportDatasets.test.ts`: meelopende datums (ook rond de jaarwisseling en in een
    schrikkeljaar), datasets, inkorten voor het model, zoek/vervang, de HTML-controle;
  - `src/lib/reportFrame.test.ts`: de bouwstenen van het kader (opmaak, optellen in centen,
    perioden opvullen, groeperen) en dat het kader alleen `allow-scripts` krijgt.
- `deno check` op alle 35 functies uit de CI-lijst en de twee gedeelde modules. In de cloudsessie
  kon dat niet via esm.sh; daarom met een import map naar dezelfde npm-versies, zonder het
  lockbestand te wijzigen.
- De migratieketen vanaf nul (`supabase db reset`): 261 bestanden, 261 toegepast.
  `accountant_fence_gaps()` is leeg, `anon` heeft niets op de nieuwe tabellen, en de
  triggerfuncties zijn niet los aan te roepen.
- RLS rechtstreeks in de database: de maker ziet en beheert zijn rapportage. Collega's, de eigenaar
  en de beheerder van de organisatie, een andere organisatie en een teamlid zonder Statistieken
  zien niets en kunnen niets wijzigen of verwijderen. Het versienummer en de maker zijn niet te
  wijzigen. Verwijderen ruimt versies en gesprek op.
- **Stromentest `rapportages`** (`tests/stromen/rapportages.mjs`): de echte gerrie-agent tegen de
  lokale stack, met een streamende nep-Claude die tools aanroept zoals Gerrie. 17 stappen, alle
  groen:
  - de pagina ontstaat met alleen lees-endpoints;
  - exacte omzet: concepten en geannuleerde facturen tellen niet, en de factuur van € 77.777 uit
    een andere organisatie ook niet;
  - versie, gesprek en verbruik in `ai_usage`;
  - verversen toont een nieuwe factuur zonder nieuw verbruik;
  - boekingsregels via de PostgREST-koppeling;
  - privacy tegenover eigenaar, beheerder, kijker en een andere organisatie, ook via Gerrie;
  - zoek/vervang;
  - een pagina met `fetch` wordt geweigerd en hersteld;
  - schrijf-tools en een dataset die verstuurt worden geweigerd, en er ontstaat geen factuur;
  - een versie terugzetten;
  - Financiën later dicht (datasets lezen niets, tools en bronnen vallen weg);
  - de boekhouder en een lid zonder Statistieken krijgen geen toegang;
  - tegoed op: geen rapportage en geen aanroep van Claude, verversen werkt wel;
  - verwijderen: het verbruik blijft.
- **UI-test `rapportage`** (`tests/stromen/ui.mjs`): in Chromium tegen dezelfde functie.
  - Vraag stellen op Rapportages. De pagina opent, het tabblad gaat van de tijdelijke sleutel naar
    het echte id, en het kader toont € 1.300,30 uit de echte database.
  - Verversen toont een nieuwe factuur zonder AI. Een aanpassing via de chat wordt versie 2.
  - Versie 1 bekijken en terugzetten wordt versie 3.
  - De rapportage staat in het menu. Verwijderen vraagt eerst bevestiging en noemt dat het
    tegoed niet terugkomt.

  Alle 102 stappen van de UI-test (ook de andere scenario's) zijn groen.
- De volledige stromentest: 913 stappen. Vijf stappen van `herinneringen` faalden rond
  middernacht: Nederland was al de 10e, UTC nog de 9e. Na middernacht UTC opnieuw gedraaid:
  66 van 66 groen. Dat staat los van deze wijziging.
- `npm run test:mobile -- --theme=both`: 440 metingen, 0 problemen. Nieuw gemeten zijn het
  overzicht, de rapportbouwer, een rapportage, en een rapportage met het gesprek open. De mock
  levert daarvoor een rapportage, een gesprek, versies en `report_data`. Het opstartscript van de
  test draait nu ook veilig in het afgeschermde kader: daar weigert zelfs `localStorage`, en dat
  is de bedoeling.
- `npm run test:loading` en `npm run test:inrichten`: alle controles geslaagd.
- Niet getest met het echte Claude-model: daar is in deze sessie geen sleutel voor. De nep-Claude
  bootst de stream en de tool-aanroepen precies na. Of Gerrie mooie pagina's maakt, blijkt op
  staging; de prompt beschrijft de bouwstenen met een voorbeeld.

## Om op te letten

- **Looptijd.** Een nieuwe rapportage kost Gerrie een paar rondes plus het schrijven van de pagina,
  meestal een tot twee minuten. De functie streamt, maar loopt tegen de tijdslimiet van Supabase
  Edge Functions als het langer duurt. Dan blijft de vorige versie staan en zegt de chat dat de
  verbinding wegviel.
- **Heel grote administraties.** Boven 20.000 regels per vraag meldt de rapportage dat er is
  afgekapt. Een kortere periode of een strenger filter helpt.
