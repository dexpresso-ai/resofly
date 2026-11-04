# Changelog — Berichten op de telefoon: compacter, en gekanteld weer bruikbaar — 2026-09-18

Twee dingen die pas op een echt toestel opvielen, na de herindeling van vanochtend
(`CHANGELOG_BERICHTEN_SCHERMVULLEND_2026-09-18.md`).

## 1 · De balk pakte te veel van de telefoon

Staand was de balk 153px hoog, en met de filters open 305px — ruim een derde van het scherm,
vóór er één gesprek in beeld kwam. Wat er is veranderd:

- **De titel "Berichten" is weg uit de balk.** De werktab bovenaan zegt het al, mét icoon; het
  er nog een keer onder zetten kostte een hele regel. De `<h2>` blijft in de HTML staan voor
  schermlezers en de paginastructuur, maar neemt geen ruimte meer in beeld.
- **Zoeken, filteren en *Nieuw bericht* delen nu één regel**, de tabbladen de volgende. De
  knop is daar toch al alleen een icoon.
- **De filters zijn een zwevend paneel geworden** in plaats van drie keuzelijsten ín de balk.
  Ze hangen onder de balk, in twee kolommen, en de lijst blijft staan waar hij staat — of je
  ze nu openklapt of niet. Eén kolom is onnodig hoog, drie is niet meer te lezen.
- Kleinere marges, een strakker zoekveld en tabbladen van 32px.

| | balk vóór | balk nu |
|---|---|---|
| staand, filters dicht | 153px | **98px** |
| staand, filters open | 305px | **98px** (paneel zweeft) |
| liggend, filters dicht | 153px | **93px** |
| liggend, filters open | 305px | **93px** |

Het eerste gesprek begint staand nu op **151px** in plaats van 206px (en 358px met de filters
open). De grens in de mobiele lay-outtest schuift mee naar 185.

## 2 · Gekanteld kon je niet meer scrollen

Een telefoon die je kantelt is geen smal scherm maar een **laag** scherm: nog geen 360px hoog,
waarvan de werktabs en de onderbalk er al 100 pakken. Daar bleef van de 260px die overbleef
niets over zodra de filters openstonden — de balk was 305px, de gesprekkenlijst werd tot **1px**
samengedrukt, en omdat de pagina zelf niet mocht scrollen (`overflow:hidden`) kon je er ook niet
langs. 46px inhoud stond er, onbereikbaar.

Drie dingen zijn daarvoor nodig, en alle drie zitten erin:

- **Het zwevende filterpaneel** (hierboven): openklappen verandert de hoogte van de balk niet meer.
- **Een aparte stand voor lage schermen** (`@media(max-height:560px)`): kleinere marges, de
  tabbladen en de filters op één regel, keuzelijsten die meekrimpen in plaats van te wikkelen.
  In de breedte is er liggend juist rúimte; die wordt nu gebruikt.
- **Een vangnet.** `.comm-shell` heeft een bodem van 140px en `.content` mag scrollen
  (`overflow-y:auto` in plaats van `hidden`). Past het toch niet — een groter systeemlettertype,
  een nóg lager scherm — dan scrollt de pagina in plaats van de lijst weg te drukken achter een
  rand waar je niet langs kunt. Normaal valt er niets te scrollen: de pagina past precies.

Resultaat liggend: de balk is 93px, de lijst 167px, en alle gesprekken zijn bereikbaar.

## 3 · Waarom de test dit niet zag — en nu wel

De mobiele lay-outtest mat telefoon en tablet, allebei staand, en keek naar JS-fouten,
zijwaartse overloop, de hoogte van de vaste balken en hoe laag het eerste item begint. Geen van
die vier gaat af op een lijst die tot 1px is samengedrukt: er is geen fout, niets loopt
zijwaarts, de vaste balken zijn onveranderd, en het eerste item *begon* keurig — alleen was er
niets meer van te zien. Drie dingen erbij:

- **Een liggend formaat** (740×360) naast telefoon en tablet, in de standaardronde.
- **Een bereikbaarheidscontrole.** Het eerste item wordt in beeld gescrold (ook binnen een eigen
  scrollgebied) en zijn rechthoek daarna bijgeknipt op élke voorouder die afkapt. Blijft er
  minder dan 12px over, dan is het item weggedrukt en valt de test.
- **Berichten opent mét de filters uitgeklapt** (`prepare` in `PAGES`). Dat is de stand waarin
  de balk het hoogst is, en precies daar ging het mis; een pagina die alleen in zijn ruststand
  gemeten wordt, verbergt zo'n fout.

Nagemeten dat het vangnet ook echt vangt: met de CSS van vóór deze fix meldt de test
`dark/landscape/communication ← eerste item (.comm-row) is weggedrukt: 1px zichtbaar`.

## Wat níét verandert

Alleen opmaak en de test. Geen gedrag, geen gegevens, geen database — **aan de
Supabase-migratie van vanochtend is niets gewijzigd; die staat nog steeds klaar en ongedraaid.**
Op een breed scherm ziet Berichten er precies hetzelfde uit als vanochtend.
