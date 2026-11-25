# Inhoud → Meetings: alle meetings in één tabel, en de audio wissen (2026-11-25)

## Wat er nu kan

Onder **Documenten** (Inhoud) staat een vierde regel: **Meetings**, naast Alle inhoud,
Notities en Documenten. Ook in Zenit en in de losse app Documenten (vierde knop in de
duimbalk).

- **Alle meetings onder elkaar, in een tabel**, nieuwste bovenaan: datum, klant, duur,
  de stand van de notulen en hoeveel audio er staat. Op de telefoon blijven de naam en
  de audio over; datum, klant en duur staan op de regel eronder.
- **Zoeken** op titel, klant en de notulen. **Alle · Met audio** laat zien wat ruimte
  inneemt; **Soort** filtert op afspraken, telefoongesprekken en notitie-opnames (alleen
  als er meer dan één soort is). Rechtsboven staat hoeveel audio er in totaal is.
- **Klik een meeting open** voor de notulen (samenvatting, besproken, besluiten,
  actiepunten, vervolgafspraken) en het **volledige transcript**, de audio om terug te
  luisteren, en **Openen in Inhoud** als hij daar als notitie staat.
- **Audio verwijderen**, per meeting (⋮ of in het venster) of voor een selectie
  (vinkjes, of het vinkje in de kop voor alle meetings met audio). Na een vraag ter
  bevestiging gaat alleen de audio weg: **het transcript en de notulen blijven staan**.
  In de tabel staat dan "Verwijderd", en de melding zegt hoeveel ruimte er vrijkwam.
  De opslag van de organisatie telt de audio niet meer mee.

Meer dan honderd meetings? Onderaan haalt **Oudere meetings laden** de volgende honderd.

## Wanneer niet

- **Audio zonder transcript blijft staan.** Wacht een opname nog op uitschrijven (het
  AI-tegoed was op) of wordt hij nog uitgeschreven, dan is de audio het enige wat er
  is. Mislukte het uitschrijven, dan blijft er zonder audio niets over; die verwijder
  je in zijn geheel bij de afspraak. De tabel toont de knop dan niet, en de server
  weigert het ook.
- **Wie de module niet mag wijzigen.** Audio wissen vraagt schrijfrecht op de module van
  de opname, net als de hele opname wissen: Agenda bij een afspraak, Klanten bij een
  telefoongesprek, Inhoud bij een notitie-opname. De pagina zelf hangt aan Inhoud.
- **Meetings uit de privé-agenda van een collega** staan niet in het overzicht. De
  database laat wie Agenda kan lezen elke afspraakopname lezen; in de agenda zag je die
  nooit, omdat een opname daar alleen opent bij een afspraak die je kunt zien. Het
  overzicht houdt dezelfde grens: een afspraakopname uit een agenda die je kunt lezen
  (je eigen en de gedeelde), die je zelf maakte, of die al in de gedeelde Inhoud staat.
  Gesprekken en notitie-opnames zijn er voor iedereen die ze mag lezen.

## Waarom zo

- **Een meeting terugvinden** kon alleen bij de afspraak in de agenda, of als notitie in
  een map Meetings per klant (sinds 24 november). Dan moest je weten wanneer en bij wie
  hij was. Eén tabel met zoeken gaat sneller.
- **Ruimte maken kostte het transcript.** Een uur vergaderen is al gauw 30 tot 60 MB
  audio. Tot nu toe kon je alleen de hele opname wissen, en dan was het transcript ook
  weg (de notitie in Inhoud hield alleen de notulen).
- **De tabel laadt het transcript niet.** Dat is per uur zo'n 60 KB; honderd meetings
  zouden megabytes zijn voordat je iets ziet. Het komt pas als je een meeting opent.
- **Eerst de database, dan R2.** De server maakt de sleutel leeg en haalt daarna het
  bestand weg. Andersom kon een mislukte update een opname achterlaten die naar audio
  wees die er niet meer was.
- **Een vangnet voor R2.** Lukt het meteen wissen niet (worker even weg), dan bleef het
  bestand eerst voor altijd staan: niets wees er nog naar, dus niets ruimde het op. Nu
  zet een trigger de oude sleutel in de opruimwachtrij, en de nachtelijke opruimtaak
  (`file-transfer?cron=purge`) haalt hem alsnog weg. Dat geldt ook voor het wissen van
  een hele opname: de app wiste de audio daar zelf, en een mislukking werd stil
  overgeslagen.
