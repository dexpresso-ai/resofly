# Onderzoek — Telefoongesprekken loggen in ResoFly (2026-09-18)

Vraag: *kunnen telefoongesprekken ook in de app gelogd worden — telefoon koppelen,
op telefoonnummer opzoeken of er een bestaand contact bij hoort, enzovoort?*

Kort antwoord: **ja, en de app is er beter op voorbereid dan verwacht** — het
gesprekstype, de opvangbak voor niet-herkende post, de nummer-normalisatie en zelfs
de opname → transcript → AI-samenvatting-keten liggen er al. **Eén ding kan niet:**
het gesprekslog van een mobiele telefoon uitlezen. Dat is geen bouwprobleem maar een
platformgrens (zie §2). Automatisch loggen loopt daarom via de telefooncentrale,
niet via het toestel.

Dit document is onderzoek, geen bouwopdracht: er is nog geen regel code veranderd.

---

## 1 · Wat er al ligt en direct herbruikbaar is

Onderzocht in de huidige `staging`-stand. Per bouwsteen: waar hij staat en wat hij
voor deze functie waard is.

| Bouwsteen | Waar | Waarde voor gesprekken |
|---|---|---|
| `Conversation`-union (`email \| ticket`) | `src/lib/communication.ts:51` | `'call'` erbij is een schone uitbreiding; filteren, zoeken, sorteren en de lijst op **Berichten** werken dan meteen mee |
| `client_emails` + `client_email_threads` | `supabase/migrations/20260620000003_client_emails.sql:39` | Kant-en-klare blauwdruk voor een `client_calls`-tabel (richting, status, tijdstippen, `metadata`, RLS) |
| Opvangbak `inbound_messages` | `supabase/migrations/20260815000000_inbound_doorstuuradres.sql:350` | Precies het patroon voor *"gesprek van een onbekend nummer"*: vastleggen, tonen onder "Niet gekoppeld", later handmatig aan een klant hangen |
| `normalize_client_phone_value()` + `idx_clients_org_phone_lookup` | `20260520000001_clients_duplicate_guard.sql:13,126` | Nummer-opzoeken is al eens gebouwd (voor dubbele-klant-detectie) — met één belangrijke beperking, zie §5.1 |
| Opname → transcript → notulen | `CHANGELOG_MEETING_RECORDING_AI_NOTES_2026-06-30.md`, `_shared/meetingPipeline.ts`, `components/MeetingRecorder.tsx` | Volledige keten (R2 → ElevenLabs Scribe → Claude) staat er; een gespreksopname hoeft alleen aangesloten te worden |
| Inbound-webhook met HMAC + dedup | `supabase/functions/mail-inbound/index.ts:208,441-467` | Exact het patroon dat een telefooncentrale-webhook nodig heeft (ondertekening, tijdvenster, idempotente dedup-sleutel) |
| Config per organisatie | `organization_inbound_aliases` | Patroon voor "deze organisatie heeft deze centrale, met dit eigen secret" |
| Web-push outbox | `20260710000000_web_push.sql:144` | `event_type`-lijst is een check-constraint: `'call_missed'` is één migratieregel |
| Realtime-publicatie | o.a. `client_emails`, `inbound_messages` | "Er belt iemand" live op het scherm krijgen is hetzelfde patroon |
| Handelingenregister (Gerrie/MCP) | 268 handelingen in `supabase/functions/_shared/actions/` | `call.log` en `call.find_by_number` passen er zonder uitzondering in |
| Modulerechten | `src/lib/permissions.ts` + RLS | Gesprekken vallen logisch onder de bestaande module **Klanten** |

**Wat er níét is:** geen enkel spoor van gesprekken, gesprekslogs of telefonie-integratie
in code, schema of documentatie — dit is een groen veld. Telefoonnummers staan nu op
vier plekken: `clients.phone`, `client_contacts.phone`, `suppliers.phone` en
`company_settings.phone` (het eigen nummer).

---

## 2 · De harde grens: "telefoon koppelen" kan niet vanuit de browser

ResoFly is een **PWA** — `public/manifest.webmanifest`, geen Capacitor, geen Cordova,
geen React Native (gecontroleerd in `package.json` en `index.html`). Dat betekent:

- **Er bestaat geen web-API voor het gesprekslog of voor inkomende oproepen.** Niet in
  Chrome, niet in Safari, niet in een geïnstalleerde PWA, niet in een TWA. Er is niets
  te "koppelen" aan de telefoon zelf vanuit de app zoals die nu draait.
