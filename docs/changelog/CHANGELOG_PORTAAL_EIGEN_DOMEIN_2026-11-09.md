# Het klantportaal op het eigen domein van de gebruiker — 9 november 2026

Vraag: *"Ik wil dat het klantenportaal ook in te stellen is op een eigen domein van de klant."*
Daarna verduidelijkt: het gaat om de klant van de gebruiker, en het portaal moet te gebruiken
zijn via bijvoorbeeld `portaal.fotostudiojansen.nl`: het domein van de gebruiker.

Eerder vandaag (`CHANGELOG_KLANTDOMEINEN_2026-11-09.md`) hielden we het portaal bewust van het
eigen domein af. Dit is hoe het nu wél kan, en waarom het veilig is.

## Wat er nu kan

- In **Instellingen → Domein**, bij een eigen domein, staat een schakelaar **"Ook het
  klantportaal op `<domein>`"**. Standaard uit; alleen de eigenaar of een beheerder zet hem
  om. In het Logboek: *"zette het klantportaal aan op portaal.jansen.nl"*.
- Staat hij aan, dan:
  - gaan de links in mails (welkomstmail, meldingen, gedeelde bestanden) naar
    `https://<domein>/portal`;
  - toont de Worker het portaal op het eigen domein, in de huisstijl, in plaats van door te
    sturen naar `<naam>.resofly.com`;
  - logt de klant daar in met de inlogmail, op dat adres;
  - komt de klant na een betaling via Mollie terug op het portaal waar hij betaalde.
- Gaat hij uit, of wordt het domein ontkoppeld of door een andere organisatie overgenomen, dan
  werkt een inlog van dat domein meteen niet meer, en is hij weg.

## Waarom dat niet zomaar kon

Een klant heeft één inlog voor het portaal (zijn e-mailadres). Die geldt bij elke gebruiker
van ResoFly bij wie hij klant is. De inlog staat in zijn browser, bij het adres waar hij
inlogde. De DNS van een eigen domein beheert de gebruiker zelf. Wijst Jansen
`portaal.jansen.nl` later naar een eigen server, dan leest een pagina daar alles wat de app
daar in de browser bewaarde. Met een gewone inlog zou Jansen dan zien wat de klant bij een
ander heeft (harde regel 1). En een inlog bij Supabase geldt voor het hele account: is de klant
ook teamlid bij een andere gebruiker (hetzelfde e-mailadres), dan opent hij ook die werkruimte.

## Hoe het nu werkt

### Op een eigen domein: een code van ResoFly en een sleutel, geen inlog bij Supabase

- De inlogmail bevat een link naar het eigen domein en een **code van ResoFly zelf** (acht
  cijfers). Supabase Auth geeft daar geen token uit en maakt geen inlog.
- Na de link of de code krijgt de browser een **sleutel** (`portal_tokens`): alleen voor het
  portaal van deze gebruiker, alleen vanaf dit domein, een maand geldig na het laatste gebruik.
  client-portal neemt hem aan in de kop `x-portal-token`.
- Wie de DNS van dat domein omlegt, leest dus hooguit een sleutel voor het portaal van zijn
  eigen klanten uit. Wat die klant bij anderen heeft, of een werkruimte elders, blijft dicht.
- Een inlog bij Supabase op een eigen domein weigeren `portal-login`, `client-portal` en de
  ontvangstpagina van zendingen, en die inlog maken ze ongeldig.

### Op de naam bij ResoFly en het algemene portaal: een vastgelegde inlog per gebruiker

Hier blijft het een inlog bij Supabase (deze adressen beheert alleen ResoFly), maar:

- **Elke inlog wordt vastgelegd** (`portal_sessions`), met wat hij mag zien: op
  `jansen.resofly.com` alleen Jansen, op het algemene portaal alles, zoals voorheen.
- **client-portal weigert een inlog die niet is vastgelegd.** Een sessie met een wachtwoord
  (bijvoorbeeld van iemand die met een uitgelekt token een wachtwoord instelde) of van de
  werkruimte geeft geen toegang tot het portaal. Ook de ontvangstpagina van een zending neemt
  alleen een vastgelegde inlog aan, binnen zijn bereik.
- De app wisselt de link of de code eerst in, legt de inlog dan vast (`portal-login`,
  `bindSession`) en slaat hem pas daarna op. Zo is er nooit een inlog in de browser die het
  portaal weigert.
