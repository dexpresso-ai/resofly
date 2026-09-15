# Changelog — Inhoud, teamchat en Gerrie op de telefoon — 2026-09-15

Drie dingen uit de praktijk op de telefoon: het menu-item **Inhoud** klapte eerst een
submenu uit in plaats van de pagina te openen, de **teamchat** propte de gesprekslijst
en het gesprek samen in één scherm, en het **commandocentrum van Gerrie** liep zijwaarts
uit beeld.

## 1 · Inhoud opent meteen het overzicht

- **Eén klik op "Inhoud" en je staat in het overzicht.** Het submenu met *Overzicht*,
  *Notities* en *Documenten* is weg — op de telefoon én op de desktop.
- **Notities en documenten waren daar al een filter.** In het overzicht zelf zit de knop
  **Weergeven**, waar je notities, documenten en bestanden los aan en uit zet, mét
  aantallen. Dat is dezelfde keuze, maar dan op de plek waar je hem nodig hebt.
- **De pagina's `notes` en `documents` blijven bestaan.** De globale zoekfunctie en Gerrie
  openen een notitie of document nog steeds rechtstreeks; de verkenner opent dan met dat
  filter aan en "Inhoud" licht op in het menu. Alleen de menuregels zijn weg.

## 2 · De teamchat op de telefoon: één venster tegelijk, zoals MS Teams

Vóór: de gesprekslijst stond bovenin, afgeknepen tot 230 px, met het gesprek eronder in
de resterende strook. Je zag twee berichten, een gesprekskop die de lijst herhaalde, en
een invoerveld dat tegen de onderbalk aan lag. Nu volgt de chat het patroon dat iedereen
van Teams (en WhatsApp) kent:

- **De gesprekslijst vult het scherm.** Je tikt een gesprek aan, en *dat* vult het scherm,
  met een terugpijl in de kop naast de naam en de online-status.
- **De chat loopt precies van de werktabs tot de onderbalk.** Kop en invoerbalk staan
  vast, alleen de berichten schuiven — de invoer blijft dus in beeld terwijl je terugleest.
- **Duimformaat.** Gespreksregels van 64 px, knoppen van 40 px, berichten op 15 px en
  bubbels tot 84 % van de breedte. Het invoerveld is 16 px: bij kleinere tekst zoomt iOS
  bij het aantikken in en staat de halve pagina scheef. Het veld groeit mee tot vier
  regels en scrollt daarna.
- **Gerrie zweeft niet meer over de verstuurknop.** De chatpagina loopt nu door tot de
  onderbalk, dus er is geen vrije hoek meer: Gerrie en de agenda-"+" zijn op de
  chatpagina verborgen (op elke andere pagina staan ze er gewoon).
- **Reageren, bewerken en intrekken met één tik.** Die knoppen hingen aan hover, en hover
  bestaat niet op een telefoon. Eén tik op een bericht zet de rij open, een tik ernaast
  weer dicht. Lang indrukken blijft van het toestel: tekst selecteren en kopiëren werkt
  gewoon.
- **Breed scherm verandert niets.** Vanaf 761 px staan de twee kolommen er nog precies zo,
  inclusief het automatisch openen van het bovenste gesprek. Wordt het venster smal
  terwijl er een gesprek openstaat dat je niet zelf koos, dan val je terug op de lijst.
- Ook rechtgezet: een kanaal met twee leden zei "2 lideren".

## 3 · Gerrie: de tabrij loopt niet meer uit beeld

Sinds er een vierde tab bij kwam (*Beslissingen*) stak de tabrij van het commandocentrum
65 px buiten het scherm en scrolde de hele pagina zijwaarts. De vier tabs staan op
`flex:1 1 auto` — mochten dus krimpen — maar een flex-item krimpt niet onder zijn eigen
inhoud. Dus krompen ze niet, ook al was er geen ruimte.

- **De tabrij is nu een veegrij.** Je veegt hem opzij; de vierde tab piept rechts al om
  de hoek, dus je ziet dat er meer is. Hetzelfde patroon als de knoppenrij van de
  rapportbouwer. Afkappen was geen optie: van "Nu uitvoeren" en "Beslissingen" blijft dan
  niets leesbaars over, en er past nu ook gewoon een vijfde tab bij.
- **Dode regel opgeruimd.** `.cc-tabs .cc-tab span{display:none}` moest de tablabels op
  een telefoon verbergen, maar die labels zijn kale tekstknopen — de regel deed niets, en
  het enige `<span>` in een tab is inmiddels de teller, die je juist wél wilt zien.

## Code

- `src/components/Sidebar.tsx` — het submenu onder *Inhoud* is verwijderd (`StickyNote` en
  `Files` waren alleen daarvoor). `contentPages` blijft: daarmee licht "Inhoud" op als je
  via zoeken op `notes` of `documents` landt.
- `src/components/TeamChat.tsx` — `useNarrowViewport()` (≤ 760 px, dezelfde grens als de
  CSS) bepaalt `singlePane`. Daaronder toont de shell óf de lijst óf het gesprek en zet
  hij `.chat-single`; de terugpijl hangt niet meer aan `variant === 'dock'` maar aan een
  `showBack`-prop. `MessageRow` opent zijn knoppenrij op een tik zodra het toestel geen
  hover kent.
- `src/styles/globals.css` — `.chat-single` vervangt de dock-specifieke kolomregels; blok
  **13b** in het mobiele deel bevat de telefoonweergave (`.content` als pad-loze
  flex-kolom, duimformaten, invoerbalk) en `@media(hover:none)` regelt de knoppenrij op
  een touchscreen. De oude gestapelde regels en de losse hoogtesommen zijn weg. `.cc-tabs`
  is op de telefoon een veegrij (`overflow-x:auto`, tabs op `flex:0 0 auto`).

## Getest

`npm run test:mobile` (telefoon 390×844 en tablet 820×1180, alle 72 pagina's) draait
schoon. De Gerrie-pagina stond daar al rood vóór deze wijziging; die overloop is hierboven
opgelost. De aangeraakte pagina's (chat, inhoud, notities, documenten, Gerrie) zijn ook in
het lichte thema nagemeten.

De mock-backend kreeg teamchat-data (een kanaal en een 1-op-1 gesprek met berichten), zodat
de chatpagina in die test niet langer als lege lijst wordt gemeten; `chat` heeft nu ook een
eigen ondergrens voor het eerste item. De mock sorteert daarnaast op `?order=`, zoals
PostgREST, anders komen berichten omgekeerd binnen.

Handmatig nagelopen in Chromium op 390×844, 360×640, 820×1180 en 1440×900: gesprek openen,
terug, tikken op een bericht, een bericht van vier regels typen, en het zwevende chatpaneel
op de desktop. Bij Gerrie: de tabrij opzij vegen en de vierde tab aantikken — die staat
daarna helemaal in beeld en de pagina blijft staan waar hij staat. Alle vier de tabs zijn
op 390 px nagemeten (de lay-outtest opent alleen de eerste); geen van de vier loopt nog
zijwaarts uit beeld.
