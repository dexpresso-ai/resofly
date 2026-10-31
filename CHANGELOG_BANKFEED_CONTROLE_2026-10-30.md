# Bankfeed — controle Enable Banking op staging, en de fixes (2026-10-30)

## Wat & waarom
Vraag: loopt de directe bankkoppeling (Enable Banking) echt, en kunnen klanten straks
zelf hun bank koppelen? Gecontroleerd tegen de live staging-omgeving (Supabase
Management API, alleen lezen) en tegen de API-documentatie van Enable Banking.

## Wat de controle vond

| | Bevinding |
|---|---|
| ✅ | `bank-sync` staat live (versie 44), `ENABLEBANKING_APP_ID` en `ENABLEBANKING_PRIVATE_KEY` zijn gezet, de JWT-auth werkt: bankenlijst en `/auth` gaven op 28 oktober nog 200, `/sessions` lukte in juni twee keer. |
| ⚠️ | **De Enable Banking-app is een sandbox-app.** Alle zes toestemmingslinks (juni t/m 28 oktober) wijzen naar `tilisy-sandbox.enablebanking.com`. De twee "geslaagde" koppelingen van 26 juni (Gerjanvanlopik en Billy, elk vier Rabobank-rekeningen) zijn testrekeningen met testdata: 1800 resp. 1820 transacties. Niets daarvan is geboekt of gematcht. Een sandbox-app gaat nooit naar productie; daarvoor is een nieuwe app-registratie nodig. |
| ❌ | **Sinds de koppeldag nooit meer gesynct.** Synchroniseren kon alleen met de knop; `last_synced_at` stond op 26 juni. Er was geen automatische sync. |
| ❌ | **Verlopen toestemming onzichtbaar.** Beide koppelingen verliepen op 24 september, maar stonden nog op "gekoppeld": de status werd pas `expired` na een mislukte sync, en er werd niet gesynct. |
| ❌ | **Afgebroken koppeling stil.** De poging van 28 oktober bleef op `created` staan: na `/auth` kwam er nooit een afronding. Breekt de klant af of weigert de bank, dan stuurt Enable Banking `?error=…&state=…` terug — dat herkende de app niet: geen melding, geen status. |
| ❌ | **Pending transacties werden geïmporteerd.** Geen filter op status `BOOK`; een pending post verandert bij het boeken nog, en de ontdubbeling op inhoud ziet hem dan als nieuw. |
| ⚠️ | Toestemming vast op 90 dagen; de meeste banken staan 180 toe (`maximum_consent_validity`, in seconden). Rekeningsoort vast op `business`: een eenmanszaak met een privérekening, of een bank die alleen privé aankan, liep vast. |
| ⚠️ | Mislukt ophalen bij het koppelen meldde "0 transacties opgehaald"; een pagineringslimiet van 25 pagina's markeerde een onvolledige sync als gelukt (rest kwam nooit binnen); een tweede afronding met dezelfde code zette een geslaagde koppeling op `error`. |

## Wat er veranderd is

**`supabase/functions/_shared/bankSync.ts` (nieuw)** — de regels, zonder netwerk en zonder
Deno, zodat ze testbaar zijn: ASPSP-mapping met `psu_types`, keuze rekeningsoort,
`consentValidUntil` (het maximum van de bank, met een uur speling; `ENABLEBANKING_CONSENT_DAYS`
is nu een bovengrens in plaats van een vaste waarde), `isBookedTransaction`,
`mapEbTransaction` (verhuisd), `syncDateFrom`, `consentExpired`, `bankReturnError`,
`ebErrorCode`, `needsReconsent`.

**`supabase/functions/bank-sync/index.ts`**
- `finalizeRequisition` accepteert ook `error`/`errorDescription`: legt *afgebroken* of
  *geweigerd* vast (`status = 'error'`, met reden). Een al gekoppelde requisition wordt niet
  nog eens afgerond. Na koppelen synct hij alleen de rekeningen van díe koppeling, neemt hij
  de werkelijke geldigheid uit de sessie over, en geeft hij sync-fouten terug.
