# Inspreken bij Gerrie: geen dubbele woorden meer (2026-11-12)

Wie een bericht aan Gerrie insprak, kreeg vaak een tekst vol herhalingen, vooral op een
Android-telefoon. "Welke facturen staan nog open" werd daar
"welkewelke facturenwelke facturen staanwelke facturen staan nog open". Dat is opgelost. Daarbij
zijn ook drie kleinere fouten rond de microfoonknop verholpen.

## Wat er misging

De spraakherkenning zit in de browser (Web Speech API). Die geeft tijdens het praten steeds
nieuwe resultaten door. De oude code plakte elk resultaat met de vlag "definitief" achter het
vorige. In Chrome op de computer klopt dat, maar niet overal:

- **Chrome op Android** meldt bij doorlopend luisteren elk tussenresultaat al als definitief,
  telkens met de hele zin tot dan toe en met zekerheid (`confidence`) 0. Pas de echte uitslag aan
  het eind heeft een zekerheid. Elk tussenresultaat kwam er dus opnieuw achter.
- **Safari** (en Chrome op de iPhone, met dezelfde motor) geeft soms de hele tekst sinds de start
  opnieuw als definitief resultaat. Ook meldt het hetzelfde resultaat soms twee keer, of zet het
  een zin twee keer achter elkaar in één resultaat.

## Wat er nu gebeurt

- `src/lib/dictation.ts` maakt van de resultaten één lopende tekst. Een resultaat dat herhaalt wat
  er al staat en verder gaat, vervangt dat stuk. Een resultaat dat er al staat, komt er niet nog
  eens bij. Een zin die twee keer achter elkaar in één resultaat staat, komt er één keer in. Woorden
  worden vergeleken zonder hoofdletters en leestekens.
- Op Android geldt een "definitief" resultaat zonder zekerheid als voorlopig. Een verbetering van
  de herkenner ("maak een koe" → "maak een offerte voor") vervangt het voorlopige stuk in plaats van
  erachter te komen. Lijkt het nieuwe stuk er niet op, dan blijft het vorige staan. Zo gaat er
  geen tekst verloren als een toestel zich anders gedraagt dan verwacht.
- Eén los woord dat dubbel staat ("nee nee") laten we staan: dat kan iemand echt zeggen.

## Ook verholpen

- **Versturen terwijl de microfoon aanstaat.** De herkenner liep door, en zijn volgende resultaat
  zette het verstuurde bericht opnieuw in het tekstveld. Ook dat las als dubbele tekst. Versturen
  zet de microfoon nu uit.
- **Zelf typen terwijl de microfoon aanstaat.** Het volgende spraakresultaat overschreef wat je net
  had getypt. Typen zet de microfoon nu uit.
- **Een oude herkenner die nog nawerkt** (na een fout of een nieuwe start) kan het tekstveld en de
  knop niet meer aanraken. Elke handler kijkt eerst of hij nog de actieve herkenner is.

## Getest

- `src/lib/dictation.test.ts` speelt na hoe Chrome op de computer, Chrome op Android en Safari hun
  resultaten aanleveren. Ook getest: verbeteringen, herhaalde meldingen, een dubbele zin, en
  gewone zinnen die heel moeten blijven.
- In Chromium met de nagebootste backend van de mobiele test (`tests/mobile/mock`) en een
  nagebootste spraakherkenner: Gerrie geopend, ingesproken als Android en als computer, getypt en
  verstuurd met de microfoon aan. De oude code gaf daar 6 fouten, waaronder precies de dubbele
  woorden hierboven. De nieuwe code geeft er geen.
- `npm run typecheck`, `npm test` en `npm run test:mobile -- --theme=both`.

Niet getest op een echt toestel. De verschillen per browser komen uit de broncode van Chrome en
uit bekende meldingen (Stack Overflow, react-speech-recognition, de Apple-ontwikkelaarsfora).
Hoor je op een toestel nog herhalingen, noteer dan het toestel en de browser.