- Wordt de naam bij ResoFly later van een ander (een oude naam is een jaar na het wijzigen
  weer vrij), dan geven de inloggen die daar nog in een browser staan niets meer.
- Wie ook ergens teamlid is (of uitgenodigd), krijgt in de inlogmail alleen de link, zonder
  code: die link werkt alleen in de browser die hem aanvroeg.

### De inlogmail

- De link gaat terug naar het adres waar de klant de inlog aanvroeg: daar staat het geheim van
  zijn browser. Eerst ging hij voor een klant met één leverancier naar diens adres, ook als hij
  op het algemene portaal aanvroeg; dan werkte de link niet.
- De mail zegt waar de code hoort: *"Vul de code alleen in op portaal.jansen.nl. Vraagt een
  andere website erom, vul hem dan niet in."*
- Op het algemene portaal, voor een klant van meer leveranciers, staat de mail niet in de
  huisstijl van één van hen (ook niet via `/portal/<sleutel>`): die inlog opent alles.
- Een oude app zonder het geheim van de browser krijgt *"Vernieuw de pagina en probeer het
  opnieuw."*

## Veiligheid

Gecontroleerd en getest: de nieuwe tabellen en functies zijn alleen voor de server (geen
rechten voor `anon` of `authenticated`), met het boekhouder-hek; het bereik komt altijd uit de
database (het adres van de aanvraag, opgezocht), nooit uit tekst in het verzoek; elke actie in
client-portal (alle 23) loopt via een lijst die op het bereik filtert, ook de gedeelde bestanden
en zendingen.

Bij de controle gevonden en gerepareerd, vóór de uitrol:

1. **Een onderschepte inlog aan een latere aanvraag hangen.** Het vastleggen liet een minuut
   speling tussen de tijd van de inlog en die van de aanvraag (twee klokken). Wie een verse
   inlog van een klant onderschepte, kon direct daarna een eigen aanvraag op het algemene
   portaal doen en de inlog daaraan hangen: dan zag hij alles. Nu moet het token van de aanvraag
   het laatste zijn dat Supabase uitgaf (`auth.users.recovery_sent_at` is precies wat het bij
   het opslaan was), en moet de inlog daarna zijn begonnen, op dezelfde klok. Een tegenproef met
   de oude regel liet de aanval slagen; met de nieuwe niet.
2. **Een inlog bij Supabase op een eigen domein.** Het eerste ontwerp gaf ook op een eigen
   domein een (vastgelegde) inlog bij Supabase. Het portaal toonde dan wel alleen de eigen
   gebruiker, maar de inlog zelf gold voor het hele account, en dus ook voor een werkruimte
   elders. Nu krijgt een eigen domein alleen de sleutel.
3. **Codes raden door veel pogingen tegelijk.** Het aantal foute pogingen werd gelezen en daarna
   teruggeschreven; tegelijk afgevuurde pogingen telden zo niet allemaal. Nu controleert één
   databasefunctie de code met de aanvraag vergrendeld (`portal_code_redeem`): na vijf keer mis
   is de code op, ook als ze tegelijk komen.
4. **Een code van Supabase voor wie ook een werkruimte heeft.** Een code kan elke website
   vragen. Voor een klant die ook teamlid is, opent een inlog bij Supabase de werkruimte; zijn
   inlogmail bevat nu alleen de link.

Wat blijft: een klant die een code uit de mail invult op een website die niet van zijn
leverancier is, geeft die website toegang, zoals bij elke inlogcode. De mail zegt daarom op
welk adres de code hoort. Op een eigen domein geeft zo'n code alleen een sleutel voor dat ene
portaal.

## Techniek

- Migratie `20261109020000_portaal_eigen_domein.sql`: `client_domains.portal_enabled`;
  `portal_login_requests` met het bereik, het adres, de code van ResoFly, het moment van het
  token en de inlog die eruit kwam; `portal_sessions`; `portal_tokens`; de functies
  `portal_session_bind`, `portal_session_scope`, `portal_token_scope`, `portal_code_redeem`,
  `portal_user_id`, `portal_email_has_workspace` en `portal_sessions_cleanup` (in de ronde van
  `client-domains`, elk kwartier).
- `_shared/portalSession.ts`: het vastleggen, het bereik en de sleutel.
- `portal-login`: `requestLogin` (bereik, link naar het adres van de aanvraag, code van ResoFly
  op een eigen domein), `redeemLogin` (sleutel op een eigen domein), nieuw `bindSession`,
  `redeemCode` en `endPortalToken`.
