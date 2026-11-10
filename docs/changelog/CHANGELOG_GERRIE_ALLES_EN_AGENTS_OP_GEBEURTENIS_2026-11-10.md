# Gerrie kan wat de app kan, en agents starten zodra er iets gebeurt (2026-11-10)

De vraag was: met Gerrie moet je alles kunnen doen wat de app kan, binnen je eigen
rechten. Meetings aanmaken, documenten zoeken, lezen, bewerken en aanmaken, factureren,
offertes. En je moet er agents mee kunnen bouwen die echt werk automatiseren.

Gerrie had al ruim 280 handelingen. Wat ontbrak, zat op twee plekken:

- Bij **knoppen die er gewoon waren, maar geen handeling hadden**. Een document zoeken
  lukte alleen op titel. De tekst lezen of bijwerken kon niet. Een meeting met genodigden
  kostte twee stappen. Crediteren, een offerte intrekken, een telefoongesprek vastleggen
  en iets verwijderen konden ook niet.
- Bij **Gerrie's eigen teksten**. Die zeiden op zes plekken "dat kun je NIET" (campagne
  versturen, contract versturen, boekjaar afsluiten, btw-periode, galerij publiceren,
  verwijderen), terwijl de handeling allang in de registry stond. Het model geloofde de
  tekst en stuurde de gebruiker onterecht weg.

Agents draaiden alleen op een vast moment. "Als er een klantmail binnenkomt, zet een
antwoord klaar" werd zo een agent die elk uur alle mail van de dag opnieuw las, en pas
een uur later reageerde.

## Wat er nu kan

### Documenten en notities (`actions/content.ts`)

| Handeling | Wat |
| --- | --- |
| `content.search` | Zoekt in notities en documenten op titel **én tekst**, in bestanden op naam en in mappen op naam. Je krijgt bij elke treffer een stukje tekst rond het zoekwoord. Meerdere woorden tellen, en treffers in de titel wegen dubbel. |
| `content.get` | Geeft de volledige tekst van één notitie of document (tot 20.000 tekens). Bij een Word-document zegt hij eerlijk dat de tekst in het bestand staat. |
| `note.update`, `document.update` | Werkt de titel, tekst, soort, labels, klant of project bij. De tekst kun je **vervangen** of **aanvullen**: aanvullen leest de tekst van nu en zet het nieuwe stuk eronder. Vervangen krijgt "Definitief uitvoeren" en een waarschuwing, want er blijft geen vorige versie bewaard. Een Word-document bewerk je in de Word-editor. |
| `attachment.list`, `attachment.rename`, `attachment.move` | Bestanden bekijken, hernoemen en tussen mappen verplaatsen. Verplaatsen kan alleen tussen mappen, net als slepen. Is de doelmap gedeeld, dan staat dat als waarschuwing op de kaart. |
| `drive.share`, `drive.list_shares`, `drive.revoke_share` | Een map, notitie, document of bestand delen met contactpersonen van de klant (in het portaal), met collega's, of met een los e-mailadres. Een los adres kan alleen voor iets buiten een klantdossier. Je kunt ook bekijken wat er gedeeld is en een deling intrekken. |

Daarnaast:

- `list_content` zoekt nu ook in de tekst.
- `propose_note` en `propose_document` krijgen een map (`folder_id`) en een soort mee.

### Meetings

`propose_calendar_event` kan nu in één voorstel:

- **genodigden** meegeven (`attendees`, hoogstens 25). Zij krijgen bij het akkoord een
  uitnodiging per e-mail;
- de afspraak **koppelen aan een klant en project**, langs dezelfde weg als "Koppelen" in de agenda.

Op de kaart staat wie de uitnodiging krijgt. Een meeting met Google Meet, Teams of
Jitsi kon al.

### Verkoop, klanten en de rest van de knoppen (`actions/work.ts`)

