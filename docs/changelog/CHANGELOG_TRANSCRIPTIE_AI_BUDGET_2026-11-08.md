# Transcriptie telt mee in het AI-budget (2026-11-08)

Het uitschrijven van een opname (ElevenLabs Scribe) valt nu onder hetzelfde AI-maandtegoed
als Gerrie, de agents, de notulen en het uitlezen van facturen. Daarbij nagelopen of opnemen,
transcriberen en samenvatten werken; vijf fouten gevonden en opgelost.

## Wat er nu kan of klopt

- **Elke transcriptie staat in `ai_usage`**, op naam van wie de opname maakte en met de opname
  erbij (`transcribed_recording_id`, model `elevenlabs/scribe_v1`, zonder tokens). Zo telt ze
  mee in het maandtegoed (`ai_usage_month_totals`), in de tegoed-balk van Gerrie en in
  Instellingen → AI-gebruik.
- **Budget vóór de kosten.** `meeting-transcribe` controleert het tegoed (van de maker én van
  de organisatie) vóórdat de audio naar ElevenLabs gaat. Is het op, dan:
  - gaat er niets naar ElevenLabs;
  - blijft de opname bewaard (status `uploaded`, met de audio en een melding);
  - kan hij met **Opname uitschrijven** op de kaart alsnog, zodra er tegoed is.
- **De recorder waarschuwt vooraf.** Bij "Opname starten" vraagt hij het tegoed op (nieuwe
  actie `budget`). Is het op, dan zegt hij dat opnemen wel kan maar het uitschrijven moet
  wachten.
- **Dezelfde regel als overal** (`_shared/aiBudget.ts`): zolang er tegoed is, mag de volgende
  aanroep, ook als die de grens nog iets overschrijdt. Een uur audio kost $ 0,40.
- **Transcript klaar, tegoed daarna op:** de notulen wachten (zoals al gold), en nu telt de
  transcriptie daarin mee: de kosten gaan vóór de notulen in `ai_usage`.
- **Nooit twee keer betalen:** hoogstens één transcriptierij per opname (unieke index). Een
  herhaalde webhook of een tweede klik telt niet nog eens.
- **Wissen maakt geen tegoed vrij:** verwijdert iemand een opname, dan blijft de rij in
  `ai_usage` staan (`on delete set null`).
- **Instellingen → AI-gebruik** noemt nu ook transcriptie en het uitlezen van facturen. De
  kolom "Berichten" heet "Aantal keer". De uitleg zegt nu correct dat het overzicht één
  organisatie toont; het tegoed per gebruiker telt alle organisaties.

## Gevonden en opgelost bij het nalopen

1. **Een telefoongesprek kon je niet opnemen.** De recorder liet de knop "Opname starten"
   alleen zien bij een agenda-item (`eventRef`). Bij een gesprek stond er "Opnemen kan zodra de
   afspraak is opgeslagen", ook al was het gesprek opgeslagen. Nu telt een gesprek (`callId`)
   ook (`src/components/MeetingRecorder.tsx`).
2. **De browser stuurde een verkeerde duur mee.** `finishRecording` las de teller uit de state
   van toen de opname begon. Er ging 0 mee, of de duur van de vorige opname. Op staging stonden
   opnames van 40 en 44 seconden op 0 seconden en $ 0. Nu:
   - meet de recorder de duur met tijdstempels, ook als de browser het tabblad op de
     achtergrond afremt;
   - rekent de server met de langste van wat de browser meldt en waar het laatste woord in het
     transcript eindigt.

   Wie een te lage duur meestuurt, betaalt zo toch voor wat er gezegd is.
3. **De webhook-route las het transcript op de verkeerde plek.** Volgens de documentatie van
   ElevenLabs zit het transcript in `data.transcription`; de code las `data`. Dan bleef het
   transcript leeg en eindigde de opname in "Geen transcript om samen te vatten". Beide vormen
   werken nu (`_shared/scribeTranscript.ts`). Een foutmelding van ElevenLabs (`webhook_error`,
   `error_message`) wordt nu als fout herkend en niet als leeg transcript opgeslagen.
