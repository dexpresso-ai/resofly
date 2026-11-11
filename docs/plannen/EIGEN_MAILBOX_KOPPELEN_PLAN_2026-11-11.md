# Plan: je eigen mailbox koppelen aan Berichten (2026-11-11)

> **Stand op 11 november 2026: plan, nog niets gebouwd.** Onderzocht op `staging` (`a3a455a`).
> Tickets en telefoon blijven zoals ze zijn; dit plan gaat alleen over e-mail.

Vraag: *Ik wil een eigen mailfunctionaliteit inbouwen binnen Berichten. Klanten moeten hun eigen
mailbox kunnen koppelen. Voor Microsoft via MS Graph, en nodemailer en imapflow voor mailboxen bij
een hostingpartij en dergelijke.*

**Kort.** Een organisatie koppelt één of meer echte mailboxen: `jan@bedrijf.nl` of `info@bedrijf.nl`.
Berichten wordt daarmee een postvak voor klantmail, niet langer een kopie van wat via ResoFly ging.

1. **Twee soorten koppeling, één resultaat.**
   - **Microsoft 365 en Outlook.com**: inloggen met Microsoft en toestemming geven. ResoFly praat met
     Microsoft Graph. Er wordt geen wachtwoord opgeslagen.
   - **Andere mailboxen** (TransIP, Strato, Hostnet, one.com, een eigen server; Gmail en iCloud met een
     app-wachtwoord): adres en wachtwoord invullen. ResoFly zoekt de instellingen zelf op. Lezen gaat
     met imapflow, versturen met nodemailer.
2. **Lezen.** Mail van en naar klanten komt vanzelf in Berichten en in het klantdossier: wat
   binnenkomt én wat je vanuit Outlook verstuurt. Je kiest per mailbox: *alleen klantmail* (standaard)
   of *alles* (voor een gedeeld adres als info@). Wat niet bij een klant hoort, haalt ResoFly bij
   *alleen klantmail* niet eens op.
3. **Versturen.** Een antwoord uit Berichten gaat vanuit je eigen mailbox. Het staat in je eigen map
   Verzonden. De klant antwoordt op je echte adres, en dat antwoord komt terug in hetzelfde gesprek.
4. **Eén weg naar binnen, één weg naar buiten.** Microsoft en IMAP leveren hun mail af bij één
   databasefunctie die ontdubbelt, het gesprek zoekt en de klant koppelt. Versturen gaat altijd via de
   bestaande functie `mail`, met dezelfde rechtencontrole als nu.
5. **Waar het draait.**
   - Microsoft past in de edge functions, net als de agenda nu.
   - IMAP en SMTP niet. Die hebben een proces nodig dat altijd draait en verbindingen openhoudt, en
     Supabase blokkeert poort 587. Daarvoor komt één nieuwe service, `workers/mail-engine`: Node in
     een Cloudflare Container, zoals de Office-server al draait.
6. **Resend blijft** voor systeemmail: facturen, offertes, herinneringen, het portaal en marketing.
   Het doorstuuradres blijft bestaan voor wie niet wil koppelen.

Dit document is een plan, geen bouwopdracht. De volgorde staat in §13, de beslissingen in §15.

---

## 1 · Wat er al ligt

| Bouwsteen | Waar | Wat we eraan hebben |
|---|---|---|
| Berichten: gesprekken, Ongelezen, Niet gekoppeld, zoeken, filters, tickets ertussen | `src/features/Communication.tsx` (`CommunicationPage`, `ThreadPane`, `ComposePane`), `src/lib/communication.ts` | Het scherm bestaat. Mailboxmail wordt gewoon een gesprek. |
| Klantmail in de database | `client_email_threads`, `client_emails` (`20260620000003_client_emails.sql`), leesstatus per persoon in `client_email_reads`, view `client_email_thread_overview`, `search_client_emails` | Zelfde tabellen. Er komen kolommen bij, geen tweede postvak. |
| Inkomende mail: ontdubbelen, klant zoeken, gesprek kiezen, opvangbak | `register_inbound_message`, `resolve_inbound_client`, `pick_client_email_thread`, `inbound_messages` (`20260815000000_inbound_doorstuuradres.sql`) | De slimste stukken zijn er al, in SQL. De nieuwe ingang gebruikt ze opnieuw. |
| MIME lezen | `postal-mime` in `workers/email-inbound` | Werkt in Node én in Deno: één parser voor Microsoft en IMAP. |
| HTML van klanten veilig tonen | `src/lib/sanitizeHtml.ts` (`sanitizeInboundEmailHtml`, blokkeert afbeeldingen) | Ongewijzigd bruikbaar. |
| Microsoft-login met Graph | `_shared/calendarOAuth.ts` (state met HMAC, terugkeeradres gecontroleerd, code pas inwisselen met de sessie van de gebruiker), `_shared/calendarCore.ts` (`refreshAccessToken`, `classifyTokenFailure`) | Het hele OAuth-patroon is er en is al eens gehard (`CHANGELOG_CALENDAR_OAUTH_PUBLIC_CALLBACK_STATE_HARDENING_2026-05-26.md`). |
| Geheimen versleutelen | AES-GCM in `_shared/webhooks.ts:206` (`encryptSecret`/`decryptSecret`, sleutel als argument), twee kopieën in `calendarCore.ts` en `mollieSecrets.ts` | Wordt één gedeelde module die ook in Node draait. |
| Wachtrij met `FOR UPDATE SKIP LOCKED` | `claim_webhook_deliveries` (`20261003010000_webhooks.sql`): pogingen, `next_attempt_at`, vastgelopen rijen terugpakken | Sjabloon voor de verzendwachtrij en de leases. |
| Bestanden op R2 vanuit de server | `storeInboxAttachment` in `_shared/invoiceInbox.ts` → media-worker `/internal/media` | Bijlagen van mailboxmail gaan dezelfde weg. |
| Een Node-container op Cloudflare | `workers/office-server` (Worker + Durable Object + Container) | Het deploypatroon voor de mail-engine. |
| Verzendlimiet per organisatie | `email_quota_take`, `organization_email_limits` (200 per uur, 1000 per dag) | Geldt ook voor versturen via de mailbox. |
| Vertrek van een teamlid zet koppelingen uit | `disable_integrations_on_member_exit` (`20261101020000`) | Uitbreiden met persoonlijke mailboxen. |
| Logboek, exportmanifest | `audit_row_change`, `audit_logs_action_check`, `src/lib/exportManifest.ts` | Nieuwe tabellen krijgen daar meteen hun plek. |

**Wat er niet is:**

- Geen enkele verbinding met een mailbox. Mail komt binnen op `reply+…@inbound.resofly.com` of via een
  doorstuurregel die de klant zelf moet instellen.
- **ResoFly zet bij uitgaande mail geen eigen `Message-ID`, `In-Reply-To` of `References`.** Resend
  kiest zelf een `Message-ID`, maar die wordt niet bewaard. Het commentaar bij de kolom belooft dat
  `resend-webhook` hem vult, maar dat gebeurt nergens. Antwoorden vinden hun gesprek nu via het `reply+`-adres. Met een eigen mailbox bestaat dat
  adres niet meer, dus de koppen moeten kloppen.
- De route met een `reply+`-token kiest het gesprek opnieuw in plaats van het gesprek van het
  oorspronkelijke bericht te nemen, en `in_reply_to` wordt opgeslagen maar nergens gebruikt.
- `client_emails` kent één `to_email`, geen cc en geen bijlagen. Van inkomende mail bewaren we alleen
  de namen van bijlagen.
- Gerrie stuurt `sendClientEmail` zonder `threadId`. Elke mail van Gerrie begint dus een nieuw gesprek.

## 2 · Waarom nu wel (in juli bewust niet)

`20260721020000_user_sender_identities.sql` zegt het letterlijk: *"GEEN mailbox-koppeling (bewust:
Gmail/Microsoft-OAuth eerder afgewezen)"*. De reden staat er niet bij. Sindsdien is er wel veel
veranderd:

- **Resend schaalt niet als verzenddomein voor iedereen.** Alle organisaties delen één Resend-account,
  en Resend Pro heeft 10 domeinen (`CHANGELOG_EIGEN_VERZENDDOMEIN_2026-11-06.md`). Een gekoppelde
  mailbox heeft geen Resend-domein nodig.
