# Changelog — Projectgegevens als kaart, een kruimelpad op elke pagina, compactere projectfilters — 2026-09-19

Drie losse wensen, alle drie over dezelfde klacht: op de telefoon gaat er te veel hoogte op aan
dingen die geen inhoud zijn, en terugnavigeren kost te veel tikken.

## 1 · "Projectgegevens" is een kaart geworden

Het blok stond als vijf label/waarde-regels onder elkaar — klant, facturatie, startdatum,
einddatum, aangemaakt — elk op een eigen regel met een kop erboven. Op een telefoon was dat een
halve schermhoogte aan witruimte voor vijf korte waarden, en de twee datums zeiden los van
elkaar niets over de looptijd.

Nu drie blokjes met een lijntje ertussen:

- **Klant** — de initialen in de klantkleur, de naam ernaast, de facturatiewijze eronder.
  Die twee onder elkaar in plaats van naast elkaar: in een kolom van 340px kapte anders altijd
  één van de twee af.
- **Looptijd** — start en einde links en rechts met een pijl ertussen, daaronder een balk die
  laat zien waar vandaag staat, en één regel eronder: *"Nog 25 dagen van 46"*. Die regel kleurt
  mee — groen als er tijd is, oranje in de laatste week, rood over de einddatum heen, en hij
  zegt *"Start over 3 dagen"* voor een project dat nog moet beginnen.
- **Urenbudget** (alleen als er een budget staat) — geboekt tegenover begroot, met dezelfde balk
  en een percentage. Over het budget heen wordt de balk rood.

De aanmaakdatum is voetnoot geworden; die zoek je zelden op.

Alles is afgeleid uit wat er al was (`projectFacts()` in `src/features/Projects.tsx`) — er wordt
niets opgeslagen en er is geen migratie.

## 2 · Kruimelpad op elke pagina

Boven de pagina-inhoud staat nu één regel die twee dingen doet: zeggen waar je bent, en je in
één klik terugbrengen.

```
🏠 Dashboard  ›  Werk  ›  Projecten  ›  WOW – Implementatie
   klikbaar      menukop  klikbaar      hier sta je
```

- De **menukoppen** ("Werk", "Financiën", "Kennis & inzicht") komen letterlijk uit de zijbalk.
  Ze zijn geen pagina en dus geen knop — oriëntatie, geen doel.
- Op de **telefoon** verdwijnen die koppen, wordt "Dashboard" een huisje en staat er een
  terugpijl vóór het pad die naar de dichtstbijzijnde bovenliggende pagina springt. De rest is
  één veegbare regel; de naam van de huidige pagina kapt af in plaats van de regel open te duwen.
- Een galerij hangt onder zijn project, een klantdossier onder Klanten, notities en documenten
  onder Inhoud, de weekplanner en het archief onder Projecten. Eén klik brengt je terug.

Geen kruimelpad op het **dashboard** (dat is de bovenkant van het pad) en niet op de
schermvullende werkpagina's — agenda, weekplanner, Gerrie, Berichten en teamchat. Precies de
pagina's die ook de titelbalk al overslaan: daar valt niets terug te navigeren en is de regel
alleen verloren hoogte.

Nieuw: `src/lib/breadcrumbs.ts` (het pad) en `src/components/Breadcrumbs.tsx` (de regel).
Een klik zet pagina, project, klant en galerij in één keer (`navigateCrumb` in `main.tsx`), zodat
er geen tussentoestand bestaat waarin de pagina al klopt maar de context nog niet.

## 3 · De projectfilters op het dashboard zijn gehalveerd

Op het dashboard stond vóór de eerste projectbalk **214px** aan filterwerk: vier cijferblokken
van een halve regel hoog, een rij schaalknoppen en de fasechips die over twee regels vielen.

| | vóór | nu |
|---|---|---|
| filterblok op de telefoon (390px breed) | 214px | **122px** |

Wat er is veranderd:

- **De vier cijfers staan op één regel**: het getal vóór zijn label (*5 Getoond · 5 Piek ·
  14 Open · 0 Ongepland*) in plaats van vier blokken onder elkaar. Elk cijfer draagt twee
  labels — het volledige voor een breed scherm, een kort voor de telefoon. Alleen het zichtbare
  wordt voorgelezen; `display:none` haalt het andere ook uit de toegankelijkheidsboom.
- **De fasechips zijn één veegbare regel.** Dat hóórde al zo te zijn, maar de basisregel
  `.ptl-chips{flex-wrap:wrap}` staat verderop in `globals.css` dan de mediaquery die het regelde
  en won dus alsnog. De nieuwe regels staan helemaal achteraan.
- Het kopje "Fase" is weg — de chips zeggen zelf waar ze over gaan, en de groep houdt zijn
  `aria-label`.
- Kleinere knoppen, maar met 36px nog altijd te raken.

Geen filter is verdwenen; alles wat je kon aanklikken, kun je nog steeds aanklikken. Dit geldt
ook voor de volledige pagina *Projectplanning*, die dezelfde balk gebruikt — daar begint het
bord nu op 301px in plaats van 361px, kruimelpad inbegrepen.

## Test

`tests/mobile/run.mjs` meet per pagina hoe laag het eerste échte item begint. Het kruimelpad
kost op de telefoon 36px (een regel van 28px plus 8px marge); de grenzen in `FIRST_ITEM` zijn met
datzelfde bedrag omhoog gegaan, zodat de speling tegen *ongemerkte* groei blijft wat hij was.
Niet opgehoogd: het dashboard, de schermvullende pagina's zonder kruimelpad, en alles buiten de
werkruimte.

- `npm run typecheck` — schoon
- `npm test` — 321/321
- `npm run test:mobile -- --theme=both` — 240 pagina's (licht en donker × telefoon, tablet,
  liggend), 0 problemen
- `npm run build` — schoon
