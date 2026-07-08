-- ============================================================
-- ResoFly — E-mailmarketing / Campagnes (fase 1)
-- Date: 2026-07-08
--
-- Scope:
-- - Bulk-/marketingmail naar een selectie klanten vanaf één "Marketing"-pagina.
-- - Tracking (geopend/geklikt/gebounced/geantwoord) wordt HERGEBRUIKT van de
--   bestaande klant-mail-infrastructuur: elke campagne-verzending schrijft per
--   ontvanger een gewone outbound-rij in public.client_emails, waardoor de
--   bestaande resend-webhook (match op provider_email_id) en mail-inbound
--   (antwoord-threading) automatisch blijven werken — ZONDER die functies te
--   wijzigen. Twee nieuwe triggers op client_emails spiegelen die lifecycle naar
--   de campagne-ontvanger.
-- - AVG: opt-out. Elke marketingmail krijgt een afmeldlink; afgemelde adressen
--   komen in public.email_suppressions en worden nooit meer gemaild.
--
-- Schrijven van ontvangers gebeurt uitsluitend via de `campaigns` Edge Function
-- (service role, tijdens verzenden). Organisatieleden lezen (RLS can_read_org)
-- en beheren campagnes/afmeldingen zelf (can_write_org).
-- ============================================================

create extension if not exists pgcrypto;

begin;

-- ------------------------------------------------------------
-- 1. Campagnes
-- ------------------------------------------------------------
create table if not exists public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  name text not null default '',
  subject text not null default '',
  preheader text,
  body_html text not null default '',
  body_text text,
  accent_color text,
  audience jsonb not null default '{}'::jsonb,
  status text not null default 'draft'
    check (status in ('draft','scheduled','sending','sent','paused','cancelled')),
  scheduled_at timestamptz,
  started_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Eén rij per ontvanger per campagne. thread_id/client_email_id verwijzen naar
-- de HERGEBRUIKTE klant-mail-tabellen zodat tracking + antwoorden vanzelf werken.
create table if not exists public.email_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.email_campaigns(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  contact_id uuid references public.client_contacts(id) on delete set null,
  to_email text not null,
  to_name text,
  thread_id uuid references public.client_email_threads(id) on delete set null,
  client_email_id uuid references public.client_emails(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending','sending','sent','delivered','opened','clicked','bounced','failed','complained','skipped','unsubscribed')),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  bounced_at timestamptz,
  failed_at timestamptz,
  replied_at timestamptz,
  unsubscribed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, to_email)
);

-- ------------------------------------------------------------
-- 2. Suppressielijst (opt-out) per organisatie
-- ------------------------------------------------------------
create table if not exists public.email_suppressions (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  reason text not null default 'unsubscribed'
    check (reason in ('unsubscribed','bounced','complained','manual')),
  source text,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (organization_id, email)
);

-- ------------------------------------------------------------
-- 3. Indexen
-- ------------------------------------------------------------
create index if not exists idx_email_campaigns_org_status
  on public.email_campaigns(organization_id, status, created_at desc);
-- Goedkope scan voor de dispatch-cron: campagnes die verzonden moeten worden.
create index if not exists idx_email_campaigns_dispatch
  on public.email_campaigns(status, scheduled_at)
  where status in ('sending','scheduled');
create index if not exists idx_email_campaign_recipients_claim
  on public.email_campaign_recipients(campaign_id, status);
create index if not exists idx_email_campaign_recipients_org
  on public.email_campaign_recipients(organization_id, campaign_id);
-- Bediening van de antwoord-detectietrigger (match op thread_id).
create index if not exists idx_email_campaign_recipients_thread
  on public.email_campaign_recipients(thread_id) where thread_id is not null;

-- ------------------------------------------------------------
-- 4. Rangorde-helper voor e-mail-engagement (voor de spiegel-trigger + stats)
-- ------------------------------------------------------------
create or replace function public.email_engagement_rank(p_status text)
returns integer
language sql
immutable
as $$
  select case p_status
    when 'pending' then 0
    when 'sending' then 0
    when 'queued' then 0
    when 'sent' then 1
    when 'delivered' then 2
    when 'opened' then 3
    when 'clicked' then 4
    when 'bounced' then 5
    when 'failed' then 5
    when 'complained' then 6
    else 0
  end;
$$;

