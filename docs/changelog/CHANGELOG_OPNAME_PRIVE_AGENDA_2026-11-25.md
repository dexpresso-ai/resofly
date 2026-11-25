# Opnames uit een privé-agenda: alleen voor wie die agenda heeft (2026-11-25)

## Wat er nu klopt

Een opname bij een afspraak uit je **privé-agenda** is van jou. Een collega ziet
hem nergens meer: niet in de database, niet via Gerrie, de agents, MCP of de API,
en niet op de beslislijst van Gerrie.

Je ziet een afspraakopname als:

- hij komt uit een agenda die je kunt lezen: je eigen agenda's en de agenda's die met
  het team gedeeld zijn;
- je hem zelf maakte;
- of hij al in de gedeelde Inhoud staat (in de map Meetings).

Een opname bij een **telefoongesprek** of een **notitie** hoort niet bij een agenda;
daar verandert niets. De modulerechten blijven gelden: zonder Agenda zie je nog steeds
alleen wat in Inhoud staat. Is de agenda van een opname verwijderd, dan ziet alleen
wie hem maakte hem nog.

## Wat er misging

Wie Agenda kon lezen, kon ook elke afspraakopname van de organisatie lezen: titel,
transcript en notulen, ook uit de privé-agenda van een collega. In de app zag je die
nooit (een opname opent bij een afspraak die je kunt zien, en Inhoud → Meetings
filterde sinds vanochtend zelf), maar:

- **PostgREST** gaf ze gewoon terug (`meeting_recordings?select=*`);
- **Gerrie, de agents, MCP en de API** (`meeting_recording.list` en `.recent`) lieten
  ze zien, met de notulen;
- met **meeting-transcribe** en Gerrie's handelingen kon een collega die notulen
  **mailen**, het transcript **overschrijven**, de notulen opnieuw laten maken, de
  audio wissen of de hele opname **verwijderen**, als hij het id had;
- de notulen kwamen als **kaart op de beslislijst** van Gerrie (die is van het hele
  team), met de titel en de actiepunten, en als signaal dat een beheerder kon lezen;
- de gebeurtenis **"notulen klaar"** ging met de titel naar elke agent van het team.

## Waarom zo

- **Dezelfde grens als de agenda.** Een privé-agenda lees je alleen zelf
  (`calendar_sources`). Wat erin besproken is, hoort daar ook bij.
- **Wie opnam, mag erbij.** Neemt een collega een meeting op bij een afspraak die in
  jouw privé-agenda staat, dan is die opname ook van hem; de genodigden van jouw
  afspraak blijven geheim (dat gold al).
- **Wat in Inhoud staat, is gedeeld.** Daar heeft iemand hem bewust neergezet; de map
  Meetings vult zich alleen vanuit een gedeelde agenda.
- **"Niet gevonden", niet "geen toegang".** Een collega hoort niet dat er een opname is.
- **De rechten één keer per query.** De lijst met agenda's die je kunt lezen
  (`my_readable_calendar_source_ids`) wordt één keer opgehaald, niet per rij, zoals de
  andere lijsten sinds 22 november.

Gevolg voor een export door de eigenaar: opnames uit de privé-agenda van een collega
gaan niet meer mee, net zoals die privé-agenda zelf.

## Wat er veranderd is

- `supabase/migrations/20261125110000_opname_prive_agenda.sql`:
  - `my_readable_calendar_source_ids()` en de restrictive leespolicy
    `prive agenda select` op `meeting_recordings`;
  - `meeting_recording_visible_to(opname, gebruiker)`: dezelfde regel per rij, voor de
    triggers; zonder gebruiker: is hij met het team gedeeld;
  - `ai_signal_on_meeting_done` en `collect_time_signals`: geen signaal meer voor
    notulen uit een privé-agenda;
  - `agent_event_recording_ready`: "notulen klaar" alleen naar agents van iemand die de
    opname mag zien (`run_as_user_id`, anders de maker);
  - `close_private_meeting_signals()`: wat er al stond, gaat dicht. Signalen worden
    overgeslagen, open kaarten verlopen, wachtende gebeurtenissen bij een agent die het
    niet mag zien worden overgeslagen, en geen van alle noemt nog de titel, de notulen
    of de actiepunten.
- `supabase/functions/_shared/recordingPrivacy.ts` (nieuw): de regel voor wat met de
  service-role leest, plus het filter voor lijsten.
- `supabase/functions/_shared/actions/calendar.ts`: `agendaRecording` (gebruikt door
  `send_summary`, `update_transcript`, `regenerate_summary` en `meeting_recording.delete`)
  zegt "niet gevonden"; `meeting_recording.list` en `.recent` filteren.
- `supabase/functions/meeting-transcribe`: elke actie op een bestaande opname toetst de
  regel (404); `create` weigert de privé-agenda van een ander.
- `supabase/functions/gerrie-signals`: slaat een meeting uit een privé-agenda over
  (voor een agenda die privé werd nadat het signaal er stond).
- `src/lib/meetingsOverview.ts`: alleen de uitleg; het filter in Inhoud → Meetings blijft
  als tweede slot.
- `src/lib/exportManifest.ts`: schemaversie naar 20261125110000 (geen tabellen of
  kolommen erbij).

## Getest

- `tests/database/opname_prive_agenda.sql` (nieuw): wie wat ziet (collega, eigenaar, iemand
  zonder Agenda), het plan (een InitPlan, geen subplan per rij), de beslislijst (trigger
  en veegronde), de agentgebeurtenis per eigenaar, en het opruimen van wat er al stond.
  Met de policy weggehaald valt de test om: de collega ziet dan "Gesprek met de bank".
- `tests/database/rls_een_keer_per_query.sql` kent de nieuwe lijst (stable, security
  definer, dicht voor anon). `meeting_in_inhoud.sql` en `opname_bij_notitie.sql` maakten
  afspraakopnames zonder agenda en zonder maker (dat doet de app nooit); hun opnames
  komen nu uit een gedeelde agenda. Keten vanaf nul (`supabase start`) en
  `npm run test:database`: alle 13 bestanden geslaagd.
- `npm test`. Nieuw: `recordingPrivacy.test.ts`; in `recheckFixes.test.ts` de lijsten en
  de handelingen op een opname uit een privé-agenda (met de controles weggehaald vallen
  beide tests om); en in `meetingsOverview.test.ts` dat de app en de server in alle 96
  combinaties hetzelfde beslissen.
- `npm run test:stromen -- notulen` met een nieuw scenario *een meeting uit een
  privé-agenda*: PostgREST (ook voor de eigenaar van de organisatie), de zes acties van
  meeting-transcribe, een opname aan andermans privé-agenda hangen, en
  `meeting_recording.list` en `.recent` via de API. 63 stappen, 0 fout. Met de controle
  in meeting-transcribe weggehaald valt het scenario om (de beheerder liet de notulen
  opnieuw maken). De opnames van de andere scenario's komen nu uit een gedeelde
  teamagenda, zoals in de app.
- `deno check` op meeting-transcribe, gerrie-signals, mcp, api, gerrie-agent en
  gerrie-agent-runner.
