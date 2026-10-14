# Onderzoek — Een mailclient met je eigen mailadressen via IMAP (2026-10-14)

Vraag: *zijn er mogelijkheden om een mailclient te bouwen waar ik via IMAP gewoon mijn
mailadressen in kan laden?*

Kort antwoord: **ja, en een groot deel van het fundament ligt er al.** De verwerking van
inkomende mail (vastleggen, dedupliceren, aan een klant koppelen, opvangbak), de pagina
Berichten, versleutelde opslag van inloggegevens en zelfs ruwe TCP/TLS-verbindingen vanuit de
edge functions zijn gebouwd. Wat ontbreekt is de kern: een gekoppelde mailbox per persoon en
een sync-motor die IMAP spreekt.

Maar "gewoon via IMAP" klopt maar voor een deel van de adressen:

- **Hostingpartijen** (TransIP, Strato, Hostnet, Antagonist, one.com, Vimexx, alles met
  cPanel/Plesk/DirectAdmin), **iCloud** en **Yahoo**: mailadres + (app-)wachtwoord, klaar.
- **Microsoft 365 en Outlook.com/Hotmail**: inloggen met een wachtwoord via IMAP is uitgezet
  (zakelijk sinds eind 2022, privé sinds september 2024). Het moet via *Inloggen met Microsoft*
  (OAuth). Goed te doen: de Microsoft-koppeling voor de agenda bestaat al.
- **Gmail en Google Workspace**: ook alleen OAuth (Workspace sinds maart 2025), en hier zit de
  echte drempel. Wie Gmail-inhoud via een server leest, moet door Google's verificatie **plus
  een jaarlijkse beveiligingsaudit (CASA)**. Tot die tijd: app-wachtwoord of het bestaande
  doorstuuradres.

De belangrijkste keuze is niet technisch maar inhoudelijk: **wat moet de mailclient zijn?**

1. **Mailbox koppelen.** Je koppelt je adressen één keer. Alle mail van én naar klanten (ook
   wat je op je telefoon of in Outlook verstuurt) komt vanzelf in het klantdossier en op
   Berichten, en je antwoordt vanuit ResoFly vanaf je eigen adres, met een kopie in je eigen
   map Verzonden. De doorstuurregel is dan niet meer nodig.
2. **Volledige mailclient.** Je hele postvak in ResoFly: alle mappen, nieuwsbrieven, privémail,
   zoeken, verplaatsen, concepten. Een vervanger van Outlook of Gmail.

**Advies:** bouw eerst *Mailbox koppelen*, met een sync-motor die zo is opgezet dat een volledige
postvakweergave er later bovenop kan. Begin met IMAP + wachtwoord, daarna Microsoft via
Microsoft Graph, en Gmail-OAuth pas na een bewuste beslissing over de audit.

Dit document is onderzoek, geen bouwopdracht: er is nog geen regel code veranderd.

---

## 1 · Wat er al ligt

Onderzocht in de huidige `staging`-stand (`b6d1d6d`).

