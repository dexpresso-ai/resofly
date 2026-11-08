# Plan: eigen subdomein voor alles wat je klant ziet (2026-11-08)

Vraag: *Gebruikers (klanten van ResoFly) moeten gebruik kunnen maken van een eigen subdomein
om te communiceren naar klanten, opleveren albums, mails, klantportalen, etc. Kun je hier een
mooi idee voor maken hoe we dit dienen te realiseren.*

**Kort antwoord.** Elke organisatie krijgt één adres op haar eigen domein, bijvoorbeeld
`portaal.fotostudiojansen.nl`. Daarop staat alles wat haar klant ziet: albums, offertes,
facturen met betalen, contracten, afspraken, gedeelde bestanden, zendingen en het klantportaal.
De mails komen al van `info@fotostudiojansen.nl` (eigen verzenddomein, sinds juni) en linken
voortaan naar dat adres. De ondernemer zet bij zijn domeinbeheerder **één CNAME-record**.
**Cloudflare for SaaS** controleert dat record en maakt en vernieuwt het certificaat. Eén
nieuwe **Worker** koppelt het adres aan de huisstijl van de juiste organisatie. ResoFly blijft
één app, één database en één build.

Drie afspraken maken het veilig:

1. **Links bouwt de server uit de organisatie**, nooit uit het adres waar een verzoek vandaan
   kwam.
2. **Het klantportaal krijgt een eigen inlogmail**, vanaf het verzenddomein van de
   organisatie, in het Nederlands en in de huisstijl. Nu stuurt Supabase een Engelse
   standaardmail (zie §2.2).
3. **De werkruimte komt nooit op een klantdomein.** Geen inlogscherm voor teamleden, geen
   `/mcp`.

Dit document is een plan, geen bouwopdracht. Er is nog geen regel code veranderd.

## Bekijken

| wat | waar |
|---|---|
| De visuele versie: wat de klant ziet, Instellingen → Domein als werkend voorbeeld (adres invullen, record kopiëren, stappen per provider, de controle afspelen), het verkeer, de afspraken, de fasering en de beslispunten | online: https://claude.ai/artifact/KuofS5kfqBrFEekGhUeiwL (privé; deel het via het Share-menu). De bron staat in `docs/design-voorstel-eigen-subdomein/index.html`. |

---

## 1 · Wat er al ligt

Onderzocht in de huidige `staging`-stand (`64bb27d`).

| Bouwsteen | Waar | Waarde voor een eigen domein |
|---|---|---|
| Alle klantpagina's in één app, gekozen op pad: `/portal`, `/portal/<sleutel>`, `/quote/`, `/invoice/`, `/contract/`, `/booking/`, `/gallerij/`, `/gedeeld/` en `/ontvang/<token>` | `src/main.tsx:575-641` en `:1690-1698` | De Worker hoeft alleen te bepalen welke routes op een klantdomein mogen. Er komt geen tweede app. |
| Eigen inlogadres per organisatie (`/portal/<sleutel>`), huisstijl vóór het inloggen via `getBranding` | `supabase/migrations/20261106080000_klantlogin_huisstijl.sql`, `supabase/functions/_shared/portalAddress.ts`, `supabase/functions/portal-login/index.ts` | Hetzelfde idee, maar dan in de hostnaam. Het domein vervangt de sleutel als "wie is de leverancier". |
| Huisstijl op alles wat de klant ziet, en *Geleverd via ResoFly verbergen* | `company_settings.brand_*`, `supabase/functions/_shared/branding.ts`, `src/lib/branding.ts` | De Worker zet naam, kleur en icoon al in de HTML. Dan is er geen flits van ResoFly. |
| Eigen verzenddomein (From en Reply-To op het eigen domein, status per DNS-record, verversen, de 7-dagenregel, overlapcontrole) | `organization_email_domains`, `_shared/sendingDomain.ts`, `_shared/resendDomains.ts`, `_shared/domainOverlap.ts`, kaart in Instellingen → E-mail | Mail vanaf het eigen domein werkt al. Het webdomein volgt hetzelfde patroon, en de twee komen in één tabblad. |
| DNS opvragen vanuit een edge function (`Deno.resolveDns`, met DNS-over-HTTPS als terugval) | `supabase/functions/_shared/webhookDelivery.ts:301` | Voor de controle "staat je record goed?" in het scherm. |
| Stappen per provider in Instellingen | `FORWARDING_PROVIDERS`, `src/features/SimplePages.tsx:483` | Dezelfde vorm voor "zo zet je een CNAME bij TransIP, Versio, …". |
| Media-worker met getekende tokens, `nosniff` en `CSP: sandbox` | `workers/media-api/src/index.ts` | Kan later onder het klantdomein draaien, via een service binding (fase 3). |
| Origin-regels voor edge functions | `_shared/origins.ts`, `_shared/edgeAuth.ts:137` (`makeCors`) | Hier komt "een actief klantdomein mag ook" bij. |
| Cloudflare: zone `resofly.com` (Free), staging op `staging.resofly.com` (Pages), Workers Paid (containers, `cpu_ms`) | Cloudflare-account, `workers/*/wrangler.toml` | Cloudflare for SaaS zit in elk plan, ook Free. |

