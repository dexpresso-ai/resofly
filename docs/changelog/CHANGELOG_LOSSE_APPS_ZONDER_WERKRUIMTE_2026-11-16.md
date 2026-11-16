# Losse apps: geen knop meer naar de hele werkruimte

**16 november 2026**

In Agenda, Financiën en Communicatie staat *Volledige werkruimte* niet meer.
Een losse app is nu alleen die app: het menu toont zijn eigen pagina's, en
verder niets.

## Wat er weg is

- In Baken, Zenit en Stroom: het icoon onderaan de linkerbalk, en het item in
  het accountmenu.
- In Cockpit: de knop onderaan het menu.
- De meldingen die die knop kon tonen: *Installeer eerst de ResoFly-app* en
  *Open ResoFly vanaf je beginscherm*.

Wie de hele werkruimte wil, opent de ResoFly-app of de werkruimte in de
browser, zoals elke andere app.

## Wat ermee wegging

Dit bestond alleen voor die knop (zie
`CHANGELOG_VOLLEDIGE_WERKRUIMTE_APP_2026-11-16.md`):

- `src/lib/openWorkspaceApp.ts` en de test: bijhouden of de ResoFly-app op het
  apparaat staat, en wat de knop per apparaat deed.
- In de werkruimte-app: de vlag in de opslag die de losse apps lazen, en
  `?installeren=1`, waarmee de installeerkaart ook kwam als je hem ooit
  wegklikte. Die kaart werkt verder als vanouds: wegklikken is wegklikken.
- `related_applications` in de vier manifesten en
  `public/.well-known/assetlinks.json`. Daarmee kon een losse app op Android
  aan Chrome vragen of de ResoFly-app er stond.
- De stijlen van de knop en de meldingen in `src/styles/apps.css`.

## Wat blijft

- De drie losse apps zelf, met hun eigen adres, manifest, menu en duimbalk.
- Instellingen → Apps, waar je ResoFly en de losse apps opent en installeert.
- `launch_handler` met `focus-existing` in het manifest van de werkruimte-app:
  open je ResoFly terwijl hij al open staat, dan komt dat venster naar voren in
  plaats van een tweede.
- Binnen een losse app opent een klant vanuit een factuur nog altijd gewoon, in
  hetzelfde venster.

## Getest

- `npm run typecheck` en `npm test`: 1918 geslaagd.
- `npm run test:terugknop`: 12 geslaagd.
- In Chromium met de nagebootste backend: Agenda, Financiën en Communicatie in
  Cockpit, Baken, Zenit en Stroom, met het accountmenu open. Nergens
  *Volledige werkruimte*, en geen fouten op de pagina. De werkruimte op `/` en
  op `/app/werkruimte/` opent gewoon.