- `createRequisition` zoekt de bank op: rekeningsoort moet passen, geldigheid = maximum van de bank.
- Sync: verlopen toestemming (op `expires_at`) → meteen `expired`, zonder opvraging. Alleen
  geboekte transacties. `WRONG_TRANSACTIONS_PERIOD` → opnieuw met `strategy=longest` (en
  alleen wat in het venster valt). Paginering tot 100 pagina's; onvolledig telt niet als gelukt.
- Cron `?cron=sync` (vóór de origin-check, want pg_cron stuurt geen Origin): elke rekening met
  een geldige toestemming één keer per dag, oudste poging eerst, `BANK_SYNC_CRON_BATCH` per ronde.
- Een 401 van Enable Banking gaat als 502 naar de app (de provider weigert óns, de gebruiker is
  wel ingelogd); de foutcode staat in de melding.

**`supabase/migrations/20261030000000_bank_sync_attempts.sql`** — `bank_accounts.last_sync_attempt_at`
en `last_sync_error`. De cron kiest op de laatste *poging* (een rekening die steeds mislukt,
verdringt anders de rest), de klant ziet de reden van een mislukte sync. bank-sync werkt ook
zonder deze kolommen.

**App (`src/lib/bankLink.ts` nieuw, `Bank.tsx`, `main.tsx`)**
- Terugkeer met `?error=&state=` opent de Bankpagina met een duidelijke melding. De `state`
  moet onze UUID zijn: een Supabase-inloglink (`?code=` of `?error=access_denied`) wordt zo
  niet voor een bankterugkeer aangezien.
- Per rekening: *Toestemming verlopen op …* met *Opnieuw koppelen* (op de verloopdatum),
  *verloopt over N dagen* (vanaf twee weken ervoor), *Laatste synchronisatie mislukt: …*.
- Bankkiezer: *Zakelijke rekening* / *Privérekening*; banken die die soort niet aankunnen,
  vallen weg.
- Melding *Testomgeving* zolang de koppeling via de sandbox loopt; zo gekoppelde rekeningen
  krijgen het label *testdata*.

## Verificatie
- `npm test`: **841/841 groen** (826 bestaand + 15 nieuw in `bankSync.test.ts` en
  `bankLink.test.ts`, waaronder een vergelijking app ↔ server en een broncontrole dat de
  cron vóór de origin-check staat en pending transacties worden weggefilterd).
- `npm run typecheck` ✓, `npm run build` ✓.
- `bank-sync` getypecheckt met `tsc` (met Deno-shims): geen nieuwe fouten; de enige melding
  (`pemToDer`, `Uint8Array` vs `BufferSource`) stond er al en speelt onder Deno niet.
- Bankpagina gerenderd tegen de mock-backend van `tests/mobile` (desktop en telefoon):
  verlopen/bijna-verlopen/syncfout/testdata, terugkeer na annuleren (URL opgeschoond,
  afronding met `error` aangeroepen), bankkiezer filtert per rekeningsoort. Geen JS-fouten,
  geen horizontale overloop. `npm run test:mobile -- --pages=bank --theme=both` ✓.
- Niet getest: een echte bank. Dat kan pas met een productie-app (zie hieronder).

## Deploy
1. `supabase db push --linked` — migratie `20261030000000`.
2. `supabase functions deploy bank-sync --project-ref enzghpduqwaojcxgwarr`.
3. Branch naar `staging` → Cloudflare Pages bouwt.
4. Cron inplannen: SQL in `ENABLEBANKING_BANK_SYNC_SETUP_2026-06-25.md` § 6.

## Nog open — voordat klanten zelf koppelen
Zie `ENABLEBANKING_BANK_SYNC_SETUP_2026-06-25.md` § 7: productie-app registreren en secrets
vervangen, eerst beperkte productie met je eigen rekening, dan contract + KYB, testdata
opruimen, en een besluit over welk plan koppelen mag (nu: elk plan).

Ook bewust níét in deze ronde: saldi ophalen (`/balances`) voor de saldo-aansluiting van
gekoppelde rekeningen, PSU-headers (IP/user-agent) bij een sync door de klant zelf, en een
"Ontkoppel"-knop die de sessie bij Enable Banking intrekt (scheelt kosten per rekening als
een klant vertrekt).
