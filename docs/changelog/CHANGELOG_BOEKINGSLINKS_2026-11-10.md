# Boekingslinks: veilig, kloppend en duidelijk voor de klant (2026-11-10)

## Aanleiding

"Controleer of de boekingslinks op een juiste en veilige manier worden gedaan.
Verfraai de UX daarbij zodat de user experience ten goede komt. Ook op de
klantpagina moet dit duidelijk naar voren komen."

Een boekingslink is een geheime link (zoals Calendly) waarmee een klant zelf
een moment kiest uit de tijden die je aanbiedt. De afspraak komt dan meteen in
je agenda. Ik heb de hele keten nagelopen: de database, de beheerfunctie
`meeting-booking`, de publieke functie `meeting-booking-public`, de
handelingen van Gerrie en de schermen.

## Wat al goed was

- De link is niet te raden: 32 willekeurige bytes (256 bits). De database
  bewaart alleen de SHA-256-hash; de link zelf staat nergens leesbaar.
- Reserveren gebeurt atomisch, onder een slot per link, met een unieke index
  op één lopende boeking per moment. Twee klanten kunnen hetzelfde moment niet
  tegelijk boeken.
- Elke handeling in het beheer filtert op de organisatie uit de sessie, en de
  database-functies mag alleen de service-role aanroepen.
- Een link van organisatie A opent niet op het klantadres van organisatie B.
- De boekingspagina staat niet in zoekmachines (`X-Robots-Tag`). Een andere
  site kreeg via de algemene `Referrer-Policy` al alleen het adres van ResoFly
  te zien, niet de link zelf.
- Gerrie en een gekoppelde AI zetten boekingshandelingen alleen klaar; een
  mens keurt goed, met zijn eigen rechten.

## Wat er misging, en wat er nu klopt

### 1. Een poging die bleef hangen, hield de link voorgoed dicht

Viel de publieke functie om tussen reserveren en afronden, dan zette de
"zelfherstellende" opruiming na twee minuten alleen het moment terug op vrij.
De boeking zelf bleef op `pending` staan, en die telde voorgoed mee. Bij een
link voor één afspraak (de standaard) kon daarna niemand meer boeken
("maximum bereikt"). Het vrijgekomen moment gaf bij elke poging een fout,
want de unieke index staat maar één lopende boeking per moment toe.

Nagespeeld tegen de oude functie op een lokale database:

```
OUD: opnieuw boeken faalt: Het maximum aantal boekingen voor deze link is bereikt.
OUD: ook met maximum 3 faalt hetzelfde blok: Het maximum aantal boekingen in die week is bereikt.
```

**Nu**: een poging die na tien minuten nog loopt, gaat op `failed` en het
moment komt vrij (`release_stale_meeting_bookings`). Waarom tien en niet
twee minuten: een edge function draait hooguit 400 seconden. Wat dan nog
loopt, is zeker dood. Bij twee minuten kon een trage agenda-aanroep zijn eigen
moment nog kwijtraken terwijl hij het boekte. Het beheer ruimt hetzelfde op
bij het openen van de lijst, bij het verwijderen en bij het annuleren. De
migratie zet wat nu al vastzit eenmalig recht.

### 2. Een moment dat al begonnen was, kon nog geboekt worden

De boekingspagina toonde een moment tot het eind ervan, en reserveren keek
niet naar de begintijd. Om 10.20 uur kon een klant het moment van 10.00 uur
nog boeken. **Nu** toont de pagina alleen momenten die nog moeten beginnen,
en weigert de database de rest: "Dit moment is al voorbij." Ook in het
verleden toevoegen kan niet meer (scherm, server en Gerrie). Een moment van
meer dan twaalf uur wordt geweigerd: dat is vrijwel zeker een vergissing.

### 3. De link van een oud-teamlid boekte gewoon door

Een boeking zet de afspraak in de agenda namens wie de link maakte, met diens
koppeling. Was die persoon geen actief teamlid meer, of mocht hij niet meer in
de Agenda schrijven, dan werkte zijn link toch door. **Nu** kan een link nooit
meer dan zijn maker (dezelfde regel als bij de agents). De database controleert
het bij elke reservering. De klant ziet "Deze link is niet meer beschikbaar",
met de contactgegevens van de organisatie. Het beheer zegt waarom
("Niet beschikbaar") en weigert de link nog te mailen.

### 4. Annuleren kon het moment van een ander openzetten

`cancel_meeting_booking` zette het moment altijd terug op vrij, ook bij een
boeking die al mislukt was. Had iemand anders dat moment intussen geboekt, dan
stond het weer open en kon het een tweede keer geboekt worden. **Nu**
annuleert de functie alleen een bevestigde boeking, en gaat het moment alleen
terug als er geen andere lopende boeking op staat. Een boeking die nog
verwerkt wordt of nooit doorging, geeft een uitleg in plaats van een fout.

### 5. Kleinere dingen

