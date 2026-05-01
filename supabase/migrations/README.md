# BrandCore migraties — actuele volgorde

Gebruik voor een nieuwe/lege Supabase database bij voorkeur het complete installatieschema:

```text
supabase/BRANDCORE_DATABASE_SETUP.sql
```

Dit bestand is bijgewerkt met Sprint 1, organisatie-licenties, Sprint 2 billing/Mollie Connect en de production-ready afronding van Sprint 2.

## Upgrade vanaf bestaande Sprint 1 database

Voer de migraties in deze volgorde uit. Sla geen stappen over; latere hardening-migraties gaan ervan uit dat de basistabellen uit de eerdere stappen bestaan.

```text
1. 20260430_sprint2_billing_mollie_licensing.sql
2. 20260430_sprint2_mollie_connect_production_hardening.sql
3. 20260430_sprint2_mollie_connect_final_hardening.sql
4. 20260430_sprint2_completion_production_ready.sql
```

## Upgrade vanaf eerdere Sprint 2 versie

Als `20260430_sprint2_billing_mollie_licensing.sql` al is uitgevoerd, voer dan alleen de nog ontbrekende hardening-stappen uit, in oplopende volgorde:

```text
20260430_sprint2_mollie_connect_production_hardening.sql
20260430_sprint2_mollie_connect_final_hardening.sql
20260430_sprint2_completion_production_ready.sql
```

Als de eerste drie Sprint 2-migraties al zijn uitgevoerd, is alleen deze migratie nog nodig:

```text
20260430_sprint2_completion_production_ready.sql
```

## Wat zit in de Sprint 2-afronding?

- `refresh_token_version` op `organization_mollie_connections` voor veilige compare-and-swap refresh-token rotation.
- Prijsveilige reusable checkout-index inclusief `amount_cents` en `currency`.
- Idempotente upgrade-SQL met `add column if not exists`, `create index if not exists` en veilige `drop index if exists` voor de verouderde checkout-index.
- Billing event ledger blijft zonder generieke audit-trigger, zodat duplicate webhooks alleen `receive_count` en `last_seen_at` verhogen.

## Nieuwe database versus losse migraties

Voor een nieuwe database is `supabase/BRANDCORE_DATABASE_SETUP.sql` de snelste en minst foutgevoelige route. De losse migraties zijn vooral bedoeld voor bestaande databases die al op een oudere BrandCore-versie draaien.

Voor een oude pre-v2/user-scoped database blijft een aparte datamigratie nodig waarin bestaande `user_id`-data naar `organizations` en `organization_members` wordt omgezet voordat je de organisatie-SaaS migraties toepast.
