-- ============================================================
-- ResoFly — Eigen-domein e-mail (fase 1, onderdeel B): klant-mail loggen
-- Date: 2026-06-18
--
-- Context:
-- Onderdeel A liet organisaties hun eigen verzenddomein koppelen. Onderdeel B
-- voegt vrije klant-mail toe: een gebruiker stelt een e-mail op, die wordt vanaf
-- het geverifieerde domein verstuurd én gelogd onder de klant ("Communicatie").
--
-- Het datamodel is meteen tweerichtings-klaar: `direction` onderscheidt
-- outbound/inbound, zodat fase C (antwoorden opvangen) alleen inbound-rijen hoeft
-- toe te voegen zonder schemawijziging. De statuskolommen spiegelen
-- quote_email_deliveries zodat de bestaande resend-webhook de lifecycle kan
-- bijwerken.
--
-- Schrijven loopt uitsluitend via de `mail`/`resend-webhook` Edge Functions
-- (service role). De client leest alleen (RLS: can_read_org).
-- ============================================================

create extension if not exists pgcrypto;

begin;

-- Een thread bundelt een conversatie met één klant.
create table if not exists public.client_email_threads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  subject text not null default '',
  last_message_at timestamptz not null default now(),
  last_direction text not null default 'outbound'
    check (last_direction in ('outbound','inbound')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Eén rij per bericht (uitgaand of, vanaf fase C, inkomend).
create table if not exists public.client_emails (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  thread_id uuid not null references public.client_email_threads(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  direction text not null check (direction in ('outbound','inbound')),
  provider text not null default 'resend',
  provider_email_id text,
  from_email text not null,
  from_name text,
  to_email text not null,
  subject text not null default '',
  body_html text,
  body_text text,
  status text not null default 'queued'
    check (status in ('queued','sent','delivered','opened','clicked','bounced','failed','complained','received')),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  bounced_at timestamptz,
  failed_at timestamptz,
  complained_at timestamptz,
  received_at timestamptz,
  last_event_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Lifecycle-events vanuit de Resend-webhook (sent/delivered/opened/bounced/…).
create table if not exists public.client_email_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_email_id uuid references public.client_emails(id) on delete set null,
  thread_id uuid references public.client_email_threads(id) on delete set null,
  provider text not null default 'resend',
  provider_event_id text not null,
  provider_email_id text,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create index if not exists idx_client_email_threads_client
  on public.client_email_threads(organization_id, client_id, last_message_at desc);
create index if not exists idx_client_emails_thread
  on public.client_emails(organization_id, thread_id, created_at);
create index if not exists idx_client_emails_client
  on public.client_emails(organization_id, client_id, created_at desc);
create index if not exists idx_client_emails_provider_email
  on public.client_emails(provider, provider_email_id) where provider_email_id is not null;
create index if not exists idx_client_email_events_provider_email
  on public.client_email_events(provider, provider_email_id, occurred_at desc);

drop trigger if exists client_email_threads_updated on public.client_email_threads;
create trigger client_email_threads_updated
before update on public.client_email_threads
for each row execute function public.set_updated_at();

drop trigger if exists client_emails_updated on public.client_emails;
create trigger client_emails_updated
before update on public.client_emails
for each row execute function public.set_updated_at();

alter table public.client_email_threads enable row level security;
alter table public.client_emails enable row level security;
alter table public.client_email_events enable row level security;

-- Alleen-lezen voor leden; schrijven via Edge Functions (service role).
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='client_email_threads' and policyname='client email threads read') then
    create policy "client email threads read" on public.client_email_threads for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='client_emails' and policyname='client emails read') then
    create policy "client emails read" on public.client_emails for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='client_email_events' and policyname='client email events read') then
    create policy "client email events read" on public.client_email_events for select using (public.can_read_org(organization_id));
  end if;
end $$;

commit;
