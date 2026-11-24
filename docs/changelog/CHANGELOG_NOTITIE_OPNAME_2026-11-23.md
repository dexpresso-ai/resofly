# Opnemen en uitschrijven in een notitie

**23 november 2026**

In een notitie kun je nu opnemen, net als bij een meeting: je spreekt in (of
neemt een gesprek op), en krijgt een transcript en notulen. Met één klik zet je
die in de tekst van de notitie.

## Hoe het werkt voor jou

1. Maak een notitie (**Nieuw → Notitie**) of open een bestaande.
2. Onder de tekst staat **Opname & transcriptie**. Kies **Opname starten** en
   bevestig. Is het een nieuwe notitie, dan wordt hij op dat moment
   opgeslagen, zodat de opname een plek heeft. Het venster blijft open en heet
   daarna *Notitie bewerken*; wat je al typte blijft staan.
3. Pauzeer en hervat als je wilt, en kies **Stop & verwerk**.
4. De AI schrijft de opname uit en maakt notulen: samenvatting, besproken,
   besluiten, actiepunten en vervolgafspraken. Dat loopt op de achtergrond
   door; je kunt het venster sluiten en later terugkomen.
5. Op de kaart van de opname:
   - **Notulen in de notitie** zet de notulen onder je tekst;
   - **Toon transcript → Transcript in de notitie** doet hetzelfde met de
     letterlijke tekst;
   - **Transcript bijwerken**, **Notulen opnieuw maken**, **Kopieer notulen**,
     **Notulen mailen** en **Beluister opname** werken zoals bij een meeting.
6. Kies **Opslaan**.

Wis je de notitie, dan gaan de opname, het transcript, de notulen en de audio
mee.

Het AI-tegoed is hetzelfde als bij meetings: is het op, dan wordt de opname
bewaard en kun je hem later laten uitschrijven.

## Rechten

Een opname bij een notitie valt onder **Inhoud**, niet onder Agenda.

- Wie Inhoud mag wijzigen, kan in een notitie opnemen, ook zonder Agenda.
- Wie Inhoud niet mag lezen, krijgt het transcript van een notitie niet, ook
  niet met Agenda, en ook niet via Gerrie of de API: de handelingen
  `meeting_recording.*` (onder Agenda) slaan notitie-opnames over of weigeren
  ze.
- Opnames bij een afspraak (Agenda) of een gesprek (Klanten) blijven precies
  zoals ze waren.

## Hoe het werkt

- **Database** (`20261123150000_opname_bij_notitie.sql`):
  `meeting_recordings.note_id`, met cascade naar de notitie. Een
  notitie-opname heeft geen afspraak en geen gesprek (check
  `meeting_recordings_note_alleen`), en de notitie hoort bij dezelfde
  organisatie. De module gate voor lezen kijkt naar de rij: met een `note_id`
  Inhoud, anders Agenda; nog steeds één keer per query. De agentgebeurtenis
  *opname klaar* gaat niet af voor een notitie-opname.
- **`meeting-transcribe`**: een derde soort opname, met `noteId`. De poort is
  Inhoud (`_shared/recordingModule.ts`, met test). Alleen bij `create` en
  `budget` telt wat de aanvraag zegt; bij elke andere actie beslist de rij,
  zodat niemand met een los veld langs de poort komt.
- **Gerrie**: `meeting_recording.list` en `.recent` tonen geen
  notitie-opnames; `regenerate_summary`, `update_transcript`, `send_summary` en
  `delete` weigeren ze. De beslislijst slaat ze over (*actiepunten uit
  notulen*, *notulen nog niet gemaild*).
- **App**: `MeetingRecorder` kent nu de stand *notitie* (`ensureNoteId`,
  `onInsertIntoNote`). In `main.tsx` slaat `createNoteNow` een nieuwe notitie
  op zonder het venster te sluiten. De recorder laadt pas als een notitie
  opengaat. Bij het wissen van een notitie gaat ook de audio uit R2
  (`deleteEntityCascade`).

## Getest

- `npm run typecheck` en `npm test`: 2232 geslaagd, waarvan nieuw:
  `recordingModule.test.ts` (de poort per soort opname).
- `supabase db start`: de hele keten op een lege database, met de nieuwe
  migratie.
- `npm run test:database`: alles geslaagd, met de nieuwe test
  `tests/database/opname_bij_notitie.sql`: wie welke opname ziet (met alles,
  zonder Inhoud, zonder Agenda, een andere organisatie), de check op één
  eigenaar, een notitie van een andere organisatie, een lid dat zelf een rij
  probeert te schrijven, en de cascade bij het wissen.
- `npm run test:mobile -- --theme=both` (890 pagina's, 0 met problemen),
  `npm run test:loading` en `npm run test:terugknop` (15/15).
- Met de hand in Chromium (nagebootste backend): een nieuwe notitie met de
  recorder en de toestemmingsvraag; een bestaande notitie met een afgeronde
  opname, waar **Notulen in de notitie** de notulen onder de tekst zet. Geen
  fouten op de pagina.
- Niet hier getest: `deno check` (esm.sh is vanuit deze omgeving niet
  bereikbaar; de CI doet het bij de push) en een echte opname met ElevenLabs.
  Dat laatste na de uitrol op staging, met een korte opname.
