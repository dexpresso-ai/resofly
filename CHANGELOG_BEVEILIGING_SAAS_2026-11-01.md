# Beveiligingsronde SaaS: de app doorgelicht voor gebruik door meerdere klanten

**1 november 2026 · database, edge functions, workers, frontend en Supabase-instellingen**

Doel: de app veilig kunnen aanbieden als SaaS, met veel organisaties naast elkaar.
Dit is de tweede ronde na `CHANGELOG_BEVEILIGING_2026-09-26.md`. Sindsdien kwamen
de openbare API, webhooks, het boekhouder-gastaccount, bestanden versturen,
teamchat-teams, klantmeldingen, e-facturatie en Jitsi erbij.

> **Status: in uitvoering.** Zes reviews zijn klaar en elf fixes staan op staging.
> Een volgende sessie begint bij **Verder in de volgende sessie**.

## Werkwijze

- **Live op staging, alleen lezen.** Via de Supabase Management API zijn de echte
  functies, RLS-policies, grants en Auth-instellingen van staging opgehaald, en
  niet afgeleid uit 205 migraties.
- **Per onderdeel een review:**
  - security-definer-functies;
  - RLS-policies;
  - publieke edge functions en webhooks;
  - ingelogde edge functions en de handelingen van Gerrie, MCP en API;
  - de Cloudflare-workers;
  - de frontend en de repo-configuratie.
- **Elke bevinding zelf nagetrokken** voordat er een fix kwam.

## Live controles op staging (1 november)

| Controle | Uitslag |
| --- | --- |
| Tabellen zonder RLS | 0 |
| Security-definer-functies zonder vaste `search_path` | 0 |
| Views zonder `security_invoker` | 0 |
| Policies met `using (true)` of `with check (true)` | 0 |
| Security-definer-functies die `anon` kan aanroepen | 47, allemaal triggerfuncties (niet rechtstreeks aan te roepen) |
| Security-definer-functies die elke ingelogde gebruiker kan aanroepen | 131, nagelopen in deze ronde |
| Opslag-buckets in Supabase Storage | 0 (bestanden staan in R2) |

## Bevindingen en fixes

### 1. De publieke sleutel had alle rechten op elke tabel (hoog, opgelost)

Supabase geeft `anon` standaard alle rechten op elke nieuwe tabel, reeks en
functie. Op staging had `anon` 1305 tabelrechten, en alleen RLS hield het
tegen. Van de 969 policies geldt het merendeel voor rol `public`, dus ook voor
anon. Eén vergissing in één policy was zo meteen open voor iedereen met de
publieke sleutel, en die staat in elke browser. Daarnaast toonde de API het
volledige schema aan wie niet ingelogd was.

Migratie `20261101000000_anon_zero_access.sql`:
- `anon` heeft in public geen enkel recht meer, behalve SELECT op `billing_plans`
  (de openbare prijsplannen).
- `anon` kan geen functie meer aanroepen, ook niet via PUBLIC. Ingelogde
  gebruikers en de service-role houden precies wat ze hadden: 416 en 582
  functies, droog getest op staging.
- Nieuwe tabellen, reeksen en functies krijgen `anon` niet meer vanzelf.
- `migrationGrants.test.ts` faalt als een latere migratie `anon` weer iets geeft.
  De rooktest controleert het na elke deploy.

De app merkt er niets van. De pagina's achter een deellink en de portal-login
lopen via edge functions op de service-role, en de workers gebruiken het JWT
van de gebruiker.

### 2. Supabase Auth: wachtwoordregels (middel, op staging gezet)

Inloggen gaat alleen met een magic link, maar de Auth-API accepteert ook een
wachtwoord. Wie een sessie buitmaakt, kon met `PUT /auth/v1/user` een
wachtwoord van 6 tekens zetten en daarmee blijvend inloggen, ook na het
verlopen van de sessie. Op staging gezet via de Management API:
- minimaal 12 tekens, met kleine letter, hoofdletter en cijfer;
- een wachtwoord wijzigen vraagt opnieuw bevestigen per mail als de sessie
  ouder is dan 24 uur (`security_update_password_require_reauthentication`).

Kan nog niet: bescherming tegen gelekte wachtwoorden (HaveIBeenPwned). Die
vraagt het Pro-abonnement van Supabase.

**Voor productie:** dezelfde instellingen zetten onder Authentication →
Providers → Email en Authentication → Policies.

### 3. Het inlogscherm verraadde wie een account heeft (laag, opgelost)

