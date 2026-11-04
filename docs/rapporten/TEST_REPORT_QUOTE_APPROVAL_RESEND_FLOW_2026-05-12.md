# Test report — Quote approval + Resend flow

Datum: 2026-05-12

## Uitgevoerde controles

### Frontend

- `npm run typecheck` uitgevoerd.
- `npm run build` uitgevoerd.
- Build succesvol afgerond.
- Nieuwe projectdetail-integratie gecontroleerd op TypeScript-contracten.
- Publieke offertepagina gecompileerd binnen de Vite-build.

### Database/migratie

- Nieuwe migratie toegevoegd als los bestand.
- Fresh install schema's bijgewerkt met dezelfde idempotente migratie.
- RLS policies toegevoegd voor workflow- en e-mailtabellen.
- RPC-functies toegevoegd voor interne goedkeuring en publieke klantbeslissingen.
- Status-transition guard toegevoegd om directe ongeldige offerte-statussprongen tegen te houden.

### Edge Functions

Code toegevoegd voor:

- `quote-workflow`
- `quote-public`
- `resend-webhook`

Niet live uitgevoerd, omdat daarvoor echte Supabase Edge Function secrets en een Resend-domein nodig zijn.

## Resultaat

```txt
npm run typecheck: geslaagd
npm run build: geslaagd
```

## Opmerking

Vite geeft nog een chunk-size warning omdat de app als één grote bundel wordt gebouwd. Dat is geen build-error. Later kan code-splitting worden toegevoegd.
