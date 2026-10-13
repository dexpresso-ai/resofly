# Changelog — Berichten: filters die je ziet staan — 2026-10-13

## Aanleiding

Op een breed scherm stonden de filters *Soort*, *Klant* en *Periode* niet naast de
tabbladen, maar als drie lege vakjes van 38px onder elkaar tegen de rechterrand van
de balk, er half buiten. Klapte je er een open, dan was het menu net zo smal: van
*Alle soorten*, *Alleen e-mail*, *Alleen tickets* en *Alleen telefoon* zag je een
vinkje en drie keer een "A".

Twee oorzaken:

1. **De tabstrook pakte de hele regel.** Belicht (25 september) zet elke tabstrook
   vanaf 761px op de volle breedte, als onderstreepte regel. Op Berichten moeten de
   filters ernaast staan; die hielden 0px over, wikkelden onder elkaar, en het menu
   neemt de breedte van zijn knop over.
2. **De knoppen hadden geen veldopmaak.** `Select` zet `form-select` alleen op de
   knop als er geen eigen klasse wordt meegegeven, en Berichten gaf `comm-filter`
   mee. De filters waren daardoor kale browserknoppen: grijs vlak, harde rand,
   geen ronde hoeken, tekst tegen de rand. Ook op een smaller scherm en in het
   filterpaneel op de telefoon, waar ze wél ruimte hadden.

## Wat er is veranderd

### Eén regel: tabbladen links, filters rechts

- De tabstrook is zo breed als zijn tabbladen; de filters staan rechts op dezelfde
  regel. De balk is op 1440px daardoor **104px hoog in plaats van 180px**; het
  gesprek eronder wint 76px.
- Past het niet naast elkaar (een smal laptopscherm, of de zijbalk uitgeklapt),
  dan zakken de filters als groep naar een eigen regel eronder, links uitgelijnd.
  Dat beslist de ruimte die er is, niet een vaste schermbreedte: de zijbalk is 64
  of 248px breed, en het oude breekpunt van 1250px zat daar altijd naast.
- De grijze lijn onder de tabbladen is weg in deze balk. De rand van de kaart is
  die lijn al, en een tweede lijn die stopt waar de filters beginnen, oogde als een
  fout. De gouden streep onder het gekozen tabblad blijft.

### De filters zelf

- **Compacte knoppen in de stijl van de velden** (licht of grafiet vlak, haarlijn,
  ronde hoeken), 32px hoog, zo breed als hun tekst, tot 210px. Een lange
  klantnaam kapt daarna af met …
- **Een icoon per filter**: lagen voor *Soort*, de poppetjes van Klanten voor
  *Klant*, een kalender voor *Periode*. Er staat geen label boven, dus het icoon
  zegt waaróp je filtert.
- **Een filter dat aanstaat, kleurt goud**: gouden tint en rand, vette tekst,
  gouden icoon. Zo valt een vergeten filter op voordat je je afvraagt waar een
  gesprek gebleven is.
- **Wissen.** Staat er minstens één filter aan, dan verschijnt achteraan
  *↺ Wissen*. Dat zet soort, klant en periode terug; de zoekterm blijft staan, die
  heeft zijn eigen ✕. *Filters wissen* in een lege lijst wist zoals voorheen
  alles, ook de zoekterm.
- **Aangepast…** (een eigen periode): de twee datumvelden staan even hoog direct
  achter *Periode*.

### Het menu

- **Breder dan de knop waar dat nodig is**: 200px voor *Soort* en *Periode*, 260px
  voor *Klant*, zodat *Afgelopen 90 dagen* en *Van Dijk Installatietechniek* heel
  in beeld staan. Past het naar rechts niet meer, dan lijnt het menu uit op de
  rechterkant van zijn knop.
- **De periodes passen in één keer.** Een keuzelijst zonder zoekveld (minder dan
  tien opties) mag tot 320px hoog worden in plaats van 264px; bij de acht periodes
  viel *Aangepast…* er half af. Dat geldt voor elke korte keuzelijst in de app,
  alleen als de ruimte er is. Of een menu omhoog of omlaag openklapt, beslist nog
  steeds dezelfde regel, dus geen menu klapt ineens de andere kant op.

### Telefoon

Het paneel achter de schuifjesknop heeft dezelfde knoppen, nu met veldopmaak,
icoon en gouden stand, op 36px duimhoogte en 12,5px letter. *Wissen* staat als
gestippelde knop in het lege vak naast *Periode*. Het menu van *Klant* is 260px
breed en lijnt rechts uit op zijn knop. Liggend blijven de filters op 30px.

### Ook opgelost: het zoekveld met de zijbalk uitgeklapt

Vanaf 1251px staan de tellers naast de titel (*3 gesprekken · 5 tickets · 2
telefoongesprekken · …*, ruim 450px). Die gaven nooit iets op, dus kromp alleen het
zoekveld: met de zijbalk uitgeklapt (de standaard vanaf 1280px) bleef er op 1280px
een vakje van 34px over. Nu wijken de tellers eerst (ze kappen af met …) en houdt
het zoekveld ruim 250px. *Gesprek loggen* en *Nieuw bericht* krimpen niet meer;
anders braken ze over twee regels.

## Waar het staat

| bestand | wat |
|---|---|
| `src/features/Communication.tsx` | de drie filters met `form-select`, een icoon, `is-set` en een menubreedte; de knop *Wissen* (`clearFilters`) |
| `src/components/Ui.tsx` | `Select` kent twee optionele props: `icon` (vóór de waarde in de knop) en `menuMinWidth` (het menu mag breder zijn dan de knop). Zonder die props verandert er niets. Korte lijsten mogen tot 320px hoog worden. |
| `src/styles/globals.css` | `.select-icon`; de regel tabbladen + filters, de filterknoppen, de gouden stand, *Wissen*, het paneel op de telefoon en de liggende stand; de tellers die wijken voor het zoekveld |

## Getest

- `npm run typecheck`, `npm test` (705 tests), `npm run build` en
  `node scripts/check-csp-hash.mjs`: schoon.
- `npm run test:mobile -- --theme=both`: 264 pagina's (licht en donker ×
  telefoon, tablet, liggend), 0 problemen. Het eerste gesprek op Berichten staat
  op de telefoon nog steeds op 151px (grens 185); de filters zweven daar als
  paneel en duwen niets omlaag.
- In de browser met de nagebootste backend en Poppins: 1920px, 1440 en 1280px
  met de zijbalk in én uit (licht en donker), 1251, 1100, 900, 820 en 761px, de
  telefoon (390px, licht en donker), liggend (740×360) en lage vensters van
  1280×520 en 1024×520. Steeds de filters dicht, een menu open, twee filters aan,
  een lange klantnaam en een eigen periode. Geen overlap, geen zijwaartse
  overloop, geen JavaScript-fouten, en geen menu valt buiten beeld.

## Wat níét verandert

Wat de filters doen. Soort, klant en periode filteren precies zoals voorheen, één
klant kiezen geeft nog steeds de vensters E-mail, Tickets en Telefoon naast elkaar,
en op de telefoon zitten de filters nog steeds achter de schuifjesknop. Geen
migratie en geen nieuwe gegevens, alleen de weergave.
