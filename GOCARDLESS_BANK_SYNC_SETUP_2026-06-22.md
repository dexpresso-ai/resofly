# GoCardless bankkoppeling (PSD2) — setup

De `bank-sync` Edge Function koppelt bankrekeningen direct via **GoCardless Bank Account
Data** (voorheen Nordigen). De credentials zijn app-breed (de app is de TPP), dus ze staan
als Edge-Function-secrets, niet per organisatie.

## 1. GoCardless-account + credentials
1. Maak een gratis account op de **Bank Account Data**-portal:
   https://bankaccountdata.gocardless.com/ (Nordigen/GoCardless).
2. Ga naar **Developers → User secrets** en maak een nieuw secret-paar aan.
3. Noteer `secret_id` en `secret_key`.

## 2. Edge Function secrets zetten (staging)
```bash
npx --no-install supabase secrets set \
  GOCARDLESS_SECRET_ID="<secret_id>" \
  GOCARDLESS_SECRET_KEY="<secret_key>" \
  --project-ref enzghpduqwaojcxgwarr
```
Optioneel (defaults tussen haakjes):
- `GOCARDLESS_BASE_URL` (`https://bankaccountdata.gocardless.com/api/v2`)
- `GOCARDLESS_COUNTRY` (`nl`) — land voor de bankenlijst
- `BANK_ALLOWED_ORIGINS` — komma-gescheiden front-end origins. Valt automatisch terug op
  `APP_PUBLIC_URL` / `INVOICE_ALLOWED_ORIGINS` / `QUOTE_ALLOWED_ORIGINS`, dus meestal niet nodig.

> CORS + de toegestane redirect-URL leunen op dezelfde origin-allowlist als de andere
> functies. Zorg dat `APP_PUBLIC_URL` (of `BANK_ALLOWED_ORIGINS`) de staging-/productie-URL bevat.

## 3. Edge Function deployen
```bash
npx --no-install supabase functions deploy bank-sync --project-ref enzghpduqwaojcxgwarr
```
(De migratie `20260622000005_bankfeed_gocardless.sql` moet via `supabase db push` zijn toegepast.)

## 4. Redirect-URL
Er hoeft niets vooraf geregistreerd te worden: per koppeling stuurt de app zijn eigen
`window.location.origin + pathname` mee als redirect. GoCardless hangt daar na de toestemming
`?ref=<reference>` achter; de app detecteert dat, opent de Bankpagina en rondt de koppeling af.

## 5. Testen zonder echte bank
De bankkiezer bevat onderaan **"Sandbox Finance (test)"** (`SANDBOXFINANCE_SFIN0000`). Kies die
om de volledige flow (toestemming → terugkomst → rekeningen koppelen → transacties ophalen) te
testen met door GoCardless gegenereerde testdata.

## Werking (kort)
- **Koppel bank** → `bank-sync` maakt een GoCardless *requisition* en geeft de consent-link terug;
  de browser gaat naar de bank.
- Terug in de app (`?ref=`) → `finalizeRequisition` koppelt de rekening(en) aan een grootboek-
  rekening (1100) en haalt meteen de eerste transacties op.
- **Synchroniseer** (per rekening) → `sync` haalt nieuwe transacties op vanaf de laatste sync.
- Alle transacties lopen via dezelfde `import_bank_transactions` RPC → dezelfde match/boek-laag
  als de afschrift-import (fase 1).
- De toestemming verloopt na ~90 dagen; daarna toont de UI een herauthenticatie-melding en
  koppel je de bank opnieuw.
