# Accountlead per klant en tickets toewijzen — 11 november 2026

Vraag: *"Bouw een functionaliteit waarbij je per klant een accountlead aan kunt wijzen. Dit zou dan
een van de teamleden moeten zijn. Hier moet ook gerapporteerd kunnen worden via de
rapportagetool. Bouw daarna een functionaliteit waarbij je ook tickets in het ticketsysteem op een
specifieke naam kunt toewijzen. Ook hier moet men op kunnen rapporteren."*

## Wat er nu kan

### Accountlead per klant

- **Kiezen.** In het klantvenster staat onder Status het veld *Accountlead*: een teamlid, of
  *Geen accountlead*. Ook bij een nieuwe klant.
- **Zien.** In de klantenlijst staat de accountlead op de kaart (avatar en naam) en in de tabel
  (kolom *Accountlead*). In het klantdossier staat hij bij de gegevens.
- **Filteren en zoeken.** Het filter *Accountlead* in de klantenlijst kent *Mijn klanten*,
  *Zonder accountlead* en elk teamlid. Zoeken op de naam van de accountlead werkt ook.

### Tickets toewijzen

- **Toewijzen.** In het ticketvenster staat het veld *Toegewezen aan*: een teamlid, of
  *Niet toegewezen*.
- **Zien.** De ticketlijst toont wie het ticket heeft: avatar en naam in de lijst en in de tabel
  (kolom *Toegewezen*, sorteerbaar). Op de telefoon alleen de avatar, zodat de klantnaam zijn ruimte
  houdt.
- **Filteren en zoeken.** Twee nieuwe snelfilters vooraan: *Aan mij* en *Niet toegewezen*.
  Daarnaast het filter *Toegewezen aan* per teamlid. Zoeken op de naam van het teamlid werkt ook.
- De klant ziet niet wie zijn ticket heeft; het portaal kiest zijn eigen kolommen.

### Rapporteren

- **Rapportbouwer.**
  - Nieuwe dimensies en filters:
    - *Accountlead* bij klanten;
    - *Accountlead (klant)* bij facturen, offertes, projecten en tickets;
    - *Toegewezen aan* en *Openstaand* bij tickets.
  - Het filter op een teamlid kent ook *Ik (wie het rapport bekijkt)*. Zo werkt één gedeeld of op
    het dashboard vastgezet rapport ("mijn openstaande tickets") voor elke collega met zijn eigen
    cijfers.
  - Een opgeslagen filter onthoudt het teamlid op id, niet op naam: de naam is het e-mailadres en
    dat kan veranderen.
  - Nieuwe sjablonen:
    - Omzet per accountlead;
    - Klanten per accountlead;
    - Openstaande tickets per teamlid;
    - Afgehandelde tickets per teamlid.
- **Rapportages met Gerrie.** `query_records` kent nu de velden:
  - `account_lead` en `account_lead_id` bij facturen, offertes, klanten, projecten en tickets;
  - `assignee` en `assignee_id` bij tickets.

  Vragen als "omzet per accountlead dit jaar" of "doorlooptijd van tickets per behandelaar" kunnen
  dus. Zonder leesrecht op Klanten blijft de accountlead op een factuur leeg, met een melding: wie
  welke klant beheert, is klantinformatie.
- **Gerrie in de chat.**
  - `search_clients` filtert op `account_lead_user_id` en `list_tickets` op `assignee_user_id`
    ("me" = jezelf, "none" = niemand). Beide geven de naam terug.
  - Een rapportagevoorstel (`propose_report`) kan op accountlead en toegewezen groeperen en
    filteren. Ook *omzet excl. btw* (`subtotal`), die de bouwer al had, kan Gerrie nu voorstellen.

### Gerrie, agents, MCP en de API

- Twee nieuwe handelingen:
  - `client.set_account_lead`: accountlead kiezen of weghalen, voor één of meer klanten;
  - `ticket.assign`: toewijzen of de toewijzing weghalen, voor één of meer tickets.

  Ze komen als kaart in de goedkeurwachtrij en lopen na goedkeuring langs dezelfde weg als het
  formulier. Een koppeling die rechtstreeks mag uitvoeren, schrijft als het teamlid.
