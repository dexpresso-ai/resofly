# Enable Banking bankkoppeling (PSD2) — setup

De `bank-sync` Edge Function koppelt bankrekeningen direct via **Enable Banking**
(EU/Fins, vergunninghoudende AISP, GDPR-conform). De credentials zijn app-breed (de
app is de TPP), dus ze staan als Edge-Function-secrets, niet per organisatie.

> **Stand 2026-10-30 (controle, zie `CHANGELOG_BANKFEED_CONTROLE_2026-10-30.md`):** de
> app achter `ENABLEBANKING_APP_ID` op staging is een **sandbox-app** — elke
> toestemmingslink wees naar `tilisy-sandbox.enablebanking.com`. Daarmee koppel je
> alleen testbanken met testgegevens, nooit een echte rekening, en Enable Banking
> zet een sandbox-app **niet** om naar productie. Voor echte rekeningen: een nieuwe
> productie-app registreren en de secrets vervangen (§ 7).

## 1. App-registratie + sleutelpaar (eenmalig)
1. Maak een account op de **Control Panel**: https://enablebanking.com/ → "Get started".
2. **API applications** (https://enablebanking.com/cp/applications) → registreer een applicatie:
   - **Omgeving**: **Production** voor echte rekeningen. *Sandbox* is alleen voor testbanken
     met testgegevens, en een app verhuist nooit van de ene omgeving naar de andere.
   - **Naam**: `ResoFly` (zien je klanten in het toestemmingsscherm van hun bank).
   - **Redirect URL('s)**: de ResoFly-app-URL's waarop de bank terugstuurt, exact zoals de app
     ze meestuurt (§ 4): `https://staging.resofly.com/` en `https://app.resofly.nl/`.
   - Productie vraagt ook: een omschrijving (ziet de klant bij de toestemming), een
     e-mailadres voor gegevensbescherming, en de URL's van privacyverklaring en voorwaarden.
   - **Sleutelpaar**: laat de browser het genereren → je downloadt `‹application-id›.pem`
     (de **private sleutel**). Bewaar die veilig.
3. Noteer het **Application ID** (= de bestandsnaam van de `.pem`).

## 2. Edge Function secrets zetten (staging)
```bash
npx --no-install supabase secrets set \
  ENABLEBANKING_APP_ID="<application-id>" \
  ENABLEBANKING_PRIVATE_KEY="$(cat <application-id>.pem)" \
  --project-ref enzghpduqwaojcxgwarr
```
Optioneel (defaults tussen haakjes):
- `ENABLEBANKING_BASE_URL` (`https://api.enablebanking.com`) — sandbox en productie gebruiken
  hetzelfde adres; de app-registratie bepaalt de omgeving
- `ENABLEBANKING_COUNTRY` (`NL`) — land voor de bankenlijst
- `ENABLEBANKING_PSU_TYPE` (`business`) — alleen de standaard: de klant kiest in de bankkiezer
  zelf *Zakelijke rekening* of *Privérekening*
- `ENABLEBANKING_CONSENT_DAYS` (leeg) — leeg = het maximum dat de bank toestaat (meestal 180
  dagen); een getal = bovengrens. Boven het maximum van de bank gaat het nooit: dan zou
  Enable Banking de hele koppeling weigeren
- `BANK_ALLOWED_ORIGINS` — valt terug op `APP_PUBLIC_URL` / invoice/quote-origins. Zet hem
  expliciet zodra productie meedoet: `https://staging.resofly.com,https://app.resofly.nl`
- `BANK_SYNC_CRON_SECRET` — voor de automatische sync (§ 6); valt terug op
  `INVOICE_REMINDER_CRON_SECRET`, dus meestal niet nodig
- `BANK_SYNC_CRON_BATCH` (`20`) — rekeningen per cron-ronde

> De private sleutel is een PKCS#8 PEM (meerdere regels). `"$(cat ...pem)"` behoudt de
> regeleindes; de functie accepteert ook een met `\n` ge-escapete variant.

## 3. Migraties + Edge Function deployen
```bash
npx --no-install supabase db push --linked
npx --no-install supabase functions deploy bank-sync --project-ref enzghpduqwaojcxgwarr
```
Nodig: `20260625000005_bankfeed_direct_link.sql` en, voor de automatische sync,
`20261030000000_bank_sync_attempts.sql`. Zonder die laatste werkt koppelen en
handmatig synchroniseren gewoon; alleen de cron faalt dan.

## 4. Redirect-URL
De app stuurt per koppeling zijn eigen `window.location.origin + pathname` mee als
redirect. Die exacte URL moet bij de **app-registratie** in stap 1 gewhitelist staan
(staging + productie). De bank hangt na de toestemming `?code=…&state=…` achter die URL;
de app detecteert dat, opent de Bankpagina en rondt de koppeling af. Breekt de klant het
af (of weigert de bank), dan komt hij terug met `?error=…&state=…`: de Bankpagina zegt
dat, en de koppeling krijgt status `error` met de reden.

## 5. Testen
In de **sandbox** staan testbanken in de bankenlijst waarmee je de volledige flow
doorloopt met testdata (geen echte bank nodig). De Bankpagina toont dan bovenaan
*Testomgeving*, en zo gekoppelde rekeningen krijgen het label *testdata*.

In **productie** (beperkt, § 7) test je met je eigen echte rekening.

## 6. Automatisch synchroniseren (pg_cron)
`bank-sync?cron=sync` werkt elke gekoppelde rekening met een geldige toestemming één keer
per dag bij (wat het langst niet aan de beurt was eerst, hooguit `BANK_SYNC_CRON_BATCH`
per ronde). Elk uur een ronde is genoeg, ook met veel klanten. Mislukt een rekening, dan
ziet de klant de reden op de Bankpagina; verlopen toestemmingen worden overgeslagen tot
de klant opnieuw koppelt.

```sql
select cron.schedule(
  'bank-sync-hourly',
  '23 * * * *',
  $$
  select net.http_post(
    url     := 'https://enzghpduqwaojcxgwarr.supabase.co/functions/v1/bank-sync?cron=sync',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<INVOICE_REMINDER_CRON_SECRET>'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
```

Handmatig testen:
```bash
curl -s -X POST "https://enzghpduqwaojcxgwarr.supabase.co/functions/v1/bank-sync?cron=sync" -H "x-cron-secret: <secret>"
# -> {"ok":true,"checked":…,"synced":…,"failed":…,"inserted":…}
```

## 7. Live voor klanten — zodat ze zelf hun bank koppelen
In de code hoeft daarvoor niets te veranderen: elke organisatie (owner/admin/member met
schrijfrecht op Financiën) kan via *Bank → Rekeningen & koppeling → Koppel bank* zelf
koppelen. Wat er wél moet gebeuren:

1. **Productie-app registreren** (§ 1, omgeving *Production*) en de twee secrets vervangen
   (§ 2). De sandbox-app kan niet worden omgezet.
2. **Beperkte productie (gratis):** koppel in het Control Panel je eigen rekening(en) aan de
   app ("linked accounts"). De app gaat dan van *Inactive* naar *Active*, maar haalt alleen
   gegevens op van die gekoppelde rekeningen — goed om zelf echt te testen, niet voor klanten.
3. **Volledige productie:** contract met Enable Banking + hun KYB-controle. Daarna kan iedere
   klant zijn eigen bank koppelen. Kosten: per gekoppelde rekening per maand, met een
   minimumfactuur — op aanvraag; herautoriseren van een al gekoppelde rekening telt niet
   als nieuwe rekening. Regel ook de verwerkersovereenkomst (DPA).
4. **Testdata opruimen:** verwijder de rekeningen met het label *testdata* (Bewerk →
   verwijderen; de testtransacties gaan mee). Geboekt is er niets op, dus dat mag.
5. **Prijsmodel in ResoFly:** nu kan elk plan (Starter, Team, Pro) koppelen, terwijl Enable
   Banking per rekening rekent. Beslis of dat zo blijft of dat koppelen alleen bij een
   bepaald plan hoort — dat is nog niet ingebouwd.

## Werking (kort)
- **Koppel bank** → de klant kiest *Zakelijke rekening* of *Privérekening* en zijn bank (de
  kiezer toont alleen banken die die soort aankunnen) → `bank-sync` start een autorisatie
  (`/auth`) met de langste toestemming die de bank toestaat en geeft de consent-link terug;
  de browser gaat naar de bank.
- Terug in de app (`?code=&state=`) → `finalizeRequisition` wisselt de code in (`/sessions`),
  koppelt de rekening(en) aan grootboek 1100, neemt de werkelijke geldigheid van de sessie
  over en haalt meteen de eerste transacties op. Lukt dat ophalen niet, dan zegt de melding dat.
- **Synchroniseer** (en de cron) → `sync` haalt nieuwe transacties op vanaf de laatste sync
  min een week (paginering via `continuation_key`; bij `WRONG_TRANSACTIONS_PERIOD` opnieuw met
  `strategy=longest`). Alleen **geboekte** transacties (status `BOOK`): een pending post
  verandert nog en zou na het boeken als tweede regel terugkomen.
- Alle transacties lopen via dezelfde `import_bank_transactions` RPC → dezelfde match/boek-laag
  als de afschrift-import (fase 1).
- Verlopen toestemming → op de verloopdatum (niet pas na een mislukte sync) toont de rekening
  *Toestemming verlopen* met *Opnieuw koppelen*; twee weken ervoor een waarschuwing.
