# Een menu in plaats van een leeg tekstvak

**17 september 2026 · fase C · volgt op [CHANGELOG_MCP_PROPOSE_2026-09-17.md](CHANGELOG_MCP_PROPOSE_2026-09-17.md)**

Fase A en B gaven de gekoppelde AI van een klant toegang tot zijn administratie: meelezen, en wijzigingen klaarzetten. Wat er niet bij zat was een antwoord op de vraag die iedereen stelt nadat hij gekoppeld heeft: *en wat kan ik hier nu mee?* Een leeg tekstvak met tweehonderdvierenzestig onzichtbare mogelijkheden erachter levert in de praktijk "hoeveel facturen staan er open?" op, en daarna niets meer.

MCP kent daar twee dingen voor die we tot nu toe met een lege lijst beantwoordden. Tools kiest het model; deze twee kiest een **mens**, in zijn eigen AI-app.

## Standaardvragen

Vijf opdrachten die deze koppeling goed aankan, als menu:

| Vraag | Wat het doet |
|---|---|
| Weekoverzicht | Wat er deze week speelt, eindigend op hoogstens drie dingen die vandaag aandacht nodig hebben |
| Klant doorlichten | Dossier, mail, projecten en financiën van één klant (naam als invulveld) |
| Openstaande facturen nalopen | Op volgorde van hoe lang ze te laat zijn, met wat de volgende stap zou zijn |
| Notulen opvolgen | Actiepunten uit recente gesprekken, en welke daarvan nergens als taak staan |
| Mijn dag voorbereiden | De agenda van vandaag, met per klantafspraak wat er speelt |

De opdracht eronder is geschreven voor een model dat onze app níét kent: zoek eerst met `find_actions`, gebruik de exacte id's, verzin geen bedragen of namen. Dat laatste is geen wantrouwen maar ervaring — een model dat zelf een factuurnummer invult, doet dat overtuigend.

Een vraag verschijnt alleen als **alle** modules die hij aanraakt open staan, niet één ervan. Een dagvoorbereiding die de agenda wél en de klanten niet mag inzien, geeft een half antwoord waarvan de gebruiker niet ziet dat het half is; dat is erger dan de vraag niet aanbieden.

## Bronnen

Dingen die je aanhecht vóórdat je iets vraagt — "neem mijn postvak erbij" — zonder id's over te tikken. Zes vaste (postvak, recente klantmail, de planning van deze week, openstaande posten, recente notulen, en een samenvatting van de werkruimte) en twee met een veld erin: `resofly://project/{project_id}` en `resofly://factuur/{invoice_id}`.

Bewust kort gehouden. Een lijst van dertig bronnen is voor een mens net zo onbruikbaar als tweehonderd tools voor een model: hij scrolt, ziet het verschil niet, en pakt de bovenste.

## Geen tweede weg naar de gegevens

Allebei lopen ze over dezelfde rails als `run_action`: een lees-handeling uit de registry, org-scoped, achter het modulerecht van dat teamlid. Er komt dus geen nieuw pad naar de database bij — alleen een tweede manier om het bestaande aan te roepen.

Dat betekent ook dat de controle aan beide kanten hetzelfde is. Wie Financiën niet mag zien, krijgt *facturen nalopen* niet in zijn menu én kan `resofly://openstaande-posten` niet ophalen. Een lijst die iets toont wat je niet kunt ophalen is verwarrend; een lijst die iets verbergt wat je wél kunt ophalen is een lek. Elke ophaalactie komt net als een `run_action` in `ai_action_audit`.

Eén ordening die er toe doet: `resources/read` zoekt eerst uit wélke bron dit is, controleert dan het modulerecht, en raakt pas daarna de database. Andersom zou een geweigerd verzoek alsnog een query hebben gedraaid — precies het verschil in reactietijd waaraan je van buitenaf kunt aflezen of iets bestaat.

## Wat de test bewaakt

Een bron is een naam die naar een handeling wijst. Wordt die handeling hernoemd of naar een andere module verhuisd, dan blijft de bron er keurig staan en breekt hij pas als een klant hem aanklikt — in zíjn AI-app, waar wij het niet zien gebeuren.

`mcpCatalog.test.ts` (14 tests) faalt daarom op: een bron die naar een niet-bestaande handeling wijst, een bron die naar een *schrijf*-handeling wijst, een bron waarvan de module niet klopt met die van zijn handeling, een vaste bron die verplichte invoer niet meelevert, een URI-sjabloon dat een ander veld invult dan de handeling verlangt, dubbele namen of adressen, en een standaardvraag die het model niet naar de registry stuurt.

Ook van de verkeerde kant nagelopen: alle vier de manieren om de catalogus te laten afwijken worden betrapt. Bij de eerste poging leek er een gat te zitten in twee controles; dat bleek mijn proef die een doc-comment raakte in plaats van de definitie. Met een proef die faalt als hij zijn eigen zoektekst niet vindt, komt er geen valse geruststelling meer uit.

Verder: `matchTemplate` is apart getest op alles wat er níét op een sjabloon mag passen — een leeg veld, een tweede padsegment, een ander sjabloon, een adres van een heel ander domein.

## Wat er níét in zit

| Niet gebouwd | Waarom |
|---|---|
| Een klantdossier als bron | Er is geen lees-handeling die het hele dossier in één keer geeft; dat zou er eerst moeten komen. |
| Abonneren op bronwijzigingen | `resources/subscribe` geeft een lege bevestiging. Wij duwen niets uit onszelf. |
| Melding bij een nieuw AI-voorstel | De push-infrastructuur ligt er (`decision_digest`); een variant hiervoor is een losse toevoeging. |

Nagemeten: `npm test` 205 tests groen (191 + 14 nieuwe), `npm run typecheck` en `npm run build` groen. De edge functions zijn met `tsc --noResolve` gecontroleerd. *Naschrift:* `deno check` is later alsnog gedraaid en is groen; sindsdien bewaakt CI het.