| Bouwsteen | Waar | Wat het nu doet | Waarde voor een mailclient |
|---|---|---|---|
| Inkomende-mailpijplijn | `supabase/functions/mail-inbound/index.ts`, `register_inbound_message()` (`supabase/migrations/20260815000000_inbound_doorstuuradres.sql:570`) | Vastleggen, dedupliceren, afzender herkennen, aan een klant koppelen of in de opvangbak; automatische mail en lussen herkennen (`classifyInbound`, `mail-inbound/index.ts:666`) | Een mailbox-sync levert precies dezelfde feiten aan. Eén nieuwe herkomst (`route = 'imap'`, check-constraint op `…doorstuuradres.sql:355`) en de hele koppel- en opvanglogica doet mee |
| Dossier-idempotentie | `uidx_client_emails_inbound_rfc` (`…doorstuuradres.sql:304`) | Eén inkomend bericht per Message-ID per organisatie | Komt dezelfde mail binnen via het doorstuuradres én via de mailbox, dan staat hij één keer in het dossier |
| Header-threading | `…doorstuuradres.sql:533` | Een antwoord landt in het juiste gesprek binnen de al gevonden klant | Werkt net zo voor mail uit de mailbox |
| MIME-parser | `workers/email-inbound/src/index.ts` (postal-mime) | Ruwe mail uitpakken, kop-whitelist, plafond op tekst en bijlagen | postal-mime is puur JavaScript: dezelfde parser werkt in Deno, Workers en Node |
| Klantgesprekken | `client_email_threads` + `client_emails` (`supabase/migrations/20260620000003_client_emails.sql`) | Tweerichtingsmodel (in/uit), statussen, `provider`, `metadata` | Het doel voor klantmail uit de mailbox, met `provider = 'imap'` of `'graph'` |
| Leesstatus per persoon | `client_email_reads` (`supabase/migrations/20260701000001_client_email_reads.sql`) | Ongelezen per gebruiker, live badge | Zelfde patroon voor de mailbox, al moet "gelezen" daar ook terug naar de mailserver |
| Berichten | `src/features/Communication.tsx`, `src/lib/communication.ts:15` (`ConversationKind`) | Alle klantgesprekken, ongelezen, opvangbak, antwoorden in hetzelfde gesprek, telefoon-lay-out | De plek voor mail uit de mailbox, en later voor een tab *Postvak* |
| Doorstuuradres | `organization_inbound_aliases`, `InboundForwardingCard` (`src/features/SimplePages.tsx:410`) | Klantmail komt binnen via een doorstuurregel bij de eigen provider | Blijft de terugvaloptie. Een gekoppelde mailbox doet hetzelfde zonder doorstuurregel, en vangt ook je *verzonden* mail |
| Eigen verzenddomein + persoonlijke afzender | `supabase/functions/_shared/sendingDomain.ts:10,72` | Versturen via Resend vanaf `naam@eigendomein.nl`, met aflever- en bouncestatus | Antwoorden vanaf je eigen adres kan al; wat ontbreekt is de kopie in je eigen map Verzonden |
| Versleutelde inloggegevens | `supabase/functions/_shared/calendarCore.ts:417-438` (AES-GCM) | Agenda-tokens van Google/Microsoft versleuteld bewaren en verversen | Hetzelfde schema voor mailwachtwoorden en mail-tokens, met een eigen sleutel |
| Google/Microsoft-koppeling | `supabase/functions/calendar-integrations/index.ts`, scopes in `calendarCore.ts:139-155` | *Inloggen met Google/Microsoft* voor agenda en contacten | Dezelfde app-registraties; mail is een uitbreiding van de rechten (§2) |
| Ruwe TCP/TLS-verbinding | `supabase/functions/_shared/webhookTransport.ts:248,266` (`Deno.connect` + `startTls`) | Webhooks versturen over een verbinding die vastligt op een gecontroleerd adres | Bewijst dat onze edge-runtime ruwe TCP + TLS spreekt: precies wat IMAP (poort 993) nodig heeft |
| Adrescontrole (SSRF) | `isPrivateAddress()` (`supabase/functions/_shared/webhooks.ts:280`), `_shared/pinnedGet.ts` | Weigert interne en privé-adressen | Een gebruiker vult zelf een mailserver in; dezelfde controle is nodig |
| Cron met lease | pg_cron + pg_net, `claim_due_agents()` (`supabase/migrations/20260715000000_gerrie_scheduled_agents.sql:241`); het `claim_*`-patroon staat acht keer in de migraties | Elke minuut een kleine batch werk claimen, de rest naar de volgende tik | Precies het patroon voor "elke paar minuten de mailboxen bijwerken" |
| Cloudflare Containers | `workers/office-server/` (Collabora) | Een langlopend proces achter een Durable Object | De optie voor een altijd-verbonden sync (nieuwe mail binnen seconden) |
| Opslag met quotum | `workers/media-api`, `assertStorageCapacity()` (`workers/media-api/src/index.ts:765`) | Bestanden per organisatie met een GB-grens per abonnement | Bijlagen van klantmail, die meetellen in het quotum |
| Modulerechten | `src/lib/permissions.ts:43` (module Klanten omvat "klant-e-mail") | Wie klantmail mag zien | Klantmail uit een mailbox valt hier gewoon onder; de mailbox zélf is persoonlijk (§4.2) |

**Wat er níét is:** geen begrip "gekoppelde mailbox", geen IMAP- of SMTP-code, geen
sync-toestand per map, geen persoonlijke zichtbaarheid (alle mailtabellen zijn nu
organisatiebreed leesbaar), en geen manier om via de eigen mailserver te versturen. In code en
documentatie staat geen eerder spoor van IMAP: dit is een groen veld bovenop een sterke basis.

