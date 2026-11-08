# Opnames uitschrijven via de webhook — inrichten (productie)

Een opname (bij een afspraak of een telefoongesprek) gaat naar ElevenLabs Scribe.
Het transcript komt op een van twee manieren terug:

- **Synchroon**, zonder `ELEVENLABS_WEBHOOK_SECRET`. `meeting-transcribe` wacht op
  ElevenLabs en maakt in dezelfde aanroep het transcript en de notulen. Dat is
  eenvoudig, maar een lange opname kan tegen de tijdslimiet van de edge function
  lopen. Dan breekt Supabase de functie af en blijft de opname op
  "Transcriberen…" staan.
- **Via de webhook**, met `ELEVENLABS_WEBHOOK_SECRET`. ElevenLabs neemt de opname
  aan en stuurt het transcript later naar `meeting-transcribe-webhook`. Er wacht
  geen functie, dus er is ook geen tijdslimiet.

## Besluit (8 november 2026)

| Omgeving  | Route     | Waarom |
| --------- | --------- | ------ |
| Productie | webhook   | Meetings van een uur of langer moeten gewoon werken. |
| Staging   | synchroon | Staging is voor korte proefopnames. Zo is er geen tweede webhook in ElevenLabs nodig. |

Staging blijft zoals het is:

- zet daar **geen** `ELEVENLABS_WEBHOOK_SECRET`;
- maak in ElevenLabs geen webhook naar staging;
- test op staging met korte opnames, van hooguit een paar minuten.

Gebruikt staging dezelfde ElevenLabs-sleutel als productie, dan is dat geen
probleem. Staging vraagt geen webhook aan (`webhook=true` gaat alleen mee als het
geheim er is), dus ElevenLabs stuurt een staging-opname nergens heen.

## Productie inrichten (eenmalig)

De volgorde telt. Zodra het geheim in Supabase staat, gaat **elke** nieuwe
transcriptie via de webhook. Maak de webhook dus eerst in ElevenLabs, en test
meteen daarna.

### 1. De webhook in ElevenLabs

Je moet beheerder zijn van de ElevenLabs-workspace.

1. Ga in het dashboard naar de instellingen, onderdeel **Webhooks**, en maak een
   nieuwe webhook.
2. URL: `https://<project-ref>.supabase.co/functions/v1/meeting-transcribe-webhook`,
   met de project-ref van productie.
3. Kies als authenticatie **HMAC**. ElevenLabs maakt dan een gedeeld geheim aan.
   Kopieer het meteen; vaak is het later niet meer te zien.
4. Koppel de webhook aan de **speech-to-text**-gebeurtenissen. Zonder die
   koppeling stuurt ElevenLabs de transcripties nergens heen.

De menu's kunnen iets anders heten. Deze stappen komen uit de documentatie van
ElevenLabs (zie onderaan), niet uit het scherm zelf.

### 2. Het geheim in Supabase

Zet in het productieproject onder **Edge Functions → Secrets** het secret
`ELEVENLABS_WEBHOOK_SECRET`, met het geheim uit stap 1. Of met de CLI:

```bash
supabase secrets set ELEVENLABS_WEBHOOK_SECRET='<geheim>' --project-ref <project-ref>
```

Opnieuw deployen hoeft niet: de functies lezen het geheim bij elke aanroep.
`meeting-transcribe-webhook` heeft `verify_jwt = false` (`supabase/config.toml`).
Zo kan ElevenLabs hem aanroepen zonder Supabase-login; de HMAC-handtekening is de
beveiliging.

### 3. Testen

1. Neem een opname van ongeveer 15 seconden op, bij een afspraak of een gesprek.
2. De kaart staat even op "Transcriberen…" en springt dan naar "Klaar", met
   notulen.
3. Controleer in de SQL-editor (alleen lezen) dat hij echt via de webhook liep,
   en dat de transcriptie in het AI-budget telt:

   ```sql
   select id, status, elevenlabs_request_id is not null as via_webhook, transcription_cost_usd
     from public.meeting_recordings order by created_at desc limit 1;

   select model, cost_usd from public.ai_usage
    where transcribed_recording_id = '<id van hierboven>';
   ```

   Verwacht: status `done`, `via_webhook` is `true`, en één rij met model
   `elevenlabs/scribe_v1`.
4. Neem daarna één keer een lange opname op, van een half uur of meer.

## Als het niet werkt

Kijk onder **Edge Functions → meeting-transcribe-webhook → Logs**:

- **Geen aanroep:** de URL klopt niet, of de webhook is niet aan speech-to-text
  gekoppeld.
- **401, "ongeldige of ontbrekende signatuur":** het geheim in Supabase verschilt
  van dat in ElevenLabs. Of ElevenLabs ondertekent anders dan de code verwacht. De
  code leest `t=<tijd>,v0=<hmac>` uit de header `ElevenLabs-Signature`, met
  HMAC-SHA256 over `"<tijd>.<body>"`, en weigert een handtekening die ouder is dan
  30 minuten. Eén bron noemt `v1` in plaats van `v0`. Is dat zo, dan moet
  `verifyWebhookSignature` in `supabase/functions/_shared/elevenlabs.ts` mee.
- **200, maar de opname blijft hangen of het transcript is leeg:** dan levert
  ElevenLabs het transcript in een andere vorm aan. De code leest het uit
  `data.transcription` of rechtstreeks uit `data`
  (`supabase/functions/_shared/scribeTranscript.ts`); een nieuwe vorm hoort daar
  bij.

**Terug naar de oude situatie:** verwijder het secret. Dan gaat alles weer
synchroon. Een opname die bleef hangen kun je verwijderen en opnieuw opnemen.

## Wat de code doet

- `meeting-transcribe`, actie `start`: controleert het AI-budget, stuurt de audio
  met `webhook=true` naar ElevenLabs, en bewaart het `request_id`.
- `meeting-transcribe-webhook`:
  - controleert de handtekening;
  - zoekt de opname op `request_id`, en kijkt een paar keer opnieuw als de webhook
    sneller is dan het opslaan;
  - slaat het transcript op, rekent de transcriptie af in `ai_usage`, en maakt de
    notulen.
- Een herhaalde webhook doet niets: alleen een opname die nog op
  "Transcriberen…" staat, wordt bijgewerkt.
- Meldt ElevenLabs een fout, dan gaat de opname op "Mislukt" en wordt er niets
  afgerekend.

De webhook-route is getest met een nagebootste ElevenLabs
(`tests/stromen/notulen.mjs`), nog niet met de echte. De vorm van de webhook komt
uit de documentatie van ElevenLabs, die vanuit de sessie van 8 november niet te
openen was. De eerste test in productie is dus de echte proef: houd daarbij de
logs open.

Bronnen: [Webhooks instellen](https://elevenlabs.io/docs/webhooks/setup),
[Asynchronous Speech to Text](https://elevenlabs.io/docs/cookbooks/speech-to-text/webhooks),
[Webhooks](https://elevenlabs.io/docs/eleven-api/resources/webhooks).
