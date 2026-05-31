
-- ============================================================
-- Calendar integrations: per-user Google Calendar & Microsoft Graph
-- ============================================================

create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft')),
  provider_account_id text not null,
  provider_account_email text,
  display_name text,
  status text not null default 'active' check (status in ('active','expired','revoked','error')),
  scopes text[] not null default '{}',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, provider_account_id)
);

create table public.calendar_connection_tokens (
  connection_id uuid primary key references public.calendar_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft')),
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  token_type text,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.calendar_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.calendar_connections(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft')),
  provider_calendar_id text not null,
  name text not null,
  description text,
  color text,
  timezone text,
  is_primary boolean not null default false,
  access_role text,
  sync_enabled boolean not null default true,
  write_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, provider_calendar_id)
);

create index idx_calendar_connections_user on public.calendar_connections(user_id, provider);
create index idx_calendar_connection_tokens_user on public.calendar_connection_tokens(user_id, provider);
create index idx_calendar_sources_user on public.calendar_sources(user_id, sync_enabled);
create index idx_calendar_sources_connection on public.calendar_sources(connection_id);

create or replace function public.enforce_calendar_tokens_integrity()
returns trigger
language plpgsql
as $$
declare
  v_connection public.calendar_connections;
begin
  select * into v_connection
  from public.calendar_connections
  where id = new.connection_id;

  if not found then
    raise exception 'calendar_connection_tokens.connection_id verwijst naar een niet-bestaande koppeling'
      using errcode = '23514';
  end if;

  if v_connection.user_id <> new.user_id then
    raise exception 'calendar_connection_tokens.user_id wijkt af van de gekoppelde calendar_connection tenant'
      using errcode = '23514';
  end if;

  if v_connection.provider <> new.provider then
    raise exception 'calendar_connection_tokens.provider wijkt af van de gekoppelde calendar_connection provider'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function public.enforce_calendar_sources_integrity()
returns trigger
language plpgsql
as $$
declare
  v_connection public.calendar_connections;
begin
  select * into v_connection
  from public.calendar_connections
  where id = new.connection_id;

  if not found then
    raise exception 'calendar_sources.connection_id verwijst naar een niet-bestaande koppeling'
      using errcode = '23514';
  end if;

  if v_connection.user_id <> new.user_id then
    raise exception 'calendar_sources.user_id wijkt af van de gekoppelde calendar_connection tenant'
      using errcode = '23514';
  end if;

  if v_connection.provider <> new.provider then
    raise exception 'calendar_sources.provider wijkt af van de gekoppelde calendar_connection provider'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger calendar_connections_updated before update on public.calendar_connections for each row execute function public.set_updated_at();
create trigger calendar_connection_tokens_updated before update on public.calendar_connection_tokens for each row execute function public.set_updated_at();
create trigger calendar_sources_updated before update on public.calendar_sources for each row execute function public.set_updated_at();

create trigger calendar_connection_tokens_integrity
before insert or update of connection_id, user_id, provider on public.calendar_connection_tokens
for each row execute function public.enforce_calendar_tokens_integrity();

create trigger calendar_sources_integrity
before insert or update of connection_id, user_id, provider on public.calendar_sources
for each row execute function public.enforce_calendar_sources_integrity();

alter table public.calendar_connections enable row level security;
alter table public.calendar_connection_tokens enable row level security;
alter table public.calendar_sources enable row level security;

create policy "own calendar connections read" on public.calendar_connections
for select using (auth.uid() = user_id);

create policy "own calendar sources read" on public.calendar_sources
for select using (auth.uid() = user_id);

-- Deliberately no RLS policies on calendar_connection_tokens.
-- Tokens are only accessible through Supabase Edge Functions with the service role key.
