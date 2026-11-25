# Een meeting uit de agenda komt vanzelf in Inhoud (2026-11-24)

## Wat er nu kan

Neem je een meeting op bij een afspraak in de agenda, dan zet ResoFly hem na het
uitschrijven **vanzelf** in Inhoud:

- bij de klant van de afspraak in de map **Meetings**. Hangt er geen klant aan de
  afspraak, dan in de map **Meetings** onder **Geen klant**. Bestaat de map nog niet,
  dan maakt ResoFly hem; een volgende meeting gaat in dezelfde map;
- als notitie van het soort Meeting, met de titel van de afspraak en de dag:
  *"Kennismaking Bakkerij Jansen — 24 november 2026"*;
- met de notulen als tekst, en in de notitie de wissel naar het **volledige
  transcript**;
- ook onder **Notities** bij de afspraak.

Er komt geen vraag meer. Dat gebeurt ook als je het venster al hebt gesloten of de
browser dicht is: de server doet het op het moment dat het transcript binnenkomt.

Op de opnamekaart zie je waar je aan toe bent:

- tijdens het uitschrijven: *"Komt na het uitschrijven vanzelf in Inhoud, in de map
  Meetings."*;
- daarna: *"Staat in Inhoud, in de map Meetings."* met **Openen**;
- staat hij er niet (een opname van vóór vandaag, of je wiste de notitie in
  Inhoud): de knop **Opslaan in Inhoud**.

## Wanneer niet

- **Bij een privé-afspraak.** De notulen van een privé-afspraak horen niet ongemerkt
  in de gedeelde Inhoud. De app vraagt het alleen bij een gedeelde afspraak, en de
  server kijkt zelf nog eens of de agenda gedeeld is.
- **Voor wie Inhoud niet mag wijzigen.** De opname en de notulen lukken gewoon; de
  meeting komt alleen niet in Inhoud. De server controleert dat bij het opnemen én
  bij het uitschrijven, met de rechten van wie de opname maakte. Wie intussen zijn
  recht op Inhoud kwijt is, zet er dus ook niets meer in.
- **Bij een telefoongesprek of een notitie.** Een gesprek hoort bij het klantdossier,
  een notitie-opname staat al in Inhoud.

## Waarom zo

- **Eerst vroeg de kaart erom** ("Ook opslaan in Inhoud?", sinds vanochtend). Die
  vraag kwam alleen als je de afspraak open had op het moment dat het transcript
  binnenkwam. Liep het uitschrijven op de achtergrond door (je sloot het venster, of
  de webhook van ElevenLabs kwam later), dan stond de meeting nergens in Inhoud,
  totdat iemand de afspraak weer opende en op Opslaan klikte.
- **Inhoud komt vóór de notulen.** De meeting staat er zodra het transcript er is,
  ook als de notulen moeten wachten (AI-tegoed op) of de functie tijdens het
  samenvatten stopt. De notitie zegt dan "De notulen zijn nog niet gemaakt", en vult
  ze in zodra ze er zijn. Heb je de notitie intussen zelf bewerkt, dan blijft jouw
  tekst staan (dat gold al).
- **Wat de app bij het opnemen wist, staat op de opname.** Op het moment van
  uitschrijven is er geen browser meer. Daarom gaan de vraag om Inhoud, de dag van de
  afspraak (voor de titel) en het begin en eind (voor de koppeling onder Notities)
  mee bij het aanmaken van de opname.
- **Twee meetings van dezelfde klant tegelijk klaar** gaven elk een eigen map
  Meetings. Na het maken kijkt de server nog eens: de oudste map wint, en de andere
  (nog lege) map verdwijnt weer.
- **De koppeling onder Notities legt nu de server**, zowel vanzelf als met de knop.
  Eerst deed de app dat na de klik; vanzelf is er geen app.

## Wat er veranderd is

- `supabase/migrations/20261124170000_meeting_automatisch_in_inhoud.sql`: op
  `meeting_recordings` de kolommen `save_to_content`, `meeting_date`,
  `event_starts_at` en `event_ends_at`, en de check dat alleen een opname bij een
  afspraak om Inhoud kan vragen.
- `supabase/functions/_shared/meetingInhoud.ts` (nieuw): map, notitie en koppeling
  maken (`saveMeetingToContent`), en de automatische weg met de controle op rechten
  en agenda (`autoSaveMeetingToContent`). Wat eerst in `meeting-transcribe` stond,
  staat nu hier, zodat de knop en de automatische weg hetzelfde doen.