**Wat er níét is:** geen tabel met webdomeinen, geen manier om een hostnaam aan een
organisatie te koppelen en geen certificaten voor andermans domeinen. En elke link in een mail
komt uit één vaste instelling per omgeving.

---

## 2 · Wat er misgaat als je het "gewoon" aanzet

Dit zijn de dingen die het ontwerp moet oplossen. Ze staan nu allemaal in de code.

### 2.1 Links komen uit vaste instellingen, verspreid over de functies

`APP_PUBLIC_URL` en zes varianten (`INVOICE_PUBLIC_BASE_URL`, `QUOTE_PUBLIC_BASE_URL`,
`CONTRACT_PUBLIC_BASE_URL`, `BOOKING_PUBLIC_BASE_URL`, `CLIENT_PORTAL_BASE_URL`, …) bepalen
het adres in elke mail. Zo onder meer in `invoice-workflow/index.ts:67`,
`quote-workflow/index.ts:131`, `contract-workflow/index.ts:84`, `meeting-booking/index.ts:38`, `mail/index.ts:50`,
`portal-notify/index.ts:59`, `contract-public/index.ts:61`, `file-share/index.ts:42` en
`_shared/fileTransferServer.ts:100`. De galerijlink bouwt de app zelf uit
`window.location.origin` (`src/features/ProjectGallery.tsx:2672` en `:2710`,
`src/lib/actions/marketing.ts:411`). De afmeldlink in campagnes wijst rechtstreeks naar
Supabase (`campaigns/index.ts:62`), ook in de `List-Unsubscribe`-kop (`:1001`).

### 2.2 Inloggen in het portaal werkt alleen op het adres van ResoFly

Het portaal vraagt een inloglink met `emailRedirectTo: ${window.location.origin}/portal`
(`src/features/portal/ClientPortal.tsx:445`). Supabase accepteert alleen terugkeeradressen op
de host van de Site URL (`https://staging.resofly.com`) of uit de lijst Redirect URLs. Die lijst
is op staging leeg. Elk klantdomein zou daarin moeten, en dat doen we bewust niet (§6, regel 2).

Los van dit plan, maar nu al zichtbaar voor elke klant van elke organisatie: de inlogmail komt
van Supabase zelf. De afzender is **"Gerjan van Lopik" `<ne-reply@resofly.com>`** (let op:
*ne*-reply), het onderwerp is **"Your Magic Link"** en de tekst is de Engelse standaardtekst.
Alle organisaties samen mogen er **50 per uur** versturen (`rate_limit_email_sent`). Opgevraagd
via de Management API, alleen lezen.

### 2.3 De publieke functies kennen alleen vaste origins

`portal-login`, `client-portal`, `gallery-public` en de andere publieke functies laten alleen
origins uit vaste lijsten toe (`CLIENT_PORTAL_ALLOWED_ORIGINS`,
`GALLERY_PUBLIC_ALLOWED_ORIGINS`, …). Een browser op `portaal.jansen.nl` krijgt nu *"Deze
frontend-origin is niet toegestaan."*

### 2.4 Een beveiligingsfilter kijkt naar één voorvoegsel

`withoutPublicLinks` (`invoice-workflow/index.ts:4314`) haalt publieke factuurlinks uit elk
antwoord aan de browser. Dat werkt door te zoeken op `${INVOICE_PUBLIC_BASE_URL}/invoice/`. Een
link op `portaal.jansen.nl` glipt daar doorheen, en dan staat de link mét token weer in het
antwoord. Met die link opent iedereen de factuur, ook wie later uit de organisatie vertrekt.
`isValidInvoiceRedirectUrl` (`:4353`) laat Mollie alleen naar dat ene vaste adres terugkeren.

### 2.5 Na betalen in het portaal terug naar ResoFly

`client-portal` stuurt Mollie terug naar `APP_PUBLIC_URL/portal`
(`client-portal/index.ts:597`, `:616`). De klant betaalt dus op het eigen domein en komt uit op
dat van ResoFly. Zonder `APP_PUBLIC_URL` valt de functie terug op de Origin van het verzoek, en
juist dat willen we nergens meer (§6, regel 2).

---

## 3 · Drie manieren, en waarom het de derde wordt

| | Hoe | Waarom niet / wel |
|---|---|---|
| A | Domeinen toevoegen aan het Pages-project (API) | Een vaste limiet per project. Elk domein toont de héle app, ook het inlogscherm voor teamleden. Geen eigen headers of huisstijl per domein. |
| B | Eigen proxyserver met automatische certificaten (Caddy on-demand TLS op een VPS) | Volledige controle, maar dan moet er een server dag en nacht draaien: bijwerken, opschalen, aanvallen opvangen. Al het andere draait op Cloudflare en Supabase. |
| **C** | **Cloudflare for SaaS + één Worker** | De ondernemer zet één CNAME naar ons. Cloudflare controleert dat record en maakt en vernieuwt het certificaat. Een Worker op de route `*/*` krijgt elk verzoek met de hostnaam erbij. **100 hostnamen gratis per zone, daarboven $0,10 per hostnaam per maand** (Free, Pro en Business; tot 50.000). Workers Paid hebben we al. |

