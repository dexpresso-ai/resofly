# Eigen-domein e-mail — fase 1, onderdeel C (antwoorden opvangen)

Datum: 2026-06-19 · branch `feat/klant-mail-inbound`

## Wat
Antwoorden van klanten op een verzonden klant-mail komen nu terug onder de klant
(Communicatie-tab), zonder hun mailbox te koppelen. De reply maakt een rondreis
via een inbound-domein dat wij beheren, opgevangen door **Cloudflare Email
Routing** (gratis) → een **Email Worker** → de Supabase-functie **`mail-inbound`**.

Zie [CLOUDFLARE_EMAIL_INBOUND_SETUP_2026-06-19.md](CLOUDFLARE_EMAIL_INBOUND_SETUP_2026-06-19.md)
voor de DNS/Cloudflare-stappen en de deploy.

## Bestanden
- `supabase/functions/mail-inbound/index.ts`: ontvangt de geparseerde inbound-mail
  (secret-auth via `x-inbound-secret`), koppelt op token `<client_email_id>`
  (fallback: eenduidig afzenderadres), schrijft een `direction='inbound'`-rij in
  dezelfde thread, dedup op Message-ID, negeert automatische mail/lussen.
- `workers/email-inbound/`: Cloudflare Email Worker (TypeScript + postal-mime) —
  parseert de MIME en POST't naar `mail-inbound`. Met `wrangler.toml` (staging +
  production), `package.json`, `tsconfig.json`.
- `supabase/config.toml`: `[functions.mail-inbound] verify_jwt = false`.
- `.env.example`: `MAIL_INBOUND_WEBHOOK_SECRET`, `MAIL_INBOUND_ALLOW_UNSIGNED`
  (en `MAIL_INBOUND_DOMAIN` uit fase B).

## Al klaar uit eerdere fasen (geen werk meer nodig)
- De Reply-To-token (`reply+<id>@<inbound-domein>`) wordt in fase B al gezet zodra
  `MAIL_INBOUND_DOMAIN` is ingevuld.
- Het datamodel is tweerichtings (`direction`, status `received`) en de
  Communicatie-tab rendert inkomende berichten al.

## Activatie (handmatig — vereist Cloudflare-dashboard + DNS)
Zie het setup-doc. Kort:
1. Email Routing aanzetten op het inbound-(sub)domein + MX-records plaatsen.
2. `workers/email-inbound`: `npm install`, `wrangler secret put MAIL_INBOUND_SECRET`,
   `npm run deploy:staging`; route (catch-all `reply+*`) → de Worker.
3. Supabase: `MAIL_INBOUND_WEBHOOK_SECRET` (zelfde waarde) + `MAIL_INBOUND_DOMAIN`
   zetten; `mail-inbound` deployen en `mail` opnieuw deployen.

## Verificatie
- `npm run typecheck` — groen (geen frontend-wijzigingen in deze fase).
- `workers/email-inbound`: `npm install` + `tsc --noEmit` — groen.
- `mail-inbound` (Deno) handmatig nagelopen; end-to-end test pas mogelijk na de
  Cloudflare-activatie (stap hierboven).

## Aandachtspunten
- Reply naar de From i.p.v. Reply-To → belandt in de eigen mailbox (randgeval).
- Automatische mail/bounces/no-reply worden genegeerd; onbekende afzender zonder
  token alleen gekoppeld bij eenduidige match; dedup op Message-ID.
- Bijlagen: nu tekst/HTML; bijlagen naar R2 is een latere uitbreiding.
