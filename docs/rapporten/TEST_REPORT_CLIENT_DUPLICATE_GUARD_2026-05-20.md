# Test report — Client duplicate guard — 2026-05-20

## Uitgevoerd

### Build/typecheck
- `npm run build` uitgevoerd.
- Resultaat: geslaagd.
- Opmerking: eerst was `node_modules` afwezig. `npm ci` faalde doordat de Supabase CLI postinstall GitHub nodig had. Daarna is `npm ci --ignore-scripts` gebruikt om dependencies lokaal te installeren zonder externe Supabase CLI-download. Vervolgens is de build succesvol uitgevoerd.

### Verwachte UX-scenario's
- Nieuwe klant met bestaand klantnummer binnen dezelfde organisatie: opslaan geblokkeerd.
- Nieuwe klant met bestaand e-mailadres binnen dezelfde organisatie: opslaan geblokkeerd.
- Nieuwe klant met bestaande naam + telefoonnummer binnen dezelfde organisatie: opslaan geblokkeerd.
- Nieuwe klant met bestaande naam + contactpersoon binnen dezelfde organisatie: opslaan geblokkeerd.
- Nieuwe klant met alleen dezelfde naam: waarschuwing zichtbaar, opslaan blijft mogelijk.
- Klant bewerken zonder eigen gegevens te wijzigen: geen false-positive duplicate doordat huidige klant wordt uitgesloten.

### Database-scenario's
- Trigger is `organization_id`-scoped en blokkeert dus niet over organisaties heen.
- Trigger gebruikt `pg_advisory_xact_lock` per organisatie om gelijktijdige duplicate inserts te serialiseren.
- Fresh-install schema's zijn bijgewerkt met dezelfde functies, indexes en trigger.

## Niet uitgevoerd
- Geen live Supabase migratie-run uitgevoerd in deze sandbox.
- Geen browsermatige E2E-test uitgevoerd tegen een echte Supabase omgeving.
