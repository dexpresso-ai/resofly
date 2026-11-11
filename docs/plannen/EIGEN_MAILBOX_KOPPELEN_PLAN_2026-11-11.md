# Plan: je eigen mailbox als afzender en postvak van ResoFly (2026-11-11)

> **Stand op 11 november 2026: plan, nog niets gebouwd.** Onderzocht op `staging` (`a3a455a`).
> Tweede versie. In de eerste ging alleen losse klantmail via de mailbox en bleef Resend de afzender
> van facturen en offertes. Op verzoek gaat nu **alles wat ResoFly namens een organisatie aan haar
> klanten stuurt** via de gekoppelde mailbox. Tickets en telefoon blijven zoals ze zijn.

Vraag: *Ik wil een eigen mailfunctionaliteit inbouwen binnen Berichten. Klanten moeten hun eigen
mailbox kunnen koppelen. Voor Microsoft via MS Graph, en nodemailer en imapflow voor mailboxen bij
een hostingpartij en dergelijke.* Daarna: *Ik wil net wat professioneler dan een doorstuurlink.
Zodat de functionaliteit van ResoFly en het verzenden ook echt via de mailbox gebeurt.*

**Kort.** Een organisatie koppelt haar echte mailboxen, bijvoorbeeld `jan@bedrijf.nl`,
`info@bedrijf.nl` of `administratie@bedrijf.nl`. Vanaf dat moment is de mailbox **de afzender** van
alles wat ResoFly aan klanten stuurt, en **het postvak** waaruit Berichten leest.

1. **Koppelen.**
   - Microsoft 365 en Outlook.com via Microsoft Graph: inloggen en toestemming geven. Er wordt geen
     wachtwoord bewaard.
   - Mailboxen bij een hoster (TransIP, Strato, Hostnet, one.com, een eigen server; Gmail en iCloud
     met een app-wachtwoord) via imapflow (lezen) en nodemailer (versturen).
2. **Alles naar klanten gaat via de mailbox.** Dat zijn: klantmail, offertes, facturen,
   herinneringen, aanmaningen, creditnota's, contracten, afspraken en uitnodigingen, bestanden,
   portaalmeldingen en inlogcodes. De mail komt van je eigen adres, met je eigen SPF en DKIM, staat in
   je eigen map Verzonden, en de klant antwoordt gewoon aan jou.
3. **Per soort mail kies je de mailbox.** Facturen vanaf `administratie@`, offertes en klantmail
   vanaf de mailbox van wie verstuurt, het portaal vanaf `info@`. Bij een eenmanszaak is dat gewoon
   overal dezelfde mailbox.
4. **Antwoorden komen terug waar ze horen.** Een klant die op een factuur antwoordt ("klopt dit
   bedrag?"), staat in Berichten in het gesprek van díe factuur, met een knop naar de factuur.
5. **Eén verzendlaag.** Nu roepen 28 plekken in de code Resend elk zelf aan. Die gaan allemaal via
   één functie, `sendOrgMail`, en één verzendregister, `mail_sends`. Daar zit de logica:
   - welke weg (mailbox of Resend);
   - de wachtrij en het tempo per mailbox;
   - de terugval als een mailbox niet werkt;
   - nooit dubbel versturen;
   - een kopie van het bericht zoals het verstuurd is;
   - de status.
6. **Bezorging zonder Resend.**
   - Een bounce leest ResoFly uit de mailbox zelf (het "onbestelbaar"-bericht).
   - *Geopend* via een trackingpixel wordt *Bekeken*: de klant opende de offerte- of factuurpagina.
     Dat bestaat al, en het is betrouwbaarder.
7. **Ook via ResoFly blijft het je eigen domein.** Marketing en de terugval gaan via Resend, maar
   vanaf je eigen domein (`administratie@jansen.nl`), zolang dat domein bij ResoFly geverifieerd is.
   Dat kan nu al: het verzenddomein in Instellingen → Domein. Bij het koppelen van een mailbox
   stelt ResoFly het meteen voor (§7.4). Alleen mail van ResoFly aan je eigen team komt van ResoFly
   zelf.
8. **Het doorstuuradres wordt plan B** voor wie niet wil of kan koppelen.

Waar het draait:

- Microsoft in de edge functions, zoals de agenda nu.
- IMAP en SMTP in één nieuwe service, `workers/mail-engine`: Node in een Cloudflare Container, zoals
  de Office-server. Supabase blokkeert poort 587 en houdt geen verbindingen open.

Dit document is een plan, geen bouwopdracht. De volgorde staat in §16, de beslissingen in §18.

---

## 1 · Wat er al ligt

| Bouwsteen | Waar | Wat we eraan hebben |
|---|---|---|
| Berichten: gesprekken, Ongelezen, Niet gekoppeld, zoeken, filters, tickets ertussen | `src/features/Communication.tsx`, `src/lib/communication.ts` | Het scherm bestaat. Mailboxmail wordt gewoon een gesprek. |
| Klantmail in de database | `client_email_threads`, `client_emails`, `client_email_reads`, view `client_email_thread_overview`, `search_client_emails` | Zelfde tabellen. Er komen kolommen bij, geen tweede postvak. |
| Inkomende mail: ontdubbelen, klant zoeken, gesprek kiezen, opvangbak | `register_inbound_message`, `resolve_inbound_client`, `pick_client_email_thread`, `inbound_messages` (`20260815000000`) | De slimste stukken zijn er al, in SQL. De nieuwe ingang gebruikt ze opnieuw. |
| Bekeken door de klant | `client_viewed`-gebeurtenissen in `quote-public`, `invoice-public` en `contract-public` (hooguit één per tien minuten) | De vervanger van de trackingpixel. |
| MIME lezen en HTML veilig tonen | `postal-mime` (`workers/email-inbound`), `src/lib/sanitizeHtml.ts` | Werkt in Node én Deno; ongewijzigd bruikbaar. |
| Microsoft-login met Graph | `_shared/calendarOAuth.ts`, `_shared/calendarCore.ts` (`refreshAccessToken`, `classifyTokenFailure`) | Het OAuth-patroon is er en is al gehard. |
| Geheimen versleutelen | AES-GCM in `_shared/webhooks.ts:206` (twee kopieën in `calendarCore.ts` en `mollieSecrets.ts`) | Wordt één gedeelde module die ook in Node draait. |
| Wachtrij met `FOR UPDATE SKIP LOCKED` | `claim_webhook_deliveries` (`20261003010000`) | Sjabloon voor het verzendregister en de leases. |
| Status naar de bron spiegelen | De trigger die status van `client_emails` naar campagnes en stromen kopieert | Zelfde patroon: `mail_sends` → `invoice_email_deliveries` enzovoort. |
| Bestanden op R2 vanuit de server | `storeInboxAttachment` (`_shared/invoiceInbox.ts`) → media-worker `/internal/media` | Bijlagen, ingelezen mail en "zoals verstuurd". |
| Een Node-container op Cloudflare | `workers/office-server` (Worker + Durable Object + Container) | Het deploypatroon voor de mail-engine. |
| SSRF-bescherming | `isPrivateIpv4`/`isPrivateIpv6` (`_shared/webhooks.ts`), vastgepind adres (`_shared/webhookTransport.ts`) | Voor de IMAP- en SMTP-server die een klant invult. |
| Verzendlimiet, logboek, exportmanifest, vertrek van een teamlid | `email_quota_take`, `audit_row_change`, `src/lib/exportManifest.ts`, `disable_integrations_on_member_exit` | Nieuwe tabellen krijgen daar meteen hun plek. |

---

## 2 · Wat er nu gebeurt als ResoFly mailt

ResoFly verstuurt mail op **28 plekken**. Elke plek bouwt zelf een bericht voor Resend en roept
`api.resend.com` zelf aan. Er bestaan vier kopieën van een `sendViaResend`-functie, en acht plekken
gebruiken er geen enkele.

| Groep | Verzendpunten (bestand) | Wordt nu vastgelegd in |
|---|---|---|
| **Documenten naar de klant** | factuur, herinnering, aanmaning, creditnota (`invoice-workflow`); offerte (`quote-workflow`); contract, getekende kopie (`contract-workflow`, `contract-public`) | `invoice_email_deliveries`, `quote_email_deliveries`, `contract_email_deliveries`. De creditnota en de getekende kopie alleen als gebeurtenis. |
| **Klantmail** | vrije mail, Gerrie-voorstel, portaalwelkom (`mail`) | `client_emails`; het welkom nergens |
| **Afspraken** | boekingslink, bevestiging (`meeting-booking`, `meeting-booking-public`); uitnodiging en annulering met ICS (`_shared/calendarEventWrite.ts`); gespreksverslag (`meeting-transcribe`) | deels (`calendar_event_attendees.invited_at`, `summary_sent_at`), deels nergens |
| **Bestanden** | zending, toegangscode (`_shared/fileTransferServer.ts`, `file-transfer-public`); gedeeld bestand (`file-share`) | `file_transfer_recipients`, `drive_shares.notified_at` |
| **Klantportaal** | inlogcode (`portal-login`); ticketupdates (`portal-notify`) | `portal_login_requests`, `portal_ticket_activity` |
| **Marketing** | campagnes, campagnetest, stromen (`campaigns`) | `email_campaign_recipients`, `email_flow_sends`, `client_emails` |
| **Aan het eigen team** | "contract getekend", nieuwe boeking, testmail, uitnodiging teamlid, domeinmelding, Gerrie-agentrapport | meestal nergens |

**Wat daaraan opvalt:**

- **Er is geen centrale verzender.** Elke wijziging (een andere afzender, een kop erbij) moet op 28
  plekken.
- **De afzender** komt bijna overal uit `resolveSenderIdentity` (`_shared/sendingDomain.ts`). De
  uitzonderingen:
  - de agenda heeft een eigen kopie (`resolveOrgSender`);
  - de domeinmelding en de Gerrie-agent gebruiken een vast adres, de agent zelfs een andere
    variabele (`RESEND_FROM` in plaats van `RESEND_FROM_EMAIL`).
- **Bijlagen.** Factuur, offerte, contract, herinnering, aanmaning en creditnota gaan als PDF mee
  (tot 8 MB), bij e-facturatie met UBL erbij. Het logo zit er als inline-afbeelding (`cid`) in. Een
  uitnodiging heeft een `invite.ics`.
- **Status uit `resend-webhook`.** De webhook werkt facturen, offertes, klantmail, zendingen en
  portaal-bounces bij. **Contracten, creditnota's, afspraken, verslagen en gedeelde bestanden krijgen
  nooit een status.**
- **Wat ervan afhangt:**
  - de labels *Afgeleverd*, *Geopend* en *Gebounced* in Financiën (`Finance.tsx:1393`) en bij
    klantmail (`ClientEmailMessage.tsx`);
  - het Gerrie-signaal "offerte geopend, geen reactie" (`ai_signal_quote_delivery_opened`, op
    `quote_email_deliveries.opened_at`);
  - het overslaan van adressen die bouncen (`email_suppressions`) bij het portaal en bij marketing.
- **Kleine gaten**, die meteen mee kunnen:
  - de inlogcode van het portaal en de annulering van een afspraak tellen niet mee voor de
    verzendlimiet;
  - de toegangscode van een zending en het gespreksverslag hebben een `Idempotency-Key` met
    `Date.now()` of een willekeurige waarde, en beschermen dus niet tegen dubbel versturen.
- **Threading.**
  - ResoFly zet bij uitgaande mail geen eigen `Message-ID`, `In-Reply-To` of `References`. Resend
    kiest zelf een `Message-ID`, maar die wordt niet bewaard.
  - Antwoorden vinden hun gesprek nu alleen via het `reply+`-adres. Met een eigen mailbox bestaat dat
    adres niet meer.
  - De route met een `reply+`-token kiest het gesprek bovendien opnieuw in plaats van het gesprek van
    het oorspronkelijke bericht te nemen.
- **Uitnodigingen.** Een uitnodiging uit een ResoFly-agenda heeft als organisator
  `organizer+<token>@inbound.resofly.com`. Dat is het "doorstuuradres" dat een klant in zijn agenda
  ziet.

---

## 3 · Waarom nu wel (in juli bewust niet)

`20260721020000_user_sender_identities.sql` zegt het letterlijk: *"GEEN mailbox-koppeling (bewust:
Gmail/Microsoft-OAuth eerder afgewezen)"*. De reden staat er niet bij. Wat sindsdien veranderd is:

