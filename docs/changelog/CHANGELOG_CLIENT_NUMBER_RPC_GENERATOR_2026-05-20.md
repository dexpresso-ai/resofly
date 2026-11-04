# Changelog — Server-side klantnummer-generator per organisatie — 2026-05-20

## Samenvatting
Nieuwe klantnummers worden niet meer door de browser bepaald. De frontend toont alleen nog een preview; de definitieve reservering gebeurt atomair via Supabase/Postgres binnen dezelfde organisatie.

## Gewijzigd
- Nieuwe migratie toegevoegd: `supabase/migrations/20260520_client_number_rpc_generator.sql`.
- Nieuwe tabel toegevoegd: `organization_client_number_sequences`.
- Nieuwe RPC's toegevoegd:
  - `preview_next_client_code(p_organization_id)` voor een niet-bindende preview.
  - `create_client_with_next_code(p_organization_id, p_payload)` voor transactionele klantaanmaak.
- Nieuwe interne databasefuncties toegevoegd:
  - `reconcile_client_number_sequence(...)`
  - `allocate_next_client_code(...)`
  - `format_client_code(...)`
  - `extract_client_sequence_number(...)`
- `clients_duplicate_guard` is uitgebreid zodat directe REST-inserts alsnog server-side een klantnummer krijgen.
- Frontend gebruikt voor nieuwe klanten nu `createClientWithServerCode(...)` in plaats van een browserberekening.
- Klantnummer-veld is bij nieuwe klanten read-only en wordt als server-preview getoond.
- Fresh install bestanden bijgewerkt:
  - `supabase/schema.sql`
  - `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
  - `supabase/BRANDCORE_DATABASE_SETUP.sql`
- `supabase/migrations/README.md` bijgewerkt met uitvoerinstructie.

## Waarom
Hiermee voorkom je race conditions waarbij twee gebruikers binnen dezelfde organisatie op exact hetzelfde moment een klant aanmaken en allebei hetzelfde lokaal voorgestelde klantnummer krijgen.
