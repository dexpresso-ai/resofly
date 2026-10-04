-- ============================================================
-- ResoFly — Klantportaal: e-mailmeldingen, eigen instellingen, leesstatus
-- en berichten
-- Date: 2026-10-04
--
-- WAAROM
-- Een klant die in het portaal een ticket indiende, hoorde daarna niets meer
-- tot er zelf weer gekeken werd. Er komt nu een e-mail als er een ticket voor
-- de klant is aangemaakt, als de status verandert en als er een antwoord op
-- staat — en de klant zet dat zelf aan of uit, per soort melding, in de eigen
-- instellingen in het portaal. Daarnaast staan de mailgesprekken met de
-- leverancier netjes in het portaal, en kan de klant daar ook antwoorden.
--
-- ONDERDELEN
--  1. organization_portal_settings — één schakelaar per organisatie: mailt
--     ResoFly klanten over hun tickets? Standaard aan; een owner/admin zet het
--     voor de hele organisatie uit.
--  2. portal_contact_settings — de eigen keuzes van één portaalgebruiker
--     (e-mailadres) binnen één klantdossier. Geen rij = de standaard: alles
--     aan; het hoofdadres van de klant over álle tickets, een contactpersoon
--     alleen over de zelf ingediende tickets (zie _shared/portalNotify.ts).
--  3. portal_reads — wat een portaalgebruiker al gezien heeft (ticket of
--     mailgesprek), voor de stip "nieuw antwoord" in het portaal.
--  4. portal_ticket_activity — wat er voor de klant zichtbaar met een ticket
--     gebeurde (aangemaakt, status gewijzigd, zichtbaar antwoord). Tegelijk de
--     wachtrij voor de e-mailmelding: de edge function `portal-notify` claimt
--     elke minuut wat er klaarstaat, bundelt per ticket en mailt. Drie triggers
--     vullen hem, dus het maakt niet uit of de wijziging uit de app, de API,
--     Gerrie of het portaal komt.
--  5. Twee service-role-functies die het portaal licht houden: een overzicht
--     per ticket en een overzicht van de mailberichten van één klant, allebei
--     met een afgekapte preview in plaats van volledige mailteksten.
--  6. De openbare API: een wijziging met een sleutel zonder `execute_high`
--     (bv. een ticketstatus) staat wel in het portaal, maar mailt de klant
--     niet. api_rest_write zet daarvoor een markering voor de transactie.
--
-- BEVEILIGING
-- - Een klant is geen organisatielid: alles wat het portaal leest of schrijft
--   loopt via de service-role `client-portal`, die de toegang afleidt uit het
--   geverifieerde e-mailadres. Tabellen 2-4 hebben RLS aan en GEEN policies.
-- - De triggers draaien in een eigen exception-blok: een fout in het
--   vastleggen mag het ticket of de notitie zelf nooit tegenhouden.
-- - Interne notities komen nooit in de activiteit, en de meldingsdienst
--   controleert vlak voor het versturen opnieuw of een antwoord nog bestaat
--   en nog zichtbaar is.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Schakelaar per organisatie
-- ------------------------------------------------------------
create table if not exists public.organization_portal_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  ticket_emails_enabled boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.organization_portal_settings is
  'Instellingen van het klantportaal per organisatie. Geen rij = standaard (klanten krijgen e-mailmeldingen over hun tickets).';

drop trigger if exists organization_portal_settings_updated on public.organization_portal_settings;
create trigger organization_portal_settings_updated
  before update on public.organization_portal_settings
  for each row execute function public.set_updated_at();

alter table public.organization_portal_settings enable row level security;

-- Lezen mag elk lid (het tijdlijnvak laat zien of de klant gemaild wordt);
-- wijzigen alleen owners/admins, net als de e-mailteksten.
drop policy if exists "organization portal settings read" on public.organization_portal_settings;
create policy "organization portal settings read" on public.organization_portal_settings
  for select using (public.can_read_org(organization_id));
drop policy if exists "organization portal settings insert" on public.organization_portal_settings;
create policy "organization portal settings insert" on public.organization_portal_settings
  for insert with check (public.can_admin_org(organization_id));
drop policy if exists "organization portal settings update" on public.organization_portal_settings;
create policy "organization portal settings update" on public.organization_portal_settings
  for update using (public.can_admin_org(organization_id)) with check (public.can_admin_org(organization_id));

