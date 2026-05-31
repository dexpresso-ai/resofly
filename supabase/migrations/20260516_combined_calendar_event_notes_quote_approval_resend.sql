-- ============================================================
-- BrandCore / ResoFly — Combined Supabase migration
-- Date: 2026-05-16
--
-- Purpose:
-- - Merge the agenda-item notes migration from migratie1
-- - Merge the quote approval + Resend flow migrations from migratie2
--
-- Run this single SQL file when you want to apply both feature sets
-- in one Supabase SQL editor run.
--
-- Sources included in order:
-- 1. 20260514_calendar_event_notes_complete.sql
-- 2. 20260515_quote_approval_resend_flow.sql
-- 3. 20260515_quote_approval_resend_flow_hardening.sql
-- 4. 20260515_quote_approval_resend_flow_final_recheck.sql
-- ============================================================


-- ============================================================
-- Included source migration: 20260514_calendar_event_notes_complete.sql
-- ============================================================

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

-- ============================================================
-- Included source migration: 20260515_quote_approval_resend_flow.sql
-- ============================================================

-- ============================================================
-- BrandCore / ResoFly — Quote approval + Resend delivery flow
-- Date: 2026-05-15
--
-- Scope:
-- - Project-linked quote workflow
-- - Internal approval state machine
-- - Public quote approval tokens
-- - Resend delivery tracking
-- - Quote timeline events
-- - Audit-log entries for critical quote actions
-- ============================================================

create extension if not exists pgcrypto;

begin;

-- Existing quotes get extra workflow states. Invoices keep using the legacy subset.
alter table public.quotes drop constraint if exists quotes_status_check;
alter table public.quotes
  add constraint quotes_status_check
  check (status in (
    'draft',
    'pending_internal_approval',
    'internally_approved',
    'sent',
    'accepted',
    'rejected',
    'expired',
    'paid',
    'overdue',
    'cancelled'
  ));

