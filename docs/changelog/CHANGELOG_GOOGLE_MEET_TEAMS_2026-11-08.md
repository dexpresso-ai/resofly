# Google Meet en Teams vanuit ResoFly (2026-11-08)

## Aanleiding

"Zodra je via Google je agenda koppelt, wil ik dat je vanuit ResoFly ook
Google Meet-links automatisch aan kan maken. Dit geldt ook voor Microsoft,
maar dan met MS Teams."

Wat er al was: bij een nieuwe afspraak in een gekoppelde Google- of
Microsoft-agenda kon je "Google Meet/Teams" kiezen. Wat er niet kon, of
misging:

- **Gerrie en een gekoppelde AI (MCP)** maakten bij "plan een videocall"
  altijd een Jitsi-link, ook in een Google-agenda. Meet of Teams vragen kon
  niet.
- **De ResoFly-agenda, boekingslinks daarop en de teamchat** kenden alleen
  Jitsi of een geplakte link.
- **Bewerken**: een afspraak met Meet stond in het formulier als "Eigen link",
  en bij elke bewerking (ook slepen in het rooster) kwam de Meet-link als regel
  in de omschrijving. Meet erbij kiezen bij een afspraak die al een Meet had,
  vroeg Google om een tweede.
- **Teams op een privé-Microsoftaccount** (outlook.com): Microsoft maakte de
  afspraak zonder Teams, zonder foutmelding. De klant had geen link en niemand
  wist het.
- **Een Meet die Google nog aan het maken was** ("pending") gaf een
  boekingsbevestiging zonder link.

## Wat er nu kan

### Bij een afspraak (nieuw en bewerken)

- Het blok **Videovergadering** heeft vijf keuzes: **Geen · Jitsi Meet ·
  Google Meet · Teams · Eigen link**. Google Meet en Teams staan er waar ze
  kunnen:
  - **van de agenda zelf**: Meet in een Google-agenda, Teams in een
    Microsoft-agenda. Werkt meteen na het koppelen, zonder extra stap;
  - **los, met je eigen koppeling**: in de ResoFly-agenda, of Teams bij een
    Google-afspraak (en andersom), als je dat bij Instellingen → Agenda hebt
    aangezet (zie hieronder).
- Een bestaande Meet of Teams staat als zodanig in het formulier. Laat je hem
  staan, dan verandert er niets aan (geen regel in de omschrijving, geen tweede
  vergadering). Kies je iets anders, dan gaat een Meet eraf; een Teams-
  vergadering kan Microsoft niet via een koppeling weghalen, en dat zegt
  ResoFly dan ook.
- Kan het niet, dan staat de keuze er niet, met de reden eronder: "Google Meet
  ook hier? Zet het aan bij Instellingen → Agenda", of "Dit Microsoft-account
  maakt geen Teams-vergaderingen".
- Opgeslagen, maar met een kanttekening (Google maakt de Meet nog, Microsoft
  zette er geen Teams bij): een oranje melding boven de agenda.

### Instellingen → Agenda

- Per gekoppeld Google- of Microsoft-account een regel: **Google Meet
  aanzetten** / **Teams aanzetten**. Dat is één keer toestemming geven bij
  Google of Microsoft voor losse vergaderingen (ResoFly-agenda, boekingslinks,
  teamchat). Je agenda's en instellingen blijven staan.
- Bewust **apart** en niet bij het koppelen zelf: een Workspace-beheerder die
  Meet voor apps blokkeert, of een Microsoft-tenant waar alleen de beheerder
  rechten goedkeurt, liet anders de hele agendakoppeling weigeren, ook voor wie
  nooit Meet wilde.
- Een privé-Microsoftaccount krijgt geen knop maar uitleg: Teams kan alleen met
  een werk- of schoolaccount van Microsoft 365.
- De kaart **Videovergaderen** legt de drie diensten uit.

### Boekingslinks

- Nieuwe keuzes: **Google Meet — per boeking, met je Google-account** en
  **Teams — per boeking, met je Microsoft-account**, ook op een ResoFly-agenda.
  Op een Google- of Microsoft-agenda blijft "van je agenda" de keuze.
