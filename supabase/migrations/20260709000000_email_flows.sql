-- ============================================================
-- ResoFly — E-mailmarketing / Follow-up-stromen (fase 2)
-- Date: 2026-07-09
--
-- Bouwt op fase 1 (20260708000000). Een "stroom" is een reeks stappen: mail 1 →
-- wacht X dagen → mail 2/3 als de klant niet heeft gereageerd. Wat als "gereageerd"
-- telt (en de reeks dus stopt) is PER STROOM instelbaar: alleen antwoord /
-- openen-klik-antwoord / klik-antwoord.
--
-- Hergebruikt hetzelfde tracking-fundament: elke stap-verzending schrijft een
-- outbound-rij in client_emails (metadata.flow_send_id) zodat de resend-webhook +
-- mail-inbound automatisch open/klik/bounce/antwoord vullen. De mirror-, reply- en
-- suppressie-triggers uit fase 1 worden hier uitgebreid zodat ze óók de stroom-
-- boekhouding (email_flow_sends / email_flow_enrollments) bijwerken.
--
-- Scheduling: pg_cron → campaigns?cron=flows (operator-stap, CAMPAIGNS_SCHEDULER_SETUP.md).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Stromen + stappen
-- ------------------------------------------------------------
create table if not exists public.email_flows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  name text not null default '',
  status text not null default 'draft'
    check (status in ('draft','active','paused','archived')),
  audience jsonb not null default '{}'::jsonb,
  -- Wanneer stopt de reeks (wat telt als 'gereageerd'):
  --   reply             = alleen een antwoordmail
  --   open_click_reply  = openen OF klikken OF antwoorden
  --   click_reply       = klikken OF antwoorden
  stop_condition text not null default 'reply'
    check (stop_condition in ('reply','open_click_reply','click_reply')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.email_flow_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flow_id uuid not null references public.email_flows(id) on delete cascade,
  step_index integer not null,
  -- Wachttijd (dagen) vóór deze stap, gerekend vanaf de vorige stap; voor stap 0
  -- vanaf het moment van inschrijven (meestal 0 = direct).
  delay_days integer not null default 0 check (delay_days >= 0 and delay_days <= 3650),
  subject text not null default '',
  preheader text,
  body_html text not null default '',
  body_text text,
  accent_color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (flow_id, step_index)
);

-- ------------------------------------------------------------
-- 2. Inschrijvingen (één per contact per stroom) + per-stap-verzendingen
-- ------------------------------------------------------------
create table if not exists public.email_flow_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flow_id uuid not null references public.email_flows(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  contact_id uuid references public.client_contacts(id) on delete set null,
  to_email text not null,
  to_name text,
  -- Eén thread per inschrijving: alle stappen + het antwoord lopen hier doorheen.
  thread_id uuid references public.client_email_threads(id) on delete set null,
  status text not null default 'active'
    check (status in ('active','completed','stopped_reacted','stopped_unsubscribed','cancelled')),
  current_step_index integer not null default -1,
  next_step_due_at timestamptz,
  last_reply_at timestamptz,
  enrolled_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (flow_id, to_email)
);

create table if not exists public.email_flow_sends (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flow_id uuid not null references public.email_flows(id) on delete cascade,
  enrollment_id uuid not null references public.email_flow_enrollments(id) on delete cascade,
  step_id uuid references public.email_flow_steps(id) on delete set null,
  step_index integer not null,
  client_id uuid references public.clients(id) on delete set null,
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
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Idempotentie: max één send-rij per (inschrijving, stap). Een retry vindt de
  -- bestaande rij terug en hergebruikt het id als Resend-idempotency-key.
  unique (enrollment_id, step_index)
);

-- ------------------------------------------------------------
-- 3. Indexen
-- ------------------------------------------------------------
create index if not exists idx_email_flows_org_status
  on public.email_flows(organization_id, status, created_at desc);
create index if not exists idx_email_flow_steps_flow
  on public.email_flow_steps(flow_id, step_index);
create index if not exists idx_email_flow_enrollments_flow
  on public.email_flow_enrollments(organization_id, flow_id, status);
-- Goedkope scan voor de flows-cron: inschrijvingen die nu een volgende stap nodig hebben.
create index if not exists idx_email_flow_enrollments_due
  on public.email_flow_enrollments(next_step_due_at)
  where status = 'active' and next_step_due_at is not null;
create index if not exists idx_email_flow_enrollments_thread
  on public.email_flow_enrollments(thread_id) where thread_id is not null;
