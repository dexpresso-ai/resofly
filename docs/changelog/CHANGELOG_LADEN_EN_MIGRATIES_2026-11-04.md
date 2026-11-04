# Changelog: laden per module, en een nieuwe database vanaf nul (2026-11-04)

Twee punten uit de doorlichting van de codebase:

1. De werkruimte laadde bij het opstarten 56 tabellen in hun geheel, en na bijna
   elke wijziging opnieuw.
2. Een nieuwe database kon je niet installeren. De README verwees naar een
   schema van april, en de migraties liepen op een lege database al bij de eerste
   stap stuk.

## 1. Laden per module

**Hoe het nu werkt** (`src/lib/dataGroups.ts`):

- Bij het opstarten laadt alleen de kern: klanten, projecten, taken, offertes,
  facturen, en wat zoeken, de tabbladen, het kruimelpad en Gerrie gebruiken.
- Vijf groepen laden pas als een pagina ze nodig heeft, en blijven daarna
  bewaard:

  | Groep | Tabellen | Pagina's |
  | --- | --- | --- |
  | uren | `time_entries` | Uren, Agenda, Weekplanner, Klant, Project |
  | communicatie | `ticket_notes`, `client_calls` | Berichten, Klant, het ticketvenster |
  | verloop offertes en facturen | gebeurtenissen, verzendingen, betalingen, versies, terugbetalingen, creditnota's, chargebacks, aanmaningen | Offertes, Facturen, Project |
  | boekhouding | journaalposten en -regels, perioden, boekjaren, activa, afschrijvingen, btw-aangiftes | Grootboek, Bank, Btw, Activa, Winst & verlies |
  | bank | rekeningen, afschriften, transacties, regels, koppelingen | Bank, Btw |

- **Na een wijziging** ververst de app de kern plus de groepen van de pagina die
  openstaat. Andere geladen groepen worden "verouderd": opent een pagina die ze
  nodig heeft, dan staat de oude stand er meteen, en de nieuwe komt op de
  achtergrond binnen.
- **Een pagina rendert pas als al zijn groepen er zijn.** Tot dan staat er
  "Gegevens laden…", nooit een lege lijst die nog onderweg is. Lukt laden niet,
  dan zegt de pagina dat, met een knop *Opnieuw proberen*. Hij probeert het niet
  vanzelf opnieuw, zodat de app bij een storing niet blijft hameren.
- **Het ticketvenster** opent vanaf elke pagina en laadt de tijdlijn zelf. Tot die
  binnen is, staat er "Tijdlijn laden…".
- **Het dashboard** telde de af te letteren banktransacties en de in te dienen
  btw-aangiftes uit de volledige bank en boekhouding. Nu zijn dat twee tellingen
  (HEAD-verzoeken) in de kern.
- **Volgorde van antwoorden.** Een antwoord voor een vorige organisatie wordt
  weggegooid, net als een ouder antwoord dat later binnenkomt. De groepen van de
  ene organisatie staan dus nooit onder de andere.
- **Bijvangst.** Zestien lijstladers haalden maar de eerste 1000 rijen op
  (PostgREST kapt stil af):
  - de hele geschiedenis van offertes en facturen;
  - de tickettijdlijn;
  - documenten en mappen;
  - de agendakoppelingen;
  - het handschrift.

  Ze pagineren nu, zoals het commentaar bij `fetchAllPages` al beloofde.

**Na een onafhankelijke review aangescherpt.** Een tweede lezer, zonder de
redenering van de bouwer, vond geen lek tussen organisaties en geen pagina die
een groepsveld leest zonder hem te vragen. Wel deze vier punten, nu opgelost:

- **Mislukt verversen van een groep die al in beeld staat, bleef stil.** De
  pagina toonde de stand van vóór de wijziging, zonder melding. Nu zegt een balk
  het ("Bijwerken lukte niet …; kies Ververs"), en de groep is verouderd. Vroeger
  gaf een mislukte herlaadslag dezelfde balk.
- **Een gestopte timer kon uit beeld vallen.** Liep er nog een aanvraag voor de
  uren, dan veegde die de nieuwe post weg. Nu vervalt zo'n aanvraag na een eigen
  wijziging, en komt er een nieuwe voor in de plaats.
- **Bij een stroom verversingen kwam niets meer binnen.** Rondes haalden elkaar
  in en streepten elkaar weg. Nu loopt `loadWorkspace` één ronde tegelijk, met
  hooguit één ronde erachteraan voor alle vragers van intussen. Een groep toont
  het nieuwste antwoord dat binnen is, in plaats van alleen het laatst gevraagde.
- **"Tijd reserveren" wachtte op alle uren.** Nu haalt het alleen de geboekte
  minuten van die ene taak op, en stopt het als je intussen van organisatie
  wisselt.

Plus twee kleinere punten:

- Bij een wissel van organisatie staat er een laadscherm tot de nieuwe kern
  binnen is. Er is dan niets van de vorige organisatie te zien, ook niet als de
  nieuwe kern niet laadt.
- Wat bij uitloggen nog onderweg was, komt niet meer in beeld.

**Bewaakt door:**

- `src/lib/dataGroups.test.ts`. Een struikeldraad faalt zodra een bestand buiten
  `GROUP_FILES` een groepsveld leest. Daarnaast tests voor de toestand per groep
  (geladen, verouderd, mislukt).
