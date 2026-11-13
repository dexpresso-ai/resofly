-- ============================================================
-- ResoFly — Een ResoFly-agenda delen met mensen buiten ResoFly
-- Date: 2026-11-13
--
-- Een deellink is een geheim adres op de agendaserver (workers/caldav):
-- https://caldav-staging.resofly.com/feed/<token>.ics. Wie hem heeft, zet hem
-- in Google Agenda, Outlook of Apple Agenda en ziet de agenda daar mee, alleen
-- lezen. De eigenaar kiest per link wat er te zien is: alleen "Bezet", of ook
-- titel en plaats. Omschrijving, genodigden en vergaderlinks gaan nooit mee.
--
-- Waarom een eigen tabel en geen kolom op calendar_sources: één agenda kan
-- meerdere links hebben (partner, assistent, een klant), elk met een eigen
-- niveau, en elke link moet los in te trekken zijn.
--
-- Beveiliging, zoals calendar_app_passwords:
-- - We bewaren alleen de SHA-256 van het token. Het token zelf (256 bits
--   toeval) ziet de maker één keer.
-- - RLS aan en geen policies: alleen de edge function calendar-integrations
--   (beheer) en de agendaserver (lezen) komen erbij, met de service-role.
-- - calendar_feed_lookup() geeft niets terug zodra de link is ingetrokken, de
--   maker geen actief lid meer is of de Agenda niet meer mag zien, of de agenda
--   niet meer van hem is. Een vertrokken teamlid deelt dus niets meer, ook als
--   iemand zijn link nog heeft.
-- - Alleen een eigen ResoFly-agenda (provider 'native'). Een Google- of
--   Outlook-agenda deel je in Google of Outlook zelf; die afspraken staan hier
--   niet.
--
-- Verder: "caldav-staging" komt op de lijst met gereserveerde klantnamen. Dat
-- adres is van de agendaserver van staging (workers/caldav/wrangler.toml).
--
-- Veilig om opnieuw te draaien.
-- ============================================================

begin;

-- ── 1. De tabel ─────────────────────────────────────────────────────────────

create table if not exists public.calendar_feed_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null references public.calendar_sources(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null default 'Deellink' check (length(label) between 1 and 80),
  detail text not null default 'busy' check (detail in ('busy', 'details')),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists calendar_feed_links_token_hash on public.calendar_feed_links(token_hash);
create index if not exists idx_calendar_feed_links_source
  on public.calendar_feed_links(source_id) where revoked_at is null;
create index if not exists idx_calendar_feed_links_owner
  on public.calendar_feed_links(user_id, organization_id) where revoked_at is null;

drop trigger if exists calendar_feed_links_prevent_org_change on public.calendar_feed_links;
create trigger calendar_feed_links_prevent_org_change
  before update of organization_id on public.calendar_feed_links
  for each row execute function public.prevent_organization_id_change();

-- Een link hoort bij een eigen ResoFly-agenda van de maker, in dezelfde
-- organisatie. De edge function controleert dat ook; dit is de grendel als
-- iemand later een andere weg bouwt.
create or replace function public.enforce_calendar_feed_link_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.calendar_sources s
    where s.id = new.source_id
      and s.organization_id = new.organization_id
      and s.user_id = new.user_id
      and s.provider = 'native'
  ) then
    raise exception 'Een deellink hoort bij een eigen ResoFly-agenda in dezelfde organisatie' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_calendar_feed_link_source() from public, anon, authenticated;

drop trigger if exists calendar_feed_links_source on public.calendar_feed_links;
create trigger calendar_feed_links_source
  before insert or update of source_id, organization_id, user_id on public.calendar_feed_links
  for each row execute function public.enforce_calendar_feed_link_source();

alter table public.calendar_feed_links enable row level security;
-- Geen policies, en ook geen tabelrechten voor de app: het token_hash is een sleutel.
revoke all on public.calendar_feed_links from anon, authenticated;
-- Toch achter de module Agenda, zoals elke organisatietabel (regel 3 in
-- CLAUDE.md): geeft iemand de app later wel rechten, dan geldt de module meteen.
do $$ begin perform public.apply_module_gate('calendar_feed_links', 'calendar', 'write'); end $$;

-- ── 2. De agendaserver zoekt een link op ────────────────────────────────────