---

## 2 · De harde grens: hoe je mag inloggen verschilt per provider

IMAP zelf is overal hetzelfde protocol. Het verschil zit in het inloggen, en dat bepaalt de route
meer dan wat ook.

| Provider | Inloggen via IMAP | Wat ResoFly nodig heeft | Drempel |
|---|---|---|---|
| Hostingpartij (TransIP, Strato, Hostnet, Antagonist, one.com, Vimexx, cPanel/Plesk/DirectAdmin) | Mailadres + wachtwoord; IMAP 993, SMTP 465 of 587 | Formulier met automatische serverherkenning en een test | Geen |
| iCloud, Yahoo | App-specifiek wachtwoord, dat de gebruiker zelf aanmaakt | Hetzelfde formulier + korte uitleg per provider | Laag |
| Microsoft 365 (zakelijk) | Wachtwoord-IMAP staat sinds eind 2022 definitief uit; alleen OAuth | De bestaande Microsoft-app uitbreiden met mailrechten, bij voorkeur via Microsoft Graph in plaats van IMAP (§3) | Middel: uitgeververificatie, en sommige bedrijven laten alleen hun beheerder toestemming geven |
| Outlook.com / Hotmail / Live (privé) | Sinds 16 september 2024 alleen nog OAuth | Zelfde Microsoft-app | Middel |
| Google Workspace | Sinds 14 maart 2025 geen gewone wachtwoorden meer; OAuth, of een app-wachtwoord als de beheerder dat toestaat | IMAP-scope `https://mail.google.com/` of Gmail API-scopes, beide *restricted* | **Hoog**, zie hieronder |
| Gmail (privé) | OAuth; een app-wachtwoord met tweestapsverificatie werkt vooralsnog | Idem | Idem, of app-wachtwoord als tussenoplossing |

**Microsoft, versturen.** Versturen via Microsoft's SMTP-server met een wachtwoord werkt nog, maar
staat op de lijst: eind december 2026 gaat het voor bestaande omgevingen standaard uit (een
beheerder kan het nog terugzetten), en in de tweede helft van 2027 maakt Microsoft de definitieve
einddatum bekend. Daar bouw je niet op; versturen gaat via Graph (`sendMail`).

**Google, de audit.** Voor IMAP met OAuth vraagt Gmail de scope `https://mail.google.com/`, en
die is *restricted*, net als de leesscopes van de Gmail API (`gmail.readonly`, `gmail.modify`).
Een app die zo'n scope gebruikt en de mail via een server verwerkt, moet:

- door Google's OAuth-verificatie (privacyverklaring, demovideo, onderbouwing waarom de scope
  nodig is), en
- een **CASA-beveiligingsaudit** laten doen door een door Google erkend lab, **elk jaar
  opnieuw**. Bij TAC Security kostte Tier 2 volgens de laatst gepubliceerde prijslijst
  $540–720 per jaar per app. Het hele traject duurt weken tot maanden, en herstelwerk na
  bevindingen komt daar nog bij.

Zonder verificatie kan het alleen in *testmodus*: een beperkte groep vooraf opgegeven gebruikers,
van wie de toegang elke 7 dagen verloopt. Prima voor een proef met je eigen adres, niet voor een
product. Alleen *versturen* via de Gmail API (`gmail.send`) is "sensitive" in plaats van
"restricted": wel de (lichtere) verificatie, geen audit.

**Wat "gewoon mijn mailadres invullen" in de praktijk wordt.** De gebruiker typt zijn adres.
ResoFly zoekt de MX-records op (wijzen die naar Google of Microsoft, dan verschijnt de knop
*Inloggen met Google/Microsoft*), probeert daarna de Thunderbird-database (ISPDB),
`autoconfig.<domein>` en de SRV-records uit RFC 6186, en vult de servergegevens zelf in. De
gebruiker ziet alleen nog een wachtwoordveld en een knop *Test en koppel*.

---

## 3 · Waar de verbinding draait

IMAP is geen HTTP: het is een blijvende TCP-verbinding met TLS. `fetch()` kan dat niet; er is een
plek nodig die ruwe sockets mag openen.