create index if not exists idx_email_flow_sends_enrollment
  on public.email_flow_sends(enrollment_id, step_index);
create index if not exists idx_email_flow_sends_flow_step
  on public.email_flow_sends(organization_id, flow_id, step_index);
-- Bediening van de reply-trigger (mark_campaign_reply_from_inbound matcht op thread_id);
-- draait op ELKE inkomende klant-mail, dus zonder index = seq scan op de hot path.
create index if not exists idx_email_flow_sends_thread
  on public.email_flow_sends(thread_id) where thread_id is not null;

-- ------------------------------------------------------------
-- 4. updated_at + org-lock + org-integriteit
-- ------------------------------------------------------------
drop trigger if exists email_flows_updated on public.email_flows;
create trigger email_flows_updated before update on public.email_flows
  for each row execute function public.set_updated_at();
drop trigger if exists email_flows_prevent_org_change on public.email_flows;
create trigger email_flows_prevent_org_change before update of organization_id on public.email_flows
  for each row execute function public.prevent_organization_id_change();

drop trigger if exists email_flow_steps_updated on public.email_flow_steps;
create trigger email_flow_steps_updated before update on public.email_flow_steps
  for each row execute function public.set_updated_at();

drop trigger if exists email_flow_enrollments_updated on public.email_flow_enrollments;
create trigger email_flow_enrollments_updated before update on public.email_flow_enrollments
  for each row execute function public.set_updated_at();

drop trigger if exists email_flow_sends_updated on public.email_flow_sends;
create trigger email_flow_sends_updated before update on public.email_flow_sends
  for each row execute function public.set_updated_at();

create or replace function public.enforce_email_flow_child_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.email_flows', new.flow_id, new.organization_id, 'email_flow child.flow_id');
  return new;
end;
$$;

drop trigger if exists email_flow_steps_org_integrity on public.email_flow_steps;
create trigger email_flow_steps_org_integrity
  before insert or update of organization_id, flow_id on public.email_flow_steps
  for each row execute function public.enforce_email_flow_child_org_integrity();

create or replace function public.enforce_email_flow_enrollment_org_integrity()
returns trigger
language plpgsql
as $$
begin
  perform public.assert_same_org_reference('public.email_flows', new.flow_id, new.organization_id, 'email_flow_enrollments.flow_id');
  if new.client_id is not null then
    perform public.assert_same_org_reference('public.clients', new.client_id, new.organization_id, 'email_flow_enrollments.client_id');
  end if;
  return new;
end;
$$;

drop trigger if exists email_flow_enrollments_org_integrity on public.email_flow_enrollments;
create trigger email_flow_enrollments_org_integrity
  before insert or update of organization_id, flow_id, client_id on public.email_flow_enrollments
  for each row execute function public.enforce_email_flow_enrollment_org_integrity();

drop trigger if exists email_flow_sends_org_integrity on public.email_flow_sends;
create trigger email_flow_sends_org_integrity
  before insert or update of organization_id, flow_id on public.email_flow_sends
  for each row execute function public.enforce_email_flow_child_org_integrity();

-- ------------------------------------------------------------
-- 5. RLS
-- ------------------------------------------------------------
alter table public.email_flows enable row level security;
alter table public.email_flow_steps enable row level security;
alter table public.email_flow_enrollments enable row level security;
alter table public.email_flow_sends enable row level security;

