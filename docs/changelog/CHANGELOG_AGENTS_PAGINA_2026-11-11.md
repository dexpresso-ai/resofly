# Agents van Gerrie: je ziet ze werken, je bouwt ze in een gesprek (2026-11-11)

De pagina Gerrie → Agents is opnieuw opgezet. Je ziet nu wanneer een agent aan het
werk is en wat hij op dat moment doet. Agents maak je en pas je aan in een gesprek
met Gerrie. De emblemen hebben een nieuw, rustiger ontwerp, en de pagina zegt meer
zonder dat je hoeft te klikken.

## Wat er nu te zien is

### Een agent aan het werk
- **Op de kaart** loopt een komeet van poollicht om de rand, en staat wat hij nu
  doet ("Tickets bekijken — 6 gevonden"), met een klok en vier streepjes voor de
  stappen.
- **In het detail** staat de werkbank. Links liggen de gegevens waar hij in kijkt,
  in het midden de agent met een draaiende ring, rechts wat hij oplevert. Wat er
  beweegt, volgt de stap:
  - opstarten;
  - gegevens bekijken: de bron die hij gebruikt licht op, en de lijn naar de
    agent loopt;
  - uitwerken: de uitkomsten schuiven erin;
  - afronden: de uitkomsten krijgen een vinkje.

  Eronder staan de stappenbalk, de klok en elke stap uit het logboek zodra hij
  gebeurt.
- Dat geldt voor **elke run**, ook een die volgens schema of door een
  gebeurtenis start terwijl je kijkt. "Nu draaien" kan nu ook vanaf de kaart.

### Agents bouwen en aanpassen in een gesprek
- **Bovenaan de pagina** vraag je het Gerrie: "Wat moet er vanzelf gebeuren?".
  Versturen opent het gesprek met die vraag erin. Daaronder staan "Gesprek
  beginnen" en "Zelf invullen" (het formulier).
- **In het gesprek** staat links de chat. Rechts zie je de agent ontstaan:
  - eerst een blauwdruk;
  - terwijl Gerrie nadenkt, een agent die in elkaar wordt gezet;
  - daarna de echte agent, met wanneer hij draait, waar hij in kijkt en wat hij
    mag klaarzetten.

  Proefdraaien en aanmaken kan daar meteen.
- **Aanpassen met Gerrie** bij een bestaande agent: zeg in gewone taal wat er
  anders moet ("laat hem elke maand draaien"). Wat er verandert, staat erbij als
  *gewijzigd*. Opslaan werkt de agent bij; bezorging, delen en model blijven
  zoals ze waren.
- **Startpunten** (Ochtendbriefing, Ticketwacht, …) openen in hetzelfde gesprek,
  al ingevuld. Aanmaken kan direct, en bijsturen in gewone taal ook. Tot je iets
  vraagt, kost dat geen AI-tegoed.

