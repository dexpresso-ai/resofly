-- ============================================================
-- Agents die starten op een GEBEURTENIS, naast het vaste ritme.
--
-- Waarom: een agent draaide alleen op een vast moment (elk uur, elke ochtend).
-- "Als er een klantmail binnenkomt, zet een antwoord klaar" werd zo een agent
-- die elk uur alle mail van de dag opnieuw las, en pas een uur later reageerde.
-- Echt werk automatiseren vraagt dat een agent begint op het moment dat er iets
-- gebeurt, met precies dat ding in handen.
--
-- Hoe:
--  1. schedule_kind 'event' + trigger_events: waar de agent op wacht.
--  2. Triggers op de bron (tickets, klantmail, offertes, facturen, boekingen,
--     notulen, inkoopfacturen, klanten) zetten een regel in ai_agent_events —
--     alleen als er in die organisatie een actieve agent op dat soort
--     gebeurtenis wacht. Zonder luisteraar gebeurt er niets.
--  3. De runner (gerrie-agent-runner, elke minuut) claimt per agent een bundel
--     gebeurtenissen en draait hem één keer voor die hele bundel.
--
-- Grenzen:
--  - Een agent voert nog steeds niets zelf uit: hij zet klaar, een mens keurt goed.
--  - Hoogstens max_event_runs_per_day runs op een gebeurtenis per 24 uur, en
--    hoogstens 200 wachtende gebeurtenissen per agent: een mailstorm wordt geen
--    rekening.
--  - Wat de eigenaar van de agent niet mag lezen, krijgt de agent niet: de runner
--    gooit die gebeurtenissen weg vóór het model ze ziet (agentEvents.ts).
--  - Een trigger mag het opslaan van een ticket of mail nooit laten mislukken.
--  - ai_agent_events is alleen voor de service-role (RLS aan, geen policies).
--
-- Veilig opnieuw te draaien.
-- ============================================================

-- 1. Het ritme 'event' en de gebeurtenissen waarop een agent wacht.
alter table public.ai_agents drop constraint if exists ai_agents_schedule_kind_check;
alter table public.ai_agents
  add constraint ai_agents_schedule_kind_check
  check (schedule_kind in ('daily', 'weekdays', 'weekly', 'monthly', 'hourly', 'event'));

alter table public.ai_agents add column if not exists trigger_events text[] not null default '{}';
alter table public.ai_agents drop constraint if exists ai_agents_trigger_events_check;
alter table public.ai_agents
  add constraint ai_agents_trigger_events_check
  check (trigger_events <@ array[
    'client_email.received', 'ticket.created', 'ticket.client_reply', 'quote.accepted', 'quote.rejected',
    'invoice.paid', 'booking.created', 'meeting_recording.ready', 'purchase_invoice.received', 'client.created'
  ]::text[]);

alter table public.ai_agents add column if not exists max_event_runs_per_day int not null default 24;
alter table public.ai_agents drop constraint if exists ai_agents_max_event_runs_per_day_check;
alter table public.ai_agents
  add constraint ai_agents_max_event_runs_per_day_check check (max_event_runs_per_day between 1 and 96);

-- De triggers vragen bij elke nieuwe mail of elk nieuw ticket: luistert er iemand?
create index if not exists ai_agents_event_listeners_idx
  on public.ai_agents (organization_id)
  where status = 'active' and schedule_kind = 'event';

-- 2. Een run kan nu ook door een gebeurtenis gestart zijn.
alter table public.ai_agent_runs drop constraint if exists ai_agent_runs_triggered_by_check;
alter table public.ai_agent_runs
  add constraint ai_agent_runs_triggered_by_check
  check (triggered_by in ('schedule', 'manual', 'retry', 'event'));