**Een apart domein voor het klantverkeer.** De route `*/*` vangt al het verkeer van een zone.
Op `resofly.com` zou hij ook `staging.resofly.com` (Pages) en straks `caldav.resofly.com`
vangen, en elke nieuwe hostnaam daar zou ongemerkt een klantadres worden. Daarom komt er een nieuw domein
alleen voor klantverkeer (werknaam **`resofly.site`**, nog te kiezen en te registreren), met
één zone per omgeving. Dat scheidt meteen de werkruimte van alles wat een klant ziet. Een
klantdomein deelt nooit cookies of "same-site" met de werkruimte, en een naam als
`login.resofly.com` kan nooit van een klant worden.

---

## 4 · Hoe het werkt

### 4.1 Wat de klant van de ondernemer ziet

1. Een mail van **Fotostudio Jansen `<info@fotostudiojansen.nl>`**. Dat bestaat al.
2. Knop *Bekijk je album* → `https://portaal.fotostudiojansen.nl/gallerij/…`.
3. Het album in de huisstijl. Het tabblad toont de naam en het icoon van de studio, en een
   gedeelde link in WhatsApp toont ook die naam en dat logo (fase 3).
4. *Naar je portaal* → inloggen op hetzelfde adres, met een inlogmail van de studio zelf.

ResoFly staat nergens in beeld, tenzij *Geleverd via ResoFly* aanstaat.

### 4.2 Wat de ondernemer doet: Instellingen → Domein (nieuw tabblad)

1. **Kies je adres.** We stellen `portaal.<domein>` voor, met het domein uit je verzenddomein
   of je website. Alleen een subdomein: `portaal.jansen.nl` wel, `jansen.nl` niet. Op het
   hoofddomein mag geen CNAME, en daar staat meestal je website.
2. **Zet één record bij je domeinbeheerder:** `CNAME portaal → klant.resofly.site`, met een
   kopieerknop en de stappen per provider (TransIP, Versio, Mijndomein, Hostnet, Strato,
   one.com, Cloudflare, Overig). Staat je domein zelf bij Cloudflare, zet het wolkje dan op
   grijs (alleen DNS).
3. **Wacht even.** Het scherm kijkt zelf mee, eerst elke tien seconden en daarna op de
   achtergrond. Er komt een vinkje bij *Record gevonden*, *Certificaat klaar* en *Actief*. Je
   hoeft niets te verifiëren; de knop is er wel.
4. **Klaar.** Elke nieuwe mail linkt vanaf dat moment naar je eigen adres. Je krijgt een mail
   als het actief is, en ook als het later stuk gaat.

In hetzelfde tabblad staat de kaart *Eigen verzenddomein*, die hierheen verhuist van
E-mail. E-mail houdt een verwijzing.

> **Mail en web niet op dezelfde naam.** `info@portaal.jansen.nl` werkt niet goed: naast een
> CNAME mag geen MX staan, dus antwoorden komen nooit aan. Het scherm stelt daarom
> `info@jansen.nl` voor als afzender en `portaal.jansen.nl` als webadres.

Schermteksten (voorstel):

| Status | Tekst |
|---|---|
| `pending_dns` | *We zien nog geen record op portaal.jansen.nl. Een wijziging bij je domeinbeheerder kan een paar uur duren.* |
| (wijst elders heen) | *portaal.jansen.nl wijst nu naar …. Verander het record in klant.resofly.site.* |
| `pending_certificate` | *Record gevonden. We maken nu een beveiligd certificaat, dat duurt meestal een paar minuten.* |
| `active` | *Actief. Je klanten openen albums, offertes, facturen en het portaal op portaal.jansen.nl.* |
| `failing` | *portaal.jansen.nl werkt niet meer: het record is weg of gewijzigd. Nieuwe mails linken zolang naar het adres van ResoFly.* |
| `moved` | *Verhuisd naar …. Oude links worden doorgestuurd tot 8 november 2027, zolang het oude record blijft staan.* |

### 4.3 Het verkeer

```
 Klant van de ondernemer (browser)
        │  https://portaal.fotostudiojansen.nl/gallerij/…
        ▼
 DNS van de ondernemer:   portaal   CNAME   klant.resofly.site
        ▼
 Cloudflare, zone resofly.site (Cloudflare for SaaS)
   • controleert het record, maakt en vernieuwt het certificaat
        ▼
 Worker client-domains (route */*)
   • hostnaam → status, inlogsleutel, huisstijl   ← RPC client_domain_lookup (60 s cache)
   • alleen klantroutes; al het andere = 404
   • HTML uit de Pages-build, met titel, kleur, icoon en eigen headers
        │
        └─► de app (dezelfde build als de werkruimte), in klantdomein-modus
                │  rechtstreeks, zoals nu:
                ├─► Supabase Auth en REST     (de sessie van het portaal)
                ├─► edge functions            (CORS: actieve klantdomeinen mogen)
                └─► media-api                 (fase 3: via /m/ op hetzelfde adres)

 invoice-, quote-, contract-workflow · meeting-booking · file-share · file-transfer
 portal-notify · mail · campaigns
        │  clientBaseUrl(organization_id)   ← client_domains: het actieve hoofdadres
        ▼
 Resend, vanaf info@fotostudiojansen.nl (verzenddomein, bestaat al)
        ▼
 "Bekijk je album" → https://portaal.fotostudiojansen.nl/gallerij/…
```

