# Boekingsrooster: je afspraken uit al je agenda's in beeld, en geen moment eroverheen (2026-11-11)

## Aanleiding

"Bij het aanmaken van de boekingslink, wil ik dat je bij het openen van de
agenda, ook de afspraken van de resoflyagenda en de gekoppelde agenda's laat
zien zodat ik geen dubbele boeking kan maken."

## Wat er misging

Het schermvullende rooster van een boekingslink (Agenda → Boekingslinks →
**Rooster openen**) toonde alleen de afspraken uit de agenda waar de link in
boekt. Stond de link in je ResoFly-agenda, dan zag je je Google- of
Outlook-afspraken niet (en andersom). Een uur zag er vrij uit, je tekende er
een moment op, en koos de klant dat moment, dan had je twee afspraken
tegelijk.

De controle op de server keek ook alleen naar die ene agenda. Het
weekpatroon ("elke werkdag 9.00–12.00 uur") zette dus zonder waarschuwing
momenten over je Google-afspraken heen.

## Wat er nu klopt

**In het rooster** staan de afspraken uit al je agenda's: je ResoFly-agenda's,
je gekoppelde Google- en Microsoft-agenda's en je agenda-abonnementen (ICS),
elk in zijn eigen kleur. Boven het rooster staat welke agenda's meetellen, met
de agenda van de link voorop ("deze link"). Lukt het ophalen niet, dan staat
dat er ("Je afspraken konden niet worden opgehaald. Let zelf op dubbele
afspraken"). Eerst bleef het rooster dan stil leeg, en leek alles vrij.

**Geen moment over een afspraak**:

- Sleep je over een dagdeel waarin een afspraak staat, dan komen er alleen
  momenten op de vrije stukken. Boven het rooster staat wat er wegviel: "2
  momenten overgeslagen: dan heb je al een afspraak (Teamoverleg)."
- Hetzelfde bij het **weekpatroon** en bij **Herhaal volgende week**.
- **Eén moment met de hand** kan nog wel over een afspraak heen, met een
  waarschuwing. Dat is de uitweg voor wie het bewust wil, bijvoorbeeld over
  een blok "focustijd" dat mag wijken.
- Ook bij **Beschikbaarheid** in de Agenda (opties tekenen en doorsturen naar de
  klant) valt een optie over je eigen afspraak weg, en zegt het venster met de
  nieuwe link wat er niet op kwam.

**Wat telt als afspraak** (`slotClash` op de server, `clashingAppointment` in
de app; een test legt vast dat ze gelijk oplopen):

- alles in de agenda van de link, ook een afspraak van een hele dag. De
  boekingspagina weigert de klant dan ook ("Dit moment is net bezet geraakt"),
  dus zo'n moment aanbieden heeft geen zin;
- in je andere agenda's alleen afspraken met een tijd. Een verjaardag of
  feestdag in een gekoppelde agenda maakt je niet bezet;
- de agenda's van collega's tellen niet, ook als ze die met de organisatie
  delen: hun afspraken maken jou niet bezet. Ze staan ook niet in het rooster.

Wiens agenda's: die van wie de link maakte. Opent een collega jouw link, dan
ziet hij van jouw agenda's alleen wat je met de organisatie deelt (zoals in de
Agenda), en telt ook alleen dat mee.

## Kleinere dingen

- Het rooster haalt de afspraken pas op als het open is. Eerst ging er bij elke
  klik op een link in de lijst een vraag naar Google en Microsoft, ook als je
  het rooster niet opende.
- De kleuren in het rooster komen uit al je agenda's, ook die waarin ResoFly
  niet mag schrijven (een ICS-abonnement, een Google-agenda met alleen
  leesrecht). Eerst kende het rooster alleen de kleuren van de schrijfbare
  agenda's, en kreeg de rest het standaardgeel.
