# Test report — Facturatieproces: geldprecisie + Mollie-betaalhardening — 2026-05-28

Reviewer-rol: senior developer, in opdracht van de productowner.
Scope: facturatieproces — bedragberekening, btw, PDF, offerte→factuur-conversie en
het aanmaken/afhandelen van Mollie-betaallinks.

## Samenvatting

De codebase compileerde schoon (`tsc --noEmit` slaagde) en de happy-path werkte.
De gemelde "werkt niet goed"-klacht bleek geen crash maar een set
**geldcorrectheid- en betaalintegriteitsdefecten** — de gevaarlijkste klasse fouten
voor een facturatiemodule, omdat ze stil verkeerde bedragen en onmogelijke
betaalstatussen opleveren.

Alle bevindingen zijn gefixt, geverifieerd met 5000 gerandomiseerde facturen,
een schone `tsc`, een geslaagde `vite build` en een geslaagde esbuild-bundel van
de edge function.

## Bevindingen en fixes

### B1 — Float-besmetting in alle bedragen (hoog)
`total()` in `format.ts` somde floats. `0.1 + 0.2 = 0.30000000000000004`.
Het naar Mollie gestuurde bedrag werd berekend als `Math.round(total * 100)` op zo'n
besmette float, met centafwijkingsrisico tussen UI, PDF, database en werkelijke betaling.

**Fix:** nieuwe centrale module `src/lib/money.ts` rekent in hele centen met
"round half away from zero". `format.ts#total()` delegeert hiernaar, dus de hele app
(dashboards, klantoverzichten, editor, PDF) wordt automatisch cent-exact.
`computeTotals()` levert `totalCents` voor de betaalprovider. De edge function
`invoice-workflow` heeft een identieke cent-exacte `calculateTotals` gekregen en
gebruikt nu `totalCents` i.p.v. de float-afronding.

### B2 — Geen wettelijke btw-uitsplitsing per tarief (hoog)
Bij gemengde tarieven (21%/9%/0%) toonde de factuur één samengevoegd "BTW"-bedrag.
NL-facturen vereisen een uitsplitsing per tarief; btw hoort per tarief afgerond.

**Fix:** `computeTotals()` groepeert grondslag per tarief, rondt btw per tarief af en
levert een `vatBreakdown`. De frontend-PDF (`pdf.ts`), de edge-function-PDF en het
factuurdetail-paneel tonen nu de uitsplitsing per tarief. Bij één tarief blijft de
weergave compact.

### B3 — Regeltotalen sloten niet aan op het eindtotaal (middel)
Per regel werd apart afgerond terwijl het totaal in één keer werd berekend; klassieke
"1 cent eraf" tussen de som van de regels en de footer.

**Fix:** gedeelde `lineGross`/`lineNet` helpers (cent-exact) gebruikt in editor,
detailtabel en beide PDF-generatoren. Som van regels == footertotaal, gegarandeerd.

### B4 — Negatieve aantallen/prijzen geaccepteerd (middel)
`min="0"` op de inputs dwong niets af bij plakken/typen.

**Fix:** `updateLine` klemt aantal/prijs op ≥ 0 en btw op ≤ 100%. Aanvullend blokkeert
`saveEdit` het opslaan van een offerte/factuur zonder geldige regel of met een totaal
van € 0,00.

### B5 — Mollie-webhook kon een betaalde betaling degraderen (hoog, integriteit)
`update_invoice_payment_status` (2026-05-27) overschreef de status ALTIJD met de
inkomende webhookstatus. Mollie levert webhooks "at least once" en zonder
volgordegarantie. Een late/dubbele `expired`/`failed`/`open` webhook kon een al op
`paid` gezette betaling terugzetten, terwijl de factuur op `paid` bleef — een
onmogelijke combinatie (factuur betaald, betaalrecord mislukt) die reconciliatie breekt.

**Fix:** nieuwe migratie `20260528_invoice_payment_state_precedence_hardening.sql`
introduceert een statusprioriteit. Een nieuwe status vervangt de bestaande alleen als
die verder in de levenscyclus ligt; `paid` is definitief en kan niet worden
gedegradeerd. `refunded`/`charged_back` mogen wel ná `paid` volgen. Late webhooks zijn
idempotent: metadata en `last_webhook_at` worden bijgewerkt, maar er volgen geen dubbele
snapshots/events/audit-logs.

## Wat al correct was (geen wijziging nodig)

- **`begin_invoice_payment_checkout`**: `FOR UPDATE` op de factuur, dedup van actieve
  betaalrecords, stabiele server-side idempotency-key, factuurvergrendeling. Robuust
  tegen dubbelklik en race conditions.
- **`fail_invoice_payment_checkout`**: bewaakt al tegen het overschrijven van `paid`
  en regelt retry/backoff via `finance_provider_jobs`.
- **`convert_accepted_quote_to_invoice`**: advisory lock + `FOR UPDATE` + idempotente
  teruggave van bestaande factuur + regels uit de onveranderlijke geaccepteerde
  versie-snapshot (niet de live offerte). Geen dubbele facturen mogelijk.
- De checkout-laag hergebruikt een herbruikbare bestaande checkout-URL en geeft een
  nette 409 zolang een betaallink wordt voorbereid.

## Uitgevoerde verificatie

```
tsc --noEmit                      -> slaagt (0 fouten)
vite build                        -> slaagt (alleen pre-existing chunk-size waarschuwing)
esbuild invoice-workflow bundle   -> slaagt (53.8kb)
money-module testsuite            -> 7/7 PASS, incl. 5000 random facturen cent-exact
```

## Aangeraden staging-scenario's (handmatig)

1. Factuur met gemengde btw (21%/9%/0%): controleer per-tarief-uitsplitsing in PDF,
   detailpaneel en dat subtotaal + btw == totaal.
2. Bedrag met afrondingsrand (bv. 3× 24,95 @ 21%): UI-totaal == PDF-totaal == Mollie-bedrag.
3. Dubbelklik betaallink: één actief record, tweede klik hergebruikt URL of nette 409.
4. Webhook out-of-order: stuur `paid` en daarna `expired` voor dezelfde payment;
   verwacht dat de status `paid` blijft en de factuur betaald blijft.
5. Opslaan blokkades: lege regels / totaal € 0,00 wordt geweigerd; negatief aantal/prijs
   wordt geklemd naar 0.

## Gewijzigde bestanden

- `src/lib/money.ts` (nieuw)
- `src/lib/format.ts`
- `src/lib/pdf.ts`
- `src/features/Finance.tsx`
- `src/main.tsx`
- `supabase/functions/invoice-workflow/index.ts`
- `supabase/migrations/20260528_invoice_payment_state_precedence_hardening.sql` (nieuw)