**Waarom de browser rechtstreeks met Supabase blijft praten.** De Worker zou alles kunnen
doorgeven, maar dan komen alle verzoeken van het IP van de Worker. De remmen van `portal-login`
(per IP, `cf-connecting-ip`) en die van Supabase Auth (verifiëren, sessie verversen) gaan dan
voor alle klanten van alle organisaties tegelijk dicht. Daarom alleen de HTML via de Worker, en
de rest zoals nu.

### 4.4 De Worker `workers/client-domains`

Per verzoek:

1. **Hostnaam opzoeken** via een RPC die alleen openbare gegevens teruggeeft: status,
   inlogsleutel, naam, kleuren en logo. Het resultaat blijft 60 seconden in de edge-cache. De
   Worker kent geen `organization_id` en heeft geen service-role nodig.
2. **Onbekend of niet actief** → een neutrale pagina *"Dit adres is nog niet actief"*, 404,
   `noindex`.
3. **Verhuisd** → 301 naar hetzelfde pad op het nieuwe adres.
4. **Alleen klantroutes:** `/`, `/portal…`, `/quote/`, `/invoice/`, `/contract/`, `/booking/`,
   `/gallerij/`, `/gedeeld/`, `/ontvang/`, `/afmelden` (fase 3), en de bestanden van de app.
   `/` toont het portaal. Al het andere (de werkruimte, `/mcp`, `/portal/voorbeeld`, de
   sleutel van een andere organisatie in `/portal/<sleutel>`) geeft 404.
5. **De HTML komt uit dezelfde Pages-build** als de werkruimte (opgehaald van het Pages-adres
   van die omgeving). Eén build, dus nooit een verschil tussen werkruimte en klantdomein. De CI
   rolt workers nu niet uit (`CHANGELOG_WORKERS_UITROL_2026-11-06.md`). Met een eigen kopie van
   de build zou het klantdomein dus achterlopen. Met `HTMLRewriter` zet de Worker erin:
   `<title>`, `theme-color`, het icoon uit het logo, `og:site_name` en
   `<meta name="resofly-client-host">` met de inlogsleutel. Geen inline script, dus de CSP en
   de hash van het themascript blijven gelijk.
6. **Eigen headers:** dezelfde CSP als `public/_headers`, `frame-ancestors 'none'`,
   `X-Robots-Tag: noindex, nofollow` op het hele adres, `Referrer-Policy: no-referrer` op de
   tokenroutes, HSTS zonder `preload`, en een `robots.txt` met `Disallow: /`. Geen manifest en
   geen service worker: die horen bij de werkruimte.

### 4.5 De app op een klantdomein

- `src/main.tsx` leest de meta. Op een klantdomein toont de app nooit `<Login />` of de
  werkruimte. `/` en `/portal` openen `ClientPortal` met de sleutel uit de meta, niet uit het
  pad.
- `src/lib/clientLinks.ts` (nieuw) met `useClientBaseUrl(organizationId)`, gebouwd zoals
  `usePortalLoginKey`. De galerijlink, de portaallink bij Huisstijl en die in het klantdossier
  tonen dan het eigen adres. Het is één klein verzoek dat per organisatie wordt onthouden. Er
  komt dus geen nieuwe datagroep bij (harde regel 5).

### 4.6 Inloggen in het portaal op het eigen domein (fase 2)

1. De klant vult zijn e-mailadres in op `portaal.jansen.nl`. De browser maakt een geheim van
   32 bytes, bewaart het in localStorage en stuurt alleen de sha256 ervan mee.
2. `portal-login` bepaalt de organisatie uit de Origin (een actief klantdomein) of uit de
   sleutel. Het controleert of het adres klant is bij díé organisatie
   (`portal_clients_for_email`). De remmen per IP en per adres blijven.
3. De server vraagt Supabase een inlogtoken (`auth.admin.generateLink`, type `magiclink`). Dat
   verstuurt zelf niets. Het token gaat versleuteld in `portal_login_requests`, een kwartier
   geldig. De mail bevat alleen een willekeurig aanvraagnummer, nooit het token.
4. De mail gaat via Resend vanaf het verzenddomein van de organisatie
   (`resolveSenderIdentity`), in het Nederlands en in de huisstijl. De link is
   `https://<actief adres van díé organisatie>/portal/inloggen?aanvraag=…`, gebouwd uit de
   organisatie en nooit uit het verzoek. Daaronder staat de code uit dezelfde aanvraag, voor
   wie de mail op een ander apparaat leest.
5. De pagina toont *Inloggen als k…@…nl* met een knop. Een linkscanner opent de pagina wel,
   maar klikt niet. De knop stuurt het aanvraagnummer en het geheim. De server controleert de
   sha256, markeert de aanvraag als gebruikt en geeft het token terug. De browser wisselt het
   zelf in bij Supabase (`verifyOtp({ token_hash, type: 'magiclink' })`). Zo telt de rem van
   Supabase per klant en niet voor de functie als geheel.

Net als nu met PKCE werkt de link alleen in de browser die hem aanvroeg. Op het adres van
ResoFly (`/portal`, `/portal/<sleutel>`) gebruiken we dezelfde flow. Dan verdwijnt "Your Magic
Link" overal en geldt de grens van 50 per uur niet meer.