create or replace function public.calendar_feed_lookup(p_token_hash text)
returns table (
  id uuid,
  organization_id uuid,
  source_id uuid,
  user_id uuid,
  detail text,
  source_name text,
  last_used_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.organization_id, l.source_id, l.user_id, l.detail, s.name, l.last_used_at
  from public.calendar_feed_links l
  join public.calendar_sources s
    on s.id = l.source_id
   and s.organization_id = l.organization_id
   and s.user_id = l.user_id
   and s.provider = 'native'
  join public.organization_members m
    on m.organization_id = l.organization_id
   and m.user_id = l.user_id
   and m.status = 'active'
  where coalesce(p_token_hash, '') ~ '^[0-9a-f]{64}$'
    and l.token_hash = p_token_hash
    and l.revoked_at is null
    and public.member_module_level(m.role, m.module_access, 'calendar') <> 'none';
$$;

revoke all on function public.calendar_feed_lookup(text) from public, anon, authenticated;
grant execute on function public.calendar_feed_lookup(text) to service_role;

-- ── 3. Wie vertrekt, deelt niets meer ───────────────────────────────────────
-- De lookup weigert al zodra iemand geen actief lid is. Dit maakt het blijvend:
-- weer actief worden geeft de oude links niet terug, net als bij de
-- app-wachtwoorden (20260926000000).

create or replace function public.revoke_calendar_feed_links_on_member_exit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    update public.calendar_feed_links
       set revoked_at = now()
     where user_id = old.user_id
       and organization_id = old.organization_id
       and revoked_at is null;
    return old;
  end if;
  if old.status = 'active' and new.status is distinct from 'active' then
    update public.calendar_feed_links
       set revoked_at = now()
     where user_id = new.user_id
       and organization_id = new.organization_id
       and revoked_at is null;
  end if;
  return new;
end;
$$;

revoke all on function public.revoke_calendar_feed_links_on_member_exit() from public, anon, authenticated;

drop trigger if exists organization_members_revoke_calendar_feed_links on public.organization_members;
create trigger organization_members_revoke_calendar_feed_links
  after update of status or delete on public.organization_members
  for each row execute function public.revoke_calendar_feed_links_on_member_exit();

-- ── 4. "caldav-staging" is geen klantnaam ───────────────────────────────────
-- Gelijk aan 20261111150500, met 'caldav-staging' erbij. "caldav" stond er al.
-- Op staging had niemand de naam (gecontroleerd op 13 november).

create or replace function public.client_subdomain_problem(p_name text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := coalesce(p_name, '');
begin
  if length(v) < 3 then return 'te_kort'; end if;
  if length(v) > 40 then return 'te_lang'; end if;
  if v !~ '^[a-z0-9-]+$' then return 'tekens'; end if;
  if left(v, 1) = '-' or right(v, 1) = '-' or position('--' in v) > 0 then return 'streepje'; end if;
  if v ~ '^[0-9-]+$' then return 'alleen_cijfers'; end if;
  if v = any (array[
    'www', 'app', 'apps', 'api', 'admin', 'beheer', 'beheerder', 'staging', 'test', 'tests', 'demo', 'dev', 'develop',
    'development', 'prod', 'production', 'preview', 'beta', 'alpha', 'sandbox', 'localhost', 'mail', 'email', 'e-mail',
    'smtp', 'imap', 'pop', 'pop3', 'mx', 'ns', 'ns1', 'ns2', 'ns3', 'dns', 'ftp', 'sftp', 'ssh', 'vpn', 'webmail', 'send',
    'bounce', 'reply', 'antwoord', 'inbound', 'caldav', 'caldav-staging', 'carddav', 'media', 'cdn', 'static', 'assets', 'img', 'images',
    'files', 'download', 'downloads', 'upload', 'uploads', 'status', 'docs', 'help', 'support', 'hulp', 'blog', 'login',
    'inloggen', 'logout', 'auth', 'sso', 'oauth', 'account', 'accounts', 'register', 'signup', 'aanmelden', 'billing',
    'betalen', 'pay', 'payment', 'payments', 'factuur', 'facturen', 'invoice', 'invoices', 'offerte', 'offertes', 'quote',
    'portal', 'portaal', 'klant', 'klanten', 'klantportaal', 'domein', 'domeinen', 'dashboard', 'werkruimte', 'workspace',
    'gerrie', 'mcp', 'mcp-staging', 'office', 'collabora', 'wopi', 'voorbeeld', 'example', 'root', 'system', 'systeem',
    'security', 'abuse', 'postmaster', 'hostmaster', 'webmaster', 'noreply', 'no-reply', 'info', 'contact', 'privacy',
    'terms', 'legal', 'ing', 'sns', 'asn', 'regiobank', 'bunq', 'knab', 'triodos', 'mollie', 'ideal', 'stripe', 'adyen',
    'klarna', 'kvk', 'mijnoverheid', 'overheid', 'politie', 'postnl', 'dhl', 'microsoft', 'google', 'apple', 'outlook',
    'office365', 'gmail', 'icloud', 'whatsapp', 'facebook', 'instagram', 'zendflix'
  ]) then
    return 'gereserveerd';
  end if;
  if v ~ '(resofly|brandcore|rabobank|abnamro|abn-amro|belastingdienst|digid|paypal)' then
    return 'gereserveerd';
  end if;
  return null;
end;
$$;

revoke all on function public.client_subdomain_problem(text) from public, anon;
grant execute on function public.client_subdomain_problem(text) to authenticated, service_role;

commit;