- **Professioneel overkomen.** Een factuur van `administratie@jansen.nl` die ook in de map Verzonden
  van Jansen staat, en waarop de klant gewoon kan antwoorden, is wat een ondernemer verwacht. Het
  huidige alternatief heeft drie onderdelen die een klant ziet of moet regelen: een `reply+`-adres,
  een doorstuurregel en een organisator `organizer+…`.
- **Aankomen.** Mail uit je eigen mailbox is al goed ondertekend (SPF, DKIM, DMARC van je eigen
  domein). Er hoeven geen DNS-records bij Resend gezet te worden, en spamfilters zien het
  vertrouwde verkeer van jouw domein.
- **Resend schaalt niet als verzenddomein voor iedereen.** Alle organisaties delen één account, en
  Resend Pro heeft 10 domeinen (`CHANGELOG_EIGEN_VERZENDDOMEIN_2026-11-06.md`). Met een gekoppelde
  mailbox gaat het dagelijkse verkeer niet meer via Resend. Het eigen verzenddomein blijft wel
  nuttig, voor marketing en als vangnet (§7.4).
- **De helft van het gesprek ontbreekt nu.** Wat de ondernemer vanuit Outlook aan een klant stuurt,
  ziet ResoFly nooit.
- **Microsoft zet wachtwoorden voor mail uit.**
  - IMAP met een wachtwoord werkt bij Exchange Online al sinds oktober 2022 niet meer.
  - SMTP met een wachtwoord gaat vanaf december 2026 standaard uit (Message Center MC786329).

  Outlook kan dus alleen via OAuth, en daarom via Graph.
- **De bouwstenen zijn er nu**: Microsoft-OAuth (agenda), een Node-container (Office-server) en een
  wachtrijpatroon (webhooks, push).

---

## 4 · Wat je straks ziet

**Inrichten** (`OrganizationSetup`) krijgt een stap *Koppel je mailbox*, met twee knoppen:
**Microsoft 365 / Outlook** en **Andere mailbox**. Daarna één vraag: *Wil je voortaan alles naar je
klanten vanaf dit adres versturen?* Ja zet alle soorten mail op deze mailbox.

**Instellingen → E-mail** krijgt drie delen, in deze volgorde:

1. **Mailboxen**
   - De gekoppelde mailboxen, met hun status in gewone woorden: *Bijgewerkt om 10:42*, *Bezig met
     inlezen: 1.240 van 3.900*, *Koppeling verlopen — verbind opnieuw*.
   - Per mailbox:
     - Is hij *van jou* (persoonlijk) of *van de organisatie* (gedeeld)?
     - Wat haal je binnen: *alleen mail van en naar klanten* (standaard) of *alle mail*?
     - Vanaf wanneer: 30 dagen, 90 dagen (standaard) of een jaar?
     - Wie mag ervan versturen?
     - Je handtekening; pauzeren; ontkoppelen.
   - Microsoft vraagt soms eerst toestemming van een beheerder. Het scherm zegt dat dan in gewone
     woorden en geeft een link die je naar je IT-beheerder stuurt.
2. **Verzenden: wat gaat via welke mailbox**

   | Soort | Verstuurd vanaf | Als de mailbox niet werkt |
   |---|---|---|
   | Klantmail (Berichten, klantdossier) | de mailbox van wie verstuurt | niet versturen, laten zien |
   | Offertes en contracten | de mailbox van wie verstuurt | via ResoFly, met melding |
   | Facturen, herinneringen, aanmaningen, creditnota's | `administratie@jansen.nl` | via ResoFly, met melding |
   | Afspraken en uitnodigingen | de mailbox van wie de afspraak heeft | via ResoFly, met melding |
   | Bestanden | de mailbox van wie verstuurt | via ResoFly, met melding |
   | Klantportaal (meldingen en inlogcodes) | `info@jansen.nl` | via ResoFly, direct |
   | Marketing | ResoFly (je verzenddomein) | — |

   Per regel kies je een gedeelde mailbox, *de mailbox van wie verstuurt*, of *ResoFly*. Bij *als de
   mailbox niet werkt* kies je *via ResoFly* of *wachten tot hij weer werkt*. Alleen de eigenaar en de
   beheerders mogen dit instellen.
3. **Via ResoFly vanaf je eigen domein.** Een verwijzing naar het verzenddomein in Instellingen →
   Domein (§7.4), met de stand: *jansen.nl: klaar* of *nog niet klaar, dan komt terugval van
   ResoFly*. Daaronder, ingeklapt, het doorstuuradres voor wie geen mailbox koppelt.

**Berichten en het klantdossier:**

- Mailboxmail staat tussen de andere gesprekken, met een label (`info@`) als er meer mailboxen zijn,
  en een filter.
- **Beantwoorden** vult *Van* met de mailbox waarop het gesprek binnenkwam. In de lijst staan alleen
  mailboxen waarvan jij mag versturen.
- Wat je vanuit Outlook aan een klant stuurde, staat er ook in.
- **Documentgesprekken.** De factuurmail, de herinneringen en het antwoord van de klant vormen samen
  het gesprek *Factuur 2026-014*, met een knop naar de factuur.
  - In het klantdossier staan ze altijd.
  - In Berichten verschijnen ze pas als de klant antwoordt, of via het filter *Soort: documenten*.
    Zo vult een herinneringsronde Berichten niet met honderd gesprekken.
- Bijlagen staan onder het bericht. Afbeeldingen blijven dicht tot *Afbeeldingen tonen*.
- Werkt een koppeling niet meer, dan staat dat bovenaan Berichten en op de beslislijst.

**Financiën, offertes, contracten.** Bij elke verzending staat:

- *Verstuurd vanuit administratie@jansen.nl om 10:42*, of *Verstuurd via ResoFly; de mailbox werkte
  niet (koppeling verlopen)*;
- *Bekeken door de klant op 12 nov om 9:15* (de pagina, zie §8);
- *Kwam niet aan: het adres bestaat niet* bij een bounce, met *Opnieuw versturen naar ander adres*.

---

## 5 · Welke mail via de mailbox gaat

| Groep | Via de mailbox? | Waarom |
|---|---|---|
| Documenten naar de klant (factuur, herinnering, aanmaning, creditnota, offerte, contract, getekende kopie) | **Ja** | De kern van "professioneel". De PDF en UBL gaan als bijlage mee, zoals nu. |
| Klantmail, portaalwelkom | **Ja** | Gesprekken horen in je eigen mailbox. |
| Afspraken: boekingslink, bevestiging, gespreksverslag | **Ja** | Komt van degene met wie de klant de afspraak heeft. |
| Uitnodiging en annulering (ICS) uit een ResoFly-agenda | **Ja** (fase 5) | De organisator wordt je echte adres in plaats van `organizer+…`. Antwoorden (geaccepteerd, afgewezen) komen in je mailbox, en de synchronisatie geeft ze door aan de bestaande verwerking. Bij een gekoppelde Outlook-agenda stuurt Exchange de uitnodiging al zelf. |
| Bestanden: zending, gedeeld bestand | **Ja** | Zelfde reden als klantmail. |
| Toegangscode zending, inlogcode portaal | **Ja**, niet in Verzonden, met directe terugval | Moet binnen seconden aankomen. Een code in je Verzonden heeft geen nut en is een risico. |
| Ticketupdates portaal | **Ja** | Komt van het adres van de organisatie. Een bounce zet het adres op de lijst om over te slaan, zoals nu. |
| Marketing: campagnes, stromen | **Nee** | Bulk door een gewone mailbox gaat mis: Microsoft staat 10.000 ontvangers per dag toe, hosters veel minder. Eén spamklacht schaadt de naam van het domein waar ook je facturen vandaan komen. Afmelden met één klik (`List-Unsubscribe`) hoort bij een verzenddienst. Een eigen verzenddomein bij Resend blijft hiervoor de weg. |
| Aan het eigen team (contract getekend, nieuwe boeking, testmail, uitnodiging teamlid, domeinmelding, Gerrie-agent) | **Nee** | Dit is ResoFly die met jou praat, niet de organisatie met haar klant. |

