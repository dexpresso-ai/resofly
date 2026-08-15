-- ============================================================
-- ResoFly — Doorstuuradres per organisatie + opvangbak voor inkomende mail
-- Date: 2026-08-15
--
-- WAAROM
-- Een gebruiker met info@fotograaf.nl zet bij zijn eigen mailprovider een
-- doorstuurregel naar <alias>@inbound.resofly.com. Mail die een klant SPONTAAN
-- naar zijn eigen adres stuurt, belandt daardoor in het juiste klantdossier.
-- Lukt matchen niet, dan komt de mail in een ZICHTBARE opvangbak in plaats van
-- stil te verdwijnen (vandaag: `return { skipped: 'no_match' }`).
--
-- ONTWERPKEUZES
-- 1. organization_id komt UITSLUITEND uit het ontvangeradres, nooit uit de
--    afzender. Dat sluit het bestaande cross-tenant-lek in resolveBySender()
--    (die over alle organisaties zoekt) en de LIKE-joker-injectie via .ilike.
-- 2. inbound_messages is TEGELIJK het onvoorwaardelijke register en de
--    opvangbak (status='unmatched'). Vastleggen en matchen zijn gescheiden
--    stappen; "weggooien" is een status op een bewaarde rij.
-- 3. Registreren + dedupliceren + matchen gebeurt in EEN transactie
--    (register_inbound_message), zodat er geen halve toestanden bestaan.
-- 4. Het alias is GEEN geheim: het staat in de Received-keten van elke
--    doorgestuurde mail. De veiligheid komt uit gevolgbeperking (geen push,
--    geen campagnetrigger, verwijderknop, herkomstlabel), niet uit
--    onraadbaarheid.
--
-- VALKUILEN DIE HIER BEWUST ZIJN AFGEVANGEN
-- - client_contacts heeft een BEFORE-trigger die zelf 23505 raist; ON CONFLICT
--   vangt een triggerfout NIET. Daarom een expliciet exception-blok.
-- - De unieke dossier-index staat op de NIEUWE kolom rfc_message_id (leeg bij
--   aanmaak), niet op provider_email_id. Zo kan de migratie niet falen op
--   bestaande duplicaten en is er geen exception-blok nodig dat de index
--   stilzwijgend overslaat.
-- - deleted_at wordt in de RLS-POLICY gefilterd, niet in de frontend-query:
--   PostgREST is een open API.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Inbound-domein (moet gelijk zijn aan de env-var MAIL_INBOUND_DOMAIN)
-- ------------------------------------------------------------
create or replace function public.inbound_mail_domain()
returns text language sql immutable as $$
  select 'inbound.resofly.com'::text;
$$;

comment on function public.inbound_mail_domain() is
  'Inbound-domein voor doorstuuradressen. MOET gelijk zijn aan de Supabase env-var MAIL_INBOUND_DOMAIN; mail-inbound logt een waarschuwing als ze uiteenlopen.';

-- ------------------------------------------------------------
-- 2. Freemail-domeinen (rem op de domeinheuristiek, geen beveiliging)
-- ------------------------------------------------------------
create or replace function public.is_freemail_domain(p_domain text)
returns boolean language sql immutable as $$
  select lower(coalesce(p_domain, '')) = any (array[
    'gmail.com','googlemail.com','outlook.com','outlook.be','outlook.de',
    'hotmail.com','hotmail.nl','hotmail.be','hotmail.co.uk','live.nl','live.com','live.be',
    'msn.com','icloud.com','me.com','mac.com','yahoo.com','yahoo.co.uk','yahoo.fr',
    'ziggo.nl','kpnmail.nl','planet.nl','casema.nl','home.nl','xs4all.nl','telfort.nl',
    'chello.nl','upcmail.nl','hetnet.nl','online.nl','quicknet.nl','zeelandnet.nl',
    'telenet.be','skynet.be','proximus.be','gmx.net','gmx.com','gmx.de','web.de',
    't-online.de','mail.com','zoho.com','protonmail.com','proton.me','aol.com'
  ]);
$$;

-- ------------------------------------------------------------
-- 3. Doorstuuradres per organisatie
-- ------------------------------------------------------------
create table if not exists public.organization_inbound_aliases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  -- Alleen het lokale deel; het domein komt uit inbound_mail_domain().
  local_part text not null check (local_part ~ '^[a-z0-9][a-z0-9-]{0,23}-[a-z2-7]{16}$'),
  label text not null default 'Doorstuuradres',
  -- Het adres dat de gebruiker doorstuurt (info@fotograaf.nl). Wordt gebruikt
  -- als to_email op de client_emails-rij, en om te voorkomen dat zijn eigen
  -- adres ooit als klant wordt gematcht.
  forward_from_email text,
  status text not null default 'active' check (status in ('active','retiring','revoked')),
  retires_at timestamptz,
  -- Adressen/domeinen waarvan de gebruiker niets meer wil zien. Nooit DROP,
  -- altijd PARK: de aanvaller bepaalt de getoonde From en zou anders het
  -- echte adres van een klant kunnen laten blokkeren.
  blocked_senders text[] not null default '{}',
  last_received_at timestamptz,
  received_total bigint not null default 0,
  rate_window_started_at timestamptz,
  rate_window_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.organization_inbound_aliases is
  'Uniek doorstuuradres per organisatie. De organization_id van een binnenkomende mail wordt HIER uit afgeleid, nooit uit het afzenderadres.';

create unique index if not exists uidx_org_inbound_alias_local
  on public.organization_inbound_aliases (local_part);
