# Meeting uit de agenda opslaan in Inhoud (2026-11-24)

## Wat er nu kan

Is een meeting uit de agenda getranscribeerd, dan vraagt de opnamekaart:

> **Ook opslaan in Inhoud?**
> De meeting komt dan bij *Bakkerij Jansen* in de map Meetings, met de notulen en
> het volledige transcript.
> [Opslaan in Inhoud] [Nee, niet nu]

Zeg je ja, dan:

- komt er bij de klant van de afspraak een map **Meetings** in Inhoud, bovenin op
  klantniveau. Hangt er geen klant aan de afspraak, dan komt de map onder **Geen
  klant**. De map wordt één keer gemaakt; een volgende meeting gaat in dezelfde map,
  ook als iemand hem "meetings" noemde;
- komt daarin een notitie van het soort Meeting met de titel van de afspraak en de
  datum: *"Kennismaking Bakkerij Jansen — 24 november 2026"*. Je vindt een meeting
  dus terug op naam en op dag;
- hangt de notitie ook onder Notities bij de afspraak, zoals de oude knop deed;
- zegt de kaart "Staat in Inhoud, in de map Meetings", met een knop om de notitie
  te openen. De klant staat er bewust niet bij: die kan na het opslaan aan de
  afspraak veranderen, terwijl de notitie blijft waar hij is.

De vraag komt alleen bij een gedeelde afspraak en alleen voor wie Agenda én Inhoud
mag wijzigen. Dat is dezelfde regel als bij de oude knop. De notulen van een
privé-afspraak horen niet ongemerkt in de gedeelde Inhoud.

In de notitie wissel je tussen **Notulen** en **Volledig transcript**. De notulen
zijn de tekst van de notitie: die kun je bewerken en delen zoals elke notitie. Het
transcript laat per beurt zien wie wat zei.

"Nee, niet nu" onthoudt de kaart (in deze browser). De vraag verdwijnt dan, en er
blijft een knop **Opslaan in Inhoud** staan voor later.

## Waarom zo

- **Wie Inhoud mag zien, ziet ook het transcript.** Een opname bij een afspraak viel
  alleen onder Agenda. Staat hij in Inhoud, dan mag ook wie Inhoud kan lezen het
  transcript lezen. Wie Inhoud niet heeft, ziet hem alleen via de agenda, zoals
  altijd. De database dwingt dat af (de leesregel op `meeting_recordings`).
- **Het transcript staat één keer opgeslagen**: op de opname. De notitie toont het via
  de koppeling. Een kopie in de notitie zou blijven staan als iemand de opname in de
  agenda wist. Wis je de opname, dan verdwijnt het transcript dus ook uit Inhoud. De
  notitie met de notulen blijft staan.
- **Wis je de notitie in Inhoud**, dan blijft de opname bij de afspraak; de kaart
  vraagt dan opnieuw of hij in Inhoud moet.
- **Schrijfrecht op Agenda én Inhoud.** De service-role slaat RLS en de modulepoort
  over, dus de edge function controleert beide zelf. Wie alleen Agenda heeft, krijgt
  de vraag niet en kan via de API ook niets in Inhoud zetten.
- **Komen de notulen later** (AI-tegoed op, of ze worden nog gemaakt), dan staat er
  in de notitie "De notulen zijn nog niet gemaakt". Zodra de notulen er zijn, vult
  ResoFly ze in. Worden de notulen opnieuw gemaakt, dan krijgt de notitie de nieuwe.
  Dat gebeurt alleen als er nog staat wat ResoFly er zelf in zette. Heb je de notitie
  bewerkt, dan blijft jouw tekst staan.
- **De datum is die van de afspraak**, zoals je hem in de agenda ziet. Een meeting die
  je 's avonds pas laat uitschrijven, krijgt dus toch de goede dag.
- **De knop "Opslaan als notitie" is weg uit de agenda.** Die zette de notulen los bij
  de klant, zonder map, zonder datum in de titel en zonder transcript. Een meeting
  was daardoor later lastig terug te vinden. "Toevoegen aan notitie of document"
  blijft.

## Wat er veranderd is

- `supabase/migrations/20261124100000_meeting_in_inhoud.sql`:
  `meeting_recordings.content_note_id` (set null als de notitie weg is, één notitie
  per opname). De verwijzing moet naar een notitie van dezelfde organisatie wijzen.
  Een notitie-opname krijgt er geen tweede notitie bij. De leesregel laat wie Inhoud
  kan lezen een opgeslagen meeting zien, nog steeds één keer per query.
- `supabase/functions/meeting-transcribe`: nieuwe actie `saveToContent`. Die zoekt de
  map Meetings of maakt hem, en maakt de notitie. Daarna koppelt hij de notitie aan
  de opname. Tweemaal klikken geeft geen tweede notitie.
- `supabase/functions/_shared/meetingNote.ts`: de mapnaam, de titel, de datum en de
  tekst van de notitie (de tekst is escaped: wat uit de opname komt, is gegevens).
- `supabase/functions/_shared/meetingPipeline.ts`: nieuwe notulen gaan ook naar de
  notitie, zolang die niet met de hand is bewerkt.
- `src/components/MeetingRecorder.tsx`: de vraag op de kaart (`InhoudVraag`).
- `src/components/MeetingNoteViews.tsx`: de wissel Notulen / Volledig transcript in
  het notitievenster.
- `src/features/CalendarPage.tsx`: geeft de plek ("bij <klant>" of "onder Geen
  klant") en de dag van de afspraak mee, en hangt de notitie aan de afspraak.
- `src/lib/exportManifest.ts`: schemaversie naar 20261124100000 (de kolom gaat met de
  tabel mee in de export).

## Getest

- `supabase/functions/_shared/meetingNote.test.ts`:
  - titel en datum, ook bij een lege of te lange titel;
  - de dag op Nederlandse tijd (kwart over elf 's avonds UTC is de volgende dag);
  - de notulen zonder lege onderdelen;
  - HTML uit de opname wordt tekst;
  - "notulen volgen" zolang er niets is.
- `tests/database/meeting_in_inhoud.sql`:
  - wie ziet wat: met alles, zonder Inhoud, zonder Agenda, een andere organisatie;
  - de leesregel blijft één keer per query;
  - de regels op de tabel: geen notitie van een andere organisatie, één notitie per
    opname, geen tweede notitie bij een notitie-opname;
  - een lid kan niet zelf koppelen;
  - na het wissen van de notitie blijft de opname staan.
- `supabase db start`: de hele keten vanaf nul, en de migratie nog een keer erover
  (veilig opnieuw). `npm run test:database`: alle 9 bestanden geslaagd.
- `npm run typecheck`, `npm test` (2250 tests, 0 mislukt).
- `deno check` kon in de sessie niet draaien: esm.sh en deno.land zijn er niet
  bereikbaar. Daarom zijn `meeting-transcribe`, `meetingPipeline.ts` en
  `meetingNote.ts` met `tsc --strict` gecontroleerd (supabase-js uit node_modules).
  Dat gaf geen fouten. CI draait de echte `deno check`.
- In Chromium tegen de nagebootste backend van de schermtest:
  - de vraag, opslaan en de bevestiging op de kaart;
  - de wissel in de notitie, heen en terug;
  - telefoon en desktop, donker en licht;
  - geen JavaScript-fouten en geen zijwaartse overloop.