- **`size_bytes` gaat mee leeg.** De opslagmeter (`organization_storage_status`) telt
  die kolom; anders bleef de gewiste audio meetellen.

## Wat er veranderd is

- `supabase/migrations/20261125090000_meeting_audio_verwijderen.sql`:
  - `audio_deleted_at` en `audio_deleted_by` op `meeting_recordings`, met de check
    `meeting_recordings_audio_gewist_zonder_sleutel` (gewist = geen sleutel, geen grootte);
  - trigger `meeting_recordings_purge_audio`: een sleutel onder
    `<organisatie>/meeting_recording/` die leeg wordt of met de opname verdwijnt, gaat de
    opruimwachtrij in (niet als een andere opname er nog naar wijst, en niet dubbel);
  - `storage_purge_queue_guard` kent de reden `meeting_recording`, alleen voor sleutels
    van dat soort.
- `supabase/functions/meeting-transcribe`: nieuwe actie `deleteAudio` (schrijfrecht op
  de module van de opname). Regel in `_shared/meetingAudio.ts` (`audioDeleteDecision`):
  alleen met transcript, en een tweede keer is geen fout. Het bestand gaat via
  `deleteStorageObject` (dezelfde weg als de opruimtaak).
- `src/features/MeetingsOverview.tsx` (nieuw): de pagina, het venster met notulen en
  transcript, en de vraag ter bevestiging. `src/styles/meetings.css` (nieuw, `mtg-*`).
- `src/lib/meetingsOverview.ts` (nieuw): wie wat ziet (`visibleInOverview`), wanneer de
  knop er staat (`canDeleteAudio`), zoeken, filteren, sorteren en de teksten in de cellen.
- `src/lib/meeting-api.ts`: `listMeetingOverview` (per honderd, zonder transcript),
  `listReadableCalendarSourceIds` en `deleteRecordingAudio`.
- De pagina `meetings` in `main.tsx`, `Sidebar.tsx`, `ZenitNav.tsx`, `BottomNav.tsx`,
  `TabBar.tsx` (icoon), `workspaceTabs.ts` (titel), `breadcrumbs.ts` (onder Documenten),
  `permissions.ts` (module Inhoud) en `standaloneApps.ts` (app Documenten).
- `src/components/MeetingNoteViews.tsx`: `TranscriptLines` is nu gedeeld.
- `src/types.ts`: de twee nieuwe velden. `src/lib/exportManifest.ts`: schemaversie naar
  20261125090000 (de kolommen gaan met de tabel mee).

## Getest

- `npm run typecheck`; `npm test`. Nieuw: `src/lib/meetingsOverview.test.ts` (wie wat
  ziet, ook de privé-agenda van een collega; de knop alleen waar de server hem ook
  toestaat; zoeken zonder accenten; filteren en sorteren) en
  `supabase/functions/_shared/meetingAudio.test.ts`.
- `tests/database/meeting_audio_verwijderen.sql`: de wachtrij bij wissen van audio en
  van een hele opname, niet dubbel, de check op sleutel en grootte, geen notitiebestand
  of factuur-PDF in de wachtrij, een gedeelde sleutel blijft staan, en een lid kan de
  audio niet zelf als gewist markeren.
- `deno check` op `meeting-transcribe`.
- `npm run test:mobile -- --theme=both` voor de aangeraakte schermen: `meetings`,
  `meetings-detail`, `meetings-transcript`, `meetings-selectie`, `meetings-wissen`
  (telefoon, tablet en liggend, licht en donker), en de grens voor de eerste meeting
  (`FIRST_ITEM`, gemeten 258px).
- `npm run test:terugknop` met een nieuw scenario: terug sluit eerst de vraag, dan de
  meeting, dan de pagina. `npm run test:loading` met de pagina erbij.
- Doorgeklikt in Chromium tegen de nagebootste backend, op telefoon en desktop: zoeken,
  audio wissen via ⋮, de melding met de vrijgekomen ruimte, "Verwijderd" in de tabel, het
  transcript nog in het venster, de knop weg, het filter Met audio en de regel in het
  menu. De meeting uit de privé-agenda van een collega staat er niet in.
- Niet hier getest: het wissen in R2 op staging. Wis na de uitrol de audio van een
  testmeeting en kijk of het bestand weg is en de opslagmeter zakt.
