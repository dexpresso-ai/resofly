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
