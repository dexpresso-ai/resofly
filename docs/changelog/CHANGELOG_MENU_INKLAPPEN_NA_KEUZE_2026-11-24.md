# Menu: het paneel klapt in zodra je iets kiest (2026-11-24)

## Wat de PO vroeg

> Zorg ervoor dat wanneer ik op het menu klik, dat we inderdaad de pagina openen. Maar daarna
> blijft hij zo irritant in het beeld hangen. Dus ik wil op het moment dat ik een keuze heb
> gemaakt, dat hij daarna weer inklapt. Ben je klaar met de ontwikkeling? Deploy dan naar staging.

## Wat er was

In Baken (de standaard), Zenit en Stroom staat links de rail met de modules. Staat het paneel
niet vast, dan schuift het submenu uit zodra je de rail aanwijst, en zweeft het over het
werkvlak. Het bleef open zolang de muis erop stond. Klikte je in het paneel op bijvoorbeeld
*Projecten*, dan opende de pagina wel, maar het paneel bleef eroverheen hangen tot je de muis
weghaalde. Op een tablet was het erger: daar blijft een aanraking "plakken", en het paneel
ging pas weg als je ergens anders tikte.

## Wat er nu is

- **Kies je iets in het paneel, dan klapt het meteen in**, ook als de muis er nog op staat.
  Dat geldt voor elke keuze in het paneel: een pagina, een recent project, een rapportage
  van Gerrie, *Praat met Gerrie*, de Gerrie-kaart onderin, een onderdeel van de
  instellingen en een andere organisatie. En voor de keuzes in het accountmenu
  (instellingen, nieuwe organisatie of administratie).
- **Terug openen gaat via de rail.** Wijs de rail opnieuw aan, tik hem aan of kom er met
  Tab in, en het paneel is er weer. Met de muis over de plek bewegen waar het paneel stond,
  opent het niet: daar staat nu je pagina.
- **Een klik op een module op de rail laat het paneel open.** Dan opent de beginpagina van
  die module, en toont het paneel wat er nog meer in zit. Zo kun je meteen verder naar
  bijvoorbeeld *Geld › Grootboek*. Kies je daar iets, dan klapt het in.
- **Tikken naast het menu klapt het in.** Op een tablet hoef je dus niet meer te zoeken naar
  een plek die het paneel wegkrijgt. Het lijstje van de organisatiekeuze telt als deel van
  het menu: daarin tikken sluit het paneel niet.
- **De knop *Paneel inklappen*** (rechtsboven in het paneel) klapt het nu ook echt meteen
  in. Eerst bleef het staan zolang de muis erop stond.

## Wat niet verandert

- **Vastgezet blijft vast.** Wie het paneel met het speldje vastzette, houdt het naast de
  rail, ook na een keuze: daar is het speldje voor. Wie nooit koos, krijgt vanaf 1280px
  breed nog steeds het vaste paneel. Wil je dat het inklapt, klik dan één keer op
  *Paneel inklappen*; die keuze wordt onthouden.
- **De telefoon** deed dit al: het uitschuifmenu gaat na een keuze dicht, en een tik op de
  rail wisselt alleen het paneel.
- **Met het toetsenbord** klapt het na Enter op een keuze in, net als met de muis. Klap je
  het paneel met het toetsenbord los, dan blijft het open: anders staat de focus in een
  paneel dat je niet ziet.
- **Cockpit**, de vorige look met de zijbalk, is niet aangepast.

## Waar het staat

| bestand | wat |
| --- | --- |
| `src/components/ZenitNav.tsx` | `shut`: na een keuze `is-shut` op de navigatie. De rail haalt het weg bij aanwijzen, aantikken of focus. Een tik naast het menu zet het (alleen als het paneel los staat). |
| `src/styles/zenit.css` | §5: het losse paneel opent bij hover of focus, behalve met `.is-shut` |

## Hoe het gecontroleerd is

- `npm run typecheck` en `npm test` (2256 tests): groen.
- `npm run test:loading`: groen. Die navigeert via de rail en het paneel, dus ook na het
  inklappen.
- `npm run test:terugknop`: 16 gelukt, 0 mislukt.
- `npm run test:mobile -- --theme=both`: 914 pagina's gemeten op telefoon, tablet, liggend
  en laptop, in Dag en Nacht: 0 met problemen.
- `npm run build` en `node scripts/check-csp-hash.mjs`: groen.
- Een eigen ronde in Chromium tegen de mock-backend, 37 controles, op 1440×900 met de muis
  (los en vastgezet), op een tablet van 820×1180 met aanraking en op een telefoon van
  390×844. Gedraaid in Baken met en zonder animaties, in Zenit en in Stroom: alle vier
  37 van 37 goed. Dezelfde ronde tegen de code van vóór deze wijziging: zeven controles
  fout, precies die over het inklappen. Getoetst onder meer:
  - na een keuze in het paneel is het dicht, met de muis er nog op;
  - over de plek van het paneel bewegen opent het niet weer, de rail wel;
  - na een keuze snel terug naar de rail: het paneel is er meteen;
  - Tab in de rail opent het paneel, Enter op een keuze klapt het in;
  - vastgezet blijft het staan na een keuze en na een klik ernaast;
  - *Paneel inklappen* klapt meteen in, ook met de muis erop;
  - tablet: tik op Geld toont Geld, tik op Grootboek opent de pagina en klapt in, tik naast
    het menu klapt in, het lijstje van de organisatiekeuze houdt het open;
  - telefoon: na een keuze is het uitschuifmenu dicht;
  - geen fouten in de console.
