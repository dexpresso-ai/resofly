# Bankfeed fase 2 — directe PSD2-koppeling via Enable Banking (2026-06-25)

## Wat & waarom
Fase 1 leverde afschrift-import + de match/boek-engine. Fase 2 voegt de **directe
bankkoppeling** toe: de gebruiker geeft via zijn bank toestemming (PSD2/SCA) en de
`bank-sync` Edge Function haalt de transacties op. Die belanden via dezelfde
`import_bank_transactions` RPC in dezelfde `bank_transactions`-tabel en doorlopen dezelfde
match/boek-laag — alleen de ingestiebron verschilt.

**Provider: Enable Banking** (EU/Fins, vergunninghoudende AISP, GDPR-conform). GoCardless/
Nordigen nam geen nieuwe klanten meer aan; het datamodel is provider-generiek (kolom
`provider`) zodat wisselen geen migratie kost.

## Database — `supabase/migrations/20260625000005_bankfeed_direct_link.sql`
- **`bank_requisitions`** — consent-administratie (institution, country, reference=`state`,
  requisition_id=`session_id`, link, status, accounts, expires_at). Alleen-lezen RLS; schrijven
  via de service-role in de Edge Function.
- `bank_accounts.bank_requisition_id` + verbrede `source`-check (`+enablebanking`) +
  `bank_statements.format`-check (`+enablebanking`).
- Unique index `(organization_id, external_account_id)` — niet-partieel (NULLs distinct).

## Edge Function — `supabase/functions/bank-sync/index.ts`
Action-routed, eigen auth (`requireUser` + `requireOrganizationAccess`). Enable Banking-auth
via een **JWT (RS256)** gesigneerd met de private sleutel (Web Crypto, PKCS#8) en `kid` = App ID.
- `listInstitutions` — `GET /aspsps?country=NL`.
- `createRequisition` — `POST /auth` (consent, default 90 dagen) → redirect-link; redirect-URL
  gevalideerd tegen de origin-allowlist.
- `finalizeRequisition` — na de redirect (`?code=&state=`): org uit `state`, `POST /sessions`
  (code → session + accounts), rekening(en) koppelen aan grootboek 1100, eerste sync.
  Bestaande rekeningen worden bijgewerkt zónder de gekozen grootboekrekening te overschrijven.
- `sync` — `GET /accounts/{uid}/transactions` met paginering (`continuation_key`); 401/403 →
  consent als verlopen markeren + herauthenticatie-signaal.

Transactie-mapping: teken uit `credit_debit_indicator` (CRDT/DBIT), tegenpartij debtor/creditor,
omschrijving uit `remittance_information`, dedup op `entry_reference`/`transaction_id`.

Registratie in `supabase/config.toml` (`verify_jwt = false`, eigen auth).

## Front-end — `src/features/Bank.tsx`
- "Koppel bank" → bankkiezer (zoekbaar) → start koppeling → redirect.
- Terugkomst (`?code=&state=`) → `main.tsx` routet naar de Bankpagina; `AccountsTab` rondt
  eenmalig af. Gekoppelde rekeningen tonen "Synchroniseer", laatste-sync, "gekoppeld"-label en
  een herauthenticatie-waarschuwing bij verlopen toestemming.
- Data-laag/types: `bankRequisitions`, wrappers `listBankInstitutions`/`createBankRequisition`/
  `finalizeBankRequisition({code,state})`/`syncBankAccount`; `BankAccountSource +enablebanking`.

## Verificatie
- `npm run typecheck` ✓ en `npm run build` ✓ (front-end).
- **JWT-signing getest** (Node, 9 asserts): RS256-handtekening gesigneerd met `crypto.subtle` +
  PKCS#8 PEM, geverifieerd met de publieke sleutel; `\n`-escaping van de secret afgedekt.
- Edge Function verder op patroon gereviewd (Deno niet lokaal); end-to-end te testen met de
  Enable Banking sandbox zodra de secrets gezet zijn.

## Go-live (zie ENABLEBANKING_BANK_SYNC_SETUP_2026-06-25.md)
1. App registreren bij Enable Banking + sleutelpaar → `supabase secrets set` (APP_ID + PRIVATE_KEY).
2. Migratie 20260625000005 toepassen + `supabase functions deploy bank-sync` + branch pushen.
3. Voor **alle klanten**: betaald productiecontract + DPA + prijs/gating-model (kosten per rekening).

## Bewust buiten scope
- Geen periodieke auto-sync (pg_cron) — sync is handmatig per rekening.
- Alleen "booked" transacties.