**Terugval.** Werkt een mailbox niet (status `needs_reauth` of `error`), of mislukt het versturen
definitief, dan geldt de keuze van §4:

- **Klantmail valt nooit stil terug.** Je ziet de fout, met *Toch versturen via ResoFly*.
- **Documenten, afspraken, bestanden en portaal** gaan via ResoFly, met:
  - **hetzelfde afzenderadres als de mailbox** (`administratie@jansen.nl`), als `jansen.nl` bij
    ResoFly geverifieerd is (§7.4). De klant ziet dan geen verschil. Anders komt de mail van "Jansen
    Fotografie" op het adres van ResoFly;
  - `Reply-To` naar het adres van de mailbox, zodat het antwoord toch bij jou komt;
  - de reden bij de verzending;
  - een melding aan de beheerders.

  Wie dat niet wil, kiest *wachten*. De mail blijft dan in de wachtrij tot de mailbox weer werkt.
- **Codes** wachten hooguit 10 seconden op de mailbox en gaan anders direct via ResoFly. Een klant die
  wil inloggen, wacht niet.

---

## 6 · Hoe het in elkaar zit

```
 App: Berichten · klantdossier · Financiën · Instellingen → E-mail
   │ koppelen                        │ elke verzendknop, elke cron
   ▼                                 ▼
 edge: mailboxes            de 28 verzendpunten (invoice-workflow, quote-workflow, mail, …)
 OAuth, IMAP-gegevens,               │
 test, ontkoppelen                   ▼
   │                        _shared/mail/sendOrgMail ── kiest de weg, bouwt de MIME,
   │                                 │                   legt vast in mail_sends
   │                                 ├─ Resend .......................... zoals nu
   │                                 ├─ Microsoft Graph ................. direct of via de wachtrij
   │                                 └─ IMAP/SMTP → wachtrij → mail-engine
   ▼                                                              │
 Postgres: mailboxes · mailbox_secrets · organization_mail_routes │ seintje
           mail_sends · client_emails · inbound_messages          ▼
   ▲  register_mailbox_message (één ingang)     workers/mail-engine
   │                                            Worker + Container (Node 22)
 edge: mailbox-sync                             imapflow · nodemailer · postal-mime
 Microsoft: meldingen, delta, wachtrij          leases, IDLE, wachtrij, bounces
   ▲                                              │ IMAP 993   │ SMTP 465/587
 Microsoft Graph                                  └─ server van de hoster ─┘
```

| Onderdeel | Soort | Doet |
|---|---|---|
| `_shared/mail/` | gedeelde code, zonder runtime-imports | `sendOrgMail`, de routekeuze, de MIME-bouwer, `secretBox`, adressen normaliseren, foutteksten. Ook bruikbaar in de engine (Node), getest met `deno test` én `node --test`. |
| `mailboxes` | edge function (nieuw) | Koppelen (Microsoft-OAuth, IMAP-gegevens), testen, instellingen, routes, ontkoppelen. |
| `mailbox-sync` | edge function (nieuw, `verify_jwt = false`) | Microsoft: meldingen van Graph, delta, abonnementen verlengen, het eerste inlezen. Verder de wachtrij van Microsoft-mailboxen. Een cron elke minuut. |
| `workers/mail-engine` | Worker + Container (nieuw) | Alles met IMAP en SMTP: verbindingen, IDLE, nieuwe mail, versturen, `APPEND` in Verzonden, testen. |
| `register_mailbox_message` | SQL (nieuw, alleen service-role) | De ene ingang voor binnenkomende mail. |
| `mail_sends` | tabel (nieuw) | Het verzendregister en de wachtrij: elke mail die ResoFly namens een organisatie verstuurt, via welke weg ook. |
| `resend-webhook` | bestaand | Werkt `mail_sends` bij naast de tabellen die hij nu bijwerkt. |

**Waarom deze verdeling.**

| Alternatief | Waarom niet |
|---|---|
| Alles in edge functions, ook IMAP | Een edge function leeft per aanroep: geen IDLE, geen verbinding die openblijft. Poort 587 is dicht volgens de documentatie van Supabase. |
| IMAP in een gewone Worker (`node:net`) | Een socket leeft maar zo lang als het verzoek. Een verbinding per mailbox openhouden kost een Durable Object per mailbox. |
| Ook Microsoft in de mail-engine | Dan hangt de grootste groep aan de container. Graph is HTTPS, en de agenda doet het al vanuit edge functions. |
| Alleen klantmail via de mailbox (de eerste versie) | Voor de klant van je klant blijft het dan een mengsel: de factuur van ResoFly, het antwoord naar `reply+`. Precies wat je niet wilt. |
| Een dienst als Nylas of Unipile | Duur per mailbox, een extra verwerker met toegang tot alle klantmail, en niet wat je vroeg. |

---

## 7 · De verzendlaag: één functie, één register

### 7.1 `sendOrgMail`

Alle verzendpunten roepen voortaan één functie aan in `_shared/mail/sendOrgMail.ts`:

```ts
await sendOrgMail(admin, {
  organizationId,
  kind: 'invoice',                 // welke soort (bepaalt de route en de module)
  requestedBy: userId ?? null,     // null = automatisch (cron, openbare pagina)
  clientId,                        // voor het documentgesprek en de rechten
  to: [{ email, name }], cc: [],
  subject, html, text,
  attachments,                     // PDF, UBL, ICS, logo (cid)
  thread: { sourceKind: 'invoice', sourceId: invoiceId },   // of { threadId } bij klantmail
  idempotencyKey: `invoice-${invoiceId}-${deliveryId}`,
  record: { table: 'invoice_email_deliveries', id: deliveryId },
  urgency: 'interactive',          // 'code' | 'interactive' | 'batch'
});
// → { sendId, transport: 'mailbox' | 'resend', mailboxId, status: 'sent' | 'queued', fromEmail, messageId }
```

Wat de functie doet:

1. **De route kiezen** (`resolveMailRoute`): de regel van `organization_mail_routes` voor deze soort.
   - *De mailbox van wie verstuurt*: de persoonlijke mailbox van `requestedBy`, als die bestaat en
     werkt.
   - Een vaste mailbox: die mailbox, als hij werkt.
   - Anders de terugval van §5.
   - Zonder gekoppelde mailbox verandert er niets: Resend met `resolveSenderIdentity`, zoals nu.
