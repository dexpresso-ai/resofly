# Stromen-test: offertes, facturen, herinneringen en contracten end-to-end

Draait de **echte edge functions** (`supabase/functions/<naam>/index.ts`) in Node tegen een
lokale Supabase-stack: echte gebruikers (GoTrue), echte rechten (PostgREST met RLS), de echte
database met alle migraties. Alleen wat buiten Supabase ligt is nep (`nepdiensten.mjs`):

- **Resend**: elke mail wordt vastgelegd (aan wie, onderwerp, tekst, bijlagen) in plaats van verstuurd;
- **Mollie**: betalingen, terugbetalingen en de webhook zoals Mollie ze doet, per API-sleutel;
- **de media-worker**: R2-opslag van PDF's en de omzetting van Word naar PDF.

Waarom zo: de unittests toetsen losse functies, de database-scripts de database. Pas als de
functies, de database, de rechten en de mails samen draaien, zie je of een offerte écht van
concept tot factuur komt, of een herinnering naar het juiste adres gaat met het juiste bedrag,
en of een klant of collega nergens bij kan waar hij niet bij hoort.

## Draaien

```bash
# 1. De lokale stack (database, auth, REST, gateway)
npx supabase start -x studio,imgproxy,mailpit,logflare,vector,supavisor,edge-runtime,postgres-meta,realtime,storage-api

# 2. Twee pakketten die alleen de edge functions gebruiken (via esm.sh)
npm install --no-save xss@1.0.15 fast-xml-parser@4.5.0

# 3. Alles, of één scenario
npm run test:stromen
npm run test:stromen -- facturen
```

Scenario's: `rook`, `offertes`, `facturen`, `herinneringen`, `contracten`, `beveiliging`.
Elk scenario maakt zijn eigen organisaties (`wereld.mjs`), dus ze raken elkaar niet en de
database hoeft niet leeg.

**Let op met Postgres 17.6.1.111** (de versie van staging op 2026-11-05): daar laat een
geweigerde functieaanroep de database crashen, en het beveiligingsscenario doet zulke aanroepen
expres. Draai lokaal op 17.6.1.178 of nieuwer: zet `17.6.1.178` in
`supabase/.temp/postgres-version` vóór `supabase start` (en commit die wijziging niet).

## Bestanden

| Bestand | Wat |
| --- | --- |
| `register.mjs`, `loader.mjs`, `std-serve.mjs` | laden de Deno-code in Node: imports van esm.sh/deno.land naar `node_modules`, `serve()` naar de harnas |
| `omgeving.mjs` | de lokale stack en de secrets van de functies |
| `nepdiensten.mjs` | Resend, Mollie en de media-worker, met storingen op bestelling |
| `supabase.mjs` | PostgREST als gebruiker of als server, `psql` voor wat alleen de tijd doet |
| `functies.mjs` | roept een functie aan met een `Request`, zoals de browser of Mollie |
| `wereld.mjs` | een organisatie met alle rollen, bedrijfsgegevens en twee klanten met portaal |
| `toets.mjs` | de testloper: stappen, controles, telling |
| `run.mjs` | start de gekozen scenario's |