-- ------------------------------------------------------------
-- 5. Trigger 1: lifecycle van client_emails spiegelen naar de campagne-ontvanger
-- ------------------------------------------------------------
-- Draait op ELKE update van client_emails, maar doet niets tenzij de rij aan een
-- campagne-ontvanger gekoppeld is (metadata.campaign_recipient_id). Zo blijft de
-- resend-webhook ongewijzigd en werkt open/klik/bounce-tracking voor campagnes
-- automatisch, zonder normale klant-mail te belasten.
create or replace function public.mirror_client_email_to_campaign()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipient_id uuid;
begin
  v_recipient_id := nullif(new.metadata ->> 'campaign_recipient_id', '')::uuid;
  if v_recipient_id is null then
    return new;
  end if;

  update public.email_campaign_recipients r
     set status = case
           when r.status in ('unsubscribed','skipped') then r.status
           when public.email_engagement_rank(new.status) >= public.email_engagement_rank(r.status)
             and new.status in ('sent','delivered','opened','clicked','bounced','failed','complained')
             then new.status
           else r.status
         end,
         sent_at = coalesce(r.sent_at, new.sent_at),
         delivered_at = coalesce(r.delivered_at, new.delivered_at),
         opened_at = coalesce(r.opened_at, new.opened_at),
         clicked_at = coalesce(r.clicked_at, new.clicked_at),
         bounced_at = coalesce(r.bounced_at, new.bounced_at),
         failed_at = coalesce(r.failed_at, new.failed_at),
         error_message = coalesce(new.error_message, r.error_message),
         updated_at = now()
   where r.id = v_recipient_id;

  -- Feedback loop: een bounce of spamklacht op een campagnemail zet het adres op
  -- de suppressielijst, zodat een volgend campagne dat dode/klagende adres niet
  -- opnieuw aanschrijft (deliverability + AVG). Alleen voor campagne-mail (deze
  -- trigger keert immers al terug als er geen campaign_recipient_id is). De
  -- INSERT-trigger op email_suppressions stopt meteen eventuele lopende sends.
  if new.status in ('bounced', 'complained') and new.to_email is not null then
    insert into public.email_suppressions (organization_id, email, reason, source)
    values (
      new.organization_id,
      lower(btrim(new.to_email)),
      case when new.status = 'complained' then 'complained' else 'bounced' end,
      'resend-webhook'
    )
    on conflict (organization_id, email) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists client_emails_mirror_campaign on public.client_emails;
create trigger client_emails_mirror_campaign
  after update on public.client_emails
  for each row execute function public.mirror_client_email_to_campaign();

-- ------------------------------------------------------------
-- 6. Trigger 2: inkomend antwoord koppelen aan de campagne-ontvanger
-- ------------------------------------------------------------
-- mail-inbound voegt een inbound-rij toe op dezelfde thread als de uitgaande
-- campagne-mail. We markeren de bijbehorende ontvanger als 'geantwoord' op basis
-- van thread_id (elke campagne-ontvanger heeft een eigen thread).
create or replace function public.mark_campaign_reply_from_inbound()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.email_campaign_recipients r
     set replied_at = coalesce(r.replied_at, coalesce(new.received_at, now())),
         updated_at = now()
   where r.thread_id = new.thread_id
     and r.replied_at is null;
  return new;
end;
$$;

drop trigger if exists client_emails_campaign_reply on public.client_emails;
create trigger client_emails_campaign_reply
  after insert on public.client_emails
  for each row
  when (new.direction = 'inbound' and new.thread_id is not null)
  execute function public.mark_campaign_reply_from_inbound();

-- ------------------------------------------------------------
-- 6b. Trigger: een suppressie stopt meteen lopende campagne-sends
-- ------------------------------------------------------------
-- Zodra een adres op de suppressielijst komt (handmatig 'Blokkeren', afmeldlink,
-- of bounce/klacht via de mirror-trigger), worden nog niet-verzonden ontvangers
-- met dat adres op 'unsubscribed' gezet. Zo wordt de opt-out ook AFDWINGBAAR voor
-- een campagne die al aan het verzenden is (materialiseren checkt de lijst alleen
-- bij de start). De dispatch checkt daarnaast per batch nog een keer (defense-in-depth).
create or replace function public.suppress_campaign_recipients_on_block()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.email_campaign_recipients r
     set status = 'unsubscribed',
         unsubscribed_at = coalesce(r.unsubscribed_at, now()),
         updated_at = now()
   where r.organization_id = new.organization_id
     and lower(btrim(r.to_email)) = new.email
     and r.status in ('pending', 'sending');
  return new;
end;
$$;

drop trigger if exists email_suppressions_stop_recipients on public.email_suppressions;
create trigger email_suppressions_stop_recipients
  after insert on public.email_suppressions
  for each row execute function public.suppress_campaign_recipients_on_block();

-- ------------------------------------------------------------
-- 7. Hardening-triggers (org-integriteit + updated_at + org-lock)
-- ------------------------------------------------------------
drop trigger if exists email_campaigns_updated on public.email_campaigns;
create trigger email_campaigns_updated
  before update on public.email_campaigns
  for each row execute function public.set_updated_at();

drop trigger if exists email_campaigns_prevent_org_change on public.email_campaigns;
create trigger email_campaigns_prevent_org_change
  before update of organization_id on public.email_campaigns
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists email_campaign_recipients_updated on public.email_campaign_recipients;
create trigger email_campaign_recipients_updated
  before update on public.email_campaign_recipients
  for each row execute function public.set_updated_at();

