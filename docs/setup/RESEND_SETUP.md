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

Zet daarnaast de domein-events aan. Daarmee werkt ResoFly de status van een
eigen verzenddomein zelf bij zodra Resend het (opnieuw) controleerde, ook als
niemand op "Verifieer" klikt (zie hoofdstuk 8):

```text
domain.created
domain.updated
domain.deleted
```

Sla de `signing_secret` op als `RESEND_WEBHOOK_SIGNING_SECRET`.

Let op de naam van dat secret. Op staging stond op 6 november 2026 een secret
met de naam `RESEND_WEBHOOK_SIGNING_SECRET="jouw_resend_webhook_secret"`:
naam en voorbeeldwaarde samen in het naamveld van het dashboard. Het secret
`RESEND_WEBHOOK_SIGNING_SECRET` zelf bestond dus niet, en `resend-webhook`
weigerde elk bericht van Resend (geen afleverstatussen, geen domeinstatus).
Controleer het met `supabase secrets list`: de naam moet precies
`RESEND_WEBHOOK_SIGNING_SECRET` zijn, de waarde begint met `whsec_`.

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

## 8. Eigen verzenddomein per organisatie

Een organisatie kan in **Instellingen → E-mail → Eigen verzenddomein** haar
eigen domein koppelen. Mail van die organisatie (offertes, facturen,
herinneringen, contracten, klantmail, campagnes) gaat dan weg als
bijvoorbeeld `Bakkerij <info@bakkerij.nl>`, en antwoorden komen op dat adres
binnen.

Hoe het werkt:

1. Een owner of admin vult het domein en het afzenderadres in. De `mail`-
   functie maakt het domein aan in het **gedeelde** Resend-account van
   ResoFly (`POST /domains`, regio `RESEND_DEFAULT_REGION`, standaard
   `eu-west-1`, alleen versturen: `receiving` staat uit).
2. Het scherm toont de DNS-records die Resend teruggeeft (DKIM op
   `resend._domainkey`, SPF/MX op `send`), met per record of Resend hem al
   gevonden heeft. De MX hoort alleen bij `send.<domein>`: de gewone MX-records
   van het domein blijven staan.
3. Na "Verifieer" controleert Resend de records op de achtergrond. Het scherm
   vraagt een minuut lang elke tien seconden de stand op; daarna werkt de
   webhook (`domain.updated`) hem bij.
4. Pas als de status `verified` is, versturen de functies vanaf het domein
   (`_shared/sendingDomain.ts`). Hapert een record later, dan vallen ze terug
   op `RESEND_FROM_EMAIL`.

Wat nodig is:

- `RESEND_API_KEY` met **Full access**. Een sleutel met alleen
  "Sending access" mag geen domeinen aanmaken of controleren.
- De domein-events in de webhook (hoofdstuk 4) en een juist
  `RESEND_WEBHOOK_SIGNING_SECRET`.
- Genoeg domeinen in het Resend-abonnement. Alle organisaties delen één
  account: elk gekoppeld domein (ook een dat nooit geverifieerd wordt) telt
  mee. Pro heeft er 10, Scale 1.000; daarboven is er een uitbreiding. Een
  organisatie kan er zelf maximaal vijf koppelen.

Wie mag een domein koppelen? Een domein hoort bij hooguit één organisatie
(`_shared/resendDomains.ts`, `judgeDomainClaim`). Is het ooit geverifieerd,
dan blijft het van die organisatie, met de domeinen erboven en eronder. Een
koppeling die na zeven dagen nog nooit geverifieerd is, mag een andere
organisatie overnemen; de oude koppeling verdwijnt dan ook bij Resend.