- **Rem op misbruik**: de publieke pagina mag 120 keer per tien minuten per
  afzender openen. Boeken mag 20 keer per tien minuten per afzender en 30 keer
  per uur per link. Dat telt via de bestaande teller van de portal-login, met
  eigen sleutels.
- **Invoer**: een naam zonder stuurtekens (een regeleinde in een naam kwam in
  de titel van de afspraak en in de melding), hooguit 160 tekens. Een
  e-mailadres in kleine letters, hooguit 254 tekens. Een NUL-teken geeft een
  nette melding in plaats van een serverfout. Twee keer hetzelfde moment
  kiezen telt één keer.
- **Geldigheid**: hooguit 365 dagen. Eerst gaf 1e9 dagen een serverfout, en
  maakte 100.000 dagen een link die nooit verliep.
- **Gaat niet naar buiten**: de hash van de token stuurt het beheer niet meer
  mee naar de app (`has_token` zegt genoeg). Het antwoord van de publieke
  pagina krijgt `Cache-Control: no-store`, en `/booking/*` krijgt
  `Referrer-Policy: no-referrer`, net als `/ontvang/*`.
- **Lezen met leesrecht**: wie de Agenda alleen mag lezen, ziet nu de links
  en afspraken (de database gaf ze hem al). Maken, wijzigen en mailen vraagt
  schrijfrecht, zoals altijd.
- **Een link op een alleen-lezen agenda** (een ICS-abonnement, of Google
  zonder schrijfrecht) kan niet meer: eerst faalde pas de boeking van de klant.
- **Mailen naar een lege pagina** kan niet meer: een gesloten, verlopen of
  niet-beschikbare link, of een link zonder vrije momenten, wordt geweigerd met
  uitleg.
- **Botsing bij het boeken**: stond er intussen een afspraak op dat moment,
  dan gaat het moment op vervallen. Eerst ging het weer open, en liep de
  volgende klant tegen dezelfde botsing aan.
- **Foutmeldingen**: eigen zinnen uit de database (week vol, al voorbij, net
  gekozen) komen nu bij de klant aan. Eerst kreeg hij altijd "Dit moment kon
  niet worden geboekt". In het beheer las de app de uitleg van de server niet
  uit (`error.context.body` bestaat niet bij supabase-js), en zag je "Edge
  Function returned a non-2xx status code".
- **Vangnet in de database**: een moment en een boeking horen bij een link van
  dezelfde organisatie (triggers).

## De klantpagina (wat de klant ziet)

De boekingspagina is nu een klantpagina zoals de offerte en de factuur:

- **In de huisstijl** van de organisatie: logo, kleuren, letters en de
  afsluiting. Bovenaan staat "Afspraak met \<bedrijf\>", de titel, de tekst, en
  twee tegels: **hoe lang** en **hoe** ("Videogesprek via Jitsi Meet"). Eerst
  was het een kale kaart zonder afzender.
- **Momenten per dag**, als een rij tijdknoppen (10:00, 10:30 …), zoals in een
  agenda. Eerst was elk moment een brede knop met de hele datum erop.
- **De week telt in Nederlandse tijd**, net als de weeklimiet in de database.
  Een klant in een andere tijdzone zag anders een andere week.
- **Kiezen**: mag de klant één moment kiezen, dan vervangt een klik op een
  ander moment de keuze. Eerst stond de rest grijs zonder uitleg. De gekozen
  momenten staan als chips bij "Je gegevens", met een kruisje om weg te halen.
- **Op de telefoon** staat onderaan een balk met de keuze en de knop **Verder**,
  die naar het formulier springt.
- **Na het boeken**: "Je afspraak staat vast", met dag, tijd, duur, de
  videolink en wat er nu gebeurt (bevestiging per mail, uitnodiging voor de
  agenda). De nieuwe stand wordt meteen opgehaald. Kiest de klant daarna nog
  een moment, dan staan de net geboekte momenten er niet meer als vrij tussen.
- **Gesloten, verlopen, vol of niet beschikbaar**: een eigen scherm dat zegt
  wat er aan de hand is en bij wie de klant terechtkan (mail, telefoon,
  website). Wie de link later nog eens opent, ziet zijn afspraak staan.
- Een **onbekende link** zegt dat er misschien een nieuwe link is verstuurd.

## De klantpagina in ResoFly (klantdossier)

Op het **Overzicht** van een klant staat bovenaan de kaart **Afspraken**. Op
de telefoon is dat het eerste na de tabbladen:

- **Komt eraan**: de afspraken die de klant via een boekingslink maakte.
- **Boekingslinks** van deze klant, elk met hun stand (Open, Volgeboekt,
  Gesloten, Verlopen, Niet beschikbaar), "1/2 geboekt", het aantal vrije
  momenten en de geldigheid.
- **+ Boekingslink** opent Agenda → Boekingslinks met een nieuwe link voor deze
  klant (klant en titel staan al ingevuld). Een klik op een link opent die
  link.

