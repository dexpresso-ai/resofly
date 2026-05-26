# Testrapport — Calendar OAuth publieke callback + state hardening — 2026-05-26

## Uitgevoerde checks

### Frontend build
Command:

```bash
npm run build
```

Resultaat:

```text
✓ built in 10.23s
```

Opmerking: `npm ci` is eerst met scripts geprobeerd, maar de Supabase CLI postinstall kon GitHub niet bereiken vanuit de sandbox. Daarna is `npm ci --ignore-scripts` gebruikt, omdat de frontend build geen lokale Supabase CLI binary nodig heeft.

### Edge Function syntax-check
Command:

```bash
tsc --noEmit --skipLibCheck --lib esnext,dom --module esnext --target esnext --noResolve supabase/functions/calendar-integrations/index.ts
```

Resultaat:

- Geen syntaxfouten gevonden.
- Alleen verwachte meldingen op remote Deno imports en de globale `Deno` namespace, omdat deze functie buiten de Deno/Supabase runtime met Node/TypeScript is gecontroleerd.

## Handmatige acceptatiecheck na deploy

1. Deploy de function met JWT-verificatie uit:

```bash
supabase functions deploy calendar-integrations --no-verify-jwt --project-ref enzghpduqwaojcxgwarr
```

2. Controleer secrets:

```bash
supabase secrets set \
  CALENDAR_ALLOWED_RETURN_ORIGINS="http://localhost:5173,https://staging.resofly.com,https://resofly.com,https://www.resofly.com,https://staging.resofly.pages.dev" \
  --project-ref enzghpduqwaojcxgwarr
```

3. In Google Cloud OAuth Client moet deze redirect URI staan:

```text
https://enzghpduqwaojcxgwarr.supabase.co/functions/v1/calendar-integrations
```

4. Test in staging:

```text
https://staging.resofly.com/#calendar-connections
```

5. Klik Google koppelen.
6. Autoriseer Google.
7. Verwacht resultaat: redirect terug naar ResoFly zonder `UNAUTHORIZED_NO_AUTH_HEADER`.
8. Klik daarna op Ververs en controleer dat accounts/agenda's zichtbaar worden.