do $$
begin
  -- Stromen + stappen: leden lezen, schrijvers beheren.
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_flows' and policyname='email flows read') then
    create policy "email flows read" on public.email_flows for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_flows' and policyname='email flows insert') then
    create policy "email flows insert" on public.email_flows for insert with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_flows' and policyname='email flows update') then
    create policy "email flows update" on public.email_flows for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_flows' and policyname='email flows delete') then
    create policy "email flows delete" on public.email_flows for delete using (public.can_write_org(organization_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_flow_steps' and policyname='email flow steps read') then
    create policy "email flow steps read" on public.email_flow_steps for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_flow_steps' and policyname='email flow steps insert') then
    create policy "email flow steps insert" on public.email_flow_steps for insert with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_flow_steps' and policyname='email flow steps update') then
    create policy "email flow steps update" on public.email_flow_steps for update using (public.can_write_org(organization_id)) with check (public.can_write_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_flow_steps' and policyname='email flow steps delete') then
    create policy "email flow steps delete" on public.email_flow_steps for delete using (public.can_write_org(organization_id));
  end if;

  -- Inschrijvingen + verzendingen: alleen lezen; schrijven via service-role (Edge Function).
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_flow_enrollments' and policyname='email flow enrollments read') then
    create policy "email flow enrollments read" on public.email_flow_enrollments for select using (public.can_read_org(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='email_flow_sends' and policyname='email flow sends read') then
    create policy "email flow sends read" on public.email_flow_sends for select using (public.can_read_org(organization_id));
  end if;
end $$;

-- ------------------------------------------------------------
-- 6. Stats-views (security_invoker → RLS van de onderliggende tabellen geldt)
-- ------------------------------------------------------------
create or replace view public.email_flow_stats
with (security_invoker = on) as
select
  e.organization_id,
  e.flow_id,
  count(*)::int as enrollments,
  count(*) filter (where e.status = 'active')::int as active,
  count(*) filter (where e.status = 'completed')::int as completed,
  count(*) filter (where e.status = 'stopped_reacted')::int as stopped_reacted,
  count(*) filter (where e.status = 'stopped_unsubscribed')::int as stopped_unsubscribed,
  count(*) filter (where e.status = 'cancelled')::int as cancelled
from public.email_flow_enrollments e
group by e.organization_id, e.flow_id;

create or replace view public.email_flow_step_stats
with (security_invoker = on) as
select
  s.organization_id,
  s.flow_id,
  s.step_index,
  count(*)::int as sent,
  count(*) filter (where s.opened_at is not null)::int as opened,
  count(*) filter (where s.clicked_at is not null)::int as clicked,
  count(*) filter (where s.replied_at is not null)::int as replied,
  count(*) filter (where s.bounced_at is not null)::int as bounced
from public.email_flow_sends s
where s.sent_at is not null
group by s.organization_id, s.flow_id, s.step_index;

grant select on public.email_flow_stats to authenticated;
grant select on public.email_flow_step_stats to authenticated;

-- ------------------------------------------------------------
-- 7. RPC: due inschrijvingen claimen (flows-cron)
-- ------------------------------------------------------------
-- Lease-patroon: schuif next_step_due_at 15 min vooruit onder for-update-skip-locked,
-- zodat overlappende cron-ticks dezelfde inschrijving niet dubbel verwerken en een
-- gecrashte tick vanzelf na 15 min opnieuw wordt opgepakt. De Edge Function zet
-- daarna de echte next_step_due_at (of rondt af). Alleen inschrijvingen van een
-- ACTIEVE stroom worden geclaimd (gepauzeerde stromen liggen stil).
create or replace function public.claim_due_flow_enrollments(p_limit integer default 100)
returns setof public.email_flow_enrollments
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Alleen de service-role mag stroom-inschrijvingen claimen.' using errcode = '42501';
  end if;

  return query
  update public.email_flow_enrollments e
     set next_step_due_at = now() + interval '15 minutes',
         updated_at = now()
   where e.id in (
     select en.id
       from public.email_flow_enrollments en
       join public.email_flows f on f.id = en.flow_id
      where en.status = 'active'
        and f.status = 'active'
        and en.next_step_due_at is not null
        and en.next_step_due_at <= now()
      order by en.next_step_due_at
      limit greatest(1, p_limit)
      for update skip locked
   )
   returning e.*;
end;
$$;

revoke execute on function public.claim_due_flow_enrollments(integer) from public, anon, authenticated;
grant execute on function public.claim_due_flow_enrollments(integer) to service_role;

-- ------------------------------------------------------------
-- 8. Bestaande fase-1-triggerfuncties uitbreiden voor stromen
-- ------------------------------------------------------------
-- Mirror: spiegel client_emails-lifecycle óók naar email_flow_sends (metadata.flow_send_id).
create or replace function public.mirror_client_email_to_campaign()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipient_id uuid;
  v_flow_send_id uuid;
begin
  v_recipient_id := nullif(new.metadata ->> 'campaign_recipient_id', '')::uuid;
  v_flow_send_id := nullif(new.metadata ->> 'flow_send_id', '')::uuid;

  if v_recipient_id is not null then
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
  end if;

  if v_flow_send_id is not null then
    update public.email_flow_sends s
       set status = case
             when s.status in ('unsubscribed','skipped') then s.status
             when public.email_engagement_rank(new.status) >= public.email_engagement_rank(s.status)
               and new.status in ('sent','delivered','opened','clicked','bounced','failed','complained')
               then new.status
             else s.status
           end,
           sent_at = coalesce(s.sent_at, new.sent_at),
           delivered_at = coalesce(s.delivered_at, new.delivered_at),
           opened_at = coalesce(s.opened_at, new.opened_at),
           clicked_at = coalesce(s.clicked_at, new.clicked_at),
           bounced_at = coalesce(s.bounced_at, new.bounced_at),
           failed_at = coalesce(s.failed_at, new.failed_at),
           error_message = coalesce(new.error_message, s.error_message),
           updated_at = now()
     where s.id = v_flow_send_id;
  end if;

  -- Bounce/klacht → suppressielijst (deliverability + AVG); geldt voor campagne- én
  -- stroom-mail. De INSERT-trigger op email_suppressions stopt meteen lopende sends.
  if new.status in ('bounced', 'complained') and new.to_email is not null
     and (v_recipient_id is not null or v_flow_send_id is not null) then
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

-- Reply: een inkomend antwoord op de thread markeert óók de stroom-inschrijving.
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

  update public.email_flow_enrollments e
     set last_reply_at = coalesce(new.received_at, now()),
         updated_at = now()
   where e.thread_id = new.thread_id;

  update public.email_flow_sends s
     set replied_at = coalesce(s.replied_at, coalesce(new.received_at, now())),
         updated_at = now()
   where s.thread_id = new.thread_id
     and s.replied_at is null;

  return new;
end;
$$;

-- Suppressie stopt óók lopende stroom-inschrijvingen (handmatig blokkeren, afmelden, bounce).
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

  update public.email_flow_enrollments e
     set status = 'stopped_unsubscribed',
         completed_at = coalesce(e.completed_at, now()),
         next_step_due_at = null,
         updated_at = now()
   where e.organization_id = new.organization_id
     and lower(btrim(e.to_email)) = new.email
     and e.status = 'active';

  return new;
end;
$$;

-- ------------------------------------------------------------
-- 9. Draft-lock: doelgroep/stopconditie mogen alleen wijzigen zolang de stroom een
--    concept is (een lopende stroom mag niet retroactief van doelgroep/stopregel
--    veranderen). Statuswijzigingen en naamwijzigingen blijven toegestaan.
-- ------------------------------------------------------------
create or replace function public.enforce_email_flow_draft_lock()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft'
     and (new.audience is distinct from old.audience or new.stop_condition is distinct from old.stop_condition) then
    raise exception 'De doelgroep en stopconditie van een gestarte stroom kunnen niet meer worden gewijzigd.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists email_flows_draft_lock on public.email_flows;
create trigger email_flows_draft_lock
  before update of audience, stop_condition, status on public.email_flows
  for each row execute function public.enforce_email_flow_draft_lock();

-- ------------------------------------------------------------
-- 10. RPC: stappen van een CONCEPT-stroom atomair vervangen (delete + insert in één
--     transactie). Voorkomt (a) dataverlies bij een mislukte insert na een
--     gecommitte delete, en (b) het aanpassen van stappen van een reeds gestarte
--     stroom (concurrency-veilig, i.t.t. een frontend-check).
-- ------------------------------------------------------------
create or replace function public.replace_flow_steps(p_organization_id uuid, p_flow_id uuid, p_steps jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if not public.can_write_org(p_organization_id) then
    raise exception 'Geen schrijfrechten voor deze organisatie.' using errcode = '42501';
  end if;

  select status into v_status
  from public.email_flows
  where id = p_flow_id and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Stroom niet gevonden.' using errcode = '02000';
  end if;
  if v_status <> 'draft' then
    raise exception 'De stappen van een gestarte stroom kunnen niet meer worden gewijzigd.' using errcode = '23514';
  end if;

  delete from public.email_flow_steps where organization_id = p_organization_id and flow_id = p_flow_id;

  insert into public.email_flow_steps (organization_id, flow_id, step_index, delay_days, subject, preheader, body_html, body_text, accent_color)
  select
    p_organization_id,
    p_flow_id,
    (row_number() over (order by (elem->>'step_index')::int) - 1)::int,
    least(3650, greatest(0, coalesce((elem->>'delay_days')::int, 0))),
    coalesce(elem->>'subject', ''),
    nullif(btrim(coalesce(elem->>'preheader', '')), ''),
    coalesce(elem->>'body_html', ''),
    nullif(elem->>'body_text', ''),
    nullif(elem->>'accent_color', '')
  from jsonb_array_elements(coalesce(p_steps, '[]'::jsonb)) as elem;
end;
$$;

revoke execute on function public.replace_flow_steps(uuid, uuid, jsonb) from public, anon;
grant execute on function public.replace_flow_steps(uuid, uuid, jsonb) to authenticated, service_role;

commit;