- Die vergaderingen komen van het account van de **maker** van de link. Een
  collega kan een link daarom niet op Meet/Teams van zijn eigen account zetten.
- Lukt de Meet of Teams bij een boeking niet (toestemming ingetrokken, de API
  staat uit), dan gaat de boeking toch door, zonder link, en staat in de
  melding aan de eigenaar dat hij zelf een link moet sturen.

### Teamchat

- "Nu vergaderen" en "Nu bellen" hebben naast Jitsi ook **met Google Meet** en
  **met Teams**, als je dat aanzette.

### Gerrie en gekoppelde AI (MCP, API)

- `propose_calendar_event`: `video_call` kiest nu wat de agenda kan (Meet bij
  Google, Teams bij Microsoft, anders Jitsi), en `video_service`
  (`google_meet`, `teams`, `jitsi`) kiest zelf. Kan het niet, dan krijgt Gerrie
  de uitleg terug ("geef eerst toestemming…; Jitsi kan altijd") in plaats van
  een voorstel dat bij het akkoord stukloopt.
- `propose_edit_calendar_event`: `video_service` zet een videovergadering op een
  bestaande afspraak, of haalt hem eraf (`none`).
- `calendar_event.set_meeting_url` kreeg `video_service`;
  `booking_link.create`/`update` kregen `google_meet` en `teams` als
  `conference_provider`.
- Een Meet of Teams ontstaat pas bij het akkoord, langs dezelfde weg als de knop
  in de agenda en met de koppeling van wie akkoord geeft. Gerrie maakt zelf
  niets (een Jitsi-link staat al op de kaart, zoals voorheen).

## Ook gerepareerd onderweg

- **Een wijziging via Gerrie wiste de afspraak leeg.** "Verplaats naar drie
  uur" stuurde een lege omschrijving en locatie mee: bij Google en Microsoft
  verdwenen die (en de videocall-regel), en bij een ResoFly-afspraak kregen alle
  genodigden een afzegging en ging de herhaling eraf. Nu verandert een
  bewerking alleen wat genoemd wordt; de rest blijft staan. Het scherm stuurt
  altijd alles mee en merkt daar niets van.
- **Gerrie en hele dagen of herhalingen.** Een hele-dag-afspraak wijzigen via
  Gerrie liep bij het akkoord stuk op "Eindtijd moet na starttijd liggen", ook
  als alleen de titel veranderde (de app rekende de tijden om uit datum en uur,
  en dan was begin gelijk aan einde). Een herhalende ResoFly-afspraak schoof met
  de hele reeks naar het gevonden voorkomen. Gerrie verplaatst die nu niet meer
  (dat gaat in het agendascherm) en houdt bij andere wijzigingen de tijden
  precies zoals ze waren, ook het einde van een meerdaagse hele dag (dat bewaart
  de ResoFly-agenda anders dan Google en Microsoft).
- **Genodigden hoorden een verplaatsing via Gerrie niet**: Google mailde alleen
  als de genodigden werden meegestuurd. Nu altijd (Google mailt alleen als er
  genodigden zijn).
- **Weggelaten afspraken in een reeks kwamen terug** bij elke bewerking van een
  herhalende ResoFly-afspraak (`exdate` werd gewist). Nu blijven ze weg zolang
  begin en regel gelijk blijven.

## Beveiliging

- **Alleen je eigen koppeling.** Een losse vergadering komt altijd van een
  koppeling van wie erom vraagt, in deze organisatie (`organization_id` uit de
  sessie, `user_id` van de aanvrager). Ook als een collega zijn agenda deelt,
  maakt niemand vergaderingen in diens account.
- **Het nieuwe recht is optioneel en apart** (incrementele toestemming); de
  gewone koppeling vraagt niets extra's.
