# Beveiligingsronde SaaS: de app doorgelicht voor gebruik door meerdere klanten

**1 november 2026 · database, edge functions, workers, frontend en Supabase-instellingen**

Doel: de app veilig kunnen aanbieden als SaaS, met veel organisaties naast elkaar.
Dit is de tweede ronde na `CHANGELOG_BEVEILIGING_2026-09-26.md`. Sindsdien kwamen
de openbare API, webhooks, het boekhouder-gastaccount, bestanden versturen,
teamchat-teams, klantmeldingen, e-facturatie en Jitsi erbij.

> **Status: in uitvoering.** Onderaan staat wat nog openligt. Een volgende sessie
> begint bij **Verder in de volgende sessie**.

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
2. Ga verder met het eerste onderdeel hieronder dat nog niet af is.

| Onderdeel | Stand |
| --- | --- |
| Live controles staging | klaar |
| Security-definer-functies | bezig |
| RLS-policies | bezig |
| Publieke edge functions en webhooks | bezig |
| Ingelogde edge functions en handelingen | bezig |
| Cloudflare-workers | bezig |
| Frontend en repo-configuratie | bezig |
| Supabase Auth-instellingen | klaar op staging (productie: zie fix 2) |
| Rechten van `anon` | klaar (migratie 20261101000000) |

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