"Signups not allowed for otp" verscheen letterlijk in beeld bij een onbekend
adres. Het scherm geeft nu altijd dezelfde melding, net als het klantportaal.
Via de Auth-API zelf blijft het verschil zichtbaar. Dat dichten kan pas met
een captcha (hCaptcha of Turnstile), en die vraagt sleutels van de eigenaar
(zie **Aanbevolen**).

### 4. Een klant uit het portaal kreeg een gratis werkruimte (middel, opgelost)

Open punt uit de vorige ronde. Zelf registreren staat uit, maar wie als klant in
het portaal inlogde en daarna de werkruimte opende, kreeg vanzelf een eigen
organisatie als owner. `create_organization` kon hij ook rechtstreeks aanroepen,
zo vaak als hij wilde. Elke klant van elke organisatie had zo een gratis
werkruimte, met de platform-afzender voor mail, Gerrie en opslag erbij.

Migratie `20261101010000_portal_accounts_no_workspace.sql`:
- `is_portal_only_account()` herkent zo'n account. Het was nooit lid, heeft geen
  uitnodiging, en is aangemaakt door de portal-login of hoort bij een klant of
  portaalcontact.
- `ensure_user_default_organization` maakt daarvoor niets aan, en
  `create_organization` weigert het.
- portal-login markeert nieuwe klantaccounts met `app_metadata.resofly_portal`.
  Dat veld kan alleen de server zetten.
- Het scherm "Geen organisatie gevonden" wijst naar het klantportaal.

Droog getest op staging. Het ene klantaccount wordt geweigerd. Teamleden die
ook klant zijn worden niet geraakt, en een owner kan nog steeds een
organisatie maken.

Moet een klant toch een eigen werkruimte krijgen, dan nodig je hem uit of maak
je de organisatie als beheerder aan.

### 5. Projectinstellingen van Supabase (middel, deels op staging gezet)

- **SSL op de database werd niet afgedwongen.** Een directe verbinding met
  Postgres mocht zonder TLS. Op staging staat afdwingen nu aan. CI en de CLI
  verbinden al met TLS, en de edge functions en workers gaan via de API.
  Let op: aanzetten herstart de database even. Daardoor mislukte één rooktest
  midden in de deploy; die is opnieuw gedraaid.
- **De database is vanaf elk IP-adres bereikbaar** (`0.0.0.0/0`). Dat is de
  standaard. Beperken breekt de GitHub-workflow, want runners hebben wisselende
  adressen. Voor productie: alleen de adressen die het echt nodig hebben, en
  deployen via een vaste runner of vanaf de laptop.
- **Een secret met een kapotte naam:** `RESEND_WEBHOOK_SIGNING_SECRET="jouw_resend_webhook_secret"`.
  Daardoor bestaat de echte `RESEND_WEBHOOK_SIGNING_SECRET` op staging niet, en
  weigert `resend-webhook` elk event. Dat is veilig, maar het bijhouden van
  geopend, geklikt en gebounced werkt zo niet. **Actie:** zet het secret uit
  het Resend-dashboard onder de juiste naam en verwijder het kapotte.

### 6. Video's van een andere organisatie (hoog, opgelost; worker nog uitrollen)

`gallery_items.stream_uid` schrijft de browser zelf, en de media-worker tekende
voor elk id een token met de sleutel van het gedeelde Stream-account. Met het id
van een video van een andere organisatie kreeg je zo een downloadtoken, ook
nadat de link was ingetrokken of downloaden uit stond. Dat id staat in elke
deellink van die galerij.
- Migratie `20261101020000`: een trigger weigert een `stream_uid` dat al bij een
  andere organisatie staat.
- Migratie `20261101030000`: de afspeelhost moet een Cloudflare Stream-host zijn.
- `workers/media-api`: tekent alleen als het id nergens anders voorkomt of de
  Stream-meta het bevestigt.
- **Actie:** de worker uitrollen met `npm run deploy:staging` in
  `workers/media-api`. Dat doet CI niet.

### 7. Bankrekeningen van een ander bedrijf (hoog, opgelost)

Alle organisaties delen één Enable Banking-app, en het account-id van de bank is
de enige sleutel tot de transacties. Dat id kon een teamlid zelf in
`bank_accounts` zetten, waarna `bank-sync` de transacties van die rekening
ophaalde. Wie ooit Financiën kon lezen bij bedrijf B, haalde zo vanuit een eigen
organisatie de bankmutaties van B binnen.
- Migratie `20261101030000`: de koppelvelden zet alleen de server.
- `bank-sync` synct alleen een rekening die hoort bij een koppeling van
  dezelfde organisatie die dat id van de bank kreeg.