| Plek | Kan het? | Grenzen | Past bij |
|---|---|---|---|
| **Supabase Edge Function** (Deno) | Ja: `Deno.connect` + `startTls` zijn al in gebruik (`webhookTransport.ts`) | 2 s CPU per aanroep (wachten op het netwerk telt niet mee), 150 s (gratis) / 400 s (betaald) looptijd. **Uitgaande verbindingen naar poort 25 en 587 zijn geblokkeerd**, dus SMTP alleen via 465. Geen verbinding die blijft openstaan | Ophalen (polling) elke 1–2 minuten in kleine batches, met cron + lease zoals de Gerrie-routines |
| **Cloudflare Worker** (`connect()` uit `cloudflare:sockets`, of `node:net` met `nodejs_compat`) | Ja | Poort 25 geblokkeerd; geen Cloudflare-, localhost- of privé-adressen; een verbinding leeft niet langer dan het verzoek (een Durable Object kan hem vasthouden, maar betaalt dan voor de looptijd) | Ophalen, en SMTP via 587 met STARTTLS |
| **Container** (Cloudflare Containers zoals `workers/office-server`, of een kleine VPS) | Ja: gewone Node.js met beproefde bibliotheken (ImapFlow, Nodemailer) | Een proces dat altijd draait, dus vaste kosten en beheer. De office-server zelf staat nog als proef te boek | IMAP IDLE (nieuwe mail binnen seconden), de volledige mailclient, grote mailboxen |

Twee gevolgen:

- **Microsoft 365 verstuurt alleen via poort 587**, en die is vanuit Supabase dicht. Nog een reden
  om Microsoft via Graph te doen: lezen (met delta-sync en meldingen bij nieuwe mail), versturen en
  mappen gaan dan allemaal over HTTPS, zonder IMAP of SMTP. De meldingen zijn abonnementen die
  periodiek verlengd moeten worden; dat past in dezelfde cron.
- **Ophalen per 1–2 minuten is voor klantmail ruim voldoende.** "Binnen seconden" vraagt een
  blijvende verbinding per mailbox, en dus een container. Dat is pas nodig bij de volledige
  mailclient.

