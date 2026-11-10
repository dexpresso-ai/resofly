# Actiepunten beveiliging SaaS

**1 november 2026 · bij `CHANGELOG_BEVEILIGING_SAAS_2026-11-01.md`**

Dit zijn alle actiepunten uit de beveiligingsronde die nog open staan. Per
actie staat erbij wie hem doet, waarom, de stappen, en hoe je ziet dat hij
klaar is. De achtergrond per fix staat in de changelog; de nummers (fix 6,
punt K) verwijzen daarheen.

- **Eigenaar:** iets in Supabase, Cloudflare of GitHub dat alleen met jouw
  accounts kan.
- **Keuze:** jij beslist; daarna is het een kleine wijziging in de code.
- **Code:** werk voor een ontwikkelaar (of een volgende sessie).

## Overzicht

| # | Actie | Wie | Wanneer |
| --- | --- | --- | --- |
| 1 | Media-worker uitrollen | Eigenaar | Uitgerold op 6 november; de proef nog |
| 2 | Office-server uitrollen | Eigenaar | Uitgerold op 6 november; de proef nog |
| 3 | Handtekening op inkomende mail verplicht maken | Eigenaar | Nu (stap 1 gedaan) |
| 4 | Webhook-secret van Resend repareren | Eigenaar | Uitgesteld tot productie (zie 26) |
| 5 | JWT-secret van staging vernieuwen | Eigenaar | Nu |
| 6 | CI-secrets alleen voor branch `staging` | Eigenaar | Deze week |
| 7 | Oude media-worker opruimen | Eigenaar | Deze week |
| 24 | Mail van het platformdomein beveiligen (SPF, DKIM, DMARC) | Eigenaar | Deze week |
| 8 | Productie-config van de workers | Eigenaar + code | Vóór productie |
| 9 | Eigen office-server voor productie | Eigenaar | Vóór productie |
| 10 | Supabase-productieproject inrichten | Eigenaar | Vóór productie |
| 11 | Captcha op inloggen | Eigenaar + code | Vóór productie |
| 12 | Supabase Pro voor productie | Eigenaar | Vóór productie |
| 13 | Buiten de code: AVG, back-ups, monitoring | Eigenaar | Vóór productie |
| 25 | Tweestapsverificatie (MFA) aanbieden | Code + keuze | Vóór productie |
| 26 | Resend en eigen verzenddomeinen op productie | Eigenaar + keuze | Vóór productie |
| 14 | Privé-afspraken en opnames (punt P) | Keuze | Wanneer je wilt |
| 15 | Deellink van een galerij (punt Q) | Keuze | Wanneer je wilt |
| 16 | Campagne-HTML saneren (punt A) | Keuze | Wanneer je wilt |
| 17 | Offertes zelf goedkeuren | Keuze | Wanneer je wilt |
| 18 | Vite naar een nieuwe hoofdversie | Code | Onderhoud |
| 19 | Bytes-teller in de media-worker (punt L) | Code | Na de lancering |
| 20 | AI-budget vooraf reserveren (punt M) | Code | Later |
| 21 | DMARC-uitslag van inkomende mail (punt G) | Code | Later |
| 22 | CSP per omgeving (punt R) | Code | Vóór productie |
| 23 | Maker op de overige tabellen (punt U) | Code | Later |

Nummer 24, 25 en 26 kwamen er later bij en staan op hun plek in de tabel. Na elke
uitrol: de **rooktest** onderaan.

---

## Nu, op staging

### 1. Media-worker uitrollen (eigenaar)

**Stand op 6 november:** uitgerold naar staging (versie `bf775db3`, code van
`staging` op `3a5afcc`). Zie `CHANGELOG_WORKERS_UITROL_2026-11-06.md`. Nog te
doen: de proef bij *Klaar als*.

**Waarom:** fix 6, 22 en 32 staan in de code, maar CI rolt de workers niet
uit. Tot dan draait staging de oude worker, met onder meer het lek van
video's van een andere organisatie (fix 6).

**Stappen:**
1. `cd workers/media-api`
2. `npm ci`
3. `npx wrangler login` (of zet `CLOUDFLARE_API_TOKEN`)
4. `npm run deploy:staging`

Er zijn geen nieuwe secrets nodig.

**Klaar als:** op staging een video in een galerij uploaden en afspelen
werkt, een Word-document opslaan in de editor werkt, en
`npx wrangler tail --env staging` geen fouten toont.

Productie (`npm run deploy`) pas na actie 8.

### 2. Office-server uitrollen (eigenaar)

**Stand op 6 november:** uitgerold (versie `4f400a61`). `OFFICE_CONVERT_SECRET`
staat op beide workers. Nog te doen: de proef bij *Klaar als*.

