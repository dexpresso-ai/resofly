-- ============================================================
-- ResoFly — Opgeslagen rapportages (zelfbouw-rapportbouwer, fase 2)
-- Date: 2026-06-23
--
-- Scope:
-- - `saved_reports` bewaart een door de gebruiker samengestelde rapportage als
--   pure JSON-definitie (`definition`, de client-side `ReportDefinition`). De
--   engine draait volledig in de browser; de database slaat alleen de definitie,
--   een naam en de dashboard-plaatsing op.
-- - `is_pinned` + `position` bepalen of en in welke volgorde een rapport als
--   widget op het dashboard verschijnt.
--
-- Beveiliging:
-- - RLS staat lezen/schrijven uitsluitend toe aan actieve organisatieleden
--   (zelfde patroon als notes/documents/content_folders).
-- ============================================================

begin;

create table if not exists public.saved_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  name text not null,
  definition jsonb not null default '{}'::jsonb,
  is_pinned boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.saved_reports
  drop constraint if exists saved_reports_name_not_blank;
alter table public.saved_reports
  add constraint saved_reports_name_not_blank
  check (length(btrim(name)) > 0);

create index if not exists idx_saved_reports_org
  on public.saved_reports(organization_id, created_at desc);
create index if not exists idx_saved_reports_pinned
  on public.saved_reports(organization_id, is_pinned, position)
  where is_pinned;

-- Houd updated_at automatisch bij.
create or replace function public.touch_saved_report_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end; $$;

drop trigger if exists saved_reports_touch_updated_at on public.saved_reports;
create trigger saved_reports_touch_updated_at
  before update on public.saved_reports
  for each row execute function public.touch_saved_report_updated_at();

-- Blokkeer verplaatsen naar een andere organisatie na aanmaken.
drop trigger if exists saved_reports_prevent_org_change on public.saved_reports;
create trigger saved_reports_prevent_org_change
  before update of organization_id on public.saved_reports
  for each row execute function public.prevent_organization_id_change();

-- Audit trail, consistent met de overige org-scoped tabellen.
drop trigger if exists saved_reports_audit on public.saved_reports;
create trigger saved_reports_audit
  after insert or update or delete on public.saved_reports
  for each row execute function public.audit_row_change('saved_report', 'name');

alter table public.saved_reports enable row level security;

drop policy if exists "saved_reports read" on public.saved_reports;
create policy "saved_reports read" on public.saved_reports for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "saved_reports insert" on public.saved_reports;
create policy "saved_reports insert" on public.saved_reports for insert with check (
  public.can_write_org(organization_id)
  and created_by = auth.uid()
);

drop policy if exists "saved_reports update" on public.saved_reports;
create policy "saved_reports update" on public.saved_reports for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);

drop policy if exists "saved_reports delete" on public.saved_reports;
create policy "saved_reports delete" on public.saved_reports for delete using (
  public.can_write_org(organization_id)
);

commit;