- **Microsoft vernieuwt alleen met gegeven rechten.** Vroeg de vernieuwing om
  een recht dat nooit gegeven is, dan weigerde Microsoft (`invalid_grant`), en
  dat telde als "ingetrokken": met het Teams-recht vast in de lijst was na de
  uitrol elke bestaande Microsoft-koppeling op "Verlopen" gesprongen.
- **Links van buiten worden gecontroleerd**: wat Google of Microsoft als
  vergaderlink teruggeeft, moet https zijn en van meet.google.com of
  teams.microsoft.com/teams.live.com komen. Zo komt er nooit een vreemde link in
  een uitnodiging aan een klant.
- **Modulerechten**: een losse vergadering maken vraagt schrijfrechten op de
  agenda, zoals een afspraak maken. Een kijker kan het niet.
- **Privé-afspraken van een collega blijven van die collega.** In een gedeelde
  agenda ziet een collega een privé-afspraak als "Bezet", en het scherm laat
  hem die niet bewerken. De server liet het wel toe. Met "niet genoemd = blijft
  staan" gaf een bewerking zonder omschrijving via de API of Gerrie dan zelfs
  de afgeschermde omschrijving terug (gevonden in een onafhankelijke
  beveiligingsreview van deze wijziging). Nu weigert de server bewerken én
  verwijderen van andermans privé-afspraak vóórdat er iets verandert (403), en
  zet Gerrie geen wijziging of afzegging meer klaar. Eerst kreeg zo'n afspraak
  bij het akkoord de titel "Bezet". Bij Microsoft vraagt ResoFly de afspraak op
  via de gedeelde agenda zelf, zodat een afspraak uit een andere agenda van de
  eigenaar niet meetelt.
- De tekst van Google of Microsoft bij een fout blijft in het log; de gebruiker
  leest een eigen, Nederlandse uitleg.

## Bestanden

- `supabase/functions/_shared/conference.ts` (+ test) — de regels: wat een agenda
  zelf kan, de vergadering op een afspraak teruglezen (ook "pending"), welke
  koppeling, wat een fout betekent, en wat er met de video moet gebeuren.
- `supabase/functions/_shared/calendarEventBody.ts` (+ test) — wat er naar
  Google en Microsoft gaat, met "niet genoemd = blijft staan".
- `supabase/functions/_shared/onlineMeetings.ts` — losse Meet (Meet REST API) en
  Teams (Graph `/me/onlineMeetings`), en de videostatus per gebruiker.
- `supabase/functions/_shared/calendarOAuth.ts` (+ test) — het aparte recht, de
  vlag in de state, en `microsoftRefreshScopes`.
- `supabase/functions/_shared/calendarEventWrite.ts` — aanmaken en bewerken
  (verhuisd uit `calendar-integrations`), Meet/Teams, "pending", weghalen.
- `supabase/functions/_shared/calendarCore.ts`, `calendarAvailability.ts`,
  `meetingLinks.ts`.
- `supabase/functions/calendar-integrations/index.ts` — `oauthStart` met
  `meetings`, `videoServices`, `createMeeting`, en per agenda
  `conference_types` bij "Agenda's ophalen".
- `supabase/functions/meeting-booking{,-public}/index.ts` — Meet/Teams per
  boeking, wie dat mag kiezen, en de boeking die doorgaat als de video niet lukt.
- `supabase/functions/_shared/gerrieCore.ts`, `_shared/actions/calendar.ts`
  (+ `conferenceActions.test.ts`).
- `supabase/migrations/20261108190000_videovergadering_meet_teams.sql` —
  `calendar_sources.conference_types`, `google_meet`/`teams` als
  `conference_provider`, en het logboek telt `conference_types` niet als
  wijziging.
- App: `src/lib/meeting.ts` (+ test), `src/lib/calendar-api.ts`, `src/types.ts`,
  `src/features/CalendarPage.tsx`, `src/components/BookingVideoSelect.tsx`,
  `src/features/MeetingBookingManager.tsx`, `src/components/teamchat/Dialogs.tsx`,
  `src/main.tsx`, `src/lib/gerrie-api.ts`, `src/lib/gerrie-proposals.ts`,
  `src/components/GerrieChat.tsx`, `src/lib/actions/calendar.ts`,
  `src/styles/globals.css`, `src/styles/teamchat.css`.
