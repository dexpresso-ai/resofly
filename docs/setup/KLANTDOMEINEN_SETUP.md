# Klantadressen inrichten (jansen.resofly.com en eigen domeinen)

Elke organisatie kiest bij het inrichten een webadres: `<naam>.resofly.com`. Daarop opent
een klant zijn portaal, albums, offertes, facturen, contracten en gedeelde bestanden. Met een
betaald abonnement kan een organisatie ook een eigen domein koppelen, zoals
`albums.fotostudiojansen.nl`, voor de documenten met een link (album, factuur, offerte,
contract, deellink, boeking). Het klantportaal blijft op `<naam>.resofly.com`: de sessie van
een klant geldt bij al zijn leveranciers, en de DNS van een eigen domein beheert de
organisatie zelf. De Worker stuurt `/portal` op een eigen domein door. Het plan staat in
`docs/plannen/EIGEN_SUBDOMEIN_PLAN_2026-11-08.md`, de wijzigingen in
`docs/changelog/CHANGELOG_KLANTDOMEINEN_2026-11-09.md`.

Wat de code al levert:

- migratie `20261108230000_klantdomeinen.sql`: de namen (`client_subdomains`), de eigen
  domeinen (`client_domains`), de inlogaanvragen van het portaal (`portal_login_requests`),
  de RPC's `client_subdomain_check` en `client_subdomain_claim`, en de eis dat een
  organisatie een webadres heeft voordat de inrichting afrondt;
- de edge function `client-domains` (`verify_jwt = false`, zie `supabase/config.toml`):
  het overzicht voor Instellingen → Domein, eigen domeinen via Cloudflare for SaaS, de
  opzoeking voor de Worker en de nachtelijke ronde;
- de Worker `workers/client-domains`: zet de app op het klantadres, in de huisstijl van de
  organisatie, en laat alleen klantpaden door;
- in de app: de stap *Je webadres* bij het inrichten, het tabblad Instellingen → Domein en
  de klantadres-modus (op een klantadres nooit de werkruimte of het inlogscherm van een
  teamlid).

**Zolang `CLIENT_DOMAINS_LIVE` niet aan staat, verandert er voor klanten niets.** Links in
mails gaan dan naar het adres van de app, zoals altijd. De namen worden wel al gekozen en
vastgelegd. Zet de schakelaar pas om als stap 1 tot en met 4 werken.

## 0. Wat er op staging al staat

Na de deploy van de migratie en de functies (de workflow *Deploy Supabase (staging)*) werken
de stap *Je webadres*, het tabblad Domein, de controle of een naam bestaat, en de nieuwe
inlogmail van het portaal (met link naar het adres van de app). Een eigen domein koppelen
meldt *"Eigen domeinen zijn op deze omgeving nog niet ingericht"* tot stap 3 klaar is.

## 1. DNS: de namen bij ResoFly

In Cloudflare, zone `resofly.com`, onder DNS → Records:

| Type | Naam | Inhoud | Proxy |
|---|---|---|---|
| `AAAA` | `*` | `100::` | Proxied (oranje wolkje) |

`100::` is een adres zonder server: de Worker beantwoordt alles. Bestaande records
(`staging`, `caldav`, `inbound`, …) gaan voor de wildcard en blijven werken. Het
certificaat dekt `*.resofly.com` al (Universal SSL). Gebruik geen `*.staging.resofly.com`:
een tweede niveau zit niet in dat certificaat.

## 2. De Worker

```bash
cd workers/client-domains
npm install
npx wrangler login                     # een account met Workers-rechten op resofly.com
# Hetzelfde geheim als in Supabase (stap 4). Kies het één keer en bewaar het even:
openssl rand -base64 32
npx wrangler secret put CLIENT_DOMAINS_WORKER_SECRET --env staging
npm run deploy:staging
```

Controleer in `wrangler.toml` onder `[env.staging.vars]`:

- `APP_ORIGIN`: het adres van de Pages-build die de Worker toont (de staging-branch:
  `https://staging.resofly.pages.dev`);
- `SUPABASE_URL`: het staging-project;
- `PASSTHROUGH_HOSTS`: elk adres van ResoFly zelf onder `resofly.com`. Komt daar toch een
  verzoek binnen, dan gaat het ongewijzigd door.

Routes, in het dashboard onder Workers → `resofly-client-domains-staging` → Settings →
Domains & Routes (of zet ze in `wrangler.toml` en deploy opnieuw):

1. `*.resofly.com/*` → deze Worker;
2. voor elk eigen adres van ResoFly een route **zonder** Worker (*None*), bijvoorbeeld
   `staging.resofly.com/*`, `caldav.resofly.com/*`, `inbound.resofly.com/*`. Een preciezere
   route gaat voor, zo kost de werkruimte geen Worker-aanroepen.

Testen:

```bash
npm test                                         # de Worker in workerd, zonder netwerk
curl -sI https://<een-gekozen-naam>.resofly.com/portal | head -5   # 200, x-robots-tag: noindex
curl -sI https://bestaat-niet-123.resofly.com/   | head -1          # 404, neutrale pagina
```