- **De helft van het gesprek ontbreekt.** Wat de ondernemer vanuit Outlook naar een klant stuurt, ziet
  ResoFly nooit. Wat ResoFly verstuurt, staat niet in diens eigen map Verzonden. Voor een CRM is dat
  het belangrijkste gemis.
- **Microsoft zet wachtwoorden voor mail uit.** IMAP en POP met een wachtwoord werken bij Exchange
  Online al sinds oktober 2022 niet meer. SMTP met een wachtwoord gaat vanaf december 2026 standaard
  uit, en de definitieve datum volgt in 2027 (Microsoft Message Center MC786329). Wie Outlook
  gebruikt, kan dus alleen nog via OAuth. Daarom moet Microsoft via Graph.
- **De bouwstenen zijn er nu.** Microsoft-OAuth (agenda, november), een Node-container op Cloudflare
  (Office-server) en een wachtrijpatroon (webhooks, push) bestonden in juli nog niet of niet zo.

De gebruikelijke bezwaren (wachtwoorden bewaren, de Google-audit, een proces dat altijd draait,
privacy) komen hieronder elk aan bod: §6, §11 en §15.

---

## 3 · Wat je straks ziet

**Instellingen → E-mail → Mailboxen** (bovenaan het tabblad, boven het doorstuuradres):

- *Mailbox koppelen* → twee knoppen: **Microsoft 365 / Outlook** en **Andere mailbox**.
- Bij Microsoft: inloggen bij Microsoft, toestemming geven, klaar. Moet een beheerder van jouw bedrijf
  eerst toestemming geven, dan zegt het scherm dat in gewone woorden. Je krijgt dan een link die je
  naar je IT-beheerder stuurt.
- Bij een andere mailbox: je e-mailadres en wachtwoord. ResoFly zoekt de server erbij. Lukt dat niet,
  dan vul je hem zelf in, met hulp per hoster. *Verbinding testen* laat per stap zien wat lukt:
  inloggen ✓, map Verzonden gevonden ✓, versturen ✓.
- Daarna drie keuzes, met een uitleg ernaast:
  - **Wat haal je binnen?** *Alleen mail van en naar klanten* (standaard) of *alle mail* (handig voor
    info@).
  - **Vanaf wanneer?** De afgelopen 30 dagen, 90 dagen (standaard) of een jaar.
  - **Wie mag vanaf dit adres versturen?** Alleen jij (een persoonlijke mailbox) of het team (een
    gedeelde mailbox).
- Per mailbox zie je de status in gewone woorden: *Bezig met inlezen: 1.240 van 3.900*, *Bijgewerkt
  om 10:42*, *Koppeling verlopen — verbind opnieuw*. Verder kun je hem pauzeren, ontkoppelen en een
  handtekening instellen.

**Berichten:**

- Mail uit de mailbox staat tussen de andere gesprekken. Heeft de organisatie meer dan één mailbox,
  dan staat er een klein label bij (`info@`) en kun je erop filteren.
- **Beantwoorden** vult *Van* met de mailbox waarop het gesprek binnenkwam. Bij **Nieuw bericht** staat
  je eigen mailbox voorgeselecteerd. In de lijst staan alleen mailboxen waarvan jij mag versturen, plus
  "ResoFly-afzender" (de huidige weg via Resend).
- Bijlagen staan onder het bericht en zijn te downloaden. Afbeeldingen in de mail blijven geblokkeerd
  tot je op *Afbeeldingen tonen* klikt, zoals nu.
- Wat je vanuit Outlook aan een klant stuurde, staat ook in het gesprek, met *Verstuurd vanuit je
  mailbox*.
- Lukt versturen niet, dan staat de reden bij het bericht met *Opnieuw proberen*. Bij een mailbox van
  een hoster zie je even *Wordt verstuurd…*.
- Werkt een koppeling niet meer, dan zie je dat bovenaan Berichten en op de beslislijst. Alleen wie de
  mailbox beheert, krijgt de knop *Opnieuw verbinden*.

**Klantdossier → Communicatie:** dezelfde mail, dezelfde knoppen.

---

## 4 · Hoe het in elkaar zit

```
 App: Berichten · klantdossier · Instellingen → E-mail
   │ koppelen, instellingen            │ versturen ("Van: jan@…")
   ▼                                   ▼
 edge: mailboxes                     edge: mail  (sendClientEmail, bestaand)
 OAuth Microsoft, IMAP-gegevens,       ├─ Resend ............................ zoals nu
 test, ontkoppelen                     ├─ Microsoft Graph ................... direct, synchroon
   │                                   └─ IMAP/SMTP → mailbox_outbox ──┐
   ▼                                                                    │ seintje
 Postgres: mailboxes · mailbox_secrets (versleuteld) · client_emails    │
           inbound_messages · client_email_attachments                  ▼
   ▲  register_mailbox_message (één ingang)      workers/mail-engine
   │                                             Worker + Container (Node 22)
 edge: mailbox-sync                              imapflow · nodemailer · postal-mime
 Microsoft: meldingen, delta, verlengen          leases, wachtrij, IDLE
   ▲                                               │ IMAP 993     │ SMTP 465/587
 Microsoft Graph                                   └── server van de hoster ──┘
```

**Onderdelen:**

| Onderdeel | Soort | Doet |
|---|---|---|
| `mailboxes` | edge function (nieuw) | Microsoft koppelen (start, terugkeer, afronden), IMAP-gegevens opslaan en laten testen, instellingen, pauzeren, ontkoppelen. Rechten uit de sessie. |
| `mailbox-sync` | edge function (nieuw, `verify_jwt = false`) | Microsoft: meldingen van Graph ontvangen, de nieuwe mail ophalen met delta, abonnementen verlengen, het eerste inlezen in porties. Elke minuut een cron (`?cron=tick`, `x-cron-secret`). |
| `mail` | edge function (bestaand) | `sendClientEmail` krijgt `mailboxId`. Microsoft verstuurt direct, IMAP gaat via de wachtrij, Resend blijft zoals het is. |
| `workers/mail-engine` | Cloudflare Worker + Container (nieuw) | Alles met IMAP en SMTP: verbindingen openhouden, nieuwe mail ophalen, versturen, kopie in Verzonden zetten, verbinding testen. |
| `register_mailbox_message` | SQL-functie (nieuw, alleen service-role) | De ene ingang: ontdubbelen, gesprek kiezen, klant koppelen, opslaan, opvangbak. |
| media-worker | bestaand | Bijlagen en het originele bericht op R2, onder `<orgId>/client_mail/…`. |

**Waarom deze verdeling.** Overwogen en afgevallen:

| Alternatief | Waarom niet |
|---|---|
| Alles in edge functions, ook IMAP | Een edge function leeft per aanroep, met een tijdslimiet: geen IDLE en geen verbinding die openblijft. Volgens de documentatie van Supabase mogen ze niet naar poort 25 en 587, en 587 is bij veel hosters de verzendpoort. |
| IMAP in een gewone Cloudflare Worker (`node:net`) | Een TCP-socket leeft maar zo lang als het verzoek, en imapflow is gebouwd voor Node. Om één verbinding per mailbox open te houden zou je een Durable Object per mailbox nodig hebben: duur en broos. |
| Ook Microsoft in de mail-engine | Kan, en geeft één plek voor alle synchronisatie. Maar dan hangt Microsoft, waarschijnlijk de grootste groep, aan de container. Graph is gewoon HTTPS, en de agenda doet het al vanuit edge functions. Microsoft kan zo eerst live, zonder nieuwe infrastructuur. |
| Een dienst als Nylas of Unipile | Snel, maar duur per mailbox, een extra verwerker met toegang tot alle klantmail, en het is niet wat je vroeg. |

Wat Microsoft en IMAP wél delen, staat op één plek:

- **`supabase/functions/_shared/mailbox/`**, zonder runtime-imports (zoals `lib/communication.ts`).
  Daarin: adressen normaliseren, de payload voor `register_mailbox_message` bouwen, de MIME-bouwer
  aanroepen, versleutelen (WebCrypto, werkt in Deno én Node 22) en de foutteksten. De mail-engine
  importeert dezelfde bestanden; de tests draaien in `deno test` én `node --test`.
- **`register_mailbox_message`** in SQL: alle beslissingen over gesprek en klant.

---

## 5 · Microsoft 365 via Graph

### 5.1 De app bij Microsoft