- **iOS geeft apps überhaupt geen toegang tot het gesprekslog** — ook een native app niet.
  Wat wél kan is een *CallDirectory*-extensie: bij een inkomende oproep toont iOS dan
  "ResoFly · Bakker BV" in plaats van een kaal nummer. Dat verrijkt het belscherm, maar
  levert géén log terug aan de app.
- **Android kent `READ_CALL_LOG`, maar Google Play staat die permissie alleen toe voor
  de standaard telefoon- of assistent-app.** Een CRM komt daar niet doorheen bij de
  review. (Buiten de Play Store om, met eigen distributie, kan het technisch wel —
  dat is een andere discussie dan een product dat je uitrolt.)

**Gevolg voor het ontwerp:** automatisch loggen loopt via de **telefooncentrale**
(server-kant), niet via het toestel. Het toestel kan wel de aanleiding zijn
(klik-om-te-bellen) en het gesprek kan wel handmatig in twee tikken vastgelegd worden.

---

## 3 · Drie routes, van licht naar zwaar

### Route A — Handmatig loggen + klik-om-te-bellen
*Geen externe partij, geen contract, werkt op elk toestel.*

- `tel:`-links op de klantkaart, de contactpersonenlijst en de leverancierskaart.
  `sanitizeHtml.ts:43` en `RichTextEditor.tsx:47` staan `tel:` al toe, dus de
  saneringslaag hoeft niet open.
- **"Gesprek loggen"**-venster: richting (inkomend/uitgaand/gemist), nummer, met wie
  gesproken (contactpersoon uit de lijst), duur (meelopende timer of met de hand),
  uitkomst, notitie, koppeling aan klant/project/ticket, en optioneel meteen een
  terugbeltaak of agenda-item.
- **De slimme brug:** klik je op een `tel:`-link, dan onthoudt de app dát je belde.
  Kom je terug in het tabblad (`visibilitychange`), dan staat er *"Gebeld met Bakker BV
  — gesprek loggen?"* met de duur al ingevuld. Geen permissies, geen integratie, en het
  vangt in de praktijk het grootste deel van de uitgaande gesprekken.
- Gesprekken verschijnen tussen de mail en de tickets op **Berichten** en als tabblad
  in het klantdossier — dezelfde weg die tickets op 17 september aflegden.

### Route B — Telefooncentrale via webhook
*Dit is de eigenlijke "koppeling", en de enige route die automatisch logt.*

- Edge function `call-webhook`, gebouwd op het patroon van `mail-inbound`: HMAC-
  ondertekening, tijdvenster, idempotente dedup-sleutel, alles in één transactie.
- **Bij een inkomende oproep:** nummer normaliseren → opzoeken over `clients`,
  `client_contacts` en `suppliers` → match betekent een melding *"Bakker BV belt —
  Maria de Vries, 2 openstaande facturen"* (web-push + realtime); geen match betekent
  een rij in de opvangbak.
- **Bij het einde van het gesprek:** het CDR (duur, richting, beantwoord/gemist,
  eventueel opname-URL) wordt een `client_calls`-rij, automatisch aan de klant gehangen.
- **Per organisatie instelbaar**, zoals de doorstuuradressen: welke centrale, welk
  secret, welke nummers zijn "van ons".
- Leveranciers met bruikbare webhooks/API's: **Voys/VoIPGRID** (NL, goed
  gedocumenteerd), **Dstny**, **RoutIT**, **3CX**, **Twilio**, **Aircall**. Het
  webhook-contract verschilt per partij; één adapterlaag met per-partij een vertaler
  naar één intern gespreksformaat houdt dat beheersbaar.

### Route C — Opname, transcript en AI-samenvatting
*Bovenop A of B, met vrijwel alleen bedrading.*

- De meeting-keten is één op één herbruikbaar: audio naar R2, ElevenLabs Scribe voor
  het transcript met sprekerlabels, Claude voor de samenvatting, onder hetzelfde
  `ai_usage`-maandplafond.
- Bij route B komt de opname van de centrale; bij route A kan het met de
  device-microfoon op de luidspreker (zoals `MeetingRecorder` nu al doet).
- De AVG-laag (verplichte toestemming, `consent_given`/`consent_at`, verwijderen wist
  ook de audio) is er al en moet overgenomen worden — zie §5.4.

