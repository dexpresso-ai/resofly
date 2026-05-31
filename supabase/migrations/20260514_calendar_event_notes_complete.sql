-- Calendar Event Notes complete migration.
-- Squashed replacement for:
-- - 20260512_note_calendar_links.sql
-- - 20260513_calendar_note_transaction_rpc.sql
--
-- Run this single SQL migration for the agenda-item notes feature.
-- It is intentionally idempotent enough for staging retries: tables/indexes are created if missing,
-- policies/triggers are recreated, and functions use CREATE OR REPLACE.

-- Link internal rich-text notes to external Google/Microsoft calendar events.
-- Events remain external; ResoFly stores only a stable reference + safe snapshots.

create table if not exists public.note_calendar_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  note_id uuid not null references public.notes(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft')),
  calendar_source_id uuid not null references public.calendar_sources(id) on delete cascade,
  provider_calendar_id text,
  provider_event_id text not null,
  event_starts_at timestamptz not null,
  event_ends_at timestamptz,
  event_title_snapshot text,
  event_location_snapshot text,
  event_html_link text,
  visibility_snapshot text not null default 'organization' check (visibility_snapshot in ('private','organization')),
  is_private_masked_snapshot boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, note_id, provider, calendar_source_id, provider_event_id, event_starts_at)
);

create index if not exists idx_note_calendar_links_event
  on public.note_calendar_links(organization_id, provider, calendar_source_id, provider_event_id, event_starts_at desc);

create index if not exists idx_note_calendar_links_note
  on public.note_calendar_links(organization_id, note_id, created_at desc);

create or replace function public.enforce_note_calendar_links_integrity()
returns trigger language plpgsql as $$
declare
  v_note public.notes;
  v_source public.calendar_sources;
begin
  if new.visibility_snapshot <> 'organization' then
    raise exception 'Notities koppelen aan privé-agenda-items is geblokkeerd' using errcode = '23514';
  end if;

  if coalesce(new.is_private_masked_snapshot, false) then
    raise exception 'Notities koppelen aan afgeschermde agenda-items is geblokkeerd' using errcode = '23514';
  end if;

  select * into v_note from public.notes where id = new.note_id;
  if not found then
    raise exception 'note_calendar_links.note_id verwijst naar een niet-bestaande notitie' using errcode = '23514';
  end if;
  if v_note.organization_id <> new.organization_id then
    raise exception 'note_calendar_links.organization_id wijkt af van de gekoppelde notitie' using errcode = '23514';
  end if;

  select * into v_source from public.calendar_sources where id = new.calendar_source_id;
  if not found then
    raise exception 'note_calendar_links.calendar_source_id verwijst naar een niet-bestaande agenda' using errcode = '23514';
  end if;
  if v_source.organization_id <> new.organization_id then
    raise exception 'note_calendar_links.organization_id wijkt af van de gekoppelde agenda' using errcode = '23514';
  end if;
  if v_source.provider <> new.provider then
    raise exception 'note_calendar_links.provider wijkt af van de gekoppelde agenda-provider' using errcode = '23514';
  end if;
  if v_source.visibility <> 'organization' then
    raise exception 'Notities koppelen is alleen toegestaan voor agenda’s die met de organisatie gedeeld zijn' using errcode = '23514';
  end if;

  new.provider_calendar_id := coalesce(new.provider_calendar_id, v_source.provider_calendar_id);
  return new;
end;
$$;

drop trigger if exists note_calendar_links_prevent_org_change on public.note_calendar_links;
create trigger note_calendar_links_prevent_org_change
  before update of organization_id on public.note_calendar_links
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists note_calendar_links_integrity on public.note_calendar_links;
create trigger note_calendar_links_integrity
  before insert or update of note_id, organization_id, provider, calendar_source_id, visibility_snapshot, is_private_masked_snapshot
  on public.note_calendar_links
  for each row execute function public.enforce_note_calendar_links_integrity();

drop trigger if exists note_calendar_links_audit on public.note_calendar_links;
create trigger note_calendar_links_audit
  after insert or update or delete on public.note_calendar_links
  for each row execute function public.audit_row_change('note_calendar_link','event_title_snapshot');

alter table public.note_calendar_links enable row level security;

drop policy if exists "note calendar links read" on public.note_calendar_links;
create policy "note calendar links read" on public.note_calendar_links for select using (
  public.can_read_org(organization_id)
  and visibility_snapshot = 'organization'
  and is_private_masked_snapshot = false
  and exists (
    select 1 from public.notes note
    where note.id = note_calendar_links.note_id
      and note.organization_id = note_calendar_links.organization_id
  )
  and exists (
    select 1 from public.calendar_sources source
    where source.id = note_calendar_links.calendar_source_id
      and source.organization_id = note_calendar_links.organization_id
      and source.visibility = 'organization'
  )
);