-- 3. De wachtrij.
create table if not exists public.ai_agent_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  -- Een paar kenmerken (titel, onderwerp, nummer, klant-id). Geen volledige
  -- teksten: de agent haalt de details op met zijn eigen tools, en die volgen
  -- de modulerechten van zijn eigenaar.
  summary jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'done', 'skipped', 'expired')),
  lease_until timestamptz,
  run_id uuid references public.ai_agent_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists ai_agent_events_pending_idx
  on public.ai_agent_events (agent_id, created_at) where status = 'pending';
create index if not exists ai_agent_events_claimed_idx
  on public.ai_agent_events (lease_until) where status = 'claimed';
create index if not exists ai_agent_events_run_idx
  on public.ai_agent_events (run_id) where run_id is not null;

alter table public.ai_agent_events enable row level security;
revoke all on public.ai_agent_events from anon, authenticated;
grant all on public.ai_agent_events to service_role;
-- Geen policies: alleen de runner (service-role) leest en schrijft hier. De
-- modulepoort staat er toch op, net als bij ai_agent_runs: komt er ooit een
-- leesregel bij, dan geldt Gerrie meteen (en staat de boekhouder buiten).
select public.apply_module_gate('ai_agent_events', 'gerrie');

-- 4. Een gebeurtenis in de wachtrij zetten, voor elke agent die erop wacht.
create or replace function public.enqueue_agent_event(
  p_organization_id uuid, p_event text, p_entity_type text, p_entity_id uuid, p_summary jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_organization_id is null then return; end if;
  insert into public.ai_agent_events (organization_id, agent_id, event_type, entity_type, entity_id, summary)
  select a.organization_id, a.id, p_event, p_entity_type, p_entity_id, coalesce(p_summary, '{}'::jsonb)
    from public.ai_agents a
   where a.organization_id = p_organization_id
     and a.status = 'active'
     and a.schedule_kind = 'event'
     and p_event = any(a.trigger_events)
     and (select count(*) from public.ai_agent_events e
           where e.agent_id = a.id and e.status = 'pending') < 200;
exception when others then
  -- Een agent mag NOOIT het opslaan van een ticket, mail of factuur laten mislukken.
  raise warning 'enqueue_agent_event(%): %', p_event, sqlerrm;
end;
$$;

revoke execute on function public.enqueue_agent_event(uuid, text, text, uuid, jsonb) from public, anon, authenticated;

-- 5. De triggers, één per bron. Elk geeft alleen een paar kenmerken mee.

create or replace function public.agent_event_ticket_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.enqueue_agent_event(new.organization_id, 'ticket.created', 'ticket', new.id,
    jsonb_build_object('title', left(coalesce(new.title, ''), 200), 'priority', new.priority,
      'client_id', new.client_id, 'from', left(coalesce(new.created_by_name, new.created_by_email, ''), 120)));
  return new;
end;
$$;
drop trigger if exists agent_event_ticket_created on public.tickets;
create trigger agent_event_ticket_created after insert on public.tickets
  for each row execute function public.agent_event_ticket_created();

create or replace function public.agent_event_ticket_client_reply() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.author_type = 'client' then
    perform public.enqueue_agent_event(new.organization_id, 'ticket.client_reply', 'ticket', new.ticket_id,
      jsonb_build_object('note_id', new.id, 'from', left(coalesce(new.author_name, ''), 120),
        'title', (select left(coalesce(t.title, ''), 200) from public.tickets t where t.id = new.ticket_id and t.organization_id = new.organization_id)));
  end if;
  return new;
end;
$$;
drop trigger if exists agent_event_ticket_client_reply on public.ticket_notes;
create trigger agent_event_ticket_client_reply after insert on public.ticket_notes
  for each row execute function public.agent_event_ticket_client_reply();

create or replace function public.agent_event_client_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.direction = 'inbound' and new.client_id is not null then
    perform public.enqueue_agent_event(new.organization_id, 'client_email.received', 'client_email', new.id,
      jsonb_build_object('client_id', new.client_id, 'subject', left(coalesce(new.subject, ''), 200),
        'from', left(coalesce(new.from_name, new.from_email, ''), 160)));
  end if;
  return new;
end;
$$;
drop trigger if exists agent_event_client_email on public.client_emails;
create trigger agent_event_client_email after insert on public.client_emails
  for each row execute function public.agent_event_client_email();

create or replace function public.agent_event_quote_decision() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('accepted', 'rejected') and old.status is distinct from new.status then
    perform public.enqueue_agent_event(new.organization_id, 'quote.' || new.status, 'quote', new.id,
      jsonb_build_object('number', new.number, 'client_id', new.client_id,
        'note', left(coalesce(new.client_decision_note, ''), 300)));
  end if;
  return new;
end;
$$;
drop trigger if exists agent_event_quote_decision on public.quotes;
create trigger agent_event_quote_decision after update of status on public.quotes
  for each row execute function public.agent_event_quote_decision();

create or replace function public.agent_event_invoice_paid() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    perform public.enqueue_agent_event(new.organization_id, 'invoice.paid', 'invoice', new.id,
      jsonb_build_object('number', new.number, 'client_id', new.client_id, 'total_amount', new.total_amount));
  end if;
  return new;
end;
$$;
drop trigger if exists agent_event_invoice_paid on public.invoices;
create trigger agent_event_invoice_paid after update of status on public.invoices
  for each row execute function public.agent_event_invoice_paid();

create or replace function public.agent_event_booking_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.enqueue_agent_event(new.organization_id, 'booking.created', 'meeting_booking', new.id,
    jsonb_build_object('name', left(coalesce(new.booked_name, ''), 120), 'email', new.booked_email,
      'client_id', new.client_id, 'link_id', new.booking_link_id,
      'starts_at', (select s.starts_at from public.meeting_booking_slots s where s.id = new.slot_id and s.organization_id = new.organization_id)));
  return new;
end;
$$;
drop trigger if exists agent_event_booking_created on public.meeting_bookings;
create trigger agent_event_booking_created after insert on public.meeting_bookings
  for each row execute function public.agent_event_booking_created();

create or replace function public.agent_event_recording_ready() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' then
    perform public.enqueue_agent_event(new.organization_id, 'meeting_recording.ready', 'meeting_recording', new.id,
      jsonb_build_object('title', left(coalesce(new.event_title_snapshot, ''), 200),
        'client_id', new.client_id, 'project_id', new.project_id));
  end if;
  return new;
end;
$$;
drop trigger if exists agent_event_recording_ready on public.meeting_recordings;
create trigger agent_event_recording_ready after update of status on public.meeting_recordings
  for each row execute function public.agent_event_recording_ready();

create or replace function public.agent_event_purchase_inbox() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('ready', 'needs_review') and old.status not in ('ready', 'needs_review') then
    perform public.enqueue_agent_event(new.organization_id, 'purchase_invoice.received', 'purchase_invoice_inbox', new.id,
      jsonb_build_object('subject', left(coalesce(new.subject, ''), 200),
        'from', left(coalesce(new.sender_name, new.sender_email, ''), 160), 'status', new.status));
  end if;
  return new;
end;
$$;
drop trigger if exists agent_event_purchase_inbox on public.purchase_invoice_inbox;
create trigger agent_event_purchase_inbox after update of status on public.purchase_invoice_inbox
  for each row execute function public.agent_event_purchase_inbox();

create or replace function public.agent_event_client_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.enqueue_agent_event(new.organization_id, 'client.created', 'client', new.id,
    jsonb_build_object('name', left(coalesce(new.name, ''), 200), 'status', new.status));
  return new;
end;
$$;
drop trigger if exists agent_event_client_created on public.clients;
create trigger agent_event_client_created after insert on public.clients
  for each row execute function public.agent_event_client_created();

-- De triggerfuncties zijn geen RPC: niemand roept ze rechtstreeks aan.
revoke execute on function public.agent_event_ticket_created() from public, anon, authenticated;
revoke execute on function public.agent_event_ticket_client_reply() from public, anon, authenticated;
revoke execute on function public.agent_event_client_email() from public, anon, authenticated;
revoke execute on function public.agent_event_quote_decision() from public, anon, authenticated;
revoke execute on function public.agent_event_invoice_paid() from public, anon, authenticated;
revoke execute on function public.agent_event_booking_created() from public, anon, authenticated;
revoke execute on function public.agent_event_recording_ready() from public, anon, authenticated;
revoke execute on function public.agent_event_purchase_inbox() from public, anon, authenticated;
revoke execute on function public.agent_event_client_created() from public, anon, authenticated;

-- 6. De runner claimt per agent een bundel wachtende gebeurtenissen.
--
-- Een gebeurtenis wacht minstens een minuut: komen er drie mails vlak na
-- elkaar binnen, dan draait de agent één keer voor alle drie in plaats van
-- drie keer. Een agent die al loopt (lease), slaat deze tik over.
create or replace function public.claim_agent_event_batches(p_limit int default 5)
returns table (agent_id uuid, event_ids uuid[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent record;
  v_ids uuid[];
  v_taken int := 0;
  v_limit int := greatest(1, least(coalesce(p_limit, 5), 10));
begin
  -- "is distinct from" en niet "<>": zonder rol is auth.role() null, en dan
  -- liet "<>" de aanroep gewoon door.
  if auth.role() is distinct from 'service_role' then
    raise exception 'Alleen de service-role mag gebeurtenissen claimen.' using errcode = '42501';
  end if;

  -- Wat al dagen wacht (agent uit, daggrens vol), vervalt: een agent die weer
  -- aangaat, krijgt geen stapel van vorige week.
  update public.ai_agent_events
     set status = 'expired', processed_at = now()
   where status = 'pending' and created_at < now() - interval '3 days';
  -- Een claim van een runner die halverwege stopte, komt terug in de wachtrij.
  update public.ai_agent_events
     set status = 'pending', lease_until = null
   where status = 'claimed' and lease_until < now();

  for v_agent in
    select a.id, a.max_event_runs_per_day
      from public.ai_agents a
     where a.status = 'active'
       and a.schedule_kind = 'event'
       and (a.lease_until is null or a.lease_until < now())
       and exists (select 1 from public.ai_agent_events e
                    where e.agent_id = a.id and e.status = 'pending'
                      and e.created_at <= now() - interval '1 minute')
     order by a.last_run_at nulls first
     for update of a skip locked
  loop
    exit when v_taken >= v_limit;

    -- Daggrens: zo kan een mailstorm de rekening niet opjagen.
    if (select count(*) from public.ai_agent_runs r
         where r.agent_id = v_agent.id and r.triggered_by = 'event'
           and r.created_at > now() - interval '24 hours') >= coalesce(v_agent.max_event_runs_per_day, 24) then
      continue;
    end if;

    with picked as (
      select e.id from public.ai_agent_events e
       where e.agent_id = v_agent.id and e.status = 'pending'
       order by e.created_at
       limit 20
       for update skip locked
    ), claimed as (
      update public.ai_agent_events e
         set status = 'claimed', lease_until = now() + interval '10 minutes'
        from picked
       where e.id = picked.id
      returning e.id
    )
    select array_agg(claimed.id) into v_ids from claimed;

    if v_ids is null or coalesce(array_length(v_ids, 1), 0) = 0 then
      continue;
    end if;

    update public.ai_agents set lease_until = now() + interval '10 minutes' where id = v_agent.id;
    agent_id := v_agent.id;
    event_ids := v_ids;
    v_taken := v_taken + 1;
    return next;
  end loop;
end;
$$;

revoke execute on function public.claim_agent_event_batches(int) from public, anon, authenticated;
grant execute on function public.claim_agent_event_batches(int) to service_role;