create index if not exists idx_org_inbound_alias_org
  on public.organization_inbound_aliases (organization_id, status, created_at desc);

drop trigger if exists organization_inbound_aliases_updated on public.organization_inbound_aliases;
create trigger organization_inbound_aliases_updated
  before update on public.organization_inbound_aliases
  for each row execute function public.set_updated_at();

drop trigger if exists organization_inbound_aliases_prevent_org_change on public.organization_inbound_aliases;
create trigger organization_inbound_aliases_prevent_org_change
  before update of organization_id on public.organization_inbound_aliases
  for each row execute function public.prevent_organization_id_change();

alter table public.organization_inbound_aliases enable row level security;

-- Lezen alleen met leesrecht op de module Klanten: wie het alias kent, kan er
-- mail in injecteren. Schrijven uitsluitend via de RPC's hieronder.
drop policy if exists "org inbound alias read" on public.organization_inbound_aliases;
create policy "org inbound alias read" on public.organization_inbound_aliases
  for select using (public.can_read_module(organization_id, 'clients'));

do $$ begin perform public.apply_module_gate('organization_inbound_aliases', 'clients', 'write'); end $$;

-- ------------------------------------------------------------
-- 4. Aliasgenerator (32-tekens alfabet: 256 % 32 = 0, dus geen modulo-bias)
-- ------------------------------------------------------------
-- LET OP: search_path bevat bewust ook `extensions`. gen_random_bytes komt uit
-- pgcrypto, en Supabase installeert extensies in het schema `extensions`. Met
-- alleen `public` in het pad is die functie onvindbaar en faalt het aanmaken van
-- een doorstuuradres. (gen_random_uuid mag wél: die zit sinds PG13 in de kern.)
create or replace function public.generate_inbound_alias_local_part(p_organization_id uuid)
returns text language plpgsql volatile set search_path = public, extensions as $$
declare
  v_alphabet constant text := 'abcdefghijklmnopqrstuvwxyz234567';
  v_reserved constant text[] := array['reply','organizer','postmaster','abuse','noreply','mailer-daemon','in'];
  v_slug text;
  v_rand text := '';
  v_bytes bytea;
  i integer;
begin
  select lower(regexp_replace(coalesce(o.slug, ''), '[^a-zA-Z0-9]+', '-', 'g'))
    into v_slug
    from public.organizations o
   where o.id = p_organization_id;

  v_slug := btrim(coalesce(nullif(v_slug, ''), 'resofly'), '-');
  v_slug := btrim(left(v_slug, 23), '-');
  if v_slug = '' or v_slug = any(v_reserved) then v_slug := 'resofly'; end if;

  v_bytes := gen_random_bytes(16);
  for i in 0..15 loop
    v_rand := v_rand || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;

  return v_slug || '-' || v_rand;
end; $$;

create or replace function public.ensure_organization_inbound_alias(p_organization_id uuid)
returns public.organization_inbound_aliases
language plpgsql security definer set search_path = public as $$
declare v_row public.organization_inbound_aliases;
begin
  if auth.role() is distinct from 'service_role'
     and not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen owners en admins beheren het doorstuuradres.' using errcode = '42501';
  end if;

  select * into v_row from public.organization_inbound_aliases
   where organization_id = p_organization_id and status = 'active'
   order by created_at desc limit 1;
  if found then return v_row; end if;

  insert into public.organization_inbound_aliases (organization_id, local_part)
  values (p_organization_id, public.generate_inbound_alias_local_part(p_organization_id))
  returning * into v_row;
  return v_row;
end; $$;

create or replace function public.rotate_organization_inbound_alias(p_organization_id uuid)
returns public.organization_inbound_aliases
language plpgsql security definer set search_path = public as $$
declare v_row public.organization_inbound_aliases;
begin
  if not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen owners en admins vernieuwen het doorstuuradres.' using errcode = '42501';
  end if;

  -- Het oude adres blijft 30 dagen resolven, maar koppelt niets meer
  -- automatisch: mail die al onderweg is, landt in de opvangbak i.p.v. te
  -- verdwijnen.
  update public.organization_inbound_aliases
     set status = 'retiring', retires_at = now() + interval '30 days'
   where organization_id = p_organization_id and status = 'active';

  insert into public.organization_inbound_aliases
    (organization_id, local_part, forward_from_email)
  select p_organization_id,
         public.generate_inbound_alias_local_part(p_organization_id),
         (select a.forward_from_email from public.organization_inbound_aliases a
           where a.organization_id = p_organization_id
           order by a.created_at desc limit 1)
  returning * into v_row;
  return v_row;
end; $$;

create or replace function public.set_inbound_alias_forward_from(
  p_organization_id uuid, p_alias_id uuid, p_email text
) returns public.organization_inbound_aliases
language plpgsql security definer set search_path = public as $$
declare v_row public.organization_inbound_aliases;
begin
  if not public.can_admin_org(p_organization_id) then
    raise exception 'Alleen owners en admins beheren het doorstuuradres.' using errcode = '42501';
  end if;
  update public.organization_inbound_aliases
     set forward_from_email = public.normalize_client_lookup_value(p_email)
   where id = p_alias_id and organization_id = p_organization_id
  returning * into v_row;
  if v_row.id is null then
    raise exception 'Doorstuuradres niet gevonden.' using errcode = '02000';
  end if;
  return v_row;
end; $$;