drop policy if exists "note calendar links insert" on public.note_calendar_links;
create policy "note calendar links insert" on public.note_calendar_links for insert with check (
  public.can_write_org(organization_id)
  and created_by = auth.uid()
  and visibility_snapshot = 'organization'
  and is_private_masked_snapshot = false
  and exists (
    select 1 from public.notes note
    where note.id = note_calendar_links.note_id
      and note.organization_id = note_calendar_links.organization_id
  )
  and exists (
    select 1 from public.calendar_sources source
    where source.id = note_calendar_links.calendar_source_id
      and source.organization_id = note_calendar_links.organization_id
      and source.visibility = 'organization'
  )
);

drop policy if exists "note calendar links update" on public.note_calendar_links;
create policy "note calendar links update" on public.note_calendar_links for update using (
  public.can_write_org(organization_id)
) with check (
  public.can_write_org(organization_id)
  and visibility_snapshot = 'organization'
  and is_private_masked_snapshot = false
  and exists (
    select 1 from public.notes note
    where note.id = note_calendar_links.note_id
      and note.organization_id = note_calendar_links.organization_id
  )
  and exists (
    select 1 from public.calendar_sources source
    where source.id = note_calendar_links.calendar_source_id
      and source.organization_id = note_calendar_links.organization_id
      and source.visibility = 'organization'
  )
);

drop policy if exists "note calendar links delete" on public.note_calendar_links;
create policy "note calendar links delete" on public.note_calendar_links for delete using (
  public.can_write_org(organization_id)
);

-- Transactional creation of a rich-text note plus its calendar-event link.
-- This prevents orphan notes when creating a note from a calendar event and the link insert fails.
create or replace function public.create_note_with_calendar_link(
  p_organization_id uuid,
  p_client_id uuid,
  p_project_id uuid,
  p_title text,
  p_content text,
  p_note_type text,
  p_tags text[],
  p_provider text,
  p_calendar_source_id uuid,
  p_provider_calendar_id text,
  p_provider_event_id text,
  p_event_starts_at timestamptz,
  p_event_ends_at timestamptz,
  p_event_title_snapshot text,
  p_event_location_snapshot text,
  p_event_html_link text,
  p_visibility_snapshot text,
  p_is_private_masked_snapshot boolean
)
returns public.notes
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_note public.notes;
  v_clean_title text := nullif(trim(coalesce(p_title, '')), '');
  v_note_type text := coalesce(nullif(trim(p_note_type), ''), 'general');
begin
  if v_user_id is null then
    raise exception 'Niet ingelogd.' using errcode = '28000';
  end if;

  if not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  if p_visibility_snapshot <> 'organization' or coalesce(p_is_private_masked_snapshot, false) then
    raise exception 'Notities koppelen is alleen toegestaan bij gedeelde agenda-items waarvan de details zichtbaar zijn.' using errcode = '23514';
  end if;

  if v_note_type not in ('general','meeting','action','decision','idea','support') then
    raise exception 'Ongeldig notitietype: %', v_note_type using errcode = '23514';
  end if;

  insert into public.notes (
    organization_id,
    created_by,
    client_id,
    project_id,
    title,
    content,
    note_type,
    tags
  ) values (
    p_organization_id,
    v_user_id,
    p_client_id,
    p_project_id,
    coalesce(v_clean_title, 'Notitie ' || to_char(now(), 'DD-MM-YYYY')),
    coalesce(p_content, ''),
    v_note_type,
    coalesce(p_tags, '{}'::text[])
  ) returning * into v_note;

  insert into public.note_calendar_links (
    organization_id,
    created_by,
    note_id,
    provider,
    calendar_source_id,
    provider_calendar_id,
    provider_event_id,
    event_starts_at,
    event_ends_at,
    event_title_snapshot,
    event_location_snapshot,
    event_html_link,
    visibility_snapshot,
    is_private_masked_snapshot
  ) values (
    p_organization_id,
    v_user_id,
    v_note.id,
    p_provider,
    p_calendar_source_id,
    p_provider_calendar_id,
    p_provider_event_id,
    p_event_starts_at,
    p_event_ends_at,
    p_event_title_snapshot,
    p_event_location_snapshot,
    p_event_html_link,
    p_visibility_snapshot,
    coalesce(p_is_private_masked_snapshot, false)
  );

  return v_note;
end;
$$;

revoke all on function public.create_note_with_calendar_link(
  uuid, uuid, uuid, text, text, text, text[], text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, boolean
) from public;
grant execute on function public.create_note_with_calendar_link(
  uuid, uuid, uuid, text, text, text, text[], text, uuid, text, text, timestamptz, timestamptz, text, text, text, text, boolean
) to authenticated;
