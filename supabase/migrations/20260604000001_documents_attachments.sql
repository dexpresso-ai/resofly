-- Allow attachments on internal documents (e.g. generated PDF snapshots stored in R2).
-- The attachments.entity_type CHECK predates the migration history, so drop whatever
-- entity_type check exists and recreate it with the full, current set incl. 'document'.

do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.attachments'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%entity_type%'
  loop
    execute format('alter table public.attachments drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.attachments
  add constraint attachments_entity_type_check
  check (entity_type in ('client','project','task','subtask','ticket','note','document','quote','invoice'));
