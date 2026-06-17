-- ============================================================
-- ResoFly — Agenda-items koppelen aan klant & project
-- Date: 2026-06-17
--
-- Scope:
-- - Nieuwe tabel `calendar_event_links`: koppelt een extern agenda-item
--   (Google/Microsoft) aan een klant en/of project. Hierdoor kun je bij het
--   aanmaken van een event direct de klant en/of het project kiezen, en daarna
--   heel makkelijk notities en documenten met de juiste koppeling aanmaken.
-- - Een koppeling is org-scoped en identificeert het event op exact dezelfde
--   manier als `note_calendar_links`: provider + agenda (source) +
--   provider_event_id + starttijd. Eén koppeling per event-instantie.
-- - `client_id` / `project_id` zijn 'on delete set null': verwijder je een klant
--   of project, dan blijft de eventkoppeling bestaan zonder die verwijzing.
--
-- Beveiliging:
-- - RLS staat lezen/schrijven uitsluitend toe aan actieve organisatieleden
--   (zelfde patroon als note_calendar_links / notes / documents).
-- ============================================================

begin;

create table if not exists public.calendar_event_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  provider text not null check (provider in ('google','microsoft')),
  calendar_source_id uuid not null references public.calendar_sources(id) on delete cascade,
  provider_calendar_id text,
  provider_event_id text not null,
  event_starts_at timestamptz not null,
  event_title_snapshot text,
  client_id uuid references public.clients(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, calendar_source_id, provider_event_id, event_starts_at)
);

create index if not exists idx_calendar_event_links_lookup
  on public.calendar_event_links(organization_id, provider, calendar_source_id, provider_event_id, event_starts_at desc);
create index if not exists idx_calendar_event_links_client
  on public.calendar_event_links(organization_id, client_id);
create index if not exists idx_calendar_event_links_project
  on public.calendar_event_links(organization_id, project_id);

-- updated_at automatisch bijhouden.
create or replace function public.touch_calendar_event_link_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end; $$;

drop trigger if exists calendar_event_links_touch_updated_at on public.calendar_event_links;
create trigger calendar_event_links_touch_updated_at
  before update on public.calendar_event_links
  for each row execute function public.touch_calendar_event_link_updated_at();

-- Integriteit: de agenda hoort bij dezelfde organisatie én provider, en de
-- gekozen klant/het project ook bij dezelfde organisatie. provider_calendar_id
-- en (indien leeg) client_id worden automatisch afgeleid.
create or replace function public.validate_calendar_event_link()
returns trigger language plpgsql as $$
declare
  v_source public.calendar_sources;
  v_client_org uuid;
  v_project_org uuid;
  v_project_client uuid;
begin
  select * into v_source from public.calendar_sources where id = new.calendar_source_id;
  if not found then
    raise exception 'calendar_event_links.calendar_source_id verwijst naar een niet-bestaande agenda' using errcode = '23514';
  end if;
  if v_source.organization_id <> new.organization_id then
    raise exception 'calendar_event_links.organization_id wijkt af van de gekoppelde agenda' using errcode = '23514';
  end if;
  if v_source.provider <> new.provider then
    raise exception 'calendar_event_links.provider wijkt af van de gekoppelde agenda-provider' using errcode = '23514';
  end if;
  new.provider_calendar_id := coalesce(new.provider_calendar_id, v_source.provider_calendar_id);

  if new.project_id is not null then
    select organization_id, client_id into v_project_org, v_project_client
    from public.projects where id = new.project_id;
    if v_project_org is null then
      raise exception 'calendar_event_links.project_id verwijst naar een niet-bestaand project' using errcode = '23514';
    end if;
    if v_project_org <> new.organization_id then
      raise exception 'calendar_event_links.project_id hoort bij een andere organisatie' using errcode = '23514';
    end if;
    -- Leid de klant af uit het project als die niet expliciet is gekozen.
    if new.client_id is null then
      new.client_id := v_project_client;
    end if;
  end if;

  if new.client_id is not null then
    select organization_id into v_client_org from public.clients where id = new.client_id;
    if v_client_org is null then
      raise exception 'calendar_event_links.client_id verwijst naar een niet-bestaande klant' using errcode = '23514';
    end if;
    if v_client_org <> new.organization_id then
      raise exception 'calendar_event_links.client_id hoort bij een andere organisatie' using errcode = '23514';
    end if;
  end if;

  return new;
end; $$;

drop trigger if exists calendar_event_links_validate on public.calendar_event_links;
create trigger calendar_event_links_validate
  before insert or update on public.calendar_event_links
  for each row execute function public.validate_calendar_event_link();

-- Blokkeer verplaatsen naar een andere organisatie na aanmaken.
drop trigger if exists calendar_event_links_prevent_org_change on public.calendar_event_links;
create trigger calendar_event_links_prevent_org_change
  before update of organization_id on public.calendar_event_links
  for each row execute function public.prevent_organization_id_change();

-- Audit trail, consistent met de overige org-scoped tabellen.
drop trigger if exists calendar_event_links_audit on public.calendar_event_links;
create trigger calendar_event_links_audit
  after insert or update or delete on public.calendar_event_links
  for each row execute function public.audit_row_change('calendar_event_link', 'event_title_snapshot');

alter table public.calendar_event_links enable row level security;

drop policy if exists "calendar_event_links read" on public.calendar_event_links;
create policy "calendar_event_links read" on public.calendar_event_links for select using (
  public.can_read_org(organization_id)
);

drop policy if exists "calendar_event_links insert" on public.calendar_event_links;
create policy "calendar_event_links insert" on public.calendar_event_links for insert with check (
  public.can_write_org(organization_id)
  and created_by = auth.uid()
);

drop policy if exists "calendar_event_links update" on public.calendar_event_links;
create policy "calendar_event_links update" on public.calendar_event_links for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
);

drop policy if exists "calendar_event_links delete" on public.calendar_event_links;
create policy "calendar_event_links delete" on public.calendar_event_links for delete using (
  public.can_write_org(organization_id)
);

commit;