alter table public.quotes
  add column if not exists internal_approval_status text not null default 'draft',
  add column if not exists internal_approval_requested_at timestamptz,
  add column if not exists internal_approval_requested_by uuid references auth.users(id) on delete set null,
  add column if not exists internal_approved_at timestamptz,
  add column if not exists internal_approved_by uuid references auth.users(id) on delete set null,
  add column if not exists internal_rejected_at timestamptz,
  add column if not exists internal_rejected_by uuid references auth.users(id) on delete set null,
  add column if not exists internal_rejection_note text,
  add column if not exists client_decision_at timestamptz,
  add column if not exists client_decision_by_name text,
  add column if not exists client_decision_by_email text,
  add column if not exists client_decision_note text,
  add column if not exists public_token_hash text,
  add column if not exists public_token_created_at timestamptz,
  add column if not exists public_token_expires_at timestamptz,
  add column if not exists resend_last_email_id text,
  add column if not exists last_email_delivery_status text,
  add column if not exists last_email_delivery_at timestamptz,
  add column if not exists last_email_opened_at timestamptz,
  add column if not exists last_email_clicked_at timestamptz,
  add column if not exists last_email_failed_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quotes'::regclass
      and conname = 'quotes_internal_approval_status_check'
  ) then
    alter table public.quotes
      add constraint quotes_internal_approval_status_check
      check (internal_approval_status in ('draft','pending','approved','rejected'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.quotes'::regclass
      and conname = 'quotes_public_token_hash_unique'
  ) then
    alter table public.quotes
      add constraint quotes_public_token_hash_unique unique (public_token_hash);
  end if;
end $$;

create table if not exists public.quote_approval_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  quote_id uuid not null references public.quotes(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in (
    'created',
    'updated',
    'submitted_for_internal_approval',
    'internal_approval_granted',
    'internal_approval_rejected',
    'public_token_created',
    'sent_to_client',
    'email_sent',
    'email_delivered',
    'email_opened',
    'email_clicked',
    'email_bounced',
    'email_failed',
    'email_complained',
    'client_viewed',
    'client_accepted',
    'client_rejected',
    'expired',
    'cancelled'
  )),
  title text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.quote_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  quote_id uuid not null references public.quotes(id) on delete cascade,
  provider text not null default 'resend',
  provider_email_id text,
  recipient_email text not null,
  recipient_name text,
  subject text not null,
  status text not null default 'queued' check (status in ('queued','sent','delivered','opened','clicked','bounced','failed','complained')),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  bounced_at timestamptz,
  failed_at timestamptz,
  complained_at timestamptz,
  last_event_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.quote_email_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  quote_id uuid references public.quotes(id) on delete set null,
  delivery_id uuid references public.quote_email_deliveries(id) on delete set null,
  provider text not null default 'resend',
  provider_event_id text not null,
  provider_email_id text,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create index if not exists idx_quotes_workflow_org_status on public.quotes(organization_id, status, internal_approval_status, created_at desc);
create index if not exists idx_quotes_public_token_hash on public.quotes(public_token_hash) where public_token_hash is not null;
create index if not exists idx_quote_approval_events_quote on public.quote_approval_events(organization_id, quote_id, created_at desc);
create index if not exists idx_quote_email_deliveries_quote on public.quote_email_deliveries(organization_id, quote_id, created_at desc);
create index if not exists idx_quote_email_deliveries_provider_email on public.quote_email_deliveries(provider, provider_email_id) where provider_email_id is not null;
create index if not exists idx_quote_email_events_provider_email on public.quote_email_events(provider, provider_email_id, occurred_at desc);

alter table public.quote_approval_events enable row level security;
alter table public.quote_email_deliveries enable row level security;
alter table public.quote_email_events enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_approval_events' and policyname = 'quote approval events read') then
    create policy "quote approval events read" on public.quote_approval_events for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_approval_events' and policyname = 'quote approval events insert') then
    create policy "quote approval events insert" on public.quote_approval_events for insert with check (public.can_write_org(organization_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_email_deliveries' and policyname = 'quote email deliveries read') then
    create policy "quote email deliveries read" on public.quote_email_deliveries for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_email_deliveries' and policyname = 'quote email deliveries insert') then
    create policy "quote email deliveries insert" on public.quote_email_deliveries for insert with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_email_deliveries' and policyname = 'quote email deliveries update') then
    create policy "quote email deliveries update" on public.quote_email_deliveries for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_email_events' and policyname = 'quote email events read') then
    create policy "quote email events read" on public.quote_email_events for select using (public.can_read_org(organization_id));
  end if;
end $$;

-- Extend explicit audit event vocabulary. Existing row-change triggers keep working.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.audit_logs'::regclass
      and conname = 'audit_logs_action_check'
  ) then
    alter table public.audit_logs drop constraint audit_logs_action_check;
  end if;

  alter table public.audit_logs
    add constraint audit_logs_action_check
    check (action in (
      'created','updated','deleted','invited','accepted','revoked','role_changed','disabled','expired',
      'mollie_connected','plan_changed','seat_purchased','seat_downgrade_requested',
      'payment_succeeded','payment_failed','payment_expired','subscription_cancelled',
      'licensed_seats_changed','invitation_blocked_insufficient_seats','billing_synced',
      'quote_submitted_for_approval','quote_internal_approved','quote_internal_rejected',
      'quote_sent_to_client','quote_client_accepted','quote_client_rejected',
      'quote_email_delivered','quote_email_failed'
    ));
end $$;

create or replace function public.quote_token_hash(p_token text)
returns text
language sql
immutable
as $$
  select encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
$$;

create or replace function public.insert_quote_workflow_event(
  p_organization_id uuid,
  p_quote_id uuid,
  p_event_type text,
  p_title text,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_user_id uuid default auth.uid()
)
returns public.quote_approval_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.quote_approval_events;
begin
  insert into public.quote_approval_events(
    organization_id,
    quote_id,
    actor_user_id,
    event_type,
    title,
    description,
    metadata
  ) values (
    p_organization_id,
    p_quote_id,
    p_actor_user_id,
    p_event_type,
    coalesce(nullif(trim(p_title), ''), p_event_type),
    nullif(trim(coalesce(p_description, '')), ''),
    coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_event;

  return v_event;
end;
$$;

create or replace function public.insert_quote_audit_event(
  p_organization_id uuid,
  p_quote_id uuid,
  p_action text,
  p_entity_label text,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_user_id uuid default auth.uid()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
  values (p_organization_id, p_actor_user_id, p_action, 'quote', p_quote_id, p_entity_label, coalesce(p_metadata, '{}'::jsonb));
exception when others then
  raise warning 'quote audit event failed for quote % action %: %', p_quote_id, p_action, SQLERRM;
end;
$$;

create or replace function public.submit_quote_for_internal_approval(p_quote_id uuid, p_organization_id uuid)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if not public.can_write_org(p_organization_id) then raise exception 'Geen schrijfrechten voor deze organisatie' using errcode = '42501'; end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status in ('sent','accepted','rejected','expired','cancelled') then
    raise exception 'Deze offerte kan niet meer intern worden ingediend vanuit status %', v_quote.status using errcode = '23514';
  end if;
  if jsonb_array_length(coalesce(v_quote.lines, '[]'::jsonb)) = 0 then
    raise exception 'Een offerte zonder regels kan niet ter goedkeuring worden ingediend' using errcode = '23514';
  end if;

  update public.quotes
  set status = 'pending_internal_approval',
      internal_approval_status = 'pending',
      internal_approval_requested_at = now(),
      internal_approval_requested_by = v_user_id,
      internal_rejection_note = null,
      updated_at = now()
  where id = p_quote_id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'submitted_for_internal_approval', 'Ter interne goedkeuring ingediend', null, '{}'::jsonb, v_user_id);
  perform public.insert_quote_audit_event(p_organization_id, p_quote_id, 'quote_submitted_for_approval', v_quote.number, '{}'::jsonb, v_user_id);
  return v_quote;
end;
$$;

create or replace function public.approve_quote_internal(p_quote_id uuid, p_organization_id uuid)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if not public.can_admin_org(p_organization_id) then raise exception 'Alleen owners/admins kunnen offertes intern goedkeuren' using errcode = '42501'; end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status not in ('pending_internal_approval','internally_approved','draft') then
    raise exception 'Deze offerte kan niet intern worden goedgekeurd vanuit status %', v_quote.status using errcode = '23514';
  end if;

  update public.quotes
  set status = 'internally_approved',
      internal_approval_status = 'approved',
      internal_approved_at = now(),
      internal_approved_by = v_user_id,
      internal_rejected_at = null,
      internal_rejected_by = null,
      internal_rejection_note = null,
      updated_at = now()
  where id = p_quote_id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'internal_approval_granted', 'Intern goedgekeurd', null, '{}'::jsonb, v_user_id);
  perform public.insert_quote_audit_event(p_organization_id, p_quote_id, 'quote_internal_approved', v_quote.number, '{}'::jsonb, v_user_id);
  return v_quote;
end;
$$;

create or replace function public.reject_quote_internal(p_quote_id uuid, p_organization_id uuid, p_note text default null)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if not public.can_admin_org(p_organization_id) then raise exception 'Alleen owners/admins kunnen offertes intern afwijzen' using errcode = '42501'; end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status in ('sent','accepted','rejected','expired','cancelled') then
    raise exception 'Deze offerte kan niet intern worden afgewezen vanuit status %', v_quote.status using errcode = '23514';
  end if;

  update public.quotes
  set status = 'draft',
      internal_approval_status = 'rejected',
      internal_rejected_at = now(),
      internal_rejected_by = v_user_id,
      internal_rejection_note = nullif(trim(coalesce(p_note, '')), ''),
      updated_at = now()
  where id = p_quote_id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'internal_approval_rejected', 'Intern afgewezen', nullif(trim(coalesce(p_note, '')), ''), '{}'::jsonb, v_user_id);
  perform public.insert_quote_audit_event(p_organization_id, p_quote_id, 'quote_internal_rejected', v_quote.number, jsonb_build_object('note', nullif(trim(coalesce(p_note, '')), '')), v_user_id);
  return v_quote;
end;
$$;

create or replace function public.accept_quote_public(
  p_token_hash text,
  p_name text,
  p_email text,
  p_note text default null
)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
begin
  select * into v_quote
  from public.quotes
  where public_token_hash = p_token_hash
    and public_token_expires_at is not null
    and public_token_expires_at > now()
  for update;

  if not found then raise exception 'Offertelink is ongeldig of verlopen' using errcode = '28000'; end if;
  if v_quote.status <> 'sent' then raise exception 'Deze offerte kan niet meer worden geaccepteerd' using errcode = '23514'; end if;

  update public.quotes
  set status = 'accepted',
      accepted_at = now(),
      client_decision_at = now(),
      client_decision_by_name = nullif(trim(coalesce(p_name, '')), ''),
      client_decision_by_email = nullif(lower(trim(coalesce(p_email, ''))), ''),
      client_decision_note = nullif(trim(coalesce(p_note, '')), ''),
      updated_at = now()
  where id = v_quote.id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(v_quote.organization_id, v_quote.id, 'client_accepted', 'Klant heeft de offerte geaccepteerd', nullif(trim(coalesce(p_note, '')), ''), jsonb_build_object('name', p_name, 'email', p_email), null);
  perform public.insert_quote_audit_event(v_quote.organization_id, v_quote.id, 'quote_client_accepted', v_quote.number, jsonb_build_object('name', p_name, 'email', p_email), null);
  return v_quote;
end;
$$;

create or replace function public.reject_quote_public(
  p_token_hash text,
  p_name text,
  p_email text,
  p_note text default null
)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
begin
  select * into v_quote
  from public.quotes
  where public_token_hash = p_token_hash
    and public_token_expires_at is not null
    and public_token_expires_at > now()
  for update;

  if not found then raise exception 'Offertelink is ongeldig of verlopen' using errcode = '28000'; end if;
  if v_quote.status <> 'sent' then raise exception 'Deze offerte kan niet meer worden geweigerd' using errcode = '23514'; end if;

  update public.quotes
  set status = 'rejected',
      client_decision_at = now(),
      client_decision_by_name = nullif(trim(coalesce(p_name, '')), ''),
      client_decision_by_email = nullif(lower(trim(coalesce(p_email, ''))), ''),
      client_decision_note = nullif(trim(coalesce(p_note, '')), ''),
      updated_at = now()
  where id = v_quote.id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(v_quote.organization_id, v_quote.id, 'client_rejected', 'Klant heeft de offerte geweigerd', nullif(trim(coalesce(p_note, '')), ''), jsonb_build_object('name', p_name, 'email', p_email), null);
  perform public.insert_quote_audit_event(v_quote.organization_id, v_quote.id, 'quote_client_rejected', v_quote.number, jsonb_build_object('name', p_name, 'email', p_email), null);
  return v_quote;
end;
$$;


create or replace function public.enforce_quote_status_transition()
returns trigger
language plpgsql
as $$
begin
  if TG_OP <> 'UPDATE' then return new; end if;
  if old.status is not distinct from new.status then return new; end if;

  if old.status = 'draft' and new.status in ('pending_internal_approval','cancelled') then return new; end if;
  if old.status = 'pending_internal_approval' and new.status in ('internally_approved','draft','cancelled') then return new; end if;
  if old.status = 'internally_approved' and new.status in ('sent','draft','cancelled') then return new; end if;
  if old.status = 'sent' and new.status in ('accepted','rejected','expired','cancelled') then return new; end if;
  if old.status in ('accepted','rejected','expired','cancelled') and new.status = old.status then return new; end if;

  raise exception 'Ongeldige offerte-statusovergang van % naar %. Gebruik de offerte-workflow acties.', old.status, new.status using errcode = '23514';
end;
$$;

drop trigger if exists quotes_status_transition_guard on public.quotes;
create trigger quotes_status_transition_guard
  before update of status on public.quotes
  for each row execute function public.enforce_quote_status_transition();

grant execute on function public.submit_quote_for_internal_approval(uuid, uuid) to authenticated;
grant execute on function public.approve_quote_internal(uuid, uuid) to authenticated;
grant execute on function public.reject_quote_internal(uuid, uuid, text) to authenticated;
grant execute on function public.accept_quote_public(text, text, text, text) to service_role;
grant execute on function public.reject_quote_public(text, text, text, text) to service_role;
grant execute on function public.insert_quote_workflow_event(uuid, uuid, text, text, text, jsonb, uuid) to authenticated, service_role;
grant execute on function public.insert_quote_audit_event(uuid, uuid, text, text, jsonb, uuid) to authenticated, service_role;

commit;

-- ============================================================
-- Included source migration: 20260515_quote_approval_resend_flow_hardening.sql
-- ============================================================

-- ============================================================
-- BrandCore / ResoFly — Quote approval + Resend hardening
-- Scope:
-- - Lock quote business fields after submission
-- - Keep timeline/email tables read-only from browser clients
-- - Add transactional send lifecycle RPCs for Resend
-- - Harden helper RPC permissions
-- ============================================================

begin;

-- Browser clients may read timeline/e-mail status, but inserts/updates must flow
-- through RPCs or service-role Edge Functions to prevent forged events/statuses.
drop policy if exists "quote approval events insert" on public.quote_approval_events;
drop policy if exists "quote email deliveries insert" on public.quote_email_deliveries;
drop policy if exists "quote email deliveries update" on public.quote_email_deliveries;

create or replace function public.insert_quote_workflow_event(
  p_organization_id uuid,
  p_quote_id uuid,
  p_event_type text,
  p_title text,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_user_id uuid default auth.uid()
)
returns public.quote_approval_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.quote_approval_events;
begin
  if auth.role() = 'authenticated' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.quotes q
    where q.id = p_quote_id and q.organization_id = p_organization_id
  ) then
    raise exception 'Offerte niet gevonden voor deze organisatie' using errcode = '02000';
  end if;

  insert into public.quote_approval_events(
    organization_id,
    quote_id,
    actor_user_id,
    event_type,
    title,
    description,
    metadata
  ) values (
    p_organization_id,
    p_quote_id,
    p_actor_user_id,
    p_event_type,
    coalesce(nullif(trim(p_title), ''), p_event_type),
    nullif(trim(coalesce(p_description, '')), ''),
    coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_event;

  return v_event;
end;
$$;

create or replace function public.insert_quote_audit_event(
  p_organization_id uuid,
  p_quote_id uuid,
  p_action text,
  p_entity_label text,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_user_id uuid default auth.uid()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'authenticated' and not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.quotes q
    where q.id = p_quote_id and q.organization_id = p_organization_id
  ) then
    raise exception 'Offerte niet gevonden voor deze organisatie' using errcode = '02000';
  end if;

  begin
    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (p_organization_id, p_actor_user_id, p_action, 'quote', p_quote_id, p_entity_label, coalesce(p_metadata, '{}'::jsonb));
  exception when others then
    raise warning 'quote audit event failed for quote % action %: %', p_quote_id, p_action, SQLERRM;
  end;
end;
$$;

create or replace function public.enforce_quote_immutable_after_submission()
returns trigger
language plpgsql
as $$
begin
  if TG_OP <> 'UPDATE' then return new; end if;

  if old.status = 'draft' then
    return new;
  end if;

  if old.number is distinct from new.number
    or old.date is distinct from new.date
    or old.valid_until is distinct from new.valid_until
    or old.client_id is distinct from new.client_id
    or old.project_id is distinct from new.project_id
    or old.lines is distinct from new.lines
    or old.notes is distinct from new.notes then
    raise exception 'Deze offerte is al onderdeel van de goedkeuringsflow. Maak een nieuwe offerte of reset de workflow voordat je inhoudelijke velden wijzigt.' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists quotes_immutable_after_submission_guard on public.quotes;
create trigger quotes_immutable_after_submission_guard
  before update of number, date, valid_until, client_id, project_id, lines, notes on public.quotes
  for each row execute function public.enforce_quote_immutable_after_submission();

create or replace function public.begin_quote_email_send(
  p_quote_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_token_hash text,
  p_token_expires_at timestamptz,
  p_recipient_email text,
  p_recipient_name text,
  p_subject text,
  p_public_url text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_delivery public.quote_email_deliveries;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de server mag een offerte-e-mail voorbereiden' using errcode = '42501';
  end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status <> 'internally_approved' or v_quote.internal_approval_status <> 'approved' then
    raise exception 'Alleen intern goedgekeurde offertes kunnen worden verstuurd' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.quote_email_deliveries d
    where d.quote_id = p_quote_id
      and d.organization_id = p_organization_id
      and d.status = 'queued'
      and d.created_at > now() - interval '15 minutes'
  ) then
    raise exception 'Er loopt al een recente Resend-verzendpoging voor deze offerte' using errcode = '23505';
  end if;

  update public.quotes
  set public_token_hash = p_token_hash,
      public_token_created_at = now(),
      public_token_expires_at = p_token_expires_at,
      last_email_delivery_status = 'queued',
      updated_at = now()
  where id = p_quote_id
  returning * into v_quote;

  insert into public.quote_email_deliveries(
    organization_id,
    quote_id,
    provider,
    provider_email_id,
    recipient_email,
    recipient_name,
    subject,
    status,
    last_event_at,
    metadata
  ) values (
    p_organization_id,
    p_quote_id,
    'resend',
    null,
    lower(trim(p_recipient_email)),
    nullif(trim(coalesce(p_recipient_name, '')), ''),
    p_subject,
    'queued',
    now(),
    jsonb_build_object('publicUrl', p_public_url, 'expiresAt', p_token_expires_at)
  ) returning * into v_delivery;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'public_token_created', 'Publieke offertelink aangemaakt', 'Link voorbereid voor verzending via Resend.', jsonb_build_object('expiresAt', p_token_expires_at), p_actor_user_id);

  return jsonb_build_object('deliveryId', v_delivery.id, 'quoteId', v_quote.id);
