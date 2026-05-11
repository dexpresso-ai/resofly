# Changelog — Notes Context Enrichment — 2026-05-11

## Doel
De centrale notitiemodule uitbreiden zodat notities beter bruikbaar zijn in klant- en projectcontext.

## Toegevoegd
- `note_type` toegevoegd aan `notes` met vaste waarden:
  - `general`
  - `meeting`
  - `action`
  - `decision`
  - `idea`
  - `support`
- `tags text[]` toegevoegd aan `notes` voor vrije notitietags.
- Nieuwe Supabase-migratie:
  - `supabase/migrations/20260511_notes_context_enrichment.sql`
- Fresh-install schema's bijgewerkt:
  - `supabase/schema.sql`
  - `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
  - `supabase/BRANDCORE_DATABASE_SETUP.sql`
- Notitie-overzicht vernieuwd met:
  - datum toegevoegd via `created_at`
  - type-badges
  - klant/project-context
  - tag-weergave
  - centrale kaartweergave
- Klantdetails uitgebreid met gekoppelde notities.
  - Notities die direct aan de klant hangen worden getoond.
  - Projectnotities van projecten van die klant worden ook meegenomen.
- Projectdetails uitgebreid met projectnotities.
- Vanuit klantdetails en projectdetails kan direct een gekoppelde notitie worden aangemaakt.
- Klantkaarten tonen nu het aantal gekoppelde notities.

## Niet gewijzigd
- Bestaande authenticatie, RLS, organisatie-isolatie, billing, kalender en R2/Worker-functionaliteit zijn niet functioneel aangepast.
- Er is geen extra datumkolom toegevoegd, omdat `created_at` al de juiste bron is voor “datum toegevoegd”.

## Database-impact
Voor bestaande omgevingen moet de nieuwe migratie worden uitgevoerd voordat notities met type/tags worden opgeslagen:

```bash
supabase db push
```

Of voer de SQL uit vanuit:

```txt
supabase/migrations/20260511_notes_context_enrichment.sql
```
