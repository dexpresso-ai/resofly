-- ============================================================
-- ResoFly — Mappenstructuur voor inhoud (content folders)
-- Date: 2026-06-16
--
-- Scope:
-- - Per klant een hiërarchische mappenboom (`content_folders`) waarin notities
--   en documenten geordend kunnen worden. Mappen zijn org-scoped; `client_id`
--   is nullable zodat organisatiebrede mappen later mogelijk zijn (de UI werkt
--   voorlopig uitsluitend per klant).
-- - `notes.folder_id` en `documents.folder_id` koppelen een item aan een map.
--   Bij het verwijderen van een map vervalt de koppeling (on delete set null):
--   notities/documenten gaan dus nooit verloren, ze worden alleen ontkoppeld.
-- - Externe bestanden kunnen rechtstreeks in een map worden geüpload. Ze worden
--   als attachment opgeslagen met `entity_type = 'folder'`; daarom breidt deze
--   migratie de `attachments.entity_type`-CHECK uit met 'folder'.
--
-- Beveiliging:
-- - RLS staat lezen/schrijven uitsluitend toe aan actieve organisatieleden
--   (zelfde patroon als notes/documents).
-- ============================================================

begin;

create table if not exists public.content_folders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  client_id uuid references public.clients(id) on delete cascade,
  parent_id uuid references public.content_folders(id) on delete cascade,
  name text not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.content_folders
  drop constraint if exists content_folders_name_not_blank;
alter table public.content_folders
  add constraint content_folders_name_not_blank
  check (length(btrim(name)) > 0);

create index if not exists idx_content_folders_org_client
  on public.content_folders(organization_id, client_id, parent_id, position);
create index if not exists idx_content_folders_parent
  on public.content_folders(parent_id);

-- Map-koppeling op notes en documents.
alter table public.notes
  add column if not exists folder_id uuid references public.content_folders(id) on delete set null;
alter table public.documents
  add column if not exists folder_id uuid references public.content_folders(id) on delete set null;

create index if not exists idx_notes_folder on public.notes(organization_id, folder_id);
create index if not exists idx_documents_folder on public.documents(organization_id, folder_id);

-- Houd updated_at automatisch bij.
create or replace function public.touch_content_folder_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end; $$;

drop trigger if exists content_folders_touch_updated_at on public.content_folders;
create trigger content_folders_touch_updated_at
  before update on public.content_folders
  for each row execute function public.touch_content_folder_updated_at();

-- Valideer de hiërarchie: de bovenliggende map hoort bij dezelfde organisatie
-- én dezelfde klant, en een map kan nooit een (klein)kind van zichzelf worden
-- (cykel-preventie).
create or replace function public.validate_content_folder()
returns trigger language plpgsql as $$
declare
  parent_org uuid;
  parent_client uuid;
  cursor_id uuid;
  guard int := 0;
begin
  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'Een map kan niet zijn eigen bovenliggende map zijn.';
    end if;

    select organization_id, client_id into parent_org, parent_client
    from public.content_folders where id = new.parent_id;

    if parent_org is null then
      raise exception 'Bovenliggende map bestaat niet.';
    end if;
    if parent_org <> new.organization_id then
      raise exception 'Bovenliggende map hoort bij een andere organisatie.';
    end if;
    if parent_client is distinct from new.client_id then
      raise exception 'Bovenliggende map hoort bij een andere klant.';
    end if;

    -- Loop omhoog door de voorouders. Kom je new.id tegen, dan zou er een
    -- cyclische structuur ontstaan.
    cursor_id := new.parent_id;
    while cursor_id is not null loop
      guard := guard + 1;
      if cursor_id = new.id then
        raise exception 'Cyclische mapstructuur is niet toegestaan.';
      end if;
      if guard > 100 then
        raise exception 'Maximale mapdiepte overschreden.';
      end if;
      select parent_id into cursor_id from public.content_folders where id = cursor_id;
    end loop;
  end if;
  return new;
end; $$;

drop trigger if exists content_folders_validate on public.content_folders;
create trigger content_folders_validate
  before insert or update on public.content_folders
  for each row execute function public.validate_content_folder();

-- Blokkeer verplaatsen naar een andere organisatie na aanmaken.
drop trigger if exists content_folders_prevent_org_change on public.content_folders;
create trigger content_folders_prevent_org_change
  before update of organization_id on public.content_folders
  for each row execute function public.prevent_organization_id_change();

-- Audit trail, consistent met notes/documents/etc.
drop trigger if exists content_folders_audit on public.content_folders;
create trigger content_folders_audit
  after insert or update or delete on public.content_folders
  for each row execute function public.audit_row_change('content_folder', 'name');

alter table public.content_folders enable row level security;

drop policy if exists "content_folders read" on public.content_folders;
create policy "content_folders read" on public.content_folders for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "content_folders insert" on public.content_folders;
create policy "content_folders insert" on public.content_folders for insert with check (
  public.can_write_org(organization_id)
  and created_by = auth.uid()
);

drop policy if exists "content_folders update" on public.content_folders;
create policy "content_folders update" on public.content_folders for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);

drop policy if exists "content_folders delete" on public.content_folders;
create policy "content_folders delete" on public.content_folders for delete using (
  public.can_write_org(organization_id)
);

-- Sta bijlagen toe die rechtstreeks aan een map hangen (geüploade bestanden).
-- De entity_type-CHECK predateert de migratiehistorie: drop wat er is en
-- hercreëer met de volledige, huidige set incl. 'folder'.
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
  check (entity_type in ('client','project','task','subtask','ticket','note','document','quote','invoice','folder'));

commit;