### 4.7 Links: altijd uit de organisatie

`supabase/functions/_shared/clientLinks.ts` (nieuw):

- `clientBaseUrl(admin, organizationId)` geeft het actieve hoofdadres van die organisatie,
  anders `APP_PUBLIC_URL` zoals nu. Een adres dat hapert telt niet, zodat een nieuwe mail nooit
  een dode link krijgt.
- `isPublicLinkPath(value)` herkent `/invoice/<token>` en de andere tokenroutes op élk adres.
  Dat gebruiken `withoutPublicLinks` en `isValidInvoiceRedirectUrl`.
- `assertTokenMatchesClientHost(admin, req, organizationId)`: komt een token van organisatie A
  binnen via het adres van organisatie B, dan volgt een 404. Anders kun je de factuur van de
  een openen in de huisstijl van de ander.

Overal waar nu `APP_PUBLIC_URL` of een variant een link maakt, komt `clientBaseUrl` (zie §7).
`resolvePortalBaseUrl` in `client-portal` valt niet meer terug op de Origin.

**Wat al verstuurd is, verandert niet.** Een link in een verstuurde mail of PDF blijft zoals
hij was; een verstuurde factuur ligt vast (harde regel 6). Daarom:

- blijven alle tokenroutes altijd werken op het adres van ResoFly;
- wordt een verwijderd domein `moved`: zolang het oude record naar ons wijst, stuurt de Worker
  oude links twaalf maanden door naar het nieuwe adres. Het scherm waarschuwt: *Laat het oude
  record nog een jaar staan. Anders werken links in eerder verstuurde mails en PDF's niet
  meer.*

### 4.8 Mail

- Links in alle mails gaan naar het eigen adres (§4.7). Afzender- en linkdomein zijn dan
  hetzelfde. Dat oogt betrouwbaarder voor de klant, en voor spamfilters.
- De afmeldlink in campagnes wordt `https://portaal.jansen.nl/afmelden?t=…`, ook in de
  `List-Unsubscribe`-kop. De Worker geeft hem door aan `email-unsubscribe`, ook de one-click
  POST (fase 3).
- Een nieuw sjabloon `portal.login` in het register (`_shared/emailTemplates/`). Alleen de
  huisstijl is aanpasbaar, niet de veiligheidstekst.
- **Capaciteit:** alle organisaties delen één Resend-account, en Resend Pro heeft 10 domeinen
  (zie `CHANGELOG_EIGEN_VERZENDDOMEIN_2026-11-06.md`). Een eigen domein als verkoopargument
  maakt Resend eerder de grens dan Cloudflare.
- Antwoorden komen sinds 6 november in de eigen mailbox (Reply-To). Antwoorden opvangen op een
  eigen subdomein (`antwoord.jansen.nl`, met de ontvangstfunctie van Resend) kan later. Het
  kost een extra Resend-domein per organisatie.

---

## 5 · Datamodel (schets)

Migratie `<versie>_klantdomeinen.sql`, met een versie na `20261108171500`. Veilig opnieuw te
draaien (harde regel 4).

```sql
create table if not exists public.client_domains (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Kleine letters, punycode, zonder punt aan het eind; altijd een subdomein.
  hostname text not null,
  status text not null default 'pending_dns'
    check (status in ('pending_dns','pending_certificate','active','failing','moved','removed','blocked')),
  is_primary boolean not null default false,
  cf_custom_hostname_id text,
  cf_state jsonb not null default '{}'::jsonb,   -- laatste stand bij Cloudflare (hostname, ssl, fouten)
  verified_at timestamptz,                       -- ooit actief: dan blijft het van deze organisatie
  last_checked_at timestamptz,
  moved_to uuid references public.client_domains(id),
  redirect_until timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Eén levende rij per hostnaam over alle organisaties, en één hoofdadres per organisatie.
create unique index if not exists client_domains_hostname_live
  on public.client_domains (hostname) where status not in ('removed');
create unique index if not exists client_domains_one_primary
  on public.client_domains (organization_id) where is_primary;
```

- **RLS:** lezen met `can_read_org` (hostnamen zijn openbaar). Schrijven alleen via de edge
  function met de service-role, zoals bij `organization_email_domains`. Plus
  `apply_accountant_fence('client_domains')`.
- **`client_domain_lookup(p_hostname)`**: security definer, alleen openbare velden en alleen
  bij `active` of `moved`. Voor de Worker.
- **`client_domain_for_origin(p_origin)`** geeft de organisatie bij een actieve origin. Alleen
  voor de service-role (CORS en de tokencontrole).
- **`portal_login_requests`** (fase 2): id, organization_id, e-mailadres, het versleutelde
  token, de sha256 van het browsergeheim, `expires_at` en `used_at`. Alleen de service-role, en
  een opruimtaak.
- **Abonnement:** `billing_plans.limits.client_domains`, het aantal adressen per plan.

---

## 6 · Beveiligingsmodel

1. **Een hostnaam bepaalt de huisstijl, nooit de toegang.** Toegang blijft een token (album,
   factuur, …) of een portaalsessie die de server aan een organisatie koppelt (harde regel 1).
   Op een klantdomein kiest de hostnaam hooguit tussen de eigen dossiers van een klant die bij
   meer leveranciers klant is. Dat filtert, het geeft niets extra.
