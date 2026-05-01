# Sprint 2 production-ready afronding — testrapport

Datum: 2026-04-30  
Versie: `2.2.3-sprint2-production-ready`

## Uitgevoerde controles

### Statische code/syntax-controle

Uitgevoerd met TypeScript compiler API `transpileModule` op de gewijzigde kernbestanden:

- `src/features/SimplePages.tsx` — OK
- `supabase/functions/billing/index.ts` — OK
- `src/services/billingService.ts` — OK
- `src/types.ts` — OK

### Gerichte code-review controles

- Edge Function gebruikt geen `organization_billing_overview` RPC meer voor plan-change of refreshBilling vanuit service-role context.
- `BillingPlan.is_active` bestaat in het lokale Edge Function-type.
- Reusable checkout query filtert nu op `amount_cents` en `currency`.
- Idempotency-key conflict wordt geblokkeerd wanneer bedrag/valuta/plan/seats niet exact overeenkomen.
- Productieconfig vereist `MOLLIE_WEBHOOK_SECRET`.
- Refresh-token rotation gebruikt `refresh_token_version` compare-and-swap.
- `last_error` wordt pas gezet nadat fallback geen vers geroteerde token vindt.
- Migratie README bevat de volledige volgorde inclusief de nieuwe afrondingsmigratie.
- Complete fresh-install schema’s bevatten `refresh_token_version` en de prijsveilige reusable checkout-index.

## Niet volledig uitvoerbaar in deze sandbox

### `npm ci`

Niet succesvol uitvoerbaar door ontbrekende npm-cache/netwerktoegang in de sandbox. Offline install faalde op een niet-gecachete dependency (`yallist`). Zonder `node_modules` kunnen Vite/React dependencies niet worden geresolved.

### `npm run typecheck`

Uitgevoerd, maar faalde door ontbrekende dependencies/types (`react`, `react/jsx-runtime`, `lucide-react`, etc.) doordat `npm ci` niet kon worden afgerond. Dit is geen aangetoonde applicatie-typefout in de aangepaste code, maar een dependency-installatieprobleem in de sandbox.

### `npm run build`

Niet betrouwbaar uitvoerbaar zonder geïnstalleerde dependencies.

### `npm run lint`

Niet uitvoerbaar: er is geen `lint` script aanwezig in `package.json`. Er bestaat alleen `lint:sql` als placeholder.

### `npm test`

Niet uitvoerbaar: er is geen `test` script aanwezig in `package.json`.

### Live Mollie/Supabase tests

Niet uitgevoerd in de sandbox, omdat daarvoor een Supabase project, Edge Function deployment, production secrets en een Mollie Connect testaccount nodig zijn.

## Acceptatiecheck per punt

| Onderdeel | Resultaat | Toelichting |
|---|---:|---|
| Starter → Team checkout | Code gereed | Server-side flow gebruikt target plan, amount en Mollie checkout. Live test nog nodig. |
| Team → Pro checkout | Code gereed | Zelfde flow, prijs/upgrades server-side bepaald. Live test nog nodig. |
| Custom checkout geblokkeerd | OK | Server-side `targetPlan.is_custom` block. |
| Inactief plan geblokkeerd | OK | Server-side `!targetPlan.is_active` block. |
| Niet-admin geblokkeerd | OK | JWT + `organization_members` role check vóór actie. |
| Auth.uid/service-role mismatch | OK | Billing overview RPC is uit Edge Function interne billingberekening gehaald. |
| Zelfde checkout hergebruikt | OK op code-review | Exacte shape + bedrag/valuta vereist. |
| Prijswijziging maakt nieuwe checkout | OK op code-review | Oude open checkout met ander bedrag/valuta matcht niet meer. |
| Duplicate webhook muteert seats niet dubbel | OK op SQL-review | Processed/ignored event en `processed_at` guard. Live test nog nodig. |
| Webhook verkeerde secret | OK op code-review | 401 bij mismatch. |
| Productie zonder webhook secret | OK op code-review | `assertProductionBillingConfig` faalt veilig. |
| Refresh-token concurrency | OK op code-review | CAS + fallback zonder premature `last_error`. |
| Migratie/fresh install | OK op bestandscontrole | Schema’s en README bijgewerkt. Database-run nog nodig. |

## Oordeel

- **Staging:** GO, mits je in je eigen omgeving eerst `npm ci`, `npm run typecheck`, `npm run build` en de Supabase migraties draait.
- **Productie:** NO-GO totdat staging succesvol is getest met echte Supabase Edge Function deployment, Mollie Connect sandbox/live testaccount, webhook-secret validatie en duplicate webhook replay-test.
