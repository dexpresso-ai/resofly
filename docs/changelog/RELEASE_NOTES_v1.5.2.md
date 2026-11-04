# Release notes — BrandCore v1.5.2

Deze release is gebaseerd op v1.5.1 debugged en is specifiek geschikt gemaakt voor een volledig nieuwe Supabase database.

## Aangepast

- Eén all-in-one database setupscript toegevoegd: `supabase/BRANDCORE_DATABASE_SETUP.sql`.
- `supabase/schema.sql` is gelijkgetrokken met hetzelfde complete fresh-install script.
- Oude losse migraties zijn vervangen door een korte README, zodat er geen verwarring is over migratievolgorde.
- `DATABASE_SETUP.md` toegevoegd met concrete Supabase-stappen.
- `.env.example` aangepast: `VITE_R2_PUBLIC_BASE_URL` staat standaard leeg voor private bijlagen.
- Packageversie verhoogd naar `1.5.2`.

## Nog steeds aanwezig uit v1.5.1

- Tenant-safe relationele integriteit.
- Subtask attachment hardening.
- Atomaire ticket → project conversie.
- UI-statusguard voor geconverteerde tickets.
- Delete-cleanup voor task- en subtask-bijlagen.