-- Alias -> organisatie. Alleen de service role (mail-inbound).
create or replace function public.resolve_inbound_alias(p_local_part text)
returns table (
  alias_id uuid, organization_id uuid, alias_status text,
  forward_from_email text, blocked_senders text[]
)
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de service-role mag een doorstuuradres opzoeken.' using errcode = '42501';
  end if;
  return query
    select a.id, a.organization_id, a.status, a.forward_from_email, a.blocked_senders
      from public.organization_inbound_aliases a
     where a.local_part = lower(btrim(coalesce(p_local_part, '')))
       and (a.status = 'active'
            or (a.status = 'retiring' and (a.retires_at is null or a.retires_at > now())));
end; $$;

revoke execute on function public.resolve_inbound_alias(text) from public, anon, authenticated;
grant  execute on function public.resolve_inbound_alias(text) to service_role;

-- ------------------------------------------------------------
-- 5. "Is dit een adres van de organisatie zelf?"
--    Zonder deze guard belandt interne post en ResoFly's eigen systeemmail in
--    klantdossiers zodra iemand zichzelf ooit als testklant heeft aangemaakt.
-- ------------------------------------------------------------
create or replace function public.is_own_org_address(p_organization_id uuid, p_email text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_norm text; v_domain text;
begin
  v_norm := public.normalize_client_lookup_value(p_email);
  if v_norm is null then return false; end if;
  v_domain := split_part(v_norm, '@', 2);

  if v_domain = public.inbound_mail_domain() then return true; end if;

  if exists (select 1 from public.organization_inbound_aliases a
              where a.organization_id = p_organization_id
                and public.normalize_client_lookup_value(a.forward_from_email) = v_norm) then
    return true;
  end if;

  if exists (select 1 from public.organization_email_domains d
              where d.organization_id = p_organization_id
                and lower(d.domain) = v_domain) then
    return true;
  end if;

  if exists (select 1 from public.organization_members m
              where m.organization_id = p_organization_id
                and public.normalize_client_lookup_value(m.email) = v_norm) then
    return true;
  end if;

  return false;
exception when others then
  -- Kolomdrift mag de mailverwerking nooit stilleggen.
  raise warning 'is_own_org_address: %', sqlerrm;
  return false;
end; $$;

-- ------------------------------------------------------------
-- 6. client_emails: threading, herkomst en verwijderrecht
-- ------------------------------------------------------------
alter table public.client_emails
  add column if not exists rfc_message_id text,
  add column if not exists inbound_message_id uuid,
  add column if not exists link_source text,
  add column if not exists link_confidence text,
  add column if not exists linked_by uuid references auth.users(id) on delete set null,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null;

comment on column public.client_emails.rfc_message_id is
  'RFC 5322 Message-ID. Inbound: uit de mail zelf. Outbound: gevuld door resend-webhook uit data.message_id bij het email.sent-event.';
comment on column public.client_emails.link_source is
  'reply_token | header_thread | client_email | client_contact | manual — waarom dit bericht in dit dossier staat.';

-- Dossier-idempotentie. Staat bewust op de NIEUWE (lege) kolom, zodat de
-- migratie niet kan falen op bestaande duplicaten in provider_email_id.
create unique index if not exists uidx_client_emails_inbound_rfc
  on public.client_emails (organization_id, rfc_message_id)
  where direction = 'inbound' and rfc_message_id is not null and deleted_at is null;

create index if not exists idx_client_emails_rfc_lookup
  on public.client_emails (organization_id, rfc_message_id)
  where rfc_message_id is not null;

-- Verwijderde berichten verdwijnen in de RLS-POLICY, niet in de query.
drop policy if exists "client emails read" on public.client_emails;
create policy "client emails read" on public.client_emails
  for select using (public.can_read_org(organization_id) and deleted_at is null);

create or replace function public.delete_client_email(p_organization_id uuid, p_client_email_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role'
     and not public.can_write_module(p_organization_id, 'clients') then
    raise exception 'Geen schrijfrechten op de module Klanten.' using errcode = '42501';
  end if;
  update public.client_emails
     set deleted_at = now(), deleted_by = auth.uid(), updated_at = now()
   where id = p_client_email_id and organization_id = p_organization_id and deleted_at is null;
  if not found then
    raise exception 'Bericht niet gevonden of al verwijderd.' using errcode = '02000';
  end if;
end; $$;

-- ------------------------------------------------------------
-- 7. client_contacts: herkomst, zodat automatisch geleerde adressen niet in
--    campagne-doelgroepen belanden (een verse reply+<uuid>-schrijfsleutel).
-- ------------------------------------------------------------
alter table public.client_contacts
  add column if not exists origin text not null default 'manual';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'client_contacts_origin_check') then
    alter table public.client_contacts
      add constraint client_contacts_origin_check check (origin in ('manual','inbound_auto'));
  end if;
end $$;

-- ------------------------------------------------------------
-- 8. Register + opvangbak
-- ------------------------------------------------------------
create table if not exists public.inbound_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  alias_id uuid references public.organization_inbound_aliases(id) on delete set null,
  origin_client_email_id uuid references public.client_emails(id) on delete set null,
  route text not null check (route in ('alias','reply_token','organizer_token')),

  -- Transport-idempotentie: ontvanger|message-id|inhoudshash. De hash zit er
  -- bewust in: mail zonder Message-ID dedupt daardoor toch, en een gekaapte
  -- Message-ID verdringt het echte bericht niet (dat wordt een conflict).
  dedup_key text not null,
  recipient text not null,

  envelope_from text,
  header_from text,
  sender_email text,
  sender_name text,
  sender_source text check (sender_source in
    ('rfc822_attachment','header_from','forward_block','srs_envelope','reply_to','envelope')),
  sender_confidence text not null default 'low' check (sender_confidence in ('high','medium','low')),
  sender_candidates text[] not null default '{}',
  forwarding_evidence text,

  subject text not null default '',
  body_text text,
  body_html text,
  rfc_message_id text,
  in_reply_to text,
  reference_ids text[] not null default '{}',
  headers jsonb not null default '{}'::jsonb,
  attachment_names text[] not null default '{}',
  raw_hash text,
  raw_size integer,
  truncated boolean not null default false,
  received_at timestamptz not null default now(),

  status text not null default 'unmatched' check (status in
    ('linked','unmatched','duplicate','dropped','conflict')),
  reason text,
  category text not null default 'human' check (category in ('human','automated')),
  candidates jsonb not null default '[]'::jsonb,

  suggested_client_id uuid references public.clients(id) on delete set null,
  linked_client_id uuid references public.clients(id) on delete set null,
  linked_thread_id uuid references public.client_email_threads(id) on delete set null,
  client_email_id uuid references public.client_emails(id) on delete set null,
  duplicate_of_client_email_id uuid references public.client_emails(id) on delete set null,
  link_source text,
  link_confidence text,
  handled_by uuid references auth.users(id) on delete set null,
  handled_at timestamptz,

  purge_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.inbound_messages is
  'Elke binnenkomende mail wordt hier onvoorwaardelijk vastgelegd voordat er gematcht wordt. status=unmatched is de opvangbak; niets verdwijnt stil.';

create unique index if not exists uidx_inbound_messages_dedup
  on public.inbound_messages (dedup_key);
create index if not exists idx_inbound_messages_org_status
  on public.inbound_messages (organization_id, status, category, received_at desc);
create index if not exists idx_inbound_messages_org_rfc
  on public.inbound_messages (organization_id, rfc_message_id)
  where rfc_message_id is not null;
create index if not exists idx_inbound_messages_purge
  on public.inbound_messages (purge_after) where purge_after is not null;

drop trigger if exists inbound_messages_updated on public.inbound_messages;
create trigger inbound_messages_updated
  before update on public.inbound_messages
  for each row execute function public.set_updated_at();

drop trigger if exists inbound_messages_prevent_org_change on public.inbound_messages;
create trigger inbound_messages_prevent_org_change
  before update of organization_id on public.inbound_messages
  for each row execute function public.prevent_organization_id_change();

alter table public.inbound_messages enable row level security;

drop policy if exists "inbound messages read" on public.inbound_messages;
create policy "inbound messages read" on public.inbound_messages
  for select using (public.can_read_module(organization_id, 'clients'));

do $$ begin perform public.apply_module_gate('inbound_messages', 'clients', 'write'); end $$;

-- ------------------------------------------------------------
-- 9. Klantmatching binnen de organisatie
--    clients EN client_contacts worden allebei doorzocht; pas bij precies EEN
--    distinct client_id wordt automatisch gekoppeld.
-- ------------------------------------------------------------
create or replace function public.resolve_inbound_client(p_organization_id uuid, p_emails text[])
returns table (client_id uuid, match_source text, matched_email text, ambiguous boolean, candidates jsonb)
language plpgsql security definer set search_path = public as $$
declare
  v_email text; v_norm text; v_domain text; v_count integer; v_hits jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de service-role mag inbound-klantmatching uitvoeren.' using errcode = '42501';
  end if;

  -- a/b: exacte treffers, kandidaat voor kandidaat, in volgorde van vertrouwen
  foreach v_email in array coalesce(p_emails, array[]::text[]) loop
    v_norm := public.normalize_client_lookup_value(v_email);
    continue when v_norm is null;
    continue when public.is_own_org_address(p_organization_id, v_norm);

    with hits as (
      select c.id as cid, null::uuid as contact_id, 'client_email'::text as src, c.name as label
        from public.clients c
       where c.organization_id = p_organization_id
         and public.normalize_client_lookup_value(c.email) = v_norm
      union
      select cc.client_id, cc.id, 'client_contact'::text, cc.name
        from public.client_contacts cc
       where cc.organization_id = p_organization_id
         and cc.is_active
         and public.normalize_client_lookup_value(cc.email) = v_norm
    )
    select count(distinct h.cid),
           coalesce(jsonb_agg(distinct jsonb_build_object(
             'client_id', h.cid, 'label', h.label, 'matched_on', h.src)), '[]'::jsonb)
      into v_count, v_hits
      from hits h;

    if v_count = 1 then
      select (v_hits->0->>'client_id')::uuid, v_hits->0->>'matched_on'
        into client_id, match_source;
      matched_email := v_norm; ambiguous := false; candidates := v_hits;
      return next; return;
    elsif v_count > 1 then
      client_id := null; match_source := 'ambiguous'; matched_email := v_norm;
      ambiguous := true; candidates := v_hits;
      return next; return;
    end if;
  end loop;

  -- c: domeinheuristiek — ALTIJD alleen een suggestie, nooit een koppeling
  foreach v_email in array coalesce(p_emails, array[]::text[]) loop
    v_norm := public.normalize_client_lookup_value(v_email);
    continue when v_norm is null;
    v_domain := split_part(v_norm, '@', 2);
    continue when v_domain = '' or public.is_freemail_domain(v_domain);
    continue when public.is_own_org_address(p_organization_id, v_norm);

    select count(*),
           coalesce(jsonb_agg(jsonb_build_object(
             'client_id', c.id, 'label', c.name, 'matched_on', 'domain')), '[]'::jsonb)
      into v_count, v_hits
      from public.clients c
     where c.organization_id = p_organization_id
       and split_part(public.normalize_client_lookup_value(c.email), '@', 2) = v_domain;

    if v_count = 1 then
      client_id := null;                    -- bewust NIET koppelen
      match_source := 'domain_suggestion';
      matched_email := v_norm; ambiguous := true; candidates := v_hits;
      return next; return;
    end if;
  end loop;

  client_id := null; match_source := null; matched_email := null;
  ambiguous := false; candidates := '[]'::jsonb;
  return next;
end; $$;

revoke execute on function public.resolve_inbound_client(uuid, text[]) from public, anon, authenticated;
grant  execute on function public.resolve_inbound_client(uuid, text[]) to service_role;

-- ------------------------------------------------------------
-- 10. Threadkeuze — EEN definitie voor automatisch en handmatig koppelen.
--     Maakt bewust een nieuwe thread als de nieuwste thread aan een campagne
--     of stroom hangt: anders markeert mark_campaign_reply_from_inbound een
--     losstaand bericht als "geantwoord" en stopt de follow-upstroom.
-- ------------------------------------------------------------
create or replace function public.pick_client_email_thread(
  p_organization_id uuid, p_client_id uuid, p_subject text,
  p_received_at timestamptz, p_reference_ids text[] default '{}'
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_thread uuid;
begin
  -- 1. Header-threading: alleen om BINNEN de al gevonden klant het juiste
  --    gesprek te kiezen. Nooit om de klant te bepalen (References is vrij
  --    door de afzender te kiezen).
  if array_length(p_reference_ids, 1) > 0 then
    select e.thread_id into v_thread
      from public.client_emails e
     where e.organization_id = p_organization_id
       and e.client_id = p_client_id
       and e.rfc_message_id = any(p_reference_ids)
     order by e.created_at desc limit 1;
    if v_thread is not null then return v_thread; end if;
  end if;

  -- 2. Meest recente thread, maar niet ouder dan 30 dagen en niet als er een
  --    campagne of stroom aan hangt.
  select t.id into v_thread
    from public.client_email_threads t
   where t.organization_id = p_organization_id
     and t.client_id = p_client_id
     and t.last_message_at > now() - interval '30 days'
     and not exists (select 1 from public.email_campaign_recipients r where r.thread_id = t.id)
     and not exists (select 1 from public.email_flow_enrollments f where f.thread_id = t.id)
   order by t.last_message_at desc limit 1;
  if v_thread is not null then return v_thread; end if;

  insert into public.client_email_threads
    (organization_id, client_id, created_by, subject, last_direction, last_message_at)
  values (p_organization_id, p_client_id, auth.uid(),
          coalesce(nullif(btrim(p_subject), ''), '(bericht van klant)'),
          'inbound', p_received_at)
  returning id into v_thread;
  return v_thread;
end; $$;

-- ------------------------------------------------------------
-- 11. Registreren + dedupliceren + matchen in EEN transactie
-- ------------------------------------------------------------
create or replace function public.register_inbound_message(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.inbound_messages;
  v_org uuid := (p_payload->>'organization_id')::uuid;
  v_route text := p_payload->>'route';
  v_dedup text := p_payload->>'dedup_key';
  v_rfc text := nullif(p_payload->>'rfc_message_id', '');
  v_raw_hash text := nullif(p_payload->>'raw_hash', '');
  v_received timestamptz := coalesce((p_payload->>'received_at')::timestamptz, now());
  v_drop text := nullif(p_payload->>'drop_reason', '');
  v_park text := nullif(p_payload->>'park_reason', '');
  v_category text := coalesce(nullif(p_payload->>'category', ''), 'human');
  v_candidates text[] := coalesce(
    (select array_agg(value::text) from jsonb_array_elements_text(p_payload->'sender_candidates')),
    array[]::text[]);
  v_existing_id uuid;
  v_match record;
  v_thread uuid;
  v_email_id uuid;
  v_throttled boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de service-role mag inkomende mail registreren.' using errcode = '42501';
  end if;
  if v_org is null or v_dedup is null or v_route is null then
    raise exception 'Onvolledige inbound-payload.' using errcode = '22023';
  end if;

  -- Vastleggen. Bij een Cloudflare-retry is dedup_key identiek -> zelfde rij.
  insert into public.inbound_messages (
    organization_id, alias_id, origin_client_email_id, route, dedup_key, recipient,
    envelope_from, header_from, sender_email, sender_name, sender_source,
    sender_confidence, sender_candidates, forwarding_evidence,
    subject, body_text, body_html, rfc_message_id, in_reply_to, reference_ids,
    headers, attachment_names, raw_hash, raw_size, truncated, received_at,
    status, reason, category
  ) values (
    v_org, (p_payload->>'alias_id')::uuid, (p_payload->>'origin_client_email_id')::uuid,
    v_route, v_dedup, coalesce(p_payload->>'recipient', ''),
    p_payload->>'envelope_from', p_payload->>'header_from',
    p_payload->>'sender_email', p_payload->>'sender_name', p_payload->>'sender_source',
    coalesce(p_payload->>'sender_confidence', 'low'), v_candidates,
    p_payload->>'forwarding_evidence',
    coalesce(p_payload->>'subject', ''),
    left(coalesce(p_payload->>'body_text', ''), 131072),
    left(coalesce(p_payload->>'body_html', ''), 131072),
    v_rfc, nullif(p_payload->>'in_reply_to', ''),
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_payload->'reference_ids')), '{}'),
    coalesce(p_payload->'headers', '{}'::jsonb),
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_payload->'attachment_names')), '{}'),
    v_raw_hash, (p_payload->>'raw_size')::integer,
    coalesce((p_payload->>'truncated')::boolean, false), v_received,
    'unmatched', null, v_category
  )
  on conflict (dedup_key) do nothing
  returning * into m;

  if m.id is null then
    select * into m from public.inbound_messages where dedup_key = v_dedup;
    if m.status <> 'unmatched' or m.reason is not null then
      return jsonb_build_object('outcome', 'duplicate', 'inbound_message_id', m.id);
    end if;
    -- Rij bestaat maar is nooit afgehandeld (vorige poging strandde): doorgaan.
  end if;

  -- Tellen pas NA dedup, zodat retries en bounces de limiet niet opblazen.
  if m.alias_id is not null then
    update public.organization_inbound_aliases a
       set rate_window_started_at = case
             when a.rate_window_started_at is null or a.rate_window_started_at < now() - interval '1 hour'
             then now() else a.rate_window_started_at end,
           rate_window_count = case
             when a.rate_window_started_at is null or a.rate_window_started_at < now() - interval '1 hour'
             then 1 else a.rate_window_count + 1 end,
           last_received_at = now(),
           received_total = a.received_total + 1
     where a.id = m.alias_id
    returning (a.rate_window_count > 120) into v_throttled;
  end if;

  -- DROP: rij blijft staan met een reden, 30 dagen.
  if v_drop is not null then
    update public.inbound_messages
       set status = 'dropped', reason = v_drop, body_text = null, body_html = null,
           purge_after = now() + interval '30 days'
     where id = m.id;
    return jsonb_build_object('outcome', 'dropped', 'reason', v_drop, 'inbound_message_id', m.id);
  end if;

  -- Message-ID-conflict: zelfde Message-ID, andere inhoud. Beide bewaren.
  if v_rfc is not null then
    select id into v_existing_id from public.client_emails
     where organization_id = v_org and direction = 'inbound'
       and rfc_message_id = v_rfc and deleted_at is null limit 1;
    if v_existing_id is not null then
      update public.inbound_messages
         set status = 'conflict', reason = 'messageid_conflict',
             duplicate_of_client_email_id = v_existing_id,
             purge_after = now() + interval '90 days'
       where id = m.id;
      return jsonb_build_object('outcome', 'conflict', 'inbound_message_id', m.id);
    end if;
  end if;

  -- Klantmatching (ook bij PARK, zodat de opvangbak een suggestie kan tonen).
  if v_route = 'reply_token' and m.origin_client_email_id is not null then
    select o.client_id as client_id, 'reply_token'::text as match_source,
           false as ambiguous, '[]'::jsonb as candidates
      into v_match
      from public.client_emails o where o.id = m.origin_client_email_id;
  else
    select r.client_id, r.match_source, r.ambiguous, r.candidates
      into v_match
      from public.resolve_inbound_client(v_org, v_candidates) r;
  end if;

  -- Rate limit degradeert nooit een exacte klantmatch.
  if v_throttled and coalesce(v_match.match_source, '') not in ('client_email','reply_token') then
    v_park := coalesce(v_park, 'rate_limited');
  end if;

  if v_park is null and v_match.client_id is null then
    v_park := case when coalesce(v_match.ambiguous, false) then 'ambiguous' else 'no_match' end;
  end if;

  -- PARK: opvangbak.
  if v_park is not null then
    update public.inbound_messages
       set status = 'unmatched', reason = v_park,
           candidates = coalesce(v_match.candidates, '[]'::jsonb),
           suggested_client_id = case
             when jsonb_array_length(coalesce(v_match.candidates, '[]'::jsonb)) = 1
             then (v_match.candidates->0->>'client_id')::uuid else null end,
           purge_after = now() + case when v_category = 'automated'
             then interval '14 days' else interval '90 days' end
     where id = m.id;
    return jsonb_build_object('outcome', 'parked', 'reason', v_park, 'inbound_message_id', m.id);
  end if;

  -- DOOR: koppelen.
  v_thread := public.pick_client_email_thread(
    v_org, v_match.client_id, m.subject, m.received_at, m.reference_ids);

  insert into public.client_emails (
    organization_id, thread_id, client_id, created_by, direction, provider,
    provider_email_id, rfc_message_id, inbound_message_id,
    from_email, from_name, to_email, subject, body_html, body_text,
    status, received_at, last_event_at, link_source, link_confidence, linked_by, metadata
  ) values (
    v_org, v_thread, v_match.client_id, null, 'inbound', 'inbound',
    m.rfc_message_id, m.rfc_message_id, m.id,
    m.sender_email, m.sender_name,
    coalesce(nullif(p_payload->>'to_display', ''), m.recipient),
    m.subject, m.body_html, coalesce(m.body_text, ''),
    'received', m.received_at, m.received_at,
    v_match.match_source, m.sender_confidence, null,
    jsonb_build_object(
      'inbound_route', m.route,
      'inbound_message_id', m.id,
      'sender_source', m.sender_source,
      'forwarding_evidence', m.forwarding_evidence,
      'attachment_names', to_jsonb(m.attachment_names),
      'truncated', m.truncated)
  ) returning id into v_email_id;

  update public.client_email_threads
     set last_message_at = greatest(last_message_at, m.received_at), last_direction = 'inbound'
   where id = v_thread;

  update public.inbound_messages
     set status = 'linked', reason = null, client_email_id = v_email_id,
         linked_client_id = v_match.client_id, linked_thread_id = v_thread,
         link_source = v_match.match_source, link_confidence = m.sender_confidence,
         body_text = null, body_html = null,
         purge_after = now() + interval '30 days'
   where id = m.id;

  return jsonb_build_object('outcome', 'linked', 'inbound_message_id', m.id,
                            'client_email_id', v_email_id, 'thread_id', v_thread);
