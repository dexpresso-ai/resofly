# Changelog — Offertes en facturen op de telefoon: de kaart van de klantenview — 2026-09-15

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

## Code

- `src/features/Finance.tsx` — de twee tabellen krijgen de klasse
  `fin-doc-table`. Nodig, want `quote-table` dragen de tickets- en
  marketingtabellen óók, en die hebben hun eigen mobiele vorm (blok 23). Een
  generieke regel zou die overschrijven.
- `src/styles/globals.css` — blok **24** in het mobiele deel: `tr` wordt een
  raster van twee kolommen en elke cel krijgt zijn plek via `grid-row`/
  `grid-column`, dus de volgorde in de kaart staat los van de kolomvolgorde in
  de tabel. Staat bewust achteraan het bestand, ná de generieke
  `.quote-table`-mobielregels: die hebben dezelfde specificiteit, dus de
  volgorde beslist.

## Getest

`npm run test:mobile -- --theme=both` (zoals CI) draait schoon. Offertes,
facturen, tickets én marketing zijn los nagemeten op 390 px in donker en licht:
die laatste twee delen de `quote-table`-klasse en zijn ongewijzigd. `tsc` en
`npm test` zijn groen.

## Wat hier niet in zit

De leverancierstabel loopt op een telefoon rechts uit beeld (de IBAN-kolom valt
weg). Die staat niet in de mobiele lay-outtest en heeft geen testdata, dus hij
is niet nagemeten — en de vraag ging over offertes en facturen. Los op te pakken.
