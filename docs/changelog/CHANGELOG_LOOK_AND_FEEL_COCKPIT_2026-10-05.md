# Look & feel: Cockpit, naar Value Backlog in de eigen kleuren (2026-10-05)

## Wat de PO vroeg

> Ik heb vandaag de Value Engine gezien. Die vond ik echt heel erg mooi als
> layout en graphic. Bouw de look en feel van ResoFly om, geïnspireerd op de
> value backlog, met behoud van de eigen branding kleuren.

Value Backlog (repo `dexpresso-ai/value-backlog`, House of Bèta) is gebouwd rond
een paar herkenbare beelden: een donkere zijbalk met een gloed bovenin en een
textuur die naar onderen wegvloeit, een licht werkvlak dat met grote ronde hoeken
op die donkere grond zweeft, een dashboard als donkere *cockpit* met glazen
kerncijfers en het fasespoor, paginakoppen met een pictogram in een donkere tegel,
zacht gelaagde kaarten en een zwevende dock op de telefoon. Die opbouw en
beeldtaal staan nu in ResoFly — in grafiet, zongoud en het poollicht van Gerrie,
niet in het navy en mint van House of Bèta.

## Wat blijft

- **De kleuren.** Grafiet, zongoud (`#F7C548` / op licht `#855800` als tekst) en
  het poollicht van Gerrie. Alle teksttokens uit Belicht blijven staan, dus ook
  hun contrast (WCAG AA).