end; $$;

revoke execute on function public.register_inbound_message(jsonb) from public, anon, authenticated;
grant  execute on function public.register_inbound_message(jsonb) to service_role;

-- ------------------------------------------------------------
-- 12. Handmatig koppelen / negeren / blokkeren
-- ------------------------------------------------------------
create or replace function public.link_inbound_message(
  p_organization_id uuid, p_inbound_message_id uuid, p_client_id uuid,
  p_remember_sender boolean default false
) returns uuid language plpgsql security definer set search_path = public as $$
declare m public.inbound_messages; v_thread uuid; v_email_id uuid; v_existing uuid;
begin
  if auth.role() is distinct from 'service_role'
     and not public.can_write_module(p_organization_id, 'clients') then
    raise exception 'Geen schrijfrechten op de module Klanten.' using errcode = '42501';
  end if;

  select * into m from public.inbound_messages
   where id = p_inbound_message_id and organization_id = p_organization_id for update;
  if not found then raise exception 'Bericht niet gevonden.' using errcode = '02000'; end if;
  if m.status = 'linked' then raise exception 'Dit bericht is al gekoppeld.' using errcode = '23514'; end if;

  perform public.assert_same_org_reference('public.clients', p_client_id, p_organization_id, 'Klant');

  if m.rfc_message_id is not null then
    select id into v_existing from public.client_emails
     where organization_id = p_organization_id and direction = 'inbound'
       and rfc_message_id = m.rfc_message_id and deleted_at is null limit 1;
    if v_existing is not null then
      update public.inbound_messages
         set status = 'duplicate', reason = 'already_in_dossier',
             duplicate_of_client_email_id = v_existing,
             handled_by = auth.uid(), handled_at = now(),
             purge_after = now() + interval '30 days'
       where id = m.id;
      return v_existing;
    end if;
  end if;

  v_thread := public.pick_client_email_thread(
    p_organization_id, p_client_id, m.subject, m.received_at, m.reference_ids);

  insert into public.client_emails (
    organization_id, thread_id, client_id, created_by, direction, provider,
    provider_email_id, rfc_message_id, inbound_message_id,
    from_email, from_name, to_email, subject, body_html, body_text,
    status, received_at, last_event_at, link_source, link_confidence, linked_by, metadata
  ) values (
    p_organization_id, v_thread, p_client_id, auth.uid(), 'inbound', 'inbound',
    m.rfc_message_id, m.rfc_message_id, m.id,
    m.sender_email, m.sender_name, m.recipient, m.subject, m.body_html,
    coalesce(m.body_text, ''), 'received', m.received_at, m.received_at,
    'manual', m.sender_confidence, auth.uid(),
    jsonb_build_object('inbound_route', m.route, 'inbound_message_id', m.id,
                       'sender_source', m.sender_source,
                       'attachment_names', to_jsonb(m.attachment_names))
  ) returning id into v_email_id;

  update public.client_email_threads
     set last_message_at = greatest(last_message_at, m.received_at), last_direction = 'inbound'
   where id = v_thread;

  -- "Onthoud deze afzender": standaard UIT, en server-side geweigerd bij bulk/
  -- automatische mail, zodat een nieuwsbrief geen permanente route wordt.
  if p_remember_sender
     and m.category = 'human'
     and m.sender_email is not null
     and not public.is_own_org_address(p_organization_id, m.sender_email) then
    begin
      insert into public.client_contacts
        (organization_id, client_id, name, email, gives_portal_access, is_active, origin)
      values (p_organization_id, p_client_id,
              coalesce(nullif(btrim(m.sender_name), ''), split_part(m.sender_email, '@', 1)),
              m.sender_email, false, true, 'inbound_auto');
    exception when others then
      -- client_contacts heeft een BEFORE-trigger die zelf 23505/23514 raist;
      -- ON CONFLICT vangt dat NIET. Een bestaand contact mag het koppelen
      -- nooit laten mislukken.
      raise warning 'link_inbound_message: contactpersoon niet aangemaakt: %', sqlerrm;
    end;
  end if;

  update public.inbound_messages
     set status = 'linked', reason = null, client_email_id = v_email_id,
         linked_client_id = p_client_id, linked_thread_id = v_thread,
         link_source = 'manual', link_confidence = m.sender_confidence,
         handled_by = auth.uid(), handled_at = now(),
         body_text = null, body_html = null,
         purge_after = now() + interval '30 days'
   where id = m.id;

  -- Andere wachtende kopieën van hetzelfde bericht opruimen.
  if m.rfc_message_id is not null then
    update public.inbound_messages
       set status = 'duplicate', reason = 'already_in_dossier',
           duplicate_of_client_email_id = v_email_id,
           purge_after = now() + interval '30 days'
     where organization_id = p_organization_id and rfc_message_id = m.rfc_message_id
       and id <> m.id and status in ('unmatched','conflict');
  end if;

  return v_email_id;
