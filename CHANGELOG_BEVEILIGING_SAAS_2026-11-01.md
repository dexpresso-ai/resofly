# Beveiligingsronde SaaS: de app doorgelicht voor gebruik door meerdere klanten

**1 november 2026 · database, edge functions, workers, frontend en Supabase-instellingen**

Doel: de app veilig kunnen aanbieden als SaaS, met veel organisaties naast elkaar.
Dit is de tweede ronde na `CHANGELOG_BEVEILIGING_2026-09-26.md`. Sindsdien kwamen
de openbare API, webhooks, het boekhouder-gastaccount, bestanden versturen,
teamchat-teams, klantmeldingen, e-facturatie en Jitsi erbij.

> **Status: in uitvoering.** Zes reviews zijn klaar, vijftien fixes staan op staging, het mailquotum werkt op de eerste routes, interne functies zijn dicht en AI-registraties begrensd.
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

### 12. Login-CSRF (middel, opgelost)

Met de impliciete flow nam de app elk tokenpaar uit een link over. Iemand met
een eigen account kon zo een link sturen, waarna het slachtoffer ongemerkt in
zíjn werkruimte werkte. Wat het slachtoffer daar koppelde, zoals agenda, bank
en documenten, kwam dan bij de aanvaller terecht.

Beide Supabase-clients gebruiken nu PKCE. Tokens in de URL worden geweigerd, en
een inloglink werkt alleen in de browser die hem aanvroeg. Alle Auth-sjablonen
gebruiken `ConfirmationURL`, dus de mails blijven werken.

### 13. Mail als open relay (hoog, opgelost)

- **Testmails:** "Stuur testmail" bij campagnes en het mailsjabloon ging naar
  elk adres, met de platform-afzender en zonder limiet. Nu alleen naar je eigen
  adres of dat van een actief teamlid (`_shared/testRecipient.ts`).
- **Agenda-uitnodigingen:** een afspraak heeft nu maximaal 50 deelnemers.
- **Quotum per organisatie** (migratie `20261101050000`, `_shared/emailQuota.ts`):
  standaard 200 per uur en 1000 per 24 uur. Een organisatie die meer nodig
  heeft, krijgt een rij in `organization_email_limits`; die zet alleen de
  platformbeheerder. Het quotum geldt nu voor vrije klantmail en voor
  agenda-uitnodigingen.
- **Alle verzendroutes** (sessie 2): ook campagnes, facturen, herinneringen,
  aanmaningen, creditnota's, offertes, contracten, gespreksamenvattingen,
  boekingslinks, deellinks, zendingen, klantmeldingen, agentrapporten en
  uitnodigingen. Waar een mail niet mag mislukken, wacht hij: campagne-
  ontvangers gaan terug in de rij, flows en klantmeldingen worden later opnieuw
  geprobeerd. Een bevestiging na een handtekening of boeking blijft achterwege;
  de handtekening of boeking zelf staat vast.
- **Vangnet:** `emailQuota.test.ts` faalt als een bestand via Resend verstuurt
  zonder het quotum aan te roepen.

### 14. Vangnetten (opgelost)

- **Rooktest:** controleert na elke deploy de Auth-instellingen waar het portaal
  en de uitnodigingen op leunen. Dat zijn: geen zelfregistratie, een adres
  bevestigen, een adreswijziging dubbel bevestigen, geen anonieme accounts en
  wachtwoorden van 12 tekens.
- **Workflows:** het `GITHUB_TOKEN` mag alleen lezen.
- **CSV-export:** een cel die met `= + - @` begint, wordt tekst (`csvSafeText`).
- **Uitloggen:** wist ook onverstuurde chatberichten en de besluiten van Gerrie
  die nog wachten.
- **DOMPurify 3.4.17:** de productie-dependencies hebben weer 0 kwetsbaarheden.

### 15. Facturen of geld omleiden zonder goedkeuring (middel, opgelost)

Gerrie, MCP en de API konden deze gegevens wijzigen op normaal risico, dus met
een sleutel op "execute" zonder goedkeuring:
- het e-factuuradres en het kanaal van een klant;
- het IBAN en het e-mailadres van een leverancier.