-- ------------------------------------------------------------
-- 2. Eigen meldingskeuzes van een portaalgebruiker, per klantdossier
-- ------------------------------------------------------------
create table if not exists public.portal_contact_settings (
  client_id uuid not null references public.clients(id) on delete cascade,
  -- Genormaliseerd (normalize_client_lookup_value), zoals het portaal de
  -- toegang afleidt. Wijzigt het adres van de klant, dan is dit een ander
  -- mens: de oude keuzes gelden dan niet meer.
  email text not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  notify_ticket_created boolean not null default true,
  notify_ticket_status boolean not null default true,
  notify_ticket_reply boolean not null default true,
  -- 'all' = alle tickets van deze klant; 'own' = alleen de zelf ingediende tickets.
  notify_scope text not null default 'all' check (notify_scope in ('all', 'own')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (client_id, email),
  constraint portal_contact_settings_email_check check (email = lower(btrim(email)) and email <> '')
);

create index if not exists idx_portal_contact_settings_org
  on public.portal_contact_settings(organization_id, client_id);

drop trigger if exists portal_contact_settings_updated on public.portal_contact_settings;
create trigger portal_contact_settings_updated
  before update on public.portal_contact_settings
  for each row execute function public.set_updated_at();

alter table public.portal_contact_settings enable row level security;

-- ------------------------------------------------------------
-- 3. Gezien in het portaal (stip "nieuw antwoord")
-- ------------------------------------------------------------
create table if not exists public.portal_reads (
  item_kind text not null check (item_kind in ('ticket', 'thread')),
  item_id uuid not null,
  email text not null,
  client_id uuid not null references public.clients(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (item_kind, item_id, email)
);

create index if not exists idx_portal_reads_client_email
  on public.portal_reads(client_id, email);

alter table public.portal_reads enable row level security;

-- ------------------------------------------------------------
-- 4. Ticketactiviteit voor de klant (= wachtrij voor de e-mailmelding)
-- ------------------------------------------------------------
create table if not exists public.portal_ticket_activity (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  -- De klant op het moment van de gebeurtenis. Verhuist het ticket naar een
  -- andere klant, dan krijgt die een eigen 'created'.
  client_id uuid references public.clients(id) on delete set null,
  kind text not null check (kind in ('created', 'status', 'reply')),
  note_id uuid references public.ticket_notes(id) on delete set null,
  old_status text,
  new_status text,
  -- Wie het deed: een teamlid, de klant (via het portaal) of het systeem
  -- (service-role zonder gebruiker). Wie iets zelf deed, krijgt er geen mail
  -- over — behalve de bevestiging van een zelf ingediend ticket.
  actor_type text not null default 'staff' check (actor_type in ('staff', 'client', 'system')),
  actor_user_id uuid,
  actor_contact_id uuid,
  actor_email text,
  -- De e-mailmelding.
  notify_status text not null default 'queued'
    check (notify_status in ('queued', 'sending', 'done', 'skipped', 'dead')),
  attempts integer not null default 0,
  last_error text,
  -- Adressen die deze gebeurtenis al in een mail kregen. Een nieuwe poging
  -- (na een mislukte verzending aan een ander) slaat hen over.
  notified_emails text[] not null default '{}'::text[],
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.portal_ticket_activity is
  'Voor de klant zichtbare ticketactiviteit (aangemaakt, status, zichtbaar antwoord). Wachtrij van portal-notify; ook de statusregels in de tickettijdlijn van het portaal.';

-- Een notitie die verborgen → zichtbaar → verborgen → zichtbaar gaat, levert
-- één melding op, niet drie (zie portal_activity_on_ticket_note).
create unique index if not exists uidx_portal_ticket_activity_reply
  on public.portal_ticket_activity(note_id)
  where kind = 'reply';

create index if not exists idx_portal_ticket_activity_ticket
  on public.portal_ticket_activity(organization_id, ticket_id, created_at);

-- Draaiende index voor de dienst: alleen werk dat nog moet.
create index if not exists idx_portal_ticket_activity_pending
  on public.portal_ticket_activity(ticket_id, created_at)
  where notify_status in ('queued', 'sending');

drop trigger if exists portal_ticket_activity_updated on public.portal_ticket_activity;
create trigger portal_ticket_activity_updated
  before update on public.portal_ticket_activity
  for each row execute function public.set_updated_at();

alter table public.portal_ticket_activity enable row level security;

-- ── Triggers ────────────────────────────────────────────────────────────────

-- Nieuw ticket voor een klant. Wie het indiende volgt hetzelfde criterium als
-- de view ticket_unread: maakte een organisatielid het aan, dan is het het
-- team; anders, met een indiener-adres of contactpersoon, de klant zelf.
create or replace function public.portal_activity_on_ticket_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text;
begin
  begin
    if new.client_id is null then return null; end if;

    if new.created_by is not null and exists (
      select 1 from public.organization_members m
       where m.organization_id = new.organization_id and m.user_id = new.created_by
    ) then
      v_actor := 'staff';
    elsif new.created_by_contact_id is not null
       or nullif(btrim(coalesce(new.created_by_email, '')), '') is not null then
      v_actor := 'client';
    else
      v_actor := 'system';
    end if;

    insert into public.portal_ticket_activity
      (organization_id, ticket_id, client_id, kind, new_status,
       actor_type, actor_user_id, actor_contact_id, actor_email)
    values
      (new.organization_id, new.id, new.client_id, 'created', new.status,
       v_actor, new.created_by,
       case when v_actor = 'client' then new.created_by_contact_id end,
       case when v_actor = 'client' then public.normalize_client_lookup_value(new.created_by_email) end);
  exception when others then
    raise warning 'portal_activity_on_ticket_insert: %', sqlerrm;
  end;
  return null;
end;
$$;

-- Statuswijziging, of een ticket dat (alsnog) aan een klant wordt gekoppeld.
-- Een klant kan in het portaal geen status wijzigen; wie dit doet is dus het
-- team (met een sessie) of het systeem (service-role, bv. de API of Gerrie).
create or replace function public.portal_activity_on_ticket_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := case when auth.uid() is not null then 'staff' else 'system' end;
begin
  begin
    if new.client_id is null then return null; end if;

    if old.client_id is distinct from new.client_id then
      -- Voor de nieuwe klant is dit een nieuw ticket; een gelijktijdige
      -- statuswijziging zit daar al in.
      insert into public.portal_ticket_activity
        (organization_id, ticket_id, client_id, kind, new_status, actor_type, actor_user_id)
      values
        (new.organization_id, new.id, new.client_id, 'created', new.status, v_actor, auth.uid());
      return null;
    end if;

    if new.status is distinct from old.status then
      insert into public.portal_ticket_activity
        (organization_id, ticket_id, client_id, kind, old_status, new_status, actor_type, actor_user_id)
      values
        (new.organization_id, new.id, new.client_id, 'status', old.status, new.status, v_actor, auth.uid());
    end if;
  exception when others then
    raise warning 'portal_activity_on_ticket_update: %', sqlerrm;
  end;
  return null;
end;
$$;

-- Een antwoord dat de klant ziet: een zichtbare notitie, of een interne die
-- zichtbaar wordt gemaakt. Een reactie van de klant zelf telt ook — die gaat
-- naar de andere portaalgebruikers van dezelfde klant, nooit naar de schrijver.
create or replace function public.portal_activity_on_ticket_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
begin
  begin
    if new.is_internal then return null; end if;
    if tg_op = 'UPDATE' and old.is_internal is not true then return null; end if;

    select t.client_id into v_client
      from public.tickets t
     where t.id = new.ticket_id and t.organization_id = new.organization_id;
    if v_client is null then return null; end if;

    insert into public.portal_ticket_activity
      (organization_id, ticket_id, client_id, kind, note_id, actor_type, actor_user_id, actor_contact_id)
    values
      (new.organization_id, new.ticket_id, v_client, 'reply', new.id,
       case when new.author_type = 'client' then 'client' else 'staff' end,
       coalesce(new.author_user_id, new.created_by),
       case when new.author_type = 'client' then new.author_client_contact_id end)
    -- Al eens zichtbaar geweest: geen tweede melding. Behalve als de eerste
    -- nooit verstuurd is (overgeslagen, bv. omdat het antwoord bij het
    -- versturen weer intern was): dan is opnieuw zichtbaar maken wél nieuws.
    -- Wie de mail toen toch al kreeg, staat in notified_emails en krijgt hem
    -- niet nog eens. De waarden komen uit de nieuwe rij, zodat
    -- portal_ticket_activity_quiet ook hier geldt.
    on conflict (note_id) where kind = 'reply' do update
       set notify_status = excluded.notify_status,
           last_error = excluded.last_error,
           processed_at = excluded.processed_at,
           attempts = 0,
           client_id = excluded.client_id,
           actor_type = excluded.actor_type,
           actor_user_id = excluded.actor_user_id,
           actor_contact_id = excluded.actor_contact_id,
           created_at = now()
     where portal_ticket_activity.notify_status = 'skipped';
  exception when others then
    raise warning 'portal_activity_on_ticket_note: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function public.portal_activity_on_ticket_insert() from public, anon, authenticated;
revoke all on function public.portal_activity_on_ticket_update() from public, anon, authenticated;
revoke all on function public.portal_activity_on_ticket_note() from public, anon, authenticated;

drop trigger if exists portal_activity_tickets_insert on public.tickets;
create trigger portal_activity_tickets_insert
  after insert on public.tickets
  for each row execute function public.portal_activity_on_ticket_insert();

drop trigger if exists portal_activity_tickets_update on public.tickets;
create trigger portal_activity_tickets_update
  after update of status, client_id on public.tickets
  for each row execute function public.portal_activity_on_ticket_update();

drop trigger if exists portal_activity_ticket_notes on public.ticket_notes;
create trigger portal_activity_ticket_notes
  after insert or update of is_internal on public.ticket_notes
  for each row execute function public.portal_activity_on_ticket_note();

-- ── Claimen door de meldingsdienst ─────────────────────────────────────────
-- Pakt alle wachtende activiteit van tickets waarvan de OUDSTE wachtende
-- gebeurtenis minstens p_min_age_seconds oud is. Zo komen een statuswijziging
-- en een antwoord die vlak na elkaar gebeuren samen in één mail, in plaats van
-- in twee. Plus rijen die langer dan 5 minuten in 'sending' hangen
-- (crashherstel). Na 5 pogingen geeft hij het op ('dead').
create or replace function public.claim_portal_ticket_activity(
  p_limit integer default 100,
  p_min_age_seconds integer default 30
)
returns setof public.portal_ticket_activity
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de meldingsdienst mag dit aanroepen.' using errcode = '42501';
  end if;

  update public.portal_ticket_activity
     set notify_status = 'dead', processed_at = now()
   where notify_status in ('queued', 'sending') and attempts >= 5;

  return query
  update public.portal_ticket_activity a
     set notify_status = 'sending', attempts = a.attempts + 1
   where a.id in (
     select c.id
       from public.portal_ticket_activity c
      where (c.notify_status = 'queued'
             and exists (
               select 1 from public.portal_ticket_activity o
                where o.ticket_id = c.ticket_id
                  and o.notify_status = 'queued'
                  and o.created_at <= now() - make_interval(secs => greatest(0, coalesce(p_min_age_seconds, 30)))))
         or (c.notify_status = 'sending' and c.updated_at < now() - interval '5 minutes')
      order by c.created_at
      for update skip locked
      limit greatest(1, least(coalesce(p_limit, 100), 500))
   )
  returning a.*;
end;
$$;

revoke all on function public.claim_portal_ticket_activity(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_portal_ticket_activity(integer, integer) to service_role;

-- ------------------------------------------------------------
-- 5. Lichte overzichten voor het portaal (service-role)
-- ------------------------------------------------------------

-- Per ticket van één klant: hoeveel zichtbare notities, wanneer en van wie de
-- laatste (met een stukje tekst), en wanneer het team voor het laatst
-- antwoordde. Interne notities tellen nergens mee.
create or replace function public.portal_ticket_overview(p_organization_id uuid, p_client_id uuid)
returns table (
  ticket_id uuid,
  note_count integer,
  last_note_at timestamptz,
  last_note_author_type text,
  last_note_author_name text,
  last_note_preview text,
  last_team_note_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select t.id,
         coalesce(s.note_count, 0)::integer,
         l.created_at,
         l.author_type,
         l.author_name,
         left(l.body, 400),
         s.last_team_note_at
    from public.tickets t
    left join lateral (
      select count(*) as note_count,
             max(n.created_at) filter (where n.author_type <> 'client') as last_team_note_at
        from public.ticket_notes n
       where n.organization_id = t.organization_id and n.ticket_id = t.id and n.is_internal = false
    ) s on true
    left join lateral (
      select n.created_at, n.author_type, n.author_name, n.body
        from public.ticket_notes n
       where n.organization_id = t.organization_id and n.ticket_id = t.id and n.is_internal = false
       order by n.created_at desc
       limit 1
    ) l on true
   where t.organization_id = p_organization_id
     and t.client_id = p_client_id;
$$;

revoke all on function public.portal_ticket_overview(uuid, uuid) from public, anon, authenticated;
grant execute on function public.portal_ticket_overview(uuid, uuid) to service_role;

-- Alle (niet-verwijderde) mailberichten van één klant, zonder de volledige
-- tekst: wie, wanneer, welke kant op, herkomst en een stukje tekst. Welke
-- daarvan de klant in het portaal ziet, beslist client-portal
-- (_shared/portalMessages.ts): alleen gesprekken met de eigen
-- portaalgebruikers van de klant, nooit campagnes of stromen.
create or replace function public.portal_client_message_overview(p_organization_id uuid, p_client_id uuid)
returns table (
  id uuid,
  thread_id uuid,
  thread_subject text,
  direction text,
  status text,
  from_email text,
  from_name text,
  to_email text,
  source text,
  preview text,
  occurred_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select e.id,
         e.thread_id,
         t.subject,
         e.direction,
         e.status,
         e.from_email,
         e.from_name,
         e.to_email,
         coalesce(e.metadata ->> 'source', ''),
         -- Het portaal toont hooguit 160 tekens (na het samenvouwen van witruimte).
         left(coalesce(nullif(btrim(e.body_text), ''), ''), 320),
         coalesce(e.received_at, e.sent_at, e.created_at),
         e.created_at
    from public.client_emails e
    join public.client_email_threads t
      on t.id = e.thread_id and t.organization_id = e.organization_id
   where e.organization_id = p_organization_id
     and e.client_id = p_client_id
     and e.deleted_at is null
   order by e.created_at desc
   limit 2000;
$$;

revoke all on function public.portal_client_message_overview(uuid, uuid) from public, anon, authenticated;
grant execute on function public.portal_client_message_overview(uuid, uuid) to service_role;

comment on column public.client_emails.link_source is
  'reply_token | header_thread | client_email | client_contact | manual | portal — waarom dit bericht in dit dossier staat. portal = door de klant zelf geschreven in het klantportaal (geverifieerde login).';

-- ------------------------------------------------------------
-- 6. De openbare API: geen klantmail zonder `execute_high`
-- ------------------------------------------------------------
-- Een sleutel zonder `execute_high` mag niets "naar buiten" doen
-- (20261003030000, 20261003050000), maar wel de status van een ticket van een
-- klant wijzigen (docs/API.md: "status, prioriteit en datums wel"). Met de
-- klantmeldingen zou dat alsnog een e-mail aan de klant opleveren. Daarom:
-- api_rest_write zet zonder `execute_high` voor de rest van de transactie de
-- markering resofly.portal_notify = 'quiet', en wat er dan aan ticketactiviteit
-- ontstaat, staat meteen op 'skipped'. In het portaal staat de wijziging
-- gewoon (zoals voorheen); er gaat alleen geen mail uit.
--
-- De markering kan alleen een mail tegenhouden, nooit een veroorzaken: wie de
-- markering in een eigen transactie zet, houdt hooguit mail aan de eigen
-- klanten tegen.

create or replace function public.portal_ticket_activity_quiet()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('resofly.portal_notify', true), '') = 'quiet' then
    new.notify_status := 'skipped';
    new.last_error := 'Via de API zonder toegangsniveau execute_high: wel zichtbaar in het portaal, geen e-mail.';
    new.processed_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.portal_ticket_activity_quiet() from public, anon, authenticated;

drop trigger if exists portal_ticket_activity_quiet on public.portal_ticket_activity;
create trigger portal_ticket_activity_quiet
  before insert on public.portal_ticket_activity
  for each row execute function public.portal_ticket_activity_quiet();

-- api_rest_write zoals in 20261003050000_full_api_check.sql, met alleen de
-- markering hierboven erbij (in het blok "Wat het klantportaal raakt"). De
-- oude vijf-parameterversie (zonder portaalregels) blijft weg.
drop function if exists public.api_rest_write(uuid, uuid, text, jsonb, uuid);

create or replace function public.api_rest_write(
  p_user_id uuid,
  p_organization_id uuid,
  p_resource text,
  p_values jsonb,
  p_row_id uuid default null,
  p_allow_outward boolean default false
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_table text;
  v_server_only text[];
  v_create_only text[];
  v_keys text[];
  v_bad text[];
  v_cols text;
  v_existing jsonb;
  v_project uuid;
  v_task uuid;
  v_client uuid;
  v_task_project uuid;
  v_project_client uuid;
  v_old_portal_client uuid;
  v_new_portal_client uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_row jsonb;
begin
  -- 1. Alleen de API. Straks wisselen we naar het teamlid; deze controle hoort
  --    dus vóór die wissel.
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de API kan dit aanroepen.' using errcode = '42501';
  end if;

  v_table := case p_resource
    when 'clients'      then 'clients'
    when 'contacts'     then 'client_contacts'
    when 'projects'     then 'projects'
    when 'tasks'        then 'tasks'
    when 'tickets'      then 'tickets'
    when 'ticket_notes' then 'ticket_notes'
    when 'time_entries' then 'time_entries'
  end;
  if v_table is null then
    raise exception 'Onbekende resource "%".', p_resource using errcode = '22023';
  end if;

  -- Kolommen die de app zelf beheert, per resource — gelijk aan de velden die
  -- in apiResourceSpecs.ts alleen-lezen zijn (apiResourceSpecs.test.ts legt ze
  -- naast elkaar). Klantnummers kent de app toe, portaaltoegang geef je in de
  -- app, de schrijver van een reactie en de eigenaar van uren is het teamlid.
  v_server_only := case p_resource
    when 'clients'      then array['client_code']
    when 'contacts'     then array['gives_portal_access', 'origin']
    when 'projects'     then array['contract_id']
    when 'tasks'        then array['ticket_id', 'planned_order', 'subtasks', 'comments']
    when 'tickets'      then array['converted_to_project_id', 'created_by_contact_id', 'created_by_name', 'created_by_email']
    when 'ticket_notes' then array['author_type', 'author_user_id', 'author_name', 'author_client_contact_id']
    when 'time_entries' then array['user_id', 'source', 'calendar_event_link_id']
  end;
  -- Alleen bij aanmaken: een contactpersoon verhuist niet naar een andere klant.
  v_create_only := case p_resource
    when 'contacts' then array['client_id']
    else array[]::text[]
  end;

  -- Een reactie wijzig je in de app (zichtbaar maken voor de klant is daar een
  -- bewuste stap); via de API komt er alleen een nieuwe bij.
  if p_row_id is not null and p_resource = 'ticket_notes' then
    raise exception 'Een reactie wijzig je in de app; via de API kun je er alleen een toevoegen.' using errcode = '22023';
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    raise exception 'De invoer moet een object zijn.' using errcode = '22023';
  end if;

  select coalesce(array_agg(k order by k), array[]::text[]) into v_keys
    from jsonb_object_keys(p_values) as k;

  -- 2. Wat nooit van buiten komt: de grens van de organisatie, wie en wanneer,
  --    alles wat op een geheim lijkt, en kolommen die niet bestaan.
  select coalesce(array_agg(k order by k), array[]::text[]) into v_bad
    from unnest(v_keys) as k
   where k in ('id', 'organization_id', 'created_by', 'created_at', 'updated_at')
      or k = any(v_server_only)
      or (p_row_id is not null and k = any(v_create_only))
      or public.webhook_is_secret_column(k)
      or not exists (
        select 1 from pg_attribute a
         where a.attrelid = format('public.%I', v_table)::regclass
           and a.attname = k and a.attnum > 0 and not a.attisdropped
      );
  if cardinality(v_bad) > 0 then
    raise exception 'Deze velden kunnen niet via de API: %.', array_to_string(v_bad, ', ') using errcode = '22023';
  end if;
  if p_row_id is not null and cardinality(v_keys) = 0 then
    raise exception 'Er valt niets te wijzigen.' using errcode = '22023';
  end if;

  -- 3. Het teamlid achter de sleutel is NU actief lid van deze organisatie.
  if not exists (
    select 1 from public.organization_members m
     where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status = 'active'
  ) then
    raise exception 'Het teamlid achter deze sleutel is geen actief lid van de organisatie.' using errcode = '42501';
  end if;

  -- Bij wijzigen: de rij zoals hij nu is, in deze organisatie. Nu nog als
  -- service role gelezen, zodat "bestaat niet" (404) en "mag niet" (403) uit
  -- elkaar blijven, en de regels hieronder het verschil kunnen zien.
  if p_row_id is not null then
    execute format('select to_jsonb(t) from public.%I t where t.id = $1 and t.organization_id = $2', v_table)
      into v_existing using p_row_id, p_organization_id;
    if v_existing is null then
      raise exception 'Niet gevonden in deze organisatie.' using errcode = 'P0002';
    end if;
  end if;

  -- Een nieuwe reactie zonder `is_internal` is intern: de kolom zelf staat op
  -- "zichtbaar", en de regel hieronder neemt aan dat weglaten intern betekent.
  if p_row_id is null and p_resource = 'ticket_notes' then
    p_values := jsonb_build_object('is_internal', true) || p_values;
  end if;

  -- ── Wat het klantportaal raakt: alleen met `execute_high` ────────────────
  --
  -- Wie in het portaal kan, volgt uit het e-mailadres van de klant en uit
  -- contactpersonen met portaaltoegang; wat ze daar zien, uit de klant waaraan
  -- projecten (met hun taken), tickets en facturen hangen — met titel en
  -- omschrijving (client-portal: sanitizeProject/Ticket/Task). Iets daarin
  -- zetten of veranderen is net zo goed "naar buiten" als een bericht aan de klant.
  if not coalesce(p_allow_outward, false) then
    -- Klantmeldingen (20261004000000): wat zonder `execute_high` wél mag, zoals
    -- een status wijzigen, ziet de klant in het portaal, maar levert geen
    -- e-mail aan de klant op. portal_ticket_activity_quiet leest deze
    -- markering; ze geldt tot het einde van deze transactie.
    perform set_config('resofly.portal_notify', 'quiet', true);
    if p_row_id is not null and p_resource = 'clients' and p_values ? 'email'
       and lower(coalesce(p_values ->> 'email', '')) is distinct from lower(coalesce(v_existing ->> 'email', '')) then
      raise exception 'Het e-mailadres van een klant bepaalt wie in het klantportaal kan. Wijzigen via de API vraagt toegangsniveau "execute_high".'
        using errcode = 'RS403';
    end if;
    -- Een nieuwe klant met het adres van iemand die al op het portaal inlogt,
    -- verschijnt in diens portaal. (Hetzelfde adres als een andere KLANT houdt
    -- create_client_with_next_code al tegen.)
    if p_row_id is null and p_resource = 'clients' and nullif(btrim(coalesce(p_values ->> 'email', '')), '') is not null
       and exists (
         select 1 from public.client_contacts cc
          where cc.organization_id = p_organization_id and cc.gives_portal_access and cc.is_active
            and public.normalize_client_lookup_value(cc.email) = public.normalize_client_lookup_value(p_values ->> 'email')
       ) then
      raise exception 'Met dit e-mailadres logt al iemand in op het klantportaal; een nieuwe klant ermee verschijnt in diens portaal. Dat vraagt toegangsniveau "execute_high".'
        using errcode = 'RS403';
    end if;
    if p_row_id is not null and p_resource = 'contacts' and coalesce((v_existing ->> 'gives_portal_access')::boolean, false)
       and ((p_values ? 'email' and lower(coalesce(p_values ->> 'email', '')) is distinct from lower(coalesce(v_existing ->> 'email', '')))
         or (coalesce((p_values ->> 'is_active')::boolean, false) and not coalesce((v_existing ->> 'is_active')::boolean, false))) then
      raise exception 'Deze contactpersoon heeft toegang tot het klantportaal. Zijn e-mailadres wijzigen of hem weer actief maken vraagt toegangsniveau "execute_high".'
        using errcode = 'RS403';
    end if;
    if p_row_id is not null and p_resource in ('projects', 'tickets') and p_values ? 'client_id'
       and nullif(p_values ->> 'client_id', '') is distinct from nullif(v_existing ->> 'client_id', '') then
      raise exception 'Een % naar een andere klant verhuizen verandert wat die klant in het portaal ziet. Dat vraagt toegangsniveau "execute_high".',
        case p_resource when 'projects' then 'project' else 'ticket' end
        using errcode = 'RS403';
    end if;
    if p_row_id is null and p_resource in ('projects', 'tickets') and nullif(p_values ->> 'client_id', '') is not null then
      raise exception 'Een % voor een klant staat meteen in diens klantportaal. Aanmaken mét klant vraagt toegangsniveau "execute_high"; zonder klant kan het wel.',
        case p_resource when 'projects' then 'project' else 'ticket' end
        using errcode = 'RS403';
    end if;
    if p_row_id is not null and p_resource = 'tickets' and nullif(v_existing ->> 'client_id', '') is not null
       and ((p_values ? 'title' and p_values ->> 'title' is distinct from v_existing ->> 'title')
         or (p_values ? 'description' and p_values ->> 'description' is distinct from v_existing ->> 'description')) then
      raise exception 'De klant ziet dit ticket in het portaal. De titel of omschrijving wijzigen vraagt toegangsniveau "execute_high".'
        using errcode = 'RS403';
    end if;
    if p_row_id is not null and p_resource = 'projects' and nullif(v_existing ->> 'client_id', '') is not null
       and ((p_values ? 'name' and p_values ->> 'name' is distinct from v_existing ->> 'name')
         or (p_values ? 'description' and p_values ->> 'description' is distinct from v_existing ->> 'description')) then
      raise exception 'De klant ziet dit project in het portaal. De naam of omschrijving wijzigen vraagt toegangsniveau "execute_high".'
        using errcode = 'RS403';
    end if;
    if p_resource = 'tasks' then
      -- Het project van de taak vóór en ná dit verzoek, en of daar een klant aan hangt.
      select pr.client_id into v_old_portal_client from public.projects pr
       where pr.id = nullif(v_existing ->> 'project_id', '')::uuid and pr.organization_id = p_organization_id;
      select pr.client_id into v_new_portal_client from public.projects pr
       where pr.id = case when p_values ? 'project_id' then nullif(p_values ->> 'project_id', '')::uuid
                          else nullif(v_existing ->> 'project_id', '')::uuid end
         and pr.organization_id = p_organization_id;
      if (p_row_id is null and v_new_portal_client is not null)
         or (p_row_id is not null and p_values ? 'project_id'
             and nullif(p_values ->> 'project_id', '') is distinct from nullif(v_existing ->> 'project_id', '')
             and (v_old_portal_client is not null or v_new_portal_client is not null))
         or (p_row_id is not null and v_new_portal_client is not null
             and p_values ? 'title' and p_values ->> 'title' is distinct from v_existing ->> 'title') then
        raise exception 'Taken in een project met een klant staan in diens klantportaal. Zo''n taak aanmaken, verplaatsen of hernoemen vraagt toegangsniveau "execute_high".'
          using errcode = 'RS403';
      end if;
    end if;
    if p_row_id is null and p_resource = 'ticket_notes'
       and not coalesce((p_values ->> 'is_internal')::boolean, true) then
      raise exception 'Een reactie die de klant in het portaal ziet, is een bericht naar buiten. Dat vraagt toegangsniveau "execute_high"; zonder blijft hij intern.'
        using errcode = 'RS403';
    end if;
  end if;

  -- ── Per resource: wat de app er bij aanmaken of wijzigen zelf bij doet ────

  -- Een taak met een klant die niet bij zijn project hoort: de app (trigger)
  -- zou de klant stil vervangen door die van het project. Liever een fout,
  -- net als bij uren.
  if p_resource = 'tasks' and nullif(p_values ->> 'client_id', '') is not null then
    select pr.client_id into v_project_client from public.projects pr
     where pr.id = case when p_values ? 'project_id' then nullif(p_values ->> 'project_id', '')::uuid
                        else nullif(v_existing ->> 'project_id', '')::uuid end
       and pr.organization_id = p_organization_id;
    if v_project_client is not null and v_project_client <> (p_values ->> 'client_id')::uuid then
      raise exception '"client_id" hoort niet bij het project: dat is van een andere klant. Laat client_id weg; de klant volgt het project.'
        using errcode = '22023';
    end if;
    v_project_client := null;
  end if;

  -- Uren uit de agenda volgen hun afspraak (sync_time_entry_from_link); de app
  -- laat ze niet los bewerken, de API dus ook niet.
  if p_row_id is not null and p_resource = 'time_entries' and v_existing ->> 'source' = 'calendar' then
    raise exception 'Deze uren komen uit de agenda en volgen die afspraak. Wijzig de afspraak in de agenda.' using errcode = '22023';
  end if;

  if p_resource = 'time_entries' then
    -- Taak, project en klant zoals ze na deze wijziging zijn.
    v_task := case when p_values ? 'task_id' then nullif(p_values ->> 'task_id', '')::uuid else nullif(v_existing ->> 'task_id', '')::uuid end;
    v_project := case when p_values ? 'project_id' then nullif(p_values ->> 'project_id', '')::uuid else nullif(v_existing ->> 'project_id', '')::uuid end;
    v_client := case when p_values ? 'client_id' then nullif(p_values ->> 'client_id', '')::uuid else nullif(v_existing ->> 'client_id', '')::uuid end;

    -- Het project van de taak gaat voor — zo zet validate_time_entry het ook.
    -- Wie in hetzelfde verzoek een ánder project noemt, hoort dat, in plaats
    -- van een stille correctie (met het tarief van het verkeerde project).
    if v_task is not null then
      select t.project_id into v_task_project from public.tasks t
       where t.id = v_task and t.organization_id = p_organization_id;
      if p_values ? 'project_id' and v_project is distinct from v_task_project then
        raise exception '"project_id" hoort niet bij de taak: die valt onder een ander project. Laat project_id weg of kies het project van de taak.'
          using errcode = '22023';
      end if;
      v_project := v_task_project;
    end if;

    if v_project is not null and v_client is not null and (p_values ? 'client_id' or p_values ? 'project_id' or p_values ? 'task_id') then
      select pr.client_id into v_project_client from public.projects pr
       where pr.id = v_project and pr.organization_id = p_organization_id;
      if v_project_client is not null and v_project_client <> v_client then
        raise exception '"client_id" hoort niet bij het project: dat is van een andere klant. Laat client_id weg; de klant volgt het project.'
          using errcode = '22023';
      end if;
    end if;

    -- De eindtijd ligt niet vóór de begintijd — ook als maar één van de twee
    -- in dit verzoek staat.
    v_start := case when p_values ? 'started_at' then nullif(p_values ->> 'started_at', '')::timestamptz else nullif(v_existing ->> 'started_at', '')::timestamptz end;
    v_end := case when p_values ? 'ended_at' then nullif(p_values ->> 'ended_at', '')::timestamptz else nullif(v_existing ->> 'ended_at', '')::timestamptz end;
    if v_start is not null and v_end is not null and v_end < v_start then
      raise exception '"ended_at" ligt op of na "started_at".' using errcode = '22023';
    end if;
  end if;

  -- Nieuwe uren: wat de app invult als je het niet zelf kiest (TimeTracking en
  -- Gerrie): vandaag in Nederlandse tijd, declarabel tenzij het project een vaste
  -- prijs heeft of de uren indirect zijn, en het tarief van het project of
  -- anders het standaardtarief van de organisatie — als momentopname. Het
  -- project is hier dat van de taak, als er een taak is.
  if p_row_id is null and p_resource = 'time_entries' then
    if not (p_values ? 'entry_date') then
      p_values := p_values || jsonb_build_object('entry_date', (now() at time zone 'Europe/Amsterdam')::date);
    end if;
    if not (p_values ? 'billable') then
      p_values := p_values || jsonb_build_object('billable',
        coalesce(p_values ->> 'entry_type', 'direct') <> 'indirect'
        and not exists (
          select 1 from public.projects pr
           where pr.id = v_project and pr.organization_id = p_organization_id and pr.billing_type = 'fixed_price'
        ));
    end if;
    if not (p_values ? 'hourly_rate_cents') then
      p_values := p_values || jsonb_build_object('hourly_rate_cents', coalesce(
        (select pr.hourly_rate_cents from public.projects pr where pr.id = v_project and pr.organization_id = p_organization_id),
        (select cs.default_hourly_rate_cents from public.company_settings cs where cs.organization_id = p_organization_id)));
    end if;
    p_values := p_values || jsonb_build_object('user_id', p_user_id, 'source', 'manual');
  end if;

  -- Een nieuwe reactie: het ticket hoort bij deze organisatie, en de schrijver
  -- is het teamlid — met zijn e-mailadres als momentopname, net als
  -- createTicketNote in de app.
  if p_row_id is null and p_resource = 'ticket_notes' then
    if not exists (
      select 1 from public.tickets tk
       where tk.id = nullif(p_values ->> 'ticket_id', '')::uuid and tk.organization_id = p_organization_id
    ) then
      raise exception 'Ticket niet gevonden in deze organisatie.' using errcode = 'P0002';
    end if;
    p_values := p_values || jsonb_build_object(
      'author_type', 'user',
      'author_user_id', p_user_id,
      'author_name', (
        select m.email from public.organization_members m
         where m.organization_id = p_organization_id and m.user_id = p_user_id
      ));
  end if;

  -- 4. Vanaf hier: als het teamlid. Dezelfde wissel als PostgREST voor een
  --    ingelogde gebruiker; hij geldt tot het einde van deze transactie.
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- Een nieuwe klant gaat langs dezelfde weg als in de app: het klantnummer,
  -- de dubbelcontrole en de normalisatie zitten in create_client_with_next_code.
  if p_row_id is null and p_resource = 'clients' then
    select to_jsonb(c) into v_row from public.create_client_with_next_code(p_organization_id, p_values) as c;
    return v_row;
  end if;

  v_cols := (select string_agg(format('%I', k), ', ' order by k) from jsonb_object_keys(p_values) as k);

  if p_row_id is null then
    execute format(
      'insert into public.%1$I as t (organization_id, created_by%2$s) '
      || 'select $1, $2%2$s from jsonb_populate_record(null::public.%1$I, $3) '
      || 'returning to_jsonb(t.*)',
      v_table, case when v_cols is null then '' else ', ' || v_cols end)
      into v_row using p_organization_id, p_user_id, p_values;
  else
    execute format(
      'update public.%1$I as t set (%2$s, updated_at) = '
      || '(select %2$s, now() from jsonb_populate_record(null::public.%1$I, $1)) '
      || 'where t.id = $2 and t.organization_id = $3 '
      || 'returning to_jsonb(t.*)',
      v_table, v_cols)
      into v_row using p_values, p_row_id, p_organization_id;
    -- De rij bestaat (zie boven), maar RLS liet hem niet bijwerken.
    if v_row is null then
      raise exception 'Het teamlid achter deze sleutel mag dit niet wijzigen.' using errcode = '42501';
    end if;
  end if;

  return v_row;
end;
$$;

revoke all on function public.api_rest_write(uuid, uuid, text, jsonb, uuid, boolean) from public, anon, authenticated;
grant execute on function public.api_rest_write(uuid, uuid, text, jsonb, uuid, boolean) to service_role;

commit;
