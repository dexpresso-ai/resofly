# Invoice template export hardening report — v1.5.4

## Gewijzigd
- PDF-export voor offertes en facturen draait via `pdf-lib`.
- Gebruikers kunnen in `Instellingen > Bedrijfsinstellingen` een eigen PDF/PNG/JPG-template uploaden.
- De template wordt als vaste onderlaag gebruikt; BrandCore zet daar de vaste datavelden overheen.
- Bedrijfsgegevens worden geladen uit `company_settings` en gebruikt op de factuur/offerte.
- Vaste datavelden: bedrijfsgegevens, KvK/BTW/IBAN, klantgegevens, documentnummer, datum, vervaldatum/geldig-tot, regels, BTW, totalen, notities, betaaltekst en footer.

## Extra hardening in v1.5.4
- Opslagfouten in bedrijfsinstellingen tonen geen valse succesmelding meer.
- PDF-tekst wordt genormaliseerd voor WinAnsi/Helvetica, zodat emoji's en slimme leestekens de export niet laten crashen.
- Afbeeldingtemplates worden proportioneel als cover geplaatst in plaats van hard uitgerekt.
- Bij eigen templates wordt de standaard accentbalk niet meer over de templateheader getekend.
- `package-lock.json` gebruikt publieke npm registry URLs in plaats van interne registry URLs.
- Supabase Auth-aanroepen lopen via een kleine typed adapter, zodat de app typecheckt met recente Supabase typings.
- Migratie is idempotenter gemaakt met `alter table add column if not exists`.

## Validatie
- `npm ci` succesvol uitgevoerd.
- `tsc --noEmit` uitgevoerd: geen TypeScript errors na laatste fix.
- `tsc -b` uitgevoerd: geen TypeScript errors.
- `vite build` succesvol uitgevoerd; alleen de bekende chunk-size waarschuwing door de grote PDF-lib bundle.
- PDF smoke-test uitgevoerd via bundled Node script: `%PDF` output gegenereerd met speciale tekens in factuurregel.

## Opmerking
De template wordt nu compact opgeslagen als data-url in `company_settings`. Voor zeer grote templatebestanden of multi-template beheer is een volgende stap om templates als object in R2/Supabase Storage op te slaan en alleen metadata in Postgres te bewaren.