## 3. Eigen domeinen: Cloudflare for SaaS

Aanbevolen: een aparte zone voor de klantdomeinen, bijvoorbeeld `resofly.site`. Dan vangt de
route `*/*` alleen verkeer van klanten, en nooit dat van ResoFly zelf.

1. Zone `resofly.site` toevoegen (gratis plan is genoeg).
2. SSL/TLS → Custom Hostnames → *Enable Cloudflare for SaaS* (100 hostnamen gratis per
   zone, daarna $0,10 per hostnaam per maand).
3. DNS: `AAAA klant 100::`, proxied. Dat is het CNAME-doel voor klanten en het *fallback
   origin*: zet `klant.resofly.site` als fallback origin bij Custom Hostnames.
4. De Worker als fallback: route `*/*` op `resofly.site` → `resofly-client-domains-staging`.
5. Een API-token (My Profile → API Tokens → Create Token → Custom): alleen
   *Zone → SSL and Certificates → Edit* op `resofly.site`. Niets meer: het token in deze
   repo-sessie kan bewust geen custom hostnames beheren.

Wie `klant.resofly.site` zelf opent, krijgt de neutrale pagina "niet in gebruik": dat adres
hoort bij geen organisatie. Zet het dus niet in `PASSTHROUGH_HOSTS`, want achter `100::`
staat geen server.

## 4. Supabase-secrets

```bash
supabase secrets set --project-ref <REF> \
  CLIENT_DOMAIN_BASE=resofly.com \
  CLIENT_DOMAIN_CNAME_TARGET=klant.resofly.site \
  CLIENT_DOMAINS_WORKER_SECRET='<dezelfde waarde als in de Worker>' \
  CLOUDFLARE_SAAS_API_TOKEN='<token uit stap 3>' \
  CLOUDFLARE_SAAS_ZONE_ID='<zone-id van resofly.site>'
```

De nachtelijke ronde (`CLIENT_DOMAINS_CRON_SECRET` en de pg_cron-taak
`client-domains-recheck`, elk kwartier) zet het script:

```bash
SUPABASE_PROJECT_ID=<REF> SUPABASE_DB_PASSWORD='…' bash scripts/supabase-setup-webhooks.sh
```

of het vinkje **setup_webhooks** bij *Run workflow* van *Deploy Supabase (staging)*. Het zet
alleen wat ontbreekt. De rooktest na elke deploy controleert daarna dat de taak en het secret
bij elkaar passen.

Optioneel: `CLIENT_DOMAINS_ALLOWED_ORIGINS` (de adressen van de app die Instellingen →
Domein mogen aanroepen; valt terug op `APP_ALLOWED_ORIGINS`, `APP_PUBLIC_URL` en
`MAIL_ALLOWED_ORIGINS`).

## 5. Aanzetten

Pas als `https://<naam>.resofly.com/portal` het portaal toont, in de huisstijl:

```bash
supabase secrets set --project-ref <REF> CLIENT_DOMAINS_LIVE=true
```

Vanaf dat moment linken nieuwe mails (facturen, offertes, contracten, albums, deellinks,
boekingslinks, de welkomstmail en de inlogmail van het portaal) naar het klantadres. Oude
links naar het adres van de app blijven werken. Terug: dezelfde regel met `false`.

## 6. Supabase Auth

Niets nieuws. De inlogmail komt van ResoFly zelf (`portal-login`), en de browser logt in met
het token uit die mail (`verifyOtp` met `token_hash`); daar is geen redirect-URL voor nodig.
Een klantadres hoeft dus niet in de lijst *Redirect URLs*.

## Wat je ziet als iets niet klopt

| Wat | Waar het zit |
|---|---|
| Een klantadres geeft de neutrale pagina "niet in gebruik" | De naam bestaat niet, of de Worker kan `client-domains` niet bereiken: kijk of `CLIENT_DOMAINS_WORKER_SECRET` in Worker en Supabase gelijk is (de rooktest meldt een 401). |
| De werkruimte (`staging.resofly.com`) is traag of toont een klantpagina | Ontbreekt de route zonder Worker, of staat het adres niet in `PASSTHROUGH_HOSTS`. |
| Een eigen domein blijft op *Wacht op het record* | Het CNAME-record wijst niet naar `CLIENT_DOMAIN_CNAME_TARGET` (het scherm zegt waarheen wel), het staat bij Cloudflare met een oranje wolkje, of het TXT-record van deze koppeling ontbreekt. Zonder dat TXT-record wordt een domein nooit actief, ook als Cloudflare het al goedkeurde: zo kan niemand een vergeten record van een ander overnemen. |
| *Certificaat wordt gemaakt* duurt uren | Een CAA-record bij de klant: het scherm geeft de tekst van Cloudflare. |
| Links gaan nog naar het adres van de app | `CLIENT_DOMAINS_LIVE` staat niet aan, of de organisatie heeft (nog) geen webadres: organisaties van vóór deze functie kiezen het in Instellingen → Domein. |