2. **Links uit `organization_id`, nooit uit Host of Origin.** Dat is de klassieke "host header
   injection". Wie de link in een inlogmail naar een domein kan sturen dat hij (later) zelf
   beheert, onderschept het inlogtoken. Daarom komen klantdomeinen ook niet in de Redirect URLs
   van Supabase. Elke organisatie in die lijst zou de inloglinks van een ándere organisatie op
   haar eigen domein kunnen laten landen. Zodra zij haar record elders heen laat wijzen, komt
   het token bij haar terecht.
3. **Eigendom bewijs je met DNS.** Een domein wordt pas actief als het record naar ons wijst.
   Cloudflare controleert dat, en maakt pas dan een certificaat. Een hostnaam is uniek over
   alle organisaties. Is hij nooit geverifieerd, dan mag een ander hem na zeven dagen overnemen.
   Is hij ooit actief geweest, dan blijft hij van die organisatie tot zij hem verwijdert. Dat
   is dezelfde regel als bij verzenddomeinen.
4. **Geen werkruimte op een klantdomein** (§4.4, stap 4). Zo kan geen klantdomein ooit een
   wachtwoord of sessie van een teamlid zien, ook niet als het record later elders heen wijst.
5. **Geweigerd bij het toevoegen:** hoofddomeinen, IP-adressen, `localhost`, publieke
   achtervoegsels (`co.uk`), alles onder `resofly.com` of het klantdomein van ResoFly, en een
   hostnaam die bij een andere organisatie actief is.
6. **Overname van een vergeten record.** Laat iemand een record naar ons staan nadat hij zijn
   domein verwijderde, dan kan een ander het niet overnemen. Cloudflare koppelt een hostnaam
   alleen aan wie hem aanmaakt, en wij alleen na zijn eigen DNS-bewijs. Na de doorstuurperiode
   toont het adres de neutrale pagina.
7. **Bestanden van gebruikers niet als pagina op het portaaladres** (fase 3). Onder `/m/` op
   het klantdomein krijgt alles behalve beeld en video `Content-Disposition: attachment`, en
   alles `CSP: sandbox` en `nosniff`. Anders kan een geüpload HTML-bestand scripts draaien op
   `portaal.jansen.nl` en de portaalsessie uit localStorage lezen.
8. **Misbruik.** Een eigen domein maakt een nepfactuur geloofwaardiger. Daarom alleen voor
   betalende organisaties, met een meldadres en de status `blocked`, die alleen ResoFly zet en
   die het adres meteen uitzet.
9. **AI (harde regel 2).** Gerrie, de agents en MCP krijgen geen handeling om domeinen toe te
   voegen of te verwijderen. Hooguit lezen: *"staat mijn domein goed?"*
10. **Rechten (harde regel 3) en Logboek.** Het tabblad Domein is te zien voor wie Instellingen
    ziet; wijzigen mag alleen owner of admin, net als bij het verzenddomein. Een boekhouder
    ziet het niet (`ACCOUNTANT_SETTINGS_TABS`). Elke wijziging komt in het Logboek.

---

## 7 · Waar het in de code komt

| Bestand | Wat |
|---|---|
| `supabase/migrations/<versie>_klantdomeinen.sql` (nieuw) | `client_domains`, de twee RPC's, het hek en de rechten. In fase 2 komt `portal_login_requests` erbij. |
| `supabase/functions/client-domains/index.ts` (nieuw) | toevoegen, verversen, hoofdadres kiezen, verwijderen (owner/admin) via de Cloudflare-API; actie `recheck` voor pg_cron (elke 15 minuten de wachtende en haperende adressen, dagelijks de actieve) |
| `supabase/functions/_shared/clientDomains.ts` + test (nieuw, puur) | hostnaam keuren (punycode, subdomein verplicht, geweigerde namen), status van Cloudflare vertalen |
| `supabase/functions/_shared/clientLinks.ts` + test (nieuw) | `clientBaseUrl`, `isPublicLinkPath`, `assertTokenMatchesClientHost` |
| `_shared/origins.ts`, `_shared/edgeAuth.ts` | een actief klantdomein als toegestane origin, alleen voor de publieke functies, 60 seconden onthouden per instantie |
| `portal-login`, `client-portal`, `quote-public`, `invoice-public`, `contract-public`, `gallery-public`, `file-share-public`, `file-transfer-public`, `meeting-booking-public` | CORS, en controleren dat het token bij het domein hoort |
| `invoice-workflow`, `quote-workflow`, `contract-workflow`, `meeting-booking`, `file-share`, `_shared/fileTransferServer.ts`, `portal-notify`, `mail`, `client-portal`, `contract-public`, `campaigns` | links via `clientBaseUrl`. `withoutPublicLinks` en `isValidInvoiceRedirectUrl` werken op elk adres. |
| `portal-login` + `_shared/emailTemplates/` | fase 2: de inlogmail zelf versturen (aanvraag en geheim), sjabloon `portal.login`, `getBranding` op hostnaam |
| `workers/client-domains/` (nieuw) | de Worker: opzoeken, routes, headers, `HTMLRewriter`; `wrangler.toml` per omgeving |
| `src/main.tsx` | klantdomein-modus |
| `src/features/portal/ClientPortal.tsx`, `src/lib/supabasePortal.ts` | sleutel uit de meta; fase 2: de nieuwe inlogflow |
| `src/lib/clientLinks.ts` (nieuw); `ProjectGallery.tsx`, `lib/actions/marketing.ts`, `lib/portalAddress.ts` | links via `useClientBaseUrl` |
| `src/features/SimplePages.tsx` + `src/components/ClientDomainCard.tsx` (nieuw) | het tabblad Domein; de verzenddomeinkaart verhuist mee |
| `src/lib/repository.ts`, `src/services/domainService.ts` (nieuw) | `loadClientDomains` en de acties |
| `public/_headers`, `scripts/check-csp-hash.mjs` | één bron voor de CSP, ook voor de Worker, en de controle daarop |
| `tests/stromen/klantdomein.mjs` (nieuw), `nepdiensten.mjs` | een nagebootste Custom Hostnames-API van Cloudflare |
| `docs/setup/KLANTDOMEINEN_SETUP.md` (nieuw) | inrichten: zone, SaaS, token, route, cron, secrets |