- `tests/laden` (`npm run test:loading`, ook in CI). In Chromium, tegen de
  nagebootste backend, controleert hij:
  - per pagina precies de eigen tabellen;
  - daarna de pagina zelf;
  - bewaren;
  - verversen op de achtergrond;
  - het ticketvenster;
  - een mislukte groep, en opnieuw proberen;
  - een mislukte ververs van een groep die al in beeld staat (de balk);
  - twintig keer verversen in vijf seconden terwijl een groep traag is.

  Tegen de code van vóór de review faalden die laatste twee: geen balk, en
  20 overlappende rondes voor 20 klikken.

## 2. Een nieuwe database vanaf nul

**Wat er mis was:** de migraties begonnen bovenop een schema dat ooit met de hand
in de SQL-editor was gezet (`FRESH_INSTALL_COMPLETE_SCHEMA.sql`, v2.2.1). Daarbij:

- draaiden twee paren migraties uit mei in een andere volgorde dan hun nummers;
- kwamen een functie en een event-trigger uit het dashboard;
- was staging op twee punten met de hand gerepareerd.

**Hoe het is rechtgezet,** zonder één versienummer te veranderen. Staging merkt er
dus niets van; de details staan in `supabase/migrations/README.md`.

- `20260427000000` is nu de basis: v2.2.1 zoals staging begon. De dertien
  migraties van eind april zaten daarin en zijn leeg.
- De paren van 15 en 27 mei zijn omgewisseld naar de volgorde waarin ze echt
  draaiden.
- `20261101060000` maakt zelf `rls_auto_enable()` en de trigger `ensure_rls`.
- `20260526000000` definieert `invoice_token_hash` zoals hij op staging staat, met
  een vaste `search_path`. De eerste versie faalde vanuit
  security-definer-functies, en daarmee de publieke factuurlinks. Staging was
  ooit in de SQL-editor gerepareerd.

**Eerst een nieuwe migratie, toen niet.** De reparatie stond eerst in een nieuwe
migratie (`…060500`, later `…070500`). Terwijl dit werk liep, rolden twee andere
sessies er ook migraties uit (`20261104070000` en `20261104075000`). Elke keer
was de nieuwe versie daardoor ouder dan de laatste op staging, en dat weigert
`supabase db push`. De reparatie hoort bovendien bij de definitie zelf. Ze staat
nu daar, en deze uitrol voegt geen migratie toe.

De jaarprijzen van de abonnementen zijn op staging met de hand gezet. Ze staan
bewust niet in een migratie: volgens 20260626000002 zijn ze een instelling per
omgeving (0 = geen jaarabonnement). Een nieuwe omgeving zet ze zelf; zie stap 5
in `supabase/migrations/README.md`.

**Getest met de echte Supabase-images** (Postgres 17.6.1.111, net als staging):

- alle 232 migraties lopen op een lege database, ook de twee van de andere
  sessies;
- de versielijst is gelijk aan die van staging, dus `db push` heeft niets te doen;
- vergeleken met staging is de vingerafdruk gelijk:
  - tabellen en kolommen;
  - constraints en indexen;
  - functie-inhoud, triggers en policies;
  - rechten, types en buckets;
  - de referentiedata.

  Er zijn drie bewuste verschillen:
  - `public._migrations`, een oud logboek dat niemand gebruikt;
  - `pg_cron`, dat zet je per project aan;
  - de jaarprijzen, die zijn een instelling per omgeving.

**Verder:**

- de drie verouderde schema-snapshots zijn weg;
- `seed.sql` gebruikte een kolom die niet meer bestaat en is nu leeg;
- CI-job `migrations` speelt de keten bij elke pull request af;
- `scripts/schema-vergelijken.sh` herhaalt de vergelijking met staging.

## Opgeruimd

- 229 losse documenten zijn uit de root naar `docs/` verhuisd: `changelog`,
  `setup`, `plannen`, `rapporten`. De namen zijn gelijk gebleven, dus elke
  verwijzing in de code vind je op naam terug. Alle 93 relatieve links zijn
  bijgewerkt en gecontroleerd.
- `README.md` is herschreven. Hij heette nog BrandCore v2.1.3, met
  installatie-instructies van april.
- `CLAUDE.md` is nieuw, met de vaste afspraken: tenantgrens, voorstellen in plaats
  van uitvoeren, migraties, laden per module, en welke tests je draait.

## Uitslag van de controles

Op de stand die naar staging gaat, na het samenvoegen met het werk van de
andere sessies van vandaag:

| Controle | Uitslag |
| --- | --- |
| `npm run typecheck` | schoon |
| `npm test` | 949 tests groen, waarvan 16 nieuw in `dataGroups.test.ts` |
| `npm run test:loading` | 103 controles groen, twee keer na elkaar |
| `npm run test:mobile -- --theme=both` | 288 metingen, geen problemen |
| `npm run build` | geslaagd |

Daarnaast, met de echte Supabase-images:

- alle 233 migraties lopen op een lege database;
- de vingerafdruk is gelijk aan staging, op de bewuste verschillen na;
- de versielijst is gelijk aan die van staging.

De CI-rondes op de branch (`Frontend checks`, met de nieuwe jobs `migrations` en
*Laden per module*) waren groen.