- Een **aparte app-registratie "ResoFly Mail"** in Entra, niet de agenda-app uitbreiden.
  - Het toestemmingsscherm noemt dan alleen mail.
  - Een bedrijf dat mail blokkeert, raakt zo zijn agenda niet kwijt.
  - Je kunt de geheimen los van elkaar vervangen.
- Instelling: *multitenant + persoonlijke Microsoft-accounts* (`common`), zoals de agenda.
- **Rechten, zo weinig mogelijk:** `openid email offline_access User.Read Mail.Read Mail.Send`.
  - `Mail.ReadWrite` pas als we de gelezen-status terugzetten (fase 4).
  - `Mail.Read.Shared` en `Mail.Send.Shared` pas voor gedeelde postvakken van Microsoft (fase 4).
- **Een geverifieerde uitgever** (*publisher verification*, met een ID uit het Microsoft AI Cloud
  Partner Program). Zonder die badge zien gebruikers een waarschuwing, en veel bedrijven staan
  toestemming voor onbekende uitgevers niet toe. Begin hier in fase 0: het kan weken duren.
- **Reken op toestemming van een beheerder.** Microsoft beperkt steeds meer welke mailrechten een
  gewone gebruiker zelf mag geven. Vangt de terugkeer `consent_required` of `admin_consent_required`,
  dan toont het scherm de link voor beheerderstoestemming
  (`/{tenant}/adminconsent?client_id=…`), met een tekst die je aan je IT-beheerder kunt sturen.

### 5.2 Koppelen

Hetzelfde patroon als de agenda (`calendarOAuth.ts`), algemener gemaakt in
`_shared/oauthState.ts`:

1. `mailboxes` → `oauthStart`. De state wordt getekend met HMAC en bevat provider, gebruiker,
   organisatie, het soort mailbox, `returnTo` en een nonce. Hij is 30 minuten geldig.
2. Microsoft stuurt terug naar `mailboxes` (GET). Die wisselt de code níet in, maar stuurt door naar de
   app met `mailbox_code` en `mailbox_state`.
3. De app roept `oauthComplete` aan, met de sessie van de gebruiker. De gebruiker moet dezelfde zijn als
   in de state. Pas dan wisselt de server de code in, haalt `/me` op (adres, tenant) en slaat de tokens
   versleuteld op.
4. De server maakt de mailbox aan met status `importing` en plant het eerste inlezen.

### 5.3 Lezen

- **Mappen:** Postvak IN en Verzonden items (`wellKnownName` `inbox` en `sentitems`), zodat ook mail
  die je in Outlook verstuurt in het dossier komt.
- **Delta per map** (`/me/mailFolders/{id}/messages/delta`). De `deltaLink` staat per map in
  `mailbox_folders`. Een verlopen delta (`410 Gone`) betekent: opnieuw inlezen vanaf de laatste datum,
  en de ontdubbeling vangt de rest op.
- **Altijd met `Prefer: IdType="ImmutableId"`.** Anders verandert het id van een bericht zodra iemand
  het naar een andere map sleept.
- **Eerst de envelop, dan de inhoud.** De delta vraagt alleen `from`, `toRecipients`, `ccRecipients`,
  `internetMessageId`, `conversationId`, `receivedDateTime` en `hasAttachments` op. Bij *alleen
  klantmail* vraagt de server de database eerst of een adres bij een klant hoort
  (`mailbox_match_preview`). Alleen dan haalt hij het hele bericht op (`/messages/{id}/$value`, de
  MIME) en gaat dat door `postal-mime`. Privémail wordt dus nooit gedownload.

  Graph geeft `In-Reply-To` niet mee in de delta. De voorcontrole mag daarom iets ruimer zijn dan de
  echte beslissing: is het `conversationId` al bekend bij een klantgesprek, dan haalt hij de MIME
  ook op. `register_mailbox_message` beslist daarna met de echte koppen (§7). Valt het dan alsnog
  af, dan wordt er niets bewaard.
- **Meldingen als wekker, niet als waarheid.** Per map is er een abonnement op `created`:
  - Maximaal 10.080 minuten geldig; de cron verlengt elke dag.
  - Met een `clientState` per abonnement; daarvan bewaren we alleen de hash.
  - Met een `lifecycleNotificationUrl`, voor `reauthorizationRequired`, `subscriptionRemoved` en
    `missed`.

  Komt er een melding, dan zet `mailbox-sync` een vlag op de mailbox, antwoordt binnen een paar
  seconden met `202` (Microsoft noemt 3 seconden) en draait daarna de delta. Een melding kan
  wegvallen, daarom draait de delta ook elke 10 minuten zonder melding.
- **Het eerste inlezen** gaat in porties van een paar honderd berichten per aanroep, met de voortgang
  in `mailboxes.import_progress`. Een edge function heeft een tijdslimiet, dus de cron pakt de volgende
  portie.

### 5.4 Versturen

- **Eén MIME-bouwer voor Microsoft en SMTP:** de `MailComposer` van nodemailer. In de edge function
  komt die via een `npm:`-import; dat test fase 0.
  - Wij zetten zelf `Message-ID`, `In-Reply-To`, `References` en `X-ResoFly-Id: <client_email_id>`.
  - Dat bericht gaat met `POST /me/sendMail` als MIME (base64, `Content-Type: text/plain`). Daarvoor
    is alleen `Mail.Send` nodig. De kopie in Verzonden items maakt Exchange zelf.
  - Fase 0 controleert of Exchange onze `Message-ID` laat staan. Zo niet, dan vindt de synchronisatie
    van Verzonden items de kopie terug via `X-ResoFly-Id` en vult de echte `Message-ID` in.
- **Synchroon in `mail`**, net als Resend nu: je ziet meteen *Verstuurd* of de fout.
- **Grenzen:**
  - Exchange Online staat 30 berichten per minuut en 10.000 ontvangers per dag per mailbox toe.
  - Graph knijpt af op 4 gelijktijdige verzoeken per mailbox. Bij `429` volgen we `Retry-After`.
  - Een MIME-bericht via Graph mag een paar MB zijn. Grote bestanden gaan als beveiligde link, zoals
    ResoFly nu al doet (`file_transfer_recipients`).
- **Fouten in gewone woorden:**
  - `invalid_grant` → *Koppeling verlopen, verbind opnieuw*, status `needs_reauth`.
  - `MailboxNotEnabledForRESTAPI` → *Deze mailbox staat niet in Microsoft 365 (bijvoorbeeld op een
    eigen Exchange-server). Koppel hem als andere mailbox.*
  - `ErrorSendAsDenied` → *Je mag niet vanaf dit adres versturen.*

---

## 6 · Andere mailboxen via IMAP en SMTP (imapflow, nodemailer)

### 6.1 Instellen zonder dat je iets hoeft te weten

`mailboxes` → `imapDiscover(email)` zoekt in deze volgorde en stopt bij de eerste treffer:

1. **MX-record.** Wijst het naar Microsoft (`*.mail.protection.outlook.com`), dan zegt het scherm:
   *Dit is een Microsoft-mailbox, koppel hem met de Microsoft-knop.* Wijst het naar Google, dan volgt
   de uitleg voor een app-wachtwoord.
2. **Vaste instellingen** voor de hosters die onze klanten echt gebruiken. Die lijst stellen we samen
   in fase 2 en houden we bij in `_shared/mailbox/presets.ts`, met de stappen per hoster zoals
   `FORWARDING_PROVIDERS` in `SimplePages.tsx`.
3. **Autoconfig**: `autoconfig.<domein>/mail/config-v1.1.xml` en de database van Thunderbird
   (`autoconfig.thunderbird.net/v1.1/<domein>`), ook voor het domein van het MX-record.
4. **SRV-records** (RFC 6186 en 8314): `_imaps._tcp`, `_submissions._tcp`, `_submission._tcp`.
5. Lukt niets, dan vul je zelf de server, poort en beveiliging in.

**Gmail en Google Workspace** gaan in fase 2 via IMAP met een **app-wachtwoord** (daarvoor moet
tweestapsverificatie aan staan). Google staat alleen nog dat of OAuth toe. OAuth voor Gmail vraagt een
jaarlijkse beveiligingsaudit (CASA), omdat mailrechten bij Google "restricted" zijn. Dat doen we pas
als er genoeg vraag is (fase 4). **iCloud** werkt hetzelfde, met een app-specifiek wachtwoord.

