# Changelog — Calendar OAuth publieke callback + state hardening — 2026-05-26

## Aanleiding
Na Google OAuth autorisatie kwam de callback terug op de Supabase Edge Function `calendar-integrations`, maar Supabase blokkeerde de request vooraf met:

```text
UNAUTHORIZED_NO_AUTH_HEADER — Missing authorization header
```

Dat komt doordat Google/Microsoft bij een OAuth callback geen Supabase `Authorization` header meesturen.

## Wijzigingen

### 1. Edge Function callback publiek gemaakt
Toegevoegd:

```text
supabase/config.toml
```

Met:

```toml
[functions.calendar-integrations]
verify_jwt = false
```

Hierdoor kan de OAuth callback vanaf Google/Microsoft de function bereiken.

### 2. POST app-acties blijven beveiligd
De function accepteert nu platformmatig publieke requests, maar in de code blijven alle normale `POST` app-acties beveiligd via:

```ts
requireUser(req)
requireOrganizationAccess(...)
requireRole(...)
```

Zonder geldige Supabase bearer token kan een normale app-call dus nog steeds niets uitvoeren.

### 3. OAuth state verder aangescherpt
De OAuth `state` bevat nu expliciet:

- provider
- userId
- organizationId
- returnTo
- nonce
- iat
- exp

De callback valideert nu:

- HMAC-handtekening
- state-formaat en maximale lengte
- provider
- userId als UUID
- organizationId als UUID
- nonce als UUID
- issued-at en expiration timestamp
- maximaal tijdvenster van 10 minuten
- returnTo-origin via `CALENDAR_ALLOWED_RETURN_ORIGINS`

### 4. Ongeldige callback-state geeft nette 400
Een ontbrekende, verlopen of gemanipuleerde state wordt niet meer via de algemene 500-flow teruggegeven, maar netjes geweigerd met:

```json
{ "ok": false, "error": "Ongeldige of verlopen OAuth state." }
```

### 5. Documentatie bijgewerkt
Aangepast:

- `CALENDAR_INTEGRATION_SETUP.md`
- `.env.example`

De deploy-instructie benoemt nu expliciet:

```bash
supabase functions deploy calendar-integrations --no-verify-jwt
```

En de staging-origin is toegevoegd aan het voorbeeld voor `CALENDAR_ALLOWED_RETURN_ORIGINS`.