Na een geïnjecteerde mail ("ons rekeningnummer is gewijzigd") ging zo elke
volgende factuur naar een ander adres. Of de IBAN-controle van de factuur-inbox
viel stil weg.

Nu:
- **Hoog risico:** deze wijzigingen krijgen een waarschuwing en gaan dus altijd
  langs een mens. Het e-factuuradres vraagt bovendien schrijfrecht op Financiën.
- **REST-API:** de e-factuurvelden vragen "execute_high", net als het
  e-mailadres van een klant (migratie `20261101040000`).
- **TRUNCATE:** ingelogde gebruikers hebben geen TRUNCATE meer op tabellen. RLS
  geldt daar niet voor, en de app gebruikt het nergens.

### 16. Interne functies die iedereen kon aanroepen (laag, opgelost)

Een scan van de 131 security-definer-functies die elke ingelogde gebruiker via
`/rest/v1/rpc` kan aanroepen. Acht daarvan controleerden niet wie er belde.
Het zijn bouwstenen voor andere functies, en niemand roept ze rechtstreeks aan.

- `book_invoice_payment` en `ensure_sales_invoice_booked` boekten in het
  grootboek van elke organisatie waarvan je de ID's kende, met een zelfgekozen
  `p_created_by`. De module-gate op de financiële tabellen hield een niet-lid
  al tegen; dit is het tweede slot.
- `expire_stale_organization_invitations` zette uitnodigingen van elke
  organisatie op verlopen.
- Verder: `first_open_booking_date`, `org_creative_in_grace`, de twee
  rekenhulpen voor de bedrijfsgrootte en `rls_auto_enable`.

Ingelogde gebruikers kunnen ze niet meer aanroepen (migratie `20261101060000`).

**Ook gezien en in orde:** `close_vat_period` en `finalize_vat_return`
controleren de schrijfrol. Het recht op Financiën bewaakt de module-gate op
`vat_returns`, `closed_periods` en `journal_entries`.

### 17. AI-koppelingen: registratie en verbruik (laag, opgelost)

- **Registratie:** `mcp-oauth /register` kan zonder login, want zo werkt het
  koppelen van Claude of ChatGPT. Hij nam elke grootte aan, en registraties
  bleven voor altijd staan. Nu:
  - maximaal 16 KB per registratie en 512 tekens per redirect-URI;
  - een dagelijkse taak ruimt registraties op die na twee dagen nog geen
    koppeling hebben (migratie `20261101070000`).
- **Verbruik:** het overzicht van AI-gebruik per teamlid telde zijn gebruik in
  al zijn organisaties op. Nu telt alleen het gebruik in deze organisatie.

### 18. Als de klant schrijven via het reply-adres (middel, opgelost)

Het reply-adres van een klantmail (`reply+<id>@…`) verloopt nooit, en iedereen
die de mail ooit doorgestuurd kreeg, kent het. De controle "hoort de afzender
bij deze klant?" accepteerde elk kandidaat-adres: Reply-To, de From van een
bijgevoegde `.eml`, en een "Van:"-blok in de tekst. Zo schreef iemand vanaf een
eigen domein "als de klant" in diens dossier, met een melding aan het hele team.

Nu telt op de reply-route alleen de From-kop, voor de controle én voor de
opgeslagen afzender. Een antwoord van een ander adres wordt geparkeerd, niet
weggegooid.

**Actie:** controleer of de uitgerolde email-inbound-worker zijn verzoeken
tekent, en zet dan `MAIL_INBOUND_REQUIRE_SIGNATURE=true`. Nu volstaat het
gedeelde secret alleen, zonder controle op inhoud of tijd.

### 19. Een rem op de portal-login (middel, opgelost)

`portal-login` draait zonder login. Hij maakte zonder grens een auth-account
voor elk adres dat bij een klant hoort. Een script kon zo onbeperkt adressen
proberen, via de reactietijd raden welke bij een klant horen, en voor elk
bekend adres een account en een inlogmail laten maken.

Nu telt `portal-login` per afzender (gehasht IP, 20 per 10 minuten) en per
e-mailadres (gehasht, 5 per uur). Boven de grens geeft hij hetzelfde antwoord,
maar doet hij niets. De teller is eigen (migratie `20261101080000`), los van
die van de openbare API.