-- campaign_id én (optioneel) client_id moeten bij dezelfde organisatie horen.
create or replace function public.enforce_campaign_recipient_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.email_campaigns', new.campaign_id, new.organization_id, 'email_campaign_recipients.campaign_id');
  if new.client_id is not null then
    perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'email_campaign_recipients.client_id');
  end if;
  return new;
end;
$$;

drop trigger if exists email_campaign_recipients_org_integrity on public.email_campaign_recipients;
create trigger email_campaign_recipients_org_integrity
  before insert or update of organization_id, campaign_id, client_id
  on public.email_campaign_recipients
  for each row execute function public.enforce_campaign_recipient_org_integrity();

-- ------------------------------------------------------------
-- 8. RLS
-- ------------------------------------------------------------
alter table public.email_campaigns enable row level security;
alter table public.email_campaign_recipients enable row level security;
alter table public.email_suppressions enable row level security;

do $$
begin
  -- Campagnes: leden lezen, schrijvers beheren.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_campaigns' and policyname='email campaigns read') then
    create policy "email campaigns read" on public.email_campaigns for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_campaigns' and policyname='email campaigns insert') then
    create policy "email campaigns insert" on public.email_campaigns for insert with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_campaigns' and policyname='email campaigns update') then
    create policy "email campaigns update" on public.email_campaigns for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_campaigns' and policyname='email campaigns delete') then
    create policy "email campaigns delete" on public.email_campaigns for delete using (public.can_write_org(organization_id));
  end if;

  -- Ontvangers: alleen lezen; schrijven uitsluitend via service role (Edge Function).
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_campaign_recipients' and policyname='email campaign recipients read') then
    create policy "email campaign recipients read" on public.email_campaign_recipients for select using (public.can_read_org(organization_id));
  end if;

  -- Suppressies: leden lezen, schrijvers beheren handmatig (naast de service-role afmeldflow).
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_suppressions' and policyname='email suppressions read') then
    create policy "email suppressions read" on public.email_suppressions for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_suppressions' and policyname='email suppressions insert') then
    create policy "email suppressions insert" on public.email_suppressions for insert with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_suppressions' and policyname='email suppressions delete') then
    create policy "email suppressions delete" on public.email_suppressions for delete using (public.can_write_org(organization_id));
  end if;
end $$;

-- ------------------------------------------------------------
-- 9. Stats-view (per campagne). security_invoker → RLS van de ontvangers geldt.
-- ------------------------------------------------------------
create or replace view public.email_campaign_stats
with (security_invoker = on) as
select
  r.organization_id,
  r.campaign_id,
  count(*)::int as total,
  count(*) filter (where r.sent_at is not null)::int as sent,
  count(*) filter (where r.delivered_at is not null)::int as delivered,
  count(*) filter (where r.opened_at is not null)::int as opened,
  count(*) filter (where r.clicked_at is not null)::int as clicked,
  count(*) filter (where r.replied_at is not null)::int as replied,
  count(*) filter (where r.bounced_at is not null)::int as bounced,
  count(*) filter (where r.status = 'failed')::int as failed,
  count(*) filter (where r.unsubscribed_at is not null or r.status = 'unsubscribed')::int as unsubscribed,
  count(*) filter (where r.status in ('pending','sending'))::int as pending
from public.email_campaign_recipients r
group by r.organization_id, r.campaign_id;

grant select on public.email_campaign_stats to authenticated;

-- ------------------------------------------------------------
-- 10. RPC: atomair een batch te-verzenden ontvangers claimen (dispatch-cron)
-- ------------------------------------------------------------
-- pending → sending onder `for update skip locked`, zodat overlappende cron-ticks
-- nooit dezelfde ontvanger dubbel versturen. Ontvangers die > 15 min in 'sending'
-- hangen (dispatch gecrasht vóór afronden) worden opnieuw opgepakt.
create or replace function public.claim_campaign_recipients(
  p_campaign_id uuid,
  p_limit integer default 100
)
returns setof public.email_campaign_recipients
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag campagne-ontvangers claimen.' using errcode = '42501';
  end if;

  return query
  update public.email_campaign_recipients r
     set status = 'sending',
         updated_at = now()
   where r.id in (
     select c.id
       from public.email_campaign_recipients c
      where c.campaign_id = p_campaign_id
        and (c.status = 'pending'
             or (c.status = 'sending' and c.updated_at < now() - interval '15 minutes'))
      order by c.created_at
      limit greatest(1, p_limit)
      for update skip locked
   )
   returning r.*;
end;
$$;

revoke execute on function public.email_engagement_rank(text) from public, anon, authenticated;
grant execute on function public.email_engagement_rank(text) to authenticated, service_role;
revoke execute on function public.claim_campaign_recipients(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_campaign_recipients(uuid, integer) to service_role;

-- ------------------------------------------------------------
-- 11. Realtime: campagne-ontvangers live meelezen in de campagne-detailweergave
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'email_campaign_recipients'
     ) then
    execute 'alter publication supabase_realtime add table public.email_campaign_recipients';
  end if;
end $$;

commit;