Je ziet de kaart als je de Agenda mag lezen. Zonder dat recht staat hij er
niet (harde regel 3).

## Het beheer (Agenda → Boekingslinks)

- Elke link heeft een **stand** in één woord, en de detailkaart zegt in één
  zin wat dat voor de klant betekent. Een voorbeeld: "De link werkt, maar er
  staan geen vrije momenten op: de klant ziet een lege pagina."
- **Geldigheid** ("Verloopt over 10 dagen") met de knop **Verlengen**: dan
  werkt **dezelfde** link langer, of weer. Eerst kon dat alleen met een
  nieuwe link, en die maakte de link in de mail van de klant ongeldig.
- **Delen**: kopiëren met "Gekopieerd", **Bekijk als klant**, en een
  mailformulier met ontvanger en aanhef. Zonder klant kon je eerst niet mailen.
  Is de link niet meer in beeld (we bewaren hem niet leesbaar), dan zegt
  **Nieuwe link mailen** vooraf dat de oude link daarna niet meer werkt.
- **Nieuwe link maken** vraagt eerst om bevestiging, en wijst op
  **Verlengen** als de link alleen verlopen is.
- **Momenten**: komende en voorbije apart, statussen in het Nederlands (de
  status van een boeking stond er in het Engels: "confirmed"). Wat er al stond,
  wordt overgeslagen met een melding.
- **Afspraken**: komend en geweest apart. **Annuleren** vraagt eerst om
  bevestiging en zegt dat je de klant zelf moet laten weten dat de afspraak
  niet doorgaat.
- **Verwijderen** met afspraken erop: de uitleg raadt aan de link te
  **sluiten**. Dan blijven de afspraken bewaard.

## Bestanden

- `supabase/migrations/20261110030000_boekingslinks_veilig.sql`: de opruiming,
  reserveren (begintijd, maker, invoer), annuleren, triggers voor de
  organisatie, en het eenmalige rechtzetten.
- `supabase/functions/_shared/meetingBookingRules.ts` (+ test): de regels die
  beide functies delen.
- `supabase/functions/meeting-booking-public/index.ts`: de stand, de huisstijl
  en het contact, de rem, de controle op de maker en de foutmeldingen.
- `supabase/functions/meeting-booking/index.ts`: lezen met leesrecht,
  Verlengen, een lijst per klant, mailen met voorwaarden, geen momenten in het
  verleden, en geen dubbele momenten.
- `supabase/functions/_shared/actions/calendar.ts`: Gerrie volgt dezelfde
  regels (geen verleden, de maker moet nog kunnen boeken).
- `src/lib/bookingLinks.ts` (+ test): woorden, tijden en weken voor de drie
  schermen.
- `src/features/PublicBookingPage.tsx`, `src/features/MeetingBookingManager.tsx`,
  `src/components/ClientBookingLinks.tsx` en `src/features/Clients.tsx`.
- `tests/stromen/boekingslinks.mjs`: het nieuwe scenario.

## Getest

- `npm run typecheck`: schoon.
- `npm test`: 1419 tests, 0 fout (nieuw: `meetingBookingRules.test.ts`,
  `bookingLinks.test.ts`).
- `deno check` op de 35 functies uit `frontend-checks.yml` en de twee gedeelde
  bestanden: schoon. Lokaal via een import map naar npm, want esm.sh en
  deno.land zijn vanuit de cloudsessie niet bereikbaar.
- `supabase db start`: de hele keten vanaf nul, met de nieuwe migratie.
- Twaalf controles in SQL op de nieuwe functies: voorbij moment, een poging
  die blijft hangen, annuleren, een andere organisatie, een oud-teamlid, een
  teamlid met alleen leesrecht, invoer, de triggers, en de rechten (anon en
  authenticated mogen niets). Plus het nagespeelde oude gedrag hierboven.
- `npm run test:stromen -- boekingslinks`: 22 stappen, 0 fout.
- `npm run test:stromen -- videovergadering`: 51 stappen, 0 fout.
  `rook beveiliging agenda`: 203 stappen, 0 fout.
- `npm run test:mobile -- --theme=both`: 440 metingen, 0 problemen. De
  boekingspagina houdt het eerste moment op de telefoon op 356px (grens 360),
  ook met de nieuwe kop. De klantpagina en het beheer hebben nu echte
  boekingslinks in de nagebootste backend.
- In Chromium doorgeklikt tegen die backend:
  - de boekingspagina: kiezen, wisselen, Verder, een fout e-mailadres,
    bevestigen, en de schermen voor gesloten, verlopen en vol (23 controles);
  - de klantpagina: de kaart Afspraken, een link openen, Verlengen, en
    "+ Boekingslink" met de klant en de titel al ingevuld (11 controles).
- `npm run test:loading`: alle controles geslaagd. `npm run build`: geslaagd.

## Na de uitrol

- De migratie draait via *Deploy Supabase (staging)*. De twee functies gaan
  met dezelfde workflow mee.
- Er is geen nieuwe instelling of geheim nodig.