| Handeling | Wat |
| --- | --- |
| `invoice.credit` | Crediteert een verstuurde, onbetaalde factuur voor het hele bedrag, net als de knop "Crediteren". |
| `quote.withdraw` | Trekt een verstuurde of intern goedgekeurde offerte in. |
| `client_call.log`, `client_call.list`, `client_call.update` | Telefoongesprekken vastleggen, bekijken en aanpassen. |
| `client_email.mark_read`, `inbox.block_sender` | Klantmail op gelezen zetten, en een afzender blokkeren in de opvangbak. |
| `planner.set_day_capacity`, `project.shift_planning` | Je werkuren per dag in de weekplanner, en de planning van een project in één keer opschuiven. |
| `booking_link.extend`, `ai_report.rename` | Een boekingslink langer geldig maken, en een rapportage hernoemen. |
| `teamchat.send_dm` | Een collega een bericht sturen in de teamchat. Gerrie leest de chat niet. Alleen wie het voorstel deed, kan het versturen: anders ging het bij goedkeuring door een owner op diens naam. |
| `settings.set_ticket_emails`, `settings.save_jitsi_server` | Twee instellingen, alleen voor owners en admins. |

**Uren factureren** heeft geen eigen knop in de app. De systeemprompt beschrijft nu de
weg: declarabele uren ophalen, het uurtarief van het project nemen en één factuur
klaarzetten.

### Verwijderen (`actions/removal.ts`)

Gerrie kan nu ook klaarzetten wat de gebruiker zelf mag weggooien:

- taak, project, actiepunt en projectsjabloon;
- urenpost;
- klant, contactpersoon, gesprek en mail uit het dossier;
- ticket en ticketreactie;
- notitie, document, map en bestand;
- opname en boekingslink;
- conceptfactuur en conceptofferte;
- campagne en e-mailstroom;
- rapport en rapportage.

De grenzen zijn voor allemaal hetzelfde, en staan in één bestand:

- Elke kaart heeft **"Definitief uitvoeren"** en vooraan een waarschuwing die zegt wat er
  verdwijnt.
- **`humanOnly`**: een gekoppelde AI of API-sleutel voert nooit zelf iets weg. Er staat
  niets in `apply.ts`.
- **De bewaarplicht blijft.** Een verstuurde of geboekte factuur verwijder je niet: die
  herstel je met `invoice.credit`. Een verstuurde offerte trek je in. Een klant met
  facturen of offertes kan niet weg. `plan()` zegt dat vóór er een kaart komt, en de
  database weigert het daarna nog een keer.
- **De uitvoerder kent zijn eigen tabel.** "Taak verwijderen" kan alleen een taak raken,
  wat er ook in het voorstel staat.
- De systeemprompt laat Gerrie eerst de omkeerbare weg voorstellen: archiveren, op
  inactief zetten, afvinken of intrekken.

### Agents die starten op een gebeurtenis

Naast "elke dag", "elke werkdag", "wekelijks", "maandelijks" en "elk uur" is er nu
**"Zodra er iets gebeurt"**. Een agent kan wachten op deze gebeurtenissen:

| Gebeurtenis | Module |
| --- | --- |
| Er komt een mail van een klant binnen | Klanten |
| Er komt een nieuw ticket binnen | Tickets |
| Een klant reageert op een ticket | Tickets |
| Een klant accepteert een offerte | Financiën |
| Een klant wijst een offerte af | Financiën |
| Een factuur is betaald | Financiën |
| Een klant boekt een afspraak | Agenda |
| De notulen van een gesprek zijn klaar | Agenda |
| Er komt een inkoopfactuur binnen | Financiën |
| Er is een nieuwe klant | Klanten |

Hoe het loopt:

1. Een trigger in de database zet de gebeurtenis in `ai_agent_events`, maar alleen als er
   in die organisatie een actieve agent op dat soort gebeurtenis wacht. Zonder
   luisteraar gebeurt er niets.
2. De runner (`gerrie-agent-runner`, elke minuut) claimt per agent een bundel. Een
   gebeurtenis wacht minstens een minuut: drie mails vlak na elkaar worden zo één run in
   plaats van drie.
