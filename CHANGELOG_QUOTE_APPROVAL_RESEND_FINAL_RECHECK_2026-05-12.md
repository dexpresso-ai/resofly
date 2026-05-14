# Changelog — Quote Approval + Resend Final Recheck

Datum: 2026-05-12

## Doel
Tweede grondige software-engineering en test-engineering review van de offerteflow, met directe fixes op risico's die niet automatisch door TypeScript/build worden gevangen.

## Gevonden en opgeloste punten

### 1. Workflowvelden waren nog te direct muteerbaar
Hoewel de UI de statusvelden netjes via RPC/Edge Functions liet lopen, kon een kwaadwillende browserclient met schrijfrechten theoretisch rechtstreeks `quotes.status`, approvalvelden, publieke tokenvelden of e-mailstatusvelden muteren.

**Fix**
Nieuwe databaseguard toegevoegd:

- `public.enforce_quote_workflow_fields_server_only()`
- trigger `quotes_workflow_fields_server_only_guard`

Deze blokkeert directe browsermutaties op workflow-, token-, klantbeslissing- en e-mailstatusvelden. Trusted SECURITY DEFINER RPC's en service-role Edge Functions blijven werken.

### 2. Helper-RPC's voor timeline/audit waren te ruim aanroepbaar
`insert_quote_workflow_event` en `insert_quote_audit_event` konden nog direct door authenticated browserclients worden aangeroepen, waardoor timeline/audit-events vervalst konden worden binnen een organisatie.

**Fix**
Directe browserrechten ingetrokken. Alleen `service_role` krijgt expliciet execute-rechten; interne SECURITY DEFINER workflowfuncties kunnen de helpers blijven gebruiken.

### 3. Interne goedkeuring kon te ruim vanuit draft
De eerdere functie liet admins in bepaalde gevallen direct vanuit `draft` goedkeuren. Dat is functioneel handig, maar niet strak genoeg voor een echte goedkeuringsflow.

**Fix**
`approve_quote_internal` vereist nu strikt:

- `status = pending_internal_approval`
- `internal_approval_status = pending`
- minimaal één offerteregel

### 4. Herindienen na interne afwijzing liet oude approvalvelden deels staan
Na een afwijzing werd de offerte weer concept, maar bij opnieuw indienen was het schoner om oude approval/rejection metadata te resetten.

**Fix**
`submit_quote_for_internal_approval` reset nu oude approval/rejection velden bij opnieuw indienen.

### 5. Verlopen offertes konden nog via token worden beoordeeld
De publieke token had een eigen TTL, maar de zakelijke `valid_until` van de offerte moest óók leidend zijn.

**Fix**
- `quote-public` blokkeert publieke beoordeling zodra `valid_until` in het verleden ligt.
- `accept_quote_public` blokkeert acceptatie van verlopen offertes op database/RPC-niveau.
- `quote-workflow` en `begin_quote_email_send` blokkeren verzending van verlopen offertes.

### 6. Resend webhook-replaybeveiliging
De webhooksignature werd gevalideerd, maar timestamp freshness werd nog niet expliciet afgedwongen.

**Fix**
`resend-webhook` controleert nu `svix-timestamp` met een configureerbare replay-window:

```text
RESEND_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS=300
```

### 7. Timeline-spam door publieke pagina refreshes
Elke publieke page-load kon een nieuw `client_viewed` event schrijven.

**Fix**
`quote-public` schrijft nog maar één `client_viewed` event per offerte per 10 minuten.

## Nieuwe migratie

```text
supabase/migrations/20260515_quote_approval_resend_flow_final_recheck.sql
```

Deze is ook toegevoegd aan:

```text
supabase/schema.sql
supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql
supabase/BRANDCORE_DATABASE_SETUP.sql
```

## Aangepaste Edge Functions

```text
supabase/functions/quote-workflow/index.ts
supabase/functions/quote-public/index.ts
supabase/functions/resend-webhook/index.ts
```

## Aangepaste configuratie

```text
.env.example
```

Toegevoegd:

```text
RESEND_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS=300
```