**Testen** gebeurt in de mail-engine, niet in de browser. Het scherm laat per stap zien wat lukt en
wat niet:

- inloggen op IMAP;
- de map Verzonden vinden (`\Sent` volgens RFC 6154, anders op naam: "Sent", "Verzonden",
  "Verzonden items", "INBOX.Sent");
- inloggen op SMTP;
- een testbericht naar jezelf (optioneel).

Pas na een geslaagde test wordt het wachtwoord opgeslagen.

### 6.2 Lezen

- **Leases.** Een mailbox wordt door precies één engine-proces bijgehouden.
  - `claim_mailboxes(worker, max)` pakt mailboxen met `FOR UPDATE SKIP LOCKED` en zet een lease van
    2 minuten. Elke 30 seconden verlengt de engine die.
  - Valt de container om, dan loopt de lease af en pakt de volgende start hem op.
  - Zo kunnen er later zonder wijziging meer instanties bij.
- **Eén verbinding per mailbox:**
  - Postvak IN met **IDLE**; imapflow doet dat vanzelf als de verbinding niets te doen heeft. Komt er
    een `exists`, dan haalt de engine de nieuwe UID's op.
  - Verzonden elke 5 minuten via `STATUS` en daarna een fetch.
  - Kent de server geen IDLE, dan elke 2 minuten `NOOP`.
- **Stand per map:** `uidvalidity` en de laatst verwerkte UID. Verandert `uidvalidity`, dan leest de
  engine opnieuw in vanaf de laatste datum, en de ontdubbeling op `Message-ID` voorkomt dubbelen.
- **Eerst de envelop, dan de inhoud.** Zelfde regel als bij Microsoft: bij *alleen klantmail* eerst de
  envelop ophalen, `mailbox_match_preview` vragen, en alleen bij een treffer de hele bron
  (`source`). Die gaat door `postal-mime` naar `register_mailbox_message`.
- **We veranderen niets in de mailbox.** Bij het lezen gebruiken we `BODY.PEEK`, dus de mail wordt bij
  de klant niet als gelezen gemarkeerd. ResoFly verplaatst en wist niets.

### 6.3 Versturen

1. `mail` legt de `client_emails`-rij vast als `queued`, met de `Message-ID` die wij kiezen, en zet een
   rij in `mailbox_outbox`. Daarna stuurt hij de engine een seintje.
2. De engine pakt de rij (`claim_mailbox_outbox`) en bouwt de MIME met `MailComposer`. Die bytes gaan
   via nodemailer naar SMTP: poort 465 met TLS, of 587 met STARTTLS.
3. Daarna zet de engine **dezelfde bytes** met IMAP `APPEND` in Verzonden, met de vlag `\Seen`. Veel
   hosters doen dat niet zelf. Gmail wel; dat herkent de test (§6.1), en dan slaan we deze stap over.
4. Status `sent`. Via realtime springt *Wordt verstuurd…* in het scherm op *Verstuurd*.

**Nooit dubbel versturen.** Een rij die al 5 minuten op `sending` staat, verstuurt de engine niet
zomaar opnieuw, want misschien ging hij al de deur uit vlak voor een crash. Hij zoekt eerst in
Verzonden naar de `Message-ID` (`SEARCH HEADER Message-ID`). Vindt hij hem, dan is de rij verstuurd.
Zo niet, dan probeert hij opnieuw. Na 5 pogingen wordt de rij `failed`, met de reden voor het scherm.

### 6.4 Netjes zijn tegen hosters

Alle verbindingen komen van dezelfde paar adressen van Cloudflare. Eén slordige klant kan zo de rest
laten blokkeren.

- **Bij een fout wachtwoord meteen stoppen.** Status `needs_reauth`, geen nieuwe pogingen. Hosters
  blokkeren met fail2ban het IP na een paar mislukte inlogpogingen, en dat IP delen al onze klanten.
- **Wachten met terugval** bij netwerk- en serverfouten (1, 2, 4 … tot 60 minuten), met
  `backoff_until` per mailbox.
- **Een maximum per server**, standaard 20 gelijktijdige verbindingen naar dezelfde IMAP-host. Veel
  hosters staan per account ook maar rond de 10 verbindingen toe; wij gebruiken er één.
- **Een herkenbare naam**: imapflow stuurt `ID` met `name: "ResoFly"`, zodat een beheerder ziet wie
  er verbindt.
- Vraagt een hoster om een vast IP, dan is dat een reden voor Fly.io met een vast uitgaand adres
  (§14).

---

## 7 · Eén weg naar binnen: van mail naar gesprek

Microsoft (edge) en IMAP (engine) maken van elk bericht dezelfde payload: mailbox, map
(`inbox`/`sent`), adressen, onderwerp, tekst, HTML, `Message-ID`, `In-Reply-To`, `References`, het id bij
de provider, eventueel `conversationId`, en van de bijlagen alleen naam, type en grootte. Daarna
beslist `register_mailbox_message(p_payload)` (security definer, alleen service-role). Pas als die
een `client_email_id` teruggeeft, gaan de bijlagen en het `.eml` naar R2. Zo komen er geen
bestanden van mail die uiteindelijk niet bewaard wordt.

De stappen van `register_mailbox_message`:

1. **Organisatie** = die van de mailbox. Nooit uit de mail zelf (harde regel 1).
2. **Ontdubbelen** op `(organization_id, rfc_message_id)`.
   - Kwam dezelfde mail al binnen via het doorstuuradres of via een tweede gekoppelde mailbox, dan
     krijgt de bestaande rij alleen het `mailbox_id` erbij.
   - Is het een kopie in Verzonden van iets dat ResoFly zelf verstuurde, dan wordt de rij uit de
     wachtrij aangevuld en komt er geen tweede.
3. **Intern overslaan.** Mail tussen twee adressen van de eigen organisatie (`is_own_org_address`)
   is geen klantmail.
4. **Eerst de klant, dan het gesprek.** Koppen als `References` kiest de afzender zelf. Ze mogen dus
   nooit bepalen bij welke klant een mail hoort, alleen welk gesprek binnen die klant. Dat is nu ook
   de regel (commentaar in `pick_client_email_thread`), en die blijft. Anders kan iedereen met een
   verzonnen `References` zijn mail in het dossier van een andere klant schuiven.
   - **De klant**, in deze volgorde:
     1. `resolve_inbound_client` op de tegenpartij: de afzender bij binnenkomend, de ontvangers bij
        Verzonden. Alleen een exact adres van een klant of contactpersoon koppelt.
     2. Geen treffer op adres, maar `In-Reply-To` wijst naar een bericht dat **wij** verstuurden (onze
        eigen, willekeurige `Message-ID`)? Dan is dat net zo sterk als het `reply+`-token van nu:
        alleen wie onze mail kreeg, kent die id. Dan geldt de klant van dat bericht. Zo komt ook het
        antwoord van een collega van de klant, vanaf een ander adres, goed terecht.
     3. Een domein is een voorstel, net als nu, en gaat naar de opvangbak.
   - **Het gesprek** binnen die klant, in deze volgorde:
     1. `In-Reply-To` en `References` tegen `client_emails.rfc_message_id`;
     2. `X-ResoFly-Id`, alleen bij mail uit de eigen map Verzonden;
     3. het `conversationId` van Microsoft (`provider_thread_id`);
     4. pas daarna de bestaande regel: het laatste gesprek van minder dan 30 dagen, of een nieuw.
5. **Opslaan.**
   - Gevonden: een rij in `client_emails` met `provider = 'mailbox'`. Binnenkomend krijgt `inbound` /
     `received`; Verzonden krijgt `outbound` / `sent`.
   - Niet gevonden, bij *alle mail*: een rij in `inbound_messages` met `route = 'mailbox'`. Het
     tabblad Niet gekoppeld werkt dan ongewijzigd: koppelen, negeren, "onthoud dit adres".
   - Niet gevonden, bij *alleen klantmail*: niets. Alleen een teller in de mailbox, voor *x berichten
     overgeslagen*.

**Het eerste inlezen mag geen lawine geven.** Op `client_emails` hangen triggers voor push
(`push_on_client_email_insert`), Gerrie-signalen (`ai_signal_client_email_inbound`), agents
(`agent_event_client_email`) en campagnes. Inlezen van 90 dagen zou honderden meldingen en
agentruns geven. Daarom:

- Een kolom `imported` (true bij het eerste inlezen). Alle vier de triggers slaan zulke rijen over.
- Ingelezen mail telt als gelezen: `client_email_unread` sluit `imported` uit. Anders begint iedereen
  met 600 ongelezen berichten.

**Bijlagen.**

- Bestanden tot 25 MB gaan naar R2 via `/internal/media`, onder
  `<orgId>/client_mail/<client_email_id>/<uuid>-<naam>`, met een rij in `client_email_attachments`.
- Grotere bestanden krijgen alleen een naam en de tekst *Open dit bericht in je mailbox*.
- Mislukt het uploaden, dan blijft de mail staan. De bijlage krijgt dan `storage_key = null` met
  *Bijlage nog niet opgehaald*, en de volgende ronde probeert het opnieuw.
- Inline afbeeldingen (`cid:`) worden ook opgeslagen, maar alleen getoond na *Afbeeldingen tonen*.
- De media-worker geeft ze alleen aan wie module Klanten mag lezen. Het voorvoegsel `client_mail/`
  komt in zijn lijst van modules per pad.

**Het originele bericht** (`.eml`) gaat ook naar R2, als een gekoppelde mail kleiner is dan 25 MB.
Dan kun je later opnieuw inlezen als de parser beter wordt, staat het bewijs van wat er precies
binnenkwam vast, en kan de export het originele bericht meenemen. Zie beslissing 4.

---

## 8 · Eén weg naar buiten: versturen

`sendClientEmail` in `supabase/functions/mail/index.ts` krijgt `mailboxId` (optioneel; leeg =
Resend, zoals nu). Wat er gebeurt:

1. **Rechten**, zoals nu: rol owner, admin of member, `assertClientModuleWrite`. Daar komt bij: de
   gebruiker staat in `mailbox_members` met `can_send`, en de mailbox heeft status `active`.
2. **Het gesprek.** Antwoord je in een bestaand gesprek (`threadId`), dan neemt de server
   `In-Reply-To` en `References` over van het laatste bericht van de klant, en `Re: ` één keer.
3. **De `Message-ID`** kiezen wij altijd zelf (`<uuid@domein-van-de-mailbox>`) en die wordt bewaard.
   Dat geldt vanaf nu ook voor Resend, via `headers` in de API, zodat een antwoord op een
   Resend-mail later ook via de koppen zijn gesprek vindt. Laat Resend een eigen `Message-ID` niet
   toe (fase 0 controleert dat), dan bewaren we de id die Resend zelf kiest.
4. **Limiet.** `email_quota_take` geldt ook voor de mailbox. Daarbovenop komen de grenzen van de
   provider (§5.4) als eigen teller per mailbox.
5. **Versturen.** Microsoft gaat direct (§5.4). IMAP/SMTP gaat via de wachtrij (§6.3). Bij een
   mailbox valt de `reply+`-Reply-To weg: antwoorden komen in de mailbox, en de synchronisatie haalt
   ze op.
6. **De opmaak.** Een mail vanuit je eigen mailbox ziet eruit als een gewone mail: jouw tekst en je
   handtekening, zonder de huisstijl-omlijsting van `buildClientEmailHtml`. Die blijft voor Resend.
   HTML gaat zoals nu door `sanitizeEmailBodyHtml`.

**Resend blijft voor systeemmail.** Facturen, offertes, herinneringen, aanmaningen, contracten,
portaalmail en marketing gaan door Resend, met hun eigen sjablonen en bezorgstatus. Bulk via een
mailbox is gevraagd om in een spamfilter te belanden, en raakt de grenzen van Microsoft. Facturen
vanuit de eigen mailbox kan later een keuze worden (fase 4).

---

## 9 · Datamodel (schets)

Migratie `<versie>_mailboxen.sql`, met een versie na `20261111190000`, veilig opnieuw te draaien.

```sql
-- De mailbox zelf: wat het scherm mag zien. Geen geheimen.
create table if not exists public.mailboxes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('microsoft', 'imap')),
  email text not null,                                   -- lowercase
  display_name text,
  kind text not null check (kind in ('personal', 'shared')),
  owner_user_id uuid references auth.users(id) on delete set null,  -- wie hem koppelde
  import_mode text not null default 'clients_only' check (import_mode in ('clients_only', 'all')),
  import_since date not null,
  status text not null default 'connecting' check (status in
    ('connecting', 'importing', 'active', 'needs_reauth', 'error', 'paused', 'disconnected')),
  status_detail text,                                    -- in gewone woorden, voor het scherm
  import_progress jsonb,                                 -- {"done": 1240, "total": 3900}
  skipped_count integer not null default 0,              -- "alleen klantmail": overgeslagen
  signature_html text,
  server_info jsonb,                                     -- imap: host/poort/tls (geen wachtwoord)
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, email)
);

-- Tokens en wachtwoorden, versleuteld. RLS aan, geen policies: alleen de server.
create table if not exists public.mailbox_secrets (
  mailbox_id uuid primary key references public.mailboxes(id) on delete cascade,
  organization_id uuid not null,
  secret_encrypted text not null,                        -- "v1.<sleutel-id>.<iv>.<cipher>"
  expires_at timestamptz,                                -- Microsoft: access token
  updated_at timestamptz not null default now()
);

-- Wie mag versturen vanaf een mailbox.
create table if not exists public.mailbox_members (
  mailbox_id uuid not null references public.mailboxes(id) on delete cascade,
  organization_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  can_send boolean not null default true,
  primary key (mailbox_id, user_id)
);

-- De stand per map, en de lease. Intern.
create table if not exists public.mailbox_folders (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid not null references public.mailboxes(id) on delete cascade,
  organization_id uuid not null,
  role text not null check (role in ('inbox', 'sent')),
  remote_name text not null,                             -- "INBOX", "Verzonden items", Graph-id
  uidvalidity bigint, last_uid bigint,                   -- imap
  delta_link text,                                       -- microsoft
  subscription_id text, subscription_expires_at timestamptz, client_state_hash text,
  last_synced_at timestamptz,
  unique (mailbox_id, role)
);
create table if not exists public.mailbox_sync (
  mailbox_id uuid primary key references public.mailboxes(id) on delete cascade,
  organization_id uuid not null,
  lease_owner text, lease_until timestamptz,
  wake_requested_at timestamptz,                         -- melding van Graph / seintje
  failures integer not null default 0, backoff_until timestamptz
);

-- De verzendwachtrij voor IMAP/SMTP. Intern.
create table if not exists public.mailbox_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  mailbox_id uuid not null references public.mailboxes(id) on delete cascade,
  client_email_id uuid not null unique references public.client_emails(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

-- Klantmail: wat er bij moet.
alter table public.client_emails
  add column if not exists mailbox_id uuid references public.mailboxes(id) on delete set null,
  add column if not exists to_emails text[],
  add column if not exists cc_emails text[],
  add column if not exists in_reply_to text,
  add column if not exists reference_ids text[],
  add column if not exists provider_thread_id text,      -- conversationId van Microsoft
  add column if not exists raw_storage_key text,         -- het .eml op R2
  add column if not exists imported boolean not null default false;
-- provider: 'mailbox' erbij in de check. Uniek: (organization_id, rfc_message_id) ook voor
-- uitgaand, zodat de kopie in Verzonden en de rij uit de wachtrij één rij blijven.

create table if not exists public.client_email_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_email_id uuid not null references public.client_emails(id) on delete cascade,
  file_name text not null, mime_type text, size_bytes bigint,
  storage_key text,                                      -- null = te groot, niet opgeslagen
  sha256 text, content_id text, is_inline boolean not null default false,
  created_at timestamptz not null default now()
);
```

**Daarbij:**

- **RLS.**
  - `mailboxes` en `mailbox_members`: lezen met `can_read_module(org, 'clients')`. Schrijven alleen
    via `mailboxes` (service-role) of security-definer-RPC's.
  - `client_email_attachments`: `apply_module_gate(…, 'clients')`, net als `client_emails`.
  - `mailbox_secrets`, `mailbox_sync`, `mailbox_folders` en `mailbox_outbox`: RLS aan, geen policies.
  - Een trigger controleert dat `mailbox_id` en `client_email_id` bij dezelfde organisatie horen
    (zoals `20260926000000_security_hardening.sql`).