end; $$;

create or replace function public.set_inbound_message_status(
  p_organization_id uuid, p_inbound_message_id uuid, p_status text
) returns public.inbound_messages
language plpgsql security definer set search_path = public as $$
declare v public.inbound_messages;
begin
  if auth.role() is distinct from 'service_role'
     and not public.can_write_module(p_organization_id, 'clients') then
    raise exception 'Geen schrijfrechten op de module Klanten.' using errcode = '42501';
  end if;
  if p_status not in ('unmatched','dropped') then
    raise exception 'Ongeldige status.' using errcode = '23514';
  end if;
  update public.inbound_messages
     set status = p_status,
         reason = case when p_status = 'dropped' then 'dismissed_by_user' else null end,
         handled_by = case when p_status = 'dropped' then auth.uid() else null end,
         handled_at = case when p_status = 'dropped' then now() else null end,
         purge_after = case when p_status = 'dropped'
                            then now() + interval '30 days'
                            else now() + interval '90 days' end
   where id = p_inbound_message_id and organization_id = p_organization_id
     and status in ('unmatched','dropped','conflict')
  returning * into v;
  if v.id is null then
    raise exception 'Bericht niet gevonden of al gekoppeld.' using errcode = '02000';
  end if;
  return v;
end; $$;

-- Blokkeren is PARK, nooit DROP, en mag nooit een bekend klantadres treffen.
create or replace function public.block_inbound_sender(
  p_organization_id uuid, p_alias_id uuid, p_value text
) returns public.organization_inbound_aliases
language plpgsql security definer set search_path = public as $$
declare v public.organization_inbound_aliases; v_norm text;
begin
  if not public.can_write_module(p_organization_id, 'clients') then
    raise exception 'Geen schrijfrechten op de module Klanten.' using errcode = '42501';
  end if;
  v_norm := lower(btrim(coalesce(p_value, '')));
  if v_norm = '' then raise exception 'Leeg adres.' using errcode = '23514'; end if;

  if exists (select 1 from public.clients c
              where c.organization_id = p_organization_id
                and public.normalize_client_lookup_value(c.email) = v_norm)
     or exists (select 1 from public.client_contacts cc
                 where cc.organization_id = p_organization_id
                   and public.normalize_client_lookup_value(cc.email) = v_norm) then
    raise exception 'Dit adres hoort bij een klant en kan niet geblokkeerd worden.'
      using errcode = '23514';
  end if;

  update public.organization_inbound_aliases
     set blocked_senders = (select array_agg(distinct x)
                            from unnest(blocked_senders || array[v_norm]) x)
   where id = p_alias_id and organization_id = p_organization_id
  returning * into v;
  if v.id is null then raise exception 'Doorstuuradres niet gevonden.' using errcode = '02000'; end if;
  return v;
