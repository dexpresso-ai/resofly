# Agendaserver: ResoFly-agenda's op de telefoon, en deellinks

De agendaserver (`workers/caldav`, een Cloudflare Worker) doet twee dingen:

1. **CalDAV**: je eigen ResoFly-agenda's in Apple Agenda (iPhone, iPad, Mac),
   op Android (DAVx⁵) of in Thunderbird. Lezen, maken, wijzigen en verwijderen,
   in beide richtingen.
2. **Deellinks**: één ResoFly-agenda als `.ics`-adres voor iemand zonder
   ResoFly, in Google Agenda, Outlook of Apple Agenda. Alleen bekijken.

Bijgewerkt op 13 november 2026 (zie
`docs/changelog/CHANGELOG_AGENDASERVER_DEELLINKS_2026-11-13.md`).

| Omgeving | Adres | Supabase |
| --- | --- | --- |
| staging | `https://caldav-staging.resofly.com` | `enzghpduqwaojcxgwarr` |
| productie | `https://caldav.resofly.com` (nog niet aan) | nog niet |

Alleen ResoFly-agenda's (`provider = 'native'`) gaan mee. Een gekoppelde
Google- of Outlook-agenda staat al via Google of Microsoft op de telefoon, en
die deel je ook daar.

## 1. Database en edge function

Alles staat in de migraties en gaat met *Deploy Supabase (staging)* mee:

- `calendar_app_passwords` en `caldav_lookup_app_passwords()`: inloggen met
  een app-wachtwoord (20260625000001 en later);
- `calendar_feed_links` en `calendar_feed_lookup()`: deellinks
  (20261113120000).

Het beheer (app-wachtwoorden en deellinks maken, tonen en intrekken) loopt via
de edge function `calendar-integrations`: `createAppPassword`,
`listAppPasswords`, `revokeAppPassword`, `createFeedLink`, `listFeedLinks`,
`revokeFeedLink`.

## 2. De Worker

Eén secret, per omgeving een eigen waarde:

```bash
cd workers/caldav
npm install
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
```

Uitrollen:

- **vanzelf**: bij een push naar `staging` die `workers/caldav/**` raakt, draait
  de workflow *Deploy agendaserver (staging)*. Die heeft in GitHub de secrets
  `CLOUDFLARE_API_TOKEN` en `CLOUDFLARE_ACCOUNT_ID` nodig (zie de kop van
  `.github/workflows/deploy-agendaserver-staging.yml`). Ontbreken ze, dan
  faalt de workflow met die melding: de Worker is dan niet bijgewerkt.
- **met de hand**: `npm run deploy:staging` in `workers/caldav`.

De route `caldav-staging.resofly.com/*` staat in `wrangler.toml` en gaat mee
met elke deploy.

## 3. DNS

In Cloudflare, zone `resofly.com`:

| Type | Naam | Inhoud | Proxy |
| --- | --- | --- | --- |
| `AAAA` | `caldav-staging` | `100::` | Proxied |

Zonder dit record dekt de wildcard `*` het ook, maar dan hangt het adres aan de
klantadressen. Gebruik geen `caldav.staging.resofly.com`: een tweede niveau zit
niet in het certificaat van `*.resofly.com`.

## 4. De app

De app leest het adres uit `src/lib/caldavSetup.ts`: `VITE_APP_ENV=staging`
geeft `https://caldav-staging.resofly.com`. `VITE_CALDAV_URL` gaat voor, voor
een eigen adres. Zonder adres (productie, lokaal) zegt Instellingen → Agenda
dat de agendaserver er nog niet is, en staat de knop *Delen buiten ResoFly*
er niet.

## 5. Controleren

```bash
base=https://caldav-staging.resofly.com
curl -si -X OPTIONS "$base/"                          # 204, met DAV: 1, 2, 3, calendar-access
curl -si -X PROPFIND "$base/.well-known/caldav"       # 401, met WWW-Authenticate: Basic
curl -si "$base/feed/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ics"   # 404 "Deze agendalink bestaat niet (meer)"
curl -s "$base/robots.txt"                            # onderaan: Googlebot, Bingbot, … met Disallow: /
curl -sI -X OPTIONS "$base/" | grep -i x-robots-tag   # noindex, nofollow, noarchive, nosnippet
```