Nieuwe secrets: `CLOUDFLARE_SAAS_API_TOKEN` (alleen *SSL and Certificates: Edit* op de
klantzone), `CLOUDFLARE_SAAS_ZONE_ID` en `CLIENT_DOMAIN_CNAME_TARGET` voor de edge functions.
Het Cloudflare-token in deze sessie mag zones zien, maar geen DNS-records of custom hostnames
(getest). Er is dus een eigen token nodig.

---

## 8 · Valkuilen die ik nu al zie

1. **CNAME en mail op dezelfde naam:** zie §4.2.
2. **CAA-records.** Staat er op het domein een CAA die alleen één certificaatleverancier
   toelaat, dan komt er geen certificaat. De controle in het scherm leest de CAA en zegt welke
   regel erbij moet.
3. **Het domein van de ondernemer staat zelf bij Cloudflare.** Dat kan, maar de eerste
   controle gaat het soepelst met het wolkje op grijs. Dat staat in de stappen.
4. **De portaalsessie hoort bij één adres.** localStorage is per origin. Wie eerst op het adres
   van ResoFly inlogde, logt op het eigen adres één keer opnieuw in.
5. **Twee kopieën van de CSP** (Pages en Worker) lopen uit elkaar. Daarom één bron, en
   `check-csp-hash.mjs` controleert beide.
6. **Linkscanners** (zoals Microsoft Safe Links) openen links vooraf. Een GET op de inloglink
   doet daarom niets; pas de knop logt in.
7. **Staging en productie** hebben elk een eigen klantzone en CNAME-doel. Een record dat naar
   staging wijst, mag nooit productiegegevens tonen.
8. **Valt Pages uit, dan ligt ook het klantdomein plat.** Dat is nu ook zo voor de klantpagina's
   op het adres van ResoFly, dus er komt geen nieuw risico bij.
9. **Bestaande links** blijven op het oude adres staan. Dat is bewust (§4.7).

---

## 9 · Fasering en omvang

Geen urenschatting, wel eerlijk welke onderdelen eraan moeten.

**Fase 0: inrichten en bewijzen** (klein, en het enige deel met echte onzekerheid). Kies en
registreer het klantdomein, maak de zone en zet Cloudflare for SaaS aan. Zet de fallback origin
(`AAAA 100::`, proxied), het CNAME-doel `klant.<klantdomein>` en de route `*/*`. Maak het token
met alleen de rechten hierboven. Bouw een kale Worker die de HTML van Pages doorgeeft, en zet er
met de hand `portaal.gerjanvanlopik.nl` bij. **Klaar als:** het certificaat actief is en
`/gallerij/<token>` op dat adres laadt en werkt.

**Fase 1: albums, offertes, facturen en mails op het eigen adres** (de kern). De migratie,
`client-domains` met de cron-controle, het tabblad Domein, `clientLinks.ts` in alle functies,
de fix van `withoutPublicLinks` en `isValidInvoiceRedirectUrl`, CORS voor de publieke functies,
de Worker (opzoeken, routes, headers, huisstijl in de HTML) en de klantdomein-modus in de app.
**Resultaat:** albums, offertes, facturen met betalen, contracten, afspraken, gedeelde bestanden
en zendingen staan op `portaal.jansen.nl`, en elke nieuwe mail linkt daarheen. Links naar het
portaal wijzen in deze fase nog naar het adres van ResoFly.

**Fase 2: het klantportaal op het eigen adres.** De nieuwe inlogflow en inlogmail,
`portal_login_requests`, en de portaalmeldingen, welkomstmail en Mollie-terugkeer naar het eigen
adres. Dezelfde flow komt ook op het adres van ResoFly, en dan is "Your Magic Link" weg.

**Fase 3: alles onder één adres.** Media via een service binding onder `/m/` (downloads, zip,
video), met de headers uit §6. Verder de afmeldlink via `/afmelden`, het voorbeeld in WhatsApp
en iMessage (naam en logo; de albumcover alleen zonder pincode en als de maker dat aanzet), en
verhuizen met 301's. De media-worker verhuist van `gerjan.workers.dev` naar
`media.<klantdomein>`.

