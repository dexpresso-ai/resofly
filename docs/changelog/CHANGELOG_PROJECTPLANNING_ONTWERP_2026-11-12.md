# Changelog — Projectplanning in een nieuw jasje — 2026-11-12

## Aanleiding

> Ik vind het projectoverzicht alles behalve mooi. Het ziet er wat rommelig uit. Kunnen we
> hetzelfde idee niet in een mooier jasje gaan gieten.

Het idee blijft: alle projecten op één tijdbalk, met fases, drukte en vandaag. Wat rommelig
oogde, en wat er nu anders is:

| Wat er misging | Wat het nu is |
| --- | --- |
| De kaart had geen binnenmarge. Titel en cijfers plakten tegen de rand; "Zonder planning" viel er rechts af. | De kop heeft een eigen marge, het bord loopt van rand tot rand eronder. De vier cijfers staan in één rustig blok. |
| Zoekveld, klantkeuze, knoppen en chips hadden elk een andere hoogte en ronding. | Alle bediening is 38px hoog, met de ronding van de look. Zoeken heeft een vergrootglas, de klantkeuze een icoon. |
| Korte balken toonden "Alge", "Doc" of één letter. | De naam staat in de balk als hij past, alleen de naam als de datums niet passen, en anders naast de balk. Bij opzij scrollen schuift de naam mee, zodat hij in beeld blijft. |
| De gele bezettingsblokken en het rode vandaag-label vielen over elkaar. | "Drukte" is per kolom een staafje naar verhouding; de drukste in goud. Vandaag is een gouden lijn met een eigen label bovenaan, en de lopende week of maand licht zacht op. |
| Een streepje "—" in de projectkolom leek een knop. | Links staat de projectkleur, de naam, de klant met "1/3 taken" en de fase als gekleurd label. |
| Te laat zag je alleen aan een woord. | De tijd na de einddatum is gearceerd, tot vandaag. Je ziet op het bord hoe ver een project over zijn tijd is. |
| Vooruit of terug kon alleen door te slepen. | Pijltjes naast Vandaag schuiven een flink stuk op. Vandaag komt op tweevijfde van het zichtbare bord, niet achter de projectkolom. |

Verder:

- Voortgang is een lijntje onderin de balk. Het getinte vlak liep dwars door de naam.
- Onder het bord staat een legenda, alleen met wat er op het bord staat (vandaag, voortgang,
  geschatte looptijd, over de einddatum).
- De vier cijfers zijn nu Projecten, Te laat (rood als het er een is), Open taken en Zonder
  vaste datum. "Piek overlap" is weg als cijfer: de drukste kolom staat in de Drukte-rij, met
  "max" ernaast.
- De fase "Planning" heet nu "Gepland". Op een pagina die Projectplanning heet, las "Planning 2"
  als iets anders dan een fase.
- Op het dashboard staan de fasechips en de tijdknoppen op één regel; daar is niets te zoeken.
- Lege toestand: een icoon, een zin wat je kunt doen en een knop "Alles tonen".

## Telefoon

De uitleg onder de titel valt weg (de tab zegt waar je bent). De cijfers staan in één strook,
de werkbalk past in twee regels (archief is daar alleen het icoon, met de tekst voor de
schermlezer), de fasechips zijn één veegbare regel. Het fasekenmerk staat onder de naam.

De telefoonregels stonden verspreid over drie plekken in `globals.css` die elkaar
overschreven. Ze staan nu bij de rest in het `.ptl`-blok.

## Zenit en Stroom

De rustige kop van Zenit (één zin, drie lenzen, Verfijnen) blijft. Kop en werkbalk zitten nu
samen in `.ptl-top`; de marges in `zenit.css` zijn daarop aangepast. Het bord zelf is in alle
looks hetzelfde. Zenit zet in de balk alleen de datums; de berekening van wat past houdt daar
rekening mee.

## Bestanden

- `src/features/ProjectTimeline.tsx`: de opbouw, de berekening welke tekst in een balk past
  (canvas-meting van de tekst tegen de gemeten breedte van het spoor), de uitloop, de
  tijdknoppen.
- `src/styles/globals.css`: het `.ptl`-blok opnieuw; de oude telefoonlagen eruit.
- `src/styles/zenit.css`: marges van de rustige kop.

## Getest

- `npm run typecheck`, `npm test` (1723 geslaagd).
- `npm run test:mobile -- --pages=project-planning,dashboard --viewports=phone,tablet,landscape,desktop --theme=both`:
  16 pagina's, geen problemen. Eerste projectbalk op de telefoon op 309px (grens 496).
- Hetzelfde voor `--look=zenit` (telefoon, tablet, desktop, beide thema's): geen problemen.
- `npm run test:loading`: alles geslaagd.
- Screenshots in Baken, Cockpit en Zenit, dag en nacht, op 1440px, 1100px en telefoon, met
  extra projecten zoals in de schermafdruk van de gebruiker: korte projecten die al maanden
  te laat zijn, projecten zonder klant en zonder datum.