- **Functies:** `register_mailbox_message`, `mailbox_match_preview`, `claim_mailboxes`,
  `renew_mailbox_lease`, `claim_mailbox_outbox` (naar `claim_webhook_deliveries`), en
  `mark_mailbox_needs_reauth`. Allemaal `revoke … from public, anon, authenticated`.
- **De triggers op `client_emails`** slaan `imported` over (§7). `client_email_unread` sluit
  `imported` uit.
- **Realtime:** `mailboxes` erbij voor de status. `useClientEmailUnread` luistert nu alleen naar
  `INSERT` op `client_emails`; voor *Wordt verstuurd → Verstuurd* komt `UPDATE` erbij, op een eigen
  kanaal (zie de les in `CHANGELOG_BERICHTEN_2026-09-17.md` §6).
- **Logboek:** `audit_row_change('mailbox', 'email')` op `mailboxes`. Nieuwe acties
  `mailbox_connected`, `mailbox_reconnected` en `mailbox_disconnected` in `audit_logs_action_check`.
  In de metadata staan nooit geheimen of serverwachtwoorden.
- **Vertrek van een teamlid** (`disable_integrations_on_member_exit`):
  - Zijn persoonlijke mailboxen gaan naar `disconnected` en de geheimen worden gewist.
  - Een gedeelde mailbox die hij koppelde, blijft staan. Bij Microsoft hangen de tokens wel aan zijn
    account; zodra dat account uitgaat, wordt de status `needs_reauth` en krijgen de beheerders een
    melding.
- **Exportmanifest** (`src/lib/exportManifest.ts`):
  - `mailboxes`, `mailbox_members` en `client_email_attachments` gaan mee, met bestanden.
  - `mailbox_secrets` valt onder `geheim`.
  - `mailbox_folders`, `mailbox_sync` en `mailbox_outbox` vallen onder `intern`.
- **dataGroups:** geen wijziging. `client_emails` wordt nu al per gesprek geladen, niet bij het
  opstarten. Leest nieuwe code toch een veld uit een groep, dan gelden harde regel 5 en
  `dataGroups.test.ts`.

---

## 10 · De harde regels, één voor één

| Regel | Hoe dit plan eraan voldoet |
|---|---|
| 1 · Elke organisatie een eigen wereld | De organisatie komt uit de mailbox, en de mailbox uit de sessie (`mailboxes`) of uit de lease (engine). De engine gebruikt de service-role, zoals `caldav` en `media-api`. Hij schrijft daarom alleen via RPC's die zelf op `organization_id` filteren, en nooit rechtstreeks in tabellen. Een test geeft `register_mailbox_message` een mailbox van organisatie A en een gesprek van B, en verwacht een weigering. |
| 2 · De AI voert niets zelf uit | Gerrie, agents en MCP krijgen `mailbox_id` en `thread_id` in `propose_send_client_email`, en het blijft een voorstel. Na goedkeuring loopt het via `onSendClientEmail` → `mail`, met de rechten van wie goedkeurt: die moet zelf `can_send` hebben op die mailbox (`agentAccess.ts`). Mailtekst gaat als gegevens naar Gerrie, tussen de bekende markeringen, nooit als opdracht. Er komt geen handeling om mailboxen te koppelen of te ontkoppelen. `actionTenancy.test.ts` krijgt de nieuwe parameters. |
| 3 · Modulerechten overal | Mailboxmail valt onder module Klanten, net als Berichten. Wie Klanten niet mag lezen, ziet geen mailboxen, geen mail en geen bijlagen (RLS én de media-worker). Versturen vraagt schrijfrecht op Klanten én `can_send`. |
| 4 · Alleen via migraties | Eén migratie, veilig opnieuw te draaien, na `20261111190000`. Daarna `supabase db start` en de keten vanaf nul. |
| 5 · Laden per module | Geen nieuwe groep nodig (zie §9). |
| 6 · Geld en bewaarplicht | Niet geraakt. Facturen blijven via Resend gaan, met hun vaste kopie. |

---

## 11 · Veiligheid en privacy

**Geheimen.**

- Eén module `_shared/mailbox/secretBox.ts` (AES-GCM, WebCrypto) met een sleutel-id in het formaat,
  zodat we sleutels kunnen vervangen zonder alles opnieuw te koppelen.
- **Twee sleutels:**
  - `MAILBOX_MS_TOKEN_KEY` voor Microsoft-tokens. Alleen de edge functions hebben die.
  - `MAILBOX_IMAP_SECRET_KEY` voor IMAP-wachtwoorden. Die hebben `mailboxes` en de engine.

  Een lek in de engine geeft dus geen Microsoft-tokens prijs.
- Geheimen gaan nooit naar de browser. Het scherm ziet alleen *verbonden als jan@…* en de server.
- Bij ontkoppelen worden ze meteen gewist. Bij Microsoft verwijderen we ook de abonnementen. Een
  token intrekken kan alleen de gebruiker zelf (myapps.microsoft.com); het scherm zegt dat.

**De server die de klant invult (SSRF).** Een IMAP- of SMTP-host is invoer van een gebruiker.

- De engine zoekt de naam één keer op, weigert IP's die privé, lokaal of link-local zijn, en
  verbindt met precies dat gecontroleerde adres. De naam gaat mee voor het certificaat (SNI;
  `servername` in imapflow en nodemailer). Zo glipt DNS-rebinding er niet langs. Beide stukken staan
  er al voor webhooks: de IP-controle in `_shared/webhooks.ts` (`isPrivateIpv4`, `isPrivateIpv6`)
  en het vastpinnen in `_shared/webhookTransport.ts`. Ze komen in de gedeelde map, zodat de engine
  ze ook gebruikt.
- Alleen de poorten 993, 143 (met STARTTLS), 465 en 587.
- TLS is verplicht, met een geldig certificaat. Er komt geen knop "certificaat negeren".

**De engine zelf.**

- Er komt geen enkele poort van buitenaf binnen.
- De Worker ervoor accepteert alleen verzoeken met `MAIL_ENGINE_SECRET`, van `mailboxes` (testen) en
  `mail` (seintje).
- Hij logt nooit inhoud of wachtwoorden, alleen mailbox-id's en foutcodes.

**Mail van klanten is onbetrouwbare invoer.**

- HTML gaat door `sanitizeInboundEmailHtml`, en afbeeldingen blijven dicht. Zo zie je geen
  trackingpixels zonder dat je erop klikt.
- Bijlagen serveert de media-worker als download, met `nosniff` en `CSP: sandbox`.
- Gerrie behandelt mailtekst als gegevens (harde regel 2).

**Misbruik.** Een overgenomen account kan via ResoFly geen spam versturen. Daarvoor zorgen
`email_quota_take`, de tellers per mailbox en het logboek. Een plotselinge piek zet de mailbox op
pauze en meldt dat de beheerders.

**Privacy (AVG).**

- **Minimale gegevens.** Standaard *alleen klantmail*, en de envelop wordt gecontroleerd vóór de
  inhoud (§5.3, §6.2). ResoFly krijgt alleen wat in het klantdossier hoort.
- **Eenrichtingsverkeer.** ResoFly bewaart een kopie; de mailbox blijft de baas over zichzelf.
  - Iets verwijderen in ResoFly verwijdert niets in de mailbox.
  - Iets verwijderen in de mailbox laat de kopie in ResoFly staan. Dat staat zo in het scherm.
- **Ontkoppelen** vraagt: *ingelezen mail bewaren* (standaard: hij hoort bij het klantdossier) of
  *ook alles van deze mailbox uit ResoFly verwijderen*.
- **Verwerkersovereenkomst.** ResoFly verwerkt nu mailboxinhoud. Dat moet erin, net als de
  subverwerker waar de engine draait en de regio daarvan. Laat dat toetsen door een jurist.
- **Gegevens meenemen, fase 2** (`GEGEVENS_MEENEMEN_BOUWPLAN_2026-11-11.md`): bij wissen ook alle
  mailboxen ontkoppelen en de bijlagen onder `client_mail/` wissen.

---

## 12 · Wat er misgaat als je het simpel doet

