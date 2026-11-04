# Changelog — Calendar Event Notes Hardening

Datum: 2026-05-12  
Versie: `2.2.4-calendar-event-notes-hardening`

## Scope
Gerichte hardening op de agenda-notities feature. Er zijn geen nieuwe productfeatures toegevoegd buiten de gevraagde fixes.

## Aangepast

### 1. Event-detailpaneel sluit vóór openen/aanmaken notitie
- `CalendarEventDetailPanel` sluit nu expliciet vóór het openen van de notitie-editor.
- Dit voorkomt dat de notitie-modal achter de agenda-overlay terechtkomt.
- Geldt voor:
  - `+ Notitie` vanuit een agenda-item.
  - openen/bewerken van een reeds gekoppelde notitie vanuit het agenda-detailpaneel.

### 2. Database setup consistent gemaakt
- `supabase/BRANDCORE_DATABASE_SETUP.sql` bevat nu ook de volledige `note_calendar_links`-laag.
- De setup is hiermee weer consistent met:
  - `supabase/schema.sql`
  - `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
  - `supabase/migrations/20260514_calendar_event_notes_complete.sql`

### 3. Transactionele hardening voor nieuwe agenda-notities
- Nieuwe Supabase RPC toegevoegd:
  - `public.create_note_with_calendar_link(...)`
- Nieuwe migratie toegevoegd:
  - `supabase/migrations/20260514_calendar_event_notes_complete.sql`
- Bij het aanmaken van een nieuwe notitie vanuit een agenda-item worden `notes` en `note_calendar_links` nu in één database-transactie aangemaakt.
- Als de kalenderlink faalt, wordt de notitie-insert automatisch teruggedraaid. Daardoor ontstaan er geen orphan notes meer.

## Frontend-aanpassing
- `src/lib/repository.ts`
  - nieuwe functie `createNoteWithCalendarLink(...)`
- `src/main.tsx`
  - nieuwe agenda-notities gebruiken nu de transactionele RPC in plaats van losse `insertRow(...)` + `createNoteCalendarLink(...)`
- `src/features/CalendarPage.tsx`
  - overlay sluit vóór openen/aanmaken van notities

## Database-aanpassing
Nieuwe RPC is opgenomen in:
- `supabase/migrations/20260514_calendar_event_notes_complete.sql`
- `supabase/schema.sql`
- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`
- `supabase/BRANDCORE_DATABASE_SETUP.sql`

## Deploy-notitie
Voor bestaande omgevingen na de vorige agenda-notities release:

```bash
supabase db push
```

De gecombineerde migratie `20260514_calendar_event_notes_complete.sql` bevat zowel de tabel, policies/triggers als de transactionele RPC.
