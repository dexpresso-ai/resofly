-- ============================================================
-- Rapportages van Gerrie: persoonlijke, dynamische rapportagepagina's.
--
-- Een gebruiker vraagt in de chat op de pagina Rapportages om een overzicht
-- ("omzet per maand tegen vorig jaar", "uren per project dit kwartaal"). Gerrie
-- haalt de gegevens op, schrijft er een HTML-pagina bij en legt vast WELKE
-- gegevens die pagina nodig heeft (de datasets). Bij elke keer openen haalt de
-- app die datasets opnieuw op, met de rechten van de gebruiker en zonder AI:
-- verversen kost dus geen AI-tegoed, aanpassen via de chat wel.
--
-- Waarom drie eigen tabellen en niet ai_conversations/ai_messages:
--  - een rapportage is van één persoon. De gesprekken van Gerrie zijn leesbaar
--    voor owners en admins (toezicht, 20260623000005); een rapportage en het
--    gesprek erover niet. Ook een beheerder ziet andermans rapportages niet;
--  - de pagina hoort bij Statistieken: wie die module niet kan lezen, krijgt
--    niets terug (module gate 'stats');
--  - verwijderen ruimt de versies en de chat mee op (cascade), terwijl het
--    verbruik in ai_usage blijft staan: tegoed komt niet terug door te wissen.
--
-- Wie schrijft wat:
--  - de edge function (service-role) maakt de rapportage aan en zet de inhoud
--    die Gerrie oplevert, met organization_id uit de sessie en created_by = de
--    ingelogde gebruiker. De datasets worden bij ELKE keer draaien opnieuw
--    gecontroleerd (alleen lees-endpoints, met de rechten van die gebruiker);
--    de opgeslagen lijst is dus nooit een sleutel tot meer;
--  - de gebruiker zelf (RLS) mag zijn rapportage hernoemen, een oude versie
--    terugzetten en verwijderen. Meer niet: alleen die kolommen zijn te wijzigen.
--
-- Versies: elke wijziging van de HTML of de datasets wordt een nieuwe versie
-- (trigger), ook een teruggezette. Zo kan de gebruiker een aanpassing van
-- Gerrie altijd terugdraaien. We bewaren de laatste vijftig per rapportage.
-- ============================================================

begin;

create table if not exists public.ai_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default 'Nieuwe rapportage',
  summary text,
  html text not null default '',
  datasets jsonb not null default '[]'::jsonb,
  version integer not null default 0,
  -- De vraag die tot de huidige inhoud leidde; de versie-trigger neemt hem over.
  last_request text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_reports_title_length check (char_length(title) between 1 and 120),
  constraint ai_reports_summary_length check (summary is null or char_length(summary) <= 600),
  constraint ai_reports_html_size check (octet_length(html) <= 250000),
  constraint ai_reports_datasets_shape check (jsonb_typeof(datasets) = 'array' and jsonb_array_length(datasets) <= 12),
  constraint ai_reports_request_length check (last_request is null or char_length(last_request) <= 4000),
  constraint ai_reports_version_positive check (version >= 0)
);

create index if not exists idx_ai_reports_owner
  on public.ai_reports(organization_id, created_by, updated_at desc);

create table if not exists public.ai_report_versions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.ai_reports(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  version integer not null,
  title text not null,
  summary text,
  html text not null,
  datasets jsonb not null default '[]'::jsonb,
  request text,
  created_at timestamptz not null default now(),
  constraint ai_report_versions_unique unique (report_id, version),
  constraint ai_report_versions_html_size check (octet_length(html) <= 250000),
  constraint ai_report_versions_datasets_shape check (jsonb_typeof(datasets) = 'array'),
  constraint ai_report_versions_request_length check (request is null or char_length(request) <= 4000)
);

create index if not exists idx_ai_report_versions_report
  on public.ai_report_versions(report_id, version desc);

