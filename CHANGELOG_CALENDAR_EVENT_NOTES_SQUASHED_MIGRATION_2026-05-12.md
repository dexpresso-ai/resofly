# Changelog — Calendar Event Notes Squashed Migration

Datum: 2026-05-12  
Versie: `2.2.5-calendar-event-notes-squashed-migration`

## Scope
Gerichte database-opschoning: de twee eerdere agenda-notitie-migraties zijn samengevoegd tot één complete migratie, zodat de feature met één SQL-query kan worden toegepast.

## Aangepast

### 1. Eén gecombineerde migratie
Nieuwe migratie toegevoegd:

```text
supabase/migrations/20260514_calendar_event_notes_complete.sql
```

Deze bevat in één bestand:
- `note_calendar_links` tabel;
- indexes;
- integrity trigger;
- audit trigger;
- RLS policies;
- `public.create_note_with_calendar_link(...)` RPC;
- grants/revoke voor de RPC.

### 2. Oude losse migraties verwijderd
Verwijderd uit de codebase:

```text
supabase/migrations/20260512_note_calendar_links.sql
supabase/migrations/20260513_calendar_note_transaction_rpc.sql
```

### 3. Documentatie en waarschuwingen bijgewerkt
- `supabase/migrations/README.md` verwijst nu naar de ene gecombineerde migratie.
- `src/lib/repository.ts` noemt bij ontbrekende tabel nu `20260514_calendar_event_notes_complete.sql`.
- Bestaande changelogreferenties zijn bijgewerkt om verwarring met oude migratiebestanden te voorkomen.

## Deploy-notitie
Voor een bestaande omgeving waarop de agenda-notities nog niet zijn toegepast, voer je alleen deze migratie uit:

```text
supabase/migrations/20260514_calendar_event_notes_complete.sql
```

Voor Supabase CLI:

```bash
supabase db push
```

Voor Supabase SQL Editor: kopieer de volledige inhoud van `20260514_calendar_event_notes_complete.sql` en voer die als één query uit.