- `client-portal`: het bereik in elke actie, de sleutel (`x-portal-token`); `verify_jwt` staat
  uit (`supabase/config.toml`), want een sleutel is geen JWT; `requireUser` laat zonder inlog of
  sleutel niemand door.
- `client-domains`: actie `setPortal`, `portalEnabled` in het overzicht en in de opzoeking voor
  de Worker.
- De Worker: het portaal op een eigen domein als het daar aan staat, met `portalMode: "token"`
  in de meta.
- De app: de schakelaar in Instellingen → Domein; inloggen met inwisselen, vastleggen en dan
  opslaan; de sleutelmodus op een eigen domein (`src/lib/portalToken.ts`); uitloggen alleen op
  dit adres; *"Je bent uitgelogd. Log opnieuw in."* als de server een inlog niet (meer) kent.

## Gevolgen bij de uitrol

- **Elke klant logt één keer opnieuw in.** Een inlog van vóór deze wijziging ligt nergens vast;
  het portaal zegt dan *"Je bent uitgelogd. Log opnieuw in."*
- Er is geen nieuwe instelling nodig. Het portaal op een eigen domein werkt pas als de
  klantadressen live zijn (`docs/setup/KLANTDOMEINEN_SETUP.md`).

## Getest

- `npm test`: 1374 tests (nieuw: het vastleggen, het bereik en de sleutel in
  `_shared/portalSession.ts`, de code van acht cijfers, de sleutel in de browser, de meta van
  de Worker, de inlogmail met het adres van de code, het Logboek).
- `npm run typecheck`, `npm run build` (zoals Cloudflare Pages) en `scripts/check-csp-hash.mjs`.
- `deno check` op de 35 functies uit `frontend-checks.yml`, en op `client-portal` (niet in die
  lijst): geen fouten.
- De Worker in workerd (`workers/client-domains/test/worker.mjs`): het portaal op een eigen
  domein met de schakelaar aan en uit.
- Migraties vanaf nul: 259 van 259, en de nieuwe migratie twee keer achter elkaar.
- `npm run test:stromen` op die verse database: 899 stappen, 0 fout. Het scenario
  `klantdomein` telt nu 105 stappen: vastleggen, bereik, een wachtwoord, de nieuwste aanvraag,
  de onderschepte inlog, de code en de sleutel op het eigen domein, pogingen tegelijk, een
  teamlid zonder code, aan- en uitzetten, ontkoppelen en opruimen.
- De twee nieuwe controles van de rooktest (client-portal zonder inlog en met een verzonnen
  sleutel) lokaal tegen de functie.
- `npm run test:mobile -- --theme=both`: 422 pagina's, 0 met problemen; `npm run test:loading`:
  alles geslaagd. Op een schermafbeelding van Instellingen → Domein gezien: op de telefoon stond
  het vinkje van de schakelaar boven zijn tekst (de labelstijl van de kaart); nu ernaast.

## Ook gevonden, los van deze wijziging

Lokaal crashte Postgres 17.6.1.111, de versie waarop staging draaide (en 17.6.1.106), telkens
als een ingelogde gebruiker een functie aanriep waar hij geen recht op heeft: in plaats van
*"permission denied"* stopte het databaseproces (de uitbreiding supautils), en de hele database
herstartte even. Met 17.6.1.178 gebeurt dat niet. Dat staat los van deze wijziging (het gebeurt
ook zonder de nieuwe migratie), maar op staging zou zo'n aanroep hetzelfde kunnen doen. Getest
op staging is dat bewust niet. Opgelost: staging draait sinds 9 november op 17.11.0.018
(`CHANGELOG_POSTGRES_17_11_2026-11-09.md`).

## Bijgewerkt na de hertest (later op 9 november)

Bij de hertest (`CHANGELOG_PORTAAL_HERTEST_2026-11-09.md`) bleek een code van Supabase in de
inlogmail via een eigen domein te ontfutselen. Daarom, anders dan hierboven:

- op de naam bij ResoFly en het algemene portaal staat er nooit meer een code in de mail, voor
  niemand (niet alleen voor teamleden). Supabase Auth maakt het token pas als de link opengaat
  in de browser die hem aanvroeg;
- een haperend eigen domein telt niet meer voor het portaal, en de sleutels van een domein
  verdwijnen zodra het portaal er uitgaat of het domein niet meer actief is.
