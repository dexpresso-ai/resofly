# Changelog — Client duplicate guard — 2026-05-20

## Doel
Binnen dezelfde organisatie dubbele klanten netjes voorkomen of minimaal vroeg signaleren, zonder dezelfde klantgegevens tussen verschillende organisaties te blokkeren.

## Gewijzigd

### Frontend
- Klantformulier detecteert live mogelijke duplicaten in de actieve organisatie.
- Opslaan wordt geblokkeerd bij harde conflicten:
  - hetzelfde klantnummer;
  - hetzelfde e-mailadres;
  - dezelfde klantnaam + hetzelfde telefoonnummer;
  - dezelfde klantnaam + dezelfde contactpersoon.
- Bij alleen dezelfde klantnaam verschijnt een waarschuwing, maar opslaan blijft mogelijk. Dit voorkomt onnodige blokkades bij bijvoorbeeld vestigingen of gelijknamige relaties.
- Klantvelden worden vóór opslaan opgeschoond: trimmen van tekstvelden en lowercasing van e-mailadressen.

### Database
- Nieuwe migratie toegevoegd: `supabase/migrations/20260520_clients_duplicate_guard.sql`.
- Nieuwe normalisatiehelpers voor klantlookup toegevoegd.
- Nieuwe trigger `clients_duplicate_guard` op `public.clients` toegevoegd.
- Duplicate-check gebruikt een transactionele advisory lock per organisatie om race conditions bij gelijktijdige inserts te voorkomen.
- Lookup-indexes toegevoegd voor klantnummer, e-mail, naam en telefoon.
- `supabase/schema.sql`, `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql` en `supabase/BRANDCORE_DATABASE_SETUP.sql` bijgewerkt voor fresh installs.

## Belangrijk gedrag
- Zelfde klantgegevens in verschillende organisaties blijven toegestaan.
- De guard is organisatie-scoped via `organization_id`.
- Bestaande historische dubbelen worden niet automatisch samengevoegd of verwijderd.