4. **Een snelle webhook ging verloren.** Komt de webhook binnen voordat het `request_id` is
   opgeslagen, dan vond hij geen opname en bleef die eeuwig op "Transcriberen…". Hij kijkt nu
   een paar keer opnieuw (tot ±5 seconden).
5. **Foutmeldingen kwamen niet in beeld.** `src/lib/meeting-api.ts` liet bij elke weigering
   "Edge Function returned a non-2xx status code" zien in plaats van de reden (tegoed op, geen
   toestemming…). Nu via `throwFunctionError`, net als de rest van de app.

Verder: `start` neemt alleen nog audio die bij déze opname is geüpload
(`<organisatie>/meeting_recording/<opname>/…`). Met alleen de organisatie als voorvoegsel kon
elk bestand van de organisatie naar ElevenLabs, op kosten van het tegoed.

## Bestanden

| Bestand | Wat |
| --- | --- |
| `supabase/migrations/20261108171500_ai_usage_transcriptie.sql` | kolom `ai_usage.transcribed_recording_id` + unieke index |
| `supabase/functions/_shared/transcriptionUsage.ts` | duur, kosten, budgetcontrole en de rij in `ai_usage` |
| `supabase/functions/_shared/scribeTranscript.ts` | het Scribe-antwoord inlezen (synchroon en webhook), los te testen |
| `supabase/functions/_shared/meetingPipeline.ts` | `completeTranscription`: opslaan → afrekenen → notulen, voor beide routes |
| `supabase/functions/meeting-transcribe/index.ts` | actie `budget`, budget vóór Scribe, opname bewaren, opslagsleutel per opname |
| `supabase/functions/meeting-transcribe-webhook/index.ts` | `data.transcription`, fouten herkennen, opnieuw kijken, afrekenen |
| `supabase/functions/_shared/elevenlabs.ts` | het webhook-geheim wordt bij elke aanroep gelezen (test van beide routes) |
| `src/components/MeetingRecorder.tsx` | gesprekken opnemen, duur via tijdstempels, waarschuwing, Opname uitschrijven |
| `src/lib/meeting-api.ts` | echte foutmeldingen, `loadTranscriptionBudget`, `canStartTranscription` |
| `src/features/SimplePages.tsx` | tekst en kolom van AI-gebruik |

## Getest

- `npm run typecheck`, `npm test` (1287 tests, waarvan 17 nieuw: `scribeTranscript.test.ts`,
  `transcriptionUsage.test.ts`). Die laatste bewaakt ook in de broncode dat elke route naar
  ElevenLabs eerst het budget controleert, en dat de transcriptie vóór de notulen wordt
  afgerekend.
- `deno check` op alle 34 functies uit de CI-lijst. In de cloudsessie kon dat niet via esm.sh;
  daarom met een import map naar dezelfde npm-versies.
- De migratieketen vanaf nul (`supabase db reset`): 256 bestanden, 256 toegepast. De migratie
  zelf twee keer achter elkaar gedraaid: veilig opnieuw te draaien.
- **Stromentest `notulen`** (`tests/stromen/notulen.mjs`): de echte functies tegen de lokale
  stack, met nep-ElevenLabs en nep-Claude (`tests/stromen/nep-ai.mjs`); 39 stappen, alle groen.
  Gedekt:
  - de synchrone route en de webhook-route;
  - echte en vervalste webhook-handtekeningen, een herhaalde webhook en een foutmelding;
  - de wedloop (webhook komt eerder dan het `request_id`);
  - tegoed op voor de gebruiker en voor de organisatie;
  - bewaren en later alsnog uitschrijven;
  - een collega die het niet op eigen tegoed kan doen;
  - transcript klaar maar notulen te duur;
  - het overzicht AI-gebruik en de tegoed-balk;
  - wissen zonder tegoed vrij te maken;
  - telefoongesprekken (module Klanten);
  - rechten: kijker, andere organisatie, wie `ai_usage` ziet.

  Tegenproef: met drie fixes teruggezet (`data.transcription`, de budgetcontrole, het
  afrekenen) falen 16 stappen.
