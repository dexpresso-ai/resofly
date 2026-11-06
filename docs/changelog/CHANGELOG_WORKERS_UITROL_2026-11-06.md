# Changelog — Workers uitgerold op staging — 2026-11-06

## Aanleiding

> Hoe update ik naar nieuwe postgres versie en als ik Cloudflare secrets in de cloud sessie zet,
> kun jij dan de nieuwe workers plaatsen

CI rolt de workers niet uit. Sinds 1 november stonden er fixes in de repo die staging nog niet
draaide. Zie actie 1 en 2 in `docs/plannen/ACTIEPUNTEN_BEVEILIGING_SAAS_2026-11-01.md`, en de
uitrolstappen in `CHANGELOG_CONTRACT_OFFERTE_FACTUUR_2026-11-05.md` en
`CHANGELOG_DOCUMENTEN_2026-11-06.md`.

## Wat er nu draait

Alle vier met de code van `staging` op `3a5afcc`. Alleen staging; productie is niet aangeraakt.

| Map | Worker in Cloudflare | Vorige uitrol | Versie | Wat erbij komt |
| --- | --- | --- | --- | --- |
| `workers/media-api` | `resofly-media-api-staging` | 11 oktober | `bf775db3` | Fix 6, 22 en 32 van 1 november. De route voor offerte-PDF's (`/internal/quote-snapshot`): zonder die route gaf versturen een 502. En de documentfixes van 6 november: lezen via de editor controleert lidmaatschap en modulerecht opnieuw, en de PDF-omzetting neemt alleen contractbestanden aan. |
| `workers/office-server` | `resofly-office-server` (één voor staging en productie) | 2 augustus | `4f400a61` | Fix 28: alle conversie-eindpunten van Collabora vragen het geheim. Eerder kon iedereen ze gebruiken, op onze kosten. De container zelf is niet veranderd. |
| `workers/email-inbound` | `resofly-email-inbound-staging` | 15 augustus | `e6ce8169` | Mail aan een `facturen-…`-adres stuurt de bijlagen mee: pdf, xml en afbeeldingen, tot 10 MB per stuk en 14 MB samen. De oude versie stuurde alleen de namen, dus kwam er via de mail geen bestand in de inkoopfacturen-inbox. Ondertekenen deed de oude versie al. |
| `workers/caldav` | `resofly-caldav-staging` | 30 juni | `79f59000` | Modulerechten voor Agenda (harde regel 3). Met de oude versie kwam wie Agenda niet mag zien via CalDAV toch in de agenda's, en kon wie alleen mag lezen er toch in schrijven. Staging geeft `calendar_level` al terug, dus de controle werkt meteen. |

De media-worker ging eerst uit vanaf `6586e54`, het beginpunt van deze sessie (versie
`a259a88c`). Staging bleek intussen een wijziging aan de worker te hebben (`a7f2392`, de
documentfixes), dus daarna opnieuw vanaf `3a5afcc`. Voor de andere drie zijn beide
commits gelijk.

## Vooraf gecontroleerd

- De secrets die de code leest, staan er. Alleen de namen bekeken:
  - media-api: `SUPABASE_SERVICE_ROLE_KEY`, `MEDIA_SIGNING_SECRET`, `INTERNAL_UPLOAD_SECRET`,
    `OFFICE_CONVERT_SECRET`, `STREAM_ACCOUNT_ID`;
  - office-server: `OFFICE_CONVERT_SECRET`;
  - email-inbound: `MAIL_INBOUND_SECRET`;
  - caldav: `SUPABASE_SERVICE_ROLE_KEY`.
- Van Cloudflare Stream staat alleen `STREAM_ACCOUNT_ID`. De worker gebruikt Stream pas met alle
  vier de waarden, dus video's lopen op staging via R2. Dat was al zo.
- De migraties waar de nieuwe media-worker op leunt (tot en met `20261106160000`) staan op
  staging.
- De media-worker roept op de office-server alleen `/convert-to` aan, met het geheim. De nieuwe
  afscherming breekt dus niets.

## Gevonden, nog open (eigenaar)

- **De oude media-worker draait nog.** `resofly-media-staging` komt uit `cloudflare-worker/`,
  is laatst uitgerold op 11 oktober en staat aan op workers.dev. Hij gebruikt dezelfde R2-bucket
  (`resofly-media-staging`) en hetzelfde Supabase-project als de media-worker. Volgens het
  rapport van 5 november kan elk lid met een JWT via deze worker de vastgelegde PDF's van
  facturen, offertes en contracten wissen. Dit is actie 7 uit de actielijst. Hem weghalen, of
  zijn workers.dev-adres uitzetten, beslist de eigenaar.
- **`resofly-media-api`, de productienaam, draait code van 3 mei.** Hij wijst naar een ander
  Supabase-project (`vmxamdjyzquaipdcroqe`) en de bucket `resofly-media-production`, met alleen
  `OFFICE_CONVERT_SECRET` als secret. Hij staat ook aan op workers.dev. Er is nog geen
  productie. Weghalen, of laten staan tot actie 8, beslist de eigenaar.

## Postgres: de stand vóór de upgrade

Opgevraagd via de Management API, alleen lezen:

- Staging draait `supabase-postgres-17.6.1.111`. Supabase biedt `17.11.0.018` aan (kanaal GA).
- De controle van Supabase vindt niets dat in de weg zit: geen extensies, objecten of rollen.
  Geschatte duur: 1 uur. De database is 854 MB.
- Supabase heeft geen back-up van het project klaarstaan (de lijst is leeg, geen PITR).

Upgraden is actie 1 uit `docs/rapporten/REVIEW_CONTRACT_OFFERTE_FACTUUR_2026-11-05.md`. Daarna
`supabase/.temp/postgres-version` op de nieuwe versie zetten. Anders draaien `supabase db start`
en de CI-job `migrations` op een ander image dan staging.

## Hoe

- Het Cloudflare-token staat als *network secret* op de cloudomgeving. De proxy zet het in elk
  verzoek naar `api.cloudflare.com`; in de sessie zelf staat het niet. Wrangler kreeg
  `CLOUDFLARE_API_TOKEN=proxy-injected` als plaatshouder, en `CLOUDFLARE_ACCOUNT_ID`.
- Per map `npm ci` en dan `npx wrangler deploy --env staging`. De office-server heeft geen
  staging-omgeving, dus daar `npx wrangler deploy`.
- Productie is niet uitgerold: de productie-instellingen van de workers wijzen nog naar de
  database van staging (actie 8).

## Getest

- Per worker `tsc --noEmit` en `wrangler deploy --dry-run`: schoon.
- Na de uitrol de code uit Cloudflare opgehaald en gezocht naar een stuk van elke fix: in alle
  vier aanwezig. In de eerste uitrol van de media-worker ontbrak de fix van `a7f2392`; in
  `bf775db3` zit hij.
- Niet getest: de workers zelf aanroepen. Hun workers.dev-adressen zijn vanuit de cloudsessie
  niet bereikbaar. Doe daarom de rooktest uit de actielijst:
  - een video uploaden en afspelen;
  - een Word-document bewerken, opslaan en als PDF downloaden;
  - een offerte versturen;
  - een mail met een PDF naar een `facturen-…`-adres;
  - een telefoon die via CalDAV synchroniseert.