**Waarom:** fix 28. Nu kan iedereen de conversie-eindpunten van Collabora
gebruiken, op onze kosten en in het proces met de documenten van alle klanten.

**Stappen:**
1. `cd workers/office-server`
2. `npm ci`
3. Controleer dat `OFFICE_CONVERT_SECRET` bestaat: `npx wrangler secret list`.
   Dezelfde waarde moet ook in de media-worker staan (`npx wrangler secret list --env staging`
   in `workers/media-api`).
4. `npm run deploy`

**Klaar als:** een Word-document openen en bewerken in de editor werkt, en
"Download als PDF" werkt. Een aanroep van `/get-thumbnail` zonder het geheim
geeft 404: de worker doet dan alsof het pad niet bestaat.

### 3. Handtekening op inkomende mail verplicht maken (eigenaar)

**Stand op 6 november:** stap 1 is gedaan (versie `e6ce8169`). De vorige
versie tekende al. Stap 2 tot en met 4 zijn voor jou.

**Waarom:** fix 18. `mail-inbound` accepteert nu ook verzoeken met alleen het
gedeelde geheim, zonder handtekening en tijdstempel. Wie dat geheim één keer
ziet, kan dan mail in elk klantdossier zetten, en een opgevangen verzoek
opnieuw afspelen.

**Stappen:**
1. Rol de huidige email-worker uit, zodat zeker is dat hij tekent:
   `cd workers/email-inbound && npm ci && npm run deploy:staging`.
2. Stuur een testmail naar een doorstuuradres van een werkruimte op staging en
   kijk of hij aankomt.
3. Supabase (staging) → Edge Functions → Secrets → **Add new secret**:
   `MAIL_INBOUND_REQUIRE_SIGNATURE` = `true`.
4. Stuur nog een testmail.

**Klaar als:** de tweede testmail ook aankomt. Komt hij niet aan, haal het
secret dan weer weg, en controleer of `MAIL_INBOUND_SECRET` in de worker
gelijk is aan `MAIL_INBOUND_WEBHOOK_SECRET` in Supabase.

### 4. Webhook-secret van Resend repareren (eigenaar)

**Stand op 9 november:** bewust uitgesteld tot de overstap naar productie;
daar gebeurt het als stap 5 van punt 26. Tot dan komen op staging geen
afleverstatussen (afgeleverd, geopend, gebounced) en geen domeinstatus via de
webhook binnen. Een eigen verzenddomein verifieer je op staging met de knop
"Verifieer"; het scherm vraagt daarna een minuut lang zelf de stand op.

**Waarom:** fix 5. Op staging heet het secret letterlijk
`RESEND_WEBHOOK_SIGNING_SECRET="jouw_resend_webhook_secret"`, met naam en
waarde in één. Het echte secret bestaat dus niet, en `resend-webhook` weigert
elk event. Dat is veilig, maar geopend, geklikt en gebounced worden niet
bijgehouden.

**Stappen:**
1. Resend → Webhooks → het endpoint van staging → kopieer het **Signing
   secret** (begint met `whsec_`).
2. Supabase (staging) → Edge Functions → Secrets: verwijder het secret waarvan
   de naam begint met `RESEND_WEBHOOK_SIGNING_SECRET=`.
3. Voeg toe: `RESEND_WEBHOOK_SIGNING_SECRET` = het gekopieerde secret.

**Klaar als:** na een testmail uit een campagne de status "afgeleverd" of
"geopend" verschijnt.

### 5. JWT-secret van staging vernieuwen (eigenaar)

**Waarom:** tijdens deze ronde gaf de Management API de JWT-secret van
staging terug in de uitvoer van de sessie. Hij is nergens opgeslagen of
gecommit. Maar wie hem heeft, kan tokens maken met de rol `service_role`, en
daarmee om alle RLS heen.

**Stappen:**
1. Supabase (staging) → Project Settings → **JWT Keys** → vernieuw de JWT-secret
   (legacy), of stap over op de asymmetrische signing keys. Iedereen wordt
   daarna uitgelogd.
2. Neem de nieuwe sleutels over:
   - Cloudflare Pages (staging) → Settings → Environment variables:
     `VITE_SUPABASE_ANON_KEY`, daarna opnieuw bouwen;
   - `workers/media-api`: `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging`;
   - `workers/caldav`: `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging`.

   De edge functions krijgen de nieuwe sleutels vanzelf. CI gebruikt een access
   token, en geen JWT.

**Klaar als:** inloggen op staging werkt, een bestand uploaden werkt, en de
agenda-koppeling (CalDAV) synchroniseert.