2. **De afzender** is altijd het adres van de mailbox. Er is geen vrij `From`; zo kan niemand via
   ResoFly als een ander versturen. De naam erbij komt uit de route ("Jansen Fotografie —
   Administratie").
3. **Het bericht** bouwt één MIME-bouwer, de `MailComposer` van nodemailer:
   - wij zetten `Message-ID` (`<uuid@domein-van-de-mailbox>`), `X-ResoFly-Id: <sendId>`, en bij een
     antwoord of een herinnering `In-Reply-To` en `References`;
   - de huisstijl (`withEmailBrand`) en het logo als `cid` blijven zoals nu;
   - de handtekening van de mailbox komt eronder.

   Het bericht gaat als `.eml` naar R2 (`<orgId>/mail_sends/<sendId>.eml`). Dat is de kopie *zoals
   verstuurd*, en de wachtrij leest hem daar.
4. **Vastleggen** in `mail_sends`, met `status = 'queued'`.
5. **Versturen.**
   - Bij `interactive` en `code` probeert de functie het meteen, dus Microsoft direct vanuit de edge
     function. Bij IMAP stuurt hij een seintje aan de engine en wacht hij hooguit een paar seconden
     op het resultaat.
   - Bij `batch` (herinneringen, aanmaningen, portaalmeldingen) blijft de mail in de wachtrij. Het
     tempo per mailbox regelt de rest.
6. **De status** `sent` of `failed` gaat via een trigger terug naar de bron (`record`), zoals de
   status nu van `client_emails` naar campagnes gaat. De bestaande `begin_`/`complete_`-functies van
   facturen en offertes blijven het verloop van het document bepalen.

### 7.2 Tempo, voorrang en nooit dubbel

- **Tempo per mailbox.**
  - Microsoft staat 30 berichten per minuut en 10.000 ontvangers per dag toe; wij houden 25 per
    minuut aan.
  - Hosters hebben eigen grenzen. We beginnen voorzichtig (standaard 60 per uur, aan te passen per
    preset) en remmen af bij een SMTP-fout `421` of `4xx` met *rate*.

  Een herinneringsronde van 200 facturen duurt via Microsoft dus zo'n 8 minuten. Dat is prima voor
  een cron, en het scherm zegt *Wordt verstuurd (34 van 200)*.
- **Voorrang:** eerst codes, dan wat iemand net met de hand verstuurde, dan rondes.
- **Nooit dubbel.**
  - De `idempotencyKey` is uniek per organisatie: twee keer op *Versturen* klikken geeft één mail.
  - Een rij die na een crash op `sending` blijft staan, wordt pas opnieuw verstuurd nadat de map
    Verzonden is doorzocht op de `Message-ID`.
  - De bestaande sleutels met `Date.now()` of een willekeurige waarde worden vaste sleutels.
- **De verzendlimiet** (`email_quota_take`) geldt voor elke route, ook voor de inlogcode en de
  annulering, die nu niet meetellen.
- **In Verzonden.** Microsoft zet de kopie er zelf in. Bij IMAP doet de engine een `APPEND` van
  dezelfde bytes. Codes gaan niet naar Verzonden (`saveToSentItems: false`, geen `APPEND`).

### 7.3 Zonder gedragswijziging overstappen

De verzendpunten raken facturen en betalingen. `_shared/resend.ts` noemt de functie `mail` zelfs
bewust "betaalkritisch" en wilde hem niet aanraken. Daarom gaat de overstap in twee stappen:

1. **Eerst alles via `sendOrgMail`, met alleen Resend als weg** (fase 1). Een gouden test legt per
   verzendpunt de Resend-payload van nu vast (afzender, ontvangers, onderwerp, bijlagen, tags,
   idempotentiesleutel). Na de overstap moet de payload hetzelfde zijn. Alleen de kleine gaten van §2
   worden bewust gerepareerd, met een eigen test.
2. **Dan pas de mailbox als weg erbij** (fase 2 en 3), per soort, achter de schakelaar.

### 7.4 Via ResoFly, vanaf je eigen domein

Gaat een mail via ResoFly (marketing, de terugval, of een organisatie zonder mailbox), dan komt hij
toch van het eigen domein. Dat bestaat al sinds juni, en sinds 6 november werkt het goed
(`CHANGELOG_EIGEN_VERZENDDOMEIN_2026-11-06.md`): Instellingen → Domein → *Eigen verzenddomein*, naast
het webadres van het klantportaal.

**Wat de klant daarvoor doet:** eenmalig drie DNS-records bij zijn domeinbeheerder.

- Een DKIM-sleutel (`resend._domainkey.jansen.nl`).
- Een SPF-record en een MX op het subdomein `send.jansen.nl`.

Zijn gewone mail merkt daar niets van: de MX staat op `send.`, niet op het domein zelf, en het
SPF-record van `jansen.nl` blijft zoals het is. Resend tekent met DKIM op `jansen.nl`, dus ook een
strenge DMARC (`p=reject`) laat de mail door. Het scherm controleert de records en vraagt een minuut
lang zelf de stand op.

**Wat dit plan eraan toevoegt:**

- **Hetzelfde adres als de mailbox.** Valt `administratie@jansen.nl` terug op ResoFly, dan is het
  `From` ook `administratie@jansen.nl`, met hetzelfde adres als `Reply-To`. `sendOrgMail` neemt
  het adres van de mailbox over, maar alleen als het domein op dat moment geverifieerd is. Dat is
  dezelfde controle tegen vervalsen als nu in `resolveSenderIdentity` (`_shared/sendingDomain.ts`).
  Niet geverifieerd? Dan komt de mail van "Jansen Fotografie" op het adres van ResoFly, met
  `Reply-To` naar de mailbox. Nooit van een domein dat niet bij ResoFly geverifieerd is: dat haalt
  DMARC niet en belandt in de spam, of wordt geweigerd.
- **Meteen voorstellen bij het koppelen.** Na *Mailbox gekoppeld* volgt: *Wil je dat ResoFly ook
  vanaf jansen.nl kan versturen, als je mailbox even niet werkt en voor nieuwsbrieven? Zet dan deze
  drie records.* Het domein haalt ResoFly uit het adres van de mailbox. Is het verzenddomein al
  klaar, dan zie je alleen een vinkje.
- **De stand per route** in Instellingen → E-mail → Verzenden: *terugval vanaf
  administratie@jansen.nl* of *terugval vanaf ResoFly, jansen.nl is nog niet klaar*.
- **Niet in je map Verzonden.** Een terugval loopt buiten je mailbox om. Werkt de mailbox weer,
  dan zet ResoFly bij IMAP het bewaarde `.eml` alsnog in Verzonden (`APPEND`). Of dat bij Microsoft
  ook netjes kan (een bericht uit MIME in Verzonden items, niet als concept), test fase 0.

**De grens zit bij Resend, niet bij de klant.**

- Alle organisaties delen één Resend-account. Pro heeft 10 domeinen. Daarboven:
  - extra domeinen (100 voor $20 per maand, ook op Pro);
  - of het Scale-abonnement (1.000 domeinen, vanaf $90 per maand).

  Wordt het eigen domein bij ResoFly voor iedereen de standaard, dan is dat uitbreiden een vaste
  stap vóór de 11e organisatie. Zie §17 en beslissing 15.
- Een domein kan maar in één Resend-account tegelijk geverifieerd zijn. Staging en productie hebben
  elk een eigen account; een testdomein hoort dus bij één van de twee (punt 26 van
  `ACTIEPUNTEN_BEVEILIGING_SAAS_2026-11-01.md`).
- Per organisatie mag de code nu hooguit vijf verzenddomeinen koppelen. Dat is genoeg.

---

## 8 · Bezorging en status zonder Resend

Via een mailbox weet ResoFly minder dan via Resend. Dit is wat we wel weten en hoe het scherm het
zegt:

| Nu (Resend) | Via de mailbox | In het scherm |
|---|---|---|
| Verstuurd | De server van Microsoft of de hoster nam het bericht aan | *Verstuurd vanuit administratie@…* |
| Afgeleverd | Niet te weten | Niet meer tonen bij mailboxmail |
| Geopend (pixel) | Geen pixel | *Bekeken door de klant*, uit `client_viewed` van de pagina |
| Geklikt | — | Zelfde als bekeken: de link gaat naar de pagina |
| Gebounced | Uit het "onbestelbaar"-bericht in de mailbox | *Kwam niet aan: …* met de reden |
| Spamklacht | Niet te weten | — |

**Bounces uit de mailbox.** De synchronisatie herkent een onbestelbaar-bericht vóór de klantfilter:

- afzender `MAILER-DAEMON` of `postmaster`;
- `Content-Type: multipart/report; report-type=delivery-status`;
- of de vorm die Exchange gebruikt.

Uit het bijgevoegde origineel of uit `message/rfc822-headers` haalt hij de `X-ResoFly-Id` of de
`Message-ID`. Dan gebeurt er dit:

- De rij in `mail_sends` wordt `bounced`, met de reden in gewone woorden ("het adres bestaat niet",
  "de mailbox van de ontvanger is vol").
- De trigger zet de bron op *gebounced*, net als nu bij Resend.
- Een harde bounce zet het adres in `email_suppressions`, zoals nu bij het portaal.
- Het onbestelbaar-bericht zelf komt niet in Berichten en niet in de opvangbak.

Fase 0 verzamelt echte voorbeelden van Microsoft, Gmail, Postfix en Exim voor de tests.

**Waarom geen trackingpixel.**

- Apple Mail en steeds meer zakelijke filters openen elke mail vooraf. *Geopend* zegt dus weinig.
- Een pixel in een factuur vanuit je eigen mailbox is een privacyvraag die je klant niet verwacht.
- Pixels kosten punten bij spamfilters.

*Bekeken* (de klant opende de offerte, factuur of het contract) bestaat al en is eerlijker.

**Wat er mee verandert:**

- `emailStatusLabel` (`Finance.tsx:1393`) en `ClientEmailMessage.tsx` kennen *Verstuurd vanuit…*,
  *Bekeken* en *Kwam niet aan*.
- Het Gerrie-signaal `quote_opened_unanswered` kijkt voortaan naar `client_viewed`, of naar
  `opened_at` als die er is. `gerrie-signals/index.ts:533` telt mee.
- `src/lib/stroom.ts:147` (*geopend*) leest hetzelfde.
- Contracten krijgen ook bij Resend eindelijk een status, via `mail_sends` (§2).

---

## 9 · Microsoft 365 via Graph

### 9.1 De app bij Microsoft

- **Een aparte app-registratie "ResoFly Mail"** in Entra, los van de agenda-app.
  - Het toestemmingsscherm noemt dan alleen mail.
  - Wie mail blokkeert, raakt zijn agenda niet kwijt.
  - De geheimen zijn los van elkaar te vervangen.

  De app is multitenant, met persoonlijke accounts (`common`).
- **Rechten, in één keer:** `openid email offline_access User.Read Mail.ReadWrite Mail.Send
  Mail.ReadWrite.Shared Mail.Send.Shared`. Waarom meer dan het minimum (`Mail.Read Mail.Send`):
  - Facturen en offertes komen meestal van een **gedeeld postvak** (`administratie@`, `info@`).
    Daarvoor zijn de `.Shared`-rechten nodig, en de gebruiker die koppelt heeft *Send As* op dat
    postvak.
  - Een bijlage boven ongeveer 3 MB gaat bij Graph via een concept en een upload. Daarvoor is
    `Mail.ReadWrite` nodig. Contracten met een Office-bestand kunnen zo groot zijn.
  - Vaak moet een beheerder van de klant toestemming geven. Dat wil je één keer vragen, niet bij elke
    nieuwe functie opnieuw. Zie beslissing 8.
- **Een geverifieerde uitgever** (*publisher verification*, via het Microsoft AI Cloud Partner
  Program). Zonder die badge zien gebruikers een waarschuwing, en veel bedrijven blokkeren onbekende
  uitgevers. Begin in fase 0: het kan weken duren.
- **Toestemming van een beheerder.** Bij `consent_required` of `admin_consent_required` toont het
  scherm de link voor beheerderstoestemming (`/{tenant}/adminconsent?client_id=…`), met een tekst
  voor de IT-beheerder.

### 9.2 Koppelen

Hetzelfde patroon als de agenda (`calendarOAuth.ts`), algemener gemaakt in `_shared/oauthState.ts`:

1. `oauthStart` maakt een getekende state, 30 minuten geldig.
2. De terugkeer gaat naar `mailboxes`, die doorstuurt naar de app zonder de code in te wisselen.
3. `oauthComplete` gebeurt met de sessie van dezelfde gebruiker.
4. Daarna `/me`: het adres en de tenant.

Een **gedeeld postvak toevoegen** gebeurt met dezelfde tokens. Je typt het adres, en ResoFly
controleert met een leesverzoek en een testverzending of je erbij mag.

### 9.3 Lezen

- **Mappen:** Postvak IN en Verzonden items, per map een delta (`/mailFolders/{id}/messages/delta`).
  Bij een gedeeld postvak via `/users/{adres}/…`.
- **Altijd `Prefer: IdType="ImmutableId"`.** Anders verandert het id als iemand een mail verplaatst.
- **Eerst de envelop, dan de inhoud.** De delta vraagt alleen afzender, ontvangers, `internetMessageId`,
  `conversationId`, datum en `hasAttachments`. Bij *alleen klantmail* vraagt de server eerst
  `mailbox_match_preview`. Alleen bij een treffer haalt hij de MIME op (`/messages/{id}/$value`).

  Graph geeft `In-Reply-To` niet in de delta. Daarom haalt de voorcontrole de MIME ook op als het
  `conversationId` al bekend is bij een klant- of documentgesprek. Onbestelbaar-berichten en
  antwoorden op uitnodigingen (`eventMessage`) gaan altijd door. De echte beslissing valt in
  `register_mailbox_message`.
- **Meldingen als wekker:**
  - een abonnement op `created` per map, maximaal 10.080 minuten geldig, dagelijks verlengd;
  - een `clientState` per abonnement (alleen de hash bewaard);
  - lifecycle-meldingen voor `reauthorizationRequired`, `subscriptionRemoved` en `missed`.

  Antwoord met `202` binnen een paar seconden. De delta draait ook elke 10 minuten zonder melding.
- **Het eerste inlezen** gaat in porties, met de voortgang in `mailboxes.import_progress`.

### 9.4 Versturen

- **De MIME uit §7.1 via `POST /sendMail`** (base64, `Content-Type: text/plain`), bij een gedeeld
  postvak via `/users/{adres}/sendMail`.
- **Bij meer dan ongeveer 3 MB** gaat het via een concept, een upload-sessie voor de bijlage, en
  `send`.
- **Fase 0 controleert** of Exchange onze `Message-ID` laat staan, en in welke map Verzonden de kopie
  komt bij een gedeeld postvak. Exchange zet die standaard bij wie verstuurt, tenzij
  `MessageCopyForSentAsEnabled` op het postvak aan staat; dan geeft het scherm die tip.
- **Fouten in gewone woorden:**
  - `invalid_grant` → *Koppeling verlopen, verbind opnieuw*;
  - `ErrorSendAsDenied` → *Je mag niet vanaf dit adres versturen; vraag je beheerder om "Verzenden
    als"*;
  - `MailboxNotEnabledForRESTAPI` → *Deze mailbox staat niet in Microsoft 365; koppel hem als andere
    mailbox*;
  - `429` → wachten volgens `Retry-After`.

---

## 10 · Andere mailboxen via IMAP en SMTP (imapflow, nodemailer)

### 10.1 Instellen zonder dat je iets hoeft te weten

`imapDiscover(email)` zoekt in deze volgorde:

1. **MX-record.** Microsoft → *koppel hem met de Microsoft-knop*. Google → uitleg voor een
   app-wachtwoord.
2. **Vaste instellingen** voor de hosters die onze klanten echt gebruiken
   (`_shared/mail/presets.ts`, met stappen per hoster zoals `FORWARDING_PROVIDERS`).
3. **Autoconfig**: `autoconfig.<domein>` en de database van Thunderbird.
4. **SRV-records** (RFC 6186, 8314).
5. Lukt niets, dan vul je zelf de server, poort en beveiliging in.

**Testen** gebeurt in de engine, per stap zichtbaar:

- inloggen op IMAP;
- de map Verzonden vinden (`\Sent`, anders op naam);
- inloggen op SMTP;
- een testbericht naar jezelf. Komt dat vanzelf in Verzonden? Dan slaan we de `APPEND` over.

Het wachtwoord wordt pas na een geslaagde test opgeslagen.

**Gmail en Google Workspace** gaan via IMAP met een app-wachtwoord (tweestapsverificatie aan). OAuth
voor Gmail vraagt een jaarlijkse beveiligingsaudit (CASA); dat doen we pas bij genoeg vraag.
**iCloud** werkt hetzelfde.

### 10.2 Lezen

- **Leases.** Precies één engine-proces houdt een mailbox bij (`claim_mailboxes`, `FOR UPDATE SKIP
  LOCKED`). De lease is 2 minuten en wordt elke 30 seconden verlengd. Zo kunnen er later instances
  bij.
- **Eén verbinding per mailbox:**
  - Postvak IN met IDLE;
  - Verzonden elke 5 minuten;
  - zonder IDLE elke 2 minuten `NOOP`.
- **Stand per map:** `uidvalidity` en de laatste UID. Verandert `uidvalidity`, dan lezen we opnieuw in
  vanaf de laatste datum, en de ontdubbeling vangt de rest op.
- **Eerst de envelop en `BODYSTRUCTURE`**, dan pas de bron. Zo herkent de engine een onbestelbaar-
  bericht of een uitnodigingsantwoord (`text/calendar; method=REPLY`) zonder privémail te downloaden.
- **We veranderen niets in de mailbox.** `BODY.PEEK`: niets wordt gelezen gemarkeerd, verplaatst of
  gewist.

### 10.3 Versturen

1. De engine pakt een rij uit `mail_sends` (`claim_mail_sends`) en leest het `.eml` van R2.
2. nodemailer geeft het door aan SMTP: poort 465 met TLS, of 587 met STARTTLS.
3. Een `APPEND` van dezelfde bytes in Verzonden, met `\Seen`.
4. Status `sent`. Een rij die op `sending` bleef staan, wordt pas opnieuw verstuurd nadat Verzonden
   is doorzocht op de `Message-ID`.

### 10.4 Netjes zijn tegen hosters

Alle verbindingen komen van dezelfde paar adressen. Eén slordige klant kan zo de rest laten
blokkeren.

- **Bij een fout wachtwoord meteen stoppen** (`needs_reauth`). Hosters blokkeren met fail2ban het IP,
  en dat IP delen al onze klanten.
- **Wachten met terugval** bij netwerkfouten (1, 2, 4 … tot 60 minuten).
- **Hooguit 20 gelijktijdige verbindingen** naar dezelfde IMAP-host. Per mailbox gebruiken we er één.
- **Een herkenbare naam**: `ID name=ResoFly`.
- Vraagt een hoster om een vast IP, dan is dat een reden voor Fly.io met een vast uitgaand adres.

---

## 11 · Eén weg naar binnen: van mail naar gesprek

Microsoft (edge) en IMAP (engine) maken van elk bericht dezelfde payload. Bijlagen staan er alleen met
naam, type en grootte in. `register_mailbox_message` beslist. Pas daarna gaan de bijlagen en het
`.eml` naar R2.

1. **Organisatie** = die van de mailbox. Nooit uit de mail zelf (harde regel 1).
2. **Speciale mail eerst.** Een onbestelbaar-bericht → bounce (§8). Een antwoord op een uitnodiging →
   de bestaande RSVP-verwerking. Geen van beide wordt een gesprek.
3. **Ontdubbelen** op `(organization_id, rfc_message_id)`:
   - via het doorstuuradres of een tweede mailbox: het `mailbox_id` erbij;
   - een kopie in Verzonden van een eigen `mail_sends`-rij: aanvullen, geen tweede rij.
4. **Intern overslaan**: mail tussen adressen van de eigen organisatie.
5. **Eerst de klant, dan het gesprek.** Koppen als `References` kiest de afzender zelf. Ze mogen nooit
   bepalen bij welke klant een mail hoort, alleen welk gesprek binnen die klant. Dat is nu ook de
   regel (commentaar in `pick_client_email_thread`). Anders schuift iemand met een verzonnen kop zijn
   mail in het dossier van een andere klant.
   - **De klant**, in deze volgorde:
     1. Een exact adres van een klant of contactpersoon. Bij binnenkomend is dat de afzender, bij
        Verzonden de ontvangers.
     2. Geen adres, maar `In-Reply-To` wijst naar een bericht dat **wij** verstuurden? Dat is net zo
        sterk als het `reply+`-token van nu: alleen wie onze mail kreeg, kent die id. Dan geldt de
        klant van dat bericht. Zo komt het antwoord van de boekhouder van je klant, die op de factuur
        antwoordt, goed terecht.
     3. Een domein is een voorstel, en gaat naar de opvangbak.
   - **Het gesprek** binnen die klant, in deze volgorde:
     1. `In-Reply-To` en `References`;
     2. `X-ResoFly-Id`, alleen uit de eigen map Verzonden;
     3. het documentgesprek (`source_kind`, `source_id`) van het bericht waarop geantwoord wordt;
     4. het `conversationId` van Microsoft;
     5. de bestaande regel: het laatste gesprek van minder dan 30 dagen, of een nieuw.
6. **Opslaan.**
   - Gevonden: een rij in `client_emails`, `provider = 'mailbox'`.
   - Niet gevonden, bij *alle mail*: `inbound_messages` met `route = 'mailbox'` (Niet gekoppeld).
   - Niet gevonden, bij *alleen klantmail*: niets, alleen een teller.

**Het eerste inlezen mag geen lawine geven.** Een kolom `imported` zorgt ervoor dat push,
Gerrie-signalen, agents en campagnetriggers zulke rijen overslaan. Ingelezen mail telt als gelezen.

**Bijlagen.**

- Tot 25 MB per bestand naar R2 (`<orgId>/client_mail/…`), met een rij in
  `client_email_attachments`. Groter: alleen de naam.
- Mislukt het uploaden, dan blijft de mail staan en volgt een nieuwe poging.
- Inline afbeeldingen alleen na *Afbeeldingen tonen*.
- De media-worker geeft ze alleen aan wie module Klanten mag lezen.

---

## 12 · Datamodel (schets)

Migratie `<versie>_mailboxen.sql`, na `20261111190000`, veilig opnieuw te draaien. In fase 1 komt
alleen het verzendregister; de mailboxtabellen komen in fase 2.

```sql
-- Het verzendregister en de wachtrij: elke mail die ResoFly namens een organisatie verstuurt.
create table if not exists public.mail_sends (
  id uuid primary key default gen_random_uuid(),        -- ook de X-ResoFly-Id
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null,                                   -- 'invoice', 'invoice_reminder', 'dunning',
                                                        -- 'credit_note', 'quote', 'contract', 'client_mail',
                                                        -- 'booking', 'calendar_invite', 'file_transfer',
                                                        -- 'portal_update', 'portal_code', 'campaign', …
  source_table text, source_id uuid,                    -- invoice_email_deliveries.id enz.
  client_id uuid references public.clients(id) on delete set null,
  requested_by uuid references auth.users(id) on delete set null,   -- null = automatisch
  idempotency_key text not null,
  transport text not null check (transport in ('mailbox', 'resend')),
  mailbox_id uuid,                                      -- fk naar mailboxes in fase 2
  fallback_reason text,                                 -- "mailbox werkte niet: koppeling verlopen"
  from_email text not null,
  to_emails text[] not null, cc_emails text[],
  subject text not null,
  rfc_message_id text not null,
  mime_storage_key text,                                -- het bericht zoals verstuurd, op R2
  urgency text not null default 'interactive' check (urgency in ('code', 'interactive', 'batch')),
  status text not null default 'queued' check (status in
    ('queued', 'sending', 'sent', 'failed', 'bounced', 'cancelled')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  provider_id text,                                     -- id bij Resend of Microsoft
  last_error text, bounce_reason text,
  sent_at timestamptz, bounced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, idempotency_key),
  unique (organization_id, rfc_message_id)
);

-- Welke mailbox voor welke soort mail (§4). Fase 2.
create table if not exists public.organization_mail_routes (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind_group text not null check (kind_group in
    ('client_mail', 'quotes_contracts', 'invoices', 'appointments', 'files', 'portal')),
  sender text not null check (sender in ('mailbox', 'own_mailbox', 'resofly')),
                                                        -- own_mailbox = van wie verstuurt
  mailbox_id uuid references public.mailboxes(id) on delete set null,
  display_name text,
  on_failure text not null default 'resofly' check (on_failure in ('resofly', 'wait')),
  primary key (organization_id, kind_group)
);

-- De mailboxen (fase 2): zoals in de eerste versie.
--   mailboxes          (provider, email, kind personal/shared, owner_user_id, import_mode,
--                       import_since, status, status_detail, import_progress, signature_html,
--                       send_rate_per_minute, server_info)
--   mailbox_secrets    (versleuteld; RLS aan, geen policies)
--   mailbox_members    (wie mag versturen)
--   mailbox_folders    (uidvalidity/last_uid of delta_link, abonnement)
--   mailbox_sync       (lease, wekker, terugval)

-- Klantmail en documentgesprekken.
alter table public.client_emails
  add column if not exists mailbox_id uuid,
  add column if not exists mail_send_id uuid references public.mail_sends(id) on delete set null,
  add column if not exists source_kind text,            -- 'invoice', 'quote', 'contract', …
  add column if not exists source_id uuid,              -- het document
  add column if not exists to_emails text[], add column if not exists cc_emails text[],
  add column if not exists in_reply_to text, add column if not exists reference_ids text[],
  add column if not exists provider_thread_id text,
  add column if not exists raw_storage_key text,
  add column if not exists imported boolean not null default false;

-- De bestaande registraties wijzen naar het register.
alter table public.invoice_email_deliveries  add column if not exists mail_send_id uuid;
alter table public.quote_email_deliveries    add column if not exists mail_send_id uuid;
alter table public.contract_email_deliveries add column if not exists mail_send_id uuid;
alter table public.file_transfer_recipients  add column if not exists mail_send_id uuid;

create table if not exists public.client_email_attachments (…);   -- zoals in de eerste versie
```

**Daarbij:**

- **RLS op `mail_sends`.** Lezen mag alleen met de module die bij de soort hoort, via een functie
  `mail_kind_module(kind)`. Dezelfde indeling als `PAGE_MODULE` in `src/lib/permissions.ts`:
  - facturen, offertes en contracten → Financiën;
  - klantmail → Klanten;
  - afspraken → Agenda;
  - bestanden → Inhoud;
  - het portaal → Tickets;
  - marketing → Marketing.

  Zo ziet een teamlid zonder Financiën ook in het register geen factuurmail (harde regel 3).
  Schrijven alleen via de service-role.
- **Documentgesprekken volgen de module van het document.** Een factuurmail in het klantdossier
  vertelt bedragen. Iemand met Klanten maar zonder Financiën mag die niet zien, ook het antwoord
  van de klant erop niet. Daarom:
  - `client_email_threads` krijgt ook `source_kind`;
  - een extra restrictive policy op `client_email_threads`, `client_emails` en
    `client_email_attachments`: `source_kind is null or can_read_module(org,
    mail_kind_module(source_kind))`;
  - de views `client_email_thread_overview` en `client_email_unread` zijn `security_invoker` en
    volgen vanzelf.
- **Een trigger** spiegelt `sent`, `failed` en `bounced` naar `source_table`/`source_id`. De bestaande
  `begin_`/`complete_`-functies van facturen en offertes blijven het document bijwerken.
- **`resend-webhook`** werkt naast zijn huidige tabellen ook `mail_sends` bij (op `provider_id`).
- **Documentgesprekken.** Een documentmail naar een klant krijgt ook een rij in `client_emails`,
  outbound, met `source_kind` en `source_id`, in een gesprek per document. Een trigger op
  `client_emails` die uitgaande mail niet verwacht (signalen, agents), wordt nagelopen.
- **Logboek.**
  - `audit_row_change` op `mailboxes` en `organization_mail_routes`.
  - Acties `mailbox_connected`, `mailbox_disconnected` en `mail_route_changed` in
    `audit_logs_action_check`.
  - Een terugval naar ResoFly komt ook in het logboek.
- **Vertrek van een teamlid.** Persoonlijke mailboxen gaan naar `disconnected` en hun geheimen worden
  gewist. Routes met *de mailbox van wie verstuurt* gaan voor die persoon niet meer.
- **Exportmanifest.**
  - `mail_sends` gaat mee, met de `.eml`'s: het bewijs van wat er verstuurd is.
  - `organization_mail_routes`, `mailboxes`, `mailbox_members` en `client_email_attachments` gaan mee.
  - `mailbox_secrets` valt onder `geheim`; `mailbox_folders` en `mailbox_sync` onder `intern`.
- **dataGroups:** geen wijziging nodig.

---

## 13 · De harde regels, één voor één

| Regel | Hoe dit plan eraan voldoet |
|---|---|
| 1 · Elke organisatie een eigen wereld | `sendOrgMail` krijgt de organisatie van de aanroeper (uit de sessie of de rij die al van die organisatie is). De route en de mailbox moeten van dezelfde organisatie zijn; een trigger en een test bewaken dat. De engine schrijft alleen via RPC's die zelf op `organization_id` filteren. |
| 2 · De AI voert niets zelf uit | Gerrie, agents en MCP stellen voor (`propose_send_client_email` met `thread_id`). Na goedkeuring loopt het via de knop, met de rechten van wie goedkeurt. *De mailbox van wie verstuurt* is dan de mailbox van die mens, nooit van de agent. Mailtekst is gegevens. Er is geen handeling om mailboxen of routes te veranderen. |
| 3 · Modulerechten overal | Mailboxmail valt onder Klanten. Het register volgt de module van de soort. Een documentgesprek (factuur, offerte, contract) volgt ook Financiën: zonder Financiën zie je het niet in Berichten en niet in het klantdossier. Bijlagen gaan via de media-worker met dezelfde controle. |
| 4 · Alleen via migraties | Migraties na `20261111190000`, veilig opnieuw te draaien; daarna de keten vanaf nul. |
| 5 · Laden per module | Geen nieuwe groep nodig. |
| 6 · Geld en bewaarplicht | Een factuur ligt vast op het moment van *Versturen*, zoals nu. De mail is een aparte stap met een eigen status. Mislukt de mail, dan blijft de factuur staan, met *Mail niet verstuurd — opnieuw*. Het `.eml` op R2 legt vast wat de klant precies kreeg, naast de PDF-kopie die er al is. |

---

## 14 · Veiligheid en privacy

**Geheimen.**

- Eén module `secretBox` (AES-GCM, WebCrypto), met een sleutel-id voor het vervangen van sleutels.
- Twee sleutels: `MAILBOX_MS_TOKEN_KEY` (alleen de edge functions) en `MAILBOX_IMAP_SECRET_KEY`
  (`mailboxes` en de engine). Een lek in de engine geeft geen Microsoft-tokens prijs.
- Geheimen gaan nooit naar de browser en worden bij ontkoppelen meteen gewist.

**Versturen als iemand anders.**

- Het `From` is altijd het adres van de mailbox; vrije adressen bestaan niet.
- Een persoonlijke mailbox verstuurt alleen voor zijn eigenaar.
- Automatische mail (cron, openbare pagina) gaat alleen via een gedeelde mailbox die een beheerder aan
  die soort heeft gekoppeld.
- Bij Microsoft controleert Exchange daarnaast *Send As*.

**De server die een klant invult (SSRF).**

- Eén keer opzoeken; privé, lokaal en link-local weigeren; verbinden met dat vaste adres, met de naam
  voor het certificaat (`servername`).
- Alleen de poorten 993, 143 (STARTTLS), 465 en 587.
- TLS verplicht, geen knop "certificaat negeren".

**De engine** heeft geen open poort. De Worker ervoor accepteert alleen `MAIL_ENGINE_SECRET`. Hij logt
nooit inhoud of wachtwoorden.

**Misbruik.** De verzendlimiet geldt voor elke route, het tempo per mailbox ook. Een plotselinge piek
zet de mailbox op pauze en meldt dat de beheerders. Een overgenomen account kan zo via ResoFly geen
spamrun starten vanaf het domein van de klant.

**Inkomende mail is onbetrouwbaar.** HTML gaat door `sanitizeInboundEmailHtml`, en afbeeldingen
blijven dicht. Bijlagen worden als download geserveerd, met `nosniff` en `CSP: sandbox`. Voor Gerrie
is het gegevens, nooit een opdracht.

**Privacy (AVG).**

- Standaard *alleen klantmail*, en de envelop gaat vóór de inhoud.
- Eenrichtingsverkeer: ResoFly verwijdert of verplaatst niets in de mailbox.
- Ontkoppelen vraagt of de ingelezen mail mag blijven.
- In de verwerkersovereenkomst komen: mailboxinhoud, de subverwerker van de engine en de regio
  daarvan. Laat dat toetsen door een jurist.
- Gegevens meenemen, fase 2: bij wissen ook ontkoppelen en `client_mail/` en `mail_sends/` op R2
  wissen.

---

## 15 · Wat er misgaat als je het simpel doet

| Valkuil | Wat er dan gebeurt | In dit plan |
|---|---|---|
| Elk verzendpunt zelf laten kiezen tussen Resend en mailbox | 28 plekken met elk een eigen variant; de volgende wijziging vergeet er drie | Eén `sendOrgMail` |
| De overstap in één keer, met de mailbox erbij | Een fout in de factuurmail valt niet op tussen alle andere wijzigingen | Eerst alles via de verzendlaag met alleen Resend, met gouden tests; dan pas de mailbox |
| Herinneringen in één klap via Microsoft | Na 30 berichten in een minuut weigert Exchange; de rest faalt | Een wachtrij met tempo per mailbox; rondes als `batch` |
| Mailbox kapot, factuur gaat stil niet weg | De klant krijgt nooit een factuur, niemand weet het | Terugval naar ResoFly (of wachten), altijd zichtbaar, met melding |
| Klantmail stil via ResoFly als de mailbox kapot is | De klant krijgt mail van een onverwacht adres | Klantmail valt nooit stil terug |
| Bij een terugval het adres van de mailbox als `From` zetten, zonder geverifieerd domein | DMARC faalt: de factuur belandt in de spam of wordt geweigerd | Het eigen adres alleen als het domein bij ResoFly geverifieerd is; anders het adres van ResoFly met `Reply-To` |
| De kopie in Verzonden opnieuw inlezen | Elke factuurmail twee keer in het dossier | `X-ResoFly-Id` en de `Message-ID` koppelen de kopie aan de rij in `mail_sends` |
| *Geopend* laten staan zonder pixel | Elke offerte "nooit geopend"; het Gerrie-signaal vuurt bij alles | *Bekeken* uit de pagina; het signaal kijkt daarnaar |
| Bounces negeren | Herinneringen naar een adres dat niet bestaat, tot aan de aanmaning | Onbestelbaar-berichten uit de mailbox lezen; `email_suppressions` |
| Marketing via de mailbox | Microsoft blokkeert het account; het domein van de facturen belandt op een zwarte lijst | Marketing blijft via het verzenddomein |
| Inlogcodes wachten op een trage hoster | De klant komt het portaal niet in | Hooguit 10 seconden, dan via ResoFly |
| De klant bepalen uit `References` | Iemand schuift met een verzonnen kop mail in het dossier van een andere klant | De klant uit het adres of uit onze eigen `Message-ID` |
| Factuurmail gewoon als klantmail opslaan | Een teamlid zonder Financiën leest bedragen in het klantdossier | Documentgesprekken volgen de module van het document |
| Inlezen van 90 dagen als nieuwe mail behandelen | Honderden meldingen en agentruns | Kolom `imported` |
| Alles uit de mailbox binnenhalen | Privémail bij het hele team | *Alleen klantmail* als standaard |
| Doorgaan na een fout wachtwoord | De hoster blokkeert het IP van ResoFly, voor alle klanten | Direct `needs_reauth`, terugval, een maximum per server |
| Alleen op meldingen van Microsoft vertrouwen | Gemiste mail, verlopen abonnementen | Delta elke 10 minuten, dagelijks verlengen |
| Een gedeeld postvak via de tokens van één medewerker | Die vertrekt, en de facturen gaan via ResoFly | Terugval met melding; app-only-rechten in fase 6 |

---

## 16 · Fasen

Alles staat achter een schakelaar per organisatie (`organizations.mailboxes_enabled`, alleen door
ResoFly aan te zetten). Fase 1 verandert voor klanten niets, behalve de kleine reparaties.

### Fase 0 · Proeven en voorbereiden (± 1 week)

- **Entra:** app "ResoFly Mail" registreren en de uitgeversverificatie starten. Toestemming testen in
  een testtenant met de standaardinstellingen.
- **Graph:**
  - `sendMail` met MIME, met een PDF van 2 en van 5 MB (de tweede via concept en upload).
  - Blijft onze `Message-ID` staan?
  - Een gedeeld postvak met *Send As*: in welke map Verzonden komt de kopie?
  - Een `text/calendar`-uitnodiging via MIME: hoe gaat Exchange daarmee om?
- **Deno:** `postal-mime` en `MailComposer` (via `npm:`) in een edge function.
- **Container:** lukt uitgaand 993, 465 en 587 naar drie Nederlandse hosters, Gmail en iCloud? Hoe lang
  blijft hij leven, en in welke regio draait hij?
- **Bounces:** echte onbestelbaar-berichten van Microsoft, Gmail, Postfix en Exim, als testdata.
- **Resend:** neemt de API een eigen `Message-ID` in `headers` over?
- **Besluit:** Cloudflare Containers of Fly.io.
- **Resultaat:** `docs/rapporten/MAILBOX_PROEF_<datum>.md`, en de beslissingen van §18 genomen.

### Fase 1 · De verzendlaag, nog alleen via Resend (± 2 weken)

- `mail_sends`, `sendOrgMail` (alleen Resend), de MIME-bouwer en het `.eml` op R2.
- Alle 28 verzendpunten erop, met gouden tests per punt (§7.3).
- `resend-webhook` werkt `mail_sends` bij, en de statustrigger spiegelt naar de bron.
- **De gaten van §2 dicht:**
  - contracten en creditnota's krijgen een status;
  - vaste idempotentiesleutels;
  - de inlogcode en de annulering tellen mee voor de limiet;
  - de Gerrie-agent gebruikt `RESEND_FROM_EMAIL`.
- **De eigen `Message-ID`** voor elke mail, en `In-Reply-To` en `References` bij antwoorden en
  herinneringen. De `reply+`-route gebruikt het gesprek van het oorspronkelijke bericht.
- **Documentgesprekken** in `client_emails` (factuur, offerte, contract) en het filter *Soort:
  documenten*.
- ***Bekeken*** in Financiën en bij offertes, en het Gerrie-signaal op `client_viewed`.

Dit is op zichzelf waardevol en verkleint het risico van alles wat volgt.

### Fase 2 · Microsoft 365: koppelen, lezen, alles versturen (± 3 weken)

- `mailboxes` (Microsoft, ook gedeelde postvakken) en `mailbox-sync` (delta, meldingen, verlengen,
  inlezen, de wachtrij van Microsoft).
- `register_mailbox_message`, `mailbox_match_preview`, bijlagen naar R2, en bounces uit de mailbox.
- `organization_mail_routes` en de route via Microsoft in `sendOrgMail`, voor:
  - klantmail;
  - offertes en contracten;
  - facturen, herinneringen, aanmaningen en creditnota's;
  - de afspraakmails (zonder ICS);
  - bestanden;
  - het portaal en de codes.
- Terugval (vanaf het eigen domein als dat geverifieerd is), tempo en voorrang.
- **Scherm:**
  - Instellingen → E-mail (Mailboxen, Verzenden);
  - na het koppelen het voorstel om het domein ook bij ResoFly klaar te zetten;
  - *Van* in Berichten;
  - de statussen in Financiën;
  - de melding bij een kapotte koppeling;
  - de stap bij Inrichten.
- Verder: logboek, vertrek van een teamlid, exportmanifest, en
  `docs/setup/MAILBOX_KOPPELEN_SETUP.md`.

### Fase 3 · Andere mailboxen: IMAP en SMTP (± 3 weken)

- `workers/mail-engine`:
  - de Worker: cron, `/poke`, `/test`;
  - de container: Node 22 met imapflow, nodemailer en postal-mime;
  - leases, IDLE, de wachtrij, `APPEND`, de controle in Verzonden en bounces.
- Instellen: zoeken, presets, testen per stap, de uitleg voor Gmail en iCloud.
- Netjes tegen hosters, SSRF.
- Dezelfde routes als bij Microsoft; het scherm hoeft niet te weten welke soort mailbox het is.
- Deployen met de hand, zoals de andere workers.

### Fase 4 · Werken vanuit Berichten (± 2 weken)

- Gedeelde mailboxen in Berichten: wie mag versturen, en een handtekening per mailbox.
- Versturen ongedaan maken: 10 seconden in de wachtrij voor wat je met de hand verstuurt.
- Gerrie antwoordt in hetzelfde gesprek, en een leeshandeling `mailbox.list`.
- *Oude mail van deze klant ophalen* in het klantdossier.
- Een kaart op de beslislijst bij een kapotte koppeling.
- Telefoon: *Van* als compacte keuze, en bijlagen in een strook.
- Het doorstuuradres wordt in Instellingen plan B (ingeklapt).

### Fase 5 · Afspraken volledig via de mailbox (± 1–2 weken)

- Uitnodigingen en annuleringen uit een ResoFly-agenda via de mailbox: de organisator wordt het echte
  adres in plaats van `organizer+…`.
- Antwoorden op uitnodigingen uit de mailbox naar de bestaande RSVP-verwerking.
- Een route *de mailbox van de vaste contactpersoon* (accountlead) voor klantmail en offertes.

### Fase 6 · Later, als er vraag naar is

- Gelezen-status heen en weer.
- App-only-rechten met beperking per postvak (RBAC for Applications) voor bedrijven die geen tokens
  van een medewerker willen.
- Gmail via OAuth (na de CASA-audit).
- Inkoopfacturen uit de mailbox: een regel per map of adres naar de factuurinbox.
- Meer engine-instanties.

De weken zijn een schatting voor één ontwikkelaar met AI, inclusief tests en documentatie. Samen
ongeveer 12 tot 14 weken tot en met fase 5.

---

## 17 · Kosten en capaciteit

- **Container:** één instance `basic` (¼ vCPU, 1 GiB), altijd aan. Cloudflare rekent sinds november
  2025 alleen de CPU die echt gebruikt wordt; geheugen en schijf op wat je toewijst. Reken op een paar
  tientjes per maand, of minder; controleer de actuele prijstabel. Eén instance kan naar schatting
  honderden tot ongeveer duizend IMAP-mailboxen aan.
- **Supabase:** een melding van Microsoft kost één aanroep, plus de cron elke minuut. Dat blijft ruim
  binnen het tegoed van Pro.
- **R2:** bijlagen, ingelezen `.eml`'s en de `.eml`'s *zoals verstuurd*. De grootste post. Een
  quotum per abonnement is beslissing 13.
- **Resend:** minder verkeer. Maar wie ook via ResoFly vanaf zijn eigen domein wil versturen
  (terugval, marketing), heeft een domein bij Resend nodig (§7.4). Pro heeft er 10. Daarboven
  extra domeinen (100 voor $20 per maand) of Scale (1.000 domeinen, vanaf $90 per maand).
  Controleer de actuele prijzen.
- **Microsoft en hosters:** gratis. Lidmaatschap van het Microsoft AI Cloud Partner Program ook.

---

## 18 · Beslissingen

| # | Vraag | Voorstel | Wie |
|---|---|---|---|
| 1 | Wat gaat via de mailbox? | Alles naar klanten (§5), behalve marketing | Gerjan, 11 november: ja, ook documenten |
| 2 | Terugval als de mailbox niet werkt? | Documenten, afspraken, bestanden en portaal via ResoFly, met melding; per organisatie *wachten* te kiezen. Klantmail nooit stil. | Gerjan |
| 3 | Codes via de mailbox? | Ja, niet in Verzonden; na 10 seconden via ResoFly | Gerjan |
| 4 | Marketing via de mailbox? | Nee, het verzenddomein blijft | Voorstel |
| 5 | Trackingpixel? | Nee; *Bekeken* via de pagina | Gerjan |
| 6 | Wat halen we binnen? | Per mailbox; standaard *alleen klantmail* | Gerjan |
| 7 | Hoe ver terug bij koppelen? | 90 dagen; keuze 30 / 90 / 365 | Gerjan |
| 8 | Microsoft-rechten? | Alles in één toestemming (`Mail.ReadWrite`, `Mail.Send` en de `.Shared`-varianten) | Gerjan |
| 9 | Bijlagen en `.eml` bewaren? | Ja; bijlagen tot 25 MB | Gerjan |
| 10 | Documentgesprekken in Berichten? | Zodra de klant antwoordt, of via het filter | Voorstel |
| 11 | Waar draait de mail-engine? | Cloudflare Containers; Fly.io als fase 0 problemen geeft | Na fase 0 |
| 12 | Gmail? | App-wachtwoord via IMAP; OAuth bij genoeg vraag | Gerjan |
| 13 | Mailboxen per abonnement, en opslag? | Open | Gerjan |
| 14 | Wie stelt routes in, wie koppelt? | Routes: eigenaar en beheerders. Persoonlijke mailbox: elk teamlid met schrijfrecht op Klanten. | Voorstel |
| 15 | Versturen via ResoFly vanaf het eigen domein? | Ja: altijd als het domein geverifieerd is, en bij het koppelen van een mailbox meteen voorstellen. Resend uitbreiden met extra domeinen zodra er meer dan 10 nodig zijn. | Gerjan, 11 november: ja, gevraagd |

---

## 19 · Testen

- **Gouden tests voor de verzendlaag** (fase 1): per verzendpunt de Resend-payload van vóór en na de
  overstap naast elkaar. Alleen de bewuste reparaties mogen verschillen.
- **`npm test`** (app en `_shared`, ook onder Node):
  - `resolveMailRoute` (elke route, elke terugval, een persoonlijke mailbox van een ander, een
    mailbox van een andere organisatie);
  - de terugval vanaf het adres van de mailbox: met een geverifieerd domein, met een domein dat
    net zijn verificatie kwijt is, en zonder domein (dan het adres van ResoFly met `Reply-To`);
  - de MIME-bouwer (koppen, `cid`-logo, ICS, PDF en UBL);
  - het herkennen van bounces met de echte voorbeelden;
  - presets en autoconfig, de SSRF-controle, `secretBox`;
  - de statuslabels.
- **Edge functions:** `mailboxes` en `mailbox-sync` in de `deno check`-lijst (`frontend-checks.yml`).
  Tests met een nep-Graph:
  - meldingen (`validationToken`, een verkeerde `clientState`);
  - delta;
  - `sendMail` met `429`;
  - een gedeeld postvak zonder *Send As*.
- **Mail-engine:** tegen een IMAP/SMTP-server in Docker (GreenMail):
  - inlezen en IDLE;
  - `uidvalidity`;
  - tempo;
  - `APPEND`;
  - een crash tijdens het versturen;
  - een fout wachtwoord.
- **Database** (`supabase db start`):
  - ontdubbelen over doorsturen, mailbox en de kopie in Verzonden;
  - een verzonnen `References` (moet naar de opvangbak);
  - `In-Reply-To` op onze eigen `Message-ID` vanaf een onbekend adres (moet in het gesprek);
  - organisatiegrenzen;
  - de module per soort in `mail_sends`;
  - een factuurgesprek en het antwoord van de klant erop, voor een teamlid met Klanten maar zonder
    Financiën (moet onzichtbaar zijn);
  - `imported` zonder triggers.
- **`tests/stromen/`:**
  - factuur versturen via een Microsoft-mailbox (nep-Graph) → *Verstuurd vanuit…* → de klant
    antwoordt → het antwoord in het gesprek van de factuur;
  - een herinneringsronde met tempo;
  - een kapotte mailbox → terugval met melding;
  - een bounce → *Kwam niet aan*.
- **`actionTenancy.test.ts`** voor de nieuwe parameters van Gerrie.
- **`npm run test:mobile -- --theme=both`:** Instellingen → E-mail, Berichten met *Van* en
  documentgesprekken, Financiën met de nieuwe statussen.
- **`npm run test:inrichten`:** de stap *Koppel je mailbox*.

---

## 20 · Inrichten (voor de setup-handleiding)

- **Entra:** app "ResoFly Mail".
  - Redirect: `…/functions/v1/mailboxes`.
  - Rechten: §9.1.
  - Uitgeversverificatie.
- **Secrets voor de edge functions:**
  - `MICROSOFT_MAIL_CLIENT_ID`, `MICROSOFT_MAIL_CLIENT_SECRET`, `MICROSOFT_MAIL_TENANT_ID`;
  - `MAILBOX_OAUTH_STATE_SECRET`, `MAILBOX_REDIRECT_URL`, `MAILBOX_ALLOWED_RETURN_ORIGINS`;
  - `MAILBOX_MS_TOKEN_KEY`, `MAILBOX_IMAP_SECRET_KEY`, `MAILBOX_SYNC_CRON_SECRET`;
  - `MAIL_ENGINE_URL`, `MAIL_ENGINE_SECRET`.
- **Cron:** `mailbox-sync-tick` elke minuut (in `scripts/supabase-setup-webhooks.sh`).
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
- Microsoft Graph, abonnementen en lifecycle-meldingen:
  [subscription resource type](https://learn.microsoft.com/graph/api/resources/subscription),
  [Outlook change notifications](https://learn.microsoft.com/graph/outlook-change-notifications-overview).
- Cloudflare Containers:
  [pricing](https://developers.cloudflare.com/containers/pricing/),
  [container class](https://developers.cloudflare.com/containers/reference/container-class/),
  [FAQ](https://developers.cloudflare.com/containers/faq/).
- Cloudflare Workers en TCP:
  [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/).
- Resend, domeinen per abonnement (Pro 10, Scale 1.000, extra domeinen per 100):
  [pricing](https://resend.com/pricing),
  [Introducing the Scale plan](https://resend.com/blog/introducing-the-scale-plan).
- Mailrechten bij Microsoft en toestemming van een beheerder: indicatief, uit Microsoft Q&A en
  [Nylas over uitgeversverificatie](https://support.nylas.com/hc/en-us/articles/28841177145117-Understanding-This-App-May-Be-Risky-Warnings-Post-Publisher-Verification).
  Fase 0 test dit in een echte tenant.
- De grenzen van Exchange Online (30 berichten per minuut, 10.000 ontvangers per dag) en van
  Supabase Edge Functions (poorten 25 en 587, tijdslimiet) staan in hun documentatie. Controleer ze
  bij de bouw.