Een 500 op de deellink betekent meestal dat de migratie met
`calendar_feed_lookup` er nog niet is. Dan het einde-tot-einde:

1. Instellingen → Agenda → *ResoFly-agenda's*: maak een agenda.
2. *Agenda op je telefoon of computer*: maak een app-wachtwoord en volg de
   stappen voor je telefoon. De afspraak die je daar maakt, staat binnen een
   paar seconden in ResoFly.
3. *Delen buiten ResoFly* bij de agenda: maak een link en zet hem in Google
   Agenda (Andere agenda's → + → Via URL). Google haalt hem een paar keer per
   dag op; de eerste keer meteen.

## 6. Hoe het in elkaar zit

- **Inloggen (CalDAV)**: HTTP Basic, gebruikersnaam = het inlogmailadres,
  wachtwoord = een app-wachtwoord. We bewaren alleen een gezouten SHA-256.
  `caldav_lookup_app_passwords()` geeft alleen actieve leden die de Agenda
  mogen zien, met hun niveau: met alleen leesrecht biedt de server geen
  schrijfrecht aan en weigert hij PUT en DELETE.
- **Wat je ziet**: je eigen ResoFly-agenda's en die een collega met het team
  deelt, binnen de organisatie van het app-wachtwoord. Naam en kleur van een
  agenda wijzigt alleen de eigenaar.
- **Deellinks**: 32 willekeurige bytes in het adres; in de database alleen de
  SHA-256. `calendar_feed_lookup()` geeft niets terug zodra de link is
  ingetrokken, de maker geen actief lid meer is of de Agenda niet meer mag
  zien, of de agenda niet meer van hem is. Vertrekt iemand, dan worden zijn
  links ingetrokken en komen ze niet terug.
- **Wat een deellink toont**: alleen de tijden ("Bezet"), of ook titel en
  plaats. Nooit de omschrijving, genodigden, organisator, herinneringen,
  bijlagen of vergaderlinks. Een afspraak die op de telefoon als privé is
  gemarkeerd, is altijd "Bezet". Afspraken tot een jaar terug, en alle
  herhalende.
- **Tenancy**: de Worker gebruikt de service-role en filtert zelf op
  `organization_id`, uit het app-wachtwoord of de deellink, nooit uit het
  verzoek.
- **Zomer- en wintertijd**: een reeks uit de app gaat naar de telefoon en de
  deellink op de kloktijd met tijdzone (`DTSTART;TZID=…` en een VTIMEZONE),
  dezelfde regel als in de app (`_shared/wallClock.ts`).
- **Zoekmachines**: Cloudflare zet zijn eigen robots.txt (met `Allow: /` voor
  iedereen) vóór die van de Worker. Daarom noemt de Worker de zoekmachines bij
  naam, en geeft elk antwoord `X-Robots-Tag: noindex`.

## 7. Testen

```bash
npm test                                   # o.a. workers/caldav/src/logic.test.ts en src/lib/caldavSetup.test.ts
npm run test:stromen -- caldav             # de echte Worker tegen een lokale stack
npm run test:mobile -- --theme=both --pages=settings-agenda,settings-agenda-delen
```

## 8. Bestanden

```text
workers/caldav/src/index.ts                         routes, inloggen, database
workers/caldav/src/logic.ts                         iCalendar lezen en schrijven, wat een deellink toont (puur, getest)
supabase/functions/_shared/calendarFeed.ts          het token van een deellink
supabase/functions/calendar-integrations/index.ts   app-wachtwoorden en deellinks beheren
supabase/migrations/20261113120000_agenda_deellinks.sql
src/lib/caldavSetup.ts                              het adres per omgeving
src/features/CalendarPage.tsx                       Instellingen → Agenda
tests/stromen/caldav.mjs                            de end-to-end test
.github/workflows/deploy-agendaserver-staging.yml   uitrollen
```
