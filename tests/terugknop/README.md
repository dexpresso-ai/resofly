# Terugknop

`npm run test:terugknop` controleert in Chromium of de terugknop van de
telefoon "terug" is in de app, en de geïnstalleerde app niet wegzet zolang er
nog iets is om naar terug te gaan. De test draait tegen dezelfde nagebootste
backend als de mobiele lay-outtest (`tests/mobile/mock`), op telefoonformaat
(390×844), en drukt op terug zoals de browser dat doet (`page.goBack`).

Hij loopt deze gevallen na:

1. pagina's: terug gaat naar de vorige pagina, en op het dashboard laat de app
   los (de volgende druk verlaat hem);
2. drie keer terug zonder tik ertussen: elke druk één pagina, zonder dat er
   onderweg items bijkomen;
3. een bewerkvenster: terug sluit het venster, daarna pas de pagina;
4. een venster dicht met het kruisje: zijn stap gaat weg, de volgende druk
   gaat meteen naar de pagina ervoor;
5. het menu: terug sluit het; kies je erin, dan gaat terug naar de pagina
   ervoor;
6. het chatpaneel van Gerrie;
7. opstarten op een project (na herladen): terug gaat omhoog langs het
   kruimelpad, Projecten en dan het dashboard;
8. een nieuw tabblad: terug sluit het, en gaat daarna verder in het tabblad
   ervoor;
9. Berichten en de teamchat: van een gesprek terug naar de lijst;
10. herladen midden in de app: daarna klopt terug weer;
11. op een computer: een menu dat sluit bij het indrukken van de muis, en
    een klik die daarna een pagina opent.

```bash
npx playwright install chromium   # eenmalig
npm run test:terugknop
npm run test:terugknop -- --only=Berichten
npm run test:terugknop -- --url=http://localhost:5173/
```

In een cloudsessie: `RESOFLY_CHROMIUM=/opt/pw-browsers/chromium`.

## Wat deze test niet ziet

Chrome op een telefoon slaat items in de geschiedenis over die een pagina
toevoegde zonder dat iemand tikte (tegen sites die de terugknop kapen), en
na een stap terug telt een eerdere tik niet meer mee. `page.goBack` doet dat
niet. Dat deel staat in `src/lib/backButton.test.ts` (`npm test`), met een
nagebootste browser die bijhoudt wanneer er getikt is.

## Hoe het werkt

Zie `src/lib/backButton.ts` (de geschiedenis), `src/lib/tabHistory.ts` (waar
terug heen gaat in een werktabblad) en `src/lib/useBackStep.ts` (hoe een
venster of scherm zich aanmeldt).