**Aanbevolen:** `rate_limit_email_sent` staat in Supabase Auth op 50 per uur
voor het hele project. Voor een SaaS met veel gebruikers is dat krap: bij
drukte, of bij misbruik, krijgt niemand nog een inloglink. Verhoog die waarde,
samen met een captcha (zie **Aanbevolen**).

### 20. Een uitgegeven factuur ligt vast (middel, opgelost)

Open punt van 26 september, en ruimer dan toen gedacht. De bewaking van
facturen keek naar de oude status, `locked_at` en `journal_entry_id`. Die drie
kon iedereen met schrijfrecht op Financiën zelf wijzigen. In twee verzoeken was
een verzonden, geboekte factuur weer een concept. Daarna kon iemand regels of
nummer aanpassen, of de factuur verwijderen met betalingen, versies en
creditnota's erbij. Migratie `20261101090000`:

- **Facturen:** vergrendeling, boeking, deellink, verzending, versies, PDF,
  terugbetaling, chargeback en herinneringen zet alleen de server.
  - Een uitgegeven factuur gaat niet meer terug naar concept.
  - "Terugbetaald" kan alleen via de server.
  - Handmatig op verzonden, betaald, geannuleerd, ongeldig of afgeboekt zetten
    blijft kunnen, net als nu.
- **Inkoopfacturen:** status, boeking en betaling wijzigt alleen de server (Boeken,
  bank), en een geboekte inkoopfactuur ligt vast.
- **Offertes:** een verstuurde offerte, of een offerte waarover de klant heeft
  beslist, is niet meer te verwijderen (bewaarplicht). De app controleert dat
  nu ook vóór het wissen van de bijlagen.

Droog getest op staging als owner.

### 21. AI-budget per gebruiker én per organisatie (middel, opgelost)

Het AI-budget had drie gaten:
- zonder `GERRIE_MONTHLY_USER_COST_EUR` gold geen enkel plafond;
- het telde alleen per gebruiker, dus meer teamleden of agents gaven zonder
  grens meer kosten;
- kon het verbruik niet worden gelezen, dan ging de aanroep toch door.

De factuur-inbox controleerde bovendien niets meer zodra de maker van het
inbox-adres was vertrokken.

Nu (`_shared/aiBudget.ts`, met tests):
- standaard 25 euro per gebruiker en 250 euro per organisatie per maand, via
  `GERRIE_MONTHLY_USER_COST_EUR` en `GERRIE_MONTHLY_ORG_COST_EUR`. Een
  expliciete 0 betekent geen plafond;
- het verbruik wordt in de database opgeteld (migratie `20261101100000`);
- kan het verbruik niet worden gelezen, dan nee.

Dit geldt voor Gerrie, agents, notulen, de factuurscan en de factuur-inbox.
**Kies de bedragen** voor productie bij je prijsplannen. Wat nog open is: twee
gelijktijdige aanroepen passeren allebei de controle, want die telt pas na de
aanroep.

### 22. De online editor overschreef vastgelegde PDF's (middel, opgelost; worker nog uitrollen)

WOPI en de office-routes controleerden alleen of een opslagsleutel bij de
organisatie hoorde. Een teamlid met schrijfrecht op Inhoud kon zo een factuur-
of contract-PDF vervalsen, bijvoorbeeld met een ander IBAN, en de klant kreeg
die vervalsing te zien:
1. Een documents- of attachments-rij naar een vastgelegde factuur- of
   contract-PDF laten wijzen.
2. Een editorsessie openen.
3. Met PutFile het bestand overschrijven.

Op dezelfde manier kon hij de PDF lezen zonder recht op Financiën.

Nu moet het tweede segment van de sleutel bij de bron passen:
- `contract` voor een contract;
- `document` of `folder` voor een document;
- het eigen `entity_type` voor een bijlage.

Vastgelegde bewijsstukken, zendingen en originelen uit de factuur-inbox zijn
nooit een doel voor de editor. Op staging voldoen alle bestaande documenten en
bijlagen.

**Actie:** de media-worker uitrollen (fix 6 en deze).

## Gevonden en nog open (volgorde = prioriteit)