- Tests: `tests/stromen/videovergadering.mjs` (nieuw), `tests/stromen/nep-agenda.mjs`
  (Meet, Meet REST API, Teams, en een Microsoft die zich gedraagt als het echte),
  `tests/mobile/mock/*`.
- `docs/setup/CALENDAR_INTEGRATION_SETUP.md`.

## Getest

- `npm run typecheck` en `npm run build` — schoon.
- `npm test` — 1317 tests, waarvan 30 nieuw — allemaal groen.
- `deno check` op alle 39 bestanden uit de CI-lijst — schoon (lokaal met een
  import map naar npm; esm.sh en deno.land zijn hier niet bereikbaar).
- De migratieketen vanaf nul (`supabase start` met alle migraties), en de nieuwe
  migratie nog eens: veilig herhaalbaar; `zoom` als `conference_provider` wordt
  geweigerd; de app leest `conference_types` wel en `feed_url` nog steeds niet;
  `audit_field_spec` is voor anon dicht en geeft verder hetzelfde als eerst.
- `npm run test:stromen -- videovergadering` — **51 stappen, 0 fout**: de echte
  edge functions tegen de lokale database, met nep-Google en nep-Microsoft. O.a.
  Meet en Teams van de agenda, "pending", geen tweede Meet bij opnieuw opslaan,
  geen regel in de omschrijving, een bewerking zoals Gerrie die niets wist,
  overstappen naar Jitsi (Meet eraf, Teams met kanttekening), toestemming aan
  en uit, de Meet API uit, een collega en een andere organisatie die niets
  kunnen, Microsoft-vernieuwing met en zonder Teams-recht, boekingen met Meet
  (ook als de Meet niet lukt), en Gerrie via een echte MCP-koppeling: klaarzetten
  en dan het akkoord zoals de app het doet (Meet erbij, Meet eraf, een hele dag
  in Google en een meerdaagse hele dag in de ResoFly-agenda hernoemen zonder dat
  de dagen verschuiven). Die laatste stap faalt zonder de reparatie. En
  privé-afspraken van een collega (Google en Microsoft): niet bewerken, niet
  verwijderen, geen omschrijving in het antwoord, niets klaargezet door Gerrie;
  een gewone gedeelde afspraak en de eigen privé-afspraak wel. Zonder de nieuwe
  controles falen die stappen.
- `npm run test:stromen -- agenda` — 36 stappen, 0 fout (ongewijzigd gedrag).
- De hele stromen-suite: 778 stappen. Vijf fouten in de herinneringen
  (rekendatum 8 vs. 9 november): de run viel rond middernacht in Amsterdam,
  terwijl het in UTC nog de 8e was. Na middernacht UTC opnieuw
  `npm run test:stromen -- herinneringen`: 66 stappen, 0 fout. Daarna de hele
  suite nog eens: 785 stappen, 0 fout; en na de afscherming van
  privé-afspraken: **791 stappen, 0 fout**.
- `npm run test:mobile -- --theme=both` — 410 pagina's gemeten, 0 met problemen;
  plus schermafdrukken van het videoblok (vijf keuzes: drie en twee),
  Instellingen → Agenda en de videokaart, op telefoon en desktop, licht en
  donker, zonder JavaScript-fouten.
- `npm run test:loading` — 103 controles, alle geslaagd.
- `tests/stromen/ui.mjs agenda` (koppelen, verlopen, opnieuw koppelen,
  loskoppelen in Chromium tegen de lokale stack) — 7 stappen, 0 fout.

## Uitrollen

- Push naar `staging`: de workflow zet eerst de migratie en dan de functies
  neer. Die volgorde is nodig: de functies lezen en schrijven `conference_types`.
- De app mag vóórlopen: tegen de oude functies werkt alles als eerst (zonder
  `videoServices` toont de app alleen wat de agenda zelf kan).
