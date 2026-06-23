# Bankfeed fase 2 — directe PSD2-koppeling via GoCardless (2026-06-22)

## Wat & waarom
Fase 1 leverde afschrift-import + de match/boek-engine. Fase 2 voegt de **directe
bankkoppeling** toe: de gebruiker geeft via zijn bank toestemming (PSD2/SCA) en de
`bank-sync` Edge Function haalt de transacties op. Die belanden via dezelfde
`import_bank_transactions` RPC in dezelfde `bank_transactions`-tabel en doorlopen dezelfde
match/boek-laag — alleen de ingestiebron verschilt.

## Database — `supabase/migrations/20260622000005_bankfeed_gocardless.sql`
- **`bank_requisitions`** — consent-administratie (institution, reference, requisition_id,
  link, status created/linked/expired/error, accounts, expires_at). Alleen-lezen RLS; schrijven
  via de service-role in de Edge Function.
- `bank_accounts.bank_requisition_id` — koppelt een gesynchroniseerde rekening aan zijn consent
  (voor verloop/herauthenticatie-melding).
- Unique index `(organization_id, external_account_id)` — voorkomt dubbele gekoppelde rekeningen;
  bewust niet-partieel (NULLs distinct in Postgres, dus meerdere handmatige rekeningen blijven OK).

## Edge Function — `supabase/functions/bank-sync/index.ts`
Action-routed, eigen auth (`requireUser` + `requireOrganizationAccess`), zoals invoice-workflow.
GoCardless-credentials zijn app-breede secrets (de app is de TPP); access token wordt per
aanroep opgehaald.
- `listInstitutions` — banken voor de kiezer (+ sandbox-institution voor testen).
- `createRequisition` — maakt de consent (default 90 dagen, geen expliciete agreement) en geeft
  de redirect-link terug; redirect-URL wordt gevalideerd tegen de origin-allowlist.
- `finalizeRequisition` — na de redirect (`?ref=`): leidt de org af uit de requisition, koppelt
  de rekening(en) aan grootboek 1100, en draait meteen een eerste sync. Bestaande rekeningen
  worden bijgewerkt zónder de door de gebruiker gekozen grootboekrekening te overschrijven.
- `sync` — haalt nieuwe transacties op (vanaf laatste sync − 7 dagen overlap, of 90 dagen) en
  importeert ze; bij 401/403 → consent als verlopen markeren + herauthenticatie-signaal.

Registratie in `supabase/config.toml` (`verify_jwt = false`, eigen auth).

## Front-end — `src/features/Bank.tsx`
- "Koppel bank" opent een bankkiezer (zoekbaar, met logo's) → start de koppeling → redirect.
- Terugkomst (`?ref=`) wordt in `main.tsx` naar de Bankpagina gerouteerd; `AccountsTab` rondt de
  koppeling eenmalig af en toont het resultaat.
- Gekoppelde rekeningen tonen een "Synchroniseer"-knop, laatste-sync-datum, een "gekoppeld"-label
  en een herauthenticatie-waarschuwing bij verlopen toestemming.
- Data-laag (`repository.ts`): `bankRequisitions` laden + wrappers `listBankInstitutions`,
  `createBankRequisition`, `finalizeBankRequisition`, `syncBankAccount`.
- Types (`types.ts`): `BankRequisition`, `BankInstitution`, `bank_requisition_id` op `BankAccount`.

## Deploy (vereist GoCardless-credentials — zie GOCARDLESS_BANK_SYNC_SETUP_2026-06-22.md)
1. `supabase db push` — migratie 20260622000005.
2. `supabase secrets set GOCARDLESS_SECRET_ID=… GOCARDLESS_SECRET_KEY=…`
3. `supabase functions deploy bank-sync`
4. `npm run build` + branch pushen (Cloudflare Pages).

## Verificatie
- `npm run typecheck` ✓ en `npm run build` ✓ (front-end).
- Edge Function: Deno niet lokaal beschikbaar → op patroon gereviewd (mirror van invoice-workflow,
  self-contained). Volledige flow te testen met de sandbox-bank zodra de secrets gezet zijn.

## Bewust buiten scope
- Geen automatische periodieke sync (pg_cron) — sync is nu handmatig per rekening. Kan later als
  cron-ingang op `bank-sync` (zoals de invoice-reminder-cron).
- Alleen "booked" transacties; "pending" worden overgeslagen tot ze definitief zijn.
