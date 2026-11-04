# Changelog — Financiële lijsten op de telefoon: de kaart van de klantenview — 2026-09-15

> De offertes en facturen vind ik op mobiel niet overzichtelijk. Die mag meer het
> uiterlijk van de klantenview hebben.

## Wat er misging

Offerte- en factuurlijsten zijn op een breed scherm een tabel. Op een telefoon
werden ze een kaartstapel waarin elke kolom een eigen regel kreeg, met het
kolomlabel ervoor:

```
OFFERTE    OFF-2026-7617
KLANT      Brand New Creators
DATUM      23-8-2026
VERLOOPT   —
TOTAAL     € 363,00
STATUS     CONCEPT
                              [oog] [pijl]
```

Zeven regels per offerte, ruim 600 px. Je scrolde dus per offerte in plaats van
door een lijst — precies één regel per scherm, met de helft van de breedte
opgevuld door woorden als "OFFERTE" en "STATUS" die je al weet omdat je op de
offertepagina staat.

## Wat het nu is

De klantenkaart leest veel sneller: een naam, een regel eronder, wat meta en een
pil — zonder labels ervoor. Offertes en facturen hebben nu diezelfde vorm, vier
regels:

```
2026-021                            [CONCEPT]
Kinderopvang Zonnetje
5-9-2026              verloopt 5-10-2026
€ 4.452,80                     [oog] [pijl]
```

- **Ruim vier per scherm** in plaats van één: ±112 px per kaart tegen ±600 px.
- **Het nummer is de kop**, de klant staat eronder, het bedrag is het grootste
  wat er staat — dat is waar je op zoekt in zo'n lijst.
- **De statuspil staat rechtsboven**, waar hij in de klantenkaart ook staat. Bij
  een factuur schuiven "niet geboekt", een herinneringsniveau en de pauzepil
  daar netjes achteraan.
- **De twee datums staan naast elkaar.** Kaal zeggen ze niet welke welke is, dus
  het kolomlabel komt terug als klein woord vóór de tweede: "verloopt 5-10-2026",
  bij een factuur "vervalt 3-10-2026".
- **Bekijken en downloaden** staan onderaan naast het bedrag, zoals eerst.
- **Project, bedrag ex. en btw** — en bij een factuur het offertenummer — gaan
  uit. Die lees je in het detail, en de hele kaart is één tik.

Vanaf 761 px verandert er niets: daar staat de tabel er nog precies zo.

## Leveranciers: dezelfde behandeling

`.bk-table` is op een telefoon een veegrij: `min-width:560px` in een zijwaartse
scroller. Voor een grootboek- of btw-rapport klopt dat — daar hoort een kolom
cijfers naast een kolom cijfers. Voor de leverancierslijst niet: die heeft vier
tekstvelden, en je moest vegen om te zien of er een IBAN in stond. Nu:

```
Drukkerij Van Wijk · L-001
Bert van Wijk
btw NL812345678B01      iban NL91ABNA0417164300
```

- **Niets loopt meer uit beeld**; btw-nummer en IBAN staan er allebei, met het
  kolomlabel als klein woord ervóór, want kaal zie je niet welk nummer welk is.
  Een lange IBAN breekt af in plaats van de kaart uit te rekken.
- **"Bewerk" is weg op de telefoon.** Die knop duwde de naam in een kolom van
  200 px, waardoor "Drukkerij Van Wijk · L-001" middenin de code afbrak — en de
  hele regel opende het formulier al. Net als bij de klant- en offertekaart is
  de kaart zelf het doel.
- **Alleen deze tabel.** Alle andere `.bk-table`s in de administratie zijn wél
  rapporten en houden hun veegrij; grootboek, btw-aangifte, winst & verlies en
  bank zijn nagemeten en ongewijzigd.

De leverancierspagina stond niet in de mobiele lay-outtest en had geen testdata.
Beide zijn toegevoegd: twee crediteuren, één volledig ingevuld en één waar bijna
alles leeg is, zodat zowel de volle regel als de "—"-variant gemeten wordt.

## Code

- `src/features/Finance.tsx` — de twee tabellen krijgen de klasse
  `fin-doc-table`. Nodig, want `quote-table` dragen de tickets- en
  marketingtabellen óók, en die hebben hun eigen mobiele vorm (blok 23). Een
  generieke regel zou die overschrijven.
- `src/features/Bookkeeping.tsx` — de leverancierstabel krijgt de klasse
  `supplier-table` en `data-label`-attributen per cel. Nodig, want `bk-table`
  dragen ruim twintig rapporttabellen in de administratie ook.
- `src/styles/globals.css` — blok **24** in het mobiele deel: `tr` wordt een
  raster van twee kolommen en elke cel krijgt zijn plek via `grid-row`/
  `grid-column`, dus de volgorde in de kaart staat los van de kolomvolgorde in
  de tabel. Staat bewust achteraan het bestand, ná de generieke
  `.quote-table`-mobielregels: die hebben dezelfde specificiteit, dus de
  volgorde beslist. Blok **25** doet hetzelfde voor `.supplier-table`.
- `tests/mobile/*` — leveranciers in de seed en in de gemeten pagina's, met een
  ondergrens voor het eerste item.

## Getest

`npm run test:mobile -- --theme=both` (zoals CI) draait schoon. Los nagemeten op
390 px in donker en licht: offertes, facturen, **tickets en marketing** (die
delen de `quote-table`-klasse en zijn ongewijzigd), en leveranciers plus
**grootboek, btw-aangifte, winst & verlies en bank** (die delen `bk-table` en
houden hun veegrij). `tsc` en `npm test` zijn groen.

