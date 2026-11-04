# Changelog — aanpasbare e-mailteksten per organisatie

Datum: 2026-06-17

## Wat is aangepast

Gebruikers kunnen nu zelf de tekst van hun uitgaande e-mails bepalen, per
organisatie. Het gaat om alle klantmails die via de centrale template-registry
lopen:

- Offerte versturen (`quote.sent`)
- Factuur versturen (`invoice.sent`)
- Betalingsherinneringen niveau 1, 2 en 3 (`invoice.reminder.1/2/3`)
- Creditfactuur versturen (`creditNote.sent`)

Per e-mail zijn aanpasbaar: **onderwerp**, **aanhef & bericht**, **afsluiting** en
**knoptekst**. De structurele inhoud — bedragen, datums, de beveiligde link en de
PDF-bijlage — blijft door de backend bepaald en is bewust níét aanpasbaar.

### Database

- Nieuwe tabel `public.email_templates` (migratie
  `20260619000000_email_template_content.sql`): één rij per organisatie per
  template-sleutel met `subject`, `intro`, `closing`, `cta_label`, `enabled`.
- RLS spiegelt `company_settings`: lezen mag elk lid (`can_read_org`), aanpassen
  alleen owners/admins (`can_admin_org`).
- Lengte-constraints per veld en een `check` op de toegestane template-sleutels.

### Edge Functions (verzendkant)

- Nieuw gedeeld hulpmodule `_shared/emailTemplates/content.ts` met veilige
  plaatshouder-substitutie. Gebruikerstekst wordt HTML-ge-escaped, plaatshouders
  worden ge-escaped ingevuld en regeleindes worden `<br/>`. Hierdoor kan een
  klant-aanpasbaar veld nooit rauwe HTML in een mail injecteren — dit adresseert
  het beveiligingspunt uit de eerdere template-registry-review.
- De vier templates (`quoteSent`, `invoiceSent`, `invoiceReminder`,
  `creditNoteSent`) renderen nu via één route: aangepaste tekst → anders de
  ingebouwde standaardtekst (als plaatshouder-string). Lege/ontbrekende velden
  vallen terug op de default, dus bestaande organisaties merken niets tot ze zelf
  iets aanpassen.
- `invoice-workflow` en `quote-workflow` laden de per-organisatie tekst
  (service-role, omzeilt RLS) en geven die mee aan de template. Een lookup-fout is
  niet fataal: de mail gaat dan met de standaardtekst.

### Frontend

- Nieuwe editor in **Instellingen → E-mail**: kies een e-mail, pas de velden aan,
  zie een live voorbeeld met voorbeeldwaarden, en gebruik de plaatshouderlijst
  (`{{recipient_name}}`, `{{invoice_number}}`, …).
- "E-mailtekst opslaan" legt de aangepaste tekst vast; "Herstel standaardtekst"
  verwijdert de rij en zet de mail terug naar de ingebouwde standaard.
- Alleen owners/admins kunnen aanpassen; overige leden zien het alleen-lezen.
- Repository-functies `loadEmailTemplates`, `upsertEmailTemplate` en
  `resetEmailTemplate`; catalogus met defaults + plaatshouders in
  `src/lib/emailTemplateContent.ts` (spiegelt de Edge-defaults).

## Beveiliging

- Geen rauwe HTML uit gebruikersvelden: alles loopt via `renderContentHtml`
  (escape → plaatshouders escaped → `<br/>`).
- Onbekende plaatshouders worden weggelaten, niet letterlijk getoond.
- De Resend API-key blijft server-side; de frontend kiest geen template, alleen de
  tekst per vaste sleutel.

## Toepassen

1. Migratie uitvoeren: `supabase db push` (of de migratie in de Supabase SQL-editor
   draaien). Zonder deze tabel valt de editor terug op een laadfout en blijven
   mails de standaardtekst gebruiken.
2. Edge Functions opnieuw deployen: `supabase functions deploy invoice-workflow` en
   `supabase functions deploy quote-workflow` (delen de bijgewerkte
   `_shared/emailTemplates`).

## Validatie

- `npm run typecheck` ✅
- `npm run build` ✅ (vite build geslaagd)
- TypeScript-transpile van alle gewijzigde Edge-bestanden (`ts.transpileModule`) ✅

## Niet live getest

Er is geen echte Resend-mail verzonden en de migratie is niet tegen een live
Supabase-project gedraaid vanuit deze sessie. De editor vereist een ingelogde
sessie én de toegepaste migratie en kon daarom niet in een lokale browserpreview
worden doorlopen.