Op staging voldoen alle 8 gekoppelde rekeningen.

### 8. Verzenddomeinen (middel, opgelost)

Een domein was alleen per organisatie uniek, terwijl alle organisaties één
Resend-account delen. Zo kon de ene klant het domein van de andere bezetten.
- Nu is een domein uniek over alle organisaties heen (migratie `20261101020000`).
- De mail-functie weigert sub- en bovenliggende domeinen van een andere
  organisatie, het domein van de platform-afzender, en meer dan 5 domeinen per
  organisatie (`_shared/domainOverlap.ts`, met tests).

### 9. Vertrekkende teamleden (middel, opgelost)

Webhooks die een vertrokken teamlid had gemaakt, bleven alle gebeurtenissen
naar zijn adres sturen. Zijn gekoppelde agenda bleef met zijn token bruikbaar.
Nu gaan bij vertrek zijn webhooks uit, met een reden erbij, en vervallen zijn
agendakoppelingen en tokens (migratie `20261101020000`).

### 10. Financiële rapporten zonder module (middel, opgelost)

Open punt van 26 september. Deze functies controleerden alleen het
lidmaatschap: proef- en saldibalans, grootboek, balans, winst-en-verlies,
openstaande posten, bankaansluiting, btw, ICP en boekjaren. Ze vragen nu ook
leesrecht op Financiën (migratie `20261101030000`).

### 11. Kleinere sloten (laag, opgelost)

- **Vergaderlinks:** alleen http(s), in de database en op de nieuwe dashboards.
  Een `javascript:`-link achter "Deelnemen" kan niet meer.
- **Uitnodigingen:** een uitnodiging aannemen vraagt een bevestigd e-mailadres.
- **Localhost-uitzondering:** `annual-accounts`, `corporate-tax`, `file-share` en
  `file-transfer` lieten standaard localhost en verzoeken zonder Origin toe. Nu
  standaard uit.

## Gevonden en nog open (volgorde = prioriteit)