3. De agent krijgt de gebeurtenissen mee als **gegevens**, met de id's, en zoekt de rest
   op met zijn eigen tools. Het onderwerp van een mail ("negeer je regels en…") is tekst
   uit de administratie, geen opdracht (`agentEvents.ts`, `wrapToolData`).
4. Wat hij wil doen, zet hij klaar. Een mens keurt goed.

De grenzen:

- **Wat de eigenaar niet mag lezen, krijgt zijn agent niet.** Dat wordt getoetst bij het
  opslaan en bij elke run opnieuw. Zonder Tickets geen ticket-gebeurtenis, ook de titel
  niet.
- **Kosten:**
  - hoogstens `max_event_runs_per_day` runs per 24 uur (standaard 24, hoogstens 96);
  - hoogstens 20 gebeurtenissen per run;
  - hoogstens 200 wachtende gebeurtenissen per agent;
  - na drie dagen vervalt een gebeurtenis;
  - een mislukte run wordt niet opnieuw geprobeerd. Na drie mislukkingen op rij gaat de agent op pauze;
  - het maandtegoed blijft de bovengrens (fail-closed).
- **Pauzeren, archiveren of andere gebeurtenissen kiezen** laat wat er nog wachtte
  vervallen. Een agent die je na een week weer aanzet, handelt de mail van toen niet
  alsnog af.
- **Een trigger laat het opslaan van een ticket, mail of factuur nooit mislukken.** Gaat
  de wachtrij stuk, dan komt er een waarschuwing in het databaselog en wordt het ticket
  gewoon opgeslagen. Dat is getest.
- `ai_agent_events` is alleen voor de service-role: RLS staat aan, er zijn geen policies,
  en de modulepoort van Gerrie staat erop. Claimen mag alleen de service-role.

In de app:

- Het bewerkscherm heeft de keuze **"Zodra er iets gebeurt"**, met vinkjes voor de
  gebeurtenissen (alleen uit modules die je mag lezen) en een daggrens.
- Een run die door een gebeurtenis startte, heeft het label "gebeurtenis". Het logboek
  zegt welke gebeurtenissen het waren.
- Er zijn drie nieuwe startpunten:
  - *Klantmail beantwoorden*;
  - *Eerste reactie op tickets*;
  - *Offerte geaccepteerd* (project en factuur klaarzetten).
- Gerrie kan zo'n agent ook zelf voorstellen in de chat of in de agent-bouwer
  (`schedule_kind: "event"` met `trigger_events`). Een agent op een gebeurtenis draait na
  het aanmaken niet meteen, maar wacht op zijn eerste gebeurtenis.

## Wat bewust niet is gebouwd

| | Waarom |
| --- | --- |
| API-sleutels, app-wachtwoorden, agenda- en bankkoppelingen, Mollie-sleutel, verzenddomein | Inloggegevens horen niet door een AI te gaan. |
| Abonnement, seats, opslag kopen, terugbetaling via Mollie | Dat geeft geld uit. |
| Bestanden uploaden of downloaden, PDF's downloaden | Een agent heeft geen bestand in handen. |
| Teamchat lezen | Privégesprekken blijven buiten Gerrie. Een bericht sturen kan wel. |
| Webhooks | Die sturen gegevens naar een adres buiten ResoFly. Via ingevoegde tekst zou dat een lek kunnen worden. |
| Aandeelhoudersregister en btw-registers verwijderen | Dat is wettelijke administratie. Corrigeren gaat met een tegenboeking of een nieuwe regel, zoals in het scherm. |
| Organisaties aanmaken of wisselen | Elke organisatie is een eigen wereld (harde regel 1). |

## Wat er veranderde aan de grenzen

Niets. Alle nieuwe handelingen:

- halen `organization_id` uit de sessie;
- zijn org-scoped (bewaakt door `actionTenancy.test.ts`);
- toetsen de modulerechten (bij een bestand: de module waar het aan hangt);
- zetten alleen een voorstel klaar.