---

## Deze week

### 6. CI-secrets alleen voor branch `staging` (eigenaar, punt K)

**Waarom:** `SUPABASE_ACCESS_TOKEN` en `SUPABASE_DB_PASSWORD` staan nu als
repository-secrets. Wie op welke branch dan ook mag pushen, kan een workflow
schrijven die ze uitleest. Met dat token beheer je het hele Supabase-account.

**Stappen:**
1. GitHub → Settings → Environments → **New environment** → `staging`.
2. Bij **Deployment branches and tags**: *Selected branches* → `staging`.
3. Eventueel **Required reviewers**: jijzelf.
4. Voeg in die environment de secrets `SUPABASE_ACCESS_TOKEN` en
   `SUPABASE_DB_PASSWORD` toe, met dezelfde waarden.
5. Laat in `.github/workflows/deploy-staging.yml` bij de job
   `environment: staging` zetten, en de tekst van de stap "Controleer de
   secrets" aanpassen. Dat kan een volgende sessie doen; zeg dan dat stap 1 t/m
   4 klaar zijn.
6. Actions → Deploy Supabase (staging) → **Run workflow**. Die moet groen zijn.
7. Pas daarna: verwijder de twee repository-secrets onder Settings → Secrets
   and variables → Actions.
8. Settings → Rules → **Rulesets**, voor branch `staging`: geen force-push en
   niet verwijderen. Een verplichte pull request blokkeert de huidige
   werkwijze (rechtstreeks mergen); kies dat alleen bewust.

Environments in een privé-repository vragen GitHub Team (of Pro).

**Klaar als:** de deploy groen is met alleen de environment-secrets, en een
workflow op een andere branch de secrets niet ziet.

### 7. Oude media-worker opruimen (eigenaar, punt O)

**Stand op 6 november:** `resofly-media-staging` draait nog. Hij staat aan op
workers.dev en gebruikt dezelfde bucket als de media-worker. `resofly-media`
bestaat niet meer.

**Stand op 10 november:** hij is nog in gebruik. Het secret
`QUOTE_PDF_STORAGE_WORKER_URL` op staging wijst ernaar. Via de terugvalketen bewaren
offertes, facturen en jaarrekeningen hun PDF dus via deze oude worker. Eerst de
PDF-opslag omzetten, daarna pas uitzetten. De stappen staan bij O1 in
`docs/rapporten/CONTROLE_API_LAAG_2026-11-10.md`.

**Waarom:** de map `cloudflare-worker/` is de voorganger van
`workers/media-api`, zonder de bewaking van deze ronde. Draait hij nog, dan is
hij een tweede deur naar dezelfde bestanden.

**Stappen:**
1. Cloudflare → Workers & Pages: staan `resofly-media` of
   `resofly-media-staging` er nog?
2. Zo ja: kijk bij **Metrics** of er nog verkeer is. Wijst de app er nergens
   meer naar (de app gebruikt `resofly-media-api`), verwijder de worker dan via
   Settings → Delete.
3. Laat daarna de map `cloudflare-worker/` uit de repo halen.

**Klaar als:** alleen `resofly-media-api` en `resofly-media-api-staging`
over zijn.

### 24. Mail van het platformdomein beveiligen (eigenaar)

**Waarom:** alle organisaties versturen via het platformdomein. Zonder een
strikte DMARC-record kan iedereen mail sturen die eruitziet alsof hij van
ResoFly komt: phishing richting de klanten van je klanten, met jouw naam.
Vanuit deze sessie kon ik de DNS niet opvragen.

**Stappen:**
1. Controleer de records, met `dig` of MXToolbox:
   - `dig TXT mail.resofly.com` (SPF: de include van Resend);
   - `dig TXT resend._domainkey.mail.resofly.com` (DKIM);
   - `dig TXT _dmarc.resofly.com` (DMARC).

   Doe dat voor elk domein waarvan je verstuurt.
2. DMARC: begin met `v=DMARC1; p=none; rua=mailto:dmarc@resofly.com`, zodat
   je rapporten krijgt. Ga na een paar weken zonder onbekende afzenders naar
   `p=quarantine`, en daarna naar `p=reject`.
3. Een domein dat geen mail verstuurt (bijvoorbeeld `resofly.nl`, als dat
   klopt): `v=spf1 -all`, en DMARC met `p=reject`.

**Klaar als:** DMARC op `p=quarantine` of `p=reject` staat, en de rapporten
alleen Resend en je eigen mailserver tonen.

---

## Vóór productie

### 8. Productie-config van de workers (eigenaar + code, punt N)