- De melding na het toevoegen telt wat er echt op kwam ("3 momenten
  toegevoegd"), niet wat je aanvroeg.
- Gerrie en de MCP-koppeling (`booking_slot.add`) waarschuwen nu ook voor een
  afspraak in je andere agenda's. Ze slaan niets over: een mens keurde die
  momenten goed.

## Wat (nog) niet verandert

De boekingspagina van de klant kijkt bij het boeken nog alleen naar de agenda
van de link. Komt er ná het aanbieden een afspraak in je Google-agenda op een
aangeboden moment, dan kan de klant dat moment nog kiezen. Dat is een aparte
keuze (een aangeboden moment vervalt dan zonder dat je het weet), dus niet
in deze wijziging.

## Bestanden

- `supabase/functions/_shared/meetingBookingRules.ts` (+ test): `slotClash`.
- `supabase/functions/meeting-booking/index.ts`: `addSlots` kijkt naar alle
  agenda's van de maker van de link, en slaat met `skipClashes` over in plaats
  van te waarschuwen. Het maximum van 500 vrije momenten telt pas daarna.
- `supabase/functions/_shared/actions/calendar.ts`: de uitleg bij
  `booking_slot.add`.
- `src/lib/bookingLinks.ts` (+ test): `bookingGridSources`,
  `clashingAppointment` en `clashNotice`.
- `src/lib/meetingBookingApi.ts`: `skipClashes` en `clashes`.
- `src/features/MeetingBookingManager.tsx`: het rooster, de legenda en de
  meldingen.
- `src/features/CalendarPage.tsx`: Beschikbaarheid in de Agenda.
- `src/styles/globals.css`: de legenda en de melding.
- `tests/stromen/boekingslinks.mjs`: de nieuwe stap.

## Getest

- `npm run typecheck`: schoon.
- `npm test`: 1594 tests, 0 fout. Nieuw: welke afspraak botst (de agenda van de
  link, je andere agenda's, geen hele dag daar, geen collega), dat de app en de
  server dezelfde regel volgen, welke agenda's in het rooster staan, en de
  melding over overgeslagen momenten.
- `deno check` op de 35 functies uit `frontend-checks.yml`: schoon. Lokaal met
  deno uit npm en een import map naar npm, want esm.sh en deno.land zijn vanuit
  de cloudsessie niet bereikbaar.
- `npm run test:stromen -- boekingslinks`: 27 stappen, 0 fout. Nieuw: een
  afspraak in een tweede ResoFly-agenda van de maker staat in wat het rooster
  ophaalt; tekenen slaat dat moment over ("Tandarts"); een afspraak in de
  gedeelde agenda van een collega telt niet; met de hand komt het moment erop,
  met een waarschuwing.
- `npm run test:stromen -- videovergadering agenda`: 87 stappen, 0 fout.
- `npm run test:mobile -- --theme=both`: 506 metingen, 0 problemen.
- `npm run test:loading`: alle controles geslaagd.
- In Chromium doorgeklikt tegen de nagebootste backend, met een extra
  Google-agenda en de gedeelde agenda van een collega (laptop en telefoon,
  licht en donker, 24 controles): de legenda noemt de ResoFly- en de
  Google-agenda en niet die van de collega; de Google-afspraak staat in het
  rooster, die van de collega niet; geen horizontale scroll; slepen over de
  Google-afspraak vraagt `skipClashes` en het rooster meldt "1 moment
  overgeslagen: dan heb je al een afspraak (Tandarts (Google))". Op de telefoon
  brak "Afspraken uit" eerst over twee regels; nu één regel die zijwaarts
  schuift.

## Na de uitrol

- `meeting-booking` gaat mee met *Deploy Supabase (staging)*. Geen migratie,
  geen nieuwe instelling of geheim.
- Een app die nog niet ververst is, werkt gewoon met de nieuwe server (zonder
  `skipClashes` krijgt hij waarschuwingen, zoals eerst). De nieuwe app met een
  oudere server ook: die negeert `skipClashes` en geeft waarschuwingen terug,
  en de app meldt die.
