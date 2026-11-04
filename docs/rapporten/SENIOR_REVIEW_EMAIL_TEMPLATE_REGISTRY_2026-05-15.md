# Senior review — Email template registry

Datum: 2026-05-15
Scope: Resend mailkoppeling, centrale template registry, Edge Function integratie, quote-mailflow, database template tracking en build-validatie.

## Conclusie

De architectuur is goed opgezet voor deze fase van ResoFly/BrandCore:

- Resend wordt gebruikt als verzendprovider, niet als template-engine.
- De backend bepaalt de mailactie en daarmee de template.
- Templates staan centraal onder `supabase/functions/_shared/emailTemplates`.
- `mail/index.ts` gebruikt `test.resend`.
- `quote-workflow/index.ts` gebruikt `quote.sent`.
- De Resend API-key blijft server-side in Supabase Edge Function secrets.
- Offerte-mails worden gekoppeld aan delivery logging en krijgen een `template_key` mee.

## Directe verbetering doorgevoerd

### Plain-text formatting gehard

Bestand:

`supabase/functions/_shared/emailTemplates/layout.ts`

De helper `textLines` filterde eerst met `filter(Boolean)`. Daardoor verdwenen bewust geplaatste lege regels in plain-text mails. Dat was geen functionele blocker, maar wel minder professioneel voor tekstfallbacks en mailclients die plain text tonen.

Aangepast naar expliciete filtering van alleen `null`, `undefined` en `false`, zodat lege strings als regelafstand behouden blijven.

## Reviewpunten

### 1. Template registry

Goedgekeurd.

`renderEmailTemplate(templateKey, data)` is een nette centrale ingang. Het voorkomt dat HTML-snippets door verschillende Edge Functions verspreid raken.

### 2. Template ownership

Goedgekeurd.

De frontend kan niet willekeurig een template kiezen. De backend bepaalt:

- `sendTestEmail` → `test.resend`
- `sendQuoteEmail` → `quote.sent`

Dat is de juiste security- en productarchitectuur.

### 3. HTML safety

Goedgekeurd met aandachtspunt.

Dynamische velden worden in de templates via `escapeHtml` verwerkt. De layout accepteert bewust HTML-blokken via `introHtml`, `bodyHtml` en `footerHtml`; dat is prima zolang alleen server-side templatecode deze velden vult.

Niet toestaan dat gebruikers straks rauwe HTML in deze velden kunnen injecteren zonder sanitization.

### 4. Resend secrets

Goedgekeurd.

`RESEND_API_KEY` wordt alleen in Edge Functions gebruikt. Er is geen browsergebruik van de Resend key aangetroffen.

### 5. Database template tracking

Goedgekeurd voor de huidige MVP.

`quote_email_deliveries.template_key` is toegevoegd aan migratie en fresh install schema's. De huidige quote-flow gebruikt `quote.sent`, waardoor de default correct is. Voor toekomstige templates zoals `invoice.sent` of `portal.invite` is het advies om `template_key` direct in de betreffende workflow/RPC mee te nemen.

### 6. Validatie

Uitgevoerd:

- `npm run typecheck` — geslaagd
- `npm run build` — geslaagd
- `npm run lint:sql` — geslaagd, maar dit is nog een placeholder
- `npm audit --audit-level=moderate` — 0 vulnerabilities
- Edge Function TypeScript syntax parse via `typescript.transpileModule` — geslaagd

## Niet live getest

Niet uitgevoerd in deze sandbox:

- echte Supabase Edge Function deploy
- echte Resend send-call
- echte Resend webhook callback
- echte database-RPC uitvoering tegen jouw Supabase-project

Daarvoor zijn jouw Supabase-project, secrets, verified Resend-domein en database-migratie nodig.

## Resterende aandachtspunten

1. `npm run lint:sql` is nog een placeholder. Later vervangen door echte SQL linting of Supabase migration validation.
2. De frontend bundle is groter dan 500 kB. Geen blocker voor Resend, maar later code-splitting toepassen.
3. Bij nieuwe templates de registry uitbreiden met nieuwe typed inputmodellen, niet losse HTML in workflows zetten.

## Eindbeoordeling

Ja: deze opzet is goed gebouwd voor de huidige fase. Het is schaalbaar genoeg om de komende mailflows op te bouwen zonder rommelige template-snippets door de codebase heen.