Open punt voor de proef (§8, fase 0): of ImapFlow via `npm:` in de Supabase-runtime draait (hij
leunt op Node's `net`/`tls`), of dat we, zoals bij `webhookTransport.ts`, een kleine eigen
IMAP-client schrijven die alleen doet wat de sync nodig heeft. De parser is geen open punt:
postal-mime is puur JavaScript.

---

## 4 · Ontwerpkeuzes die vóór het bouwen vast moeten staan

### 4.1 Wat bewaren we?

| Niveau | Wat | Gevolg |
|---|---|---|
| a. Alleen klantmail | Van mail van en naar klanten een kopie in het dossier; van de rest alleen de sync-toestand (welke berichten al bekeken zijn) | Minste opslag en AVG-impact; de mailbox blijft bij de provider |
| b. Kop-cache + inhoud op aanvraag | Afzender, onderwerp, datum en vlaggen van het hele postvak; de inhoud wordt live opgehaald bij openen | Nodig voor een postvakweergave: snel bladeren, openen kost een tel |
| c. Volledige kopie | Alles, inclusief bijlagen | Veel opslag, maximale AVG-impact, twee waarheden |

Voorstel: **a** voor *Mailbox koppelen*, **b** pas voor de volledige mailclient, **c** nooit.

### 4.2 Wie ziet wat?

Een mailbox is persoonlijk: privémail, mail over andere zaken, en elke "wachtwoord
vergeten"-mail. De bestaande mailtabellen zijn organisatiebreed leesbaar (`can_read_org`); een
mailbox niet.

- **Persoonlijk is de standaard.** Gekoppelde mailboxen en alles wat daarvan bewaard wordt: alleen
  de eigenaar (RLS op `owner_user_id = auth.uid()`).
- **Klantmail gaat naar het dossier, en het dossier is van het team.** Zo werkt het doorstuuradres
  nu ook. Per mailbox een schakelaar *Klantmail delen met het team* (standaard aan), en een map
  *Privé* die altijd buiten blijft.
- **Gedeelde adressen** (info@, support@) zijn zichtbaar voor collega's die de eigenaar aanwijst.
- **Eén mailbox hoort bij één organisatie.** Klanten worden alleen dáárin gezocht; de organisatie
  komt uit de mailbox, nooit uit de afzender. Dat is dezelfde regel als bij het doorstuuradres
  (`…doorstuuradres.sql`, ontwerpkeuze 1).
- **De boekhouder** ziet niets: klantmail valt onder de module Klanten, en die heeft het
  gastaccount niet.
- **Gerrie en MCP** zien alleen klantmail, nooit de mailbox, en behandelen de inhoud als tekst,
  niet als opdracht. Zoals nu.

### 4.3 Wachtwoorden

Een IMAP-wachtwoord is de sleutel tot de hele mailbox, en via "wachtwoord vergeten" tot elk ander
account van die persoon. Dus:

- versleuteld met een **eigen sleutel** (`MAIL_ACCOUNT_ENCRYPTION_KEY`, AES-GCM zoals
  `calendarCore.ts`), los van de agendasleutel;
- nooit terug naar de browser, en bij opslaan eerst testen;
- bij ontkoppelen direct weg, en elke koppeling en ontkoppeling in het auditlog;
- een app-wachtwoord aanraden waar de provider dat kent, en OAuth waar het kan (intrekbaar en
  begrensd).

### 4.4 De server die de gebruiker invult

Wie een servernaam invult, laat onze server verbinding maken met een adres naar keuze. Dat is
SSRF, net als bij webhooks: dezelfde `isPrivateAddress()`-controle, verbinden met het
gecontroleerde adres (zoals `webhookTransport.ts` doet), en alleen de poorten 993, 143, 465 en 587.

### 4.5 Versturen

| Route | Goed | Let op |
|---|---|---|
| Via de eigen SMTP-server (465) | Echt vanaf je eigen server, met je eigen SPF/DKIM | Een kopie in Verzonden alleen als de server dat zelf doet (Gmail wel, de meeste hostingpartijen niet), anders zelf plaatsen met IMAP `APPEND` |
| Via Resend vanaf het geverifieerde domein + `APPEND` naar Verzonden | Aflever-, open- en bouncestatus blijven werken; de verzendkant bestaat al | Alleen vanaf een geverifieerd eigen domein, niet vanaf een gmail.com- of hotmail.com-adres (DMARC) |
| Via Graph / Gmail API | Netjes in Verzonden, geen poortproblemen | Alleen Microsoft/Google |

Voorstel: Resend + `APPEND` waar het domein geverifieerd is (dan blijft de tracking werken),
anders de eigen SMTP-server; Microsoft via Graph.

### 4.6 Eerste koppeling en grote mailboxen

- De eerste keer alleen Postvak IN en Verzonden, en alleen de **laatste 90 dagen**.
- Daarna per map alleen wat nieuw is: `UIDVALIDITY` + `UIDNEXT`, en waar de server het
  ondersteunt `CONDSTORE`/`HIGHESTMODSEQ` voor gewijzigde vlaggen.
- De map Verzonden heet overal anders ("Sent", "Verzonden items", "INBOX.Sent", "Sent
  Messages"): eerst de SPECIAL-USE-vlag `\Sent` (RFC 6154), dan de naam.
- Eén verbinding per mailbox, nooit parallel (providers begrenzen het aantal verbindingen per
  account). De lease per mailbox regelt dat.

### 4.7 Terugschrijven

Toont ResoFly het hele postvak (niveau b), dan moeten lezen, verplaatsen en verwijderen terug naar
de server (`\Seen`, `MOVE`, `EXPUNGE`), anders zijn er twee waarheden. Bij niveau a is dat niet
nodig: de klantkopie in het dossier is een bewuste registratie, net als nu.

### 4.8 AVG

ResoFly verwerkt dan mail namens de klant. Bij niveau a is dat weinig meer dan wat het
doorstuuradres nu al doet. Bij b of c wordt het een wezenlijke uitbreiding: verwerkersovereenkomst
en privacyverklaring bijwerken, een bewaartermijn vastleggen, en bij ontkoppelen alles wat uit de
mailbox kwam (behalve het dossier) weggooien. Een externe dienst (§5, route C) is een extra
subverwerker, en bij Nylas een Amerikaanse.

---

## 5 · Vier routes naast elkaar

| Route | Wat je krijgt | Wat er gebouwd moet worden | Kosten | Grootste risico |
|---|---|---|---|---|
| **A. Mailbox koppelen** (eigen bouw) | Klantmail in én uit automatisch in dossier en Berichten, ook wat je op je telefoon verstuurt; antwoorden vanaf je eigen adres met kopie in Verzonden; doorstuurregel overbodig | Sync-motor, koppelscherm, versleuteling, versturen | Geen licentie | IMAP-eigenaardigheden per provider |
| **B. Volledige mailclient** (eigen bouw) | Het hele postvak in ResoFly: mappen, zoeken, verplaatsen, concepten, bijlagen, meerdere adressen in één postvak | A + kop-cache, terugschrijven, zoeken, concepten, waarschijnlijk een container | Opslag + container | Nooit af; concurreert met Outlook, Gmail en Apple Mail, terwijl je op je telefoon tóch de eigen mail-app gebruikt |
| **C. Mail-API als dienst** (Nylas, Unipile) | Eén API voor Gmail, Microsoft en IMAP, met webhooks | Koppelscherm, opslag, UI; geen sync-motor | Nylas: $15/mnd inclusief 5 mailboxen, daarna ~$1,50–2 per mailbox per maand. Unipile: ~€5 per mailbox per maand (minimaal €49). Nylas' gedeelde Google-app (geen eigen audit) alleen op contractbasis | Afhankelijkheid, kosten groeien per mailbox, mail loopt via een derde |
| **D. EmailEngine** (zelf gehost) | IMAP, SMTP, Gmail en Graph achter één REST-API met webhooks | Hosting (Node + Redis) en koppeling | Vaste jaarlicentie (~$995–1.450), onbeperkt mailboxen | Eigen beheer; de Google-audit blijft nodig voor Gmail-OAuth |

De Google-audit verdwijnt bij eigen bouw en bij EmailEngine niet. Nylas biedt op contractbasis een
gedeelde Google-app die de audit al heeft doorstaan; bij Unipile vooraf navragen hoe dat zit.

---

## 6 · Voorgesteld datamodel (schets)

```
mail_accounts                -- één rij per gekoppeld adres
  id, organization_id, owner_user_id
  email, display_name
  provider            'imap' | 'microsoft' | 'google'
  imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, username
  secret_encrypted    -- wachtwoord of refresh-token (AES-GCM, eigen sleutel)
  visibility          'personal' | 'shared'
  share_client_mail   boolean   -- klantmail naar het dossier (het team ziet het)
  sync_since          date      -- standaard vandaag − 90 dagen
  status              'active' | 'auth_failed' | 'paused' | 'error'
  last_sync_at, next_sync_at, lease_until, last_error

mail_account_members         -- wie een gedeeld adres mag zien (alleen bij 'shared')

mail_folders                 -- sync-toestand per map
  mail_account_id, path, role ('inbox' | 'sent' | …)
  uidvalidity, uidnext, highestmodseq, last_synced_at

-- bestaand, kleine uitbreidingen:
inbound_messages.route       + 'imap'
client_emails.provider       'imap' | 'graph'   (metadata: mail_account_id, map, uid)
-- unieke Message-ID-index ook voor uitgaand (zie §7.1)
```

Pas bij de volledige mailclient (niveau b) komt er een `mail_messages`-kop-cache bij.

---

## 7 · Valkuilen die ik nu al zie

1. **Wat ResoFly zelf verstuurt, komt terug via Verzonden.** Een antwoord dat via Resend vertrekt
   en met `APPEND` in Verzonden belandt, ziet de sync daarna als "nieuwe uitgaande mail". De
   unieke Message-ID-index op `client_emails` geldt nu alleen voor *inkomend*
   (`…doorstuuradres.sql:304`). Voor uitgaand moet er een bij, en `APPEND` moet dezelfde
   Message-ID dragen als de verstuurde mail.
2. **Eén fout wachtwoord, en de provider blokkeert.** Hostingpartijen sluiten een account of IP af
   na herhaalde mislukte pogingen. Bij de eerste weigering stoppen (`auth_failed`), de gebruiker
   een melding geven, en nooit blind opnieuw proberen.
3. **Gmail-labels zijn mappen.** Eén bericht staat in meerdere "mappen" tegelijk. Synchroniseren
   op Postvak IN en Verzonden en dedupliceren op Message-ID voorkomt dubbelingen.
4. **Eigen adressen als "klant".** Mail tussen collega's, of naar je eigen tweede adres, mag geen
   klant worden. De bestaande regel voor `forward_from_email` (die voorkomt dat het eigen adres
   als klant wordt gematcht) uitbreiden naar alle gekoppelde adressen en alle leden van de
   organisatie.
5. **De CPU-grens van 2 s.** Een batch van vijftig grote HTML-mails parsen kan erover gaan. Voor
   niet-klantmail alleen de kop ophalen (`ENVELOPE`), de volledige inhoud alleen voor klantmail,
   en kleine batches met lease, zoals Gerrie.
6. **Doorstuuradres en mailbox tegelijk.** Inkomend dedupt al op Message-ID; wel in het
   koppelscherm melden dat de doorstuurregel uit mag.
7. **Externe afbeeldingen zijn trackingpixels.** Bij een postvakweergave standaard blokkeren, met
   een knop *Afbeeldingen tonen*.
8. **Lussen.** Een automatisch antwoord op een automatisch antwoord: de bestaande classificatie
   (`classifyInbound`) hergebruiken.
9. **Ongelezen op twee plekken.** Lees je een mail op je telefoon, dan staat hij in ResoFly nog op
   ongelezen, tenzij de `\Seen`-vlag meekomt. Voor klantmail acceptabel (ResoFly's leesstatus is
   per persoon); voor een postvakweergave niet.

---

## 8 · Fasering en omvang

Geen urenschatting, wel eerlijk welke onderdelen eraan moeten.

**Fase 0: proef (klein, beslist de architectuur).** Eén tijdelijke edge function die op staging
inlogt op een handvol echte mailboxen (een hostingpartij, iCloud, Gmail met app-wachtwoord), van
Postvak IN en Verzonden de laatste vijftig koppen ophaalt, en meet hoeveel CPU dat kost. Uitkomst:
ophalen vanuit Supabase volstaat of er moet een container komen, en ImapFlow of een eigen kleine
client.

**Fase 1: Mailbox koppelen, IMAP met wachtwoord (de kern).** Migratie (`mail_accounts`,
`mail_folders`, route `'imap'`, uitgaande Message-ID-index), een edge function `mail-sync` (cron +
lease) met de IMAP-client, het scherm *Mijn mailadressen* (herkennen, testen, koppelen, status),
versleuteling, aansluiten op `register_inbound_message` voor inkomend en een nieuwe registratie
voor uitgaand, versturen via SMTP of Resend + `APPEND`, en een melding bij een mislukte koppeling.
Ter vergelijking: dit heeft de onderdelen van het doorstuuradres-blok van augustus (migratie,
functie, instellingenkaart, opvangbak), plus de IMAP-client, de sync-toestand en het versturen.
Reken op ruim meer dan dat blok.

**Fase 2: Microsoft via Graph.** De bestaande Microsoft-app uitbreiden met `Mail.ReadWrite` en
`Mail.Send`, delta-sync met meldingen bij nieuwe mail, versturen via `sendMail`, en
uitgeververificatie. Het datamodel uit fase 1 blijft; alleen de bron verschilt.

**Fase 3: Postvak (de volledige mailclient), alleen als dat de wens is.** Kop-cache van alle
mappen, inhoud op aanvraag, terugschrijven, zoeken, concepten, bijlagen, meerdere adressen in één
postvak, en waarschijnlijk een container voor IDLE.

**Fase 4: Gmail via OAuth.** Google-verificatie en de jaarlijkse audit, of alleen voor Gmail een
dienst als Nylas. Tot die tijd: app-wachtwoord (fase 1) of het doorstuuradres.

---

## 9 · Beslispunten (met mijn voorstel)

| Vraag | Voorstel | Waarom |
|---|---|---|
| Mailbox koppelen of volledige mailclient? | **Eerst koppelen** | De waarde van ResoFly is de klantcontext. Een volledige client is nooit af, en op je telefoon gebruik je toch de eigen mail-app. Juist wat je dáár verstuurt, vangt de koppeling via Verzonden |
| Welke providers eerst? | **IMAP met wachtwoord, dan Microsoft, dan Gmail** | Hangt af van waar de mailboxen van jou en je klanten zitten (zie §10) |
| Ziet het team klantmail uit mijn persoonlijke mailbox? | **Ja, met een schakelaar per mailbox**, en een map *Privé* die altijd buiten blijft | Het dossier is van het team; privé blijft privé |
| Hoe ver terug bij de eerste koppeling? | **90 dagen** | Genoeg context, geen jaren import |
| Ophalen of altijd verbonden? | **Ophalen elke 1–2 minuten** (Supabase) | Past op wat er staat; een container pas bij de volledige client |
| Eigen sync of een dienst? | **Eigen voor IMAP en Microsoft**; een dienst alleen overwegen voor Gmail | Vaste kosten per mailbox per maand tegenover één keer bouwen; een dienst is een extra (Amerikaanse) subverwerker |
| De Google-audit aangaan? | **Pas als duidelijk is hoeveel gebruikers Gmail of Workspace hebben** | Jaarlijks terugkerend; app-wachtwoord en doorstuuradres overbruggen |

---

## 10 · Advies

Begin met **fase 0**. Een korte proef beslist de grootste onbekende (past de sync in Supabase, of
is er een container nodig?) voordat er een datamodel ligt.

Bouw daarna **fase 1** als kern. Het is verleidelijk om meteen een volledige mailclient te bouwen,
maar het onderscheidende deel (klantmail die vanzelf in het dossier staat, ook wat je vanaf je
telefoon verstuurt) zit in de koppeling, niet in mappen en zoekfuncties die Outlook en Gmail al
jaren beter doen. Alles wat fase 1 bouwt (mailbox, versleuteling, sync-toestand, versturen) is
precies wat een postvakweergave later nodig heeft; er gaat niets verloren.

Voor de volgorde daarna is één ding nodig dat niet in deze codebase staat: **bij welke providers
de mailboxen zitten**, van jou en van de organisaties die ResoFly gebruiken. Zitten ze vooral bij
Microsoft 365, dan schuift fase 2 naar voren. Zitten ze vooral bij Google Workspace, dan wordt de
audit-beslissing (fase 4) de eerste vraag.

---

## Bronnen (externe feiten, gecontroleerd op 2026-10-14)

Prijzen en termijnen veranderen; check ze opnieuw vlak voor een beslissing.

- Supabase Edge Functions, limieten (CPU, looptijd, poort 25/587):
  [supabase.com/docs/guides/functions/limits](https://supabase.com/docs/guides/functions/limits)
- Cloudflare Workers, TCP sockets en `node:net`:
  [tcp-sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/),
  [nodejs/net](https://developers.cloudflare.com/workers/runtime-apis/nodejs/net/)
- Microsoft, einde Basic Auth in Exchange Online (IMAP/POP):
  [learn.microsoft.com](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online)
- Microsoft, IMAP/POP/SMTP met OAuth:
  [learn.microsoft.com](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)
- Microsoft, Outlook.com alleen nog moderne aanmelding (16 september 2024):
  [support.microsoft.com](https://support.microsoft.com/en-us/topic/c5d65390-9676-4763-b41f-d7986499a90d)
- Microsoft, SMTP AUTH Basic Auth, tijdlijn MC786329 (bijgewerkt januari 2026):
  [itelio.com](https://www.itelio.com/en/microsoft-message-center/MC786329)
- Google Workspace, overgang naar OAuth (14 maart 2025):
  [knowledge.workspace.google.com](https://knowledge.workspace.google.com/admin/sync/transition-from-less-secure-apps-to-oauth)
- Google, XOAUTH2 voor IMAP/SMTP (scope `https://mail.google.com/`):
  [developers.google.com](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)
- Nylas, Google-verificatie en beveiligingsaudit:
  [verificatiegids](https://developer.nylas.com/docs/dev-guide/provider-guides/google/google-verification-security-assessment-guide),
  [gedeelde Google-app](https://developer.nylas.com/docs/provider-guides/google/shared-gcp-app/)
- CASA-prijzen per lab:
  [switchlabs.dev](https://www.switchlabs.dev/post/casa-tier-2-tier-3-security-review-providers-pricing-and-the-cheapest-option)
- Google testmodus (toegang verloopt na 7 dagen):
  [unipile.com](https://www.unipile.com/google-oauth-refresh-token/)
- Prijzen: [Nylas](https://nylas.com/pricing/), [Unipile](https://www.unipile.com/pricing-api/),
  [EmailEngine](https://www.itechguides.com/best/email-apis/emailengine/)
