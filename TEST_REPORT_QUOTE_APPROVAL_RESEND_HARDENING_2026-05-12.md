# Testreport — Quote approval + Resend hardening

Datum: 2026-05-12

## Uitgevoerd

```text
npm run typecheck
npm run build
```

## Resultaat

```text
npm run typecheck: geslaagd
npm run build: geslaagd
```

## Extra controle

De drie quote-gerelateerde Supabase Edge Functions zijn lokaal syntactisch gecontroleerd met een TypeScript-shim, omdat Deno/Supabase CLI in deze omgeving niet beschikbaar is:

```text
supabase/functions/quote-workflow/index.ts: geslaagd
supabase/functions/quote-public/index.ts: geslaagd
supabase/functions/resend-webhook/index.ts: geslaagd
```

## Belangrijkste gereviewde risico's en fixes

1. **Goedgekeurde/verzonden offertes konden inhoudelijk nog gewijzigd worden**
   - Gefixt via UI-read-only lock en database trigger `quotes_immutable_after_submission_guard`.

2. **Workflow- en e-mailtabellen waren te ruim beschrijfbaar vanuit browserclients**
   - Gefixt door insert/update RLS-policies te verwijderen; schrijven loopt via RPC/service-role.

3. **Resend-verzending bestond uit losse database-acties**
   - Gefixt met transactionele queued/sent/failed RPC's.

4. **Webhook zonder signing secret was mogelijk**
   - Gefixt: signing secret is standaard verplicht. Alleen lokaal kan unsigned expliciet worden toegestaan.

5. **Out-of-order Resend-events konden status terugzetten**
   - Gefixt met statusranking en timestamp max-logica.

6. **Oude webhook-events konden actuele quote-status overschrijven**
   - Gefixt: quote-summary wordt alleen bijgewerkt als het event hoort bij `quotes.resend_last_email_id`.

## Niet live getest

Deze onderdelen vereisen echte Supabase Edge Function deployment, secrets en een geverifieerd Resend-domein:

- daadwerkelijke Resend API-call
- echte Svix webhook-signature vanaf Resend
- publieke quote accept/reject flow tegen productie-URL

## Verwachte smoke test na deploy

1. Maak een offerte gekoppeld aan een project.
2. Dien de offerte intern in.
3. Keur de offerte intern goed als owner/admin.
4. Verstuur via Resend.
5. Controleer dat de offerte `sent` wordt en delivery-status `sent` toont.
6. Open publieke quote-link.
7. Accepteer of weiger als klant.
8. Controleer timeline, audit-log en quote-status.
9. Probeer een verzonden/geaccepteerde offerte inhoudelijk te wijzigen; dit moet geblokkeerd zijn.
10. Test een Resend webhook-event en controleer dat delivery-status en timeline worden bijgewerkt.