**Waarom:** de productie-instellingen van de workers wijzen naar het
staging-project van Supabase. Een `npm run deploy` zet productie dus op de
database van staging. Bij de agenda-worker staat er nog een placeholder.

**Stappen**, zodra het productieproject bestaat:
1. Laat in deze bestanden de staging-URL vervangen door die van productie:
   - `workers/media-api/wrangler.toml`: `SUPABASE_URL` onder `[vars]` en
     `[env.production.vars]`;
   - `workers/email-inbound/wrangler.toml`: `MAIL_INBOUND_ENDPOINT` onder
     `[vars]` en `[env.production.vars]`;
   - `workers/caldav/wrangler.toml`: `SUPABASE_URL` onder
     `[env.production.vars]` (nu `YOUR_PRODUCTION_PROJECT`).
2. Zet per worker de productie-secrets, met **andere waarden dan staging**
   (`npx wrangler secret put <NAAM> --env production`):
   - media-api: `SUPABASE_SERVICE_ROLE_KEY`, `MEDIA_SIGNING_SECRET`,
     `INTERNAL_UPLOAD_SECRET`, `OFFICE_CONVERT_SECRET`, `STREAM_API_TOKEN`,
     `STREAM_SIGNING_KEY_ID`, `STREAM_SIGNING_KEY_JWK`;
   - email-inbound: `MAIL_INBOUND_SECRET`;
   - caldav: `SUPABASE_SERVICE_ROLE_KEY`.
3. Overweeg eigen domeinen in plaats van `*.gerjan.workers.dev` (bijvoorbeeld
   `media.resofly.com`). Dan kan de CSP exacte hosts noemen (actie 22).

**Klaar als:** `npx wrangler deploy --env production --dry-run` in elke map
alleen productie-URL's toont.

### 9. Eigen office-server voor productie (eigenaar, punt F)

**Waarom:** één Collabora-instantie verwerkt nu de documenten van staging én
productie. Een fout of overbelasting op staging raakt dan ook de klanten. En
`localhost` staat in `FRAME_ANCESTORS`.

**Stappen:**
1. Laat een `[env.production]` toevoegen aan `workers/office-server/wrangler.toml`,
   met een eigen naam, en zonder `localhost` in `FRAME_ANCESTORS`.
2. Zet daar een eigen `OFFICE_CONVERT_SECRET`, en dezelfde waarde in de
   productie-media-worker.
3. Laat in `public/_headers` de productie-host van de office-server toevoegen
   (`form-action` en `frame-src`).

**Klaar als:** de editor op productie een andere office-server gebruikt dan
staging.

### 10. Supabase-productieproject inrichten (eigenaar)

Neem op productie over wat op staging al is gezet, en zet de testschakelaars
uit. Per onderdeel:

**Authentication**
- Providers → Email: minimaal 12 tekens, met kleine letter, hoofdletter en
  cijfer (fix 2).
- Een wachtwoord wijzigen vraagt opnieuw bevestigen ("Secure password change",
  fix 2).
- **Allow new users to sign up** uit (`disable_signup`).
- URL Configuration: Site URL en Redirect URLs alleen het eigen domein; geen
  `localhost`, geen staging.
- Providers → Google uit, tenzij je hem echt gebruikt.
- Rate Limits: "emails sent" hoger dan 50 per uur. Dat vraagt eigen SMTP; met
  50 per uur voor het hele project krijgt bij drukte niemand nog een inloglink.

**Database**
- Settings → SSL Configuration: **Enforce SSL** aan (fix 5). Dit herstart de
  database even.
- Network Restrictions: alleen de adressen die het nodig hebben. Deploy dan
  via een vaste runner of vanaf je eigen machine.
- Migraties: `supabase db push`, ook alle migraties van deze ronde
  (`20261101000000` t/m `20261101160000`).

**Edge Functions → Secrets.** Deze mogen op productie **niet** bestaan, want
elk ervan zet een slot open:

| Secret | Wat het opent |
| --- | --- |
| `MOLLIE_ALLOW_MOCK` | Een abonnement afronden zonder te betalen |
| `INVOICE_MOLLIE_ALLOW_MOCK` | Nepbetaallinks die vanzelf op betaald gaan |
| `INVOICE_DEBUG_ERRORS` | Interne foutteksten naar de browser |
| `MAIL_ALLOW_LOCAL_DEV`, `QUOTE_ALLOW_LOCAL_DEV` | Verzoeken zonder Origin en vanaf localhost |
| `RESEND_WEBHOOK_ALLOW_UNSIGNED` | Resend-events zonder handtekening |
| `MAIL_INBOUND_ALLOW_UNSIGNED` | Inkomende mail zonder geheim |