- `propose_client` en `propose_ticket` kunnen meteen een accountlead of een behandelaar meegeven.
- De API kent `account_lead_user_id` op klanten en `assignee_user_id` op tickets. Je kunt ze
  lezen, zetten en erop filteren. Webhookberichten bevatten ze ook; een toewijzing is dus een
  `ticket.updated`.

## De regels

- **Alleen een teamlid.** Accountlead of behandelaar is altijd:
  - een actief teamlid van dezelfde organisatie;
  - geen boekhouder;
  - iemand die de module (Klanten of Tickets) mag zien.

  De database dwingt dat af (`public.member_can_hold`), ook voor de API en de handelingen. De
  keuzelijst in de app en de goedkeurkaart volgen dezelfde regel. Een id van iemand uit een andere
  organisatie komt er dus niet in.
- **Wie de toegang verliest, laat los.** Wordt een teamlid uitgeschakeld of verwijderd, wordt hij
  boekhouder, of gaat de module voor hem dicht? Dan vervallen zijn accountleadschap en zijn
  tickettoewijzingen in die organisatie. Ze komen op *Geen accountlead* en *Niet toegewezen* te
  staan.

  Liet je ze staan, dan lag werk op naam van iemand die het niet meer ziet, en viel dat in geen
  enkel filter op.
- **Eén persoon per ticket**, anders dan bij taken. Bij een ticket wil je weten wie het antwoord
  geeft; met meerdere namen erop doet in de praktijk niemand het.

## Techniek

- Migratie `20261111160000_accountlead_en_tickettoewijzing.sql`:
  - kolommen `clients.account_lead_user_id` en `tickets.assignee_user_id`;
  - de controle en het loslaten;
  - indexen;
  - `create_client_with_next_code` neemt de accountlead mee. Zonder dat verdween een accountlead
    die je bij een nieuwe klant koos, want die functie noemt zijn kolommen één voor één;
  - `webhook_payload_columns` met de twee velden.
- `src/lib/reporting.ts`:
  - teamlidvelden (`memberDimension`) met eigen filterkeuzes (`filterOptions`) en vergelijking
    (`matches`);
  - `runReport` krijgt de teamleden en wie er kijkt mee.
- `src/lib/format.ts`, `members.ts` en `reporting.ts` importeren met `.ts`, zodat `npm test` ze kan
  laden.

## Getest

- `npm run typecheck` en `npm test`: 1580 tests, allemaal groen. Nieuw:
  - `src/lib/reporting.test.ts`;
  - `src/lib/members.test.ts`;
  - `supabase/functions/_shared/actionHolders.test.ts`;
  - twee tests in `reportRecords.test.ts`: per accountlead, per behandelaar, en de boekhouder
    zonder Klanten.
- `supabase db reset`: de hele keten vanaf nul, op Postgres 17.11.0.018. Met SQL op die database
  getoetst:
  - toewijzen aan een teamlid lukt, ook als ingelogd teamlid via RLS;
  - iemand uit een andere organisatie en de boekhouder worden geweigerd;
  - opslaan zonder de toewijzing te wijzigen loopt niet vast;
  - Tickets dicht voor een teamlid laat zijn tickets los, maar niet zijn klanten;
  - uitschakelen laat ook de klanten los;
  - een nieuwe klant via `create_client_with_next_code` houdt zijn accountlead;
  - de webhookvelden staan erin.
- `deno check` op de lijst uit `frontend-checks.yml`: schoon. esm.sh en deno.land zijn vanuit de
  cloudsessie niet bereikbaar, dus de controle liep met een tijdelijke importmap: esm.sh naar
  dezelfde npm-versies, en `serve` uit std als stub. In de repo is niets veranderd.
- `npm run test:mobile -- --theme=both`: 500 pagina's gemeten, 0 problemen. De nep-backend heeft
  nu accountleads en toewijzingen, zodat de nieuwe kaarten, kolommen en avatars meegemeten worden.
- `npm run test:loading`: alle controles geslaagd.

## Wat nog kan

- Een pushmelding "Ticket aan jou toegewezen". Dat vraagt een nieuw meldingstype in de
  databasecontrole, de voorkeuren en de catalogus. Daarom is het een aparte stap.
