# Boekingspagina: mooier, in stappen, met het videogesprek erbij en de afspraak in het portaal (2026-11-11)

## Aanleiding

"De boekingspagina's vind ik alles behalve mooi. Maak de functionaliteit en
design van de boekingspagina veel mooier, moderner en overzichtelijker, ook met
het selecteren van tijdsloten in de agenda. Zorg dat de functie veilig is. De
klant dient ook op de eigen klantportaal de afspraak te zien. Via de
boekingslink moet ook duidelijk zijn of het een Jitsi, Google Meet of Teams
meeting moet zijn."

Gisteren is de keten nagelopen op veiligheid
(`CHANGELOG_BOEKINGSLINKS_2026-11-10.md`). Dit is de tweede ronde: hoe het
eruitziet en werkt, voor de klant en voor wie de momenten aanbiedt.

## De boekingspagina (wat de klant ziet)

Eerst stond alles op één lange pagina: alle dagen onder elkaar, elk met een rij
tijdknoppen, en het formulier eronder. Bij twintig momenten scrolde je op de
telefoon langs alles heen. Het videogesprek stond als één woord in een tegel,
en bij een vaste link stond er "Link volgt per mail": of het Teams of Meet was,
zag de klant pas in de bevestiging.

**Nu in drie stappen**, zoals de bekende planningsdiensten:

1. **Moment.** Links een maandkalender: de dagen waarop iets vrij is, zijn
   gekleurd, de gekozen dag is gevuld, en een dag waarop je al iets koos krijgt
   een stip. Rechts de tijden van die dag, met "tot 10:30" eronder. Onderaan je
   keuze als chip en de knop **Verder**. Op de telefoon staat in plaats van de
   kalender een strook met alleen de dagen waarop iets vrij is; de tijden staan
   drie naast elkaar, en onderaan blijft de balk met **Verder** in beeld.
2. **Gegevens.** Naam en e-mailadres, met ernaast een samenvatting: wanneer, hoe
   lang, welk videogesprek (met hoe je meedoet) en dat het Nederlandse tijd is.
   Met **Ander moment kiezen** of de pijl ga je terug; je keuze blijft staan.
3. **Bevestigd.** Een vinkje, de afspraak als kaart met een datumblok, de knop
   **Deelnemen via Microsoft Teams** (of Jitsi, of Meet) en **Zet in je agenda**:
   een `.ics`-bestand dat de browser zelf maakt.

**Welk videogesprek** staat nu overal bij naam en met een eigen kleur: in de
kop ("Videogesprek: Microsoft Teams"), in de samenvatting met hoe je meedoet
("Je doet mee via je browser of de Teams-app") en op de bevestiging. Ook een
vaste link wordt herkend: Teams, Google Meet, Zoom of Jitsi. Bewust geen logo's
van die diensten (die zijn van hen); een gekleurd vlak met een camera en de
naam.

Kleinere dingen:

- Een gekozen tijd verloor zijn kleur zolang de muis erop stond: de
  hover-regel was specifieker dan "gekozen". Nu blijft hij gevuld.
- Een gesloten, verlopen of volle link toont de afspraken als kaarten, elk met
  **Zet in je agenda**.
- De bevestigingsmail noemt de dienst ("Deelnemen via Microsoft Teams"), en de
  mail met de boekingslink zegt vooraf welk videogesprek het wordt.

## Tijdsloten kiezen in het beheer en de agenda

Eerst was elk getekend blok één moment. Wie een ochtend in halve uren wilde
aanbieden, sleepte zes keer precies op de rasterlijnen, en een sleep van 9.00
tot 12.00 uur gaf de klant één afspraak van drie uur.

- **Momenten van 15, 30, 45, 60 of 90 minuten**, met een pauze ertussen (geen,
  5, 10, 15 of 30 min), of **Zoals getekend**. Sleep je een dagdeel, dan wordt
  dat vanzelf momenten van die duur. Een klik zonder slepen is één moment. De
  keuze staat in het schermvullende rooster (Agenda → Boekingslinks) en bij
  **Beschikbaarheid** in de agenda, en blijft op je apparaat bewaard.
- **Herhaal volgende week**: de vrije momenten van de week in beeld komen er een
  week later nog eens bij, en het rooster springt mee.
- **Snel invullen met een weekpatroon**: dagen (ma t/m zo), van–tot, vanaf
  welke datum en hoeveel weken. Je ziet vooraf hoeveel momenten het worden
  ("24 momenten: ma t/m vr, 09:00–12:00, 2 weken"). Wat al begonnen is, valt
  weg.
