# Resend koppelen voor mail verzenden

Deze codebase gebruikt Resend server-side via Supabase Edge Functions. De browser krijgt dus nooit toegang tot `RESEND_API_KEY`.

## Wat is toegevoegd / aanwezig

- `supabase/functions/mail/index.ts` — generieke mailfunctie met een veilige testmail voor owners/admins.
- `src/services/mailService.ts` — frontend service die de `mail` Edge Function aanroept.
- Instellingenpagina — nieuwe kaart **E-mail via Resend** met knop **Verstuur testmail**.
- `supabase/functions/quote-workflow/index.ts` — offerte-mails via Resend, inclusief publieke offertelink en PDF-bijlage, waarbij de mailinhoud uit de centrale template-registry komt.
- `supabase/functions/resend-webhook/index.ts` — webhookverwerking voor delivery/open/click/bounce/fail-statussen.

## 1. Resend-domein instellen

1. Voeg je verzenddomein toe in Resend.
2. Zet de DNS-records bij je DNS-provider.
3. Wacht tot Resend het domein als verified toont.
4. Kies daarna een afzender, bijvoorbeeld:
   - `ResoFly <noreply@mail.resofly.nl>`
   - `BrandCore <offertes@mail.jouwdomein.nl>`

## 2. Supabase secrets instellen

Gebruik PowerShell vanuit de root van je project:

```powershell
supabase secrets set RESEND_API_KEY="re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
supabase secrets set RESEND_FROM_EMAIL="ResoFly <noreply@mail.jouwdomein.nl>"
supabase secrets set RESEND_REPLY_TO="hello@jouwdomein.nl"
supabase secrets set QUOTE_PUBLIC_BASE_URL="https://app.jouwdomein.nl"
supabase secrets set QUOTE_ALLOWED_ORIGINS="http://localhost:5173,https://app.jouwdomein.nl"
supabase secrets set QUOTE_PUBLIC_ALLOWED_ORIGINS="http://localhost:5173,https://app.jouwdomein.nl"
supabase secrets set MAIL_ALLOWED_ORIGINS="http://localhost:5173,https://app.jouwdomein.nl"
supabase secrets set RESEND_WEBHOOK_SIGNING_SECRET="whsec_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
supabase secrets set RESEND_WEBHOOK_ALLOW_UNSIGNED="false"
```

Voor lokale tests kun je tijdelijk gebruiken:

```powershell
supabase secrets set MAIL_ALLOW_LOCAL_DEV="true"
supabase secrets set QUOTE_ALLOW_LOCAL_DEV="true"
```

Zet dit in productie weer op `false`.

## 3. Edge Functions deployen

```powershell
supabase functions deploy mail
supabase functions deploy quote-workflow
supabase functions deploy quote-public
supabase functions deploy resend-webhook
```

## 4. Webhook in Resend aanmaken

Endpoint:

```text
https://YOUR_PROJECT.supabase.co/functions/v1/resend-webhook
```

Events die zinvol zijn voor de offerteflow:

```text
email.sent
email.delivered
email.opened
email.clicked
email.bounced
email.failed
email.complained
```

Sla de `signing_secret` op als `RESEND_WEBHOOK_SIGNING_SECRET`.

## 5. Testen vanuit de app

1. Log in als owner/admin.
2. Ga naar **Instellingen**.
3. Zoek **E-mail via Resend**.
4. Vul je e-mailadres in.
5. Klik op **Verstuur testmail**.

Als dit werkt, is de Resend-basis goed gekoppeld.

## 6. Offerte-mailflow gebruiken

1. Maak of open een offerte.
2. Zet de offerte op **Ter goedkeuring**.
3. Laat een admin/owner intern goedkeuren.
4. Klik daarna op **Verstuur via Resend**.

De Edge Function genereert dan server-side:

- een publieke, beveiligde offertelink;
- een PDF-bijlage;
- een Resend-verzendverzoek;
- delivery-statussen via webhook;
- audit/timeline-events bij de offerte.

## Belangrijke security-keuzes

- `RESEND_API_KEY` staat alleen in Supabase secrets.
- De frontend roept alleen Supabase Edge Functions aan.
- Testmail is beperkt tot owners/admins.
- CORS/origin checks blokkeren onbekende frontends.
- Resend webhook signatures worden gecontroleerd met `RESEND_WEBHOOK_SIGNING_SECRET`.

## 7. Mailtemplates en templatekeuze

Resend kiest zelf geen template. De backend rendert de juiste template server-side en stuurt kant-en-klare `subject`, `html` en `text` naar Resend.

De centrale registry staat hier:

```text
supabase/functions/_shared/emailTemplates/
  index.ts
  layout.ts
  quoteSent.ts
  testResend.ts
  types.ts
```

Huidige template keys:

```text
test.resend
quote.sent
```

Voorbeeld in een Edge Function:

```ts
const email = renderEmailTemplate('quote.sent', {
  quote,
  client,
  project,
  company,
  publicUrl,
  recipientName,
  expiresAt,
});
```

Daarna gaat naar Resend:

```ts
{
  subject: email.subject,
  html: email.html,
  text: email.text,
  tags: [{ name: 'template_key', value: email.templateKey }]
}
```

Nieuwe mailflows moeten dus niet zelf losse HTML-snippets bouwen. Voeg een nieuw templatebestand toe, registreer de key in `types.ts` en koppel hem in `index.ts`. Resend tags mogen alleen veilige ASCII-waarden bevatten; gebruik daarom altijd de bestaande `sanitizeTagValue` helper voordat je template keys of nummers als tag value meestuurt.
