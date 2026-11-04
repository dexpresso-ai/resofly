# Senior review — Resend mailkoppeling

Datum: 2026-05-15
Scope: Resend-testmail, offerte-mailflow via Resend, webhookverwerking, frontend service-laag, build/dependency-check.

## Verdict

De Resend-functionaliteit is technisch correct opgezet en veilig genoeg om te deployen voor een eerste productie-/stagingtest.

De API-key blijft server-side in Supabase Edge Function secrets. De browser roept alleen Supabase Edge Functions aan. De testmail is beperkt tot owners/admins. De offerteflow verstuurt alleen intern goedgekeurde, niet-verlopen offertes en maakt server-side een publieke offertelink plus PDF-bijlage aan.

Let op: in deze sandbox is geen live Supabase-project, geen Resend API-key en geen verified Resend-domein beschikbaar. Daarom is de echte e-mailbezorging niet live verzonden. De code is wel gebouwd, typechecked, dependency-geauditeerd en statisch gereviewd.

## Direct doorgevoerde fixes

1. Edge Function foutmeldingen worden nu beter getoond in de UI.
   - Nieuw: `src/lib/functionErrors.ts`
   - Aangepast: `src/services/mailService.ts`
   - Aangepast: `src/lib/repository.ts`
   - Resultaat: server-side validatiefouten zoals ontbrekende secrets, ongeldig e-mailadres of verkeerde rechten komen niet meer alleen als generieke Supabase Function error terug.

2. Dependency security hardening.
   - `vite` bijgewerkt naar `^8.0.13`
   - `@vitejs/plugin-react` bijgewerkt naar `^6.0.2`
   - Resultaat: `npm audit --audit-level=moderate` geeft nu `found 0 vulnerabilities`.

3. Hardcoded persoonlijke fallback uit testmail verwijderd.
   - `supabase/functions/mail/index.ts`
   - Fallback is nu `Hoi daar` in plaats van een persoonsnaam.

4. Testmail gebruikt geen organisatienaam meer als ontvangersnaam.
   - `src/features/SimplePages.tsx`
   - Resultaat: geen rare mail zoals `Hoi BrandCore` of `Hoi ResoFly`.

5. Resend tag values gehard.
   - `supabase/functions/quote-workflow/index.ts`
   - `organization_id` en `quote_id` worden nu gesanitized voordat ze als Resend tag meegaan.

## Testresultaten

Uitgevoerd op een schone kopie zonder `node_modules`, zonder `dist` en zonder lokale env-bestanden:

- `npm ci --ignore-scripts` — geslaagd
- `npm run typecheck` — geslaagd
- `npm run build` — geslaagd
- `npm run lint:sql` — geslaagd, maar dit is nu nog een placeholder-script
- `npm audit --audit-level=moderate` — geslaagd, 0 kwetsbaarheden

Build-output:

- Vite: `8.0.13`
- Productiebundel bouwt succesvol
- Enige resterende waarschuwing: grote JS-bundle boven 500 kB. Dit is geen blocker voor Resend, maar later is code-splitting verstandig.

## Wat werkt functioneel in de code

### Resend-testmail

Pad:

- UI: Instellingen → E-mail via Resend
- Frontend: `src/services/mailService.ts`
- Edge Function: `supabase/functions/mail/index.ts`

Controlepunten:

- Alleen owner/admin mag testmail verzenden.
- Organisatie-toegang wordt server-side gecontroleerd.
- Ontvanger wordt gevalideerd.
- `RESEND_API_KEY` en `RESEND_FROM_EMAIL` zijn verplicht server-side.
- De browser krijgt geen Resend secret te zien.
- Succesrespons geeft `providerEmailId` terug.

### Offerte versturen via Resend

Pad:

- UI: Financiën → Offertes → Verstuur via Resend
- Frontend: `sendQuoteEmailViaResend`
- Edge Function: `supabase/functions/quote-workflow/index.ts`

Controlepunten:

- Alleen owner/admin/member met organisatierechten mag versturen.
- Alleen intern goedgekeurde offertes mogen worden verzonden.
- Verlopen offertes worden geblokkeerd.
- Klant-e-mailadres wordt gevalideerd.
- Publieke offertelink wordt server-side gegenereerd.
- PDF wordt server-side gemaakt en als attachment meegestuurd.
- Verzendpoging wordt eerst in de database voorbereid.
- Pas na Resend provider-id wordt verzending definitief als verzonden afgerond.
- Fout bij Resend wordt als mislukte verzendpoging gelogd.

### Resend webhook

Pad:

- Edge Function: `supabase/functions/resend-webhook/index.ts`

Controlepunten:

- Alleen POST toegestaan.
- Svix-signature verificatie aanwezig.
- Unsigned webhooks alleen mogelijk als `RESEND_WEBHOOK_ALLOW_UNSIGNED=true` staat.
- Replay-window via timestamp-tolerance aanwezig.
- Delivery/events worden gekoppeld aan `quote_email_deliveries`.
- Statussen zoals delivered/opened/clicked/bounced/failed worden doorgezet naar offerte en audit/timeline.

## Nog nodig voor echte live test

Zet in Supabase secrets minimaal:

```powershell
supabase secrets set RESEND_API_KEY="re_xxx"
supabase secrets set RESEND_FROM_EMAIL="ResoFly <noreply@mail.jouwdomein.nl>"
supabase secrets set RESEND_REPLY_TO="hello@jouwdomein.nl"
supabase secrets set MAIL_ALLOWED_ORIGINS="https://app.jouwdomein.nl"
supabase secrets set QUOTE_PUBLIC_BASE_URL="https://app.jouwdomein.nl"
supabase secrets set QUOTE_ALLOWED_ORIGINS="https://app.jouwdomein.nl"
supabase secrets set QUOTE_PUBLIC_ALLOWED_ORIGINS="https://app.jouwdomein.nl"
supabase secrets set RESEND_WEBHOOK_SIGNING_SECRET="whsec_xxx"
```

Deploy daarna:

```powershell
supabase functions deploy mail
supabase functions deploy quote-workflow
supabase functions deploy quote-public
supabase functions deploy resend-webhook
```

## Eerlijk resterende aandachtspunten

1. De Edge Functions konden in deze sandbox niet met Deno worden getypecheckt, omdat Deno hier niet geïnstalleerd is. De code is wel statisch gecontroleerd en de frontend compileert volledig.
2. `npm run lint:sql` is nog een placeholder. Voor echte databasekwaliteit is later een echte SQL lint/migration-check aan te raden.
3. De frontendbundle is groot. Niet blokkerend, maar later opsplitsen met dynamic imports is verstandig.
4. Live e-mailbezorging hangt af van Resend-domeinverificatie, juiste Supabase secrets en succesvolle function deploy.
