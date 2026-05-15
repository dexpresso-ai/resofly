# Changelog — centrale e-mailtemplate-registry

Datum: 2026-05-15

## Wat is aangepast

- Nieuwe centrale server-side template registry toegevoegd onder `supabase/functions/_shared/emailTemplates/`.
- Bestaande Resend-testmail gekoppeld aan template key `test.resend`.
- Bestaande offerte-mail gekoppeld aan template key `quote.sent`.
- Shared e-maillayout toegevoegd voor consistente HTML/plain-text mails.
- Resend payloads krijgen nu een `template_key` tag mee.
- Offerte-mailresponse geeft `templateKey` terug.
- Database uitgebreid met `quote_email_deliveries.template_key` voor expliciete template-tracking.
- Fresh install schema's bijgewerkt, inclusief index op `(organization_id, template_key, created_at desc)`.

## Waarom

Voorheen stonden e-mailtemplates verspreid in Edge Functions. Dat werkte, maar was op termijn rommelig zodra facturen, betaalherinneringen en klantportaaluitnodigingen erbij komen.

Met deze registry bepaalt de backend per actie welke template wordt gerenderd. Resend blijft alleen de verzendprovider.

## Huidige template keys

- `test.resend`
- `quote.sent`

## Validatie

- `npm ci --ignore-scripts` ✅
- `npm run typecheck` ✅
- `npm run build` ✅
- `npm run lint:sql` ✅
- `npm audit --audit-level=moderate` ✅ — 0 vulnerabilities
- Shared template module standalone TypeScript-check ✅

## Niet live getest

Er is geen echte Resend-mail verzonden vanuit de sandbox, omdat daarvoor Supabase secrets, een Supabase project en een verified Resend domein nodig zijn.