- **De letter is wél veranderd**, in een vervolgvraag dezelfde dag: de
  werkruimte staat nu helemaal in Poppins (was Geist met Instrument Serif en
  Geist Mono). Zie [Vervolg: alles in Poppins](#vervolg-alles-in-poppins).
- **Nacht en Dag.** Beide thema's zijn ontworpen. Op Dag blijft het werkvlak licht;
  alleen de commandovlakken zijn donker, precies zoals bij Value Backlog.
- **De gemeten opbouw van de telefoon.** Hoogtes, marges en lettergroottes
  veranderen alleen vanaf 761px. `npm run test:mobile -- --theme=both`: 246
  pagina's gemeten, 0 problemen. Het dashboard begint op de telefoon op 273px
  (was 269, grens 280); de chrome blijft 100px.
- **De publieke pagina's en het klantportaal.** Die dragen de huisstijl van de
  leverancier (`brandThemeVars`). Alle regels van deze laag staan onder `.app`
  (de werkruimte); offerte-, factuur- en portaalpagina's zijn pixel voor pixel
  gelijk gebleven.

## Wat er veranderd is

### De werkruimte

- **Het commandovlak is altijd donker** — de zijbalk, de cockpit van het
  dashboard, de kop van een project of klant, de dock op de telefoon en het
  inlogscherm, ook op Dag. Grafiet met één warme lamp linksboven (het zongoud).
  De textuur is eigen: **resonantieringen** die vanuit het R-merkteken
  uitwaaieren, waar Value Backlog de honingraat van zijn fasebord gebruikt.
- **Het werkvlak zweeft op de grond.** Op desktop en tablet ligt het met 8px
  marge en hoeken van 22px op de donkere grond, met licht van boven. Op Dag is
  dat een warm papieren canvas tegen het donker; op Nacht een grafieten paneel met
  een haarlijn.
- **De bovenregel** (werktabs en knoppen) ligt doorzichtig op het werkvlak en
  krijgt pas een haarlijn en schaduw als de inhoud eronder schuift. Het actieve
  tabblad ligt erbovenop met een gouden icoon.
- **Een nieuwe pagina schuift zacht in** (300 ms; niet bij *reduced motion*).

### De zijbalk

- Het merk als gouden blok met een halo, eronder *Werkruimte* in goud.
- Groepskopjes klein, in kapitalen met lucht (OVERZICHT, PLANNEN, WERK …).
- **Waar je bent, gloeit**: de actieve regel krijgt een gouden verloop, een
  gouden streep langs de rand en een oplichtend icoon. Gerrie houdt zijn
  poollicht.
- Tellers zijn gouden pillen met gloed; in de smalle balk een gouden stip.
- Zoekveld, organisatiekeuze en het accountmenu in glas op donker.
- **Uitgeklapt als standaard op een breed scherm (≥ 1280px)** voor wie nog
  nooit gekozen heeft — de opbouw van Value Backlog. Wie de balk ooit heeft
  vastgezet of losgemaakt, houdt die keuze; smaller blijft het de iconenbalk.

### Het dashboard: een cockpit

Bovenaan één donker vlak met de stand van zaken (`Dashboard.tsx`):

- de bovenregel met de datum, de groet (*Goedenavond, Studio Lopik* met de naam
  in goud), de samenvatting van de dag en rechts *Weekplanner* met het aantal
  open acties van deze week;
- de zes kerncijfers als **glazen tegels**, met een dun lijntje bovenaan als een
  tegel iets te melden heeft (goud voor de omzet, rood voor te laat);
- **het weekspoor** — de tegenhanger van het fasespoor: zeven dagen op één
  lijn, *Werkweek* en *Weekend*, vandaag ademt in goud. Per dag het aantal open
  acties en een stip per taak in de kleur van het project; een voorbije dag met
  open werk kleurt oranje. Elke dag opent de weekplanner.

Op de tablet staan alleen de tegels in het donkere vlak (de groet was daar al
verborgen), op de telefoon ook — met 6px rand die in de tegels is teruggewonnen.
De kaarten eronder (Vandaag, Vereist je aandacht, Weekacties) hebben een icoon
voor hun titel gekregen.

### Paginakoppen, kaarten en bediening

- **Paginakoppen** groot en stevig (28px, 800), de bovenregel in kleine
  gouden kapitalen, en vanaf 1025px het **icoon van de pagina in een donkere
  tegel** links van de titel — hetzelfde icoon als in de werktab (`PageIcon`).
  Staat op Klanten, Projecten, Offertes, Facturen, Contracten,
  Leveranciers, Inkoopfacturen, Grootboek, Bank, Activa, W&V, Omzetbelasting,
  VPB, DGA, Aandeelhouders, Boekjaren, Jaarrekening, Uren, Marketing en
  Instellingen. De kop van Klanten staat nu vrij op het werkvlak, net als de rest.
- **De kop van een project of klant** is donker, met de kleur van het project
  of de klant als gloed linksboven, de ringen erachter en de knoppen in glas.
  *Terug naar klanten* is een rustige regel in plaats van een brede knop.
- **Kaarten** hebben hoeken van 18px en een zachte, gelaagde schaduw; wat
  klikbaar is, komt bij hover 2px omhoog.
- **De hoofdknop** is goud met een verloop van boven en een gouden gloed; bij
  hover een gloeiende rand. Gewone knoppen zijn wit (of grafiet) met een
  haarlijn, op een donker vlak glas. Hoeken 12px.
- **Velden** krijgen bij focus een zachte gouden ring van 4px.
- **Keuzestroken** (Mijn/Team, Kaarten/Tabel …): een verzonken spoor, de gekozen
  stand ligt er wit bovenop.
- **Tabelkoppen** in kleine kapitalen; het gekozen tabblad op klant- en
  projectpagina's draagt een gloeiende gouden streep.

### Telefoon

- **De onderbalk is een zwevende dock**: donker glas met ronde hoeken, 8px boven
  de rand. Het gekozen icoon gloeit goud met een streepje erboven. Gerrie, de
  agenda-"+" en de meldingen schuiven die 8px mee omhoog.
- **De menuknop** is een donkere merktegel met het icoon in goud.
- Het uitschuifmenu is dezelfde donkere zijbalk, met de ringen uit het merk.

### Inloggen

Het donkere commandovlak over het hele scherm. Op een groot scherm links het
verhaal — het merk, *Van eerste mail tot betaalde factuur.* en het traject
klant → offerte → project → factuur → betaald — en rechts het formulier; op de
telefoon alleen het formulier. Ook het laadscherm is donker.

## Waar het staat

| bestand | wat |
|---|---|
| `src/styles/cockpit.css` | de hele laag: tokens (`--ground`, `--rings`, `--cmd-surface`, `--shadow-card`, …), het donkere commandovlak (op Dag krijgen zijbalk, cockpit, koppen en dock de Nacht-tokens), werkvlak, zijbalk, koppen, kaarten, knoppen, velden, cockpit, weekspoor, dock, inloggen. Geladen ná `globals.css` (zie `main.tsx`), dus hij wint van Belicht op gelijke specificiteit |
| `src/main.tsx` | de laag laden; zijbalk standaard uitgeklapt op een breed scherm; `is-scrolled` op het werkvlak; het inschuiven van een pagina; het inlogscherm met het verhaal |
| `src/features/Dashboard.tsx` | de cockpit (groet, tegels, `WeekRail`) en de iconen bij de kaarttitels |
| `src/components/PageIcon.tsx` | de tegel met het pagina-icoon (de iconen komen uit `PAGE_ICON` in `TabBar.tsx`) |
| `src/components/Sidebar.tsx` | *Werkruimte* onder het merk |
| `src/features/Clients.tsx` | de gloed in de kop van een klant |
| koppen in `Clients`, `Projects`, `WeekPlanner`, `Finance`, `Bookkeeping`, `Contracts`, `Bank`, `Assets`, `ProfitLoss`, `VatReturns`, `CorporateTax`, `Dga`, `Shareholders`, `FiscalYears`, `AnnualAccounts`, `TimeTracking`, `Marketing`, `SimplePages` (Instellingen) | één `<PageIcon page="…" />` per kop |

## Hoe het gecontroleerd is

- `npm run typecheck`, `npm test` (608 tests), `npm run build` en
  `node scripts/check-csp-hash.mjs`: groen. Het inline themascript in
  `index.html` is niet veranderd, dus de CSP-hash ook niet.
- `npm run test:mobile -- --theme=both`: 246 pagina's op telefoon, tablet en
  liggend, Nacht en Dag — 0 problemen.
- Elke pagina van de werkruimte is met de nagebootste backend op desktop
  (1440×900) en telefoon (390×844) in Nacht en Dag naast de oude versie gelegd,
  plus de interacties: de smalle balk bij hover, het accountmenu, een venster,
  het uitschuifmenu en de bovenregel bij het scrollen.

## Vervolg: alles in Poppins

> Alles, dus ook balken mogen Poppins zijn.

De hele werkruimte staat nu in **Poppins**, net als Value Backlog — en het is
ook gewoon de huisletter van ResoFly: in `BRAND_FONTS` heet Poppins al *"De
huisstijl van ResoFly"*, de standaardletter van alles wat de klant ziet.

- **Alles**: zijbalk, werktabs, bovenregel, dock, koppen, kaarten, tabellen,
  knoppen, velden, pop-ups en keuzelijsten. Ook de rol van *Geist Mono*
  (tijden, nummers, schattingen) en die van *Instrument Serif* (het accent in
  de groet en op het inlogscherm) zijn Poppins. Het accent is daarmee geen
  andere letter meer maar een andere kleur: *Studio Lopik* staat in goud in de
  groet, *werkruimte* in diep amber op het inlogscherm.
- **Hoe**: `cockpit.css` zet `--font-sans`, `--font-mono` en `--font-serif` op
  Poppins zodra de werkruimte, het inlogscherm of het laadscherm in beeld is
  (`:root:has(.app, main.login:not(.portal), div.boot)`). `index.html` laadt
  Poppins (300–800, cursief 400 en 600 — dezelfde set als de klantpagina's).
- **Wat niet verandert**: de publieke pagina's en het klantportaal kiezen hun
  eigen letter (de huisstijl van de leverancier) en zijn pixel voor pixel gelijk
  gebleven. Na `'Poppins'` staat dezelfde terugvalreeks als voorheen, dus de
  lay-outtest (die geen webfonts laadt) meet precies hetzelfde.
- **Bijgesteld voor de bredere letter**: titels iets minder strak gespatieerd
  (−0,022em), tabelkoppen in kapitalen met minder lucht (0,06em), en de regel
  *Owner · + administratie · + organisatie* onder de organisatiekeuze iets
  kleiner (hij paste net niet meer). De weekplanner houdt zijn compacte
  kopbalk zonder icoontegel: met de tegel werd de kop twee regels en viel de
  knoppenrij eronder half weg.
- **Om te weten**: Poppins van Google Fonts heeft geen tabelcijfers (`tnum`).
  Bedragen onder elkaar lijnen rechts uit, maar niet cijfer voor cijfer — net
  als in Value Backlog.

## Nog niet gedaan

- Een opdrachtpalet (⌘K) en *Nieuwe taak* in de bovenregel, zoals Value Backlog
  ze heeft, staan nog op de lijst uit het Belicht-voorstel.
- De e-mails en pdf's volgen de huisstijl van de leverancier en zijn niet
  aangepast.
