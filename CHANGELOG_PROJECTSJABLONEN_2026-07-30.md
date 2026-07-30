# Projectsjablonen: standaardtaken en subtaken per projecttype

**Datum:** 2026-07-30
**Migratie:** `20260730000000_project_templates.sql` (toegepast op staging)

## Aanleiding

Vakmensen die elk project op dezelfde manier aanpakken — filmmakers, timmerlieden,
fotografen — typten bij elk nieuw project dezelfde takenlijst opnieuw in. Er was geen
manier om die vaste werkwijze één keer vast te leggen.

## Wat er verandert

### Database

Twee nieuwe tabellen:

- **`project_templates`** — de sjabloonkop: `name`, `description`, `is_active`. Alleen
  actieve sjablonen verschijnen bij het aanmaken van een project.
- **`project_template_tasks`** — de standaardtaken, in volgorde (`position`). De kolommen
  spiegelen `tasks` (status, prioriteit, tags, geschatte duur, subtaken als JSONB), zodat
  het uitrollen een rechttoe rechtaan kopie is.

**Datums liggen relatief vast.** Een sjabloon hangt niet aan een kalender, dus in plaats
van datums staan er dagoffsets t.o.v. de projectstart: `start_offset_days`,
`due_offset_days` en `planned_offset_days` (die laatste zet de taak meteen op een dag in
de weekplanner). `0` is de startdag, `-2` is twee dagen ervoor. Bij het uitrollen worden
ze omgerekend naar echte datums; zonder startdatum komen de taken simpelweg datumloos
binnen.

Subtaken staan als JSONB op de sjabloontaak, net als bij `tasks.subtasks` — met één
verschil: in een sjabloon staat géén `done`, want een sjabloon heeft geen voortgang. Die
vlag komt er bij het uitrollen bij. Een normalisatietrigger houdt de lijst schoon (altijd
een array van `{id, label}`, lege labels eruit).

**`apply_project_template(org, project, template, startdatum)`** rolt een sjabloon uit in
één transactie: óf alle taken worden aangemaakt, óf geen enkele. Een half uitgerold
sjabloon is erger dan een leeg project. De functie draait als `security invoker` — het is
een gewone schrijfactie, dus RLS geldt gewoon — en is ingetrokken voor `public`/`anon`.

Twee dingen die het uitrollen expliciet regelt, omdat de standaardwaarden hier stuk gaan:

- **`created_at` via `clock_timestamp()`.** De default `now()` is de *transactietijd*, dus
  alle taken van één uitrol zouden exact dezelfde `created_at` krijgen en overal op `id`
  — dus willekeurig — gesorteerd worden. Met de wandklok staan ze in sjabloonvolgorde.
- **`planned_order`.** Taken met een plandatum worden achter wat er al op die dag staat
  gehangen, in sjabloonvolgorde, met stappen van 1000 (dezelfde stapgrootte als
  `reorder_task_planning`). Anders zouden ze in de weekplanner willekeurig door elkaar
  staan.

Ook `created_by` wordt expliciet op `auth.uid()` gezet: `tasks.created_by` heeft, anders
dan de meeste tabellen, géén default, dus zonder dat zou een uitgerolde taak op naam van
niemand staan.

Standaard org-patroon verder ongewijzigd: RLS met `can_read_org`/`can_write_org`,
`assert_same_org_reference` op `template_id` (en op project + sjabloon in de RPC),
`set_updated_at`, `prevent_organization_id_change` en audit-triggers.

`FRESH_INSTALL_COMPLETE_SCHEMA.sql` is in lijn gebracht.

### Sjabloonbeheer (Instellingen → Projectsjablonen)

Nieuw tabblad onder Instellingen:

- Sjablonen aanmaken, hernoemen, op niet-actief zetten en verwijderen.
- Per sjabloon een takenlijst: titel, beschrijving, status, prioriteit, tags, geschatte
  duur, de drie dagoffsets en een eigen subtakenlijst.
- Taken verplaatsen (↑/↓), dupliceren en verwijderen. Onder elk offsetveld staat direct
  wat het betekent ("dag +14", "op de startdag").
- De opslaanknop is uitgeschakeld tot er echt iets gewijzigd is; wisselen van sjabloon
  met onopgeslagen werk vraagt om bevestiging. Taken zonder titel worden bij het opslaan
  overgeslagen (en dat wordt gemeld).

### Project aanmaken vanuit een sjabloon