end;
$$;

create or replace function public.complete_quote_email_send(
  p_delivery_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_provider_email_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery public.quote_email_deliveries;
  v_quote public.quotes;
  v_now timestamptz := now();
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de server mag een offerte-e-mail afronden' using errcode = '42501';
  end if;

  select * into v_delivery
  from public.quote_email_deliveries
  where id = p_delivery_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'E-maildelivery niet gevonden' using errcode = '02000'; end if;

  select * into v_quote
  from public.quotes
  where id = v_delivery.quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status <> 'internally_approved' or v_quote.internal_approval_status <> 'approved' then
    raise exception 'Offerte staat niet meer klaar om te verzenden' using errcode = '23514';
  end if;

  update public.quote_email_deliveries
  set provider_email_id = nullif(trim(coalesce(p_provider_email_id, '')), ''),
      status = 'sent',
      sent_at = v_now,
      last_event_at = v_now,
      updated_at = v_now
  where id = v_delivery.id
  returning * into v_delivery;

  update public.quotes
  set status = 'sent',
      sent_at = v_now,
      resend_last_email_id = nullif(trim(coalesce(p_provider_email_id, '')), ''),
      last_email_delivery_status = 'sent',
      updated_at = v_now
  where id = v_quote.id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(p_organization_id, v_quote.id, 'email_sent', 'E-mail geaccepteerd door Resend', null, jsonb_build_object('providerEmailId', p_provider_email_id), p_actor_user_id);
  perform public.insert_quote_workflow_event(p_organization_id, v_quote.id, 'sent_to_client', 'Offerte naar klant verzonden', 'Verstuurd naar ' || v_delivery.recipient_email || '.', jsonb_build_object('recipientEmail', v_delivery.recipient_email, 'providerEmailId', p_provider_email_id), p_actor_user_id);
  perform public.insert_quote_audit_event(p_organization_id, v_quote.id, 'quote_sent_to_client', v_quote.number, jsonb_build_object('recipientEmail', v_delivery.recipient_email, 'providerEmailId', p_provider_email_id), p_actor_user_id);

  return jsonb_build_object('delivery', to_jsonb(v_delivery), 'quote', to_jsonb(v_quote));
end;
$$;

create or replace function public.fail_quote_email_send(
  p_delivery_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery public.quote_email_deliveries;
  v_quote public.quotes;
  v_now timestamptz := now();
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de server mag een offerte-e-mail markeren als mislukt' using errcode = '42501';
  end if;

  select * into v_delivery
  from public.quote_email_deliveries
  where id = p_delivery_id and organization_id = p_organization_id
  for update;

  if not found then return; end if;

  update public.quote_email_deliveries
  set status = 'failed',
      failed_at = v_now,
      last_event_at = v_now,
      error_message = nullif(trim(coalesce(p_error_message, '')), ''),
      updated_at = v_now
  where id = v_delivery.id
  returning * into v_delivery;

  select * into v_quote
  from public.quotes
  where id = v_delivery.quote_id and organization_id = p_organization_id
  for update;

  if found and v_quote.status = 'internally_approved' then
    update public.quotes
    set last_email_delivery_status = 'failed',
        last_email_failed_at = v_now,
        updated_at = v_now
    where id = v_quote.id;

    perform public.insert_quote_workflow_event(p_organization_id, v_quote.id, 'email_failed', 'E-mail verzenden via Resend mislukt', nullif(trim(coalesce(p_error_message, '')), ''), '{}'::jsonb, p_actor_user_id);
    perform public.insert_quote_audit_event(p_organization_id, v_quote.id, 'quote_email_failed', v_quote.number, jsonb_build_object('error', p_error_message), p_actor_user_id);
  end if;
end;
$$;

grant execute on function public.begin_quote_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text) to service_role;
grant execute on function public.complete_quote_email_send(uuid, uuid, uuid, text) to service_role;
grant execute on function public.fail_quote_email_send(uuid, uuid, uuid, text) to service_role;

commit;

-- ============================================================
-- Included source migration: 20260515_quote_approval_resend_flow_final_recheck.sql
-- ============================================================

-- ============================================================
-- BrandCore / ResoFly — Quote approval + Resend final recheck hardening
-- Date: 2026-05-15
-- Scope:
-- - Prevent browser clients from directly mutating quote workflow fields
-- - Prevent direct helper-RPC event/audit forgery
-- - Require proper pending state before internal approval
-- - Enforce quote validity date during public acceptance
-- ============================================================

begin;

-- Direct table updates from browser clients may edit draft business fields,
-- but workflow/status/delivery fields must only change through trusted RPCs
-- and service-role Edge Functions. SECURITY DEFINER RPCs run as the function
-- owner and are therefore not blocked by this guard.
create or replace function public.enforce_quote_workflow_fields_server_only()
returns trigger
language plpgsql
as $$
begin
  if current_user not in ('anon', 'authenticated', 'authenticator') then
    return new;
  end if;

  if TG_OP = 'INSERT' then
    if coalesce(new.status, 'draft') <> 'draft'
      or coalesce(new.internal_approval_status, 'draft') <> 'draft'
      or new.internal_approval_requested_at is not null
      or new.internal_approval_requested_by is not null
      or new.internal_approved_at is not null
      or new.internal_approved_by is not null
      or new.internal_rejected_at is not null
      or new.internal_rejected_by is not null
      or new.internal_rejection_note is not null
      or new.client_decision_at is not null
      or new.client_decision_by_name is not null
      or new.client_decision_by_email is not null
      or new.client_decision_note is not null
      or new.public_token_hash is not null
      or new.public_token_created_at is not null
      or new.public_token_expires_at is not null
      or new.resend_last_email_id is not null
      or new.last_email_delivery_status is not null
      or new.last_email_delivery_at is not null
      or new.last_email_opened_at is not null
      or new.last_email_clicked_at is not null
      or new.last_email_failed_at is not null
      or new.sent_at is not null
      or new.accepted_at is not null then
      raise exception 'Offerte-workflowvelden mogen niet rechtstreeks vanuit de browser worden gezet. Gebruik de offerte-workflow acties.' using errcode = '42501';
    end if;
    return new;
  end if;

  if TG_OP = 'UPDATE' then
    if old.status is distinct from new.status
      or old.internal_approval_status is distinct from new.internal_approval_status
      or old.internal_approval_requested_at is distinct from new.internal_approval_requested_at
      or old.internal_approval_requested_by is distinct from new.internal_approval_requested_by
      or old.internal_approved_at is distinct from new.internal_approved_at
      or old.internal_approved_by is distinct from new.internal_approved_by
      or old.internal_rejected_at is distinct from new.internal_rejected_at
      or old.internal_rejected_by is distinct from new.internal_rejected_by
      or old.internal_rejection_note is distinct from new.internal_rejection_note
      or old.client_decision_at is distinct from new.client_decision_at
      or old.client_decision_by_name is distinct from new.client_decision_by_name
      or old.client_decision_by_email is distinct from new.client_decision_by_email
      or old.client_decision_note is distinct from new.client_decision_note
      or old.public_token_hash is distinct from new.public_token_hash
      or old.public_token_created_at is distinct from new.public_token_created_at
      or old.public_token_expires_at is distinct from new.public_token_expires_at
      or old.resend_last_email_id is distinct from new.resend_last_email_id
      or old.last_email_delivery_status is distinct from new.last_email_delivery_status
      or old.last_email_delivery_at is distinct from new.last_email_delivery_at
      or old.last_email_opened_at is distinct from new.last_email_opened_at
      or old.last_email_clicked_at is distinct from new.last_email_clicked_at
      or old.last_email_failed_at is distinct from new.last_email_failed_at
      or old.sent_at is distinct from new.sent_at
      or old.accepted_at is distinct from new.accepted_at then
      raise exception 'Offerte-workflowvelden mogen niet rechtstreeks vanuit de browser worden gewijzigd. Gebruik de offerte-workflow acties.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists quotes_workflow_fields_server_only_guard on public.quotes;
create trigger quotes_workflow_fields_server_only_guard
  before insert or update of
    status,
    internal_approval_status,
    internal_approval_requested_at,
    internal_approval_requested_by,
    internal_approved_at,
    internal_approved_by,
    internal_rejected_at,
    internal_rejected_by,
    internal_rejection_note,
    client_decision_at,
    client_decision_by_name,
    client_decision_by_email,
    client_decision_note,
    public_token_hash,
    public_token_created_at,
    public_token_expires_at,
    resend_last_email_id,
    last_email_delivery_status,
    last_email_delivery_at,
    last_email_opened_at,
    last_email_clicked_at,
    last_email_failed_at,
    sent_at,
    accepted_at
  on public.quotes
  for each row execute function public.enforce_quote_workflow_fields_server_only();

-- Prevent direct browser RPC calls that could forge timeline/audit records.
-- Workflow RPCs and Edge Functions can still call these helpers from trusted
-- SECURITY DEFINER/server-role contexts.
revoke execute on function public.insert_quote_workflow_event(uuid, uuid, text, text, text, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.insert_quote_audit_event(uuid, uuid, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.insert_quote_workflow_event(uuid, uuid, text, text, text, jsonb, uuid) to service_role;
grant execute on function public.insert_quote_audit_event(uuid, uuid, text, text, jsonb, uuid) to service_role;

revoke execute on function public.accept_quote_public(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.reject_quote_public(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.begin_quote_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.complete_quote_email_send(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.fail_quote_email_send(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.accept_quote_public(text, text, text, text) to service_role;
grant execute on function public.reject_quote_public(text, text, text, text) to service_role;
grant execute on function public.begin_quote_email_send(uuid, uuid, uuid, text, timestamptz, text, text, text, text) to service_role;
grant execute on function public.complete_quote_email_send(uuid, uuid, uuid, text) to service_role;
grant execute on function public.fail_quote_email_send(uuid, uuid, uuid, text) to service_role;

create or replace function public.submit_quote_for_internal_approval(p_quote_id uuid, p_organization_id uuid)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if not public.can_write_org(p_organization_id) then raise exception 'Geen schrijfrechten voor deze organisatie' using errcode = '42501'; end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status <> 'draft' then
    raise exception 'Deze offerte kan niet ter goedkeuring worden ingediend vanuit status %', v_quote.status using errcode = '23514';
  end if;
  if jsonb_array_length(coalesce(v_quote.lines, '[]'::jsonb)) = 0 then
    raise exception 'Een offerte zonder regels kan niet ter goedkeuring worden ingediend' using errcode = '23514';
  end if;

  update public.quotes
  set status = 'pending_internal_approval',
      internal_approval_status = 'pending',
      internal_approval_requested_at = now(),
      internal_approval_requested_by = v_user_id,
      internal_approved_at = null,
      internal_approved_by = null,
      internal_rejected_at = null,
      internal_rejected_by = null,
      internal_rejection_note = null,
      updated_at = now()
  where id = p_quote_id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'submitted_for_internal_approval', 'Ter interne goedkeuring ingediend', null, '{}'::jsonb, v_user_id);
  perform public.insert_quote_audit_event(p_organization_id, p_quote_id, 'quote_submitted_for_approval', v_quote.number, '{}'::jsonb, v_user_id);
  return v_quote;
end;
$$;

create or replace function public.approve_quote_internal(p_quote_id uuid, p_organization_id uuid)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if not public.can_admin_org(p_organization_id) then raise exception 'Alleen owners/admins kunnen offertes intern goedkeuren' using errcode = '42501'; end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status <> 'pending_internal_approval' or v_quote.internal_approval_status <> 'pending' then
    raise exception 'Deze offerte moet eerst ter interne goedkeuring worden ingediend voordat deze kan worden goedgekeurd' using errcode = '23514';
  end if;
  if jsonb_array_length(coalesce(v_quote.lines, '[]'::jsonb)) = 0 then
    raise exception 'Een offerte zonder regels kan niet intern worden goedgekeurd' using errcode = '23514';
  end if;

  update public.quotes
  set status = 'internally_approved',
      internal_approval_status = 'approved',
      internal_approved_at = now(),
      internal_approved_by = v_user_id,
      internal_rejected_at = null,
      internal_rejected_by = null,
      internal_rejection_note = null,
      updated_at = now()
  where id = p_quote_id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'internal_approval_granted', 'Intern goedgekeurd', null, '{}'::jsonb, v_user_id);
  perform public.insert_quote_audit_event(p_organization_id, p_quote_id, 'quote_internal_approved', v_quote.number, '{}'::jsonb, v_user_id);
  return v_quote;
end;
$$;

create or replace function public.reject_quote_internal(p_quote_id uuid, p_organization_id uuid, p_note text default null)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Niet ingelogd' using errcode = '28000'; end if;
  if not public.can_admin_org(p_organization_id) then raise exception 'Alleen owners/admins kunnen offertes intern afwijzen' using errcode = '42501'; end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status not in ('pending_internal_approval','internally_approved') then
    raise exception 'Deze offerte kan niet intern worden afgewezen vanuit status %', v_quote.status using errcode = '23514';
  end if;

  update public.quotes
  set status = 'draft',
      internal_approval_status = 'rejected',
      internal_rejected_at = now(),
      internal_rejected_by = v_user_id,
      internal_rejection_note = nullif(trim(coalesce(p_note, '')), ''),
      internal_approved_at = null,
      internal_approved_by = null,
      updated_at = now()
  where id = p_quote_id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'internal_approval_rejected', 'Intern afgewezen', nullif(trim(coalesce(p_note, '')), ''), '{}'::jsonb, v_user_id);
  perform public.insert_quote_audit_event(p_organization_id, p_quote_id, 'quote_internal_rejected', v_quote.number, jsonb_build_object('note', nullif(trim(coalesce(p_note, '')), '')), v_user_id);
  return v_quote;
end;
$$;

create or replace function public.accept_quote_public(
  p_token_hash text,
  p_name text,
  p_email text,
  p_note text default null
)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de publieke offerte-service mag klantbeslissingen verwerken' using errcode = '42501';
  end if;

  select * into v_quote
  from public.quotes
  where public_token_hash = p_token_hash
    and public_token_expires_at is not null
    and public_token_expires_at > now()
  for update;

  if not found then raise exception 'Offertelink is ongeldig of verlopen' using errcode = '28000'; end if;
  if v_quote.status <> 'sent' then raise exception 'Deze offerte kan niet meer worden geaccepteerd' using errcode = '23514'; end if;
  if v_quote.valid_until is not null and v_quote.valid_until < current_date then
    raise exception 'Deze offerte is verlopen en kan niet meer worden geaccepteerd' using errcode = '23514';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'Naam is verplicht om de offerte te accepteren' using errcode = '23514';
  end if;
  if nullif(lower(trim(coalesce(p_email, ''))), '') is null or lower(trim(coalesce(p_email, ''))) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Geldig e-mailadres is verplicht om de offerte te accepteren' using errcode = '23514';
  end if;

  update public.quotes
  set status = 'accepted',
      accepted_at = now(),
      client_decision_at = now(),
      client_decision_by_name = nullif(trim(coalesce(p_name, '')), ''),
      client_decision_by_email = nullif(lower(trim(coalesce(p_email, ''))), ''),
      client_decision_note = nullif(trim(coalesce(p_note, '')), ''),
      updated_at = now()
  where id = v_quote.id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(v_quote.organization_id, v_quote.id, 'client_accepted', 'Klant heeft de offerte geaccepteerd', nullif(trim(coalesce(p_note, '')), ''), jsonb_build_object('name', p_name, 'email', p_email), null);
  perform public.insert_quote_audit_event(v_quote.organization_id, v_quote.id, 'quote_client_accepted', v_quote.number, jsonb_build_object('name', p_name, 'email', p_email), null);
  return v_quote;
end;
$$;

create or replace function public.reject_quote_public(
  p_token_hash text,
  p_name text,
  p_email text,
  p_note text default null
)
returns public.quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de publieke offerte-service mag klantbeslissingen verwerken' using errcode = '42501';
  end if;

  select * into v_quote
  from public.quotes
  where public_token_hash = p_token_hash
    and public_token_expires_at is not null
    and public_token_expires_at > now()
  for update;

  if not found then raise exception 'Offertelink is ongeldig of verlopen' using errcode = '28000'; end if;
  if v_quote.status <> 'sent' then raise exception 'Deze offerte kan niet meer worden geweigerd' using errcode = '23514'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'Naam is verplicht om de offerte te weigeren' using errcode = '23514';
  end if;
  if nullif(lower(trim(coalesce(p_email, ''))), '') is null or lower(trim(coalesce(p_email, ''))) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Geldig e-mailadres is verplicht om de offerte te weigeren' using errcode = '23514';
  end if;

  update public.quotes
  set status = 'rejected',
      client_decision_at = now(),
      client_decision_by_name = nullif(trim(coalesce(p_name, '')), ''),
      client_decision_by_email = nullif(lower(trim(coalesce(p_email, ''))), ''),
      client_decision_note = nullif(trim(coalesce(p_note, '')), ''),
      updated_at = now()
  where id = v_quote.id
  returning * into v_quote;

  perform public.insert_quote_workflow_event(v_quote.organization_id, v_quote.id, 'client_rejected', 'Klant heeft de offerte geweigerd', nullif(trim(coalesce(p_note, '')), ''), jsonb_build_object('name', p_name, 'email', p_email), null);
  perform public.insert_quote_audit_event(v_quote.organization_id, v_quote.id, 'quote_client_rejected', v_quote.number, jsonb_build_object('name', p_name, 'email', p_email), null);
  return v_quote;
end;
$$;

create or replace function public.begin_quote_email_send(
  p_quote_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_token_hash text,
  p_token_expires_at timestamptz,
  p_recipient_email text,
  p_recipient_name text,
  p_subject text,
  p_public_url text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotes;
  v_delivery public.quote_email_deliveries;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de server mag een offerte-e-mail voorbereiden' using errcode = '42501';
  end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id and organization_id = p_organization_id
  for update;

  if not found then raise exception 'Offerte niet gevonden' using errcode = '02000'; end if;
  if v_quote.status <> 'internally_approved' or v_quote.internal_approval_status <> 'approved' then
    raise exception 'Alleen intern goedgekeurde offertes kunnen worden verstuurd' using errcode = '23514';
  end if;
  if v_quote.valid_until is not null and v_quote.valid_until < current_date then
    raise exception 'Deze offerte is verlopen en kan niet meer worden verstuurd' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.quote_email_deliveries d
    where d.quote_id = p_quote_id
      and d.organization_id = p_organization_id
      and d.status = 'queued'
      and d.created_at > now() - interval '15 minutes'
  ) then
    raise exception 'Er loopt al een recente Resend-verzendpoging voor deze offerte' using errcode = '23505';
  end if;

  update public.quotes
  set public_token_hash = p_token_hash,
      public_token_created_at = now(),
      public_token_expires_at = p_token_expires_at,
      last_email_delivery_status = 'queued',
      updated_at = now()
  where id = p_quote_id
  returning * into v_quote;

  insert into public.quote_email_deliveries(
    organization_id,
    quote_id,
    provider,
    provider_email_id,
    recipient_email,
    recipient_name,
    subject,
    status,
    last_event_at,
    metadata
  ) values (
    p_organization_id,
    p_quote_id,
    'resend',
    null,
    lower(trim(p_recipient_email)),
    nullif(trim(coalesce(p_recipient_name, '')), ''),
    p_subject,
    'queued',
    now(),
    jsonb_build_object('publicUrl', p_public_url, 'expiresAt', p_token_expires_at)
  ) returning * into v_delivery;

  perform public.insert_quote_workflow_event(p_organization_id, p_quote_id, 'public_token_created', 'Publieke offertelink aangemaakt', 'Link voorbereid voor verzending via Resend.', jsonb_build_object('expiresAt', p_token_expires_at), p_actor_user_id);

  return jsonb_build_object('deliveryId', v_delivery.id, 'quoteId', v_quote.id);
end;
$$;


grant execute on function public.submit_quote_for_internal_approval(uuid, uuid) to authenticated;
grant execute on function public.approve_quote_internal(uuid, uuid) to authenticated;
grant execute on function public.reject_quote_internal(uuid, uuid, text) to authenticated;
grant execute on function public.accept_quote_public(text, text, text, text) to service_role;
grant execute on function public.reject_quote_public(text, text, text, text) to service_role;

commit;
