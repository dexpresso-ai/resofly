# Agenda, Financiën en Communicatie als losse app

**12 november 2026**

Je kunt nu drie onderdelen van ResoFly elk als eigen app installeren: op je
telefoon, in het dock van je Mac of in de taakbalk van Windows. Zo'n app opent
meteen op de goede pagina, en het menu toont alleen wat erbij hoort. Wie de hele
dag in zijn agenda of zijn facturen zit, hoeft niet meer langs het dashboard en
het menu.

| App | Adres | Opent op | In het menu |
| --- | --- | --- | --- |
| ResoFly Agenda | `/app/agenda/` | Agenda | Agendaweergave, Boekingslinks |
| ResoFly Financiën | `/app/financien/` | Facturen | alle pagina's van Financiën |
| ResoFly Communicatie | `/app/communicatie/` | Berichten | Berichten, Chat, Marketing |

## Hoe installeer je een app

Ga naar **Instellingen → Apps**. Daar staan de apps waar je bij kunt, elk met
**Openen** en **Link**.

1. Kies **Openen**. Op je telefoon kopieer je de link en open je hem daar in de
   browser.
2. In Chrome en Edge (ook op Android) staat er onderin een kaart *Installeer
   ResoFly Agenda* met een knop. In Safari op de iPhone of iPad tik je op Deel en
   kies je *Zet op beginscherm*; op de Mac kies je Archief → *Voeg toe aan Dock*.
   De kaart zegt dat ook.
3. Klaar. Het icoon is de gele tegel van ResoFly met het teken van de app.

Wie de kaart wegklikt, krijgt hem in die browser niet meer te zien. Draait de
app al als app, dan staat de kaart er niet.

## Wat er in de app hetzelfde blijft

- **Rechten.** De app is de werkruimte op een ander adres. Je ziet precies wat je
  in de werkruimte ook mag zien. Staat Financiën voor je dicht, dan staat de app
  Financiën niet bij Instellingen → Apps. De boekhouder ziet daar alleen
  Financiën.
- **Alles werkt.** Een klant openen vanuit een factuur kan gewoon, in hetzelfde
  venster. Alleen het menu en de duimbalk zijn kleiner.
- **Gerrie en de teamchat** zweven ook in de app, net als in de werkruimte.
- **Terug naar de werkruimte**: onderaan het menu staat *Volledige werkruimte*.
  In een geïnstalleerde app opent die in een nieuw venster, zodat de app blijft
  staan waar hij was.

## Wat er anders is in een app

- Het menu toont alleen de pagina's van de app. Op de telefoon heeft de duimbalk
  de knoppen van de app (Financiën: Facturen, Offertes, Inkoop, Bank, Grootboek).
- Het kruimelpad begint bij het begin van de app (*Financiën › Offertes*) en niet
  bij het dashboard.
- Een app onthoudt zijn eigen tabbladen, los van de werkruimte. Tabbladen buiten
  de app (een klant die je vanuit Financiën opende) staan de volgende keer niet
  meer open: de app Agenda opent op de agenda.
- Een pushmelding komt in het venster waar hij over gaat: een mail of chat in
  Communicatie, een boeking in Agenda, een betaalde factuur in Financiën. Is die
  app niet open, dan in de werkruimte, zoals altijd.

## Hoe het werkt

- Een browser herkent een geïnstalleerde app aan zijn manifest: het `id` en de
  `scope`, het adres waaronder hij woont. Met één manifest kun je dus maar één
  app installeren. Daarom heeft elke app een eigen adres en een eigen manifest
  (`public/apps/*.webmanifest`). Google doet het met Docs, Sheets en Slides net
  zo.
- `src/lib/standaloneApps.ts` beschrijft de drie apps: adres, naam, pagina's,
  beginpagina en duimbalk. `main.tsx` leest bij het laden het adres, zet het
  manifest, de titel en het icoon in de `<head>`, en geeft de navigatie een
  `canOpenPage` die alleen de pagina's van de app doorlaat. De echte rechten,
  het laden en de pagina's zelf veranderen niet.
- `/app/agenda` zonder slash wordt `/app/agenda/`. Zonder slash valt de pagina
  buiten de scope van het manifest, en dan biedt de browser installeren niet aan.
- De iconen tekent `scripts/app-iconen.mjs` (gele tegel, teken uit lucide, binnen
  de veilige zone van een `maskable` icoon).
- De service worker (`public/sw.js`) kiest bij een klik op een melding het
  venster aan de hand van de tag (`chat:…`, `email:…`, `booking:…`,
  `invoice:…`). Voorheen pakte hij het eerste venster dat er was; met losse apps
  kon dat de app Agenda zijn, en dan opende een chatbericht in je agenda.

## Ook veranderd

- **Het opstartscript in `index.html`** zet in Baken ook op `/app/…` meteen het
  lichte thema, net als op `/`. Anders flitste een app bij elke start van donker
  naar licht. De hash in de CSP (`public/_headers`, twee regels) is mee
  veranderd; `scripts/check-csp-hash.mjs` controleert dat.
- **Berichten heeft een eigen icoon in de tabbalk** (het postvak). Het viel terug
  op hetzelfde icoon als Offertes.
- **Instellingen → Apps** is nieuw, ook voor de boekhouder.

## Beperking: inloggen in een app op de iPhone

Een app op het beginscherm van een iPhone of iPad heeft zijn eigen opslag, los
van Safari. Inloggen gaat met een link in je mail, en die opent in Safari: dan
ben je daar ingelogd en niet in de app. Dat gold al voor de werkruimte als app
en is niet nieuw. Op Android, Windows en de Mac (Chrome, Edge) delen app en
browser hun opslag, en ben je in de app meteen ingelogd. Oplossen kan met een
inlogcode in de mail naast de link; dat is een aparte wijziging.

## Getest

- `npm run typecheck`, `npm test` (1664 tests, waarvan 10 nieuw in
  `src/lib/standaloneApps.test.ts`: adressen, manifesten en iconen, pagina's per
  module, rechten van de boekhouder, de service worker, de uitleg per browser en
  het kruimelpad).
- `npm run test:mobile -- --theme=both`, met drie nieuwe pagina's
  (`app-agenda`, `app-financien`, `app-communicatie`) op telefoon, tablet en
  liggend.
- `npm run test:loading`.
- `npm run build`: de manifesten en iconen staan in `dist/`, en de hash van het
  opstartscript in de gebouwde `index.html` staat in `_headers`.
- Met de hand in Chromium: de drie apps in Baken en Zenit, het uitschuifmenu op
  de telefoon, Instellingen → Apps op desktop en telefoon. Titel, manifest en
  adres kloppen per app; geen fouten in de console.
