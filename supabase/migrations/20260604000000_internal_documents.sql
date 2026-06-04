-- Internal documents: rich-text documents alongside notes.
-- Mirrors the notes table: org-scoped, optional client/project link, a fixed
-- category (document_type) and rich-text content. Idempotent for staging retries.

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  client_id uuid references public.clients(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  title text not null,
  content text not null default '',
  document_type text not null default 'general',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.documents
  drop constraint if exists documents_document_type_check;
alter table public.documents
  add constraint documents_document_type_check
  check (document_type in ('contract','general','policy','procedure','other'));

create index if not exists idx_documents_org_created
  on public.documents(organization_id, created_at desc);
create index if not exists idx_documents_type
  on public.documents(organization_id, document_type, created_at desc);
create index if not exists idx_documents_client
  on public.documents(organization_id, client_id, created_at desc);
create index if not exists idx_documents_project
  on public.documents(organization_id, project_id, created_at desc);

-- Block moving a document to another organization after creation.
drop trigger if exists documents_prevent_org_change on public.documents;
create trigger documents_prevent_org_change
  before update of organization_id on public.documents
  for each row execute function public.prevent_organization_id_change();

-- Audit trail, consistent with notes/clients/etc.
drop trigger if exists documents_audit on public.documents;
create trigger documents_audit
  after insert or update or delete on public.documents
  for each row execute function public.audit_row_change('document','title');

alter table public.documents enable row level security;

drop policy if exists "documents read" on public.documents;
create policy "documents read" on public.documents for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "documents insert" on public.documents;
create policy "documents insert" on public.documents for insert with check (
  public.can_write_org(organization_id)
  and created_by = auth.uid()
);

drop policy if exists "documents update" on public.documents;
create policy "documents update" on public.documents for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);

drop policy if exists "documents delete" on public.documents;
create policy "documents delete" on public.documents for delete using (
  public.can_write_org(organization_id)
);