- `supabase/functions/_shared/meetingNote.ts`: `autoSaveRefusal` (wanneer het
  vanzelf mag), `validDay` en `validTime`.
- `supabase/functions/_shared/meetingPipeline.ts`: na het opslaan van het transcript
  eerst Inhoud, dan de notulen. Geldt voor de synchrone route en de webhook.
- `supabase/functions/meeting-transcribe`: `create` neemt `saveToContent`,
  `meetingDate`, `eventStartsAt` en `eventEndsAt` aan (alleen bij een afspraak, en
  alleen met schrijfrecht op Inhoud). `saveToContent` (de knop) gebruikt de gedeelde
  code en neemt ook begin en eind van de afspraak aan, voor een oude opname.
- `src/components/MeetingRecorder.tsx`: de vraag is weg; de kaart toont
  `InhoudStatus`. De recorder stuurt de afspraakgegevens mee. Maakte de server de
  notitie buiten de app om, dan ververst de kaart één keer, zodat de notitie onder
  Notities staat en **Openen** werkt.
- `src/features/CalendarPage.tsx`: geeft de dag, het begin en het eind van de
  afspraak mee; de koppeling legt de server.
- `src/lib/meeting-api.ts`, `src/types.ts`: de nieuwe velden.
- `src/lib/exportManifest.ts`: schemaversie naar 20261124170000 (de kolommen gaan
  met de tabel mee).

## Getest

- `npm run typecheck`, `npm test` (2282 tests, 0 mislukt). Nieuw in
  `meetingNote.test.ts`: wanneer het vanzelf mag (rollen, Agenda- en Inhoudrechten,
  een onbekende rol, privé-agenda, gesprek, notitie) en de dag en tijd uit de
  aanvraag.
- `npm run test:stromen -- notulen` met de echte edge functions tegen de lokale
  stack: 54 stappen, 0 fout. Nieuw scenario *de meeting komt vanzelf in Inhoud*:
  - na het uitschrijven bij klant A in de map Meetings, met titel, dag, notulen en
    de koppeling onder Notities;
  - een tweede meeting in dezelfde map (ook als die intussen "meetings" heet);
  - zonder klant onder Geen klant; zonder dag van de afspraak de opnamedag;
  - niet uit een privé-agenda, niet voor wie Inhoud alleen mag lezen (ook niet met
    de knop), niet als het recht tussen opnemen en uitschrijven dichtging, niet bij
    een notitie-opname;
  - een oude opname via de knop, en de knop na het wissen van de notitie;
  - het tegoed op na het transcript: de notitie staat er met "notulen volgen", en
    krijgt de notulen zodra die er zijn;
  - via de webhook: de notitie komt pas als het transcript binnen is.
  Met de automatische stap uitgeschakeld vallen 8 van deze stappen om.
- `tests/database/meeting_vanzelf_in_inhoud.sql`: standaard niet, alleen bij een
  afspraak (een notitie- of gespreksopname wordt geweigerd), en een lid kan het niet
  zelf aanzetten. `supabase start` bouwde de keten vanaf nul met de nieuwe migratie;
  daarna nog eens erover (veilig opnieuw). `npm run test:database`: alle 10 bestanden
  geslaagd.
- `deno check` op `meeting-transcribe` en `meeting-transcribe-webhook` (met alles
  wat ze uit `_shared` laden): geen fouten. esm.sh en deno.land zijn in de sessie
  niet bereikbaar; daarom Deno 2.9 uit npm, met supabase-js 2.45.0 (dezelfde versie
  als de esm.sh-import) via een import map. CI draait de echte lijst bij de push.
- `npm run test:mobile -- --theme=both`, de volledige ronde: 920 pagina's gemeten,
  0 met problemen.
- In Chromium tegen de nagebootste backend van de schermtest: de drie standen op de
  kaart (komt vanzelf, staat erin, de knop), telefoon en desktop, licht en donker;
  geen JavaScript-fouten en geen zijwaartse overloop.
- Niet hier getest: een echte opname met ElevenLabs op staging. Doe na de uitrol een
  korte opname bij een gedeelde afspraak met een klant, en kijk of hij in de map
  Meetings van die klant staat.