### Het overzicht
- **Kaarten** in plaats van tegels. Op elke kaart staat:
  - of hij aan staat;
  - wanneer hij draait;
  - of hij kijkt of klaarzet;
  - wat hij de vorige keer vond ("gisteren 08:00 · Vier facturen staan langer
    dan 30 dagen open…");
  - wat er op je wacht.
- **Een regel met de stand van zaken**: aan het werk, actief, gepauzeerd,
  concept, en "N wachten op jouw akkoord", met een knop daarheen.
- **Eén agent open**: links de lijst, rechts het detail. Voorheen klapte het
  detail ónder de hele galerij open. Op een smal scherm zie je alleen het detail,
  met "Alle agents" erboven. Het detail zelf:
  - de laatste uitkomst bovenaan;
  - daaronder hoe hij werkt (kijkt in, mag klaarzetten, bezorging, deze maand,
    model, rechten) en zijn opdracht;
  - onderaan de geschiedenis.

  Minder gebruikte knoppen staan onder "Meer": formulier, delen, kopie,
  archiveren.
- **Telefoon**: de vier tabbladen van het commandocentrum staan als vier vakken
  naast elkaar. Voorheen was het een veegrij waarin "Beslissingen" van het scherm
  viel.

### Moderne emblemen
- Een rustige tegel met een dun randje van poollicht, en het icoon met een
  kleurverloop in de lijn. Voorheen was het een glimmende regenboogtegel.
- Een statusstip in de hoek: groen is actief, oranje gepauzeerd, een open rondje
  een concept.
- Aan het werk: een draaiende ring met een kloppende gloed.
- Modernere iconen: onder meer een bonnetje met tekst, een headset voor tickets,
  een chip-brein en een chatrobot. De tabbladen van het commandocentrum kregen
  ook nieuwe iconen.

## Hoe het werkt

- **Het logboek wordt live.** `runAgent` (`_shared/gerrieCore.ts`) heeft een
  `onStep`-haak. De runner schrijft daarmee elke stap meteen weg (`log.live`),
  bij een run en bij een antwoord op een run. Wegschrijven gaat in een rij achter
  elkaar aan; de agent wacht er niet op, de afsluitende flush wel. Voorheen kwamen
  alle stappen pas na afloop in één keer: een agent die een minuut werkte, leek
  die hele minuut niets te doen.
- **De app kijkt mee zolang de pagina in beeld is.**
  - `useAgentActivity` (`components/AgentWork.tsx`) leest de recente runs van alle
    agents in één vraag (`listRecentAgentRuns`): elke 15 seconden, en elke 3
    seconden als er iets loopt.
  - `useRunEvents` leest het logboek van een lopende run elke anderhalve seconde.
  - Een Gerrie-tabblad op de achtergrond vraagt niets.
  - Een run die langer dan een kwartier "loopt", is gestrand en telt niet als
    bezig (`lib/agentWork.ts`).
- **Aanpassen via de chat.**
  - De app stuurt de huidige agent mee (`design_agent`, veld `current`).
  - `agentForEditing` (`_shared/agentEditing.ts`) laat daarvan alleen door wat de
    bouwer nodig heeft, begrensd. Eigenaar, status en organisatie blijven buiten
    het gesprek.
  - De bouwer krijgt de agent als gegevens (`<gegevens bron="huidige_agent">`),
    niet als opdracht.
- **Opgelost**: een agent die Gerrie bouwde voor "zodra er een klantmail
  binnenkomt", werd zonder gebeurtenis opgeslagen (`trigger_events` ging niet
  mee) en startte dus nooit. Opslaan vanuit de chat gaat nu via één functie
  (`inputFromProposal`) die alles meeneemt.
- De stappenbalk en de klok delen de agents met de rapportages
  (`components/StepTrack.tsx`).
- De stijl staat in `src/styles/agents.css` (`agx-*`, `agw-*`). Het oude embleem,
  de tegels en het oude paneel zijn uit `globals.css`, `cockpit.css`, `zenit.css`
  en `stroom.css` gehaald (ruim 300 regels).

## Getest

- `npm run typecheck` en `npm test`: 1503 tests. Nieuw zijn
  `src/lib/agentWork.test.ts` (welke runs lopen, de stap, de live stappen, de
  laatste uitkomst) en `_shared/agentEditing.test.ts` (wat er bij de bouwer
  aankomt, en dat de runner live logt).
- `npm run test:stromen -- agents` (nieuw), tegen de echte runner en de echte
  bouwer:
  - de stappen staan op volgorde en één keer in het logboek;
  - de toolstap is weggeschreven vóór het antwoord. Met de oude runner faalt deze
    toets: beide kregen hetzelfde tijdstip;
  - bij aanpassen krijgt de bouwer de huidige agent als gegevens mee, zonder de
    eigenaar;
  - bij een nieuwe agent gaat er geen huidige agent mee.
- `npm run test:stromen -- rook rapportages`: groen.
- `npm run test:mobile -- --theme=both`, met twee nieuwe standen:
  - `gerrie-agent`: het detail van een agent die nu draait, met de werkbank;
  - `gerrie-bouwer`: het gesprek.

  De testdata (`tests/mobile/mock/seed.mjs`) heeft nu zeven agents, waarvan één
  op dit moment draait, één van een collega en één gearchiveerd. De mock geeft de
  toolcatalogus van de runner.
- Met een nagebootste bouwer zijn nagelopen, op laptop en telefoon, licht en
  donker, zonder JavaScript-fouten: nieuw bouwen, aanpassen, een startpunt en het
  formulier.
