# Enable Banking bankkoppeling (PSD2) — setup

De `bank-sync` Edge Function koppelt bankrekeningen direct via **Enable Banking**
(EU/Fins, vergunninghoudende AISP, GDPR-conform). De credentials zijn app-breed (de
app is de TPP), dus ze staan als Edge-Function-secrets, niet per organisatie.

## 1. App-registratie + sleutelpaar (eenmalig)
1. Maak een account op de **Control Panel**: https://enablebanking.com/ → "Get started".
2. **API applications** (https://enablebanking.com/cp/applications) → registreer een applicatie:
   - **Naam**: `ResoFly` (zien je klanten in het toestemmingsscherm van hun bank).
   - **Redirect URL('s)**: de ResoFly-app-URL(s) waarop de bank terugstuurt — eerst de
     **staging-URL**, later productie. Deze moeten hier gewhitelist staan.
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
Voor de geplande sync (sinds 2026-10-18) ook een gedeeld secret, alleen voor de cron:
```bash
npx --no-install supabase secrets set BANK_SYNC_CRON_SECRET="$(openssl rand -hex 32)" \
  --project-ref enzghpduqwaojcxgwarr
```

Optioneel (defaults tussen haakjes):
- `ENABLEBANKING_BASE_URL` (`https://api.enablebanking.com`)
- `ENABLEBANKING_COUNTRY` (`NL`) — land voor de bankenlijst
- `ENABLEBANKING_PSU_TYPE` (`business`) — zet op `personal` voor een privé-/sandboxrekening
- `ENABLEBANKING_CONSENT_DAYS` (`180`) — hoe lang een toestemming loopt; per bank begrensd door
  wat die toestaat (`maximum_consent_validity`). Is dat maximum niet op te halen, dan 90 dagen.
- `BANK_ALLOWED_ORIGINS` — valt terug op `APP_PUBLIC_URL` / invoice/quote-origins; meestal niet nodig

> De private sleutel is een PKCS#8 PEM (meerdere regels). `"$(cat ...pem)"` behoudt de
> regeleindes; de functie accepteert ook een met `\n` ge-escapete variant.

## 3. Edge Function deployen
```bash
npx --no-install supabase functions deploy bank-sync --project-ref enzghpduqwaojcxgwarr
```
(De migratie `20260625000005_bankfeed_direct_link.sql` moet zijn toegepast.)

## 3b. Geplande sync inrichten (pg_cron + pg_net)
Eén job, elk uur. Per aanroep haalt `bank-sync` de gekoppelde rekeningen op die aan de beurt
zijn: toestemming geldig, langer dan twaalf uur niet opgehaald, langst geleden eerst, binnen
een tijdsbudget van 100 seconden (wat niet past, komt het uur erna). Zo wordt elke rekening
zonder handwerk twee keer per dag bijgewerkt — binnen de PSD2-grens van vier opvragingen per
24 uur zonder dat de gebruiker erbij is (een sync vraagt transacties én saldo op). Een klik op
"Synchroniseer" telt daar niet voor mee: dan gaan IP en browser van de gebruiker mee als
PSU-headers. Dezelfde ronde zet verlopen toestemmingen op `expired`.

```sql
select cron.schedule(
  'bank-sync-hourly',
  '17 * * * *',                     -- elk uur op :17 (niet op het hele uur, dan is het druk)
  $$
  select net.http_post(
    url    := 'https://enzghpduqwaojcxgwarr.functions.supabase.co/bank-sync?cron=sync',
    headers:= jsonb_build_object('content-type','application/json','x-cron-secret','<BANK_SYNC_CRON_SECRET>'),
    body   := '{}'::jsonb
  );
  $$
);
```

Rooktest (verwacht 401 = de functie leeft en de secret-check werkt):
```bash
curl -s -X POST "https://enzghpduqwaojcxgwarr.functions.supabase.co/bank-sync?cron=sync" -H "x-cron-secret: fout"
```
Met het goede secret geeft hij een samenvatting terug, bijvoorbeeld
`{"ok":true,"expiredConsents":0,"due":4,"synced":4,"failed":0,"inserted":12,"needsReconsent":0,"rateLimited":0,"truncated":0,"postponed":0,"ms":8123}`.
Het secret staat nooit in een migratie of in git.

## 4. Redirect-URL
De app stuurt per koppeling zijn eigen `window.location.origin + pathname` mee als
redirect. Die exacte URL moet bij de **app-registratie** in stap 1 gewhitelist staan
(staging + productie). De bank hangt na de toestemming `?code=…&state=…` achter die URL;
de app detecteert dat, opent de Bankpagina en rondt de koppeling af.

## 5. Testen
Enable Banking heeft een **sandbox/mock-bank** in de bankenlijst waarmee je de volledige
flow kunt doorlopen met testdata (geen echte bank nodig). Voor de mock-bank werkt
`ENABLEBANKING_PSU_TYPE=personal` doorgaans het best.

## Werking (kort)
- **Koppel bank** → `bank-sync` start een autorisatie (`/auth`) en geeft de consent-link terug;
  de browser gaat naar de bank.
- Terug in de app (`?code=&state=`) → `finalizeRequisition` wisselt de code in (`/sessions`),
  koppelt de rekening(en) en haalt meteen de eerste transacties op. Een rekening die al bestaat
  (zelfde extern id of IBAN, bijvoorbeeld na opnieuw koppelen) wordt hergebruikt. Een nieuwe
  rekening komt op 1100; deelt hij die met een rekening met een ander IBAN, dan krijgt hij een
  eigen grootboekrekening (1110, 1120, …) via `assign_own_bank_ledger_account`.
- **Synchroniseer** (of de geplande sync) → haalt nieuwe transacties op vanaf een week vóór de
  laatste sync, alle pagina's via `continuation_key` (hoogstens 100 per keer; afgekapt = het
  startpunt blijft staan en de volgende sync gaat verder). Alleen geboekte transacties komen
  binnen; pending (`PDNG`, `SCHD`, `HOLD`) komt later vanzelf als geboekt terug, geweigerd of
  geannuleerd (`RJCT`, `CNCL`) nooit, en een onbekende status wordt gemeld.
- Een overboeking naar of van een andere eigen rekening wordt herkend: voorstel 1190
  Kruisposten bankrekeningen. Beide kanten daarop geboekt vallen tegen elkaar weg.
- Daarna haalt `sync` het **geboekte saldo** op (`/accounts/{uid}/balances`) en legt het vast
  met `record_bank_balance`, zodat de saldo-aansluiting ook voor gekoppelde rekeningen werkt
  (sinds 2026-10-18; migratie `20261018000000` moet vóór de functie zijn toegepast).
- Alle transacties lopen via dezelfde `import_bank_transactions` RPC → dezelfde match/boek-laag
  als de afschrift-import (fase 1). Afletteren tegen een factuur zet die op betaald zodra het
  openstaande bedrag is voldaan.
- **Toestemming**: standaard 180 dagen, begrensd door wat de bank toestaat. De rekeningkaart
  toont tot wanneer; twee weken vooraf een gele waarschuwing met **Opnieuw koppelen** (zelfde
  bank, de rekeningen en hun boekingen blijven), daarna rood. Staat de beslislijst aan, dan zet
  die twee weken vooraf een kaart klaar ("Banktoestemming verloopt"); die vervalt zodra de
  rekeningen aan een nieuwe toestemming hangen.
- **Fouten**: een 401/403 bij het ophalen betekent óf een verlopen toestemming (de rekening
  krijgt "koppel opnieuw") óf een probleem met onze eigen sleutel — `GET /application` maakt het
  onderscheid, zodat een sleutelfout niet alle koppelingen op verlopen zet. Een 429 geeft
  "probeer het over een uur", een sessiefout (`EXPIRED_SESSION` e.d.) "koppel opnieuw". De
  technische details staan in de logs van de functie.

## Belangrijk voor "alle klanten" (productie)
- De gratis **Restricted Production** dekt alleen je **eigen / gewhiteliste** rekeningen — prima
  voor ResoFly zelf of een pilot, **niet** om aan alle klanten open te zetten.
- Voor alle klanten: **betaald productiecontract** bij Enable Banking (kosten per gekoppelde
  rekening) + **DPA** + een **prijs/gating-model** in ResoFly (wie betaalt de per-rekening-kosten).
- Auth = JWT/RS256 (gevalideerd: signing + verificatie groen). Geen verdere wijziging nodig om
  op te schalen; alleen het contract + de doorrekening.