end; $$;

-- ------------------------------------------------------------
-- 13. Opruimen (AVG). De opvangbak bevat per definitie gegevens van mensen
--     die geen klant zijn; kortere termijn dan het klantdossier.
-- ------------------------------------------------------------
create or replace function public.purge_inbound_messages()
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de service-role mag de opvangbak opschonen.' using errcode = '42501';
  end if;
  delete from public.inbound_messages
   where purge_after is not null and purge_after < now();
  get diagnostics v_count = row_count;
  return v_count;
end; $$;

revoke execute on function public.purge_inbound_messages() from public, anon, authenticated;
grant  execute on function public.purge_inbound_messages() to service_role;

-- ------------------------------------------------------------
-- 14. Triggeraanpassingen
-- ------------------------------------------------------------
-- Geen web push voor mail die via het doorstuuradres binnenkomt: die zit al in
-- het eigen postvak van de gebruiker, en het is het versterkingspad van een
-- spamgolf (N mails = N pushes naar elk teamlid).
create or replace function public.push_on_client_email_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_body text;
begin
  begin
    if new.direction is distinct from 'inbound' then return null; end if;
    if coalesce(new.metadata->>'inbound_route', '') = 'alias' then return null; end if;
    v_body := coalesce(nullif(btrim(new.from_name), ''), nullif(btrim(new.from_email), ''), 'Onbekende afzender')
              || ': ' || coalesce(nullif(btrim(new.subject), ''), '(geen onderwerp)');
    perform public.push_enqueue(
      new.organization_id, 'client_email_inbound',
      public.push_org_member_ids(new.organization_id),
      jsonb_build_object('title', 'Nieuwe e-mail', 'body', v_body, 'url', '/',
                         'tag', 'email:' || new.thread_id::text)
    );
  exception when others then
    raise warning 'push_on_client_email_insert: %', sqlerrm;
  end;
  return null;
end; $$;

-- Alleen aantoonbaar vertrouwde herkomst mag een campagne of stroom stoppen.
drop trigger if exists client_emails_campaign_reply on public.client_emails;
create trigger client_emails_campaign_reply
  after insert on public.client_emails
  for each row
  when (new.direction = 'inbound'
        and new.thread_id is not null
        and coalesce(new.link_source, 'reply_token') in ('reply_token', 'manual'))
  execute function public.mark_campaign_reply_from_inbound();

-- ------------------------------------------------------------
-- 15. Realtime
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public'
         and tablename = 'inbound_messages') then
      alter publication supabase_realtime add table public.inbound_messages;
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public'
         and tablename = 'organization_inbound_aliases') then
      alter publication supabase_realtime add table public.organization_inbound_aliases;
    end if;
  end if;
end $$;

commit;
