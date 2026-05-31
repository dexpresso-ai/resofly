-- ============================================================
-- BrandCore Sprint 1 Workspace Foundation
-- Adds audit-log basis for organization SaaS operations.
-- Safe to run on an existing BrandCore v2 organization database.
-- ============================================================

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null default auth.uid(),
  action text not null check (action in ('created','updated','deleted','invited','accepted','revoked','role_changed','disabled')),
  entity_type text not null,
  entity_id uuid,
  entity_label text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_org_created on public.audit_logs(organization_id, created_at desc);
create index if not exists idx_audit_logs_entity on public.audit_logs(organization_id, entity_type, entity_id);

create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity_type text := coalesce(nullif(TG_ARGV[0], ''), TG_TABLE_NAME);
  v_label_column text := coalesce(nullif(TG_ARGV[1], ''), 'name');
  v_old jsonb := case when TG_OP in ('UPDATE','DELETE') then to_jsonb(old) else '{}'::jsonb end;
  v_new jsonb := case when TG_OP in ('INSERT','UPDATE') then to_jsonb(new) else '{}'::jsonb end;
  v_org uuid;
  v_entity_id uuid;
  v_label text;
  v_action text;
  v_changed text[] := array[]::text[];
begin
  if TG_TABLE_NAME = 'organizations' then
    v_org := coalesce(nullif(v_new ->> 'id', '')::uuid, nullif(v_old ->> 'id', '')::uuid);
  else
    v_org := coalesce(nullif(v_new ->> 'organization_id', '')::uuid, nullif(v_old ->> 'organization_id', '')::uuid);
  end if;

  v_entity_id := coalesce(nullif(v_new ->> 'id', '')::uuid, nullif(v_old ->> 'id', '')::uuid);
  v_label := coalesce(
    nullif(v_new ->> v_label_column, ''), nullif(v_old ->> v_label_column, ''),
    nullif(v_new ->> 'title', ''), nullif(v_old ->> 'title', ''),
    nullif(v_new ->> 'number', ''), nullif(v_old ->> 'number', ''),
    nullif(v_new ->> 'email', ''), nullif(v_old ->> 'email', ''),
    v_entity_id::text
  );

  if TG_OP = 'INSERT' then
    v_action := 'created';
  elsif TG_OP = 'DELETE' then
    v_action := 'deleted';
  else
    select coalesce(array_agg(key order by key), array[]::text[])
      into v_changed
    from jsonb_object_keys(v_new || v_old) as changed(key)
    where (v_old -> key) is distinct from (v_new -> key)
      and key not in ('updated_at');

    if coalesce(array_length(v_changed, 1), 0) = 0 then
      return new;
    end if;

    v_action := 'updated';
  end if;

  if TG_TABLE_NAME = 'organization_invitations' then
    v_entity_type := 'invitation';
    if TG_OP = 'INSERT' then
      v_action := 'invited';
    elsif TG_OP = 'UPDATE' and v_old ->> 'status' is distinct from v_new ->> 'status' then
      if v_new ->> 'status' in ('accepted','revoked') then
        v_action := v_new ->> 'status';
      end if;
    end if;
  elsif TG_TABLE_NAME = 'organization_members' then
    v_entity_type := 'member';
    if TG_OP = 'UPDATE' and v_old ->> 'role' is distinct from v_new ->> 'role' then
      v_action := 'role_changed';
    elsif TG_OP = 'UPDATE' and v_new ->> 'status' = 'disabled' and v_old ->> 'status' is distinct from v_new ->> 'status' then
      v_action := 'disabled';
    elsif TG_OP = 'INSERT' and v_new ->> 'role' <> 'owner' then
      v_action := 'accepted';
    end if;
  end if;

  if v_org is not null then
    insert into public.audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, entity_label, metadata)
    values (
      v_org,
      auth.uid(),
      v_action,
      v_entity_type,
      v_entity_id,
      v_label,
      jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP, 'changed_columns', to_jsonb(v_changed))
    );
  end if;

  if TG_OP = 'DELETE' then return old; end if;
  return new;
exception when others then
  raise warning 'audit logging failed for %.%: %', TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLERRM;
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

alter table public.audit_logs enable row level security;
drop policy if exists "audit logs read by org members" on public.audit_logs;
create policy "audit logs read by org members" on public.audit_logs for select using (public.can_read_org(organization_id));

-- Recreate all audit triggers idempotently.
drop trigger if exists organizations_audit on public.organizations;
create trigger organizations_audit after insert or update or delete on public.organizations for each row execute function public.audit_row_change('organization','name');

drop trigger if exists organization_members_audit on public.organization_members;
create trigger organization_members_audit after insert or update or delete on public.organization_members for each row execute function public.audit_row_change('member','email');

drop trigger if exists organization_invitations_audit on public.organization_invitations;
create trigger organization_invitations_audit after insert or update or delete on public.organization_invitations for each row execute function public.audit_row_change('invitation','email');

drop trigger if exists clients_audit on public.clients;
create trigger clients_audit after insert or update or delete on public.clients for each row execute function public.audit_row_change('client','name');

drop trigger if exists projects_audit on public.projects;
create trigger projects_audit after insert or update or delete on public.projects for each row execute function public.audit_row_change('project','name');

drop trigger if exists tasks_audit on public.tasks;
create trigger tasks_audit after insert or update or delete on public.tasks for each row execute function public.audit_row_change('task','title');

drop trigger if exists tickets_audit on public.tickets;
create trigger tickets_audit after insert or update or delete on public.tickets for each row execute function public.audit_row_change('ticket','title');

drop trigger if exists notes_audit on public.notes;
create trigger notes_audit after insert or update or delete on public.notes for each row execute function public.audit_row_change('note','title');

drop trigger if exists company_settings_audit on public.company_settings;
create trigger company_settings_audit after insert or update or delete on public.company_settings for each row execute function public.audit_row_change('company_settings','company_name');

drop trigger if exists quotes_audit on public.quotes;
create trigger quotes_audit after insert or update or delete on public.quotes for each row execute function public.audit_row_change('quote','number');

drop trigger if exists invoices_audit on public.invoices;
create trigger invoices_audit after insert or update or delete on public.invoices for each row execute function public.audit_row_change('invoice','number');

drop trigger if exists attachments_audit on public.attachments;
create trigger attachments_audit after insert or update or delete on public.attachments for each row execute function public.audit_row_change('attachment','name');

do $$
begin
  if to_regclass('public.calendar_connections') is not null then
    drop trigger if exists calendar_connections_audit on public.calendar_connections;
    create trigger calendar_connections_audit after insert or update or delete on public.calendar_connections for each row execute function public.audit_row_change('calendar_connection','provider_account_email');
  end if;
  if to_regclass('public.calendar_sources') is not null then
    drop trigger if exists calendar_sources_audit on public.calendar_sources;
    create trigger calendar_sources_audit after insert or update or delete on public.calendar_sources for each row execute function public.audit_row_change('calendar_source','name');
  end if;
end;
$$;