| Valkuil | Wat er dan gebeurt | In dit plan |
|---|---|---|
| Alles uit de mailbox binnenhalen | Privémail van de ondernemer bij het hele team, veel opslag, AVG-probleem | *Alleen klantmail* als standaard; de envelop eerst |
| Inlezen van 90 dagen als nieuwe mail behandelen | Honderden pushmeldingen, agentruns en een badge van 600 | Kolom `imported`; de triggers en de ongelezen-view slaan die over |
| Antwoorden koppelen op onderwerp | Gesprekken lopen door elkaar ("Re: offerte") | Eerst de koppen (`In-Reply-To`, `References`), dan `conversationId`, dan pas de oude regels |
| De klant bepalen uit `References` | Een vreemde zet met een verzonnen kop zijn mail in het dossier van een andere klant | De klant komt uit het adres of uit onze eigen `Message-ID`; koppen kiezen alleen het gesprek binnen die klant |
| Geen eigen `Message-ID` | Een antwoord vindt zijn gesprek niet; de kopie in Verzonden wordt een tweede bericht | Wij kiezen en bewaren de `Message-ID`; uniek per organisatie |
| Doorstuurregel én koppeling | Elke mail twee keer | Ontdubbelen op `Message-ID` over alle ingangen; tip in het scherm om het doorsturen uit te zetten |
| Opnieuw proberen na een crash tijdens versturen | De klant krijgt de mail twee keer | Eerst in Verzonden zoeken naar de `Message-ID` |
| Doorgaan na een fout wachtwoord | De hoster blokkeert het IP van ResoFly, voor alle klanten | Direct `needs_reauth`; terugval; een maximum per server |
| Alleen op meldingen van Microsoft vertrouwen | Gemiste mail, abonnementen die na een week verlopen | Delta elke 10 minuten; elke dag verlengen; lifecycle-meldingen |
| Graph-id's zonder `ImmutableId` | Een verplaatste mail lijkt nieuw of verdwijnt | Altijd `Prefer: IdType="ImmutableId"` |
| IMAP-mail als gelezen markeren | De ondernemer mist mail in zijn eigen Outlook | `BODY.PEEK`, we veranderen niets in de mailbox |
| Versturen via SMTP zonder kopie in Verzonden | Je eigen mailbox mist wat je via ResoFly stuurde | `APPEND` van dezelfde bytes |
| Een mailbox van Microsoft via IMAP koppelen | Werkt niet (geen wachtwoorden meer) of stopt in december | MX herkennen en naar de Microsoft-knop sturen |
| Gedeelde mailbox via de tokens van één medewerker | Die vertrekt en de koppeling breekt stil | Status `needs_reauth` met melding; app-only-rechten in fase 4 |

---

## 13 · Fasen

Alles staat achter een schakelaar per organisatie (`organizations.mailboxes_enabled`, alleen door
ResoFly zelf aan te zetten). Zo proberen eerst een paar organisaties het, op staging en daarna echt.

### Fase 0 · Proeven en voorbereiden (± 1 week)

Doel: de onzekerheden weg, vóór er een tabel bestaat.

- **Entra:** app "ResoFly Mail" registreren en de uitgeversverificatie starten. Met een testtenant:
  hoe ziet toestemming eruit met de standaardinstellingen van Microsoft, en met *alleen
  geverifieerde uitgevers*?
- **Graph:** `sendMail` met MIME. Blijft onze `Message-ID` staan? Komt de kopie in Verzonden items?
  Kloppen `In-Reply-To` en `References` bij de ontvanger in Outlook en Gmail?
- **Deno:** `postal-mime` en `MailComposer` (via `npm:`) in een edge function.
- **Resend:** neemt de API een eigen `Message-ID` in `headers` over?
- **Container:** Node 22 met imapflow en nodemailer in een Cloudflare Container.
  - Lukt uitgaand 993, 465 en 587 naar drie Nederlandse hosters, Gmail en iCloud?
  - Hoe lang blijft hij leven, en komt hij na een herstart vanzelf terug (cron, Durable Object)?
  - In welke regio draait hij?
- **Besluit:** Cloudflare Containers of Fly.io (regio Amsterdam, vast uitgaand IP).
- **Resultaat:** `docs/rapporten/MAILBOX_PROEF_<datum>.md`, en de beslissingen van §15 genomen.

### Fase 1 · Microsoft 365: koppelen, lezen, versturen (± 3 weken)

- De migratie van §9 (alles, ook wat IMAP straks nodig heeft), `secretBox`, `oauthState` algemener.
- Edge function `mailboxes` (Microsoft) en `mailbox-sync` (delta, meldingen, verlengen, eerste
  inlezen), plus cron `mailbox-sync-tick`, elke minuut.
- `register_mailbox_message`, `mailbox_match_preview`, bijlagen en `.eml` naar R2, de media-worker
  met `client_mail/`.
- `mail`: `mailboxId`, onze eigen `Message-ID` (ook voor Resend), de koppen bij antwoorden, en de
  route via Microsoft.
- Meteen meegenomen: de `reply+`-route gebruikt het gesprek van het oorspronkelijke bericht, en
  `in_reply_to` telt mee bij het kiezen van het gesprek.
- **Scherm:**
  - Instellingen → E-mail → Mailboxen.
  - In Berichten en het klantdossier: *Van*, het mailboxlabel, bijlagen, *Verstuurd vanuit je
    mailbox* en de melding bij een kapotte koppeling.
- **Verder:** de triggers met `imported`, het logboek, vertrek van een teamlid, het exportmanifest en
  een setup-handleiding (`docs/setup/MAILBOX_KOPPELEN_SETUP.md`).

### Fase 2 · Andere mailboxen: IMAP en SMTP (± 3 weken)

- `workers/mail-engine`:
  - De Worker: cron die de container wakker houdt, `/poke`, `/test`.
  - De container: Node 22 met imapflow, nodemailer en postal-mime.
  - Leases, IDLE, de wachtrij, `APPEND` en de controle in Verzonden.
- Instellen: zoeken (MX, presets, autoconfig, SRV), testen per stap, presets met stappen per hoster,
  en de uitleg voor Gmail en iCloud.
- Netjes tegen hosters (§6.4) en SSRF (§11).
- In het scherm: *Wordt verstuurd…*, *Opnieuw proberen* en de realtime-update.
- Deployen gaat met de hand, zoals de andere workers (`npm run deploy:staging`). Dat komt in de
  setup-handleiding.

### Fase 3 · Werken vanuit Berichten (± 2 weken)

- **Gedeelde mailboxen:** wie mag versturen (`mailbox_members`), en een handtekening per mailbox.
- **Versturen ongedaan maken:** 10 seconden. De wachtrij heeft er al een `next_attempt_at` voor; voor
  Microsoft gaat het in dat geval ook via de wachtrij.
- **Filter op mailbox** in Berichten.
- **Gerrie:** antwoord in hetzelfde gesprek en vanaf de juiste mailbox (`thread_id`, `mailbox_id`), en
  een leeshandeling `mailbox.list` (status, geen geheimen).
- **Oude mail van deze klant ophalen**, in het klantdossier: zoeken in de mailbox op het adres van de
  klant (IMAP `SEARCH FROM/TO`, Graph `$search`), via dezelfde ingang.
- **Beslislijst:** een kaart *Mailbox moet opnieuw verbonden worden*.
- **Inrichten:** een optionele stap *Koppel je mailbox* (`test:inrichten`).
- **Telefoon:** *Van* als compacte keuze, en bijlagen in een strook.

### Fase 4 · Later, als er vraag naar is

- **Gelezen-status heen en weer**: `Mail.ReadWrite` en `\Seen`.
- **Gedeelde postvakken van Microsoft** (`Mail.Read.Shared`), en app-only-rechten met beperking per
  postvak (RBAC for Applications) voor bedrijven die geen persoonlijke tokens willen.
- **Gmail via OAuth**, na de CASA-audit.
- **Inkoopfacturen uit de mailbox**: een regel per map of adres naar de factuurinbox.
- **Facturen en offertes vanuit de eigen mailbox**, als keuze per organisatie.
- **Meer engine-instanties**: de leases maken dat al mogelijk.
- Het doorstuuradres alleen nog tonen aan wie niet gekoppeld heeft.

De weken zijn een schatting voor één ontwikkelaar met AI, inclusief tests en documentatie.

---

## 14 · Kosten en capaciteit

**Container.** Eén instance `basic` (¼ vCPU, 1 GiB) die altijd aan staat.

- Cloudflare rekent sinds november 2025 alleen de CPU die echt gebruikt wordt; geheugen en schijf
  gaan op wat je toewijst. Een proces dat vooral wacht op IDLE kost dus vooral geheugen. Reken op een
  paar tientjes per maand, of minder; controleer de actuele prijstabel.