| # | Ernst | Wat | Waar |
| --- | --- | --- | --- |
| A | laag | Campagne- en flow-HTML bij het verzenden saneren, zoals klantmail al gebeurt. Het relay-risico is weg: testmails gaan alleen nog naar het team en alles telt mee in het quotum. | campaigns |
| F | middel | Office-server bewaakt alleen `/convert-to`, en één Collabora-instantie draait voor alle klanten en beide omgevingen. | workers/office-server |
| G | middel | Inkomende mail: de afzender is niet geverifieerd, want DMARC wordt niet doorgegeven. De factuur-inbox boekt automatisch op het From-adres. De aliasroute vertrouwt de `.eml` nog. De reply-route is opgelost (fix 18). | workers/email-inbound, mail-inbound, invoiceInbox |
| I | laag | mcp-oauth: een fout-redirect naar een geregistreerd adres als `response_type` ontbreekt. Liever een foutpagina tonen. Registratie zelf is begrensd (fix 17). | mcp-oauth |
| J | middel | De agenda-OAuth-callback is niet gekoppeld aan de sessie (open sinds 26 september). | calendar-integrations |
| K | middel | De CI-secrets zijn vanaf elke branch te gebruiken. `permissions: contents: read` staat er nu. Nog doen, door de eigenaar in GitHub: de secrets naar een Environment `staging` verplaatsen, alleen voor branch `staging` en met een reviewer, `environment: staging` op de job zetten, en `staging` beschermen. | .github/workflows |
| L | middel | Opslagquotum is alleen een advies: de opgegeven grootte telt, en het faalt open. Stream-kopieën onbeperkt. | workers/media-api |
| M | laag | AI-budget: gelijktijdige aanroepen passeren samen de controle (die telt pas na de aanroep), en mislukte aanroepen tellen niet. Het plafond zelf staat er (fix 21). | aiBudget.ts |
| N | middel | De productie-config van de workers wijst naar het staging-project van Supabase. | workers/*/wrangler.toml |
| O | middel | De oude `cloudflare-worker/` (zonder de bewaking van media-api) wordt nog in de docs genoemd. Controleer of hij nog draait, en verwijder hem. | cloudflare-worker, README |
| P | laag | `calendar_event_links` toont titels van privé-afspraken van collega's; `calendar_sources.feed_url` is leesbaar. | RLS |
| Q | laag | Interne foutteksten in publieke functies; ACAO `*` bij meeting-booking-public; contract-vraag zonder limiet; pin-blokkade per galerij. | publieke functies |
| R | laag | CSP met wildcards (`*.supabase.co`, `*.workers.dev`, `img-src https:`), en afbeeldingen in inkomende mail laden vanzelf. | frontend |
| T | laag | Chatdeelname blijft na vertrek staan; `p_created_by` in boekingsfuncties komt van de aanroeper. | RLS/RPC |
| U | laag | De review van de 131 functies die elke ingelogde gebruiker kan aanroepen: de scan op ontbrekende controles is gedaan (fix 16). Nog doen: per functie nalopen of elk id-argument bij de organisatie hoort, en of de juiste module wordt gevraagd. De dumps maak je met de queries uit de commits van deze ronde. | db |

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
4. Rol de media-worker uit (fix 6 en 22).

| Onderdeel | Stand |
| --- | --- |
| Live controles staging | klaar |
| Rechten van `anon` | klaar (migratie 20261101000000) |
| Supabase Auth-instellingen | klaar op staging (productie: zie fix 2) |
| Klantaccounts zonder werkruimte | klaar (20261101010000) |
| Video's, domeinen, vertrek | klaar (20261101020000; worker nog uitrollen) |
| Bank, rapporten, kleine sloten | klaar (20261101030000) |
| PKCE, vangnetten, testmails | klaar |
| Omleiden van facturen of geld, TRUNCATE | klaar (20261101040000) |
| Mailquotum per organisatie | klaar op alle routes (20261101050000, sessie 2) |
| Reviews | klaar: RLS, publieke functies, app-functies, AI en koppelingen, workers, frontend |
| Review security-definer-functies | scan klaar (20261101060000); diepe review is punt U |
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
