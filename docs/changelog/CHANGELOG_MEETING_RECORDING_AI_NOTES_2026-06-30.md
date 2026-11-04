# Meeting opnemen + AI-notulen — fase 1 (2026-06-30)

Gesprek opnemen vanuit een agenda-item, automatisch transcriberen (ElevenLabs Scribe)
en door Claude laten samenvatten tot gestructureerde notulen. Fase 1 = fysieke meeting
via de device-microfoon, met sprekerlabels, klant/project-koppeling en AVG-toestemming.

## Keten

```
MediaRecorder (browser, mono opus) → R2 (privé) → ElevenLabs Scribe → Claude → notulen
```

Opnemen is geen AI (browser `MediaRecorder`); samenvatten hergebruikt de bestaande
Claude-koppeling (`ANTHROPIC_API_KEY`) en valt onder hetzelfde `ai_usage`-maandplafond
als Gerrie. Alleen de transcriptielaag (ElevenLabs Scribe) is nieuw.

## Wat is gebouwd

**Database** — `supabase/migrations/20260630000010_meeting_recordings.sql`
- Tabel `meeting_recordings`: audio-key + metadata, koppeling aan het agenda-item via
  (provider, source_id, event_ref) zodat het voor Google/Microsoft én native werkt,
  optionele klant/project-koppeling, AVG-toestemming, pipeline-status, transcript
  (tekst + sprekersegmenten) en notulen (tekst + gestructureerde JSON).
- RLS: lezen voor org-leden (`can_read_org`); alle schrijfacties via de service-role.

**R2 media-worker** — `workers/media-api/src/index.ts`
- `meeting_recording` toegevoegd aan de toegestane entity-types.
- Entity-afhankelijke uploadlimiet: 150 MB voor audio (≈10 uur mono opus), 25 MB voor de rest.
- Nieuw intern, met `INTERNAL_UPLOAD_SECRET` beveiligd pad `GET /internal/media/:key` —
  hiermee haalt de edge-functie de audiobytes server-side op (gaan niet via de browser).

**Edge-functies** — `supabase/functions/`
- `_shared/edgeAuth.ts` — gedeelde auth (Supabase JWT) + org-toegang + CORS/JSON.
- `_shared/elevenlabs.ts` — Scribe-call (async webhook-modus, met synchrone fallback) +
  transcript-normalisatie naar sprekersegmenten + HMAC-verificatie van de webhook.
- `_shared/claudeSummary.ts` — transcript → gestructureerde notulen + kosten/budget op `ai_usage`.
- `_shared/meetingPipeline.ts` — notulen-pijplijn op een opname-rij (budget, opslaan, usage).
- `meeting-transcribe` — acties create / start / summarize / delete.
- `meeting-transcribe-webhook` — ontvangt het async transcript van ElevenLabs (HMAC) en
  start de notulen. Beide `verify_jwt = false` in `supabase/config.toml`.

**Frontend**
- `src/lib/meeting-api.ts` — API-client + audio-upload + statuspolling.
- `src/components/MeetingRecorder.tsx` — opname-UI (consent, opname-indicator + timer,
  pauze/stop), verwerking, en weergave van notulen + transcript (sprekerlabels) + audio-speler.
- Ingebouwd in het agenda-detailpaneel (`src/features/CalendarPage.tsx`), met één-klik
  "Opslaan als notitie" op klant/project (alleen bij gedeelde items) en "Kopieer notulen".
- `src/types.ts` — `EntityType` uitgebreid + `MeetingRecording`-types.
- `src/styles/globals.css` — donker-thema styling voor de recorder.

## AVG

- Verplichte toestemmingsbevestiging vóór opname ("Deze meeting wordt opgenomen…") +
  `consent_given`/`consent_at` vastgelegd; duidelijke opname-indicator.
- "Verwijderen" wist de R2-audio én de databaserij (transcript + notulen).
- Audio blijft privé in R2 en wordt server-side naar ElevenLabs gestuurd; zet in het
  ElevenLabs-account EU-dataresidentie + zero-retention aan.

## Te regelen vóór live (door beheerder)

1. `ELEVENLABS_API_KEY` (+ EU-residentie/zero-retention in het account).
2. `ELEVENLABS_WEBHOOK_SECRET` + webhook in het ElevenLabs-dashboard naar
   `…/functions/v1/meeting-transcribe-webhook` (aanbevolen voor lange opnames).
3. `MEDIA_WORKER_URL` (= worker-URL) en hergebruik `INTERNAL_UPLOAD_SECRET`.
4. Media-worker opnieuw deployen (nieuwe entity-type + interne route).
5. Optioneel: `ELEVENLABS_STT_MODEL` (scribe_v2), `ELEVENLABS_LANGUAGE`, `ELEVENLABS_USD_PER_HOUR`.

## Verificatie

- `npm run typecheck` ✓ en `npm run build` ✓.
- Worker `tsc --noEmit` ✓.
- Edge-functies (Deno) niet in de lokale typecheck — ná deploy een boot-health-check
  draaien (lesgeleerd: edge-functies vallen buiten `npm run typecheck`).

## Nog open (fase 2)

- Actiepunten automatisch omzetten naar taken (Gerrie's `propose_task`).
- Online meetings (Meet/Teams/Zoom) via systeemaudio of meeting-bot.
- Eventueel Supabase Realtime i.p.v. polling.
