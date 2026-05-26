# Changelog — Invoice workflow runtime hardening — 2026-05-26

## Doel
De facturatieflow is opnieuw doorgelopen als end-to-end proces: offerte → factuur → publieke factuurpagina → betaallink → mock/Mollie betaling → status/timeline/audit.

## Aangepast

### Supabase Edge Function `invoice-public`
- Volledig opgeschoond en opnieuw opgebouwd zodat het bestand weer betrouwbaar bundelt/deployt.
- `client_viewed` audit logging is teruggebracht, maar defensief gemaakt: logging mag de publieke factuurpagina nooit meer laten crashen.
- Optionele relaties zoals klant, project, offerte, bedrijfsinstellingen, events, betalingen en versies worden veilig geladen. Als één optionele query faalt, blijft de publieke factuurpagina laden.
- Publieke response blijft gesanitized: `public_token_hash` wordt nooit teruggestuurd naar de browser.
- Mock-betalingen kunnen via `?mock_payment=...` vanaf de publieke factuurpagina worden afgerond wanneer `MOLLIE_ALLOW_MOCK=true` staat.

### Supabase Edge Function `invoice-workflow`
- Factuurbetalingen gebruiken nu eerst `MOLLIE_INVOICE_API_KEY` en pas daarna de algemene `MOLLIE_API_KEY`, zodat SaaS-billing en klantfactuurbetalingen gescheiden blijven.
- Nieuwe betaallinks genereren altijd een nieuwe publieke factuurtoken. Dit voorkomt dat een checkout-link naar een oude of niet-reconstrueerbare token verwijst.
- Mock-betaallinks verwijzen altijd naar `/invoice/<token>?mock_payment=<payment_id>` en vallen niet meer terug naar alleen de basis-URL.
- Hergebruik van bestaande checkoutlinks is aangescherpt: kapotte staging-links die alleen naar de app-root wijzen worden niet meer hergebruikt.

### Frontend `PublicInvoicePage`
- De publieke factuurpagina leest `mock_payment` uit de URL en geeft die mee aan `invoice-public`.
- Na verwerking van een mockbetaling wordt de querystring uit de URL opgeschoond.

### Database migratie
Nieuwe migratie toegevoegd:

```text
supabase/migrations/20260526_invoice_workflow_runtime_hardening.sql
```

Deze migratie:
- roteert en bewaart publieke factuurtokens betrouwbaarder bij nieuwe betaallinks;
- repareert bestaande mock/public checkout-URLs door de token uit `/invoice/<token>` te hashen;
- legt een `payment_created` factuurversie vast bij nieuwe betaalrecords;
- maakt `update_invoice_payment_status` idempotenter, zodat herhaalde webhooks geen dubbele paid snapshots/audit-events veroorzaken.
