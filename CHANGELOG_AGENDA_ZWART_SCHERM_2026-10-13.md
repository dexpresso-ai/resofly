# Agenda: een afspraak openen gaf een zwart scherm (2026-10-13)

## Aanleiding

Wie in de agenda een afspraak aantikte, keek naar een zwart scherm. Niet alleen
het paneel bleef weg: de hele werkruimte verdween, inclusief menu en
onderbalk, en alleen herladen hielp. Gemeld op de telefoon, maar de desktop had
precies hetzelfde.

Het leek ook bij taken te gebeuren. Dat klopt voor wat je in de agenda als taak
ziet: een afspraak die bij een taak hoort — bijvoorbeeld via "Tijd reserveren"
aangemaakt, met de titel van de taak en een taakicoontje — opent hetzelfde
afspraakpaneel. Een taakblok zelf (en een taak vanuit het dashboard, de
weekplanner of de kanban) opende wel gewoon het taakvenster.

## Oorzaak

`CalendarEventDetailPanel` (`src/features/CalendarPage.tsx`) is altijd
gemount, ook als er geen afspraak open is; dan geeft het `null` terug via
`if (!event) return null`. Op 18 september kwam er een `useRef` bij
(`pendingInkNoteRef`, tegen een dubbele notitie bij een mislukte inktopslag),
maar ónder die vroege return. Bij een gesloten paneel riep React dus één hook
minder aan dan bij een open paneel, en bij de eerste afspraak die je opende
gooide het *"Rendered more hooks than during the previous render"*. De app
heeft geen error boundary, dus React haalde de hele boom weg en bleef alleen de
donkere achtergrond van de pagina over.

## Wat er is veranderd

- **`pendingInkNoteRef` staat nu bij de andere hooks**, boven de vroege
  return, met een opmerking waarom hij daar moet blijven.
- **Hij wordt leeggemaakt zodra je van afspraak wisselt**, in hetzelfde effect
  dat de rest van het paneel terugzet. Het paneel blijft tussen afspraken door
  gemount, dus anders kon een notitie die bij afspraak A achterbleef na een
  mislukte inktopslag de tekening van afspraak B krijgen. Binnen één afspraak
  werkt de bescherming zoals bedoeld: een tweede poging vult dezelfde notitie.

## Nieuwe controle

`tests/mobile/run.mjs` opent nu ook de agenda mét een afspraak open
(`calendar-event`) en mét een taak open (`calendar-task`), op telefoon, tablet
en liggend. Zonder deze fix faalt `calendar-event` op alle drie met
`js-fout: Rendered more hooks…` en `chrome 0px` (de hele app weg); met de fix is
alles groen. De lay-outmetingen zagen dit nooit, omdat ze alleen pagina's
openden en niets aantikten.

De voorbereidingsklik in die test valt terug op een directe klik op het element
als er iets overheen ligt. Op tabletformaat staat de muis van de testbrowser op
(0,0), waardoor de niet-vastgezette zijbalk openklapt over de eerste
agendakolom; een echte tablet heeft geen hover.

## Getest

- `npm run typecheck`, `npm test` (737 tests) en `npm run build` — schoon.
- `react-hooks/rules-of-hooks` over heel `src/` gedraaid: dit was de enige
  hook ná een vroege return in de app.
- Met Playwright tegen de nagebootste backend uit `tests/mobile/mock`, op
  telefoonformaat: een afspraak openen, sluiten en een andere openen; een
  afspraak met gekoppelde taak openen en via "Open taak →" het taakvenster in
  (met de agendasectie gevuld); een taak openen vanuit het dashboard, de
  agenda, de weekplanner en de kanban van een project; vanuit de weekplanner
  een afspraak aantikken en in de agenda openen. Overal het juiste venster, geen
  JavaScript-fouten. Vóór de fix liep elk pad met een afspraak vast op een leeg
  scherm, ook op desktop.
- `npm run test:mobile -- --pages=calendar,calendar-event,calendar-task,communication,settings-boekhouder`
  (telefoon, tablet, liggend) — 15 metingen, geen problemen; daarmee zijn ook
  de bestaande voorbereidingsklikken (`communication`, `settings-boekhouder`)
  na de aanpassing nagelopen.
