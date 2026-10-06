# Changelog — Financiën schermvullend: offertes, facturen, contracten en de administratie — 2026-10-06

> Maak de tabellen van de offertes, contracten, facturen, etc zodanig dat ze
> schermvullend zijn en mobile friendly blijven. Zoals je nu op de printscreen
> ziet, zie je aan de rechterzijde nog aardig wat witruimte ontstaan.

## Wat er misging

Klanten, projecten en tickets lopen al een tijd tot de rand van het werkblad.
Financiën niet: de kop van Offertes en Facturen (`.quote-table-header`), hun
zoekblok (`.finance-search-card`), de tabelkaart (`.quote-table-card`) en elke
pagina van de administratie (`.bk-page`) hadden nog een plafond van **1180px**.
Op een scherm van ±1800px breed is het werkblad 1500px, dus bleef er rechts een
lege baan van **320px** staan — precies wat de schermafdruk liet zien.

Op twee plekken was het meer dan lucht:

- **Facturen** — de waarschuwingsbalk "nog niet in het grootboek" liep wél tot
  de rand, de tabel eronder niet. En in die 1180px paste de tabel niet eens:
  gemeten 1414px tabel in een kaart van 1178px, dus de statuskolom viel half
  weg en de knoppen stonden achter een zijwaartse scrollbalk. Op een breed
  scherm, met ruimte zat ernaast. (De offertetabel had hetzelfde, kleiner:
  70px.)
- **Marketing** — kop en tabbladen liepen al tot de rand, het zoekblok en de
  campagnetabel stopten op 1180px: een knip halverwege het scherm. Die tabel
  deelt `.quote-table-card` met offertes en facturen, dus hij gaat mee.

## Wat het nu is

### Alles tot de rand

Offertes, Facturen, Contracten, Leveranciers, Inkoopfacturen, Grootboek, Bank,
Activa, Winst & verlies, Omzetbelasting, Boekjaren, Vpb, DGA, Aandeelhouders en
Jaarrekening — plus het zoekblok en de campagnetabel van Marketing. Zelfde
regel als bij klanten, projecten en tickets: geen plafond. Gemeten op 1820px
met de zijbalk open: **0px** lege rand op al die pagina's (was 320px).

De knoppen in de kop (*+ Nieuw*, *Nieuw contract*, …) staan daarmee nu rechts
tegen de rand, net als op Marketing en Klanten.

### De offerte- en factuurtabel: de ruimte gaat naar klant en project

Alleen het plafond weghalen verdeelt de extra breedte over álle kolommen: lucht
achter "Concept" en tussen de bedragen, terwijl een projectnaam nog steeds op
190px werd afgekapt ("Campagne winteractie Van D…"). Daarom, vanaf 761px:

- **Nummer, datums, bedragen, status en knoppen** zijn zo smal als hun inhoud.
- **Klant en project** delen de rest, en kappen pas af op de rand van hun eigen
  kolom in plaats van op een vaste 190px. Op een smaller scherm houden ze een
  ondergrens van 150px, zodat een naam altijd leesbaar blijft.

Gemeten met de testdata, met Poppins geladen ("zijwaarts" = hoeveel van de
tabel achter de scrollbalk binnen de kaart valt):

| scherm | werkblad | offertes | facturen |
|---|---|---|---|
| 2560px, zijbalk open | 2238px | past; klant/project 709px, niets afgekapt (was 70px zijwaarts) | past; 626px, niets afgekapt (was 236px zijwaarts) |
| 1820px, zijbalk open | 1500px | past; 339px, niets afgekapt (was 70px zijwaarts) | past; 256px, niets afgekapt (was 236px zijwaarts) |
| 1440px, zijbalk dicht | 1302px | past; 241px, niets afgekapt (was 70px zijwaarts) | 49px zijwaarts (was 236px) |
| 1440px, zijbalk open | 1118px | 66px zijwaarts (was 130px) | 233px zijwaarts (was 296px) |

Rijhoogtes zijn ongewijzigd (nagemeten: 58–60px, voor en na).

### Lange omschrijvingen houden een leesbare regel

De regel onder de paginatitel van de administratie (`.bk-head p`) krijgt dezelfde
720px als die van Offertes en Facturen al had. Zonder plafond werd hij op
Boekjaren, Vpb en Aandeelhouders één regel van ±1200px, en drukte hij op
Boekjaren de knop *Nieuw boekjaar openen* in twee regels.

## Telefoon en tablet

- **Telefoon: niets veranderd.** Tot en met 760px is een offerte of factuur een
  kaart (blok 24 in `globals.css`); de nieuwe kolomverdeling geldt pas vanaf
  761px. Het plafond van 1180px speelde daar nooit mee: die schermen zijn
  smaller.
- **Tablet:** de tabel blijft een veegrij binnen zijn kaart, zoals hij was.
  Klant en project zijn daar 150px in plaats van tot 190px breed, dus de rij is
  ±63px korter om doorheen te vegen (offertes 1184px i.p.v. 1248px, facturen
  1351px i.p.v. 1414px).

## Code

- `src/styles/globals.css` — een nieuw blok *"Financiën: de lijsten lopen tot
  de rand van het werkblad"*, direct na het blok van Tickets (dat hetzelfde voor
  tickets deed). Het zet `max-width:none` op de drie houders, 720px op
  `.bk-head p`, en vanaf 761px de kolomverdeling van `.fin-doc-table`:
  `width:1%` krimpt een kolom tot zijn inhoud; de naam in klant en project telt
  niet mee voor de kolombreedte (`width:0` + `min-width:100%`), en een lege
  `::after` van 150px is de ondergrens. De knoppencel is een flexbox en geen
  tabelcel, dus daar zet de kolomkop (`th:last-child`) de breedte.
- `src/features/Finance.tsx`, `src/features/Marketing.tsx` — het zoekblok krijgt
  `is-wide` mee, net als op Klanten, Projecten en Tickets.

## Getest

- `npm run typecheck`, `npm test` (647 tests), `npm run build` en
  `node scripts/check-csp-hash.mjs`: groen.
- `npm run test:mobile -- --theme=both` (zoals CI): 258 pagina's gemeten op
  telefoon, tablet en liggend, Nacht en Dag — 0 problemen. De eerste offerte en
  factuur beginnen op de telefoon nog op dezelfde plek (236px en 367px).
- Desktop met de nagebootste backend, telkens mét Poppins geladen zoals in
  productie: alle zestien pagina's hierboven op 1820px in licht én donker (0px
  lege rand, geen zijwaartse overloop), offertes en facturen daarnaast op 1440
  (zijbalk open en dicht) en 2560px. De administratiepagina's zijn daarbij
  gevuld met tijdelijke testdata (rekeningschema, journaal, inkoopfacturen,
  activa, bank, contracten, rapportcijfers) — anders tonen ze in de test alleen
  "Boekhouding nog niet ingericht". Die data is niet meegecommit.

## Om te weten

- **Laptop met de zijbalk open (±1440px).** Daar is het werkblad 1118px. Tien
  of elf kolommen passen daar niet zonder de namen tot niets af te knippen, dus
  offertes en facturen schuiven nog een stukje zijwaarts — minder dan eerst
  (zie de tabel hierboven). Met de zijbalk ingeklapt past de offertetabel wel;
  de factuurtabel scrolt dan nog 49px.
- **Bank** gaat mee in de breedte; de keuzelijsten in een af te letteren
  bankregel waren al zo breed als de kaart, en zijn dat nog steeds.
- **Het klantdossier** staat nog gecentreerd op 1320px. Dat is een dossier met
  kaarten, geen lijst, en is daarom niet meegenomen.