**Fase 4: als het gevraagd wordt.** Een gratis adres op het klantdomein van ResoFly
(`jansen.resofly.site`) voor wie geen eigen domein heeft. Alleen als bewuste keuze van de
ondernemer, want dat adres is wél te raden, en dat hebben we bij `/portal/<sleutel>` juist
vermeden. Verder één wizard voor web en mail samen, met één DNS-lijst, en antwoorden opvangen
op een eigen subdomein.

**Testen per fase**

- `npm test`: hostnaam keuren, de statusvertaling van Cloudflare, `clientBaseUrl`, en
  `isPublicLinkPath` op elk adres. `withoutPublicLinks` krijgt een test met een eigen domein:
  tegen de huidige code faalt die.
- `npm run test:stromen` met het scenario `klantdomein`: toevoegen → wachten op het record →
  actief → de factuurmail linkt naar het domein → een token van organisatie A op het adres van
  B geeft 404 → overnemen na zeven dagen → verwijderen wordt verhuisd → de link in de inlogmail
  komt uit de organisatie, ook als de Origin liegt.
- Unittests voor de Worker (routekeuze, headers, verhuizen) en een rooktest na de uitrol:
  `curl -sI https://portaal.gerjanvanlopik.nl/gallerij/x`.
- `npm run test:mobile -- --theme=both` op Instellingen → Domein. Verder `npm run
  test:loading` (er komt geen datagroep bij, en dat moet blijken), `deno check` op de
  gewijzigde functies en `supabase db start` voor de keten.

Ter vergelijking: fase 1 is ongeveer zo groot als het eigen verzenddomein (juni en november
samen), plus de Worker en het doorlichten van de linkbouw in elf functies. Fase 0 is daar een
fractie van.

---

## 10 · Kosten

- **Cloudflare for SaaS:** per zone 100 hostnamen gratis, daarna $0,10 per hostnaam per maand
  (Free, Pro en Business; tot 50.000). Bron: de prijslijst van Cloudflare, november 2026.
- **Workers:** het betaalde plan loopt al. Per bezoek komt er één Worker-aanroep voor de HTML
  bij, plus de bestanden als die via de Worker gaan. Ruim binnen de bundel.
- **Een domein per omgeving:** een paar euro per jaar.
- **Resend:** de echte grens bij eigen verzenddomeinen (Pro: 10 domeinen voor alle organisaties
  samen). Reken op een groter abonnement zodra meer dan een handvol organisaties een eigen
  domein gebruikt.

---

## 11 · Beslispunten (met mijn voorstel)

| Vraag | Voorstel | Waarom |
|---|---|---|
| Welk domein wordt het klantdomein van ResoFly (CNAME-doel, fallback)? | **Een nieuw, apart domein** (werknaam `resofly.site`), één zone per omgeving | De route `*/*` vangt alles in een zone. Zo deelt niets wat een klant ziet een domein met de werkruimte. |
| Alleen een subdomein op het eigen domein, of ook een gratis adres bij ResoFly? | **Eerst alleen het eigen subdomein**; het adres bij ResoFly in fase 4, als keuze | Het eigen domein is waar de vraag om gaat. Een adres bij ResoFly is te raden. |
| Ook het hoofddomein (`jansen.nl`)? | **Nee** | Daar mag geen CNAME en staat meestal de website. Cloudflare kan het alleen met Enterprise. |
| Hoeveel adressen per organisatie? | **Eén hoofdadres**, plus oude adressen die doorsturen | Eén adres in alle mails. Een tweede merk is een tweede administratie (`create_child_organization`) met een eigen adres. |
| In welk abonnement? | **Vanaf Pro**, of als betaalde optie (`billing_plans.limits.client_domains`) | Het beperkt misbruik, en de mailkant kost Resend-capaciteit. |
| De inlogmail ook op het adres van ResoFly vervangen? | **Ja** | Weg met "Your Magic Link" en de grens van 50 per uur, en er is één flow om te testen. |
| Een code in de inlogmail naast de link? | **Ja** | Mail op de telefoon en het portaal op de laptop werkt nu niet. Het nadeel: een code werkt in elke browser. Dat is de gewone afweging bij een inlogmail. |
| Media onder het klantdomein (fase 3)? | **Ja**, met de headers uit §6 | Dan tonen de downloadbalk en de zip het eigen adres, niet `gerjan.workers.dev`. |
| Hoe lang sturen verhuisde adressen door? | **Twaalf maanden** | Een factuurlink is maanden later nog nodig, bij herinneringen en aanmaningen. |

---

## 12 · Advies

Begin met **fase 0**. Dat is weinig werk en het enige deel met echte onzekerheid: een
certificaat, de Worker en de HTML van Pages op een vreemd domein. Daarna **fase 1**: dan staan
albums, offertes, facturen en contracten op het eigen adres, en dat zien klanten het eerst.
**Fase 2** komt er meteen achteraan.

Los van dit plan is het de moeite waard om nu al de afzender en het onderwerp van de
Supabase-inlogmail aan te passen (*Authentication → Emails* in het dashboard van Supabase):
"Gerjan van Lopik `<ne-reply@resofly.com>`" en "Your Magic Link" zien al je klanten vandaag.
