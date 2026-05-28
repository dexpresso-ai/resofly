# Diagnose — Publieke factuurpagina: "Deze link werkt niet meer" — 2026-05-28 (update 2)

## Wat de eerste fix opleverde
De frontend-fix legde bloot wat de edge function teruggaf:
"Publieke factuur kon niet worden geladen." Dat is geen rauwe Supabase-fout meer
maar een eigen tekst van de functie — concreet de **catch-all 500** in
`invoice-public/index.ts`. Alle echte fouten die geen `PublicInvoiceError` zijn
(rauwe Postgres-/Supabase-fouten) werden daar onder dezelfde generieke tekst
weggepoetst en alleen naar `console.error` gelogd.

## Wat er nu in deze build verandert (twee edge functions)

### `invoice-public`
1. De 500-catch-all geeft nu de werkelijke foutreden terug (afgekapt op 500 chars).
   Dus na deze deploy zie je op de pagina precies wat er misging, zoals
   "function public.update_invoice_payment_status(...) does not exist" of
   "permission denied for table invoice_payment_records".
2. De mock-payment markering is nu **non-fataal**: als het markeren als betaald
   na de mock-checkout faalt, wordt de factuur tóch getoond en verschijnt er een
   niet-blokkerende waarschuwing (`mockPaymentWarning`) op de pagina. De webhook
   regelt de status dan alsnog.

### `quote-public`
Zelfde diagnostische verbetering in de catch-all.

## Belangrijk: deze fix vereist een edge-function deploy
De frontend is niet voldoende — `invoice-public` en `quote-public` draaien op
Supabase, niet op Cloudflare Pages. Deploy ze met:

```
supabase functions deploy invoice-public --project-ref <project-ref>
supabase functions deploy quote-public --project-ref <project-ref>
```

(Of vanuit de Supabase Dashboard, of je CI-pipeline als die de functies ook deployt.)

## Onmiddellijke check zonder deploy
De huidige Supabase-functie logt de echte fout al via `console.error`:

*Supabase Dashboard → Project → Edge Functions → `invoice-public` → Logs.*

Open de mislukte invocatie en lees de regel die begint met `invoice-public error` —
daar staat de werkelijke Postgres-/Supabase-foutmelding.

## Snelle isolatietest
De getoonde URL bevat `?mock_payment=mock_invoice_payment_…`. Test of de
weergavecode op zich werkt door de query-string te strippen:

```
https://staging.resofly.com/invoice/<token>
```

- Laadt hij **wel**: het probleem zit in de mock-payment-markeerflow
  (`maybeMarkMockPaymentPaid`), waarschijnlijk de RPC
  `update_invoice_payment_status` of de daarbinnen aangeroepen
  `create_invoice_version_snapshot`. Met de nieuwe non-fatale markering blijft de
  pagina ook met mock_payment in de URL gewoon werken.
- Laadt hij **ook niet**: het probleem zit dieper (resolveLink, loadInvoice,
  ontbrekende migratie). De nieuwe foutmelding op de pagina geeft dan precies aan
  welke.

## Meest waarschijnlijke onderliggende oorzaken (op volgorde van waarschijnlijkheid)

1. **`update_invoice_payment_status` of `create_invoice_version_snapshot` gooit een
   fout** op staging tijdens het mock-markeren. Door de non-fatale wrap blokkeert
   dat de pagina niet meer; de echte foutreden komt mee in `mockPaymentWarning`.
2. **`MOLLIE_ALLOW_MOCK` staat op `false` op staging**, terwijl de oorspronkelijke
   betaallink wél in mock-modus is aangemaakt. Geeft 403 met heldere tekst, niet de
   generieke 500.
3. **Migraties van 2026-05-27 (`finance_core_*`) zijn nog niet op staging
   toegepast**, waardoor `update_invoice_payment_status` of `resolve_invoice_public_link`
   ontbreekt of een oude signatuur heeft.
