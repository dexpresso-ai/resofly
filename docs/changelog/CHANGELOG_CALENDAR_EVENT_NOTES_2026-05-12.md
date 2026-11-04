# Changelog — Calendar Event Notes (2026-05-12)

## Toegevoegd

- Agenda-items kunnen vanuit het event-detailpaneel worden gekoppeld aan interne rich-text notities.
- Nieuwe relationele tabel `note_calendar_links` toegevoegd voor stabiele koppeling tussen externe Google/Microsoft-events en interne notities.
- Ondersteuning voor recurring events via combinatie van:
  - provider
  - calendar source
  - provider event id
  - starttijd van de specifieke occurrence
- Nieuwe notitie aanmaken vanuit een agenda-item:
  - opent bestaande rich-text notitie-editor
  - zet standaard `note_type = meeting`
  - voegt standaard tag `agenda` toe
  - maakt na opslaan automatisch de kalenderkoppeling aan
- Bestaande notitie koppelen aan een agenda-item via dropdown in het event-detailpaneel.
- Gekoppelde notities bekijken en openen vanuit het agenda-item.
- Notitie loskoppelen van een agenda-item zonder de notitie zelf te verwijderen.

## Privacy & veiligheid

- Koppelen is bewust geblokkeerd voor privé-agenda-items en afgeschermde/masked events.
- Database-trigger valideert dat alleen organisatiegedeelde agenda-sources gekoppeld mogen worden.
- RLS toegevoegd voor `note_calendar_links`:
  - lezen alleen voor organisatieleden
  - schrijven alleen voor leden met schrijfrechten
  - verwijderen alleen voor leden met schrijfrechten
- Metadata snapshots worden alleen opgeslagen bij organisatiegedeelde, niet-afgeschermde events.

## Gewijzigde bestanden

- `src/types.ts`
- `src/lib/repository.ts`
- `src/main.tsx`
- `src/features/CalendarPage.tsx`
- `src/styles/globals.css`
- `supabase/migrations/20260514_calendar_event_notes_complete.sql`
- `supabase/schema.sql`
- `supabase/FRESH_INSTALL_COMPLETE_SCHEMA.sql`

## Database-migratie

Voer deze migratie uit in Supabase voordat de feature in productie wordt gebruikt:

```sql
supabase/migrations/20260514_calendar_event_notes_complete.sql
```

Of via Supabase CLI:

```bash
supabase db push
```