---

## 4 · Voorgesteld datamodel (schets)

In het spoor van `client_emails`, zodat RLS, org-integriteit en de opvangbak
hetzelfde werken:

```
client_calls
  id, organization_id, created_by
  client_id            -- nullable: een gesprek mag (nog) losstaan
  contact_id           -- client_contacts, nullable
  supplier_id          -- nullable, voor leverancierscontact
  project_id, ticket_id-- nullable koppelingen
  direction            -- 'inbound' | 'outbound'
  outcome              -- 'answered' | 'missed' | 'voicemail' | 'busy' | 'failed'
  phone_raw            -- zoals binnengekomen
  phone_e164           -- genormaliseerd, hierop wordt gezocht (§5.1)
  counterpart_name     -- snapshot: met wie is gesproken
  started_at, ended_at, duration_seconds
  summary              -- korte reden/uitkomst, de regel in de lijst
  notes                -- vrije tekst
  source               -- 'manual' | 'click_to_call' | 'pbx'
  provider, provider_call_id, dedup_key
  recording_key, transcript_text, transcript_segments, ai_summary
  metadata jsonb
  created_at, updated_at
```

Bijbehorend: een leesfunctie `find_contacts_by_phone(org, nummer)` die over
`clients`, `client_contacts` en `suppliers` zoekt en **alle** treffers teruggeeft
(niet de eerste — zie §5.2), `security invoker` zodat de bestaande RLS geldt, precies
zoals `search_client_emails` dat op 17 september deed.

---

## 5 · Valkuilen die ik nu al zie

### 5.1 De bestaande nummer-normalisatie is niet geschikt voor herkenning
`normalize_client_phone_value()` gooit álle niet-cijfers weg:

```
'+31 6 12345678'  →  '31612345678'
'06-12345678'     →  '0612345678'
```

Twee schrijfwijzen van hetzelfde nummer, twee verschillende uitkomsten — voor
dubbele-klant-detectie ruim voldoende, voor nummerherkenning onbruikbaar. Er is dus
een **tweede** functie nodig (`normalize_phone_e164`, NL-bewust: `06` ↔ `+316`,
`0031` ↔ `+31`, doorkiesnummers, anonieme oproepen).

**Belangrijk: de bestaande functie niet aanpassen.** Die is `immutable` en zit in het
predicaat van `idx_clients_org_phone_lookup` én in de dedupe-trigger; hem herschrijven
maakt die index stil ongeldig. De nieuwe functie komt ernaast, met een eigen index.

