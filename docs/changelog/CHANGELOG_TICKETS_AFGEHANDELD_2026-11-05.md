# Changelog: tickets afhandelen, en een archief (2026-11-05)

## Aanleiding

Een ticket waar niets meer aan hoefde, bleef op de werklijst staan. Er was geen
status voor "klaar": *goedgekeurd* zegt "we gaan het doen", *geweigerd* "we doen
het niet" en *omgezet* "het werd een project". Wie een vraag had beantwoord,
liet het ticket op nieuw of goedgekeurd staan, en de werklijst op de
ticketpagina en in het klantdossier groeide dicht met wat al lang klaar was.

Gevraagd: een status **Afgehandeld**; zo'n ticket verdwijnt van de werklijst,
ook op de klantpagina, en is terug te vinden in een **archief**.

## Wat er nu kan

### Ticketpagina

- **Afgehandeld** staat in de statuskeuze van het ticketvenster, met een regel
  uitleg eronder.
- **Afhandelen** met één klik, op de kaart en in de tabel, naast *Op de
  planning* en *Project maken*. Op de telefoon is het daar een rond vinkje (drie
  knoppen met tekst passen op 390px niet naast elkaar); in de telefoontabel
  staat het in het menu achter ⋮. Een omgezet ticket kan niet: dat werd een
  project, en de database houdt het op *omgezet*.
- **Archief**: een knop naast Lijst/Tabel, met het aantal afgehandelde
  tickets. Geen eigen rij, zodat op de telefoon het eerste ticket even hoog
  blijft staan (275px, gemeten). In het archief:
  - laatst afgehandeld bovenaan, met de datum van afhandelen;
  - zoeken, klant en prioriteit werken; status, *Openstaand*, *Om te zetten*
    en *Ongelezen* niet, want daar is alles afgehandeld;
  - in de tabel is de kolom *Status* de kolom *Afgehandeld* (datum);
  - **Heropenen** zet een ticket terug op *Review*, terug op de werklijst;
  - een statuskaart bovenaan brengt je terug naar de werklijst, met dat filter.
- De statuskaarten, de statuskeuze en *Openstaand* gaan over de werklijst.
  *Geweigerd* en *Omgezet* blijven daar staan: daar is niet om gevraagd.

### Klantdossier, tabblad Tickets

- De werklijst van de klant staat bovenaan; de teller op het tabblad telt alleen
  wat daar staat.
- Daaronder het **archief**, dicht (naslag, geen werk; hetzelfde patroon als in
  de agentengalerij). De zoekterm geldt ook daar, en de kop zegt hoeveel
  afgehandelde tickets er passen.

### Klantportaal

- De klant ziet de status **Afgehandeld**; zo'n ticket telt niet meer bij *Open
  tickets*.
- Op het tabblad Tickets staan afgehandelde tickets onderaan in een dicht blok
  *Afgehandeld*. Een afgehandeld ticket met een antwoord dat de klant nog niet
  las, blijft bovenaan staan: vaak schrijft het team het laatste antwoord en
  handelt het meteen af.
- In een afgehandeld ticket staat boven het tekstvak dat een bericht het ticket
  weer openzet.

### Reageert de klant op een afgehandeld ticket

Dan zet de database het terug op *review* (In behandeling). Zonder dat verdween
zijn bericht in het archief, waar niemand het zou zien. De statusregel komt op
naam van de klant die reageerde: hij krijgt er zelf geen mail over (net als over
zijn eigen reactie), zijn collega's in het portaal wel. Een "bedankt!" heropent
het ticket dus ook; dan handel je het opnieuw af. Dat is bewust: liever een
ticket te veel op de werklijst dan een vraag die niemand ziet.

### Ongelezen

Een afgehandeld ticket telt niet meer als ongelezen. De leesmarker is per
persoon: maakte de klant een ticket aan en handelde een collega het af, dan
bleef het voor iedereen die het nooit opende ongelezen. De teller in de zijbalk
bleef dan staan voor een ticket dat niet meer op de werklijst staat.

### Gerrie, agents, MCP en API

- `list_tickets`, `propose_ticket` en `propose_edit_ticket` kennen `resolved`;
  Gerrie kan een ticket dus voorstellen om af te handelen (een mens slaat op).
  `list_tickets` geeft ook `resolved_at` terug.
- De rapportages (app en Gerrie) kunnen op *Afgehandeld* filteren en groeperen.
- De openbare API accepteert `status: "resolved"`, ook als filter.
- De klantmail bij een statuswijziging heet "Ticket afgehandeld: …".

## Database: `20261105020000_ticket_resolved_archive.sql`

1. `tickets_status_check` met `resolved` erbij. Dezelfde naam als de
   inline-check uit de basis; op staging gecontroleerd.
2. Kolom `tickets.resolved_at`, gezet en gewist door de trigger
   `tickets_10_resolved_at` (op elke wijziging, zodat niemand er zelf een datum
   in zet). Hij loopt na `tickets_00_conversion_state`, die de status nog kan
   terugzetten.
3. Trigger `ticket_notes_reopen_resolved`: een notitie van de klant op een
   afgehandeld ticket zet het terug op `review`. Gaat dat mis, dan blijft het
   bij een waarschuwing; de reactie van de klant staat er altijd.
4. View `ticket_unread` slaat afgehandelde tickets over.

Veilig opnieuw te draaien (`drop … if exists`, `add column if not exists`,
`create or replace`).

## Bestanden

| Bestand | Wat |
| --- | --- |
| `src/lib/tickets.ts` | status, label, werklijst/archief-regels, volgorde van het archief |
| `src/features/Tickets.tsx` | knop Archief, Afhandelen, Heropenen, archieftabel |
| `src/features/Clients.tsx` | tabblad Tickets met archief |
| `src/features/portal/ClientPortal.tsx` | label, open tickets, blok Afgehandeld, uitleg |
| `src/main.tsx` | statuskeuze, opslaan van Afhandelen/Heropenen |
| `supabase/functions/_shared/portalNotify.ts` | label, zin, geen statusmail voor wie het zelf deed |
| `supabase/functions/_shared/gerrieCore.ts`, `actions/tickets.ts`, `actions/insight.ts` | Gerrie en de handelingen |
| `supabase/functions/_shared/apiResourceSpecs.ts` | API |
| `tests/mobile/` | seed met twee afgehandelde tickets; pagina's `tickets-archive`, `tickets-archive-table`, `client-tickets`, `portal-tickets` |

## Uitslag van de controles

| Controle | Uitslag |
| --- | --- |
| `npm run typecheck` | schoon |
| `npm test` | 955 tests groen, waarvan 5 nieuw in `src/lib/tickets.test.ts` en 1 in `portalNotify.test.ts` |
| `npm run test:mobile -- --theme=both` | zie hieronder |
| `npm run test:loading` | alle controles groen |
| `npm run build` | geslaagd |
| `deno check` (de lijst uit `frontend-checks.yml`) | schoon, zie de noot |

Daarnaast een klikproef tegen de nagebootste backend: afhandelen, het archief,
de volgorde, heropenen, een statuskaart terug naar de werklijst en de
statuskeuze in het venster (17 van 17 goed, geen JavaScript-fout).

**Noot bij `deno check`:** `deno.land` en `esm.sh` zijn vanuit deze sessie niet
bereikbaar. De check draaide met een tijdelijke import map: de vijf
`esm.sh`-pakketten via `npm:` (dezelfde versies), en `serve` uit std 0.224.0
via een vervanger met dezelfde handtekening. Een bewust ingevoegde typefout werd
gevonden. De echte check draait in CI bij de push naar staging.