create table if not exists public.ai_report_messages (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.ai_reports(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  -- De versie die dit antwoord opleverde (null: Gerrie stelde een vraag of het mislukte).
  version integer,
  -- Wat deze beurt kostte als deel van het maandtegoed (0..1). Bewust geen
  -- eurobedrag: de browser krijgt nooit bedragen van het AI-verbruik te zien.
  usage_fraction numeric(9, 6),
  created_at timestamptz not null default now(),
  constraint ai_report_messages_content_length check (char_length(content) <= 20000)
);

create index if not exists idx_ai_report_messages_report
  on public.ai_report_messages(report_id, created_at);

-- ── Versies en verversdatum ──────────────────────────────────────────────────
-- Vóór de wijziging: het versienummer volgt uit de oude rij, niet uit wat de
-- schrijver meestuurt. Een titel hernoemen is geen nieuwe versie; andere HTML of
-- andere datasets wel.
create or replace function public.ai_reports_before_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.version := case when coalesce(new.html, '') = '' then 0 else 1 end;
    new.created_at := coalesce(new.created_at, now());
    new.updated_at := now();
    return new;
  end if;
  new.organization_id := old.organization_id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if new.html is distinct from old.html or new.datasets is distinct from old.datasets then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.ai_reports_before_write() from public, anon, authenticated;

-- Na de wijziging: de nieuwe versie bewaren. SECURITY DEFINER omdat niemand
-- (ook de eigenaar niet) zelf versies mag schrijven; ze ontstaan alleen hier.
create or replace function public.ai_reports_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.version > 0 and (tg_op = 'INSERT' or new.version <> old.version) then
    insert into public.ai_report_versions (report_id, organization_id, created_by, version, title, summary, html, datasets, request)
    values (new.id, new.organization_id, new.created_by, new.version, new.title, new.summary, new.html, new.datasets, new.last_request)
    on conflict (report_id, version) do nothing;
    delete from public.ai_report_versions
     where report_id = new.id and version <= new.version - 50;
  end if;
  return null;
end;
$$;

revoke all on function public.ai_reports_snapshot() from public, anon, authenticated;

drop trigger if exists ai_reports_before_write on public.ai_reports;
create trigger ai_reports_before_write
  before insert or update on public.ai_reports
  for each row execute function public.ai_reports_before_write();

drop trigger if exists ai_reports_snapshot on public.ai_reports;
create trigger ai_reports_snapshot
  after insert or update on public.ai_reports
  for each row execute function public.ai_reports_snapshot();

-- ── Rechten ─────────────────────────────────────────────────────────────────
alter table public.ai_reports enable row level security;
alter table public.ai_report_versions enable row level security;
alter table public.ai_report_messages enable row level security;

revoke all on table public.ai_reports from public, anon, authenticated;
revoke all on table public.ai_report_versions from public, anon, authenticated;
revoke all on table public.ai_report_messages from public, anon, authenticated;

-- De eigenaar leest alles van zijn rapportage, wijzigt alleen naam, inhoud en
-- de vraag erbij (een versie terugzetten), en mag hem verwijderen. Aanmaken,
-- versies en chatberichten zijn van de edge function.
grant select, delete on table public.ai_reports to authenticated;
grant update (title, summary, html, datasets, last_request) on table public.ai_reports to authenticated;
grant select on table public.ai_report_versions to authenticated;
grant select on table public.ai_report_messages to authenticated;
grant all on table public.ai_reports to service_role;
grant all on table public.ai_report_versions to service_role;
grant all on table public.ai_report_messages to service_role;

drop policy if exists "ai_reports own read" on public.ai_reports;
create policy "ai_reports own read" on public.ai_reports for select to authenticated using (
  created_by = auth.uid() and public.can_read_org(organization_id)
);

drop policy if exists "ai_reports own update" on public.ai_reports;
create policy "ai_reports own update" on public.ai_reports for update to authenticated using (
  created_by = auth.uid() and public.can_read_org(organization_id)
) with check (
  created_by = auth.uid() and public.can_read_org(organization_id)
);

drop policy if exists "ai_reports own delete" on public.ai_reports;
create policy "ai_reports own delete" on public.ai_reports for delete to authenticated using (
  created_by = auth.uid() and public.can_read_org(organization_id)
);

drop policy if exists "ai_report_versions own read" on public.ai_report_versions;
create policy "ai_report_versions own read" on public.ai_report_versions for select to authenticated using (
  created_by = auth.uid() and public.can_read_org(organization_id)
);

drop policy if exists "ai_report_messages own read" on public.ai_report_messages;
create policy "ai_report_messages own read" on public.ai_report_messages for select to authenticated using (
  created_by = auth.uid() and public.can_read_org(organization_id)
);

-- De module Statistieken geldt ook hier. Schrijfniveau 'read': het is je eigen
-- pagina, dus wie Statistieken kan lezen mag zijn eigen rapportage hernoemen of
-- weggooien, net als bij zijn eigen MCP-koppelingen (mcp_grants).
select public.apply_module_gate('ai_reports', 'stats', 'read');
select public.apply_module_gate('ai_report_versions', 'stats', 'read');
select public.apply_module_gate('ai_report_messages', 'stats', 'read');

commit;
