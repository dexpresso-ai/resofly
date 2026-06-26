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
Optioneel (defaults tussen haakjes):
- `ENABLEBANKING_BASE_URL` (`https://api.enablebanking.com`)
- `ENABLEBANKING_COUNTRY` (`NL`) — land voor de bankenlijst
- `ENABLEBANKING_PSU_TYPE` (`business`) — zet op `personal` voor een privé-/sandboxrekening
- `ENABLEBANKING_CONSENT_DAYS` (`90`)
- `BANK_ALLOWED_ORIGINS` — valt terug op `APP_PUBLIC_URL` / invoice/quote-origins; meestal niet nodig

> De private sleutel is een PKCS#8 PEM (meerdere regels). `"$(cat ...pem)"` behoudt de
> regeleindes; de functie accepteert ook een met `\n` ge-escapete variant.

## 3. Edge Function deployen
```bash
npx --no-install supabase functions deploy bank-sync --project-ref enzghpduqwaojcxgwarr
```
(De migratie `20260625000005_bankfeed_direct_link.sql` moet zijn toegepast.)

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
  koppelt de rekening(en) aan grootboek 1100 en haalt meteen de eerste transacties op.
- **Synchroniseer** → `sync` haalt nieuwe transacties op vanaf de laatste sync (met
  paginering via `continuation_key`).
- Alle transacties lopen via dezelfde `import_bank_transactions` RPC → dezelfde match/boek-laag
  als de afschrift-import (fase 1).
- Toestemming verloopt na ~90 dagen → de UI toont een herauthenticatie-melding.

## Belangrijk voor "alle klanten" (productie)
- De gratis **Restricted Production** dekt alleen je **eigen / gewhiteliste** rekeningen — prima
  voor ResoFly zelf of een pilot, **niet** om aan alle klanten open te zetten.
- Voor alle klanten: **betaald productiecontract** bij Enable Banking (kosten per gekoppelde
  rekening) + **DPA** + een **prijs/gating-model** in ResoFly (wie betaalt de per-rekening-kosten).
- Auth = JWT/RS256 (gevalideerd: signing + verificatie groen). Geen verdere wijziging nodig om
  op te schalen; alleen het contract + de doorrekening.