In het projectvenster staat bij een **nieuw** project een sjabloonkeuze. Zodra je een
sjabloon kiest, zie je meteen wélke taken worden aangemaakt en — als er een startdatum
staat — op welke datums ze landen. Staat er nog geen startdatum, dan zegt de hint dat de
taken zonder datum binnenkomen.

Bij opslaan wordt het project eerst aangemaakt en daarna het sjabloon uitgerold. Mislukt
dat uitrollen, dan blijft het project gewoon bestaan en krijg je een waarschuwing — het
project terugdraaien zou meer stukmaken dan het oplost.

### Takenvolgorde op het projectdashboard (let op: gedragswijziging)

De takenlijst van een project is nu **oplopend** gesorteerd (oudste eerst) in plaats van
aflopend. Binnen een project lees je die lijst als werkvolgorde, niet als nieuwsfeed —
en een uitgerold sjabloon stond anders van stap 4 naar stap 1 in de kanban. Dit raakt
alleen het projectdashboard; de weekplanner, het dashboard en het globale zoeken zijn
ongewijzigd.

## Verificatie

- `npm run typecheck` en `npm run build` groen.
- Migratie toegepast op staging (`enzghpduqwaojcxgwarr`); `supabase migration list` toont
  `20260730000000` lokaal én remote.
- Tabellen live bevestigd via PostgREST: `project_templates` en `project_template_tasks`
  geven 200. Negatieve controles: een verzonnen kolom geeft 400 `42703`, een verzonnen
  tabel 404 — de controle zegt dus echt iets.
- `apply_project_template` bestaat en is correct afgeschermd: anon krijgt `42501
  permission denied for function`, terwijl een verzonnen RPC-naam `PGRST202 Could not
  find the function` geeft.
- **Uitrollen echt getest op staging**, in een transactie die zichzelf terugdraait (een
  `raise exception` aan het eind, zodat er per definitie niets blijft staan; achteraf
  geverifieerd dat er nul testrijen over zijn). Sjabloon met drie stappen, bewust in
  omgekeerde volgorde ingevoegd, startdatum 2026-09-01:
  - volgorde volgt `position`, niet de invoegvolgorde: Stap een → twee → drie;
  - datums: stap een start 09-01 / deadline 09-04 / plan 09-01; stap twee start 09-04 /
    deadline 09-11 / plan 09-08; stap drie zonder startdatum (offset leeg), deadline
    10-01 (maandovergang klopt);
  - `planned_order`: stap twee en drie staan op dezelfde plandag en kregen 1000 en 2000,
    in sjabloonvolgorde; stap een staat alleen op zijn dag en kreeg 1000;
  - subtaken: het lege label is eruit gefilterd, de overige twee kregen `done: false` en
    een eigen id.
  - Niet met deze route te bewijzen: `created_by`. De Management API draait als
    `postgres` zonder JWT, dus `auth.uid()` is daar per definitie leeg.
- UI geïsoleerd gerenderd met testdata (harnas daarna verwijderd):
  - sjabloonlijst met taak-/subtaaktellers; een niet-actief sjabloon is als zodanig
    gemarkeerd en verschijnt níét in de projectkeuze;
  - taakregels tonen prioriteit, "Deadline dag +3" en subtaakteller; uitklappen toont alle
    velden met de juiste waarden en leesbare offsethints;
  - ↑/↓ wisselt de volgorde en zet de opslaanknop op "Sjabloon opslaan" met de melding
    "Niet-opgeslagen wijzigingen"; de randknoppen staan correct uit;
  - "+ Taak" voegt toe en klapt meteen uit, "Dupliceren" plaatst de kopie direct eronder;
  - de sjabloonkeuze rekende vanaf startdatum 2026-09-01 de deadlines uit op 4-9, 11-9,
    15-9 en 1-10-2026 (inclusief maandovergang), en viel na het wissen van de startdatum
    terug op "dag +3 / +10 / +14 / +30" met de bijpassende hint;
  - geen console-fouten.

## Nog open

- E2E met echte login (magic link) is niet gedaan. Het uitrollen is server-side bewezen
  en de UI is met testdata bewezen, maar de knip ertussen — op "Opslaan" klikken in een
  ingelogde sessie — is niet echt doorlopen. Daarmee is `created_by` op een uitgerolde
  taak ook nog niet met eigen ogen gezien.
- Productie: migratie nog niet toegepast.
- Bewust buiten scope gehouden (kan later): een bestaand project opslaan als sjabloon,
  meegeleverde voorbeeldsjablonen, en vaste projectinstellingen (kleur, facturatie,
  uurtarief) in het sjabloon.
- Gerrie kent sjablonen nog niet; `propose_project` rolt er dus geen uit.