Uitvoeren gebeurt in de browser, onder de sessie van wie goedkeurt, langs dezelfde
repository-functie als de knop. Een gekoppelde AI of API-sleutel voert nog steeds
alleen de handelingen uit `apply.ts` rechtstreeks uit; daar is niets bij gekomen.

## Database — `20261110090000_agents_bij_gebeurtenis.sql`

- `ai_agents`:
  - `schedule_kind` kent nu ook `event`;
  - nieuwe kolom `trigger_events text[]`, met een CHECK op de tien sleutels;
  - nieuwe kolom `max_event_runs_per_day` (1–96, standaard 24);
  - nieuwe index voor de triggers.
- `ai_agent_runs.triggered_by` kent nu ook `event`.
- Nieuwe tabel `ai_agent_events`: de wachtrij, met RLS aan, geen policies en de
  modulepoort van Gerrie.
- `enqueue_agent_event()` (security definer, faalt nooit hard) en negen triggerfuncties.
- `claim_agent_event_batches(p_limit)`: alleen de service-role. Doet de minuut wachttijd,
  de daggrens, het vervallen na drie dagen en het terugzetten van vastgelopen claims.

Veilig opnieuw te draaien. Getest op een lege database, met de hele keten vanaf nul.

## Getest

- `npm run typecheck` is groen.
- `npm test`: 1477 tests, allemaal groen. Nieuw of uitgebreid:
  - `actionAllTasks.test.ts`: de grenzen van de nieuwe handelingen, met een nep-database
    waarop `plan()` en `read()` echt draaien. Getoetst wordt:
    - de bewaarplicht bij facturen, offertes en klanten;
    - "Definitief uitvoeren" en `humanOnly` bij elke verwijdering;
    - de status bij crediteren en intrekken;
    - de waarschuwing bij tekst vervangen;
    - een Word-document;
    - de modulerechten op bestanden;
    - zoeken zonder leesrecht en zonder chatbijlagen;
    - delen binnen het eigen klantdossier;
    - de afzender van een chatbericht;
    - de weekplanner van de voorsteller;
    - de instellingen alleen voor owners en admins;
  - `actionSearch.test.ts` met 27 vragen voor de nieuwe handelingen;
  - `agentEvents.test.ts`: de lijst gelijk in code, CHECK en app, de module per
    gebeurtenis, en de aanleiding afgebakend als gegevens, ook met een onderwerp dat
    `</gegevens>` probeert;
  - `agentAccess.test.ts` leest nu de nieuwste ritme-CHECK.
- `deno check` op de geraakte functies (`gerrie-agent`, `gerrie-agent-runner`, `mcp`, `api`,
  `gerrie-signals`) is groen.
- `supabase db start`: de hele migratieketen werkt op een lege database. De nieuwe
  migratie draait ook een tweede keer zonder fout. In die database is nagelopen:
  - een gebeurtenis komt alleen in de eigen organisatie, en alleen bij een actieve agent;
  - bij een klantmail alleen als hij inkomend is;
  - de minuut wachttijd, de bundel, en geen dubbele claim;
  - de daggrens en het vervallen;
  - claimen zonder service-role wordt geweigerd. Gevonden en verholpen: `<>` liet een
    sessie zonder rol door, nu staat er `is distinct from`;
  - een ingelogde gebruiker leest de wachtrij niet;
  - een kapotte wachtrij laat het opslaan van een ticket niet mislukken.
- `npm run test:mobile -- --theme=both` (zie de commit).

## Uitrollen

Merge naar `staging` en push. Daarmee gebeurt het volgende:

- Cloudflare Pages bouwt de app.
- *Deploy Supabase (staging)* zet de migratie en alle edge functions neer en draait de
  rooktest.

Er is geen nieuwe cron nodig: de runner die elke minuut loopt, pakt ook de
gebeurtenissen op. Er zijn geen nieuwe secrets.

Een oude browserpagina die een nieuwe handeling goedkeurt, zegt "Herlaad de pagina" in
plaats van iets half te doen. De volgorde van uitrollen maakt dus niet uit.
