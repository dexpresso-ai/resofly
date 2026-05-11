-- Enrich central notes with type and free-form tags.
-- Existing notes are backfilled as general notes without tags.

alter table public.notes
  add column if not exists note_type text not null default 'general',
  add column if not exists tags text[] not null default '{}';

alter table public.notes
  drop constraint if exists notes_note_type_check;

alter table public.notes
  add constraint notes_note_type_check
  check (note_type in ('general','meeting','action','decision','idea','support'));

create index if not exists idx_notes_type on public.notes(organization_id, note_type, created_at desc);
create index if not exists idx_notes_tags on public.notes using gin(tags);
