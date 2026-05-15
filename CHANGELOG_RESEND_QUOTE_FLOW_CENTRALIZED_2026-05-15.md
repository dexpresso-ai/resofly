# Changelog — Resend offerteflow gecentraliseerd — 2026-05-15

## Doel

Resend-mails zijn nu netjes gekoppeld aan de offerteflow, waarbij alle mailinhoud via één centrale template-registry loopt in plaats van losse HTML-snippets in workflowcode.

## Aangepast

- `supabase/functions/quote-workflow/index.ts`
  - Offerteverzending gebruikt nu `renderEmailTemplate('quote.sent', ...)` uit de centrale template-registry.
  - Oude lokale `buildQuoteEmailHtml` en `buildQuoteEmailText` helpers zijn verwijderd.
  - Resend payload gebruikt voor PDF-bijlagen het officiële patroon `filename` + base64 `content`.
  - Resend tags zijn opgeschoond zodat tag values alleen toegestane ASCII-tekens bevatten.
  - `template_key` wordt meegegeven als Resend tag, gesanitized als `quote_sent`.

- `supabase/functions/_shared/emailTemplates/`
  - Dit blijft de centrale plek voor alle mailtemplates:
    - `layout.ts` — basislayout, HTML escaping en plain-text helper.
    - `quoteSent.ts` — offerte naar klant.
    - `testResend.ts` — testmail vanuit instellingen.
    - `index.ts` / `types.ts` — typed registry.

- `src/features/SimplePages.tsx`
  - Instellingenpagina bevat nu een kaart **E-mail via Resend**.
  - Owners/admins kunnen een server-side testmail versturen via de `mail` Edge Function.

- `.env.example`
  - `MAIL_ALLOWED_ORIGINS` en `MAIL_ALLOW_LOCAL_DEV` toegevoegd aan de Resend/quote configuratie.

## Validatie

Uitgevoerd in de sandbox:

- `npm run typecheck` — geslaagd.
- `npm run build` — geslaagd.
- Edge Function TypeScript syntax-check via `typescript.transpileModule` — geslaagd voor `quote-workflow`, `mail`, `quote-public`, `resend-webhook` en alle gedeelde mailtemplates.
- `npm run lint:sql` — geslaagd, maar dit script is nog een placeholder.

## Niet live getest

Niet uitgevoerd in deze sandbox:

- echte Supabase Edge Function deploy;
- echte Resend verzending;
- echte Resend webhook callback;
- database-RPC uitvoering tegen jouw Supabase-project.

Daarvoor zijn jouw Supabase-project, secrets, verified Resend-domein en uitgevoerde SQL-migraties nodig.
