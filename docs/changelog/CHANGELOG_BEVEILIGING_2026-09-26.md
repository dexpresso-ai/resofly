# Beveiligingsronde: de hele app doorgelicht en dichtgezet

**26 september 2026 · database, edge functions, workers en frontend · nog niet uitgerold**

De hele app is doorgelicht op negen fronten: RLS en grants, databasefuncties,
publieke functies, webhooks en cron, financiële en communicatiefuncties, AI/MCP,
de Cloudflare-workers en de frontend. Daarnaast drie live controles:

- **Git-geschiedenis:** geen geheimen, alleen placeholders en de publieke sleutel.
- **Dependencies:** DOMPurify bijgewerkt naar 3.4.16. Productie-dependencies hebben nu 0 kwetsbaarheden.
- **Anonieme toegang op staging:** uit geen enkele tabel lekken rijen, alleen de openbare prijsplannen.

## Het ernstigste: billing-functies open voor iedereen

Supabase geeft elke nieuwe functie een eigen EXECUTE-grant aan `anon` én
`authenticated`. Alleen `revoke ... from public`, het patroon in de billing-
migraties, laat die grants staan. Daardoor kon iedereen met de publieke sleutel
functies als `set_organization_billing_exempt` en `apply_organization_*_change`
aanroepen, en zo voor elke organisatie een plan, gebruikersplekken, modules of
een vrijstelling aanzetten.

Migratie `20260926000000_security_hardening.sql` zet ze dicht:

- De billing-functies kan alleen nog de service-role aanroepen.
- `anon` verliest EXECUTE op álle security-definer-functies. De app roept die zonder login nergens aan.
- `migrationGrants.test.ts` faalt als een nieuwe migratie een security-definer-functie maakt zonder `revoke ... from public, anon`.

## Wat er verder dicht is

**Database (dezelfde migratie)**
- **Organisatiestructuur:** `organizations` is direct alleen nog op de naam bij te werken. Een admin kon zijn organisatie onder een willekeurige andere hangen en zo diens modules en billinggegevens krijgen.
- **Factuur-bewijstabellen:** betaalrecords, verzendingen en workflow-events schrijft alleen de service-role nog. Het webhook-secret is uit de opgeslagen Mollie-metadata gehaald.
- **Btw-aangifte:** direct bijwerken mag alleen nog de status, en alleen vooruit.
- **Contracten:** een nieuw contract is altijd een concept. Een ondertekenlink ontstaat alleen via de verstuurflow.
- **Teamchat:** deelnemersrijen en het soort gesprek liggen vast. Bijlagen van een chatbericht ziet alleen wie in dat gesprek zit.
- **Agenda en boekingen:** deelnemers en boekingstabellen schrijft alleen de service-role.
- **Organisatiegrens:** koppelingen die die grens nog niet bewaakten, doen dat nu.
- **Opslagsleutels:** een sleutel moet onder `<organization_id>/` liggen.
- **CalDAV:** alleen actieve leden, met hun recht op Agenda. App-wachtwoorden vervallen zodra iemand uit het team gaat.

**Media-worker (`workers/media-api`)**
- **Verwijderde teamleden** (status `disabled`) hebben geen toegang meer tot bestanden.
- **Viewers** kunnen niet meer uploaden of verwijderen. Vastgelegde factuur-, offerte- en contract-PDF's zijn helemaal niet meer te verwijderen.
- **Modulerechten** gelden nu ook voor bestanden, Word-bewerken en WOPI.
- **Opslagsleutel:** die moet bij de organisatie van de rij horen. Voorheen kon een rij naar het bestand van een andere organisatie wijzen.
- **Galerij:** serveert alleen beeld, video en audio nog inline. Elke bestandsrespons krijgt `nosniff` en `CSP: sandbox`.

**Edge functions**
- **Koppelscherm voor een eigen AI:** toont waar de toegang heen gaat, met een waarschuwing bij een onbekende dienst. Meelezen is daar de standaard.
- **MCP:**
  - Het aanroepplafond telt weer (was bij commit 148520e weggevallen).
  - Een hergebruikt refresh token zet de koppeling op slot.
  - Team- en instellingshandelingen kunnen alleen namens owners/admins.
- **Gerrie en routines:**
  - Gerrie respecteert een dichtgezette module Gerrie ook bij directe aanroepen.
  - Een gesprek laden kan alleen als het van jou is.
  - Een routine aanpassen of starten doet alleen de maker.
