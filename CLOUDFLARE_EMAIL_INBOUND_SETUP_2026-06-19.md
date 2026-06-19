# Eigen-domein e-mail — fase C: antwoorden opvangen (Cloudflare Email Routing)

Datum: 2026-06-19 · branch `feat/klant-mail-inbound`

Doel: antwoorden van klanten op een verzonden klant-mail terug onder de klant
tonen (Communicatie-tab), zonder hun mailbox te koppelen. We laten replies een
rondreis maken via een inbound-domein dat wij beheren.

## Hoe het werkt (kort)
1. Een uitgaande klant-mail krijgt `Reply-To: reply+<client_email_id>@<inbound-domein>`
   (gebeurt automatisch zodra `MAIL_INBOUND_DOMAIN` gezet is).
2. De klant antwoordt → de mail komt binnen op het inbound-domein.
3. Cloudflare Email Routing stuurt 'm naar de **Email Worker** (`workers/email-inbound`).
4. De Worker parseert de mail en POST't naar de Supabase-functie **`mail-inbound`**
   (met `x-inbound-secret`).
5. `mail-inbound` zoekt het oorspronkelijke bericht op `<id>` (fallback: afzenderadres)
   en schrijft het antwoord als inbound-bericht in dezelfde thread.

## Onderdelen in deze repo
- `supabase/functions/mail-inbound/index.ts` — verwerkt de inbound-payload.
- `workers/email-inbound/` — de Cloudflare Email Worker (TypeScript, postal-mime).
- `supabase/config.toml` — `mail-inbound` met `verify_jwt = false`.
- Env: `MAIL_INBOUND_DOMAIN`, `MAIL_INBOUND_WEBHOOK_SECRET`.

## Stap 1 — Inbound-domein in Cloudflare
Vereist dat `resofly.nl` (of het gekozen domein) een **zone in Cloudflare** is.

1. Kies een inbound-(sub)domein, bijv. `inbound.resofly.nl` (apart van je echte
   mail, zodat normale post niet geraakt wordt).
2. Cloudflare-dashboard → **Email** → **Email Routing** → inschakelen voor de zone.
   Cloudflare geeft de **MX-records** (+ SPF TXT) die geplaatst moeten worden.
   Plaats die op het inbound-(sub)domein.
3. Wacht tot Email Routing de records als geverifieerd toont.

> De exacte schermstappen kunnen per Cloudflare-UI-versie verschillen; volg de
> officiële docs "Email Routing" + "Email Workers" als de UI afwijkt.

## Stap 2 — Worker deployen
```bash
cd workers/email-inbound
npm install
# gedeeld secret zetten (zelfde waarde als de Supabase-secret in stap 3):
npx wrangler secret put MAIL_INBOUND_SECRET --env staging
npm run deploy:staging
```
Pas in `wrangler.toml` zo nodig `MAIL_INBOUND_ENDPOINT` en `INBOUND_DOMAIN` aan.

## Stap 3 — Email Routing aan de Worker koppelen
In **Email Routing → Routes**:
- Zet een **catch-all** (of een regel voor `reply+*`) met actie **"Send to a Worker"**
  → kies `resofly-email-inbound-staging`.

Zo komt elk `reply+<id>@inbound.resofly.nl`-adres bij de Worker terecht.

## Stap 4 — Supabase secrets + functies
```bash
# gedeeld secret (zelfde waarde als bij de Worker in stap 2):
supabase secrets set MAIL_INBOUND_WEBHOOK_SECRET=<zelfde-willekeurige-waarde>
# inbound-domein aanzetten zodat nieuwe mails de token-Reply-To krijgen:
supabase secrets set MAIL_INBOUND_DOMAIN=inbound.resofly.nl

supabase functions deploy mail-inbound
supabase functions deploy mail   # opnieuw, zodat het de MAIL_INBOUND_DOMAIN-env oppikt
```

## Stap 5 — Testen
1. Stuur via de app een klant-mail naar een adres dat je zelf beheert.
2. Controleer in de ontvangen mail dat `Reply-To` = `reply+<id>@inbound.resofly.nl`.
3. Beantwoord de mail.
4. Binnen ~seconden verschijnt het antwoord in de **Communicatie-tab** onder de
   klant als inkomend bericht.
5. Bij problemen: Cloudflare Worker-logs (`wrangler tail`) + Supabase Edge Function
   logs voor `mail-inbound`.

## Aandachtspunten
- **Reply naar de From i.p.v. Reply-To**: zeldzaam, maar dan belandt het antwoord
  in de eigen mailbox van de afzender en niet bij ons. Dit is de standaard
  trade-off van Reply-To-routing.
- **Automatische mail** (out-of-office, bounces, no-reply) wordt genegeerd om
  lussen te voorkomen.
- **Onbekende afzender zonder token**: alleen gekoppeld als het afzenderadres
  eenduidig bij één klant hoort; anders overgeslagen (geen foutieve koppeling).
- **Dedup**: dezelfde mail (zelfde Message-ID) wordt niet dubbel gelogd.
- **Bijlagen**: in deze versie loggen we tekst/HTML; bijlagen kunnen later naar R2.
- **Productie**: herhaal stap 2–4 met `--env production` en de productie-waarden;
  zet `MAIL_INBOUND_ALLOW_UNSIGNED` nooit op `true`.