### 5.2 Eén nummer, meerdere contacten
Een kantoornummer hoort bij de klant én bij drie contactpersonen; een
telefoonnummer kan bij twee klanten staan (zzp'er met twee dossiers). De opzoekfunctie
moet dus een **lijst** teruggeven en de app moet laten kiezen — niet gokken en de
eerste treffer koppelen.

### 5.3 Anonieme en onbruikbare nummers
Afgeschermde nummers komen binnen als leeg, `anonymous` of `+00000000000`. Die mogen
nooit tot een match leiden en horen rechtstreeks in de opvangbak.

### 5.4 AVG
Gespreksinhoud en zeker een opname zijn persoonsgegevens. Nodig: toestemming vastleggen
(patroon uit `meeting_recordings`), een bewaartermijn, en verwijderen dat de opname
óók echt wist. Los daarvan: een medewerker die privé belt op een gekoppelde lijn hoort
niet in het CRM te belanden — de centrale-koppeling moet kunnen filteren op welke
nummers/toestellen meedoen.

### 5.5 "Ongelezen" betekent niets bij een gesprek
Op **Berichten** heeft een gesprek geen ongelezen-teller. Hetzelfde probleem als bij
tickets, en daar is het opgelost met een **stip** in plaats van een getal
(`CHANGELOG_COMMUNICATIE_TICKETS_2026-09-17.md`). Datzelfde patroon aanhouden.

### 5.6 Testdekking
`src/lib/communication.ts` en `tickets.ts` zijn bewust vrij van runtime-imports zodat
`node --test` ze draait (26 tests). Nummer-normalisatie en gesprek-naar-gesprekregel
horen in diezelfde categorie: pure functies, met tests. De mobiele lay-outtest
(`npm run test:mobile`) heeft een seed-rij nodig voor een gespreksregel.

---

## 6 · Omvang per route

Geen urenschatting — wel eerlijk welke bestanden eraan moeten.

**Route A** — 1 migratie (`client_calls` + RLS + opzoekfunctie), `src/lib/calls.ts`
(puur, getest), een logvenster-component, inhaken op `communication.ts`,
`Communication.tsx`, het klantdossier (`Clients.tsx`), `types.ts`, `repository.ts` en
`AppData`. Vergelijkbaar met wat het tickets-op-Berichten-blok kostte.

**Route B** — daarbovenop: 1 edge function met HMAC + dedup, een tabel voor de
centrale-koppeling per organisatie, een instellingenscherm, secretbeheer, en per
leverancier een vertaallaag. Dit is het echte werk, en het staat of valt met de keuze
van de centrale.

**Route C** — grotendeels bedrading op bestaande onderdelen; de aandacht gaat naar
toestemming en bewaartermijn, niet naar de techniek.

---

## 7 · Advies

Begin bij **A**, en wel om een reden die verder gaat dan "klein beginnen": route A
levert het datamodel, de opvangbak-afhandeling, de nummerherkenning en de plek op
Berichten en in het klantdossier. Route B hangt daar later een automatische bron aan
en verandert er verder niets aan. Bouw je B eerst, dan bouw je datzelfde model
alsnog — plus een koppeling aan een centrale waarvan nog niet vaststaat welke het wordt.

Voor route B is één ding nodig dat niet in deze codebase te vinden is: **welke
telefooncentrale er gebruikt wordt.** Dat bepaalt het webhook-contract, of er een
gespreksopname beschikbaar is, en of nummerherkenning vóór opnemen haalbaar is.

---

## 8 · Zijn er gratis centrales voor Nederland? (aanvulling, 2026-09-18)

"Gratis" valt uiteen in twee kosten: de **centrale-software** en de **telefoonlijn**.

### Gratis centrale-software — ja, volop
**FreePBX** (Asterisk), **FusionPBX** (FreeSWITCH) en Issabel zijn open source zonder
licentiekosten. Voor onze koppeling zijn ze eerder sterker dan een commerciële
cloudcentrale: volledige toegang tot de gespreksgebeurtenissen (Asterisk AMI/ARI,
FusionPBX o.a. `mod_xml_curl` en webhooks) zonder dat de API achter een
abonnementsniveau zit. Kosten verschuiven naar een server en onderhoud.

### Gratis cloudcentrale mét bruikbare API — praktisch niet
**3CX** is het leerzame voorbeeld: er is een gratis tier, maar de CRM-integratie zit
er juist níét in — de gratis versie kan alleen een URL openen, geen echte
API-koppeling met templates. Eind 2025 kwam daar een "Basic Edition" bij, óók zonder
CRM-integraties. Precies het deel dat wij nodig hebben ontbreekt dus. Dat patroon is
breder: de centrale is goedkoop, de koppeling zit een tier hoger.

### De lijn kost altijd iets, maar weinig
Uit zoekresultaten (**niet geverifieerd** — de providerpagina's zijn vanuit deze
omgeving niet bereikbaar, controleer vóór gebruik): CheapConnect adverteert een
SIP-trunk zonder abonnements- of aansluitkosten met alleen belkosten per seconde;
VoiceOne vanaf ~€6,50/mnd voor Asterisk/FreePBX; Message To The Moon levert een
085-nummer gratis bij de trunk.

### Betaald, maar met webhooks inbegrepen
VOIPZeker (open API + webhooks, vanaf ~€14,50), Callvoip (Realtime API), MaxiTEL
(API + webhooks), PBXcomplete (~€29,95 voor 20 gebruikers incl. nummer), naast
Voys/VoIPGRID uit §3. Voor enkele gebruikers onder de €20/mnd — vermoedelijk
goedkoper dan de onderhoudstijd van een eigen FreePBX.

### Conclusie
De prijs van de centrale is niet de beslissende factor. De vraag aan een aanbieder is:
**vuurt hij bij een inkomende oproep én bij het einde van een gesprek een webhook af
met nummer, richting en duur?** Een gratis FreePBX doet dat beter dan een gratis 3CX.

En praktisch: **route B is te bouwen en te testen zonder enige provider.** FreePBX in
een container, of een testscript dat het webhook-formaat nabootst, is genoeg om de
edge function, de nummerherkenning en de opvangbak te valideren. De keuze voor een
centrale hoeft pas te vallen bij livegang.