Wel zetten:
- `MAIL_INBOUND_REQUIRE_SIGNATURE` = `true`;
- `RESEND_WEBHOOK_SIGNING_SECRET`, onder de juiste naam (de rest van Resend:
  punt 26);
- alle `*_ALLOWED_ORIGINS` en `*_ALLOWED_RETURN_ORIGINS` met alleen het
  productiedomein.

Op staging staan nu `MOLLIE_ALLOW_MOCK`, `INVOICE_DEBUG_ERRORS`,
`MAIL_ALLOW_LOCAL_DEV` en `QUOTE_ALLOW_LOCAL_DEV` aan. Dat is daar de
bedoeling, maar kopieer de secrets dus niet blind over.

**Realtime**
- De Teamchat-kanalen zijn privé (fix 34). Publieke kanalen staan op het
  project nog aan; de kanalen voor databasewijzigingen gebruiken die, met de
  RLS van de tabellen als bescherming.
- Wil je publieke kanalen helemaal uit (Realtime → Settings, "Allow public
  access"), test dat dan eerst op staging. Mogelijk moeten die kanalen dan ook
  privé.

**Klaar als:** de lijst secrets op productie geen van de zes uit de tabel
bevat, en de rooktest slaagt.

### 11. Captcha op inloggen (eigenaar + code)

**Waarom:** zonder captcha kan een script onbeperkt e-mailadressen proberen.
Via de Auth-API ziet het welke een account hebben (fix 3), en het kan
mailboxen bestoken met inloglinks.

**Stappen:**
1. Maak een Cloudflare Turnstile-site aan (Cloudflare → Turnstile) voor het
   productiedomein, en een voor staging.
2. Supabase → Authentication → Attack Protection → **Enable Captcha
   protection** → Turnstile, met de secret key.
3. Laat de site key als `VITE_TURNSTILE_SITE_KEY` in de frontend inbouwen
   (inlogscherm en portal-login). Dat is codewerk; zet de captcha in Supabase
   pas aan als die versie live staat, anders kan niemand inloggen.

**Klaar als:** inloggen werkt met de captcha, en zonder token weigert de
Auth-API.

### 12. Supabase Pro voor productie (eigenaar)

**Waarom:** twee beschermingen bestaan alleen op Pro:
- gelekte wachtwoorden weigeren (HaveIBeenPwned);
- sessies laten verlopen na inactiviteit, en een maximale sessieduur.

Ook de back-ups per moment (PITR) zitten daar.

**Stappen:** Organization → Billing → Pro. Daarna:
- Authentication → Attack Protection → **Leaked password protection** aan;
- Authentication → Sessions → een time-box (bijvoorbeeld 30 dagen) en een
  inactivity timeout (bijvoorbeeld 7 dagen).

### 13. Buiten de code: AVG, back-ups, monitoring (eigenaar)

Hoort bij veilig als SaaS werken, maar staat buiten deze codereview:
- **Verwerkersovereenkomsten** (DPA) met Supabase, Cloudflare, Resend,
  Anthropic, Mollie en Enable Banking, en een eigen verwerkersovereenkomst
  voor je klanten.
- Een **datalekprocedure**: wie beslist er, en melden binnen 72 uur bij de
  Autoriteit Persoonsgegevens.
- **Back-ups:** PITR aan (actie 12), en één keer een terugzetting oefenen.
- **Monitoring:** meldingen bij een stijging in 401/403/429/5xx van de edge
  functions en workers, en bij een ongewoon hoog AI-verbruik of mailvolume.

### 25. Tweestapsverificatie (MFA) aanbieden (code + keuze)

**Waarom:** inloggen gaat alleen met een magic link. Wie de mailbox van een
teamlid heeft, heeft dus ook diens administratie: facturen, bankkoppeling,
leden. TOTP staat in Supabase al aan, maar de app biedt het nergens aan.

**Aanpak:**
1. In de app: een tweede factor instellen met een QR-code
   (`supabase.auth.mfa.enroll`), en bij het inloggen de code vragen
   (`challenge` en `verify`).
2. Keuze: verplicht voor eigenaren, beheerders en boekhouders, en vrijwillig
   voor de rest.
3. Afdwingen in de database. Gevoelige handelingen alleen met `aal2` in het
   JWT: schrijven in Financiën, leden en rollen beheren, API-sleutels en
   koppelingen. Dat kan in `can_write_module` en `can_admin_org`, voor wie
   een factor heeft.

**Klaar als:** een eigenaar zonder tweede factor wordt gevraagd die in te
stellen, en met alleen een magic link geen facturen of leden kan wijzigen.

### 26. Resend en eigen verzenddomeinen op productie (eigenaar + keuze)

**Waarom:** sinds 6 november kan een organisatie haar eigen domein koppelen,
zodat haar mail van bijvoorbeeld `info@bakkerij.nl` komt
(`CHANGELOG_EIGEN_VERZENDDOMEIN_2026-11-06.md`; de werking staat in
`docs/setup/RESEND_SETUP.md`, hoofdstuk 8). Op staging is Resend daar bewust
nog niet helemaal voor ingericht (punt 4): dat gebeurt bij de overstap naar
productie. Drie feiten bepalen de volgorde:

- **Een domein kan maar in één Resend-account tegelijk geverifieerd zijn.**
  Elk account gebruikt dezelfde DKIM-naam (`resend._domainkey`) met een eigen
  sleutel, en in de DNS past maar één waarde. Resend kan een domein overzetten
  ("domain claims"), maar ResoFly gebruikt dat nog niet.
- **Alle organisaties delen het Resend-account.** Elk gekoppeld domein telt
  mee voor het maximum van het abonnement, ook een dat nooit geverifieerd
  wordt. Zo'n domein blijft staan tot de organisatie het verwijdert, of tot een
  andere organisatie het na zeven dagen overneemt. Vanzelf opruimen gebeurt
  niet.
- **Het afzenderdomein van het platform** (`RESEND_FROM_EMAIL`) moet in
  hetzelfde account geverifieerd zijn als de klantdomeinen: één API-sleutel
  verstuurt alles.

**Keuze vooraf: één Resend-account voor staging en productie, of twee?**
Aanbevolen: twee (bijvoorbeeld twee teams in Resend). Met één gedeeld account:

- staat een domein dat je op staging koppelt, op productie in de weg;
- tellen de testdomeinen van staging mee voor het maximum van productie;
- kan wie de sleutel van staging heeft, mailen namens elk klantdomein op
  productie;
- krijgen beide webhooks elkaars events. Dat is onschuldig (ze vinden de mail
  of het domein niet terug), maar het vult de logs.

Met twee accounts heeft staging een eigen afzenderdomein nodig, want hetzelfde
domein kan niet in beide geverifieerd zijn. Bijvoorbeeld
`staging.mail.resofly.com` voor staging en `mail.resofly.com` voor productie.
Gebruikt staging nu het domein dat productie moet krijgen (kijk naar
`RESEND_FROM_EMAIL` op staging), zet staging dan eerst over op het nieuwe
subdomein. Haal daarna het oude domein uit het staging-account. Let ook op het
domeinmaximum van het abonnement van staging: het afzenderdomein telt daar
ook mee.

**Stappen:**
1. Resend: het account voor productie, met een abonnement dat genoeg domeinen
   heeft. Reken met 1 (het platform) plus het aantal organisaties met een
   eigen domein, plus wat speling voor pogingen die blijven hangen. Een
   organisatie kan er zelf maximaal 5 koppelen (`MAX_SENDING_DOMAINS_PER_ORG`
   in `supabase/functions/mail/index.ts`). In november 2026 had Pro 10
   domeinen en Scale 1.000, met een uitbreiding van 100 domeinen; controleer
   de actuele prijzen op resend.com/pricing.
2. Resend → Domains: voeg het afzenderdomein van het platform toe in regio
   `eu-west-1`, plaats de records en verifieer. Zet SPF, DKIM en DMARC goed
   (punt 24).
3. Resend → API Keys: maak een sleutel met **Full access**. Met
   "Sending access" kan de mail-functie wel versturen, maar geen domeinen
   aanmaken, controleren of verwijderen: "Domein toevoegen" geeft dan een fout
   van Resend.
4. Resend → Webhooks: maak een endpoint
   `https://<productie-ref>.supabase.co/functions/v1/resend-webhook` met deze
   events:
   - `email.sent`, `email.delivered`, `email.opened`, `email.clicked`,
     `email.bounced`, `email.failed`, `email.complained`;
   - `domain.created`, `domain.updated`, `domain.deleted`.

   Kopieer het **Signing secret** (begint met `whsec_`).
5. Supabase (productie) → Edge Functions → Secrets:

   | Secret | Waarde |
   | --- | --- |
   | `RESEND_API_KEY` | de sleutel uit stap 3 |
   | `RESEND_FROM_EMAIL` | bijvoorbeeld `ResoFly <noreply@mail.resofly.com>`, op het domein uit stap 2 |
   | `RESEND_REPLY_TO` | waar antwoorden op mail vanaf het platformdomein heen gaan. Mail vanaf een eigen domein krijgt het eigen adres als Reply-To |
   | `RESEND_WEBHOOK_SIGNING_SECRET` | het secret uit stap 4 |
   | `MAIL_ALLOWED_ORIGINS` | alleen het productiedomein (punt 10) |

   `RESEND_DEFAULT_REGION` hoeft niet: zonder dat secret is het `eu-west-1`.
   `RESEND_WEBHOOK_ALLOW_UNSIGNED` mag niet bestaan (punt 10). Controleer de
   namen daarna met `supabase secrets list --project-ref <productie-ref>`. Op
   staging stond het webhook-secret als
   `RESEND_WEBHOOK_SIGNING_SECRET="jouw_resend_webhook_secret"` (punt 4): naam
   en voorbeeldwaarde samen in het naamveld. Dan bestaat het echte secret niet
   en weigert de webhook elk event.
6. Tracking (keuze): ResoFly geeft bij het aanmaken van een klantdomein geen
   open- of kliktracking mee, dus geldt de standaard van Resend. Kijk bij het
   eerste klantdomein in Resend (Domains → het domein) wat er staat. Staat het
   uit, dan komen "geopend" en "geklikt" voor mail vanaf een eigen domein niet
   binnen. Aanzetten is een afweging tussen inzicht en de privacy van de
   ontvanger; daarna is het een kleine wijziging in de code (de aanroep van
   `POST /domains` in `mail/index.ts`).
7. Je eigen domein (`gerjanvanlopik.nl`): verwijder het eerst op staging
   (Instellingen → E-mail → Verwijderen; dan verdwijnt het ook uit dat
   Resend-account) en koppel het daarna op productie. Je krijgt daar nieuwe
   records met een nieuwe DKIM-sleutel: vervang de oude waarde van
   `resend._domainkey` bij je DNS door de nieuwe.

**Nog niet in de code:**
- Een klant die zijn domein al in een eigen Resend-account geverifieerd heeft,
  kan het niet koppelen: Resend weigert het. Hij haalt het daar eerst weg, of
  ResoFly bouwt het overzetten via domain claims in.
- Een domein dat nooit geverifieerd wordt, blijft in het account staan en telt
  mee. Kijk af en toe in Resend → Domains, of laat een opruimtaak bouwen
  (bijvoorbeeld: na dertig dagen nog niet geverifieerd, dan weg bij Resend en
  in ResoFly).

**Klaar als:**
- op productie een testdomein koppelen de DNS-records toont, met per record
  een status;
- na het plaatsen en "Verifieer" de status binnen een minuut op
  "Geverifieerd" springt, zonder opnieuw te klikken;
- een testmail (Instellingen → E-mail) aankomt vanaf het eigen adres, en
  "Beantwoorden" in je mailprogramma dat eigen adres invult, niet het
  ResoFly-adres;
- Resend → Webhooks → het endpoint de events met status 200 toont, en geen 400
  ("Webhook signature ongeldig" of "RESEND_WEBHOOK_SIGNING_SECRET ontbreekt");
- een verwijderd testdomein ook in Resend → Domains weg is.

---

## Keuzes die bij jou liggen

### 14. Privé-afspraken en opnames (keuze, punt P)

- Uren uit een koppeling met een privé-afspraak nemen de titel van die afspraak
  over in de omschrijving van de uren. Die is zichtbaar voor iedereen die de
  uren ziet.
- Opnames en transcripties van vergaderingen uit een privé-agenda zijn
  zichtbaar voor elk teamlid met Agenda.

**Voorstel:** bij een privé-afspraak de titel niet overnemen ("Privé-afspraak"),
en opnames uit een privé-agenda alleen tonen aan de eigenaar van die agenda en
de beheerders. Zeg welke variant je wilt; het is een kleine migratie.

### 15. Deellink van een galerij (keuze, punt Q)

De app bewaart het token van de deellink leesbaar, zodat het team de link later
opnieuw kan kopiëren. Daardoor is de pincode-hash snel terug te rekenen voor
wie de database kan lezen. De pincode beschermt dus tegen een doorgestuurde
link, niet tegen een datalek.

**Voorstel:** zo laten. Het gemak weegt zwaarder, en wie de database kan lezen,
kan de foto's ook zonder pincode zien. Wil je het toch dicht: alleen de hash
bewaren, en de link alleen direct na het maken tonen.

### 16. Campagne-HTML saneren (keuze, punt A)

Campagne- en flow-HTML gaat ongesaneerd de deur uit. De standaard-sanitizer
haalt de inline styles weg, en daarmee de opmaak van elk ontwerp. Testmails
gaan al alleen naar het team, en alles telt mee in het mailquotum.

**Voorstel:** zo laten, of een e-mailvriendelijke sanitizer inbouwen die
inline styles bewaart. Alleen teamleden met schrijfrecht op Marketing maken
campagnes.

### 17. Offertes zelf goedkeuren (keuze)

Een beheerder kan een offerte die hij zelf heeft ingediend, ook zelf intern
goedkeuren. Voor een klein team is dat handig, maar het is geen vier-ogen-principe.

**Voorstel:** een instelling per werkruimte: "Goedkeuren door een ander".

---

## Nog te doen in de code

### 18. Vite naar een nieuwe hoofdversie (code)

`npm audit` meldt kwetsbaarheden in Vite 5 en esbuild. Ze raken alleen de
lokale dev-server, niet de productiebundel. De productie-packages van de app
en de vier workers hebben geen meldingen. De oplossing is Vite 8, een
major-upgrade: plan die als onderhoud, met een build en een rooktest. Tot dan:
`npm run dev` niet met `--host` op een onbekend netwerk.

### 19. Bytes-teller in de media-worker (code, punt L)

Het opslagquotum telt alleen bestanden met een rij in de database. Een bestand
waarvoor de browser nooit een rij maakt, telt niet mee. Dat geldt ook voor een
directe upload naar Stream. Zo kan een klant met een account onbeperkt opslag
vullen.

**Aanpak:**
- De worker houdt per organisatie de bytes bij die hij in R2 zet en weghaalt.
- Het quotum toetst op het hoogste van die teller en de rijen.

Opruimen is geen goede oplossing: zolang niet elke tabel met opslagsleutels
bekend is, kost dat data.

### 20. AI-budget vooraf reserveren (code, punt M)

Het maandplafond wordt pas na een aanroep bijgewerkt. Veel gelijktijdige
aanroepen passeren samen de controle, en mislukte aanroepen tellen niet mee.

**Aanpak:** in `checkAiBudget` een geschatte kost reserveren, en die na de
aanroep vervangen door de echte. Dat raakt alle 26 plekken waar AI wordt
aangeroepen, dus samen met tests doen.

### 21. DMARC-uitslag van inkomende mail (code, punt G)

De email-worker geeft de uitslag van SPF, DKIM en DMARC niet door. Bij
doorgestuurde mail faalt DMARC vaak ook bij echte mail, dus weigeren kan niet.

**Aanpak:**
- De kop `Authentication-Results` meegeven.
- In `mail-inbound` de uitslag bewaren.
- In de app "afzender niet geverifieerd" tonen bij een fail.

### 22. CSP per omgeving (code, punt R)

De CSP staat `*.supabase.co` en `*.workers.dev` toe: elk Supabase-project en
elke worker van wie dan ook. Scripts zijn wel goed dichtgezet (alleen eigen
scripts, met een hash).

**Aanpak:** bij het bouwen de exacte hosts invullen, uit `VITE_SUPABASE_URL`
en de worker-URL's. Hoe zinvol dat is, hangt af van `img-src https:`: die
blijft nodig voor afbeeldingen in mail, en laat ook gegevens naar buiten. Doe
dit samen met de eigen domeinen uit actie 8.

### 23. Maker op de overige tabellen (code, punt U)

Op zo'n 40 tabellen buiten de boekhouding (taken, notities, projecten, mail)
vult de app `created_by` zelf in. Daar hangt geen recht aan, alleen de naam die
het team ziet. Waar de maker wél toegang geeft (Gerrie-gesprekken,
agendakoppelingen, contractnotities), eist de database bij aanmaken al dat jij
het bent, of schrijft alleen de server.

**Aanpak:** de trigger `stamp_actor_columns` uit fix 31 erop zetten. Ga per
tabel na of een import of Gerrie namens iemand anders aanmaakt; die draaien
met de service-role en blijven ongemoeid.

---

## Rooktest na een uitrol

1. Inloggen met een magic link, en uitloggen.
2. Klantportaal: inloggen als klant, een offerte bekijken.
3. Galerij met pincode:
   - acht keer fout: alleen jij zit een kwartier vast;
   - vanaf een ander apparaat of netwerk: de juiste pincode werkt.
4. Galerij: een foto en een video uploaden, en de video afspelen.
5. Office-editor: een Word-document openen, wijzigen, opslaan en als PDF
   downloaden.
6. Een factuur versturen, en de publieke factuurpagina openen.
7. Een contract laten tekenen via de link.
8. Inkomende mail: een mail naar het doorstuuradres komt in het dossier.
9. Teamchat met twee teamleden: je ziet elkaar online, en "typt…" verschijnt
   bij de ander (fix 34; de kanalen zijn nu privé).
10. Boekhouding: een memoriaalboeking maken. Een boeking in een afgesloten
    periode wordt geweigerd.
11. De smoke test in de GitHub-workflow is groen.