- **UI-test `opname`** (`tests/stromen/ui.mjs`): de app in Chromium met een nep-microfoon.
  Via Klanten → klant A → Communicatie → Gesprek loggen → Opname voorbereiden echt opnemen en
  stoppen; transcript en notulen verschijnen; de duur van de browser klopt (3–6 seconden, niet
  0). Daarna met het tegoed op:
  - de waarschuwing vooraf;
  - de echte reden in beeld;
  - de kaart "Wacht op uitschrijven";
  - na meer tegoed werkt "Opname uitschrijven".

  Tegenproef: met de oude voorwaarde ontbreekt de knop bij een gesprek en faalt de test.
- `npm run test:loading`: alle controles geslaagd. `node scripts/check-csp-hash.mjs`: in orde.
- `npm run test:mobile -- --theme=both`: 410 pagina's gemeten, 0 met problemen.
- Op staging alleen gelezen (geen gespreksinhoud): vier opnames, alle via de synchrone route,
  de laatste op 1 juli; drie met notulen. Staging heeft geen `ELEVENLABS_WEBHOOK_SECRET`.

## Uitrol op staging (8 november, 22:21 UTC)

- Gemerged als `8b81350`. De Frontend checks op die commit waren groen.
- De deploy faalde vier keer bij `supabase db push`: de pooler kreeg geen verbinding met de
  database (`Connection terminated unexpectedly`, later `FATAL: Failed to connect to database:
  :timeout`). Er was niets van toegepast.
- Oorzaak: de database liep vast op schijf-IO. De CPU stond op 96 à 99%, bijna alles IOwait, op
  de kleinste instance (geen compute-upgrade). De database was 860 MB, waarvan 807 MB logboek:
  `net._http_response` (527 MB, de antwoorden van pg_net) en `cron.job_run_details` (280 MB, de
  geschiedenis van pg_cron). Geen van beide wordt door de app gelezen.
- In overleg zijn beide tabellen geleegd met `TRUNCATE`, via de Management API, met schrijfrecht
  voor alleen die ene transactie. De database ging van 860 naar 54 MB, en binnen een minuut stonden
  database, REST, Auth en Storage weer op gezond.
- Daarna slaagde de deploy:
  - migratie `20261108171500` is toegepast (256 migraties op staging), met kolom en index;
  - `meeting-transcribe` en `meeting-transcribe-webhook` zijn bijgewerkt (22:20:58 UTC);
  - de rooktest is groen.
- **Valkuil bij het meten:** een query met `read_only: true` draait als
  `supabase_read_only_user`, en die rol heeft `default_transaction_read_only=on`. Daar geeft
  `current_setting('default_transaction_read_only')` dus altijd `on`, ook als de database gewoon
  schrijfbaar is. Dat gaf eerst ten onrechte de indruk dat staging in alleen-lezen stond. Meet het
  zonder `read_only` (als `postgres`) met een query die niets schrijft.
- **Nog open:** de twee logtabellen groeien weer bij elke cron-run. Er is nog geen dagelijkse
  opruimtaak. Die hoort in een migratie, in dezelfde stijl als
  `20261101070000_mcp_clients_purge.sql`.

## Na de uitrol

- **Lange opnames:** staging transcribeert synchroon. Bij een opname van een uur kan de edge
  function tegen zijn tijdslimiet lopen; dan blijft de opname op "Transcriberen…" staan. Voor
  lange meetings is de webhook-route de veilige keuze:
  - een webhook in het ElevenLabs-dashboard naar `…/functions/v1/meeting-transcribe-webhook`;
  - hetzelfde geheim als `ELEVENLABS_WEBHOOK_SECRET`.
- Oude opnames worden niet met terugwerkende kracht afgerekend. Dat gaat om de drie
  opnames op staging (samen ruim anderhalve minuut).