- **Agenda en afspraken:**
  - Privé-agenda's en ICS-links van collega's zijn niet meer via AI op te vragen.
  - Contacten doorzoeken kan alleen in je eigen account.
- **Publieke pagina's:**
  - Offerte-, factuur- en contracttijdlijnen tonen klanten alleen nog klantstappen: geen interne afwijzingsreden, geen foutteksten, geen tracking.
  - De portal-login zegt niet meer of een e-mailadres bij een klant hoort.
  - Deellinks en het portaal halen alleen bestanden van de eigen organisatie op.
- **Financiën:**
  - Vpb vraagt het Financiën-recht.
  - Het abonnement wijzigen vraagt owner/admin van de moederorganisatie.
  - De Mollie-webhook negeert betalingen waarvan de metadata niet bij de betaalrij past.
  - Het cron-secret wordt alleen nog als header geaccepteerd.
  - De factuur-inbox boekt niet automatisch als het IBAN afwijkt van de bekende leverancier.
- **Overig:**
  - Push stuurt alleen naar echte push-diensten.
  - Afspraken en opnames koppelen alleen klanten en projecten van de eigen organisatie.
  - Een opname vraagt schrijfrecht, en de ElevenLabs-webhook is niet opnieuw af te spelen.
  - Klantmail wordt op de server gesaneerd.

**Frontend**
- **CSP-hash:** stond sinds `e0f2497` verkeerd, waardoor het themascript werd geblokkeerd. Hij klopt weer en `scripts/check-csp-hash.mjs` bewaakt hem in CI.
- **Deellink-pagina's** krijgen `noindex`.
- **Inkomende mail:** mag geen `class`/`id` meer dragen en blijft binnen het berichtvak.
- **Links uit opgeslagen gegevens:** alleen nog `http(s)`. Betaallinks alleen naar Mollie.
- **Uitloggen:** zet push uit en wist lokale werkgegevens.
- **Service worker:** opent alleen nog adressen binnen de eigen app.

## Uitrollen, in deze volgorde

1. **Database:** `npx supabase db push --linked` (met een vers `SUPABASE_ACCESS_TOKEN`).
2. **Edge functions:** allemaal, `npx supabase functions deploy --project-ref enzghpduqwaojcxgwarr`.
3. **Workers:** `media-api` en `caldav` (`npm run deploy:staging` / `wrangler deploy`).
4. **Frontend:** via Cloudflare Pages.

Na stap 1:
- Roteer `MOLLIE_WEBHOOK_SECRET` en `INVOICE_MOLLIE_WEBHOOK_SECRET`. Die waren leesbaar voor leden met Financiën-leesrecht.
- Deze query moet 0 rijen geven:

```sql
select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute');
```

- Controleer of er organisaties onder een moeder hangen die daar niet horen: een `parent_organization_id` zonder `entity_created`-regel in `audit_logs`.

In het Supabase-dashboard:
- **Registratie:** "Allow new users to sign up" moet uit staan als registratie alleen via uitnodiging gaat.
- **E-mailbevestiging:** "Confirm email" moet aan staan.
- **Wachtwoorden:** zet leaked password protection aan.

## Bewust nog niet gedaan

Deze punten vragen een ontwerpkeuze of een test tegen een live omgeving.

**Middel**
- **Vrije mail:** geen verzendquotum per organisatie. Wie via de platform-afzender mailt, kan onbeperkt versturen.
- **Portal-klanten:** krijgen bij inloggen in de werkruimte automatisch een eigen owner-organisatie (`ensure_user_default_organization`).
- **Agenda-OAuth:** de callback is niet gebonden aan de sessie die de koppeling startte.
- **Afzender van inkomende mail:** de email-inbound-worker geeft het DMARC-resultaat niet door, dus de afzender is niet te verifiëren.
- **Office-server:** bewaakt alleen `convert-to`, niet de andere Collabora-conversie-eindpunten. Staging en productie delen één instantie.
- **Finance-rapport-RPC's:** proef- en saldibalans, btw en winst-en-verlies controleren de rol, niet het modulerecht Financiën.
- **Facturen:** vergrendelvelden zijn niet server-only, zoals bij offertes wel.
- **Audit-log:** is voor elk lid leesbaar, ook voor modules die voor hem dichtstaan.

**Laag**
- `calendar_sources.feed_url` is leesbaar voor het team zodra een ICS-agenda gedeeld is.
- Het AI-budget laat bij een databasefout door. Dat is een bewuste keuze in de code.
- Vite en esbuild: de kwetsbaarheden raken alleen de lokale dev-server; oplossen vraagt een major-upgrade.
