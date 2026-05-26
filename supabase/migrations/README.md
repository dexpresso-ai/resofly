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


## Agenda-notities migratie

Voor de agenda-item-notities feature is er nog maar één migratiebestand nodig:

```text
20260514_calendar_event_notes_complete.sql
```

Deze gecombineerde migratie bevat:
- `note_calendar_links`
- indexes
- integrity trigger
- RLS policies
- audit trigger
- `public.create_note_with_calendar_link(...)` RPC voor transactioneel aanmaken van een notitie + kalenderlink

De eerdere losse migraties `20260512_note_calendar_links.sql` en `20260513_calendar_note_transaction_rpc.sql` zijn bewust samengevoegd en verwijderd uit deze codebase, zodat je deze feature met één query kunt toepassen.

## Aanvinkbare takenlijsten in notities

De aanvinkbare takenlijsten in rich-text notities vereisen geen extra databasekolom en dus geen nieuwe migratie. De status wordt veilig opgeslagen in het bestaande `notes.content` HTML-veld via `data-checked="true|false"` op checklist-items.

Daarom blijft de laatst samengevoegde agenda-notities migratie ongewijzigd:

```text
20260514_calendar_event_notes_complete.sql
```

## Offerte-goedkeuringsflow + Resend

Voor de nieuwe offerteflow zijn drie aanvullende migraties toegevoegd. De tweede hardent de eerste met browser-read-only workflowtabellen, transactionele Resend-send RPC's en immutability guards. De derde is de extra final-recheck hardening na de tweede review: directe workflowveld-mutaties vanuit de browser worden geblokkeerd, helper-RPC's zijn niet meer direct aanroepbaar door browserrollen, goedkeuring vereist eerst een pending-state en verlopen offertes kunnen niet meer publiek worden geaccepteerd:

```text
20260515_quote_approval_resend_flow.sql
20260515_quote_approval_resend_flow_hardening.sql
20260515_quote_approval_resend_flow_final_recheck.sql
```

De basismigratie bevat:
- workflowvelden op `quotes`
- extra offertestatussen
- `quote_approval_events`
- `quote_email_deliveries`
- `quote_email_events`
- RLS policies
- audit-log acties
- RPC's voor interne goedkeuring en publieke klantbeslissing
- status-transition guard trigger

De hardening-migratie bevat:
- vergrendeling van offerte-inhoud na indienen/goedkeuren/versturen
- read-only RLS voor timeline- en e-mailtabellen vanuit browserclients
- transactionele RPC's voor Resend queued/sent/failed lifecycle
- geharde helper-RPC's voor workflow/audit events

De final-recheck migratie bevat:
- server-only guard op workflow-, token-, klantbeslissing- en e-mailstatusvelden in `quotes`
- intrekken van directe browserrechten op helper-RPC's en publieke klantbeslissing-RPC's
- striktere interne goedkeuring: eerst indienen, daarna pas goedkeuren
- geldigheidsdatumcontrole vóór publieke acceptatie en vóór Resend-verzending

Voer deze migraties in deze volgorde uit na:

```text
20260514_calendar_event_notes_complete.sql
```

Daarna moeten de Edge Functions `quote-workflow`, `quote-public` en `resend-webhook` gedeployed worden en moeten de Resend/quote secrets in Supabase gezet worden.

## Klant-deduplicatie binnen organisatie

Voor bestaande databases is de volgende aanvullende migratie toegevoegd:

```text
20260520_clients_duplicate_guard.sql
```

Deze migratie voorkomt dat dezelfde klant dubbel wordt aangemaakt binnen dezelfde organisatie, terwijl dezelfde klantgegevens in een andere organisatie wel toegestaan blijven. De guard controleert:

- dubbel klantnummer binnen dezelfde organisatie;
- dubbel e-mailadres binnen dezelfde organisatie;
- dezelfde klantnaam + hetzelfde telefoonnummer;
- dezelfde klantnaam + dezelfde contactpersoon.

De trigger gebruikt een transactionele advisory lock per organisatie, zodat twee gelijktijdige inserts niet langs dezelfde duplicate-check kunnen glippen. Alleen dezelfde naam zonder extra overeenkomst blijft toegestaan, maar de frontend toont daar wel een waarschuwing voor.

## Server-side klantnummer-generator per organisatie

Voor bestaande databases is deze aanvullende migratie toegevoegd:

```text
20260520_client_number_rpc_generator.sql
```

Deze migratie verplaatst het aanmaken van klantnummers naar Supabase/Postgres. Nieuwe klanten worden via `create_client_with_next_code(...)` aangemaakt en krijgen binnen dezelfde transactie een atomair gereserveerd klantnummer uit `organization_client_number_sequences`.

Belangrijk:

- de browser toont alleen nog een preview via `preview_next_client_code(...)`;
- het definitieve klantnummer wordt pas bij opslaan server-side vastgelegd;
- directe REST-inserts krijgen alsnog server-side een nummer via de `clients_duplicate_guard` trigger;
- de volgorde is per organisatie geserialiseerd met dezelfde advisory lock als de duplicate-guard, zodat twee gelijktijdige gebruikers nooit hetzelfde klantnummer krijgen.