- Eén IMAP-verbinding kost enkele honderden KB. Eén instance kan dus naar schatting honderden tot
  ongeveer duizend mailboxen aan. Daarboven komen er instances bij (leases).

**Supabase.**

- Een melding van Microsoft kost één aanroep van een edge function, plus de cron elke minuut. Bij
  honderden mailboxen blijft dat ruim binnen het tegoed van Pro.
- De database groeit met de mail zelf (tekst en HTML, zoals nu, tot 128 KB per bericht). Bijlagen
  staan niet in de database.

**R2.** De bijlagen en de `.eml`'s, de grootste post. Een quotum per organisatie of per abonnement
is beslissing 11.

**Microsoft en hosters.** Kosten niets. Voor de uitgeversverificatie is lidmaatschap van het
Microsoft AI Cloud Partner Program nodig, en dat is gratis.

**Fly.io als terugval.** Een kleine machine in Amsterdam met een vast uitgaand IP. Vergelijkbare
kosten, maar een nieuwe subverwerker.

---

## 15 · Beslissingen

| # | Vraag | Voorstel | Wie |
|---|---|---|---|
| 1 | Wat halen we binnen? | Per mailbox kiezen; standaard *alleen klantmail*, *alle mail* voor gedeelde adressen | Gerjan |
| 2 | Hoe ver terug bij koppelen? | 90 dagen standaard; keuze 30 / 90 / 365 | Gerjan |
| 3 | Bijlagen opslaan? | Ja, tot 25 MB per bestand; groter alleen de naam | Gerjan |
| 4 | Het originele `.eml` bewaren? | Ja, voor gekoppelde mail (opnieuw inlezen, bewijs, export) | Gerjan |
| 5 | Een privé-mailbox waarvan alleen de eigenaar de mail ziet? | Niet in fase 1–3. *Alleen klantmail* plus "nooit importeren van/naar" (adres of domein) dekt het meeste | Gerjan |
| 6 | Gelezen-status synchroniseren met de mailbox? | Nee tot fase 4; ResoFly houdt zijn eigen stand per teamlid | Voorstel |
| 7 | Waar draait de mail-engine? | Cloudflare Containers; Fly.io als fase 0 problemen geeft (poorten, regio, vast IP) | Na fase 0 |
| 8 | Facturen en offertes via de eigen mailbox? | Nee, Resend blijft; later een keuze | Gerjan |
| 9 | Gmail? | App-wachtwoord via IMAP; OAuth pas bij genoeg vraag (CASA-audit) | Gerjan |
| 10 | Wie mag koppelen? | Een persoonlijke mailbox: elk teamlid met schrijfrecht op Klanten. Een gedeelde: eigenaar en beheerders | Voorstel |
| 11 | Hoeveel mailboxen per abonnement, en een opslagquotum? | Open | Gerjan |
| 12 | Het doorstuuradres? | Blijft; tip om het uit te zetten na koppelen | Voorstel |

---

## 16 · Testen

- **`npm test`** (app en `_shared`, ook onder Node):
  - adressen normaliseren, presets en autoconfig lezen;
  - de SSRF-controle (privé-IP's, DNS die naar binnen wijst);
  - de MIME-bouwer (koppen, `Re: `, `X-ResoFly-Id`);
  - `secretBox` (sleutel-id, verkeerde sleutel);
  - de foutteksten;
  - het gesprek kiezen in `lib/communication.ts` met mailboxmail.
- **Edge functions:** de `deno check`-lijst in `.github/workflows/frontend-checks.yml` krijgt
  `mailboxes` en `mailbox-sync`. Tests voor de state van OAuth, de validatie van meldingen
  (`validationToken`, een verkeerde `clientState`) en de delta met een nep-Graph.
- **Mail-engine:** tests tegen een echte IMAP/SMTP-server in Docker (bijvoorbeeld GreenMail):
  - eerste inlezen en IDLE;
  - een veranderde `uidvalidity`;
  - versturen, `APPEND` en de controle in Verzonden na een gesimuleerde crash;
  - stoppen bij een fout wachtwoord.
- **Database** (`supabase db start`, de keten vanaf nul):
  - `register_mailbox_message` met dubbele mail (doorsturen en mailbox);
  - de kopie in Verzonden van een rij uit de wachtrij;
  - een mailbox en een gesprek van verschillende organisaties (moet weigeren);
  - een onbekende afzender met een verzonnen `References` naar het gesprek van een klant (moet naar
    de opvangbak, niet in dat gesprek);
  - een antwoord vanaf een onbekend adres met `In-Reply-To` op onze eigen `Message-ID` (moet in het
    gesprek);
  - `imported` zonder triggers;
  - RLS zonder module Klanten.
- **`actionTenancy.test.ts`** voor de nieuwe parameters van Gerrie.
- **`npm run test:mobile -- --theme=both`:** Instellingen → E-mail met mailboxen, Berichten met *Van*,
  bijlagen en de melding. Seed in `tests/mobile/mock/seed.mjs`.
- **`tests/stromen/`:** een stroom *mailbox koppelen → mail binnen → antwoorden → kopie in Verzonden*
  met de nep-Graph.
- **`npm run test:inrichten`** zodra de stap bij Inrichten komt (fase 3).

## 17 · Inrichten (voor de setup-handleiding)

- **Entra:** app "ResoFly Mail".
  - Redirect: `…/functions/v1/mailboxes`.
  - Rechten: §5.1.
  - Uitgeversverificatie.
- **Secrets voor de edge functions:**
  - `MICROSOFT_MAIL_CLIENT_ID`, `MICROSOFT_MAIL_CLIENT_SECRET`, `MICROSOFT_MAIL_TENANT_ID`
    (`common`);
  - `MAILBOX_OAUTH_STATE_SECRET`, `MAILBOX_REDIRECT_URL`, `MAILBOX_ALLOWED_RETURN_ORIGINS`;
  - `MAILBOX_MS_TOKEN_KEY`, `MAILBOX_IMAP_SECRET_KEY`, `MAILBOX_SYNC_CRON_SECRET`;
  - `MAIL_ENGINE_URL`, `MAIL_ENGINE_SECRET`.
- **Cron:** `mailbox-sync-tick` elke minuut → `mailbox-sync?cron=tick` met `x-cron-secret`, in
  `scripts/supabase-setup-webhooks.sh`.
- **`supabase/config.toml`:** `[functions.mailboxes]` en `[functions.mailbox-sync]` met
  `verify_jwt = false`; beide controleren zelf.
- **Mail-engine:**
  - Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MAILBOX_IMAP_SECRET_KEY`,
    `MAIL_ENGINE_SECRET`, `MEDIA_WORKER_URL`, `INTERNAL_UPLOAD_SECRET`.
  - Een aparte deploy voor staging en productie.

---

## Bronnen

- Microsoft, SMTP AUTH met wachtwoord standaard uit vanaf december 2026: Message Center
  [MC786329](https://mc.merill.net/message/MC786329).
- Microsoft Graph, abonnementen (Outlook-berichten maximaal 10.080 minuten, lifecycle-meldingen):
  [subscription resource type](https://learn.microsoft.com/graph/api/resources/subscription),
  [Outlook change notifications](https://learn.microsoft.com/graph/outlook-change-notifications-overview).
- Cloudflare Containers (instance-types, alleen gebruikte CPU, `sleepAfter`, uitgaand internet):
  [pricing](https://developers.cloudflare.com/containers/pricing/),
  [container class](https://developers.cloudflare.com/containers/reference/container-class/),
  [FAQ](https://developers.cloudflare.com/containers/faq/).
- Cloudflare Workers en TCP (poort 25 dicht, sockets per verzoek):
  [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/).
- Mailrechten bij Microsoft en toestemming van een beheerder: indicatief, uit Microsoft Q&A en
  [Nylas over uitgeversverificatie](https://support.nylas.com/hc/en-us/articles/28841177145117-Understanding-This-App-May-Be-Risky-Warnings-Post-Publisher-Verification).
  Fase 0 test dit in een echte tenant.
- De limieten van Supabase Edge Functions (poorten 25 en 587, tijdslimiet) staan in de documentatie
  van Supabase onder *Functions → Limits*. Controleer ze bij de bouw.
