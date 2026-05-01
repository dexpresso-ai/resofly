# BrandCore Review & Fix Report — v1.6.1

## Uitgevoerde controle

- `npm ci` uitgevoerd op een schone installatie.
- `npm run typecheck` uitgevoerd: geslaagd.
- `npm run build` uitgevoerd: geslaagd.
- Frontendcode gecontroleerd op runtime-risico’s rond formulieren, datumweergave, uploads, agenda-state en ticketconversie.
- Database-schema gecontroleerd op tenant-safe relaties, RLS, ticketconversie en cascade-effecten.
- Cloudflare Worker gecontroleerd op upload-validatie, bestandsgrootte, bestandsnamen, auth en CORS.

## Bevindingen en fixes

### 1. Ticket kan na projectverwijdering ghost-converted blijven

Een geconverteerd ticket verwijst via `converted_to_project_id` naar een project. Door `on delete set null` kan bij projectverwijdering de projectreferentie verdwijnen terwijl de ticketstatus `converted` bleef. Dit kan in de UI leiden tot een ticket dat “omgezet” lijkt, zonder bestaand project.

**Fix:** toegevoegd aan fresh schema’s en aparte migratie:

- `public.normalize_ticket_conversion_state()`
- trigger `tickets_00_conversion_state`
- bestaande inconsistente data wordt in de migratie hersteld

### 2. Uploads met speciale tekens/emoji in bestandsnamen konden falen

De bestandsnaam werd direct in een HTTP-header gezet. Sommige browsers/workers kunnen falen op niet-ASCII headerwaarden.

**Fix:** frontend encodeert `x-file-name` met `encodeURIComponent`; Worker decodeert dit veilig terug met fallback.

### 3. Datumweergave kon off-by-one tonen bij DATE-velden

`new Date('YYYY-MM-DD')` wordt als UTC geïnterpreteerd. In sommige tijdzones kan dit één dag eerder tonen.

**Fix:** `dateNL()` behandelt Postgres DATE-waarden als lokale kalenderdatum.

### 4. Finance-formulier was gevoelig voor corrupte/null `lines`

Bij onverwachte data kon `form.lines.map(...)` crashen.

**Fix:** finance lines worden defensief als array genormaliseerd.

### 5. Agenda-schrijfbronnen werden per render opnieuw opgebouwd

`writeableSources` was een nieuwe array per render, waardoor een effect onnodig vaak kon draaien.

**Fix:** `writeableSources` is nu gememoized met `useMemo`.

## Testresultaat

```bash
npm ci
npm run typecheck
npm run build
```

Resultaat: alle checks geslaagd. De Vite build geeft alleen een chunk-size waarschuwing door de grote PDF-bundel (`pdf-lib`). Dat is geen blokkerende fout, maar code-splitting van PDF-export is een logische volgende optimalisatie.

## Eindoordeel

De app compileert en bouwt succesvol. De kernfunctionaliteiten zijn technisch consistent genoeg voor staging, mits de externe configuratie correct staat:

- Supabase URL + anon key
- Fresh database schema of migraties
- Supabase magic-link auth
- R2 Worker + bucket + CORS/origin
- Calendar Edge Function secrets voor Google/Microsoft agenda’s

Voor productie zou ik nog live integratietests uitvoeren tegen echte Supabase/R2/Calendar-omgevingen, omdat die afhankelijk zijn van secrets, OAuth redirect-URL’s, RLS en externe providerconfiguratie.
