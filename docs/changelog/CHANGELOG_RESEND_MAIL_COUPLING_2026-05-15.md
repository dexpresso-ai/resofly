# Changelog — Resend mailkoppeling — 2026-05-15

## Toegevoegd

- Nieuwe Supabase Edge Function `mail` voor server-side Resend-verzending.
- Nieuwe frontend service `sendResendTestEmail`.
- Nieuwe instellingenkaart **E-mail via Resend** met testmailknop voor owners/admins.
- `MAIL_ALLOWED_ORIGINS` en `MAIL_ALLOW_LOCAL_DEV` toegevoegd aan `.env.example`.
- `RESEND_SETUP.md` toegevoegd met PowerShell deploy- en configuratiestappen.

## Verbeterd

- Offerte-PDF attachment payload afgestemd op de huidige Resend REST API-documentatie: `filename` + base64 `content`.
- Resend API-key blijft volledig server-side; er is geen Vite/browser secret toegevoegd.

## Validatie

- `npm run build` succesvol uitgevoerd na wijziging.
- Eerste `npm ci` faalde doordat de Supabase CLI postinstall GitHub nodig had in de sandbox; daarna is `npm ci --ignore-scripts` gebruikt voor lokale build-validatie.