- **Momenten per dag** als tijdchips (vrij in groen met een kruisje, geboekt
  met een slotje), met **Dag leegmaken**. Eerst een lange lijst met per regel
  een knop **Weghalen**. Eén moment met de hand kan nog, onder een uitklapper.
- **De videokeuze als kaarten**: Jitsi Meet, Google Meet, Microsoft Teams en
  Geen videogesprek. Wat hier niet kan, staat er ook, uitgegrijsd, met waarom
  en wat je eraan doet ("Zet het aan bij Instellingen → Agenda, bij je
  Microsoft-account"). In de keuzelijst ontbrak Teams eerst gewoon als het
  (nog) niet kon.
- De dienst staat ook bij elke link in de lijst en in de kop van de link.
- **De blokken in het rooster** hebben eigen opmaak met kleuren uit het palet.
  Eerst stond alles inline, met lichtgroene tekst op lichtgroen in Dag en emoji
  als teken.
- Bij **Klant** staat dat de klant zijn afspraken in zijn portaal ziet als je
  een klant kiest.

## De afspraak in het klantportaal

Een klant die via een boekingslink een afspraak maakte, zag hem daarna alleen
in zijn mail en zijn eigen agenda; wie de mail kwijt was, had ook de videolink
niet meer.

- **Tabblad Afspraken** (alleen als er afspraken zijn) en op het **Overzicht**
  de kaart **Komende afspraken**. Per afspraak een datumblok, wanneer en hoe
  lang, welk videogesprek, **Deelnemen** en **In agenda**.
- Een afspraak die het team annuleerde, staat er doorgestreept als **Gaat niet
  door** tot het moment voorbij is. Eerst hoorde de klant dat alleen als het
  team eraan dacht het te laten weten.
- **Geweest**: de afgelopen negentig dagen, ingeklapt.
- "Kun je niet? Stuur … een bericht" opent Berichten.
- Deeplink: `/portal?view=afspraken`.

## Veiligheid

- **Wie ziet welke afspraak in het portaal**: alleen boekingen van díe klant
  (`client_id`, bij het reserveren uit de link gezet, nooit uit wat de bezoeker
  invulde) in díe organisatie, via dezelfde controle als de rest van het
  portaal (het geverifieerde e-mailadres, het bereik van de inlog, geen
  teamleden). Een boeking via een link zonder klant komt in geen enkel portaal:
  het e-mailadres op de boekingspagina is niet gecontroleerd, en wie de link
  heeft, kan elk adres typen. De stromentest legt vast dat klant B de afspraak
  van klant A niet ziet.
- **Wat het portaal krijgt**: titel, tijden, stand, dienst en de naam van wie
  boekte. Geen e-mailadres, geen agenda- of interne gegevens. De videolink
  alleen bij een bevestigde afspraak die nog niet voorbij is.
- **De videolink bij de boeking** (`meeting_bookings.meeting_url`): alleen
  http(s), zonder spaties of stuurtekens, hooguit 2048 tekens. De functie
  controleert dat, de database ook (check-constraint), en het portaal en de
  pagina nog eens voor ze er een knop van maken. Opslaan gooit nooit: de
  afspraak staat dan al in de agenda, en een fout zou hem in `bookSlots` weer
  vrijgeven.
- **Hooguit 500 vrije momenten per link** die nog moeten komen. Meer toont de
  pagina niet, en met het weekpatroon zet je er in één klik tientallen op. Een
  vergissing ("elke dag, een jaar lang") geeft nu een melding met hoeveel er nog
  bij kunnen. Ook Gerrie loopt hierlangs (`booking_slot.add` gebruikt dezelfde
  functie).
- **Agenda-bestand**: elk veld ontsnapt (een regeleinde in een titel maakte er
  anders een eigen regel van, met bijvoorbeeld een andere begintijd), alleen een
  echte link komt mee, en het bestand ontstaat in de browser: er gaat niets
  naar een server.
- Ongewijzigd en nagekeken: de token (256 bits, alleen de hash bewaard), de rem
  per afzender en per link, reserveren onder een slot, de controle op de maker
  van de link, en `no-store` op het antwoord.

## Bestanden

- `supabase/migrations/20261111190000_boekingen_videolink.sql`: `meeting_url`
  en `video_service` op `meeting_bookings`, met controles, een index voor het
  portaal, en de link die er al was voor bestaande boekingen.
- `supabase/functions/_shared/meetingBookingRules.ts` (+ test): welke dienst
  (`bookingVideoService`, `videoKindOfUrl`) en de grens van 500.
- `supabase/functions/meeting-booking-public/index.ts`: `video_service` op de
  pagina, de videolink bij de boeking, de dienst in de bevestiging.
- `supabase/functions/meeting-booking/index.ts`: de grens, en de dienst in de
  mail met de link.
- `supabase/functions/client-portal/index.ts`: `appointments` per dossier.
- `supabase/functions/_shared/emailTemplates/meetingBooking{Confirmed,LinkSent}.ts`.
- `src/features/PublicBookingPage.tsx` en `src/styles/portal-cockpit.css` (8b).
- `src/features/MeetingBookingManager.tsx`, `src/features/CalendarPage.tsx`,
  `src/components/BookingVideoSelect.tsx`, `src/components/SlotDurationPicker.tsx`,
  `src/components/VideoServiceMark.tsx`.
- `src/features/portal/ClientPortal.tsx`, `src/lib/portalApi.ts`,
  `src/lib/portalConversations.ts`.
- `src/lib/bookingLinks.ts` (+ test): opdelen, weekpatroon, kalender,
  agenda-bestand en de dienst.
- `src/lib/exportManifest.ts`: de schemaversie (de twee kolommen gaan gewoon mee
  in de export).
- `tests/stromen/boekingslinks.mjs`, `tests/mobile/run.mjs` en de nagebootste
  backend.

## Getest

- `npm run typecheck`: schoon.
- `npm test`: 1572 tests, 0 fout. Nieuw: welk videogesprek (ook bij een vaste
  link), alleen http(s) als videolink, opdelen in momenten (met pauze, een
  klik, onzin), het weekpatroon (in drie tijdzones), de maandkalender, het
  agenda-bestand (een regeleinde in de titel wordt geen eigen regel) en de
  dienst van een link in het beheer.
- `deno check` op de 35 functies uit `frontend-checks.yml`, en op
  `client-portal` (staat niet in die lijst): schoon. Lokaal met deno uit npm en
  een import map naar npm, want esm.sh en deno.land zijn vanuit de cloudsessie
  niet bereikbaar.
- `supabase db start`: de hele keten vanaf nul, met de nieuwe migratie. De
  migratie draait daarna nog eens zonder fout. In SQL getoetst: een
  `javascript:`-link, een link met een regeleinde en een onbekende dienst worden
  geweigerd; een Teams-link niet. Het eenmalig rechtzetten neemt een Zoom-link
  van de boekingslink over (met de dienst erbij) en een `javascript:`-link niet.
- `npm run test:stromen -- boekingslinks`: 26 stappen, 0 fout. Nieuw: de
  videolink en de dienst bij de boeking, de pagina noemt de dienst, het portaal
  van klant A toont de afspraak (zonder e-mailadres) en dat van klant B niet,
  na annuleren "gaat niet door" zonder link, de mail met de link noemt het
  videogesprek, en de grens van 500 vrije momenten.
- `npm run test:stromen -- videovergadering rook beveiliging agenda`: 255
  stappen, 0 fout.
- `npm run test:mobile -- --theme=both`: 506 metingen, 0 problemen. Het eerste
  moment op de boekingspagina staat op de telefoon op 325px (grens 360; eerst
  324px). Nieuw gemeten: `portal-appointments` (`/portal?view=afspraken`), de
  eerste afspraak op 150px; de grens ligt 20% hoger (180px).
- `npm run test:loading`: geslaagd. Eén keer faalde één controle terwijl de
  volledige mobiele test en de stromentest tegelijk liepen; daarna los twee keer
  achter elkaar alles geslaagd.
- In Chromium doorgeklikt tegen de nagebootste backend (telefoon en laptop):
  - de boekingspagina: Teams in de kop, kalender of strook, dag wisselen,
    kiezen en vervangen, Verder, de samenvatting met hoe je meedoet, een fout
    e-mailadres, terug met behoud van je keuze, bevestigen, de knop
    "Deelnemen via Microsoft Teams" en het agenda-bestand met de Teams-link (33
    controles);
  - het beheer: het weekpatroon (alleen maandag, 9–11 uur, een uur, drie
    weken: zes momenten op maandag van een uur naar de server, en geen "Zoals
    getekend" bij het patroon) en slepen in het rooster van 13.00 tot 14.30 uur
    met "30 min": drie momenten (13.00, 13.30, 14.00).

## Na de uitrol

- De migratie en de drie functies (`meeting-booking-public`,
  `meeting-booking`, `client-portal`) gaan mee met *Deploy Supabase (staging)*.
  Er is geen nieuwe instelling of geheim nodig.
- Een app die nog niet ververst is, werkt gewoon met de nieuwe server (`video`
  blijft in het antwoord staan), en de nieuwe app met een oudere server ook (hij
  leidt de dienst dan af uit `video`).
