-- ============================================================
-- ResoFly — Ticketnotities / tijdlijn (ticket notes timeline)
-- Date: 2026-06-16
--
-- Scope:
-- - Tickets krijgen een gedeelde notitie-/conversatietijdlijn waar zowel
--   medewerkers (author_type = 'user') als klanten via het portaal
--   (author_type = 'client') notities aan toevoegen.
-- - Medewerkers kunnen een notitie als INTERN markeren (is_internal = true).
--   Interne notities zijn alleen zichtbaar voor organisatieleden en worden
--   NOOIT door de `client-portal` edge function naar de klant teruggestuurd.
--
-- Beveiliging:
-- - RLS staat lezen/schrijven uitsluitend toe aan actieve organisatieleden
--   (zelfde patroon als notes/documents). Klanten zijn geen organisatielid en
--   krijgen via de gewone app dus nul toegang.
-- - Het klantportaal leest en schrijft uitsluitend via de service-role
--   `client-portal` edge function, die toegang afleidt uit het geverifieerde
--   e-mailadres en interne notities server-side wegfiltert.
-- ============================================================

begin;

create table if not exists public.ticket_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  author_type text not null default 'user',
  author_user_id uuid references auth.users(id) on delete set null,
  author_name text,
  body text not null,
  is_internal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ticket_notes
  drop constraint if exists ticket_notes_author_type_check;
alter table public.ticket_notes
  add constraint ticket_notes_author_type_check
  check (author_type in ('user', 'client'));

-- Een klantnotitie is per definitie zichtbaar voor de klant: alleen
-- medewerkers kunnen iets verbergen. Dit voorkomt dat een klantnotitie ooit
-- per ongeluk (of via een omweg) als 'intern' wordt gemarkeerd.
alter table public.ticket_notes
  drop constraint if exists ticket_notes_client_visible_check;
alter table public.ticket_notes
  add constraint ticket_notes_client_visible_check
  check (author_type <> 'client' or is_internal = false);

alter table public.ticket_notes
  drop constraint if exists ticket_notes_body_not_blank;
alter table public.ticket_notes
  add constraint ticket_notes_body_not_blank
  check (length(btrim(body)) > 0);

create index if not exists idx_ticket_notes_ticket
  on public.ticket_notes(organization_id, ticket_id, created_at);
create index if not exists idx_ticket_notes_org_created
  on public.ticket_notes(organization_id, created_at desc);

-- Houd updated_at automatisch bij zodat de tijdlijn een betrouwbare
-- "bewerkt op" kan tonen, ongeacht of de schrijver dat veld meestuurt.
create or replace function public.touch_ticket_note_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end; $$;

drop trigger if exists ticket_notes_touch_updated_at on public.ticket_notes;
create trigger ticket_notes_touch_updated_at
  before update on public.ticket_notes
  for each row execute function public.touch_ticket_note_updated_at();

-- Blokkeer verplaatsen naar een andere organisatie na aanmaken.
drop trigger if exists ticket_notes_prevent_org_change on public.ticket_notes;
create trigger ticket_notes_prevent_org_change
  before update of organization_id on public.ticket_notes
  for each row execute function public.prevent_organization_id_change();

-- Audit trail, consistent met notes/documents/etc.
drop trigger if exists ticket_notes_audit on public.ticket_notes;
create trigger ticket_notes_audit
  after insert or update or delete on public.ticket_notes
  for each row execute function public.audit_row_change('ticket_note', 'author_name');

alter table public.ticket_notes enable row level security;

drop policy if exists "ticket_notes read" on public.ticket_notes;
create policy "ticket_notes read" on public.ticket_notes for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "ticket_notes insert" on public.ticket_notes;
create policy "ticket_notes insert" on public.ticket_notes for insert with check (
  public.can_write_org(organization_id)
  and created_by = auth.uid()
);

drop policy if exists "ticket_notes update" on public.ticket_notes;
create policy "ticket_notes update" on public.ticket_notes for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);

drop policy if exists "ticket_notes delete" on public.ticket_notes;
create policy "ticket_notes delete" on public.ticket_notes for delete using (
  public.can_write_org(organization_id)
);

commit;