- **Geen nieuwe secrets.**

### Uitrol op staging (9 november 2026, 00:22 UTC)

- Merge `6d3a990` naar `staging`. Staging had sinds de afsplitsing alleen
  documentatie erbij (opnames, migrations/README), geen overlap.
- *Deploy Supabase (staging)*, run 198: geslaagd. `db push` paste alleen
  `20261108190000` toe (de laatste op staging was `20261108171500`), daarna
  alle 39 functies, en de rooktest is groen (o.a. `api` antwoordt, en laadt
  daarbij de handelingenregistry met deze wijziging).
- Nacontrole op staging, alleen lezen (Management API, `read_only`):
  - `calendar_sources.conference_types` bestaat (`text[]`); de app mag hem
    lezen, `feed_url` nog steeds niet;
  - de check op `meeting_booking_links.conference_provider` laat `calendar`,
    `jitsi`, `google_meet` en `teams` toe;
  - `audit_field_spec` is dicht voor `anon` en `authenticated`, en telt
    `conference_types` niet als wijziging;
  - de functies `calendar-integrations`, `meeting-booking(-public)`, `api`,
    `mcp` en `gerrie-agent(-runner)` staan op de nieuwe versie (ACTIVE);
  - 0 van de 8 Google-/Microsoft-agenda's hebben al `conference_types`. Dat
    vult zich zodra iemand zijn account (opnieuw) koppelt, Meet of Teams
    aanzet, of bij Instellingen → Agenda op **Agenda's** klikt. Tot dan werkt
    alles zoals eerst: ResoFly vraagt de vergadering aan, en zet Google of
    Microsoft er geen bij, dan staat dat als kanttekening bij de afspraak.
- Cloudflare Pages: de build van `staging` (`6d3a990`) is geslaagd.

### Wat de beheerder van ResoFly zelf moet doen

Voor Meet en Teams **in de eigen Google- of Microsoft-agenda** is niets nodig.
Voor de losse vergaderingen (ResoFly-agenda, boekingslinks daarop, teamchat):

1. **Google Cloud Console**, het project van de agendakoppeling:
   - APIs & Services → Library → **Google Meet REST API** → Enable.
   - Google Auth Platform → Data access → scope
     `https://www.googleapis.com/auth/meetings.space.created` toevoegen.
   Zonder de API zegt ResoFly bij "Google Meet aanzetten" netjes: "Google Meet
   staat voor deze ResoFly-omgeving nog niet aan".
2. **Microsoft Entra** → App registrations → de agenda-app → API permissions →
   Microsoft Graph → Delegated → **OnlineMeetings.ReadWrite** toevoegen (geen
   beheerderstoestemming nodig, tenzij de tenant dat eist).
3. **Staging**: de Google-koppeling staat sinds 14 oktober op "Fout · Bad
   Request" (Google trok het vernieuwtoken in). Koppel hem opnieuw via
   Instellingen → Agenda → **Opnieuw koppelen**; daarna werkt Meet in je
   Google-agenda meteen, en "Google Meet aanzetten" voor de rest.

## Goed om te weten

- **Teams kan alleen met een werk- of schoolaccount** van Microsoft 365 met
  Teams. Microsoft biedt geen manier om met een privé-account (outlook.com) via
  een koppeling Teams-vergaderingen te maken.
- **Een Teams-vergadering haal je in Outlook weg**; Microsoft laat dat niet via
  een koppeling toe. Kies je in ResoFly iets anders, dan toont ResoFly de nieuwe
  link en zegt erbij dat Teams in Outlook blijft staan.
- **Wie de Meet-ruimte "bezit"**: een losse Meet is van het Google-account van
  wie hem maakte. Gasten van buiten de organisatie vragen bij Google Meet om
  toegang (de standaard van Google); de organisator laat ze binnen.
- Toestemming intrekken kan bij Google (myaccount.google.com → Beveiliging →
  apps van derden) of Microsoft (myapps.microsoft.com); daarna toont ResoFly
  "Google Meet aanzetten" weer.