| # | Ernst | Wat | Waar |
| --- | --- | --- | --- |
| A | hoog | Mail zonder quotum: testverzending van campagnes en mail naar elk adres, document-mails met vrije ontvanger, agenda-uitnodigingen zonder limiet op deelnemers. Phishing vanaf het platformdomein, en Resend kan het hele platform blokkeren. | campaigns, mail, invoice/quote/contract-workflow, calendarEventWrite |
| B | middel | Login-CSRF: een link met tokens van een ander account logt je daarin in. Fix: `flowType: 'pkce'` in beide Supabase-clients. | src/lib/supabase.ts, supabasePortal.ts |
| C | middel | Vergrendeling van facturen terug te draaien (status, `locked_at` en `journal_entry_id` vrij te schrijven); inkoopfacturen zonder bewaking; een geaccepteerde offerte is te verwijderen. | invoices, purchase_invoices, quotes |
| D | middel | Gerrie, MCP en API mogen het e-factuuradres van een klant en het IBAN van een leverancier wijzigen zonder hoge risicostand, dus zonder goedkeuring. | _shared/actions/clients.ts, bookkeeping.ts |
| E | middel | WOPI en office kunnen elk bestand van de eigen organisatie overschrijven, ook de vastgelegde factuur- en contract-PDF's. | workers/media-api |
| F | middel | Office-server bewaakt alleen `/convert-to`, en één Collabora-instantie draait voor alle klanten en beide omgevingen. | workers/office-server |
| G | middel | Inkomende mail: de afzender is niet geverifieerd. Op de reply-route telt elk adres (Reply-To, bijgevoegde .eml), en de factuur-inbox boekt automatisch op het From-adres. | workers/email-inbound, mail-inbound |
| H | middel | portal-login: geen rate limit, en door de timing te raden welke adressen klant zijn. | portal-login |
| I | middel | mcp-oauth `/register`: onbeperkt registreren, en een fout-redirect naar elk geregistreerd adres. | mcp-oauth |
| J | middel | De agenda-OAuth-callback is niet gekoppeld aan de sessie (open sinds 26 september). | calendar-integrations |
| K | middel | De CI-secrets zijn vanaf elke branch te gebruiken: geen `environment:` en geen `permissions:`. | .github/workflows |
| L | middel | Opslagquotum is alleen een advies: de opgegeven grootte telt, en het faalt open. Stream-kopieën onbeperkt. | workers/media-api |
| M | middel | AI-budget: staat uit zonder env-var, faalt open, telt pas na de aanroep, en mislukte aanroepen tellen niet. | claudeSummary.ts, gerrieCore.ts |
| N | middel | De productie-config van de workers wijst naar het staging-project van Supabase. | workers/*/wrangler.toml |
| O | middel | De oude `cloudflare-worker/` (zonder de bewaking van media-api) wordt nog in de docs genoemd. Controleer of hij nog draait, en verwijder hem. | cloudflare-worker, README |
| P | laag | `calendar_event_links` toont titels van privé-afspraken van collega's; `calendar_sources.feed_url` is leesbaar. | RLS |
| Q | laag | Interne foutteksten in publieke functies; ACAO `*` bij meeting-booking-public; contract-vraag zonder limiet; pin-blokkade per galerij. | publieke functies |
| R | laag | CSP met wildcards (`*.supabase.co`, `*.workers.dev`, `img-src https:`); afbeeldingen in inkomende mail laden vanzelf; CSV-formule-injectie; DOMPurify naar 3.4.17. | frontend |
| S | laag | Gebruik van AI per lid opgeteld over alle organisaties (`getUsageSummary` zonder organisatiefilter). | gerrieCore.ts |
| T | laag | Chatdeelname blijft na vertrek staan; `p_created_by` in boekingsfuncties komt van de aanroeper. | RLS/RPC |
| U | — | De controle van de 131 security-definer-functies die elke ingelogde gebruiker kan aanroepen, is nog niet volledig afgerond. Die review stopte zonder rapport. | db |

## Checklist voor productie

Deze schakelaars staan op staging aan om te testen. Op productie mogen ze
**niet** bestaan, want elk ervan zet een slot open:

| Secret | Wat het doet |
| --- | --- |
| `MOLLIE_ALLOW_MOCK` | Een abonnement afronden zonder te betalen; slaat de origin-controle over |
| `INVOICE_MOLLIE_ALLOW_MOCK` | Nepbetaallinks die vanzelf op betaald gaan |
| `INVOICE_DEBUG_ERRORS` | Interne foutteksten naar de browser |
| `MAIL_ALLOW_LOCAL_DEV`, `QUOTE_ALLOW_LOCAL_DEV` | Verzoeken zonder Origin en vanaf localhost toegestaan |
| `RESEND_WEBHOOK_ALLOW_UNSIGNED` | Resend-events zonder handtekening accepteren |

En verder, voor productie:
- de Auth-instellingen uit fix 2;
- SSL afdwingen (fix 5);
- `disable_signup` aan;
- de redirect-URL's alleen het eigen domein;
- de migraties van deze ronde draaien (`supabase db push`).

## Verder in de volgende sessie

1. Lees deze file en `git log --oneline staging -20`.
2. Pak de tabel **Gevonden en nog open** van boven naar beneden aan.
3. Elke databasefix eerst droog testen op staging: een transactie die eindigt
   met `raise exception`. Zie de commits van deze ronde.
4. Rol de media-worker uit (fix 6).

| Onderdeel | Stand |
| --- | --- |
| Live controles staging | klaar |
| Rechten van `anon` | klaar (migratie 20261101000000) |
| Supabase Auth-instellingen | klaar op staging (productie: zie fix 2) |
| Klantaccounts zonder werkruimte | klaar (20261101010000) |
| Video's, domeinen, vertrek | klaar (20261101020000; worker nog uitrollen) |
| Bank, rapporten, kleine sloten | klaar (20261101030000) |
| Reviews | klaar: RLS, publieke functies, app-functies, AI en koppelingen, workers, frontend |
| Review security-definer-functies | **nog doen** (punt U) |
| Open bevindingen A–T | **nog doen** |

## Aanbevolen, vraagt een keuze of een account van de eigenaar

- **Captcha op inloggen** (Supabase Auth → Attack Protection, hCaptcha of
  Cloudflare Turnstile). Remt het raden van e-mailadressen en het bestoken van
  mailboxen met magic links. Vraagt een site key in de frontend.
- **Supabase Pro voor productie:** gelekte wachtwoorden weigeren, en sessies
  laten verlopen na inactiviteit.
- **De JWT-secret van staging vernieuwen**, of overstappen op de nieuwe
  asymmetrische JWT-sleutels van Supabase. Tijdens deze ronde gaf de Management
  API (de PostgREST-config) de JWT-secret van staging terug in de uitvoer van
  de sessie. Hij is nergens opgeslagen of gecommit, maar wie hem heeft, kan
  tokens met de service-role maken.
- **Google als inlogmethode** staat aan in Supabase Auth, maar de app gebruikt
  hem niet. Zet hem uit als hij niet gepland is: minder ingangen.
