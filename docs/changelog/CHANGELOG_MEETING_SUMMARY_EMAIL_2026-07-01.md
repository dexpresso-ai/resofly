# Meeting-notulen naar genodigden mailen + transcript bewerken — fase 2 (2026-07-01)

Voortbouwend op de meeting-opname-feature (fase 1, `CHANGELOG_MEETING_RECORDING_AI_NOTES_2026-06-30.md`).
Na de transcriptie kan de app-gebruiker nu:

1. **de transcriptie bijwerken** (correcties) vóór er iets mee gebeurt, en de notulen
   daaruit opnieuw laten genereren;
2. **de notulen per e-mail naar de genodigden sturen** — met een composer waarin het
   onderwerp, de tekst én de ontvangerslijst nog aanpasbaar zijn alvorens te versturen.

## Wat is gebouwd

**Database** — `supabase/migrations/20260701000003_meeting_summary_send.sql`
- `meeting_recordings.summary_sent_at` + `summary_recipients` (jsonb) voor audit/UI-feedback
  ("Notulen gemaild naar N genodigden · datum").
- Geen policywijziging: schrijven blijft via de service-role (edge-functie).

**Edge-functie** — `supabase/functions/meeting-transcribe/index.ts` (twee nieuwe acties)
- `update` — slaat de door de gebruiker gecorrigeerde `transcript_text` (en optioneel
  `summary_text`) op. Write-rol + org-check.
- `sendSummary` — mailt de (bewerkte) notulen naar de meegegeven ontvangers via Resend
  (hergebruikt `resolveSenderIdentity` + de projectbrede RESEND-secrets). Elke genodigde
  krijgt een **eigen** mail (privacy). Ontvangers worden server-side gevalideerd,
  ontdubbeld en begrensd (max 50). Optioneel wordt het volledige transcript meegestuurd.
  Bij deelfouten gaat de verzending door en wordt gerapporteerd welke adressen faalden.

**Frontend**
- `src/lib/meeting-api.ts` — `updateRecordingText()` + `sendSummaryToAttendees()`.
- `src/components/MeetingRecorder.tsx` — inline transcript-editor (bijwerken + opslaan);
  knop **"Verstuur naar genodigden"** die een composer opent (voorgevulde ontvangers uit
  de genodigden, aan/uit per persoon + handmatig adres toevoegen; voorgevuld onderwerp
  en notulen-tekst, allebei bewerkbaar; optie "volledig transcript meesturen").
  Toont na afloop "Notulen gemaild naar N genodigden · datum".
- `src/features/CalendarPage.tsx` — geeft de genodigden mee aan de recorder: native uit
  `calendar_event_attendees`, extern (Google/Microsoft) uit het event zelf.
- `src/types.ts` + `src/styles/globals.css` — nieuwe velden en composer-styling.

## Nog te doen (deploy naar staging)
- Migratie `20260701000003` toepassen.
- `meeting-transcribe` opnieuw deployen + boot-health-check (edge zit niet in `npm run typecheck`).
- RESEND-secrets zijn al gezet (klant-mail draait al); een geverifieerd verzenddomein of
  `RESEND_FROM_EMAIL` is vereist om te kunnen versturen.

Verificatie: `npm run typecheck` groen, `npm run build` groen. Edge-tsc niet lokaal draaibaar
(geen deno); handmatig gecontroleerd op dubbele declaraties.
