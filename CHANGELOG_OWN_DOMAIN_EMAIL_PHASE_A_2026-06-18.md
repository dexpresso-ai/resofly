# Eigen-domein e-mail — fase 1, onderdeel A (verzenddomein koppelen)

Datum: 2026-06-18 · branch `feat/eigen-domein-mail`

## Wat
Organisaties kunnen hun eigen domein koppelen en verifiëren, zodat e-mails
straks vanaf hun eigen adres (bijv. `info@eigendomeinnaam.nl`) verstuurd worden
in plaats van het globale `RESEND_FROM_EMAIL`. Dit is onderdeel **A** van fase 1
(N1, eigen domein via Resend). Onderdeel B (vrije mail versturen + loggen) en C
(antwoorden opvangen via Cloudflare Email Routing) volgen apart.

Eén gedeelde app-Resend-key bedient alle organisatie-domeinen; per-org
secret-opslag is dus niet nodig. Domeinnaam, Resend-domein-id en DNS-records zijn
niet-gevoelig en worden in platte vorm bewaard.

## Bestanden
- `supabase/migrations/20260620000002_organization_email_domains.sql`: nieuwe
  tabel `organization_email_domains` (org-gescopet, RLS `can_read_org`, schrijven
  via Edge Function/service role), partial unique index voor één standaard­domein
  per org, `set_updated_at`-trigger.
- `supabase/functions/mail/index.ts`: acties `addSendingDomain`,
  `verifySendingDomain`, `updateSendingDomain`, `removeSendingDomain` (owner/admin),
  Resend Domains-API-helpers (POST/GET/verify/DELETE), statusmapping en
  domein-/afzendervalidatie. Nieuwe const `RESEND_DEFAULT_REGION`.
- `src/services/mailService.ts`: `addSendingDomain`, `verifySendingDomain`,
  `updateSendingDomain`, `removeSendingDomain`.
- `src/lib/repository.ts`: `loadSendingDomains` (alleen-lezen).
- `src/types.ts`: `SendingDomain`, `SendingDomainDnsRecord`, `SendingDomainStatus`.
- `src/features/SimplePages.tsx`: kaart **Eigen verzenddomein** in de tab
  Instellingen → E-mail (domein toevoegen, DNS-records tonen, verifiëren, standaard
  maken, ontkoppelen) + `DnsRecordsTable`.
- `src/styles/globals.css`: styling voor de domeinkaart, statuspills en DNS-records.
- `.env.example`: `RESEND_DEFAULT_REGION` (standaard `eu-west-1`).

## Secrets / migratie
- Migratie nog toepassen op de database.
- Optionele secret `RESEND_DEFAULT_REGION` (valt terug op `eu-west-1`).
- Bestaande `RESEND_API_KEY` wordt hergebruikt; geen nieuwe key nodig.

## Verificatie
- `npm run typecheck` — groen (hele project).
- Dev-server (`npm run dev`) bouwt en laadt zonder console-fouten.
- UI-doorklik naar Instellingen → E-mail is in deze sessie niet getest (achter
  magic-link-login + actieve organisatie). Te testen na deploy: domein toevoegen
  → DNS-records verschijnen → records plaatsen → "Verifieer" → status wordt
  `Geverifieerd` → "Maak standaard".

## Nog open (volgende onderdelen)
- B: vrije klant-mail versturen vanaf het geverifieerde domein + logging in een
  nieuwe "Communicatie"-tab op de klant; `resolveFromAddress`-helper inhaken in
  `mail`/`quote-workflow`/`invoice-workflow`.
- C: antwoorden opvangen via Cloudflare Email Routing → `mail-inbound`-functie.
